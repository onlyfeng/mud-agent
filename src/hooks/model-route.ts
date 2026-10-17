import type { OpenClawPluginApi } from "../core/types.js";
import { resolveRegisteredMudSessionKey } from "./session-mode.js";

export function parseModelRef(value: unknown): { provider: string; model: string } | null {
  if (typeof value !== "string") return null;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  const provider = value.slice(0, slash);
  const model = value.slice(slash + 1);
  if (!provider || !model) return null;
  return { provider, model };
}

export function registerModelRouteHook(api: OpenClawPluginApi): void {
  if (typeof api?.on !== "function") return;

  const configured = api.pluginConfig?.model;
  const overrideDisabled = configured === undefined || configured === "" || configured === null || configured === false;
  if (overrideDisabled) {
    api.logger.info(
      "MUD 模型覆盖未启用：未配置 plugins.entries.mud-agent.config.model，MUD 会话继续使用 Agent 默认模型",
    );
    return;
  }

  const parsed = parseModelRef(configured);
  if (!parsed) {
    api.logger.warn(`MUD 模型覆盖未注册：model 必须是 provider/model（两侧均非空），收到 ${String(configured)}`);
    return;
  }

  const { provider, model } = parsed;
  // 宿主在模型回退时会为每个候选重新进入 before_model_resolve（同一逻辑回合共用 ctx.runId）；
  // 只在一个 runId 的首次调用覆盖，同一 runId 再进来就是配置模型已经失败后的回退尝试，
  // 这时不再覆盖，让回退链走到健康的候选。没有 runId 的调用方保持每次覆盖。
  // 同一会话可能有两个 run 交错（用户回合 + 子任务结算），所以记的是全部已覆盖过的 runId（有界），不是每会话最后一个。
  // 记录按 TTL 清理，不按条数淘汰：一个配置模型请求可能长时间超时，期间别的会话产生再多 run 也不能遗忘它——
  // 否则它的回退候选再进来会被重新覆盖成刚失败的模型。TTL 取远大于任何模型请求超时的值；硬上限只防内存失控。
  const overriddenRuns = new Map<string, number>();
  const RUN_OVERRIDE_TTL_MS = 30 * 60 * 1000;
  const MAX_TRACKED_RUNS = 10_000;
  const pruneRuns = (now: number) => {
    for (const [tracked, seenAt] of overriddenRuns) {
      if (now - seenAt > RUN_OVERRIDE_TTL_MS) overriddenRuns.delete(tracked);
    }
    while (overriddenRuns.size > MAX_TRACKED_RUNS) {
      const oldest = overriddenRuns.keys().next().value;
      if (oldest === undefined) break;
      overriddenRuns.delete(oldest);
    }
  };
  // 路由条件是“已注册的 MUD 会话（session 目录存在）”，不要求 daemon 存活：
  // 上线 / 下线这两个回合发生在 daemon 启动前 / 停止后，实测它们落在默认模型上最慢（上线 2 分 20 秒）。
  // 提示词注入仍由 resolveActiveMudSessionKey 按 daemon 存活门控。
  api.on("before_model_resolve", (event, ctx) => {
    try {
      const key = resolveRegisteredMudSessionKey(event, ctx);
      if (!key) return undefined;
      const runId = readRunId(ctx);
      if (runId) {
        const tracked = `${key}\u0000${runId}`;
        const now = Date.now();
        pruneRuns(now);
        if (overriddenRuns.has(tracked)) return undefined;
        overriddenRuns.set(tracked, now);
      }
      return { providerOverride: provider, modelOverride: model };
    } catch {
      return undefined;
    }
  });
}

function readRunId(ctx: unknown): string | null {
  const runId = (ctx as { runId?: unknown } | null | undefined)?.runId;
  return typeof runId === "string" && runId.trim() ? runId : null;
}
