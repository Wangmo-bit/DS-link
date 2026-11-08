// Build-time only: fetch pinned public SDK tarballs for offline tests. This
// does not install plugins, execute their lifecycle scripts or start DSH.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { patchHostChat } from './dsh-web-scroll-patch.mjs';
const destination = process.argv[2];
if (!destination || resolve(destination) !== destination) throw Error('Usage: node scripts/prepare-host-fixtures.mjs /absolute/new-output-directory');
// Refuse existing outputs; fixture identities must never be silently replaced.
await mkdir(destination, { mode: 0o700 });
const bundles = [
  ['chat-rc1','@deepseek-ai/dsh-client-ui-chat@0.2.2-rc.1','b7e645f2461231e8ece31381f026db2df72d058e425eaef19265f215c823d84e'],
  ['chat-rc5','@deepseek-ai/dsh-client-ui-chat@0.2.1-rc.5','181f766f2fe12ad27eed4f1c0cd4609e8d2211d397890355eb476b6a9ee311c2'],
  ['conversation','@deepseek-ai/dsh-client-ui-conversation@0.2.2-rc.1','9a37949cc76603ea3a965ce4d0d6ca65885de4a9808345c38748e595ac396378'],
];
for (const [name, spec, expected] of bundles) {
  const temp = await mkdtemp(join(destination,'download-'));
  const [manifest] = JSON.parse(execFileSync('npm',['pack',spec,'--ignore-scripts','--json','--pack-destination',temp],{encoding:'utf8'}));
  const target = join(destination,name);
  await mkdir(target);
  // Extract only regular bundle and package metadata paths, not executable
  // installation scripts or a complete dependency tree.
  execFileSync('tar',['--no-same-owner','-xzf',join(temp,manifest.filename),'-C',target,'package/lib/client.js','package/package.json']);
  const bytes = await readFile(join(target,'package/lib/client.js'));
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw Error(`Pinned SDK bytes changed: ${name}`);
}
const rc5 = await readFile(join(destination,'chat-rc5/package/lib/client.js'),'utf8');
await writeFile(join(destination,'chat-rc5/scroll-patched.js'),patchHostChat(rc5),{flag:'wx'});
console.log('Prepared exact-version public SDK fixtures; no installed Host was read or modified.');
