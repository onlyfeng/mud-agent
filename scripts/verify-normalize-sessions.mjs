#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeSessions, applyChanges, decodeSessionDirName, encodeSessionDirName } from './normalize-sessions.mjs';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const normalizeScript = path.join(repoRoot, 'scripts', 'normalize-sessions.mjs');

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function writeSessionDir(sessionsDir, name, marker = name) {
  const dir = path.join(sessionsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'state.json'), { connected: false, loginDone: false, marker });
  writeJson(path.join(dir, 'alerts.json'), []);
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mud-agent-normalize-'));
  const mudDir = path.join(root, '.mud-agent');
  const sessionsDir = path.join(mudDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });

  const canonical = 'agent:main:telegram:group:-100:topic:1234';
  const encodedCanonical = encodeSessionDirName(canonical);
  const registryAlias = 'telegram:-100:1234';
  const shortAlias = 'topic-1234';
  const unmanaged = 'xiyouji';

  for (const name of [encodedCanonical, shortAlias, unmanaged]) {
    writeSessionDir(sessionsDir, name);
  }

  writeJson(path.join(mudDir, 'registry.json'), {
    [canonical]: { sessionKey: canonical, mode: 'active' },
    [registryAlias]: { sessionKey: registryAlias, mode: 'active' },
  });

  return { mudDir, sessionsDir, canonical, encodedCanonical, registryAlias, shortAlias, unmanaged };
}

function runNormalize(args) {
  return execFileSync(process.execPath, [normalizeScript, ...args], { encoding: 'utf8' });
}

