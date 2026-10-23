import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

interface Point {
  x: number;
  y: number;
}

interface ReadingRecord {
  id: string;
  archivedAt: string;
  organizer: string;
  titles: string[];
  content: string;
  transcript: string;
}

interface CardReading {
  introduction: string;
  records: ReadingRecord[];
}

interface MdBlock {
  type: string;
  text?: string;
  level?: number;
  children?: MdBlock[];
  items?: Array<{ blocks: MdBlock[] }>;
  id?: string;
}

interface ReadingDoc {
  kind: "intro" | "content" | "transcript";
  ns: string;
  blocks: MdBlock[];
  index: number;
  record: ReadingRecord | null;
  anchorMap: Map<string, string>;
}

interface Hierarchy {
  parentOf: Map<string, string | null>;
  childrenOf: Map<string, string[]>;
  roots: string[];
  depthOf: Map<string, number>;
  detached: string[];
}

interface WebHelpers {
  safeHref(value: string): { kind: string; href: string } | null;
  buildHierarchy(
    nodes: Array<{ id: string; parentId?: string | null; title?: string }>
  ): Hierarchy;
  treeQuery(
    ids: string[],
    parentOf: Map<string, string | null>,
    match: (id: string) => boolean
  ): { hitIds: Set<string>; visible: Set<string>; expand: Set<string> };
  computeTreeLayout(
    roots: string[],
    childrenOf: Map<string, string[]>,
    sizeOf: (id: string) => { w: number; h: number },
    opts?: { siblingGap?: number; levelGap?: number; rootGap?: number }
  ): Map<string, Point>;
  applySkipTitle(blocks: MdBlock[], skipTitle?: string): MdBlock[];
  prepareHeadingIds(
    blocks: MdBlock[],
    ns: string,
    usedIds: Record<string, boolean>,
    anchorMap?: Map<string, string>
  ): void;
  resolveAnchor(fragment: string, anchorMap: Map<string, string> | null): string | null;
  normalizeReading(raw: unknown): CardReading | null;
  buildReadingViews(node: {
    title?: string;
    reading?: unknown;
  } | null): { reading: CardReading | null; docs: ReadingDoc[]; anchorMap: Map<string, string> | null };
}

const module = { exports: {} as WebHelpers };
runInNewContext(await readFile(new URL("../web/graph.js", import.meta.url), "utf8"), { module });
const {
  safeHref,
  buildHierarchy,
  treeQuery,
  computeTreeLayout,
  applySkipTitle,
  prepareHeadingIds,
  resolveAnchor,
  normalizeReading,
  buildReadingViews,
} = module.exports;

test("Markdown 链接仅允许网页、同页锚点和卡片路径", () => {
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,test",
    "//example.org",
    "\\\\example.org",
    "https://example.org\n.bad",
    "../private",
    "file:///etc/passwd",
    "cards/../../private",
    "../discussions/abc/x.md",
    "../discussions/abc-123.md#other-1",
    "discussions/abc-123.md",
    "../../discussions/abc-123.md",
  ]) {
    assert.equal(safeHref(value), null, value);
  }
  for (const [href, kind] of [
    ["https://example.org", "external"],
    ["#笔记", "anchor"],
    ["cards/abc-123.md", "relative"],
  ] as const) {
    assert.equal(safeHref(href)?.href, href);
    assert.equal(safeHref(href)?.kind, kind);
  }
});

test("讨论来源链接重定位为库根相对路径", () => {
  assert.equal(safeHref("../discussions/abc-123.md#message-3")?.kind, "relative");
  assert.equal(safeHref("../discussions/abc-123.md#message-3")?.href, "discussions/abc-123.md#message-3");
  assert.equal(safeHref("../discussions/abc-123.md")?.href, "discussions/abc-123.md");
});

function node(id: string, parentId?: string | null): { id: string; parentId: string | null } {
  return { id, parentId: parentId ?? null };
}

