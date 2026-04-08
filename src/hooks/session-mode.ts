import fs from "node:fs";
import path from "node:path";
import type { Alert, GameMode, GameState, OpenClawPluginApi } from "../core/types.js";
import { resolveSessionDir, resolveSessionKey } from "../lib/session-key.js";
import { getMudSessionStore } from "../storage/session-store.js";

/**
 * 读取游戏模式（从 game-mode.json），默认返回 "companion"。
 */
function readGameMode(dir: string): GameMode {
  try {
    const obj = JSON.parse(fs.readFileSync(path.join(dir, "game-mode.json"), "utf8"));
    if (["companion", "semi-auto", "full-auto"].includes(obj.mode)) return obj.mode as GameMode;
  } catch {}
  return "companion";
}

/**
 * 陪伴模式上下文：用户主导，AI 翻译+叙事，严格暂停规则。
 */
function buildCompanionContext(sessionKey: string, serverLine: string): string {
  return [
    "当前会话处于 MUD 游戏模式【陪伴模式】。",
    `【当前会话标识】sessionKey = "${sessionKey}"  ← 调用所有 mud_* 工具时必须传此值，禁止使用其他值或凭记忆猜测。`,
    serverLine
      ? `【已配置服务器】${serverLine}  ← 本 Topic 绑定的服务器，重启守护进程时无需重新 setup，直接 start 即可。`
      : "【已配置服务器】尚未配置（请先调 mud_admin setup 并提供服务器地址、编码、账号密码）。",
    "",
    "═══════════════════════════════════════════",
    "⛔ 核心约束（违反将导致用户消息永久丢失）",
    "═══════════════════════════════════════════",
    "规则 A — 严禁文字与工具调用同条消息：",
    "  ❌ 错误：输出「好的，我来试试：」+ 立即调用工具  ← 平台不等用户，直接继续",
    "  ✅ 正确：先调工具，拿到结果后，单独输出一条纯文字消息给用户",
    "规则 B — 每 2 次工具调用后必须暂停：",
    "  执行任意 2 次工具调用后，必须输出一条【纯文字消息（不含任何工具调用）】告知用户进度，然后停止，等用户确认是否继续。",
    "  只有纯文字消息才会触发平台暂停，把控制权还给用户。",
    "规则 C — 收到用户消息时立即切换任务：",
    "  若当前消息包含 [Queued messages] 或有多条排队指令，优先响应用户最新指令，放弃或暂停之前的计划。不要继续执行旧任务。",
    "═══════════════════════════════════════════",
    "",
    "你是一个智能的 MUD 游戏客户端代理，把用户的自然语言翻译为 MUD 命令，并将生涩的游戏输出转换为生动的叙事。",
    "【/mud 斜杠命令（已由平台处理，AI 不要重复执行）】",
    "用户可通过以下斜杠命令直接管理 daemon，这些命令由平台即时处理，AI 收到时它们已经生效：",
    "  /mud start [host:port] [enc] — 写入 config 并启动 daemon（服务器地址、端口、编码已写入 config.json）",
    "  /mud stop                    — 停止 daemon",
    "  /mud status                  — 查看 daemon 状态",
    "  /mud reset                   — 清除全部会话数据",
    "  /mud mode <companion|semi-auto|full-auto> [style] — 切换游戏模式",
    "核心原则：这些命令反映用户的明确意图，AI 必须尊重结果，不得反向操作。",
    "  ✅ /mud start 后：配置已完成，禁止再调 mud_admin setup 修改服务器地址/端口/编码（除非用户明确说「换服务器」）。",
    "  ✅ /mud stop 后：用户主动停止，禁止调 mud_admin start 重启。只需确认「已停止」，等用户下一步指令。",
    "  ✅ /mud reset 后：用户主动清除数据，禁止调 mud_admin setup/start 重建会话。只需确认「已清除」，等用户重新配置。",
    "  ✅ /mud status 后：仅转述状态信息，不要根据状态主动执行修复动作（如重启、重连、重新配置）。",
    "",
    "【工具使用原则】",
    "1. 所有游戏动作（移动、攻击、对话、捡物、look 等）优先调用 mud_act —— 它一次完成「发送 + 等待 + 读取响应」。",
    "2. 只在需要读取历史输出时才单独调用 mud_read。",
    "3. 角色快照（HP/MP/位置/出口）已自动注入在本提示末尾，无需主动调 mud_status。仅在用户询问详细状态或快照显示有未读警报时才调。",
    "4. 不要把原始游戏文本块直接展示，用叙事口吻重新表述。",
    "5. 遇到命令失败，说出备选操作，询问用户如何继续。",
    "6. 不要擅自修改【已配置服务器】中显示的服务器信息，那是用户通过 /mud start 指定的。",
    "【场景节奏】",
    "- 长途移动：每走 2 步，输出纯文字「当前在 XX，继续前进吗？」，等用户确认。",
    "- 发送 chat/say 后：立即输出纯文字「已发出，等待回复」，不要继续轮询 read。",
    "- 连续 2 次找不到目标：停止搜索，告知用户现状，询问下一步。",
    "【下线规则】",
    "- 用户说下线/离开/退出/结束/不玩了/关掉 → 必须调 mud_admin stop，然后告知已停止",
    "- 用户说挂机/保持连接 → 不停止，提醒 30 分钟无操作会自动断开",
    "- 未经用户明确确认，不要让 daemon 长期空转",
    "【游戏存档】",
    "游戏进度笔记（地图、角色状态、上次目标等）保存在 ~/.mud-agent/saves/ 下，按服务器命名，如 xiyouji-game-log.md。",
    "新会话开始时若用户未主动说明进度，可读取对应存档快速恢复上下文；游戏结束时应将新进展追加写入存档。",
    "【模式切换】",
    "你可以通过调用 mud_admin set-mode 主动切换游戏模式，识别以下自然语言触发词：",
    '- 「帮我挂机」「去自动探索」「你来玩」「自动探索吧」→ mud_admin { action:"set-mode", setModeArgs:{ mode:"semi-auto", style:"exploration" } }',
    '- 「挂机打怪」「一直打就行」「刷怪挂机」→ mud_admin { action:"set-mode", setModeArgs:{ mode:"full-auto", style:"grinding" } }',
    '- 「全自动探索」「完全自动」→ mud_admin { action:"set-mode", setModeArgs:{ mode:"full-auto", style:"exploration" } }',
  ].join("\n");
}

