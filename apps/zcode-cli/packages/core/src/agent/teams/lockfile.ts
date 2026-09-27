// ============================================================
// Agent Teams v1 - 文件锁（mailbox/任务板/花名册共用的串行原语）
// 见 specs/agent-teams-v1.md：文件总线是唯一共享状态，所有读-改-写
// 都必须在锁内完成。mkdir 是原子操作，天然可做互斥锁；持锁方崩溃后
// 锁目录残留，靠 mtime 过期窃取恢复。锁内操作必须是纯文件读写
// （无网络、无模型调用），STALE_MS 才能安全地小于任何真实持锁时长。
// ============================================================

import { mkdir, rm, stat } from "node:fs/promises";

const STALE_MS = 5_000;
const POLL_MS = 25;
const ACQUIRE_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withDirectoryLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      // 父目录可能从未创建（首次写 inbox/任务文件）；mkdir recursive 幂等，
      // 真正的互斥靠对 lockPath 本身的非递归 mkdir。
      const { dirname } = await import("node:path");
      await mkdir(dirname(lockPath), { recursive: true });
      await mkdir(lockPath);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EEXIST") throw error;
      const lockStat = await stat(lockPath).catch(() => undefined);
      if (lockStat && Date.now() - lockStat.mtimeMs > STALE_MS) {
        // 持锁者已崩溃：窃取并立刻重试竞争。
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        throw new Error(`Timed out acquiring file lock at ${lockPath}`);
      }
      await sleep(POLL_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 原子写：先写临时文件再 rename，读者永远不会看到半截 JSON。 */
export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const { writeFile, rename } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path);
}
