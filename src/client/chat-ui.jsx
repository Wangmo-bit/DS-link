// Shared message surfaces for native chat, relays and the exchange reader.
// Interaction model follows DS-Bot; Host Markdown/image/action capabilities
// remain authoritative. No HTML strings or private Host state are used.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives';
import { createExchangePager, readExchangePage } from './exchange-page.mjs';
import { callApi, visibleMessageState, textOf } from './model.js';

export const MARKDOWN_LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' };

export function MessageText({ text = '', streaming = false, mentions }) {
  // Agent messages are for reading, not previews: never trim them based on
  // length, whether this is the main transcript, a relay or the exchange.
  return <div className="sl-chat-text" data-i18n-skip="">
    <MarkdownText text={text} streaming={streaming} variant="compact" labels={MARKDOWN_LABELS} fileMentions={mentions}/>
  </div>;
}

export function ThinkingDots() {
  return <span className="sl-chat-thinking-dots" aria-hidden="true"><span>·</span><span>·</span><span>·</span></span>;
}

export function MessageBubble({ author, direction = 'received', text, children, time, status, streaming, mentions, actions, quote, selected, heading, bodyless = false }) {
  return <article className={`sl-chat-message sl-chat-message--${direction}`} data-sl-message="" data-selected={selected || undefined} aria-current={selected ? 'true' : undefined} data-sl-bodyless={bodyless || undefined}>
    <header className="sl-chat-heading"><span className="sl-chat-author" data-sl-author="" data-i18n-skip="">{author || '会话消息'}</span>{heading}</header>
    {bodyless ? null : <div className="sl-chat-bubble" data-sl-bubble="">
      {quote && <blockquote className="sl-chat-quote" data-i18n-skip="">{quote}</blockquote>}
      {children}
      {typeof text === 'string' && text !== '' && <MessageText text={text} streaming={streaming} mentions={mentions}/>}
    </div>}
    {(time || status || actions) && <footer className="sl-chat-meta">{status && <span>{status}</span>}{time && <time dateTime={new Date(time).toISOString()}>{new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>}{actions}</footer>}
  </article>;
}

export function CopyMessage({ text }) {
  const [state, setState] = useState('idle');
  const timer = useRef();
  useEffect(() => () => clearTimeout(timer.current), []);
  const label = state === 'copied' ? '已复制' : state === 'error' ? '复制失败，请重试' : '复制消息';
  return <button type="button" className="sl-chat-copy" aria-label={label} title={label} onClick={async () => {
    try { await navigator.clipboard.writeText(text); setState('copied'); }
    catch { setState('error'); }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1500);
  }}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true" focusable="false"><rect x="1.5" y="4" width="10.4" height="10.4" rx="2"/><path d="M5 1.5h5a2.5 2.5 0 0 1 2.5 2.5v6"/></svg>{state !== 'idle' && <span className="sl-chat-sr-only" role="status">{label}</span>}</button>;
}

