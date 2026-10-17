/**
 * 游戏画像（profile）：某一台 MUD 服务器的文本语义——状态行怎么写、出口怎么列、什么算战斗、什么是噪音、
 * 哪些播报是事件、方向词怎么反向。公共核心只认这里定义的接口，不内置任何服务器知识；
 * 具体服务器 / 角色的规则放在运行时目录里，由驾驭模型在实际游戏中观察回包生成、持续迭代：
 *
 *   1. `<会话目录>/profile.json`                 —— 本会话专用（优先）
 *   2. `<存储根>/profiles/<server.host>.json`   —— 同一服务器的所有会话共用（存储根由启动器经 MUD_STORAGE_ROOT 传入，默认 ~/.mud-agent）
 *   3. 内置默认画像（`profiles/example.json` 随包发布，作为示例与回退）
 *
 * 画像文件按"顶层分区 → 字段"两级合并到默认画像上：只写需要改的分区 / 字段即可，数组整体替换。
 * 正则用 JSON 字符串表示：`"pattern"` 或 `{ "pattern": "...", "flags": "i" }`。
 */

import fs from "node:fs";
import path from "node:path";
import type { AlertPriority } from "./types.js";

export type PatternJson = string | { pattern: string; flags?: string };

export interface TriggerJson {
  id: string;
  pattern: PatternJson;
  priority: AlertPriority;
  label: string;
  advice: string;
  /** 离散事件（每次发生都是独立进展：死亡、升级、任务、稀有物品）只抑制几秒内的服务器重发；持续性场景按 id 在 5 分钟窗口内去重。默认 false */
  discrete?: boolean;
}

export interface GameProfileJson {
  /** 画像名称，只用于日志 */
  name?: string;
  status?: {
    /** 刷新状态用的游戏命令（当前血量到了而上限不可信时 autopilot 会发它） */
    query?: string;
    /** 血量：第 1 个捕获组是当前值，第 2 个（可选）是上限；按顺序第一个命中的生效 */
    hp?: PatternJson[];
    mp?: PatternJson[];
    /** 等级（仅展示）：第一个非空捕获组是数值 */
    level?: PatternJson[];
    gold?: PatternJson[];
  };
  exits?: {
    /** 状态解析用的出口行（第 1 个捕获组是出口列表原文） */
    state?: PatternJson[];
    /** look 回包里的出口行（第 1 个捕获组是出口列表原文），同时用于判定"这是房间描述" */
    room?: PatternJson[];
    /** 出口列表的分隔符 */
    splitter?: PatternJson;
  };
  room?: {
    /** 命中其一的短行视为房间名（只分类，不改文本） */
    name?: PatternJson[];
    /** 命中其一的行不是房间名 */
    exclude?: PatternJson[];
    /** 从房间名里剥掉的装饰（如尾部的 ` -`） */
    strip?: PatternJson[];
    maxLength?: number;
  };
  items?: {
    /** 带标记的物品行：第 1 个捕获组是物品文本 */
    marker?: PatternJson[];
    /** 整行就是一件物品 */
    plain?: PatternJson[];
    /** 拾取成功的回包 */
    pickedUp?: PatternJson[];
  };
  combat?: {
    start?: PatternJson[];
    end?: PatternJson[];
  };
  /** 探索策略的事件类型：按顺序逐行匹配，第一个命中的类型生效 */
  events?: { type: string; patterns: PatternJson[] }[];
  /** 文本触发器（告警）；纯数值的血量触发器在核心里，不在这里 */
  triggers?: TriggerJson[];
  noise?: {
    ambientChat?: PatternJson[];
    movement?: PatternJson[];
    /** 命中其一的行是自己移动的回包，不算环境噪音 */
    movementSelf?: PatternJson[];
    emote?: PatternJson[];
    loginPrompt?: PatternJson[];
    /** 紧贴名字后的玩家 / 物品 ASCII id 标注，剥掉后再做触发匹配；第 1 个捕获组是括号内文本 */
    inlineId?: PatternJson;
    /** 括号内文本命中它时保留（本身就是触发关键字） */
    keepAnnotations?: PatternJson;
  };
  directions?: {
    reverse?: Record<string, string>;
    aliases?: string[][];
  };
}

export interface CompiledTrigger {
  id: string;
  re: RegExp;
  priority: AlertPriority;
  label: string;
  advice: string;
  discrete: boolean;
}

