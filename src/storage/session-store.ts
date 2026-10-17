import fs from "node:fs";
import path from "node:path";
import type { MudSession } from "../core/types.js";
import { acquireMigrationLockAsync, acquireMigrationLockSync } from "../lib/migration-lock-contract.mjs";
import {
  caseFoldSessionDirName,
  encodeLegacySessionDirName,
  encodeSessionDirName,
  findEncodedSessionDirOwnershipConflicts,
  findRegistrySessionKeyOwnershipConflicts,
  parseSessionDirName,
} from "../lib/session-dir-name.js";
import { listLegacySessionAliases, normalizeSessionKey } from "../lib/session-key.js";
import { listLiveSessionProcesses } from "../lib/session-process.mjs";

export type { MudSession };

export interface MudSessionConfig {
  host: string;
  port: number;
  encoding: string;
  username?: string;
  password?: string;
}

// A directory-rename-based migration completes in well under a second even
// on slow storage; this timeout is generous headroom, not a tuned budget.
const MIGRATION_LOCK_TIMEOUT_MS = 2000;
const MIGRATION_LOCK_POLL_MS = 10;

// registerAlias() and ensure() call this to decide whether their alias
// bookkeeping actually changed anything before writing the registry back to
// disk. Both are on hot paths (ensure() runs on essentially every tool
// call) and are frequently idempotent repeats; resolveSessionDir()
// (session-key.ts) reads registry.json's raw content as the cross-process
// signal to revalidate its cached, not-yet-materialized session lookups, so
// an unconditional write here -- even one that reproduces byte-identical
// content -- still costs a filesystem write and (for a genuinely different
// write elsewhere racing it) a real content change to detect. Skipping the
// write on a true no-op keeps idempotent repeats cheap and keeps them from
// forcing every OTHER, unrelated session's cached lookup to revalidate too.
function sortedStringArraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

let storageRoot = path.join(process.env.HOME || "", ".mud-agent");

export function configureMudStorage(dir?: string) {
  if (dir) {
    storageRoot = dir;
  }
}

export function getStorageRoot(): string {
  return storageRoot;
}

const warnedLiveLegacyDirs = new Set<string>();
function warnLiveLegacyDirOnce(dirName: string, live: { file: string; pid: number }[]): void {
  if (warnedLiveLegacyDirs.has(dirName)) return;
  warnedLiveLegacyDirs.add(dirName);
  const detail = live.map((p) => `${p.file}=${p.pid}`).join(", ");
  console.warn(
    `[mud-agent] legacy session directory ${dirName} still has a live session process (${detail}); migration deferred until it stops`,
  );
}

export class MudSessionStore {
  // 迁移锁在本实例内可重入：ensure() 持锁期间触发的 v1 迁移会再次申请同一把锁，不能自锁超时。
  private lockDepth = 0;

  public constructor() {
    this.prepareSessionStorage();
  }

  public getStorageRoot() {
    return storageRoot;
  }

  public getSessionDataDir(sessionKey: string): string {
    const logical = normalizeSessionKey(sessionKey);
    return this.getSessionDataDirWithRegistry(logical, this.loadRegistry());
  }

  public getRegistryPath(): string {
    return path.join(storageRoot, "registry.json");
  }

  public prepareSessionStorage(): boolean {
    return this.migrateLegacyV1Directories(this.loadRegistry(false));
  }

