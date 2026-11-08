// Optional, one-file Host maintenance for the exact rc.1 flow bridge.
// Explicit installation root required; default is read-only check. Never called
// by the plugin installer. No profile/store/database/service changes or restart.
// This is NOT the official DSH plugin installer and must not be used for plugins.
import { constants as C } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { patchHostFlowRc1 } from './dsh-web-flow-bridge-rc1.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BRIDGE = Object.freeze({
  expectedVersion: '0.2.2-rc.1',
  beforeHash: 'b7e645f2461231e8ece31381f026db2df72d058e425eaef19265f215c823d84e',
  beforeSize: 688923,
  afterHash: '74b1dfe9656fedd2099bc812819491f896d781fc550501cc6522b68ed932bf7f',
  afterSize: 691781,
  generatorCommit: '00def193c4a162af2c2a14d5999b3fa3892f604b',
});

async function readRegularExact(path, expectedMode) {
  if (!path || resolve(path) !== path || await realpath(path) !== path) throw new Error('path is not an exact, non-symlink absolute path');
  const initial = await lstat(path);
  if (!initial.isFile() || initial.nlink !== 1) throw new Error('target is not an exclusive regular file');
  if (expectedMode !== undefined && (initial.mode & 0o777) !== expectedMode) throw new Error('target mode changed');
  const handle = await open(path, C.O_RDONLY | C.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!same(initial, before)) throw new Error('file changed during open');
    const data = await handle.readFile();
    const after = await handle.stat();
    if (!same(before, after) || data.length !== after.size) throw new Error('file changed during read');
    return { data, stat: after, hash: hash(data) };
  } finally { await handle.close(); }
}
async function fsyncDirectory(path) {
  const h = await open(path, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  try { await h.sync(); } finally { await h.close(); }
}
async function versionOf(config) {
  const p = await readRegularExact(config.packageFile);
  const manifest = JSON.parse(p.data.toString('utf8'));
  if (manifest.name !== '@deepseek-ai/dsh-client-ui-chat' || manifest.version !== config.expectedVersion) throw new Error('host package identity or version changed');
  if (config.coreFile) {
    const core = JSON.parse((await readRegularExact(config.coreFile)).data.toString('utf8'));
    if (core.name !== '@deepseek-ai/dsh' || core.version !== config.expectedVersion) throw new Error('DSH core identity or version changed');
  }
  return manifest.version;
}
function verifyCandidate(candidate, config) {
  if (candidate.hash !== config.afterHash || candidate.data.length !== config.afterSize) throw new Error('candidate hash or size mismatch');
}
function verifyBefore(original, config) {
  if (original.hash !== config.beforeHash || original.data.length !== config.beforeSize) throw new Error('host preimage hash or size mismatch');
}
async function writeExclusive(path, data, mode) {
  const h = await open(path, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, mode);
  try { await h.writeFile(data); await h.chmod(mode); await h.sync(); return await h.stat(); } finally { await h.close(); }
}

/**
 * The low-level config/hook seam supports isolated tests. Public CLI paths are
 * built from an explicit DSH installation root and the pinned BRIDGE manifest.
 * Hooks may only run in tests; no such hook is reachable from the CLI.
 */
export async function runHostBridge(config, { apply = false, hooks = {} } = {}) {
  const target = resolve(config.target), candidatePath = resolve(config.candidate), backupBase = resolve(config.backupBase);
  if (target !== config.target || candidatePath !== config.candidate || backupBase !== config.backupBase) throw new Error('non-canonical configured path');
  const parent = dirname(target);
  if (await realpath(parent) !== parent || await realpath(backupBase) !== backupBase) throw new Error('symlinked host or backup parent');
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.uid !== process.getuid() || (parentStat.mode & 0o022) !== 0) throw new Error('host parent is not exclusively controlled by this user');
  const packageVersion = await versionOf(config);
  if (config.generator && (await readRegularExact(config.generator)).hash !== config.generatorHash) throw new Error('bridge generator hash changed');
  const candidate = await readRegularExact(candidatePath);
  verifyCandidate(candidate, config);
  let original = await readRegularExact(target, config.mode);
  if (original.stat.uid !== process.getuid() || original.stat.gid !== process.getgid()) throw new Error('host owner/group differs from current user');
  if (original.hash === config.afterHash && original.data.length === config.afterSize) return { status: 'already-installed', target, hash: original.hash, packageVersion };
  verifyBefore(original, config);
  if (!apply) return { status: 'ready', target, packageVersion, beforeHash: original.hash, afterHash: candidate.hash, mode: config.mode.toString(8), uid: original.stat.uid, gid: original.stat.gid };

  const lockPath = join(parent, '.session-link-flow-bridge.lock');
  let lock, lockStat, temporary, backup, phase = 'lock';
  try {
    lock = await open(lockPath, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
    lockStat = await lock.stat();
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), target }) + '\n');
    await lock.sync();
    original = await readRegularExact(target, config.mode);
    verifyBefore(original, config);
    if (original.stat.uid !== process.getuid() || original.stat.gid !== process.getgid()) throw new Error('host owner/group changed');
    await versionOf(config);

    phase = 'backup';
    backup = await mkdtemp(join(backupBase, 'dsh-host-flow-rc1-'));
    await chmod(backup, 0o700);
    if (await realpath(backup) !== backup || !backup.startsWith(`${backupBase}${sep}`)) throw new Error('backup path escaped');
    await fsyncDirectory(backupBase);
    const saved = join(backup, 'client.js.original');
    await writeExclusive(saved, original.data, config.mode);
    const checked = await readRegularExact(saved, config.mode);
    if (checked.hash !== config.beforeHash || checked.data.length !== config.beforeSize) throw new Error('backup verification failed');
    await writeExclusive(join(backup, 'receipt-before.json'), Buffer.from(JSON.stringify({ phase: 'backed-up', target, packageVersion, beforeHash: config.beforeHash, afterHash: config.afterHash, beforeSize: config.beforeSize, afterSize: config.afterSize, mode: config.mode.toString(8), uid: original.stat.uid, gid: original.stat.gid, generatorCommit: config.generatorCommit, generatorHash: config.generatorHash, saved, at: new Date().toISOString() }, null, 2) + '\n'), 0o600);
    await fsyncDirectory(backup);
    await hooks.afterBackup?.({ backup, target });

    phase = 'prepare';
    temporary = join(parent, `.session-link-flow-bridge-${randomUUID()}.tmp`);
    const tempStat = await writeExclusive(temporary, candidate.data, config.mode);
    if (tempStat.uid !== original.stat.uid || tempStat.gid !== original.stat.gid) throw new Error('prepared file owner/group mismatch');
    const prepared = await readRegularExact(temporary, config.mode);
    verifyCandidate(prepared, config);
    await hooks.afterPrepare?.({ backup, target, temporary });

    phase = 'precommit';
    await hooks.beforeCommit?.({ backup, target, temporary });
    const current = await readRegularExact(target, config.mode);
    verifyBefore(current, config);
    if (!same(original.stat, current.stat) || current.stat.uid !== original.stat.uid || current.stat.gid !== original.stat.gid) throw new Error('host changed after backup');
    await versionOf(config);
    if (config.generator && (await readRegularExact(config.generator)).hash !== config.generatorHash) throw new Error('bridge generator hash changed');
    verifyCandidate(await readRegularExact(candidatePath), config);
    if (await realpath(parent) !== parent) throw new Error('host parent changed');
    const currentParent = await lstat(parent);
    if (!currentParent.isDirectory() || currentParent.dev !== parentStat.dev || currentParent.ino !== parentStat.ino || currentParent.uid !== parentStat.uid || (currentParent.mode & 0o022) !== 0) throw new Error('host parent identity or permissions changed');

    phase = 'commit';
    await rename(temporary, target); // same directory/filesystem, one atomic replacement
    temporary = undefined;
    await hooks.afterCommit?.({ backup, target });
    await fsyncDirectory(parent);
    phase = 'verify';
    const result = await readRegularExact(target, config.mode);
    verifyCandidate(result, config);
    if (result.stat.uid !== original.stat.uid || result.stat.gid !== original.stat.gid) throw new Error('installed owner/group mismatch');
    const receipt = { phase: 'installed', target, packageVersion, beforeHash: config.beforeHash, afterHash: result.hash, beforeSize: config.beforeSize, afterSize: result.data.length, mode: config.mode.toString(8), uid: result.stat.uid, gid: result.stat.gid, backup, generatorCommit: config.generatorCommit, generatorHash: config.generatorHash, at: new Date().toISOString(), restarted: false };
    await writeExclusive(join(backup, 'receipt-installed.json'), Buffer.from(JSON.stringify(receipt, null, 2) + '\n'), 0o600);
    await fsyncDirectory(backup);
    return { status: 'installed', ...receipt };
  } catch (error) {
    const failure = new Error(`host bridge stopped at ${phase}: ${error?.message ?? error}`, { cause: error });
    failure.phase = phase; failure.backup = backup; failure.temporary = temporary;
    throw failure;
  } finally {
    if (lock) {
      await lock.close();
      // Only remove the exact inode created by this invocation. Never guess or
      // remove somebody else's stale lock; leave it for explicit investigation.
      try { const current = await lstat(lockPath); if (lockStat && current.isFile() && current.dev === lockStat.dev && current.ino === lockStat.ino) await unlink(lockPath); } catch { /* preserve unknown ownership */ }
    }
  }
}

