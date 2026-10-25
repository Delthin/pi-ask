import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archive, emptyIndex, loadIndex, parseIndex, rebuildGraph } from "../src/store.ts";
import type { ArchiveInput } from "../src/store.ts";
import type { KnowledgeIndex, KnowledgeNode, Routing } from "../src/types.ts";

const stamp = "2026-01-01T00:00:00.000Z";
const pendingFile = ".pi-cardex-transaction.json";
const noModel = async (): Promise<never> => { throw new Error("重复归档不能再调用模型"); };

function input(id: string, title = "闭包"): ArchiveInput {
  return {
    recordId: id,
    notes: [{ id: "n1", title, summary: `${title}的定义与应用`, background: "JS", content: "整理正文", messageIndices: [0, 1] }],
    messages: [{ role: "user", text: `问 ${title}`, timestamp: 1 }, { role: "assistant", text: "原始回答", model: "p/m", timestamp: 2 }],
    organizer: "p/organizer",
  };
}

function routing(item: ArchiveInput): Routing {
  return { targets: item.notes.map(note => ({ key: note.id, noteIds: [note.id], matchId: null, title: note.title, summary: note.summary, parent: null })), groups: [], relations: [] };
}

function card(id: string, parentId: string | null = null): KnowledgeNode {
  return { id, kind: "knowledge", parentId, title: id, summary: `${id}简介`, file: `cards/${id}.md`, createdAt: stamp, updatedAt: stamp, recordIds: [] };
}

function group(id: string, parentId: string | null = null): KnowledgeNode {
  return { ...card(id, parentId), kind: "group", file: null };
}

