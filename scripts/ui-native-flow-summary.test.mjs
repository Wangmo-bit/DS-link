import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {build} from 'esbuild';
const output=await build({entryPoints:['src/client/native-flow.jsx'],bundle:true,write:false,format:'cjs',platform:'browser',external:['react','@deepseek-ai/*'],logLevel:'silent'});
const mod={exports:{}};new Function('require','module','exports',output.outputFiles[0].text)(name=>name==='react'?React:{MarkdownText:()=>null},mod,mod.exports);
// One turn with TWO process segments, each with its own response, plus one
// trailing segment that has neither text nor a response.
const closed={turn:7,status:'closed',start:{time:1000},end:{time:21000},steps:[]};
const nodes=new Map([
 ['c1',{kind:'turn-process',location:{kind:'turn',turn:closed},data:{turn:7,toolCallCount:2}}],
 ['g1',{kind:'assistant-step',location:{kind:'turn',turn:closed},data:{turn:7,blocks:[]}}],
 ['r1',{kind:'assistant-step',location:{kind:'turn',turn:closed},data:{turn:7,blocks:[]}}],
 ['g2',{kind:'assistant-step',location:{kind:'turn',turn:closed},data:{turn:7,blocks:[]}}],
 ['r2',{kind:'assistant-step',location:{kind:'turn',turn:closed},data:{turn:7,blocks:[]}}],
]);
const groups={ga:{data:{turn:7},members:[{key:'g1'}]},gb:{data:{turn:7},members:[{key:'g2'}]}};
const base={sessionId:'self',pendingInputs:[],lastInputTurn:7,useChat:fn=>fn({nodes}),useSessions:fn=>fn({byId:{self:{title:'助手'}}}),useChatNode:(key,fn=x=>x)=>fn(nodes.get(key)),useChatGroup:(key,fn=x=>x)=>fn(groups[key]),usePresentation:fn=>fn({foldCompletedTurns:true,stepGrouping:'collapsed'}),NativeFlow:()=>null};
function render(root){const ref=React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher,old=ref.current;
 ref.current={useState:v=>[typeof v==='function'?v():v,()=>{}],useSyncExternalStore:(_s,get)=>get(),useRef:v=>({current:v}),useMemo:f=>f(),useCallback:f=>f,useEffect:()=>{},useLayoutEffect:()=>{}};
 const walk=value=>{if(value==null||typeof value==='boolean')return null;if(Array.isArray(value))return value.map(walk).filter(Boolean);if(typeof value==='string'||typeof value==='number')return value;if(typeof value.type==='function')return walk(value.type(value.props));if(value.type===React.Fragment)return walk(value.props.children);return {type:value.type,props:value.props,children:walk(value.props.children)};};
 try{return walk(root);}finally{ref.current=old;}}
const text=v=>{if(v==null)return'';if(typeof v==='string'||typeof v==='number')return String(v);if(Array.isArray(v))return v.map(text).join('');return text(v.children);};
test('a turn with several text segments shows one bubble per utterance and one summary total',()=>{
 const tree=render(React.createElement(mod.exports.NativeFlowAdapter,{...base,entries:[{kind:'node',key:'c1'},{kind:'group',key:'ga',slFlowTurn:7},{kind:'node',key:'r1',groupPart:'response'},{kind:'group',key:'gb',slFlowTurn:7},{kind:'node',key:'r2',groupPart:'response'}]}));
 const flat=[];const walk=v=>{if(!v||typeof v!=='object')return;if(Array.isArray(v)){v.forEach(walk);return;}flat.push(v);walk(v.children);};walk(tree);
 const bubbles=flat.filter(x=>x.props?.['data-sl-native-message']!==undefined);
 assert.equal(bubbles.length,2,'one bubble per text segment');
 const rendered=text(tree);
 assert.equal(rendered.split('耗时 20 秒').length-1,1,'the turn total appears exactly once in the rendered output');
});
test('native bubble response receives a display-only currency view, not a replacement native component',()=>{
 const previous=nodes.get('r1');
 const source='你的 $60 是 **额度**，不是无限。估计 $0.30/M。';
 const node={kind:'assistant-step',key:'r1',location:{kind:'turn',turn:closed},data:{turn:7,status:'settled',blocks:[{kind:'text',text:source}]}};
 nodes.set('r1',node);
 const received=[];
 try {
  const NativeFlow=props=>{if(props.entries?.some(e=>e.key==='r1'))received.push({node:props.useChatNode('r1'),selected:props.useChatNode('r1', n=>n.data.blocks[0].text),props});return null;};
  render(React.createElement(mod.exports.NativeFlowAdapter,{...base,NativeFlow,entries:[{kind:'node',key:'c1'},{kind:'group',key:'ga',slFlowTurn:7},{kind:'node',key:'r1',groupPart:'response'}]}));
  assert.equal(received.length,1);
  assert.equal(received[0].node.data.blocks[0].text,'你的 \\$60 是 **额度**，不是无限。估计 $0.30/M。');
  assert.equal(received[0].node.key,node.key);
  assert.equal(node.data.blocks[0].text,source,'original source remains unchanged');
  assert.equal(received[0].selected,source,'selector-based access remains unmodified');
 } finally {nodes.set('r1',previous);}
});

test('a turn that ends without text keeps exactly one statistics-only bubble',()=>{
 const tree=render(React.createElement(mod.exports.NativeFlowAdapter,{...base,entries:[{kind:'node',key:'c1'},{kind:'group',key:'ga',slFlowTurn:7}]}));
 const flat=[];const walk=v=>{if(!v||typeof v!=='object')return;if(Array.isArray(v)){v.forEach(walk);return;}flat.push(v);walk(v.children);};walk(tree);
 const bubbles=flat.filter(x=>x.props?.['data-sl-native-message']!==undefined);
 assert.equal(bubbles.length,1);
 assert.match(text(tree),/耗时 20 秒/);
});
