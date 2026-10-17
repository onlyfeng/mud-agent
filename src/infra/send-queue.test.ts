import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDirLockSync } from "../lib/dir-lock-contract.mjs";
import { enqueueCommands, readQueueFile, withQueueLock, writeQueueFile } from "./send-queue";

const dirs: string[] = [];
function tempQueue(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mud-queue-"));
  dirs.push(d);
  return path.join(d, "send-queue.json");
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("send queue handoff", () => {
  it("enqueue appends under the lock and leaves no lock directory behind", () => {
    const q = tempQueue();
    enqueueCommands(q, ["look"]);
    enqueueCommands(q, ["north", "south"]);
    expect(readQueueFile(q).items.map((i) => i.cmd)).toEqual(["look", "north", "south"]);
    expect(fs.existsSync(`${q}.lock`)).toBe(false);
  });

  it("a producer cannot overwrite a drain with a stale snapshot: it waits for the lock and re-reads", () => {
    const q = tempQueue();
    enqueueCommands(q, ["look"]);
    // daemon 排水持锁中：生产者此时入队必须等锁，然后在最新内容上追加，而不是用旧快照（含已派发的 look）覆盖
    withQueueLock(q, () => {
      const queue = readQueueFile(q);
      const drainedAt = new Date().toISOString();
      writeQueueFile(q, { items: [], drainedAt, drains: { [queue.items[0].time]: drainedAt } });
    });
    enqueueCommands(q, ["north"]);
    const after = readQueueFile(q);
    expect(after.items.map((i) => i.cmd)).toEqual(["north"]); // look 没有被塞回去
    expect(Object.keys(after.drains ?? {})).toHaveLength(1); // drains 记录没有丢
  });

  it("times out instead of proceeding when another live process holds the queue lock", () => {
    const q = tempQueue();
    const release = acquireDirLockSync(`${q}.lock`, { atomic: true, timeoutMs: 100, pollMs: 5 }); // 另一个活进程持锁
    try {
      expect(() => enqueueCommands(q, ["x"])).toThrow(/timed out/);
    } finally {
      release();
    }
  });
});
