import type { CardReading } from "./types.ts";

interface Line { text: string; start: number; outsideFence: boolean; }

/** Keep original offsets (including CRLF); fences must not turn examples into record boundaries. */
function scanLines(markdown: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  let fence: { character: string; length: number } | undefined;
  for (const raw of markdown.split("\n")) {
    const text = raw.replace(/\r$/, "");
    const match = /^(?: {0,3})(`{3,}|~{3,})(.*)$/.exec(text);
    const outsideFence = fence === undefined && !match;
    lines.push({ text, start, outsideFence });
    if (fence) {
      if (match && match[1]![0] === fence.character && match[1]!.length >= fence.length && !match[2]!.trim()) fence = undefined;
    } else if (match && !(match[1]![0] === "`" && match[2]!.includes("`"))) {
      fence = { character: match[1]![0]!, length: match[1]!.length };
    }
    start += raw.length + 1;
  }
  return lines;
}

/**
 * A conservative read-only view of the existing card format, not a Markdown migration.
 * All indexed records must occur exactly once, in order, with the writer's boundaries.
 * Ambiguous/edited/legacy cards retain the ordinary full-Markdown reader instead.
 */
export function cardReading(markdown: string, recordIds: readonly string[]): CardReading | undefined {
  if (!recordIds.length || new Set(recordIds).size !== recordIds.length || recordIds.some(id => !/^[a-zA-Z0-9_-]{1,160}$/.test(id))) return undefined;
  const known = new Set(recordIds);
  const lines = scanLines(markdown);
  const markers: { id: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.outsideFence) continue;
    const match = /^<!-- record:([a-zA-Z0-9_-]{1,160}) -->$/.exec(lines[i]!.text);
    if (match && known.has(match[1]!)) markers.push({ id: match[1]!, line: i });
  }
  if (markers.length !== recordIds.length || markers.some((marker, i) => marker.id !== recordIds[i])) return undefined;

  const boundaries: { id: string; line: number; start: number; contentLine: number; archivedAt: string; organizer: string }[] = [];
  for (const marker of markers) {
    const i = marker.line;
    if (i < 5 || !lines[i - 4]!.outsideFence || lines[i - 4]!.text !== "---" || lines[i - 5]!.text !== "" ||
        lines[i - 3]!.text !== "" || lines[i - 1]!.text !== "" || lines[i + 2]?.text !== "") return undefined;
    const archivedAt = /^## (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/.exec(lines[i - 2]!.text)?.[1];
    if (!archivedAt || !Number.isFinite(Date.parse(archivedAt)) || new Date(archivedAt).toISOString() !== archivedAt) return undefined;
    const organizer = /^整理模型：(.+)$/.exec(lines[i + 1]?.text ?? "")?.[1];
    if (!organizer?.trim() || !lines[i + 3]) return undefined;
    boundaries.push({ id: marker.id, line: i, start: lines[i - 4]!.start, contentLine: i + 3, archivedAt, organizer });
  }

  const records: CardReading["records"] = [];
  for (let index = 0; index < boundaries.length; index++) {
    const boundary = boundaries[index]!;
    const endLine = boundaries[index + 1] ? boundaries[index + 1]!.line - 4 : lines.length;
    const end = boundaries[index + 1]?.start ?? markdown.length;
    const sourceHeadings: number[] = [];
    const titles: string[] = [];
    // The writer always starts each note with a title and a Background/Knowledge section.
    const isNoteTitle = (i: number): boolean => lines[i]!.outsideFence && /^### .+/.test(lines[i]!.text) &&
      lines[i + 1]?.text === "" && /^(#### 背景|#### 知识整理)$/.test(lines[i + 2]?.text ?? "");
    if (!isNoteTitle(boundary.contentLine)) return undefined;
    for (let i = boundary.contentLine; i < endLine; i++) {
      if (!lines[i]!.outsideFence) continue;
      if (lines[i]!.text === "### 相关原始问答") sourceHeadings.push(i);
    }
    // Even a second matching heading in hand-written text is ambiguous: keep it all visible.
    if (sourceHeadings.length !== 1) return undefined;
    const sourceLine = sourceHeadings[0]!;
    if (lines[sourceLine - 1]?.text !== "" || lines[sourceLine + 1]?.text !== "") return undefined;
    const sourceStart = sourceLine + 2;
    const firstLink = lines[sourceStart]?.text;
    const link = /^\[原始消息 message-(\d+)\]\(\.\.\/discussions\/([a-zA-Z0-9_-]{1,160})\.md#message-(\d+)\)$/.exec(firstLink ?? "");
    if (!link || link[2] !== boundary.id || link[1] !== link[3] || lines[sourceStart + 1]?.text !== "" ||
        !/^### (?:用户问题（user）|模型回答（assistant）)/.test(lines[sourceStart + 2]?.text ?? "")) return undefined;
    for (let i = boundary.contentLine; i < sourceLine; i++) {
      if (isNoteTitle(i)) titles.push(lines[i]!.text.slice(4));
    }
    records.push({
      id: boundary.id, archivedAt: boundary.archivedAt, organizer: boundary.organizer, titles,
      content: markdown.slice(lines[boundary.contentLine]!.start, lines[sourceLine]!.start),
      transcript: markdown.slice(lines[sourceStart]!.start, end),
    });
  }
  return { introduction: markdown.slice(0, boundaries[0]!.start), records };
}
