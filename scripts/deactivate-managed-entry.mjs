// Rename handoff: remove only our managed host row, after bundle deselection.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const BEGIN='# BEGIN dsh-session-link managed-hot-entry',END='# END dsh-session-link managed-hot-entry';
export function removeManagedEntry(text){
 const lines=text.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean)??[];let offset=0,start=-1,end=-1,starts=0,ends=0;
 for(const line of lines){const value=line.replace(/\r?\n$/,'');if(value===BEGIN){starts++;start=offset}if(value===END){ends++;end=offset+line.length}offset+=line.length}
 if(starts===0&&ends===0)return text;
 if(starts!==1||ends!==1||start<0||end<=start)throw Error('Malformed managed block; refuse removal');
 const body=text.slice(start,end).split(/\r?\n/).filter(x=>x&&x!==BEGIN&&x!==END);
 const allowed=[/^\s*- id: session-link(?:-runtime)?-[A-Za-z0-9.-]+\s*$/,/^\s*- id: session-link\s*$/,/^\s*disabled: true\s*$/,/^\s*- insert:\s*$/,/^\s*- id: session-link-hot-[A-Za-z0-9.-]+\s*$/,/^\s*name: 'file:\/\/.*'\s*$/];
 if(body.some(line=>!allowed.some(re=>re.test(line))))throw Error('Managed block was customized; refuse to discard content');
 if(body.filter(x=>/^\s*name:/.test(x)).length!==1)throw Error('Unexpected managed host rows');
 const outside=text.slice(0,start)+text.slice(end);
 if(/^\s*(?:-\s*)?id:\s*['\"]?session-link(?:-runtime-|-hot-|['\"]?\s*$)/m.test(outside)||/^\s*name:.*node_modules\/(?:@wangmo\/)?dsh-session-link\//m.test(outside))throw Error('Plugin host row remains outside managed block; refuse partial deactivation');
 return outside;
}
export async function deactivate(profileDir,{apply=false,allowProduction=false}={}){
 const dir=await fs.realpath(profileDir),manifest=JSON.parse(await fs.readFile(path.join(dir,'package.json'),'utf8'));
 const names=['dsh-session-link','@wangmo/dsh-session-link'];
 const selected=(manifest.dsh?.profile?.bundles??[]).map(item=>{if(typeof item==='string')return item;if(item&&typeof item.name==='string')return item.name;throw Error('Unsupported bundle shape; refuse managed host removal')});
 if(selected.some(n=>names.includes(n)))throw Error('Deselect legacy/new bundles before managed host removal');
 const file=path.join(dir,'cordis.patch.yml'),before=await fs.readFile(file,'utf8'),after=removeManagedEntry(before);
 const result={profile:dir,changed:before!==after,applied:false};if(!apply||before===after)return result;
 if(!dir.startsWith('/tmp/')&&!allowProduction)throw Error('Production removal requires --allow-production');
 const hash=s=>createHash('sha256').update(s).digest('hex');
 if(hash(await fs.readFile(file,'utf8'))!==hash(before))throw Error('CAS conflict before deactivation');
 const backup=`${file}.before-deactivate-${Date.now()}-${randomUUID()}`;const b=await fs.open(backup,'wx',0o600);try{await b.writeFile(before);await b.sync()}finally{await b.close()}
 const d=await fs.open(dir,'r');await d.sync();const tmp=`${file}.tmp-${randomUUID()}`;
 try{const t=await fs.open(tmp,'wx',0o600);try{await t.writeFile(after);await t.sync()}finally{await t.close()};if(hash(await fs.readFile(file,'utf8'))!==hash(before))throw Error('CAS conflict before rename');await fs.rename(tmp,file);await d.sync()}finally{await d.close();await fs.unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e})}
 return{...result,applied:true,backup};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const args=process.argv.slice(2);const flags=args.filter(x=>x.startsWith('--'));if(!args[0]||flags.some(x=>!['--apply','--allow-production'].includes(x)))throw Error('usage: deactivate-managed-entry.mjs <profileDir> [--apply] [--allow-production]');console.log(JSON.stringify(await deactivate(args[0],{apply:flags.includes('--apply'),allowProduction:flags.includes('--allow-production')}),null,2));}