export function ExchangeDialog({ selfId, peerId, selfName, peerName, onClose }) {
  const dialog = useRef(null);
  const scroller = useRef(null);
  const [messages, setMessages] = useState([]);
  const pager = useRef(createExchangePager(selfId, peerId));
  const pendingAnchor = useRef(null);
  const generation = useRef(0);
  const appliedPage = useRef(-1);
  const [pageNumber, setPageNumber] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [changed, setChanged] = useState(false);
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
    const current = ++generation.current;
    setBusy(true); setError(''); setChanged(false);
    const query = ({ from, to, offset, limit, signal }) => callApi('snapshot', { view: 'records', senderSessionId: from, receiverSessionId: to, limit, offset }, { signal });
    readExchangePage(pager.current, query, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted || generation.current !== current) return;
      pager.current = result.pager;
      appliedPage.current = pageNumber;
      setMessages(previous => pageNumber === 0 ? result.messages : [...result.messages, ...previous]);
      setHasMore(result.hasMore);
    }).catch(failure => {
      if (controller.signal.aborted || generation.current !== current || failure.name === 'AbortError') return;
      setChanged(failure.code === 'exchange_changed');
      setError(failure.code === 'exchange_changed' ? '记录已更新，请重新载入。' : '往返消息读取失败，请重试。');
    }).finally(() => { if (!controller.signal.aborted && generation.current === current) setBusy(false); });
    return () => controller.abort();
  }, [selfId, peerId, pageNumber, retry]);
  useLayoutEffect(() => {
    const root = scroller.current;
    if (!root || busy || appliedPage.current !== pageNumber) return;
    let frame;
    if (pageNumber === 0) root.scrollTop = root.scrollHeight;
    else if (pendingAnchor.current?.node?.isConnected) {
      // The Host and browser may both perform anchoring. First correct based
      // on the actual visible row, then re-check once after browser layout.
      const anchor = pendingAnchor.current;
      const correct = () => { if (root.isConnected && anchor.node.isConnected) root.scrollTop += anchor.node.getBoundingClientRect().top - anchor.top; };
      correct();
      frame = requestAnimationFrame(correct);
    }
    pendingAnchor.current = null;
    return () => { if (frame !== undefined) cancelAnimationFrame(frame); };
  }, [messages, busy, pageNumber]);
  const loadOlder = () => {
    if (busy || !hasMore) return;
    const root = scroller.current;
    const rect = root?.getBoundingClientRect();
    const anchor = root && rect && [...root.querySelectorAll('[data-sl-message]')].find(node => node.getBoundingClientRect().bottom > rect.top);
    pendingAnchor.current = anchor ? { node: anchor, top: anchor.getBoundingClientRect().top } : null;
    setPageNumber(value => value + 1);
  };
  const retryLoad = () => {
    if (changed) { pager.current = createExchangePager(selfId, peerId); setMessages([]); setPageNumber(0); }
    setRetry(value => value + 1);
  };
  return <dialog ref={dialog} className="sl-exchange-dialog" aria-label={`${selfName}与${peerName}的往返消息`} onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="sl-exchange-frame">
      <header className="sl-exchange-head"><h2>{selfName} <span aria-hidden="true">⇄</span> {peerName}</h2><button type="button" className="sl-chat-close" onClick={onClose} aria-label="关闭往返消息">关闭</button></header>
      <div className="sl-exchange-scroll" ref={scroller}>
        {hasMore && <div className="sl-exchange-older"><button className="sl-exchange-older-button" type="button" disabled={busy} onClick={loadOlder}>查看更早的消息</button></div>}
        {busy && <p className="sl-chat-notice" role="status">正在读取往返消息…</p>}
        {error && <p className="sl-chat-error" role="alert">{error} <button type="button" onClick={retryLoad}>{changed ? '重新载入' : '重试'}</button></p>}
        {!busy && !error && !messages.length && <p className="sl-chat-notice">还没有往返消息。</p>}
        {messages.map(message => {
          const sent = message.from === selfId;
          const parent = messages.find(item => item.id === message.parentMessageId);
          return <MessageBubble key={message.id} author={message.fromTitle || (sent ? selfName : peerName)} direction={sent ? 'sent' : 'received'} text={textOf(message) || '这条消息的正文已清理。'} time={message.createdAt} status={visibleMessageState(message)} quote={parent ? `${parent.fromTitle || '回复'}：${textOf(parent).slice(0, 160)}` : undefined} actions={<CopyMessage text={textOf(message)}/>}/>;
        })}
      </div>
    </div>
  </dialog>;
}

export function ExchangeLink({ selfId, peerId, selfName, peerName, children, className = '', title }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className={`sl-exchange-link ${className}`} title={title} onClick={() => setOpen(true)}>{children}</button>{open && <ExchangeDialog selfId={selfId} peerId={peerId} selfName={selfName} peerName={peerName} onClose={() => setOpen(false)}/>}</>;
}
