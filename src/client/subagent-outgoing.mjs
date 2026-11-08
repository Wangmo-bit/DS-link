// Non-exclusive projection of `send_message` calls to direct child agents,
// gated by the current exact event window and verified direct parent/child
// addresses. A call is shown as "sending" from the moment the Host records it;
// only the Host's own acknowledgement turns it into a delivered receipt. A
// failed call is marked failed instead of disappearing without a trace.
// Never turns a tool acknowledgement into an 'entered context' receipt.
import { directPair } from './subagent-history.mjs';
export const SUBAGENT_SEND_KIND='session-link-subagent-send';
const callIdOf = event => event.data?.message?.source?.callId;
function isAcknowledgedContent(content) {
  return Array.isArray(content) && content.some(block=>block?.type==='text' && typeof block.text==='string' && /^message delivered to agent\s/iu.test(block.text));
}
function argumentsOf(raw) {
  try { const value=JSON.parse(raw); return value && typeof value==='object' && !Array.isArray(value)?value:null; } catch { return null; }
}
export function createSubagentSenderDefinition({scope,sessions}) {
  // Call ids observed as `send_message` calls by THIS definition. A result can
  // otherwise be any tool's result; only these ids may end a sending capsule.
  const sendCalls = new Set();
  return {
    kind:SUBAGENT_SEND_KIND,target:'chat',
    match(event) {
      if(event.type==='tool/call' && event.data?.name==='send_message' && typeof event.data.callId==='string') {
        // Only a verified direct parent/child address may enter the projection;
        // every other send_message call keeps its original native row.
        const owner=typeof scope.resolveEvent==='function'?scope.resolveEvent(event):null;
        const args=argumentsOf(event.data.arguments), target=typeof args?.agent_id==='string'?args.agent_id:args?.target;
        if(typeof owner!=='string'||typeof target!=='string'||typeof args?.message!=='string')return null;
        if(!directPair(sessions,owner,target))return null;
        sendCalls.add(event.data.callId);
        return {id:event.data.callId,role:'start'};
      }
      if(event.type==='tool/result' && event.surfaceOp==='append' && sendCalls.has(callIdOf(event))) return {id:callIdOf(event),role:'update'};
      return null;
    },
    start(_context,match) { const event=match.event;return {call:{id:event.data.callId,args:event.data.arguments,seq:event.seq,event},result:null}; },
    update(context,match) {
      const event=match.event;
      if(event.type==='tool/call') return {...context.state,call:{id:event.data.callId,args:event.data.arguments,seq:event.seq,event}};
      const message=event.data?.message;
      const owner=scope.resolveResult(event,callIdOf(event));
      const content=message?.content;
      const text=Array.isArray(content)?content.filter(block=>block?.type==='text').map(block=>block.text).join(''):'';
      const ok=message?.isError!==true && isAcknowledgedContent(content);
      return {...context.state,result:{owner,time:event.time,seq:event.seq,text,ok}};
    },
    buildViewNode(context) {
      const {call,result}=context.state??{};
      if(!call)return null;
      const args=argumentsOf(call.args), target=typeof args?.agent_id==='string'?args.agent_id:args?.target;
      if(typeof target!=='string' || typeof args?.message!=='string')return null;
      // The sending phase has no result yet; its owner is the unique current
      // window holding the call event. Any ambiguity falls back to native.
      const owner=result===null
        ? (typeof scope.resolveEvent==='function'&&call.event ? scope.resolveEvent(call.event) : null)
        : (typeof result.owner==='string'?result.owner:null);
      if(typeof owner!=='string'||!owner)return null;
      const pair=directPair(sessions,owner,target);
      if(!pair)return null;
      // A delivery acknowledgement must name exactly this target; anything else
      // is ambiguous and falls back to the Host instead of inventing a receipt.
      if(result!==null && result.ok===true && result.text!==`message delivered to agent ${target}`)return null;
      const acknowledged=result?.ok===true;
      // An old call with no result (aborted turn) must not spin forever: once
      // its session is provably not running, report an honest unknown state.
      const idle=sessions?.byId?.[owner]?.running===false;
      const state=result===null ? (idle?'unknown':'sending') : acknowledged ? 'sent' : 'failed';
      return {key:context.key,kind:SUBAGENT_SEND_KIND,id:context.id,target:'chat',anchorSeq:call.seq,location:context.start?.location??context.matches?.[0]?.location??{kind:'unresolved'},visibility:'visible',groupTree:'turn',data:{from:owner,to:target,text:args.message,time:result?.time,pair,state}};
    },
  };
}
