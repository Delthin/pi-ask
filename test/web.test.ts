import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

interface Point {
  x: number;
  y: number;
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
}

const module = { exports: {} as WebHelpers };
runInNewContext(await readFile(new URL("../web/graph.js", import.meta.url), "utf8"), { module });
const { safeHref, buildHierarchy, treeQuery, computeTreeLayout } = module.exports;

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
