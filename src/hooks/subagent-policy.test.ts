import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

async function loadModules(homeDir: string) {
  process.env.HOME = homeDir;
  vi.resetModules();
  const policy = await import("./subagent-policy");
  const sessionMode = await import("./session-mode");
  const store = await import("../storage/session-store");
  const sessionKey = await import("../lib/session-key");
  return { ...policy, ...store, ...sessionKey, rememberMudTurn: sessionMode.rememberMudTurn };
}

// 策略钩子按 daemon 存活门控：注册目录 + 活着的 mud-daemon.pid 才算活跃 MUD 会话
type SessionMods = Pick<Awaited<ReturnType<typeof loadModules>>, "getMudSessionStore" | "resolveSessionDir">;
function activateSession(mods: SessionMods, sessionKey: string) {
  const store = mods.getMudSessionStore();
  store.ensure(sessionKey);
  fs.writeFileSync(path.join(mods.resolveSessionDir(store, sessionKey), "mud-daemon.pid"), String(process.pid));
}

type Handler = (event: unknown, ctx: unknown) => unknown;

function captureHook(register: (api: import("../core/types.js").OpenClawPluginApi) => void) {
  let handler: Handler | undefined;
  let opts: Record<string, unknown> | undefined;
  register({
    on(event: string, fn: Handler, o?: Record<string, unknown>) {
      if (event === "before_tool_call") {
        handler = fn;
        opts = o;
      }
    },
  } as unknown as import("../core/types.js").OpenClawPluginApi);
  return { handler, opts };
}

const ANNOUNCE_RUN = "announce:requester-settle:main:agent:main:telegram:group:-1009000000000:topic:5:6b0950fc:yield-1";
const USER_RUN = "fa73bc80-a664-49ce-98e1-abd9773883f8";

