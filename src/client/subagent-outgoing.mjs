// Non-exclusive projection of successful native send_message calls, gated by
// the current exact event window and verified direct parent/child addresses.
// Never turns a tool acknowledgement into an 'entered context' receipt.
import { directPair } from './subagent-history.mjs';
export const SUBAGENT_SEND_KIND='session-link-subagent-send';
const callIdOf = event => event.data?.message?.source?.callId;
function isAcknowledged(event) {
  const content=event.data?.message?.content;
  return event.type==='tool/result' && event.surfaceOp==='append' && event.data?.message?.isError!==true && Array.isArray(content) && content.some(block=>block?.type==='text' && typeof block.text==='string' && /^message delivered to agent\s/iu.test(block.text));
}
function argumentsOf(raw) {
  try { const value=JSON.parse(raw); return value && typeof value==='object' && !Array.isArray(value)?value:null; } catch { return null; }
}
export function createSubagentSenderDefinition({scope,sessions}) {
  return {
    kind:SUBAGENT_SEND_KIND,target:'chat',
    match(event) {
      if(event.type==='tool/call' && event.data?.name==='send_message' && typeof event.data.callId==='string') return {id:event.data.callId,role:'start'};
      if(isAcknowledged(event) && typeof callIdOf(event)==='string' && scope.resolveResult(event,callIdOf(event))!==null) return {id:callIdOf(event),role:'update'};
      return null;
    },
    start(_context,match) { const event=match.event;return {call:{id:event.data.callId,args:event.data.arguments,seq:event.seq},result:null}; },
    update(context,match) {
      const event=match.event;
      if(event.type==='tool/call') return {...context.state,call:{id:event.data.callId,args:event.data.arguments,seq:event.seq}};
      const owner=scope.resolveResult(event,callIdOf(event));
      const text=event.data.message.content.filter(block=>block?.type==='text').map(block=>block.text).join('');
      return {...context.state,result:{owner,time:event.time,seq:event.seq,text}};
    },
    buildViewNode(context) {
      const {call,result}=context.state??{};
      if(!call||!result||typeof result.owner!=='string')return null;
      const args=argumentsOf(call.args), target=typeof args?.agent_id==='string'?args.agent_id:args?.target;
      if(typeof target!=='string' || typeof args?.message!=='string' || !Number.isFinite(result.time) || result.text !== `message delivered to agent ${target}`)return null;
      const pair=directPair(sessions,result.owner,target);
      if(!pair)return null;
      return {key:context.key,kind:SUBAGENT_SEND_KIND,id:context.id,target:'chat',anchorSeq:call.seq,location:context.start?.location??context.matches?.[0]?.location??{kind:'unresolved'},visibility:'visible',groupTree:'turn',data:{from:result.owner,to:target,text:args.message,time:result.time,pair}};
    },
  };
}
