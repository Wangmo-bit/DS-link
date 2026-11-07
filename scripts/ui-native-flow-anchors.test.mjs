import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {build} from 'esbuild';
const output=await build({entryPoints:['src/client/native-flow.jsx'],bundle:true,write:false,format:'cjs',platform:'browser',external:['react','@deepseek-ai/*'],logLevel:'silent'});
const mod={exports:{}};new Function('require','module','exports',output.outputFiles[0].text)(name=>name==='react'?React:{MarkdownText:()=>null},mod,mod.exports);
const turn={turn:7,status:'open',start:{time:1000},steps:[]};
const nodes=new Map([['ctrl',{kind:'turn-process',location:{kind:'turn',turn},data:{turn:7}}],['reason',{kind:'assistant-step',location:{kind:'turn',turn},data:{turn:7,blocks:[]}}],['answer',{kind:'assistant-step',location:{kind:'turn',turn},data:{turn:7,blocks:[]}}]]);
const groups={group:{data:{turn:7},members:[{key:'reason',groupPart:'reasoning'}]}};
const base={sessionId:'self',pendingInputs:[],lastInputTurn:7,useChat:fn=>fn({nodes}),useSessions:fn=>fn({byId:{self:{title:'助手'}}}),useChatNode:(key,fn=x=>x)=>fn(nodes.get(key)),useChatGroup:(key,fn=x=>x)=>fn(groups[key]),usePresentation:fn=>fn({foldCompletedTurns:true,stepGrouping:'collapsed'}),NativeFlow:()=>null};
function render(root){const ref=React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher,old=ref.current;
 ref.current={useState:v=>[typeof v==='function'?v():v,()=>{}],useSyncExternalStore:(_s,get)=>get(),useRef:v=>({current:v}),useMemo:f=>f(),useCallback:f=>f,useEffect:()=>{},useLayoutEffect:()=>{}};
 const walk=value=>{if(value==null||typeof value==='boolean')return null;if(Array.isArray(value))return value.map(walk).filter(Boolean);if(typeof value==='string'||typeof value==='number')return value;if(typeof value.type==='function')return walk(value.type(value.props));if(value.type===React.Fragment)return walk(value.props.children);return {type:value.type,props:value.props,children:walk(value.props.children)};};
 try{return walk(root);}finally{ref.current=old;}}
function flatten(value,hidden=false,out=[]){if(!value||typeof value!=='object')return out;if(Array.isArray(value)){for(const x of value)flatten(x,hidden,out);return out;}const next=hidden||value.props?.hidden===true;out.push({node:value,hidden:next});flatten(value.children,next,out);return out;}
// User decision 2026-11-06: bubble mode renders no process area at all, so the
// old "folded native group" contract is replaced by "no process container, but
// node identity stays reachable and the bubble still carries its own summary".
test('bubble mode keeps node and paging anchors without any process container',()=>{
 const tree=render(React.createElement(mod.exports.NativeFlowAdapter,{...base,entries:[{kind:'node',key:'ctrl'},{kind:'group',key:'group',slFlowTurn:7},{kind:'node',key:'answer',groupPart:'response'}]}));
 const all=flatten(tree),outer=all.find(x=>x.node.props?.['data-sl-native-message']!==undefined);
 assert.ok(outer);assert.equal(outer.node.props['data-chat-paging-anchor'],'');
 for(const key of ['ctrl','reason'])assert.ok(all.some(x=>!x.hidden&&x.node.props?.['data-chat-node-key']===key&&typeof x.node.props?.['data-chat-anchor-key']==='string'),`missing visible ${key} anchor`);
 assert.ok(!all.some(x=>x.node.props?.['data-sl-native-process']!==undefined),'no process container may be rendered');
 // The running turn still announces itself: the real elapsed clock plus dots,
 // without repeating the word the dots already convey.
 const text=JSON.stringify(tree);
 assert.match(text,/\d+ 秒/);
});
test('opening turn control retains node identity without becoming a paging anchor',()=>{
 const tree=render(React.createElement(mod.exports.NativeFlowAdapter,{...base,entries:[{kind:'node',key:'ctrl'}]}));const all=flatten(tree),row=all.find(x=>x.node.props?.['data-chat-flow-kind']==='turn-process');
 assert.ok(row);assert.equal(row.node.props['data-chat-node-key'],'ctrl');assert.equal(row.node.props['data-chat-paging-anchor'],undefined);
});
