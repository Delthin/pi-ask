import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import cardexExtension from "../src/extension.ts";
import { updateConfig, loadConfig } from "../src/config.ts";
import { activeDraft, FINISH, preparedArchive, textContent, type BranchEntry } from "../src/session.ts";
import { loadIndex } from "../src/store.ts";
import { modelCaller } from "../src/model.ts";

function host(configPath: string) {
  const branch: BranchEntry[] = [];
  const notifications: string[] = [];
  const calls: { system: string; data: unknown }[] = [];
  const model = { provider: "local", id: "family/model", maxTokens: 16000 };
  const events = new Map<string, (event: unknown, ctx: ExtensionCommandContext) => unknown>();
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  let answer: (system: string, data: unknown) => unknown = () => { throw new Error("unexpected model call"); };
  let failFinish = false;
  const ctx = {
    hasUI: true, isIdle: () => true, hasPendingMessages: () => false, waitForIdle: async () => {},
    ui: { notify: (message: string) => notifications.push(message), setStatus: () => {}, setEditorText: () => {}, select: async () => "local/family/model" },
    sessionManager: {
      getBranch: () => branch, getSessionId: () => "test-session", getLeafId: () => branch.at(-1)?.id ?? null,
      buildSessionProjection: () => ({ messages: [{ role: "system", content: "Test chat system", timestamp: 0 }, ...branch.filter(entry => entry.type === "message").map(entry => entry.message)] }),
    }, model,
    modelRegistry: {
      find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
      getAvailable: () => [model],
      streamSimple: (_model: unknown, context: { systemPrompt?: string; messages: { content: unknown }[]; tools?: unknown }) => {
        assert.equal(context.tools, undefined);
        const system = context.systemPrompt ?? textContent(context.messages.at(-1)!.content);
        const data = context.systemPrompt ? JSON.parse(textContent(context.messages[0]!.content)) : { reused: true };
        calls.push({ system, data });
        return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify(await answer(system, data)) }] }) };
      },
    },
  } as unknown as ExtensionCommandContext;
  const pi = {
    on: (name: string, callback: (event: unknown, ctx: ExtensionCommandContext) => unknown) => events.set(name, callback),
    registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; },
    appendEntry: (customType: string, data: unknown) => {
      if (customType === FINISH && failFinish) throw new Error("simulated session write failure");
      branch.push({ id: `entry-${branch.length}`, type: "custom", customType, data });
    },
    sendUserMessage: (text: string, options: { expandPromptTemplates: boolean }) => {
      assert.equal(options.expandPromptTemplates, false);
      branch.push({ id: `entry-${branch.length}`, type: "message", message: { role: "user", content: text, timestamp: Date.now() } });
    },
  } as unknown as ExtensionAPI;
  const reload = () => { cardexExtension(pi, configPath); events.get("session_start")?.({}, ctx); };
  reload();
  return {
    branch, notifications, calls, ctx, events, reload,
    command: (args: string) => handler!(args, ctx),
    setAnswer: (next: typeof answer) => { answer = next; },
    failFinish: (value: boolean) => { failFinish = value; },
    assistant: (text: string) => {
      const message = { role: "assistant", provider: model.provider, model: model.id, content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now() };
      events.get("message_end")?.({ message }, ctx);
      branch.push({ id: `entry-${branch.length}`, type: "message", message });
    },
  };
}