async function temp(t: { after(fn: () => Promise<void>): void }, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function seed(root: string, index: KnowledgeIndex): Promise<void> {
  for (const node of index.nodes) {
    if (node.file === null) continue;
    await mkdir(join(root, "cards"), { recursive: true });
    await writeFile(join(root, node.file), `# ${node.title}\n\nPRIVATE BODY ${node.id}\n`);
  }
  await writeFile(join(root, "index.json"), JSON.stringify(index));
}

async function markdown(root: string, node: KnowledgeNode): Promise<string> {
  assert.equal(node.kind, "knowledge");
  assert.ok(node.file);
  return readFile(join(root, node.file), "utf8");
}

async function graph(root: string) {
  const html = await readFile(join(root, "index.html"), "utf8");
  assert.doesNotMatch(html, /__PI_CARDEX_DATA__|\/\*PI_CARDEX_CSS\*\/|\/\*PI_CARDEX_JS\*\//);
  return { html, data: JSON.parse(html.match(/<script id="cardex-data" type="application\/json">([\s\S]*?)<\/script>/)![1]!) };
}

test("多新知识卡和分组：前向引用、UUID、三级树与独立语义关系", async t => {
  const root = await temp(t, "cardex-multi-");
  const item = input("r1");
  item.notes.push({ ...item.notes[0]!, id: "n2", title: "词法作用域", summary: "词法作用域规则" });
  const plan = routing(item);
  plan.groups = [{ key: "inner", title: "作用域", summary: "作用域分组", parent: "group:outer" }, { key: "outer", title: "JavaScript", summary: "语言", parent: null }];
  plan.targets[0]!.parent = "group:inner";
  plan.targets[1]!.parent = "group:outer";
  plan.targets[0]!.title = "路由指定标题";
  plan.targets[0]!.summary = "路由指定简介";
  plan.relations = [{ source: "target:n1", target: "target:n2", relation: "基础", reason: "闭包保留词法环境" }];
  const result = await archive(root, item, async () => plan);
  assert.equal(result.created, 2); assert.equal(result.updated, 0); assert.equal(result.duplicate, false);
  assert.equal(result.nodes.length, 2);
  assert.ok(result.nodes.every(node => node.kind === "knowledge"));
  const index = await loadIndex(root);
  assert.equal(index.version, 2); assert.equal(index.nodes.length, 4); assert.equal(index.edges.length, 1);
  assert.ok(index.nodes.every(node => /^[0-9a-f-]{36}$/.test(node.id)));
  assert.equal(result.nodes[0]!.title, "路由指定标题"); assert.equal(result.nodes[0]!.summary, "路由指定简介");
  const inner = index.nodes.find(node => node.title === "作用域")!;
  const outer = index.nodes.find(node => node.title === "JavaScript")!;
  assert.equal(result.nodes[0]!.parentId, inner.id); assert.equal(inner.parentId, outer.id); assert.equal(outer.parentId, null);
  assert.deepEqual(index.edges, [{ source: result.nodes[0]!.id, target: result.nodes[1]!.id, relation: "基础", reason: "闭包保留词法环境" }]);
  assert.equal(index.discussions.length, 1);
  assert.deepEqual(index.discussions[0]!.nodeIds, result.nodes.map(node => node.id));
  const { data } = await graph(root);
  assert.equal(data.version, 2);
  assert.ok(data.nodes.filter((node: KnowledgeNode) => node.kind === "group").every((node: { file: unknown; markdown: string; entryCount: number }) => node.file === null && node.markdown === "" && node.entryCount === 0));
  const files = await readdir(join(root, "cards"));
  assert.equal(files.length, 2, "分组没有正文文件");
  const indexBefore = await readFile(join(root, "index.json"), "utf8");
  const duplicate = await archive(root, item, noModel);
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.created, 0); assert.equal(duplicate.updated, 0);
  assert.deepEqual(new Set(duplicate.nodes.map(node => node.id)), new Set(result.nodes.map(node => node.id)));
  assert.equal(await readFile(join(root, "index.json"), "utf8"), indexBefore);
});

test("同次新增与追加：标题和父级保持，只替换本批目标的语义关系", async t => {
  const root = await temp(t, "cardex-append-");
  const index = emptyIndex();
  index.nodes = [group("g"), card("a", "g"), card("b"), card("c")];
  index.nodes[1]!.recordIds = ["old"];
  index.edges = [{ source: "a", target: "b", relation: "旧关系", reason: "应被本次替换" }, { source: "b", target: "c", relation: "保留", reason: "与本次目标无关" }];
  await seed(root, index);
  const old = await readFile(join(root, "cards/a.md"), "utf8");
  const item = input("r2");
  item.notes.push({ ...item.notes[0]!, id: "n2", title: "新知识" });
  const plan = routing(item);
  plan.targets[0]!.matchId = "a";
  plan.targets[0]!.title = "不得重命名";
  plan.targets[0]!.parent = "existing:g";
  plan.targets[0]!.summary = "定义、应用与新增细节";
  plan.targets[1]!.parent = "target:n1";
  plan.relations = [{ source: "target:n2", target: "existing:b", relation: "应用", reason: "新知识应用 b" }];
  const result = await archive(root, item, async (_system, data) => {
    assert.doesNotMatch(JSON.stringify(data), /PRIVATE BODY|整理正文|原始回答|cards\//, "路由输入只有名称简介与结构元数据");
    return plan;
  });
  assert.equal(result.created, 1); assert.equal(result.updated, 1);
  assert.equal(result.nodes[0]!.id, "a"); assert.equal(result.nodes[0]!.title, "a"); assert.equal(result.nodes[0]!.parentId, "g");
  assert.equal(result.nodes[1]!.parentId, "a");
  const body = await markdown(root, result.nodes[0]!);
  assert.ok(body.includes(old.trim()));
  assert.match(body, /定义、应用与新增细节/); assert.match(body, /record:r2/);
  assert.deepEqual(result.nodes[0]!.recordIds, ["old", "r2"]);
  const next = await loadIndex(root);
  assert.deepEqual(next.edges, [index.edges[1], { source: result.nodes[1]!.id, target: "b", relation: "应用", reason: "新知识应用 b" }]);
  assert.equal(await readFile(join(root, "cards/b.md"), "utf8"), "# b\n\nPRIVATE BODY b\n");
  assert.equal((await archive(root, item, noModel)).nodes.length, 2);
});

test("同批 notes 合并：record 只记一次，问答按来源去重归属，不采用模型引文", async t => {
  const root = await temp(t, "cardex-sources-");
  const item = input("sources");
  item.messages.push({ role: "user", text: "独立问题乙", timestamp: 3 }, { role: "assistant", text: "独立原文乙", model: "p/second", timestamp: 4, status: "aborted" });
  item.notes = [
    { ...item.notes[0]!, id: "a", title: "笔记甲", content: "甲整理", messageIndices: [1, 0, 1] },
    { ...item.notes[0]!, id: "b", title: "笔记甲补充", content: "甲补充整理", messageIndices: [0] },
    { ...item.notes[0]!, id: "c", title: "笔记乙", content: "乙整理", messageIndices: [2, 3] },
  ];
  const plan = routing(item);
  plan.targets = [ { ...plan.targets[0]!, noteIds: ["a", "b"] }, plan.targets[2]! ];
  const result = await archive(root, item, async () => plan);
  const a = await markdown(root, result.nodes[0]!);
  const b = await markdown(root, result.nodes[1]!);
  assert.equal(a.split("<!-- record:sources -->").length - 1, 1);
  assert.deepEqual(result.nodes[0]!.recordIds, ["sources"]);
  assert.match(a, /甲整理/); assert.match(a, /甲补充整理/);
  assert.equal(a.split("原始回答").length - 1, 1);
  assert.equal(a.split("问 闭包").length - 1, 1);
  assert.doesNotMatch(a, /独立问题乙|独立原文乙|乙整理|message-2|message-3/);
  assert.match(b, /独立问题乙/); assert.match(b, /独立原文乙/); assert.match(b, /回答已中断/);
  assert.doesNotMatch(b, /甲整理|甲补充整理|原始回答|问 闭包|message-0|message-1/);
  assert.match(a, /\.\.\/discussions\/sources\.md#message-0/);
  assert.match(b, /\.\.\/discussions\/sources\.md#message-3/);
  const transcript = await readFile(join(root, "discussions/sources.md"), "utf8");
  for (let i = 0; i < 4; i++) assert.match(transcript, new RegExp(`<a id="message-${i}"></a>`));
  assert.match(transcript, /p\/m/); assert.match(transcript, /p\/second/); assert.match(transcript, /1970-01-01T00:00:00.001Z/);
  assert.doesNotMatch(transcript, /甲整理|甲补充整理|乙整理/);
  assert.deepEqual(await readdir(join(root, "discussions")), ["sources.md"]);
  const { data } = await graph(root);
  const readings = result.nodes.map(node => data.nodes.find((entry: { id: string }) => entry.id === node.id).reading);
  assert.deepEqual(readings.map(reading => reading.records[0].id), ["sources", "sources"]);
  assert.match(readings[0].records[0].content, /甲整理/);
  assert.doesNotMatch(readings[0].records[0].transcript, /独立问题乙|独立原文乙/);
  assert.match(readings[1].records[0].transcript, /独立原文乙/);
  assert.doesNotMatch(readings[1].records[0].transcript, /问 闭包|原始回答/);
});

test("分组命中后提升为知识卡，ID、父级和已有子节点保持", async t => {
  const root = await temp(t, "cardex-promote-");
  const index = emptyIndex(); index.nodes = [group("parent"), group("promote", "parent"), card("child", "promote")];
  await seed(root, index);
  const item = input("promoted"); const plan = routing(item); plan.targets[0]!.matchId = "promote"; plan.targets[0]!.parent = "existing:parent";
  const result = await archive(root, item, async () => plan);
  assert.equal(result.created, 0); assert.equal(result.updated, 1);
  assert.equal(result.nodes[0]!.id, "promote"); assert.equal(result.nodes[0]!.title, "promote");
  assert.equal(result.nodes[0]!.parentId, "parent"); assert.equal(result.nodes[0]!.kind, "knowledge");
  assert.equal((await loadIndex(root)).nodes.find(node => node.id === "child")!.parentId, "promote");
  assert.match(await markdown(root, result.nodes[0]!), /整理正文/);
});

test("v1 索引原地迁移、旧 record 去重；新写入 v2 不虚构历史讨论文件", async t => {
  const root = await temp(t, "cardex-migrate-");
  const oldNode = { id: "legacy", title: "旧卡", summary: "旧简介", file: "cards/legacy.md", createdAt: stamp, updatedAt: stamp, recordIds: ["historical"] };
  const old = { version: 1, revision: 4, updatedAt: stamp, nodes: [oldNode], edges: [] };
  await mkdir(join(root, "cards")); await writeFile(join(root, oldNode.file), "# 原始旧正文\n不应丢失");
  await writeFile(join(root, "index.json"), JSON.stringify(old));
  const loaded = await loadIndex(root);
  assert.equal(loaded.version, 2); assert.equal(loaded.nodes[0]!.id, "legacy");
  assert.equal(loaded.nodes[0]!.kind, "knowledge"); assert.equal(loaded.nodes[0]!.parentId, null); assert.deepEqual(loaded.discussions, []);
  const duplicate = await archive(root, input("historical"), noModel);
  assert.deepEqual(duplicate.nodes.map(node => node.id), ["legacy"]); assert.equal(duplicate.duplicate, true);
  assert.equal(JSON.parse(await readFile(join(root, "index.json"), "utf8")).version, 1, "只读及重复操作不重写索引");
  const item = input("new"); const plan = routing(item); plan.targets[0]!.matchId = "legacy";
  await archive(root, item, async () => plan);
  const next = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
  assert.equal(next.version, 2); assert.equal(next.revision, 5); assert.deepEqual(next.nodes[0].recordIds, ["historical", "new"]);
  assert.match(await readFile(join(root, oldNode.file), "utf8"), /原始旧正文\n不应丢失/);
  assert.deepEqual(await readdir(join(root, "discussions")), ["new.md"]);
});

test("模型格式错误、缺失卡片、来源越界均在写入前失败", async t => {
  const root = await temp(t, "cardex-invalid-");
  const index = emptyIndex(); index.nodes = [card("existing")]; await seed(root, index);
  const before = await readFile(join(root, "index.json"), "utf8");
  const oldBody = await readFile(join(root, "cards/existing.md"), "utf8");
  await assert.rejects(archive(root, input("r2"), async () => "broken"), /有效 JSON/);
  const invalid = input("badsource"); invalid.notes[0]!.messageIndices = [2];
  await assert.rejects(archive(root, invalid, async () => { throw new Error("来源无效时不应调用模型"); }), /来源消息索引无效/);
  invalid.notes[0]!.messageIndices = [-1];
  await assert.rejects(archive(root, invalid, noModel), /来源消息索引无效/);
  invalid.notes[0]!.messageIndices = [0.5];
  await assert.rejects(archive(root, invalid, noModel), /来源消息索引无效/);
  await assert.rejects(archive(root, input("../outside"), noModel), /记录 ID 无效/);
  assert.equal(await readFile(join(root, "cards/existing.md"), "utf8"), oldBody);
  const item = input("r2"); const plan = routing(item); plan.targets[0]!.matchId = "existing";
  await rm(join(root, "cards/existing.md"));
  await assert.rejects(archive(root, item, async () => plan), /卡片文件缺失/);
  assert.equal(await readFile(join(root, "index.json"), "utf8"), before);
  await assert.rejects(access(join(root, "discussions"))); await assert.rejects(access(join(root, pendingFile)));
});

test("parseIndex 校验三级、环、无父、路径、group/file、node 内 record 和讨论双向关联", () => {
  const valid = emptyIndex(); valid.nodes = [group("root"), card("parent", "root"), card("leaf", "parent")];
  valid.nodes[1]!.recordIds = ["shared"]; valid.nodes[2]!.recordIds = ["shared"];
  valid.discussions = [{ id: "shared", file: "discussions/shared.md", createdAt: stamp, organizer: "p/o", nodeIds: ["parent", "leaf"] }];
  assert.equal(parseIndex(valid).nodes.length, 3, "父节点可以是真知识卡，同 record 跨卡合法");
  const cases: [string, (index: KnowledgeIndex) => void, RegExp][] = [
    ["第四级", index => { index.nodes.push(card("fourth", "leaf")); }, /不能超过 3 级/],
    ["环", index => { index.nodes[0]!.parentId = "leaf"; }, /存在环/],
    ["无父", index => { index.nodes[0]!.parentId = "missing"; }, /父节点不存在/],
    ["危险卡片路径", index => { index.nodes[1]!.file = "cards/../../outside.md"; }, /条目无效/],
    ["危险节点 ID", index => { index.nodes[1]!.id = "../outside"; }, /条目无效/],
    ["分组有文件", index => { index.nodes[0]!.file = "cards/root.md"; }, /条目无效/],
    ["分组有 record", index => { index.nodes[0]!.recordIds = ["record"]; }, /条目无效/],
    ["知识卡无文件", index => { index.nodes[1]!.file = null; }, /条目无效/],
    ["node 内 record 重复", index => { index.nodes[1]!.recordIds.push("shared"); }, /条目无效/],
    ["讨论遗漏卡片", index => { index.discussions[0]!.nodeIds = ["leaf"]; }, /双向关联/],
    ["卡片遗漏讨论", index => { index.nodes[2]!.recordIds = []; }, /双向关联/],
    ["讨论危险路径", index => { index.discussions[0]!.file = "../outside.md"; }, /来源条目/],
    ["讨论重复节点", index => { index.discussions[0]!.nodeIds.push("leaf"); }, /来源条目/],
    ["讨论重复", index => { index.discussions.push(structuredClone(index.discussions[0]!)); }, /来源条目/],
    ["关系不存在", index => { index.edges.push({ source: "root", target: "missing", relation: "r", reason: "why" }); }, /关系无效/],
    ["自关联", index => { index.edges.push({ source: "leaf", target: "leaf", relation: "r", reason: "why" }); }, /关系无效/],
    ["无向重复关系", index => { index.edges.push({ source: "leaf", target: "parent", relation: "r", reason: "why" }, { source: "parent", target: "leaf", relation: "r2", reason: "why2" }); }, /关系重复/],
  ];
  for (const [name, mutate, error] of cases) {
    const broken = structuredClone(valid); mutate(broken); assert.throws(() => parseIndex(broken), error, name);
  }
  assert.equal(valid.nodes[0]!.parentId, null, "校验不修改调用方对象");
});

test("非法落盘索引拒绝读取且全部源文件保持不变", async t => {
  const root = await temp(t, "cardex-bad-index-");
  const index = emptyIndex(); index.nodes = [group("g"), card("a", "g"), card("b", "a")]; await seed(root, index);
  const body = await readFile(join(root, "cards/a.md"), "utf8");
  for (const mutate of [
    (bad: KnowledgeIndex) => { bad.nodes.push(card("too-deep", "b")); },
    (bad: KnowledgeIndex) => { bad.nodes[0]!.parentId = "b"; },
    (bad: KnowledgeIndex) => { bad.nodes[1]!.file = "../../outside.md"; },
  ]) {
    const bad = structuredClone(index); mutate(bad);
    const raw = JSON.stringify(bad); await writeFile(join(root, "index.json"), raw);
    await assert.rejects(archive(root, input("not-written"), noModel), /不能超过|存在环|条目无效/);
    assert.equal(await readFile(join(root, "index.json"), "utf8"), raw);
    assert.equal(await readFile(join(root, "cards/a.md"), "utf8"), body);
    await assert.rejects(access(join(root, "discussions"))); await assert.rejects(access(join(root, pendingFile)));
  }
});

test("非法路由的第四级、环在建立 WAL 前失败，现有正文不变", async t => {
  const root = await temp(t, "cardex-bad-plan-");
  const index = emptyIndex(); index.nodes = [group("root"), card("parent", "root"), card("leaf", "parent")]; await seed(root, index);
  const before = await readFile(join(root, "index.json"), "utf8");
  const body = await readFile(join(root, "cards/leaf.md"), "utf8");
  const item = input("bad-depth"); const tooDeep = routing(item); tooDeep.targets[0]!.parent = "existing:leaf";
  await assert.rejects(archive(root, item, async () => tooDeep), /3|三级|层级|深度/);
  const cycle = routing(item); cycle.targets[0]!.parent = "group:g"; cycle.groups = [{ key: "g", title: "循环", summary: "循环", parent: "target:n1" }];
  await assert.rejects(archive(root, item, async () => cycle), /环|循环/);
  assert.equal(await readFile(join(root, "index.json"), "utf8"), before);
  assert.equal(await readFile(join(root, "cards/leaf.md"), "utf8"), body);
  await assert.rejects(access(join(root, pendingFile))); await assert.rejects(access(join(root, "discussions")));
});

test("旧 version1 WAL 在旧索引、卡片后和索引后均可重放并迁移", async t => {
  for (const stage of ["before", "card", "index"]) await t.test(stage, async st => {
    const root = await temp(st, "cardex-old-wal-");
    const oldNode = { id: "legacy", title: "旧卡", summary: "旧简介", file: "cards/legacy.md", createdAt: stamp, updatedAt: stamp, recordIds: ["old"] };
    const current = { version: 1, revision: 1, updatedAt: stamp, nodes: [oldNode], edges: [] };
    const next = structuredClone(current); next.revision = 2; next.nodes[0]!.recordIds.push("recovered");
    const content = "# 旧正文\n\nRECOVERED $& $`";
    await mkdir(join(root, "cards"));
    await writeFile(join(root, "cards/legacy.md"), stage === "before" ? "# 旧正文" : content);
    await writeFile(join(root, "index.json"), JSON.stringify(stage === "index" ? next : current));
    await writeFile(join(root, pendingFile), JSON.stringify({ version: 1, index: next, card: { file: "cards/legacy.md", content } }));
    const loaded = await loadIndex(root);
    assert.equal(loaded.revision, 2); assert.equal(loaded.version, 2); assert.equal(loaded.nodes[0]!.id, "legacy");
    assert.deepEqual(loaded.discussions, []); assert.equal(await readFile(join(root, "cards/legacy.md"), "utf8"), content);
    assert.equal(JSON.parse(await readFile(join(root, "index.json"), "utf8")).version, 2);
    await assert.rejects(access(join(root, pendingFile))); await assert.rejects(access(join(root, "discussions")));
    const result = await archive(root, input("recovered"), noModel); assert.equal(result.duplicate, true);
    assert.equal((await graph(root)).data.nodes[0].markdown, content);
  });
});

function multiFileTransaction() {
  const index = emptyIndex(); index.revision = 1; index.updatedAt = stamp;
  index.nodes = [card("a"), card("b")];
  for (const node of index.nodes) node.recordIds = ["record"];
  index.discussions = [{ id: "record", file: "discussions/record.md", createdAt: stamp, organizer: "p/o", nodeIds: ["a", "b"] }];
  const files = [ { file: "discussions/record.md", content: "RAW DISCUSSION" }, { file: "cards/a.md", content: "CARD A" }, { file: "cards/b.md", content: "CARD B" } ];
  return { version: 2, index, files };
}

test("version2 WAL 多文件中途真实写入失败后重放，retry 返回全部卡片", async t => {
  const root = await temp(t, "cardex-wal-multi-");
  const tx = multiFileTransaction();
  await writeFile(join(root, "index.json"), JSON.stringify(emptyIndex()));
  await writeFile(join(root, pendingFile), JSON.stringify(tx));
  // Directory occupying the last card forces a real rename failure after earlier files were written.
  await mkdir(join(root, "cards/b.md"), { recursive: true });
  await assert.rejects(loadIndex(root), (error: NodeJS.ErrnoException) => ["EISDIR", "ENOTEMPTY", "EEXIST"].includes(error.code ?? ""));
  assert.equal(await readFile(join(root, "discussions/record.md"), "utf8"), "RAW DISCUSSION");
  assert.equal(await readFile(join(root, "cards/a.md"), "utf8"), "CARD A");
  assert.equal(JSON.parse(await readFile(join(root, "index.json"), "utf8")).revision, 0);
  await access(join(root, pendingFile));
  await rm(join(root, "cards/b.md"), { recursive: true });
  const result = await archive(root, input("record"), noModel);
  assert.equal(result.duplicate, true); assert.deepEqual(result.nodes.map(node => node.id), ["a", "b"]);
  assert.equal((await loadIndex(root)).revision, 1);
  assert.equal(await readFile(join(root, "cards/b.md"), "utf8"), "CARD B");
  await assert.rejects(access(join(root, pendingFile)));
  assert.equal((await graph(root)).data.nodes.length, 2);
});

test("version2 WAL 索引写入后 HTML 失败可恢复，已提交 revision 可重复重放", async t => {
  const root = await temp(t, "cardex-wal-html-");
  const tx = multiFileTransaction();
  await writeFile(join(root, pendingFile), JSON.stringify(tx));
  await mkdir(join(root, "index.html"));
  await assert.rejects(loadIndex(root), (error: NodeJS.ErrnoException) => ["EISDIR", "ENOTEMPTY", "EEXIST"].includes(error.code ?? ""));
  assert.equal(JSON.parse(await readFile(join(root, "index.json"), "utf8")).revision, 1);
  await access(join(root, pendingFile));
  await rm(join(root, "index.html"), { recursive: true });
  assert.equal((await loadIndex(root)).revision, 1);
  const first = await graph(root);
  await writeFile(join(root, pendingFile), JSON.stringify(tx));
  assert.equal((await loadIndex(root)).revision, 1);
  const second = await graph(root);
  assert.equal(first.data.libraryId, second.data.libraryId);
  assert.deepEqual(first.data.nodes, second.data.nodes);
  await assert.rejects(access(join(root, pendingFile)));
});

test("WAL 危险路径、重复文件与 revision 冲突在任何文件写入前拒绝", async t => {
  const root = await temp(t, "cardex-wal-invalid-");
  const current = emptyIndex(); current.revision = 5;
  const raw = JSON.stringify(current); await writeFile(join(root, "index.json"), raw);
  const invalid = multiFileTransaction(); invalid.index.revision = 6;
  invalid.files.push({ file: "../outside.md", content: "must not write" });
  await writeFile(join(root, pendingFile), JSON.stringify(invalid));
  await assert.rejects(loadIndex(root), /文件路径/);
  const duplicate = multiFileTransaction(); duplicate.index.revision = 6; duplicate.files.push(duplicate.files[0]!);
  await writeFile(join(root, pendingFile), JSON.stringify(duplicate));
  await assert.rejects(loadIndex(root), /文件路径/);
  const conflict = multiFileTransaction();
  await writeFile(join(root, pendingFile), JSON.stringify(conflict));
  await assert.rejects(loadIndex(root), /索引版本冲突/);
  assert.equal(await readFile(join(root, "index.json"), "utf8"), raw);
  await assert.rejects(access(join(root, "cards"))); await assert.rejects(access(join(root, "discussions")));
});

test("HTML 安全嵌入无损原文，libraryId 稳定且分组为空正文", async t => {
  const root = await temp(t, "cardex-html-");
  const index = emptyIndex(); index.nodes = [group("g"), card("safe", "g")]; await seed(root, index);
  const content = '</script><script>globalThis.pwned=1</script> $& $` < > & \u2028 \u2029';
  await writeFile(join(root, "cards/safe.md"), content);
  await rebuildGraph(root);
  const first = await graph(root);
  assert.doesNotMatch(first.html, /<script>globalThis.pwned/); assert.match(first.html, /\\u003c\/script\\u003e/);
  assert.equal(first.data.nodes[1].markdown, content, "JSON 转义后原文和替换特殊字符应无损还原");
  assert.equal(first.data.nodes[0].markdown, ""); assert.equal(first.data.nodes[0].file, null);
  await rebuildGraph(root);
  assert.equal((await graph(root)).data.libraryId, first.data.libraryId);
});

test("空知识库可生成浏览页，不改变知识索引", async t => {
  const root = await temp(t, "cardex-empty-");
  await rebuildGraph(root);
  assert.equal((await graph(root)).data.version, 2);
  assert.equal((await loadIndex(root)).nodes.length, emptyIndex().nodes.length);
  await assert.rejects(access(join(root, "index.json")));
});
