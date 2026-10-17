#!/usr/bin/env node
/**
 * 守护进程独立入口 — 由 CLI start / OpenClaw spawn 调用。
 *
 * uncaughtException / unhandledRejection 由 startDaemon() 内部统一注册，
 * 走 gracefulShutdown("crash") 保证 state.json 被正确清理（connected=false
 * + shutdownReason="crash"）。不要在这里重复注册 —— Node.js 先注册的 handler
 * 如果调了 process.exit()，后注册的不会执行。
 */

import { buildPaths, resolveMudDir } from "../infra/paths.js";
import { startDaemon } from "../services/daemon.service.js";

const mudDir = resolveMudDir();
const paths = buildPaths(mudDir);

startDaemon({ paths });