  private loadRegistry(validateOwnership = true): Record<string, MudSession> {
    const registryPath = this.getRegistryPath();
    if (!fs.existsSync(registryPath)) return {};

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(registryPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new TypeError("registry root must be an object");
      }
    } catch (error) {
      throw new Error(
        `registry JSON is invalid at ${registryPath}; repair it manually, then run npm run normalize:sessions before retrying`,
        { cause: error },
      );
    }
    const registry = parsed as Record<string, MudSession>;
    this.assertRegistryIntegrity(registry);
    if (validateOwnership) this.assertRegistryOwnership(registry);
    return registry;
  }

  private getSessionDataDirWithRegistry(logical: string, registry: Record<string, MudSession>): string {
    this.migrateLegacyV1Directories(registry);
    return path.join(storageRoot, "sessions", encodeSessionDirName(logical));
  }

  private collectRegistrySessionClaims(registry: Record<string, MudSession>, sessionDirNames: string[]) {
    const claims: Array<{ ownerKey: string; sessionKey: string }> = [];
    for (const [registryKey, session] of Object.entries(registry)) {
      const ownerKey = normalizeSessionKey(registryKey);
      const sessionKeys = new Set<string>([ownerKey, registryKey]);
      if (Array.isArray(session?.aliases)) {
        for (const alias of session.aliases) {
          if (typeof alias === "string" && alias) sessionKeys.add(alias);
        }
      }
      for (const sessionKey of sessionKeys) claims.push({ ownerKey, sessionKey });
    }
    const ownerKeys = new Set(claims.map((claim) => claim.ownerKey));
    for (const dirName of sessionDirNames) {
      const parsed = parseSessionDirName(dirName);
      if (!parsed) continue;
      const ownerKey = normalizeSessionKey(parsed.sessionKey);
      if (ownerKeys.has(ownerKey)) claims.push({ ownerKey, sessionKey: parsed.sessionKey });
    }
    return claims;
  }

  private assertRegistryIntegrity(registry: Record<string, MudSession>): void {
    for (const [registryKey, session] of Object.entries(registry)) {
      const canonicalKey = normalizeSessionKey(registryKey);
      if (!session || typeof session !== "object" || Array.isArray(session)) {
        throw new Error(
          `registry entry "${registryKey}" is invalid: expected a session object; ` +
            "repair it manually, then run npm run normalize:sessions",
        );
      }
      if (registryKey !== canonicalKey || session.sessionKey !== canonicalKey) {
        throw new Error(
          `registry entry "${registryKey}" is invalid: sessionKey "${String(session.sessionKey)}" must equal ` +
            `canonical registry key "${canonicalKey}"; repair it manually, then run npm run normalize:sessions`,
        );
      }
      if (!(["active", "paused", "archived"] as const).includes(session.mode)) {
        throw new Error(
          `registry entry "${registryKey}" is invalid: unsupported mode "${String(session.mode)}"; ` +
            "repair it manually, then run npm run normalize:sessions",
        );
      }
      if (
        session.aliases !== undefined &&
        (!Array.isArray(session.aliases) || session.aliases.some((alias) => typeof alias !== "string" || !alias))
      ) {
        throw new Error(
          `registry entry "${registryKey}" is invalid: aliases must contain nonempty strings; ` +
            "repair it manually, then run npm run normalize:sessions",
        );
      }
    }
  }

  private assertRegistryOwnership(registry: Record<string, MudSession>): void {
    const conflicts = findRegistrySessionKeyOwnershipConflicts(this.collectRegistrySessionClaims(registry, []));
    if (conflicts.length === 0) return;
    const details = conflicts
      .map((conflict) => `${conflict.sessionKey} => [${conflict.ownerKeys.join(", ")}]`)
      .join("; ");
    throw new Error(`registry session-key ownership conflict: ${details}; no files were changed`);
  }

  private getSessionDirectoryNames(): string[] {
    const sessionsDir = path.join(storageRoot, "sessions");
    if (!fs.existsSync(sessionsDir)) return [];
    return fs
      .readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  }

  private assertNoLegacyFallbackWouldBeShadowed(
    registry: Record<string, MudSession>,
    canonicalKey: string,
    requestedKeys: string[],
  ): void {
    const sessionsDir = path.join(storageRoot, "sessions");
    if (!fs.existsSync(sessionsDir)) return;

    const aliases = Array.isArray(registry[canonicalKey]?.aliases) ? registry[canonicalKey].aliases : [];
    const candidates = new Set([canonicalKey, ...requestedKeys, ...aliases, ...listLegacySessionAliases(canonicalKey)]);
    const conflicts = new Set<string>();
    for (const candidate of candidates) {
      if (
        !candidate ||
        candidate === "." ||
        candidate === ".." ||
        candidate.includes("/") ||
        candidate.includes("\\")
      ) {
        continue;
      }
      const rawPath = path.join(sessionsDir, candidate);
      if (fs.existsSync(rawPath)) conflicts.add(candidate);
      if (candidate === canonicalKey) continue;
      try {
        const encodedAlias = encodeSessionDirName(candidate);
        if (fs.existsSync(path.join(sessionsDir, encodedAlias))) conflicts.add(encodedAlias);
      } catch {
        // An unencodable legacy alias cannot be a valid v2 fallback. Its raw
        // form above is still checked when it is a safe path component.
      }
    }
    if (conflicts.size === 0) return;

    const canonicalV2 = encodeSessionDirName(canonicalKey);
    throw new Error(
      `legacy fallback directory for canonical session "${canonicalKey}" still exists ` +
        `(${[...conflicts].sort().join(", ")}) and would be shadowed by canonical v2 directory "${canonicalV2}"; ` +
        `no files were changed. Run npm run normalize:sessions -- --mud-dir "${storageRoot}" before retrying`,
    );
  }

  private assertEncodedDirectoryOwnership(registry: Record<string, MudSession>, sessionDirNames: string[]): void {
    const ownershipConflicts = findEncodedSessionDirOwnershipConflicts(
      sessionDirNames,
      this.collectRegistrySessionClaims(registry, sessionDirNames),
    );
    if (ownershipConflicts.length === 0) return;
    const reasonLabels = {
      "missing-owner": "no registry owner",
      "multiple-owners": "multiple registry owners",
      "unclaimed-decoded-key": "decoded key is not claimed by its registry owner",
      "noncanonical-name": "noncanonical encoded-looking directory name",
    } as const;
    const details = ownershipConflicts
      .map(
        (conflict) =>
          `${conflict.foldedName} => [${conflict.sessionKeys.join(", ")}] (${reasonLabels[conflict.reason]})`,
      )
      .join("; ");
    const label = ownershipConflicts.every((conflict) => conflict.foldedName.startsWith("v1_"))
      ? "ambiguous legacy v1 case-fold collision"
      : "encoded directory case-fold collision";
    throw new Error(
      `${label}: ${details}; no files were changed. ` +
        `Run npm run normalize:sessions -- --mud-dir "${storageRoot}" and repair ownership before retrying`,
    );
  }

  // Two processes can independently compute the same v1->v2 migration plan
  // (it's a pure function of readdirSync + the registry): without mutual
  // exclusion, both act on the same source/destination pair. A "check state,
  // then act" idempotent retry doesn't close this -- the check and the act
  // are two separate syscalls, so a peer's own migration (or its rollback)
  // can land in between them, which is exactly how an empty v2 directory
  // can end up shadowing a v1 directory that still holds real data. A real
  // lock removes the race instead of chasing individual windows.
  private acquireMigrationLock(): () => void {
    if (this.lockDepth > 0) {
      this.lockDepth += 1;
      return () => {
        this.lockDepth -= 1;
      };
    }
    // 锁本体（owner 记录 + 死进程回收）与 scripts/normalize-sessions.mjs 共用，见 lib/migration-lock-contract.mjs
    const release = acquireMigrationLockSync(storageRoot, {
      timeoutMs: MIGRATION_LOCK_TIMEOUT_MS,
      pollMs: MIGRATION_LOCK_POLL_MS,
    });
    this.lockDepth = 1;
    return () => {
      this.lockDepth = 0;
      try {
        release();
      } catch {
        // Best-effort release: a lock left behind is reclaimed by the next acquirer once this process exits.
      }
    };
  }

  private hasLegacySessionDirEntries(entries: fs.Dirent[]): boolean {
    return entries.some((entry) => entry.isDirectory() && parseSessionDirName(entry.name)?.version === "v1");
  }

  // A directory can appear (or disappear, or get renamed) in sessions/
  // without registry.json's content ever changing, since directory-level
  // filesystem state is not part of it. This isn't only about v1->v2
  // migration: resolveSessionDir()'s own candidate loop also reads a raw,
  // unencoded legacy alias directory directly (getLegacySessionDir(), for
  // names like listLegacySessionAliases() produces -- an even older,
  // pre-v1 naming scheme that parseSessionDirName() doesn't recognize as
  // "v1" at all) if one exists. Either kind appearing for a key that was
  // already resolved (and cached, via the fallback branch, since nothing
  // had a materialized directory yet) before this process ever saw it --
  // another process performing a migration, or a data volume attaching
  // after this process's cache was already warm -- would otherwise keep
  // that cached guess pointing at an empty, wrong directory indefinitely:
  // the returned path can look right (for the v1 case, it's the same v2
  // destination the migration would eventually use) but the real data sits
  // unreachable in the actual directory until some unrelated event forces
  // a full resolution.
  //
  // Comparing the whole listing catches any of this uniformly, rather than
  // trying to separately enumerate every kind of directory
  // resolveSessionDir() might read. It's exposed separately from
  // migrateLegacyV1Directories() so a cache-hit check can afford it: it's
  // just the readdir, no ownership validation (an O(n) cross-reference
  // against the whole registry) and no migration lock (which can block for
  // up to MIGRATION_LOCK_TIMEOUT_MS under contention) -- those only run
  // once a fresh resolution independently confirms migration is needed.
  //
  // Includes each entry's type (directory vs. not), not just its name: a
  // plain file can occupy a v1-shaped name slot (a stray leftover, a failed
  // migration's partial artifact, anything) and later get replaced by an
  // actual v1 directory of the same name -- two separate filesystem
  // operations (remove the file, create the directory), but readdirSync()
  // returns the exact same name list before and after if only names are
  // compared. hasLegacySessionDirEntries() -- what the real migration check
  // uses -- is itself type-aware (entry.isDirectory()), so a names-only
  // snapshot can silently miss exactly the transition this exists to catch.
  //
  // Encoded via JSON.stringify() on a real array, not by joining
  // "type:name" strings with a plain separator character: entry names are
  // ordinary filesystem strings and can legally contain any byte except "/"
  // and NUL, including a literal newline -- an entry named "foo\nf:bar"
  // and two separate entries "foo" (a directory) and "bar" (a file) would
  // both join to the identical string "d:foo\nf:bar" under a naive
  // separator-joined scheme, so two genuinely different directory states
  // could produce the same "snapshot", silently defeating the whole point
  // of comparing it. JSON's own string escaping (a literal newline in a
  // string value is emitted as the two characters "\" "n", not a raw
  // newline byte) keeps entry boundaries unambiguous regardless of what
  // characters appear in any entry's name.
  public getSessionsDirSnapshot(): string {
    const sessionsDir = path.join(storageRoot, "sessions");
    if (!fs.existsSync(sessionsDir)) return "";
    const entries = fs
      .readdirSync(sessionsDir, { withFileTypes: true })
      .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return JSON.stringify(entries);
  }

  // prepareSessionStorage() -- and therefore this -- runs on every
  // resolveSessionDir() cache MISS (a fresh resolution): it's the busiest
  // path in the whole store whenever the fast path doesn't apply. Migration
  // is a one-time, rare event (once a v1 directory is migrated it never
  // reappears), so do a cheap, lock-free scan first and only pay for
  // cross-process mutual exclusion when there's actually a v1 directory to
  // migrate. Getting this gate wrong previously put a synchronous,
  // up-to-multi-second lock wait on every single tool call whenever the
  // lock was contended or stale.
  private migrateLegacyV1Directories(registry: Record<string, MudSession>): boolean {
    const sessionsDir = path.join(storageRoot, "sessions");
    if (!fs.existsSync(sessionsDir)) {
      this.assertRegistryOwnership(registry);
      return false;
    }

    const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
    const sessionDirNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    this.assertEncodedDirectoryOwnership(registry, sessionDirNames);
    this.assertRegistryOwnership(registry);

    if (!this.hasLegacySessionDirEntries(entries)) return false;

    const reentrant = this.lockDepth > 0;
    const release = this.acquireMigrationLock();
    try {
      // 等锁期间别的进程可能注册了新会话：新获得锁时锁内重读 registry，否则锁内重扫看到的新目录会被判成无主；
      // 重入（调用方已在锁内读的快照，可能含尚未落盘的新注册项）则沿用调用方的快照
      return this.migrateLegacyV1DirectoriesLocked(reentrant ? registry : this.loadRegistry(false), sessionsDir);
    } finally {
      release();
    }
  }

  private migrateLegacyV1DirectoriesLocked(registry: Record<string, MudSession>, sessionsDir: string): boolean {
    // Re-scan under the lock: the caller's snapshot was taken before we held
    // it, so it's stale by definition -- a concurrent process could have
    // already migrated everything (or changed the registry) in the gap.
    const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
    const sessionDirNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    this.assertEncodedDirectoryOwnership(registry, sessionDirNames);
    this.assertRegistryOwnership(registry);

    const allLegacyDirs = entries.flatMap((entry) => {
      if (!entry.isDirectory()) return [];
      const parsed = parseSessionDirName(entry.name);
      if (parsed?.version !== "v1") return [];
      return [{ dirName: entry.name, sessionKey: parsed.sessionKey }];
    });
    // 升级期间旧版 daemon / autopilot 可能还在某个 v1 目录里读写（它们不走迁移锁）：搬走它就是 ENOENT 断会话。
    // 只要一个 canonical 会话的任一 v1 来源（canonical 本身或它的别名）有活进程，这个会话的所有 v1 来源都推迟：
    // 否则另一个别名目录先迁进 canonical v2，解析会优先命中它、遮住活进程还在用的目录。进程退出后下一次再迁。
    const deferredOwners = new Set<string>();
    for (const legacyDir of allLegacyDirs) {
      const live = listLiveSessionProcesses(path.join(sessionsDir, legacyDir.dirName));
      if (live.length === 0) continue;
      warnLiveLegacyDirOnce(legacyDir.dirName, live);
      deferredOwners.add(this.resolveCanonicalFromRegistry(registry, legacyDir.sessionKey));
    }
    const legacyDirs = allLegacyDirs.filter(
      (legacyDir) => !deferredOwners.has(this.resolveCanonicalFromRegistry(registry, legacyDir.sessionKey)),
    );
    if (legacyDirs.length === 0) return false;

    const existingByFoldedName = new Map(entries.map((entry) => [caseFoldSessionDirName(entry.name), entry.name]));
    const migrations = legacyDirs.map((legacyDir) => {
      // Encode the destination from the canonical registry owner, not the
      // raw decoded key: when this v1 directory is merely a registered
      // alias, encoding the alias would migrate it into a directory that
      // ensure()/getSessionDataDirWithRegistry() never look up (they always
      // encode from the canonical key), permanently orphaning the data. If a
      // live canonical v2 directory already exists, the conflict check below
      // fails the whole migration closed instead of silently overwriting it.
      const canonicalOwner = this.resolveCanonicalFromRegistry(registry, legacyDir.sessionKey);
      let destinationName: string;
      try {
        destinationName = encodeSessionDirName(canonicalOwner);
      } catch (error) {
        throw new Error(
          `cannot migrate legacy v1 directory ${legacyDir.dirName} to v2: ${error instanceof Error ? error.message : String(error)}. ` +
            `Run npm run normalize:sessions -- --mud-dir "${storageRoot}" for manual repair`,
          { cause: error },
        );
      }
      const conflictingName = existingByFoldedName.get(caseFoldSessionDirName(destinationName));
      if (conflictingName && conflictingName !== legacyDir.dirName) {
        throw new Error(
          `legacy v1 directory ${legacyDir.dirName} and v2 destination ${conflictingName} both exist; ` +
            `no files were changed. Run npm run normalize:sessions -- --mud-dir "${storageRoot}" and resolve the conflict`,
        );
      }
      // resolveSessionDir() tries canonicalOwner first, then every registered
      // alias, then every algorithmically-derived legacy Telegram alias
      // (listLegacySessionAliases — computed purely from canonicalOwner,
      // independent of the registry), checking each candidate's raw
      // (unencoded) form and its own v2 form — all are supported fallback
      // storage forms. Once canonicalOwner's v2 destination exists,
      // resolveSessionDir() always resolves canonicalOwner first and returns
      // immediately, so it never reaches any of these other candidates'
      // directories again, silently shadowing whatever live data they hold
      // instead of leaving it unreachable via a clear error.
      const canonicalAliases = Array.isArray(registry[canonicalOwner]?.aliases)
        ? (registry[canonicalOwner].aliases as string[])
        : [];
      const derivedLegacyAliases = listLegacySessionAliases(canonicalOwner);
      const candidates = new Set([canonicalOwner, ...canonicalAliases, ...derivedLegacyAliases]);
      for (const candidate of candidates) {
        const rawConflict = existingByFoldedName.get(caseFoldSessionDirName(candidate));
        if (rawConflict && rawConflict !== legacyDir.dirName) {
          throw new Error(
            `legacy v1 directory ${legacyDir.dirName} would migrate to v2 destination ${destinationName}, but raw ` +
              `legacy directory "${rawConflict}" for canonical session "${canonicalOwner}" (via "${candidate}") ` +
              "still exists and would become unreachable once that v2 directory exists; no files were changed. " +
              `Run npm run normalize:sessions -- --mud-dir "${storageRoot}" and resolve the conflict`,
          );
        }
        if (candidate === canonicalOwner) continue;
        let candidateEncodedName: string;
        try {
          candidateEncodedName = encodeSessionDirName(candidate);
        } catch {
          continue;
        }
        const encodedConflict = existingByFoldedName.get(caseFoldSessionDirName(candidateEncodedName));
        if (encodedConflict && encodedConflict !== legacyDir.dirName) {
          throw new Error(
            `legacy v1 directory ${legacyDir.dirName} would migrate to v2 destination ${destinationName}, but v2 ` +
              `directory "${encodedConflict}" for alias "${candidate}" of canonical session "${canonicalOwner}" ` +
              "still exists and would become unreachable once that v2 directory exists; no files were changed. " +
              `Run npm run normalize:sessions -- --mud-dir "${storageRoot}" and resolve the conflict`,
          );
        }
      }
      return {
        source: path.join(sessionsDir, legacyDir.dirName),
        destination: path.join(sessionsDir, destinationName),
      };
    });

    // Two different v1 directories can now decode to distinct alias strings
    // that both resolve to the same canonicalOwner; without this check they
    // would both plan a rename into the same destination, silently dropping
    // one of them.
    const migrationSourcesByDestination = new Map<string, string>();
    for (const migration of migrations) {
      const foldedDestination = migration.destination.toLowerCase();
      const existingSource = migrationSourcesByDestination.get(foldedDestination);
      if (existingSource) {
        throw new Error(
          `multiple migration sources target the same v2 destination: ${existingSource}, ` +
            `${migration.source} -> ${migration.destination}; no files were changed. ` +
            `Run npm run normalize:sessions -- --mud-dir "${storageRoot}" and resolve the conflict`,
        );
      }
      migrationSourcesByDestination.set(foldedDestination, migration.source);
    }

    const migrationSources = new Set(legacyDirs.map((legacyDir) => legacyDir.dirName));
    const plannedSessionDirNames = sessionDirNames.filter((dirName) => !migrationSources.has(dirName));
    for (const migration of migrations) plannedSessionDirNames.push(path.basename(migration.destination));
    this.assertEncodedDirectoryOwnership(registry, plannedSessionDirNames);

    const moved: Array<{ source: string; destination: string }> = [];
    try {
      for (const migration of migrations) {
        fs.renameSync(migration.source, migration.destination);
        moved.push(migration);
      }
    } catch (error) {
      let rollbackError: unknown;
      for (const migration of moved.reverse()) {
        try {
          if (fs.existsSync(migration.destination) && !fs.existsSync(migration.source)) {
            fs.renameSync(migration.destination, migration.source);
          }
        } catch (rollbackFailure) {
          rollbackError = rollbackFailure;
        }
      }
      const rollbackNote = rollbackError ? `; rollback also failed: ${String(rollbackError)}` : "";
      throw new Error(`legacy v1 to v2 migration failed: ${String(error)}${rollbackNote}`, { cause: error });
    }
    return migrations.length > 0;
  }

  private saveRegistry(reg: Record<string, MudSession>) {
    this.assertRegistryIntegrity(reg);
    this.assertRegistryOwnership(reg);
    this.assertEncodedDirectoryOwnership(reg, this.getSessionDirectoryNames());
    const p = this.getRegistryPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // 原子替换：读方永远看不到截断中的 registry
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
    try {
      fs.renameSync(tmp, p);
    } catch (error) {
      try {
        fs.unlinkSync(tmp);
      } catch {}
      throw error;
    }
  }

  // registry 的读-改-写必须跨进程串行：两个进程同时注册不同会话时会各自基于同一快照保存、互相覆盖，
  // 输家的目录随后没有 registry 所有者，所有权校验会让整个 store 不可用。复用迁移锁（mkdir 原子）。
  private withRegistryLock<T>(fn: () => T): T {
    const release = this.acquireMigrationLock();
    try {
      return fn();
    } finally {
      release();
    }
  }

  private resolveCanonicalFromRegistry(reg: Record<string, MudSession>, sessionKey: string): string {
    const normalized = normalizeSessionKey(sessionKey);
    if (reg[normalized]) return normalized;

    for (const [canonicalKey, session] of Object.entries(reg)) {
      const aliases = Array.isArray(session.aliases) ? session.aliases : [];
      if (aliases.some((alias) => normalizeSessionKey(alias) === normalized)) {
        return canonicalKey;
      }
    }

    return normalized;
  }

  public getCanonicalSessionKey(sessionKey: string): string {
    return this.resolveCanonicalFromRegistry(this.loadRegistry(), sessionKey);
  }

  public getAliases(sessionKey: string): string[] {
    const reg = this.loadRegistry();
    const canonicalKey = this.resolveCanonicalFromRegistry(reg, sessionKey);
    const session = reg[canonicalKey];
    return Array.isArray(session?.aliases) ? [...session.aliases] : [];
  }

  public registerAlias(sessionKey: string, alias: string): MudSession | undefined {
    return this.withRegistryLock(() => this.registerAliasLocked(sessionKey, alias));
  }

  private registerAliasLocked(sessionKey: string, alias: string): MudSession | undefined {
    const reg = this.loadRegistry();
    const canonicalKey = this.resolveCanonicalFromRegistry(reg, sessionKey);
    const normalizedAlias = alias.trim();
    if (!normalizedAlias) return reg[canonicalKey];

    const existed = Boolean(reg[canonicalKey]);
    if (!reg[canonicalKey]) {
      reg[canonicalKey] = { sessionKey: canonicalKey, mode: "active", aliases: [] };
    }
    const previousAliases = existed && Array.isArray(reg[canonicalKey].aliases) ? [...reg[canonicalKey].aliases] : [];

    const aliases = new Set<string>(Array.isArray(reg[canonicalKey].aliases) ? reg[canonicalKey].aliases : []);
    if (normalizedAlias !== canonicalKey) {
      aliases.add(normalizedAlias);
    }
    reg[canonicalKey].aliases = [...aliases].sort();
    if (normalizedAlias !== canonicalKey) {
      this.assertRegistryOwnership(reg);
      this.assertEncodedDirectoryOwnership(reg, this.getSessionDirectoryNames());
      this.assertNoLegacyFallbackWouldBeShadowed(reg, canonicalKey, [normalizedAlias]);
    }
    if (!existed || !sortedStringArraysEqual(previousAliases, reg[canonicalKey].aliases)) {
      this.saveRegistry(reg);
    }
    return reg[canonicalKey];
  }

  public ensure(sessionKey: string): MudSession {
    return this.withRegistryLock(() => this.ensureLocked(sessionKey));
  }

  /**
   * 网关处理器用的异步注册：等锁不阻塞事件循环（同进程里另一个 start 正在 launchDaemon() 内持锁等 PID 时，
   * 同步版的 Atomics.wait 会卡住它、直到超时）。临界区本身（ensureLocked）是同步的，持锁期间不会有别的任务插进来。
   */
  public async ensureAsync(sessionKey: string): Promise<MudSession> {
    if (this.lockDepth > 0) return this.ensureLocked(sessionKey);
    const release = await acquireMigrationLockAsync(storageRoot, {
      timeoutMs: MIGRATION_LOCK_TIMEOUT_MS,
      pollMs: MIGRATION_LOCK_POLL_MS,
    });
    this.lockDepth = 1;
    try {
      return this.ensureLocked(sessionKey);
    } finally {
      this.lockDepth = 0;
      try {
        release();
      } catch {
        // Best-effort release: a lock left behind is reclaimed by the next acquirer once this process exits.
      }
    }
  }

  private ensureLocked(sessionKey: string): MudSession {
    const reg = this.loadRegistry();
    const requestedKey = sessionKey.trim();
    const normalizedKey = normalizeSessionKey(requestedKey);
    const canonicalKey = this.resolveCanonicalFromRegistry(reg, normalizedKey);
    const existed = Boolean(reg[canonicalKey]);
    if (!reg[canonicalKey]) {
      reg[canonicalKey] = { sessionKey: canonicalKey, mode: "active", aliases: [] };
    }
    const previousAliases = existed && Array.isArray(reg[canonicalKey].aliases) ? [...reg[canonicalKey].aliases] : [];
    const aliases = new Set<string>(Array.isArray(reg[canonicalKey].aliases) ? reg[canonicalKey].aliases : []);
    for (const alias of [requestedKey, normalizedKey]) {
      if (alias && alias !== canonicalKey) aliases.add(alias);
    }
    reg[canonicalKey].aliases = [...aliases].sort();
    this.assertRegistryOwnership(reg);
    const encodedName = encodeSessionDirName(canonicalKey);
    this.assertEncodedDirectoryOwnership(reg, [...this.getSessionDirectoryNames(), encodedName]);
    this.assertNoLegacyFallbackWouldBeShadowed(reg, canonicalKey, [requestedKey, normalizedKey]);
    const dir = this.getSessionDataDirWithRegistry(canonicalKey, reg);
    // 先提交 registry、再建目录：两步之间崩溃只会留下“有注册项、没目录”（下次 ensure 补建），
    // 而不是“有目录、没注册项”——后者会被所有权校验判为 missing-owner，拒绝所有会话操作直到人工修复。
    // A no-op repeat (already registered, no new alias) leaves reg
    // content-identical to what's on disk -- skip the write. See the
    // sortedStringArraysEqual() comment above for why this matters.
    if (!existed || !sortedStringArraysEqual(previousAliases, reg[canonicalKey].aliases)) {
      this.saveRegistry(reg);
    }
    // 该键还有一个被推迟迁移的 v1 目录（里面有活 daemon / autopilot）：不要建一个空的 v2 目录把活数据遮住，
    // 解析会继续落到 v1 目录，进程退出后迁移把它搬到 v2
    if (!fs.existsSync(dir) && !this.hasDeferredLegacyDir(canonicalKey, reg)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return reg[canonicalKey];
  }

  // 与 resolveSessionDir() 的候选集一致：canonical key、已注册别名、派生的旧别名——v1 目录可能是用其中任何一个编码的
  private hasDeferredLegacyDir(canonicalKey: string, reg: Record<string, MudSession>): boolean {
    const aliases = Array.isArray(reg[canonicalKey]?.aliases) ? reg[canonicalKey].aliases : [];
    const candidates = new Set<string>([canonicalKey, ...aliases, ...listLegacySessionAliases(canonicalKey)]);
    for (const candidate of candidates) {
      try {
        const v1 = path.join(storageRoot, "sessions", encodeLegacySessionDirName(candidate));
        if (fs.statSync(v1).isDirectory()) return true;
      } catch {}
    }
    return false;
  }

  public get(sessionKey: string): MudSession | undefined {
    const reg = this.loadRegistry();
    const canonicalKey = this.resolveCanonicalFromRegistry(reg, sessionKey);
    return reg[canonicalKey];
  }

  public setMode(sessionKey: string, mode: "active" | "paused" | "archived"): MudSession | undefined {
    return this.withRegistryLock(() => {
      const reg = this.loadRegistry();
      const canonicalKey = this.resolveCanonicalFromRegistry(reg, sessionKey);
      if (!reg[canonicalKey]) return undefined;
      reg[canonicalKey].mode = mode;
      this.saveRegistry(reg);
      return reg[canonicalKey];
    });
  }
}

let _store: MudSessionStore | null = null;
export function getMudSessionStore(): MudSessionStore {
  if (!_store) {
    _store = new MudSessionStore();
  }
  return _store;
}
