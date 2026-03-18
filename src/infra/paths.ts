/**
 * MUD_DIR 解析、所有文件路径集中管理。
 */

import path from "node:path";
import type { MudPaths } from "../core/types";

export function resolveMudDir(override?: string): string {
  return override || process.env.MUD_DIR || path.join(process.env.HOME || "", ".mud-agent");
}

export function buildPaths(mudDir: string): MudPaths {
  return {
    root: mudDir,
    config: path.join(mudDir, "config.json"),
    output: path.join(mudDir, "output.jsonl"),
    queue: path.join(mudDir, "send-queue.json"),
    state: path.join(mudDir, "state.json"),
    alerts: path.join(mudDir, "alerts.json"),
    control: path.join(mudDir, "control.json"),
    pid: path.join(mudDir, "mud-daemon.pid"),
    heartbeat: path.join(mudDir, ".heartbeat"),
    log: path.join(mudDir, "daemon.log"),
    report: path.join(mudDir, "report.md"),
    decisions: path.join(mudDir, "decisions.json"),
    autopilotConfig: path.join(mudDir, "autopilot-config.json"),
    autopilotPid: path.join(mudDir, "autopilot.pid"),
    autopilotControl: path.join(mudDir, "autopilot-control.json"),
    autopilotLog: path.join(mudDir, "autopilot.log"),
  };
}
