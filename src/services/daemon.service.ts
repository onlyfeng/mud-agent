/**
 * MUD TCP 连接守护进程主循环。
 * 从 scripts/mud-daemon.js 迁移为 TypeScript。
 */

import fs from "node:fs";
import net from "node:net";
import { decode, encode, stripAnsi } from "../core/encoding.js";
import { detectLoginAction } from "../core/login-handler.js";
import { isLogNoiseLine } from "../core/noise-filter.js";
import { liveSampleGate, resetRuntimeState } from "../core/state-parser.js";
import { checkTriggers } from "../core/triggers.js";
import type { Alert, GameState, MudConfig, MudPaths, ShutdownReason } from "../core/types.js";
import { writeStopSignal } from "../infra/control-signal.js";
import { appendOutput, loadJSON, writeJSON } from "../infra/file-store.js";
import { Logger } from "../infra/logger.js";
import { acquirePidLock, isProcessRunning, removePid } from "../infra/process-guard.js";
import { type QueueItem, readQueueFile, withQueueLock, writeQueueFile } from "../infra/send-queue.js";

export interface DaemonOptions {
  paths: MudPaths;
}

// ── 防空转常量 ──────────────────────────────────────────────────
const MAX_RECONNECT = 10;
const BASE_DELAY = 15_000;
const MAX_DELAY = 300_000;
const IDLE_TIMEOUT = 30 * 60 * 1000; // 30 分钟
const EMPTY_CRED_GRACE = 60_000; // 60 秒
// 队列文件里每个请求的派发时刻按时间保留：调用方（mud_act）最长等待远小于这个窗口，窗口内的记录不会因为并发请求多而被挤掉；
// 条数上限只是极端情况下的体积保护
const DRAIN_RECORD_TTL_MS = 10 * 60 * 1000;
const DRAIN_HISTORY_HARD_CAP = 2000;

// ── 登录延迟常量 ─────────────────────────────────────────────
const LOGIN_CUSTOM_DELAY = 200; // loginSequence 自定义步骤（服务端等待窗口较短）
const LOGIN_FIELD_DELAY = 800; // 标准用户名/密码字段（留出服务端处理时间）

// ── 关机 Alert 定义 ──────────────────────────────────────────
const SHUTDOWN_ALERT_MAP: Partial<
  Record<ShutdownReason, { label: string; advice: string; priority: Alert["priority"] }>
> = {
  "reconnect-limit": {
    label: "连接已断开：重连次数达到上限，请通过 mud_admin start 重新启动",
    advice: "调用 mud_admin start 重新连接，或检查服务器是否正常。",
    priority: "critical",
  },
  "empty-credentials": {
    label: "守护进程已停止：未配置凭据，请先 mud_admin setup",
    advice: "调用 mud_admin setup 配置用户名、密码，然后再 mud_admin start。",
    priority: "high",
  },
  "idle-timeout": {
    label: "守护进程已停止：30 分钟无活动自动关闭",
    advice: "调用 mud_admin start 重新连接。",
    priority: "normal",
  },
};

