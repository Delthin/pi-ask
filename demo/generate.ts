/**
 * 生成 GitHub 公开演示数据。
 *
 * 运行：node --experimental-strip-types demo/generate.ts
 *
 * 本脚本只写入 demo/site/ 下由它生成的文件，每次运行整体覆盖，不清理其他文件：
 * - demo/site/index.html          由 src/graph.ts 的 renderGraph() 生成，生成后仅改写页面标题、
 *                                 顶栏说明和 libraryId/generatedAt，其余仍是产品页面
 * - demo/site/index.json          固定索引
 * - demo/site/cards/<id>.md       4 张知识卡片
 * - demo/site/discussions/demo-javascript.md、demo-closure-capture.md  两次示例讨论原文
 *
 * 节点、父子关系、语义关联、卡片正文、讨论问答和日期都写在本文件里，输出可重复生成。
 * 全部内容为预设的公开示例，不来自真实用户会话，也未经过 /ask 模型归档流程。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderGraph } from "../src/graph.ts";
import type { KnowledgeEdge, KnowledgeIndex, KnowledgeNode } from "../src/types.ts";

const OUT = fileURLToPath(new URL("./site/", import.meta.url));
const RECORD_ID = "demo-javascript";
const LIBRARY_ID = "pi-ask-public-demo-v1";
const CREATED_AT = "2024-01-01T09:00:00.000Z";
const UPDATED_AT = "2024-01-02T09:00:00.000Z";
const DEMO_NOTE = "> 预设演示内容，不来自用户会话。";
const SUPPLEMENT_ID = "demo-closure-capture";
const SUPPLEMENT_AT = "2024-01-03T09:00:00.000Z";
const SUPPLEMENT_TITLE = "闭包读取的是变量，不是创建时的快照";
const SUPPLEMENT_BODY = `闭包保留对词法环境中变量的访问。外层代码修改同一个变量后，闭包再次读取时会得到修改后的值：

\`\`\`js
let count = 0;
const read = () => count;
count = 2;
console.log(read()); // 2
\`\`\`

如果另一个变量保存了预先计算好的结果，读取的仍然是那个结果；它不会因为原变量改变而自动重新计算。这次补充解释变量捕获，上次记录中的闭包定义和计数器示例仍然适用。`;

interface DemoNode {
  id: string;
  kind: "group" | "knowledge";
  parentId: string | null;
  title: string;
  summary: string;
  /** 卡片正文；分组节点没有正文。 */
  body?: string;
  /** 卡片“相关原始问答”引用的消息位置。 */
  messages?: number[];
}

