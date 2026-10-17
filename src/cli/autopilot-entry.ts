#!/usr/bin/env node

/**
 * autopilot 独立进程入口。
 */

import { activateGameProfile, loadGameProfile } from "../core/game-profile.js";
import { sendToChannel } from "../infra/notifier.js";
import { buildPaths, resolveMudDir } from "../infra/paths.js";
import { removeOwnPid } from "../infra/process-guard.js";
import { startAutopilot } from "../services/autopilot/autopilot.service.js";

const mudDir = resolveMudDir();
const paths = buildPaths(mudDir);
activateGameProfile(loadGameProfile(mudDir).profile);

// 只删自己持有的 PID 锁：退出窗口里顶上来的新 autopilot 可能已经拿走了这个槽位
process.on("uncaughtException", (err) => {
  console.error(`[autopilot] uncaughtException: ${err.message}\n${err.stack}`);
  removeOwnPid(paths.autopilotPid);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error(`[autopilot] unhandledRejection: ${reason}`);
  removeOwnPid(paths.autopilotPid);
  process.exit(1);
});

startAutopilot(paths).catch((err) => {
  console.error(`[错误] ${err.message}\n${err.stack}`);
  // 致命故障（队列锁持续卡死、队列不可写…）：留下原因并删掉自己的 PID，让用户 / 恢复器知道 autopilot 已退出
  sendToChannel(paths.notifyTarget, `🛑 autopilot 因故障退出：${err.message.slice(0, 200)}`, (m: string) =>
    console.error(m),
  );
  removeOwnPid(paths.autopilotPid);
  process.exit(1);
});
