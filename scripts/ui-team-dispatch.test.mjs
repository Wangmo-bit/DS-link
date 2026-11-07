// Team dispatch accounting uses only the Host's projected ToolChatData and
// roster facts. All examples are synthetic; no user message or log is copied.
import test from 'node:test';
import assert from 'node:assert/strict';
import {teamDispatchSignature, teamRosterSignature, agentsByTurn} from '../src/client/native-flow-plan.mjs';

// rc.5 ToolResultNode: args is a PartialArguments view, not a plain object;
// content is an array of ContentBlocks and call records the paired call head.
function args(fields = {}) {
  return {text(key) {
    assert.notEqual(key, 'message', 'message bodies must never be read for attribution');
    return fields[key];
  }};
}
function result(target, overrides = {}) {
  return {
    kind:'tool-result', seq:10, time:110, callId:'call-1', name:'send_message',
    args:args({target}), call:{name:'send_message',argsRaw:JSON.stringify({target})}, callTime:100,
    content:[{type:'text',text:'{"sent":true}'}], isError:false, subCalls:[],
    ...overrides,
  };
}
const row = root => ({root});
const parse = rows => JSON.parse(teamDispatchSignature(rows)).map(([name])=>name);
const windows = [{turn:1,from:100,to:199},{turn:2,from:200,to:299}];
const roster = [
  {id:'lead-id',name:'lead',role:'lead',phase:'active'},
  {id:'alpha-id',name:'alpha',role:'teammate',phase:'active'},
  {id:'beta-id',name:'beta',role:'teammate',phase:'active'},
  {id:'pending-id',name:'pending',role:'teammate',phase:'provisioning'},
  {id:'failed-id',name:'failed',role:'teammate',phase:'failed'},
];
const sorted = rows => [...rows].sort((a,b)=>a.label.localeCompare(b.label));

test('signature counts successful results once, sorted, including nested tool results', () => {
  const parent = result(undefined, {
    name:'wrapper', call:{name:'wrapper',argsRaw:'{}'}, args:args(),
    subCalls:[result('beta'), result('alpha'), result('beta')],
  });
  const inputs = [row(result('beta')),row(parent),row(result('alpha')),
    row(result('gamma',{content:[{type:'text',text:'unrelated'}, {type:'text',text:'{"sent":true}'}]}))];
  assert.deepEqual(parse(inputs), ['alpha','beta','gamma']);
  assert.equal(teamDispatchSignature(inputs), JSON.stringify([['alpha',100],['beta',100],['gamma',100]]));
  assert.equal(teamDispatchSignature([...inputs].reverse()), teamDispatchSignature(inputs));
  assert.deepEqual(parse([]), []);
});

test('the signature preserves the earliest known accepted send time per teammate', () => {
  const rows=[row(result('alpha',{callTime:210})),row(result('alpha',{callTime:240})),row(result('alpha',{callTime:null})),row(result('beta',{callTime:null}))];
  assert.deepEqual(JSON.parse(teamDispatchSignature(rows)),[['alpha',210],['beta',null]]);
  assert.equal(teamDispatchSignature(rows),teamDispatchSignature([...rows].reverse()));
  const mapped=agentsByTurn([],windows,roster,new Map([[2,JSON.parse(teamDispatchSignature(rows))]]));
  assert.deepEqual(sorted(mapped.get(2)),[
    {label:'alpha',ids:['alpha-id'],count:1,sentIds:['alpha-id'],sentTimes:[['alpha-id',210]]},
    {label:'beta',ids:['beta-id'],count:1,sentIds:['beta-id']},
  ]);
});

test('only a complete, unambiguously successful send_message target is counted', () => {
  const invalid = [
    result('errored',{isError:true}),
    result('missing-error-flag',{isError:undefined}),
    result('not-sent',{content:[{type:'text',text:'{"sent":false}'}]}),
    result('truthy',{content:[{type:'text',text:'{"sent":"true"}'}]}),
    result('invalid-json',{content:[{type:'text',text:'sent: true'}]}),
    result('no-result',{content:[]}),
    result('image-only',{content:[{type:'image',text:'{"sent":true}'}]}),
    result('other-tool',{name:'not_send_message',call:{name:'not_send_message',argsRaw:'{}'}}),
    result(undefined,{args:args({agent_id:'ordinary-agent'})}),
    result(undefined,{args:args({messageId:'ordinary-message'})}),
    result('',{args:args({target:''})}),
    result('no-head',{call:null}), // forged args cannot replace a missing paired call
    result('mismatched-head',{call:{name:'other',argsRaw:'{}'}}),
    result('blank',{args:args({target:'   '})}),
    {phase:'preparing', name:'send_message', args:args({target:'preparing'}), subCalls:[]},
    {phase:'start', name:'send_message', args:args({target:'started'}), subCalls:[]},
    null, {},
  ];
  assert.deepEqual(parse(invalid.map(row)), []);
});

test('message body, result prose and unrelated structured content cannot impersonate dispatch', () => {
  const fakeArgs = {text(key) {
    if (key === 'message') throw new Error('message was read');
    if (key === 'target') return undefined;
    return undefined;
  }};
  const rows = [
    row(result(undefined,{args:fakeArgs, message:'target=alpha {"sent":true}'})),
    row(result('alpha',{content:[{type:'text',text:'A message mentioned {"sent":true} in prose.'}]})),
    row(result('beta',{content:[{type:'text',text:'{"message":"{\\"sent\\":true}"}'}]})),
  ];
  assert.deepEqual(parse(rows), []);
});

