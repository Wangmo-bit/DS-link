// One-click quote: a Host action-strip entry resolves the finalized message's
// markdown source and inserts it through the Host's public quote seat.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { build } from 'esbuild';
import { clipQuote, closingQuoteText } from '../src/client/message-quote.mjs';

const output=await build({entryPoints:['src/client/message-quote-action.jsx'],bundle:true,write:false,format:'cjs',platform:'browser',external:['react','@deepseek-ai/*'],logLevel:'silent'});
const mod={exports:{}};
// `react` is the only external the component imports directly.
new Function('require','module','exports',output.outputFiles[0].text)(name=>name==='react'?React:null,mod,mod.exports);

function storage(value){const original=Object.getOwnPropertyDescriptor(globalThis,'localStorage');Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>value}});return ()=>{if(original)Object.defineProperty(globalThis,'localStorage',original);else delete globalThis.localStorage;};}
function mount(element){
 const ref0=React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher,prior=ref0.current;
 ref0.current={useSyncExternalStore:(_subscribe,get)=>get(),useState:v=>[typeof v==='function'?v():v,()=>{}],useRef:v=>({current:v}),useEffect:()=>{},useLayoutEffect:()=>{},useCallback:f=>f,useMemo:f=>f()};
 const walk=value=>{if(value==null||typeof value==='boolean')return null;if(Array.isArray(value))return value.map(walk).filter(Boolean);if(typeof value==='string'||typeof value==='number')return value;if(typeof value.type==='function')return walk(value.type(value.props));if(value.type===React.Fragment)return walk(value.props.children);return {type:value.type,props:value.props,children:walk(value.props.children)};};
 try{return walk(element);}finally{ref0.current=prior;}
}
const find=(node,pred)=>{if(node==null||typeof node!=='object')return null;if(Array.isArray(node)){for(const item of node){const hit=find(item,pred);if(hit)return hit;}return null;}if(pred(node))return node;return find(node.children,pred);};

test('a short message is quoted verbatim, a huge one as a marked excerpt',()=>{
  assert.equal(clipQuote('hello'),'hello');
  assert.equal(clipQuote('  a\r\nb  '),'a\nb');
  assert.equal(clipQuote(''),'');
  assert.equal(clipQuote(null),'');
  const huge='x'.repeat(3000);
  const clipped=clipQuote(huge);
  assert.equal(clipped.endsWith('…（引用节选）'),true);
  assert.equal(clipped.length <= 1200 + '\n…（引用节选）'.length,true);
});

test('the quote keeps markdown source and ignores reasoning blocks',()=>{
  const closing={blocks:[{kind:'text',text:'**标题**'},{kind:'reasoning',text:'内部推理'},{kind:'text',text:'   '},{kind:'text',text:'正文'}]};
  assert.equal(closingQuoteText(closing),'**标题**\n正文');
  assert.equal(closingQuoteText({}),'');
  assert.equal(closingQuoteText(null),'');
});

test('the action strip entry resolves the message and inserts the Host quote',()=>{
  const restore=storage('bubble');
  try{
    const Action=mod.exports.createQuoteMessageAction();
    const closing={finalNode:{messageId:'m1'},blocks:[{kind:'text',text:'**hello**'},{kind:'reasoning',text:'why'},{kind:'text',text:'world'}]};
    const snapshot={nodes:new Map([['n1',{data:{closing}},]]),timeline:{}};
    let inserted='';
    const tree=mount(React.createElement(Action,{messageId:'m1',sessionId:'S',useChat:selector=>selector(snapshot),inputActions:{insertQuote:text=>{inserted=text;return true;}}}));
    const button=find(tree,node=>String(node.props?.className??'').includes('sl-message-action'));
    assert.ok(button,'quote action renders in the native strip');
    assert.equal(button.props['aria-label'],'引用这条消息');
    button.props.onClick();
    assert.equal(inserted,'**hello**\nworld');
  }finally{restore();}
});

test('card mode and unknown messages never add an action',()=>{
  const restore=storage('card');
  try{
    const Action=mod.exports.createQuoteMessageAction();
    const closing={finalNode:{messageId:'m1'},blocks:[{kind:'text',text:'hello'}]};
    const snapshot={nodes:new Map([['n1',{data:{closing}}]])};
    assert.equal(mount(React.createElement(Action,{messageId:'m1',useChat:s=>s(snapshot),inputActions:{insertQuote:()=>true}})),null);
    assert.equal(mount(React.createElement(Action,{messageId:'other',useChat:s=>s(snapshot),inputActions:{insertQuote:()=>true}})),null);
  }finally{restore();}
});
