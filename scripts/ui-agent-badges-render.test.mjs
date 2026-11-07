// Render-level contract for the agent badges: a turn that dispatched nothing must
// not reserve any space, and a turn with agents must show the grouped SVG badges
// after the summary text.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {build} from 'esbuild';
const output=await build({entryPoints:['src/client/native-flow.jsx'],bundle:true,write:false,format:'cjs',platform:'browser',external:['react','@deepseek-ai/*'],logLevel:'silent'});
const mod={exports:{}};new Function('require','module','exports',output.outputFiles[0].text)(name=>name==='react'?React:{MarkdownText:()=>null},mod,mod.exports);

const closed={turn:7,status:'closed',start:{time:1000},end:{time:21000},steps:[],data:{}};
const node=(kind,extra={})=>({kind,location:{kind:'turn',turn:closed},data:{turn:7,...extra}});

function mount(element){
 const ref0=React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher,prior=ref0.current;
 const slots=[];let cursor=0;
 ref0.current={useState(v){const at=cursor++;if(!(at in slots))slots[at]=typeof v==='function'?v():v;return[slots[at],next=>{slots[at]=typeof next==='function'?next(slots[at]):next;}];},useSyncExternalStore:(_s,get)=>{cursor++;return get();},useRef(v){const at=cursor++;if(!(at in slots))slots[at]={current:v};return slots[at];},useMemo(f){cursor++;return f();},useCallback(f){cursor++;return f;},useEffect(){cursor++;},useLayoutEffect(){cursor++;}};
 const walk=value=>{if(value==null||typeof value==='boolean')return null;if(Array.isArray(value))return value.map(walk).filter(Boolean);if(typeof value==='string'||typeof value==='number')return value;if(typeof value.type==='function')return walk(value.type(value.props));if(value.type===React.Fragment)return walk(value.props.children);return {type:value.type,props:value.props,children:walk(value.props.children)};};
 try{return walk(element);}finally{ref0.current=prior;}}
const flatten=(v,out=[])=>{if(!v||typeof v!=='object')return out;if(Array.isArray(v)){v.forEach(x=>flatten(x,out));return out;}out.push(v);flatten(v.children,out);return out;};
const text=v=>{if(v==null)return'';if(typeof v==='string'||typeof v==='number')return String(v);if(Array.isArray(v))return v.map(text).join('');return text(v.children);};

/** @param {Array} catalog parent subagentCatalog projection */
function render(catalog){
 const nodes=new Map([['ctrl',node('turn-process',{toolCallCount:2})],['r',node('assistant-step',{blocks:[]})]]);
 const sessions={byId:{self:{title:'助手'}},projectionsBySession:{self:{values:{subagentCatalog:catalog}}}};
 const base={sessionId:'self',pendingInputs:[],lastInputTurn:7,useChat:fn=>fn({nodes,timeline:{turns:new Map([[7,closed]])}}),useSessions:fn=>fn(sessions),useChatNode:(key,fn=x=>x)=>fn(nodes.get(key)),useChatGroup:()=>undefined,usePresentation:fn=>fn({foldCompletedTurns:true,stepGrouping:'collapsed'}),NativeFlow:()=>null};
 return mount(React.createElement(mod.exports.NativeFlowAdapter,{...base,entries:[{kind:'node',key:'ctrl'},{kind:'node',key:'r',groupPart:'response'}]}));
}

test('a turn that dispatched no agent renders no badge element',()=>{
 const tree=render([]);
 const all=flatten(tree);
 assert.equal(all.filter(n=>n.props?.['data-sl-agent-badges']!==undefined).length,0);
 assert.doesNotMatch(text(tree),/agent/);
});

test('a turn with agents renders grouped svg badges after the summary',()=>{
 // two children created inside the turn window (1000..21000): one running, one done
 const catalog=[
  {id:'a',createdAt:2000,label:'冷审'},
  {id:'b',createdAt:3000,label:'开发'},
 ];
 const nodes=new Map([['ctrl',node('turn-process',{toolCallCount:2})],['r',node('assistant-step',{blocks:[]})]]);
 const sessions={byId:{self:{title:'助手'},a:{running:false,projectionValues:{subagentTiming:{lastTurnCompleted:true}}},b:{running:true}},
  projectionsBySession:{self:{values:{subagentCatalog:catalog}}}};
 const base={sessionId:'self',pendingInputs:[],lastInputTurn:7,useChat:fn=>fn({nodes,timeline:{turns:new Map([[7,closed]])}}),useSessions:fn=>fn(sessions),useChatNode:(key,fn=x=>x)=>fn(nodes.get(key)),useChatGroup:()=>undefined,usePresentation:fn=>fn({foldCompletedTurns:true,stepGrouping:'collapsed'}),NativeFlow:()=>null};
 const tree=mount(React.createElement(mod.exports.NativeFlowAdapter,{...base,entries:[{kind:'node',key:'ctrl'},{kind:'node',key:'r',groupPart:'response'}]}));
 const all=flatten(tree);
 const badge=all.find(n=>n.props?.['data-sl-agent-badges']!==undefined);
 assert.ok(badge,'the badge container must render when the turn dispatched agents');
 const svgs=all.filter(n=>n.type==='svg'&&String(n.props?.className||'').includes('sl-agent-icon'));
 assert.equal(svgs.length,2,'one silhouette per state group');
 const label=badge.props['aria-label'];
 assert.match(label,/2 个 agent/);
 assert.match(label,/运行中 1 个/);
 assert.match(label,/已完成 1 个/);
});
