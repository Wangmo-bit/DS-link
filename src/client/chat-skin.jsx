// A real React rendering layer, not DOM mutation. The public Slot ledger keeps
// the native renderer below us; forwarding its props and inject face preserves
// Host images, references, process disclosures, actions and safe fallback.
import React, { useEffect, useState } from 'react';
import { MessageBubble, MessageText, ThinkingDots, MARKDOWN_LABELS } from './chat-ui.jsx';
import { formatTurnSummary } from './chat-skin-model.mjs';
import css from './chat-skin.css';
import { ImageHandoffContext, imageHandoffFor, installStableUserImages } from './image-skin.jsx';
import { getDisplayMode, subscribeDisplayMode } from './display-mode.mjs';
import { installNativeFlowAdapter } from './native-flow.jsx';

export function createUserSkin(Native) {
  return function UserSkin(props) {
    const originalFactory = props.renderFactorySlot;
    const renderFactorySlot = (name, input, ...rest) => {
      if (name !== 'conversation.chat.user.content') return originalFactory(name, input, ...rest);
      const content = input.content;
      const attachments = content.attachments ?? [];
      const extra = content.extraBlocks ?? [];
      const labels = content.referenceLabels ?? [];
      const hasText = Boolean(content.text || extra.length || labels.length);
      const source = props.node?.data?.source;
      const handoff = source?.kind === 'user' ? imageHandoffFor(props.slImageSession, source.rpcId, attachments) : null;
      // Render Host-authorized images/files separately from the text bubble.
      // The original renderer still owns image preview, file references, copy,
      // time and errors; no attachment is duplicated or read a second time.
      return <div className="sl-chat-user-content">
        {attachments.length > 0 && <div className="sl-user-attachments"><ImageHandoffContext.Provider value={handoff}>{originalFactory(name, { ...input, content: { ...content, text: '', attachments, extraBlocks: [], referenceLabels: [] } }, ...rest)}</ImageHandoffContext.Provider></div>}
        {hasText && <div className="sl-user-bubble" data-sl-bubble="">{originalFactory(name, { ...input, content: { ...content, attachments: [] } }, ...rest)}</div>}
      </div>;
    };
    return <article className="sl-chat-message sl-chat-message--sent sl-chat-user" data-sl-message="">
      <header className="sl-chat-author" data-sl-author="">王墨</header>
      <div className="sl-native-user"><Native {...props} renderFactorySlot={renderFactorySlot}/></div>
    </article>;
  };
}

const EMPTY_ROWS = Object.freeze([]);
const EMPTY_SOURCE = Object.freeze({ getSnapshot: () => EMPTY_ROWS, subscribe: () => () => {} });
const TOOL_LABEL = Object.freeze({ bash: '运行命令', read: '读取文件', read_image: '读取图片', grep: '搜索内容', glob: '查找文件', edit: '编辑文件', write: '写入文件', web_search: '搜索网页', web_fetch: '读取网页' });

