// Render-level contract for the 2026-11-06 "no timeline fragments" rule: mechanism
// rows keep an anchor but draw nothing, while rows carrying real user-visible
// information (terminal failures, token-limit stops) still reach the native renderer.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {build} from 'esbuild';
const output=await build({entryPoints:['src/client/native-flow.jsx'],bundle:true,write:false,format:'cjs',platform:'browser',external:['react','@deepseek-ai/*'],logLevel:'silent'});
const mod={exports:{}};
// Native renderer stand-in: records which kinds it was asked to draw.
const drawn=[];
function NativeFlow({entries}){for(const entry of entries)drawn.push(entry.key);return null;}
new Function('require','module','exports',output.outputFiles[0].text)(name=>name==='react'?React:null,mod,mod.exports);

const closed={turn:7,status:'closed',start:{time:1000},end:{time:21000},steps:[]};
const nodes=new Map([
 ['retry',{kind:'model-retry',location:{kind:'turn',turn:closed},data:{turn:7}}],
 ['tail',{kind:'turn-tail',location:{kind:'turn',turn:closed},data:{turn:7}}],
 ['trigger',{kind:'turn-trigger',location:{kind:'turn',turn:closed},data:{turn:7}}],
 ['error',{kind:'turn-error',location:{kind:'turn',turn:closed},data:{turn:7,failure:{message:'boom',code:'E1'}}}],
 ['maxtok',{kind:'turn-max-tokens',location:{kind:'turn',turn:closed},data:{turn:7}}],
 ['compact',{kind:'manual-compaction',location:{kind:'turn',turn:closed},data:{turn:7}}],
]);
const base={sessionId:'self',pendingInputs:[],lastInputTurn:7,useChat:fn=>fn({nodes}),useSessions:fn=>fn({byId:{self:{title:'助手'}}}),useChatNode:(key,fn=x=>x)=>fn(nodes.get(key)),useChatGroup:(key,fn=x=>x)=>fn(undefined),usePresentation:fn=>fn({foldCompletedTurns:true,stepGrouping:'collapsed'}),NativeFlow};
function mount(element){const ref0=React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher,prior=ref0.current;
 const slots=[];let cursor=0;
 ref0.current={useState(v){const at=cursor++;if(!(at in slots))slots[at]=typeof v==='function'?v():v;return[slots[at],next=>{slots[at]=typeof next==='function'?next(slots[at]):next;}];},useSyncExternalStore:(_s,get)=>{cursor++;return get();},useRef(v){const at=cursor++;if(!(at in slots))slots[at]={current:v};return slots[at];},useMemo(f){cursor++;return f();},useCallback(f){cursor++;return f;},useEffect(){cursor++;},useLayoutEffect(){cursor++;}};
 const walk=value=>{if(value==null||typeof value==='boolean')return null;if(Array.isArray(value))return value.map(walk).filter(Boolean);if(typeof value==='string'||typeof value==='number')return value;if(typeof value.type==='function')return walk(value.type(value.props));if(value.type===React.Fragment)return walk(value.props.children);return {type:value.type,props:value.props,children:walk(value.props.children)};};
 try{return walk(element);}finally{ref0.current=prior;}}

test('mechanism rows draw nothing while remaining resolvable',()=>{
 drawn.length=0;
 const entries=['retry','tail','trigger'].map(key=>({kind:'node',key}));
 mount(React.createElement(mod.exports.NativeFlowAdapter,{...base,entries}));
 assert.deepEqual(drawn,[],'model-retry / turn-tail / turn-trigger must not reach the renderer');
});

test('terminal failure and token-limit rows still reach the renderer',()=>{
 drawn.length=0;
 const entries=['error','maxtok','compact'].map(key=>({kind:'node',key}));
 mount(React.createElement(mod.exports.NativeFlowAdapter,{...base,entries}));
 assert.deepEqual(drawn.sort(),['compact','error','maxtok'],'real information must never be swallowed');
});