export function startDaemon(opts: DaemonOptions): void {
  const { paths } = opts;

  // 目录不在就是被 normalize:sessions 迁移/归档了（派生方在维护锁内已确认过它存在）：拒绝启动，不能把旧路径重建出来
  if (!fs.existsSync(paths.root)) {
    console.error(`[daemon] 会话目录不存在（${paths.root}），可能已被迁移/归档，拒绝启动。`);
    process.exit(1);
  }

  if (!acquirePidLock(paths.pid)) {
    console.error("[daemon] 另一个 daemon 已在运行（PID 锁获取失败），拒绝启动。");
    process.exit(1);
  }

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
  let loginActionPending = false;
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
  let hasLiveHp = false; // 本进程是否已从服务器输出解析到血量（边沿触发器基线）

  let state: Partial<GameState> = resetRuntimeState(
    loadJSON(paths.state, {
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
    }),
  );

  function saveState(): void {
    writeJSON(paths.state, { ...state, lastSeen: new Date().toISOString() });
  }
  // 上一个进程被 SIGKILL / 掉电留下的 connected=true/loginDone=true 要立即落盘：
  // 否则连上之前切到自动模式，autopilot 会读到旧登录状态跳过 waitForLogin，在本次登录完成前就往队列发游戏命令。
  saveState();

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.log("WARN", "30 分钟无活动，自动关闭");
      gracefulShutdown("idle-timeout");
    }, IDLE_TIMEOUT);
  }

  // 上限不可信（未知 / 陈旧）时由 daemon 自己发画像里的状态查询（陪伴模式没有 autopilot 也要刷新），最多每 20 s 一次。
  // 由排水定时器每 500 ms 调用一次：服务器静默时保鲜期到了也能刷新、查询丢包也能重试，不依赖下一批输出
  function drainQueue(socket: net.Socket, enc: string): void {
    // 读-清-记在队列锁内完成：生产者（mud_act / mud_send / autopilot）同样在锁内读改写，谁也不会用旧快照覆盖对方。
    // 锁被占超过超时（生产者进程被挂起、文件系统卡顿）只是可重试的延迟：跳过本次排水，下一个周期再来，不能让它变成崩溃退出。
    let toSend: QueueItem[];
    try {
      toSend = withQueueLock(paths.queue, () => {
        const queue = readQueueFile(paths.queue);
        if (queue.items.length === 0) return [];
        // 先清队列并记下派发时刻（在 socket.write 之前）：mud_act 用它做响应读取游标，
        // 否则快速服务器在 mud_act 下一次轮询前返回的响应会被当成“派发前”的环境消息过滤掉。
        // 每个请求（按入队时刻）单独记一份：两批命令在调用方轮询前先后排水时，前一批不能拿到后一批的时刻。
        const drainedAt = new Date().toISOString();
        const cutoff = Date.parse(drainedAt) - DRAIN_RECORD_TTL_MS;
        const drains = Object.fromEntries(
          Object.entries(queue.drains ?? {})
            .filter(([, at]) => {
              const t = Date.parse(at);
              return Number.isNaN(t) || t >= cutoff;
            })
            .slice(-DRAIN_HISTORY_HARD_CAP),
        );
        // 同一毫秒入队的两个 mud_act 请求 time 相同：按请求 id 记派发时刻，没有 id 的（mud_send / CLI）退回 time
        for (const item of queue.items) {
          const key = item.id ?? item.time;
          if (key) drains[key] = drainedAt;
        }
        writeQueueFile(paths.queue, { items: [], drainedAt, drains });
        return queue.items;
      });
    } catch (error) {
      logger.log("WARN", `队列锁暂不可用，本次跳过排水：${(error as Error).message}`);
      return;
    }
    if (toSend.length === 0) return;

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
    // 新连接的首份状态不能拿旧连接的低血状态做边沿基线，否则断线重连后仍低血会被 true → true 吃掉。
    hasLiveHp = false;
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
        if (!isLogNoiseLine(l)) logger.log("GAME", l);
      }
      // 边沿基线只用本进程观测到的实时血量：登录横幅等不含血量的首批输出不能拿上次运行持久化的快照制造假告警，
      // 首批带血量的样本也不能拿旧快照做基线（重启后仍低血会被 true → true 吃掉）。
      const gate = liveSampleGate(lines, state, hasLiveHp);
      state = gate.state;
      hasLiveHp = gate.hasLiveHp;
      saveState();

      const alerts = loadJSON<Alert[]>(paths.alerts, []);
      const result = checkTriggers(lines, gate.triggerState, alerts, gate.prevState, {
        firstLiveSample: gate.hasLiveHp && gate.prevState === undefined,
      });
      if (result.changed) {
        writeJSON(paths.alerts, result.alerts);
        for (const a of result.alerts.filter((x) => !alerts.some((old) => old.time === x.time))) {
          logger.log("TRIGGER", a.label);
        }
      }

      if (!loginDone && cfg && !loginActionPending) {
        const action = detectLoginAction(lines, cfg, lastLoginField);
        if (action.type === "send" && action.value && sock) {
          const loginValue = action.value;
          lastLoginField = action.field;
          loginActionPending = true;
          const delay = action.field === "custom" ? LOGIN_CUSTOM_DELAY : LOGIN_FIELD_DELAY;
          setTimeout(() => {
            loginActionPending = false;
            logger.log("LOGIN", `发送 ${action.field}`);
            sock?.write(encode(loginValue, encoding));
          }, delay);
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
      loginActionPending = false;
      state.connected = false;
      // 持久化的 loginDone 也要清：否则重连后先写入 connected=true 时 autopilot 会把上次连接的 loginDone 当成本次已登录。
      state.loginDone = false;
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

  function writeShutdownAlert(reason: ShutdownReason): void {
    const def = SHUTDOWN_ALERT_MAP[reason];
    if (!def) return;

    const newAlert: Alert = {
      id: `shutdown-${reason}-${Date.now()}`,
      priority: def.priority,
      label: def.label,
      advice: def.advice,
      context: `shutdownReason=${reason}`,
      time: new Date().toISOString(),
      read: false,
    };

    const alerts = loadJSON<Alert[]>(paths.alerts, []);
    alerts.push(newAlert);
    writeJSON(paths.alerts, alerts);
    logger.log("WARN", `Alert written: ${def.label}`);
  }

  function gracefulShutdown(reason: ShutdownReason): void {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.log("INFO", `Shutting down: ${reason}`);

    // 在关机前写入 alert 通知（仅限异常原因）
    try {
      writeShutdownAlert(reason);
    } catch {}

    // 写入关机原因到 state.json（try-catch 防 uncaughtException 路径下的二次异常）
    state.connected = false;
    state.loginDone = false;
    state.shutdownReason = reason;
    state.shutdownAt = new Date().toISOString();
    try {
      saveState();
    } catch {}

    // 联停 autopilot：只在 autopilot 确实在跑时写 stop 信号，让它下轮循环退出，
    // 不用等 disconnectGraceSec 超时。没有 autopilot 时不能留下 stop 文件，
    // 否则下次切 semi-auto / full-auto 新起的 autopilot 首轮就会被它退出。
    try {
      if (isProcessRunning(paths.autopilotPid)) {
        writeStopSignal(paths.autopilotControl, { force: true });
      } else {
        fs.rmSync(paths.autopilotControl, { force: true });
      }
    } catch {}

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
    process.exit(reason === "crash" ? 1 : 0);
  }

  process.on("SIGTERM", () => gracefulShutdown("signal"));
  process.on("SIGINT", () => gracefulShutdown("signal"));
  process.on("uncaughtException", (err) => {
    try {
      logger.log("ERROR", `uncaughtException: ${err.message}\n${err.stack ?? ""}`);
    } catch {}
    gracefulShutdown("crash");
  });
  process.on("unhandledRejection", (reason) => {
    logger.log("ERROR", `unhandledRejection: ${reason}`);
    gracefulShutdown("crash");
  });

  logger.log("INFO", `MUD Daemon 启动 (PID ${process.pid})`);
  connect();
}
