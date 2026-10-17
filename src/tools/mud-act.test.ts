import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, OpenClawToolDefinition, ToolResult } from "../core/types";

const QUIET_MS = 500;
const POLL_MS = 200;
const DRAIN_POLL_MS = 50;
const WAIT_MS = 2500;

async function loadAct(homeDir: string) {
  process.env.HOME = homeDir;
  vi.resetModules();
  const actModule = await import("./mud-act");
  const storeModule = await import("../storage/session-store");
  const sessionKeyModule = await import("../lib/session-key");
  return { ...actModule, ...storeModule, ...sessionKeyModule };
}

function resultText(result: ToolResult): string {
  const block = result.content[0];
  if (!block || block.type !== "text") {
    throw new Error(`expected text block, got ${JSON.stringify(result)}`);
  }
  return block.text;
}

function schemaDescription(parameters: Record<string, unknown>, name: string): string {
  const properties = parameters.properties;
  if (typeof properties !== "object" || properties === null) {
    throw new Error("tool parameters.properties is missing");
  }
  const prop = Object.getOwnPropertyDescriptor(properties, name)?.value;
  if (typeof prop !== "object" || prop === null) {
    throw new Error(`parameter ${name} is missing`);
  }
  const description = Object.getOwnPropertyDescriptor(prop, "description")?.value;
  if (typeof description !== "string") {
    throw new Error(`parameter ${name} has no description`);
  }
  return description;
}

function captureTool(register: (api: OpenClawPluginApi) => void): OpenClawToolDefinition {
  let def: OpenClawToolDefinition | undefined;
  register({
    registerTool(tool: OpenClawToolDefinition) {
      def = tool;
    },
  } as unknown as OpenClawPluginApi);
  if (!def) throw new Error("mud_act was not registered");
  return def;
}

// Armed before execute so this timer is queued ahead of the same-deadline poll sleep.
// Fake timers fire equal-delay timers in registration order; the line must already
// be on disk when the t=delay poll reads output.jsonl.
function scheduleOutputLine(outputFile: string, delayMs: number, text: string): void {
  setTimeout(() => {
    const line = `${JSON.stringify({ ts: new Date(Date.now() + 1).toISOString(), text })}\n`;
    fs.appendFileSync(outputFile, line);
  }, delayMs);
}

function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    promise.then(
      () => finish(true),
      () => finish(true),
    );
    queueMicrotask(() => finish(false));
  });
}

