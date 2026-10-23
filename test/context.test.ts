import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { containsDiscussion, ConversationSnapshot, type ConversationMessages } from "../src/context.ts";
import { modelCaller } from "../src/model.ts";
import type { AskConfig, TranscriptMessage } from "../src/types.ts";

type Context = Parameters<ExtensionContext["modelRegistry"]["streamSimple"]>[1];
type Options = Parameters<ExtensionContext["modelRegistry"]["streamSimple"]>[2];
const config: AskConfig = { version: 1, directory: "/tmp/unused", model: null, timeoutMs: 1000 };
const discussion: TranscriptMessage[] = [{ role: "user", text: "ASK_QUESTION", timestamp: 3 }, { role: "assistant", text: "ASK_ANSWER", timestamp: 5, model: "local/model" }];
const initial = () => [
  { role: "system", content: "CHAT_SYSTEM", toolsAdded: [{ name: "read", description: "Existing declaration", parameters: { type: "object", properties: {} } }], timestamp: 1 },
  { role: "user", content: "EARLIER_BACKGROUND", timestamp: 2 },
  { role: "user", content: "ASK_QUESTION", timestamp: 3 },
  { role: "toolResult", toolCallId: "t0", toolName: "read", content: [{ type: "text", text: "CURRENT_TOOL_DATA" }], isError: false, timestamp: 4 },
  { role: "assistant", content: [{ type: "thinking", thinking: "CURRENT_THINKING", thinkingSignature: "sig" }, { type: "text", text: "ASK_ANSWER" }], stopReason: "stop", timestamp: 5 },
] as unknown as ConversationMessages;

function fixture() {
  const messages = initial();
  const branch = messages.map((message, i) => ({ id: `e${i}`, type: "message", message }));
  const requests: { context: Context; options: Options }[] = [];
  const model = { provider: "local", id: "model", maxTokens: 16000 };
  let response = { stopReason: "stop", content: [{ type: "text", text: "{}" }] };
  const ctx = {
    model, thinkingLevel: "high",
    sessionManager: { getSessionId: () => "session-A", getBranch: () => branch, buildSessionProjection: () => ({ messages }) },
    modelRegistry: { find: () => model, streamSimple: (_model: unknown, context: Context, options: Options) => {
      requests.push({ context, options }); return { result: async () => response };
    } },
  } as unknown as ExtensionContext;
  return { ctx, messages, branch, requests, setResponse: (value: typeof response) => { response = value; } };
}

test("follow 整理复用系统、工具声明和历史前缀，只在尾部增加提示", async () => {
  const app = fixture();
  assert.ok(containsDiscussion(app.messages, discussion));
  const before = structuredClone(app.messages);
  const caller = modelCaller(app.ctx, config, new AbortController().signal, { messages: discussion });
  assert.equal(caller.contextSource, "projection");
  assert.equal(caller.contextWarning, undefined);
  await caller.organizationCall("ORGANIZE_INSTRUCTIONS", { conversation: discussion });
  const { context, options } = app.requests[0]!;
  assert.deepEqual(context.messages.slice(0, -1), before);
  assert.equal(context.messages.length, before.length + 1);
  assert.equal(context.systemPrompt, undefined);
  const suffix = JSON.stringify(context.messages.at(-1));
  assert.match(suffix, /ORGANIZE_INSTRUCTIONS/);
  assert.match(suffix, /最后 2 条/);
  assert.doesNotMatch(suffix, /ASK_QUESTION|ASK_ANSWER|CURRENT_TOOL_DATA/);
  assert.equal(options?.sessionId, "session-A"); assert.equal(options?.reasoning, "high");
  assert.deepEqual(app.messages, before, "整理调用不可修改会话投影");
});

test("检索与归类保持隔离，固定模型的整理也不带会话上下文", async () => {
  const app = fixture();
  const caller = modelCaller(app.ctx, config, new AbortController().signal, { messages: discussion });
  await caller.call("ROUTE", { catalog: [{ id: "a", title: "A", summary: "brief", kind: "knowledge", parentId: null }] });
  assert.equal(app.requests[0]!.context.messages.length, 1);
  assert.doesNotMatch(JSON.stringify(app.requests[0]!.context), /CHAT_SYSTEM|EARLIER_BACKGROUND|ASK_ANSWER|CURRENT_TOOL_DATA|CURRENT_THINKING/);
  const fixed = modelCaller(app.ctx, { ...config, model: { provider: "local", id: "model" } }, new AbortController().signal, { messages: discussion, history: initial() });
  assert.equal(fixed.contextSource, "isolated");
  await fixed.organizationCall("ORGANIZE", { conversation: discussion });
  const request = app.requests[1]!;
  assert.equal(request.context.messages.length, 1);
  assert.match(JSON.stringify(request.context), /ASK_QUESTION/);
  assert.doesNotMatch(JSON.stringify(request.context), /CHAT_SYSTEM|EARLIER_BACKGROUND|CURRENT_TOOL_DATA|CURRENT_THINKING/);
  assert.equal(request.options?.sessionId, undefined);
});

