import { homedir } from "node:os";
import { isAbsolute, join, normalize, dirname } from "node:path";
import { atomicWrite, readOptional, withLock } from "./files.ts";
import type { AskConfig } from "./types.ts";

export function resolveDirectory(value: string): string {
  const expanded = value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  if (!expanded.trim() || !isAbsolute(expanded) || expanded.includes("\0")) {
    throw new Error("归档目录须为绝对路径或 ~/ 开头的路径。");
  }
  return normalize(expanded);
}

export function defaultConfig(): AskConfig {
  return { version: 1, directory: join(homedir(), "journal", "ask"), model: null, timeoutMs: 120_000 };
}

export function parseConfig(raw: unknown): AskConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("pi-ask 配置必须是 JSON 对象。");
  const value = raw as Record<string, unknown>;
  const defaults = defaultConfig();
  if (value.version !== undefined && value.version !== 1) throw new Error("不支持此 pi-ask 配置版本。");
  const directory = value.directory ?? defaults.directory;
  if (typeof directory !== "string") throw new Error("directory 必须是路径字符串。");
  const model = value.model ?? null;
  if (model !== null && (typeof model !== "object" || Array.isArray(model) ||
      typeof (model as Record<string, unknown>).provider !== "string" ||
      typeof (model as Record<string, unknown>).id !== "string" ||
      !(model as { provider: string }).provider.trim() || !(model as { id: string }).id.trim())) {
    throw new Error("model 须为 null，或包含 provider 和 id 的对象。");
  }
  const timeoutMs = value.timeoutMs ?? defaults.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
    throw new Error("timeoutMs 必须是 1000 到 600000 之间的整数。");
  }
  return { version: 1, directory: resolveDirectory(directory), model: model as AskConfig["model"], timeoutMs };
}

export async function loadConfig(path: string): Promise<AskConfig> {
  const raw = await readOptional(path);
  if (raw === undefined) return defaultConfig();
  try { return parseConfig(JSON.parse(raw)); }
  catch (error) { throw new Error(`配置文件 ${path} 无效：${(error as Error).message}`); }
}

export async function updateConfig(path: string, patch: Partial<AskConfig>): Promise<AskConfig> {
  // Separate lock namespace from the knowledge library and other Pi settings.
  return withLock(join(dirname(path), ".pi-ask-config"), async () => {
    const config = parseConfig({ ...await loadConfig(path), ...patch });
    await atomicWrite(path, JSON.stringify(config, null, 2) + "\n");
    return config;
  });
}
