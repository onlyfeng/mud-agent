import fs from "node:fs";
import path from "node:path";
import type { Alert, MudAlertsParams, OpenClawPluginApi } from "../core/types";
import { resolveSessionDir } from "../lib/session-key";
import { getMudSessionStore } from "../storage/session-store";

export function registerMudAlertsTool(api: OpenClawPluginApi): void {
  if (typeof api?.registerTool !== "function") return;

  api.registerTool({
    name: "mud_alerts",
    description: "查看和清除未读警报",
    parameters: {
      type: "object",
      properties: {
        sessionKey: { type: "string" },
        clear: {
          type: "boolean",
          description: "传 true 时，读取后自动将未读警报标记为已读，避免下次重复显示。建议每次读警报时传 true。",
        },
      },
      required: ["sessionKey"],
    },
    async execute(_id: string, raw: Record<string, unknown>) {
      const params = raw as unknown as MudAlertsParams;
      const store = getMudSessionStore();
      const dir = resolveSessionDir(store, params.sessionKey);
      const alertsFile = path.join(dir, "alerts.json");

      let alerts: Alert[] = [];
      try {
        alerts = JSON.parse(fs.readFileSync(alertsFile, "utf8"));
      } catch {}

      const unread = alerts.filter((a) => !a.read);

      if (!unread.length) {
        return { content: [{ type: "text", text: "✅ 无未读警报" }] };
      }

      const formatted = unread
        .map((a) => {
          const t = new Date(a.time).toLocaleTimeString("zh-CN", { hour12: false });
          return `[${t}] [${a.priority.toUpperCase()}] ${a.label}\n  建议: ${a.advice}${a.context ? `\n  原文: ${a.context}` : ""}`;
        })
        .join("\n\n");

      if (params.clear) {
        const cleared = alerts.map((a) => ({ ...a, read: true }));
        fs.writeFileSync(alertsFile, JSON.stringify(cleared, null, 2));
      }

      return {
        content: [
          {
            type: "text",
            text: `=== 未读警报 (${unread.length} 条) ===\n\n${formatted}\n\n${params.clear ? "(已自动清除未读状态)" : ""}`.trim(),
          },
        ],
      };
    },
  });
}
