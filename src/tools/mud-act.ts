import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isLogNoiseLine } from "../core/noise-filter.js";
import type { MudActParams, OpenClawPluginApi } from "../core/types.js";
import { readQueueFile, withQueueLock, writeQueueFile } from "../infra/send-queue.js";
import { resolveSessionDir } from "../lib/session-key.js";
import { getMudSessionStore } from "../storage/session-store.js";

/**
 * mud_act — 游戏动作工具（send + wait + read_since 三合一）
 *
 * 优先用于所有产生游戏状态变化的操作（移动、攻击、对话、捡物等）。
 * 一次工具调用完成「写队列 → 等待服务器响应 → 读取新输出」全流程，
 * 替代分开调用 mud_send + mud_read 的两次往返，减少用户消息被阻塞的时长。
 * 首批新输出到达后，再静默 quietMs 即返回，不必睡满 waitMs。
 */
export function registerMudActTool(api: OpenClawPluginApi): void {
  if (typeof api?.registerTool !== "function") return;

  api.registerTool({
    name: "mud_act",
    description:
      "发送游戏命令并等待服务器响应，一次完成「发送→等待→读取新输出」全流程。" +
      "所有游戏动作（移动、攻击、说话、捡物、发 look 等）优先使用此工具。",
    parameters: {
      type: "object",
      properties: {
        sessionKey: { type: "string" },
        commands: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "要发送的命令（单条字符串或数组）",
        },
        waitMs: {
          type: "number",
          description: "最长等待毫秒数，默认 2500",
        },
        quietMs: {
          type: "number",
          description: "首批新输出到达后，再静默多少毫秒即返回，默认 500",
        },
        fallbackLines: {
          type: "number",
          description: "无新输出时回退读最近 N 行，默认 20",
        },
      },
      required: ["sessionKey", "commands"],
    },

    async execute(_id: string, raw: Record<string, unknown>) {
      const params = raw as unknown as MudActParams;
      const store = getMudSessionStore();
      // 写工具不注册会话：打错/从未初始化的键若在这里 ensure()，目录一出现模型路由就把该话题永久当成 MUD 会话
      const dir = resolveSessionDir(store, params.sessionKey);
      if (!fs.existsSync(path.join(dir, "config.json"))) {
        return {
          content: [{ type: "text", text: "❌ 该会话尚未初始化：请先 /mud start host:port 或 mud_admin setup" }],
        };
      }
      const queueFile = path.join(dir, "send-queue.json");
      const outputFile = path.join(dir, "output.jsonl");

      const cmds = Array.isArray(params.commands) ? params.commands : [params.commands];
      const waitMs = params.waitMs ?? 2500;
      const quietMs = params.quietMs ?? 500;
      const fallbackLines = params.fallbackLines ?? 20;

      // ── 1. 记录发送时刻，写入命令队列 ────────────────────────────────
      const sentAt = new Date();
      const requestId = randomUUID(); // 同一毫秒的两个请求 time 相同，排水判定与派发记录按 id 区分

      withQueueLock(queueFile, () => {
        const queue = readQueueFile(queueFile);
        for (const cmd of cmds) queue.items.push({ cmd, time: sentAt.toISOString(), id: requestId });
        writeQueueFile(queueFile, queue);
      });

      // ── 2. 等队列被消费，再轮询至输出静默，或达到最长等待 ──────────────────────────
      // 队列最多 500 ms 才被守护进程消费；在此之前到达的环境消息（闲聊、其他玩家移动）
      // 不是本命令的响应，不能让它们启动静默窗口：先等队列被消费，再从那一刻起算响应。
      const deadline = sentAt.getTime() + waitMs;
      const drainedAt = await waitForQueueDrain(queueFile, sentAt, requestId, deadline);
      // 游标用 >=：drainedAt 与输出行的 ts 都只有毫秒精度，同一毫秒内返回的响应不能丢。
      const since = drainedAt ?? sentAt;
      if (drainedAt) await waitUntilQuiet(outputFile, since, deadline, quietMs);

      // ── 3. 读取命令发出之后的新输出行 ────────────────────────────────
      try {
        const raw = fs.readFileSync(outputFile, "utf8");
        const all = raw.trim().split("\n").filter(Boolean);

        let newLines = all.filter((l) => {
          try {
            return new Date(JSON.parse(l).ts) >= since;
          } catch {
            return false;
          }
        });

        // 没有新输出时回退读最近 N 行（连接未就绪或响应极慢的情况）
        if (!newLines.length) {
          newLines = all.slice(-fallbackLines);
        }

        const formatted = newLines
          .map((l) => {
            try {
              const { ts, text } = JSON.parse(l);
              const t = new Date(ts).toLocaleTimeString("zh-CN", {
                hour12: false,
              });
              return `[${t}] ${text}`;
            } catch {
              return l;
            }
          })
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text:
                `已发送: ${cmds.join(", ")}\n` +
                (drainedAt ? "" : `（命令在 ${waitMs}ms 内未被守护进程发出，请用 mud_status 确认 daemon 在线）\n`) +
                `\n=== 服务器响应 ===\n${formatted || "(暂无新输出)"}`,
            },
          ],
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [
            {
              type: "text",
              text: `已发送: ${cmds.join(", ")}\n读取响应失败: ${msg}`,
            },
          ],
        };
      }
    },
  });
}

