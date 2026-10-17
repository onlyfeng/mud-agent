#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeSessionDirName,
  encodeSessionDirName,
  findEncodedSessionDirOwnershipConflicts,
  findRegistrySessionKeyOwnershipConflicts,
  isEncodedSessionDirNameCandidate,
  normalizeSessionRoutingKey as normalizeSessionKey,
  parseSessionDirName,
} from '../src/lib/session-dir-name-contract.mjs';
import { acquireMigrationLockSync } from '../src/lib/migration-lock-contract.mjs';
import { listLiveSessionProcesses } from '../src/lib/session-process.mjs';

export { decodeSessionDirName, encodeSessionDirName };

function parseArgs(argv) {
  const options = {
    apply: false,
    json: false,
    archiveUnmanaged: false,
    mudDir: process.env.MUD_DIR || path.join(process.env.HOME || '', '.mud-agent'),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      options.apply = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--archive-unmanaged') {
      options.archiveUnmanaged = true;
      continue;
    }
    if (arg === '--mud-dir' && argv[i + 1]) {
      options.mudDir = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith('--mud-dir=')) {
      options.mudDir = path.resolve(arg.slice('--mud-dir='.length));
      continue;
    }
    throw new Error(`未知参数: ${arg}`);
  }

  return options;
}

function timestamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function isCanonicalManagedKey(sessionKey) {
  return /^agent:main:telegram:(group|direct):[^:]+(?::topic:[^:]+)?$/.test(sessionKey);
}

function readRegistrySnapshot(registryPath) {
  try {
    return { exists: true, bytes: fs.readFileSync(registryPath) };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { exists: false, bytes: null };
    }
    throw error;
  }
}

function registrySnapshotsEqual(expected, current) {
  if (!expected || expected.exists !== current.exists) return false;
  if (!expected.exists) return true;
  return Buffer.isBuffer(expected.bytes) && expected.bytes.equals(current.bytes);
}

function assertRegistrySnapshotUnchanged(registryPath, expectedSnapshot) {
  const currentSnapshot = readRegistrySnapshot(registryPath);
  if (!registrySnapshotsEqual(expectedSnapshot, currentSnapshot)) {
    throw new Error(
      'registry changed after session normalization analysis. No files were changed; rerun normalize:sessions',
    );
  }
}

function loadRegistry(registryPath) {
  const snapshot = readRegistrySnapshot(registryPath);
  if (!snapshot.exists) return { registry: {}, snapshot };
  try {
    const parsed = JSON.parse(snapshot.bytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('registry root must be an object');
    }
    validateRegistryEntries(parsed);
    return { registry: parsed, snapshot };
  } catch (error) {
    throw new Error(
      `registry JSON at ${registryPath} is invalid: ${error instanceof Error ? error.message : String(error)}; ` +
        'manual repair is required before normalize:sessions can continue',
      { cause: error },
    );
  }
}

function validateRegistryEntries(registry) {
  for (const [registryKey, session] of Object.entries(registry)) {
    if (!session || typeof session !== 'object' || Array.isArray(session)) {
      throw new TypeError(`registry entry "${registryKey}" must be a session object`);
    }
    if (
      typeof session.sessionKey !== 'string' ||
      normalizeSessionKey(session.sessionKey) !== normalizeSessionKey(registryKey)
    ) {
      throw new TypeError(
        `registry entry "${registryKey}" has sessionKey "${String(session.sessionKey)}" with a different canonical owner`,
      );
    }
    if (!['active', 'paused', 'archived'].includes(session.mode)) {
      throw new TypeError(`registry entry "${registryKey}" has unsupported mode "${String(session.mode)}"`);
    }
    if (
      session.aliases !== undefined &&
      (!Array.isArray(session.aliases) || session.aliases.some((alias) => typeof alias !== 'string' || !alias))
    ) {
      throw new TypeError(`registry entry "${registryKey}" aliases must contain nonempty strings`);
    }
  }
}

function mergeRegistry(registry) {
  const merged = {};
  for (const [rawKey, session] of Object.entries(registry)) {
    const canonicalKey = normalizeSessionKey(rawKey);
    const incomingMode = session?.mode === 'paused' || session?.mode === 'archived' ? session.mode : 'active';
    const existing = merged[canonicalKey] || { sessionKey: canonicalKey, mode: incomingMode, aliases: [] };
    if (session && typeof session === 'object') {
      if (incomingMode === 'active') {
        existing.mode = 'active';
      } else if (existing.mode !== 'active') {
        existing.mode = incomingMode;
      }
      const aliases = new Set(existing.aliases || []);
      const incomingAliases = Array.isArray(session.aliases) ? session.aliases : [];
      for (const alias of incomingAliases) {
        if (alias && alias !== canonicalKey) aliases.add(alias);
      }
      if (rawKey !== canonicalKey) aliases.add(rawKey);
      existing.aliases = [...aliases].sort();
    }
    merged[canonicalKey] = existing;
  }
  return merged;
}

