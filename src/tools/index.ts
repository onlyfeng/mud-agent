import type { OpenClawPluginApi } from "../core/types";
import { registerMudActTool } from "./mud-act";
import { registerMudAdminTool } from "./mud-admin";
import { registerMudAlertsTool } from "./mud-alerts";
import { registerMudReadTool } from "./mud-read";
import { registerMudSendTool } from "./mud-send";
import { registerMudStatusTool } from "./mud-status";

export function registerMudTools(api: OpenClawPluginApi): void {
  registerMudActTool(api); // ← 新增：send+wait+read 三合一，优先使用
  registerMudSendTool(api);
  registerMudReadTool(api);
  registerMudStatusTool(api);
  registerMudAlertsTool(api);
  registerMudAdminTool(api);
}
