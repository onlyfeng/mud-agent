#!/usr/bin/env node
/**
 * autopilot 独立进程入口。
 */

import { buildPaths, resolveMudDir } from "../infra/paths";
import { removePid } from "../infra/process-guard";
import { startAutopilot } from "../services/autopilot/autopilot.service";

const mudDir = resolveMudDir();
const paths = buildPaths(mudDir);

process.on("uncaughtException", (err) => {
  console.error(`[autopilot] uncaughtException: ${err.message}\n${err.stack}`);
  removePid(paths.autopilotPid);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error(`[autopilot] unhandledRejection: ${reason}`);
  removePid(paths.autopilotPid);
  process.exit(1);
});

startAutopilot(paths).catch((err) => {
  console.error(`[错误] ${err.message}\n${err.stack}`);
  process.exit(1);
});