describe("registerSubagentPolicyHook", () => {
  const originalHome = process.env.HOME;
  const dirs = new Set<string>();
  function tempHome(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-subagent-policy-"));
    dirs.add(d);
    return d;
  }
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    vi.resetModules();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.clear();
  });

  it("registers a match-all before_tool_call hook", async () => {
    const { registerSubagentPolicyHook } = await loadModules(tempHome());
    const { handler, opts } = captureHook(registerSubagentPolicyHook);
    expect(handler).toBeTypeOf("function");
    expect(opts?.matcher).toBeUndefined();
  });

  it("blocks sessions_yield on a subagent-completion (announce) turn inside a registered MUD session", async () => {
    const sessionKey = "agent:main:telegram:group:-1009000000000:topic:5";
    const mods = await loadModules(tempHome());
    const { registerSubagentPolicyHook, YIELD_BLOCK_REASON } = mods;
    activateSession(mods, sessionKey);
    const { handler } = captureHook(registerSubagentPolicyHook);

    expect(
      handler?.(
        { toolName: "sessions_yield", params: { acknowledgment: "第1轮完成" }, runId: ANNOUNCE_RUN },
        { sessionKey, runId: ANNOUNCE_RUN },
      ),
    ).toEqual({ block: true, blockReason: YIELD_BLOCK_REASON });
  });

  it("lets a user-initiated turn yield", async () => {
    const sessionKey = "agent:main:telegram:group:-1009000000000:topic:7";
    const mods = await loadModules(tempHome());
    const { registerSubagentPolicyHook } = mods;
    activateSession(mods, sessionKey);
    const { handler } = captureHook(registerSubagentPolicyHook);

    expect(
      handler?.(
        { toolName: "sessions_yield", params: { acknowledgment: "已上线" }, runId: USER_RUN },
        { sessionKey, runId: USER_RUN },
      ),
    ).toBeUndefined();
  });

  it("strips completionTarget from a direct sessions_spawn in a MUD session", async () => {
    const sessionKey = "agent:main:telegram:group:-1009000000000:topic:8";
    const mods = await loadModules(tempHome());
    const { registerSubagentPolicyHook } = mods;
    activateSession(mods, sessionKey);
    const { handler } = captureHook(registerSubagentPolicyHook);

    const params = { task: "打工一轮", completionTarget: "parent", runtime: "subagent", mode: "run" };
    expect(handler?.({ toolName: "sessions_spawn", params, runId: USER_RUN }, { sessionKey, runId: USER_RUN })).toEqual(
      {
        params: { task: "打工一轮", runtime: "subagent", mode: "run" },
      },
    );
  });

  it("keeps stripping completionTarget for a run that began as a MUD turn even after the daemon died mid-turn", async () => {
    const sessionKey = "agent:main:telegram:group:-1009000000000:topic:18";
    const mods = await loadModules(tempHome());
    const { registerSubagentPolicyHook, rememberMudTurn, resolveSessionDir, getMudSessionStore } = mods;
    activateSession(mods, sessionKey);
    rememberMudTurn({ runId: USER_RUN }, sessionKey); // 回合开始时（before_prompt_build）daemon 还活着
    fs.rmSync(path.join(resolveSessionDir(getMudSessionStore(), sessionKey), "mud-daemon.pid")); // 回合中途 daemon 没了
    const { handler } = captureHook(registerSubagentPolicyHook);
    const params = { task: "打工一轮", completionTarget: "parent" };
    expect(handler?.({ toolName: "sessions_spawn", params, runId: USER_RUN }, { sessionKey, runId: USER_RUN })).toEqual(
      {
        params: { task: "打工一轮" },
      },
    );
    // 很多别的回合之后，原回合仍被记得（按时间过期，不按条数淘汰）
    for (let i = 0; i < 300; i++) rememberMudTurn({ runId: `run-${i}` }, sessionKey);
    expect(handler?.({ toolName: "sessions_spawn", params, runId: USER_RUN }, { sessionKey, runId: USER_RUN })).toEqual(
      {
        params: { task: "打工一轮" },
      },
    );
    // 另一个没有以 MUD 回合开始的 run：仍按瞬时门控，daemon 不在就放行
    expect(
      handler?.({ toolName: "sessions_spawn", params, runId: "other-run" }, { sessionKey, runId: "other-run" }),
    ).toBeUndefined();
  });

  it("strips completionTarget from a chained spawn inside an announce turn even after the daemon stopped", async () => {
    const sessionKey = "agent:main:telegram:group:-1009000000000:topic:19";
    const mods = await loadModules(tempHome());
    const { registerSubagentPolicyHook, resolveSessionDir, getMudSessionStore } = mods;
    activateSession(mods, sessionKey);
    fs.rmSync(path.join(resolveSessionDir(getMudSessionStore(), sessionKey), "mud-daemon.pid")); // daemon 已停
    const { handler } = captureHook(registerSubagentPolicyHook);
    const params = { task: "打工下一轮", completionTarget: "parent" };
    expect(
      handler?.({ toolName: "sessions_spawn", params, runId: ANNOUNCE_RUN }, { sessionKey, runId: ANNOUNCE_RUN }),
    ).toEqual({ params: { task: "打工下一轮" } });
  });

  it("strips completionTarget inside the code-mode tool_call wrapper and keeps the wrapper shape", async () => {
    const sessionKey = "agent:main:telegram:group:-1009000000000:topic:9";
    const mods = await loadModules(tempHome());
    const { registerSubagentPolicyHook } = mods;
    activateSession(mods, sessionKey);
    const { handler } = captureHook(registerSubagentPolicyHook);

    const params = {
      id: "sessions_spawn",
      args: { task: "打工一轮", completionTarget: "parent", label: "第2轮", expectsCompletionMessage: true },
    };
    expect(
      handler?.({ toolName: "tool_call", params, runId: ANNOUNCE_RUN }, { sessionKey, runId: ANNOUNCE_RUN }),
    ).toEqual({
      params: { id: "sessions_spawn", args: { task: "打工一轮", label: "第2轮", expectsCompletionMessage: true } },
    });
  });

  it("leaves spawns without completionTarget, other tools, and non-MUD sessions alone", async () => {
    const sessionKey = "agent:main:telegram:group:-1009000000000:topic:6";
    const mods = await loadModules(tempHome());
    const { registerSubagentPolicyHook } = mods;
    activateSession(mods, sessionKey);
    const { handler } = captureHook(registerSubagentPolicyHook);

    expect(
      handler?.(
        { toolName: "sessions_spawn", params: { task: "x" }, runId: USER_RUN },
        { sessionKey, runId: USER_RUN },
      ),
    ).toBeUndefined();
    expect(
      handler?.(
        { toolName: "exec", params: { command: "ls" }, runId: ANNOUNCE_RUN },
        { sessionKey, runId: ANNOUNCE_RUN },
      ),
    ).toBeUndefined();
    expect(
      handler?.(
        { toolName: "sessions_spawn", params: { task: "x", completionTarget: "parent" }, runId: USER_RUN },
        { sessionKey: "agent:main:telegram:direct:424242", runId: USER_RUN },
      ),
    ).toBeUndefined();
  });
  it("keeps blocking announce-turn sessions_yield after the daemon stopped (directory still registered) but leaves new spawns alone", async () => {
    const sessionKey = "agent:main:telegram:group:-1009000000000:topic:5";
    const mods = await loadModules(tempHome());
    const { registerSubagentPolicyHook, getMudSessionStore, YIELD_BLOCK_REASON } = mods;
    getMudSessionStore().ensure(sessionKey); // /mud stop 之后：目录在，daemon 不在
    const { handler } = captureHook(registerSubagentPolicyHook);
    expect(
      handler?.(
        { toolName: "sessions_spawn", params: { task: "x", completionTarget: "parent" }, runId: USER_RUN },
        { sessionKey, runId: USER_RUN },
      ),
    ).toBeUndefined();
    // 子任务在 daemon 还活着时派出，结算回合到来前 daemon 已停：yield 仍会被宿主丢弃，简报必须直接发
    expect(
      handler?.(
        { toolName: "sessions_yield", params: { acknowledgment: "ok" }, runId: ANNOUNCE_RUN },
        { sessionKey, runId: ANNOUNCE_RUN },
      ),
    ).toEqual({ block: true, blockReason: YIELD_BLOCK_REASON });
  });
});
