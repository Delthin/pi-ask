import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { atomicWrite } from "./files.ts";
import type { GraphData, KnowledgeIndex } from "./types.ts";

export async function renderGraph(directory: string, index: KnowledgeIndex): Promise<void> {
  const nodes = await Promise.all(index.nodes.map(async ({ recordIds, ...node }) => ({
    ...node, entryCount: recordIds.length, markdown: node.file === null ? "" : await readFile(join(directory, node.file), "utf8"),
  })));
  const data: GraphData = {
    version: 2, libraryId: createHash("sha256").update(resolve(directory)).digest("hex").slice(0, 20),
    generatedAt: new Date().toISOString(), nodes, edges: index.edges,
  };
  const [template, css, js] = await Promise.all(["template.html", "graph.css", "graph.js"].map(name => readFile(new URL(`../web/${name}`, import.meta.url), "utf8")));
  const encoded = JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  // Function replacers preserve literal '$&' and '$`' in user text.
  const html = template.replace("/*PI_ASK_CSS*/", () => css).replace("/*PI_ASK_JS*/", () => js).replace("__PI_ASK_DATA__", () => encoded);
  await atomicWrite(join(directory, "index.html"), html);
}