function detectTopicAliasTarget(dirName, canonicalKeys) {
  const match = dirName.match(/^topic-(.+)$/);
  if (!match) return null;
  const topicId = match[1];
  const matches = canonicalKeys.filter((key) => key.endsWith(`:topic:${topicId}`));
  return matches.length === 1 ? matches[0] : null;
}

function classifySessionDirs(sessionDirs) {
  return sessionDirs.map((dirName) => {
    const parsed = parseSessionDirName(dirName);
    return {
      dirName,
      logicalKey: parsed?.sessionKey ?? dirName,
      version: parsed?.version ?? null,
      encoded: parsed !== null,
      invalidEncoded: isEncodedSessionDirNameCandidate(dirName) && parsed === null,
    };
  });
}

function collectRegistrySessionClaims(registry, mergedRegistry, classifiedDirs) {
  const claims = new Map();
  const addClaims = (ownerKey, sessionKeys) => {
    for (const sessionKey of sessionKeys) {
      if (typeof sessionKey === 'string' && sessionKey) {
        claims.set(`${ownerKey}\0${sessionKey}`, { ownerKey, sessionKey });
      }
    }
  };

  for (const [canonicalKey, session] of Object.entries(mergedRegistry)) {
    addClaims(canonicalKey, [canonicalKey, ...(Array.isArray(session?.aliases) ? session.aliases : [])]);
  }
  for (const [registryKey, session] of Object.entries(registry)) {
    const ownerKey = normalizeSessionKey(registryKey);
    addClaims(ownerKey, [ownerKey, registryKey, ...(Array.isArray(session?.aliases) ? session.aliases : [])]);
  }

  const ownerKeys = new Set([...claims.values()].map((claim) => claim.ownerKey));
  for (const item of classifiedDirs) {
    if (!item.encoded) continue;
    const ownerKey = normalizeSessionKey(item.logicalKey);
    if (ownerKeys.has(ownerKey)) addClaims(ownerKey, [item.logicalKey]);
  }
  return [...claims.values()];
}

function detectLegacyCaseFoldCollisions(classifiedDirs, registry, mergedRegistry) {
  return findEncodedSessionDirOwnershipConflicts(
    classifiedDirs.map((item) => item.dirName),
    collectRegistrySessionClaims(registry, mergedRegistry, classifiedDirs),
  );
}

