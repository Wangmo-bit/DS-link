// Terminal failure rows belong to the turn's own bubble (user decision
// 2026-11-08): the summary line names the state, and the original Host block is
// mounted only through the in-bubble disclosure, never as a stray timeline row.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {build} from 'esbuild';
const output=await build({entryPoints:['src/client/native-flow.jsx'],bundle:true,write:false,format:'cjs',platform:'browser',external:['react','@deepseek-ai/*'],logLevel:'silent'});
const mod={exports:{}};
const drawn=[];
function NativeFlow({entries}){for(const entry of entries)drawn.push(entry.key);return React.createElement('div',{'data-native-flow':'', 'data-keys':entries.map(e=>e.key).join(',')});}
new Function('require','module','exports',output.outputFiles[0].text)(name=>name==='react'?React:{MarkdownText:()=>null},mod,mod.exports);

const failedTurn={turn:7,status:'closed',start:{time:1000},end:{time:21000,data:{reason:{kind:'error',error:{message:'boom',code:'E1'}}}},steps:[]};
const nodes=new Map([
 ['ctrl',{kind:'turn-process',location:{kind:'turn',turn:failedTurn},data:{turn:7,toolCallCount:3}}],
 ['err',{kind:'turn-error',location:{kind:'turn',turn:failedTurn},data:{turn:7,failure:{message:'boom',code:'E1'}}}],
]);
const base={sessionId:'self',pendingInputs:[],lastInputTurn:7,useChat:fn=>fn({nodes}),useSessions:fn=>fn({byId:{self:{title:'助手'}}}),useChatNode:(key,fn=x=>x)=>fn(nodes.get(key)),useChatGroup:(key,fn=x=>x)=>fn(undefined),usePresentation:fn=>fn({foldCompletedTurns:true,stepGrouping:'collapsed'}),NativeFlow};
function mount(element){
 const ref0=React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher,prior=ref0.current;
 const slots=[],effects=[];let cursor=0,dirty=false,tree=null;
 const dispatcher={
  useState(initial){const at=cursor++;if(!(at in slots))slots[at]=typeof initial==='function'?initial():initial;
   return[slots[at],value=>{const next=typeof value==='function'?value(slots[at]):value;if(!Object.is(next,slots[at])){slots[at]=next;dirty=true;}}];},
  useRef(initial){const at=cursor++;if(!(at in slots))slots[at]={current:initial};return slots[at];},
  useSyncExternalStore(_subscribe,get){cursor++;return get();},
  useMemo(factory){cursor++;return factory();},
  useCallback(fn){cursor++;return fn;},
  useEffect(callback){const at=cursor++;if(!(at in slots)){slots[at]={};effects.push(callback);}},
  useLayoutEffect(){cursor++;},
 };
 const walk=value=>{if(value==null||typeof value==='boolean')return null;if(Array.isArray(value))return value.map(walk).filter(Boolean);if(typeof value==='string'||typeof value==='number')return value;if(typeof value.type==='function')return walk(value.type(value.props));if(value.type===React.Fragment)return walk(value.props.children);return {type:value.type,props:value.props,children:walk(value.props.children)};};
 const run=()=>{for(let round=0;round<8;round++){cursor=0;dirty=false;effects.length=0;ref0.current=dispatcher;try{tree=walk(element);}finally{ref0.current=prior;}for(const effect of effects.splice(0))effect();if(!dirty)break;}return tree;};
 const find=(node,pred)=>{if(node==null||typeof node!=='object')return null;if(Array.isArray(node)){for(const item of node){const hit=find(item,pred);if(hit)return hit;}return null;}if(pred(node))return node;return find(node.children,pred);};
 run();
 return {get tree(){return tree;},find:pred=>find(tree,pred),click:pred=>{const node=find(tree,pred);assert.ok(node?.props?.onClick,'expected a clickable disclosure');node.props.onClick({});return run();}};
}
const text=value=>{if(value==null||typeof value==='boolean')return'';if(Array.isArray(value))return value.map(text).join('');if(typeof value==='string'||typeof value==='number')return String(value);return text(value.children);};
const entries=[{kind:'node',key:'ctrl'},{kind:'node',key:'err'}];

test('a failed turn states the failure on its single line and hides the raw block',()=>{
 drawn.length=0;
 const ui=mount(React.createElement(mod.exports.NativeFlowAdapter,{...base,entries}));
 assert.match(text(ui.tree),/执行失败/);
 assert.match(text(ui.tree),/查看原因/);
 assert.deepEqual(drawn,[],'the original Host error block must not paint in the timeline by default');
 assert.equal(ui.find(node=>node.props?.['data-sl-terminal-detail']),null);
});

test('the in-bubble disclosure reveals the original Host block on demand',()=>{
 drawn.length=0;
 const ui=mount(React.createElement(mod.exports.NativeFlowAdapter,{...base,entries}));
 ui.click(node=>String(node.props?.className??'').includes('sl-terminal-toggle'));
 assert.equal(ui.find(node=>String(node.props?.className??'').includes('sl-terminal-detail'))!==null,true);
 assert.deepEqual(drawn,['err'],'expanding mounts the original terminal block inside the bubble');
 assert.match(text(ui.tree),/收起原因/);
});

test('an ended message with text offers a one-click quote action',()=>{
 const okTurn={turn:8,status:'closed',start:{time:1000},end:{time:21000,data:{reason:{kind:'completed'}}},steps:[]};
 const textNodes=new Map([
  ['ctrl2',{kind:'turn-process',location:{kind:'turn',turn:okTurn},data:{turn:8,toolCallCount:0}}],
  ['resp2',{kind:'assistant-step',location:{kind:'turn',turn:okTurn},data:{turn:8}}],
 ]);
 const base2={...base,useChat:fn=>fn({nodes:textNodes}),useChatNode:(key,fn=x=>x)=>fn(textNodes.get(key))};
 drawn.length=0;
 const ui=mount(React.createElement(mod.exports.NativeFlowAdapter,{...base2,entries:[{kind:'node',key:'ctrl2'},{kind:'node',key:'resp2'}]}));
 assert.match(text(ui.tree),/引用/,'the quote action lives on the message heading');
 assert.ok(ui.find(node=>String(node.props?.className??'').includes('sl-quote-action')));
 assert.ok(ui.find(node=>node.props?.['data-sl-quote-text']!==undefined));
});