test('nested result is found even when its parent is still running or fails', () => {
  const parent = {phase:'start',name:'wrapper',args:args(),subCalls:[
    result('alpha'),
    result('ignored',{isError:true,subCalls:[result('beta')]}),
  ]};
  assert.deepEqual(parse([row(parent)]), ['alpha','beta']);
});

test('existing catalog-only attribution stays unchanged without team facts', () => {
  const catalog = [
    {id:'ordinary-1',label:'worker',createdAt:120},
    {id:'ordinary-2',label:'worker',createdAt:130},
    {id:'other',label:'other',createdAt:230},
  ];
  const actual=agentsByTurn(catalog,windows);
  assert.deepEqual(actual.get(1),[{label:'worker',ids:['ordinary-1','ordinary-2'],count:1}]);
  assert.deepEqual(actual.get(2),[{label:'other',ids:['other'],count:1}]);
});

test('roster target joins by name, deduplicates repeated sends and ignores lead and unknown names', () => {
  const targets=new Map([[1,['beta','alpha','alpha','lead','missing','pending','failed']]]);
  const actual=agentsByTurn([],windows,roster,targets);
  assert.deepEqual(sorted(actual.get(1)),[
    {label:'alpha',ids:['alpha-id'],count:1,sentIds:['alpha-id']},
    {label:'beta',ids:['beta-id'],count:1,sentIds:['beta-id']},
  ]);
  assert.equal(actual.has(2),false);
});

test('new teammate and same-turn sends merge by member id, without duplicate counts', () => {
  const catalog=[{id:'alpha-id',label:'alpha',createdAt:120}, {id:'normal-id',label:'normal',createdAt:130}];
  const actual=agentsByTurn(catalog,windows,roster,new Map([[1,['alpha','alpha']]]));
  assert.deepEqual(sorted(actual.get(1)),[
    {label:'alpha',ids:['alpha-id'],count:1,sentIds:['alpha-id']},
    {label:'normal',ids:['normal-id'],count:1},
  ]);
});

test('a catalog entry joins its roster member by id even when its label differs', () => {
  const catalog=[{id:'alpha-id',label:'display alias',createdAt:120}];
  const actual=agentsByTurn(catalog,windows,roster,new Map([[1,['alpha']]]));
  assert.deepEqual(actual.get(1),[{label:'alpha',ids:['alpha-id'],count:1,sentIds:['alpha-id']}]);
});

test('same roster member can be reused in multiple loaded turns independently', () => {
  const actual=agentsByTurn([],windows,roster,new Map([[1,['alpha']],[2,['alpha','beta']],[99,['beta']]]));
  assert.deepEqual(actual.get(1),[{label:'alpha',ids:['alpha-id'],count:1,sentIds:['alpha-id']}]);
  assert.deepEqual(sorted(actual.get(2)),[
    {label:'alpha',ids:['alpha-id'],count:1,sentIds:['alpha-id']},
    {label:'beta',ids:['beta-id'],count:1,sentIds:['beta-id']},
  ]);
  assert.equal(actual.has(99),false,'unloaded turn is never invented');
});

test('an absent or unloaded roster cannot turn message targets into agents', () => {
  const targets=new Map([[1,['alpha']]]);
  for (const members of [undefined,null,[]]) {
    assert.equal(agentsByTurn([],windows,members,targets).size,0);
  }
  assert.equal(agentsByTurn([],[],roster,targets).size,0);
});

test('roster selector keeps only active teammates and includes live timing facts', () => {
  const snapshot={
    byId:{'alpha-id':{running:true,projectionValues:{subagentTiming:{active:{since:210,through:220}}}},'beta-id':{running:false,projectionValues:{subagentTiming:{lastTurnCompleted:true},turnOutline:[{turn:1}]}}},
    projectionsBySession:{root:{values:{agentTeam:{members:roster}}}},
  };
  assert.deepEqual(JSON.parse(teamRosterSignature(snapshot,'root')), [
    ['alpha-id','alpha','teammate','active',true,'',210,null],
    ['beta-id','beta','teammate','active',false,'c',null,1],
  ]);
  assert.equal(teamRosterSignature(snapshot,'missing'),'');
  const next={...snapshot,byId:{...snapshot.byId,'alpha-id':{running:true,projectionValues:{subagentTiming:{active:{since:250,through:260}}}}}};
  assert.notEqual(teamRosterSignature(snapshot,'root'),teamRosterSignature(next,'root'),'a newer activation must refresh historical status');
  const reused={...snapshot,byId:{...snapshot.byId,'beta-id':{running:false,projectionValues:{subagentTiming:{lastTurnCompleted:true},turnOutline:[{turn:1},{turn:2}]}}}};
  assert.notEqual(teamRosterSignature(snapshot,'root'),teamRosterSignature(reused,'root'),'a later child turn must invalidate old completion evidence');
});

test('a verified teammate reads its lead roster; ordinary children do not inherit it', () => {
  const snapshot={
    byId:{'alpha-id':{parentId:'root'},ordinary:{parentId:'root'}},
    projectionsBySession:{
      root:{values:{agentTeam:{members:roster}}},
      'alpha-id':{values:{agentTeam:{members:[{id:'alpha-id',name:'lead',role:'lead',phase:'active'}]}}},
      ordinary:{values:{agentTeam:{members:[{id:'ordinary',name:'lead',role:'lead',phase:'active'}]}}},
    },
  };
  assert.deepEqual(JSON.parse(teamRosterSignature(snapshot,'alpha-id')).map(row=>row[1]),['alpha','beta']);
  assert.deepEqual(JSON.parse(teamRosterSignature(snapshot,'ordinary')),[]);
});
