// Host parent/child agent messages, never session-link ledger messages.
// Only exact direct-parent addresses + the Host's structured source are used.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MessageBubble, CopyMessage } from './chat-ui.jsx';
import { cardClass, directionAttribute } from './card-shell.mjs';
import { getDisplayMode, subscribeDisplayMode, useDisplayMode } from './display-mode.mjs';
import { createSubagentPager, directPair, readSubagentPage, subagentText } from './subagent-history.mjs';
import { createWindowScope } from './outgoing-window-scope.mjs';
import { createSubagentSenderDefinition, SUBAGENT_SEND_KIND } from './subagent-outgoing.mjs';

const titleOf = (session, fallback) => session?.projectionValues?.subagent?.label || session?.title || (session?.displayTitle && session.displayTitle!==session.id ? session.displayTitle : fallback);
const cutOf = binding => {
  const entries=binding.eventSource.getSnapshot().entries;
  let max=-1;
  for(const item of entries) if(item.type==='event' && Number.isSafeInteger(item.event?.seq))max=Math.max(max,item.event.seq);
  return max;
};

export function SubagentExchangeDialog({ pair, selfId, selfName, peerName, sessions, remote, workspace, onClose }) {
  const dialog=useRef(null), scroller=useRef(null), anchor=useRef(null), pager=useRef(null), refs=useRef([]), inflight=useRef(null), first=useRef(true);
  const [messages,setMessages]=useState([]), [busy,setBusy]=useState(true), [more,setMore]=useState(false), [incomplete,setIncomplete]=useState(false), [error,setError]=useState(''), [attempt,setAttempt]=useState(0);
  const load=useCallback(async (initial=false)=>{
    if(inflight.current || !pager.current)return;
    setBusy(true);setError('');
    const controller=new AbortController();inflight.current=controller;
    try {
      const page=await readSubagentPage(pager.current,async ({signal,...request})=>{
        const result=await remote.page(request,signal);if(!result?.ok)throw new Error('session_page_failed');return result.value;
      },{signal:controller.signal});
      if(controller.signal.aborted)return;
      pager.current=page.pager;setMessages(previous=>initial?page.messages:[...page.messages,...previous]);setMore(page.hasMore);setIncomplete(page.incomplete);
    } catch(failure) { if(!controller.signal.aborted)setError('往返消息读取失败，请重试。'); }
    finally { if(inflight.current===controller){inflight.current=null;if(!controller.signal.aborted)setBusy(false);} }
  },[remote]);
  useEffect(()=>{
    const element=dialog.current, previous=document.activeElement;element?.showModal();
    const key=event=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();onClose();}};
    window.addEventListener('keydown',key,true);
    return ()=>{window.removeEventListener('keydown',key,true);element?.close();if(previous?.isConnected)previous.focus?.();};
  },[]);
  useEffect(()=>{
    const controller=new AbortController();let disposed=false;
    setBusy(true);setError('');pager.current=null;
    (async()=>{
      try {
        // Revalidate direct ancestry at click time, not merely when the card
        // first rendered. The Host also checks the addressed child.
        const verified=directPair(sessions,pair.parent,pair.child);
        if(!verified || verified.address.parentSessionId!==pair.parent)throw new Error('stale_pair');
        const parentTarget=sessions.subagentAddress(pair.parent) ?? pair.parent;
        const parent=sessions.retain(parentTarget,{source:'sessionLinkExchange',signal:controller.signal});refs.current.push(parent);
        const child=sessions.retain(verified.address,{source:'sessionLinkExchange',signal:controller.signal});refs.current.push(child);
        const [parentBinding,childBinding]=await Promise.all([parent.ready,child.ready]);
        if(disposed||controller.signal.aborted)return;
        const parentAddress=typeof parentTarget==='string'?{kind:'session',sessionId:parentTarget}:{kind:'subagent',...parentTarget};
        pager.current=createSubagentPager(verified,{parent:cutOf(parentBinding),child:cutOf(childBinding),parentAddress});
        await load(true);
      } catch(failure) { if(!disposed&&!controller.signal.aborted){setError('往返消息暂不可用，请重试。');setBusy(false);} }
    })();
    return ()=>{disposed=true;controller.abort();inflight.current?.abort();inflight.current=null;for(const ref of refs.current.splice(0))ref.release();};
  },[attempt,pair.parent,pair.child,load,sessions]);
  useLayoutEffect(()=>{
    const root=scroller.current;if(!root||busy||error)return;
    let frame;
    if(first.current){root.scrollTop=root.scrollHeight;first.current=false;}
    else if(anchor.current?.node?.isConnected){const saved=anchor.current;const correct=()=>{if(root.isConnected&&saved.node.isConnected)root.scrollTop+=saved.node.getBoundingClientRect().top-saved.top;};correct();frame=requestAnimationFrame(correct);}
    anchor.current=null;return ()=>{if(frame!==undefined)cancelAnimationFrame(frame);};
  },[messages,busy,error]);
  const loadOlder=()=>{
    if(busy||!more)return;const root=scroller.current,top=root?.getBoundingClientRect().top;
    const node=root&&[...root.querySelectorAll('[data-sl-message]')].find(element=>element.getBoundingClientRect().bottom>top);
    anchor.current=node?{node,top:node.getBoundingClientRect().top}:null;void load();
  };
  const navigate=message=>{const target=message.to===pair.child?pair.address:(sessions.subagentAddress(pair.parent)??pair.parent);onClose();void workspace.openSession(target);};
  return <dialog ref={dialog} className="sl-exchange-dialog" aria-label={`${selfName}与${peerName}的往返消息`} onCancel={onClose} onClick={event=>{if(event.target===event.currentTarget)onClose();}}>
    <div className="sl-exchange-frame"><header className="sl-exchange-head"><h2>{selfName} <span aria-hidden="true">⇄</span> {peerName}</h2><button type="button" className="sl-chat-close" onClick={onClose} aria-label="关闭往返消息">关闭</button></header>
      <div className="sl-exchange-scroll" ref={scroller}>
        {more && <div className="sl-exchange-older"><button type="button" className="sl-exchange-older-button" disabled={busy} onClick={loadOlder}>{incomplete?'继续查找更早消息':'查看更早的消息'}</button></div>}
        {busy && <p className="sl-chat-notice" role="status">正在读取往返消息…</p>}
        {error && <p className="sl-chat-error" role="alert">{error} <button type="button" onClick={()=>pager.current ? void load() : setAttempt(value=>value+1)}>重试</button></p>}
        {!busy&&!error&&!messages.length&&!more && <p className="sl-chat-notice">还没有往返消息。</p>}
        {!busy&&!error&&!messages.length&&more && <p className="sl-chat-notice">当前范围内没有匹配的消息，可继续查找更早记录。</p>}
        {messages.map(message=><MessageBubble key={message.id} author={message.from===selfId?selfName:peerName} direction={message.from===selfId?'sent':'received'} text={message.text ?? undefined} time={message.createdAt} actions={message.text!==null?<CopyMessage text={message.text}/>:undefined}>{message.unsupported&&<p className="sl-chat-notice">这条消息含无法在此显示的内容。<button type="button" onClick={()=>navigate(message)}>查看原会话</button></p>}</MessageBubble>)}
      </div>
    </div>
  </dialog>;
}
function SubagentLink({ children, pair, selfId, selfName, peerName, sessions, remote, workspace }) {
  const [open,setOpen]=useState(false);
  return <><button type="button" className="sl-exchange-link" onClick={()=>setOpen(true)}>{children}</button>{open && <SubagentExchangeDialog pair={pair} selfId={selfId} selfName={selfName} peerName={peerName} sessions={sessions} remote={remote} workspace={workspace} onClose={()=>setOpen(false)}/>}</>;
}
function VerifiedSubagentMessage({ props, Native, sessions, remote, workspace, selfId, source }) {
  const mode=useDisplayMode(), [open,setOpen]=useState(false);
  const self=props.useSessions(snapshot=>snapshot.byId?.[selfId]);
  const sender=props.useSessions(snapshot=>snapshot.byId?.[source.senderSessionId]);
  const pair=directPair(sessions,selfId,source.senderSessionId);
  const text=subagentText(props.node?.data?.content,source.senderSessionId);
  if(!pair || text===null || !Number.isFinite(props.node?.data?.time))return <Native {...props}/>;
  const from=titleOf(sender,source.senderSessionId===pair.parent?'父会话':'子智能体'), to=titleOf(self,'当前会话');
  const link=<SubagentLink pair={pair} selfId={selfId} selfName={to} peerName={from} sessions={sessions} remote={remote} workspace={workspace}>收到消息，来自 {from}</SubagentLink>;
  if(mode==='card')return <div className={cardClass('received')} data-session-link-subagent-card="" {...directionAttribute('received')}>
    <button type="button" className="sl-card__toggle" aria-expanded={open} onClick={()=>setOpen(value=>!value)}><span className="sl-card__party"><span className="sl-card__party-label">发送者</span><span className="sl-card__party-name">{from}</span><span className="sl-card__toggle-text">{open?'收起':'展开'}</span></span><span className="sl-card__party"><span className="sl-card__party-label">接收者</span><span className="sl-card__party-name">{to}</span></span><span className="sl-card__party"><span className="sl-card__party-label">主题</span><span className="sl-card__subject">{text.split('\n').find(line=>line.trim())?.slice(0,120) || '会话消息'}</span></span></button>
    {open && <div className="sl-card__expanded"><div className="sl-card__body" data-i18n-skip="">{text}</div><div className="sl-chat-meta"><CopyMessage text={text}/></div><div className="sl-chat-event">{link}</div></div>}
  </div>;
  return <div data-session-link-subagent-message=""><div className="sl-chat-event">{link}</div><MessageBubble author={from} text={text} time={props.node.data.time} actions={<CopyMessage text={text}/>}/></div>;
}
export function createSubagentMessageSkin(Native, dependencies) {
  return function SubagentMessageSkin(props) {
    const source=props.node?.data?.source;
    if(source?.kind!=='agent-message'||source.form!=='relay'||typeof source.senderSessionId!=='string')return <Native {...props}/>;
    return <VerifiedSubagentMessage {...dependencies} selfId={props.sessionId} props={props} Native={Native} source={source}/>;
  };
}
export function createSubagentSenderView({sessions,remote,workspace}) {
  return function SubagentSenderView(props) {
    const mode=useDisplayMode(),[open,setOpen]=useState(false), data=props.node?.data;
    const sender=props.useSessions(snapshot=>snapshot.byId?.[data?.from]);
    const target=props.useSessions(snapshot=>snapshot.byId?.[data?.to]);
    if(!data || data.from!==props.sessionId)return null;
    const pair=directPair(sessions,data.from,data.to);if(!pair)return null;
    const from=titleOf(sender,'当前会话'),to=titleOf(target,data.to===pair.parent?'父会话':'子智能体');
    const link=<SubagentLink pair={pair} selfId={data.from} selfName={from} peerName={to} sessions={sessions} remote={remote} workspace={workspace}>已发消息给 {to}</SubagentLink>;
    if(mode==='card')return <div className={cardClass('sent')} data-session-link-subagent-sender-card="" {...directionAttribute('sent')}><button type="button" className="sl-card__toggle" aria-expanded={open} onClick={()=>setOpen(value=>!value)}><span className="sl-card__party"><span className="sl-card__party-label">发送者</span><span className="sl-card__party-name">{from}</span><span className="sl-card__toggle-text">{open?'收起':'展开'}</span></span><span className="sl-card__party"><span className="sl-card__party-label">接收者</span><span className="sl-card__party-name">{to}</span></span><span className="sl-card__party"><span className="sl-card__party-label">主题</span><span className="sl-card__subject">{data.text.split('\n').find(line=>line.trim())?.slice(0,120)||'会话消息'}</span></span></button>{open && <div className="sl-card__expanded"><div className="sl-card__body" data-i18n-skip="">{data.text}</div><div className="sl-chat-meta"><CopyMessage text={data.text}/></div><div className="sl-chat-event">{link}</div></div>}</div>;
    return <div className="sl-chat-event" data-session-link-subagent-sent=""><span className="sl-chat-event-target">{link}<span className="sl-delivery-indicator sl-delivery-indicator--received" role="status" aria-label="宿主已确认投递，不代表已读或已回复" title="宿主已确认投递，不代表已读或已回复" tabIndex={0}>✓</span></span></div>;
  };
}
export function installSubagentMessages(ctx) {
  const scope=createWindowScope({sessions:ctx.sessions});
  let stopDefinition,stopSlots,stopTool;
  const dispose=()=>{stopTool?.();stopTool=undefined;stopSlots?.();stopSlots=undefined;stopDefinition?.();stopDefinition=undefined;scope.dispose();};
  try {
    stopDefinition=ctx.uiConversation.events.register(createSubagentSenderDefinition({scope,sessions:ctx.sessions}));
    stopSlots=ctx.slots.inject('conversation.chat.node',()=>{
      const stops=[];
      try {
        const remote=ctx.get('remote.session'), dependencies={sessions:ctx.sessions,remote,workspace:ctx.uiWorkspace};
        for(const key of ['turn-trigger','context']) {
          const entries=ctx.slots.entries('conversation.chat.node').filter(entry=>entry.options.key===key);
          const native=(entries.find(entry=>String(entry.registrant??'').includes('@deepseek-ai/dsh-client-ui-chat')) ?? entries[0]);
          if(!native)continue;
          stops.push(ctx.slots.register({name:'conversation.chat.node',key,priority:(native.options.priority??0)-5,locale:native.locale||'chat',inject:native.inject},createSubagentMessageSkin(native.component,dependencies)));
        }
        stops.push(ctx.slots.register({name:'conversation.chat.node',key:SUBAGENT_SEND_KIND},createSubagentSenderView(dependencies)));
      } catch(error) {for(const stop of stops.reverse())stop();throw error;}
      return ()=>{for(const stop of stops.reverse())stop();};
    });
    stopTool=ctx.slots.inject('tool.call.toolview',()=>{
      let stop;
      const sync=()=>{
        if(getDisplayMode()!=='card'){stop?.();stop=undefined;return;}
        if(stop)return;
        const entries=ctx.slots.entries('tool.call.toolview').filter(entry=>entry.options.key==='send_message').sort((a,b)=>(a.options.priority??0)-(b.options.priority??0));
        const native=entries[0];if(!native || Object.keys(native.children??{}).length>0)return;
        const Native=native.component;
        // Keep the original native toolview and all of its controls; the card
        // is presentation only. No extra dispatch or forged delivery status.
        const CardToolview=props=><div className="sl-tool-record sl-subagent-tool-card" data-session-link-subagent-toolview=""><Native {...props}/></div>;
        stop=ctx.slots.register({name:'tool.call.toolview',key:'send_message',priority:(native.options.priority??0)-5,locale:native.locale,inject:native.inject},CardToolview);
      };
      sync();const off=subscribeDisplayMode(sync);return ()=>{off();stop?.();};
    });
    ctx.effect(()=>dispose,'session-link: direct subagent messages');
  } catch(error){dispose();throw error;}
}
