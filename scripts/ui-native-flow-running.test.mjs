// Regression: a running turn must keep its bubble. The 0.6.0 bodyless rule for a
// finished text-less turn was also firing mid-turn, so the bubble (and the thinking
// dots inside it) vanished as soon as a process segment arrived.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {build} from 'esbuild';
const output=await build({entryPoints:['src/client/native-flow.jsx'],bundle:true,write:false,format:'cjs',platform:'browser',external:['react','@deepseek-ai/*'],logLevel:'silent'});
const mod={exports:{}};new Function('require','module','exports',output.outputFiles[0].text)(name=>name==='react'?React:{MarkdownText:()=>null},mod,mod.exports);

const open={turn:7,status:'open',start:{time:Date.now()-5000},steps:[]};
const mk=(kind,extra={})=>({kind,location:{kind:'turn',turn:open},data:{turn:7,...extra}});
const nodes=new Map([
 ['ctrl',mk('turn-process',{toolCallCount:2})],
 ['g1',mk('assistant-step',{blocks:[]})],
]);
const groups={ga:{data:{turn:7},members:[{kind:'node',key:'g1'}]}};
const base={sessionId:'self',pendingInputs:[],lastInputTurn:7,useChat:fn=>fn({nodes}),useSessions:fn=>fn({byId:{self:{title:'助手'}}}),useChatNode:(key,fn=x=>x)=>fn(nodes.get(key)),useChatGroup:(key,fn=x=>x)=>fn(groups[key]),usePresentation:fn=>fn({foldCompletedTurns:true,stepGrouping:'collapsed'}),NativeFlow:()=>null};
function mount(element){
 const ref0=React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher,prior=ref0.current;
 const slots=[];let cursor=0;
 ref0.current={useState(v){const at=cursor++;if(!(at in slots))slots[at]=typeof v==='function'?v():v;return[slots[at],next=>{slots[at]=typeof next==='function'?next(slots[at]):next;}];},useSyncExternalStore:(_s,get)=>{cursor++;return get();},useRef(v){const at=cursor++;if(!(at in slots))slots[at]={current:v};return slots[at];},useMemo(f){cursor++;return f();},useCallback(f){cursor++;return f;},useEffect(){cursor++;},useLayoutEffect(){cursor++;}};
 const walk=value=>{if(value==null||typeof value==='boolean')return null;if(Array.isArray(value))return value.map(walk).filter(Boolean);if(typeof value==='string'||typeof value==='number')return value;if(typeof value.type==='function')return walk(value.type(value.props));if(value.type===React.Fragment)return walk(value.props.children);return {type:value.type,props:value.props,children:walk(value.props.children)};};
 try{return walk(element);}finally{ref0.current=prior;}}
const flatten=(v,out=[])=>{if(!v||typeof v!=='object')return out;if(Array.isArray(v)){v.forEach(x=>flatten(x,out));return out;}out.push(v);flatten(v.children,out);return out;};
const text=v=>{if(v==null)return'';if(typeof v==='string'||typeof v==='number')return String(v);if(Array.isArray(v))return v.map(text).join('');return text(v.children);};

test('a running turn without text still shows its bubble and thinking dots',()=>{
 const tree=mount(React.createElement(mod.exports.NativeFlowAdapter,{...base,entries:[{kind:'node',key:'ctrl'},{kind:'group',key:'ga',slFlowTurn:7}]}));
 const all=flatten(tree);
 const bubble=all.find(node=>node.props?.['data-sl-bubble']!==undefined);
 assert.ok(bubble,'the running bubble must exist, not just its heading');
 assert.ok(!all.some(node=>node.props?.['data-sl-bodyless']!==undefined),'a running turn must NOT be bodyless');
 const dots=all.find(node=>String(node.props?.className||'').includes('sl-chat-thinking-dots'));
 assert.ok(dots,'the thinking dots must stay visible while the turn runs');
 // The dots are the "working" signal; the line above reports only elapsed time
 // and the real counts, so it must not repeat the word 思考中.
 assert.doesNotMatch(text(tree),/思考中/);
 assert.match(text(tree),/\d+ 秒/);
});

test('a finished turn that produced no text keeps a bodyless statistics line',()=>{
 const closed={turn:7,status:'closed',start:{time:1000},end:{time:21000},steps:[]};
 const closedNodes=new Map([['ctrl',{kind:'turn-process',location:{kind:'turn',turn:closed},data:{turn:7,toolCallCount:1}}]]);
 const tree=mount(React.createElement(mod.exports.NativeFlowAdapter,{...base,useChat:fn=>fn({nodes:closedNodes}),useChatNode:(key,fn=x=>x)=>fn(closedNodes.get(key)),entries:[{kind:'node',key:'ctrl'}]}));
 const all=flatten(tree);
 assert.ok(!all.some(node=>node.props?.['data-sl-bubble']!==undefined),'no empty bubble shell for a text-less finished turn');
 assert.match(text(tree),/耗时 20 秒/);
});
