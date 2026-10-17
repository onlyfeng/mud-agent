import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processStartTimeMs } from "../lib/dir-lock-contract.mjs";
import { acquireMigrationLockAsync } from "../lib/migration-lock-contract.mjs";
import { encodeSessionDirName } from "../lib/session-dir-name";
import { clearSessionDirCache, resolveSessionDir } from "../lib/session-key";
import { configureMudStorage, MudSessionStore } from "./session-store";

const tempRoots: string[] = [];

function createStore(): { root: string; store: MudSessionStore } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-session-store-"));
  tempRoots.push(root);
  configureMudStorage(root);
  clearSessionDirCache();
  return { root, store: new MudSessionStore() };
}

function encodeLegacyV1(sessionKey: string): string {
  return `v1_${Buffer.from(sessionKey, "utf8").toString("base64url")}`;
}

function writeRegistry(root: string, sessionKeys: string[]): string {
  const registryPath = path.join(root, "registry.json");
  const registry = Object.fromEntries(
    sessionKeys.map((sessionKey) => [sessionKey, { sessionKey, mode: "active", aliases: [] }]),
  );
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
  return registryPath;
}

function writeSessionMarker(dir: string, marker: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ marker }));
}

afterEach(() => {
  vi.restoreAllMocks();
  clearSessionDirCache();
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("MudSessionStore encoded session directories", () => {
  it("ensure() can migrate a v1 directory that appears after construction without self-deadlocking on the lock", () => {
    const { root, store } = createStore();
    const key = "agent:main:telegram:direct:100000002";
    writeSessionMarker(path.join(root, "sessions", encodeLegacyV1(key)), "late-v1");
    // ensure 持 registry 锁期间触发迁移，迁移再次申请同一把锁：必须可重入而不是 2 s 后超时
    expect(() => store.ensure(key)).not.toThrow();
    expect(fs.existsSync(path.join(root, "sessions", encodeSessionDirName(key), "state.json"))).toBe(true);
    expect(fs.readdirSync(root)).not.toContain(".migration.lock");
  });

  it("commits the registry before creating the session directory so a crash never leaves an ownerless directory", () => {
    const { root, store } = createStore();
    const key = "agent:main:telegram:direct:100000003";
    const encodedDir = path.join(root, "sessions", encodeSessionDirName(key));
    const realMkdir = fs.mkdirSync;
    const spy = vi.spyOn(fs, "mkdirSync").mockImplementation(((p: fs.PathLike, opts?: fs.MakeDirectoryOptions) => {
      if (String(p) === encodedDir) throw new Error("crash between registry commit and mkdir");
      return realMkdir(p, opts);
    }) as typeof fs.mkdirSync);
    try {
      expect(() => store.ensure(key)).toThrow(/crash between/);
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(encodedDir)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(root, "registry.json"), "utf8"))[key]?.sessionKey).toBe(key);
    expect(() => new MudSessionStore().ensure(key)).not.toThrow(); // 注册项在、目录不在：下次 ensure 补建，不会被判 missing-owner
    expect(fs.existsSync(encodedDir)).toBe(true);
  });

  it("drops a cached encoded path once its directory vanishes (normalize renamed it) and re-resolves", () => {
    const { root, store } = createStore();
    const key = "agent:main:telegram:direct:100000004";
    store.ensure(key);
    const encodedDir = resolveSessionDir(store, key);
    expect(fs.existsSync(encodedDir)).toBe(true);
    expect(resolveSessionDir(store, key)).toBe(encodedDir); // 命中 encoded 缓存

    fs.renameSync(encodedDir, path.join(root, "sessions", "moved-away")); // 模拟 normalize 把目录搬走
    const resolved = resolveSessionDir(store, key);
    expect(resolved).not.toBe("");
    expect(fs.existsSync(encodedDir)).toBe(false);
    expect(resolved).toBe(store.getSessionDataDir(key)); // 重新解析，不再返回已消失的路径之外的陈旧缓存
  });

  it("defers every v1 source of a canonical owner when any of them has a live process", () => {
    const { root, store } = createStore();
    const canonical = "agent:main:telegram:group:-100:topic:5555";
    const alias = "telegram:-100:5555";
    writeRegistry(root, [canonical]);
    store.registerAlias(canonical, alias);
    const aliasV1 = path.join(root, "sessions", encodeLegacyV1(alias)); // 活进程在这里
    const canonicalV1 = path.join(root, "sessions", encodeLegacyV1(canonical)); // 同一会话的另一个 v1 来源
    writeSessionMarker(aliasV1, "alias-live");
    writeSessionMarker(canonicalV1, "canonical-idle");
    const entry = path.join(root, "daemon-entry.js");
    fs.writeFileSync(entry, "setTimeout(() => {}, 60_000);\n");
    const child = spawn(process.execPath, [entry], { stdio: "ignore" });
    try {
      for (
        let i = 0;
        i < 50 &&
        !spawnSync("ps", ["-o", "command=", "-p", String(child.pid)], { encoding: "utf8" }).stdout.includes(
          "daemon-entry.js",
        );
        i++
      ) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      fs.writeFileSync(path.join(aliasV1, "mud-daemon.pid"), String(child.pid));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(new MudSessionStore().prepareSessionStorage()).toBe(false);
      } finally {
        warn.mockRestore();
      }
      expect(fs.existsSync(canonicalV1)).toBe(true); // 空闲的那个来源也不能先迁进 canonical v2
      expect(fs.existsSync(path.join(root, "sessions", encodeSessionDirName(canonical)))).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("does not shadow a deferred v1 directory that is encoded from a registered alias", () => {
    const { root, store } = createStore();
    const canonical = "agent:main:telegram:group:-100:topic:4321";
    const alias = "telegram:-100:4321";
    writeRegistry(root, [canonical]);
    store.registerAlias(canonical, alias);
    const aliasV1 = path.join(root, "sessions", encodeLegacyV1(alias));
    writeSessionMarker(aliasV1, "alias-v1");
    const entry = path.join(root, "daemon-entry.js");
    fs.writeFileSync(entry, "setTimeout(() => {}, 60_000);\n");
    const child = spawn(process.execPath, [entry], { stdio: "ignore" });
    try {
      for (
        let i = 0;
        i < 50 &&
        !spawnSync("ps", ["-o", "command=", "-p", String(child.pid)], { encoding: "utf8" }).stdout.includes(
          "daemon-entry.js",
        );
        i++
      ) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      fs.writeFileSync(path.join(aliasV1, "mud-daemon.pid"), String(child.pid));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        store.ensure(canonical);
      } finally {
        warn.mockRestore();
      }
      expect(fs.existsSync(path.join(root, "sessions", encodeSessionDirName(canonical)))).toBe(false); // 不建空 canonical v2
      expect(resolveSessionDir(store, canonical)).toBe(aliasV1);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("prefers the v1 source that holds the live session process over an idle sibling of the same session", () => {
    const { root, store } = createStore();
    const canonical = "agent:main:telegram:group:-100:topic:8888";
    const alias = "telegram:-100:8888";
    writeRegistry(root, [canonical]);
    store.registerAlias(canonical, alias);
    const canonicalV1 = path.join(root, "sessions", encodeLegacyV1(canonical)); // 空闲
    const aliasV1 = path.join(root, "sessions", encodeLegacyV1(alias)); // 活进程在这里
    writeSessionMarker(canonicalV1, "canonical-idle");
    writeSessionMarker(aliasV1, "alias-live");
    const entry = path.join(root, "daemon-entry.js");
    fs.writeFileSync(entry, "setTimeout(() => {}, 60_000);\n");
    const child = spawn(process.execPath, [entry], { stdio: "ignore" });
    try {
      for (
        let i = 0;
        i < 50 &&
        !spawnSync("ps", ["-o", "command=", "-p", String(child.pid)], { encoding: "utf8" }).stdout.includes(
          "daemon-entry.js",
        );
        i++
      ) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      fs.writeFileSync(path.join(aliasV1, "mud-daemon.pid"), String(child.pid));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(resolveSessionDir(store, canonical)).toBe(aliasV1); // 不是空闲的 canonical v1
      } finally {
        warn.mockRestore();
      }
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("re-resolves a cached deferred v1 directory once its session process is gone, so the migration finally runs", () => {
    const { root, store } = createStore();
    const canonical = "agent:main:telegram:group:-100:topic:7777";
    writeRegistry(root, [canonical]);
    const v1 = path.join(root, "sessions", encodeLegacyV1(canonical));
    writeSessionMarker(v1, "v1-live");
    const entry = path.join(root, "daemon-entry.js");
    fs.writeFileSync(entry, "setTimeout(() => {}, 60_000);\n");
    const child = spawn(process.execPath, [entry], { stdio: "ignore" });
    try {
      for (
        let i = 0;
        i < 50 &&
        !spawnSync("ps", ["-o", "command=", "-p", String(child.pid)], { encoding: "utf8" }).stdout.includes(
          "daemon-entry.js",
        );
        i++
      ) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      fs.writeFileSync(path.join(v1, "mud-daemon.pid"), String(child.pid));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(resolveSessionDir(store, canonical)).toBe(v1); // 活进程在：推迟迁移，按 v1 名字找到并缓存
        expect(resolveSessionDir(store, canonical)).toBe(v1); // 缓存命中
      } finally {
        warn.mockRestore();
      }
    } finally {
      child.kill("SIGKILL");
    }
    for (
      let i = 0;
      i < 50 &&
      spawnSync("ps", ["-o", "stat=", "-p", String(child.pid)], { encoding: "utf8" }).status === 0 &&
      !spawnSync("ps", ["-o", "stat=", "-p", String(child.pid)], { encoding: "utf8" })
        .stdout.trim()
        .startsWith("Z");
      i++
    ) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    fs.rmSync(path.join(v1, "mud-daemon.pid"));
    // 进程退出后：缓存失效 → 重新解析 → prepareSessionStorage 把 v1 迁成 v2
    const resolved = resolveSessionDir(store, canonical);
    expect(resolved).toBe(path.join(root, "sessions", encodeSessionDirName(canonical)));
    expect(fs.existsSync(v1)).toBe(false);
  });

  it("resolves an overlength (unencodable) unregistered key to a nonexistent path instead of throwing", () => {
    const { store } = createStore();
    const key = `agent:main:telegram:group:-1009000000000:topic:${"x".repeat(200)}`;
    const dir = resolveSessionDir(store, key);
    expect(fs.existsSync(dir)).toBe(false);
    expect(() => store.ensure(key)).toThrow(); // 真要注册它时才报错
  });

  it("ensureAsync waits for an async lock holder without blocking the event loop, then registers", async () => {
    const { root, store } = createStore();
    const key = "agent:main:telegram:group:-1009000000000:topic:77";
    const release = await acquireMigrationLockAsync(root, { timeoutMs: 2000, pollMs: 5 }); // 另一个 start 正在 launchDaemon 内持锁
    let settled = false;
    const pending = store.ensureAsync(key).then((s) => {
      settled = true;
      return s;
    });
    await new Promise((r) => setTimeout(r, 60)); // 事件循环仍在转：持锁者能继续工作
    expect(settled).toBe(false);
    release();
    const session = await pending;
    expect(session.sessionKey).toBe(key);
    expect(fs.existsSync(path.join(root, "sessions", encodeSessionDirName(key)))).toBe(true);
    expect(fs.existsSync(path.join(root, ".migration.lock.v2"))).toBe(false);
  });

  it("writes registry.json atomically and leaves no temp file or lock behind", () => {
    const { root, store } = createStore();
    store.ensure("agent:main:telegram:group:-1009000000000:topic:1");
    store.ensure("agent:main:telegram:group:-1009000000000:topic:2");
    const names = fs.readdirSync(root);
    expect(names.filter((n) => n.startsWith("registry.json.tmp-"))).toEqual([]);
    expect(names).not.toContain(".migration.lock");
    const reg = JSON.parse(fs.readFileSync(path.join(root, "registry.json"), "utf8"));
    expect(Object.keys(reg).sort()).toEqual([
      "agent:main:telegram:group:-1009000000000:topic:1",
      "agent:main:telegram:group:-1009000000000:topic:2",
    ]);
  });

  it("creates an encoded directory while the registry keeps the logical key", () => {
    const { store } = createStore();
    const key = "agent:main:telegram:direct:100000001";

    store.ensure(key);

    expect(fs.existsSync(store.getSessionDataDir(key))).toBe(true);
    expect(path.basename(store.getSessionDataDir(key))).toBe(encodeSessionDirName(key));
    const registry = JSON.parse(fs.readFileSync(store.getRegistryPath(), "utf8"));
    expect(registry[key].sessionKey).toBe(key);
    expect(store.get(key)?.sessionKey).toBe(key);
  });

  it("keeps formerly case-fold-colliding keys in separate v2 directories", () => {
    const { store } = createStore();

    store.ensure("AAG");
    store.ensure("AAa");
    const upperDir = store.getSessionDataDir("AAG");
    const mixedDir = store.getSessionDataDir("AAa");
    writeSessionMarker(upperDir, "upper");
    writeSessionMarker(mixedDir, "mixed");

    expect(path.basename(upperDir)).toBe("v2_414147");
    expect(path.basename(mixedDir)).toBe("v2_414161");
    expect(upperDir.toLowerCase()).not.toBe(mixedDir.toLowerCase());
    expect(JSON.parse(fs.readFileSync(path.join(upperDir, "state.json"), "utf8")).marker).toBe("upper");
    expect(JSON.parse(fs.readFileSync(path.join(mixedDir, "state.json"), "utf8")).marker).toBe("mixed");
  });

  it("migrates an unambiguous v1 directory to v2 before returning it", () => {
    const { root, store } = createStore();
    const key = "AAG";
    const legacyDir = path.join(root, "sessions", encodeLegacyV1(key));
    const v2Dir = path.join(root, "sessions", "v2_414147");
    writeRegistry(root, [key]);
    writeSessionMarker(legacyDir, "legacy");

    expect(store.getSessionDataDir(key)).toBe(v2Dir);
    expect(fs.existsSync(legacyDir)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(v2Dir, "state.json"), "utf8")).marker).toBe("legacy");
    expect(store.getSessionDataDir(key)).toBe(v2Dir);
  });

  it("migrates an unambiguous v1 directory during store initialization", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-session-store-"));
    tempRoots.push(root);
    configureMudStorage(root);
    clearSessionDirCache();
    const legacyDir = path.join(root, "sessions", encodeLegacyV1("AAG"));
    const v2Dir = path.join(root, "sessions", "v2_414147");
    writeRegistry(root, ["AAG"]);
    writeSessionMarker(legacyDir, "legacy");

    new MudSessionStore();

    expect(fs.existsSync(legacyDir)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(v2Dir, "state.json"), "utf8")).marker).toBe("legacy");
  });

  it("never touches the migration lock when there is nothing to migrate", () => {
    const { root, store } = createStore();
    writeRegistry(root, []);
    fs.mkdirSync(path.join(root, "sessions"), { recursive: true });

    // prepareSessionStorage() runs on every resolveSessionDir() call, ahead
    // of its own cache lookup -- it's the busiest path in the whole store.
    // A stale/foreign lock left behind here (e.g. by a crashed process from
    // an unrelated storage root sharing this test's temp dir layout by
    // coincidence) must never block or slow down a call that has no v1
    // directory to migrate in the first place.
    const lockDir = path.join(root, ".migration.lock");
    fs.mkdirSync(lockDir);

    const start = Date.now();
    expect(() => store.prepareSessionStorage()).not.toThrow();
    expect(Date.now() - start).toBeLessThan(100);

    // Untouched: this call must never have attempted to acquire it.
    expect(fs.existsSync(lockDir)).toBe(true);
  });

  it("blocks a concurrent migration attempt behind a stale lock instead of racing it", () => {
    const { root, store } = createStore();
    const key = "AAG";
    const legacyDir = path.join(root, "sessions", encodeLegacyV1(key));
    writeRegistry(root, [key]);
    writeSessionMarker(legacyDir, "legacy");

    // Simulate another live process holding the migration lock (one that raced
    // us here first). This process must wait it out and fail closed with a clear,
    // actionable error instead of proceeding as if it had exclusive access --
    // that's exactly the "check state, then act" gap that let a concurrent
    // migration and its rollback race on the same rename. (A lock whose owner
    // has died is reclaimed instead; see the dead-owner test below.)
    const lockDir = path.join(root, ".migration.lock.v2");
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, `owner-${process.pid}-${processStartTimeMs()}`), ""); // 活着的持锁者：pid + 真实启动时刻

    expect(() => store.prepareSessionStorage()).toThrow(/timed out waiting for session migration lock/);

    // A lock this process never acquired must not be removed by it, and no
    // partial migration should have happened while waiting.
    expect(fs.existsSync(lockDir)).toBe(true);
    expect(fs.existsSync(legacyDir)).toBe(true);
  });

  it("reclaims a migration lock whose owner process is dead and proceeds", () => {
    const { root, store } = createStore();
    const key = "AAG";
    const legacyDir = path.join(root, "sessions", encodeLegacyV1(key));
    writeRegistry(root, [key]);
    writeSessionMarker(legacyDir, "legacy");
    const lockDir = path.join(root, ".migration.lock.v2");
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, `owner-999999-${Date.now() - 60_000}`), "");

    expect(() => store.prepareSessionStorage()).not.toThrow(); // 持锁者已死：回收后完成迁移，不再要求人工删目录
    expect(fs.existsSync(lockDir)).toBe(false);
    expect(fs.existsSync(legacyDir)).toBe(false);
  });

  it("re-reads the registry under the migration lock so a session registered while waiting is not treated as ownerless", () => {
    const { root, store } = createStore();
    const key = "AAG";
    const legacyDir = path.join(root, "sessions", encodeLegacyV1(key));
    writeRegistry(root, [key]);
    writeSessionMarker(legacyDir, "legacy");
    const other = "agent:main:telegram:direct:100000009";
    const v2Stage = path.join(root, ".migration.lock.v2.stage-"); // v2 的暂存目录在持有任何锁之前创建：在这里插入等价于"拿锁之前"
    const realMkdir = fs.mkdirSync;
    // 拿到锁的瞬间模拟另一个进程刚刚完成的注册：它的目录已在，registry 也已更新，但调用方的快照是加锁前读的
    const spy = vi.spyOn(fs, "mkdirSync").mockImplementation(((p: fs.PathLike, opts?: fs.MakeDirectoryOptions) => {
      if (String(p).startsWith(v2Stage)) {
        spy.mockRestore();
        new MudSessionStore().ensure(other); // 另一个进程在我们拿到锁之前完成注册（自己加锁、释放）
      }
      return realMkdir(p, opts);
    }) as typeof fs.mkdirSync);
    try {
      expect(() => store.prepareSessionStorage()).not.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(legacyDir)).toBe(false);
    expect(store.get(other)?.sessionKey).toBe(other);
  });

  it("defers migrating a v1 directory that still has a live session process and migrates it once the process is gone", () => {
    const { root, store } = createStore();
    const key = "AAG";
    const legacyDir = path.join(root, "sessions", encodeLegacyV1(key));
    writeRegistry(root, [key]);
    writeSessionMarker(legacyDir, "legacy");
    const entry = path.join(root, "daemon-entry.js");
    fs.writeFileSync(entry, "setTimeout(() => {}, 60_000);\n");
    const child = spawn(process.execPath, [entry], { stdio: "ignore" }); // 旧版 daemon 还在这个目录里跑
    try {
      for (
        let i = 0;
        i < 50 &&
        !spawnSync("ps", ["-o", "command=", "-p", String(child.pid)], { encoding: "utf8" }).stdout.includes(
          "daemon-entry.js",
        );
        i++
      ) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      fs.writeFileSync(path.join(legacyDir, "mud-daemon.pid"), String(child.pid));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(store.prepareSessionStorage()).toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
      expect(fs.existsSync(legacyDir)).toBe(true); // 目录原地不动，进程继续可用
      expect(resolveSessionDir(store, key)).toBe(legacyDir); // 推迟期间仍按 v1 目录解析，钩子/工具能看到它的 config / PID
      store.ensure(key);
      expect(fs.existsSync(path.join(root, "sessions", encodeSessionDirName(key)))).toBe(false); // 不建空 v2 目录遮住活数据
    } finally {
      child.kill("SIGKILL");
    }
    fs.writeFileSync(path.join(legacyDir, "mud-daemon.pid"), "999999"); // 进程退出后
    new MudSessionStore(); // 构造时自动迁移
    expect(fs.existsSync(legacyDir)).toBe(false);
  });

  it("releases the migration lock after a successful migration", () => {
    const { root, store } = createStore();
    const key = "AAG";
    const legacyDir = path.join(root, "sessions", encodeLegacyV1(key));
    const v2Dir = path.join(root, "sessions", "v2_414147");
    writeRegistry(root, [key]);
    writeSessionMarker(legacyDir, "legacy");

    store.prepareSessionStorage();

    expect(fs.existsSync(path.join(root, ".migration.lock"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".migration.lock.v2"))).toBe(false);
    expect(fs.existsSync(legacyDir)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(v2Dir, "state.json"), "utf8")).marker).toBe("legacy");
  });

  it("fails closed when registry keys share one legacy case-fold path", () => {
    const { root, store } = createStore();
    const legacyDir = path.join(root, "sessions", encodeLegacyV1("AAG"));
    const registryPath = writeRegistry(root, ["AAG", "AAa"]);
    const registryBefore = fs.readFileSync(registryPath, "utf8");
    writeSessionMarker(legacyDir, "legacy");

    expect(() => store.getSessionDataDir("AAG")).toThrow(/legacy.*case-fold.*AAG.*AAa.*normalize:sessions/i);
    expect(fs.readFileSync(registryPath, "utf8")).toBe(registryBefore);
    expect(JSON.parse(fs.readFileSync(path.join(legacyDir, "state.json"), "utf8")).marker).toBe("legacy");
    expect(fs.existsSync(path.join(root, "sessions", "v2_414147"))).toBe(false);
    expect(fs.existsSync(path.join(root, "sessions", "v2_414161"))).toBe(false);
  });

  it("fails closed when two canonical sessions claim one legacy alias directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-session-store-"));
    tempRoots.push(root);
    configureMudStorage(root);
    clearSessionDirCache();
    const alias = "shared-alias";
    const legacyDir = path.join(root, "sessions", encodeLegacyV1(alias));
    fs.writeFileSync(
      path.join(root, "registry.json"),
      JSON.stringify({
        "session-one": { sessionKey: "session-one", mode: "active", aliases: [alias] },
        "session-two": { sessionKey: "session-two", mode: "active", aliases: [alias] },
      }),
    );
    writeSessionMarker(legacyDir, "shared");

    expect(() => new MudSessionStore()).toThrow(/legacy.*case-fold.*session-one.*session-two.*shared-alias/i);
    expect(JSON.parse(fs.readFileSync(path.join(legacyDir, "state.json"), "utf8")).marker).toBe("shared");
    expect(fs.existsSync(path.join(root, "sessions", encodeSessionDirName(alias)))).toBe(false);
  });

  it("fails closed when a v1 directory has no registry owner", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-session-store-"));
    tempRoots.push(root);
    configureMudStorage(root);
    clearSessionDirCache();
    const legacyDir = path.join(root, "sessions", encodeLegacyV1("AAG"));
    writeSessionMarker(legacyDir, "orphan");

    expect(() => new MudSessionStore()).toThrow(/legacy.*case-fold.*AAG.*no registry owner/i);
    expect(JSON.parse(fs.readFileSync(path.join(legacyDir, "state.json"), "utf8")).marker).toBe("orphan");
    expect(fs.existsSync(path.join(root, "sessions", "v2_414147"))).toBe(false);
  });

  it("fails closed when a literal raw v2-looking key collides with a decoded v2 key", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-session-store-"));
    tempRoots.push(root);
    configureMudStorage(root);
    clearSessionDirCache();
    const rawKey = "V2_61";
    const ambiguousDir = path.join(root, "sessions", rawKey);
    writeRegistry(root, [rawKey]);
    writeSessionMarker(ambiguousDir, "raw-v2-looking");

    expect(() => new MudSessionStore()).toThrow(/encoded.*case-fold.*V2_61.*a/i);
    expect(JSON.parse(fs.readFileSync(path.join(ambiguousDir, "state.json"), "utf8")).marker).toBe("raw-v2-looking");
    expect(fs.existsSync(path.join(root, "sessions", "v2_56325f3631"))).toBe(false);
  });

  it("fails closed when a noncanonical v2 case variant folds onto a valid v2 path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-session-store-"));
    tempRoots.push(root);
    configureMudStorage(root);
    clearSessionDirCache();
    const rawKey = "v2_6A";
    const ambiguousDir = path.join(root, "sessions", rawKey);
    writeRegistry(root, [rawKey]);
    writeSessionMarker(ambiguousDir, "case-variant");

    expect(() => new MudSessionStore()).toThrow(/encoded.*case-fold.*v2_6A.*j/i);
    expect(JSON.parse(fs.readFileSync(path.join(ambiguousDir, "state.json"), "utf8")).marker).toBe("case-variant");
  });

  it("rejects an uppercase v2 physical name even when its decoded key has an owner", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-session-store-"));
    tempRoots.push(root);
    configureMudStorage(root);
    clearSessionDirCache();
    const noncanonicalDir = path.join(root, "sessions", "V2_61");
    writeRegistry(root, ["a"]);
    writeSessionMarker(noncanonicalDir, "uppercase-v2");

    expect(() => new MudSessionStore()).toThrow(/encoded.*case-fold.*V2_61.*noncanonical/i);
    expect(JSON.parse(fs.readFileSync(path.join(noncanonicalDir, "state.json"), "utf8")).marker).toBe("uppercase-v2");
  });

  it("does not block reads on an ownerless canonical v2 stale-state directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-session-store-"));
    tempRoots.push(root);
    configureMudStorage(root);
    clearSessionDirCache();
    const staleDir = path.join(root, "sessions", encodeSessionDirName("stale-session"));
    writeSessionMarker(staleDir, "stale");

    const store = new MudSessionStore();

    expect(store.get("stale-session")).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(staleDir, "state.json"), "utf8")).marker).toBe("stale");
  });

  it("fails closed when a v1-looking raw key and decoded v1 key share one directory", () => {
    const { root, store } = createStore();
    const ambiguousDir = path.join(root, "sessions", "v1_YQ");
    writeRegistry(root, ["v1_YQ"]);
    writeSessionMarker(ambiguousDir, "ambiguous");

    expect(() => store.getSessionDataDir("v1_YQ")).toThrow(/legacy.*case-fold.*a.*v1_YQ.*normalize:sessions/i);
    expect(JSON.parse(fs.readFileSync(path.join(ambiguousDir, "state.json"), "utf8")).marker).toBe("ambiguous");
    expect(fs.existsSync(path.join(root, "sessions", "v2_61"))).toBe(false);
  });

  it("fails closed on invalid registry JSON before migrating v1 data", () => {
    const { root, store } = createStore();
    const registryPath = path.join(root, "registry.json");
    const legacyDir = path.join(root, "sessions", encodeLegacyV1("AAG"));
    fs.writeFileSync(registryPath, "{not-json");
    writeSessionMarker(legacyDir, "legacy");

    expect(() => store.getSessionDataDir("AAG")).toThrow(/registry.*JSON.*normalize:sessions/i);
    expect(fs.readFileSync(registryPath, "utf8")).toBe("{not-json");
    expect(JSON.parse(fs.readFileSync(path.join(legacyDir, "state.json"), "utf8")).marker).toBe("legacy");
    expect(fs.existsSync(path.join(root, "sessions", "v2_414147"))).toBe(false);
  });

  it("fails closed when a registry entry sessionKey drifts from its canonical key", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-session-store-"));
    tempRoots.push(root);
    configureMudStorage(root);
    clearSessionDirCache();
    const legacyDir = path.join(root, "sessions", encodeLegacyV1("B"));
    fs.writeFileSync(
      path.join(root, "registry.json"),
      JSON.stringify({ A: { sessionKey: "B", mode: "active", aliases: [] } }),
    );
    writeSessionMarker(legacyDir, "wrong-owner");

    expect(() => new MudSessionStore()).toThrow(/registry entry.*A.*sessionKey.*B.*normalize:sessions/i);
    expect(JSON.parse(fs.readFileSync(path.join(legacyDir, "state.json"), "utf8")).marker).toBe("wrong-owner");
    expect(fs.existsSync(path.join(root, "sessions", encodeSessionDirName("B")))).toBe(false);
  });

  it("fails closed when both a legacy v1 source and v2 destination exist", () => {
    const { root, store } = createStore();
    const legacyDir = path.join(root, "sessions", encodeLegacyV1("AAG"));
    const v2Dir = path.join(root, "sessions", "v2_414147");
    writeRegistry(root, ["AAG"]);
    writeSessionMarker(legacyDir, "legacy");
    writeSessionMarker(v2Dir, "v2");

    expect(() => store.getSessionDataDir("AAG")).toThrow(/legacy v1.*v2.*normalize:sessions/i);
    expect(JSON.parse(fs.readFileSync(path.join(legacyDir, "state.json"), "utf8")).marker).toBe("legacy");
    expect(JSON.parse(fs.readFileSync(path.join(v2Dir, "state.json"), "utf8")).marker).toBe("v2");
  });

  it("keeps alias APIs logical while resolving them to the encoded canonical directory", () => {
    const { store } = createStore();
    const canonical = "agent:main:telegram:group:-1009000000000:topic:1";
    const alias = "telegram:-1009000000000:1";

    store.ensure(alias);

    expect(store.getCanonicalSessionKey(alias)).toBe(canonical);
    expect(resolveSessionDir(store, alias)).toBe(store.getSessionDataDir(canonical));
  });

  it("resolveSessionDir skips prepareSessionStorage() entirely on a cache hit", () => {
    const { store } = createStore();
    const key = "AAG";
    store.ensure(key);

    // First call resolves through the "encoded" branch and populates the
    // module-level cache -- that branch is terminal, no future migration
    // can change what this key resolves to.
    const first = resolveSessionDir(store, key);
    expect(fs.existsSync(first)).toBe(true);

    // Corrupt the registry so any *fresh* read of it -- i.e. a real call to
    // prepareSessionStorage() -- would throw. A cache-hit lookup must never
    // reach that code path at all, so this must not throw.
    fs.writeFileSync(store.getRegistryPath(), "not valid json");

    expect(() => resolveSessionDir(store, key)).not.toThrow();
    expect(resolveSessionDir(store, key)).toBe(first);
  });

  it("re-resolves a not-yet-materialized key to its canonical dir once registerAlias() links it, across any number of processes", () => {
    const { store } = createStore();
    const canonicalKey = "some-canonical-session";
    const aliasKey = "totally-unrelated-alias-name";

    store.ensure(canonicalKey);
    const canonicalDir = store.getSessionDataDir(canonicalKey);

    // Nothing links aliasKey to canonicalKey yet, so resolveSessionDir()
    // resolves (and caches, via the fallback branch) its own standalone,
    // not-yet-existing path.
    const beforeAlias = resolveSessionDir(store, aliasKey);
    expect(beforeAlias).not.toBe(canonicalDir);

    store.registerAlias(canonicalKey, aliasKey);

    // registerAlias() actually changed aliasKey's registration, so it wrote
    // the registry -- resolveSessionDir() must notice registry.json's
    // content changed and re-resolve instead of trusting the earlier cached
    // guess. See the comment in resolveSessionDir() for why comparing the
    // registry's own content (not an in-memory-only signal) is what makes
    // this correct across processes too.
    expect(resolveSessionDir(store, aliasKey)).toBe(canonicalDir);
  });

  it("does not tag a stale fallback guess as fresh when the registry changes mid-resolution (cross-process TOCTOU)", () => {
    const { store } = createStore();
    const canonicalKey = "some-canonical-session";
    const aliasKey = "totally-unrelated-alias-name";

    store.ensure(canonicalKey);
    const canonicalDir = store.getSessionDataDir(canonicalKey);

    // Simulate another process linking aliasKey to canonicalKey WHILE this
    // process's own resolveSessionDir(aliasKey) call is already underway --
    // after it has read the registry and found aliasKey unaliased (so it's
    // about to fall back to its own standalone guess), but before that call
    // finishes and caches the result. getCanonicalSessionKey() is the read
    // resolveSessionDir() uses to make that determination, so firing the
    // "concurrent" write right after it returns reproduces the race
    // regardless of exactly how resolveSessionDir() is internally ordered.
    const originalGetCanonical = store.getCanonicalSessionKey.bind(store);
    const getCanonicalSpy = vi.spyOn(store, "getCanonicalSessionKey").mockImplementationOnce((key: string) => {
      const result = originalGetCanonical(key);
      store.registerAlias(canonicalKey, aliasKey);
      return result;
    });

    const first = resolveSessionDir(store, aliasKey);
    expect(first).not.toBe(canonicalDir);
    getCanonicalSpy.mockRestore();

    // The registry changed during that call. If the cached guess got
    // stamped with content read *after* the concurrent write (i.e. already
    // reflecting it), this lookup would wrongly see "unchanged since
    // caching" and keep returning the stale standalone guess forever. It
    // must instead detect the change and re-resolve to the now-correct,
    // aliased answer.
    expect(resolveSessionDir(store, aliasKey)).toBe(canonicalDir);
  });

  it("stays correct even when two registry writes land with an identical mtime (coarse filesystem clock)", () => {
    const { store } = createStore();
    const canonicalKey = "some-canonical-session";
    const aliasKey = "totally-unrelated-alias-name";

    store.ensure(canonicalKey);
    const canonicalDir = store.getSessionDataDir(canonicalKey);

    // Pin registry.json's mtime to an identical value across the write
    // below, simulating a filesystem clock too coarse to tell the pre-write
    // and post-write states apart (e.g. one-second resolution, two writes in
    // the same tick) -- a real, not-hypothetical scenario under the rapid,
    // repeated writes this cache lives alongside. Any mechanism keyed off
    // mtime would see "unchanged" both before and after registerAlias() and
    // wrongly trust the stale cached guess forever; comparing the registry's
    // own content must not depend on the clock at all.
    const pinnedTime = new Date(0);
    fs.utimesSync(store.getRegistryPath(), pinnedTime, pinnedTime);

    const fallbackBefore = resolveSessionDir(store, aliasKey);
    expect(fallbackBefore).not.toBe(canonicalDir);
    expect(fs.statSync(store.getRegistryPath()).mtimeMs).toBe(pinnedTime.getTime());

    store.registerAlias(canonicalKey, aliasKey);
    fs.utimesSync(store.getRegistryPath(), pinnedTime, pinnedTime);
    expect(fs.statSync(store.getRegistryPath()).mtimeMs).toBe(pinnedTime.getTime());

    expect(resolveSessionDir(store, aliasKey)).toBe(canonicalDir);
  });

  it("detects a registry change made without going through any sidecar coordination file (cross-version compatibility)", () => {
    const { store } = createStore();
    const canonicalKey = "some-canonical-session";
    const aliasKey = "totally-unrelated-alias-name";

    store.ensure(canonicalKey);
    const canonicalDir = store.getSessionDataDir(canonicalKey);

    const fallbackBefore = resolveSessionDir(store, aliasKey);
    expect(fallbackBefore).not.toBe(canonicalDir);

    // Two designs tried before this one used a separate coordination file
    // (registry.json's mtime; later a dedicated counter/token sidecar file)
    // as the cache-invalidation signal. Both meant an old process and a new
    // one -- e.g. briefly overlapping during a rolling restart -- had to
    // agree on a protocol version to detect each other's writes; a sidecar
    // file the old process never touches (or misreads in a different
    // format) breaks that silently. Simulate a write from *some* process --
    // it doesn't matter which version, or whether it goes through
    // registerAlias() at all -- that only ever produces the one thing every
    // version of this code has always produced: registry.json itself, in
    // its ordinary JSON shape.
    const registry = JSON.parse(fs.readFileSync(store.getRegistryPath(), "utf8"));
    registry[canonicalKey].aliases = [...registry[canonicalKey].aliases, aliasKey].sort();
    fs.writeFileSync(store.getRegistryPath(), JSON.stringify(registry, null, 2));

    expect(resolveSessionDir(store, aliasKey)).toBe(canonicalDir);
  });

  it("re-resolves once a v1 legacy directory appears for an already fallback-cached key, even though registry.json never changes", () => {
    const { root, store } = createStore();
    const key = "some-session-key";

    // Give key a registry entry (so migration below has a valid owner to
    // migrate the legacy directory to) without materializing its v2
    // directory -- registerAlias() never creates directories, only
    // ensure() does.
    store.registerAlias(key, "some-alias-of-key");

    // Nothing has a directory yet -- falls through to the fallback branch,
    // caches the (not-yet-existing) standalone v2 path. registry.json's
    // content at this point never changes again below.
    const before = resolveSessionDir(store, key);
    expect(fs.existsSync(before)).toBe(false);

    // Real prior session data shows up as a v1 legacy directory for this
    // exact key -- e.g. another process performing a migration, or a data
    // volume becoming available after this process's cache was already
    // warm. This is a pure filesystem change: it never touches
    // registry.json, so content-based staleness detection alone cannot see
    // it.
    const legacyDir = path.join(root, "sessions", encodeLegacyV1(key));
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "state.json"), JSON.stringify({ marker: "real-prior-data" }));

    // Must re-resolve for real -- which migrates the legacy directory to
    // its v2 destination -- rather than trusting the cached guess. If it
    // trusted the cache, it would return the *same path string* the
    // migration would eventually use (both are computed the same way), but
    // the migration itself would not actually have run yet: the caller
    // would read from an empty directory while the real data sat
    // unreachable in the un-migrated v1 directory.
    const after = resolveSessionDir(store, key);
    expect(after).toBe(before);
    expect(fs.existsSync(legacyDir)).toBe(false);
    expect(fs.readFileSync(path.join(after, "state.json"), "utf8")).toContain("real-prior-data");
  });

  it("re-resolves once a raw, unencoded legacy alias directory appears for an already fallback-cached key (not a v1-prefixed directory)", () => {
    const { root, store } = createStore();
    const key = "raw-legacy-key";

    // Give key a registry entry without materializing its v2 directory, same
    // as the v1 case above.
    store.registerAlias(key, "some-alias-of-key");

    const before = resolveSessionDir(store, key);
    expect(fs.existsSync(before)).toBe(false);

    // A directory literally named the raw session key appears -- the even
    // older, pre-v1 naming scheme resolveSessionDir()'s candidate loop
    // still reads directly via getLegacySessionDir(), for names like
    // listLegacySessionAliases() derives. parseSessionDirName() does not
    // recognize this as "v1" at all (it isn't v1_<base64url>-shaped), so a
    // freshness check that only looks for v1-prefixed entries -- as an
    // earlier revision of this fix did -- would miss it and keep returning
    // the stale, empty fallback path forever.
    const rawLegacyDir = path.join(root, "sessions", key);
    fs.mkdirSync(rawLegacyDir, { recursive: true });
    fs.writeFileSync(path.join(rawLegacyDir, "state.json"), JSON.stringify({ marker: "real-prior-data" }));

    const after = resolveSessionDir(store, key);
    expect(after).toBe(rawLegacyDir);
    expect(fs.readFileSync(path.join(after, "state.json"), "utf8")).toContain("real-prior-data");
  });

  it("re-resolves when a name slot that was a plain file at cache time becomes a real v1 directory (name-only freshness check regression)", () => {
    const { root, store } = createStore();
    const key = "some-session-key";
    const v1Path = path.join(root, "sessions", encodeLegacyV1(key));

    store.registerAlias(key, "some-alias-of-key");

    // A plain file -- not a directory -- already occupies the exact name a
    // v1 legacy directory for this key would use (a stray leftover, a
    // failed migration's partial artifact, anything). It isn't a directory,
    // so it doesn't affect resolution or count as a pending migration.
    fs.mkdirSync(path.dirname(v1Path), { recursive: true });
    fs.writeFileSync(v1Path, "not a directory");

    const before = resolveSessionDir(store, key);
    expect(fs.existsSync(before)).toBe(false);

    // The file is replaced by a real v1 directory holding real data -- two
    // separate filesystem operations (remove the file, create the
    // directory), but readdirSync() returns the exact same *name* before
    // and after if only names, not entry types, are compared. A freshness
    // check keyed on names alone would see "unchanged" and keep returning
    // the stale, empty fallback path forever, even though this is exactly
    // the transition hasLegacySessionDirEntries() (type-aware, via
    // entry.isDirectory()) treats as a real migration candidate.
    fs.rmSync(v1Path);
    fs.mkdirSync(v1Path, { recursive: true });
    fs.writeFileSync(path.join(v1Path, "state.json"), JSON.stringify({ marker: "real-prior-data" }));

    const after = resolveSessionDir(store, key);
    expect(after).toBe(before);
    expect(fs.existsSync(v1Path)).toBe(false);
    expect(fs.readFileSync(path.join(after, "state.json"), "utf8")).toContain("real-prior-data");
  });

  it("getSessionsDirSnapshot() does not collide when an entry name embeds the encoding's own separator characters", () => {
    const { root, store } = createStore();
    const sessionsDir = path.join(root, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Two directory *states* that a naive "type:name" strings joined by
    // "\n" encoding (an earlier revision of this exact snapshot) would
    // format identically: one entry named "foo\nf:bar" (a directory) vs.
    // two separate entries "foo" (a directory) and "bar" (a file). A
    // literal newline -- or ":" -- in a directory name is not legal on
    // every platform this codebase supports (Windows forbids both, plus
    // several other characters; see 7cd239d for the Windows-safe session
    // directory encoding that exists for exactly this kind of platform
    // gap), so this is verified against synthetic readdirSync() results
    // instead of an actual directory on disk -- keeping the test itself
    // portable regardless of what names the real filesystem would accept.
    const fakeDirent = (name: string, isDirectory: boolean) =>
      ({ name, isDirectory: () => isDirectory }) as unknown as fs.Dirent;
    const readdirSpy = vi.spyOn(fs, "readdirSync");

    readdirSpy.mockReturnValueOnce([fakeDirent("foo\nf:bar", true)] as unknown as ReturnType<typeof fs.readdirSync>);
    const snapshotOneEntry = store.getSessionsDirSnapshot();

    readdirSpy.mockReturnValueOnce([fakeDirent("foo", true), fakeDirent("bar", false)] as unknown as ReturnType<
      typeof fs.readdirSync
    >);
    const snapshotTwoEntries = store.getSessionsDirSnapshot();

    // These are genuinely different directory states -- one entry vs. two
    // -- so their snapshots must differ, or a transition between them (a
    // real, if unusual, migration/cleanup scenario) would be silently
    // invisible to the staleness check this snapshot exists to drive.
    expect(snapshotOneEntry).not.toBe(snapshotTwoEntries);
  });

  it("resolveSessionDir's fallback branch stays a cheap cache hit across repeated calls while the registry is unchanged", () => {
    const { store } = createStore();
    const key = "never-activated-topic";

    // Gate 1 in session-mode.ts calls this on every message for every Topic,
    // including ones that never ran /mud start -- this must stay O(1) after
    // the first call, not just for materialized sessions.
    const first = resolveSessionDir(store, key);
    expect(fs.existsSync(first)).toBe(false);

    const prepareSpy = vi.spyOn(store, "prepareSessionStorage");
    expect(resolveSessionDir(store, key)).toBe(first);
    expect(resolveSessionDir(store, key)).toBe(first);
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it("a repeated idempotent ensure() does not write the registry, so it never disturbs another session's cached fallback lookup", () => {
    const { store } = createStore();
    const keyA = "active-session";
    const keyB = "never-activated-topic";

    store.ensure(keyA);
    const fallbackB = resolveSessionDir(store, keyB);
    expect(fs.existsSync(fallbackB)).toBe(false);

    // ensure() runs on essentially every tool call for keyA while it's being
    // actively played, almost always idempotently (already registered, no
    // new alias). None of these repeats may write registry.json -- a write
    // changes its content, which is the exact signal resolveSessionDir()
    // uses to decide whether keyB's unrelated cached fallback guess is
    // still valid.
    const registryPath = store.getRegistryPath();
    const writeSpy = vi.spyOn(fs, "writeFileSync");
    store.ensure(keyA);
    store.ensure(keyA);
    store.ensure(keyA);
    expect(writeSpy.mock.calls.some((call) => call[0] === registryPath)).toBe(false);

    const prepareSpy = vi.spyOn(store, "prepareSessionStorage");
    expect(resolveSessionDir(store, keyB)).toBe(fallbackB);
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it("ensure() on an already-registered session leaves other sessions' cached hot-path lookups untouched", () => {
    const { store } = createStore();
    const keyA = "session-a";
    const keyB = "session-b";
    store.ensure(keyA);
    store.ensure(keyB);

    // Both resolve through the "encoded" branch and get cached, since both
    // now have a materialized directory.
    const dirA = resolveSessionDir(store, keyA);
    const dirB = resolveSessionDir(store, keyB);
    expect(fs.existsSync(dirA)).toBe(true);
    expect(fs.existsSync(dirB)).toBe(true);

    // ensure() is called on every tool invocation, usually idempotently (the
    // session already exists, with no new aliases to add). Repeating it for
    // keyA must not blow away keyB's unrelated, still-valid cache entry --
    // otherwise every idempotent ensure() call defeats the cache for every
    // OTHER session too, not just the one it's called with.
    store.ensure(keyA);

    // Corrupt the registry so a fresh read (i.e. a real prepareSessionStorage()
    // call) would throw -- a genuine cache hit for keyB must never reach it.
    fs.writeFileSync(store.getRegistryPath(), "not valid json");
    expect(() => resolveSessionDir(store, keyB)).not.toThrow();
    expect(resolveSessionDir(store, keyB)).toBe(dirB);
  });

  it("rejects assigning one logical alias to two canonical sessions", () => {
    const { store } = createStore();
    store.ensure("session-one");
    store.ensure("session-two");
    store.registerAlias("session-one", "shared-alias");
    const registryBefore = fs.readFileSync(store.getRegistryPath(), "utf8");

    expect(() => store.registerAlias("session-two", "shared-alias")).toThrow(
      /registry.*shared-alias.*session-one.*session-two/i,
    );
    expect(fs.readFileSync(store.getRegistryPath(), "utf8")).toBe(registryBefore);
    expect(store.getCanonicalSessionKey("shared-alias")).toBe("session-one");
  });

  it("rejects routing-equivalent aliases assigned to different canonical sessions", () => {
    const { store } = createStore();
    store.ensure("session-one");
    store.ensure("session-two");
    store.registerAlias("session-one", "topic:1");
    const registryBefore = fs.readFileSync(store.getRegistryPath(), "utf8");

    expect(() => store.registerAlias("session-two", "topic-1")).toThrow(/registry.*topic-1.*session-one.*session-two/i);
    expect(fs.readFileSync(store.getRegistryPath(), "utf8")).toBe(registryBefore);
    expect(store.getCanonicalSessionKey("topic-1")).toBe("session-one");
  });

  it("fails closed before registerAlias can shadow a raw alias directory", () => {
    const { root, store } = createStore();
    const canonical = "canonical-with-raw-alias";
    const alias = "legacy-raw-alias";
    store.ensure(canonical);
    const registryBefore = fs.readFileSync(store.getRegistryPath(), "utf8");
    const canonicalV2Dir = store.getSessionDataDir(canonical);
    const aliasDir = path.join(root, "sessions", alias);
    writeSessionMarker(aliasDir, "raw-alias-live");

    expect(() => store.registerAlias(canonical, alias)).toThrow(
      /legacy fallback directory.*legacy-raw-alias.*normalize:sessions/i,
    );
    expect(JSON.parse(fs.readFileSync(path.join(aliasDir, "state.json"), "utf8")).marker).toBe("raw-alias-live");
    expect(fs.existsSync(canonicalV2Dir)).toBe(true);
    expect(fs.readFileSync(store.getRegistryPath(), "utf8")).toBe(registryBefore);
    expect(store.getCanonicalSessionKey(alias)).toBe(alias);
  });

  it("fails closed before registerAlias can shadow an alias v2 directory", () => {
    const { root, store } = createStore();
    const canonical = "canonical-with-v2-alias";
    const alias = "legacy-v2-alias";
    store.ensure(canonical);
    const registryBefore = fs.readFileSync(store.getRegistryPath(), "utf8");
    const canonicalV2Dir = store.getSessionDataDir(canonical);
    const aliasV2Dir = path.join(root, "sessions", encodeSessionDirName(alias));
    writeSessionMarker(aliasV2Dir, "v2-alias-live");

    expect(() => store.registerAlias(canonical, alias)).toThrow(/legacy fallback directory.*v2_.*normalize:sessions/i);
    expect(JSON.parse(fs.readFileSync(path.join(aliasV2Dir, "state.json"), "utf8")).marker).toBe("v2-alias-live");
    expect(fs.existsSync(canonicalV2Dir)).toBe(true);
    expect(fs.readFileSync(store.getRegistryPath(), "utf8")).toBe(registryBefore);
    expect(store.getCanonicalSessionKey(alias)).toBe(alias);
  });

  it("rejects an alias that impersonates another session's encoded directory", () => {
    const { store } = createStore();
    store.ensure("a");
    store.ensure("session-two");
    const registryBefore = fs.readFileSync(store.getRegistryPath(), "utf8");

    expect(() => store.registerAlias("session-two", "v2_61")).toThrow(/encoded.*case-fold.*a.*session-two.*v2_61/i);
    expect(fs.readFileSync(store.getRegistryPath(), "utf8")).toBe(registryBefore);
    expect(store.getCanonicalSessionKey("v2_61")).toBe("v2_61");
  });

  it("rejects creating a directory already impersonated by another session alias", () => {
    const { root, store } = createStore();
    store.ensure("session-two");
    store.registerAlias("session-two", "v2_61");
    const registryBefore = fs.readFileSync(store.getRegistryPath(), "utf8");
    const plannedDir = path.join(root, "sessions", encodeSessionDirName("a"));

    expect(() => store.ensure("a")).toThrow(/encoded.*case-fold.*a.*session-two.*v2_61/i);
    expect(fs.readFileSync(store.getRegistryPath(), "utf8")).toBe(registryBefore);
    expect(fs.existsSync(plannedDir)).toBe(false);
  });

  it("does not migrate v1 when its planned v2 destination is impersonated by an alias", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-session-store-"));
    tempRoots.push(root);
    configureMudStorage(root);
    clearSessionDirCache();
    const legacyDir = path.join(root, "sessions", encodeLegacyV1("a"));
    const plannedDir = path.join(root, "sessions", encodeSessionDirName("a"));
    fs.writeFileSync(
      path.join(root, "registry.json"),
      JSON.stringify({
        a: { sessionKey: "a", mode: "active", aliases: [] },
        "session-two": { sessionKey: "session-two", mode: "active", aliases: ["v2_61"] },
      }),
    );
    writeSessionMarker(legacyDir, "legacy");

    expect(() => new MudSessionStore()).toThrow(/encoded.*case-fold.*a.*session-two.*v2_61/i);
    expect(JSON.parse(fs.readFileSync(path.join(legacyDir, "state.json"), "utf8")).marker).toBe("legacy");
    expect(fs.existsSync(plannedDir)).toBe(false);
  });

  it.runIf(process.platform !== "win32")("reads a raw-colon legacy directory when no encoded directory exists", () => {
    const { root, store } = createStore();
    const key = "agent:main:telegram:direct:100000001";
    const legacyDir = path.join(root, "sessions", key);
    fs.mkdirSync(legacyDir, { recursive: true });

    expect(resolveSessionDir(store, key)).toBe(legacyDir);
  });

  it.runIf(process.platform !== "win32")("prefers an encoded directory over a raw-colon legacy directory", () => {
    const { root, store } = createStore();
    const key = "agent:main:telegram:direct:100000001";
    const legacyDir = path.join(root, "sessions", key);
    const encodedDir = path.join(root, "sessions", encodeSessionDirName(key));
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.mkdirSync(encodedDir, { recursive: true });

    expect(resolveSessionDir(store, key)).toBe(encodedDir);
  });

  it("reads a safe raw alias when the registered alias is too long for v2 encoding", () => {
    const { root, store } = createStore();
    const canonical = "canonical-with-long-legacy-alias";
    const alias = "a".repeat(119);
    store.ensure(canonical);
    const canonicalDir = store.getSessionDataDir(canonical);
    store.registerAlias(canonical, alias);
    fs.rmSync(canonicalDir, { recursive: true });
    const rawAliasDir = path.join(root, "sessions", alias);
    writeSessionMarker(rawAliasDir, "long-raw-alias-live");
    clearSessionDirCache();

    expect(resolveSessionDir(store, canonical)).toBe(rawAliasDir);
    expect(JSON.parse(fs.readFileSync(path.join(rawAliasDir, "state.json"), "utf8")).marker).toBe(
      "long-raw-alias-live",
    );
  });

  it("fails closed before ensure can shadow a raw canonical directory", () => {
    const { root, store } = createStore();
    const key = "topic-legacy";
    const legacyDir = path.join(root, "sessions", key);
    const encodedDir = path.join(root, "sessions", encodeSessionDirName(key));
    writeSessionMarker(legacyDir, "legacy-live");

    expect(resolveSessionDir(store, key)).toBe(legacyDir);
    expect(() => store.ensure(key)).toThrow(/legacy fallback directory.*normalize:sessions/i);
    expect(JSON.parse(fs.readFileSync(path.join(legacyDir, "state.json"), "utf8")).marker).toBe("legacy-live");
    expect(fs.existsSync(encodedDir)).toBe(false);
    expect(fs.existsSync(store.getRegistryPath())).toBe(false);
  });

  it("fails closed before ensure can shadow a registered alias directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-session-store-"));
    tempRoots.push(root);
    configureMudStorage(root);
    clearSessionDirCache();
    const canonical = "agent:main:telegram:group:-100:topic:1";
    const alias = "topic-1";
    const registryPath = path.join(root, "registry.json");
    writeRegistry(root, [canonical]);
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    registry[canonical].aliases = [alias];
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
    const registryBefore = fs.readFileSync(registryPath, "utf8");
    const aliasDir = path.join(root, "sessions", alias);
    const canonicalV2Dir = path.join(root, "sessions", encodeSessionDirName(canonical));
    writeSessionMarker(aliasDir, "alias-live");
    const store = new MudSessionStore();

    expect(() => store.ensure(canonical)).toThrow(/legacy fallback directory.*topic-1.*normalize:sessions/i);
    expect(JSON.parse(fs.readFileSync(path.join(aliasDir, "state.json"), "utf8")).marker).toBe("alias-live");
    expect(fs.existsSync(canonicalV2Dir)).toBe(false);
    expect(fs.readFileSync(registryPath, "utf8")).toBe(registryBefore);
  });

  it("migrates a v1 alias directory into the canonical v2 slot, not a stray alias slot", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-session-store-"));
    tempRoots.push(root);
    configureMudStorage(root);
    clearSessionDirCache();
    const canonical = "agent:main:telegram:group:-100:topic:1";
    const alias = "topic-1";
    fs.writeFileSync(
      path.join(root, "registry.json"),
      JSON.stringify({
        [canonical]: { sessionKey: canonical, mode: "active", aliases: [alias] },
      }),
    );
    const legacyAliasDir = path.join(root, "sessions", encodeLegacyV1(alias));
    const canonicalV2Dir = path.join(root, "sessions", encodeSessionDirName(canonical));
    const wrongV2AliasDir = path.join(root, "sessions", encodeSessionDirName(alias));
    writeSessionMarker(legacyAliasDir, "alias");

    const store = new MudSessionStore();

    // Regression guard: migrating by encoding the alias (instead of the
    // canonical key) would have created this directory, which
    // ensure()/resolveSessionDir() never look up (they only ever encode the
    // canonical key), permanently orphaning the data.
    expect(fs.existsSync(wrongV2AliasDir)).toBe(false);
    expect(fs.existsSync(legacyAliasDir)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(canonicalV2Dir, "state.json"), "utf8")).marker).toBe("alias");
    expect(resolveSessionDir(store, canonical)).toBe(canonicalV2Dir);
  });

  it("fails closed instead of overwriting a canonical v2 dir with a v1 alias copy", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-session-store-"));
    tempRoots.push(root);
    configureMudStorage(root);
    clearSessionDirCache();
    const canonical = "agent:main:telegram:group:-100:topic:1";
    const alias = "topic-1";
    fs.writeFileSync(
      path.join(root, "registry.json"),
      JSON.stringify({
        [canonical]: { sessionKey: canonical, mode: "active", aliases: [alias] },
      }),
    );
    const legacyAliasDir = path.join(root, "sessions", encodeLegacyV1(alias));
    const canonicalV2Dir = path.join(root, "sessions", encodeSessionDirName(canonical));
    writeSessionMarker(legacyAliasDir, "alias");
    writeSessionMarker(canonicalV2Dir, "canonical-live");

    expect(() => new MudSessionStore()).toThrow(/legacy v1 directory.*v2 destination.*both exist/i);
    expect(JSON.parse(fs.readFileSync(path.join(legacyAliasDir, "state.json"), "utf8")).marker).toBe("alias");
    expect(JSON.parse(fs.readFileSync(path.join(canonicalV2Dir, "state.json"), "utf8")).marker).toBe("canonical-live");
  });

  it("fails closed when two v1 aliases of the same canonical target the same v2 destination", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-session-store-"));
    tempRoots.push(root);
    configureMudStorage(root);
    clearSessionDirCache();
    const canonical = "agent:main:telegram:group:-100:topic:1";
    const aliasOne = "topic-1";
    const aliasTwo = "telegram:-100:1";
    fs.writeFileSync(
      path.join(root, "registry.json"),
      JSON.stringify({
        [canonical]: { sessionKey: canonical, mode: "active", aliases: [aliasOne, aliasTwo] },
      }),
    );
    const legacyAliasOneDir = path.join(root, "sessions", encodeLegacyV1(aliasOne));
    const legacyAliasTwoDir = path.join(root, "sessions", encodeLegacyV1(aliasTwo));
    writeSessionMarker(legacyAliasOneDir, "alias-one");
    writeSessionMarker(legacyAliasTwoDir, "alias-two");

    expect(() => new MudSessionStore()).toThrow(/multiple migration sources target the same v2 destination/i);
    expect(JSON.parse(fs.readFileSync(path.join(legacyAliasOneDir, "state.json"), "utf8")).marker).toBe("alias-one");
    expect(JSON.parse(fs.readFileSync(path.join(legacyAliasTwoDir, "state.json"), "utf8")).marker).toBe("alias-two");
  });

  it.runIf(process.platform !== "win32")(
    "fails closed instead of silently shadowing a raw canonical dir when migrating a v1 alias",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-session-store-"));
      tempRoots.push(root);
      configureMudStorage(root);
      clearSessionDirCache();
      const canonical = "agent:main:telegram:group:-100:topic:1";
      const alias = "topic-1";
      fs.writeFileSync(
        path.join(root, "registry.json"),
        JSON.stringify({
          [canonical]: { sessionKey: canonical, mode: "active", aliases: [alias] },
        }),
      );
      const rawCanonicalDir = path.join(root, "sessions", canonical);
      const legacyAliasDir = path.join(root, "sessions", encodeLegacyV1(alias));
      // Regression guard: a raw (unencoded) directory literally named after
      // canonical is a supported fallback storage form (see the "reads a
      // raw-colon legacy directory" test above). Once the v2 destination
      // exists, resolveSessionDir() always checks the canonical candidate's
      // v2 form first and returns immediately, so migrating the alias copy
      // into that v2 slot without noticing this raw directory would
      // silently shadow whatever live data it holds.
      writeSessionMarker(rawCanonicalDir, "REAL-LIVE-CANONICAL-DATA");
      writeSessionMarker(legacyAliasDir, "stale-alias-data");

      expect(() => new MudSessionStore()).toThrow(/raw legacy directory.*still exists.*unreachable/i);
      expect(JSON.parse(fs.readFileSync(path.join(rawCanonicalDir, "state.json"), "utf8")).marker).toBe(
        "REAL-LIVE-CANONICAL-DATA",
      );
      expect(JSON.parse(fs.readFileSync(path.join(legacyAliasDir, "state.json"), "utf8")).marker).toBe(
        "stale-alias-data",
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "fails closed instead of silently shadowing a raw canonical dir when migrating an unaliased v1 directory",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-session-store-"));
      tempRoots.push(root);
      configureMudStorage(root);
      clearSessionDirCache();
      const canonical = "plain-canonical-key";
      const rawCanonicalDir = path.join(root, "sessions", canonical);
      const legacyV1Dir = path.join(root, "sessions", encodeLegacyV1(canonical));
      fs.writeFileSync(
        path.join(root, "registry.json"),
        JSON.stringify({ [canonical]: { sessionKey: canonical, mode: "active" } }),
      );
      // Same hazard as above but for the plain (non-alias) v1 migration
      // path, which predates this alias fix entirely.
      writeSessionMarker(rawCanonicalDir, "REAL-LIVE-CANONICAL-DATA");
      writeSessionMarker(legacyV1Dir, "v1-data");

      expect(() => new MudSessionStore()).toThrow(/raw legacy directory.*still exists.*unreachable/i);
      expect(JSON.parse(fs.readFileSync(path.join(rawCanonicalDir, "state.json"), "utf8")).marker).toBe(
        "REAL-LIVE-CANONICAL-DATA",
      );
      expect(JSON.parse(fs.readFileSync(path.join(legacyV1Dir, "state.json"), "utf8")).marker).toBe("v1-data");
    },
  );

  it.runIf(process.platform !== "win32")(
    "fails closed instead of shadowing a DIFFERENT alias's raw dir when migrating one v1 alias",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-session-store-"));
      tempRoots.push(root);
      configureMudStorage(root);
      clearSessionDirCache();
      const canonical = "agent:main:telegram:group:-100:topic:1";
      const aliasA = "topic-1";
      const aliasB = "telegram:-100:1";
      fs.writeFileSync(
        path.join(root, "registry.json"),
        JSON.stringify({
          [canonical]: { sessionKey: canonical, mode: "active", aliases: [aliasA, aliasB] },
        }),
      );
      const legacyAliasADir = path.join(root, "sessions", encodeLegacyV1(aliasA));
      const rawAliasBDir = path.join(root, "sessions", aliasB);
      // Regression guard: once canonical's v2 slot exists (populated from
      // aliasA's migration), resolveSessionDir() resolves canonical first
      // and never even looks at aliasB's raw directory again, even though
      // aliasB is a completely different, unrelated legacy storage form.
      writeSessionMarker(legacyAliasADir, "stale-alias-a-data");
      writeSessionMarker(rawAliasBDir, "REAL-ALIAS-B-DATA");

      expect(() => new MudSessionStore()).toThrow(/raw legacy directory.*still exists.*unreachable/i);
      expect(JSON.parse(fs.readFileSync(path.join(legacyAliasADir, "state.json"), "utf8")).marker).toBe(
        "stale-alias-a-data",
      );
      expect(JSON.parse(fs.readFileSync(path.join(rawAliasBDir, "state.json"), "utf8")).marker).toBe(
        "REAL-ALIAS-B-DATA",
      );
    },
  );

  it("fails closed instead of shadowing a DIFFERENT alias's own v2 dir when migrating one v1 alias", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-session-store-"));
    tempRoots.push(root);
    configureMudStorage(root);
    clearSessionDirCache();
    const canonical = "canonical-two-alias";
    const aliasA = "alias-a";
    const aliasB = "alias-b";
    fs.writeFileSync(
      path.join(root, "registry.json"),
      JSON.stringify({
        [canonical]: { sessionKey: canonical, mode: "active", aliases: [aliasA, aliasB] },
      }),
    );
    const legacyAliasADir = path.join(root, "sessions", encodeLegacyV1(aliasA));
    const v2AliasBDir = path.join(root, "sessions", encodeSessionDirName(aliasB));
    writeSessionMarker(legacyAliasADir, "stale-alias-a-data");
    writeSessionMarker(v2AliasBDir, "REAL-ALIAS-B-V2-DATA");

    expect(() => new MudSessionStore()).toThrow(/v2 directory.*alias.*still exists.*unreachable/i);
    expect(JSON.parse(fs.readFileSync(path.join(legacyAliasADir, "state.json"), "utf8")).marker).toBe(
      "stale-alias-a-data",
    );
    expect(JSON.parse(fs.readFileSync(path.join(v2AliasBDir, "state.json"), "utf8")).marker).toBe(
      "REAL-ALIAS-B-V2-DATA",
    );
  });

  it.runIf(process.platform !== "win32")(
    "fails closed instead of shadowing an algorithmically-derived legacy alias raw dir (not registered)",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-session-store-"));
      tempRoots.push(root);
      configureMudStorage(root);
      clearSessionDirCache();
      const canonical = "agent:main:telegram:group:-100:topic:1";
      // No aliases registered at all -- "telegram:-100:1" is never recorded
      // anywhere in the registry. resolveSessionDir() still tries it as a
      // fallback candidate via listLegacySessionAliases(), which derives it
      // purely from the canonical key, independent of the registry.
      fs.writeFileSync(
        path.join(root, "registry.json"),
        JSON.stringify({ [canonical]: { sessionKey: canonical, mode: "active", aliases: [] } }),
      );
      const legacyExactDir = path.join(root, "sessions", encodeLegacyV1(canonical));
      const derivedAliasRawDir = path.join(root, "sessions", "telegram:-100:1");
      writeSessionMarker(legacyExactDir, "v1-exact-data");
      writeSessionMarker(derivedAliasRawDir, "REAL-DERIVED-ALIAS-DATA");

      expect(() => new MudSessionStore()).toThrow(/raw legacy directory.*still exists.*unreachable/i);
      expect(JSON.parse(fs.readFileSync(path.join(legacyExactDir, "state.json"), "utf8")).marker).toBe("v1-exact-data");
      expect(JSON.parse(fs.readFileSync(path.join(derivedAliasRawDir, "state.json"), "utf8")).marker).toBe(
        "REAL-DERIVED-ALIAS-DATA",
      );
    },
  );

  it("encodes Windows colon keys and never joins logical traversal input as a raw write path", () => {
    const { root, store } = createStore();
    const key = "agent:main:discord:channel:C:\\temp\\..\\outside";

    store.ensure(key);

    const sessionDir = store.getSessionDataDir(key);
    expect(path.basename(sessionDir)).toMatch(/^v2_[0-9a-f]+$/);
    expect(path.relative(path.join(root, "sessions"), sessionDir)).not.toMatch(/^\.\.(?:[\\/]|$)/);
    expect(fs.existsSync(path.join(root, "outside"))).toBe(false);
  });

  it("does not follow a traversal-shaped registry alias through the legacy fallback", () => {
    const { root, store } = createStore();
    const canonical = "agent:main:telegram:direct:100000001";
    store.ensure(canonical);
    store.registerAlias(canonical, "../../outside");
    fs.rmSync(store.getSessionDataDir(canonical), { recursive: true });
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside, { recursive: true });

    expect(resolveSessionDir(store, canonical)).toBe(store.getSessionDataDir(canonical));
  });
});