export interface GameProfile {
  name: string;
  status: { query: string; hp: RegExp[]; mp: RegExp[]; level: RegExp[]; gold: RegExp[] };
  exits: { state: RegExp[]; room: RegExp[]; splitter: RegExp };
  room: { name: RegExp[]; exclude: RegExp[]; strip: RegExp[]; maxLength: number };
  items: { marker: RegExp[]; plain: RegExp[]; pickedUp: RegExp[] };
  combat: { start: RegExp[]; end: RegExp[] };
  events: { type: string; patterns: RegExp[] }[];
  triggers: CompiledTrigger[];
  noise: {
    ambientChat: RegExp[];
    movement: RegExp[];
    movementSelf: RegExp[];
    emote: RegExp[];
    loginPrompt: RegExp[];
    inlineId: RegExp;
    keepAnnotations: RegExp;
  };
  directions: { reverse: Record<string, string>; aliases: string[][] };
}

/**
 * 内置默认画像：一台中文 LPMud（西游记 / 北大侠客行一族）的写法，随包发布为 `profiles/example.json`。
 * 它是示例，不是"通用 MUD 规则"——换服务器时复制一份按回包改。
 */
export const DEFAULT_PROFILE_JSON: Required<GameProfileJson> = {
  name: "example-cn-lpmud",
  status: {
    query: "hp",
    hp: [
      "[生精体气血][命力量精气]?\\s*[：:]\\s*(\\d+)\\s*[/／]\\s*(\\d+)",
      { pattern: "HP\\s*[：:]\\s*(\\d+)\\s*[/／]\\s*(\\d+)", flags: "i" },
      { pattern: "<\\s*(\\d+)\\s*hp", flags: "i" },
      "生命[值点]?\\s*[：:]\\s*(\\d+)",
    ],
    // 西游记/武侠类：内力是主 MP，法力是法术位资源，两者同屏出现时必须先取内力；没有内力时法力优先，精神兜底
    mp: [
      "内力\\s*[：:]\\s*(\\d+)\\s*[/／]\\s*(\\d+)",
      "内力\\s*[：:]\\s*(\\d+)",
      "[法魔]力\\s*[：:]\\s*(\\d+)\\s*[/／]\\s*(\\d+)",
      { pattern: "MP\\s*[：:]\\s*(\\d+)\\s*[/／]\\s*(\\d+)", flags: "i" },
      "精神\\s*[：:]\\s*(\\d+)\\s*[/／]\\s*(\\d+)",
    ],
    level: [{ pattern: "等级[：:\\s]*(\\d+)|Lv\\.?\\s*(\\d+)|Level\\s*(\\d+)", flags: "i" }],
    gold: [{ pattern: "[银金][币两钱]?\\s*[：:]\\s*(\\d+)|gold[：:\\s]*(\\d+)", flags: "i" }],
  },
  exits: {
    state: [
      "(?:明显的?)?出[口路][：:\\s]+([东南西北上下出入、,，\\s]+)",
      { pattern: "\\[Exits?:\\s*([^\\]]+)\\]", flags: "i" },
    ],
    room: ["这里(?:明显的|唯一的)?出口是\\s+(.+?)[。.]?$"],
    splitter: "[、，,和\\s]+",
  },
  room: {
    name: ["\\s*-\\s*$", "^[\\u4e00-\\u9fa5]{2,10}$"],
    exclude: ["[你我他它]", "[→←↑↓]", "^\\[", "^【"],
    strip: ["\\s*-\\s*$"],
    maxLength: 25,
  },
  items: {
    marker: ["^[□✦◆▶]\\s*(.+?\\([\\w\\s]+\\).*)$"],
    plain: ["^[\\u4e00-\\u9fa5\\w]+\\([\\w\\s]+\\)"],
    pickedUp: ["你捡起"],
  },
  combat: {
    start: [
      "向你的.+发动",
      "往你的.+",
      "打了你一",
      "刺了你一",
      "踢了你一",
      "正在战斗",
      "向你发起",
      "想杀死你",
      "注视着你的行动",
      "准备发动攻势",
    ],
    end: ["死了|被你杀死|你杀死了|逃走了|逃跑了|战斗结束|胜利|倒下了|断气|阵亡"],
  },
  events: [
    { type: "level_up", patterns: ["你升级了|道行境界|武学境界"] },
    { type: "rare_item", patterns: ["稀有|宝贝|天书|神器"] },
    { type: "puzzle", patterns: ["谜题|机关|秘道|暗门"] },
    { type: "boss", patterns: [{ pattern: "首领|妖王|boss|大王|魔王", flags: "i" }] },
  ],
  triggers: [
    {
      id: "death",
      pattern: { pattern: "你死了|你已死亡|你倒下了|you (?:are dead|have died|die\\b)|\\*{3}dead\\*{3}", flags: "i" },
      priority: "critical",
      label: "你死了",
      advice: "角色已死亡！需要找到复活点或等待处理。",
      discrete: true,
    },
    {
      id: "boss",
      pattern: { pattern: "boss|首领|魔王|大妖|龙王|神兽|古神|守护者|boss战|强敌", flags: "i" },
      priority: "high",
      label: "检测到Boss",
      advice: "发现强力敌人！建议做好准备再战。",
    },
    {
      id: "puzzle",
      pattern: { pattern: "谜题|机关|符文|解锁|密码|puzzle|riddle|钥匙.*锁|锁.*需要", flags: "i" },
      priority: "high",
      label: "发现谜题/机关",
      advice: "这里有谜题或机关，需要思考或找线索。",
    },
    {
      id: "level_up",
      pattern: { pattern: "你升级了|恭喜.*升|你现在是.*级|you gain a level|升为", flags: "i" },
      priority: "normal",
      label: "升级了！",
      advice: "恭喜升级！可以查看新属性和技能。",
      discrete: true,
    },
    {
      id: "quest_update",
      pattern: { pattern: "任务完成|完成了任务|任务更新|quest complete|任务.*进度", flags: "i" },
      priority: "normal",
      label: "任务更新",
      advice: "任务有进展，可以查看任务日志。",
      discrete: true,
    },
    {
      id: "rare_item",
      pattern: { pattern: "神器|传说|稀有|极品|legendary|ancient.*weapon|你发现了.*珍贵", flags: "i" },
      priority: "normal",
      label: "发现稀有物品",
      advice: "发现了珍贵物品！",
      discrete: true,
    },
    {
      id: "npc_talk",
      pattern: { pattern: "对你说[：:]|告诉你[：:]|whispers?|says? to you", flags: "i" },
      priority: "low",
      label: "NPC 在说话",
      advice: "NPC 有话说，可能是任务或线索。",
    },
  ],
  noise: {
    ambientChat: ["^【(闲聊|频道|世界|广播|传闻|谣言|江湖|帮派|门派|新手|公告|系统公告)】"],
    movement: [
      "(走了过来|走了过去|跑了过来|跑了过去|往[东南西北上下]{1,2}离开|离开了[。！]?$|来到了这里[。！]?$|从里面走了出来[。！]?$)",
    ],
    movementSelf: ["^你"],
    emote: ["(再吹一声口哨|随之往上冉冉地升起|随之飘去不见了|吹了一声口哨)"],
    loginPrompt: [{ pattern: "(请输入.{0,6}密码|密码[：:]\\s*\\?*\\s*$|password\\s*[:：]?\\s*$)", flags: "i" }],
    // 只剥紧贴在中文名字后面的玩家 ASCII id（示例玩家(BossExample)、七包金创药(Jinchuang yao)）：前面必须是 CJK 字符且没有空格
    inlineId: "(?<=[\\u3400-\\u9fff\\uf900-\\ufaff])\\(([A-Za-z][A-Za-z' -]*)\\)",
    keepAnnotations: { pattern: "^(boss|legendary|epic|rare|unique)$", flags: "i" },
  },
  directions: {
    reverse: {
      north: "south",
      south: "north",
      east: "west",
      west: "east",
      up: "down",
      down: "up",
      northeast: "southwest",
      southwest: "northeast",
      northwest: "southeast",
      southeast: "northwest",
      n: "s",
      s: "n",
      e: "w",
      w: "e",
      u: "d",
      d: "u",
      ne: "sw",
      sw: "ne",
      nw: "se",
      se: "nw",
      北: "南",
      南: "北",
      东: "西",
      西: "东",
      上: "下",
      下: "上",
      东北: "西南",
      西南: "东北",
      西北: "东南",
      东南: "西北",
      in: "out",
      out: "in",
      enter: "out",
      leave: "in",
      exit: "in",
      进: "出",
      出: "进",
      进入: "出去",
      出去: "进入",
    },
    aliases: [
      ["north", "n", "北"],
      ["south", "s", "南"],
      ["east", "e", "东"],
      ["west", "w", "西"],
      ["up", "u", "上"],
      ["down", "d", "下"],
      ["northeast", "ne", "东北"],
      ["southwest", "sw", "西南"],
      ["northwest", "nw", "西北"],
      ["southeast", "se", "东南"],
      ["in", "enter", "进", "进入"],
      ["out", "leave", "exit", "出", "出去"],
    ],
  },
};