const POLL_MS = 200;
const DRAIN_POLL_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// 守护进程消费队列时会把队列文件改写为 `{ items: [], drainedAt }`（在 socket.write 之前）；
// 本次入队的条目不再存在即视为已发出，响应读取游标用 daemon 记下的 drainedAt，
// 而不是我们观察到排水的时刻，否则快速服务器在两次轮询之间返回的响应会被漏掉。
// 先检查再等待，守护进程已经消费掉的情况不额外花时间。超过 deadline 返回 null。
async function waitForQueueDrain(
  queueFile: string,
  sentAt: Date,
  requestId: string,
  deadline: number,
): Promise<Date | null> {
  while (true) {
    const snapshot = readQueue(queueFile);
    const pending = Array.isArray(snapshot.items) && snapshot.items.some((item) => item?.id === requestId);
    if (!pending) {
      // 优先用 daemon 为本请求记的派发时刻；两批命令在我们轮询前先后排水时，全局 drainedAt 已是后一批的。
      const stamp = snapshot.drains?.[requestId] ?? snapshot.drainedAt;
      const drainedAt = stamp ? new Date(stamp) : null;
      return drainedAt && !Number.isNaN(drainedAt.getTime()) && drainedAt >= sentAt ? drainedAt : new Date();
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await sleep(Math.min(DRAIN_POLL_MS, remaining));
  }
}

type QueueSnapshot = {
  items?: Array<{ time?: string; id?: string }>;
  drainedAt?: string;
  drains?: Record<string, string>;
};

function readQueue(queueFile: string): QueueSnapshot {
  try {
    return JSON.parse(fs.readFileSync(queueFile, "utf8")) as QueueSnapshot;
  } catch {
    return {};
  }
}

// 读失败视为尚无新行，轮询中不抛出。环境噪音（闲聊、他人移动/到场、装饰行）不计入：
// 它们不能单独启动静默窗口，否则繁忙服务器上一句闲聊就会让 mud_act 在真实响应到达前返回。
// 输出文件被裁到最新 500 行：持续输出时计数会停在 500 不再增长，所以还要看最新一行的身份（ts + 文本）有没有变
function readNewOutputProgress(outputFile: string, since: Date): { count: number; newest: string } {
  try {
    const raw = fs.readFileSync(outputFile, "utf8");
    const all = raw.trim().split("\n").filter(Boolean);
    let count = 0;
    let newest = "";
    for (const line of all) {
      try {
        const { ts, text } = JSON.parse(line) as { ts: string; text?: string };
        if (new Date(ts) >= since && !isLogNoiseLine(String(text ?? ""))) {
          count += 1;
          newest = line;
        }
      } catch {
        // 坏行不计入新输出
      }
    }
    return { count, newest };
  } catch {
    return { count: 0, newest: "" };
  }
}

// 每 POLL_MS 读一次。见到新行后，若 quietMs 内没有更多新行则返回；
// 自 sentAt 起超过 waitMs 也返回。二者先到先返回。
// 已见到新输出时，休眠不超过剩余静默时间，避免静默截止点
// 卡在 POLL_MS 边界上。
async function waitUntilQuiet(outputFile: string, since: Date, deadline: number, quietMs: number): Promise<void> {
  let seen = 0;
  let seenNewest = "";
  let lastGrowthAt = Date.now();

  while (Date.now() < deadline) {
    const now = Date.now();
    const waitRemaining = deadline - now;
    const quietRemaining = seen > 0 ? quietMs - (now - lastGrowthAt) : waitRemaining;
    const delay = Math.min(POLL_MS, waitRemaining, Math.max(quietRemaining, 0));
    if (delay <= 0) return;
    await sleep(delay);

    if (Date.now() >= deadline) return;

    const { count, newest } = readNewOutputProgress(outputFile, since);
    if (count > seen || (count > 0 && newest !== seenNewest)) {
      seen = count;
      seenNewest = newest;
      lastGrowthAt = Date.now();
      continue;
    }
    if (seen > 0 && Date.now() - lastGrowthAt >= quietMs) return;
  }
}