const DEMO_NODES: DemoNode[] = [
  {
    id: "javascript",
    kind: "group",
    parentId: null,
    title: "JavaScript",
    summary: "演示知识树的根分组，收录语言基础相关的知识点。",
  },
  {
    id: "lexical-scope",
    kind: "knowledge",
    parentId: "javascript",
    title: "词法作用域",
    summary: "变量的可访问范围由代码书写位置决定，查找沿外层作用域逐级进行。",
    messages: [2, 3],
    body: `词法作用域指变量的可访问范围由代码书写位置决定，而不是由函数被调用的位置决定。函数定义在哪个作用域里，就把那个作用域作为自己的外层环境。

查找变量时，引擎先看当前作用域，找不到再沿外层作用域逐级向上，直到全局作用域。这条查找链在函数定义时已经固定。

\`\`\`js
const name = "外层";

function show() {
  console.log(name);
}

function run() {
  const name = "调用处";
  show();
}

run(); // 外层
\`\`\`

\`show\` 定义在全局作用域，外层环境就是全局作用域。它在 \`run\` 里被调用时不会改用 \`run\` 的局部变量，所以打印的是外层的值。

词法作用域让函数依赖哪些变量可以从书写位置读出来，也让闭包拥有确定的环境。`,
  },
  {
    id: "closure",
    kind: "knowledge",
    parentId: "lexical-scope",
    title: "闭包",
    summary: "函数与定义时的词法环境一起保存，外层函数返回后仍能访问其变量。",
    messages: [0, 1],
    body: `闭包是函数和它定义时所处词法环境的组合。外层函数返回后，返回的函数仍然引用外层变量，这些变量因此继续存在，可以读取和修改。

下面的计数器把 \`count\` 留在 \`makeCounter\` 的作用域里，返回的函数每次调用都操作同一个 \`count\`：

\`\`\`js
function makeCounter() {
  let count = 0;
  return () => ++count;
}

const next = makeCounter();
console.log(next()); // 1
console.log(next()); // 2
\`\`\`

\`makeCounter()\` 调用结束后，\`count\` 没有随调用结束而消失，因为返回的箭头函数持有对它的引用。每次调用 \`next\` 读到的是同一个 \`count\`，状态因此延续。

闭包常用来保存私有状态，也用来让回调记住定义时的参数。变量的生命周期由是否仍被引用决定，函数调用是否结束不直接决定它。`,
  },
  {
    id: "memory-management",
    kind: "group",
    parentId: "javascript",
    title: "内存管理",
    summary: "演示分组，整理对象生命周期和内存回收相关的知识点。",
  },
  {
    id: "garbage-collection",
    kind: "knowledge",
    parentId: "memory-management",
    title: "垃圾回收",
    summary: "从根对象出发标记可达对象，回收不可达对象占用的内存。",
    messages: [4, 5],
    body: `垃圾回收自动释放不再使用的对象占用的内存。JavaScript 引擎常用标记清除：从根对象出发，沿着引用关系标记所有能到达的对象，没有标记的对象不可达，随后被回收。

可达性由引用链决定，而不取决于变量名是否还在作用域里。闭包持有外层变量时，这条引用从函数对象延伸到变量，变量因此保持可达。

\`\`\`js
function createCache() {
  const data = new Array(1000).fill(0);
  return () => data.length;
}

let size = createCache();
console.log(size()); // 1000

size = null;
\`\`\`

\`size\` 指向返回的函数，函数引用 \`data\`，所以只要 \`size\` 还在使用，\`data\` 就保持可达。把 \`size\` 置为 \`null\` 后，函数和它引用的数组都不再可达，可以在之后的回收中释放。

回收时机由引擎决定，代码无法精确控制。需要及时释放大对象时，减少长生命周期的引用比等待回收更直接。`,
  },
  {
    id: "async-programming",
    kind: "group",
    parentId: "javascript",
    title: "异步编程",
    summary: "演示分组，整理异步任务组织和回调相关的知识点。",
  },
  {
    id: "promise",
    kind: "knowledge",
    parentId: "async-programming",
    title: "Promise",
    summary: "表示异步操作最终结果的对象，用 then 串联后续处理并统一传递错误。",
    messages: [6, 7],
    body: `Promise 表示一个异步操作的最终结果，状态为 pending、fulfilled 或 rejected，状态一旦确定就不再改变。\`then\` 注册的回调在结果可用后进入微任务队列执行。

\`\`\`js
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

delay(100)
  .then(() => console.log("完成"))
  .catch(error => console.error(error));
\`\`\`

\`delay\` 把 \`resolve\` 交给 \`setTimeout\`，定时器到点后调用它，Promise 变为 fulfilled，\`.then\` 的回调随后执行。\`then\` 返回一个新的 Promise，后续处理可以继续串联。

回调会捕获定义处的变量，这是闭包在异步流程中的常见用法：回调执行时读到的仍是书写位置作用域里的值。错误通过 \`reject\` 或抛出的异常传到 \`catch\`，统一处理。`,
  },
];