function runNormalizeResult(args) {
  return spawnSync(process.execPath, [normalizeScript, ...args], { encoding: 'utf8' });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function findSingleBackup(mudDir) {
  const backupsDir = path.join(mudDir, 'cleanup-backups');
  const timestamps = fs.readdirSync(backupsDir);
  assert.equal(timestamps.length, 1);
  return path.join(backupsDir, timestamps[0], 'session-normalization');
}

function listTree(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  return fs.readdirSync(rootDir, { recursive: true }).map(String).sort();
}

function formatBackupTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function makePreexistingTransactionRoot(mudDir) {
  // 与随后的 applyChanges 共用同一个 now：脚本用它选备份根目录，跨秒时不会落到另一个时间戳目录
  const now = new Date();
  const transactionRoot = path.join(mudDir, 'cleanup-backups', formatBackupTimestamp(now));
  fs.mkdirSync(transactionRoot, { recursive: true });
  const sentinelPath = path.join(transactionRoot, 'preexisting-sentinel.txt');
  fs.writeFileSync(sentinelPath, 'do not delete');
  return { transactionRoot, sentinelPath, now };
}

function encodeLegacyV1(sessionKey) {
  return `v1_${Buffer.from(sessionKey, 'utf8').toString('base64url')}`;
}

function makeLegacyV1Fixture(sessionKeys = ['AAG']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mud-agent-v1-normalize-'));
  const mudDir = path.join(root, '.mud-agent');
  const sessionsDir = path.join(mudDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  writeJson(
    path.join(mudDir, 'registry.json'),
    Object.fromEntries(sessionKeys.map((sessionKey) => [sessionKey, { sessionKey, mode: 'active' }])),
  );
  return { mudDir, sessionsDir };
}

function testPortableV1MigrationAndIdempotency() {
  const fixture = makeLegacyV1Fixture();
  const legacyName = encodeLegacyV1('AAG');
  const v2Name = 'v2_414147';
  writeSessionDir(fixture.sessionsDir, legacyName, 'legacy-v1');
  const registryPath = path.join(fixture.mudDir, 'registry.json');
  writeJson(registryPath, { AAG: { sessionKey: 'AAG', mode: 'paused' } });
  const registryBefore = fs.readFileSync(registryPath, 'utf8');

  const dryRun = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--json']));
  assert.deepEqual(dryRun.legacyCaseFoldCollisions, []);
  assert.deepEqual(dryRun.encodedMigrations, [{
    dirName: legacyName,
    canonicalTarget: 'AAG',
    encodedName: v2Name,
  }]);
  assert.equal(fs.readFileSync(registryPath, 'utf8'), registryBefore);
  assert.ok(fs.existsSync(path.join(fixture.sessionsDir, legacyName)));
  assert.ok(!fs.existsSync(path.join(fixture.sessionsDir, v2Name)));

  const applied = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--apply', '--json']));
  assert.equal(applied.encodedMigrations.length, 1);
  assert.ok(!fs.existsSync(path.join(fixture.sessionsDir, legacyName)));
  assert.equal(readJson(path.join(fixture.sessionsDir, v2Name, 'state.json')).marker, 'legacy-v1');
  assert.equal(readJson(registryPath).AAG.mode, 'paused');
  const backupRoot = findSingleBackup(fixture.mudDir);
  const migration = readJson(path.join(backupRoot, 'manifest.json')).encodedMigrations[0];
  assert.equal(migration.source, path.join(fixture.sessionsDir, legacyName));
  assert.equal(migration.destination, path.join(fixture.sessionsDir, v2Name));
  assert.equal(readJson(path.join(migration.backup, 'state.json')).marker, 'legacy-v1');

  const backupGroups = fs.readdirSync(path.join(fixture.mudDir, 'cleanup-backups'));
  const rerun = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--apply', '--json']));
  assert.deepEqual(rerun.encodedMigrations, []);
  assert.deepEqual(rerun.legacyCaseFoldCollisions, []);
  assert.deepEqual(fs.readdirSync(path.join(fixture.mudDir, 'cleanup-backups')), backupGroups);
}

function testPortableV1AliasMigratesToCanonicalSlotNotAliasSlot() {
  const fixture = makeLegacyV1Fixture();
  const canonical = 'canonical';
  const alias = 'legacy-alias';
  const legacyName = encodeLegacyV1(alias);
  const canonicalV2Name = encodeSessionDirName(canonical);
  const aliasEncodedAsIfCanonical = encodeSessionDirName(alias);
  writeJson(path.join(fixture.mudDir, 'registry.json'), {
    [canonical]: { sessionKey: canonical, mode: 'active', aliases: [alias] },
  });
  writeSessionDir(fixture.sessionsDir, legacyName, 'legacy-alias');

  const dryRun = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--json']));
  assert.deepEqual(dryRun.encodedMigrations, [{
    dirName: legacyName,
    canonicalTarget: canonical,
    logicalKey: alias,
    encodedName: canonicalV2Name,
  }]);
  assert.ok(!dryRun.unmanagedDirs.includes(legacyName));

  const applied = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--apply', '--json']));
  assert.equal(applied.encodedMigrations.length, 1);
  assert.ok(!fs.existsSync(path.join(fixture.sessionsDir, legacyName)));
  // The bug this guards against: migrating by encoding the alias (instead of
  // the canonical key) would have created this directory name and left the
  // data unreachable through store.ensure()/resolveSessionDir(), which only
  // ever look up the canonical encoding.
  assert.ok(!fs.existsSync(path.join(fixture.sessionsDir, aliasEncodedAsIfCanonical)));
  assert.equal(readJson(path.join(fixture.sessionsDir, canonicalV2Name, 'state.json')).marker, 'legacy-alias');
  const backupRoot = findSingleBackup(fixture.mudDir);
  const migration = readJson(path.join(backupRoot, 'manifest.json')).encodedMigrations[0];
  assert.equal(readJson(path.join(migration.backup, 'state.json')).marker, 'legacy-alias');

  const backupGroups = fs.readdirSync(path.join(fixture.mudDir, 'cleanup-backups'));
  const rerun = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--apply', '--json']));
  assert.deepEqual(rerun.encodedMigrations, []);
  assert.deepEqual(fs.readdirSync(path.join(fixture.mudDir, 'cleanup-backups')), backupGroups);
}

function testPortableV1AliasDestinationConflictFailsClosed() {
  const fixture = makeLegacyV1Fixture();
  const canonical = 'canonical';
  const alias = 'legacy-alias';
  const legacyName = encodeLegacyV1(alias);
  const canonicalV2Name = encodeSessionDirName(canonical);
  writeJson(path.join(fixture.mudDir, 'registry.json'), {
    [canonical]: { sessionKey: canonical, mode: 'active', aliases: [alias] },
  });
  writeSessionDir(fixture.sessionsDir, legacyName, 'legacy-alias');
  // Canonical session already has its own live v2 directory: migrating the
  // alias copy into it would silently overwrite or require a merge, so this
  // must fail closed instead, preserving both copies untouched.
  writeSessionDir(fixture.sessionsDir, canonicalV2Name, 'canonical-live');
  const registryPath = path.join(fixture.mudDir, 'registry.json');
  const registryBefore = fs.readFileSync(registryPath, 'utf8');

  const apply = runNormalizeResult(['--mud-dir', fixture.mudDir, '--apply', '--json']);
  assert.notEqual(apply.status, 0);
  assert.match(apply.stderr, /destination already exists/i);
  assert.equal(readJson(path.join(fixture.sessionsDir, legacyName, 'state.json')).marker, 'legacy-alias');
  assert.equal(readJson(path.join(fixture.sessionsDir, canonicalV2Name, 'state.json')).marker, 'canonical-live');
  assert.equal(fs.readFileSync(registryPath, 'utf8'), registryBefore);
  assert.ok(!fs.existsSync(path.join(fixture.mudDir, 'cleanup-backups')));
}

function testRawCanonicalDirIsNotSilentlyShadowedByAliasV1Migration() {
  if (process.platform === 'win32') return;

  const fixture = makeLegacyV1Fixture();
  const canonical = 'agent:main:telegram:group:-100:topic:1';
  const alias = 'topic-1';
  const legacyName = encodeLegacyV1(alias);
  writeJson(path.join(fixture.mudDir, 'registry.json'), {
    [canonical]: { sessionKey: canonical, mode: 'active', aliases: [alias] },
  });
  writeSessionDir(fixture.sessionsDir, legacyName, 'stale-alias-data');
  // A raw (unencoded) directory literally named after canonical is a
  // supported legacy storage form; the classifier picks it up as its own
  // migration candidate targeting the same v2 destination as the alias
  // migration, so the existing multiple-sources check must fail this
  // closed rather than let one silently overwrite/shadow the other.
  writeSessionDir(fixture.sessionsDir, canonical, 'REAL-LIVE-CANONICAL-DATA');
  const registryPath = path.join(fixture.mudDir, 'registry.json');
  const registryBefore = fs.readFileSync(registryPath, 'utf8');

  const apply = runNormalizeResult(['--mud-dir', fixture.mudDir, '--apply', '--json']);
  assert.notEqual(apply.status, 0);
  assert.match(apply.stderr, /multiple migration sources target the same v2 destination/i);
  assert.equal(readJson(path.join(fixture.sessionsDir, legacyName, 'state.json')).marker, 'stale-alias-data');
  assert.equal(
    readJson(path.join(fixture.sessionsDir, canonical, 'state.json')).marker,
    'REAL-LIVE-CANONICAL-DATA',
  );
  assert.equal(fs.readFileSync(registryPath, 'utf8'), registryBefore);
  assert.ok(!fs.existsSync(path.join(fixture.mudDir, 'cleanup-backups')));
}

function testRawCanonicalDirIsNotSilentlyShadowedByExactV1Migration() {
  if (process.platform === 'win32') return;

  const fixture = makeLegacyV1Fixture();
  const canonical = 'plain-canonical-key';
  const legacyName = encodeLegacyV1(canonical);
  writeJson(path.join(fixture.mudDir, 'registry.json'), {
    [canonical]: { sessionKey: canonical, mode: 'active' },
  });
  writeSessionDir(fixture.sessionsDir, legacyName, 'v1-data');
  // Same hazard as above but for the plain (non-alias) v1 migration path: a
  // coexisting raw canonical directory is its own competing migration
  // source and must not be silently overwritten/shadowed.
  writeSessionDir(fixture.sessionsDir, canonical, 'REAL-LIVE-CANONICAL-DATA');
  const registryPath = path.join(fixture.mudDir, 'registry.json');
  const registryBefore = fs.readFileSync(registryPath, 'utf8');

  const apply = runNormalizeResult(['--mud-dir', fixture.mudDir, '--apply', '--json']);
  assert.notEqual(apply.status, 0);
  assert.match(apply.stderr, /multiple migration sources target the same v2 destination/i);
  assert.equal(readJson(path.join(fixture.sessionsDir, legacyName, 'state.json')).marker, 'v1-data');
  assert.equal(
    readJson(path.join(fixture.sessionsDir, canonical, 'state.json')).marker,
    'REAL-LIVE-CANONICAL-DATA',
  );
  assert.equal(fs.readFileSync(registryPath, 'utf8'), registryBefore);
  assert.ok(!fs.existsSync(path.join(fixture.mudDir, 'cleanup-backups')));
}

function testAliasRawDirIsArchivedNotSilentlyLostWhenAnotherAliasMigrates() {
  if (process.platform === 'win32') return;

  const fixture = makeLegacyV1Fixture();
  const canonical = 'agent:main:telegram:group:-100:topic:1';
  const aliasA = 'topic-1';
  const aliasB = 'telegram:-100:1';
  const legacyAliasADir = encodeLegacyV1(aliasA);
  const canonicalV2Name = encodeSessionDirName(canonical);
  writeJson(path.join(fixture.mudDir, 'registry.json'), {
    [canonical]: { sessionKey: canonical, mode: 'active', aliases: [aliasA, aliasB] },
  });
  writeSessionDir(fixture.sessionsDir, legacyAliasADir, 'stale-alias-a');
  // A DIFFERENT alias's raw directory for the same canonical. Unlike the
  // runtime (which has no archiving mechanism and must fail closed), the CLI
  // classifier already recognizes this as its own alias-dir entry and
  // archives it in the same --apply transaction, so it must land safely in
  // the backup rather than being silently left behind or lost.
  writeSessionDir(fixture.sessionsDir, aliasB, 'REAL-alias-b-data');

  const dryRun = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--json']));
  assert.deepEqual(dryRun.encodedMigrations, [{
    dirName: legacyAliasADir,
    canonicalTarget: canonical,
    logicalKey: aliasA,
    encodedName: canonicalV2Name,
  }]);
  assert.ok(dryRun.aliasDirs.some((item) => item.dirName === aliasB && item.canonicalTarget === canonical));

  const applied = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--apply', '--json']));
  assert.equal(applied.encodedMigrations.length, 1);
  assert.ok(!fs.existsSync(path.join(fixture.sessionsDir, legacyAliasADir)));
  assert.ok(!fs.existsSync(path.join(fixture.sessionsDir, aliasB)));
  assert.equal(readJson(path.join(fixture.sessionsDir, canonicalV2Name, 'state.json')).marker, 'stale-alias-a');

  const backupRoot = findSingleBackup(fixture.mudDir);
  const manifest = readJson(path.join(backupRoot, 'manifest.json'));
  assert.ok(manifest.archived.some(
    (item) => item.name === aliasB && item.reason === 'alias' && item.canonical === canonical,
  ));
  assert.equal(
    readJson(path.join(backupRoot, 'archived-session-dirs', aliasB, 'state.json')).marker,
    'REAL-alias-b-data',
  );
}

function testRegisteredV2AliasDirIsArchivedWithoutTouchingCanonicalData() {
  const fixture = makeLegacyV1Fixture();
  const canonical = 'agent:main:telegram:group:-100:topic:1';
  const alias = 'topic-1';
  const canonicalV2Name = encodeSessionDirName(canonical);
  const aliasV2Name = encodeSessionDirName(alias);
  writeJson(path.join(fixture.mudDir, 'registry.json'), {
    [canonical]: { sessionKey: canonical, mode: 'active', aliases: [alias] },
  });
  writeSessionDir(fixture.sessionsDir, canonicalV2Name, 'canonical-live');
  writeSessionDir(fixture.sessionsDir, aliasV2Name, 'stale-v2-alias');

  const dryRun = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--json']));
  assert.ok(dryRun.aliasDirs.some(
    (item) => item.dirName === aliasV2Name
      && item.logicalKey === alias
      && item.canonicalTarget === canonical,
  ));

  const applied = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--apply', '--json']));
  assert.ok(!fs.existsSync(path.join(fixture.sessionsDir, aliasV2Name)));
  assert.equal(
    readJson(path.join(fixture.sessionsDir, canonicalV2Name, 'state.json')).marker,
    'canonical-live',
  );
  const backupRoot = findSingleBackup(fixture.mudDir);
  const manifest = readJson(path.join(backupRoot, 'manifest.json'));
  assert.ok(manifest.archived.some(
    (item) => item.name === aliasV2Name
      && item.reason === 'alias'
      && item.canonical === canonical,
  ));
  assert.equal(
    readJson(path.join(backupRoot, 'archived-session-dirs', aliasV2Name, 'state.json')).marker,
    'stale-v2-alias',
  );
  assert.equal(applied.archived.length, 1);
}

function testRegisteredV2AliasMigratesWhenCanonicalSlotIsMissing() {
  const fixture = makeLegacyV1Fixture();
  const canonical = 'agent:main:telegram:group:-100:topic:1';
  const alias = 'topic-1';
  const canonicalV2Name = encodeSessionDirName(canonical);
  const aliasV2Name = encodeSessionDirName(alias);
  writeJson(path.join(fixture.mudDir, 'registry.json'), {
    [canonical]: { sessionKey: canonical, mode: 'active', aliases: [alias] },
  });
  writeSessionDir(fixture.sessionsDir, aliasV2Name, 'sole-v2-alias-state');

  const dryRun = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--json']));
  assert.deepEqual(dryRun.encodedMigrations, [{
    dirName: aliasV2Name,
    canonicalTarget: canonical,
    logicalKey: alias,
    encodedName: canonicalV2Name,
  }]);
  assert.ok(!dryRun.aliasDirs.some((item) => item.dirName === aliasV2Name));

  const applied = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--apply', '--json']));
  assert.equal(applied.encodedMigrations.length, 1);
  assert.ok(!fs.existsSync(path.join(fixture.sessionsDir, aliasV2Name)));
  assert.equal(
    readJson(path.join(fixture.sessionsDir, canonicalV2Name, 'state.json')).marker,
    'sole-v2-alias-state',
  );
  const backupRoot = findSingleBackup(fixture.mudDir);
  const migration = readJson(path.join(backupRoot, 'manifest.json')).encodedMigrations[0];
  assert.equal(readJson(path.join(migration.backup, 'state.json')).marker, 'sole-v2-alias-state');

  const backupGroups = fs.readdirSync(path.join(fixture.mudDir, 'cleanup-backups'));
  const rerun = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--apply', '--json']));
  assert.deepEqual(rerun.encodedMigrations, []);
  assert.deepEqual(fs.readdirSync(path.join(fixture.mudDir, 'cleanup-backups')), backupGroups);
}

function testInvalidRegistryJsonFailsClosed() {
  const fixture = makeLegacyV1Fixture();
  const legacyName = encodeLegacyV1('AAG');
  const registryPath = path.join(fixture.mudDir, 'registry.json');
  fs.writeFileSync(registryPath, '{not-json');
  writeSessionDir(fixture.sessionsDir, legacyName, 'legacy-v1');

  const dryRun = runNormalizeResult(['--mud-dir', fixture.mudDir, '--json']);
  assert.notEqual(dryRun.status, 0);
  assert.match(dryRun.stderr, /registry.*JSON.*manual repair/i);
  assert.equal(fs.readFileSync(registryPath, 'utf8'), '{not-json');
  assert.equal(readJson(path.join(fixture.sessionsDir, legacyName, 'state.json')).marker, 'legacy-v1');
  assert.ok(!fs.existsSync(path.join(fixture.mudDir, 'cleanup-backups')));
}

function testRegistrySessionKeyDriftFailsClosed() {
  const fixture = makeLegacyV1Fixture();
  const legacyName = encodeLegacyV1('B');
  const registryPath = path.join(fixture.mudDir, 'registry.json');
  writeJson(registryPath, { A: { sessionKey: 'B', mode: 'active' } });
  const registryBefore = fs.readFileSync(registryPath, 'utf8');
  writeSessionDir(fixture.sessionsDir, legacyName, 'wrong-owner');

  for (const applyArgs of [[], ['--apply']]) {
    const result = runNormalizeResult(['--mud-dir', fixture.mudDir, ...applyArgs, '--json']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /registry entry.*A.*sessionKey.*B.*manual repair/i);
  }
  assert.equal(fs.readFileSync(registryPath, 'utf8'), registryBefore);
  assert.equal(readJson(path.join(fixture.sessionsDir, legacyName, 'state.json')).marker, 'wrong-owner');
  assert.ok(!fs.existsSync(path.join(fixture.sessionsDir, encodeSessionDirName('B'))));
  assert.ok(!fs.existsSync(path.join(fixture.mudDir, 'cleanup-backups')));
}

// 起一个命令行形如 `node .../daemon-entry.js` 的真实子进程充当会话 daemon（PID 身份核对看的是命令行）
function spawnFakeSessionEntry(mudDir) {
  const entry = path.join(mudDir, 'daemon-entry.js');
  fs.writeFileSync(entry, 'setTimeout(() => {}, 60_000);\n');
  const child = spawn(process.execPath, [entry], { stdio: 'ignore' });
  for (let i = 0; i < 50; i += 1) {
    const ps = spawnSync('ps', ['-o', 'command=', '-p', String(child.pid)], { encoding: 'utf8' });
    if (ps.status === 0 && ps.stdout.includes('daemon-entry.js')) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  return child;
}

function testApplyRefusesWhileSessionProcessIsLive() {
  const fixture = makeFixture();
  const registryPath = path.join(fixture.mudDir, 'registry.json');
  const child = spawnFakeSessionEntry(fixture.mudDir);
  try {
    fs.writeFileSync(path.join(fixture.sessionsDir, fixture.shortAlias, 'mud-daemon.pid'), String(child.pid));
    const analysis = analyzeSessions(fixture.mudDir, readJson(registryPath));
    const registryBefore = fs.readFileSync(registryPath);

    assert.throws(
      () => applyChanges(fixture.mudDir, analysis, { archiveUnmanaged: false }),
      /session process still running.*mud-daemon\.pid.*No files were changed/s,
    );
    assert.deepEqual(fs.readFileSync(registryPath), registryBefore);
    assert.ok(fs.existsSync(path.join(fixture.sessionsDir, fixture.shortAlias)));
    assert.ok(!fs.existsSync(path.join(fixture.mudDir, 'cleanup-backups')));
    assert.ok(!fs.existsSync(path.join(fixture.mudDir, '.migration.lock')));
  } finally {
    child.kill('SIGKILL');
  }

  fs.writeFileSync(path.join(fixture.sessionsDir, fixture.shortAlias, 'mud-daemon.pid'), '999999');
  applyChanges(fixture.mudDir, analyzeSessions(fixture.mudDir, readJson(registryPath)), { archiveUnmanaged: false });
  assert.ok(!fs.existsSync(path.join(fixture.sessionsDir, fixture.shortAlias)));
}

function testApplyIgnoresPidReusedByUnrelatedProcess() {
  // 强杀遗留的 PID 文件里的号码被无关进程复用：这里用本验证脚本自身的 pid（命令行不是 daemon/autopilot 入口）
  const fixture = makeFixture();
  const registryPath = path.join(fixture.mudDir, 'registry.json');
  fs.writeFileSync(path.join(fixture.sessionsDir, fixture.shortAlias, 'mud-daemon.pid'), String(process.pid));
  const analysis = analyzeSessions(fixture.mudDir, readJson(registryPath));
  applyChanges(fixture.mudDir, analysis, { archiveUnmanaged: false });
  assert.ok(!fs.existsSync(path.join(fixture.sessionsDir, fixture.shortAlias)));
}

function testApplyRejectsRegistryChangedAfterAnalysis() {
  const fixture = makeFixture();
  const registryPath = path.join(fixture.mudDir, 'registry.json');
  const analysis = analyzeSessions(fixture.mudDir, readJson(registryPath));
  const concurrentSession = 'concurrent-session';
  const concurrentRegistry = readJson(registryPath);
  concurrentRegistry[fixture.canonical].mode = 'paused';
  concurrentRegistry[concurrentSession] = { sessionKey: concurrentSession, mode: 'active' };
  writeJson(registryPath, concurrentRegistry);
  const concurrentRegistryBytes = fs.readFileSync(registryPath);

  assert.throws(
    () => applyChanges(fixture.mudDir, analysis, { archiveUnmanaged: false }),
    /registry.*changed.*rerun normalize:sessions/i,
  );
  assert.deepEqual(fs.readFileSync(registryPath), concurrentRegistryBytes);
  assert.equal(readJson(registryPath)[fixture.canonical].mode, 'paused');
  assert.equal(readJson(registryPath)[concurrentSession].sessionKey, concurrentSession);
  assert.ok(fs.existsSync(path.join(fixture.sessionsDir, fixture.shortAlias)));
  assert.ok(!fs.existsSync(path.join(fixture.mudDir, 'cleanup-backups')));
}

function testApplyRejectsRegistryChangedBeforeAtomicReplacement() {
  const fixture = makeFixture();
  const legacyName = encodeLegacyV1(fixture.canonical);
  fs.rmSync(path.join(fixture.sessionsDir, fixture.encodedCanonical), { recursive: true });
  writeSessionDir(fixture.sessionsDir, legacyName, 'concurrent-registry-write');
  const registryPath = path.join(fixture.mudDir, 'registry.json');
  const analysis = analyzeSessions(fixture.mudDir, readJson(registryPath));
  const concurrentSession = 'concurrent-session';
  const concurrentRegistry = readJson(registryPath);
  concurrentRegistry[fixture.canonical].mode = 'paused';
  concurrentRegistry[concurrentSession] = { sessionKey: concurrentSession, mode: 'active' };
  const concurrentRegistryBytes = Buffer.from(`${JSON.stringify(concurrentRegistry, null, 2)}\n`);

  assert.throws(
    () => applyChanges(
      fixture.mudDir,
      analysis,
      { archiveUnmanaged: false },
      {
        beforeStep: (step) => {
          if (step === 'registry:write') fs.writeFileSync(registryPath, concurrentRegistryBytes);
        },
      },
    ),
    /registry.*changed.*rerun normalize:sessions/i,
  );
  assert.deepEqual(fs.readFileSync(registryPath), concurrentRegistryBytes);
  assert.equal(readJson(registryPath)[fixture.canonical].mode, 'paused');
  assert.equal(readJson(registryPath)[concurrentSession].sessionKey, concurrentSession);
  assert.equal(
    readJson(path.join(fixture.sessionsDir, legacyName, 'state.json')).marker,
    'concurrent-registry-write',
  );
  assert.ok(!fs.existsSync(path.join(fixture.sessionsDir, fixture.encodedCanonical)));
  assert.ok(fs.existsSync(path.join(fixture.sessionsDir, fixture.shortAlias)));
  assert.ok(!fs.existsSync(path.join(fixture.mudDir, 'cleanup-backups')));
  assert.ok(!listTree(fixture.mudDir).some((entry) => entry.includes('.tmp-')));
}

function testApplyRejectsRegistryCreatedAfterMissingSnapshot() {
  const fixture = makeFixture();
  const registryPath = path.join(fixture.mudDir, 'registry.json');
  fs.rmSync(registryPath);
  const analysis = analyzeSessions(fixture.mudDir, {});
  const concurrentSession = 'concurrent-session';
  writeJson(registryPath, {
    [concurrentSession]: { sessionKey: concurrentSession, mode: 'paused' },
  });
  const concurrentRegistryBytes = fs.readFileSync(registryPath);

  assert.throws(
    () => applyChanges(fixture.mudDir, analysis, { archiveUnmanaged: false }),
    /registry.*changed.*rerun normalize:sessions/i,
  );
  assert.deepEqual(fs.readFileSync(registryPath), concurrentRegistryBytes);
  assert.ok(fs.existsSync(path.join(fixture.sessionsDir, fixture.shortAlias)));
  assert.ok(!fs.existsSync(path.join(fixture.mudDir, 'cleanup-backups')));
}

function testLiteralV1RawKeyAmbiguityFailsClosed() {
  const fixture = makeLegacyV1Fixture(['v1_YQ']);
  const ambiguousName = 'v1_YQ';
  writeSessionDir(fixture.sessionsDir, ambiguousName, 'ambiguous-v1');

  const dryRun = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--json']));
  assert.deepEqual(dryRun.legacyCaseFoldCollisions, [{
    foldedName: ambiguousName.toLowerCase(),
    dirNames: [ambiguousName],
    sessionKeys: ['a', 'v1_YQ'],
  }]);

  const apply = runNormalizeResult(['--mud-dir', fixture.mudDir, '--apply', '--archive-unmanaged', '--json']);
  assert.notEqual(apply.status, 0);
  assert.match(apply.stderr, /legacy v1 case-fold collision.*a.*v1_YQ.*normalize:sessions/i);
  assert.equal(readJson(path.join(fixture.sessionsDir, ambiguousName, 'state.json')).marker, 'ambiguous-v1');
  assert.ok(!fs.existsSync(path.join(fixture.mudDir, 'cleanup-backups')));
}

function testLegacyCaseFoldCollisionFailsClosed() {
  const fixture = makeLegacyV1Fixture(['AAG', 'AAa']);
  const legacyName = encodeLegacyV1('AAG');
  writeSessionDir(fixture.sessionsDir, legacyName, 'ambiguous-v1');
  const registryPath = path.join(fixture.mudDir, 'registry.json');
  const registryBefore = fs.readFileSync(registryPath, 'utf8');

  const dryRun = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--json']));
  assert.deepEqual(dryRun.legacyCaseFoldCollisions, [{
    foldedName: legacyName.toLowerCase(),
    dirNames: [legacyName],
    sessionKeys: ['AAG', 'AAa'],
  }]);

  const apply = runNormalizeResult(['--mud-dir', fixture.mudDir, '--apply', '--json']);
  assert.notEqual(apply.status, 0);
  assert.match(apply.stderr, /legacy v1 case-fold collision.*AAG.*AAa.*normalize:sessions/i);
  assert.equal(fs.readFileSync(registryPath, 'utf8'), registryBefore);
  assert.equal(readJson(path.join(fixture.sessionsDir, legacyName, 'state.json')).marker, 'ambiguous-v1');
  assert.ok(!fs.existsSync(path.join(fixture.mudDir, 'cleanup-backups')));
  assert.ok(!fs.existsSync(path.join(fixture.sessionsDir, 'v2_414147')));
  assert.ok(!fs.existsSync(path.join(fixture.sessionsDir, 'v2_414161')));
}

function testPortableV1DestinationConflictFailsClosed() {
  const fixture = makeLegacyV1Fixture();
  const legacyName = encodeLegacyV1('AAG');
  const v2Name = 'v2_414147';
  writeSessionDir(fixture.sessionsDir, legacyName, 'legacy-source');
  writeSessionDir(fixture.sessionsDir, v2Name, 'v2-destination');
  const registryPath = path.join(fixture.mudDir, 'registry.json');
  const registryBefore = fs.readFileSync(registryPath, 'utf8');

  const apply = runNormalizeResult(['--mud-dir', fixture.mudDir, '--apply', '--json']);
  assert.notEqual(apply.status, 0);
  assert.match(apply.stderr, /destination already exists/i);
  assert.equal(readJson(path.join(fixture.sessionsDir, legacyName, 'state.json')).marker, 'legacy-source');
  assert.equal(readJson(path.join(fixture.sessionsDir, v2Name, 'state.json')).marker, 'v2-destination');
  assert.equal(fs.readFileSync(registryPath, 'utf8'), registryBefore);
  assert.ok(!fs.existsSync(path.join(fixture.mudDir, 'cleanup-backups')));
}

function testDuplicateMigrationDestinationFailsBeforeWrites() {
  const fixture = makeLegacyV1Fixture();
  const legacyName = encodeLegacyV1('AAG');
  const rawName = 'AAG';
  const v2Name = 'v2_414147';
  writeSessionDir(fixture.sessionsDir, legacyName, 'legacy-v1');
  writeSessionDir(fixture.sessionsDir, rawName, 'legacy-raw');
  const registryPath = path.join(fixture.mudDir, 'registry.json');
  const registryBefore = fs.readFileSync(registryPath, 'utf8');

  const apply = runNormalizeResult(['--mud-dir', fixture.mudDir, '--apply', '--json']);
  assert.notEqual(apply.status, 0);
  assert.match(apply.stderr, /multiple migration sources.*v2 destination/i);
  assert.equal(readJson(path.join(fixture.sessionsDir, legacyName, 'state.json')).marker, 'legacy-v1');
  assert.equal(readJson(path.join(fixture.sessionsDir, rawName, 'state.json')).marker, 'legacy-raw');
  assert.ok(!fs.existsSync(path.join(fixture.sessionsDir, v2Name)));
  assert.equal(fs.readFileSync(registryPath, 'utf8'), registryBefore);
  assert.ok(!fs.existsSync(path.join(fixture.mudDir, 'cleanup-backups')));
}

function testPlannedV2OwnershipConflictFailsBeforeWrites() {
  const fixture = makeLegacyV1Fixture();
  const legacyName = encodeLegacyV1('a');
  const v2Name = encodeSessionDirName('a');
  const registryPath = path.join(fixture.mudDir, 'registry.json');
  writeJson(registryPath, {
    a: { sessionKey: 'a', mode: 'active' },
    'session-two': { sessionKey: 'session-two', mode: 'active', aliases: [v2Name] },
  });
  const registryBefore = fs.readFileSync(registryPath, 'utf8');
  writeSessionDir(fixture.sessionsDir, legacyName, 'legacy');

  const applied = runNormalizeResult(['--mud-dir', fixture.mudDir, '--apply', '--json']);
  assert.notEqual(applied.status, 0);
  assert.match(applied.stderr, /planned.*encoded.*case-fold.*a.*session-two.*v2_61/i);
  assert.equal(fs.readFileSync(registryPath, 'utf8'), registryBefore);
  assert.equal(readJson(path.join(fixture.sessionsDir, legacyName, 'state.json')).marker, 'legacy');
  assert.ok(!fs.existsSync(path.join(fixture.sessionsDir, v2Name)));
  assert.ok(!fs.existsSync(path.join(fixture.mudDir, 'cleanup-backups')));
}

function testSharedAliasOwnershipFailsClosed() {
  const fixture = makeLegacyV1Fixture();
  const alias = 'shared-alias';
  const legacyName = encodeLegacyV1(alias);
  writeJson(path.join(fixture.mudDir, 'registry.json'), {
    'session-one': { sessionKey: 'session-one', mode: 'active', aliases: [alias] },
    'session-two': { sessionKey: 'session-two', mode: 'active', aliases: [alias] },
  });
  writeSessionDir(fixture.sessionsDir, legacyName, 'shared-alias');

  const dryRun = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--json']));
  assert.deepEqual(dryRun.legacyCaseFoldCollisions, [{
    foldedName: legacyName.toLowerCase(),
    dirNames: [legacyName],
    sessionKeys: ['session-one', 'session-two', alias],
  }]);
  const apply = runNormalizeResult(['--mud-dir', fixture.mudDir, '--apply', '--json']);
  assert.notEqual(apply.status, 0);
  assert.match(apply.stderr, /legacy v1 case-fold collision.*session-one.*session-two.*shared-alias/i);
  assert.equal(readJson(path.join(fixture.sessionsDir, legacyName, 'state.json')).marker, 'shared-alias');
  assert.ok(!fs.existsSync(path.join(fixture.mudDir, 'cleanup-backups')));
}

function testOwnerlessV1FailsClosed() {
  const fixture = makeLegacyV1Fixture();
  const legacyName = encodeLegacyV1('AAG');
  fs.rmSync(path.join(fixture.mudDir, 'registry.json'));
  writeSessionDir(fixture.sessionsDir, legacyName, 'orphan-v1');

  const dryRun = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--json']));
  assert.deepEqual(dryRun.legacyCaseFoldCollisions, [{
    foldedName: legacyName.toLowerCase(),
    dirNames: [legacyName],
    sessionKeys: ['AAG'],
  }]);
  const apply = runNormalizeResult(['--mud-dir', fixture.mudDir, '--apply', '--archive-unmanaged', '--json']);
  assert.notEqual(apply.status, 0);
  assert.match(apply.stderr, /legacy v1 case-fold collision.*AAG.*no registry owner/i);
  assert.equal(readJson(path.join(fixture.sessionsDir, legacyName, 'state.json')).marker, 'orphan-v1');
  assert.ok(!fs.existsSync(path.join(fixture.mudDir, 'cleanup-backups')));
}

function testLiteralV2RawKeyAmbiguityFailsClosed() {
  const rawKey = 'V2_61';
  const fixture = makeLegacyV1Fixture([rawKey]);
  writeSessionDir(fixture.sessionsDir, rawKey, 'raw-v2-looking');

  const dryRun = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--json']));
  assert.deepEqual(dryRun.legacyCaseFoldCollisions, [{
    foldedName: 'v2_61',
    dirNames: [rawKey],
    sessionKeys: [rawKey, 'a'],
  }]);
  const apply = runNormalizeResult(['--mud-dir', fixture.mudDir, '--apply', '--json']);
  assert.notEqual(apply.status, 0);
  assert.match(apply.stderr, /invalid encoded session directories.*V2_61/i);
  assert.equal(readJson(path.join(fixture.sessionsDir, rawKey, 'state.json')).marker, 'raw-v2-looking');
  assert.ok(!fs.existsSync(path.join(fixture.mudDir, 'cleanup-backups')));
}

function testDuplicateRegistryAliasFailsClosed() {
  const fixture = makeLegacyV1Fixture();
  const registryPath = path.join(fixture.mudDir, 'registry.json');
  writeJson(registryPath, {
    'session-one': { sessionKey: 'session-one', mode: 'active', aliases: ['shared-alias'] },
    'session-two': { sessionKey: 'session-two', mode: 'active', aliases: ['shared-alias'] },
  });
  const registryBefore = fs.readFileSync(registryPath, 'utf8');

  const dryRun = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--json']));
  assert.deepEqual(dryRun.registryOwnershipConflicts, [{
    sessionKey: 'shared-alias',
    ownerKeys: ['session-one', 'session-two'],
  }]);
  const apply = runNormalizeResult(['--mud-dir', fixture.mudDir, '--apply', '--json']);
  assert.notEqual(apply.status, 0);
  assert.match(apply.stderr, /registry ownership conflict.*shared-alias.*session-one.*session-two/i);
  assert.equal(fs.readFileSync(registryPath, 'utf8'), registryBefore);
  assert.ok(!fs.existsSync(path.join(fixture.mudDir, 'cleanup-backups')));
}

function testRoutingEquivalentRegistryAliasesFailClosed() {
  const fixture = makeLegacyV1Fixture();
  const registryPath = path.join(fixture.mudDir, 'registry.json');
  writeJson(registryPath, {
    'session-one': { sessionKey: 'session-one', mode: 'active', aliases: ['topic:1'] },
    'session-two': { sessionKey: 'session-two', mode: 'active', aliases: ['topic-1'] },
  });
  const registryBefore = fs.readFileSync(registryPath, 'utf8');

  const dryRun = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--json']));
  assert.deepEqual(dryRun.registryOwnershipConflicts, [{
    sessionKey: 'topic-1',
    ownerKeys: ['session-one', 'session-two'],
  }]);
  const applied = runNormalizeResult(['--mud-dir', fixture.mudDir, '--apply', '--json']);
  assert.notEqual(applied.status, 0);
  assert.match(applied.stderr, /registry ownership conflict.*topic-1.*session-one.*session-two/i);
  assert.equal(fs.readFileSync(registryPath, 'utf8'), registryBefore);
  assert.ok(!fs.existsSync(path.join(fixture.mudDir, 'cleanup-backups')));
}

function testOwnerlessV2DirectoriesRemainSkippedUnmanaged() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mud-agent-ownerless-v2-'));
  const mudDir = path.join(root, '.mud-agent');
  const sessionsDir = path.join(mudDir, 'sessions');
  const canonicalKey = 'agent:main:telegram:group:-100:topic:1';
  const aliasKey = 'topic:1';
  const canonicalName = encodeSessionDirName(canonicalKey);
  const aliasName = encodeSessionDirName(aliasKey);
  writeSessionDir(sessionsDir, canonicalName, 'ownerless-canonical');
  writeSessionDir(sessionsDir, aliasName, 'ownerless-alias');

  const dryRun = JSON.parse(runNormalize(['--mud-dir', mudDir, '--json']));
  assert.deepEqual(dryRun.canonicalKeys, []);
  assert.deepEqual(dryRun.unmanagedDirs, [canonicalName, aliasName].sort());
  assert.deepEqual(dryRun.skippedEncodedDirs, [
    { dirName: canonicalName, logicalKey: canonicalKey, reason: 'ownerless-v2' },
    { dirName: aliasName, logicalKey: aliasKey, reason: 'ownerless-v2' },
  ].sort((left, right) => left.dirName.localeCompare(right.dirName)));

  const applied = JSON.parse(runNormalize(['--mud-dir', mudDir, '--apply', '--archive-unmanaged', '--json']));
  assert.equal(applied.backupRoot, null);
  assert.ok(!fs.existsSync(path.join(mudDir, 'registry.json')));
  assert.equal(readJson(path.join(sessionsDir, canonicalName, 'state.json')).marker, 'ownerless-canonical');
  assert.equal(readJson(path.join(sessionsDir, aliasName, 'state.json')).marker, 'ownerless-alias');
  assert.ok(!fs.existsSync(path.join(mudDir, 'cleanup-backups')));
}

function testApplyRollsBackEveryTransactionalFaultPoint() {
  for (const faultStep of [
    'migration:rename',
    'archive:rename',
    'registry:write',
    'registry:rename',
    'manifest:write',
    'manifest:rename',
  ]) {
    const fixture = makeFixture();
    const legacyName = encodeLegacyV1(fixture.canonical);
    fs.rmSync(path.join(fixture.sessionsDir, fixture.encodedCanonical), { recursive: true });
    writeSessionDir(fixture.sessionsDir, legacyName, `transaction-${faultStep}`);
    const registryPath = path.join(fixture.mudDir, 'registry.json');
    const registryBefore = fs.readFileSync(registryPath);
    const analysis = analyzeSessions(fixture.mudDir, readJson(registryPath));

    assert.throws(
      () => applyChanges(
        fixture.mudDir,
        analysis,
        { archiveUnmanaged: false },
        { beforeStep: (step) => { if (step === faultStep) throw new Error(`injected ${faultStep}`); } },
      ),
      new RegExp(`injected ${faultStep}`),
    );

    assert.deepEqual(fs.readFileSync(registryPath), registryBefore, `${faultStep}: registry rollback`);
    assert.equal(
      readJson(path.join(fixture.sessionsDir, legacyName, 'state.json')).marker,
      `transaction-${faultStep}`,
      `${faultStep}: migration rollback`,
    );
    assert.ok(!fs.existsSync(path.join(fixture.sessionsDir, fixture.encodedCanonical)));
    assert.ok(fs.existsSync(path.join(fixture.sessionsDir, fixture.shortAlias)), `${faultStep}: archive rollback`);
    assert.ok(fs.existsSync(path.join(fixture.sessionsDir, fixture.unmanaged)), `${faultStep}: unmanaged preserved`);
    assert.ok(!fs.existsSync(path.join(fixture.mudDir, 'cleanup-backups')), `${faultStep}: backup cleanup`);
    assert.ok(!listTree(fixture.mudDir).some((entry) => entry.includes('.tmp-')), `${faultStep}: temp cleanup`);
  }
}

function testConcurrentApplyDoesNotDeleteAnotherRunsBackup() {
  // selectBackupRoot() picks a path via a plain existsSync check, which is
  // racy against a second concurrent `normalize:sessions --apply`: both
  // processes can see the same timestamp-based path as free. Simulate the
  // loser's perspective by having another "process" claim and start
  // populating that exact directory right before our own claim attempt.
  const fixture = makeFixture();
  const legacyName = encodeLegacyV1(fixture.canonical);
  fs.rmSync(path.join(fixture.sessionsDir, fixture.encodedCanonical), { recursive: true });
  writeSessionDir(fixture.sessionsDir, legacyName, 'transaction-concurrent-claim');
  const registryPath = path.join(fixture.mudDir, 'registry.json');
  const registryBefore = fs.readFileSync(registryPath);
  const analysis = analyzeSessions(fixture.mudDir, readJson(registryPath));

  let otherRunBackupRoot;
  let otherRunMarkerPath;

  assert.throws(
    () => applyChanges(
      fixture.mudDir,
      analysis,
      { archiveUnmanaged: false },
      {
        beforeStep: (step, context) => {
          if (step !== 'backup:claim') return;
          // Use the exact backupRoot the production code just computed,
          // rather than re-deriving a timestamp ourselves: `timestamp()`
          // and `formatBackupTimestamp()` are both second-granularity, so
          // recomputing independently could race across a second boundary
          // and simulate a collision at the wrong path.
          otherRunBackupRoot = context.backupRoot;
          fs.mkdirSync(otherRunBackupRoot, { recursive: true });
          otherRunMarkerPath = path.join(otherRunBackupRoot, 'registry.json');
          fs.writeFileSync(otherRunMarkerPath, 'other-run-real-backup-data');
        },
      },
    ),
    /concurrent normalize:sessions/i,
  );

  assert.ok(otherRunBackupRoot, 'backup:claim hook must have fired');
  assert.equal(
    fs.readFileSync(otherRunMarkerPath, 'utf8'),
    'other-run-real-backup-data',
    "must not delete the concurrent run's real backup data",
  );
  assert.deepEqual(fs.readFileSync(registryPath), registryBefore, 'registry unchanged');
  assert.equal(
    readJson(path.join(fixture.sessionsDir, legacyName, 'state.json')).marker,
    'transaction-concurrent-claim',
    'own session dirs untouched',
  );
  assert.ok(fs.existsSync(path.join(fixture.sessionsDir, fixture.shortAlias)));
  assert.ok(fs.existsSync(path.join(fixture.sessionsDir, fixture.unmanaged)));
  assert.ok(!listTree(fixture.mudDir).some((entry) => entry.includes('.tmp-')), 'no temp files leaked');
}

function testConcurrentApplyLoserNeverWritesRecoveryJournalIntoWinnersBackup() {
  // Losing the backupRoot race (previous test) is not the only way to reach
  // the cleanup branch with backupRootCreated === false: the subsequent
  // "remove owned empty parent directories" step can *also* fail (e.g. a
  // real race with a third process, or a permission error). That failure
  // pushes a rollbackError, which used to make the catch block write
  // recovery.json into backupRoot unconditionally -- even though this
  // transaction never claimed it, so backupRoot is still the winner's real
  // backup directory. Confirm the recovery journal is skipped in that case
  // rather than corrupting the winner's directory.
  const fixture = makeFixture();
  const legacyName = encodeLegacyV1(fixture.canonical);
  fs.rmSync(path.join(fixture.sessionsDir, fixture.encodedCanonical), { recursive: true });
  writeSessionDir(fixture.sessionsDir, legacyName, 'transaction-concurrent-cleanup-fault');
  const registryPath = path.join(fixture.mudDir, 'registry.json');
  const registryBefore = fs.readFileSync(registryPath);
  const analysis = analyzeSessions(fixture.mudDir, readJson(registryPath));

  let otherRunBackupRoot;
  let otherRunMarkerPath;
  let thrown;

  try {
    applyChanges(
      fixture.mudDir,
      analysis,
      { archiveUnmanaged: false },
      {
        beforeStep: (step, context) => {
          if (step === 'backup:claim') {
            otherRunBackupRoot = context.backupRoot;
            fs.mkdirSync(otherRunBackupRoot, { recursive: true });
            otherRunMarkerPath = path.join(otherRunBackupRoot, 'registry.json');
            fs.writeFileSync(otherRunMarkerPath, 'other-run-real-backup-data');
            return;
          }
          if (step === 'rollback:parent:cleanup') {
            throw new Error('injected parent cleanup failure');
          }
        },
      },
    );
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof Error, 'apply must fail');
  assert.match(thrown.message, /concurrent normalize:sessions/i);
  assert.match(thrown.message, /injected parent cleanup failure/);
  assert.match(thrown.message, /rollback errors:/i);
  assert.ok(otherRunBackupRoot, 'backup:claim hook must have fired');
  assert.equal(
    fs.readFileSync(otherRunMarkerPath, 'utf8'),
    'other-run-real-backup-data',
    "must not overwrite the concurrent run's real backup data",
  );
  assert.deepEqual(
    listTree(otherRunBackupRoot),
    ['registry.json'],
    'must not write recovery.json (or anything else) into a backupRoot this transaction never claimed',
  );
  assert.deepEqual(fs.readFileSync(registryPath), registryBefore, 'registry unchanged');
  assert.equal(
    readJson(path.join(fixture.sessionsDir, legacyName, 'state.json')).marker,
    'transaction-concurrent-cleanup-fault',
    'own session dirs untouched',
  );
  assert.ok(!listTree(fixture.mudDir).some((entry) => entry.includes('.tmp-')), 'no temp files leaked');
}

function testStaleOwnershipFlagDoesNotPolluteBackupRootReclaimedAfterRollback() {
  // backupRootCreated used to stay true forever once set, even after the
  // rollback path successfully rmSync'd backupRoot back out of existence.
  // That leaves a window: this transaction genuinely claimed and later
  // relinquished backupRoot, a fresh concurrent run reclaims that exact
  // (now free) path and starts writing its own real backup into it, and if
  // *this* transaction's own parent-directory cleanup then also fails, the
  // stale true flag would still let it write recovery.json into what is now
  // someone else's directory.
  const fixture = makeFixture();
  const legacyName = encodeLegacyV1(fixture.canonical);
  fs.rmSync(path.join(fixture.sessionsDir, fixture.encodedCanonical), { recursive: true });
  writeSessionDir(fixture.sessionsDir, legacyName, 'transaction-stale-ownership');
  const registryPath = path.join(fixture.mudDir, 'registry.json');
  const registryBefore = fs.readFileSync(registryPath);
  const analysis = analyzeSessions(fixture.mudDir, readJson(registryPath));

  let ourBackupRoot;
  let newOwnerMarkerPath;
  let thrown;

  try {
    applyChanges(
      fixture.mudDir,
      analysis,
      { archiveUnmanaged: false },
      {
        beforeStep: (step, context) => {
          if (step === 'backup:claim') {
            ourBackupRoot = context.backupRoot;
            return;
          }
          if (step === 'manifest:rename') {
            throw new Error('injected forward failure');
          }
          if (step === 'rollback:parent:cleanup') {
            // Our own backupRoot was just rmSync'd (freed) immediately
            // before this hook fires. Simulate a fresh concurrent run
            // claiming that exact, now-available path and starting to
            // populate it with its own real backup data.
            fs.mkdirSync(ourBackupRoot, { recursive: true });
            newOwnerMarkerPath = path.join(ourBackupRoot, 'registry.json');
            fs.writeFileSync(newOwnerMarkerPath, 'new-owner-real-backup-data');
            throw new Error('injected parent cleanup failure');
          }
        },
      },
    );
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof Error, 'apply must fail');
  assert.match(thrown.message, /injected forward failure/);
  assert.match(thrown.message, /injected parent cleanup failure/);
  assert.ok(ourBackupRoot, 'backup:claim hook must have fired');
  assert.ok(newOwnerMarkerPath, 'rollback:parent:cleanup hook must have fired');
  assert.deepEqual(
    listTree(ourBackupRoot),
    ['registry.json'],
    'must not write recovery.json into a backupRoot this transaction already relinquished',
  );
  assert.equal(
    fs.readFileSync(newOwnerMarkerPath, 'utf8'),
    'new-owner-real-backup-data',
    "must not overwrite the new owner's real backup data",
  );
  assert.deepEqual(fs.readFileSync(registryPath), registryBefore, 'registry unchanged');
  assert.equal(
    readJson(path.join(fixture.sessionsDir, legacyName, 'state.json')).marker,
    'transaction-stale-ownership',
    'own session dirs untouched',
  );
  assert.ok(!fs.existsSync(path.join(fixture.sessionsDir, fixture.encodedCanonical)), 'migration rolled back');
  assert.ok(!listTree(fixture.mudDir).some((entry) => entry.includes('.tmp-')), 'no temp files leaked');
}

function testRollbackFailurePreservesRecoveryBackupAndPreexistingParent() {
  for (const rollbackFault of [
    'rollback:archive:rename',
    'rollback:migration:rename',
    'rollback:registry:restore',
  ]) {
    const fixture = makeFixture();
    const legacyName = encodeLegacyV1(fixture.canonical);
    fs.rmSync(path.join(fixture.sessionsDir, fixture.encodedCanonical), { recursive: true });
    writeSessionDir(fixture.sessionsDir, legacyName, `recovery-${rollbackFault}`);
    const registryPath = path.join(fixture.mudDir, 'registry.json');
    const registryBefore = fs.readFileSync(registryPath);
    const { transactionRoot, sentinelPath, now } = makePreexistingTransactionRoot(fixture.mudDir);
    const analysis = analyzeSessions(fixture.mudDir, readJson(registryPath));

    let thrown;
    try {
      applyChanges(
        fixture.mudDir,
        analysis,
        { archiveUnmanaged: false, now },
        {
          beforeStep: (step) => {
            if (step === 'manifest:rename') throw new Error('injected forward failure');
            if (step === rollbackFault) throw new Error(`injected ${rollbackFault}`);
          },
        },
      );
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown instanceof Error, `${rollbackFault}: apply must fail`);
    assert.match(thrown.message, new RegExp(`injected ${rollbackFault}`));
    assert.match(thrown.message, /recovery path:/i);
    assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'do not delete', `${rollbackFault}: preserve parent sentinel`);

    const backupRoot = path.join(transactionRoot, 'session-normalization');
    assert.ok(fs.existsSync(backupRoot), `${rollbackFault}: preserve transaction backup`);
    assert.deepEqual(fs.readFileSync(path.join(backupRoot, 'registry.json')), registryBefore);
    assert.equal(
      readJson(path.join(backupRoot, 'legacy-canonical-dirs', legacyName, 'state.json')).marker,
      `recovery-${rollbackFault}`,
    );
    assert.ok(fs.existsSync(path.join(backupRoot, 'recovery.json')), `${rollbackFault}: recovery journal`);

    if (rollbackFault === 'rollback:archive:rename') {
      assert.ok(fs.existsSync(path.join(backupRoot, 'archived-session-dirs', fixture.shortAlias)));
    } else {
      assert.ok(fs.existsSync(path.join(fixture.sessionsDir, fixture.shortAlias)));
    }
    if (rollbackFault === 'rollback:migration:rename') {
      assert.ok(fs.existsSync(path.join(fixture.sessionsDir, fixture.encodedCanonical)));
    } else {
      assert.ok(fs.existsSync(path.join(fixture.sessionsDir, legacyName)));
    }
    if (rollbackFault === 'rollback:registry:restore') {
      assert.notDeepEqual(fs.readFileSync(registryPath), registryBefore);
    } else {
      assert.deepEqual(fs.readFileSync(registryPath), registryBefore);
    }
    assert.ok(!listTree(fixture.mudDir).some((entry) => entry.includes('.tmp-')), `${rollbackFault}: temp cleanup`);
  }
}

function testRollbackPreservesRegistryChangedAfterTransactionCommit() {
  const fixture = makeFixture();
  const registryPath = path.join(fixture.mudDir, 'registry.json');
  const registryBefore = fs.readFileSync(registryPath);
  const { transactionRoot, now } = makePreexistingTransactionRoot(fixture.mudDir);
  const backupRoot = path.join(transactionRoot, 'session-normalization');
  const analysis = analyzeSessions(fixture.mudDir, readJson(registryPath));
  const concurrentRegistryContent = `${JSON.stringify(
    {
      ...analysis.mergedRegistry,
      'concurrent-session': { sessionKey: 'concurrent-session', mode: 'active', aliases: [] },
    },
    null,
    2,
  )}\n`;

  let thrown;
  try {
    applyChanges(
      fixture.mudDir,
      analysis,
      { archiveUnmanaged: false, now },
      {
        beforeStep: (step) => {
          if (step === 'manifest:rename') {
            fs.writeFileSync(registryPath, concurrentRegistryContent);
            throw new Error('injected forward failure after concurrent registry update');
          }
        },
      },
    );
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof Error, 'concurrent registry update: apply must fail');
  assert.match(thrown.message, /state conflict/i);
  assert.match(thrown.message, /recovery path:/i);
  assert.equal(fs.readFileSync(registryPath, 'utf8'), concurrentRegistryContent);
  assert.deepEqual(fs.readFileSync(path.join(backupRoot, 'registry.json')), registryBefore);
  assert.ok(fs.existsSync(path.join(fixture.sessionsDir, fixture.shortAlias)));
  const recovery = readJson(path.join(backupRoot, 'recovery.json'));
  assert.ok(
    recovery.rollbackErrors.some(
      (rollbackError) => /registry:.*state conflict.*concurrent/i.test(rollbackError),
    ),
  );
}

function testRollbackDetectsArchiveSourceRecreatedConflict() {
  const fixture = makeFixture();
  const registryPath = path.join(fixture.mudDir, 'registry.json');
  const { transactionRoot, now } = makePreexistingTransactionRoot(fixture.mudDir);
  const backupRoot = path.join(transactionRoot, 'session-normalization');
  const archiveDestination = path.join(backupRoot, 'archived-session-dirs', fixture.shortAlias);
  const archiveSource = path.join(fixture.sessionsDir, fixture.shortAlias);
  const analysis = analyzeSessions(fixture.mudDir, readJson(registryPath));

  let thrown;
  try {
    applyChanges(
      fixture.mudDir,
      analysis,
      { archiveUnmanaged: false, now },
      {
        beforeStep: (step) => {
          if (step === 'manifest:rename') {
            writeSessionDir(fixture.sessionsDir, fixture.shortAlias, 'concurrent-archive-source');
            throw new Error('injected forward failure after archive source recreation');
          }
        },
      },
    );
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof Error, 'archive source recreation: apply must fail');
  assert.match(thrown.message, /state conflict/i);
  assert.match(thrown.message, /recovery path:/i);
  assert.equal(readJson(path.join(archiveSource, 'state.json')).marker, 'concurrent-archive-source');
  assert.equal(readJson(path.join(archiveDestination, 'state.json')).marker, fixture.shortAlias);
  const recovery = readJson(path.join(backupRoot, 'recovery.json'));
  assert.ok(recovery.rollbackErrors.some((rollbackError) => /state conflict/i.test(rollbackError)));
  assert.ok(
    recovery.moves.some(
      (move) => move.kind === 'archive' && move.sourceExists === true && move.destinationExists === true,
    ),
  );
}

function testRollbackDetectsMigrationSourceRecreatedConflict() {
  const fixture = makeFixture();
  const legacyName = encodeLegacyV1(fixture.canonical);
  fs.rmSync(path.join(fixture.sessionsDir, fixture.encodedCanonical), { recursive: true });
  writeSessionDir(fixture.sessionsDir, legacyName, 'original-migration-source');
  const registryPath = path.join(fixture.mudDir, 'registry.json');
  const { transactionRoot, now } = makePreexistingTransactionRoot(fixture.mudDir);
  const backupRoot = path.join(transactionRoot, 'session-normalization');
  const migrationSource = path.join(fixture.sessionsDir, legacyName);
  const migrationDestination = path.join(fixture.sessionsDir, fixture.encodedCanonical);
  const migrationBackup = path.join(backupRoot, 'legacy-canonical-dirs', legacyName);
  const analysis = analyzeSessions(fixture.mudDir, readJson(registryPath));

  let thrown;
  try {
    applyChanges(
      fixture.mudDir,
      analysis,
      { archiveUnmanaged: false, now },
      {
        beforeStep: (step) => {
          if (step === 'manifest:rename') {
            writeSessionDir(fixture.sessionsDir, legacyName, 'concurrent-migration-source');
            throw new Error('injected forward failure after migration source recreation');
          }
        },
      },
    );
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof Error, 'migration source recreation: apply must fail');
  assert.match(thrown.message, /state conflict/i);
  assert.match(thrown.message, /recovery path:/i);
  assert.equal(readJson(path.join(migrationSource, 'state.json')).marker, 'concurrent-migration-source');
  assert.equal(readJson(path.join(migrationDestination, 'state.json')).marker, 'original-migration-source');
  assert.equal(readJson(path.join(migrationBackup, 'state.json')).marker, 'original-migration-source');
  const recovery = readJson(path.join(backupRoot, 'recovery.json'));
  assert.ok(recovery.rollbackErrors.some((rollbackError) => /state conflict/i.test(rollbackError)));
  assert.ok(
    recovery.moves.some(
      (move) => move.kind === 'migration' && move.sourceExists === true && move.destinationExists === true,
    ),
  );
}

function testRollbackDetectsMissingMigrationDestinationConflict() {
  const fixture = makeFixture();
  const legacyName = encodeLegacyV1(fixture.canonical);
  fs.rmSync(path.join(fixture.sessionsDir, fixture.encodedCanonical), { recursive: true });
  writeSessionDir(fixture.sessionsDir, legacyName, 'missing-destination-recovery');
  const registryPath = path.join(fixture.mudDir, 'registry.json');
  const { transactionRoot, now } = makePreexistingTransactionRoot(fixture.mudDir);
  const backupRoot = path.join(transactionRoot, 'session-normalization');
  const migrationDestination = path.join(fixture.sessionsDir, fixture.encodedCanonical);
  const migrationBackup = path.join(backupRoot, 'legacy-canonical-dirs', legacyName);
  const analysis = analyzeSessions(fixture.mudDir, readJson(registryPath));

  let thrown;
  try {
    applyChanges(
      fixture.mudDir,
      analysis,
      { archiveUnmanaged: false, now },
      {
        beforeStep: (step) => {
          if (step === 'manifest:rename') {
            fs.rmSync(migrationDestination, { recursive: true });
            throw new Error('injected forward failure after migration destination removal');
          }
        },
      },
    );
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof Error, 'missing migration destination: apply must fail');
  assert.match(thrown.message, /state conflict/i);
  assert.match(thrown.message, /recovery path:/i);
  assert.equal(readJson(path.join(migrationBackup, 'state.json')).marker, 'missing-destination-recovery');
  const recovery = readJson(path.join(backupRoot, 'recovery.json'));
  assert.ok(recovery.rollbackErrors.some((rollbackError) => /state conflict/i.test(rollbackError)));
  assert.ok(
    recovery.moves.some(
      (move) => move.kind === 'migration' && move.sourceExists === false && move.destinationExists === false,
    ),
  );
}

function testCodecParity() {
  assert.equal(encodeSessionDirName('a'), 'v2_61');
  assert.equal(encodeSessionDirName('中文'), 'v2_e4b8ade69687');
  assert.equal(encodeSessionDirName('AAG'), 'v2_414147');
  assert.equal(encodeSessionDirName('AAa'), 'v2_414161');
  assert.notEqual(encodeSessionDirName('AAG').toLowerCase(), encodeSessionDirName('AAa').toLowerCase());
  for (const key of [' a ', '\ta', 'a\t', '\na', 'a\n']) {
    assert.throws(() => encodeSessionDirName(key), /whitespace/i);
  }
  assert.equal(decodeSessionDirName('v1_YQ'), 'a');
  assert.equal(decodeSessionDirName('v1_5Lit5paH'), '中文');

  for (const key of ['中文:角色/一号', '😀', '\uFFFD']) {
    assert.equal(decodeSessionDirName(encodeSessionDirName(key)), key);
  }

  assert.throws(() => encodeSessionDirName(''), /empty/i);
  assert.throws(() => encodeSessionDirName('   '), /empty/i);
  for (const malformed of ['\uD800', '\uDC00', '\uD800\uD800', '\uD800a']) {
    assert.throws(() => encodeSessionDirName(malformed), /UTF-16/i);
  }
  assert.notEqual(encodeSessionDirName('\uFFFD'), encodeSessionDirName('😀'));

  for (const invalid of [
    'legacy:raw',
    'v2_YQ',
    'v1_',
    'v1_not valid',
    'v1_YQ==',
    'v1_wA',
    'v1_YR',
    'v1_IA',
  ]) {
    assert.equal(decodeSessionDirName(invalid), null, `expected ${invalid} to be rejected`);
  }

  const largestAscii = 'x'.repeat(118);
  const largestCjk = '中'.repeat(39);
  assert.equal(Buffer.byteLength(encodeSessionDirName(largestAscii), 'utf8'), 239);
  assert.equal(decodeSessionDirName(encodeSessionDirName(largestAscii)), largestAscii);
  assert.throws(() => encodeSessionDirName('x'.repeat(119)), /240/);
  assert.equal(Buffer.byteLength(encodeSessionDirName(largestCjk), 'utf8'), 237);
  assert.equal(decodeSessionDirName(encodeSessionDirName(largestCjk)), largestCjk);
  assert.throws(() => encodeSessionDirName('中'.repeat(40)), /240/);

  const first = `${'x'.repeat(117)}a`;
  const second = `${'x'.repeat(117)}b`;
  assert.notEqual(encodeSessionDirName(first), encodeSessionDirName(second));
  assert.equal(decodeSessionDirName(encodeSessionDirName(first)), first);
  assert.equal(decodeSessionDirName(encodeSessionDirName(second)), second);
}

function testPortableDryRunApplyAndIdempotency() {
  const fixture = makeFixture();
  const registryBefore = fs.readFileSync(path.join(fixture.mudDir, 'registry.json'), 'utf8');

  const dryRun = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--json']));
  assert.equal(dryRun.mode, 'dry-run');
  assert.deepEqual(dryRun.encodedMigrations, []);
  assert.deepEqual(dryRun.invalidEncodedDirs, []);
  assert.ok(dryRun.aliasDirs.some((item) => item.dirName === fixture.shortAlias));
  assert.ok(!dryRun.unmanagedDirs.includes(fixture.encodedCanonical));
  assert.ok(dryRun.unmanagedDirs.includes(fixture.unmanaged));
  assert.equal(fs.readFileSync(path.join(fixture.mudDir, 'registry.json'), 'utf8'), registryBefore);
  assert.ok(!fs.existsSync(path.join(fixture.mudDir, 'cleanup-backups')));
  assert.ok(fs.existsSync(path.join(fixture.sessionsDir, fixture.shortAlias)));

  const applied = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--apply', '--json']));
  assert.deepEqual(applied.encodedMigrations, []);
  const registry = readJson(path.join(fixture.mudDir, 'registry.json'));
  assert.deepEqual(Object.keys(registry).sort(), [fixture.canonical]);
  assert.equal(registry[fixture.canonical].sessionKey, fixture.canonical);
  assert.deepEqual(registry[fixture.canonical].aliases, [fixture.registryAlias, fixture.shortAlias]);
  assert.ok(fs.existsSync(path.join(fixture.sessionsDir, fixture.encodedCanonical)));
  assert.ok(!fs.existsSync(path.join(fixture.sessionsDir, fixture.shortAlias)));
  assert.ok(fs.existsSync(path.join(fixture.sessionsDir, fixture.unmanaged)));

  const backupRoot = findSingleBackup(fixture.mudDir);
  const manifest = readJson(path.join(backupRoot, 'manifest.json'));
  assert.deepEqual(manifest.encodedMigrations, []);
  assert.ok(manifest.archived.some((item) => item.name === fixture.shortAlias && item.reason === 'alias'));

  const registryPath = path.join(fixture.mudDir, 'registry.json');
  const manifestPath = path.join(backupRoot, 'manifest.json');
  const registryAfterFirstApply = fs.readFileSync(registryPath);
  const manifestAfterFirstApply = fs.readFileSync(manifestPath);
  const backupGroupsAfterFirstApply = fs.readdirSync(path.join(fixture.mudDir, 'cleanup-backups'));
  const rerun = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--apply', '--json']));
  assert.deepEqual(rerun.encodedMigrations, []);
  assert.deepEqual(rerun.aliasDirs, []);
  assert.ok(fs.existsSync(path.join(fixture.sessionsDir, fixture.encodedCanonical)));
  assert.equal(readJson(path.join(fixture.mudDir, 'registry.json'))[fixture.canonical].sessionKey, fixture.canonical);
  assert.deepEqual(fs.readdirSync(path.join(fixture.mudDir, 'cleanup-backups')), backupGroupsAfterFirstApply);
  assert.deepEqual(fs.readFileSync(registryPath), registryAfterFirstApply);
  assert.deepEqual(fs.readFileSync(manifestPath), manifestAfterFirstApply);
}

function testPortableEncodedGroupAliasTargetsCanonicalGroupSession() {
  const fixture = makeFixture();
  const groupCanonical = 'agent:main:telegram:group:-200';
  const groupAlias = 'telegram:group:-200';
  const encodedAlias = encodeSessionDirName(groupAlias);
  writeSessionDir(fixture.sessionsDir, encodedAlias, 'encoded-group-alias');
  writeJson(path.join(fixture.mudDir, 'registry.json'), {
    [fixture.canonical]: { sessionKey: fixture.canonical, mode: 'active' },
    [groupCanonical]: { sessionKey: groupCanonical, mode: 'active' },
  });

  const dryRun = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--json']));
  assert.deepEqual(dryRun.encodedMigrations, [{
    dirName: encodedAlias,
    canonicalTarget: groupCanonical,
    logicalKey: groupAlias,
    encodedName: encodeSessionDirName(groupCanonical),
  }]);

  runNormalize(['--mud-dir', fixture.mudDir, '--apply', '--json']);
  const registry = readJson(path.join(fixture.mudDir, 'registry.json'));
  assert.deepEqual(registry[groupCanonical].aliases, [groupAlias]);
  assert.ok(!registry[fixture.canonical].aliases?.includes(groupAlias));
  assert.ok(!fs.existsSync(path.join(fixture.sessionsDir, encodedAlias)));
  assert.equal(
    readJson(path.join(fixture.sessionsDir, encodeSessionDirName(groupCanonical), 'state.json')).marker,
    'encoded-group-alias',
  );
}

function testPosixRawGroupAliasTargetsCanonicalGroupSession() {
  if (process.platform === 'win32') return;

  const fixture = makeFixture();
  const groupCanonical = 'agent:main:telegram:group:-200';
  const groupAlias = 'telegram:group:-200';
  writeSessionDir(fixture.sessionsDir, groupAlias, 'raw-group-alias');
  writeJson(path.join(fixture.mudDir, 'registry.json'), {
    [groupCanonical]: { sessionKey: groupCanonical, mode: 'active' },
  });

  const dryRun = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--json']));
  assert.ok(dryRun.aliasDirs.some((item) => item.dirName === groupAlias && item.canonicalTarget === groupCanonical));
}

function testInvalidEncodedNameFailsClosed() {
  const fixture = makeFixture();
  const invalidName = 'v1_YQ==';
  writeSessionDir(fixture.sessionsDir, invalidName, 'invalid-encoded');

  const dryRun = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--json']));
  assert.deepEqual(dryRun.invalidEncodedDirs, [invalidName]);
  assert.ok(!dryRun.unmanagedDirs.includes(invalidName));

  const registryBefore = fs.readFileSync(path.join(fixture.mudDir, 'registry.json'), 'utf8');
  const apply = runNormalizeResult(['--mud-dir', fixture.mudDir, '--apply', '--json']);
  assert.notEqual(apply.status, 0);
  assert.match(apply.stderr, /invalid encoded session director/i);
  assert.equal(fs.readFileSync(path.join(fixture.mudDir, 'registry.json'), 'utf8'), registryBefore);
  assert.ok(fs.existsSync(path.join(fixture.sessionsDir, invalidName, 'state.json')));
  assert.ok(!fs.existsSync(path.join(fixture.mudDir, 'cleanup-backups')));
}

function testUppercaseV2NameFailsClosedEvenWithDecodedOwner() {
  const fixture = makeLegacyV1Fixture(['a']);
  const noncanonicalName = 'V2_61';
  writeSessionDir(fixture.sessionsDir, noncanonicalName, 'uppercase-v2');

  const dryRun = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--json']));
  assert.deepEqual(dryRun.invalidEncodedDirs, [noncanonicalName]);
  const applied = runNormalizeResult(['--mud-dir', fixture.mudDir, '--apply', '--json']);
  assert.notEqual(applied.status, 0);
  assert.match(applied.stderr, /invalid encoded session directories.*V2_61/i);
  assert.equal(readJson(path.join(fixture.sessionsDir, noncanonicalName, 'state.json')).marker, 'uppercase-v2');
  assert.ok(!fs.existsSync(path.join(fixture.mudDir, 'cleanup-backups')));
}

function testArchiveUnmanaged() {
  const fixture = makeFixture();
  runNormalize(['--mud-dir', fixture.mudDir, '--apply', '--archive-unmanaged']);
  assert.ok(!fs.existsSync(path.join(fixture.sessionsDir, fixture.unmanaged)));

  const archiveRoot = path.join(findSingleBackup(fixture.mudDir), 'archived-session-dirs');
  assert.ok(fs.existsSync(path.join(archiveRoot, fixture.unmanaged)));
}

function testPosixLegacyCanonicalMigration() {
  if (process.platform === 'win32') return;

  const fixture = makeFixture();
  fs.rmSync(path.join(fixture.sessionsDir, fixture.encodedCanonical), { recursive: true });
  writeSessionDir(fixture.sessionsDir, fixture.canonical, 'legacy-canonical');

  const dryRun = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--json']));
  assert.deepEqual(dryRun.encodedMigrations, [{
    dirName: fixture.canonical,
    canonicalTarget: fixture.canonical,
    encodedName: fixture.encodedCanonical,
  }]);
  assert.ok(fs.existsSync(path.join(fixture.sessionsDir, fixture.canonical)));
  assert.ok(!fs.existsSync(path.join(fixture.sessionsDir, fixture.encodedCanonical)));

  const applied = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--apply', '--json']));
  assert.equal(applied.encodedMigrations.length, 1);
  assert.ok(!fs.existsSync(path.join(fixture.sessionsDir, fixture.canonical)));
  assert.equal(readJson(path.join(fixture.sessionsDir, fixture.encodedCanonical, 'state.json')).marker, 'legacy-canonical');

  const backupRoot = findSingleBackup(fixture.mudDir);
  const migration = readJson(path.join(backupRoot, 'manifest.json')).encodedMigrations[0];
  assert.equal(migration.source, path.join(fixture.sessionsDir, fixture.canonical));
  assert.equal(migration.destination, path.join(fixture.sessionsDir, fixture.encodedCanonical));
  assert.equal(migration.backup, path.join(backupRoot, 'legacy-canonical-dirs', fixture.canonical));
  assert.equal(readJson(path.join(migration.backup, 'state.json')).marker, 'legacy-canonical');
  assert.equal(readJson(path.join(fixture.mudDir, 'registry.json'))[fixture.canonical].sessionKey, fixture.canonical);

  const rerun = JSON.parse(runNormalize(['--mud-dir', fixture.mudDir, '--apply', '--json']));
  assert.deepEqual(rerun.encodedMigrations, []);
}

function testPosixEncodedDestinationConflictFailsClosed() {
  if (process.platform === 'win32') return;

  const fixture = makeFixture();
  writeSessionDir(fixture.sessionsDir, fixture.canonical, 'legacy-source');
  writeJson(path.join(fixture.sessionsDir, fixture.encodedCanonical, 'state.json'), { marker: 'encoded-destination' });
  const registryBefore = fs.readFileSync(path.join(fixture.mudDir, 'registry.json'), 'utf8');

  const apply = runNormalizeResult(['--mud-dir', fixture.mudDir, '--apply', '--json']);
  assert.notEqual(apply.status, 0);
  assert.match(apply.stderr, /destination already exists/i);
  assert.equal(readJson(path.join(fixture.sessionsDir, fixture.canonical, 'state.json')).marker, 'legacy-source');
  assert.equal(readJson(path.join(fixture.sessionsDir, fixture.encodedCanonical, 'state.json')).marker, 'encoded-destination');
  assert.equal(fs.readFileSync(path.join(fixture.mudDir, 'registry.json'), 'utf8'), registryBefore);
  assert.ok(!fs.existsSync(path.join(fixture.mudDir, 'cleanup-backups')));
}

try {
  testDuplicateRegistryAliasFailsClosed();
  testRoutingEquivalentRegistryAliasesFailClosed();
  testOwnerlessV2DirectoriesRemainSkippedUnmanaged();
  testApplyRollsBackEveryTransactionalFaultPoint();
  testConcurrentApplyDoesNotDeleteAnotherRunsBackup();
  testConcurrentApplyLoserNeverWritesRecoveryJournalIntoWinnersBackup();
  testStaleOwnershipFlagDoesNotPolluteBackupRootReclaimedAfterRollback();
  testRollbackFailurePreservesRecoveryBackupAndPreexistingParent();
  testRollbackPreservesRegistryChangedAfterTransactionCommit();
  testRollbackDetectsArchiveSourceRecreatedConflict();
  testRollbackDetectsMigrationSourceRecreatedConflict();
  testRollbackDetectsMissingMigrationDestinationConflict();
  testLiteralV2RawKeyAmbiguityFailsClosed();
  testOwnerlessV1FailsClosed();
  testSharedAliasOwnershipFailsClosed();
  testDuplicateMigrationDestinationFailsBeforeWrites();
  testPlannedV2OwnershipConflictFailsBeforeWrites();
  testLiteralV1RawKeyAmbiguityFailsClosed();
  testInvalidRegistryJsonFailsClosed();
  testRegistrySessionKeyDriftFailsClosed();
  testApplyRejectsRegistryCreatedAfterMissingSnapshot();
  testApplyRefusesWhileSessionProcessIsLive();
  testApplyIgnoresPidReusedByUnrelatedProcess();
  testApplyRejectsRegistryChangedAfterAnalysis();
  testApplyRejectsRegistryChangedBeforeAtomicReplacement();
  testPortableV1MigrationAndIdempotency();
  testPortableV1AliasMigratesToCanonicalSlotNotAliasSlot();
  testPortableV1AliasDestinationConflictFailsClosed();
  testRawCanonicalDirIsNotSilentlyShadowedByAliasV1Migration();
  testRawCanonicalDirIsNotSilentlyShadowedByExactV1Migration();
  testAliasRawDirIsArchivedNotSilentlyLostWhenAnotherAliasMigrates();
  testRegisteredV2AliasDirIsArchivedWithoutTouchingCanonicalData();
  testRegisteredV2AliasMigratesWhenCanonicalSlotIsMissing();
  testLegacyCaseFoldCollisionFailsClosed();
  testPortableV1DestinationConflictFailsClosed();
  testCodecParity();
  testPortableDryRunApplyAndIdempotency();
  testPortableEncodedGroupAliasTargetsCanonicalGroupSession();
  testPosixRawGroupAliasTargetsCanonicalGroupSession();
  testInvalidEncodedNameFailsClosed();
  testUppercaseV2NameFailsClosedEvenWithDecodedOwner();
  testArchiveUnmanaged();
  testPosixLegacyCanonicalMigration();
  testPosixEncodedDestinationConflictFailsClosed();
  console.log('[verify:sessions] ok');
} catch (error) {
  console.error('[verify:sessions] failed');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
}
