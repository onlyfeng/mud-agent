import fs from "node:fs";
import path from "node:path";
import type { Alert, GameState, MudStatusParams, OpenClawPluginApi } from "../core/types.js";
import { resolveSessionDir } from "../lib/session-key.js";
import { getMudSessionStore } from "../storage/session-store.js";

export function registerMudStatusTool(api: OpenClawPluginApi): void {
  if (typeof api?.registerTool !== "function") return;

  api.registerTool({
    name: "mud_status",
    description: "获取角色状态、连接状态和未读警报总数",
    parameters: {
      type: "object",
      properties: { sessionKey: { type: "string" } },
      required: ["sessionKey"],
    },
    async execute(_id: string, raw: Record<string, unknown>) {
      const params = raw as unknown as MudStatusParams;
      const store = getMudSessionStore();
      const dir = resolveSessionDir(store, params.sessionKey);

      const pidFile = path.join(dir, "mud-daemon.pid");
      const stateFile = path.join(dir, "state.json");
      const alertsFile = path.join(dir, "alerts.json");

      let pidRunning = false;
      try {
        const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
        process.kill(pid, 0);
        pidRunning = true;
      } catch {}

      let state: Partial<GameState> = {};
      try {
        state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      } catch {}

      let unreadAlerts = 0;
      try {
        const alerts: Alert[] = JSON.parse(fs.readFileSync(alertsFile, "utf8"));
        unreadAlerts = alerts.filter((a) => !a.read).length;
      } catch {}

      let serverInfo = "";
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
        const user = cfg.credentials?.username ? ` | 角色: ${cfg.credentials.username}` : "";
        serverInfo = `${cfg.server.host}:${cfg.server.port} (${cfg.server.encoding})${user}`;
      } catch {}

      const summary = [
        "📍 MUD 状态总览",
        serverInfo ? `服务器: ${serverInfo}` : "服务器: ❌ 未配置（请先调 mud_admin setup）",
        `进程: ${pidRunning ? "✅ 运行中" : "❌ 未运行"}`,
        `连接: ${state.connected ? "✅" : "❌"}`,
        `登录: ${state.loginDone ? "✅" : "❌"}`,
      ];

      if (state.hp != null) {
        summary.push(`HP: ${state.hp}/${state.maxHp ?? "?"}`);
      }
      if (state.mp != null) {
        summary.push(`MP: ${state.mp}/${state.maxMp ?? "?"}`);
      }
      if (state.level) summary.push(`等级: ${state.level}`);
      if (state.gold) summary.push(`金钱: ${state.gold}`);
      if (state.exits?.length) summary.push(`出口: ${state.exits.join(" ")}`);

      if (unreadAlerts > 0) {
        summary.push(`\n⚠️ 未读警报: ${unreadAlerts} 条（请调 mud_alerts 详细查看）`);
      }

      return {
        content: [{ type: "text", text: summary.join("\n") }],
      };
    },
  });
}
