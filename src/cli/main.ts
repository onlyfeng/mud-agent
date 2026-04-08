#!/usr/bin/env node
/**
 * mud-ctl CLI 入口 — 从 scripts/mud-ctl.js 迁移。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Alert, AutopilotConfig, Decision, GameState, MudConfig } from "../core/types.js";
import { loadJSON, writeJSON } from "../infra/file-store.js";
import { buildPaths, resolveMudDir } from "../infra/paths.js";
import { isProcessRunning } from "../infra/process-guard.js";

const mudDir = resolveMudDir();
const P = buildPaths(mudDir);
const DAEMON_ENTRY = path.resolve(__dirname, "daemon-entry.js");
const AUTOPILOT_ENTRY = path.resolve(__dirname, "autopilot-entry.js");

fs.mkdirSync(mudDir, { recursive: true });

const [, , action, ...args] = process.argv;

function main(): void {
  switch (action) {
    case "setup": {
      const [host, port, encoding, username, password] = args;
      if (!host || !port) {
        console.error("用法: mud-ctl setup <host> <port> [encoding] [username] [password]");
        process.exit(1);
      }
      // 保留已有的 loginSequence，避免重新 setup 时把登录步骤清空
      let existingLoginSequence: MudConfig["loginSequence"] = [];
      try {
        const existing = loadJSON<MudConfig | null>(P.config, null);
        if (Array.isArray(existing?.loginSequence)) {
          existingLoginSequence = existing.loginSequence;
        }
      } catch {}
      const cfg: MudConfig = {
        server: {
          host,
          port: parseInt(port, 10),
          encoding: encoding || "gbk",
        },
        credentials: { username: username || "", password: password || "" },
        loginSequence: existingLoginSequence,
      };
      writeJSON(P.config, cfg);
      try {
        fs.writeFileSync(P.output, "");
      } catch {}
      writeJSON(P.alerts, []);
      writeJSON(P.queue, { items: [] });
      console.log("配置已保存");
      console.log(`  服务器: ${host}:${port}`);
      console.log(`  编码:   ${encoding || "gbk"}`);
      console.log(`  角色:   ${username || "(未设置)"}`);
      break;
    }

    case "config-update-creds": {
      const [username, password] = args;
      const cfg = loadJSON<MudConfig | null>(P.config, null);
      if (!cfg) {
        console.error("未配置，请先 setup");
        process.exit(1);
      }
      cfg.credentials = { username, password };
      writeJSON(P.config, cfg);
      console.log(`账号已更新: ${username}`);
      break;
    }

    case "config-show": {
      const cfg = loadJSON<MudConfig | null>(P.config, null);
      if (!cfg) {
        console.log("未配置");
        break;
      }
      const safe = JSON.parse(JSON.stringify(cfg));
      if (safe.credentials?.password) safe.credentials.password = "***";
      console.log(JSON.stringify(safe, null, 2));
      break;
    }

    case "login-step": {
      const [trigger, send] = args;
      const cfg = loadJSON<MudConfig | null>(P.config, null);
      if (!cfg) {
        console.error("未配置");
        process.exit(1);
      }
      cfg.loginSequence = cfg.loginSequence || [];
      cfg.loginSequence.push({ trigger, send });
      writeJSON(P.config, cfg);
      console.log(`已添加登录步骤: 当检测到 "${trigger}" 时发送 "${send}"`);
      break;
    }

    case "start": {
      const pid = isProcessRunning(P.pid);
      if (pid) {
        console.log(`守护进程已在运行 (PID ${pid})`);
        break;
      }
      const cfg = loadJSON<MudConfig | null>(P.config, null);
      if (!cfg) {
        console.error("未配置，请先运行 setup");
        process.exit(1);
      }
      const logFile = P.log;
      const out = fs.openSync(logFile, "a");
      const child = spawn("node", [DAEMON_ENTRY], {
        detached: true,
        stdio: ["ignore", out, out],
        env: { ...process.env, MUD_DIR: mudDir },
      });
      child.unref();
      fs.closeSync(out);
      console.log(`守护进程已启动 (PID ${child.pid})`);
      console.log(`  日志: ${logFile}`);
      console.log("  等待连接... (约3-5秒后可用 read 查看服务器输出)");
      break;
    }

    case "stop": {
      const pid = isProcessRunning(P.pid);
      if (!pid) {
        console.log("守护进程未运行");
        break;
      }
      writeJSON(P.control, { action: "stop" });
      setTimeout(() => {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
        console.log("守护进程已停止");
      }, 1500);
      break;
    }

    case "restart": {
      const pid = isProcessRunning(P.pid);
      if (pid) {
        writeJSON(P.control, { action: "stop" });
        setTimeout(() => {
          try {
            process.kill(pid, "SIGTERM");
          } catch {}
        }, 1000);
      }
      setTimeout(() => {
        const out2 = fs.openSync(P.log, "a");
        const child2 = spawn("node", [DAEMON_ENTRY], {
          detached: true,
          stdio: ["ignore", out2, out2],
          env: { ...process.env, MUD_DIR: mudDir },
        });
        child2.unref();
        fs.closeSync(out2);
        console.log(`守护进程已重启 (PID ${child2.pid})`);
      }, 2500);
      break;
    }

    case "status": {
      const pid = isProcessRunning(P.pid);
      const cfg = loadJSON<MudConfig | null>(P.config, null);
      const state = loadJSON<Partial<GameState> | null>(P.state, null);
      const alerts = loadJSON<Alert[]>(P.alerts, []);
      const unread = alerts.filter((a) => !a.read);

      console.log("=== MUD 守护进程状态 ===");
      console.log(`进程: ${pid ? `运行中 (PID ${pid})` : "未运行"}`);
      if (cfg) {
        console.log(`服务器: ${cfg.server.host}:${cfg.server.port}`);
        console.log(`角色: ${cfg.credentials?.username || "未设置"}`);
      }
      if (state) {
        console.log(`连接: ${state.connected ? "是" : "否"}`);
        console.log(`登录: ${state.loginDone ? "是" : "否"}`);
        if (state.hp != null) console.log(`HP: ${state.hp}/${state.maxHp ?? "?"}`);
        if (state.mp != null) console.log(`MP: ${state.mp}/${state.maxMp ?? "?"}`);
        if (state.level) console.log(`等级: ${state.level}`);
        if (state.exits?.length) console.log(`出口: ${state.exits.join(" ")}`);
      }
      if (unread.length) {
        console.log(`\n未读警报 ${unread.length} 条:`);
        for (const a of unread) {
          console.log(`  [${a.priority}] ${a.label}: ${a.advice}`);
        }
      }
      break;
    }

    case "send": {
      const cmd = args.join(" ");
      if (!cmd) {
        console.error("用法: mud-ctl send <命令>");
        process.exit(1);
      }
      const queue = loadJSON<{ items: Array<{ cmd: string; time: string }> }>(P.queue, { items: [] });
      queue.items.push({ cmd, time: new Date().toISOString() });
      writeJSON(P.queue, queue);
      console.log(`命令已入队: ${cmd}`);
      break;
    }

    case "send-multi": {
      let cmds: string[];
      try {
        cmds = JSON.parse(args.join(" "));
      } catch {
        cmds = args;
      }
      const queue = loadJSON<{ items: Array<{ cmd: string; time: string }> }>(P.queue, { items: [] });
      for (const cmd of cmds) {
        queue.items.push({ cmd, time: new Date().toISOString() });
      }
      writeJSON(P.queue, queue);
      console.log(`已入队 ${cmds.length} 条命令: ${cmds.join(", ")}`);
      break;
    }

    case "read": {
      const n = parseInt(args[0], 10) || 40;
      try {
        const content = fs.readFileSync(P.output, "utf8");
        const lines = content.trim().split("\n").filter(Boolean).slice(-n);
        if (!lines.length) {
          console.log("(暂无输出)");
          break;
        }
        console.log(`=== 最近 ${lines.length} 行游戏输出 ===`);
        for (const line of lines) {
          try {
            const { ts, text } = JSON.parse(line);
            const t = new Date(ts).toLocaleTimeString("zh-CN", {
              hour12: false,
            });
            console.log(`[${t}] ${text}`);
          } catch {
            console.log(line);
          }
        }
      } catch {
        console.log("(暂无输出文件)");
      }
      break;
    }

    case "read-since": {
      const since = args[0] ? new Date(args[0]) : new Date(Date.now() - 30000);
      try {
        const content = fs.readFileSync(P.output, "utf8");
        const lines = content
          .trim()
          .split("\n")
          .filter(Boolean)
          .filter((l) => {
            try {
              return new Date(JSON.parse(l).ts) > since;
            } catch {
              return false;
            }
          });
        if (!lines.length) {
          console.log("(这段时间无新输出)");
          break;
        }
        for (const l of lines) {
          try {
            const { ts, text } = JSON.parse(l);
            const t = new Date(ts).toLocaleTimeString("zh-CN", {
              hour12: false,
            });
            console.log(`[${t}] ${text}`);
          } catch {
            console.log(l);
          }
        }
      } catch {
        console.log("(暂无输出)");
      }
      break;
    }

    case "state": {
      const state = loadJSON<Partial<GameState> | null>(P.state, null);
      if (!state) {
        console.log("无状态数据");
        break;
      }
      console.log("=== 角色状态 ===");
      console.log(JSON.stringify(state, null, 2));
      break;
    }

    case "alerts": {
      const alerts = loadJSON<Alert[]>(P.alerts, []);
      const unread = alerts.filter((a) => !a.read);
      if (!unread.length) {
        console.log("无未读警报");
        break;
      }
      console.log(`=== 未读警报 (${unread.length} 条) ===`);
      for (const a of unread) {
        const t = new Date(a.time).toLocaleTimeString("zh-CN", {
          hour12: false,
        });
        console.log(`[${t}] [${a.priority.toUpperCase()}] ${a.label}`);
        console.log(`  建议: ${a.advice}`);
        if (a.context) console.log(`  原文: ${a.context}`);
        console.log("");
      }
      break;
    }

    case "alerts-clear": {
      const alerts = loadJSON<Alert[]>(P.alerts, []);
      const cleared = alerts.map((a) => ({ ...a, read: true }));
      writeJSON(P.alerts, cleared);
      console.log(`已标记 ${alerts.filter((a) => !a.read).length} 条警报为已读`);
      break;
    }

    case "autopilot": {
      const sub = args[0];
      if (sub === "start") {
        const apPid = isProcessRunning(P.autopilotPid);
        if (apPid) {
          console.log(`autopilot 已在运行 (PID ${apPid})`);
          break;
        }
        const style = args[1] || "exploration";
        if (!fs.existsSync(P.autopilotConfig)) {
          writeJSON(P.autopilotConfig, {
            ...{
              mode: "semi-auto",
              style,
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
            },
          });
        } else {
          const cfg = loadJSON<Partial<AutopilotConfig>>(P.autopilotConfig, {});
          cfg.style = style as AutopilotConfig["style"];
          writeJSON(P.autopilotConfig, cfg);
        }
        const apLogFile = P.autopilotLog;
        const out = fs.openSync(apLogFile, "a");
        const child = spawn("node", [AUTOPILOT_ENTRY], {
          detached: true,
          stdio: ["ignore", out, out],
          env: { ...process.env, MUD_DIR: mudDir },
        });
        child.unref();
        fs.closeSync(out);
        console.log(`autopilot 已启动 (PID ${child.pid}, style: ${style})`);
        console.log(`  日志: ${apLogFile}`);
      } else if (sub === "stop") {
        const apPid = isProcessRunning(P.autopilotPid);
        if (!apPid) {
          console.log("autopilot 未运行");
          break;
        }
        writeJSON(P.autopilotControl, { action: "stop" });
        console.log("已发送停止信号");
      } else if (sub === "status") {
        const apPid = isProcessRunning(P.autopilotPid);
        const cfg = loadJSON<Partial<AutopilotConfig> | null>(P.autopilotConfig, null);
        console.log("=== autopilot 状态 ===");
        console.log(`进程: ${apPid ? `运行中 (PID ${apPid})` : "未运行"}`);
        if (cfg) {
          console.log(`风格: ${cfg.style || "-"}`);
          console.log(`安全线: HP >= ${cfg.safetyBoundary?.minHpPercent ?? 30}%`);
          console.log(`暂停触发: ${(cfg.pauseOn || []).join(", ")}`);
        }
        const decs = loadJSON<Decision[]>(P.decisions, []);
        const pending = decs.filter((d) => !d.resolved);
        if (pending.length) console.log(`待决策 ${pending.length} 条`);
      } else {
        console.log("用法: mud-ctl autopilot <start [style]|stop|status>");
        console.log("  style 可选: exploration（探索，默认）/ grinding（练级）");
      }
      break;
    }

    case "decisions": {
      const decs = loadJSON<Decision[]>(P.decisions, []);
      const pending = decs.filter((d) => !d.resolved);
      if (!pending.length) {
        console.log("无待决策事项");
        break;
      }
      console.log(`=== 待决策事项 (${pending.length} 条) ===\n`);
      for (const d of pending) {
        const t = new Date(d.time).toLocaleTimeString("zh-CN", {
          hour12: false,
        });
        console.log(`[${d.id}] ${t}  [${d.priority || "normal"}]`);
        console.log(`  ${d.summary}`);
        if (d.options?.length) {
          for (let i = 0; i < d.options.length; i++) {
            console.log(`  ${i + 1}. ${d.options[i]}`);
          }
        }
        console.log("");
      }
      console.log("用 decisions-resolve <id> <选项编号或文字> 来响应");
      break;
    }

    case "decisions-resolve": {
      const [decId, ...choiceParts] = args;
      if (!decId) {
        console.error("用法: mud-ctl decisions-resolve <id> <choice>");
        process.exit(1);
      }
      const choice = choiceParts.join(" ");
      const decs = loadJSON<Decision[]>(P.decisions, []);
      const idx = decs.findIndex((d) => d.id === decId);
      if (idx === -1) {
        console.error(`未找到决策 ID: ${decId}`);
        process.exit(1);
      }
      decs[idx].resolved = true;
      decs[idx].choice = choice;
      decs[idx].resolvedAt = new Date().toISOString();
      writeJSON(P.decisions, decs);
      console.log(`决策 [${decId}] 已解决: ${choice}`);
      break;
    }

    case "report": {
      const n = parseInt(args[0], 10) || 50;
      try {
        const content = fs.readFileSync(P.report, "utf8");
        const lines = content.split("\n");
        const tail = lines.slice(-n).join("\n").trim();
        if (!tail) {
          console.log("(report.md 暂无内容)");
          break;
        }
        console.log(`=== 叙事日志（最近 ${n} 行）===\n`);
        console.log(tail);
      } catch {
        console.log("(report.md 不存在，autopilot 尚未运行过)");
      }
      break;
    }

    default:
      console.log(`
mud-ctl — MUD 守护进程控制工具

配置:
  setup <host> <port> [encoding] [username] [password]
  config-update-creds <username> <password>
  config-show
  login-step <触发正则> <发送内容>

守护进程:
  start / stop / restart / status

游戏交互:
  send <命令>
  send-multi '["cmd1","cmd2"]'
  read [行数]
  read-since [ISO时间]
  state / alerts / alerts-clear

自动驾驶:
  autopilot start [style] / stop / status
  decisions / decisions-resolve <id> <choice>
  report [行数]

数据目录: ${mudDir}
`);
  }
}

main();
