import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { patchHostChat, submissionRoom, shouldEndSubmissionGuard } from './dsh-web-scroll-patch.mjs';
const original=process.env.DSH_CHAT_CLIENT ? await readFile(process.env.DSH_CHAT_CLIENT,'utf8') : null;
const patched=original === null ? null : patchHostChat(original);

test('version bound patch fails closed on any other Host bytes', {skip: !original && 'set DSH_CHAT_CLIENT to the rc.5 client artifact'}, () => {
  assert.throws(()=>patchHostChat(`${original}\n`),/Unsupported Web Chat artifact/);
  assert.equal(patched.includes('viewport.beginSubmissionGuard()'),true);
  assert.equal(patched.includes('this.reconcileSubmissionGuard()'),true);
});

test('reserve exactly the unmatched composer collapse and consume it with new content', () => {
  assert.equal(submissionRoom(1000,907,0),93);
  assert.equal(submissionRoom(1000,1030,93),63);
  assert.equal(submissionRoom(1000,1112,93),0);
  assert.equal(submissionRoom(1000,1100,0),0);
  assert.equal(submissionRoom(NaN,1000,0),0);
});

test('guard ends after rejected input or completed turn, not on durable admission', () => {
  assert.equal(shouldEndSubmissionGuard(null,{submissionId:null,lastKey:'old',running:false}),false);
  assert.equal(shouldEndSubmissionGuard({submissionId:'rpc',lastKey:'old',running:false},{submissionId:null,lastKey:'old',running:false}),true);
  assert.equal(shouldEndSubmissionGuard({submissionId:'rpc',lastKey:'old',running:false},{submissionId:null,lastKey:'new-user',running:false}),false);
  assert.equal(shouldEndSubmissionGuard({submissionId:null,lastKey:'new-user',running:true},{submissionId:null,lastKey:'answer',running:false}),true);
});

function fixture({floor=1000,spacer=0}={}) {
  const begin=patched.indexOf('spacerHeight() {');
  const end=patched.indexOf('/**\n\t\t\t* Connect the reading policy',begin);
  assert.ok(begin>0 && end>begin);
  const methods=patched.slice(begin,end);
  const geometry={naturalFloor:floor-spacer,spacer,viewport:629};
  const metrics=()=>({floor:geometry.naturalFloor+geometry.spacer,height:geometry.viewport,top:0});
  const Mock=new Function('submissionRoom','scrollMetrics',`return class { ${methods} }`)(submissionRoom,metrics);
  const value=new Mock();
  const spacerNode={style:{get height(){return geometry.spacer ? `${geometry.spacer}px` : '';},set height(value){geometry.spacer=Number.parseFloat(value)||0;}}};
  value.elements={scroller:{},spacer:spacerNode}; value.motion={foldActive:()=>false,inputActive:()=>false};
  value.submissionGuard=null;
  return {value,geometry};
}

test('Host guard keeps the visible anchor while composer shrinks and content grows', {skip: !patched && 'set DSH_CHAT_CLIENT to the rc.5 client artifact'}, () => {
  const {value,geometry}=fixture();
  value.beginSubmissionGuard(); assert.equal(geometry.spacer,0);
  geometry.naturalFloor-=93; value.reconcileSubmissionGuard();
  assert.equal(geometry.spacer,93);
  assert.equal(geometry.naturalFloor+geometry.spacer,1000);
  geometry.naturalFloor+=30; value.reconcileSubmissionGuard();
  assert.equal(geometry.spacer,63);
  assert.equal(geometry.naturalFloor+geometry.spacer,1000);
  geometry.naturalFloor+=82; value.reconcileSubmissionGuard();
  assert.equal(geometry.spacer,0); assert.equal(value.submissionGuard,null);
  assert.equal(geometry.naturalFloor+geometry.spacer,1019);
});

test('preserves preexisting fold room and does not reserve without a shrink', {skip: !patched && 'set DSH_CHAT_CLIENT to the rc.5 client artifact'}, () => {
  const f=fixture({spacer:80}); f.value.beginSubmissionGuard(); f.geometry.naturalFloor-=93; f.value.reconcileSubmissionGuard(); assert.equal(f.geometry.spacer,173);
  f.geometry.naturalFloor+=30; f.value.reconcileSubmissionGuard(); assert.equal(f.geometry.spacer,143);
  const idle=fixture(); idle.value.beginSubmissionGuard(); idle.value.reconcileSubmissionGuard(); assert.equal(idle.geometry.spacer,0);
});

test('a second pending submission retains existing reserved room', {skip: !patched && 'set DSH_CHAT_CLIENT to the rc.5 client artifact'}, () => {
  const f=fixture(); f.value.beginSubmissionGuard(); f.geometry.naturalFloor-=93; f.value.reconcileSubmissionGuard();
  assert.equal(f.geometry.spacer,93);
  f.value.beginSubmissionGuard(); f.value.reconcileSubmissionGuard();
  assert.equal(f.geometry.spacer,93); assert.equal(f.value.submissionGuard.room,93);
  f.geometry.naturalFloor+=40; f.value.reconcileSubmissionGuard(); assert.equal(f.geometry.spacer,53);
});

test('an active or scheduled native fold retains sole control of its spacer', {skip: !patched && 'set DSH_CHAT_CLIENT to the rc.5 client artifact'}, () => {
  const f=fixture(); f.value.motion={foldActive:()=>false,inputActive:()=>true}; f.value.beginSubmissionGuard();
  assert.equal(f.value.submissionGuard,null); assert.equal(f.geometry.spacer,0);
  const active=fixture(); active.value.beginSubmissionGuard(); active.geometry.naturalFloor-=93; active.value.reconcileSubmissionGuard();
  active.value.motion={foldActive:()=>true,inputActive:()=>true}; active.value.setSpacer(20);
  assert.equal(active.value.submissionGuard,null); assert.equal(active.geometry.spacer,20, 'native fold controls the full spacer');
});

test('viewport resize ends the guard without forcing a scroll write', {skip: !patched && 'set DSH_CHAT_CLIENT to the rc.5 client artifact'}, () => {
  const f=fixture(); f.value.beginSubmissionGuard(); f.geometry.naturalFloor-=93; f.value.reconcileSubmissionGuard();
  f.geometry.viewport+=50; f.value.reconcileSubmissionGuard();
  assert.equal(f.value.submissionGuard,null); assert.equal(f.geometry.spacer,93);
});

test('reader intent releases guard without immediately yanking the viewport', {skip: !patched && 'set DSH_CHAT_CLIENT to the rc.5 client artifact'}, () => {
  const {value,geometry}=fixture(); value.beginSubmissionGuard(); geometry.naturalFloor-=93; value.reconcileSubmissionGuard(); value.endSubmissionGuard();
  assert.equal(value.submissionGuard,null); assert.equal(geometry.spacer,93);
});
