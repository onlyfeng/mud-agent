// ─── MUD 连接配置 ────────────────────────────────────────────

export interface MudServerConfig {
  host: string;
  port: number;
  encoding: "utf8" | "gbk" | "big5" | (string & {});
}

export interface MudCredentials {
  username: string;
  password: string;
}

export interface LoginStep {
  trigger: string;
  send: string;
}

export interface MudConfig {
  server: MudServerConfig;
  credentials: MudCredentials;
  loginSequence: LoginStep[];
}

// ─── 游戏状态 ────────────────────────────────────────────────

export type ShutdownReason = "reconnect-limit" | "empty-credentials" | "idle-timeout" | "control-stop" | "signal";

export interface GameState {
  connected: boolean;
  loginDone: boolean;
  hp: number | null;
  maxHp: number | null;
  mp: number | null;
  maxMp: number | null;
  level: number | null;
  gold: number | null;
  exits: string[];
  location: string;
  lastSeen: string | null;
  shutdownReason?: ShutdownReason | null;
  shutdownAt?: string | null;
  lastQueueActivity?: string | null;
}

// ─── 警报 ────────────────────────────────────────────────────

export type AlertPriority = "critical" | "high" | "normal" | "low";

export interface TriggerDefinition {
  id: string;
  re?: RegExp;
  checkFn?: (lines: string[], state: GameState) => boolean;
  priority: AlertPriority;
  label: string;
  advice: string;
}

export interface Alert {
  id: string;
  priority: AlertPriority;
  label: string;
  advice: string;
  context: string;
  time: string;
  read: boolean;
}

// ─── 命令队列 / 输出 ─────────────────────────────────────────

export interface QueueItem {
  cmd: string;
  time: string;
}

export interface CommandQueue {
  items: QueueItem[];
}

export interface OutputLine {
  ts: string;
  text: string;
}

// ─── 路径集合 ────────────────────────────────────────────────

export interface MudPaths {
  root: string;
  config: string;
  output: string;
  queue: string;
  state: string;
  alerts: string;
  control: string;
  pid: string;
  heartbeat: string;
  log: string;
  report: string;
  decisions: string;
  autopilotConfig: string;
  autopilotPid: string;
  autopilotControl: string;
  autopilotLog: string;
  gameModeFile: string;
}

// ─── 游戏模式 ────────────────────────────────────────────────

export type GameMode = "companion" | "semi-auto" | "full-auto";

// ─── 会话管理 ────────────────────────────────────────────────

export type SessionMode = "active" | "paused" | "archived";

export interface MudSession {
  sessionKey: string;
  mode: SessionMode;
}

// ─── Autopilot ───────────────────────────────────────────────

export type AutopilotStyle = "exploration" | "grinding";

export interface SafetyBoundary {
  minHpPercent: number;
  autoFlee: boolean;
  avoidCombatWith: string[];
}

export interface AutopilotConfig {
  style: AutopilotStyle;
  loopInterval: number;
  reportInterval: number;
  safetyBoundary: SafetyBoundary;
  pauseOn: string[];
  autoPickup: boolean;
  combatEnabled: boolean;
}

export interface Decision {
  id: string;
  time: string;
  priority: AlertPriority;
  eventType?: string;
  summary: string;
  context: string;
  options: string[];
  resolved: boolean;
  choice: string | null;
  resolvedAt?: string;
}

export interface StrategyAction {
  command: string | null;
  narrative: string | null;
  pauseEvent?: Omit<Decision, "id" | "time" | "resolved" | "choice">;
}

export interface StrategyContext {
  state: GameState;
  newLines: OutputLine[];
  alerts: Alert[];
  config: AutopilotConfig;
}

export interface IStrategy {
  decide(ctx: StrategyContext): StrategyAction;
}

// ─── OpenClaw 插件 API（与 SDK 类型对齐的本地声明）─────────────
// 注意：此处不直接引用 openclaw SDK 包，以保持 CLI 独立可用。
// 类型形态追踪 openclaw@2026.3.24 plugin-sdk/src/plugins/types.d.ts

export interface ToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; source: { type: "url"; url: string } }>;
}

export interface OpenClawCommandContext {
  senderId?: string;
  channel: string;
  channelId?: string;
  isAuthorizedSender: boolean;
  args?: string;
  commandBody: string;
  config: Record<string, unknown>;
  from?: string;
  to?: string;
  accountId?: string;
  messageThreadId?: string | number;
  [key: string]: unknown;
}

export interface OpenClawCommandDefinition {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  requireAuth?: boolean;
  handler: (ctx: OpenClawCommandContext) => Promise<{ text: string }>;
}

export interface OpenClawToolDefinition {
  name: string;
  description: string;
  label?: string;
  parameters: Record<string, unknown>;
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
  ownerOnly?: boolean;
  displaySummary?: string;
}

export interface PluginLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface OpenClawPluginApi {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: string;
  rootDir?: string;
  registrationMode: "full" | "setup-only" | "setup-runtime";
  config: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  runtime: Record<string, unknown>;
  logger: PluginLogger;
  registerCommand: (def: OpenClawCommandDefinition) => void;
  registerTool: (def: OpenClawToolDefinition) => void;
  on: (event: string, handler: (event: unknown, ctx: unknown) => unknown, opts?: { priority?: number }) => void;
  registerHook: (events: string | string[], handler: (...args: unknown[]) => unknown) => void;
  registerService: (service: unknown) => void;
  resolvePath: (input: string) => string;
}

// ─── Tool 参数类型 ───────────────────────────────────────────

export interface MudActParams {
  sessionKey: string;
  commands: string | string[];
  waitMs?: number;
  fallbackLines?: number;
}

export interface MudReadParams {
  sessionKey: string;
  lines?: number;
  since?: string;
}

export interface MudSendParams {
  sessionKey: string;
  commands: string | string[];
}

export interface MudStatusParams {
  sessionKey: string;
}

export interface MudAlertsParams {
  sessionKey: string;
  clear?: boolean;
}

export interface MudAdminParams {
  sessionKey: string;
  action: "start" | "stop" | "setup" | "login-step" | "set-mode";
  setupArgs?: {
    host: string;
    port: number;
    encoding?: string;
    username?: string;
    password?: string;
  };
  loginStepArgs?: {
    trigger: string;
    send: string;
  };
  setModeArgs?: {
    mode: GameMode;
    style?: AutopilotStyle;
  };
}