export function analyzeSessions(
  rootDir,
  registry,
  registrySnapshot = readRegistrySnapshot(path.join(rootDir, 'registry.json')),
) {
  const sessionsDir = path.join(rootDir, 'sessions');
  const sessionDirs = fs.existsSync(sessionsDir)
    ? fs.readdirSync(sessionsDir).filter((name) => fs.statSync(path.join(sessionsDir, name)).isDirectory()).sort()
    : [];
  const sessionDirNames = new Set(sessionDirs);

  const mergedRegistry = mergeRegistry(registry);
  const classifiedDirs = classifySessionDirs(sessionDirs);
  const registrySessionClaims = collectRegistrySessionClaims(registry, mergedRegistry, []);
  const registryOwnershipConflicts = findRegistrySessionKeyOwnershipConflicts(registrySessionClaims);
  const registryOwners = new Map();
  const exactRegistryOwners = new Map();
  for (const claim of registrySessionClaims) {
    const normalizedClaimKey = normalizeSessionKey(claim.sessionKey);
    const owners = registryOwners.get(normalizedClaimKey) ?? new Set();
    owners.add(claim.ownerKey);
    registryOwners.set(normalizedClaimKey, owners);
    const exactOwners = exactRegistryOwners.get(claim.sessionKey) ?? new Set();
    exactOwners.add(claim.ownerKey);
    exactRegistryOwners.set(claim.sessionKey, exactOwners);
  }
  const registryOwnerBySessionKey = new Map(
    [...registryOwners]
      .filter(([, owners]) => owners.size === 1)
      .map(([sessionKey, owners]) => [sessionKey, [...owners][0]]),
  );
  const registryOwnerByExactSessionKey = new Map(
    [...exactRegistryOwners]
      .filter(([, owners]) => owners.size === 1)
      .map(([sessionKey, owners]) => [sessionKey, [...owners][0]]),
  );
  const encodedOwnershipConflicts = detectLegacyCaseFoldCollisions(classifiedDirs, registry, mergedRegistry);
  const legacyCaseFoldCollisions = encodedOwnershipConflicts.map(({ foldedName, dirNames, sessionKeys }) => ({
    foldedName,
    dirNames,
    sessionKeys,
  }));
  const canonicalKeys = new Set(
    [
      ...Object.keys(mergedRegistry),
      ...classifiedDirs
        .filter((item) => !item.encoded)
        .map((item) => normalizeSessionKey(item.logicalKey))
        .filter(isCanonicalManagedKey),
    ],
  );

  for (const canonicalKey of canonicalKeys) {
    if (!mergedRegistry[canonicalKey]) {
      mergedRegistry[canonicalKey] = { sessionKey: canonicalKey, mode: 'active' };
    }
  }

  const aliasDirs = [];
  const unmanagedDirs = [];
  const encodedMigrations = [];
  const invalidEncodedDirs = [];
  const skippedEncodedDirs = [];

  for (const item of classifiedDirs) {
    const { dirName, logicalKey, version, encoded, invalidEncoded } = item;
    if (invalidEncoded) {
      invalidEncodedDirs.push(dirName);
      continue;
    }

    const normalized = normalizeSessionKey(logicalKey);
    const registryOwner = registryOwnerBySessionKey.get(normalized) ?? null;
    const exactRegistryOwner = registryOwnerByExactSessionKey.get(logicalKey) ?? null;
    let canonicalTarget = null;

    if (version === 'v2' && registryOwner === null) {
      unmanagedDirs.push(dirName);
      skippedEncodedDirs.push({ dirName, logicalKey, reason: 'ownerless-v2' });
      continue;
    }

    if (version === 'v1') {
      if (registryOwner) {
        // Always encode the destination from the canonical owner, not the
        // decoded logicalKey: when this v1 dir is merely a registered alias,
        // encoding the alias would migrate it into a directory name that
        // store.ensure()/resolveSessionDir() never looks up by canonical key,
        // orphaning the data. If a live canonical v2 directory already
        // exists, planChanges()'s destination-exists check fails the whole
        // apply closed instead of silently overwriting or merging it.
        encodedMigrations.push({
          dirName,
          canonicalTarget: registryOwner,
          ...(logicalKey !== registryOwner ? { logicalKey } : {}),
          encodedName: encodeSessionDirName(registryOwner),
        });
      }
      continue;
    }

    // Only the canonical owner's own v2 directory is already in its final
    // slot. A registered alias can also have an exact claim, but its v2
    // directory is still a stale alias slot and must be archived below.
    if (version === 'v2' && exactRegistryOwner === logicalKey) {
      continue;
    }

    if (!encoded && canonicalKeys.has(normalized) && dirName === normalized) {
      encodedMigrations.push({
        dirName,
        canonicalTarget: normalized,
        encodedName: encodeSessionDirName(normalized),
      });
      continue;
    }

    if (registryOwner && registryOwner !== logicalKey) {
      canonicalTarget = registryOwner;
    } else if (canonicalKeys.has(normalized) && logicalKey !== normalized) {
      canonicalTarget = normalized;
    } else {
      canonicalTarget = detectTopicAliasTarget(logicalKey, [...canonicalKeys]);
    }

    if (canonicalTarget) {
      const entry = mergedRegistry[canonicalTarget] || { sessionKey: canonicalTarget, mode: 'active', aliases: [] };
      const aliases = new Set(Array.isArray(entry.aliases) ? entry.aliases : []);
      aliases.add(logicalKey);
      entry.aliases = [...aliases].sort();
      mergedRegistry[canonicalTarget] = entry;

      const canonicalEncodedName = encodeSessionDirName(canonicalTarget);
      if (version === 'v2' && !sessionDirNames.has(canonicalEncodedName)) {
        // A registered alias may be the only physical v2 state left. Move it
        // into the canonical slot instead of archiving the sole live copy.
        // If another source targets the same slot, planChanges() still fails
        // closed via its multiple-migration-source guard.
        encodedMigrations.push({
          dirName,
          canonicalTarget,
          logicalKey,
          encodedName: canonicalEncodedName,
        });
        continue;
      }
      aliasDirs.push({ dirName, canonicalTarget, ...(encoded ? { logicalKey } : {}) });
      continue;
    }

    if (!canonicalKeys.has(logicalKey)) {
      unmanagedDirs.push(dirName);
    }
  }

  for (const entry of Object.values(mergedRegistry)) {
    if (Array.isArray(entry.aliases) && entry.aliases.length === 0) {
      delete entry.aliases;
    }
  }

  return {
    sessionsDir,
    registrySnapshot,
    mergedRegistry,
    aliasDirs,
    unmanagedDirs,
    encodedMigrations,
    invalidEncodedDirs,
    skippedEncodedDirs,
    registryOwnershipConflicts,
    legacyCaseFoldCollisions,
    encodedOwnershipConflicts,
    canonicalKeys: [...canonicalKeys].sort(),
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Unlike ensureDir(), this fails if `dir` already exists: `selectBackupRoot`
// only picks a path that *looked* free via a plain existsSync check, which
// is racy against a concurrent `normalize:sessions --apply`. This is the
// atomic tie-breaker -- the loser gets EEXIST here instead of silently
// sharing (and, on failure, deleting) the winner's backup directory.
function claimDirExclusively(dir) {
  ensureDir(path.dirname(dir));
  fs.mkdirSync(dir);
}

function moveDir(source, destination) {
  ensureDir(path.dirname(destination));
  fs.renameSync(source, destination);
}

function selectBackupRoot(rootDir, now = new Date()) {
  const parent = path.join(rootDir, 'cleanup-backups');
  const baseName = timestamp(now);
  let candidate = path.join(parent, baseName, 'session-normalization');
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(parent, `${baseName}-${suffix}`, 'session-normalization');
    suffix += 1;
  }
  return candidate;
}

function planChanges(rootDir, analysis, options) {
  if (analysis.invalidEncodedDirs.length > 0) {
    throw new Error(`invalid encoded session directories: ${analysis.invalidEncodedDirs.join(', ')}`);
  }
  if (analysis.encodedOwnershipConflicts.length > 0) {
    const reasonLabels = {
      'missing-owner': 'no registry owner',
      'multiple-owners': 'multiple registry owners',
      'unclaimed-decoded-key': 'decoded key is not claimed by its registry owner',
      'noncanonical-name': 'noncanonical encoded-looking directory name',
    };
    const details = analysis.encodedOwnershipConflicts
      .map(
        (collision) =>
          `${collision.foldedName} => [${collision.sessionKeys.join(', ')}] (${reasonLabels[collision.reason]})`,
      )
      .join('; ');
    const label = analysis.encodedOwnershipConflicts.every((collision) => collision.foldedName.startsWith('v1_'))
      ? 'legacy v1 case-fold collision'
      : 'encoded directory case-fold collision';
    throw new Error(
      `${label} detected: ${details}. No files were changed; ` +
        'repair registry/data ownership, then rerun normalize:sessions',
    );
  }
  if (analysis.registryOwnershipConflicts.length > 0) {
    const details = analysis.registryOwnershipConflicts
      .map((conflict) => `${conflict.sessionKey} => [${conflict.ownerKeys.join(', ')}]`)
      .join('; ');
    throw new Error(`registry ownership conflict detected: ${details}. No files were changed`);
  }
  // options.now：测试注入同一时刻，让预建的事务根目录与本次备份落在同一个时间戳目录（跨秒不再偶发分裂）
  const backupRoot = selectBackupRoot(rootDir, options?.now ?? new Date());
  const archiveRoot = path.join(backupRoot, 'archived-session-dirs');
  const migrationBackupRoot = path.join(backupRoot, 'legacy-canonical-dirs');
  const migrations = analysis.encodedMigrations.map((item) => ({
    ...item,
    source: path.join(analysis.sessionsDir, item.dirName),
    destination: path.join(analysis.sessionsDir, item.encodedName),
    backup: path.join(migrationBackupRoot, item.dirName),
  }));
  const archiveItems = [
    ...analysis.aliasDirs.map((item) => ({ ...item, reason: 'alias' })),
    ...(options.archiveUnmanaged
      ? analysis.unmanagedDirs
          .filter((dirName) => !analysis.skippedEncodedDirs.some((item) => item.dirName === dirName))
          .map((dirName) => ({ dirName, reason: 'unmanaged' }))
      : []),
  ].map((item) => ({
    ...item,
    source: path.join(analysis.sessionsDir, item.dirName),
    destination: path.join(archiveRoot, item.dirName),
  }));

  const migrationSourcesByDestination = new Map();
  for (const migration of migrations) {
    const foldedDestination = migration.destination.toLowerCase();
    const existingSource = migrationSourcesByDestination.get(foldedDestination);
    if (existingSource) {
      throw new Error(
        `multiple migration sources target the same v2 destination: ${existingSource}, ${migration.source} -> ${migration.destination}`,
      );
    }
    migrationSourcesByDestination.set(foldedDestination, migration.source);
  }

  for (const item of [...migrations, ...archiveItems]) {
    if (!fs.existsSync(item.source)) {
      throw new Error(`planned source no longer exists: ${item.source}`);
    }
    if (fs.existsSync(item.destination)) {
      throw new Error(`destination already exists: ${item.destination}`);
    }
  }

  const removedSessionDirNames = new Set(
    [...migrations, ...archiveItems].map((item) => path.basename(item.source)),
  );
  const plannedSessionDirNames = fs.existsSync(analysis.sessionsDir)
    ? fs
        .readdirSync(analysis.sessionsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !removedSessionDirNames.has(entry.name))
        .map((entry) => entry.name)
    : [];
  for (const migration of migrations) plannedSessionDirNames.push(path.basename(migration.destination));
  const plannedClassifiedDirs = classifySessionDirs(plannedSessionDirNames);
  const plannedOwnershipConflicts = findEncodedSessionDirOwnershipConflicts(
    plannedSessionDirNames,
    collectRegistrySessionClaims({}, analysis.mergedRegistry, plannedClassifiedDirs),
  );
  if (plannedOwnershipConflicts.length > 0) {
    const details = plannedOwnershipConflicts
      .map((conflict) => `${conflict.foldedName} => [${conflict.sessionKeys.join(', ')}] (${conflict.reason})`)
      .join('; ');
    throw new Error(`planned encoded directory case-fold collision detected: ${details}. No files were changed`);
  }

  return { backupRoot, archiveRoot, migrations, archiveItems };
}

let renewMigrationLease = null;

/**
 * 递归复制目录，每复制一个条目调一次 heartbeat：大目录备份期间也持续续租维护锁，
 * 不像 fs.cpSync 那样整段时间没有续租点。符号链接按链接复制，不解引用（与 cpSync 默认行为一致）。
 * @param {string} source
 * @param {string} destination
 * @param {() => void} heartbeat
 */
export function copyTreeWithHeartbeat(source, destination, heartbeat) {
  const stat = fs.lstatSync(source);
  heartbeat();
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyTreeWithHeartbeat(path.join(source, entry), path.join(destination, entry), heartbeat);
    }
    return;
  }
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), destination);
    return;
  }
  fs.copyFileSync(source, destination);
}

