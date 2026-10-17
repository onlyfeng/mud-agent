import fs from "node:fs";
import path from "node:path";
import type { MudSendParams, OpenClawPluginApi } from "../core/types.js";
import { enqueueCommands } from "../infra/send-queue.js";
import { resolveSessionDir } from "../lib/session-key.js";
import { getMudSessionStore } from "../storage/session-store.js";

export function registerMudSendTool(api: OpenClawPluginApi): void {
  if (typeof api?.registerTool !== "function") return;

  api.registerTool({
    name: "mud_send",
    description: "发送一条或多条游戏命令到 MUD 服务器（仅发送，不等待响应）。需要同时读取响应时请改用 mud_act。",
    parameters: {
      type: "object",
      properties: {
        sessionKey: { type: "string" },
        commands: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
      },
      required: ["sessionKey", "commands"],
    },
    async execute(_id: string, raw: Record<string, unknown>) {
      const params = raw as unknown as MudSendParams;
      const store = getMudSessionStore();
      // 写工具不注册会话：打错/从未初始化的键若在这里 ensure()，目录一出现模型路由就把该话题永久当成 MUD 会话
      const dir = resolveSessionDir(store, params.sessionKey);
      if (!fs.existsSync(path.join(dir, "config.json"))) {
        return {
          content: [{ type: "text", text: "❌ 该会话尚未初始化：请先 /mud start host:port 或 mud_admin setup" }],
        };
      }
      const queueFile = path.join(dir, "send-queue.json");

      const cmds = Array.isArray(params.commands) ? params.commands : [params.commands];
      enqueueCommands(queueFile, cmds);

      return {
        content: [{ type: "text", text: `已加入队列 ${cmds.length} 条命令: ${cmds.join(", ")}` }],
      };
    },
  });
}
