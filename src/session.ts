import { createHash } from "node:crypto";
import type { Draft, TranscriptMessage } from "./types.ts";

export const START = "pi-ask:start";
export const FINISH = "pi-ask:finish";
export const PREPARE = "pi-ask:prepare";

export interface PreparedArchive {
  draftId: string;
  recordId: string;
  messages: TranscriptMessage[];
}

export function preparedArchive(branch: readonly BranchEntry[], draft: Draft): PreparedArchive | undefined {
  const entry = branch.findLast(entry => entry.type === "custom" && entry.customType === PREPARE && (entry.data as PreparedArchive)?.draftId === draft.id);
  if (!entry) return undefined;
  const prepared = entry.data as PreparedArchive;
  if (!Array.isArray(prepared.messages) || prepared.recordId !== recordId(draft, prepared.messages)) throw new Error("待归档快照损坏，请保留会话并检查备份。");
  return prepared;
}

/** Structural subset of Pi's raw branch entries, also usable by test fixtures. */
export interface BranchEntry {
  type: string;
  id?: string;
  customType?: string;
  data?: unknown;
  message?: { role: string; content?: unknown; timestamp?: number; provider?: string; model?: string; stopReason?: string };
}

export function activeDraft(branch: readonly BranchEntry[]): Draft | undefined {
  let draft: Draft | undefined;
  for (const entry of branch) {
    if (entry.type !== "custom") continue;
    if (entry.customType === START) {
      const data = entry.data as Draft | undefined;
      if (!data || ![data.id, data.directory, data.question, data.startedAt].every(x => typeof x === "string" && x.length > 0)) {
        throw new Error("本次 /ask 的会话标记损坏，无法确定记录范围。");
      }
      draft = data;
    } else if (entry.customType === FINISH && (entry.data as { draftId?: string })?.draftId === draft?.id) {
      draft = undefined;
    }
  }
  return draft;
}

export function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap(block => {
    if (block?.type === "text" && typeof block.text === "string") return [block.text];
    if (block?.type === "image") return ["[图片附件：未存入文字卡片]"];
    return [];
  }).join("\n");
}

export function collectTranscript(branch: readonly BranchEntry[], draft: Draft): TranscriptMessage[] {
  const start = branch.findIndex(entry => entry.type === "custom" && entry.customType === START && (entry.data as Draft)?.id === draft.id);
  if (start < 0) throw new Error("当前分支中找不到 /ask 的起点。");
  const messages: TranscriptMessage[] = [];
  for (const entry of branch.slice(start + 1)) {
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = textContent(message.content).trim();
    if (!text) continue;
    messages.push({
      role: message.role, text, timestamp: message.timestamp ?? Date.parse(draft.startedAt),
      ...(message.role === "assistant" ? { model: [message.provider, message.model].filter(Boolean).join("/") || "unknown" } : {}),
      ...(message.role === "assistant" && ["error", "aborted", "length"].includes(message.stopReason ?? "") ? { status: message.stopReason as TranscriptMessage["status"] } : {}),
    });
  }
  return messages;
}

export function recordId(draft: Draft, messages: TranscriptMessage[]): string {
  // Forks inherit the start marker; distinct transcripts must not deduplicate.
  return `${draft.id}-${createHash("sha256").update(JSON.stringify(messages)).digest("hex").slice(0, 20)}`;
}
