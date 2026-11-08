// Run ONLY in an isolated tmpfs/container; this suite performs filesystem writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHostBridge } from './install-host-flow-bridge-rc1.mjs';

if (process.env.SL_HOST_INSTALL_TEST_ISOLATED !== '1') throw new Error('requires verified isolated tmpfs; do not run against host /tmp');
const sha = x => createHash('sha256').update(x).digest('hex');
const before = Buffer.from('official synthetic rc1 bytes\n');
const after = Buffer.from('candidate synthetic rc1 bytes\n');
const generator = Buffer.from('synthetic version-bound generator\n');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sl-host-installer-'));
  const host = join(root, 'host'), backupBase = join(root, 'backups');
  await mkdir(host); await mkdir(backupBase);
  const target=join(host,'client.js'),packageFile=join(host,'package.json'),coreFile=join(host,'core.json'),candidate=join(root,'candidate.js'),generatorPath=join(root,'generator.mjs');
  await writeFile(target,before,{mode:0o600});await writeFile(candidate,after,{mode:0o600});await writeFile(generatorPath,generator,{mode:0o600});
  await writeFile(packageFile,JSON.stringify({name:'@deepseek-ai/dsh-client-ui-chat',version:'0.2.2-rc.1'}),{mode:0o600});
  await writeFile(coreFile,JSON.stringify({name:'@deepseek-ai/dsh',version:'0.2.2-rc.1'}),{mode:0o600});
  const config={target,packageFile,coreFile,candidate,generator:generatorPath,backupBase,expectedVersion:'0.2.2-rc.1',beforeHash:sha(before),beforeSize:before.length,afterHash:sha(after),afterSize:after.length,mode:0o600,generatorCommit:'test',generatorHash:sha(generator)};
  return {root,host,target,candidate,packageFile,coreFile,generatorPath,backupBase,config};
}
const eq = async (path, bytes) => assert.deepEqual(await readFile(path),bytes);

test('default check does not write and identifies exact candidate',async()=>{
 const f=await fixture(), result=await runHostBridge(f.config);
 assert.equal(result.status,'ready');assert.equal(result.beforeHash,sha(before));assert.equal(result.afterHash,sha(after));await eq(f.target,before);assert.deepEqual(await readdir(f.backupBase),[]);assert.deepEqual((await readdir(f.host)).sort(),['client.js','core.json','package.json']);
});
test('apply backs up exact bytes, atomically replaces once, and retry is idempotent',async()=>{
 const f=await fixture(),result=await runHostBridge(f.config,{apply:true});
 assert.equal(result.status,'installed');assert.equal(result.restarted,false);await eq(f.target,after);await eq(join(result.backup,'client.js.original'),before);
 assert.equal((await lstat(result.backup)).mode&0o777,0o700);assert.equal((await lstat(f.target)).mode&0o777,0o600);
 const receipt=JSON.parse(await readFile(join(result.backup,'receipt-installed.json'),'utf8'));assert.equal(receipt.afterHash,sha(after));assert.equal(receipt.beforeHash,sha(before));
 const again=await runHostBridge(f.config,{apply:true});assert.equal(again.status,'already-installed');assert.equal((await readdir(f.backupBase)).length,1);assert.ok(!(await readdir(f.host)).some(n=>n.includes('flow-bridge')));
});
test('preimage mismatch refuses all writes',async()=>{
 const f=await fixture();await writeFile(f.target,'foreign host bytes');await assert.rejects(runHostBridge(f.config,{apply:true}),/preimage hash or size mismatch/);assert.equal((await readFile(f.target,'utf8')),'foreign host bytes');assert.deepEqual(await readdir(f.backupBase),[]);
});
test('candidate and generator mismatch both refuse all writes',async()=>{
 const f=await fixture();await writeFile(f.candidate,'wrong candidate');await assert.rejects(runHostBridge(f.config,{apply:true}),/candidate hash or size mismatch/);await eq(f.target,before);assert.deepEqual(await readdir(f.backupBase),[]);
 const g=await fixture();await writeFile(g.generatorPath,'wrong generator');await assert.rejects(runHostBridge(g.config,{apply:true}),/generator hash changed/);await eq(g.target,before);assert.deepEqual(await readdir(g.backupBase),[]);
});
test('version and mode mismatch refuse all writes',async()=>{
 const f=await fixture();await writeFile(f.packageFile,JSON.stringify({name:'@deepseek-ai/dsh-client-ui-chat',version:'9.0.0'}));await assert.rejects(runHostBridge(f.config,{apply:true}),/identity or version changed/);await eq(f.target,before);
 const g=await fixture();await chmod(g.target,0o644);await assert.rejects(runHostBridge(g.config,{apply:true}),/target mode changed/);await eq(g.target,before);
 const h=await fixture();await writeFile(h.coreFile,JSON.stringify({name:'@deepseek-ai/dsh',version:'9.0.0'}));await assert.rejects(runHostBridge(h.config,{apply:true}),/DSH core identity or version changed/);await eq(h.target,before);
});
test('symlinked target is refused without touching referent',async()=>{
 const f=await fixture();const link=join(f.host,'link.js');await symlink(f.target,link);await assert.rejects(runHostBridge({...f.config,target:link},{apply:true}),/non-symlink/);await eq(f.target,before);assert.deepEqual(await readdir(f.backupBase),[]);
});
test('another writer lock is preserved and prevents replacement',async()=>{
 const f=await fixture(),lock=join(f.host,'.session-link-flow-bridge.lock');await writeFile(lock,'other owner',{mode:0o600});await assert.rejects(runHostBridge(f.config,{apply:true}),/EEXIST/);assert.equal(await readFile(lock,'utf8'),'other owner');await eq(f.target,before);assert.deepEqual(await readdir(f.backupBase),[]);
});
test('change after backup refuses rename and preserves the concurrent writer',async()=>{
 const f=await fixture();let backup;
 await assert.rejects(runHostBridge(f.config,{apply:true,hooks:{afterBackup(x){backup=x.backup;},async beforeCommit(){await writeFile(f.target,'concurrent change');}}}),/preimage hash or size mismatch|host changed after backup/);
 assert.equal(await readFile(f.target,'utf8'),'concurrent change');await eq(join(backup,'client.js.original'),before);assert.ok((await readdir(f.host)).some(n=>n.endsWith('.tmp')));
});
test('failure after prepare leaves original intact and preserves backup/temp evidence',async()=>{
 const f=await fixture();let saved;
 await assert.rejects(runHostBridge(f.config,{apply:true,hooks:{afterPrepare(x){saved=x;throw Error('injected failure');}}}),/stopped at prepare/);
 await eq(f.target,before);await eq(join(saved.backup,'client.js.original'),before);await eq(saved.temporary,after);assert.ok(!(await readdir(f.host)).includes('.session-link-flow-bridge.lock'));
});
test('failure immediately after rename preserves both new target and old backup',async()=>{
 const f=await fixture();let saved;
 await assert.rejects(runHostBridge(f.config,{apply:true,hooks:{afterCommit(x){saved=x;throw Error('injected post-rename failure');}}}),/stopped at commit/);
 await eq(f.target,after);await eq(join(saved.backup,'client.js.original'),before);assert.ok(!(await readdir(f.host)).includes('.session-link-flow-bridge.lock'));
});
