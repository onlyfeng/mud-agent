/**
 * autopilot 主循环 — 从 scripts/autopilot.js 迁移。
 */

import fs from "node:fs";
import type { Alert, AutopilotConfig, Decision, GameState, IStrategy, MudPaths, OutputLine } from "../../core/types";
import { loadJSON, writeJSON } from "../../infra/file-store";
import { notify } from "../../infra/notifier";
import { removePid, writePid } from "../../infra/process-guard";
import { ExplorationStrategy } from "./exploration.strategy";
import { GrindingStrategy } from "./grinding.strategy";

const DEFAULT_CONFIG: AutopilotConfig = {
  mode: "semi-auto",
  style: "exploration",
  loopInterval: 3500,
  reportInterval: 4,
  safetyBoundary: {
    minHpPercent: 30,
    autoFlee: true,
    avoidCombatWith: [],
  },
  pauseOn: ["rare_item", "boss", "puzzle", "level_up"],
  autoPickup: true,
  combatEnabled: false,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendReport(reportFile: string, text: string): void {
  const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const entry = `\n### ${ts}\n${text.trim()}\n`;
  try {
    fs.appendFileSync(reportFile, entry, "utf8");
  } catch {}
}

function logLine(logFile: string, msg: string): void {
  const line = `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${msg}\n`;
  try {
    fs.appendFileSync(logFile, line);
  } catch {}
  process.stdout.write(line);
}

function sendCommand(queueFile: string, cmd: string, log: (msg: string) => void): void {
  const queue = loadJSON<{ items: Array<{ cmd: string; time: string }> }>(queueFile, { items: [] });
  queue.items.push({ cmd, time: new Date().toISOString() });
  writeJSON(queueFile, queue);
  log(`→ ${cmd}`);
}

function readOutputSince(outputFile: string, sinceTs: string): OutputLine[] {
  try {
    const content = fs.readFileSync(outputFile, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    const result: OutputLine[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as OutputLine;
        if (new Date(obj.ts) > new Date(sinceTs)) result.push(obj);
      } catch {}
    }
    return result;
  } catch {
    return [];
  }
}

function hasPendingDecisions(decisionsFile: string): boolean {
  const list = loadJSON<Decision[]>(decisionsFile, []);
  return list.some((d) => !d.resolved);
}

function writeDecision(
  decisionsFile: string,
  evt: {
    eventType?: string;
    summary: string;
    context: string;
    options: string[];
    priority?: string;
  },
  log: (msg: string) => void,
): void {
  const list = loadJSON<Decision[]>(decisionsFile, []);
  list.push({
    id: `d_${Date.now()}`,
    time: new Date().toISOString(),
    priority: (evt.priority as Decision["priority"]) || "high",
    eventType: evt.eventType,
    summary: evt.summary,
    context: evt.context,
    options: evt.options || ["继续", "暂停"],
    resolved: false,
    choice: null,
  });
  writeJSON(decisionsFile, list);
  log(`[决策] ${evt.summary}`);
}

export async function startAutopilot(paths: MudPaths): Promise<void> {
  const initialConfig = loadJSON<Partial<AutopilotConfig>>(paths.autopilotConfig, {});
  const styleArg = initialConfig.style || "exploration";
  writePid(paths.autopilotPid);
  const log = (msg: string) => logLine(paths.autopilotLog, msg);
  log(`autopilot 启动，策略: ${styleArg}`);

  if (!fs.existsSync(paths.decisions)) writeJSON(paths.decisions, []);
  if (!fs.existsSync(paths.report)) {
    fs.writeFileSync(paths.report, `# autopilot 探索日志\n\n启动时间：${new Date().toLocaleString("zh-CN")}\n`, "utf8");
  }

  const strategy: IStrategy = styleArg === "grinding" ? new GrindingStrategy() : new ExplorationStrategy();

  let lastTs = new Date(Date.now() - 5000).toISOString();

  while (true) {
    // 停止信号
    if (fs.existsSync(paths.autopilotControl)) {
      const ctrl = loadJSON<{ action?: string }>(paths.autopilotControl, {});
      if (ctrl.action === "stop") {
        try {
          fs.unlinkSync(paths.autopilotControl);
        } catch {}
        log("收到停止信号，退出。");
        appendReport(paths.report, "autopilot 已停止。");
        break;
      }
    }

    const userConfig = loadJSON<Partial<AutopilotConfig>>(paths.autopilotConfig, {});
    const config: AutopilotConfig = {
      ...DEFAULT_CONFIG,
      ...userConfig,
      safetyBoundary: {
        ...DEFAULT_CONFIG.safetyBoundary,
        ...userConfig.safetyBoundary,
      },
    };
    const state = loadJSON<Partial<GameState>>(paths.state, {});
    const alerts = loadJSON<Alert[]>(paths.alerts, []).filter((a) => !a.read);

    if (!state.connected) {
      log("守护进程未连接，等待...");
      await sleep(5000);
      continue;
    }

    // 安全边界
    if (state.hp != null && state.maxHp && config.safetyBoundary.autoFlee) {
      const hpPct = (state.hp / state.maxHp) * 100;
      if (hpPct < config.safetyBoundary.minHpPercent) {
        log(`HP ${Math.round(hpPct)}% 低于安全线，自动 flee`);
        sendCommand(paths.queue, "flee", log);
        appendReport(paths.report, `⚠️ HP 告急（${Math.round(hpPct)}%），自动撤退。`);
        notify("mud-agent 血量危急", `HP ${Math.round(hpPct)}%，已自动逃跑`);
        await sleep(config.loopInterval);
        continue;
      }
    }

    if (hasPendingDecisions(paths.decisions)) {
      log("有待处理的决策，暂停执行。");
      await sleep(2000);
      continue;
    }

    for (const alert of alerts.filter((a) => a.priority === "critical")) {
      notify("mud-agent 紧急警报", `${alert.label}：${alert.context || ""}`);
    }

    const newLines = readOutputSince(paths.output, lastTs);
    if (newLines.length > 0) {
      lastTs = newLines[newLines.length - 1].ts;
    }

    const action = strategy.decide({
      state: state as GameState,
      newLines,
      alerts,
      config,
    });

    if (action.command) sendCommand(paths.queue, action.command, log);
    if (action.narrative) appendReport(paths.report, action.narrative);

    if (action.pauseEvent) {
      writeDecision(paths.decisions, action.pauseEvent, log);
      notify("mud-agent", action.pauseEvent.summary.slice(0, 100));
      appendReport(paths.report, `**[需要决策]** ${action.pauseEvent.summary}`);
    }

    await sleep(config.loopInterval || 3500);
  }

  removePid(paths.autopilotPid);
  log("autopilot 已退出。");
}