/**
 * 半自动模式上下文：autopilot 后台跑，AI 监控 decisions，响应用户提问。
 */
function buildSemiAutoContext(sessionKey: string, serverLine: string): string {
  return [
    "当前会话处于 MUD 游戏模式【半自动模式】。",
    `【当前会话标识】sessionKey = "${sessionKey}"  ← 调用所有 mud_* 工具时必须传此值，禁止使用其他值或凭记忆猜测。`,
    serverLine
      ? `【已配置服务器】${serverLine}  ← 本 Topic 绑定的服务器。`
      : "【已配置服务器】尚未配置（请先调 mud_admin setup 并提供服务器地址、编码、账号密码）。",
    "",
    "autopilot 进程正在后台自主探索游戏，你不需要逐条驱动游戏命令。",
    "",
    "【AI 职责】",
    "1. 检查 decisions.json 里是否有待处理的决策（可调 mud_read 或 mud_status），如有则告知用户等待决策。",
    "2. 响应用户直接提问（如「在哪」「血量多少」等），可调 mud_status/mud_read 获取信息后回答。",
    "3. 用户想切回自己操控时，说明可用 /mud mode companion 切换回陪伴模式。",
    "4. 用户想切到全自动时，说明可用 /mud mode full-auto 切换。",
    "",
    "═══════════════════════════════════════════",
    "⛔ 核心约束",
    "═══════════════════════════════════════════",
    "规则 A — 严禁文字与工具调用同条消息：",
    "  ❌ 错误：输出「好的，我来查看：」+ 立即调用工具  ← 平台不等用户，直接继续",
    "  ✅ 正确：先调工具，拿到结果后，单独输出一条纯文字消息给用户",
    "规则 C — 收到用户消息时立即切换任务：",
    "  若当前消息包含 [Queued messages] 或有多条排队指令，优先响应用户最新指令。",
    "═══════════════════════════════════════════",
    "",
    "【下线规则】",
    "- 用户说下线/离开/退出/结束/不玩了/关掉 → 必须调 mud_admin stop，然后告知已停止",
    "- 用户说挂机/保持连接 → 不停止，提醒 autopilot 正在运行",
    "- 未经用户明确确认，不要停止 autopilot 或 daemon",
    "【模式切换】",
    '- 「我来玩」「我自己来」「陪我玩」「停止自动」→ mud_admin { action:"set-mode", setModeArgs:{ mode:"companion" } }',
    '- 「全自动」「不用汇报了」「完全自动跑」→ mud_admin { action:"set-mode", setModeArgs:{ mode:"full-auto" } }',
  ].join("\n");
}

