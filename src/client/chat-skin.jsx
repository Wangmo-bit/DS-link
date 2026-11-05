// A real React rendering layer, not DOM mutation. The public Slot ledger keeps
// the native renderer below us; forwarding its props and inject face preserves
// Host images, references, process disclosures, actions and safe fallback.
import React, { useState } from 'react';
import { MessageBubble, MessageText, MARKDOWN_LABELS } from './chat-ui.jsx';
import { getFoldState, formatTurnSummary } from './chat-skin-model.mjs';
import css from './chat-skin.css';

export function createUserSkin(Native) {
  return function UserSkin(props) {
    const [expanded, setExpanded] = useState(false);
    let fold;
    const originalFactory = props.renderFactorySlot;
    const renderFactorySlot = (name, input, ...rest) => {
      if (name !== 'conversation.chat.user.content') return originalFactory(name, input, ...rest);
      fold = getFoldState(input.content.text, { expanded });
      return <div className="sl-chat-user-content">
        {originalFactory(name, { ...input, content: { ...input.content, text: fold.preview } }, ...rest)}
        {fold.shouldFold && <button type="button" className="sl-chat-more" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : `显示全部 · ${fold.totalChars.toLocaleString()} 字`}</button>}
      </div>;
    };
    return <MessageBubble author="王墨" direction="sent"><div className="sl-native-user"><Native {...props} renderFactorySlot={renderFactorySlot}/></div></MessageBubble>;
  };
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
    if (!content.length) return <>{running && !thinking && <div className="sl-chat-process" role="status">思考中</div>}{thinking}</>;
    return <MessageBubble author={props.skinAuthor || '助手'}>
      {thinking}
      {running && !thinking && <div className="sl-chat-process" role="status">思考中</div>}
      {content.map((block, index) => block.kind === 'text'
        ? <MessageText key={index} text={block.text} streaming={running} mentions={mentions}/>
        : block.kind === 'image'
          ? <React.Fragment key={index}>{props.renderFactorySlot('conversation.images.content', { images: [{ attachment: block.attachment }], loadImage: props.loadImage, align: 'start' })}</React.Fragment>
          : <pre key={index}>{JSON.stringify(block.block ?? block, null, 2)}</pre>)}
      {data.status === 'interrupted' && <span className="sl-chat-notice">已停止</span>}
    </MessageBubble>;
  };
}

export function TurnProcessSkin({ node, turnProcess }) {
  const turn = node.location?.turn;
  if (turn?.status !== 'closed') return null;
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
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = 'session-link-chat-skin';
    style.textContent = css;
    document.head.append(style);
    return () => style.remove();
  });
  // Wait for native renderers as well as the keyed seat. The chat flow is
  // declared after the business renderers have registered on the current SDK.
  ctx.slots.inject('conversation.chat.flow', () => {
    const stops = [];
    const entries = ctx.slots.entries('conversation.chat.node');
    try {
      for (const [key, make] of [['user', createUserSkin], ['steering', createUserSkin], ['assistant-step', createAssistantSkin], ['turn-process', () => TurnProcessSkin]]) {
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
            const title = id ? ctx.sessions.list.getSnapshot().byId?.[id]?.title : undefined;
            return { ...base, skinAuthor: title || '助手' };
          },
        };
        stops.push(ctx.slots.register(options, make(native.component)));
      }
    } catch (error) {
      for (const stop of stops.reverse()) stop();
      throw error;
    }
    return () => { for (const stop of stops.reverse()) stop(); };
  });
}
