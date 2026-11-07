// Regression: no article may render with nothing but the author name. A text-less
// segment whose turn already shows its statistics elsewhere used to leave an empty
// block under the author, which is what the user saw as "这里啥都没有".
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {build} from 'esbuild';
const output=await build({entryPoints:['src/client/native-flow.jsx'],bundle:true,write:false,format:'cjs',platform:'browser',external:['react','@deepseek-ai/*'],logLevel:'silent'});
const mod={exports:{}};new Function('require','module','exports',output.outputFiles[0].text)(name=>name==='react'?React:{MarkdownText:()=>null},mod,mod.exports);

const turn={turn:7,status:'closed',start:{time:1000},end:{time:21000},steps:[]};
const nodes=new Map([
 ['ctrl',{kind:'turn-process',location:{kind:'turn',turn},data:{turn:7,toolCallCount:2}}],
 ['a1',{kind:'assistant-step',location:{kind:'turn',turn},data:{turn:7,blocks:[]}}],
 ['a2',{kind:'assistant-step',location:{kind:'turn',turn},data:{turn:7,blocks:[]}}],
]);
const groups={ga:{data:{turn:7},members:[{kind:'node',key:'a1'}]},gb:{data:{turn:7},members:[{kind:'node',key:'a2'}]}};
const base={sessionId:'self',pendingInputs:[],lastInputTurn:7,useChat:fn=>fn({nodes}),useSessions:fn=>fn({byId:{self:{title:'助手'}}}),useChatNode:(key,fn=x=>x)=>fn(nodes.get(key)),useChatGroup:(key,fn=x=>x)=>fn(groups[key]),usePresentation:fn=>fn({foldCompletedTurns:true,stepGrouping:'collapsed'}),NativeFlow:()=>null};
function mount(element){
 const ref0=React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher,prior=ref0.current;
 const slots=[];let cursor=0;
 ref0.current={useState(v){const at=cursor++;if(!(at in slots))slots[at]=typeof v==='function'?v():v;return[slots[at],next=>{slots[at]=typeof next==='function'?next(slots[at]):next;}];},useSyncExternalStore:(_s,get)=>{cursor++;return get();},useRef(v){const at=cursor++;if(!(at in slots))slots[at]={current:v};return slots[at];},useMemo(f){cursor++;return f();},useCallback(f){cursor++;return f;},useEffect(){cursor++;},useLayoutEffect(){cursor++;}};
 const walk=value=>{if(value==null||typeof value==='boolean')return null;if(Array.isArray(value))return value.map(walk).filter(Boolean);if(typeof value==='string'||typeof value==='number')return value;if(typeof value.type==='function')return walk(value.type(value.props));if(value.type===React.Fragment)return walk(value.props.children);return {type:value.type,props:value.props,children:walk(value.props.children)};};
 try{return walk(element);}finally{ref0.current=prior;}}
const flatten=(v,out=[])=>{if(!v||typeof v!=='object')return out;if(Array.isArray(v)){v.forEach(x=>flatten(x,out));return out;}out.push(v);flatten(v.children,out);return out;};
const text=v=>{if(v==null)return'';if(typeof v==='string'||typeof v==='number')return String(v);if(Array.isArray(v))return v.map(text).join('');return text(v.children);};

test('no article renders with only an author name',()=>{
 const tree=mount(React.createElement(mod.exports.NativeFlowAdapter,{...base,entries:[{kind:'node',key:'ctrl'},{kind:'group',key:'ga',slFlowTurn:7},{kind:'group',key:'gb',slFlowTurn:7}]}));
 const articles=flatten(tree).filter(node=>node.props?.['data-sl-message']!==undefined);
 for(const article of articles){
   const body=flatten(article).filter(node=>node!==article).map(node=>text(node)).join('');
   assert.ok(body.trim()!=='',`an article rendered with no content: ${JSON.stringify(text(article))}`);
 }
});

test('a second text-less segment of the same turn does not add a block',()=>{
 const tree=mount(React.createElement(mod.exports.NativeFlowAdapter,{...base,entries:[{kind:'node',key:'ctrl'},{kind:'group',key:'ga',slFlowTurn:7},{kind:'group',key:'gb',slFlowTurn:7}]}));
 const articles=flatten(tree).filter(node=>node.props?.['data-sl-message']!==undefined);
 assert.ok(articles.length<=1,`expected at most one message for a text-less turn, got ${articles.length}`);
});
