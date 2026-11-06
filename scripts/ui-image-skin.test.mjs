import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { build } from 'esbuild';

const result = await build({ entryPoints:['src/client/image-skin.jsx'], bundle:true,write:false,format:'cjs',platform:'browser',external:['react'],logLevel:'silent' });
const module = { exports:{} };
new Function('require','module','exports',result.outputFiles[0].text)(name => { if(name==='react') return React; throw Error(name); }, module, module.exports);
const { imageBox, reservedImageBox, stableImageKey, rememberPendingImage, imageHandoffFor, createStableUserImages, installStableUserImages } = module.exports;

function render(Component, props, slots=[], handoff=null) {
  let cursor=0;
  const ref=React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
  const prev=ref.current; ref.current={useRef(value){const i=cursor++;return slots[i] ??= {current:value};},useState(value){const i=cursor++;if (!(i in slots)) slots[i]=typeof value==='function'?value():value;return [slots[i],next=>{slots[i]=typeof next==='function'?next(slots[i]):next;}];},useContext(){return handoff;}};
  try { return Component(props); } finally { ref.current=prev; }
}

test('preview size follows known ratio; absent dimensions use stable fallback', () => {
  assert.deepEqual(imageBox({preview:{url:'blob:a',width:800,height:400}}),{width:240,height:120});
  assert.deepEqual(imageBox({attachment:{attachmentId:'id',width:100,height:400}}),{width:60,height:240});
  assert.equal(imageBox({preview:{url:'blob:a'}}),null);
  assert.equal(stableImageKey({attachment:{attachmentId:'abc'}}),'attachment:abc');
  assert.equal(stableImageKey({preview:{url:'blob:abc'}}),'preview:blob:abc');
});

test('echo preview handoff requires the exact session, request, attachment order and short lifetime', () => {
  const preview={type:'image',value:{previewUrl:'blob:local-a',name:'x.png',width:800,height:400}};
  const file={type:'file',value:{name:'doc.txt'}};
  const session={getSnapshot:()=>({pendingSubmissions:[{requestId:'rpc-a',attachments:[preview,file]}]})};
  const other={getSnapshot:session.getSnapshot};
  rememberPendingImage(session,'blob:local-a',1000);
  const attachments=[{type:'image',image:{attachment:{attachmentId:'image-a',width:800,height:400}}},{type:'file',file:{name:'doc.txt'}}];
  const found=imageHandoffFor(session,'rpc-a',attachments,1100);
  assert.equal(found.get('image-a').url,'blob:local-a');
  assert.equal(imageHandoffFor(other,'rpc-a',attachments,1100),null);
  assert.equal(imageHandoffFor(session,'rpc-b',attachments,1100),null);
  assert.equal(imageHandoffFor(session,'rpc-a',attachments.toReversed(),1100),null);
  assert.equal(imageHandoffFor(session,'rpc-a',attachments.slice(0,1),1100),null);
  assert.equal(imageHandoffFor(session,'rpc-a',attachments,61001),null);
});

test('known Codex viewer uses proven echo immediately before Host peek is ready', () => {
  function MessageImagePreviews() { return null; }
  const attachment={attachmentId:'image-a',name:'x.png',width:800,height:400};
  const loadImage=Object.assign(()=>Promise.resolve('blob:later'),{peek:()=>null});
  const handoff=new Map([['image-a',{url:'blob:echo',name:'x.png',width:800,height:400}]]);
  const result=render(createStableUserImages(MessageImagePreviews),{images:[{attachment}],loadImage},[],handoff);
  assert.equal(result.props.children.props.images[0].preview.url,'blob:echo');
  assert.equal(result.props.children.props.images[0].attachment,attachment);
  assert.equal(result.props.style['--sl-img-ratio'],'240 / 120');
  const unknown=new Map([['image-a',{url:'blob:echo'}]]);
  const reserved=render(createStableUserImages(MessageImagePreviews),{images:[{attachment}],loadImage},[],unknown);
  assert.equal(reserved.props.style['--sl-img-ratio'],'240 / 180');
});

test('a revoked provisional blob falls back to the native durable loader', () => {
  function MessageImagePreviews() { return null; }
  const attachment={attachmentId:'image-a',width:800,height:400};
  const loadImage=Object.assign(()=>Promise.resolve('blob:canonical'),{peek:()=>null});
  const handoff=new Map([['image-a',{url:'blob:revoked',width:800,height:400}]]), slots=[];
  const Wrapper=createStableUserImages(MessageImagePreviews);
  const first=render(Wrapper,{images:[{attachment}],loadImage},slots,handoff);
  assert.equal(first.props.children.props.images[0].preview.url,'blob:revoked');
  first.props.onErrorCapture({target:{tagName:'IMG',currentSrc:'blob:revoked'}});
  const second=render(Wrapper,{images:[{attachment}],loadImage},slots,handoff);
  assert.equal(second.props.children.props.images[0].preview,undefined);
  assert.equal(second.props.children.props.images[0].attachment,attachment);
});