const MESSAGES: { at: string; role: "user" | "assistant"; text: string }[] = [
  {
    at: "2024-01-01T09:00:00.000Z",
    role: "user",
    text: "为什么说闭包会让变量“活得比函数调用更久”？",
  },
  {
    at: "2024-01-01T09:00:30.000Z",
    role: "assistant",
    text: "函数返回后，它的调用帧会退出。闭包让函数继续访问定义时的词法环境，返回的函数仍能读取和修改其中的外层变量。被闭包引用的对象能否回收，要看它们是否还从根对象可达。",
  },
  {
    at: "2024-01-01T09:01:00.000Z",
    role: "user",
    text: "词法作用域是在什么时候确定的？",
  },
  {
    at: "2024-01-01T09:01:30.000Z",
    role: "assistant",
    text: "在函数定义时确定。函数记录自己书写位置所处的作用域作为外层环境，调用时按这条链查找变量，与调用位置无关。",
  },
  {
    at: "2024-01-01T09:02:00.000Z",
    role: "user",
    text: "闭包占用的内存什么时候能被回收？",
  },
  {
    at: "2024-01-01T09:02:30.000Z",
    role: "assistant",
    text: "当相关对象不再从根对象可达时，就可以被回收。一个仍然可达的闭包可能通过词法环境保留外层对象；移除这条引用以及其他引用后，对象就不再可达。实际回收时机由引擎决定。",
  },
  {
    at: "2024-01-01T09:03:00.000Z",
    role: "user",
    text: "Promise 的 then 回调为什么能用到外面的变量？",
  },
  {
    at: "2024-01-01T09:03:30.000Z",
    role: "assistant",
    text: "回调和普通函数一样携带定义时的词法环境。then 注册的回调在微任务中执行，作用域链仍然指向书写位置，因此能读到外层变量。",
  },
];

const SUPPLEMENT_MESSAGES: typeof MESSAGES = [
  { at: "2024-01-03T08:58:00.000Z", role: "user", text: "闭包记住的是创建时的值吗？变量后来变了会怎样？" },
  { at: "2024-01-03T08:58:30.000Z", role: "assistant", text: "闭包读取的是对应词法环境中的变量。同一个变量被修改后，后续读取会得到新值；已经保存在其他变量里的计算结果不会因此自动更新。" },
];

const EDGES: KnowledgeEdge[] = [
  {
    source: "closure",
    target: "garbage-collection",
    relation: "可达性",
    reason: "闭包持有外层变量的引用，这条引用链让变量保持可达，垃圾回收不会回收它们。",
  },
  {
    source: "promise",
    target: "closure",
    relation: "回调捕获",
    reason: "then 的回调会捕获定义处的变量，回调执行时读到的仍是这些变量。",
  },
];

const cardFile = (id: string): string => `cards/${id}.md`;

function messageText(message: (typeof MESSAGES)[number]): string {
  const heading = message.role === "user" ? "用户问题（user）" : "示例回答（预设）";
  return `### ${heading} · ${message.at}\n\n${message.text}`;
}

function discussionText(recordId = RECORD_ID, messages = MESSAGES, at = UPDATED_AT): string {
  const anchors = messages.map(
    (message, index) => `<a id="message-${index}"></a>\n\n${messageText(message)}`,
  ).join("\n\n");
  return `# 讨论 ${recordId}\n\n演示讨论：以下问答为预设示例，不来自真实用户会话。\n\n归档时间：${at}\n内容来源：预设示例\n\n${anchors}\n`;
}

function cardText(node: DemoNode): string {
  const updatedAt = node.id === "closure" ? SUPPLEMENT_AT : UPDATED_AT;
  const frontmatter = `---\nid: ${JSON.stringify(node.id)}\ntitle: ${JSON.stringify(node.title)}\nsummary: ${JSON.stringify(node.summary)}\ncreated: ${JSON.stringify(CREATED_AT)}\nupdated: ${JSON.stringify(updatedAt)}\n---\n\n`;
  const quoted = (node.messages ?? [])
    .map(index => `[原始消息 message-${index}](../discussions/${RECORD_ID}.md#message-${index})\n\n${messageText(MESSAGES[index]!)}`)
    .join("\n\n");
  let content = `${frontmatter}# ${node.title}\n\n${DEMO_NOTE}\n\n---\n\n## ${UPDATED_AT}\n\n<!-- record:${RECORD_ID} -->\n整理模型：预设示例（未调用模型）\n\n### ${node.title}\n\n#### 知识整理\n\n${node.body ?? ""}\n\n### 相关原始问答\n\n${quoted}\n`;
  if (node.id === "closure") {
    const supplement = SUPPLEMENT_MESSAGES.map((message, i) => `[原始消息 message-${i}](../discussions/${SUPPLEMENT_ID}.md#message-${i})\n\n${messageText(message)}`).join("\n\n");
    content += `\n---\n\n## ${SUPPLEMENT_AT}\n\n<!-- record:${SUPPLEMENT_ID} -->\n整理模型：预设示例（未调用模型）\n\n### ${SUPPLEMENT_TITLE}\n\n#### 知识整理\n\n${SUPPLEMENT_BODY}\n\n### 相关原始问答\n\n${supplement}\n`;
  }
  return content;
}

