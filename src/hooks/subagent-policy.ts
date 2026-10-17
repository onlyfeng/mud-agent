import type { OpenClawPluginApi } from "../core/types.js";
import {
  resolveActiveMudSessionKey,
  resolveMudTurnSessionKey,
  resolveRegisteredMudSessionKey,
} from "./session-mode.js";

export const YIELD_BLOCK_REASON =
  "本回合由子任务完成事件触发，sessions_yield 在这里会被宿主丢弃，它的 acknowledgment 不会送达用户。" +
  "请直接用一条不带任何工具调用的纯文字简报结束本回合，它会投递到用户的话题；下一轮子任务完成后宿主会再次唤醒你，不要调用 sessions_yield 或 wait 等待。";

type ToolCallView = {
  name: string;
  args: Record<string, unknown>;
  rewrap: (args: Record<string, unknown>) => Record<string, unknown>;
};

export function viewToolCall(event: unknown): ToolCallView | null {
  const evt = (event ?? {}) as Record<string, unknown>;
  const params = (evt.params ?? {}) as Record<string, unknown>;
  if (evt.toolName === "tool_call" && typeof params.id === "string") {
    const args = (params.args ?? {}) as Record<string, unknown>;
    return { name: params.id, args, rewrap: (next) => ({ ...params, args: next }) };
  }
  if (typeof evt.toolName === "string") {
    return { name: evt.toolName, args: params, rewrap: (next) => next };
  }
  return null;
}

export function isAnnounceRun(event: unknown, ctx: unknown): boolean {
  const evt = (event ?? {}) as Record<string, unknown>;
  const ctxRecord = (ctx ?? {}) as Record<string, unknown>;
  return String(evt.runId ?? ctxRecord.runId ?? "").startsWith("announce:");
}

// 真实观察（2026-10-16，某 Telegram topic）：
// - `completionTarget: "parent"` 是私有结算，宿主不会把结算回合的最终文本投递到频道，19 轮简报因此静默丢失；
//   剥掉它即走默认 announce 路径（top-level requester → follow-up agent call, deliver=true）。
// - 结算回合（runId 以 announce: 开头）里的 sessions_yield 会被宿主丢弃；用户发起的回合必须放行它。
export function registerSubagentPolicyHook(api: OpenClawPluginApi): void {
  if (typeof api?.on !== "function") return;

  api.on(
    "before_tool_call",
    (event, ctx) => {
      try {
        const call = viewToolCall(event);
        if (!call) return undefined;
        if (call.name !== "sessions_yield" && call.name !== "sessions_spawn") return undefined;

        if (call.name === "sessions_yield") {
          // 结算回合的 yield 会被宿主丢弃，与 daemon 是否还在无关：子任务是在 MUD 回合里派的，
          // 中途 /mud stop 或 daemon 空闲退出后这条简报仍要投递，所以只看会话是否注册过。
          if (!isAnnounceRun(event, ctx)) return undefined;
          return resolveRegisteredMudSessionKey(event, ctx)
            ? { block: true, blockReason: YIELD_BLOCK_REASON }
            : undefined;
        }
        // 结算回合（announce:）里链式派下一个子任务：它有新的 runId、daemon 可能已经不在，与 yield 分支一样只看会话是否注册过；
        // 其他 run：以活跃 MUD 回合开始的整个回合都按 MUD 处理（daemon 中途退出也不例外），没记录到 runId 的退回瞬时存活门控
        const inMudContext = isAnnounceRun(event, ctx)
          ? resolveRegisteredMudSessionKey(event, ctx) !== null
          : resolveMudTurnSessionKey(event, ctx) !== null || resolveActiveMudSessionKey(event, ctx) !== null;
        if (!inMudContext) return undefined;
        if (call.args.completionTarget === undefined) return undefined;
        const rest = { ...call.args };
        delete rest.completionTarget;
        return { params: call.rewrap(rest) };
      } catch {
        return undefined;
      }
    },
    { priority: 50 },
  );
}
