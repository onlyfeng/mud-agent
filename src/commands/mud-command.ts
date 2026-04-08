import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { OpenClawCommandContext, OpenClawPluginApi } from "../core/types.js";
import { resolveSessionKey } from "../lib/session-key.js";
import { getMudSessionStore } from "../storage/session-store.js";

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
        return { text: `SessionKey: ${sessionKey}\nStorageRoot: ${store.getStorageRoot()}` };
      }

      if (action === "reset") {
        const dir = store.getSessionDataDir(sessionKey);
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
        return { text: "OK: session data cleared" };
      }

      store.ensure(sessionKey);
      const dir = store.getSessionDataDir(sessionKey);

      if (action === "start") {
        const hostPort = args[1];
        const encoding = args[2] || "utf8";
        const configFile = path.join(dir, "config.json");

        let serverStr = "existing config";
        if (hostPort) {
          const [host, port] = hostPort.split(":");
          if (!host || !port)
            return { text: "ERROR: format should be host:port  e.g. /mud start mud.pkuxkx.net:8081 utf8" };
          // 保留已有的 loginSequence，避免重新 start 时把登录步骤清空
          let existingLoginSequence: unknown[] = [];
          try {
            const existing = JSON.parse(fs.readFileSync(configFile, "utf8"));
            if (Array.isArray(existing?.loginSequence)) {
              existingLoginSequence = existing.loginSequence;
            }
          } catch {}
          const cfg = {
            server: { host, port: parseInt(port, 10), encoding },
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
        try {
          const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
          process.kill(pid, 0);
          return { text: `OK: daemon already running (PID ${pid})` };
        } catch {}

        const daemonScript = path.resolve(__dirname, "../../dist/cli/daemon-entry.js");
        const logFile = path.join(dir, "daemon.log");
        const out = fs.openSync(logFile, "a");
        const child = spawn("node", [daemonScript], {
          detached: true,
          stdio: ["ignore", out, out],
          env: { ...process.env, MUD_DIR: dir },
        });
        child.unref();
        fs.closeSync(out);

        return {
          text: `OK: MUD daemon started (PID ${child.pid})\nServer: ${serverStr}\n\nTell AI: "show me the current game screen" to begin.\n\n⚠️  Credentials are saved in plain text (~/.mud-agent/config.json). Do not sync this directory to cloud storage.`,
        };
      }

      if (action === "status") {
        const pidFile = path.join(dir, "mud-daemon.pid");
        let pidRunning = false;
        try {
          const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
          process.kill(pid, 0);
          pidRunning = true;
        } catch {}
        return { text: `Daemon: ${pidRunning ? "running" : "stopped"}` };
      }

      if (action === "stop") {
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
        return { text: "OK: stop signal sent" };
      }

      if (action === "mode") {
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

        // 写 game-mode.json
        const gameModeFile = path.join(dir, "game-mode.json");
        fs.writeFileSync(gameModeFile, JSON.stringify({ mode: modeArg }, null, 2));

        if (modeArg === "companion") {
          // 切到陪伴模式：向 autopilot 发停止信号
          const autopilotControlFile = path.join(dir, "autopilot-control.json");
          try {
            fs.writeFileSync(autopilotControlFile, JSON.stringify({ action: "stop" }));
          } catch {}
          return { text: "OK: switched to companion mode. Autopilot stop signal sent. You are now in control." };
        }

        // semi-auto 或 full-auto：写 autopilot-config.json，按需启动 autopilot
        const pauseOn = modeArg === "semi-auto" ? ["rare_item", "boss", "puzzle", "level_up"] : [];
        const autopilotConfigData = {
          style: styleArg,
          pauseOn,
        };
        const autopilotConfigFile = path.join(dir, "autopilot-config.json");
        fs.writeFileSync(autopilotConfigFile, JSON.stringify(autopilotConfigData, null, 2));

        // 检查 autopilot 是否已在运行
        const autopilotPidFile = path.join(dir, "autopilot.pid");
        let autopilotRunning = false;
        try {
          const pid = parseInt(fs.readFileSync(autopilotPidFile, "utf8").trim(), 10);
          process.kill(pid, 0);
          autopilotRunning = true;
        } catch {}

        if (!autopilotRunning) {
          const autopilotScript = path.resolve(__dirname, "../../dist/cli/autopilot-entry.js");
          const autopilotLogFile = path.join(dir, "autopilot.log");
          const out = fs.openSync(autopilotLogFile, "a");
          const child = spawn("node", [autopilotScript], {
            detached: true,
            stdio: ["ignore", out, out],
            env: { ...process.env, MUD_DIR: dir },
          });
          child.unref();
          fs.closeSync(out);
          return {
            text: `OK: switched to ${modeArg} mode (style: ${styleArg}). Autopilot started (PID ${child.pid}).`,
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
