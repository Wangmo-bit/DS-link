import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubagentSenderDefinition, SUBAGENT_SEND_KIND } from '../src/client/subagent-outgoing.mjs';
const address={parentSessionId:'P',childSessionId:'C',mode:'continuable'};
const sessions={subagentAddress:id=>id==='C'?address:undefined};
const scope={resolveResult:(event,id)=>event.owner==='P'&&id==='call-1'?'P':null};
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
test('unknown/forked/failed/mismatched source never claims a fabricated sender event',()=>{
 assert.equal(def.match({...result(),owner:'other'}),null);
 assert.equal(def.match({...result(),surfaceOp:{op:'replace'}}),null);
 const failed=result();failed.data.message.isError=true;assert.equal(def.match(failed),null);
 assert.equal(nodeFor(stateFor(result('message delivered to agent OTHER'))),null);
 const state=stateFor();state.call.args=JSON.stringify({agent_id:'unrelated',message:'x'});assert.equal(nodeFor(state),null);
});
