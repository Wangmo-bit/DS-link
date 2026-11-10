import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapsuleGroupStore } from '../src/client/capsule-group-store.mjs';
import { groupCapsules } from '../src/client/capsule-grouping.mjs';
import { capsuleStatusKey } from '../src/client/capsule-status.mjs';
const row = {status:'accepted', dispatchStatus:'accepted', replyStatus:'none', receipt:{policy:'context',state:'received'}};
const state = capsuleStatusKey(row,{asOf:1,stale:false});
const sent = seq => ({kind:'sent',seq,time:seq*1000});
const meta = {target:'peer',kind:'notification',status:state,turn:4,multiTarget:false};

test('status keys distinguish context, reply and freshness without including query timestamps',()=>{
  assert.equal(state,capsuleStatusKey(row,{asOf:100,stale:false}));
  assert.notEqual(state,capsuleStatusKey({...row,receipt:{policy:'context',state:'queued'}},{asOf:1}));
  assert.notEqual(state,capsuleStatusKey({...row,replyStatus:'answered'},{asOf:1}));
  assert.notEqual(state,capsuleStatusKey(row,{asOf:1,stale:true}));
  assert.notEqual(state,capsuleStatusKey(row,{asOf:null}));
});

test('sent meta mounts batch once and unchanged values do not publish again',async()=>{
  const store=createCapsuleGroupStore();
  store.setItems('self',[sent(1),sent(2),sent(3)]);
  let calls=0;store.subscribe(()=>calls++);
  for(const seq of [1,2,3])store.setSentMeta('self',seq,{...meta});
  await Promise.resolve();
  assert.equal(calls,1);
  assert.deepEqual(store.info(store.getSnapshot(),'self',1),{head:true,count:3});
  const snap=store.getSnapshot();
  for(const seq of [1,2,3])store.setSentMeta('self',seq,{...meta});
  store.setItems('self',[sent(1),sent(2),sent(3)]);
  await Promise.resolve();
  assert.equal(calls,1);assert.equal(store.getSnapshot(),snap);
});

test('new window generation revokes metadata; removed entries do not rejoin on prepend',async()=>{
  const store=createCapsuleGroupStore();
  store.setItems('self',[sent(1),sent(2)]);
  store.setSentMeta('self',1,meta);store.setSentMeta('self',2,meta);
  await Promise.resolve();
  const oldGeneration=store.generationOf(store.getSnapshot(),'self');
  store.removeSession('self');
  store.setItems('self',[sent(1),sent(2)]);
  assert.equal(store.generationOf(store.getSnapshot(),'self'),oldGeneration+1);
  assert.deepEqual(store.info(store.getSnapshot(),'self',1),{head:true,count:1});
  store.setSentMeta('self',1,meta);store.setSentMeta('self',2,meta);
  await Promise.resolve();
  store.setItems('self',[sent(2)]);store.setItems('self',[sent(1),sent(2)]);
  assert.deepEqual(store.info(store.getSnapshot(),'self',1),{head:true,count:1});
  store.dispose();
  store.setSentMeta('self',1,meta);await Promise.resolve();
  assert.equal(store.getSnapshot().sessions.size,0);
});

test('unknown turns, peers, kinds, statuses and negative/nonfinite times never join',()=>{
  const base={kind:'received',seq:1,time:1000,turn:1,sender:'peer',messageKind:'notification',status:state};
  for(const extra of [{turn:null},{turn:undefined},{sender:''},{messageKind:''},{status:null},{time:NaN}]) {
    const groups=groupCapsules([{...base,...extra},{...base,...extra,seq:2}]);
    assert.deepEqual(groups.get(1),{head:true,count:1});
    assert.deepEqual(groups.get(2),{head:true,count:1});
  }
  const groups=groupCapsules([base,{...base,seq:2,time:999}]);
  assert.deepEqual(groups.get(1),{head:true,count:1});
  assert.deepEqual(groups.get(2),{head:true,count:1});
  const unknown=new Map([[1,{...meta,turn:null}],[2,{...meta,turn:null}]]);
  assert.deepEqual([...groupCapsules([sent(1),sent(2)],{sentMeta:unknown}).values()],[{head:true,count:1},{head:true,count:1}]);
});
