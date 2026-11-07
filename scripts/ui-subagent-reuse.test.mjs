import test from 'node:test';
import assert from 'node:assert/strict';
import { subagentReuseSignature, agentsByTurn } from '../src/client/native-flow-plan.mjs';
const args = id => ({ text(key) { assert.notEqual(key, 'message', 'message body must not be read'); return key === 'agent_id' ? id : undefined; } });
const start = (id, name='ask_agent', time=210) => ({root:{phase:'start',name,time,args:args(id),subCalls:[]}});
const result = (id, options={}) => ({root:{kind:'tool-result',name:options.name??'ask_agent',call:{name:options.name??'ask_agent'},callTime:options.time??210,args:args(id),isError:options.error??false,content:options.content??[{type:'text',text:'reply'}],subCalls:[],...options.override}});
const parse = rows => JSON.parse(subagentReuseSignature(rows));
const windows=[{turn:1,from:100,to:199},{turn:2,from:200,to:299}];
const catalog=[{id:'old',label:'worker',mode:'continuable',createdAt:120},{id:'one-shot',label:'other',mode:'one-shot',createdAt:130}];

test('live exact-id follow-up is provisional; successful result is durable without reading replies',()=>{
  assert.deepEqual(parse([start('old')]),[['old',210,false]]);
  assert.deepEqual(parse([result('old')]),[['old',210,true]]);
  assert.deepEqual(parse([start('old'),result('old'),start('old','ask_agent',250)]),[['old',210,true]]);
  assert.deepEqual(parse([result('old',{error:true})]),[]);
  assert.deepEqual(parse([result('old',{override:{call:null}})]),[]);
});

test('only paired successful ordinary send receipts are accepted',()=>{
  const ok=result('old',{name:'send_message',content:[{type:'text',text:'message delivered to agent old'}]});
  assert.deepEqual(parse([ok]),[['old',210,true]]);
  assert.deepEqual(parse([result('old',{name:'send_message',content:[{type:'text',text:'message delivered to agent someone-else'}]})]),[]);
  assert.deepEqual(parse([result('old',{name:'send_message',content:[{type:'text',text:'{"sent":true}'}]})]),[]);
  assert.deepEqual(parse([{root:{phase:'preparing',name:'ask_agent',args:args('old'),subCalls:[]}}]),[]);
});

test('nested calls are found; plain named calls and parent messages cannot invent ids',()=>{
  const wrapped={root:{phase:'start',name:'wrapper',subCalls:[start('old').root]}};
  assert.deepEqual(parse([wrapped]),[['old',210,false]]);
  assert.deepEqual(parse([start(undefined),result(undefined)]),[]);
});

test('reuse is bound to the direct catalog and correct loaded turn',()=>{
  const targets=new Map([[2,[['old',210,true],['old',220,true],['foreign',210,true],['one-shot',210,false]]],[99,[['old',210,true]]]]);
  const actual=agentsByTurn(catalog,windows,[],new Map(),targets);
  assert.deepEqual(actual.get(2),[{label:'worker',ids:['old'],count:1,sentIds:['old'],sentTimes:[['old',210]]}]);
  assert.equal(actual.has(99),false);
});

test('a failed call is omitted, but an unknown result time still counts safely',()=>{
  const rows=[result('old',{error:true}),result('old',{override:{callTime:null}})];
  assert.deepEqual(parse(rows),[['old',null,true]]);
  const actual=agentsByTurn(catalog,windows,[],new Map(),new Map([[2,parse(rows)]]));
  assert.deepEqual(actual.get(2),[{label:'worker',ids:['old'],count:1,sentIds:['old']}]);
});
