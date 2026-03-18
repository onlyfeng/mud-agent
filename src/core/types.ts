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
  shutdownReason?: string | null;
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
}

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
  mode: "semi-auto" | "full-auto";
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

// ─── OpenClaw 插件 API（外部类型声明）─────────────────────────

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
}

export interface OpenClawCommandDefinition {
  name: string;
  description: string;
  acceptsArgs: boolean;
  requireAuth: boolean;
  handler: (ctx: OpenClawCommandContext) => Promise<{ text: string }>;
}

export interface OpenClawCommandContext {
  args: string;
  sessionKey?: string;
  [key: string]: unknown;
}

export interface OpenClawToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
}

export interface OpenClawPluginApi {
  config?: {
    plugins?: {
      entries?: Record<string, { config?: Record<string, unknown> }>;
    };
  };
  registerCommand?(def: OpenClawCommandDefinition): void;
  registerTool?(def: OpenClawToolDefinition): void;
  on?(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
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
  action: "start" | "stop" | "setup" | "login-step";
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
}
