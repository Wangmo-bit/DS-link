// Narrow release-preparation checks, not a guarantee of no secrets and not a
// replacement for owner review of Git history, licenses and repository settings.
import { readFile, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join, extname } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const errors = [];
const required = ['README.md','README_ZH.md','PRD.md','LICENSE','THIRD_PARTY_NOTICES.md','ASSETS.md','CONTRIBUTING.md','CONTRIBUTING.en.md','SECURITY.md','SECURITY.en.md','TESTING.md','RELEASING.md','docs/installation.md','docs/installation.en.md','docs/quickstart.md','docs/quickstart.en.md','docs/settings.md','docs/settings.en.md','docs/known-issues.md','docs/known-issues.en.md','docs/security-model.md','docs/open-source-readiness.md'];
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
if (pkg.version !== lock.version || pkg.version !== lock.packages[''].version) errors.push('package/lock version mismatch');
if (pkg.private !== true) errors.push('Preparation branch must keep private:true; publishing requires separate approval');
if (pkg.name !== '@wangmo-bit/ds-link' || lock.name !== pkg.name || lock.packages[''].name !== pkg.name) errors.push('DS-link package/lock identity mismatch');
if (pkg.license !== 'MIT' || pkg.repository?.url !== 'git+https://github.com/Wangmo-bit/DS-link.git') errors.push('Package license/repository metadata missing');
for (const name of required) {
  try { await stat(join(root, name)); }
  catch { errors.push(`Required public file missing: ${name}`); }
}
const guides = [...required.filter(p => p.endsWith('.md')), 'MAINTAINING.md','PACKAGING.md','LANGUAGES.md','docs/architecture.md','docs/philosophy.md','docs/roadmap.md'];
for (const file of guides) {
  let source; try { source = await readFile(join(root, file), 'utf8'); } catch { continue; }
  for (const match of source.matchAll(/!?\[[^\]\n]*\]\(([^)]+)\)/gu)) {
    let target = match[1].replace(/^<|>$/gu, '').split('#')[0];
    if (!target || /^(https?:|mailto:|data:)/u.test(target)) continue;
    target = resolve(dirname(join(root, file)), decodeURIComponent(target));
    if (!target.startsWith(root)) { errors.push(`Nonportable documentation link in ${file}`); continue; }
    try { await stat(target); } catch { errors.push(`Broken link in ${file}: ${match[1]}`); }
  }
}
const sources = [];
const walk = async directory => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git','node_modules','dist','output','artifacts','.npm','.playwright-cli','.playwright'].includes(entry.name)) continue;
    const name = join(directory, entry.name);
    if (entry.isDirectory()) await walk(name);
    else if (['.js','.jsx','.mjs','.json','.md','.yml','.yaml'].includes(extname(name))) sources.push(name);
  }
};
await walk(root);
const credentials = /\b(?:gh[pousr]_[A-Za-z0-9]{25,}|sk-[A-Za-z0-9]{25,}|AIza[A-Za-z0-9_-]{30,})\b|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/u;
for (const file of sources) {
  const text = await readFile(file, 'utf8');
  if (credentials.test(text)) errors.push(`Credential-shaped value needs private review: ${file.slice(root.length)}`);
  if (file.startsWith(join(root, 'src/')) && /\/home\/wangmo\/|\/srv\/data\/projects\/|王墨/u.test(text)) errors.push(`Maintainer-specific runtime identity/path: ${file.slice(root.length)}`);
}
if (process.argv.includes('--pack')) {
  const [manifest] = JSON.parse(execFileSync('npm', ['pack','--ignore-scripts','--dry-run','--json'], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
  const files = manifest.files.map(item => item.path);
  for (const file of files) if (!/^(?:src\/(?:core|host)\/|dist\/client\.js$|assets\/icon\.svg$|cordis\.patch\.yml$|package\.json$|README(?:_ZH)?\.md$|LICENSE$|THIRD_PARTY_NOTICES\.md$|TESTING\.md$)/u.test(file)) errors.push(`Unexpected packed file: ${file}`);
  for (const name of ['LICENSE','THIRD_PARTY_NOTICES.md','dist/client.js',pkg.exports['.'].replace(/^\.\//u,'')]) if (!files.includes(name)) errors.push(`Required packed file missing: ${name}`);
  console.log(`Pack allowlist checked: ${files.length} files (lifecycle scripts not executed by this check).`);
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`Public preparation checks passed (${guides.length} guide files, ${sources.length} text files). History and remote settings still need separate review.`);
