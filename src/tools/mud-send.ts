import fs from "node:fs";
import path from "node:path";
import type { MudSendParams, OpenClawPluginApi } from "../core/types";
import { resolveSessionDir } from "../lib/session-key";
import { getMudSessionStore } from "../storage/session-store";

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
      store.ensure(params.sessionKey);
      const dir = resolveSessionDir(store, params.sessionKey);
      const queueFile = path.join(dir, "send-queue.json");

      let queue = { items: [] as object[] };
      try {
        queue = JSON.parse(fs.readFileSync(queueFile, "utf8"));
      } catch {}

      const cmds = Array.isArray(params.commands) ? params.commands : [params.commands];
      for (const cmd of cmds) {
        queue.items.push({ cmd, time: new Date().toISOString() });
      }

      fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2));

      return {
        content: [{ type: "text", text: `已加入队列 ${cmds.length} 条命令: ${cmds.join(", ")}` }],
      };
    },
  });
}