test('unknown preview size stays reserved through exact Host-seeded handoff only', () => {
  let peek = 'blob:local';
  const loader=Object.assign(()=>Promise.resolve(peek),{peek: ref => ref.attachmentId === 'sha:1' ? peek : 'blob:other'});
  const preview={preview:{url:'blob:local',name:'same.png'}};
  assert.deepEqual(reservedImageBox(loader,preview),{width:240,height:180});
  assert.deepEqual(reservedImageBox(loader,{preview:{...preview.preview,width:800,height:400}}),{width:240,height:180});
  const durable={attachment:{attachmentId:'sha:1',name:'same.png',width:800,height:400}};
  assert.deepEqual(reservedImageBox(loader,durable),{width:240,height:180});
  peek='blob:canonical';
  assert.deepEqual(reservedImageBox(loader,durable),{width:240,height:180},'canonical cache replacement retains the box');
  const other={attachment:{...durable.attachment,attachmentId:'sha:2'}};
  assert.deepEqual(reservedImageBox(loader,other),{width:240,height:120},'same name is not an identity');
  const otherSession=Object.assign(()=>{}, {peek:()=> 'blob:local'});
  assert.deepEqual(reservedImageBox(otherSession,durable),{width:240,height:120},'loader identity isolates sessions');
});

test('rerender preserves identical image identity without conflating different images', () => {
  const Native=() => null, Wrapper=createStableUserImages(Native), slots=[];
  const original={attachment:{attachmentId:'sha:1',name:'a',mediaType:'image/png',bytes:12,width:600,height:300}};
  const first=render(Wrapper,{images:[original],loadImage:'loader'},slots);
  const second=render(Wrapper,{images:[{attachment:{...original.attachment}}],loadImage:'loader'},slots);
  assert.equal(first.props.children.props.images[0],original);
  assert.equal(second.props.children.props.images[0],original);
  assert.equal(second.props.children.props.loadImage,'loader');
  assert.equal(second.props.style['--sl-img-ratio'],'240 / 120');
  const other={attachment:{...original.attachment,attachmentId:'sha:2'}};
  const third=render(Wrapper,{images:[other]},slots);
  assert.equal(third.props.children.props.images[0],other);
  const changed={attachment:{...other.attachment,bytes:99}};
  assert.equal(render(Wrapper,{images:[changed]},slots).props.children.props.images[0],changed);
});

test('Codex viewer reuses the Host-authorized seeded preview during durable handoff', () => {
  function MessageImagePreviews() { return null; }
  const image={attachment:{attachmentId:'sha:1',name:'x.png',width:600,height:300}};
  const loadImage=Object.assign(() => Promise.resolve('blob:canonical'), {peek: ref => ref.attachmentId === 'sha:1' ? 'blob:local-preview' : null});
  const output=render(createStableUserImages(MessageImagePreviews),{images:[image],loadImage});
  const passed=output.props.children.props.images[0];
  assert.equal(passed.attachment,image.attachment);
  assert.equal(passed.preview.url,'blob:local-preview');
  assert.equal(passed.preview.width,600);
  function OtherViewer() { return null; }
  assert.equal(render(createStableUserImages(OtherViewer),{images:[image],loadImage}).props.children.props.images[0],image, 'other viewers get the unchanged Host shape');
});

test('wrapper preserves active viewer injection and removes its own registration on unload', () => {
  const original={component:()=>null, options:{priority:-10},locale:'conversation',inject:()=>({viewer:true})};
  let entries=[original], cleanup, subscription, removed=0;
  const ctx={slots:{
    inject(name, callback){assert.equal(name,'conversation.chat.user.images');cleanup=callback();},
    subscribe(_name, cb){subscription=cb;return()=>{subscription=null;};},
    entries(){return entries;},
    entriesOfSlot(){return entries.slice().sort((a,b)=>(a.options.priority??0)-(b.options.priority??0)).slice(0,1);},
    register(options,component){const entry={component,options};entries.push(entry);return()=>{removed++;entries=entries.filter(item=>item!==entry);};},
  }};
  installStableUserImages(ctx);
  assert.equal(entries.length,2); assert.equal(entries[1].options.inject('s').viewer,true);
  cleanup(); assert.equal(removed,1); assert.equal(entries.length,1);assert.equal(subscription,null);
});

test('late viewer changes are wrapped once, with no stale injection or infinite registrations', async () => {
  const native={component:()=>null, options:{priority:100},locale:'conversation'};
  let entries=[native], cleanup, onChange, registrations=0, stopped=false;
  const ctx={slots:{
    inject(_name, callback){cleanup=callback();},
    subscribe(_name, callback){onChange=callback;return()=>{stopped=true;};},
    entries(){return entries;},
    entriesOfSlot(){return entries.slice().sort((a,b)=>(a.options.priority??0)-(b.options.priority??0)).slice(0,1);},
    register(options,component){registrations++;const entry={component,options};entries.push(entry);onChange?.();return()=>{entries=entries.filter(item=>item!==entry);onChange?.();};},
  }};
  installStableUserImages(ctx);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(registrations,1);
  const peer={component:()=>null,options:{priority:-200},inject:()=>({viewer:'peer'})};
  entries.push(peer);onChange();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(registrations,2);
  assert.equal(entries.find(e=>e.component!==peer.component&&e.options.priority < -200).options.inject('s').viewer,'peer');
  entries=entries.filter(e=>e!==peer);onChange();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(registrations,3,'removing peer returns to native viewer');
  cleanup();
  assert.equal(stopped,true);
  assert.deepEqual(entries,[native]);
});
