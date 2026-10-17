import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

async function loadModules(homeDir: string) {
  process.env.HOME = homeDir;
  vi.resetModules();
  const hookModule = await import("./model-route");
  const storeModule = await import("../storage/session-store");
  const sessionKeyModule = await import("../lib/session-key");
  return { ...hookModule, ...storeModule, ...sessionKeyModule };
}

type ModelHandler = (event: unknown, ctx: unknown) => unknown;

function captureHook(
  registerModelRouteHook: (api: import("../core/types.js").OpenClawPluginApi) => void,
  pluginConfig?: Record<string, unknown>,
) {
  const onCalls: string[] = [];
  const logs: Record<"debug" | "info" | "warn" | "error", unknown[][]> = {
    debug: [],
    info: [],
    warn: [],
    error: [],
  };
  let handler: ModelHandler | undefined;
  registerModelRouteHook({
    pluginConfig,
    logger: {
      debug: (...args: unknown[]) => {
        logs.debug.push(args);
      },
      info: (...args: unknown[]) => {
        logs.info.push(args);
      },
      warn: (...args: unknown[]) => {
        logs.warn.push(args);
      },
      error: (...args: unknown[]) => {
        logs.error.push(args);
      },
    },
    on(event: string, fn: ModelHandler) {
      onCalls.push(event);
      handler = fn;
    },
  } as unknown as import("../core/types.js").OpenClawPluginApi);
  return { onCalls, info: logs.info, warn: logs.warn, handler };
}

