import fs from "node:fs";
import path from "node:path";
import type { MudReadParams, OpenClawPluginApi } from "../core/types.js";
import { resolveSessionDir } from "../lib/session-key.js";
import { getMudSessionStore } from "../storage/session-store.js";

export function registerMudReadTool(api: OpenClawPluginApi): void {
  if (typeof api?.registerTool !== "function") return;

  api.registerTool({
    name: "mud_read",
    description: "读取 MUD 服务器的历史输出（只读，不发送命令）。需要发送命令并读取响应时请改用 mud_act。",
    parameters: {
      type: "object",
      properties: {
        sessionKey: { type: "string" },
        lines: { type: "number", description: "读取行数，默认 40" },
        since: { type: "string", description: "读取某个 ISO8601 时间之后的输出（会忽略 lines 参数）" },
      },
      required: ["sessionKey"],
    },
    async execute(_id: string, raw: Record<string, unknown>) {
      const params = raw as unknown as MudReadParams;
      const store = getMudSessionStore();
      const dir = resolveSessionDir(store, params.sessionKey);
      const outputFile = path.join(dir, "output.jsonl");

      try {
        const content = fs.readFileSync(outputFile, "utf8");
        let allLines = content.trim().split("\n").filter(Boolean);

        if (params.since) {
          const sinceTime = new Date(params.since);
          allLines = allLines.filter((l) => {
            try {
              return new Date(JSON.parse(l).ts) > sinceTime;
            } catch {
              return false;
            }
          });
        } else {
          const n = params.lines || 40;
          allLines = allLines.slice(-n);
        }

        if (!allLines.length) {
          return { content: [{ type: "text", text: "(暂无新输出)" }] };
        }

        const formatted = allLines
          .map((l) => {
            try {
              const { ts, text } = JSON.parse(l);
              const t = new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
              return `[${t}] ${text}`;
            } catch {
              return l;
            }
          })
          .join("\n");

        return {
          content: [{ type: "text", text: `=== 最近游戏输出 ===\n${formatted}` }],
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `读取失败或暂无输出文件: ${msg}` }],
        };
      }
    },
  });
}
