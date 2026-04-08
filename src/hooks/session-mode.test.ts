import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

async function loadModules(homeDir: string) {
  process.env.HOME = homeDir;
  vi.resetModules();
  const hookModule = await import("./session-mode");
  const storeModule = await import("../storage/session-store");
  return { ...hookModule, ...storeModule };
}

describe("registerSessionModeHook", () => {
  const originalHome = process.env.HOME;

  afterEach(() => {
    process.env.HOME = originalHome;
    vi.resetModules();
  });

  it("does not inject MUD context for unregistered sessions with stale shutdown state", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-session-mode-"));
    const sessionKey = "agent:main:telegram:direct:100000001";
    const dataDir = path.join(homeDir, ".mud-agent", "sessions", sessionKey);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "state.json"),
      JSON.stringify({
        shutdownReason: "reconnect-limit",
        shutdownAt: "2026-03-26T00:00:00.000Z",
      }),
    );

    const { registerSessionModeHook } = await loadModules(homeDir);
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
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-session-mode-"));
    const sessionKey = "agent:main:telegram:group:-1009000000000:topic:1";
    const dataDir = path.join(homeDir, ".mud-agent", "sessions", sessionKey);
    fs.mkdirSync(dataDir, { recursive: true });
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

    const { getMudSessionStore, registerSessionModeHook } = await loadModules(homeDir);
    const store = getMudSessionStore();
    store.ensure(sessionKey);
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
});
