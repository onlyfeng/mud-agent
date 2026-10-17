/**
 * 噪音行判定：共享给 daemon 日志回显与触发器。
 *
 * 真实会话（西游记清华，2026-10-14/15）里 daemon.log 的 41% 是房间内其他玩家的
 * 移动播报，频道闲聊则会让 boss / puzzle / npc_talk 等文本触发器反复误报。
 * 这里只负责"判定"，不改变 output.jsonl（AI 读取的游戏输出缓冲）。
 */

const AMBIENT_CHAT_RE = /^【(闲聊|频道|世界|广播|传闻|谣言|江湖|帮派|门派|新手|公告|系统公告)】/;
const MOVEMENT_RE =
  /(走了过来|走了过去|跑了过来|跑了过去|往[东南西北上下]{1,2}离开|离开了[。！]?$|来到了这里[。！]?$|从里面走了出来[。！]?$)/;
const DECORATIVE_RE = /^[\s>]*$|^[\s@┃┏┗┓┛━─│├┤┬┴┼═║╔╗╚╝]+$/;
const UNDECODABLE_RE = /\uFFFD/;
const EMOTE_RE = /(再吹一声口哨|随之往上冉冉地升起|随之飘去不见了|吹了一声口哨)/;
const LOGIN_PROMPT_RE = /(请输入.{0,6}密码|密码[：:]\s*\?*\s*$|password\s*[:：]?\s*$)/i;

export function isAmbientChatLine(line: string): boolean {
  return AMBIENT_CHAT_RE.test(line.trim());
}

export function isMovementNoiseLine(line: string): boolean {
  const t = line.trim();
  // “你往南离开。”“你离开了。”是自己移动命令的响应，不是环境播报
  if (t.startsWith("你")) return false;
  return MOVEMENT_RE.test(t);
}

export function isDecorativeLine(line: string): boolean {
  return DECORATIVE_RE.test(line) || UNDECODABLE_RE.test(line);
}

export function isEmoteNoiseLine(line: string): boolean {
  return EMOTE_RE.test(line);
}

export function isLoginPromptLine(line: string): boolean {
  return LOGIN_PROMPT_RE.test(line.trim());
}

// 只剥紧贴在中文名字后面的玩家 ASCII id（示例玩家(BossExample)、七包金创药(Jinchuang yao)）：前面必须是 CJK 字符且没有空格。
// "Goblin King (Boss) appears" / "拾取 (Legendary)" 这类带空格或英文前缀的标注保留；括号内容本身就是触发关键字时也保留。
const TRIGGER_ANNOTATION_RE = /^(boss|legendary|epic|rare|unique)$/i;
export function stripAsciiIds(line: string): string {
  return line.replace(/(?<=[\u3400-\u9fff\uf900-\ufaff])\(([A-Za-z][A-Za-z' -]*)\)/g, (match, inner: string) =>
    TRIGGER_ANNOTATION_RE.test(inner.trim()) ? match : "",
  );
}

export function isLogNoiseLine(line: string): boolean {
  return isDecorativeLine(line) || isMovementNoiseLine(line) || isAmbientChatLine(line) || isEmoteNoiseLine(line);
}
