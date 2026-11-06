// Bounded, read-only direct parent/child message history. These are Host
// agent-message events, NOT session-link ledger entries or delivery receipts.
export const SUBAGENT_PAGE_SIZE = 20;
const FETCH_MESSAGES = 20;
const FETCH_BUDGET = 16;
const validNumber = Number.isSafeInteger;
export function subagentText(content, sender) {
  const prefix=`Agent ${sender} sent a message: `;
  if (!Array.isArray(content) || content.length !== 2 || content[0]?.type !== 'text' || content[0].text !== prefix || content[1]?.type !== 'text' || typeof content[1].text !== 'string') return null;
  return content[1].text;
}
export function directPair(sessions, self, peer) {
  if (typeof self !== 'string' || typeof peer !== 'string' || self === peer) return null;
  try {
    const peerAddress=sessions.subagentAddress(peer);
    if (peerAddress?.parentSessionId===self && peerAddress.childSessionId===peer && ['one-shot','continuable','unknown'].includes(peerAddress.mode)) return {parent:self,child:peer,address:peerAddress};
    const selfAddress=sessions.subagentAddress(self);
    if (selfAddress?.parentSessionId===peer && selfAddress.childSessionId===self && ['one-shot','continuable','unknown'].includes(selfAddress.mode)) return {parent:peer,child:self,address:selfAddress};
  } catch { /* never infer a parent/child relationship */ }
  return null;
}
export function createSubagentPager(pair, cuts) {
  return { sources:[
    {address:cuts.parentAddress,receiver:pair.parent,sender:pair.child,throughSeq:cuts.parent,beforeSeq:undefined,done:cuts.parent<0,buffer:[]},
    {address:{kind:'subagent',...pair.address},receiver:pair.child,sender:pair.parent,throughSeq:cuts.child,beforeSeq:undefined,done:cuts.child<0,buffer:[]},
  ], seen:[] };
}
const newest=(a,b)=>b.createdAt-a.createdAt || a.id.localeCompare(b.id);
export async function readSubagentPage(previous, read, {signal}={}) {
  const next={sources:previous.sources.map(s=>({...s,buffer:[...s.buffer]})),seen:[...previous.seen]}, seen=new Set(next.seen), items=[];
  let budget=FETCH_BUDGET, incomplete=false;
  async function fill(source) {
    while (!source.buffer.length && !source.done) {
      if (signal?.aborted) throw new DOMException('Aborted','AbortError');
      if (budget<=0) { incomplete=true; return; }
      budget--;
      const page=await read({address:source.address,throughSeq:source.throughSeq,beforeSeq:source.beforeSeq,maxMessages:FETCH_MESSAGES,signal});
      if (signal?.aborted) throw new DOMException('Aborted','AbortError');
      if (!page || !Array.isArray(page.records) || typeof page.hasMore!=='boolean') throw new Error('invalid_session_page');
      let min=Infinity, previousSeq=-1;
      const found=[];
      for (const item of page.records) {
        const event=item?.type==='event' ? item.event : null;
        if (!event || !validNumber(event.seq) || event.seq<0 || event.seq<=previousSeq || event.seq>source.throughSeq || (source.beforeSeq!==undefined && event.seq>=source.beforeSeq)) throw new Error('invalid_session_page');
        previousSeq=event.seq; min=Math.min(min,event.seq);
        const data=event.data, src=data?.source;
        if(event.type!=='user/message' || src?.kind!=='agent-message' || src.form!=='relay' || src.senderSessionId!==source.sender)continue;
        const text=subagentText(data.content,source.sender);
        if(typeof data.id!=='string' || !Number.isFinite(event.time)) throw new Error('invalid_agent_message');
        // Never discard a verified event merely because this reader cannot
        // represent one of its content blocks; offer its original session.
        found.push({id:data.id,from:source.sender,to:source.receiver,createdAt:event.time,text,unsupported:text===null});
      }
      if (page.hasMore && (!Number.isFinite(min) || min===0)) throw new Error('invalid_session_page');
      source.beforeSeq=Number.isFinite(min)?min:source.beforeSeq;
      source.done=!page.hasMore;
      source.buffer.push(...found.sort(newest));
    }
  }
  while(items.length<SUBAGENT_PAGE_SIZE) {
    for(const source of next.sources) await fill(source);
    if(next.sources.some(source=>!source.done&&!source.buffer.length))break;
    const available=next.sources.filter(source=>source.buffer.length).sort((a,b)=>newest(a.buffer[0],b.buffer[0]));
    if(!available.length)break;
    const value=available[0].buffer.shift();
    if(!seen.has(value.id)){seen.add(value.id);items.push(value);}
  }
  next.seen=[...seen];
  return {pager:next,messages:items.reverse(),hasMore:next.sources.some(source=>!source.done||source.buffer.length),incomplete};
}
