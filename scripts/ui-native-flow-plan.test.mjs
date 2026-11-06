import test from 'node:test';
import assert from 'node:assert/strict';
import { planNativeFlow, processNeedsInput } from '../src/client/native-flow-plan.mjs';
const node=(kind,turn,extra={})=>({kind,location:{kind:'turn',turn:{turn}},...extra});
const entry=key=>({kind:'node',key});
const group=(key,turn)=>({kind:'group',key,slFlowTurn:turn});
const response=key=>({kind:'node',key,groupPart:'response'});
const store=new Map([['c1',node('turn-process',1)],['user',node('user',1)],['answer',node('assistant-step',1)],['steer',node('steering',1)],['retry',node('model-retry',1)],['c2',node('turn-process',2)],['a2',node('assistant-step',2)]]);

test('native process immediately preceding answer shares one ordered surface',()=>{
 const rows=[entry('user'),entry('c1'),group('g1',1),response('answer'),entry('retry')];
 const plan=planNativeFlow(rows,store);
 assert.deepEqual(plan.map(p=>p.kind),['native','message','native']);
 assert.deepEqual(plan[1],{kind:'message',turn:1,groups:[rows[2]],response:rows[3],control:rows[1],first:true,last:true});
});
test('never move a process across steering, retry or a different Turn',()=>{
 const rows=[entry('c1'),group('g1',1),entry('steer'),group('g2',1),entry('retry'),response('answer'),entry('c2'),group('g3',2),response('a2')];
 const plan=planNativeFlow(rows,store);
 assert.deepEqual(plan.map(p=>p.kind),['message','native','message','native','message','message']);
 assert.equal(plan[0].response,null);assert.equal(plan[2].response,null);assert.equal(plan[4].response.key,'answer');assert.equal(plan[5].response.key,'a2');
 assert.deepEqual(plan.flatMap(p=>p.kind==='native'?p.entries.map(x=>x.key):p.kind==='control'?[p.entry.key]:[...p.groups.map(x=>x.key),...(p.response?[p.response.key]:[])]),['g1','steer','g2','retry','answer','g3','a2']);
});
test('a pending question stays discoverable without any process rendering',()=>{
 assert.equal(processNeedsInput({kind:'tool-call',data:{root:{phase:'start',name:'ask_user_question'}}}),true);
 assert.equal(processNeedsInput({kind:'tool-call',data:{root:{phase:'start',name:'exit_plan_mode'}}}),true);
 assert.equal(processNeedsInput({kind:'tool-call',data:{root:{kind:'tool-result',isError:false,name:'ask_user_question'}}}),false);
 assert.equal(processNeedsInput({kind:'tool-call',data:{root:{kind:'tool-result',isError:true,error:{code:'EACCES'}}}}),false);
 assert.equal(processNeedsInput({kind:'assistant-step',data:{}}),false);
});
test('standalone native reasoning remains in the same process bubble',()=>{
 const rows=[entry('c1'),{kind:'node',key:'answer',groupPart:'reasoning'},response('answer')];
 const plan=planNativeFlow(rows,store);
 assert.equal(plan.length,1);assert.equal(plan[0].groups[0].groupPart,'reasoning');assert.equal(plan[0].response.groupPart,'response');
});
test('unknown groups remain native and empty opening turn retains its control',()=>{
 const rows=[entry('c1'),{kind:'group',key:'third-party'}];const plan=planNativeFlow(rows,store);
 assert.deepEqual(plan.map(p=>p.kind),['control','native']);assert.equal(plan[1].entries[0].key,'third-party');
});
