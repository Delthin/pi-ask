import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseConfig, updateConfig } from "../src/config.ts";
import { activeDraft, collectTranscript, FINISH, recordId, START, type BranchEntry } from "../src/session.ts";
import { catalog, organize, parseRouting, retrieve, route } from "../src/intelligence.ts";
import { withLock } from "../src/files.ts";
import type { Draft, KnowledgeIndex, OrganizedNote, Routing, TranscriptMessage } from "../src/types.ts";

const draft: Draft = { id: "draft-1", directory: "/tmp/cardex", question: "什么是闭包？", startedAt: "2026-01-01T00:00:00Z" };
const note: OrganizedNote = { id: "n1", title: "闭包", summary: "词法作用域及变量捕获", background: "JavaScript", content: "保留外部变量访问。", messageIndices: [0, 1] };
const index: KnowledgeIndex = { version: 2, revision: 1, updatedAt: "now", nodes: [{ id: "a", kind: "knowledge", parentId: null, title: "闭包", summary: "作用域", file: "cards/a.md", createdAt: "now", updatedAt: "now", recordIds: ["r1"] }], edges: [], discussions: [] };
function plan(matchId: string | null = "a"): Routing {
  return { targets: [{ key: "t1", noteIds: [note.id], matchId, title: note.title, summary: note.summary, parent: null }], groups: [], relations: [] };
}

test("配置采用固定绝对目录，持久化模型并保留其他配置", async t => {
  const root = await mkdtemp(join(tmpdir(), "cardex-config-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "pi-cardex.json");
  assert.equal((await loadConfig(path)).model, null);
  await updateConfig(path, { directory: join(root, "library") });
  await updateConfig(path, { model: { provider: "p", id: "family/model" } });
  assert.equal((await loadConfig(path)).directory, join(root, "library"));
  assert.equal(JSON.parse(await readFile(path, "utf8")).model.id, "family/model");
  assert.throws(() => parseConfig({ directory: "relative" }), /绝对路径/);
  assert.throws(() => parseConfig({ model: "bad" }), /model/);
  assert.throws(() => parseConfig({ timeoutMs: 0 }), /timeoutMs/);
});

test("记录范围来自原始分支，跨压缩保留问答，排除工具和思考", () => {
  const branch: BranchEntry[] = [
    { type: "message", message: { role: "user", content: "旧问题" } },
    { type: "custom", customType: START, data: draft },
    { type: "message", message: { role: "user", content: [{ type: "text", text: draft.question }, { type: "image" }] } },
    { type: "message", message: { role: "assistant", provider: "p", model: "m", content: [{ type: "thinking", thinking: "私有思考" }, { type: "text", text: "回答" }, { type: "toolCall", name: "read" }] } },
    { type: "message", message: { role: "toolResult", content: "工具结果" } },
    { type: "compaction", data: "摘要不作为问答" },
    { type: "message", message: { role: "assistant", stopReason: "error", content: "错误残片" } },
    { type: "message", message: { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "已显示片段" }, { type: "thinking", thinking: "不保存" }] } },
  ];
  assert.deepEqual(activeDraft(branch), draft);
  const messages = collectTranscript(branch, draft);
  assert.equal(messages.length, 4);
  assert.equal(messages[2]?.text, "错误残片"); assert.equal(messages[2]?.status, "error");
  assert.equal(messages[3]?.text, "已显示片段"); assert.equal(messages[3]?.status, "aborted");
  assert.equal(messages[1]?.text, "回答");
  assert.equal(messages[1]?.model, "p/m");
  assert.notEqual(recordId(draft, messages), recordId(draft, [...messages, { role: "user", text: "另一分支", timestamp: 1 }]));
  assert.equal(activeDraft([...branch, { type: "custom", customType: FINISH, data: { draftId: draft.id } }]), undefined);
  assert.deepEqual(activeDraft(branch), draft);
});

test("检索和建联只发送名称/简介目录，不发送详情或文件路径", async () => {
  assert.deepEqual(Object.keys(catalog(index)[0]!).sort(), ["id", "kind", "parentId", "summary", "title"]);
  const calls: unknown[] = [];
  assert.equal(await retrieve("闭包怎么用", catalog(index), async (_system, data) => { calls.push(data); return { matchId: "a" }; }), "a");
  const result = await route([{ ...note, content: "SECRET_BODY" }], catalog(index), async (_system, data) => {
    calls.push(data); return plan();
  });
  assert.equal(result.targets[0]!.matchId, "a");
  assert.doesNotMatch(JSON.stringify(calls), /SECRET_BODY|cards\/|recordIds|background/);
  await assert.rejects(retrieve("q", catalog(index), async () => ({ matchId: "missing" })), /不存在/);
  await assert.rejects(route([note], catalog(index), async () => ({ ...plan(), relations: [{ source: "target:t1", target: "existing:a", relation: "self", reason: "self" }] })), /自身引用/);
  await assert.rejects(organize([], async () => note), /可归档的问答文字/);
  await assert.rejects(organize([{ role: "user", text: "q", timestamp: 1 }, { role: "assistant", text: "a", timestamp: 2 }], async () => "not json"), /有效 JSON/);
});

