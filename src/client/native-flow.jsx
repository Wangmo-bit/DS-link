// React-owned adapter around the Host's native ChatFlow. Native group and node
// components remain the sole renderers of thinking, tools, approvals and files.
import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { MessageBubble, ThinkingDots } from './chat-ui.jsx';
import { formatTurnSummary } from './chat-skin-model.mjs';
import { formatRunningElapsed, planNativeFlow, processAttention } from './native-flow-plan.mjs';
import { useDisplayMode } from './display-mode.mjs';

export const FLOW_SLOT = 'conversation.chat.flow.adapter';
const normalizedPolicies = new WeakMap();
function inlinePolicy(policy) {
  if (!policy || typeof policy !== 'object') return policy;
  let next = normalizedPolicies.get(policy);
  if (!next) { next = {...policy, stepGrouping:'none', foldCompletedTurns:false}; normalizedPolicies.set(policy,next); }
  return next;
}
function disclosureStore() {
  const values = new Map(), listeners = new Set();
  return {
    get: key => values.get(key) === true,
    set(key, value) { if (values.get(key) === value) return; values.set(key,value); for (const fn of [...listeners]) fn(); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
function useDisclosure(store, turn) {
  const get = useCallback(() => store.get(turn), [store,turn]);
  const open = useSyncExternalStore(store.subscribe,get,()=>false);
  return [open, useCallback(() => store.set(turn,!store.get(turn)),[store,turn])];
}
function RunningLabel({ start }) {
  const [now,setNow] = useState(Date.now);
  useEffect(()=>{ if (!Number.isFinite(start)) return; setNow(Date.now()); const timer=setInterval(()=>setNow(Date.now()),1000); return ()=>clearInterval(timer); },[start]);
  return formatRunningElapsed(start,now);
}
function Chevron({ open }) {
  return <svg className="sl-process-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false"><path d={open?'M3 7.5 6 4.5 9 7.5':'M3 4.5 6 7.5 9 4.5'} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}
function reasonOf(turn) { return turn?.end?.data?.reason?.kind; }
function summaryOf(turn, control) {
  if (!turn) return '';
  const elapsedMs=turn.start && turn.end ? turn.end.time-turn.start.time : undefined;
  const steps=turn.steps?.map(step=>step.data?.get?.('assistant-step'));
  const thinkingCount=steps?.length && steps.every(Boolean) ? steps.filter(step=>step.blocks?.some(block=>block.kind==='reasoning'&&block.text?.trim())).length : undefined;
  const reason=reasonOf(turn);
  return formatTurnSummary({elapsedMs,thinkingCount,toolCount:control?.data?.toolCallCount,status:reason==='error'?'error':['aborted','interrupted'].includes(reason)?'interrupted':undefined});
}
function AttentionNode({ member, useChatNode, report }) {
  const message=useChatNode(member.key,processAttention);
  useEffect(()=>{ report(member.key,message); return ()=>report(member.key,''); },[member.key,message,report]);
  return null;
}
function AttentionGroup({ groupKey, useChatGroup, useChatNode, report }) {
  const members=useChatGroup(groupKey, group=>group?.members) ?? [];
  return members.map(member=><AttentionNode key={`${member.key}:${member.groupPart ?? ''}`} member={member} useChatNode={useChatNode} report={report}/>);
}
const EMPTY_INPUTS=Object.freeze([]), SINGLETONS=new WeakMap();
function singleton(entry) { let value=SINGLETONS.get(entry); if(!value){value=[entry];SINGLETONS.set(entry,value);} return value; }
function entryKey(entry) { return JSON.stringify([entry.kind,entry.key,entry.groupPart ?? null]); }
function NoRunningFlow({ NativeFlow, flow, entries, pendingInputs=EMPTY_INPUTS, usePresentation }) {
  return <NativeFlow {...flow} entries={entries} pendingInputs={pendingInputs} usePresentation={usePresentation ?? flow.usePresentation} slSuppressRunning/>;
}
function MessageSurface({ plan, flow, NativeFlow, store, author, inlinePresentation }) {
  const firstEntry=plan.groups[0], groupKey=firstEntry?.kind==='group' ? firstEntry.key : '';
  const groupTurn=flow.useChatGroup(groupKey,group=>group?.data.turn);
  const memberKey=flow.useChatGroup(groupKey,group=>group?.members?.[0]?.key);
  const firstKey=firstEntry?.kind==='node' ? firstEntry.key : memberKey ?? '';
  const groupNode=flow.useChatNode(firstKey);
  const responseNode=flow.useChatNode(plan.response?.key ?? '');
  const controlNode=flow.useChatNode(plan.control?.key ?? '');
  const [open,toggle]=useDisclosure(store,plan.turn);
  const [alerts,setAlerts]=useState(()=>new Map());
  const report=useCallback((key,message)=>setAlerts(previous=>{
    if ((previous.get(key) ?? '') === message) return previous;
    const next=new Map(previous); if(message)next.set(key,message);else next.delete(key);return next;
  }),[]);
  // A different/missing group is never attributed to a guessed turn.
  if (plan.groups.length && groupTurn !== undefined && groupTurn !== plan.turn) return <><NoRunningFlow NativeFlow={NativeFlow} flow={flow} entries={plan.groups}/>{plan.response && <NoRunningFlow NativeFlow={NativeFlow} flow={flow} entries={singleton(plan.response)}/>}</>;
  const turn=responseNode?.location?.turn ?? groupNode?.location?.turn ?? controlNode?.location?.turn;
  const running=turn?.status==='open' && plan.last;
  const summary=plan.last ? summaryOf(turn,controlNode) : '';
  const hasProcess=plan.groups.length>0;
  const heading=hasProcess ? <button type="button" className="sl-chat-process-toggle sl-heading-process" data-sl-running={running || undefined} aria-expanded={open} onClick={toggle}>{running ? <RunningLabel start={turn?.start?.time}/> : summary || '过程'}<Chevron open={open}/></button> : running ? <span className="sl-chat-process-toggle sl-heading-process" data-sl-running=""><RunningLabel start={turn?.start?.time}/></span> : summary ? <span className="sl-chat-process-toggle sl-heading-process">{summary}</span> : null;
  const key=plan.groups[0]?.key ?? plan.response?.key;
  return <div data-sl-native-message="" data-chat-turn={plan.turn} data-chat-flow-key={key} data-chat-anchor-key={`sl-native:${key}`} data-chat-paging-anchor="">
    {plan.first && plan.control && <span className="sl-native-anchor" aria-hidden="true" data-chat-node-key={plan.control.key} data-chat-anchor-key={`sl-control-node:${plan.control.key}`}/>}
    {firstKey && <span className="sl-native-anchor" aria-hidden="true" data-chat-node-key={firstKey} data-chat-anchor-key={`sl-process-node:${firstKey}`}/>}
    {plan.groups.filter(group=>group.kind==='group').map(group=><AttentionGroup key={group.key} groupKey={group.key} useChatGroup={flow.useChatGroup} useChatNode={flow.useChatNode} report={report}/>)}
    <MessageBubble author={author} heading={heading}>
      {hasProcess && <div hidden={!open} data-sl-native-process=""><NoRunningFlow NativeFlow={NativeFlow} flow={flow} entries={plan.groups} usePresentation={inlinePresentation}/></div>}
      {!open && alerts.size>0 && <button type="button" className="sl-process-attention" onClick={toggle} role="alert">{[...new Set(alerts.values())].join(' · ')} · 查看</button>}
      {plan.response ? <NoRunningFlow NativeFlow={NativeFlow} flow={flow} entries={singleton(plan.response)} usePresentation={inlinePresentation}/> : !open && (running ? <ThinkingDots/> : <span className="sl-chat-notice">{reasonOf(turn)==='error'?'执行失败':['aborted','interrupted'].includes(reasonOf(turn))?'已停止':'处理过程'}</span>)}
    </MessageBubble>
  </div>;
}
function ControlSurface({ plan, flow, NativeFlow, store, author }) {
  const node=flow.useChatNode(plan.entry.key), [open,toggle]=useDisclosure(store,plan.turn);
  if (!node || node.location?.turn?.status !== 'open') return <NoRunningFlow NativeFlow={NativeFlow} flow={flow} entries={singleton(plan.entry)}/>;
  const turn=node.location.turn;
  return <div data-chat-turn={plan.turn} data-chat-flow-kind="turn-process" data-chat-node-key={plan.entry.key} data-chat-flow-key={plan.entry.key} data-chat-anchor-key={`sl-control:${plan.entry.key}`}><MessageBubble author={author} heading={<button type="button" className="sl-chat-process-toggle sl-heading-process" data-sl-running="" aria-expanded={open} onClick={toggle}><RunningLabel start={turn.start?.time}/><Chevron open={open}/></button>}><ThinkingDots/></MessageBubble></div>;
}
function BubbleFlow({ NativeFlow, ...flow }) {
  const nodes=flow.useChat(snapshot=>snapshot.nodes);
  const session=flow.useSessions(snapshot=>snapshot.byId?.[flow.sessionId]);
  const identity=session?.projectionValues?.subagent;
  const author=session?.origin==='subagent'||identity?.mode ? identity?.label || '子智能体' : session?.title || '助手';
  const plans=useMemo(()=>planNativeFlow(flow.entries,nodes),[flow.entries,nodes]);
  const store=useMemo(()=>disclosureStore(),[flow.sessionId]);
  const inlinePresentation=useCallback(selector=>flow.usePresentation(policy=>selector(inlinePolicy(policy))),[flow.usePresentation]);
  let pending=flow.pendingInputs;
  const tail=flow.entries.at(-1), tailNode=tail?.kind==='node'?nodes.get(tail.key):undefined;
  const shouldPlaceBefore=tailNode?.kind==='turn-process' && tailNode.location?.kind==='turn' && tailNode.location.turn.status==='open' && tailNode.location.turn.turn!==flow.lastInputTurn;
  let early=null;
  if (shouldPlaceBefore) {
    const at=pending.findIndex(item=>'requestId' in item && item.placement==='transcript');
    if(at!==-1){early=pending[at];pending=pending.filter((_,index)=>index!==at);}
  }
  const rows=[];
  for (const plan of plans) {
    if (plan.kind==='native') {
      // Each original root entry keeps its own React parent/key. Grouping a
      // whole plain run by its first entry remounts that run on history prepend
      // and invalidates the Host's retained DOM paging anchor.
      for (const entry of plan.entries) rows.push(<NoRunningFlow key={`native:${entryKey(entry)}`} NativeFlow={NativeFlow} flow={flow} entries={singleton(entry)}/>);
      continue;
    }
    const key=plan.kind==='control' ? `control:${plan.entry.key}` : `message:${entryKey(plan.groups[0] ?? plan.response)}`;
    if (early && plan.kind==='control' && plan.entry.key===tail?.key) rows.push(<NoRunningFlow key={`echo:${early.requestId}`} NativeFlow={NativeFlow} flow={flow} entries={EMPTY_INPUTS} pendingInputs={[early]}/>);
    rows.push(plan.kind==='control' ? <ControlSurface key={key} plan={plan} flow={flow} NativeFlow={NativeFlow} store={store} author={author}/> : <MessageSurface key={key} plan={plan} flow={flow} NativeFlow={NativeFlow} store={store} author={author} inlinePresentation={inlinePresentation}/>);
  }
  // If an unexpected projection removed the opening controller, show its echo
  // at the tail rather than silently losing it.
  if (early && !plans.some(plan=>plan.kind==='control' && plan.entry.key===tail?.key)) pending=[early,...pending];
  return <>{rows}<NativeFlow {...flow} entries={EMPTY_INPUTS} pendingInputs={pending}/></>;
}
export function NativeFlowAdapter({ NativeFlow, ...flow }) {
  const mode=useDisplayMode();
  return mode==='card' ? <NativeFlow {...flow}/> : <BubbleFlow NativeFlow={NativeFlow} {...flow}/>;
}
export function installNativeFlowAdapter(ctx, onAvailability = () => {}) {
  // The Host owns this optional child slot. No flow props or callbacks are
  // installed on the browser global; when absent, the Host renders natively.
  return ctx.slots.inject(FLOW_SLOT,()=>{
    const stop=ctx.slots.register({name:FLOW_SLOT,priority:-5},NativeFlowAdapter);
    onAvailability(true);
    return ()=>{ stop(); onAvailability(false); };
  });
}