test("层级构建：幽灵父节点与自指视为根，环拆为根", () => {
  const nodes = [
    node("a", "ghost"),
    node("b", "b"),
    node("c", "d"),
    node("d", "c"),
    node("e", "a"),
    node("f", "e"),
  ];
  const h = buildHierarchy(nodes);
  for (const id of ["a", "b", "c", "d"]) {
    assert.ok(h.roots.includes(id), `root ${id}`);
    assert.equal(h.parentOf.get(id), null);
  }
  assert.ok(h.detached.includes("c") && h.detached.includes("d"));
  assert.deepEqual([...h.childrenOf.get("a")!], ["e"]);
  assert.deepEqual([...h.roots], [...h.roots].sort((x, y) => x.localeCompare(y)));
  assert.equal(h.depthOf.get("f"), 2);
  /* 缺少 parentId 字段时默认为根（兼容旧数据） */
  const legacy = buildHierarchy([{ id: "x" } as { id: string }]);
  assert.deepEqual([...legacy.roots], ["x"]);
});

test("层级构建：超深链与长环不会导致无限循环", () => {
  const deep: Array<{ id: string; parentId: string | null }> = [];
  for (let i = 0; i < 40; i++) deep.push(node(`n${i}`, i === 0 ? null : `n${i - 1}`));
  const ring: Array<{ id: string; parentId: string | null }> = [];
  for (let i = 0; i < 12; i++) ring.push(node(`r${i}`, `r${(i + 1) % 12}`));
  for (const set of [deep, ring, deep.concat(ring)]) {
    const h = buildHierarchy(set);
    assert.equal(h.roots.length + [...h.childrenOf.values()].reduce((s, arr) => s + arr.length, 0), set.length);
    for (const { id } of set) assert.ok(Number.isFinite(h.depthOf.get(id)!));
  }
});

test("树搜索：命中节点连同祖先可见，祖先强制展开", () => {
  const h = buildHierarchy([node("a"), node("b", "a"), node("c", "b"), node("d", "a")]);
  const q = treeQuery(["a", "b", "c", "d"], h.parentOf, (id) => id === "c");
  assert.deepEqual([...q.hitIds], ["c"]);
  assert.deepEqual([...q.visible].sort(), ["a", "b", "c"]);
  assert.deepEqual([...q.expand].sort(), ["a", "b"]);
  const none = treeQuery(["a", "b", "c", "d"], h.parentOf, () => false);
  assert.equal(none.hitIds.size, 0);
  assert.equal(none.visible.size, 0);
});

test("树布局：确定性输出，节点框不重叠且父节点居中", () => {
  const h = buildHierarchy([
    node("root"),
    node("k1", "root"),
    node("k2", "root"),
    node("g1", "k1"),
    node("g2", "k1"),
    node("other"),
  ]);
  const size = (id: string) => ({ w: 100, h: 40 });
  const pos = computeTreeLayout(h.roots, h.childrenOf, size, { siblingGap: 24, levelGap: 84 });
  assert.equal(pos.size, 6);
  assert.equal(JSON.stringify([...pos]), JSON.stringify([...computeTreeLayout(h.roots, h.childrenOf, size, { siblingGap: 24, levelGap: 84 })]));
  for (const p of pos.values()) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  }
  /* 父节点位于首末子节点中点 */
  const g = pos.get("g1")!;
  const g2 = pos.get("g2")!;
  assert.equal(pos.get("k1")!.x, (g.x + g2.x) / 2);
  /* 同层兄弟间隔至少为宽度 + siblingGap */
  assert.ok(g2.x - g.x >= 100 + 24 - 1e-6);
  /* 深度越大 y 越大 */
  assert.ok(pos.get("k1")!.y < g.y);
  assert.ok(pos.get("root")!.y < pos.get("k1")!.y);
  /* 所有节点框互不重叠（同一份坐标既覆盖同层也覆盖跨层） */
  const boxes = [...pos].map(([id, p]) => ({ id, x1: p.x - 50, x2: p.x + 50, y1: p.y - 20, y2: p.y + 20 }));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const overlap = a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
      assert.ok(!overlap, `${a.id} overlaps ${b.id}`);
    }
  }
});