export class GameProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GameProfileError";
  }
}

// 画像里的正则都是"无状态"地用 match / test：g 与 y 会让 match 丢捕获组、让 test 受 lastIndex 影响交替漏报，一律剥掉
function compilePattern(spec: PatternJson, where: string): RegExp {
  if (typeof spec !== "string") rejectUnknownKeys(spec, "pattern", where);
  const source = typeof spec === "string" ? spec : spec?.pattern;
  const rawFlags = typeof spec === "string" ? "" : (spec?.flags ?? "");
  if (typeof source !== "string" || source.length === 0) throw new GameProfileError(`${where}: 需要正则字符串`);
  if (typeof rawFlags !== "string") throw new GameProfileError(`${where}.flags: 需要字符串`);
  const flags = rawFlags.replace(/[gy]/g, "");
  try {
    return new RegExp(source, flags);
  } catch (error) {
    throw new GameProfileError(`${where}: 非法正则 ${JSON.stringify(source)}（${(error as Error).message}）`);
  }
}

function compileList(specs: PatternJson[] | undefined, where: string): RegExp[] {
  if (!Array.isArray(specs)) throw new GameProfileError(`${where}: 需要数组`);
  return specs.map((s, i) => compilePattern(s, `${where}[${i}]`));
}

/** 分隔符用于 split()：带捕获组会把分隔符本身塞回结果（`north, east` → `["north", ",", "east"]`），编译期拒绝 */
function compileSplitter(spec: PatternJson, where: string): RegExp {
  const re = compilePattern(spec, where);
  if (captureGroupCount(re) > 1) throw new GameProfileError(`${where}: 分隔符不能含捕获组（用 (?:…) 代替）`);
  return re;
}