test("整理请求使用知识卡片写作规则，保留输入问答且不将规则发送给检索和建联", async () => {
  const writing = (await readFile(new URL("../src/prompts/knowledge-card.md", import.meta.url), "utf8")).trim();
  assert.match(writing, /^# 知识卡片写作规则/);
  const messages: TranscriptMessage[] = [
    { role: "user", text: "闭包为何能访问外部变量？", timestamp: 1 },
    { role: "assistant", text: "原始回答保留自己的措辞。", timestamp: 2, model: "p/m" },
  ];
  const original = structuredClone(messages);
  let calls = 0;
  const organized = await organize(messages, async (system, data) => {
    calls++;
    assert.ok(system.includes(`<knowledge-card-writing>\n${writing}\n</knowledge-card-writing>`));
    assert.ok(system.indexOf("## 返回格式") > system.indexOf("</knowledge-card-writing>"));
    assert.match(system, /当前处于归档阶段/);
    assert.deepEqual(data, { conversation: original.map((message, index) => ({ index, ...message })) });
    return { notes: [note] };
  });
  assert.equal(calls, 1);
  assert.deepEqual(organized, [note]);
  assert.deepEqual(messages, original);
  const prompts: string[] = [];
  await retrieve("闭包", catalog(index), async (system) => { prompts.push(system); return { matchId: "a" }; });
  await route([note], catalog(index), async (system) => { prompts.push(system); return plan(); });
  assert.equal(prompts.length, 2);
  for (const prompt of prompts) assert.doesNotMatch(prompt, /<knowledge-card-writing>|# 知识卡片写作规则/);
});

test("一次讨论拆成多个知识点，来源必须指向真实问答", async () => {
  const messages: TranscriptMessage[] = [
    { role: "user", text: "问闭包", timestamp: 1 }, { role: "assistant", text: "闭包回答", timestamp: 2 },
    { role: "user", text: "问垃圾回收", timestamp: 3 }, { role: "assistant", text: "垃圾回收回答", timestamp: 4 },
  ];
  const notes = [note, { ...note, id: "n2", title: "垃圾回收", messageIndices: [3, 2] }];
  const result = await organize(messages, async () => ({ notes }));
  assert.equal(result.length, 2);
  assert.deepEqual(result[1]!.messageIndices, [2, 3]);
  await assert.rejects(organize(messages, async () => ({ notes: [note, note] })), /重复的知识点/);
  await assert.rejects(organize(messages, async () => ({ notes: [{ ...note, messageIndices: [0, 4] }] })), /来源位置/);
  await assert.rejects(organize(messages, async () => ({ notes: [{ ...note, messageIndices: [1] }] })), /相关的问题和回答/);
});

test("整批归类覆盖所有知识点，拒绝四级、环、无效引用与移动旧节点", () => {
  const notes = [note, { ...note, id: "n2", title: "垃圾回收" }];
  const valid: Routing = {
    targets: [
      { ...plan(null).targets[0]!, parent: "group:g2" },
      { key: "t2", noteIds: ["n2"], matchId: null, title: "垃圾回收", summary: "内存回收机制", parent: "group:g2" },
    ],
    groups: [{ key: "g1", title: "编程", summary: "编程知识", parent: null }, { key: "g2", title: "JavaScript", summary: "JS语言", parent: "group:g1" }],
    relations: [{ source: "target:t1", target: "target:t2", relation: "影响", reason: "闭包可能保留对象引用" }],
  };
  assert.deepEqual(parseRouting(valid, notes, []), valid);
  const deep = structuredClone(valid); deep.targets[1]!.parent = "target:t1";
  assert.throws(() => parseRouting(deep, notes, []), /最多三级/);
  const cycle = structuredClone(valid); cycle.groups[0]!.parent = "target:t1";
  assert.throws(() => parseRouting(cycle, notes, []), /循环/);
  const absent = structuredClone(valid); absent.targets[1]!.parent = "existing:unknown";
  assert.throws(() => parseRouting(absent, notes, []), /不存在/);
  const incomplete = structuredClone(valid); incomplete.targets.pop();
  assert.throws(() => parseRouting(incomplete, notes, []), /遗漏/);
  const moved = plan(); moved.targets[0]!.parent = "group:g1"; moved.groups.push(valid.groups[0]!);
  assert.throws(() => parseRouting(moved, [note], catalog(index)), /保留原父级/);
  const merge = plan(null); merge.targets[0]!.noteIds = ["n1", "n2"];
  assert.equal(parseRouting(merge, notes, []).targets.length, 1);
});

test("目录锁拒绝并发写入，操作失败后释放锁", async t => {
  const root = await mkdtemp(join(tmpdir(), "cardex-lock-")); t.after(() => rm(root, { recursive: true, force: true }));
  await withLock(root, async () => { await assert.rejects(withLock(root, async () => 1), /正在写入/); });
  await assert.rejects(withLock(root, async () => { throw new Error("failure"); }), /failure/);
  assert.equal(await withLock(root, async () => 2), 2);
});
