/**
 * outgoing-cards — sender-side session-link business card (product module).
 *
 * Migrated from scripts/v04-sender-spike (evidence record); Lead wires
 * `installOutgoingCards` from src/client/index.jsx. Scope guarantees:
 *   - NON-exclusive own Definition (`session-link-sender-card`, target `chat`)
 *     via public `uiConversation.events.register`; native tool row /
 *     turn-process / turn-tail untouched (two information layers);
 *   - identity from public SessionBinding.eventSource windows only
 *     (no private assembler fields, no DOM rewriting, no generic slot keys);
 *   - FOUR rendering gates: call+result in the current window → extractable
 *     ledger ids (send/reply results[].id, create firstMessage.id) → owner-only
 *     card_lookup row for EVERY id with `row.from === current sessionId` →
 *     per-tool ledger cross-checks (send targets / reply parentMessageId /
 *     create result.sessionId). Fork history, lookup missing/404, no result,
 *     out-of-window, non-append (model-only) results, or an error result
 *     (incl. AUTO_REVIEW_DENIED) → NO card; the native record stands alone;
 *   - keyed `tool.call.toolview` for EXACTLY session_link_send|reply|create:
 *     brief visible status, complete args/result/error + multi-target ledger
 *     statuses behind a default-closed 技术详情, native `inspect` ("查看轨迹")
 *     button forwarded when the host provides one (never faked), honest
 *     "参数未加载" when the call head left the window;
 *   - status via the receiver-tested truth table + local 截至 (stamped when
 *     the lookup RESPONSE completed) + 状态未更新 on failed refresh; refresh
 *     is window-batched/throttled (expand/tab-visible force), never per-card
 *     polling; never claims 已读/完成;
 *   - header line 1 uses ledger fromTitle/toTitle (short-id fallback and
 *     same-title disambiguation), line 2 real subject (explicit first, else
 *     first NON-EMPTY line of the actual text/task, code-point safe, no LLM);
 *   - INSTALL IS TRANSACTIONAL: every listener/slot/definition is created
 *     inside one try block with an idempotent rollback — any synchronous
 *     setup failure aborts the AbortController and removes everything already
 *     installed before rethrowing, so no orphan listener can keep requesting.
 *     No module-level test hooks: tests inject through `options.onReady`.
 */

import React from 'react';
import { translateText } from './i18n.js';
import { CARD_KIND, createSenderCardDefinition } from './outgoing-card.mjs';
import { createWindowScope } from './outgoing-window-scope.mjs';
import { createCardVerifier } from './outgoing-card-verify.mjs';
import { createOutgoingCoordinator } from './outgoing-coordinator.mjs';
import { CARD_PARTY, cardClass, directionAttribute, toggleText } from './card-shell.mjs';

/** Strict tool set — anything else (status/control/list/…) stays native. */
export const TOOL_KEYS = Object.freeze(['session_link_send', 'session_link_reply', 'session_link_create']);

/** Key guard: the toolview may only ever claim session_link_* keys. */
export function assertToolKey(key) {
  if (!TOOL_KEYS.includes(key)) throw new Error(`outgoing-cards refuses toolview key "${key}"`);
  return key;
}

/**
 * Compact two-line business card, aligned with the receiver v2 hierarchy:
 *   line 1 — `发送者 → 接收者` from ledger titles (+ a small `回复` tag);
 *   line 2 — real subject + non-intrusive evidence status (small, inline,
 *            never a third line).
 * Valid nesting: container <div> → ONE header <button type=button
 * aria-expanded> holding only the two lines → a SIBLING expanded <div> with
 * the business body, the single default-closed 技术详情 and the optional
 * native 查看轨迹 entry. No <details>/<button> ever nests inside the header
 * button; the native button also gives Enter/Space keyboard toggling. The
 * status stays a separate small element after the subject so it can never
 * push the subject out of line 2.
 * Pure layout (no hooks) so Node can assert both structural states directly;
 * the exported view wrapper only wires React state + the enabled refresh.
 *
 * @param props.data - rendered card data from the Definition.
 * @param props.open - expanded state (false = exactly the two lines).
 * @param props.onToggle - toggle callback.
 * @param props.onRefresh - called once when a COLLAPSED card expands.
 */
