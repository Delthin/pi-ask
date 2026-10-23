import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardReading } from "../src/reading.ts";
import { archive, rebuildGraph } from "../src/store.ts";
import type { ArchiveInput } from "../src/store.ts";

const fixture = `---
id: "card"
title: "闭包"
---

# 闭包

手写前言保留。

---

## 2026-01-02T03:04:05.000Z

<!-- record:first -->
整理模型：local/organizer

### 闭包的定义

#### 背景

函数返回之后。

#### 知识整理

函数保留定义时的词法环境。

### 相关原始问答

[原始消息 message-0](../discussions/first.md#message-0)

### 用户问题（user） · 2026-01-02T03:00:00.000Z

为什么变量还存在？

[原始消息 message-1](../discussions/first.md#message-1)

### 模型回答（assistant） · provider/model（回答已中断） · 2026-01-02T03:01:00.000Z

因为仍有引用。
`;

const second = `
---

## 2026-01-03T03:04:05.000Z

<!-- record:second -->
整理模型：local/other

### 变量捕获

#### 知识整理

补充同一变量的后续变化，不替代基础定义。

### 相关原始问答

[原始消息 message-2](../discussions/second.md#message-2)

### 用户问题（user） · 2026-01-03T03:00:00.000Z

值是快照吗？

[原始消息 message-3](../discussions/second.md#message-3)

### 模型回答（assistant） · provider/second · 2026-01-03T03:01:00.000Z

读到的是变量当前值。
`;

test("只读批次：保留前言、按原顺序分离整理和来源，含模型与中断标记", () => {
  const reading = cardReading(fixture + second, ["first", "second"]);
  assert.ok(reading);
  assert.match(reading.introduction, /# 闭包\n\n手写前言保留。/);
  assert.deepEqual(reading.records.map(r => r.id), ["first", "second"]);
  assert.deepEqual(reading.records.map(r => r.titles), [["闭包的定义"], ["变量捕获"]]);
  assert.equal(reading.records[1]!.archivedAt, "2026-01-03T03:04:05.000Z");
  assert.equal(reading.records[1]!.organizer, "local/other");
  assert.match(reading.records[0]!.content, /函数保留定义时的词法环境/);
  assert.doesNotMatch(reading.records[0]!.content, /为什么变量还存在|变量捕获/);
  assert.match(reading.records[0]!.transcript, /provider\/model（回答已中断）/);
  assert.match(reading.records[0]!.transcript, /discussions\/first\.md#message-1/);
  assert.doesNotMatch(reading.records[0]!.transcript, /值是快照吗/);
  assert.match(reading.records[1]!.transcript, /值是快照吗/);
});

test("CRLF 和 Markdown 示例不会改变归档分界；长围栏内短围栏不算结束", () => {
  for (const fence of ["````", "~~~~"]) {
    const sample = `${fence}md\n---\n\n## 2026-01-02T03:04:05.000Z\n\n<!-- record:first -->\n整理模型：fake\n\n### 相关原始问答\n${fence.slice(1)}\n<!-- record:second -->\n${fence}\n\n`;
    const text = fixture.replace("函数保留定义时的词法环境。", sample + "函数保留定义时的词法环境。") + second;
    assert.equal(cardReading(text, ["first", "second"])?.records.length, 2);
    const windows = text.replaceAll("\n", "\r\n");
    const result = cardReading(windows, ["first", "second"]);
    assert.equal(result?.records.length, 2);
    assert.ok(result!.records[0]!.content.includes(sample.replaceAll("\n", "\r\n")), "保留原有换行和代码示例");
  }
});

test("旧版、缺失/重复/错序标记、被编辑的分隔或来源均完整回退，不猜测", () => {
  const cases: [string, string, string[]][] = [
    ["旧卡", "# 旧卡\n\n原始内容", ["legacy"]],
    ["缺一条历史", fixture, ["first", "missing"]],
    ["重复索引", fixture, ["first", "first"]],
    ["错序", fixture + second, ["second", "first"]],
    ["额外已知标记", fixture + "\n<!-- record:first -->\n", ["first"]],
    ["重复原文标题", fixture + "\n### 相关原始问答\n", ["first"]],
    ["分隔线编辑", fixture.replace("\n\n---\n\n##", "\n\n***\n\n##"), ["first"]],
    ["日期非法", fixture.replace("2026-01-02T03:04:05.000Z", "2026-02-31T03:04:05.000Z"), ["first"]],
    ["日期标题编辑", fixture.replace("## 2026-01-02T03:04:05.000Z", "## 学习记录"), ["first"]],
    ["来源串卡", fixture.replace("../discussions/first.md#message-0", "../discussions/other.md#message-0"), ["first"]],
    ["消息位置不符", fixture.replace("first.md#message-0", "first.md#message-9"), ["first"]],
    ["缺原始问答", fixture.slice(0, fixture.indexOf("### 相关原始问答")), ["first"]],
    ["未闭合围栏覆盖分界", "```md\n" + fixture, ["first"]],
  ];
  for (const [name, text, ids] of cases) assert.equal(cardReading(text, ids), undefined, name);
  assert.equal(cardReading(fixture, []), undefined);
});

test("真实归档连续补充后导出批次，重建不会修改卡片/索引或调用模型", async t => {
  const root = await mkdtemp(join(tmpdir(), "ask-reading-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let cardId: string | null = null;
  let file = "";
  for (let i = 0; i < 3; i++) {
    const item: ArchiveInput = {
      recordId: `discussion-${i}`, organizer: `p/organizer-${i}`,
      notes: [{ id: "n1", title: `主题 ${i}`, summary: "词法环境", background: "背景", content: `第 ${i} 批解释`, messageIndices: [0, 1] }],
      messages: [{ role: "user", text: `问题 ${i}`, timestamp: i + 1 }, { role: "assistant", text: `回答 ${i}`, model: "p/answer", timestamp: i + 2 }],
    };
    const result = await archive(root, item, async (_system, data) => {
      assert.doesNotMatch(JSON.stringify(data), /批解释|问题 \d|回答 \d/, "归类模型仍不看正文");
      return { targets: [{ key: "t1", noteIds: ["n1"], matchId: cardId, title: "词法环境", summary: "词法环境", parent: null }], groups: [], relations: [] };
    });
    cardId = result.nodes[0]!.id;
    file = result.nodes[0]!.file!;
  }
  const before = await readFile(join(root, file), "utf8");
  const indexBefore = await readFile(join(root, "index.json"), "utf8");
  await rebuildGraph(root);
  assert.equal(await readFile(join(root, file), "utf8"), before);
  assert.equal(await readFile(join(root, "index.json"), "utf8"), indexBefore);
  const html = await readFile(join(root, "index.html"), "utf8");
  const graph = JSON.parse(html.match(/<script id="ask-data" type="application\/json">([\s\S]*?)<\/script>/)![1]!);
  assert.equal(graph.nodes[0].markdown, before, "下载数据始终为完整原文件");
  assert.equal(graph.nodes[0].entryCount, 3);
  assert.equal(graph.nodes[0].reading.records.length, 3);
  for (let i = 0; i < 3; i++) {
    const record = graph.nodes[0].reading.records[i];
    assert.equal(record.id, `discussion-${i}`);
    assert.match(record.content, new RegExp(`第 ${i} 批解释`));
    assert.match(record.transcript, new RegExp(`问题 ${i}`));
    assert.match(record.transcript, new RegExp(`回答 ${i}`));
    assert.equal(record.organizer, `p/organizer-${i}`);
  }
});