test("命令流程：选择模型、记录/恢复、固定目录、结束去重及追加", async t => {
  const root = await mkdtemp(join(tmpdir(), "cardex-extension-")); t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config.json"); const library = join(root, "library");
  await updateConfig(configPath, { directory: library });
  const app = host(configPath);
  await app.command("model");
  assert.deepEqual((await loadConfig(configPath)).model, { provider: "local", id: "family/model" });
  await app.command("闭包是什么？");
  assert.equal(activeDraft(app.branch)?.question, "闭包是什么？");
  app.assistant("OLD_CARD_BODY：保留词法环境。");
  app.reload();
  assert.ok(activeDraft(app.branch));
  await app.command(`dir ${join(root, "new-library")}`);
  app.setAnswer(system => system.includes("仅根据本次讨论") ? {
    notes: [{ id: "n1", title: "闭包", summary: "词法环境与变量捕获", background: "", content: "闭包的定义", messageIndices: [0, 1] }],
  } : { targets: [{ key: "t1", noteIds: ["n1"], matchId: null, title: "闭包", summary: "词法环境与变量捕获", parent: null }], groups: [], relations: [] });
  app.failFinish(true);
  await app.command("end");
  assert.ok(activeDraft(app.branch));
  assert.equal((await loadIndex(library)).nodes.length, 1);
  assert.equal((await loadIndex(join(root, "new-library"))).nodes.length, 0);
  const calls = app.calls.length;
  const frozen = preparedArchive(app.branch, activeDraft(app.branch)!);
  assert.ok(frozen);
  app.reload();
  assert.deepEqual(app.events.get("input")?.({ text: "先不要追加这个问题" }, app.ctx), { action: "handled" });
  const branchLength = app.branch.length;
  await app.command("先不要追加这个问题");
  assert.equal(app.branch.length, branchLength, "结束操作未完成时必须先恢复，不能混入后续追问");
  // Even host-injected branch entries must not change an already prepared transaction.
  app.assistant("归档快照之后的宿主消息");
  assert.equal(preparedArchive(app.branch, activeDraft(app.branch)!)?.recordId, frozen.recordId);
  app.failFinish(false);
  await app.command("end");
  assert.equal(activeDraft(app.branch), undefined);
  assert.equal(app.calls.length, calls, "归档已落盘但会话标记失败时，重试不再调用模型");
  await app.command(`dir ${library}`);
  const id = (await loadIndex(library)).nodes[0]!.id;
  app.setAnswer((system, data) => {
    assert.doesNotMatch(JSON.stringify(data), /OLD_CARD_BODY/);
    if (system.includes("判断问题")) return { matchId: id };
    if (system.includes("仅根据本次讨论")) return { notes: [{ id: "n1", title: "闭包", summary: "变量生命周期", background: "", content: "进一步解释", messageIndices: [0, 1] }] };
    return { targets: [{ key: "t1", noteIds: ["n1"], matchId: id, title: "闭包", summary: "词法环境、捕获与生命周期", parent: null }], groups: [], relations: [] };
  });
  await app.command("闭包会如何影响内存？");
  app.assistant("对象仍被引用时不会被回收。");
  await app.command("end");
  const index = await loadIndex(library);
  assert.equal(index.nodes.length, 1); assert.equal(index.nodes[0]!.recordIds.length, 2);
  assert.equal(activeDraft(app.branch), undefined);
});

