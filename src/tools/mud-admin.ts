import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AutopilotConfig, GameMode, MudAdminParams, MudConfig, OpenClawPluginApi } from "../core/types.js";
import { resolveSessionDir } from "../lib/session-key.js";
import { getMudSessionStore } from "../storage/session-store.js";

export function registerMudAdminTool(api: OpenClawPluginApi): void {
  if (typeof api?.registerTool !== "function") return;

  api.registerTool({
    name: "mud_admin",
    description: "管理 MUD 守护进程和配置（启动、停止、配置服务器）",
    parameters: {
      type: "object",
      properties: {
        sessionKey: { type: "string" },
        action: { type: "string", enum: ["start", "stop", "setup", "login-step", "set-mode"] },
        setupArgs: {
          type: "object",
          properties: {
            host: { type: "string" },
            port: { type: "number" },
            encoding: { type: "string" },
            username: { type: "string" },
            password: { type: "string" },
          },
        },
        loginStepArgs: {
          type: "object",
          properties: {
            trigger: { type: "string" },
            send: { type: "string" },
          },
        },
        setModeArgs: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["companion", "semi-auto", "full-auto"] },
            style: { type: "string", enum: ["exploration", "grinding"] },
          },
          required: ["mode"],
        },
      },
      required: ["sessionKey", "action"],
    },
    async execute(_id: string, raw: Record<string, unknown>) {
      const params = raw as unknown as MudAdminParams;
      const store = getMudSessionStore();
      const dir = resolveSessionDir(store, params.sessionKey);

      const pidFile = path.join(dir, "mud-daemon.pid");
      const controlFile = path.join(dir, "control.json");
      const configFile = path.join(dir, "config.json");

      function isDaemonRunning() {
        try {
          const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
          process.kill(pid, 0);
          return pid;
        } catch {
          return null;
        }
      }

      if (params.action === "setup") {
        if (!params.setupArgs?.host || !params.setupArgs?.port) {
          return { content: [{ type: "text", text: "❌ setup 缺少 host 或 port" }] };
        }
        // Merge 模式：先读现有 config，每个字段传入值优先，否则保留旧值，最后才用默认值
        let existing: Partial<MudConfig> = {};
        try {
          existing = JSON.parse(fs.readFileSync(configFile, "utf8"));
        } catch {}

        const cfg: MudConfig = {
          server: {
            host: params.setupArgs.host,
            port: params.setupArgs.port,
            encoding: params.setupArgs.encoding || existing.server?.encoding || "gbk",
          },
          credentials: {
            username: params.setupArgs.username ?? existing.credentials?.username ?? "",
            password: params.setupArgs.password ?? existing.credentials?.password ?? "",
          },
          loginSequence: Array.isArray(existing.loginSequence) ? existing.loginSequence : [],
        };
        store.ensure(params.sessionKey);
        fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2));
        // 仅在文件不存在时初始化，避免覆盖已有数据
        const initIfMissing = (file: string, content: string) => {
          if (!fs.existsSync(file)) {
            try {
              fs.writeFileSync(file, content);
            } catch {}
          }
        };
        initIfMissing(path.join(dir, "output.jsonl"), "");
        initIfMissing(path.join(dir, "alerts.json"), "[]");
        initIfMissing(path.join(dir, "send-queue.json"), '{"items":[]}');
        initIfMissing(path.join(dir, "state.json"), "{}");

        return {
          content: [
            {
              type: "text",
              text: `✅ 配置已保存\n服务器: ${cfg.server.host}:${cfg.server.port}\n编码: ${cfg.server.encoding}\n角色: ${cfg.credentials.username || "(未设置)"}`,
            },
          ],
        };
      }

      if (params.action === "login-step") {
        let cfg: MudConfig;
        try {
          cfg = JSON.parse(fs.readFileSync(configFile, "utf8"));
        } catch {
          return { content: [{ type: "text", text: "❌ 尚未配置服务器，请先 setup" }] };
        }
        cfg.loginSequence = cfg.loginSequence || [];
        if (params.loginStepArgs?.trigger && params.loginStepArgs?.send) {
          cfg.loginSequence.push({ trigger: params.loginStepArgs.trigger, send: params.loginStepArgs.send });
          fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2));
          return {
            content: [
              {
                type: "text",
                text: `✅ 添加登录步骤成功: 当检测到 "${params.loginStepArgs.trigger}" 时发送 "${params.loginStepArgs.send}"`,
              },
            ],
          };
        }
        return { content: [{ type: "text", text: "❌ 参数不完整" }] };
      }

      if (params.action === "start") {
        const pid = isDaemonRunning();
        if (pid) {
          return { content: [{ type: "text", text: `✅ 守护进程已在运行 (PID ${pid})` }] };
        }
        if (!fs.existsSync(configFile)) {
          return { content: [{ type: "text", text: "❌ 未配置服务器，请先调 setup" }] };
        }

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
          content: [
            { type: "text", text: `✅ 守护进程已启动 (PID ${child.pid})\n等待连接... (几秒后可用 mud_read 查看)` },
          ],
        };
      }

      if (params.action === "stop") {
        const pid = isDaemonRunning();
        if (!pid) return { content: [{ type: "text", text: "守护进程未运行" }] };

        fs.writeFileSync(controlFile, JSON.stringify({ action: "stop" }));

        return { content: [{ type: "text", text: "✅ 停止指令已发送，守护进程即将退出" }] };
      }

      if (params.action === "set-mode") {
        const modeArg = params.setModeArgs?.mode as GameMode | undefined;
        const validModes: GameMode[] = ["companion", "semi-auto", "full-auto"];
        if (!modeArg || !validModes.includes(modeArg)) {
          return {
            content: [{ type: "text", text: "❌ set-mode 缺少有效的 mode 参数（companion / semi-auto / full-auto）" }],
          };
        }
        const styleArg = params.setModeArgs?.style || "exploration";

        // 写入游戏模式
        fs.writeFileSync(path.join(dir, "game-mode.json"), JSON.stringify({ mode: modeArg }, null, 2));

        if (modeArg === "companion") {
          // 停止 autopilot（若运行中）
          try {
            fs.writeFileSync(path.join(dir, "autopilot-control.json"), JSON.stringify({ action: "stop" }));
          } catch {}
          return { content: [{ type: "text", text: "✅ 已切换到陪伴模式（autopilot 停止信号已发送）" }] };
        }

        // semi-auto / full-auto：写 autopilot 配置并启动
        const autopilotCfg: AutopilotConfig = {
          style: styleArg === "grinding" ? "grinding" : "exploration",
          loopInterval: 3500,
          reportInterval: 4,
          safetyBoundary: { minHpPercent: 30, autoFlee: true, avoidCombatWith: [] },
          pauseOn: modeArg === "full-auto" ? [] : ["rare_item", "boss", "puzzle", "level_up"],
          autoPickup: true,
          combatEnabled: false,
        };
        fs.writeFileSync(path.join(dir, "autopilot-config.json"), JSON.stringify(autopilotCfg, null, 2));

        // 检查 autopilot 是否已在运行
        const autopilotPidFile = path.join(dir, "autopilot.pid");
        let autopilotRunning = false;
        try {
          const apid = parseInt(fs.readFileSync(autopilotPidFile, "utf8").trim(), 10);
          process.kill(apid, 0);
          autopilotRunning = true;
        } catch {}

        if (!autopilotRunning) {
          const autopilotScript = path.resolve(__dirname, "../../dist/cli/autopilot-entry.js");
          const logFile = path.join(dir, "autopilot.log");
          const out = fs.openSync(logFile, "a");
          const child = spawn("node", [autopilotScript], {
            detached: true,
            stdio: ["ignore", out, out],
            env: { ...process.env, MUD_DIR: dir },
          });
          child.unref();
          fs.closeSync(out);
          const modeLabel = modeArg === "semi-auto" ? "半自动" : "全自动";
          return {
            content: [
              { type: "text", text: `✅ 已切换到${modeLabel}模式（${styleArg}），autopilot 已启动 (PID ${child.pid})` },
            ],
          };
        }

        const modeLabel = modeArg === "semi-auto" ? "半自动" : "全自动";
        return {
          content: [{ type: "text", text: `✅ 已切换到${modeLabel}模式（${styleArg}），autopilot 已在运行中` }],
        };
      }

      return { content: [{ type: "text", text: "❌ 未知操作" }] };
    },
  });
}
