import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

async function loadModules(homeDir: string) {
  process.env.HOME = homeDir;
  vi.resetModules();
  const hookModule = await import("./session-mode");
  const storeModule = await import("../storage/session-store");
  const sessionKeyModule = await import("../lib/session-key");
  return { ...hookModule, ...storeModule, ...sessionKeyModule };
}

describe("registerSessionModeHook", () => {
  const originalHome = process.env.HOME;
  const tempHomeDirs = new Set<string>();

  function createTempHome(): string {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-session-mode-"));
    tempHomeDirs.add(homeDir);
    return homeDir;
  }

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    vi.resetModules();
    for (const homeDir of tempHomeDirs) {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
    tempHomeDirs.clear();
  });

  it("does not inject MUD context for unregistered sessions with stale shutdown state", async () => {
    const homeDir = createTempHome();
    const sessionKey = "agent:main:telegram:direct:100000001";
    const { getMudSessionStore, registerSessionModeHook, resolveSessionDir } = await loadModules(homeDir);
    const store = getMudSessionStore();
    const dataDir = resolveSessionDir(store, sessionKey);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "state.json"),
      JSON.stringify({
        shutdownReason: "reconnect-limit",
        shutdownAt: "2026-03-26T00:00:00.000Z",
      }),
    );

    let handler: ((event: unknown, ctx: unknown) => unknown) | undefined;
    registerSessionModeHook({
      on(event: string, fn: (event: unknown, ctx: unknown) => unknown) {
        if (event === "before_prompt_build") handler = fn;
      },
    } as unknown as import("../core/types.js").OpenClawPluginApi);

    expect(handler).toBeTypeOf("function");
    const result = handler?.({}, { sessionKey });
    expect(result).toBeUndefined();
  });

  it("does not inject MUD context when daemon is stopped, even for registered sessions", async () => {
    // After stopping the game, conversations in that Topic should be clean (no MUD rules injected).
    // The shutdown-context injection was removed to prevent pollution of normal chat.
    const homeDir = createTempHome();
    const sessionKey = "agent:main:telegram:group:-1009000000000:topic:1";
    const { getMudSessionStore, registerSessionModeHook, resolveSessionDir } = await loadModules(homeDir);
    const store = getMudSessionStore();
    store.ensure(sessionKey);
    const dataDir = resolveSessionDir(store, sessionKey);
    fs.writeFileSync(
      path.join(dataDir, "state.json"),
      JSON.stringify({
        shutdownReason: "reconnect-limit",
        shutdownAt: "2026-03-26T00:00:00.000Z",
      }),
    );
    fs.writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({
        server: { host: "mud.example.com", port: 8081, encoding: "utf8" },
        credentials: { username: "test-player" },
      }),
    );

    store.setMode(sessionKey, "paused");

    let handler: ((event: unknown, ctx: unknown) => unknown) | undefined;
    registerSessionModeHook({
      on(event: string, fn: (event: unknown, ctx: unknown) => unknown) {
        if (event === "before_prompt_build") handler = fn;
      },
    } as unknown as import("../core/types.js").OpenClawPluginApi);

    expect(handler).toBeTypeOf("function");
    const result = handler?.({}, { sessionKey }) as { prependSystemContext?: string } | undefined;

    // Daemon not running → Gate 2 blocks injection → clean conversation
    expect(result).toBeUndefined();
  });

  it("safely omits transcript-derived guards when OpenClaw session filenames do not match", async () => {
    const homeDir = createTempHome();
    const sessionKey = "agent:main:telegram:direct:100000001";
    const sessionsDir = path.join(homeDir, ".openclaw", "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "transcript-agent_main_telegram_direct_100000001.jsonl"),
      [
        JSON.stringify({
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "[Queued messages while agent was busy]\nQueued #1\nQueued #2",
              },
            ],
          },
        }),
        ...Array.from({ length: 4 }, () => JSON.stringify({ message: { role: "toolResult" } })),
      ].join("\n"),
    );

    const { getMudSessionStore, registerSessionModeHook, resolveSessionDir } = await loadModules(homeDir);
    const store = getMudSessionStore();
    store.ensure(sessionKey);
    const dataDir = resolveSessionDir(store, sessionKey);
    fs.writeFileSync(path.join(dataDir, "mud-daemon.pid"), String(process.pid));

    let handler: ((event: unknown, ctx: unknown) => unknown) | undefined;
    registerSessionModeHook({
      on(event: string, fn: (event: unknown, ctx: unknown) => unknown) {
        if (event === "before_prompt_build") handler = fn;
      },
    } as unknown as import("../core/types.js").OpenClawPluginApi);

    expect(handler).toBeTypeOf("function");
    let result: { prependSystemContext?: string; appendSystemContext?: string } | undefined;
    expect(() => {
      result = handler?.({}, { sessionKey }) as
        | { prependSystemContext?: string; appendSystemContext?: string }
        | undefined;
    }).not.toThrow();
    expect(result?.prependSystemContext).toContain("当前会话处于 MUD 游戏模式");
    expect(result?.appendSystemContext).toBeUndefined();
    expect(result?.appendSystemContext ?? "").not.toContain("[SYSTEM INTERRUPT]");
    expect(result?.appendSystemContext ?? "").not.toContain("[用户有 ");
  });

  async function prepareLiveSession(sessionKey: string, gameMode?: string) {
    const homeDir = createTempHome();
    const modules = await loadModules(homeDir);
    const store = modules.getMudSessionStore();
    store.ensure(sessionKey);
    const dataDir = modules.resolveSessionDir(store, sessionKey);
    fs.writeFileSync(path.join(dataDir, "mud-daemon.pid"), String(process.pid));
    if (gameMode) fs.writeFileSync(path.join(dataDir, "game-mode.json"), JSON.stringify({ mode: gameMode }));

    let handler: ((event: unknown, ctx: unknown) => unknown) | undefined;
    modules.registerSessionModeHook({
      on(event: string, fn: (event: unknown, ctx: unknown) => unknown) {
        if (event === "before_prompt_build") handler = fn;
      },
    } as unknown as import("../core/types.js").OpenClawPluginApi);
    expect(handler).toBeTypeOf("function");
    return (event: unknown) =>
      handler?.(event, { sessionKey }) as { prependSystemContext?: string; appendSystemContext?: string } | undefined;
  }

  const toolRound = (name: string) => [
    { role: "assistant", content: [{ type: "toolCall", id: `${name}-call`, name, arguments: {} }] },
    { role: "toolResult", toolName: name, content: [{ type: "text", text: "ok" }] },
  ];

  it("interrupts a companion session from the event message snapshot without any transcript file", async () => {
    const run = await prepareLiveSession("agent:main:telegram:group:-1009000000000:topic:7");
    const messages = [
      { role: "user", content: [{ type: "text", text: "带我去大厅" }] },
      ...toolRound("mud_act"),
      ...toolRound("mud_act"),
      ...toolRound("mud_read"),
    ];

    const result = run({ prompt: "继续", messages });
    expect(result?.prependSystemContext).toContain("【陪伴模式】");
    expect(result?.appendSystemContext).toContain("[SYSTEM INTERRUPT] You have made 3+ consecutive tool calls");
    expect(result?.appendSystemContext).not.toContain("[用户有 ");
  });

  it("does not interrupt when the latest assistant message is plain text or the chain is short", async () => {
    const run = await prepareLiveSession("agent:main:telegram:group:-1009000000000:topic:8");
    const settled = [
      { role: "user", content: [{ type: "text", text: "带我去大厅" }] },
      ...toolRound("mud_act"),
      ...toolRound("mud_act"),
      ...toolRound("mud_act"),
      { role: "assistant", content: [{ type: "text", text: "已到大厅，继续吗？" }] },
    ];
    expect(run({ prompt: "继续", messages: settled })?.appendSystemContext).toBeUndefined();

    const short = [{ role: "user", content: [{ type: "text", text: "看看四周" }] }, ...toolRound("mud_act")];
    expect(run({ prompt: "继续", messages: short })?.appendSystemContext).toBeUndefined();

    // 一次调用 = 一条带 toolCall 的 assistant + 一条 toolResult，只计 1 次：两次调用不到 3 次门限
    const two = [
      { role: "user", content: [{ type: "text", text: "看看四周" }] },
      ...toolRound("mud_act"),
      ...toolRound("mud_read"),
    ];
    expect(run({ prompt: "继续", messages: two })?.appendSystemContext).toBeUndefined();
  });

  it("counts queued messages from the current prompt and skips guards in full-auto", async () => {
    const queuedPrompt = [
      "[Queued messages while agent was busy]",
      "---",
      "Queued #1",
      "别走了",
      "---",
      "Queued #2",
      "看看血量",
    ].join("\n");

    const companion = await prepareLiveSession("agent:main:telegram:group:-1009000000000:topic:9");
    const result = companion({ prompt: queuedPrompt, messages: [] });
    expect(result?.appendSystemContext).toContain("[用户有 2 条指令在工具链执行期间发送，已排队等候]");
    // 宿主只把排队块拼进 prompt、currentUserMessage 是干净的用户消息：仍要算到
    const both = companion({ prompt: queuedPrompt, currentUserMessage: "别走了", messages: [] });
    expect(both?.appendSystemContext).toContain("[用户有 2 条指令在工具链执行期间发送，已排队等候]");

    const fullAuto = await prepareLiveSession("agent:main:telegram:group:-1009000000000:topic:10", "full-auto");
    const chain = [
      { role: "user", content: [{ type: "text", text: "挂机" }] },
      ...toolRound("mud_act"),
      ...toolRound("mud_act"),
      ...toolRound("mud_act"),
      ...toolRound("mud_act"),
    ];
    const autoResult = fullAuto({ prompt: queuedPrompt, messages: chain });
    expect(autoResult?.prependSystemContext).toContain("【全自动模式】");
    expect(autoResult?.appendSystemContext).toBeUndefined();
  });
});