test("树布局：空图返回空，直接成环不挂起", () => {
  assert.equal(computeTreeLayout([], new Map(), () => ({ w: 100, h: 40 })).size, 0);
  const h = buildHierarchy([node("x", "y"), node("y", "x")]);
  const pos = computeTreeLayout(h.roots, h.childrenOf, () => ({ w: 100, h: 40 }));
  assert.equal(pos.size, 2);
  for (const p of pos.values()) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
});

function record(over: Partial<ReadingRecord> = {}): ReadingRecord {
  return {
    id: "rec-1",
    archivedAt: "2024-01-03T09:00:00.000Z",
    organizer: "organizer",
    titles: ["标题"],
    content: "### 标题\n\n正文",
    transcript: "原文",
    ...over,
  };
}

test("normalizeReading：合法结构通过并过滤空标题，异常结构返回 null 回退原文", () => {
  const raw = {
    introduction: "前言",
    records: [record({ titles: ["", "有效标题"] }), record({ id: "rec-2" })],
  };
  const ok = normalizeReading(raw);
  assert.ok(ok);
  assert.equal(ok.records.length, 2);
  /* vm 跨 realm 数组：展开为宿主数组再比较 */
  assert.deepEqual([...ok.records[0].titles], ["有效标题"]);
  /* 无效输入一律 null：调用方回退到完整 Markdown 渲染 */
  assert.equal(normalizeReading(null), null);
  assert.equal(normalizeReading("text"), null);
  assert.equal(normalizeReading({ introduction: "x", records: [] }), null);
  assert.equal(normalizeReading({ introduction: 1, records: [record()] }), null);
  assert.equal(normalizeReading({ introduction: "x", records: [record({ content: "  " })] }), null);
  assert.equal(normalizeReading({ introduction: "x", records: [{ ...record(), titles: "no" }] }), null);
  assert.equal(normalizeReading({ introduction: "x", records: [{ ...record(), archivedAt: 5 }] }), null);
  /* 未知额外字段不影响识别（保守忽略，不回退） */
  const extra = normalizeReading({ introduction: "x", records: [{ ...record(), extra: 1 }] });
  assert.ok(extra);
  /* 允许缺失可选字段（transcript/titles/organizer 为空） */
  const sparse = normalizeReading({ introduction: "", records: [{ id: "r", archivedAt: "", organizer: "", titles: [], content: "正文" }] });
  assert.ok(sparse);
  assert.equal(sparse.records[0].transcript, "");
});

test("applySkipTitle：仅当首块是与卡片同名的标题时跳过", () => {
  const heading = (text: string): MdBlock => ({ type: "heading", level: 1, text });
  const para: MdBlock = { type: "paragraph", text: "正文" };
  assert.equal(applySkipTitle([heading("闭包"), para], "闭包").length, 1);
  assert.equal(applySkipTitle([heading("闭包"), para], "闭包 ").length, 1);
  assert.equal(applySkipTitle([heading("其他"), para], "闭包").length, 2);
  assert.equal(applySkipTitle([heading("闭包")], undefined).length, 1);
  assert.equal(applySkipTitle([para], "闭包").length, 1);
});