function captureGroupCount(re: RegExp): number {
  return new RegExp(`${re.source}|`, re.flags).exec("")?.length ?? 1;
}

/** 消费方会读 m[1]（以及 m[2]）：画像编译时就要求有足够的捕获组，而不是运行时在 undefined 上崩掉 */
function compileCapturing(specs: PatternJson[] | undefined, where: string, minGroups: number): RegExp[] {
  const list = compileList(specs, where);
  list.forEach((re, i) => {
    const groups = captureGroupCount(re) - 1;
    if (groups < minGroups) {
      throw new GameProfileError(`${where}[${i}]: 至少需要 ${minGroups} 个捕获组（当前 ${groups}）`);
    }
  });
  return list;
}

function requireArray<T>(value: unknown, where: string): T[] {
  if (!Array.isArray(value)) throw new GameProfileError(`${where}: 需要数组`);
  return value as T[];
}

function requireOptionalBoolean(value: unknown, where: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new GameProfileError(`${where}: 需要 true/false`);
  return value;
}

function requireOptionalPositiveInt(value: unknown, where: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new GameProfileError(`${where}: 需要正整数`);
  }
  return value;
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new GameProfileError(`${where}: 需要非空字符串`);
  return value;
}

const PRIORITIES: readonly AlertPriority[] = ["critical", "high", "normal", "low"];

const KNOWN_KEYS: Record<string, readonly string[]> = {
  "": ["name", "status", "exits", "room", "items", "combat", "events", "triggers", "noise", "directions"],
  status: ["query", "hp", "mp", "level", "gold"],
  exits: ["state", "room", "splitter"],
  room: ["name", "exclude", "strip", "maxLength"],
  items: ["marker", "plain", "pickedUp"],
  combat: ["start", "end"],
  noise: ["ambientChat", "movement", "movementSelf", "emote", "loginPrompt", "inlineId", "keepAnnotations"],
  directions: ["reverse", "aliases"],
  trigger: ["id", "pattern", "priority", "label", "advice", "discrete"],
  event: ["type", "patterns"],
  pattern: ["pattern", "flags"],
};

/** 拼错的键（`comabt`、`status.hps`）不能被静默忽略：带路径拒绝 */
function rejectUnknownKeys(value: unknown, kind: string, where: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  const allowed = KNOWN_KEYS[kind];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new GameProfileError(`${where}.${key}: 未知字段（允许：${allowed.join(", ")}）`);
  }
}

