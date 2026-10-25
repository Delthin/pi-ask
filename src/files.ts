import { open, mkdir, readFile, rename, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export async function readOptional(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
}

export async function syncDirectory(path: string): Promise<void> {
  // Windows does not expose directory handles suitable for fsync through Node.
  if (process.platform === "win32") return;
  const directory = await open(path, "r");
  try { await directory.sync(); }
  finally { await directory.close(); }
}

export async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(text, "utf8"); await file.sync(); }
    finally { await file.close(); }
    await rename(temp, path);
    await syncDirectory(dirname(path));
  } finally { await rm(temp, { force: true }); }
}

/** Never steal a live lock or guess based on elapsed time. */
export async function withLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, ".pi-cardex.lock");
  const owner = { token: randomUUID(), pid: process.pid, host: hostname() };
  const handle = await open(lock, "wx", 0o600).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    // The owner may still be writing its lock. Fail closed if it cannot be read.
    let previous: typeof owner;
    try { previous = JSON.parse(await readFile(lock, "utf8")); }
    catch { throw new Error(`知识库锁尚未释放：${lock}。确认没有写入进程后可手动移除。`); }
    if (previous.host === hostname() && Number.isInteger(previous.pid) && previous.pid > 0) {
      try { process.kill(previous.pid, 0); }
      catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === "ESRCH") {
          // Portable Node APIs cannot compare-and-unlink atomically, so two
          // reclaimers could delete a new owner's lock. Require manual recovery.
          throw new Error(`发现已退出进程的锁：${lock}。确认进程 ${previous.pid} 已退出后移除此文件，再重试。`);
        }
      }
    }
    throw new Error(`另一个 Pi 正在写入此目录：${directory}。稍后重试。`);
  });
  try {
    await handle.writeFile(JSON.stringify(owner));
    await handle.sync();
    return await action();
  } finally {
    await handle.close();
    const current = await readOptional(lock);
    if (current && JSON.parse(current).token === owner.token) await unlink(lock);
  }
}