function RunningLabel({ startTime }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!Number.isFinite(startTime)) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startTime]);
  if (!Number.isFinite(startTime)) return '思考中…';
  const seconds = Math.max(0, Math.floor((now - startTime) / 1000));
  return `思考中 · ${seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`}`;
}

function ProcessDetails({ steps, tools, renderFactorySlot, inspectCall, turnProcess, onRevealOriginal, originalVisible }) {
  const rows = [];
  for (const step of steps) {
    for (const [index, block] of (step.blocks ?? []).entries()) {
      if (block.kind === 'reasoning' && block.text?.trim()) rows.push({ key: `thinking:${step.step}:${index}`, step: step.step ?? 0, time: step.time, order: 0, text: block.text });
    }
  }
  for (const data of tools) {
    const root = data.root;
    if (root) rows.push({ key: `tool:${root.callId}`, step: root.step, time: root.callTime ?? root.time, order: 1, root });
  }
  rows.sort((a, b) => Number.isFinite(a.time) && Number.isFinite(b.time) ? a.time - b.time || a.order - b.order : (a.step ?? 0) - (b.step ?? 0) || a.order - b.order);
  return <div className="sl-inline-process" aria-label="思考与工具过程">
    {rows.map(row => row.text !== undefined
      ? <details key={row.key}><summary>思考过程</summary>{renderFactorySlot('conversation.chat.reasoning.content', { text: row.text, running: false, labels: MARKDOWN_LABELS })}</details>
      : <div className="sl-inline-tool" key={row.key}><span>{TOOL_LABEL[row.root.name] || row.root.name || '工具'}</span>
        <span>{row.root.kind === 'tool-result' ? row.root.isError ? '失败' : '已完成' : '进行中'}</span>
        {inspectCall && <button type="button" onClick={() => inspectCall(row.root.callId)}>查看详情</button>}</div>)}
    {onRevealOriginal ? <button type="button" className="sl-chat-more" onClick={onRevealOriginal}>{originalVisible ? '收起原有过程' : '查看原有过程'}</button>
      : turnProcess?.foldable && turnProcess.hasContent && <button type="button" className="sl-chat-more" onClick={() => turnProcess.setOpen(!turnProcess.open)}>{turnProcess.open ? '收起原有过程' : '查看原有过程'}</button>}
    {!rows.length && <span className="sl-chat-notice">过程详情暂不可用</span>}
  </div>;
}

// Only the opened disclosure subscribes to the turn-wide arrays. In long
// conversations each hidden reasoning step is a mounted Host seat; subscribing
// from every one multiplies every stream update by the number of old steps.
function SubscribedProcessDetails({ turnId, useTurnSteps, useTurnTools, ...props }) {
  const steps = useTurnSteps?.(String(turnId)) ?? EMPTY_ROWS;
  const tools = useTurnTools?.(String(turnId)) ?? EMPTY_ROWS;
  return <ProcessDetails {...props} steps={steps} tools={tools}/>;
}

function ProcessAnswer({ author, summary, running, startTime, process, turnId, useTurnSteps, useTurnTools, renderFactorySlot, inspectCall, children }) {
  const [processOpen, setProcessOpen] = useState(false);
  const heading = <button type="button" className="sl-chat-process-toggle sl-heading-process" data-sl-running={running || undefined} aria-expanded={processOpen} onClick={() => setProcessOpen(value => !value)}>{running ? <RunningLabel startTime={startTime}/> : summary || '已完成'} <span className="sl-process-chevron" aria-hidden="true">{processOpen ? '⌃' : '⌄'}</span></button>;
  return <MessageBubble author={author} heading={heading}>
    {processOpen && <SubscribedProcessDetails turnId={turnId} useTurnSteps={useTurnSteps} useTurnTools={useTurnTools} renderFactorySlot={renderFactorySlot} inspectCall={inspectCall} turnProcess={process}/>}
    {children}
  </MessageBubble>;
}

export function createAssistantSkin() {
  return function AssistantSkin(props) {
    const data = props.node.data;
    const blocks = data.blocks ?? [];
    const tail = props.useTurnData?.('turn-tail');
    const turn = props.node.location?.turn;
    const owner = turn?.status === 'closed' && data.finalNode && tail?.closing?.finalNode?.seq === data.finalNode.seq ? { turn, seq: data.finalNode.seq, openFile: props.openFile } : undefined;
    const mentions = owner ? props.fileMentions?.(owner) : undefined;
    const running = data.status === 'running';
    const reasoning = props.groupPart === 'response' ? '' : blocks.filter(block => block.kind === 'reasoning').map(block => block.text).join('\n\n');
    const visible = props.groupPart === 'reasoning' ? [] : blocks.filter(block => block.kind !== 'reasoning' && block.kind !== 'tool-call');
    const content = visible.filter(block => block.kind !== 'text' || block.text.trim());
    const thinking = reasoning ? <details className="sl-chat-reasoning"><summary>{running ? '思考中' : '思考过程'}</summary>{props.renderFactorySlot('conversation.chat.reasoning.content', { text: reasoning, running, labels: MARKDOWN_LABELS })}</details> : null;
    if (props.groupPart === 'reasoning') return thinking;
    const process = props.turnProcess;
    const spec = process?.spec;
    // The turn-process seat owns the live placeholder until text arrives;
    // then the latest response owns the one status line. No extra turn-wide
    // subscription is attached to ordinary or hidden assistant steps.
    const latestStep = turn?.steps?.at(-1)?.step ?? data.step;
    const ownsProcess = Boolean(process && (turn?.status === 'closed' && spec?.answerStep === data.step || running && data.step === latestStep));
    if (!content.length) return thinking || (running && !process ? <div className="sl-chat-process" role="status">思考中</div> : null);
    const body = <>
      {!ownsProcess && thinking}
      {running && !process && !thinking && <div className="sl-chat-process" role="status">思考中</div>}
      {content.map((block, index) => block.kind === 'text'
        ? <MessageText key={index} text={block.text} streaming={running} mentions={mentions}/>
        : block.kind === 'image'
          ? <React.Fragment key={index}>{props.renderFactorySlot('conversation.images.content', { images: [{ attachment: block.attachment }], loadImage: props.loadImage, align: 'start' })}</React.Fragment>
          : <pre key={index}>{JSON.stringify(block.block ?? block, null, 2)}</pre>)}
      {data.status === 'interrupted' && <span className="sl-chat-notice">已停止</span>}
    </>;
    if (!ownsProcess) return <MessageBubble author={props.skinAuthor || '助手'}>{body}</MessageBubble>;
    const elapsedMs = turn?.start && turn?.end ? turn.end.time - turn.start.time : undefined;
    const completeSteps = turn?.steps?.map(step => step.data?.get?.('assistant-step'));
    const thinkingCount = completeSteps?.length && completeSteps.every(Boolean) ? completeSteps.filter(step => step.blocks?.some(block => block.kind === 'reasoning' && block.text?.trim())).length : undefined;
    const reason = turn?.end?.data?.reason?.kind;
    const summary = formatTurnSummary({ running, elapsedMs, thinkingCount, toolCount: spec?.toolCallCount, status: reason === 'error' ? 'error' : ['aborted', 'interrupted'].includes(reason) ? 'interrupted' : undefined });
    return <ProcessAnswer author={props.skinAuthor || '助手'} summary={summary} running={running} startTime={turn?.start?.time} process={process} turnId={data.turn} useTurnSteps={props.useTurnSteps} useTurnTools={props.useTurnTools} renderFactorySlot={props.renderFactorySlot} inspectCall={props.inspectCall}>{body}</ProcessAnswer>;
  };
}

function LiveProcessView({ node, skinAuthor, useTurnSteps, useTurnTools, renderFactorySlot, inspectCall }) {
  const [liveOpen, setLiveOpen] = useState(false);
  const [originalVisible, setOriginalVisible] = useState(false);
  const steps = useTurnSteps?.(String(node.data.turn)) ?? EMPTY_ROWS;
  const latest = steps.reduce((best, step) => !best || step.step > best.step ? step : best, null);
  // The response's own bubble takes over as soon as it has visible content;
  // avoid showing a separate live placeholder alongside a streaming answer.
  const lastTurnStep = node.location?.turn?.steps?.at(-1)?.step;
  const answering = latest?.status === 'running' && (lastTurnStep === undefined || latest.step === lastTurnStep) && latest.blocks?.some(block => block.kind !== 'reasoning' && block.kind !== 'tool-call' && (block.kind !== 'text' || block.text?.trim()));
  if (answering) return null;
    // Hide only completed, demonstrably non-interactive native summaries.
    // A pending/failed/unrecognized tool, question or approval keeps its
    // original group on screen. The original process remains one click away.
    const id = node.data.turn;
    const hideNative = steps.length > 0 && !originalVisible && Number.isSafeInteger(id);
    const base = `[data-slot="conversation.chat.flow"]:has([data-sl-live-process="${id}"]) [data-step-process][data-chat-turn="${id}"]`;
    const critical = '[role="alert"],[data-state]:not([data-state="ok"]),[data-approval],[data-user-question],[data-tool="ask_user_question"],[data-tool="exit_plan_mode"],[data-chat-flow-kind="question-reply"]';
    const style = hideNative ? `${base}:has([data-state="ok"]):not(:has(${critical})),${base}:not(:has([data-chat-flow-kind="tool-call"],${critical})){display:none}` : '';
    const heading = <button type="button" className="sl-chat-process-toggle sl-heading-process" data-sl-running="" aria-expanded={liveOpen} onClick={() => setLiveOpen(value => !value)}><RunningLabel startTime={node.location?.turn?.start?.time}/> <span className="sl-process-chevron" aria-hidden="true">{liveOpen ? '⌃' : '⌄'}</span></button>;
    return <div data-sl-live-process={id}>{style && <style>{style}</style>}<MessageBubble author={skinAuthor || '助手'} heading={heading}>
      {liveOpen ? <SubscribedProcessDetails turnId={id} useTurnSteps={useTurnSteps} useTurnTools={useTurnTools} renderFactorySlot={renderFactorySlot} inspectCall={inspectCall} onRevealOriginal={() => setOriginalVisible(value => !value)} originalVisible={originalVisible}/> : <ThinkingDots/>}
    </MessageBubble></div>;
}

export function TurnProcessSkin(props) {
  const { node, turnProcess } = props;
  const turn = node.location?.turn;
  if (!turn) return null;
  if (turn.status !== 'closed') return <LiveProcessView {...props}/>;
  // An answer carries the same control beside its author. Keep only this
  // marker in the old position so the same statistics are not shown twice.
  if (node.data.answerStep != null && node.data.answerAnchorSeq != null) return <span data-sl-process-relocated=""/>;
  const reason = turn.end?.data?.reason?.kind;
  const elapsedMs = turn.start && turn.end ? turn.end.time - turn.start.time : undefined;
  const stepData = turn.steps?.map(step => step.data?.get?.('assistant-step'));
  // messageCount counts assistant messages, not reasoning. Only count real
  // reasoning-bearing steps, and omit the count when history is incomplete.
  const thinkingCount = stepData?.length && stepData.every(Boolean) ? stepData.filter(step => step.blocks?.some(block => block.kind === 'reasoning' && block.text?.trim())).length : undefined;
  const summary = formatTurnSummary({ elapsedMs, thinkingCount, toolCount: node.data.toolCallCount, status: reason === 'error' ? 'error' : ['aborted', 'interrupted'].includes(reason) ? 'interrupted' : undefined });
  const open = !turnProcess?.foldable || turnProcess.open;
  const canToggle = turnProcess?.foldable && turnProcess.hasContent;
  return <div className="sl-chat-process"><span className="sl-chat-sr-only" role="status" aria-live="polite">{reason === 'error' ? '执行失败' : ['aborted', 'interrupted'].includes(reason) ? '已停止' : '已完成'}</span><button type="button" className="sl-chat-process-toggle" data-open={open || undefined} data-turn-process={node.data.turn} data-turn-process-messages={node.data.messageCount} data-turn-process-tool-calls={node.data.toolCallCount} aria-expanded={canToggle ? open : undefined} disabled={!canToggle} onClick={() => turnProcess.setOpen(!open)}>{summary || '已完成'}{canToggle && <span aria-hidden="true"> {open ? '⌃' : '⌄'}</span>}</button></div>;
}

export function installChatSkin(ctx) {
  installStableUserImages(ctx);
  let bridgeAvailable=false, refreshNodeSkins=()=>{};
  installNativeFlowAdapter(ctx, available=>{bridgeAvailable=available;refreshNodeSkins();});
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = 'session-link-chat-skin';
    style.textContent = css;
    document.head.append(style);
    const sync = () => document.documentElement?.toggleAttribute('data-sl-card-mode', getDisplayMode() === 'card');
    sync();
    const off = subscribeDisplayMode(sync);
    return () => { off(); document.documentElement?.removeAttribute('data-sl-card-mode'); style.remove(); };
  });
  // Wait for native renderers as well as the keyed seat. The chat flow is
  // declared after the business renderers have registered on the current SDK.
  ctx.slots.inject('conversation.chat.flow', () => {
    let stops = [];
    const disable = () => { for (const stop of stops.splice(0).reverse()) stop(); };
    const enable = () => {
    const entries = ctx.slots.entries('conversation.chat.node');
    try {
      const keys = bridgeAvailable
        ? [['user', createUserSkin], ['steering', createUserSkin]]
        : [['user', createUserSkin], ['steering', createUserSkin], ['assistant-step', createAssistantSkin], ['turn-process', () => TurnProcessSkin]];
      for (const [key, make] of keys) {
        const matching = entries.filter(entry => entry.options.key === key);
        const official = matching.filter(entry => String(entry.registrant ?? '').includes('@deepseek-ai/dsh-client-ui-chat'));
        // Wrap the official renderer, never borrow a peer plugin's private
        // presentation contract. Dynamic Host facades may assign precedence
        // by registration order rather than the static priority below.
        const native = (official.length ? official : matching).sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))[0];
        if (!native) continue;
        const originalInject = native.inject;
        const options = {
          name: 'conversation.chat.node', key, priority: (native.options.priority ?? 0) - 5, locale: native.locale || 'chat',
          inject: (...args) => {
            const base = typeof originalInject === 'function' ? originalInject(...args) : {};
            const id = args[0];
            const session = id ? ctx.sessions.list.getSnapshot().byId?.[id] : undefined;
            const identity = session?.projectionValues?.subagent;
            const title = session?.origin === 'subagent' || identity?.mode
              ? identity?.label || '子智能体'
              : session?.title || '助手';
            let binding;
            try { binding = ctx.sessions.binding?.(id); } catch { /* Session may not be retained yet. */ }
            if (key !== 'assistant-step' && key !== 'turn-process') return { ...base, skinAuthor: title, slImageSession: binding?.session };
            let chat;
            try { if (binding) chat = ctx.uiConversation?.binding(binding).target('chat'); } catch { /* No current chat binding: keep original fallback. */ }
            const source = kind => turnId => chat?.getSnapshot()?.nodes?.turnDataSource(Number(turnId), kind) ?? EMPTY_SOURCE;
            return { ...base, skinAuthor: title, keyedHooks: { ...base.keyedHooks, turnSteps: source('assistant-step'), turnTools: source('tool-call') } };
          },
        };
        stops.push(ctx.slots.register(options, make(native.component)));
      }
    } catch (error) {
      disable();
      throw error;
    }
    };
    const sync = () => { if (getDisplayMode() === 'card') disable(); else if (!stops.length) enable(); };
    const refresh = () => { disable(); sync(); };
    refreshNodeSkins = refresh;
    sync();
    const off = subscribeDisplayMode(sync);
    return () => { off(); if (refreshNodeSkins === refresh) refreshNodeSkins = () => {}; disable(); };
  });
}
