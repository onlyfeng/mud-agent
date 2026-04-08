import type { OpenClawPluginApi } from "../core/types.js";
import { registerMudActTool } from "./mud-act.js";
import { registerMudAdminTool } from "./mud-admin.js";
import { registerMudAlertsTool } from "./mud-alerts.js";
import { registerMudReadTool } from "./mud-read.js";
import { registerMudSendTool } from "./mud-send.js";
import { registerMudStatusTool } from "./mud-status.js";

export function registerMudTools(api: OpenClawPluginApi): void {
  registerMudActTool(api); // ← 新增：send+wait+read 三合一，优先使用
  registerMudSendTool(api);
  registerMudReadTool(api);
  registerMudStatusTool(api);
  registerMudAlertsTool(api);
  registerMudAdminTool(api);
}