export function compileGameProfile(json: GameProfileJson, where = "profile"): GameProfile {
  const j = json as Required<GameProfileJson>;
  rejectUnknownKeys(json, "", where);
  for (const section of ["status", "exits", "room", "items", "combat", "noise", "directions"] as const) {
    const v = (json as Record<string, unknown>)[section];
    if (v === null || typeof v !== "object" || Array.isArray(v))
      throw new GameProfileError(`${where}.${section}: 需要对象`);
    rejectUnknownKeys(v, section, `${where}.${section}`);
  }
  const triggers = requireArray<Partial<TriggerJson>>(j.triggers, `${where}.triggers`);
  const events = requireArray<Partial<{ type: string; patterns: PatternJson[] }>>(j.events, `${where}.events`);
  const aliases = requireArray<unknown>(j.directions?.aliases, `${where}.directions.aliases`);
  if (
    j.directions?.reverse === null ||
    typeof j.directions?.reverse !== "object" ||
    Array.isArray(j.directions.reverse)
  ) {
    throw new GameProfileError(`${where}.directions.reverse: 需要对象`);
  }
  return {
    name: j.name === undefined ? "unnamed" : requireString(j.name, `${where}.name`),
    status: {
      query: requireString(j.status?.query, `${where}.status.query`),
      hp: compileCapturing(j.status?.hp, `${where}.status.hp`, 1),
      mp: compileCapturing(j.status?.mp, `${where}.status.mp`, 1),
      level: compileCapturing(j.status?.level, `${where}.status.level`, 1),
      gold: compileCapturing(j.status?.gold, `${where}.status.gold`, 1),
    },
    exits: {
      state: compileCapturing(j.exits?.state, `${where}.exits.state`, 1),
      room: compileCapturing(j.exits?.room, `${where}.exits.room`, 1),
      splitter: compileSplitter(j.exits?.splitter as PatternJson, `${where}.exits.splitter`),
    },
    room: {
      name: compileList(j.room?.name, `${where}.room.name`),
      exclude: compileList(j.room?.exclude, `${where}.room.exclude`),
      strip: compileList(j.room?.strip, `${where}.room.strip`),
      maxLength: requireOptionalPositiveInt(j.room?.maxLength, `${where}.room.maxLength`, 25),
    },
    items: {
      marker: compileCapturing(j.items?.marker, `${where}.items.marker`, 1),
      plain: compileList(j.items?.plain, `${where}.items.plain`),
      pickedUp: compileList(j.items?.pickedUp, `${where}.items.pickedUp`),
    },
    combat: {
      start: compileList(j.combat?.start, `${where}.combat.start`),
      end: compileList(j.combat?.end, `${where}.combat.end`),
    },
    events: events.map((e, i) => {
      const at = `${where}.events[${i}]`;
      rejectUnknownKeys(e, "event", at);
      return { type: requireString(e?.type, `${at}.type`), patterns: compileList(e?.patterns, `${at}.patterns`) };
    }),
    triggers: triggers.map((t, i) => {
      const at = `${where}.triggers[${i}]`;
      rejectUnknownKeys(t, "trigger", at);
      if (!PRIORITIES.includes(t?.priority as AlertPriority)) {
        throw new GameProfileError(`${at}.priority: 需要 ${PRIORITIES.join("|")}`);
      }
      return {
        id: requireString(t?.id, `${at}.id`),
        re: compilePattern(t?.pattern as PatternJson, `${at}.pattern`),
        priority: t.priority as AlertPriority,
        label: requireString(t?.label, `${at}.label`),
        advice: requireString(t?.advice, `${at}.advice`),
        discrete: requireOptionalBoolean(t?.discrete, `${at}.discrete`, false),
      };
    }),
    noise: {
      ambientChat: compileList(j.noise?.ambientChat, `${where}.noise.ambientChat`),
      movement: compileList(j.noise?.movement, `${where}.noise.movement`),
      movementSelf: compileList(j.noise?.movementSelf, `${where}.noise.movementSelf`),
      emote: compileList(j.noise?.emote, `${where}.noise.emote`),
      loginPrompt: compileList(j.noise?.loginPrompt, `${where}.noise.loginPrompt`),
      inlineId: compileCapturing([j.noise?.inlineId as PatternJson], `${where}.noise.inlineId`, 1)[0],
      keepAnnotations: compilePattern(j.noise?.keepAnnotations as PatternJson, `${where}.noise.keepAnnotations`),
    },
    directions: {
      // 键在编译期统一小写：查表方按小写键查，画像里 NORTH / north 都能命中
      reverse: Object.fromEntries(
        Object.entries(j.directions.reverse).map(([k, v]) => [
          requireString(k, `${where}.directions.reverse 的键 ${JSON.stringify(k)}`)
            .trim()
            .toLowerCase(),
          requireString(v, `${where}.directions.reverse.${k}`).trim(),
        ]),
      ),
      aliases: aliases.map((g, i) => {
        if (!Array.isArray(g)) throw new GameProfileError(`${where}.directions.aliases[${i}]: 需要字符串数组`);
        return g.map((name, k) => requireString(name, `${where}.directions.aliases[${i}][${k}]`).trim());
      }),
    },
  };
}

