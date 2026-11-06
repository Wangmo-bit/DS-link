import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubagentPager, directPair, readSubagentPage, subagentText } from '../src/client/subagent-history.mjs';
const address={parentSessionId:'P',childSessionId:'C',mode:'continuable'};
const sessions={subagentAddress:id=>id==='C'?address:undefined};
const msg=(seq,sender,body,time=seq)=>({type:'event',event:{seq,time,type:'user/message',data:{id:`${sender}-${seq}`,source:{kind:'agent-message',form:'relay',senderSessionId:sender},content:[{type:'text',text:`Agent ${sender} sent a message: `},{type:'text',text:body}]}}});
const unrelated=seq=>({type:'event',event:{seq,time:seq,type:'assistant/message',data:{}}});
function fixture(parent,child){const calls=[];return {calls,read:async q=>{calls.push(q);const rows=q.address.kind==='session'?parent:child;const end=q.beforeSeq??q.throughSeq+1;const filtered=rows.filter(e=>e.event.seq<end&&e.event.seq<=q.throughSeq);const selected=filtered.slice(-q.maxMessages);return {records:selected,hasMore:filtered.length>selected.length};}};}

test('direct pair must use Host-verified immediate parent address',()=>{
 assert.deepEqual(directPair(sessions,'P','C'),{parent:'P',child:'C',address});
 assert.deepEqual(directPair(sessions,'C','P'),{parent:'P',child:'C',address});
 assert.equal(directPair(sessions,'other','C'),null);assert.equal(directPair(sessions,'P','P'),null);
});
test('only the exact Host-generated text prefix can be removed',()=>{
 assert.equal(subagentText([{type:'text',text:'Agent C sent a message: '},{type:'text',text:'hello'}],'C'),'hello');
 assert.equal(subagentText([{type:'text',text:'Agent X sent a message: '},{type:'text',text:'hello'}],'C'),null);
 assert.equal(subagentText([{type:'text',text:'Agent C sent a message: '},{type:'image'}],'C'),null);
});
test('merges latest 20 actual direct messages, then older without duplicates',async()=>{
 const parent=Array.from({length:29},(_,i)=>i%3===0?msg(i,'C',`r${i}`,i*2):unrelated(i));
 const child=Array.from({length:29},(_,i)=>i%3===0?msg(i,'P',`s${i}`,i*2+1):unrelated(i));
 const f=fixture(parent,child),start=createSubagentPager(directPair(sessions,'P','C'),{parent:28,child:28,parentAddress:{kind:'session',sessionId:'P'}});
 const page=await readSubagentPage(start,f.read);assert.equal(page.messages.length,20);assert.equal(page.hasMore,false);
 assert.equal(new Set(page.messages.map(m=>m.id)).size,20);assert.ok(page.messages.every((m,i,a)=>i===0||a[i-1].createdAt<=m.createdAt));
 assert.ok(f.calls.every(c=>c.maxMessages===20));
});
test('successive child history pages do not drop or duplicate either direction',async()=>{
 const parent=Array.from({length:26},(_,i)=>msg(i,'C',`r${i}`,i*2)), child=Array.from({length:26},(_,i)=>msg(i,'P',`s${i}`,i*2+1));
 const f=fixture(parent,child);let p=createSubagentPager(directPair(sessions,'P','C'),{parent:25,child:25,parentAddress:{kind:'session',sessionId:'P'}}),more=true;const pages=[];
 while(more){const result=await readSubagentPage(p,f.read);pages.push(result.messages);p=result.pager;more=result.hasMore;}
 assert.deepEqual(pages.map(page=>page.length),[20,20,12]);const all=pages.flat();assert.equal(new Set(all.map(m=>m.id)).size,52);assert.ok(all.every(m=>m.from==='P'||m.from==='C'));
});
test('unknown content is retained as an honest source-session fallback',async()=>{
 const strange=msg(0,'C','x');strange.event.data.content.push({type:'image'});
 const f=fixture([strange],[]),p=createSubagentPager(directPair(sessions,'P','C'),{parent:0,child:-1,parentAddress:{kind:'session',sessionId:'P'}});
 const page=await readSubagentPage(p,f.read);assert.equal(page.messages.length,1);assert.equal(page.messages[0].unsupported,true);assert.equal(page.messages[0].text,null);
});
test('pagination checks aborts and malformed/non-monotonic pages',async()=>{
 const p=createSubagentPager(directPair(sessions,'P','C'),{parent:2,child:-1,parentAddress:{kind:'session',sessionId:'P'}});
 await assert.rejects(readSubagentPage(p,async()=>({records:[unrelated(2),unrelated(1)],hasMore:false})),/invalid_session_page/);
 const controller=new AbortController();controller.abort();await assert.rejects(readSubagentPage(p,async()=>({records:[],hasMore:false}),{signal:controller.signal}),{name:'AbortError'});
});
test('scan budget does not fabricate absence when messages are sparse',async()=>{
 const f=fixture(Array.from({length:400},(_,i)=>unrelated(i)),[]),p=createSubagentPager(directPair(sessions,'P','C'),{parent:399,child:-1,parentAddress:{kind:'session',sessionId:'P'}});
 const page=await readSubagentPage(p,f.read);assert.equal(page.messages.length,0);assert.equal(page.incomplete,true);assert.equal(page.hasMore,true);assert.equal(f.calls.length,16);
});
