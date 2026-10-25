import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reusableConversation, type ConversationMessages } from "./context.ts";
import type { CardexConfig, ModelCall, TranscriptMessage } from "./types.ts";

type RequestContext = Parameters<ExtensionContext["modelRegistry"]["streamSimple"]>[1];

export function modelCaller(ctx: ExtensionContext, config: CardexConfig, signal: AbortSignal, organization?: { messages: TranscriptMessage[]; history?: ConversationMessages }): {
  call: ModelCall;
  organizationCall: ModelCall;
  name: string;
  contextSource: "request" | "projection" | "isolated";
  contextWarning?: string;
} {
  const model = config.model ? ctx.modelRegistry.find(config.model.provider, config.model.id) : ctx.model;
  if (!model) throw new Error("整理模型不可用。请用 /card model 选择已配置的模型。");
  const name = `${model.provider}/${model.id}`;
  let history: ReturnType<typeof reusableConversation>;
  let contextWarning: string | undefined;
  if (!config.model && organization) {
    history = reusableConversation(ctx, organization.messages, organization.history);
    if (!history) contextWarning = "当前会话上下文未完整保留本次问答（可能已经压缩）；本次改用原始问答快照整理。";
  }
  const request = async (context: RequestContext, reused = false): Promise<string> => {
    signal.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason ?? new Error("整理已取消。"));
    signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error("整理模型调用超时；记录仍在，可重试 /card end。")), config.timeoutMs);
    let onAbort: () => void = () => {};
    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(controller.signal.reason ?? new Error("整理已取消。"));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
      const response = ctx.modelRegistry.streamSimple(model, context, {
        signal: controller.signal, maxTokens: Math.min(model.maxTokens, 16_000),
        ...(reused ? { sessionId: ctx.sessionManager.getSessionId(), reasoning: ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel } : {}),
      });
      const result = await Promise.race([response.result(), cancelled]);
      // Declarations can remain in a reused prefix, but this is a single model request, never an agent/tool loop.
      if (result.content.some(block => block.type === "toolCall")) throw new Error(`整理模型 ${name} 请求了工具调用；调用未执行，请重试 /card end。`);
      if (result.stopReason !== "stop") throw new Error(`整理模型 ${name} 未完成输出（${result.stopReason}）。请检查模型设置或缩短本次讨论后重试。`);
      return result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", onAbort);
    }
  };
  const call: ModelCall = (systemPrompt, data) => request({
    systemPrompt, messages: [{ role: "user", content: JSON.stringify(data), timestamp: Date.now() }],
    // Retrieval and routing always use isolated metadata-only contexts.
  });
  const organizationCall: ModelCall = history && organization ? (instructions, _data) => {
    const statuses = organization.messages.flatMap((message, index) => message.status ? [{ index, status: message.status }] : []);
    const scope = `本任务使用以上已有对话，不重复附上问答。归档范围是本条整理指令之前，最后 ${organization.messages.length} 条含可见文字或图片的用户/助手消息；系统消息、工具结果以及只有思考或工具调用的消息不计入。将这些消息从 0 到 ${organization.messages.length - 1} 编号，作为 messageIndices。更早的对话只用作理解背景，不将其单独归档。本次不执行工具，直接按下述规则返回 JSON。${statuses.length ? `\n未完成回答：${JSON.stringify(statuses)}` : ""}`;
    return request({ messages: [...history!.messages, { role: "user", content: `${scope}\n\n${instructions}`, timestamp: Date.now() }] }, true);
  } : call;
  return { call, organizationCall, name, contextSource: history?.source ?? "isolated", ...(contextWarning ? { contextWarning } : {}) };
}
