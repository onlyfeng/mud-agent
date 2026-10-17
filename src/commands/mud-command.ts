import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GameMode, OpenClawCommandContext, OpenClawPluginApi } from "../core/types.js";
import { launchAutopilotAsync, respawnAutopilotWhenDaemonReady } from "../infra/autopilot-launcher.js";
import { readGameModeRecord, signalAutopilotStop, writeGameMode, writeStopSignal } from "../infra/control-signal.js";
import { launchDaemon } from "../infra/daemon-launcher.js";
import { isProcessRunning } from "../infra/process-guard.js";
import { saveNotifyTargetFromCommandContext } from "../lib/notify-target.js";
import { resolveSessionDir, resolveSessionKey } from "../lib/session-key.js";
import { parseTcpPort } from "../lib/tcp-port.js";
import { getMudSessionStore } from "../storage/session-store.js";

// ESM 下 __dirname 不是全局变量，但 @types/node 把它登记为全局声明，
// 所以 tsc / biome / vitest 都不会抱怨；真跑到 spawn 路径上才会
// ReferenceError。必须显式从 import.meta.url 解出一份。
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function helpText(): string {
  return [
    "MUD Agent (OpenClaw)",
    "",
    "-- Commands --",
    "/mud start [host:port] [enc]  Start MUD for this Topic",
    "  e.g. /mud start mud.pkuxkx.net:8081 utf8",
    "  e.g. /mud start xiyouji.org:6666 gbk",
    "/mud status                  Show daemon + login state",
    "/mud stop                    Stop daemon for this Topic",
    "/mud reset                   Clear all session data for this Topic",
    "/mud where                   Show Session ID (debug)",
    "/mud help                    Show this help",
    "",
    "-- Game Modes --",
    "/mud mode companion              Companion mode — play together, AI narrates (default)",
    "/mud mode semi-auto [style]      Autopilot explores, pauses at key events for your decision",
    "/mud mode full-auto [style]      Autopilot runs fully, only critical notifications",
    "  style: exploration (default) | grinding",
    "",
    "-- Quick Start --",
    "1. Send: /mud start mud.pkuxkx.net:8081 utf8",
    "2. Tell AI: login with username XXX password XXX",
    "3. Then chat naturally to play",
    "",
    "-- Session Management (multi-game / switch server) --",
    "Each Telegram Topic = one isolated MUD session.",
    "- Create a new Topic and send /mud start <server> for a new game",
    "- Topics are fully isolated (config, state, output history)",
    "",
    "Switch / logout flow:",
    "1. Tell AI: stop the game process  (or send /mud stop)",
    "2. Switch to target Topic (or create new Topic)",
    "3. Send: /mud start <host:port> <encoding>",
    "4. Tell AI: login with username XXX password XXX",
    "",
    "-- Encoding Reference --",
    "utf8  pkuxkx port 8081, most modern servers",
    "gbk   xiyouji.org:6666, most legacy Chinese servers",
    "big5  Taiwan / Hong Kong servers",
    "",
    "-- Recommended Servers --",
    "PKU XKX:    mud.pkuxkx.net:8081 (utf8) or :8080 (gbk)",
    "Xi You Ji:  xiyouji.org:6666 (gbk)",
    "",
    "-- Security Note --",
    "Credentials are stored in plain text at ~/.mud-agent/config.json.",
    "Do NOT sync ~/.mud-agent/ to cloud storage (iCloud/Dropbox etc.).",
    "Do NOT paste config.json content into public chats or AI sessions.",
  ].join("\n");
}