/**
 * 全自动模式上下文：autopilot 完全自主，AI 基本不调工具，只答用户问题。
 */
function buildFullAutoContext(sessionKey: string, serverLine: string): string {
  return [
    "当前会话处于 MUD 游戏模式【全自动模式】。",
    `【当前会话标识】sessionKey = "${sessionKey}"  ← 调用所有 mud_* 工具时必须传此值，禁止使用其他值或凭记忆猜测。`,
    serverLine
      ? `【已配置服务器】${serverLine}  ← 本 Topic 绑定的服务器。`
      : "【已配置服务器】尚未配置（请先调 mud_admin setup 并提供服务器地址、编码、账号密码）。",
    "",
    "autopilot 完全自主运行，不写决策点，只在紧急情况（血量危急等）发送系统通知。",
    "",
    "【AI 职责】",
    "1. 不主动调用任何工具，不干预 autopilot 运行。",
    "2. 用户提问时（如「现在在哪」「血量多少」），可调 mud_status/mud_read 回答，回答后停止。",
    "3. 用户想介入时，说明可用 /mud mode companion 切回陪伴模式，或 /mud mode semi-auto 切到半自动模式。",
    "",
    "【规则】",
    "- 无工具调用次数限制，但非必要不调工具。",
    "- 严禁文字与工具调用同条消息（规则 A）。",
    "",
    "【下线规则】",
    "- 用户说下线/离开/退出/结束/不玩了/关掉 → 必须调 mud_admin stop，然后告知已停止",
    "- 用户说挂机/保持连接 → 不停止，提醒全自动模式正在运行",
    "【模式切换】",
    '- 「我来玩」「暂停挂机」「陪我玩」→ mud_admin { action:"set-mode", setModeArgs:{ mode:"companion" } }',
    '- 「半自动」「需要汇报」「遇到好东西告诉我」→ mud_admin { action:"set-mode", setModeArgs:{ mode:"semi-auto" } }',
  ].join("\n");
}

/**
 * 解析数据目录：优先 sessions/<key>/，兼容长短格式 key，不存在时回退到 storageRoot。
 */
function resolveDataDir(sessionKey: string): string {
  const store = getMudSessionStore();
  const dir = resolveSessionDir(store, sessionKey);
  // 若 resolveSessionDir 返回的目录存在，直接用；否则回退到 storageRoot（兼容 mud-ctl.js 直写模式）
  if (fs.existsSync(dir)) return dir;
  return store.getStorageRoot();
}

/**
 * 判断 MUD 守护进程是否在运行（读 PID 文件）。
 * 用于代替 session.mode 检查，兼容仅使用 mud-ctl.js shell 工作流的情况。
 */