/** 两级合并：顶层分区内按字段覆盖，数组与标量整体替换。 */
export function mergeGameProfileJson(base: GameProfileJson, override: GameProfileJson): GameProfileJson {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override ?? {})) {
    const current = out[key];
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === "object" &&
      !Array.isArray(current)
    ) {
      out[key] = { ...(current as Record<string, unknown>), ...(value as Record<string, unknown>) };
    } else {
      out[key] = value;
    }
  }
  return out as GameProfileJson;
}

const DEFAULT_PROFILE: GameProfile = compileGameProfile(DEFAULT_PROFILE_JSON, "default profile");

let activeProfile: GameProfile = DEFAULT_PROFILE;

export function getGameProfile(): GameProfile {
  return activeProfile;
}

/** 设定本进程使用的画像（daemon / autopilot 入口在启动时调用）；返回之前的画像以便测试恢复。 */
export function activateGameProfile(profile: GameProfile): GameProfile {
  const previous = activeProfile;
  activeProfile = profile;
  return previous;
}

export function defaultGameProfile(): GameProfile {
  return DEFAULT_PROFILE;
}

function readProfileFile(file: string): GameProfileJson | null {
  if (!fs.existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new GameProfileError(`${file}: 不是合法 JSON（${(error as Error).message}）`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GameProfileError(`${file}: 顶层必须是对象`);
  }
  return parsed as GameProfileJson;
}

/** 启动器把存储根交给子进程的环境变量：主机级画像目录 `<root>/profiles` 不靠目录名猜 */
export const STORAGE_ROOT_ENV = "MUD_STORAGE_ROOT";

/**
 * 画像文件的查找顺序。存储根按优先级：显式参数 → 启动器传入的 `MUD_STORAGE_ROOT` → 会话目录本身
 * （不带 `--session` 的扁平默认会话，会话目录就是 `~/.mud-agent`）。
 */
export function gameProfileCandidates(sessionDir: string, storageRoot?: string): string[] {
  const candidates = [path.join(sessionDir, "profile.json")];
  const root = storageRoot ?? process.env[STORAGE_ROOT_ENV] ?? sessionDir;
  const host = readServerHost(path.join(sessionDir, "config.json"));
  if (host) candidates.push(path.join(root, "profiles", profileFileNameForHost(host)));
  return candidates;
}

/** 主机级画像文件名：DNS 名 / IPv4 原样；其他字符（IPv6 的冒号等）按 RFC 3986 百分号编码，路径安全且可逆 */
export function profileFileNameForHost(host: string): string {
  return `${encodeURIComponent(host.trim().toLowerCase())}.json`;
}

function readServerHost(configFile: string): string | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile, "utf8")) as { server?: { host?: unknown } };
    const host = cfg?.server?.host;
    return typeof host === "string" && host.trim() !== "" ? host : null;
  } catch {
    return null;
  }
}

/**
 * 按查找顺序读取第一个存在的画像文件，合并到默认画像上并编译；一个都没有就用默认画像。
 * 文件存在但不合法时抛 GameProfileError——操作者写坏的画像应该让进程带着明确原因拒绝启动，而不是悄悄退回默认。
 */
export function loadGameProfile(
  sessionDir: string,
  storageRoot?: string,
): { profile: GameProfile; source: string | null } {
  for (const file of gameProfileCandidates(sessionDir, storageRoot)) {
    const json = readProfileFile(file);
    if (json)
      return { profile: compileGameProfile(mergeGameProfileJson(DEFAULT_PROFILE_JSON, json), file), source: file };
  }
  return { profile: DEFAULT_PROFILE, source: null };
}
