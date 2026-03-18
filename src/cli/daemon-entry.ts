#!/usr/bin/env node
/**
 * 守护进程独立入口 — 由 CLI start / OpenClaw spawn 调用。
 */

import { buildPaths, resolveMudDir } from "../infra/paths";
import { removePid } from "../infra/process-guard";
import { startDaemon } from "../services/daemon.service";

const mudDir = resolveMudDir();
const paths = buildPaths(mudDir);

process.on("uncaughtException", (err) => {
  console.error(`[daemon] uncaughtException: ${err.message}\n${err.stack}`);
  removePid(paths.pid);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error(`[daemon] unhandledRejection: ${reason}`);
  removePid(paths.pid);
  process.exit(1);
});

startDaemon({ paths });
