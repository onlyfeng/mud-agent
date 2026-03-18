/**
 * MUD TCP 连接守护进程主循环。
 * 从 scripts/mud-daemon.js 迁移为 TypeScript。
 */

import fs from "node:fs";
import net from "node:net";
import { decode, encode, stripAnsi } from "../core/encoding";
import { detectLoginAction } from "../core/login-handler";
import { parseState } from "../core/state-parser";
import { checkTriggers } from "../core/triggers";
import type { Alert, GameState, MudConfig, MudPaths } from "../core/types";
import { appendOutput, loadJSON, writeJSON } from "../infra/file-store";
import { Logger } from "../infra/logger";
import { removePid, writePid } from "../infra/process-guard";

export interface DaemonOptions {
  paths: MudPaths;
}

// ── 防空转常量 ──────────────────────────────────────────────────
const MAX_RECONNECT = 10;
const BASE_DELAY = 15_000;
const MAX_DELAY = 300_000;
const IDLE_TIMEOUT = 30 * 60 * 1000; // 30 分钟
const EMPTY_CRED_GRACE = 60_000; // 60 秒

export function startDaemon(opts: DaemonOptions): void {
  const { paths } = opts;

  fs.mkdirSync(paths.root, { recursive: true });
  writePid(paths.pid);

  const heartbeatFile = paths.heartbeat;
  const heartbeatInterval = setInterval(() => {
    try {
      fs.writeFileSync(heartbeatFile, new Date().toISOString());
    } catch {}
  }, 30000);
  // Write initial heartbeat
  try {
    fs.writeFileSync(heartbeatFile, new Date().toISOString());
  } catch {}

  const logger = new Logger(paths.log);

  let sock: net.Socket | null = null;
  let connected = false;
  let loginDone = false;
  let lastLoginField: string | undefined;
  let rawBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let rawBufTimer: ReturnType<typeof setTimeout> | null = null;
  let queueInterval: ReturnType<typeof setInterval> | null = null;
  let controlInterval: ReturnType<typeof setInterval> | null = null;

  // ── 防空转状态 ──────────────────────────────────────────────────
  let reconnectCount = 0;
  let shuttingDown = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let emptyCredTimer: ReturnType<typeof setTimeout> | null = null;
  let wasLoggedIn = false; // 本次连接是否登录成功过

  let state: Partial<GameState> = loadJSON(paths.state, {
    connected: false,
    loginDone: false,
    hp: null,
    maxHp: null,
    mp: null,
    maxMp: null,
    level: null,
    gold: null,
    exits: [],
    location: "",
    lastSeen: null,
  });

  function saveState(): void {
    writeJSON(paths.state, { ...state, lastSeen: new Date().toISOString() });
  }

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.log("WARN", "30 分钟无活动，自动关闭");
      gracefulShutdown("idle-timeout");
    }, IDLE_TIMEOUT);
  }

  function drainQueue(socket: net.Socket, enc: string): void {
    const queue = loadJSON<{ items: Array<{ cmd?: string }> }>(paths.queue, {
      items: [],
    });
    if (!queue.items || queue.items.length === 0) return;

    const toSend = queue.items;
    writeJSON(paths.queue, { items: [] });

    for (const item of toSend) {
      const cmd = item.cmd;
      if (!cmd) continue;
      logger.log("SEND", `> ${cmd}`);
      socket.write(encode(`${cmd}\n`, enc));
    }

    // 用户通过 AI 发送了命令 → 清除空凭据定时器 + 重置空闲计时
    if (emptyCredTimer) {
      clearTimeout(emptyCredTimer);
      emptyCredTimer = null;
    }
    if (loginDone) {
      resetIdleTimer();
    }
    // 记录队列活动时间
    state.lastQueueActivity = new Date().toISOString();
    saveState();
  }

  function connect(): void {
    const cfg = loadJSON<MudConfig | null>(paths.config, null);
    if (!cfg) {
      logger.log("ERROR", "未找到配置文件");
      process.exit(1);
    }

    const { host, port, encoding = "utf8" } = cfg.server;
    const credentials = cfg.credentials || { username: "", password: "" };
    const loginSequence = cfg.loginSequence || [];

    logger.log("INFO", `连接 ${host}:${port} (${encoding})...`);

    wasLoggedIn = false;
    // 清除上一轮连接可能残留的空凭据定时器
    if (emptyCredTimer) {
      clearTimeout(emptyCredTimer);
      emptyCredTimer = null;
    }
    sock = new net.Socket();
    sock.connect(port, host, () => {
      connected = true;
      state.connected = true;
      saveState();
      logger.log("INFO", "已连接");
      appendOutput(paths.output, [`[系统] 已连接到 ${host}:${port}`]);

      if (!queueInterval) {
        queueInterval = setInterval(() => {
          if (sock && connected) drainQueue(sock, encoding);
        }, 500);
      }

      // ── 2b: 空凭据空转检测 ──────────────────────────────────────
      if (!credentials.username && !credentials.password && loginSequence.length === 0) {
        logger.log("WARN", "空凭据且无 loginSequence，60 秒后若未登录将自动停止");
        emptyCredTimer = setTimeout(() => {
          if (!loginDone) {
            logger.log("WARN", "空凭据 60 秒仍未登录，自动关闭");
            gracefulShutdown("empty-credentials");
          }
        }, EMPTY_CRED_GRACE);
      }
    });

    function flushLines(lines: string[]): void {
      if (!lines.length) return;
      appendOutput(paths.output, lines);
      for (const l of lines) {
        process.stdout.write(`\x1b[90m${l}\x1b[0m\n`);
      }
      state = parseState(lines, state);
      saveState();

      const alerts = loadJSON<Alert[]>(paths.alerts, []);
      const result = checkTriggers(lines, state, alerts);
      if (result.changed) {
        writeJSON(paths.alerts, result.alerts);
        for (const a of result.alerts.filter((x) => !alerts.some((old) => old.time === x.time))) {
          logger.log("TRIGGER", a.label);
        }
      }

      if (!loginDone && cfg) {
        const action = detectLoginAction(lines, cfg, lastLoginField);
        if (action.type === "send" && action.value && sock) {
          const loginValue = action.value;
          lastLoginField = action.field;
          setTimeout(() => {
            logger.log("LOGIN", `发送 ${action.field}`);
            sock?.write(encode(loginValue, encoding));
          }, 800);
        } else if (action.type === "success") {
          loginDone = true;
          wasLoggedIn = true;
          state.loginDone = true;
          saveState();
          logger.log("INFO", "登录成功");
          appendOutput(paths.output, ["[系统] 登录成功，开始游戏！"]);
          // 登录成功 → 重置重连计数 + 清除空凭据定时器 + 启动空闲计时
          reconnectCount = 0;
          if (emptyCredTimer) {
            clearTimeout(emptyCredTimer);
            emptyCredTimer = null;
          }
          resetIdleTimer();
        }
      }
    }

    function flushRawBuf(): void {
      if (!rawBuf.length) return;
      const text = decode(rawBuf, encoding);
      const line = stripAnsi(text).trimEnd();
      rawBuf = Buffer.alloc(0);
      if (line) flushLines([line]);
    }

    sock.on("data", (chunk) => {
      if (rawBufTimer) {
        clearTimeout(rawBufTimer);
        rawBufTimer = null;
      }

      rawBuf = Buffer.concat([rawBuf, chunk]);
      const text = decode(rawBuf, encoding);
      const stripped = stripAnsi(text);
      const parts = stripped.split("\n");

      const lastLine = parts.pop() || "";
      try {
        rawBuf = encode(lastLine, encoding);
      } catch {
        rawBuf = Buffer.alloc(0);
      }

      flushLines(parts.map((l) => l.trimEnd()).filter(Boolean));

      if (rawBuf.length) {
        rawBufTimer = setTimeout(() => flushRawBuf(), 300);
      }
    });

    sock.on("close", () => {
      if (shuttingDown) return;

      connected = false;
      loginDone = false;
      lastLoginField = undefined;
      state.connected = false;
      saveState();
      if (rawBufTimer) {
        clearTimeout(rawBufTimer);
        rawBufTimer = null;
      }
      rawBuf = Buffer.alloc(0);

      if (wasLoggedIn) {
        reconnectCount = 0;
        wasLoggedIn = false;
      }

      reconnectCount++;
      if (reconnectCount > MAX_RECONNECT) {
        logger.log("ERROR", `重连次数已达上限 (${MAX_RECONNECT})，停止守护进程`);
        appendOutput(paths.output, [`[系统] 重连失败 ${MAX_RECONNECT} 次，守护进程已停止`]);
        gracefulShutdown("reconnect-limit");
        return;
      }

      const delay = Math.min(BASE_DELAY * 2 ** (reconnectCount - 1), MAX_DELAY);
      logger.log("WARN", `连接断开，${Math.round(delay / 1000)}秒后重连 (${reconnectCount}/${MAX_RECONNECT})...`);
      appendOutput(paths.output, [
        `[系统] 连接断开，${Math.round(delay / 1000)}秒后重连 (${reconnectCount}/${MAX_RECONNECT})...`,
      ]);
      setTimeout(connect, delay);
    });

    sock.on("error", (err: Error) => {
      logger.log("ERROR", `Socket: ${err.message}`);
    });
  }

  // 控制指令监听
  controlInterval = setInterval(() => {
    const ctrl = loadJSON<{ action?: string } | null>(paths.control, null);
    if (!ctrl) return;
    try {
      fs.unlinkSync(paths.control);
    } catch {}

    if (ctrl.action === "stop") {
      logger.log("INFO", "收到停止指令，退出");
      gracefulShutdown("control-stop");
    }
    if (ctrl.action === "reconnect" && sock) {
      sock.destroy();
    }
  }, 1000);

  function gracefulShutdown(reason: string): void {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.log("INFO", `Shutting down: ${reason}`);

    // 写入关机原因到 state.json
    state.connected = false;
    state.loginDone = false;
    state.shutdownReason = reason;
    state.shutdownAt = new Date().toISOString();
    saveState();

    if (sock) {
      try {
        sock.destroy();
      } catch {}
    }
    if (queueInterval) clearInterval(queueInterval);
    if (controlInterval) clearInterval(controlInterval);
    clearInterval(heartbeatInterval);
    if (idleTimer) clearTimeout(idleTimer);
    if (emptyCredTimer) clearTimeout(emptyCredTimer);
    if (rawBufTimer) clearTimeout(rawBufTimer);
    try {
      fs.unlinkSync(heartbeatFile);
    } catch {}
    removePid(paths.pid);
    logger.close();
    process.exit(0);
  }

  process.on("SIGTERM", () => gracefulShutdown("signal"));
  process.on("SIGINT", () => gracefulShutdown("signal"));

  logger.log("INFO", `MUD Daemon 启动 (PID ${process.pid})`);
  connect();
}