function runApplyHook(hooks, step, context) {
  // 每个步骤前续租：无法核对进程身份的环境靠标记 mtime 判断持锁者仍在，大目录备份/搬迁期间不能让租约过期
  renewMigrationLease?.();
  hooks.beforeStep?.(step, context);
}

function createAtomicTempPath(filePath, sequence) {
  const parent = path.dirname(filePath);
  const base = path.basename(filePath);
  let candidate = path.join(parent, `.${base}.tmp-${process.pid}-${sequence}`);
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(parent, `.${base}.tmp-${process.pid}-${sequence}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

function atomicWriteFile(filePath, content, stepPrefix, hooks, transaction, validateBeforeRename = null) {
  ensureDir(path.dirname(filePath));
  const tempPath = createAtomicTempPath(filePath, transaction.nextTempSequence);
  transaction.nextTempSequence += 1;
  transaction.tempPaths.add(tempPath);
  runApplyHook(hooks, `${stepPrefix}:write`);
  fs.writeFileSync(tempPath, content);
  runApplyHook(hooks, `${stepPrefix}:rename`);
  validateBeforeRename?.();
  fs.renameSync(tempPath, filePath);
  transaction.tempPaths.delete(tempPath);
}

function assertRegistryStillOwnedForRollback(registryPath, committedContent) {
  const committedSnapshot = { exists: true, bytes: Buffer.from(committedContent) };
  const currentSnapshot = readRegistrySnapshot(registryPath);
  if (!registrySnapshotsEqual(committedSnapshot, currentSnapshot)) {
    throw new Error(
      'registry state conflict: registry changed after this normalization transaction committed it; ' +
        'refusing to overwrite a concurrent update during rollback',
    );
  }
}

function restoreRegistry(registryPath, existedBefore, contentBefore, committedContent, transaction) {
  if (!existedBefore) {
    assertRegistryStillOwnedForRollback(registryPath, committedContent);
    fs.rmSync(registryPath, { force: true });
    return;
  }
  const tempPath = createAtomicTempPath(registryPath, transaction.nextTempSequence);
  transaction.nextTempSequence += 1;
  transaction.tempPaths.add(tempPath);
  fs.writeFileSync(tempPath, contentBefore);
  assertRegistryStillOwnedForRollback(registryPath, committedContent);
  fs.renameSync(tempPath, registryPath);
  transaction.tempPaths.delete(tempPath);
}

function removeOwnedEmptyDirectory(dirPath, existedBefore) {
  if (!existedBefore && fs.existsSync(dirPath) && fs.readdirSync(dirPath).length === 0) {
    fs.rmdirSync(dirPath);
  }
}

function writeRecoveryJournal(backupRoot, originalError, rollbackErrors, transaction, registryPath) {
  const recoveryPath = path.join(backupRoot, 'recovery.json');
  const content = `${JSON.stringify(
    {
      status: 'rollback-incomplete',
      originalError: originalError instanceof Error ? originalError.message : String(originalError),
      rollbackErrors,
      registry: {
        path: registryPath,
        backup: path.join(backupRoot, 'registry.json'),
      },
      ownership: transaction.ownership,
      moves: transaction.moved.map((move) => ({
        kind: move.kind,
        source: move.source,
        destination: move.destination,
        backup: move.backup,
        sourceExists: fs.existsSync(move.source),
        destinationExists: fs.existsSync(move.destination),
        backupExists: fs.existsSync(move.backup),
      })),
    },
    null,
    2,
  )}\n`;
  const tempPath = createAtomicTempPath(recoveryPath, transaction.nextTempSequence);
  transaction.nextTempSequence += 1;
  try {
    fs.writeFileSync(tempPath, content);
    fs.renameSync(tempPath, recoveryPath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
  return recoveryPath;
}

/**
 * daemon / autopilot 不走迁移锁，目录被搬走后它们手里的路径就失效（下一次 writeJSON / 追加输出 ENOENT）。
 * 来源目录里有活着的 PID 就拒绝整个 apply，让用户先 stop。判定与运行时 MudSessionStore 共用 lib/session-process.mjs。
 * @param {string[]} sourceDirs
 */
export function assertNoLiveSessionProcess(sourceDirs) {
  const live = [];
  for (const dir of sourceDirs) {
    for (const p of listLiveSessionProcesses(dir)) live.push(`${dir} (${p.file} = ${p.pid})`);
  }
  if (live.length > 0) {
    throw new Error(
      `session process still running from a directory selected for migration/archive: ${live.join('; ')}. ` +
        'Stop it first (mud-ctl stop --session <key> / mud_admin stop), then rerun normalize:sessions --apply. No files were changed',
    );
  }
}

export function applyChanges(rootDir, analysis, options, hooks = {}) {
  // 与运行时 MudSessionStore 共用同一把跨进程锁：复核快照、搬目录、提交 registry 全程持锁，
  // 并发的 ensure() 不会在计划被接受后改写 registry 或抢建目标目录。
  const release = acquireMigrationLockSync(rootDir, { timeoutMs: options?.lockTimeoutMs ?? 5000 });
  renewMigrationLease = release.renew;
  try {
    return applyChangesLocked(rootDir, analysis, options, hooks);
  } finally {
    renewMigrationLease = null;
    release();
  }
}

function applyChangesLocked(rootDir, analysis, options, hooks = {}) {
  const registryPath = path.join(rootDir, 'registry.json');
  const currentRegistrySnapshot = readRegistrySnapshot(registryPath);
  assertRegistrySnapshotUnchanged(registryPath, analysis.registrySnapshot);
  const plan = planChanges(rootDir, analysis, options);
  const { backupRoot, archiveRoot, migrations, archiveItems } = plan;
  assertNoLiveSessionProcess([...migrations, ...archiveItems].map((item) => item.source));
  const registryContent = `${JSON.stringify(analysis.mergedRegistry, null, 2)}\n`;
  const registryExists = currentRegistrySnapshot.exists;
  const registryContentBefore = currentRegistrySnapshot.bytes;
  const registryShouldExist = registryExists || Object.keys(analysis.mergedRegistry).length > 0;
  const registryUnchanged =
    !registryShouldExist || (registryExists && registryContentBefore.toString('utf8') === registryContent);
  const registryNeedsWrite = !registryUnchanged;
  if (migrations.length === 0 && archiveItems.length === 0 && !registryNeedsWrite) {
    return { backupRoot: null, archived: [], encodedMigrations: [] };
  }

  const transactionRoot = path.dirname(backupRoot);
  const cleanupBackupsRoot = path.dirname(transactionRoot);
  const cleanupBackupsRootExisted = fs.existsSync(cleanupBackupsRoot);
  const transactionRootExisted = fs.existsSync(transactionRoot);
  const transactionRootEntriesBefore = transactionRootExisted ? fs.readdirSync(transactionRoot) : [];
  const transaction = {
    moved: [],
    tempPaths: new Set(),
    registryCommitted: false,
    backupRootCreated: false,
    nextTempSequence: 1,
    ownership: {
      cleanupBackupsRootExisted,
      transactionRootExisted,
      transactionRootEntriesBefore,
    },
  };
  const archived = [];
  const appliedMigrations = migrations.map(({ source, destination, backup }) => ({ source, destination, backup }));
  try {
    runApplyHook(hooks, 'backup:claim', { backupRoot });
    try {
      claimDirExclusively(backupRoot);
    } catch (claimError) {
      if (claimError.code === 'EEXIST') {
        throw new Error(
          `backup directory already exists, likely a concurrent normalize:sessions --apply run: ${backupRoot}`,
        );
      }
      throw claimError;
    }
    transaction.backupRootCreated = true;
    if (archiveItems.length > 0) ensureDir(archiveRoot);
    if (registryExists) fs.copyFileSync(registryPath, path.join(backupRoot, 'registry.json'));

    for (const item of migrations) {
      ensureDir(path.dirname(item.backup));
      copyTreeWithHeartbeat(item.source, item.backup, () => renewMigrationLease?.());
    }

    for (const item of migrations) {
      runApplyHook(hooks, 'migration:rename');
      moveDir(item.source, item.destination);
      transaction.moved.push({
        kind: 'migration',
        source: item.source,
        destination: item.destination,
        backup: item.backup,
      });
    }

    for (const item of archiveItems) {
      runApplyHook(hooks, 'archive:rename');
      moveDir(item.source, item.destination);
      transaction.moved.push({
        kind: 'archive',
        source: item.source,
        destination: item.destination,
        backup: item.destination,
      });
      archived.push({
        name: item.dirName,
        reason: item.reason,
        ...(item.canonicalTarget ? { canonical: item.canonicalTarget } : {}),
      });
    }

    if (registryNeedsWrite) {
      atomicWriteFile(
        registryPath,
        registryContent,
        'registry',
        hooks,
        transaction,
        () => assertRegistrySnapshotUnchanged(registryPath, currentRegistrySnapshot),
      );
      transaction.registryCommitted = true;
    }
    const manifestContent = `${JSON.stringify(
      { archived, encodedMigrations: appliedMigrations, archiveUnmanaged: options.archiveUnmanaged },
      null,
      2,
    )}\n`;
    atomicWriteFile(path.join(backupRoot, 'manifest.json'), manifestContent, 'manifest', hooks, transaction);
  } catch (error) {
    const rollbackErrors = [];
    for (const move of [...transaction.moved].reverse()) {
      try {
        const destinationExists = fs.existsSync(move.destination);
        const sourceExists = fs.existsSync(move.source);
        if (!destinationExists || sourceExists) {
          rollbackErrors.push(
            `move ${move.destination}: state conflict ` +
              `(source ${move.source} ${sourceExists ? 'exists' : 'missing'}, ` +
              `destination ${destinationExists ? 'exists' : 'missing'})`,
          );
          continue;
        }
        runApplyHook(hooks, `rollback:${move.kind}:rename`);
        fs.renameSync(move.destination, move.source);
      } catch (rollbackError) {
        rollbackErrors.push(`move ${move.destination}: ${String(rollbackError)}`);
      }
    }
    if (transaction.registryCommitted) {
      try {
        runApplyHook(hooks, 'rollback:registry:restore');
        restoreRegistry(registryPath, registryExists, registryContentBefore, registryContent, transaction);
      } catch (rollbackError) {
        rollbackErrors.push(`registry: ${String(rollbackError)}`);
      }
    }
    for (const tempPath of transaction.tempPaths) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch (rollbackError) {
        rollbackErrors.push(`temp ${tempPath}: ${String(rollbackError)}`);
      }
    }
    let recoveryPath = null;
    if (rollbackErrors.length === 0) {
      try {
        // Only remove backupRoot if this transaction actually created it.
        // If claimDirExclusively() above failed with EEXIST, backupRoot
        // belongs to some other (likely concurrent) run and must be left
        // alone -- deleting it would destroy that run's real backup data.
        if (transaction.backupRootCreated) {
          fs.rmSync(backupRoot, { recursive: true, force: true });
          // We just relinquished backupRoot back to the filesystem, so we
          // no longer own it -- a concurrent run's own claimDirExclusively()
          // can legitimately recreate it at this exact path before this
          // function returns. backupRootCreated must track *current*
          // ownership, not "did we ever create it", or the recovery-journal
          // write further down could still target that new owner's
          // directory using this stale flag.
          transaction.backupRootCreated = false;
        }
        runApplyHook(hooks, 'rollback:parent:cleanup');
        removeOwnedEmptyDirectory(transactionRoot, transactionRootExisted);
        removeOwnedEmptyDirectory(cleanupBackupsRoot, cleanupBackupsRootExisted);
      } catch (rollbackError) {
        rollbackErrors.push(`backup ${backupRoot}: ${String(rollbackError)}`);
      }
    }
    // Same ownership guard as the rmSync above: if we never claimed
    // backupRoot (lost the race, or failed before attempting the claim),
    // it isn't ours to write into -- even a "just" recovery.json would
    // corrupt whatever real backup another run put there. Any rollback
    // errors at this point (e.g. a failed empty-parent-dir cleanup) are
    // still reported in the thrown error's message below; they just have
    // no legitimate backupRoot to be filed under.
    if (rollbackErrors.length > 0 && transaction.backupRootCreated) {
      recoveryPath = backupRoot;
      try {
        writeRecoveryJournal(backupRoot, error, rollbackErrors, transaction, registryPath);
      } catch (recoveryError) {
        rollbackErrors.push(`recovery journal: ${String(recoveryError)}`);
      }
    }
    const rollbackNote = rollbackErrors.length > 0
      ? `; rollback errors: ${rollbackErrors.join('; ')}; recovery path: ${recoveryPath}`
      : '';
    throw new Error(`${error instanceof Error ? error.message : String(error)}${rollbackNote}`, { cause: error });
  }

  return { backupRoot, archived, encodedMigrations: appliedMigrations };
}

function printHumanSummary(options, analysis, applyResult) {
  console.log(options.apply ? '[normalize] 已执行 session 规范化' : '[normalize] dry-run（未写入）');
  console.log(`[normalize] MUD_DIR: ${options.mudDir}`);
  console.log(`[normalize] canonical sessions: ${analysis.canonicalKeys.length}`);
  console.log(`[normalize] alias dirs: ${analysis.aliasDirs.length}`);
  console.log(`[normalize] encoded migrations: ${analysis.encodedMigrations.length}`);
  console.log(`[normalize] invalid encoded dirs: ${analysis.invalidEncodedDirs.length}`);
  console.log(`[normalize] skipped encoded dirs: ${analysis.skippedEncodedDirs.length}`);
  console.log(`[normalize] registry ownership conflicts: ${analysis.registryOwnershipConflicts.length}`);
  console.log(`[normalize] legacy v1 case-fold collisions: ${analysis.legacyCaseFoldCollisions.length}`);
  console.log(`[normalize] unmanaged dirs: ${analysis.unmanagedDirs.length}`);

  if (analysis.legacyCaseFoldCollisions.length) {
    console.log('\n[normalize] legacy v1 case-fold collisions (apply will fail closed)');
    for (const collision of analysis.legacyCaseFoldCollisions) {
      console.log(`- ${collision.foldedName}: ${collision.sessionKeys.join(', ')}`);
    }
  }

  if (analysis.registryOwnershipConflicts.length) {
    console.log('\n[normalize] registry ownership conflicts (apply will fail closed)');
    for (const conflict of analysis.registryOwnershipConflicts) {
      console.log(`- ${conflict.sessionKey}: ${conflict.ownerKeys.join(', ')}`);
    }
  }

  if (analysis.encodedMigrations.length) {
    console.log('\n[normalize] legacy canonical dirs -> encoded');
    for (const item of analysis.encodedMigrations) {
      console.log(`- ${item.dirName} -> ${item.encodedName}`);
    }
  }

  if (analysis.invalidEncodedDirs.length) {
    console.log('\n[normalize] invalid encoded dirs (apply will fail closed)');
    for (const dirName of analysis.invalidEncodedDirs) {
      console.log(`- ${dirName}`);
    }
  }

  if (analysis.skippedEncodedDirs.length) {
    console.log('\n[normalize] skipped encoded dirs (preserved unmanaged)');
    for (const item of analysis.skippedEncodedDirs) {
      console.log(`- ${item.dirName}: ${item.reason}`);
    }
  }

  if (analysis.aliasDirs.length) {
    console.log('\n[normalize] alias dirs -> canonical');
    for (const item of analysis.aliasDirs) {
      console.log(`- ${item.dirName} -> ${item.canonicalTarget}`);
    }
  }

  if (analysis.unmanagedDirs.length) {
    console.log('\n[normalize] unmanaged dirs');
    for (const dirName of analysis.unmanagedDirs) {
      console.log(`- ${dirName}`);
    }
    if (!options.archiveUnmanaged) {
      console.log('[normalize] 如需一并归档 unmanaged dirs，请追加 --archive-unmanaged');
    }
  }

  if (applyResult) {
    console.log(`\n[normalize] backup: ${applyResult.backupRoot}`);
    console.log(`[normalize] archived dirs: ${applyResult.archived.length}`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(options.mudDir);
  const { registry, snapshot } = loadRegistry(path.join(rootDir, 'registry.json'));
  const analysis = analyzeSessions(rootDir, registry, snapshot);
  const applyResult = options.apply ? applyChanges(rootDir, analysis, options) : null;
  const output = {
    mode: options.apply ? 'apply' : 'dry-run',
    mudDir: rootDir,
    canonicalKeys: analysis.canonicalKeys,
    aliasDirs: analysis.aliasDirs,
    encodedMigrations: analysis.encodedMigrations,
    invalidEncodedDirs: analysis.invalidEncodedDirs,
    skippedEncodedDirs: analysis.skippedEncodedDirs,
    registryOwnershipConflicts: analysis.registryOwnershipConflicts,
    legacyCaseFoldCollisions: analysis.legacyCaseFoldCollisions,
    unmanagedDirs: analysis.unmanagedDirs,
    ...(applyResult ? { backupRoot: applyResult.backupRoot, archived: applyResult.archived } : {}),
  };

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  printHumanSummary(options, analysis, applyResult);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[normalize] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
