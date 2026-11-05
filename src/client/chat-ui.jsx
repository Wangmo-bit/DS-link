// Shared message surfaces for native chat, relays and the exchange reader.
// Interaction model follows DS-Bot; Host Markdown/image/action capabilities
// remain authoritative. No HTML strings or private Host state are used.
import React, { useEffect, useRef, useState } from 'react';
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives';
import { getFoldState } from './chat-skin-model.mjs';
import { callApi, messageState, textOf } from './model.js';

export const MARKDOWN_LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' };

export function MessageText({ text = '', streaming = false, mentions }) {
  const [expanded, setExpanded] = useState(false);
  const fold = getFoldState(text, { expanded, streaming });
  return <>
    <div className="sl-chat-text" data-i18n-skip="" data-folded={fold.folded || undefined}>
      <MarkdownText text={fold.folded ? fold.preview : text} streaming={streaming} variant="compact" labels={MARKDOWN_LABELS} fileMentions={mentions}/>
    </div>
    {fold.shouldFold && !streaming && <button type="button" className="sl-chat-more" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : `显示全部 · ${fold.totalChars.toLocaleString()} 字`}</button>}
  </>;
}

export function MessageBubble({ author, direction = 'received', text, children, time, status, streaming, mentions, actions, quote, selected }) {
  return <article className={`sl-chat-message sl-chat-message--${direction}`} data-sl-message="" data-selected={selected || undefined} aria-current={selected ? 'true' : undefined}>
    <header className="sl-chat-author" data-sl-author="" data-i18n-skip="">{author || '会话消息'}</header>
    <div className="sl-chat-bubble" data-sl-bubble="">
      {quote && <blockquote className="sl-chat-quote" data-i18n-skip="">{quote}</blockquote>}
      {children}
      {typeof text === 'string' && text !== '' && <MessageText text={text} streaming={streaming} mentions={mentions}/>}
    </div>
    {(time || status || actions) && <footer className="sl-chat-meta">{status && <span>{status}</span>}{time && <time dateTime={new Date(time).toISOString()}>{new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>}{actions}</footer>}
  </article>;
}

export function CopyMessage({ text }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef();
  useEffect(() => () => clearTimeout(timer.current), []);
  return <button type="button" className="sl-chat-copy" aria-label={copied ? '已复制' : '复制消息'} onClick={async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch { setCopied(false); }
  }}>{copied ? '已复制' : '复制'}</button>;
}

export function ExchangeDialog({ selfId, peerId, selfName, peerName, onClose }) {
  const dialog = useRef(null);
  const scroller = useRef(null);
  const [messages, setMessages] = useState([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    element?.showModal();
    // Capture before the Host's conversation shortcuts: Escape closes this
    // reader, it must not escape through to the active chat or stop a turn.
    const key = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); onClose(); } };
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('keydown', key, true); element?.close(); if (previous?.isConnected) previous.focus?.(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    setBusy(true); setError('');
    const query = (from, to) => callApi('snapshot', { view: 'records', senderSessionId: from, receiverSessionId: to, limit: 50, offset }, { signal: controller.signal });
    Promise.all([query(selfId, peerId), query(peerId, selfId)]).then(pages => {
      if (!alive) return;
      const incoming = pages.flatMap(page => page.messages ?? []);
      setMessages(previous => [...new Map([...(offset === 0 ? [] : previous), ...incoming].map(message => [message.id, message])).values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)));
      setHasMore(pages.some(page => page.hasMore));
      if (offset === 0) requestAnimationFrame(() => { if (alive && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; });
    }).catch(failure => { if (alive && failure.name !== 'AbortError') setError('往返消息读取失败，请重试。'); }).finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; controller.abort(); };
  }, [selfId, peerId, offset, retry]);
  return <dialog ref={dialog} className="sl-exchange-dialog" aria-label={`${selfName}与${peerName}的往返消息`} onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="sl-exchange-frame">
      <header className="sl-exchange-head"><h2>{selfName} <span aria-hidden="true">⇄</span> {peerName}</h2><button type="button" className="sl-chat-close" onClick={onClose} aria-label="关闭往返消息">关闭</button></header>
      <div className="sl-exchange-scroll" ref={scroller}>
        {hasMore && <button className="sl-chat-more" type="button" disabled={busy} onClick={() => setOffset(value => value + 50)}>查看更早的消息</button>}
        {busy && <p className="sl-chat-notice" role="status">正在读取往返消息…</p>}
        {error && <p className="sl-chat-error" role="alert">{error} <button type="button" onClick={() => setRetry(value => value + 1)}>重试</button></p>}
        {!busy && !error && !messages.length && <p className="sl-chat-notice">还没有往返消息。</p>}
        {messages.map(message => {
          const sent = message.from === selfId;
          const parent = messages.find(item => item.id === message.parentMessageId);
          return <MessageBubble key={message.id} author={message.fromTitle || (sent ? selfName : peerName)} direction={sent ? 'sent' : 'received'} text={textOf(message) || '这条消息的正文已清理。'} time={message.createdAt} status={messageState(message)} quote={parent ? `${parent.fromTitle || '回复'}：${textOf(parent).slice(0, 160)}` : undefined} actions={<CopyMessage text={textOf(message)}/>}/>;
        })}
      </div>
    </div>
  </dialog>;
}

export function ExchangeLink({ selfId, peerId, selfName, peerName, children, className = '' }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className={`sl-exchange-link ${className}`} onClick={() => setOpen(true)}>{children}</button>{open && <ExchangeDialog selfId={selfId} peerId={peerId} selfName={selfName} peerName={peerName} onClose={() => setOpen(false)}/>}</>;
}