function isDaemonRunning(sessionKey: string): boolean {
  const dir = resolveDataDir(sessionKey);
  try {
    const pid = parseInt(fs.readFileSync(path.join(dir, "mud-daemon.pid"), "utf8").trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取 state.json + alerts.json，生成一行紧凑的角色快照。
 * 注入到系统提示末尾，替代 AI 每轮主动调 mud_status 的需求。
 */
/**
 * 从 config.json 读取服务器信息，返回单行描述（供 buildMudSystemContext 和 buildStatusSnapshot 使用）。
 */
function readServerLine(dir: string): string {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    const user = cfg.credentials?.username ? ` 角色:${cfg.credentials.username}` : "";
    return `${cfg.server.host}:${cfg.server.port} (${cfg.server.encoding})${user}`;
  } catch {
    return "";
  }
}

function buildStatusSnapshot(sessionKey: string): { snapshot: string; serverLine: string } {
  const dir = resolveDataDir(sessionKey);

  const serverLine = readServerLine(dir);

  let state: Partial<GameState> = {};
  try {
    state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  } catch {}

  let unread = 0;
  try {
    const alerts: Alert[] = JSON.parse(fs.readFileSync(path.join(dir, "alerts.json"), "utf8"));
    unread = alerts.filter((a) => !a.read).length;
  } catch {}

  const parts: string[] = [];
  if (state.hp != null) {
    const pct = state.maxHp ? Math.round((state.hp / state.maxHp) * 100) : "?";
    parts.push(`HP ${state.hp}/${state.maxHp ?? "?"}(${pct}%)`);
  }
  if (state.mp != null) parts.push(`MP ${state.mp}/${state.maxMp ?? "?"}`);
  if (state.location) parts.push(`位置:${state.location}`);
  if (state.exits?.length) parts.push(`出口:${state.exits.join(" ")}`);
  if (unread > 0) parts.push(`未读警报 ${unread} 条`);

  const snapshot = parts.length ? `\n【角色快照】${parts.join(" | ")}` : "";
  return { snapshot, serverLine };
}

const SESSIONS_DIR = path.join(process.env.HOME || "", ".openclaw", "agents", "main", "sessions");
const TOOL_CALL_HARD_LIMIT_COMPANION = 3; // 陪伴模式：连续超过此数量 tool call 无用户消息时注入强制停止
const TOOL_CALL_HARD_LIMIT_SEMI_AUTO = 8; // 半自动模式：安全网但宽松

/**
 * 读取当前 topic 的 openclaw session log，
 * 统计最近连续 tool call（assistant toolCall 或 toolResult）轮数，
 * 中间没有 user 消息则计入。超过阈值返回 true。
 * lookback 扩大到 200 行以覆盖长链。
 */
function isToolCallChainTooLong(sessionKey: string, limit: number): boolean {
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return false;
    const suffix = `-${sessionKey}.jsonl`;
    const files = fs
      .readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith(suffix) && !f.includes(".reset."))
      .map((f) => ({ f, mtime: fs.statSync(path.join(SESSIONS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return false;

    const logPath = path.join(SESSIONS_DIR, files[0].f);
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);

    let toolCount = 0;
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 200); i--) {
      try {
        const obj = JSON.parse(lines[i]);
        const role = obj?.message?.role ?? "";
        if (role === "user") break;
        if (role === "toolResult") {
          toolCount++;
          continue;
        }
        if (role === "assistant") {
          const content: Array<Record<string, unknown>> = obj?.message?.content ?? [];
          const hasTool = content.some((c) => c?.type === "toolCall");
          if (hasTool) {
            toolCount++;
            continue;
          }
          if (content.some((c) => c?.type === "text" && typeof c.text === "string" && c.text.trim())) {
            toolCount = 0;
            break;
          }
        }
      } catch {
        /* skip */
      }
    }
    return toolCount >= limit;
  } catch {
    return false;
  }
}

/**
 * 检查当前 topic 最新的 user 消息是否包含排队消息（[Queued messages while agent was busy]）。
 * 返回排队消息条数（0 = 无排队）。
 */
function countQueuedMessages(sessionKey: string): number {
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return 0;
    const suffix = `-${sessionKey}.jsonl`;
    const files = fs
      .readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith(suffix) && !f.includes(".reset."))
      .map((f) => ({ f, mtime: fs.statSync(path.join(SESSIONS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return 0;

    const logPath = path.join(SESSIONS_DIR, files[0].f);
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);

    // 从末尾找最近一条 user 消息
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj?.message?.role !== "user") continue;
        const content = obj?.message?.content ?? [];
        const allText = (Array.isArray(content) ? content : [])
          .filter((c: Record<string, unknown>) => c?.type === "text")
          .map((c: Record<string, unknown>) => String(c.text ?? ""))
          .join("\n");
        if (!allText.includes("Queued messages while agent was busy")) return 0;
        // 计数 "Queued #N" 出现次数
        const matches = allText.match(/Queued #\d+/g);
        return matches ? matches.length : 1;
      } catch {
        /* skip */
      }
    }
    return 0;
  } catch {
    return 0;
  }
}

export function registerSessionModeHook(api: OpenClawPluginApi): void {
  if (typeof api?.on !== "function") return;

  api.on("before_prompt_build", (event: unknown, ctx: unknown) => {
    const ctxRecord = (ctx ?? {}) as Record<string, unknown>;

    const ocKey = typeof ctxRecord.sessionKey === "string" && ctxRecord.sessionKey ? ctxRecord.sessionKey : null;
    const derivedKey = resolveSessionKey({ ...ctxRecord, event });

    // Gate 1：零侵入门控
    // session 目录由 /mud start 调用 store.ensure() 创建，不存在则此 Topic 从未激活 MUD。
    // 未激活的 Topic 直接返回，不做任何 MUD 相关检查，对普通对话完全透明。
    // resolveSessionDir 内部有 Map 缓存，同一 Topic 后续调用为 O(1)。
    const store = getMudSessionStore();
    const keyToCheck = ocKey ?? derivedKey;
    if (!fs.existsSync(resolveSessionDir(store, keyToCheck))) return;

    // Gate 2：daemon 运行门控
    // 只在 daemon 确实运行时才注入 MUD 上下文，游戏停止后立即恢复干净对话。
    const sessionKey =
      (ocKey && isDaemonRunning(ocKey) ? ocKey : null) ?? (isDaemonRunning(derivedKey) ? derivedKey : null);

    if (!sessionKey) return;

    const { snapshot, serverLine } = buildStatusSnapshot(sessionKey);
    const dataDir = resolveDataDir(sessionKey);
    const gameMode = readGameMode(dataDir);

    let baseContext: string;
    if (gameMode === "full-auto") {
      baseContext = buildFullAutoContext(sessionKey, serverLine) + snapshot;
    } else if (gameMode === "semi-auto") {
      baseContext = buildSemiAutoContext(sessionKey, serverLine) + snapshot;
    } else {
      baseContext = buildCompanionContext(sessionKey, serverLine) + snapshot;
    }

    const appendParts: string[] = [];

    // 检测排队消息：companion 和 semi-auto 模式下注入，full-auto 跳过
    if (gameMode !== "full-auto") {
      const queuedCount = countQueuedMessages(sessionKey);
      if (queuedCount > 0) {
        appendParts.push(
          `\n\n[用户有 ${queuedCount} 条指令在工具链执行期间发送，已排队等候]` +
            " 请立即停止执行旧任务，先输出纯文字告知用户你当前所在位置和状态，然后处理排队的指令。" +
            " 不要在本条回复中调用任何工具。",
        );
      }
    }

    // 连续工具调用超过阈值：companion 用 limit=3，semi-auto 用 limit=8，full-auto 跳过
    if (gameMode === "companion") {
      const chainTooLong = isToolCallChainTooLong(sessionKey, TOOL_CALL_HARD_LIMIT_COMPANION);
      if (chainTooLong) {
        appendParts.push(
          "\n\n[SYSTEM INTERRUPT] You have made " +
            TOOL_CALL_HARD_LIMIT_COMPANION +
            "+ consecutive tool calls without a user reply. " +
            "STOP ALL TOOL CALLS NOW. " +
            "Output ONLY plain text: tell the user your current location and what just happened, then WAIT for their response. " +
            "Do NOT call any tool in this reply.",
        );
      }
    } else if (gameMode === "semi-auto") {
      const chainTooLong = isToolCallChainTooLong(sessionKey, TOOL_CALL_HARD_LIMIT_SEMI_AUTO);
      if (chainTooLong) {
        appendParts.push(
          "\n\n[SYSTEM INTERRUPT] You have made " +
            TOOL_CALL_HARD_LIMIT_SEMI_AUTO +
            "+ consecutive tool calls without a user reply. " +
            "STOP ALL TOOL CALLS NOW. " +
            "Output ONLY plain text: tell the user current status, then WAIT for their response. " +
            "Do NOT call any tool in this reply.",
        );
      }
    }

    if (appendParts.length > 0) {
      return { prependSystemContext: baseContext, appendSystemContext: appendParts.join("") };
    }
    return { prependSystemContext: baseContext };
  });
}
