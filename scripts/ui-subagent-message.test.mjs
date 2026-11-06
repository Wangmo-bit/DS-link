import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import React from 'react';
// Tiny deterministic hook harness: the project intentionally does not depend
// on a second copy of react-dom. No side effects or network are invoked.
const output=await build({entryPoints:['src/client/subagent-message.jsx'],bundle:true,write:false,format:'cjs',platform:'browser',external:['react','@deepseek-ai/*'],logLevel:'silent'});
const mod={exports:{}};
new Function('require','module','exports',output.outputFiles[0].text)(name=>name==='react'?React:{MarkdownText:({text})=>React.createElement('span',null,text)},mod,mod.exports);
const address={parentSessionId:'P',childSessionId:'C',mode:'continuable'};
const deps={sessions:{subagentAddress:id=>id==='C'?address:undefined},remote:{},workspace:{}};
const Native=()=>React.createElement('div',{'data-native':'yes'},'original native');
const Skin=mod.exports.createSubagentMessageSkin(Native,deps);
const list={P:{id:'P',title:'父会话'},C:{id:'C',title:'子会话',origin:'subagent'}};
const props={sessionId:'P',useSessions:selector=>selector({byId:list}),node:{data:{time:1000,source:{kind:'agent-message',form:'relay',senderSessionId:'C'},content:[{type:'text',text:'Agent C sent a message: '},{type:'text',text:'Hello full body'}]}}};
function storage(value){const original=Object.getOwnPropertyDescriptor(globalThis,'localStorage');Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>value}});return ()=>{if(original)Object.defineProperty(globalThis,'localStorage',original);else delete globalThis.localStorage;};}
function renderToStaticMarkup(root){
 const ref=React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher,prior=ref.current;
 ref.current={useState:v=>[typeof v==='function'?v():v,()=>{}],useSyncExternalStore:(_s,get)=>get(),useRef:v=>({current:v}),useEffect:()=>{},useLayoutEffect:()=>{},useCallback:f=>f};
 const walk=value=>{if(value==null||typeof value==='boolean')return '';if(Array.isArray(value))return value.map(walk).join('');if(typeof value==='string'||typeof value==='number')return String(value);if(typeof value.type==='function')return walk(value.type(value.props));if(value.type===React.Fragment)return walk(value.props.children);const attrs=Object.entries(value.props||{}).filter(([key,v])=>key.startsWith('data-')&&v!==undefined).map(([key,v])=>` ${key}=${String(v)}`).join('');return `<${String(value.type)}${attrs}>${walk(value.props?.children)}</${String(value.type)}>`;};
 try{return walk(root);}finally{ref.current=prior;}
}
test('verified direct child message becomes readable bubble with exact body',()=>{
 const restore=storage('bubble');try{const html=renderToStaticMarkup(React.createElement(Skin,props));assert.match(html,/data-session-link-subagent-message/);assert.match(html,/子会话/);assert.match(html,/Hello full body/);assert.doesNotMatch(html,/Agent C sent a message|data-native/);}finally{restore();}
});
test('verified direct child message switches to old card visual',()=>{
 const restore=storage('card');try{const html=renderToStaticMarkup(React.createElement(Skin,props));assert.match(html,/data-session-link-subagent-card/);assert.doesNotMatch(html,/data-session-link-subagent-message/);}finally{restore();}
});
test('unknown relation or unsupported original blocks always fall back to Host',()=>{
 const restore=storage('bubble');try{const fake={...props,sessionId:'unrelated'};assert.match(renderToStaticMarkup(React.createElement(Skin,fake)),/data-native/);const extra={...props,node:{data:{...props.node.data,content:[...props.node.data.content,{type:'image'}]}}};assert.match(renderToStaticMarkup(React.createElement(Skin,extra)),/data-native/);}finally{restore();}
});