test("follow 模式一次讨论归档多卡与三级树，整理结果不污染聊天", async t => {
  const root = await mkdtemp(join(tmpdir(), "cardex-multi-command-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "config.json"); const library = join(root, "library");
  await updateConfig(path, { directory: library });
  const app = host(path);
  await app.command("解释作用域、闭包与垃圾回收");
  app.events.get("context_with_system")?.({ messages: app.ctx.sessionManager.buildSessionProjection().messages }, app.ctx);
  app.assistant("RAW_CURRENT_ANSWER：解释三个知识点。");
  const definitions = [["n1", "作用域"], ["n2", "闭包"], ["n3", "垃圾回收"]];
  app.setAnswer((system, data) => {
    if (system.includes("仅根据本次讨论")) {
      assert.deepEqual(data, { reused: true });
      return { notes: definitions.map(([id, title]) => ({ id, title, summary: `${title}的定义`, background: "", content: "ORGANIZED_BODY", messageIndices: [0, 1] })) };
    }
    assert.doesNotMatch(JSON.stringify(data), /RAW_CURRENT_ANSWER|ORGANIZED_BODY/);
    return {
      targets: definitions.map(([id, title], i) => ({ key: `t${i + 1}`, noteIds: [id], matchId: null, title, summary: `${title}的定义`, parent: i === 1 ? "target:t1" : "group:g1" })),
      groups: [{ key: "g1", title: "JavaScript", summary: "语言机制", parent: null }],
      relations: [{ source: "target:t2", target: "target:t3", relation: "影响", reason: "闭包持有引用影响回收" }],
    };
  });
  await app.command("end");
  const index = await loadIndex(library);
  assert.equal(index.nodes.length, 4);
  assert.equal(index.nodes.filter(node => node.kind === "knowledge").length, 3);
  assert.equal(index.discussions.length, 1);
  assert.equal(index.discussions[0]!.nodeIds.length, 3);
  const scope = index.nodes.find(node => node.title === "作用域")!;
  assert.equal(index.nodes.find(node => node.title === "闭包")!.parentId, scope.id);
  assert.equal(activeDraft(app.branch), undefined);
  assert.equal(app.branch.filter(entry => entry.type === "message").length, 2);
  assert.ok(app.notifications.some(text => text.includes("复用当前会话上下文")));
  assert.ok(app.notifications.some(text => text.includes("新建 3，补充 0")));
});

test("模型失败保留草稿，cancel 只结束记录，模型设置不改聊天模型", async t => {
  const root = await mkdtemp(join(tmpdir(), "cardex-failed-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "config.json"); const library = join(root, "library");
  await updateConfig(path, { directory: library });
  const app = host(path);
  await app.command("model current"); await app.command("model follow");
  assert.equal((await loadConfig(path)).model, null);
  await app.command("-- end 是什么意思？"); app.assistant("它表示结束。");
  app.setAnswer(() => { throw new Error("provider unavailable"); });
  await app.command("end");
  assert.ok(activeDraft(app.branch)); assert.equal((await loadIndex(library)).nodes.length, 0);
  assert.ok(app.notifications.some(text => text.includes("provider unavailable")));
  const count = app.branch.filter(entry => entry.type === "message").length;
  await app.command("cancel");
  assert.equal(activeDraft(app.branch), undefined);
  assert.equal(app.branch.filter(entry => entry.type === "message").length, count);
});

test("归档期间阻止消息与分支切换，关闭时中止模型调用", async t => {
  const root = await mkdtemp(join(tmpdir(), "cardex-busy-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "config.json"); await updateConfig(path, { directory: join(root, "library") });
  const app = host(path);
  await app.command("问题"); app.assistant("回答");
  let entered!: () => void;
  const modelEntered = new Promise<void>(resolve => { entered = resolve; });
  app.setAnswer(() => { entered(); return new Promise(() => {}); });
  const pending = app.command("end");
  await modelEntered;
  assert.deepEqual(app.events.get("session_before_switch")?.({}, app.ctx), { cancel: true });
  assert.deepEqual(app.events.get("input")?.({ text: "稍后再问" }, app.ctx), { action: "handled" });
  app.events.get("session_shutdown")?.({}, app.ctx);
  await pending;
  assert.ok(activeDraft(app.branch));
});

test("模型适配器响应外部取消和不完整输出", async () => {
  const app = host(join(tmpdir(), "unused-cardex-config.json"));
  const config = { version: 1 as const, directory: "/tmp/unused", model: null, timeoutMs: 1000 };
  const aborted = new AbortController(); aborted.abort(new Error("cancelled"));
  await assert.rejects(modelCaller(app.ctx, config, aborted.signal).call("s", {}), /cancelled/);
  app.ctx.modelRegistry.streamSimple = (() => ({ result: async () => ({ stopReason: "length", content: [] }) })) as unknown as typeof app.ctx.modelRegistry.streamSimple;
  await assert.rejects(modelCaller(app.ctx, config, new AbortController().signal).call("s", {}), /未完成输出/);
});
