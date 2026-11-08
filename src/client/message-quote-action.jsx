// `conversation.chat.assistant-actions` entry: one-click quote in the Host's
// native assistant action strip, next to copy / rating / branch. Bubble mode
// only; card mode keeps its untouched native strip.
import React from 'react';
import { useDisplayMode } from './display-mode.mjs';
import { clipQuote, closingQuoteText } from './message-quote.mjs';

const QUOTE_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z" fill="currentColor"/>
    <path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z" fill="currentColor"/>
  </svg>
);

/**
 * Render the quote action for one finalized assistant message.
 * @param {*} props runtime seats: messageId, sessionId, inputActions, useChat
 * @returns the icon button, or null in card mode or when the message text is unavailable
 */
function QuoteMessageAction(props) {
  const mode = useDisplayMode();
  const text = props.useChat(snapshot => {
    const nodes = snapshot?.nodes;
    if (!nodes) return '';
    for (const node of nodes.values()) {
      const closing = node?.data?.closing;
      if (!closing || closing.finalNode?.messageId !== props.messageId) continue;
      return closingQuoteText(closing);
    }
    return '';
  });
  if (mode !== 'bubble' || !text) return null;
  const quote = () => {
    try { props.inputActions?.insertQuote(clipQuote(text)); } catch { /* Host refused: no fake feedback */ }
  };
  return <button type="button" className="sl-message-action" aria-label="引用这条消息" title="引用这条消息" onClick={quote}>{QUOTE_ICON}</button>;
}

export function createQuoteMessageAction() { return QuoteMessageAction; }
