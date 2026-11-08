import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubagentSenderDefinition, SUBAGENT_SEND_KIND } from '../src/client/subagent-outgoing.mjs';
const address={parentSessionId:'P',childSessionId:'C',mode:'continuable'};
const sessions={subagentAddress:id=>id==='C'?address:undefined};
const scope={resolveResult:(event,id)=>event.owner==='P'&&id==='call-1'?'P':null,resolveEvent:event=>event===call?'P':null};
const def=createSubagentSenderDefinition({scope,sessions});
const call={type:'tool/call',seq:3,data:{callId:'call-1',name:'send_message',arguments:JSON.stringify({agent_id:'C',message:'actual text'})}};
const result=(text='message delivered to agent C')=>({type:'tool/result',seq:5,time:50,surfaceOp:'append',owner:'P',data:{message:{source:{callId:'call-1'},isError:false,content:[{type:'text',text}]}}});
function stateFor(event=result()) {const start={event:call}, state=def.start({},start);return def.update({state},{event});}
function nodeFor(state) {return def.buildViewNode({key:'k',id:'call-1',state,start:{location:{kind:'unresolved'}},matches:[]});}
test('successful exact direct-child native send creates only a non-exclusive projection',()=>{
 assert.deepEqual(def.match(call),{id:'call-1',role:'start'});assert.deepEqual(def.match(result()),{id:'call-1',role:'update'});
 const node=nodeFor(stateFor());assert.equal(node.kind,SUBAGENT_SEND_KIND);assert.equal(node.data.text,'actual text');assert.equal(node.data.from,'P');assert.equal(node.data.to,'C');
 assert.equal(node.groupTree,'turn');assert.equal(node.anchorSeq,3);
});
test('a recorded call shows sending until the Host acknowledges or rejects it',()=>{
 // No result yet: the capsule exists and is still sending (live session).
 const sending=def.buildViewNode({key:'k',id:'call-1',state:def.start({}, {event:call}),start:{location:{kind:'unresolved'}},matches:[]});
 assert.equal(sending?.data.state,'sending');assert.equal(sending?.data.to,'C');
 // Result arrives: the same node becomes a confirmed receipt.
 const sent=nodeFor(stateFor());assert.equal(sent.data.state,'sent');
 // A failed call is marked failed instead of vanishing.
 const failedResult=result();failedResult.data.message.isError=true;
 const failed=nodeFor(stateFor(failedResult));assert.equal(failed.data.state,'failed');
 // A call with no result whose session is provably not running is unknown, not spinning.
 const idleSessions={...sessions,byId:{P:{running:false}}};
 const idleDef=createSubagentSenderDefinition({scope,sessions:idleSessions});
 const unknown=idleDef.buildViewNode({key:'k',id:'call-1',state:idleDef.start({}, {event:call}),start:{location:{kind:'unresolved'}},matches:[]});
 assert.equal(unknown?.data.state,'unknown');
});
test('unknown/forked/mismatched source never claims a fabricated sender event',()=>{
 assert.equal(def.match({...result(),surfaceOp:{op:'replace'}}),null);
 // An appended result for a known call id is accepted, but an owner that cannot
 // be tied to the call's window still falls back to the Host (no capsule).
 assert.equal(nodeFor(stateFor({...result(),owner:'other'})),null);
 assert.equal(def.match({type:'tool/result',seq:9,data:{message:{source:{callId:'unrelated-call'},isError:false,content:[{type:'text',text:'message delivered to agent C'}]}}}),null,'a result for a call this definition never saw is ignored');
 assert.equal(nodeFor(stateFor(result('message delivered to agent OTHER'))),null);
 const state=stateFor();state.call.args=JSON.stringify({agent_id:'unrelated',message:'x'});assert.equal(nodeFor(state),null);
 // A send to a session that is not this definition's direct child stays native.
 assert.equal(def.match({type:'tool/call',seq:7,data:{callId:'call-2',name:'send_message',arguments:JSON.stringify({agent_id:'X',message:'m'})}}),null);
 assert.equal(def.match({type:'tool/call',seq:7,data:{callId:'call-3',name:'session_link_send',arguments:'{}'}}),null);
});
