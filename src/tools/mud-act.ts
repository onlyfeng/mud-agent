import fs from "node:fs";
import path from "node:path";
import type { MudActParams, OpenClawPluginApi } from "../core/types.js";
import { resolveSessionDir } from "../lib/session-key.js";
import { getMudSessionStore } from "../storage/session-store.js";

/**
 * mud_act — 游戏动作工具（send + wait + read_since 三合一）
 *
 * 优先用于所有产生游戏状态变化的操作（移动、攻击、对话、捡物等）。
 * 一次工具调用完成「写队列 → 等待服务器响应 → 读取新输出」全流程，
 * 替代分开调用 mud_send + mud_read 的两次往返，减少用户消息被阻塞的时长。
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
          description: "发送后等待服务器响应的毫秒数，默认 2500",
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
      store.ensure(params.sessionKey);
      const dir = resolveSessionDir(store, params.sessionKey);
      const queueFile = path.join(dir, "send-queue.json");
      const outputFile = path.join(dir, "output.jsonl");

      const cmds = Array.isArray(params.commands) ? params.commands : [params.commands];
      const waitMs = params.waitMs ?? 2500;
      const fallbackLines = params.fallbackLines ?? 20;

      // ── 1. 记录发送时刻，写入命令队列 ────────────────────────────────
      const sentAt = new Date();

      let queue: { items: object[] } = { items: [] };
      try {
        queue = JSON.parse(fs.readFileSync(queueFile, "utf8"));
      } catch {}
      for (const cmd of cmds) {
        queue.items.push({ cmd, time: sentAt.toISOString() });
      }
      fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2));

      // ── 2. 等待守护进程发送并收到服务器响应 ──────────────────────────
      await new Promise((resolve) => setTimeout(resolve, waitMs));

      // ── 3. 读取 sentAt 之后的新输出行 ────────────────────────────────
      try {
        const raw = fs.readFileSync(outputFile, "utf8");
        const all = raw.trim().split("\n").filter(Boolean);

        let newLines = all.filter((l) => {
          try {
            return new Date(JSON.parse(l).ts) > sentAt;
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
              text: `已发送: ${cmds.join(", ")}\n\n` + `=== 服务器响应 ===\n${formatted || "(暂无新输出)"}`,
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
