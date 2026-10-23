import { isDeepStrictEqual } from "node:util";
import { convertToLlm, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { textContent } from "./session.ts";
import type { TranscriptMessage } from "./types.ts";

type AgentMessages = Parameters<typeof convertToLlm>[0];
export type ConversationMessages = ReturnType<typeof convertToLlm>;

/** Request-local projections can differ from persisted history. Keep only the latest active discussion. */
export class ConversationSnapshot {
  private snapshot?: { sessionId: string; model: string; branchIds: string[]; messages: AgentMessages; appended: AgentMessages };

  clear(): void { this.snapshot = undefined; }

  capture(ctx: ExtensionContext, messages: AgentMessages): void {
    try {
      this.snapshot = {
        sessionId: ctx.sessionManager.getSessionId(), model: `${ctx.model?.provider}/${ctx.model?.id}`,
        branchIds: ctx.sessionManager.getBranch().map(entry => entry.id), messages: structuredClone(messages), appended: [],
      };
    } catch { this.clear(); }
  }

  append(ctx: ExtensionContext, message: AgentMessages[number]): void {
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.sessionId !== ctx.sessionManager.getSessionId()) return;
    try {
      const copy = structuredClone(message);
      snapshot.messages.push(copy);
      snapshot.appended.push(copy);
    } catch { this.clear(); }
  }

  get(ctx: ExtensionContext): ConversationMessages | undefined {
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.sessionId !== ctx.sessionManager.getSessionId() || snapshot.model !== `${ctx.model?.provider}/${ctx.model?.id}`) return undefined;
    const branch = ctx.sessionManager.getBranch();
    // Navigation and context edits invalidate a saved request prefix. Plain custom state does not enter context.
    const following = branch.slice(snapshot.branchIds.length);
    if (snapshot.branchIds.some((id, i) => branch[i]?.id !== id) ||
        following.some(entry => entry.type !== "message" && entry.type !== "custom")) return undefined;
    // message_end runs before persistence; a later handler can replace signatures or tool blocks.
    const persisted = following.flatMap(entry => entry.type === "message" ? [entry.message] : []);
    if (!isDeepStrictEqual(persisted, snapshot.appended)) return undefined;
    return convertToLlm(structuredClone(snapshot.messages));
  }
}

/** The frozen raw Q/A must still be visible, in order, at the end of the reusable context. */
export function containsDiscussion(history: ConversationMessages, discussion: TranscriptMessage[]): boolean {
  if (!discussion.length || history[0]?.role !== "system") return false;
  const visible = history.flatMap(message => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const text = textContent(message.content).trim();
    return text ? [{ role: message.role, text }] : [];
  });
  if (visible.length < discussion.length) return false;
  return visible.slice(-discussion.length).every((message, index) => message.role === discussion[index]!.role && message.text === discussion[index]!.text);
}

export function reusableConversation(ctx: ExtensionContext, discussion: TranscriptMessage[], snapshot?: ConversationMessages): { messages: ConversationMessages; source: "request" | "projection" } | undefined {
  if (snapshot && containsDiscussion(snapshot, discussion)) return { messages: snapshot, source: "request" };
  const messages = convertToLlm(ctx.sessionManager.buildSessionProjection().messages);
  return containsDiscussion(messages, discussion) ? { messages, source: "projection" } : undefined;
}