test("buildReadingViews：批次标题 ID 命名空间隔离，重复标题加后缀，锚点表先到先得", () => {
  const node = {
    title: "闭包",
    reading: {
      introduction: "---\nid: x\n---\n\n# 闭包\n\n> 引言",
      records: [
        record({
          id: "rec-1",
          titles: ["首批"],
          content: "## 同名标题\n\n## 同名标题\n\n正文一",
          transcript: "## 同名标题\n\n原文一",
        }),
        record({
          id: "rec-2",
          titles: ["次批"],
          content: "## 同名标题\n\n正文二",
          transcript: "",
        }),
      ],
    },
  };
  const views = buildReadingViews(node);
  assert.ok(views.reading);
  assert.equal(views.reading.records.length, 2);
  /* 前言（跳过同名 H1、去 frontmatter）+ 两批正文 + 一批原文；第二批无 transcript 不建文档 */
  assert.deepEqual([...views.docs.map((d) => d.kind)], ["intro", "content", "transcript", "content"]);
  assert.deepEqual([...views.docs.map((d) => d.ns)], ["intro", "r1", "r1t", "r2"]);
  /* 同一批内重复标题加 -2 后缀；不同批命名空间隔离不冲突 */
  const first = views.docs[1].blocks[0];
  const dup = views.docs[1].blocks[1];
  const second = views.docs[3].blocks[0];
  const transcriptHeading = views.docs[2].blocks[0];
  assert.equal(first.id, "r1-同名标题");
  assert.equal(dup.id, "r1-同名标题-2");
  assert.equal(second.id, "r2-同名标题");
  assert.equal(transcriptHeading.id, "r1t-同名标题");
  /* 局部表登记原始 slug → 本文档首个 ID */
  assert.equal(views.docs[1].anchorMap.get("同名标题"), "r1-同名标题");
  assert.equal(resolveAnchor("同名标题-2", views.docs[1].anchorMap), "r1-同名标题-2", "重名标题的编号锚点可直接访问");
  /* 全局表先到先得：指向第一批 */
  assert.equal(views.anchorMap!.get("同名标题"), "r1-同名标题");
  /* 无 reading / 无效 reading：不输出任何文档，调用方回退完整 Markdown */
  assert.equal(buildReadingViews(null).docs.length, 0);
  assert.equal(buildReadingViews({ title: "x" }).docs.length, 0);
  assert.equal(buildReadingViews({ title: "x", reading: { records: [] } }).docs.length, 0);
});

test("buildReadingViews：前言只剩 frontmatter 与同名标题时不产生空文档", () => {
  const views = buildReadingViews({
    title: "闭包",
    reading: { introduction: "---\nid: closure\n---\n\n# 闭包", records: [record()] },
  });
  assert.deepEqual([...views.docs.map((d) => d.kind)], ["content", "transcript"]);
});

test("resolveAnchor：精确命中、slug 回退、未命中返回 null", () => {
  const map = new Map([["闭包-定义", "r1-闭包-定义"]]);
  assert.equal(resolveAnchor("闭包-定义", map), "r1-闭包-定义");
  assert.equal(resolveAnchor("闭包 定义", map), "r1-闭包-定义");
  assert.equal(resolveAnchor("不存在", map), null);
  assert.equal(resolveAnchor("闭包-定义", null), null);
  assert.equal(resolveAnchor("", map), null);
});

test("prepareHeadingIds：引用与列表内的标题同样登记，usedIds 跨调用共享去重", () => {
  const blocks: MdBlock[] = [
    { type: "quote", children: [{ type: "heading", level: 3, text: "引用内标题" }] },
    {
      type: "list",
      items: [{ blocks: [{ type: "heading", level: 3, text: "列表内标题" }] }],
    },
  ];
  const used: Record<string, boolean> = {};
  const map = new Map<string, string>();
  prepareHeadingIds(blocks, "ns", used, map);
  assert.equal(map.get("引用内标题"), "ns-引用内标题");
  assert.equal(map.get("列表内标题"), "ns-列表内标题");
  const again: MdBlock[] = [{ type: "heading", level: 3, text: "引用内标题" }];
  prepareHeadingIds(again, "ns", used, new Map());
  assert.equal(again[0].id, "ns-引用内标题-2");
});