export function registerMudCommand(api: OpenClawPluginApi): void {
  if (typeof api?.registerCommand !== "function") return;

  api.registerCommand({
    name: "mud",
    description: "MUD game control",
    acceptsArgs: true,
    requireAuth: false,
    handler: async (ctx: OpenClawCommandContext) => {
      const sessionKey = resolveSessionKey(ctx);
      const store = getMudSessionStore();
      const argsStr = typeof ctx.args === "string" ? (ctx.args as string).trim() : "";
      const args = argsStr ? argsStr.split(/\s+/) : [];
      const action = args[0] || "help";

      if (action === "help") return { text: helpText() };

      if (action === "where") {
        return {
          text: `SessionKey: ${sessionKey}\nSessionDir: ${resolveSessionDir(store, sessionKey)}\nStorageRoot: ${store.getStorageRoot()}`,
        };
      }

      if (action === "reset") {
        const dir = resolveSessionDir(store, sessionKey);
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
        return { text: "OK: session data cleared" };
      }

      // 只读 / 只发信号的子命令不注册会话：目录存在就是模型路由的门控，一次 /mud status 不能把话题永久变成 MUD 会话。
      if (action === "status") {
        const dir = resolveSessionDir(store, sessionKey);
        return { text: `Daemon: ${isProcessRunning(path.join(dir, "mud-daemon.pid")) ? "running" : "stopped"}` };
      }

      if (action === "stop") {
        const dir = resolveSessionDir(store, sessionKey);
        // 先联停 autopilot：daemon 已经意外死掉时只写 control.json 没人消费，autopilot 会一直按旧状态排队
        const apid = signalAutopilotStop(dir);
        const sessionControlFile = path.join(dir, "control.json");
        const stopPayload = JSON.stringify({ action: "stop" });
        try {
          fs.writeFileSync(sessionControlFile, stopPayload);
        } catch {}
        // Broadcast to flat root too: supports legacy Claude Code CLI mode
        // (mud-ctl.js flat layout where daemon watches ~/.mud-agent/control.json directly)
        const flatControlFile = path.join(getMudSessionStore().getStorageRoot(), "control.json");
        try {
          fs.writeFileSync(flatControlFile, stopPayload);
        } catch {}
        return { text: apid ? `OK: stop signal sent (autopilot PID ${apid} signalled too)` : "OK: stop signal sent" };
      }

      // 只有 /mud start 注册会话，且先校验请求再注册：host:port 格式错误或既无参数也无已有配置时不建目录，
      // 否则这个失败的话题会被永久当成 MUD 会话（目录存在即注册）。/mud mode 对未初始化的话题直接报错。
      if (action === "start") {
        const hostPort = args[1];
        if (hostPort) {
          const [host, port] = hostPort.split(":");
          if (!host || parseTcpPort(port) === null)
            return {
              text: "ERROR: format should be host:port (port 1-65535)  e.g. /mud start mud.pkuxkx.net:8081 utf8",
            };
        } else if (!fs.existsSync(path.join(resolveSessionDir(store, sessionKey), "config.json"))) {
          return { text: "ERROR: no server configured. Use /mud start host:port [encoding]" };
        }
        // 已注册且目录在：不再 ensure()；首次注册 / 目录丢失走异步锁（同步锁会在网关里 Atomics.wait，
        // 与正在 launchDaemon() 内持锁等 PID 的另一个 start 互相卡住）
        if (!store.get(sessionKey) || !fs.existsSync(resolveSessionDir(store, sessionKey))) {
          await store.ensureAsync(sessionKey);
        }
      }
      const dir = resolveSessionDir(store, sessionKey);
      if (!fs.existsSync(dir)) {
        return { text: "ERROR: this topic has no MUD session yet. Run /mud start host:port first." };
      }

      if (action === "start") {
        saveNotifyTargetFromCommandContext(dir, ctx);
        const hostPort = args[1];
        const encoding = args[2] || "utf8";
        const configFile = path.join(dir, "config.json");

        let serverStr = "existing config";
        if (hostPort) {
          const [host, port] = hostPort.split(":") as [string, string];
          const tcpPort = parseTcpPort(port) as number;
          // 保留已有的 loginSequence，避免重新 start 时把登录步骤清空
          let existingLoginSequence: unknown[] = [];
          try {
            const existing = JSON.parse(fs.readFileSync(configFile, "utf8"));
            if (Array.isArray(existing?.loginSequence)) {
              existingLoginSequence = existing.loginSequence;
            }
          } catch {}
          const cfg = {
            server: { host, port: tcpPort, encoding },
            credentials: { username: "", password: "" },
            loginSequence: existingLoginSequence,
          };
          fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2));
          serverStr = `${host}:${port} (${encoding})`;
        } else if (!fs.existsSync(configFile)) {
          return { text: "ERROR: no server configured. Use /mud start host:port [encoding]" };
        } else {
          try {
            const cfg = JSON.parse(fs.readFileSync(configFile, "utf8"));
            serverStr = `${cfg.server.host}:${cfg.server.port} (${cfg.server.encoding})`;
          } catch {}
        }

        const pidFile = path.join(dir, "mud-daemon.pid");
        // 身份核对（记录带启动时刻时与 OS 报告一致才算活）：崩溃遗留、号码被复用的记录不会让 start 误报"已在运行"
        const runningPid = isProcessRunning(pidFile);
        if (runningPid) {
          const pid = runningPid;
          const auto = ["semi-auto", "full-auto"].includes(readGameModeRecord(dir)?.mode ?? "");
          if (auto) respawnAutopilotWhenDaemonReady(store.getStorageRoot(), dir);
          const note = auto
            ? "\nAutomatic mode is set; the autopilot will be restored if missing (see autopilot.log)."
            : "";
          return { text: `OK: daemon already running (PID ${pid})${note}` };
        }

        const daemonScript = path.resolve(__dirname, "../../dist/cli/daemon-entry.js");
        const launched = await launchDaemon(store.getStorageRoot(), dir, daemonScript);
        if (!launched.ok) return { text: `ERROR: ${launched.reason}` };
        if (launched.alreadyRunning) return { text: `OK: daemon already running (PID ${launched.pid})` };
        const child = { pid: launched.pid };
        const confirmNote = launched.confirmed ? "" : "\nDaemon PID was not confirmed within 10 s; check /mud status.";
        const willRespawn = ["semi-auto", "full-auto"].includes(readGameModeRecord(dir)?.mode ?? "");
        if (willRespawn) respawnAutopilotWhenDaemonReady(store.getStorageRoot(), dir);
        const respawnNote = willRespawn
          ? "\nAutomatic mode is set; the autopilot will be restored once the daemon is up (see autopilot.log)."
          : "";

        return {
          text: `OK: MUD daemon started (PID ${child.pid})${confirmNote}${respawnNote}\nServer: ${serverStr}\n\nTell AI: "show me the current game screen" to begin.\n\n⚠️  Credentials are saved in plain text (~/.mud-agent/config.json). Do not sync this directory to cloud storage.`,
        };
      }

      if (action === "mode") {
        saveNotifyTargetFromCommandContext(dir, ctx);
        const modeArg = args[1];
        const styleArg = args[2] || "exploration";

        const validModes = ["companion", "semi-auto", "full-auto"];
        const validStyles = ["exploration", "grinding"];

        if (!modeArg || !validModes.includes(modeArg)) {
          return {
            text: [
              "ERROR: invalid mode. Usage: /mud mode <companion|semi-auto|full-auto> [exploration|grinding]",
              "",
              "-- Game Modes --",
              "/mud mode companion              Companion mode — play together, AI narrates (default)",
              "/mud mode semi-auto [style]      Autopilot explores, pauses at key events for your decision",
              "/mud mode full-auto [style]      Autopilot runs fully, only critical notifications",
              "  style: exploration (default) | grinding",
            ].join("\n"),
          };
        }

        if (styleArg && !validStyles.includes(styleArg)) {
          return { text: `ERROR: invalid style "${styleArg}". Use: exploration | grinding` };
        }

        // daemon 没在跑时不能落自动模式：autopilot 会立即退出，模式文件却显示自动。
        if (modeArg !== "companion" && !isProcessRunning(path.join(dir, "mud-daemon.pid"))) {
          return {
            text: "ERROR: daemon is not running. Start it (and log in) first, then switch to semi-auto / full-auto.",
          };
        }

        // 写 game-mode.json（带代际）；写之前先记下边界时刻，晚于它的 stop（并发的 companion 请求）不会被当成遗留物清掉。
        const launchTs = Date.now();
        // 模式与 autopilot 配置在同一把锁内一起提交：并发的两个 set-mode 不会出现"新模式 + 旧配置"
        const noticeTypes = ["rare_item", "boss", "puzzle", "level_up"];
        const autopilotConfigData =
          modeArg === "companion"
            ? undefined
            : { style: styleArg, pauseOn: modeArg === "semi-auto" ? noticeTypes : [], notifyOn: noticeTypes }; // 全自动不暂停，但 boss / 稀有物品仍要播报
        const modeGeneration = writeGameMode(dir, modeArg as GameMode, autopilotConfigData);

        if (modeArg === "companion") {
          // 切到陪伴模式：向 autopilot 发停止信号，记下所属模式代际
          const autopilotControlFile = path.join(dir, "autopilot-control.json");
          try {
            writeStopSignal(autopilotControlFile, { modeGeneration });
          } catch {}
          return { text: "OK: switched to companion mode. Autopilot stop signal sent. You are now in control." };
        }

        // semi-auto 或 full-auto：配置已随模式一起落盘，按需启动 autopilot
        // 检查 autopilot 是否已在运行
        const autopilotRunning = isProcessRunning(path.join(dir, "autopilot.pid")) !== null;

        if (!autopilotRunning) {
          if (readGameModeRecord(dir)?.generation !== modeGeneration) {
            return { text: "WARN: mode was rewritten by a newer set-mode; autopilot not started by this request." };
          }
          const launched = await launchAutopilotAsync(store.getStorageRoot(), dir, launchTs);
          if (!launched.ok) {
            return {
              text: `WARN: switched to ${modeArg} mode (style: ${styleArg}) but autopilot did not start: ${launched.reason}`,
            };
          }
          return {
            text: `OK: switched to ${modeArg} mode (style: ${styleArg}). Autopilot started (PID ${launched.pid}).`,
          };
        }

        return {
          text: `OK: switched to ${modeArg} mode (style: ${styleArg}). Autopilot is already running.`,
        };
      }

      return { text: helpText() };
    },
  });
}
