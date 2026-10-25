import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, resolveDirectory, updateConfig } from "./config.ts";
import { catalog, organize, retrieve } from "./intelligence.ts";
import { modelCaller } from "./model.ts";
import { ConversationSnapshot } from "./context.ts";
import { activeDraft, collectTranscript, FINISH, PREPARE, preparedArchive, recordId, START } from "./session.ts";
import { archive, loadIndex, rebuildGraph } from "./store.ts";
import type { Draft } from "./types.ts";

const HELP = [
  "/card 问题 — 开始记录；之后可直接追问，或继续 /card 追问",
  "/card end — 拆分知识点、归入三级知识树并归档",
  "/card cancel — 取消本次记录，保留聊天",
  "/card model — 选择默认整理模型",
  "/card model current — 固定为当前模型；follow — 跟随聊天模型",
  "/card model provider/model-id — 直接指定已配置模型",
  "/card dir ~/journal/cardex — 设置固定归档目录",
  "/card graph — 重新生成离线图谱，显示文件地址",
  "/card status — 查看记录状态、目录和配置路径",
  "/card -- 问题 — 问题以 end、model 等命令词开头时使用",
].join("\n");

export default function cardexExtension(pi: ExtensionAPI, configPath = join(getAgentDir(), "pi-cardex.json")): void {
  let busy = false;
  let controller: AbortController | undefined;
  let stopped = false;
  const conversation = new ConversationSnapshot();

  const status = (ctx: ExtensionContext) => {
    const branch = ctx.sessionManager.getBranch();
    const draft = activeDraft(branch);
    ctx.ui.setStatus("pi-cardex", busy ? "cardex · 正在处理" : draft ? preparedArchive(branch, draft) ? "cardex · 归档待重试" : `cardex · ${draft.question.slice(0, 32)}` : undefined);
  };
  const report = (ctx: ExtensionContext, message: string, level: "info" | "error" = "info") => ctx.ui.notify(message, level);

  pi.on("session_start", (_event, ctx) => { stopped = false; conversation.clear(); status(ctx); });
  pi.on("session_tree", (_event, ctx) => { conversation.clear(); status(ctx); });
  pi.on("session_compact", () => conversation.clear());
  pi.on("context_with_system", (event, ctx) => {
    if (activeDraft(ctx.sessionManager.getBranch())) conversation.capture(ctx, event.messages);
  });
  pi.on("message_end", (event, ctx) => conversation.append(ctx, event.message));
  pi.on("session_shutdown", () => { stopped = true; conversation.clear(); controller?.abort(new Error("会话已关闭；尚未完成的记录会保留。")); });
  const guard = (_event: unknown, ctx: ExtensionContext) => {
    if (busy) { report(ctx, "请等 /card 处理完成后再切换会话或分支。", "error"); return { cancel: true }; }
  };
  pi.on("session_before_switch", guard);
  pi.on("session_before_fork", guard);
  pi.on("session_before_tree", guard);
  pi.on("input", (event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    const draft = activeDraft(branch);
    const pending = draft && preparedArchive(branch, draft);
    if (!busy && !pending) return { action: "continue" };
    if (ctx.hasUI) ctx.ui.setEditorText(event.text);
    report(ctx, pending && !busy ? "上次归档尚未完成，本条消息尚未发送。请先 /card end 重试，或 /card cancel 结束记录。" : "正在处理 /card，本条消息尚未发送；请等处理完成后重新提交。", "error");
    return { action: "handled" };
  });

  pi.registerCommand("card", {
    description: "记录问答，整理 Markdown 知识卡片与离线图谱",
    getArgumentCompletions: prefix => {
      const items = ["end", "cancel", "model", "model current", "model follow", "dir", "graph", "status", "help"];
      return items.filter(value => value.startsWith(prefix)).map(value => ({ value, label: value }));
    },
    handler: async (raw, ctx) => {
      const args = raw.trim();
      if (!args || args === "help") { report(ctx, HELP); return; }
      if (busy) { report(ctx, "另一个 /card 操作尚未完成，请稍后重试。", "error"); return; }
      busy = true;
      controller = new AbortController();
      const signal = controller.signal;
      let questionToSend: string | undefined;
      try {
        status(ctx);
        const config = await loadConfig(configPath);
        const draft = activeDraft(ctx.sessionManager.getBranch());
        const [command] = args.split(/\s+/, 1);
        const rest = args.slice(command!.length).trim();
        if (args === "status") {
          report(ctx, `${draft ? `正在记录：${draft.question}\n本次归档目录：${draft.directory}` : "当前没有正在记录的讨论。"}\n默认目录：${config.directory}\n整理模型：${config.model ? `${config.model.provider}/${config.model.id}` : `跟随当前聊天模型（${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "尚未选择"}），整理时复用会话上下文`} \n配置：${configPath}`);
        } else if (command === "dir") {
          if (!rest) { report(ctx, `默认归档目录：${config.directory}\n修改：/card dir ~/journal/cardex`); return; }
          const updated = await updateConfig(configPath, { directory: resolveDirectory(rest) });
          report(ctx, `默认归档目录：${updated.directory}${draft ? `\n正在记录的讨论仍归档到：${draft.directory}` : ""}`);
        } else if (command === "model") {
          let choice = rest;
          if (!choice) {
            if (!ctx.hasUI) throw new Error("此界面不支持选择器，请使用 /card model provider/model-id、current 或 follow。");
            const models = ctx.modelRegistry.getAvailable();
            const follow = "跟随当前聊天模型";
            const current = "固定为当前聊天模型";
            const selected = await ctx.ui.select("默认整理模型（复用 Pi 的模型配置与认证）", [follow, current, ...models.map(model => `${model.provider}/${model.id}`)]);
            if (!selected) return;
            choice = selected === follow ? "follow" : selected === current ? "current" : selected;
          }
          if (choice === "follow") {
            await updateConfig(configPath, { model: null });
            report(ctx, "整理模型已设为跟随当前聊天模型，整理时复用会话上下文。");
          } else {
            const slash = choice.indexOf("/");
            const model = choice === "current" ? ctx.model : slash > 0 ? ctx.modelRegistry.find(choice.slice(0, slash), choice.slice(slash + 1)) : undefined;
            if (!model) throw new Error("未找到该模型，请用 /card model 从 Pi 已配置的模型中选择。");
            await updateConfig(configPath, { model: { provider: model.provider, id: model.id } });
            report(ctx, `默认整理模型：${model.provider}/${model.id}`);
          }
        } else if (args === "cancel") {
          if (!draft) throw new Error("当前没有正在记录的讨论。");
          const prepared = preparedArchive(ctx.sessionManager.getBranch(), draft);
          const saved = prepared ? (await loadIndex(draft.directory)).nodes.filter(node => node.recordIds.includes(prepared.recordId)) : [];
          pi.appendEntry(FINISH, { draftId: draft.id, outcome: saved.length ? "archived" : "cancelled", ...(saved.length ? { recordId: prepared!.recordId, nodeIds: saved.map(node => node.id) } : {}) });
          conversation.clear();
          report(ctx, saved.length ? `本次问答已落盘，已结束记录，共 ${saved.length} 张卡片。\n图谱：${pathToFileURL(join(draft.directory, "index.html")).href}` : "已取消本次知识卡片记录，聊天内容保留。");
        } else if (args === "graph") {
          const directory = draft?.directory ?? config.directory;
          await rebuildGraph(directory);
          report(ctx, `离线图谱：${pathToFileURL(join(directory, "index.html")).href}\n用浏览器打开即可查看。`);
        } else if (args === "end") {
          if (!draft) throw new Error("当前没有正在记录的讨论。先输入 /card 问题。");
          await ctx.waitForIdle();
          signal.throwIfAborted();
          if (ctx.hasPendingMessages()) throw new Error("还有排队的聊天消息，请等它们回答完成后再运行 /card end。");
          const prepared = preparedArchive(ctx.sessionManager.getBranch(), draft);
          const messages = prepared?.messages ?? collectTranscript(ctx.sessionManager.getBranch(), draft);
          const id = prepared?.recordId ?? recordId(draft, messages);
          // Recover and deduplicate before paying for another model request.
          const existing = (await loadIndex(draft.directory)).nodes.filter(node => node.recordIds.includes(id));
          let nodes = existing;
          let summary = `已恢复归档，共 ${nodes.length} 张知识卡片`;
          if (!nodes.length) {
            const organizer = modelCaller(ctx, config, signal, { messages, history: conversation.get(ctx) });
            if (organizer.contextWarning) report(ctx, organizer.contextWarning);
            report(ctx, `${organizer.contextSource === "isolated" ? "正在整理本次问答" : "正在复用当前会话上下文整理"}，随后拆分归档并更新三级知识树和关联……`);
            const notes = await organize(messages, organizer.organizationCall);
            signal.throwIfAborted();
            // Freeze this end operation before any archive write. A retry always uses this exact transcript.
            if (!prepared) pi.appendEntry(PREPARE, { draftId: draft.id, recordId: id, messages });
            const result = await archive(draft.directory, { recordId: id, notes, messages, organizer: organizer.name }, organizer.call);
            nodes = result.nodes;
            summary = `已归档 ${nodes.length} 个知识点：新建 ${result.created}，补充 ${result.updated}`;
          }
          if (!stopped) {
            pi.appendEntry(FINISH, { draftId: draft.id, outcome: "archived", recordId: id, nodeIds: nodes.map(node => node.id) });
            conversation.clear();
            report(ctx, `${summary}\n${nodes.map(node => `${node.title}：${join(draft.directory, node.file!)}`).join("\n")}\n图谱：${pathToFileURL(join(draft.directory, "index.html")).href}`);
          }
        } else {
          const question = command === "--" ? rest : args;
          if (!question) throw new Error("请在 /card 后输入问题。");
          if (draft && preparedArchive(ctx.sessionManager.getBranch(), draft)) throw new Error("上次归档尚未完成，请先 /card end 重试，或 /card cancel 结束记录。");
          if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("请等当前回答和排队消息完成后，再使用 /card 提问。");
          if (!draft) {
            const index = await loadIndex(config.directory);
            const organizer = modelCaller(ctx, config, signal);
            const matchId = await retrieve(question, catalog(index), organizer.call);
            signal.throwIfAborted();
            const match = index.nodes.find(node => node.id === matchId);
            const next: Draft = { id: randomUUID(), directory: config.directory, question, startedAt: new Date().toISOString() };
            pi.appendEntry(START, next);
            conversation.clear();
            report(ctx, `${match ? `发现已有知识点「${match.title}」，结束时会结合本次讨论重新判断是否补充。` : "已开始记录知识点。"}\n继续追问，完成后输入 /card end。`);
          }
          questionToSend = question;
        }
      } catch (error) {
        if (!stopped) report(ctx, error instanceof Error ? error.message : String(error), "error");
      } finally {
        busy = false;
        controller = undefined;
        if (!stopped) status(ctx);
      }
      if (questionToSend && !stopped) pi.sendUserMessage(questionToSend, { expandPromptTemplates: false });
    },
  });
}
