import fs from "node:fs";
import path from "node:path";
import { acquireDirLockSync } from "../lib/dir-lock-contract.mjs";

export type QueueItem = { cmd: string; time: string; id?: string };
export type QueueFile = { items: QueueItem[]; drainedAt?: string; drains?: Record<string, string> };

const QUEUE_LOCK_TIMEOUT_MS = 2000;
const QUEUE_LOCK_POLL_MS = 5;

// 队列文件由 daemon（排水）与多个生产者（mud_act / mud_send / autopilot）各自读-改-写：
// 没有互斥时生产者会用加锁前的快照覆盖 daemon 刚写的 drains 记录并把已派发的命令塞回去（重复执行、响应游标错位）。
// 所有读-改-写都在同一把目录锁里做（atomic 模式，崩溃遗留可自愈），临界区只有一次读写，毫秒级。
export function withQueueLock<T>(queueFile: string, fn: () => T, opts: { timeoutMs?: number } = {}): T {
  const release = acquireDirLockSync(`${queueFile}.lock`, {
    timeoutMs: opts.timeoutMs ?? QUEUE_LOCK_TIMEOUT_MS,
    pollMs: QUEUE_LOCK_POLL_MS,
    atomic: true,
  });
  try {
    return fn();
  } finally {
    release();
  }
}

export function readQueueFile(queueFile: string): QueueFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(queueFile, "utf8")) as Partial<QueueFile>;
    return { ...parsed, items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch {
    return { items: [] };
  }
}

export function writeQueueFile(queueFile: string, queue: QueueFile): void {
  const tmp = `${queueFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(queue, null, 2));
  fs.renameSync(tmp, queueFile);
}

/** 生产者入队：锁内读-追加-写。 */
/**
 * 入队。`unless` 在拿到锁之后、写入之前求值：为 true 时放弃写入并返回空数组——等锁期间世界可能已经变了
 * （用户发了 stop），调用方用它把"拿到锁"和"仍然该发"绑在同一个临界区里。
 */
export function enqueueCommands(
  queueFile: string,
  cmds: string[],
  opts: { lockTimeoutMs?: number; unless?: () => boolean } = {},
): QueueItem[] {
  fs.mkdirSync(path.dirname(queueFile), { recursive: true });
  return withQueueLock(
    queueFile,
    () => {
      if (opts.unless?.()) return [];
      const queue = readQueueFile(queueFile);
      const added = cmds.map((cmd) => ({ cmd, time: new Date().toISOString() }));
      queue.items.push(...added);
      writeQueueFile(queueFile, queue);
      return added;
    },
    { timeoutMs: opts.lockTimeoutMs },
  );
}
