// Safe default: legacy suites use fixed /tmp paths and chmod fault injection.
// Do not allow `npm test` to run them on the maintainer's shared host /tmp.
import { readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, relative, join } from 'node:path';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

export async function assertTestIsolation() {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() === 0) throw Error('Tests require a non-root Linux user in a disposable container. See TESTING.md.');
  const mounts = await readFile('/proc/self/mountinfo', 'utf8');
  const tmp = mounts.split('\n').find(line => line.split(' ')[4] === '/tmp');
  if (!tmp || tmp.split(' - ')[1]?.split(' ')[0] !== 'tmpfs') throw Error('Tests require their own tmpfs mounted at /tmp; setting TMPDIR is not isolation. See TESTING.md.');
  if (tmp.split(' ')[5]?.split(',').includes('noexec')) throw Error('The disposable /tmp tmpfs must use exec for esbuild; see the exact Docker flags in TESTING.md.');
}

export async function testFiles() {
  const files = [];
  const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && (directory !== join(root, 'scripts') || ['stress', 'v02', 'v03', 'v04'].includes(entry.name))) await walk(path);
      else if (entry.isFile() && /\.test\.(mjs|js)$/u.test(entry.name)) files.push(relative(root, path));
    }
  };
  await walk(join(root, 'test'));
  await walk(join(root, 'scripts'));
  return files.sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await assertTestIsolation();
    const files = await testFiles();
    console.log(`Running ${files.length} test files in verified non-root /tmp tmpfs isolation.`);
    const child = spawn(process.execPath, ['--test', ...files], {
      cwd: root, stdio: 'inherit', env: { ...process.env, SL_HOST_INSTALL_TEST_ISOLATED: '1' },
    });
    child.on('error', error => { console.error(error.message); process.exitCode = 1; });
    child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