/** Compact local clock for the 截至 marker (short, never squeezing the subject). */
export function formatShortTime(ms) {
  if (typeof ms !== 'number') return '';
  const date = new Date(ms);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export function SenderCardLayout({ data, open = false, onToggle, onRefresh, inspectCall }) {
  if (data === undefined || data === null) return null;
  const sender = typeof data.fromDisplay === 'string' && data.fromDisplay !== ''
    ? data.fromDisplay
    : typeof data.from === 'string' && data.from !== ''
      ? data.from
      : '未知发送会话';
  // Multi-target sends keep EVERY real recipient (never a fabricated single one).
  const recipientList = Array.isArray(data.toDisplay) && data.toDisplay.length > 0
    ? data.toDisplay
    : Array.isArray(data.to) && data.to.length > 0
      ? data.to
      : [];
  const recipients = recipientList.length > 0 ? recipientList.join('、') : '未知接收者';
  const status = typeof data.status === 'string' && data.status !== '' ? data.status : '状态未知';
  const suffix = data.statusStale === true
    ? ' · 状态未更新'
    : typeof data.statusAsOf === 'number'
      ? ` · 截至 ${formatShortTime(data.statusAsOf)}`
      : '';
  const hasReply = typeof data.replyTo === 'string' && data.replyTo !== '';
  const messageIds = Array.isArray(data.evidence?.messageIds) ? data.evidence.messageIds : [];
  const targetStatus = Array.isArray(data.targetStatus) ? data.targetStatus : [];
  const techLines = [
    `callId: ${data.callId ?? ''}`,
    `tool: ${data.tool ?? ''}`,
    typeof data.kind === 'string' && data.kind !== '' ? `kind: ${data.kind}` : null,
    // A parent link is NEVER called a reply by itself: only a verified
    // ledger kind==='reply' row names it 关联请求ID; every other kind
    // (notification/request chain continuation) stays 关联消息ID.
    hasReply ? `${data.kind === 'reply' ? '关联请求ID' : '关联消息ID'}: ${data.replyTo}` : null,
    messageIds.length > 0 ? `messageIds: ${messageIds.join(', ')}` : null,
    targetStatus.length > 0
      ? `目标状态: ${targetStatus
          .map((entry) => {
            const stamp = typeof entry.asOf === 'number' ? `截至 ${new Date(entry.asOf).toLocaleString()}` : '截至未知';
            const stale = entry.stale === true ? '，未更新' : '';
            return `${entry.target}=${entry.label ?? entry.status}（${stamp}${stale}）`;
          })
          .join(', ')}`
      : null,
    data.status === '多目标状态' ? '（多目标状态明细见上一行）' : null,
  ].filter((line) => line !== null && line !== '');
  return (
    <div
      className={cardClass('sent')}
      data-session-link-card={data.callId}
      data-session-link-i18n-root=""
      {...directionAttribute('sent')}
    >
      <button
        type="button"
        className="sl-card__toggle"
        data-session-link-card-toggle=""
        aria-expanded={open === true}
        aria-label={`${translateText(CARD_PARTY.sender)} ${sender}, ${translateText(CARD_PARTY.recipient)} ${recipients}, ${translateText(CARD_PARTY.subject)} ${data.subject ?? ''}, ${translateText(toggleText(open === true))}`}
        onClick={() => {
          if (open !== true && typeof onRefresh === 'function') {
            onRefresh({ sessionId: data.from, ids: messageIds });
          }
          if (typeof onToggle === 'function') onToggle();
        }}
      >
        <span className="sl-card__party" data-session-link-card-sender-row="">
          <span className="sl-card__party-label">{CARD_PARTY.sender}</span>
          <span className="sl-card__party-name" data-session-link-card-sender="" data-i18n-skip="" title={sender}>{sender}</span>
          <span className="sl-card__toggle-text" data-session-link-card-toggle-text="">{toggleText(open === true)}</span>
        </span>
        <span className="sl-card__party" data-session-link-card-recipient-row="">
          <span className="sl-card__party-label">{CARD_PARTY.recipient}</span>
          <span className="sl-card__party-name" data-session-link-card-recipient="" data-i18n-skip="" title={recipients}>{recipients}</span>
        </span>
        <span className="sl-card__party" data-session-link-card-subject="">
          <span className="sl-card__party-label">{CARD_PARTY.subject}</span>
          <span className="sl-card__subject" data-session-link-card-subject-text="" data-i18n-skip="">
            {data.subject ?? ''}
          </span>
          <span className="sl-card__status" data-session-link-card-status="">
            {status}{suffix}
          </span>
        </span>
      </button>
      {open === true ? (
        <div className="sl-card__expanded" data-session-link-card-expanded="">
          {typeof data.body === 'string' && data.body !== '' ? (
            <pre className="sl-card__body sl-card__body--pre" data-session-link-card-body="" data-i18n-skip="">{data.body}</pre>
          ) : null}
          <details className="sl-card__tech" data-session-link-card-tech="">
            <summary>技术详情</summary>
            <pre className="sl-card__techpre" data-i18n-skip="">{techLines.join('\n')}</pre>
          </details>
          {typeof inspectCall === 'function' ? (
            <button type="button" className="sl-card__inspect" data-session-link-card-inspect="" onClick={() => inspectCall(data.callId)}>
              查看轨迹
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Card view: one compact two-line button by default (nothing else rendered);
 * expanding reveals the real business body and the single default-closed
 * technical details, and triggers one batched status refresh for its ids.
 */
export function createSenderCardView({ onRefresh } = {}) {
  return function SenderCardView({ node, inspectCall } = {}) {
    const data = node?.data;
    const [open, setOpen] = React.useState(false);
    return (
      <SenderCardLayout
        data={data}
        open={open}
        onToggle={() => setOpen((previous) => previous !== true)}
        onRefresh={onRefresh}
        inspectCall={inspectCall}
      />
    );
  };
}

/**
 * Plain-text technical record for the native execution row, honouring the rc5
 * record shapes (contract/records.d.ts): PreparingToolCall (args not yet
 * complete), StartedToolCall.argsRaw, ToolResultNode.call?.argsRaw/content/
 * error — with an honest "参数未加载" when the call head left the window.
 * Only ever rendered inside the default-closed 技术详情 disclosure.
 * @param {{phase?: string, block?: Record<string, any>}} stage
 * @returns {string}
 */
export function toolTechText({ phase, block } = {}) {
  const lines = [];
  if (phase === 'preparing') {
    const name = typeof block?.name === 'string' && block.name !== '' ? block.name : '未知工具';
    lines.push(`工具 ${name} · 参数流式接收中（尚未完整）`);
    return lines.join('\n');
  }
  if (phase === 'start') {
    const argsRaw = typeof block?.argsRaw === 'string' && block.argsRaw !== '' ? block.argsRaw : null;
    lines.push(argsRaw === null ? '参数未加载' : `参数: ${argsRaw}`);
    return lines.join('\n');
  }
  const call = block?.call;
  const argsRaw = call !== null && call !== undefined && typeof call.argsRaw === 'string' && call.argsRaw !== ''
    ? call.argsRaw
    : null;
  lines.push(argsRaw === null ? '参数未加载（调用头不在当前窗口）' : `参数: ${argsRaw}`);
  const content = Array.isArray(block?.content)
    ? block.content.filter((item) => item?.type === 'text' && typeof item.text === 'string').map((item) => item.text).join('\n')
    : '';
  if (content !== '') lines.push(`结果: ${content}`);
  if (block?.isError === true || block?.error !== undefined) {
    const error = block?.error;
    const detail = error === undefined || error === null
      ? '（无错误详情）'
      : [error.name, error.code, error.reason].filter((part) => typeof part === 'string' && part !== '').join(' · ');
    lines.push(`错误: ${detail}`);
  }
  return lines.join('\n');
}

/**
 * Keyed toolview for the three session_link tools: brief visible status only;
 * complete args/result/error behind the default-closed 技术详情; the native
 * `inspect` entry ("查看轨迹") is forwarded when the host supplies it and
 * hidden otherwise — never faked, never executes args.
 */
export function createSessionLinkToolview() {
  return function SessionLinkToolview({ phase, block, callId, inspect } = {}) {
    const status =
      phase === 'preparing' ? '准备中' : phase === 'start' ? '执行中' : block?.isError === true ? '宿主返回错误' : '宿主已返回结果';
    const tech = toolTechText({ phase, block });
    const canInspect = typeof inspect === 'function';
    return (
      <div data-session-link-toolview={callId}>
        <span data-session-link-toolview-status>{`session-link · ${status}`}</span>
        {canInspect ? (
          <button type="button" data-session-link-toolview-inspect onClick={inspect}>
            查看轨迹
          </button>
        ) : null}
        <details data-session-link-toolview-tech>
          <summary>技术详情</summary>
          <pre>{tech}</pre>
        </details>
      </div>
    );
  };
}

export const inject = ['sessions', 'uiConversation', 'slots'];

/**
 * Install the outgoing card into one client context.
 * TRANSACTIONAL: every resource (definition, verifier watch, list/source
 * subscriptions, slot renderers, visibility listener) is created inside one
 * try block; any synchronous failure rolls ALL of them back (and aborts
 * in-flight lookups) before rethrowing — no orphan listener can keep
 * requesting after a failed install. The cordis effect owns the same
 * idempotent release for normal disposal.
 *
 * @param ctx - client context (inject: sessions, uiConversation, slots).
 * @param options.fetchImpl - injectable card_lookup fetch (tests).
 * @param options.onReady - test seam: receives {scan, stats} of the internal
 *   coordinator (production never passes it; no module-level hooks exist).
 */
export function installOutgoingCards(ctx, { fetchImpl, onReady } = {}) {
  const sessions = ctx.sessions;
  const windowScope = createWindowScope({ sessions });
  const verifier = createCardVerifier({ fetchImpl });
  const definition = createSenderCardDefinition({ windowScope, verifier, claim: 'coexist' });

  let disposed = false;
  let stopDefinition = null;
  let stopVerifyWatch = null;
  let stopList = null;
  let visibilityInstalled = false;
  let rebuildQueued = false;
  const slotStops = [];
  const aborter = new AbortController();

  const scheduleRebuild = () => {
    if (disposed || rebuildQueued) return;
    rebuildQueued = true;
    queueMicrotask(() => {
      rebuildQueued = false;
      if (disposed) return;
      try {
        stopDefinition?.();
        stopDefinition = ctx.uiConversation.events.register(definition);
      } catch {
        // Rebuild rejected (e.g. duplicate kind): the previous registration
        // still stands or the next verified change retries — never crash.
      }
    });
  };

  const coordinator = createOutgoingCoordinator({
    sessions,
    verifier,
    getSignal: () => aborter.signal,
    onPrepend: scheduleRebuild,
  });
  coordinator.attachWindowScope(windowScope);

  // Tab visible → one forced pass over the in-window verified ids.
  const onVisibility = () => {
    if (disposed) return;
    if (globalThis.document?.visibilityState === 'visible') {
      coordinator.requestForce();
      coordinator.scheduleScan();
    }
  };

  /** Idempotent rollback/dispose: releases EVERY non-effect resource. */
  function releaseAll() {
    if (disposed) return;
    disposed = true;
    aborter.abort();
    try {
      stopDefinition?.();
    } catch {
      // Already disposed.
    }
    stopDefinition = null;
    for (const stop of slotStops.splice(0)) {
      try {
        stop?.();
      } catch {
        // Slot already torn down.
      }
    }
    try {
      stopVerifyWatch?.();
    } catch {
      // Already disposed.
    }
    stopVerifyWatch = null;
    try {
      stopList?.();
    } catch {
      // Already disposed.
    }
    stopList = null;
    if (visibilityInstalled) {
      globalThis.document?.removeEventListener?.('visibilitychange', onVisibility);
      visibilityInstalled = false;
    }
    coordinator.dispose();
    windowScope.dispose();
  }

  try {
    stopDefinition = ctx.uiConversation.events.register(definition);
    stopVerifyWatch = verifier.subscribe(() => scheduleRebuild());

    try {
      stopList = sessions.list.subscribe(() => coordinator.reconcile());
      coordinator.reconcile();
    } catch {
      // Bare fixture without a list subscription: scope still resolves lazily.
      stopList = null;
    }

    // Expanding the card body forces ONE batched refresh for exactly its ids.
    const SenderCardView = createSenderCardView({
      onRefresh: ({ sessionId, ids }) => verifier.refresh(sessionId, ids, { force: true, signal: aborter.signal }),
    });
    slotStops.push(
      ctx.slots.inject('conversation.chat.node', () =>
        ctx.slots.register({ name: 'conversation.chat.node', key: CARD_KIND }, SenderCardView),
      ),
    );

    const SessionLinkToolview = createSessionLinkToolview();
    for (const key of TOOL_KEYS) {
      assertToolKey(key);
      slotStops.push(
        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register({ name: 'tool.call.toolview', key }, SessionLinkToolview),
        ),
      );
    }

    if (typeof globalThis.document?.addEventListener === 'function') {
      globalThis.document.addEventListener('visibilitychange', onVisibility);
      visibilityInstalled = true;
    }

    ctx.effect(() => () => releaseAll(), 'outgoing-cards: teardown');

    if (typeof onReady === 'function') onReady({ scan: () => coordinator.scan(), stats: () => coordinator.stats() });
  } catch (error) {
    // Synchronous setup failure: remove everything already installed, then
    // surface the original error for the caller's explicit degradation log.
    releaseAll();
    throw error;
  }
}
