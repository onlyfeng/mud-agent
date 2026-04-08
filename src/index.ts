import { registerMudCommand } from "./commands/mud-command.js";
import type { OpenClawPluginApi } from "./core/types.js";
import { registerSessionModeHook } from "./hooks/session-mode.js";
import { configureMudStorage } from "./storage/session-store.js";
import { registerMudTools } from "./tools/index.js";

export default {
  id: "mud-agent",
  name: "MUD Agent",
  description: "AI-powered MUD game assistant — play text MUDs through natural language conversation",
  register(api: OpenClawPluginApi) {
    const storageDir = api.pluginConfig?.storageDir as string | undefined;
    configureMudStorage(storageDir);
    registerMudCommand(api);
    registerSessionModeHook(api);
    registerMudTools(api);
  },
};
