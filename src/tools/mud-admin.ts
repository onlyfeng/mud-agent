import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AutopilotConfig, GameMode, MudAdminParams, MudConfig, OpenClawPluginApi } from "../core/types.js";
import { launchAutopilotAsync, respawnAutopilotWhenDaemonReady } from "../infra/autopilot-launcher.js";
import { readGameModeRecord, signalAutopilotStop, writeGameMode, writeStopSignal } from "../infra/control-signal.js";
import { launchDaemon } from "../infra/daemon-launcher.js";
import { isProcessRunning } from "../infra/process-guard.js";
import { withQueueLock, writeQueueFile } from "../infra/send-queue.js";
import { ensureNotifyTargetFromSessionKey } from "../lib/notify-target.js";
import { resolveSessionDir } from "../lib/session-key.js";
import { parseTcpPort } from "../lib/tcp-port.js";
import { getMudSessionStore } from "../storage/session-store.js";

// ESM 下 __dirname 不是全局变量，但 @types/node 把它登记为全局声明，
// 所以 tsc / biome / vitest 都不会抱怨；真跑到 spawn 路径上才会
// ReferenceError。必须显式从 import.meta.url 解出一份。
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
      // 只有 setup 注册会话，且先校验参数再注册；其他动作对未初始化的键不建目录（目录存在即被模型路由视为 MUD 会话）
      if (params.action === "setup") {
        if (!params.setupArgs?.host || parseTcpPort(params.setupArgs?.port) === null) {
          return { content: [{ type: "text", text: "❌ setup 缺少 host 或 port（1-65535）" }] };
        }
        // 已注册且目录在：不再 ensure()；首次注册走异步锁（同步锁会在网关里 Atomics.wait，与正在 launchDaemon 内持锁的 start 互相卡住）
        if (!store.get(params.sessionKey) || !fs.existsSync(resolveSessionDir(store, params.sessionKey))) {
          await store.ensureAsync(params.sessionKey);
        }
      }
      const dir = resolveSessionDir(store, params.sessionKey);
      if (!fs.existsSync(dir)) {
        return { content: [{ type: "text", text: "❌ 该会话尚未初始化：请先调 setup（host/port）再执行其他操作" }] };
      }
      ensureNotifyTargetFromSessionKey(dir, params.sessionKey);
      ensureNotifyTargetFromSessionKey(dir, path.basename(dir));

      const pidFile = path.join(dir, "mud-daemon.pid");
      const controlFile = path.join(dir, "control.json");
      const configFile = path.join(dir, "config.json");

      // 身份核对（记录带启动时刻时与 OS 报告一致才算活）：崩溃遗留、号码被复用的记录不算在运行
      const isDaemonRunning = () => isProcessRunning(pidFile);

      if (params.action === "setup" && params.setupArgs) {
        const setupArgs = params.setupArgs;
        // Merge 模式：先读现有 config，每个字段传入值优先，否则保留旧值，最后才用默认值
        let existing: Partial<MudConfig> = {};
        try {
          existing = JSON.parse(fs.readFileSync(configFile, "utf8"));
        } catch {}

        const cfg: MudConfig = {
          server: {
            host: setupArgs.host,
            port: parseTcpPort(setupArgs.port) as number,
            encoding: setupArgs.encoding || existing.server?.encoding || "gbk",
          },
          credentials: {
            username: setupArgs.username ?? existing.credentials?.username ?? "",
            password: setupArgs.password ?? existing.credentials?.password ?? "",
          },
          loginSequence: Array.isArray(existing.loginSequence) ? existing.loginSequence : [],
        };
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
        // 队列文件走同一把队列锁并在锁内复查：existsSync 与写入之间另一个进程可能刚入队，无锁覆盖会丢命令
        const queueFile = path.join(dir, "send-queue.json");
        withQueueLock(queueFile, () => {
          if (!fs.existsSync(queueFile)) writeQueueFile(queueFile, { items: [] });
        });
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
          // daemon 还在、自动模式的 autopilot 却崩了/被杀了（或正在消费联停信号）：交给轮询恢复器
          const auto = ["semi-auto", "full-auto"].includes(readGameModeRecord(dir)?.mode ?? "");
          if (auto) respawnAutopilotWhenDaemonReady(store.getStorageRoot(), dir);
          const note = auto ? "\n模式为自动，如无 autopilot 会自动恢复（见 autopilot.log）" : "";
          return { content: [{ type: "text", text: `✅ 守护进程已在运行 (PID ${pid})${note}` }] };
        }
        if (!fs.existsSync(configFile)) {
          return { content: [{ type: "text", text: "❌ 未配置服务器，请先调 setup" }] };
        }

        const daemonScript = path.resolve(__dirname, "../../dist/cli/daemon-entry.js");
        const launched = await launchDaemon(store.getStorageRoot(), dir, daemonScript);
        if (!launched.ok) return { content: [{ type: "text", text: `❌ ${launched.reason}` }] };
        if (launched.alreadyRunning) {
          return { content: [{ type: "text", text: `✅ 守护进程已在运行 (PID ${launched.pid})` }] };
        }
        const child = { pid: launched.pid };
        const confirmNote = launched.confirmed ? "" : "\n⚠️ 10 s 内未确认到守护进程 PID，请用 status 查看";
        // 模式文件仍是自动（上次 daemon 停机联停了 autopilot）：等 daemon pid 就绪后恢复 autopilot，结果记在 autopilot.log
        const willRespawn = ["semi-auto", "full-auto"].includes(readGameModeRecord(dir)?.mode ?? "");
        if (willRespawn) respawnAutopilotWhenDaemonReady(store.getStorageRoot(), dir);
        const respawnNote = willRespawn ? "\n模式为自动，daemon 就绪后会自动恢复 autopilot（见 autopilot.log）" : "";

        return {
          content: [
            {
              type: "text",
              text: `✅ 守护进程已启动 (PID ${child.pid})${confirmNote}\n等待连接... (几秒后可用 mud_read 查看)${respawnNote}`,
            },
          ],
        };
      }

      if (params.action === "stop") {
        const pid = isDaemonRunning();
        // 联停 autopilot（不管 daemon 是否在跑，autopilot 可能残留）
        signalAutopilotStop(dir);

        if (!pid) return { content: [{ type: "text", text: "守护进程未运行（autopilot 已发送停止信号）" }] };

        fs.writeFileSync(controlFile, JSON.stringify({ action: "stop" }));

        return { content: [{ type: "text", text: "✅ 停止指令已发送，守护进程和 autopilot 即将退出" }] };
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
        // daemon 没在跑时不能落自动模式：autopilot 会立即退出，模式文件却显示自动，之后起 daemon 也没人重新派生。
        if (modeArg !== "companion" && !isDaemonRunning()) {
          return {
            content: [
              {
                type: "text",
                text: "❌ 守护进程未运行，不能切到自动模式；请先 start 并登录，再 set-mode semi-auto / full-auto。",
              },
            ],
          };
        }
        // 本次 set-mode 的任何写入之前先记下时刻：早于它的 stop 一定是上一个进程遗留的，
        // 晚于它的（并发的 set-mode companion）是有效请求，清理时不动，子进程也以此为清理边界。
        const launchTs = Date.now();

        // semi-auto / full-auto 的 autopilot 配置与模式在同一把锁内一起提交（并发 set-mode 不会交叉覆盖）
        const autopilotCfg: AutopilotConfig | undefined =
          modeArg === "companion"
            ? undefined
            : {
                style: styleArg === "grinding" ? "grinding" : "exploration",
                loopInterval: 3500,
                reportInterval: 4,
                safetyBoundary: { minHpPercent: 30, autoFlee: true, avoidCombatWith: [] },
                pauseOn: modeArg === "full-auto" ? [] : ["rare_item", "boss", "puzzle", "level_up"],
                notifyOn: ["rare_item", "boss", "puzzle", "level_up"], // 全自动不暂停，但 boss / 稀有物品仍要播报
                autoPickup: true,
                combatEnabled: false,
              };
        // 写入游戏模式（带代际）；companion 的 stop 记下这个代际，后来的 set-mode 切回自动时 autopilot 才能判断 stop 已被取代。
        const modeGeneration = writeGameMode(dir, modeArg, autopilotCfg);

        if (modeArg === "companion") {
          // 停止 autopilot（若运行中）
          try {
            writeStopSignal(path.join(dir, "autopilot-control.json"), { modeGeneration });
          } catch {}
          return { content: [{ type: "text", text: "✅ 已切换到陪伴模式（autopilot 停止信号已发送）" }] };
        }

        // semi-auto / full-auto：配置已随模式一起落盘，按需启动 autopilot
        // 检查 autopilot 是否已在运行
        const autopilotRunning = isProcessRunning(path.join(dir, "autopilot.pid")) !== null;

        if (!autopilotRunning) {
          // 模式文件已被并发的 set-mode 改写（代际不是我们写的）：那次请求更新，由它决定要不要 autopilot，这里不再派生。
          if (readGameModeRecord(dir)?.generation !== modeGeneration) {
            return { content: [{ type: "text", text: "⚠️ 模式已被更新的 set-mode 改写，本次未启动 autopilot。" }] };
          }
          const launched = await launchAutopilotAsync(store.getStorageRoot(), dir, launchTs);
          const modeLabel = modeArg === "semi-auto" ? "半自动" : "全自动";
          if (!launched.ok) {
            return {
              content: [
                {
                  type: "text",
                  text: `⚠️ 已切换到${modeLabel}模式（${styleArg}），但 autopilot 未启动：${launched.reason}`,
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `✅ 已切换到${modeLabel}模式（${styleArg}），autopilot 已启动 (PID ${launched.pid})`,
              },
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
