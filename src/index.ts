import { registerMudCommand } from "./commands/mud-command";
import type { OpenClawPluginApi } from "./core/types";
import { registerSessionModeHook } from "./hooks/session-mode";
import { configureMudStorage } from "./storage/session-store";
import { registerMudTools } from "./tools";

function resolveConfiguredStorageDir(api: OpenClawPluginApi): string | undefined {
  const entry = api?.config?.plugins?.entries?.["mud-agent"];
  const cfg = entry?.config as Record<string, unknown> | undefined;
  return (
    (cfg?.storageDir as string | undefined) ??
    ((entry as Record<string, unknown> | undefined)?.storageDir as string | undefined)
  );
}

export default function register(api: OpenClawPluginApi) {
  configureMudStorage(resolveConfiguredStorageDir(api));
  registerMudCommand(api);
  registerSessionModeHook(api);
  registerMudTools(api);
}