test("请求快照优先保留临时系统提示，并续接最后回答；分支或上下文修改使快照失效", async () => {
  const app = fixture(); const snapshot = new ConversationSnapshot();
  const last = app.messages.at(-1)!;
  app.branch.pop();
  const transformed = structuredClone(app.messages.slice(0, -1));
  transformed[0] = { ...transformed[0]!, content: "EFFECTIVE_FORCED_SYSTEM" } as ConversationMessages[number];
  snapshot.capture(app.ctx, transformed);
  snapshot.append(app.ctx, last);
  app.branch.push({ id: "e4", type: "message", message: last });
  const saved = snapshot.get(app.ctx);
  assert.ok(saved);
  const caller = modelCaller(app.ctx, config, new AbortController().signal, { messages: discussion, history: saved });
  assert.equal(caller.contextSource, "request");
  await caller.organizationCall("ORGANIZE", {});
  assert.match(JSON.stringify(app.requests[0]!.context.messages[0]), /EFFECTIVE_FORCED_SYSTEM/);
  assert.doesNotMatch(JSON.stringify(app.requests[0]!.context), /CHAT_SYSTEM/);
  app.branch[1]!.id = "different-branch";
  assert.equal(snapshot.get(app.ctx), undefined);
  app.branch[1]!.id = "e1";
  app.branch.push({ id: "context-edit", type: "context_edit", message: last });
  assert.equal(snapshot.get(app.ctx), undefined);
  snapshot.clear();
  assert.equal(snapshot.get(app.ctx), undefined);
});

test("落盘消息的非文本块被后续 handler 替换时，弃用请求快照", async () => {
  const app = fixture(); const snapshot = new ConversationSnapshot();
  const last = app.messages.at(-1)!;
  app.branch.pop();
  snapshot.capture(app.ctx, app.messages.slice(0, -1));
  snapshot.append(app.ctx, last);
  const changed = { ...structuredClone(last), content: [
    { type: "thinking", thinking: "REPLACED_THINKING", thinkingSignature: "new-signature" },
    { type: "text", text: "ASK_ANSWER" },
  ] } as ConversationMessages[number];
  app.branch.push({ id: "e4", type: "message", message: changed });
  app.messages[app.messages.length - 1] = changed;
  assert.equal(snapshot.get(app.ctx), undefined);
  const caller = modelCaller(app.ctx, config, new AbortController().signal, { messages: discussion, history: snapshot.get(app.ctx) });
  assert.equal(caller.contextSource, "projection");
  await caller.organizationCall("ORGANIZE", {});
  const request = JSON.stringify(app.requests[0]!.context);
  assert.match(request, /REPLACED_THINKING|new-signature/);
  assert.doesNotMatch(request, /CURRENT_THINKING/);
});

test("压缩或归档快照之后的新消息不会改变本次记录范围", async () => {
  const app = fixture();
  app.messages.splice(1, 4, { role: "user", content: "COMPACTION_SUMMARY", timestamp: 6 });
  const caller = modelCaller(app.ctx, config, new AbortController().signal, { messages: discussion });
  assert.equal(caller.contextSource, "isolated");
  assert.match(caller.contextWarning!, /原始问答快照/);
  await caller.organizationCall("ORGANIZE", { conversation: discussion });
  assert.match(JSON.stringify(app.requests[0]!.context), /ASK_ANSWER/);
  assert.doesNotMatch(JSON.stringify(app.requests[0]!.context), /COMPACTION_SUMMARY/);
  const newer = initial(); newer.push({ role: "user", content: "NEW_AFTER_PREPARE", timestamp: 6 });
  assert.equal(containsDiscussion(newer, discussion), false);
});

test("整理请求返回工具调用时拒绝结果，不启动执行循环", async () => {
  const app = fixture();
  app.setResponse({ stopReason: "toolUse", content: [{ type: "toolCall", text: "" }] });
  const caller = modelCaller(app.ctx, config, new AbortController().signal, { messages: discussion });
  await assert.rejects(caller.organizationCall("ORGANIZE", {}), /工具调用；调用未执行/);
  assert.equal(app.requests.length, 1);
});