/** No implicit home paths, config files, or production target. */
export function parseBridgeArgs(args) {
  const options = { apply: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!['--check', '--apply', '--dsh-root', '--backup-dir'].includes(key) || seen.has(key)) throw Error('Unknown or duplicate argument');
    seen.add(key);
    if (key === '--check' || key === '--apply') { options.apply = key === '--apply'; continue; }
    const value = args[++index];
    if (!value || !value.startsWith('/') || resolve(value) !== value) throw Error('Paths must be canonical absolute paths');
    options[key === '--dsh-root' ? 'dshRoot' : 'backupBase'] = value;
  }
  if (seen.has('--check') && seen.has('--apply')) throw Error('Choose --check or --apply, not both');
  if (!options.dshRoot) throw Error('--dsh-root is required; no default installation will be touched');
  if (options.apply && !options.backupBase) throw Error('--apply requires an existing private --backup-dir');
  return options;
}

/**
 * Check the explicit installation without writes. Applying is a separate,
 * opt-in Host mutation: generate a candidate, retain exact backups/receipts,
 * then use the same guarded atomic writer as the isolated tests.
 */
export async function maintainHostBridge({ dshRoot, backupBase, apply = false }) {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') throw Error('This maintenance tool is verified for Linux only');
  if (process.getuid() === 0) throw Error('Run as the installation owner, not root or sudo');
  if (!dshRoot || resolve(dshRoot) !== dshRoot || await realpath(dshRoot) !== dshRoot) throw Error('DSH root must be canonical and non-symlinked');
  const modules = join(dshRoot, 'lib/node_modules/@deepseek-ai');
  const target = join(modules, 'dsh-client-ui-chat/lib/client.js');
  const packageFile = join(modules, 'dsh-client-ui-chat/package.json'), coreFile = join(modules, 'dsh/package.json');
  const config = { ...BRIDGE, target, packageFile, coreFile };
  const packageVersion = await versionOf(config);
  const original = await readRegularExact(target);
  const mode = original.stat.mode & 0o777;
  const parent = dirname(target), parentStat = await lstat(parent);
  if (await realpath(parent) !== parent || parentStat.uid !== process.getuid() || (parentStat.mode & 0o022) !== 0 || original.stat.uid !== process.getuid() || original.stat.gid !== process.getgid() || (mode & 0o022) !== 0) throw Error('Host file and parent must be controlled by the current user; never use sudo to bypass this check');
  if (original.hash === BRIDGE.afterHash && original.data.length === BRIDGE.afterSize) return { status: 'already-installed', target, packageVersion, hash: original.hash, restarted: false };
  verifyBefore(original, config);
  const bytes = Buffer.from(patchHostFlowRc1(original.data.toString('utf8')));
  verifyCandidate({ hash: hash(bytes), data: bytes }, config);
  if (!apply) return { status: 'ready', target, packageVersion, beforeHash: original.hash, afterHash: hash(bytes), restarted: false, writes: false };
  if (!backupBase || resolve(backupBase) !== backupBase || await realpath(backupBase) !== backupBase) throw Error('A canonical existing backup directory is required');
  const backupStat = await lstat(backupBase);
  if (!backupStat.isDirectory() || backupStat.uid !== process.getuid() || (backupStat.mode & 0o077) !== 0) throw Error('Backup directory must belong to this user and be private (0700)');
  // Keep the generated candidate as review/recovery evidence; never overwrite
  // an ignored developer artifact or require a missing local candidate file.
  const prepared = await mkdtemp(join(backupBase, 'flow-bridge-candidate-'));
  await chmod(prepared, 0o700);
  const candidate = join(prepared, 'client.js');
  await writeExclusive(candidate, bytes, 0o600);
  const generator = join(REPO, 'scripts/dsh-web-flow-bridge-rc1.mjs');
  const generatorHash = (await readRegularExact(generator)).hash;
  return runHostBridge({ ...config, mode, backupBase, candidate, generator, generatorHash }, { apply: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await maintainHostBridge(parseBridgeArgs(process.argv.slice(2))), null, 2)); }
  catch (error) {
    console.error(JSON.stringify({ status: 'stopped', phase: error.phase ?? 'preflight', message: error.message, backup: error.backup ?? null, temporary: error.temporary ?? null }, null, 2));
    console.error('Usage: node scripts/install-host-flow-bridge-rc1.mjs --dsh-root /absolute/dsh-prefix [--check | --apply --backup-dir /absolute/private-backups]');
    process.exitCode = 1;
  }
}
