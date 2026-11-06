// Regression tests for the 2026-11-06 cold-review findings and the user's final
// call: group members are `{kind:'node', key}` (never `tool-call`), a pending
// user prompt must reach the turn even when its own segment is not drawn, and a
// recoverable tool failure must NOT be announced (it is noise once the answer
// lands).
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {build} from 'esbuild';
const output=await build({entryPoints:['src/client/native-flow.jsx'],bundle:true,write:false,format:'cjs',platform:'browser',external:['react','@deepseek-ai/*'],logLevel:'silent'});
const mod={exports:{}};new Function('require','module','exports',output.outputFiles[0].text)(name=>name==='react'?React:{MarkdownText:()=>null},mod,mod.exports);

const closed=(turn,extra={})=>({turn,status:'closed',start:{time:1000},end:{time:21000},steps:[],...extra});
const toolNode=(turn,root)=>({kind:'tool-call',location:{kind:'turn',turn:closed(turn)},data:{turn,root}});

// A finished turn: a text segment whose tool failed, then a later text segment.
const failing=toolNode(7,{kind:'tool-result',isError:true,error:{name:'ToolError',code:'EACCES'}});
const pending=toolNode(7,{phase:'start',name:'ask_user_question'});
const nodes=new Map([
 ['g1',{kind:'assistant-step',location:{kind:'turn',turn:closed(7)},data:{turn:7,blocks:[]}}],
 ['r1',{kind:'assistant-step',location:{kind:'turn',turn:closed(7)},data:{turn:7,blocks:[]}}],
 ['g2',{kind:'assistant-step',location:{kind:'turn',turn:closed(7)},data:{turn:7,blocks:[]}}],
 ['r2',{kind:'assistant-step',location:{kind:'turn',turn:closed(7)},data:{turn:7,blocks:[]}}],
 ['toolfail',failing],
 ['toolask',pending],
]);
// Members use the Host's real shape: kind 'node' + key.
const groups={
 ga:{data:{turn:7},members:[{kind:'node',key:'toolfail'},{kind:'node',key:'g1'}]},
 gb:{data:{turn:7},members:[{kind:'node',key:'toolask'},{kind:'node',key:'g2'}]},
};
const base={sessionId:'self',pendingInputs:[],lastInputTurn:7,useChat:fn=>fn({nodes}),useSessions:fn=>fn({byId:{self:{title:'助手'}}}),useChatNode:(key,fn=x=>x)=>fn(nodes.get(key)),useChatGroup:(key,fn=x=>x)=>fn(groups[key]),usePresentation:fn=>fn({foldCompletedTurns:true,stepGrouping:'collapsed'}),NativeFlow:()=>null};
// Minimal but real mount loop: state persists across renders and effects run
// until the tree settles, which is what these regressions need to be observable.
function mount(element, rounds=8){
 const ref0=React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
 const slots=[], effects=[];
 let cursor=0, dirty=false;
 const dispatcher={
  useState(initial){const at=cursor++;if(!(at in slots))slots[at]=typeof initial==='function'?initial():initial;
   return [slots[at],value=>{const next=typeof value==='function'?value(slots[at]):value;if(!Object.is(next,slots[at])){slots[at]=next;dirty=true;}}];},
  useRef(initial){const at=cursor++;if(!(at in slots))slots[at]={current:initial};return slots[at];},
  useSyncExternalStore(_subscribe,get){cursor++;return get();},
  useMemo(factory){cursor++;return factory();},
  useCallback(fn){cursor++;return fn;},
  useEffect(callback,deps){const at=cursor++;const previous=slots[at];
   if(previous&&deps&&previous.deps.length===deps.length&&deps.every((value,index)=>Object.is(value,previous.deps[index])))return;
   slots[at]={deps};effects.push(callback);},
  useLayoutEffect(){cursor++;},
 };
 const prior=ref0.current;
 const walk=value=>{if(value==null||typeof value==='boolean')return null;if(Array.isArray(value))return value.map(walk).filter(Boolean);if(typeof value==='string'||typeof value==='number')return value;if(typeof value.type==='function')return walk(value.type(value.props));if(value.type===React.Fragment)return walk(value.props.children);return {type:value.type,props:value.props,children:walk(value.props.children)};};
 try{
  let tree=null;
  for(let round=0;round<rounds;round++){
   cursor=0;dirty=false;effects.length=0;
   ref0.current=dispatcher;
   tree=walk(element);
   for(const effect of effects.splice(0))effect();
   if(!dirty)break;
  }
  return tree;
 }finally{ref0.current=prior;}
}
const text=v=>{if(v==null)return'';if(typeof v==='string'||typeof v==='number')return String(v);if(Array.isArray(v))return v.map(text).join('');return text(v.children);};

test('host-shaped group members ({kind:"node"}) still reach a pending question',()=>{
 // If the old `member.kind === 'tool-call'` filter were back, no probe would mount
 // and the pending-action line could never appear.
 const tree=mount(React.createElement(mod.exports.NativeFlowAdapter,{...base,entries:[{kind:'group',key:'ga',slFlowTurn:7},{kind:'node',key:'r1',groupPart:'response'},{kind:'group',key:'gb',slFlowTurn:7},{kind:'node',key:'r2',groupPart:'response'}]}));
 const rendered=text(tree);
 assert.match(rendered,/有需要你操作的事项/,'a pending question must stay discoverable');
 assert.doesNotMatch(rendered,/EACCES|工具失败/,'a recovered tool failure must stay silent');
});

test('a pending prompt is announced once per turn, not once per bubble',()=>{
 const tree=mount(React.createElement(mod.exports.NativeFlowAdapter,{...base,entries:[{kind:'group',key:'ga',slFlowTurn:7},{kind:'node',key:'r1',groupPart:'response'},{kind:'group',key:'gb',slFlowTurn:7},{kind:'node',key:'r2',groupPart:'response'}]}));
 const rendered=text(tree);
 assert.equal(rendered.split('有需要你操作的事项').length-1,1,'the pending-action line appears once');
});
