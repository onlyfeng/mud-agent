import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { MudAdminParams, MudConfig, OpenClawPluginApi } from "../core/types";
import { resolveSessionDir } from "../lib/session-key";
import { getMudSessionStore } from "../storage/session-store";

export function registerMudAdminTool(api: OpenClawPluginApi): void {
  if (typeof api?.registerTool !== "function") return;

  api.registerTool({
    name: "mud_admin",
    description: "管理 MUD 守护进程和配置（启动、停止、配置服务器）",
    parameters: {
      type: "object",
      properties: {
        sessionKey: { type: "string" },
        action: { type: "string", enum: ["start", "stop", "setup", "login-step"] },
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

      return { content: [{ type: "text", text: "❌ 未知操作" }] };
    },
  });
}