describe("registerModelRouteHook", () => {
  const originalHome = process.env.HOME;
  const tempHomeDirs = new Set<string>();

  function createTempHome(): string {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-model-route-"));
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

  it("returns undefined for an unregistered session key", async () => {
    const homeDir = createTempHome();
    const sessionKey = "agent:main:telegram:direct:100000001";
    const { registerModelRouteHook } = await loadModules(homeDir);
    const captured = captureHook(registerModelRouteHook, { model: "example-deepseek/deepseek-flash" });

    expect(captured.onCalls).toEqual(["before_model_resolve"]);
    expect(captured.handler).toBeTypeOf("function");
    expect(captured.handler?.({}, { sessionKey })).toBeUndefined();
  });

  it("routes a live session to pluginConfig.model", async () => {
    const homeDir = createTempHome();
    const sessionKey = "agent:main:telegram:direct:100000001";
    const { getMudSessionStore, registerModelRouteHook, resolveSessionDir } = await loadModules(homeDir);
    const store = getMudSessionStore();
    store.ensure(sessionKey);
    fs.writeFileSync(path.join(resolveSessionDir(store, sessionKey), "mud-daemon.pid"), String(process.pid));

    const captured = captureHook(registerModelRouteHook, { model: "example-deepseek/deepseek-flash" });
    expect(captured.handler).toBeTypeOf("function");
    expect(captured.info).toEqual([]);
    expect(captured.warn).toEqual([]);
    expect(captured.handler?.({}, { sessionKey })).toEqual({
      providerOverride: "example-deepseek",
      modelOverride: "deepseek-flash",
    });
  });

  it("accepts any provider/model ref", async () => {
    const homeDir = createTempHome();
    const sessionKey = "agent:main:telegram:group:-1009000000000:topic:1";
    const { getMudSessionStore, registerModelRouteHook, resolveSessionDir } = await loadModules(homeDir);
    const store = getMudSessionStore();
    store.ensure(sessionKey);
    fs.writeFileSync(path.join(resolveSessionDir(store, sessionKey), "mud-daemon.pid"), String(process.pid));

    const captured = captureHook(registerModelRouteHook, { model: "example-ai/glm-5.3-flash" });
    expect(captured.handler?.({}, { sessionKey })).toEqual({
      providerOverride: "example-ai",
      modelOverride: "glm-5.3-flash",
    });
  });

  it("does not register a hook when model is not configured (no built-in default)", async () => {
    const homeDir = createTempHome();
    const { registerModelRouteHook } = await loadModules(homeDir);
    const captured = captureHook(registerModelRouteHook);

    expect(captured.onCalls).toEqual([]);
    expect(captured.handler).toBeUndefined();
    expect(captured.info).toHaveLength(1);
    expect(captured.warn).toEqual([]);
  });

  it("does not register a hook when model is an empty string", async () => {
    const homeDir = createTempHome();
    const { registerModelRouteHook } = await loadModules(homeDir);
    const captured = captureHook(registerModelRouteHook, { model: "" });

    expect(captured.onCalls).toEqual([]);
    expect(captured.handler).toBeUndefined();
    expect(captured.info).toHaveLength(1);
    expect(captured.warn).toEqual([]);
  });

  it("does not register a hook and warns once for an invalid model ref", async () => {
    const homeDir = createTempHome();
    const { registerModelRouteHook } = await loadModules(homeDir);
    const captured = captureHook(registerModelRouteHook, { model: "bad-ref" });

    expect(captured.onCalls).toEqual([]);
    expect(captured.handler).toBeUndefined();
    expect(captured.warn).toHaveLength(1);
    expect(captured.info).toEqual([]);
  });

  it("routes a registered session even when the daemon is not running (上线/下线回合也走低延迟模型)", async () => {
    const homeDir = createTempHome();
    const sessionKey = "agent:main:telegram:direct:100000001";
    const { getMudSessionStore, registerModelRouteHook } = await loadModules(homeDir);
    getMudSessionStore().ensure(sessionKey);

    const captured = captureHook(registerModelRouteHook, { model: "example-deepseek/deepseek-flash" });
    expect(captured.handler).toBeTypeOf("function");
    expect(captured.handler?.({}, { sessionKey })).toEqual({
      providerOverride: "example-deepseek",
      modelOverride: "deepseek-flash",
    });
  });

  it("overrides only the first attempt of a run so the host's model fallback chain can advance", async () => {
    const homeDir = createTempHome();
    const sessionKey = "agent:main:telegram:direct:100000001";
    const { getMudSessionStore, registerModelRouteHook } = await loadModules(homeDir);
    getMudSessionStore().ensure(sessionKey);

    const captured = captureHook(registerModelRouteHook, { model: "example-deepseek/deepseek-flash" });
    const override = { providerOverride: "example-deepseek", modelOverride: "deepseek-flash" };
    // 同一逻辑回合（runId 相同）：首次覆盖，回退候选再进来不覆盖
    expect(captured.handler?.({}, { sessionKey, runId: "run-1" })).toEqual(override);
    expect(captured.handler?.({}, { sessionKey, runId: "run-1" })).toBeUndefined();
    expect(captured.handler?.({}, { sessionKey, runId: "run-1" })).toBeUndefined();
    // 下一个回合重新覆盖
    expect(captured.handler?.({}, { sessionKey, runId: "run-2" })).toEqual(override);
    // 没有 runId 的调用方保持每次覆盖
    expect(captured.handler?.({}, { sessionKey })).toEqual(override);
    expect(captured.handler?.({}, { sessionKey })).toEqual(override);
  });
  it("keeps an in-flight run's override record no matter how many other runs start (TTL, not count, prunes it)", async () => {
    const homeDir = createTempHome();
    const sessionKey = "agent:main:telegram:direct:100000001";
    const other = "agent:main:telegram:direct:100000002";
    const { getMudSessionStore, registerModelRouteHook } = await loadModules(homeDir);
    getMudSessionStore().ensure(sessionKey);
    getMudSessionStore().ensure(other);
    const captured = captureHook(registerModelRouteHook, { model: "example-deepseek/deepseek-flash" });
    const override = { providerOverride: "example-deepseek", modelOverride: "deepseek-flash" };
    expect(captured.handler?.({}, { sessionKey, runId: "slow-run" })).toEqual(override); // 配置模型长时间超时中
    for (let i = 0; i < 1000; i++) captured.handler?.({}, { sessionKey: other, runId: `noise-${i}` }); // 别的会话大量新 run
    expect(captured.handler?.({}, { sessionKey, runId: "slow-run" })).toBeUndefined(); // 回退候选进来：仍记得，放行
  });

  it("tracks overlapping runs of one session independently (user turn + settle turn interleaved)", async () => {
    const homeDir = createTempHome();
    const sessionKey = "agent:main:telegram:direct:100000001";
    const { getMudSessionStore, registerModelRouteHook } = await loadModules(homeDir);
    getMudSessionStore().ensure(sessionKey);
    const captured = captureHook(registerModelRouteHook, { model: "example-deepseek/deepseek-flash" });
    const override = { providerOverride: "example-deepseek", modelOverride: "deepseek-flash" };
    expect(captured.handler?.({}, { sessionKey, runId: "run-a" })).toEqual(override);
    expect(captured.handler?.({}, { sessionKey, runId: "run-b" })).toEqual(override);
    // run-a 的回退尝试：不能因为 run-b 插了一次就被当成首次
    expect(captured.handler?.({}, { sessionKey, runId: "run-a" })).toBeUndefined();
    expect(captured.handler?.({}, { sessionKey, runId: "run-b" })).toBeUndefined();
  });
});