function buildIndex(): KnowledgeIndex {
  const nodes: KnowledgeNode[] = DEMO_NODES.map(node => ({
    id: node.id,
    kind: node.kind,
    parentId: node.parentId,
    title: node.title,
    summary: node.summary,
    file: node.kind === "knowledge" ? cardFile(node.id) : null,
    createdAt: CREATED_AT,
    updatedAt: node.id === "closure" ? SUPPLEMENT_AT : UPDATED_AT,
    recordIds: node.kind === "knowledge" ? node.id === "closure" ? [RECORD_ID, SUPPLEMENT_ID] : [RECORD_ID] : [],
  }));
  return {
    version: 2,
    revision: 2,
    updatedAt: SUPPLEMENT_AT,
    nodes,
    edges: EDGES,
    discussions: [{
      id: RECORD_ID,
      file: `discussions/${RECORD_ID}.md`,
      createdAt: UPDATED_AT,
      organizer: "预设示例",
      nodeIds: DEMO_NODES.filter(node => node.kind === "knowledge").map(node => node.id),
    }, {
      id: SUPPLEMENT_ID, file: `discussions/${SUPPLEMENT_ID}.md`, createdAt: SUPPLEMENT_AT,
      organizer: "预设示例", nodeIds: ["closure"],
    }],
  };
}

/** 产品页面按真实知识库渲染；这里只把页面标题、顶栏和两个运行期字段改成演示值。 */
async function brandAsDemo(htmlPath: string): Promise<void> {
  let html = await readFile(htmlPath, "utf8");
  const swaps: [RegExp, string][] = [
    [/<title>知识图谱 · pi-ask<\/title>/, "<title>知识图谱示例 · pi-ask</title>"],
    [/<span class="brand-sub">知识图谱<\/span>/, '<span class="brand-sub">知识图谱示例</span>'],
    [/"libraryId":"[0-9a-f]{20}"/, `"libraryId":${JSON.stringify(LIBRARY_ID)}`],
    [/"generatedAt":"[^"]*"/, `"generatedAt":${JSON.stringify(SUPPLEMENT_AT)}`],
  ];
  for (const [pattern, replacement] of swaps) {
    const matches = html.match(new RegExp(pattern.source, "g"));
    if (matches?.length !== 1) throw new Error(`演示页面中 ${pattern} 应恰好出现一次，实际 ${matches?.length ?? 0} 次。`);
    html = html.replace(pattern, replacement);
  }
  await writeFile(htmlPath, html, "utf8");
}

async function main(): Promise<void> {
  const index = buildIndex();
  await mkdir(join(OUT, "cards"), { recursive: true });
  await mkdir(join(OUT, "discussions"), { recursive: true });

  for (const node of DEMO_NODES) {
    if (node.kind !== "knowledge") continue;
    await writeFile(join(OUT, cardFile(node.id)), cardText(node), "utf8");
  }
  await writeFile(join(OUT, `discussions/${RECORD_ID}.md`), discussionText(), "utf8");
  await writeFile(join(OUT, `discussions/${SUPPLEMENT_ID}.md`), discussionText(SUPPLEMENT_ID, SUPPLEMENT_MESSAGES, SUPPLEMENT_AT), "utf8");
  await writeFile(join(OUT, "index.json"), JSON.stringify(index, null, 2) + "\n", "utf8");

  // renderGraph 读取 cards/*.md 并写入 index.html。
  await renderGraph(OUT, index);
  await brandAsDemo(join(OUT, "index.html"));

  console.log(`已生成 ${OUT}`);
  console.log(`节点 ${index.nodes.length} 个，关联 ${index.edges.length} 条，卡片 ${index.discussions[0]!.nodeIds.length} 张。`);
}

await main();