describe("mud_act quiet return", () => {
  const originalHome = process.env.HOME;
  const tempHomeDirs = new Set<string>();

  function createTempHome(): string {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-mud-act-"));
    tempHomeDirs.add(homeDir);
    return homeDir;
  }

  afterEach(() => {
    vi.useRealTimers();
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

  async function prepareSession() {
    const homeDir = createTempHome();
    const sessionKey = "agent:main:telegram:direct:100000001";
    const { getMudSessionStore, registerMudActTool, resolveSessionDir } = await loadAct(homeDir);
    const store = getMudSessionStore();
    store.ensure(sessionKey);
    const dir = resolveSessionDir(store, sessionKey);
    const outputFile = path.join(dir, "output.jsonl");
    const queueFile = path.join(dir, "send-queue.json");
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ server: { host: "example.com", port: 4000 } })); // 已初始化的会话
    fs.writeFileSync(outputFile, "");
    const def = captureTool(registerMudActTool);
    // 模拟守护进程消费队列：改写为 { items: [], drainedAt }（与 daemon.service drainQueue 一致，drainedAt 在 socket.write 之前记下）
    const drainQueue = () =>
      fs.writeFileSync(queueFile, JSON.stringify({ items: [], drainedAt: new Date().toISOString() }));
    const scheduleDrain = (delayMs: number) => setTimeout(drainQueue, delayMs);
    return { sessionKey, outputFile, queueFile, def, drainQueue, scheduleDrain };
  }

  it("rejects a never-initialized session key without creating its directory", async () => {
    const homeDir = createTempHome();
    const sessionKey = "agent:main:telegram:direct:100000099";
    const { getMudSessionStore, registerMudActTool, resolveSessionDir } = await loadAct(homeDir);
    const def = captureTool(registerMudActTool);
    const result = await def.execute("id", { sessionKey, commands: "look" });
    expect(resultText(result)).toContain("尚未初始化");
    expect(fs.existsSync(resolveSessionDir(getMudSessionStore(), sessionKey))).toBe(false);
    expect(getMudSessionStore().get(sessionKey)).toBeUndefined();
  });

  it("returns once output stays quiet after the first line, without waiting the full waitMs", async () => {
    const { sessionKey, outputFile, def, drainQueue } = await prepareSession();
    expect(def.name).toBe("mud_act");
    expect(schemaDescription(def.parameters, "waitMs")).toBe("最长等待毫秒数，默认 2500");
    expect(schemaDescription(def.parameters, "quietMs")).toBe("首批新输出到达后，再静默多少毫秒即返回，默认 500");

    vi.useFakeTimers();
    const line = "你向北走去。";
    scheduleOutputLine(outputFile, POLL_MS, line);
    const startedAt = Date.now();
    let resolvedAt = -1;
    const resultPromise = def.execute("id", { sessionKey, commands: "north" });
    drainQueue();
    const done = resultPromise.then((result) => {
      resolvedAt = Date.now();
      return resultText(result);
    });

    // 队列在 execute() 返回后才被消费，工具在下一次排水轮询（t=50）才看到；响应窗口从那一刻起算。
    await vi.advanceTimersByTimeAsync(DRAIN_POLL_MS + POLL_MS + QUIET_MS - 1);
    expect(await hasSettled(resultPromise)).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await hasSettled(resultPromise)).toBe(true);
    const text = await done;
    const elapsed = resolvedAt - startedAt;
    expect(elapsed).toBe(DRAIN_POLL_MS + POLL_MS + QUIET_MS);
    expect(elapsed).toBeLessThan(WAIT_MS);
    expect(text).toContain(line);
    expect(text).toContain("已发送: north");
    expect(text).toContain("=== 服务器响应 ===");
    expect(text).not.toContain("(暂无新输出)");
  });

  it("includes both bursts and returns about quietMs after the second line", async () => {
    const { sessionKey, outputFile, def, drainQueue } = await prepareSession();
    vi.useFakeTimers();
    const first = "你向北走去。";
    const second = "这里是大厅。";
    scheduleOutputLine(outputFile, 200, first);
    scheduleOutputLine(outputFile, 500, second);
    const startedAt = Date.now();
    let resolvedAt = -1;
    const resultPromise = def.execute("id", { sessionKey, commands: "north" });
    drainQueue();
    const done = resultPromise.then((result) => {
      resolvedAt = Date.now();
      return resultText(result);
    });

    // First-line quiet would have ended at t=700. The t=500 burst must extend it.
    await vi.advanceTimersByTimeAsync(700);
    expect(await hasSettled(resultPromise)).toBe(false);

    // Second line is written at t=500 and observed on the next poll (t=600).
    // Settlement is quietMs after that observation, within one POLL_MS of t=500+quietMs.
    await vi.advanceTimersByTimeAsync(500);
    expect(await hasSettled(resultPromise)).toBe(true);
    const text = await done;
    const elapsed = resolvedAt - startedAt;
    const secondLineAt = 500;
    expect(elapsed - secondLineAt).toBeGreaterThanOrEqual(QUIET_MS);
    expect(elapsed - secondLineAt).toBeLessThanOrEqual(QUIET_MS + POLL_MS);
    expect(elapsed).toBeLessThan(WAIT_MS);
    expect(text).toContain(first);
    expect(text).toContain(second);
  });

  it("keeps extending the quiet window while a capped (500-line) buffer keeps changing", async () => {
    const { sessionKey, outputFile, def, drainQueue } = await prepareSession();
    vi.useFakeTimers();
    // t=200：一次性写满 500 行（计数到顶）；之后每 100 ms 再来一行并裁回 500 行，计数不变但最新一行在变
    setTimeout(() => {
      const ts = new Date(Date.now() + 1).toISOString();
      fs.appendFileSync(
        outputFile,
        Array.from({ length: 500 }, (_, i) => `${JSON.stringify({ ts, text: `第${i}行` })}\n`).join(""),
      );
    }, 200);
    const appendTrimmed = (text: string) => {
      const kept = fs.readFileSync(outputFile, "utf8").trim().split("\n").slice(-499);
      kept.push(JSON.stringify({ ts: new Date(Date.now() + 1).toISOString(), text }));
      fs.writeFileSync(outputFile, `${kept.join("\n")}\n`);
    };
    for (let t = 300; t <= 1500; t += 100) setTimeout(() => appendTrimmed(`持续输出${t}`), t);
    const resultPromise = def.execute("id", { sessionKey, commands: "look" });
    drainQueue();
    const done = resultPromise.then(resultText);

    // 若只看计数，t=200 后计数卡在 500，t≈700 就会以“安静”返回；现在最新行一直在变，必须撑到流停止之后
    await vi.advanceTimersByTimeAsync(1400);
    expect(await hasSettled(resultPromise)).toBe(false);
    await vi.advanceTimersByTimeAsync(1200);
    expect(await hasSettled(resultPromise)).toBe(true);
    expect(await done).toContain("持续输出1500");
  });

  it("two requests enqueued in the same millisecond are tracked by request id, not by timestamp", async () => {
    const { sessionKey, outputFile, queueFile, def } = await prepareSession();
    vi.useFakeTimers(); // 假时钟下 Date.now() 不动：两次 execute 的 sentAt 完全相同
    const first = def.execute("a", { sessionKey, commands: "look" });
    const second = def.execute("b", { sessionKey, commands: "score" });
    const queued = JSON.parse(fs.readFileSync(queueFile, "utf8")).items as Array<{
      cmd: string;
      time: string;
      id: string;
    }>;
    expect(queued).toHaveLength(2);
    expect(queued[0].time).toBe(queued[1].time);
    expect(queued[0].id).not.toBe(queued[1].id);

    // daemon 只排水第一条（按 id 记派发时刻），第二条仍在队列里
    const firstId = queued[0].id;
    const drainedAt = new Date(Date.now() + 1).toISOString();
    fs.writeFileSync(
      queueFile,
      JSON.stringify({ items: queued.filter((i) => i.id !== firstId), drainedAt, drains: { [firstId]: drainedAt } }),
    );
    scheduleOutputLine(outputFile, DRAIN_POLL_MS + POLL_MS, "你看了看四周。");
    await vi.advanceTimersByTimeAsync(DRAIN_POLL_MS + POLL_MS + QUIET_MS + POLL_MS);
    expect(await hasSettled(first)).toBe(true); // 第一条按自己的 id 判定已派发，不等第二条
    expect(await hasSettled(second)).toBe(false); // 第二条仍 pending
    expect(resultText(await first)).toContain("你看了看四周。");
    await vi.advanceTimersByTimeAsync(WAIT_MS);
    expect(await hasSettled(second)).toBe(true);
  });

  it("falls back to the empty-output text only after waitMs when nothing new arrives", async () => {
    const { sessionKey, def } = await prepareSession();
    vi.useFakeTimers();
    const startedAt = Date.now();
    let resolvedAt = -1;
    const resultPromise = def.execute("id", { sessionKey, commands: "look" });
    const done = resultPromise.then((result) => {
      resolvedAt = Date.now();
      return resultText(result);
    });

    await vi.advanceTimersByTimeAsync(WAIT_MS - 1);
    expect(await hasSettled(resultPromise)).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await hasSettled(resultPromise)).toBe(true);
    const text = await done;
    expect(resolvedAt - startedAt).toBe(WAIT_MS);
    expect(text).toContain("(暂无新输出)");
    expect(text).toContain("未被守护进程发出");
    expect(text).toContain("已发送: look");
    expect(text).toContain("=== 服务器响应 ===");
  });

  it("ignores ambient output that arrives before the daemon drains the queue", async () => {
    const { sessionKey, outputFile, def, scheduleDrain } = await prepareSession();
    vi.useFakeTimers();
    const ambient = "【闲聊】某人：有人组队吗";
    const response = "你向北走去。";
    scheduleOutputLine(outputFile, 100, ambient); // 队列尚未被消费：环境消息
    scheduleDrain(300); // daemon 每 500 ms 才消费一次队列
    scheduleOutputLine(outputFile, 400, response);
    const startedAt = Date.now();
    let resolvedAt = -1;
    const resultPromise = def.execute("id", { sessionKey, commands: "north" });
    const done = resultPromise.then((result) => {
      resolvedAt = Date.now();
      return resultText(result);
    });

    // 环境消息不能启动静默窗口：若启动了，工具会在 t≈600 返回且没有响应行
    await vi.advanceTimersByTimeAsync(650);
    expect(await hasSettled(resultPromise)).toBe(false);

    await vi.advanceTimersByTimeAsync(600);
    expect(await hasSettled(resultPromise)).toBe(true);
    const text = await done;
    expect(resolvedAt - startedAt).toBeLessThan(WAIT_MS);
    expect(text).toContain(response);
    expect(text).not.toContain(ambient);
    expect(text).not.toContain("未被守护进程发出");
  });

  it("keeps a fast response that arrives between the daemon's dispatch and the next drain poll", async () => {
    const { sessionKey, outputFile, def, scheduleDrain } = await prepareSession();
    vi.useFakeTimers();
    const response = "你向北走去。";
    // daemon 在 t=300 派发（drainedAt=300），服务器 t=320 就回了；mud_act 要到 t=350 的轮询才看到排水。
    scheduleDrain(300);
    scheduleOutputLine(outputFile, 320, response);
    const resultPromise = def.execute("id", { sessionKey, commands: "north" });
    const done = resultPromise.then((result) => resultText(result));

    await vi.advanceTimersByTimeAsync(1500);
    expect(await hasSettled(resultPromise)).toBe(true);
    const text = await done;
    expect(text).toContain(response);
    expect(text).not.toContain("(暂无新输出)");
  });

  it("uses the per-request drain timestamp when a later batch was drained before we polled", async () => {
    const { sessionKey, outputFile, queueFile, def } = await prepareSession();
    vi.useFakeTimers();
    const response = "你向北走去。";
    const resultPromise = def.execute("id", { sessionKey, commands: "north" });
    const marker = JSON.parse(fs.readFileSync(queueFile, "utf8")).items[0].id as string; // daemon 按请求 id 记派发时刻
    // daemon 在 t=300 派发本请求、t=900 又派发了另一批：全局 drainedAt 已是后一批的，本请求的时刻在 drains 里
    setTimeout(() => {
      fs.writeFileSync(
        queueFile,
        JSON.stringify({
          items: [],
          drainedAt: new Date(Date.now() + 600).toISOString(),
          drains: { [marker]: new Date().toISOString() },
        }),
      );
    }, 300);
    scheduleOutputLine(outputFile, 400, response);
    const done = resultPromise.then((result) => resultText(result));
    await vi.advanceTimersByTimeAsync(2000);
    expect(await hasSettled(resultPromise)).toBe(true);
    expect(await done).toContain(response);
  });

  it("does not let ambient chat after the dispatch start the quiet window before the real response", async () => {
    const { sessionKey, outputFile, def, drainQueue } = await prepareSession();
    vi.useFakeTimers();
    const ambient = "【闲聊】某人：有人组队吗";
    const response = "你向北走去。";
    // 派发后 100 ms 服务器推了一句闲聊，真实响应 800 ms 才到；若闲聊启动了静默窗口，工具会在 ~600 ms 返回并漏掉响应。
    scheduleOutputLine(outputFile, 100, ambient);
    scheduleOutputLine(outputFile, 800, response);
    const resultPromise = def.execute("id", { sessionKey, commands: "north" });
    drainQueue();
    const done = resultPromise.then((result) => resultText(result));

    await vi.advanceTimersByTimeAsync(700);
    expect(await hasSettled(resultPromise)).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    expect(await hasSettled(resultPromise)).toBe(true);
    const text = await done;
    expect(text).toContain(response);
  });

  it("honors an explicit quietMs of 100", async () => {
    const { sessionKey, outputFile, def, drainQueue } = await prepareSession();
    vi.useFakeTimers();
    const line = "你打开了木门。";
    const quietMs = 100;
    scheduleOutputLine(outputFile, POLL_MS, line);
    const startedAt = Date.now();
    let resolvedAt = -1;
    const resultPromise = def.execute("id", { sessionKey, commands: "open door", quietMs });
    drainQueue();
    const done = resultPromise.then((result) => {
      resolvedAt = Date.now();
      return resultText(result);
    });

    await vi.advanceTimersByTimeAsync(DRAIN_POLL_MS + POLL_MS);
    expect(await hasSettled(resultPromise)).toBe(false);

    await vi.advanceTimersByTimeAsync(quietMs);
    expect(await hasSettled(resultPromise)).toBe(true);
    const text = await done;
    const elapsed = resolvedAt - startedAt;
    expect(elapsed - DRAIN_POLL_MS - POLL_MS).toBe(quietMs);
    expect(elapsed).toBeLessThan(WAIT_MS);
    expect(text).toContain(line);
  });
});
