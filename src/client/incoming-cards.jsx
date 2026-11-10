/**
 * incoming-cards — receiver-side session-link business card (product module).
 *
 * Migrated from the verified v04 receiver prototype (scripts/v04-card-spike,
 * evidence record). Lead wires `installIncomingCards` from src/client/index.jsx.
 * Scope guarantees:
 *   - own Conversation Definition (`session-link-card`, target `chat`) through
 *     the public `uiConversation.events.register` seam; own keyed renderer via
 *     `conversation.chat.node`. No private assembler fields, no DOM rewriting.
 *   - identity: an incoming `user/message` is claimed (EXCLUSIVE, single
 *     projection) ONLY when
 *       (a) its source is the standard 3-field host relay attribution
 *           {kind:'agent-message', form:'relay', senderSessionId},
 *       (b) the exact event object was observed inside a public
 *           SessionBinding.eventSource window under exactly one sessionId, and
 *       (c) owner-only `card_lookup` confirmed the durableMessageId with the
 *           EXACT fact binding: ledger row.to === observed session AND
 *           ledger row.from === event.data.source.senderSessionId.
 *     Otherwise match returns null → the native message projection renders
 *     (never swallowed, never double-projected).
 *   - exclusive-conflict safety: before claiming, the public route table
 *     (`uiConversation.events.forEvent(type)`) is consulted for another
 *     Definition on the SAME target that would exclusive-claim the same event.
 *     Two exclusive claims on one event+target make the public dispatcher THROW
 *     inside its rebuild dispatch (unreachable from a re-register try/catch), so
 *     this module conservatively declines instead: the peer keeps its single
 *     claim and the message stays native for us. A re-entrancy latch makes
 *     mutual pre-checks terminate; a throwing peer match is treated as a
 *     conflict (their own dispatch call still surfaces their error). Relies on
 *     the public contract that `match` is a pure sync predicate (the dispatcher
 *     itself re-runs every match on every rebuild).
 *   - INCREMENTAL work: the event feed is subscribed per session and every
 *     publication is classified from its public `change` descriptor — appended
 *     relay `user/message` entries are processed as a delta (scope + owner
 *     lookup of just the new ids), step/turn landings only schedule a throttled
 *     status pass, and transient streaming tokens (assistant/live-chunk etc.)
 *     cause ZERO scans, ZERO window reads and ZERO lookups. `replace`/`prepend`
 *     re-walk only that one session. Owner lookups are batched per session
 *     (≤100/request); refresh candidates come from maintained per-session
 *     window id sets, so ids outside the loaded window are never queried.
 *   - generation safety: the feed binding is keyed by sessionId AND the exact
 *     eventSource reference. A same-id SessionBinding/generation swap
 *     unsubscribes the old feed, revokes that session's identity caches, then
 *     binds and re-walks the new one — a replaced feed can never go silent.
 *     Session removal unbinds the same way; unmount aborts in-flight lookups.
 *   - re-verification batches coalesce into one dispose+re-register pair (the
 *     public registry-change rebuild trigger). Scope-set growth (fork / shared
 *     event object appearing under a second session) forces that rebuild
 *     exactly once, so an earlier exclusive claim downgrades back to native.
 *   - status freshness: verified rows carry a local as-of time. Refresh is
 *     event-driven and batched — at most one merged card_lookup pass per
 *     `refreshIntervalMs` (default 30s) over ids STILL in current windows, plus
 *     an immediate force refresh on tab-visible and on card expand (expand
 *     reuses its includeBody response). Never polls per card, never queries
 *     out-of-window ids. A failed refresh keeps the last row and flags
 *     状态未更新 (stale) instead of guessing.
 *   - UI (v2, user-approved): two-line header (line1 `from → to` + a compact
 *     ledger-kind mark — 回复 for replies, 请求 for requests, none for plain
 *     notifications — so a recipient can tell a reply from a new request at a
 *     glance; line2 keeps the short subject + small status text untouched);
 *     the verified ledger parent link is shown ONLY inside the default-closed
 *     technical details (关联请求ID only for a verified `reply`, else
 *     关联消息ID — a send can continue a chain from a notification/request),
 *     never in the two-line view and never fabricated without a parent;
 *     business body fetched ONLY on user expand
 *     via `card_lookup {includeBody:true}` for exactly this event's durable id
 *     in this session (never batch, never out-of-window); technical details /
 *     raw event text stay behind a default-closed disclosure that distinguishes
 *     宿主消息ID (durable host id) from 互通消息ID (plugin ledger id). The raw
 *     event, model input and source wrapper are never modified; unknown
 *     identity always falls back native. Never claims 已读/已处理/完成.
 */

import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { translateText } from './i18n.js';
import { CARD_PARTY, cardClass, directionAttribute, toggleText } from './card-shell.mjs';
import { ExchangeLink } from './chat-ui.jsx';
import { receiverHint } from './delivery-indicator.mjs';
import { useDisplayMode } from './display-mode.mjs';
import { createCapsuleGroupStore } from './capsule-group-store.mjs';
import { capsuleStatusKey } from './capsule-status.mjs';

const KIND = 'session-link-card';
const SCAN_DEBOUNCE_MS = 200;
const LOOKUP_BATCH = 100;
/** Bounded delayed retry for transient lookup failures (one timer, ≤3 rounds). */
const RETRY_DELAY_MS = 10_000;
const RETRY_MAX_ATTEMPTS = 3;

/** Default low-frequency cap for merged status-refresh lookups. */
const DEFAULT_REFRESH_INTERVAL_MS = 30_000;

/** Ledger kind → short Chinese subject fallback (never protocol-header text). */
const KIND_SUBJECT = {
  notification: '通知',
  request: '协作请求',
  reply: '明确回复',
};

/**
 * Ledger kind → compact first-line marker. Only kinds a recipient must be able
 * to tell apart at a glance get one: a reply answers an earlier request, a
 * request opens a new thread; plain notifications need no mark.
 * 'notification' deliberately absent (no marker).
 */
const KIND_MARK = {
  request: '请求',
  reply: '回复',
};

/** Standard host agent-message relay attribution: exactly three fields. */
function isStandardRelaySource(source) {
  if (typeof source !== 'object' || source === null) return false;
  const keys = Object.keys(source);
  if (keys.length !== 3) return false;
  return (
    source.kind === 'agent-message' &&
    source.form === 'relay' &&
    typeof source.senderSessionId === 'string' &&
    source.senderSessionId.length > 0
  );
}

/** Plain-text original of one durable user message (window-local, never fetched). */
function textOfUserMessage(event) {
  const content = event?.data?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Evidence-based status text from the ledger row (precise truth table).
 * Readable Chinese small-text only; NEVER claims 已读/已处理/完成 and never
 * implies a read receipt. `asOf` is the LOCAL query time (explicitly labelled
 * 截至, never presented as receipt evidence); `stale` marks a failed refresh
 * (last value kept, flagged 状态未更新/需核对). replyStatus never forges the
 * body or source status: `answered` shows 明确回复 (strongest fact),
 * `timed_out` appends 等待回复超时 while KEEPING the delivery/receipt facts.
 * @param {Record<string, any> | null | undefined} row
 * @param {number | null} [asOf] local ms epoch of the last successful lookup
 * @param {boolean} [stale] last refresh attempt failed
 * @returns {{ label: string, receiptTime: number | null, asOf: number | null, stale: boolean }}
 */
export function statusDisplay(row, asOf = null, stale = false) {
  const status = row?.status;
  const receipt = row?.receipt ?? null;
  const replyStatus = row?.replyStatus;
  let label;
  if (status === 'failed') {
    label = '失败';
  } else if (status === 'cancelled') {
    label = '已取消';
  } else if (status === 'held') {
    label = '已暂存·待投递';
  } else if (status === 'pending') {
    label = '待投递';
  } else if (status === 'dispatching') {
    // Dispatch started; outcome not yet evidenced — do not claim non-delivery.
    label = '投递中·结果待确认';
  } else if (status === 'unknown') {
    label = '需核对';
  } else if (status === 'accepted') {
    if (receipt?.policy === 'context') {
      if (receipt.state === 'received') {
        label = '已进入上下文';
      } else if (receipt.state === 'queued') {
        label = '宿主已接收·待进入上下文';
      } else {
        // not_sent / uncertain / unknown state: contradictory or unclear vs
        // accepted — verify instead of asserting either direction.
        label = '需核对';
      }
    } else {
      // legacy-accepted or no receipt: entry into context is UNCONFIRMED —
      // do not assert it has not happened.
      label = '宿主已接收·进入上下文未确认';
    }
  } else {
    // missing / unexpected status: verify, don't guess.
    label = '需核对';
  }
  // Reply facts sit ON TOP of delivery facts: answered is the strongest
  // available fact and shows alone; timeout keeps the delivery/receipt label
  // and appends the wait outcome (does not revoke delivery, does not imply
  // the message was unhandled).
  if (replyStatus === 'answered') label = '明确回复';
  else if (replyStatus === 'timed_out') label = `${label} · 等待回复超时`;
  const receiptTime = label.startsWith('已进入上下文') && typeof receipt?.receivedAt === 'number' ? receipt.receivedAt : null;
  return {
    label,
    receiptTime,
    asOf: typeof asOf === 'number' ? asOf : null,
    stale: stale === true,
  };
}

/** Fields whose change must re-render status cards after a refresh batch. */
function displayChanged(a, b) {
  return (
    a?.status !== b?.status ||
    a?.replyStatus !== b?.replyStatus ||
    a?.subject !== b?.subject ||
    (a?.receipt?.state ?? null) !== (b?.receipt?.state ?? null) ||
    (a?.receipt?.receivedAt ?? null) !== (b?.receipt?.receivedAt ?? null)
  );
}

/**
 * On-demand body reader: single-id owner `card_lookup` with `includeBody:true`.
 * The response is re-validated against the exact event facts before any text
 * is returned; a mismatch degrades to an honest "unavailable" state instead of
 * showing unverified text. On identity-confirmed responses the full row is
 * returned too, so the caller can use it as an expand-time status refresh.
 * @param {{ url: string, fetchImpl?: typeof fetch }} options
 * @returns {(args: {sessionId: string, durableId: string, senderSessionId: string, signal?: AbortSignal}) => Promise<{phase: string, body?: string, reason?: string, row?: Record<string, any>}>}
 */
export function createBodyFetcher({ url, fetchImpl = globalThis.fetch }) {
  return async function fetchCardBody({ sessionId, durableId, senderSessionId, signal }) {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      signal,
      // Exactly one id — the current verified event's durable id. Never a batch.
      body: JSON.stringify({ action: 'card_lookup', payload: { sessionId, ids: [durableId], includeBody: true } }),
    });
    if (!response.ok) {
      throw Object.assign(new Error(`card_lookup HTTP ${response.status}`), { httpStatus: response.status });
    }
    const payload = await response.json();
    if (payload?.ok !== true) {
      throw Object.assign(new Error(payload?.error?.message ?? 'card_lookup failed'), { code: payload?.error?.code });
    }
    const rows = Array.isArray(payload?.value?.results) ? payload.value.results : [];
    const row = rows.find((candidate) => candidate?.durableMessageId === durableId || candidate?.id === durableId);
    if (row === undefined) return { phase: 'missing', reason: '账本未返回该消息' };
    // Exact binding re-check: recipient session + ledger sender == event sender.
    if (row.to !== sessionId || row.from !== senderSessionId) {
      return { phase: 'unavailable', reason: '身份不一致，按原文技术详情显示' };
    }
    if (!('body' in row)) {
      // Host withheld the body (unknown status / non-recipient / plugin id /
      // Host without includeBody support): honest degrade, no guessing.
      return { phase: 'unavailable', reason: 'Host 未提供正文', row };
    }
    if (row.bodyState === 'redacted') return { phase: 'redacted', row };
    if (row.bodyState === 'available' && typeof row.body === 'string') return { phase: 'available', body: bodyText(row), row };
    return { phase: 'unavailable', reason: '正文状态不可用', row };
  };
}

/** Strip nothing: the ledger body IS the business text; keep verbatim. */
function bodyText(row) {
  return typeof row.body === 'string' ? row.body : '';
}

/**
 * Pure layout for one received card (no hooks, so Node can assert both
 * structural states directly). ONE outer frame owns border/background/radius;
 * the header button and the expanded sibling share it — no second card and no
 * per-node surface styles. The visible chip is only 接收; the real ledger
 * kind/parent stay in the default-closed technical details.
 * @param {{ data?: Record<string, any>, open?: boolean, body?: any, onToggle?: () => void, onRetry?: () => void }} props
 */
export function SessionLinkCardLayout({ data, open = false, body = null, onToggle, onRetry }) {
  if (data === undefined || data === null) return null;
  const row = data.row ?? {};
  const durableId = typeof data.durableMessageId === 'string' ? data.durableMessageId : '';
  // 互通消息ID = plugin ledger id; distinct from the host durable id.
  const ledgerId = typeof row.id === 'string' ? row.id : '';
  const senderSessionId = typeof data.senderSessionId === 'string' ? data.senderSessionId : '';
  const status = typeof data.status === 'string' ? data.status : '';
  // Ledger reply protocol lives on the verified row; buildViewNode exposes
  // `status` at data top level but not replyStatus, so read the row (the same
  // source statusDisplay uses) instead of a never-populated data field.
  const replyStatus = typeof row.replyStatus === 'string' ? row.replyStatus : '';
  const from = typeof data.fromDisplay === 'string' && data.fromDisplay.length > 0 ? data.fromDisplay : senderSessionId || '?';
  const to = typeof data.toDisplay === 'string' && data.toDisplay.length > 0 ? data.toDisplay : typeof row.to === 'string' && row.to.length > 0 ? row.to : '?';
  const subject = typeof data.subject === 'string' && data.subject.length > 0 ? data.subject : '会话消息';
  // The visible chip is the viewing direction only; the real ledger kind
  // stays in the technical details (never renamed away at the data layer).
  const kindText = typeof row.kind === 'string' && row.kind.length > 0 ? row.kind : '—';
  // Verified ledger parent link (label depends on the verified kind); empty
  // when the ledger has no parent — nothing is fabricated.
  const parentMessageId = typeof data.parentMessageId === 'string' ? data.parentMessageId : '';
  const parentLabel = typeof data.parentLabel === 'string' ? data.parentLabel : '';
  const rawText = typeof data.text === 'string' ? data.text : '';
  const statusInfo = statusDisplay(row, data.statusAsOf ?? null, data.statusStale === true);
  const asOfLabel = typeof statusInfo.asOf === 'number' ? new Date(statusInfo.asOf).toLocaleTimeString() : '';
  const receiptLabel = typeof statusInfo.receiptTime === 'number' ? new Date(statusInfo.receiptTime).toLocaleString() : '';

  let bodyContent;
  if (body === null) {
    bodyContent = <div className="sl-card__placeholder">正文加载中…</div>;
  } else if (body.phase === 'available') {
    bodyContent = (
      <div className="sl-card__body" data-session-link-card-text="" data-i18n-skip="">
        {body.body}
      </div>
    );
  } else if (body.phase === 'redacted') {
    bodyContent = <div className="sl-card__placeholder">正文已清除，无法展示。</div>;
  } else if (body.phase === 'error') {
    bodyContent = (
      <div className="sl-card__error">
        <span>正文获取失败：{body.reason}</span>
        <button type="button" className="sl-card__retry" onClick={() => {
          if (typeof onRetry === 'function') onRetry();
        }}>
          重试
        </button>
      </div>
    );
  } else {
    bodyContent = (
      <div className="sl-card__placeholder">
        正文不可用：{body.reason ?? '未知原因'}；可在下方技术详情查看本会话原始消息。
      </div>
    );
  }

  // Small status text: label + local as-of time (or stale marker). Receipt
  // evidence time goes in the tooltip only — never conflated with as-of.
  const statusSuffix = statusInfo.stale ? ' · 状态未更新' : asOfLabel ? ` · 截至 ${asOfLabel}` : '';
  const statusTitle = [
    statusInfo.label,
    receiptLabel ? `收讫证据 ${receiptLabel}` : '',
    asOfLabel ? `本地查询截至 ${asOfLabel}` : '',
    statusInfo.stale ? '最近一次刷新失败，显示的是上次结果' : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div
      className={cardClass('received')}
      data-session-link-card="" data-session-link-i18n-root=""
      data-session-link-card-status={status}
      {...directionAttribute('received')}
    >
      <button
        type="button"
        className="sl-card__toggle"
        data-session-link-card-toggle=""
        aria-expanded={open === true}
        aria-label={`${translateText(CARD_PARTY.sender)} ${from}, ${translateText(CARD_PARTY.recipient)} ${to}, ${translateText(CARD_PARTY.subject)} ${subject}, ${translateText(toggleText(open === true))}`}
        title="会话协作，非本人指令"
        onClick={() => {
          if (typeof onToggle === 'function') onToggle();
        }}
      >
        <span className="sl-card__party" data-session-link-card-sender-row="">
          <span className="sl-card__party-label">{CARD_PARTY.sender}</span>
          <span className="sl-card__party-name" data-session-link-card-sender="" data-i18n-skip="" title={from}>{from}</span>
          <span className="sl-card__toggle-text" data-session-link-card-toggle-text="">{toggleText(open === true)}</span>
        </span>
        <span className="sl-card__party" data-session-link-card-recipient-row="">
          <span className="sl-card__party-label">{CARD_PARTY.recipient}</span>
          <span className="sl-card__party-name" data-session-link-card-recipient="" data-i18n-skip="" title={to}>{to}</span>
        </span>
        <span className="sl-card__party" data-session-link-card-subject="">
          <span className="sl-card__party-label">{CARD_PARTY.subject}</span>
          <span className="sl-card__subject" data-session-link-card-subject-text="" data-i18n-skip="">
            {subject}
          </span>
          <span className="sl-card__status" data-session-link-card-statuslabel="" title={statusTitle}>
            {statusInfo.label}
            {statusSuffix}
          </span>
        </span>
      </button>
      {open === true ? (
        <div className="sl-card__expanded" data-session-link-card-expanded="">
          {bodyContent}
          <details className="sl-card__tech" data-session-link-card-technical="">
            <summary>技术详情/原始消息</summary>
            <div className="sl-card__techblock">
              <div>宿主消息ID: {durableId}</div>
              {ledgerId.length > 0 && ledgerId !== durableId ? <div>互通消息ID: {ledgerId}</div> : null}
              {typeof row.chainId === 'string' && row.chainId.length > 0 ? <div>chain: {row.chainId}</div> : null}
              <div>kind: {kindText}</div>
              {parentMessageId !== '' ? <div>{parentLabel}: {parentMessageId}</div> : null}
              <div>sender: {senderSessionId}</div>
              <div>
                status: {status || '—'}
                {replyStatus ? ` · reply: ${replyStatus}` : ''}
              </div>
            </div>
            {rawText.length > 0 ? <pre className="sl-card__rawtext" data-i18n-skip="">{rawText}</pre> : null}
          </details>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Card view factory bound to the plugin's body fetcher and status-refresh
 * callback. Body is fetched only after the user expands; stale requests are
 * aborted on collapse/unmount; the pure layout above owns the shared shell.
 * @param {{ fetchCardBody: ReturnType<typeof createBodyFetcher>, onFreshRow?: (row: Record<string, any>) => void }} deps
 */
const EMPTY_GROUP = { head: true, count: 1 };
const NOOP_SNAPSHOT = { version: 0, sessions: new Map() };
const NOOP_GROUP_STORE = {
  subscribe: () => () => {},
  getSnapshot: () => NOOP_SNAPSHOT,
  info: () => EMPTY_GROUP,
  set: () => {},
  has: () => false,
};

export function createSessionLinkCardView({ fetchCardBody, onFreshRow, groupStore }) {
  const store = groupStore ?? NOOP_GROUP_STORE;

  /** @param {{ node?: { data?: Record<string, any> } }} props */
  function SessionLinkCardView({ node }) {
    const [body, setBody] = useState(null);
    const [retry, setRetry] = useState(0);
    const [cardOpen, setCardOpen] = useState(false);
    const mode = useDisplayMode();
    const data = node?.data ?? {};
    const groupSnapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const groupInfo = store.info(groupSnapshot, data.capsuleSessionId, data.capsuleSeq);
    const hidden = mode !== 'card' && groupInfo.head === false;
    const capsuleCount = groupInfo.count;
    const durableId = typeof data.durableMessageId === 'string' ? data.durableMessageId : '';
    const sessionId = typeof data.row?.to === 'string' ? data.row.to : '';
    const senderSessionId = typeof data.senderSessionId === 'string' ? data.senderSessionId : '';
    // Per-node, per-session closure built WITH the view node: proves THIS
    // card's exact event is still in THIS session's window (single scope +
    // ledger facts re-checked). A same host id in another session/fork has
    // its own closure — no shared key to collide or overwrite.
    const isWindowCurrent = typeof data.isWindowCurrent === 'function' ? data.isWindowCurrent : null;
    const windowProof = useRef(isWindowCurrent);
    windowProof.current = isWindowCurrent;

    // Fetch once per mounted identity/retry, not per rebuilt node closure.
    // A live turn rebuilds nodes frequently. Always use the latest proof for
    // scope checks without aborting/re-fetching on every durable event.
    useEffect(() => {
      // Bubble mode never needs the body: only the dialog reads it.
      if (durableId === '' || sessionId === '' || mode !== 'card' || !cardOpen) return undefined;
      if (typeof windowProof.current !== 'function' || !windowProof.current()) {
        setBody({ phase: 'unavailable', reason: '事件已不在当前会话窗口' });
        return undefined;
      }
      const controller = new AbortController();
      let cancelled = false;
      fetchCardBody({ sessionId, durableId, senderSessionId, signal: controller.signal })
        .then((result) => {
          if (cancelled) return;
          if (result.phase === 'available' && !windowProof.current?.()) {
            setBody({ phase: 'unavailable', reason: '事件已不在当前会话窗口' });
            return;
          }
          // Identity-confirmed expand response doubles as a status refresh.
          if (result.row && typeof onFreshRow === 'function') onFreshRow(result.row);
          setBody({ ...result, identity: `${sessionId}\n${durableId}\n${senderSessionId}` });
        })
        .catch((error) => {
          if (cancelled || controller.signal.aborted) return;
          setBody({ phase: 'error', reason: String(error?.message ?? error) });
        });
      return () => {
        cancelled = true;
        controller.abort();
      };
    }, [durableId, sessionId, senderSessionId, retry, mode, cardOpen]);

    const from = data.fromDisplay || '发送会话';
    const to = data.toDisplay || '当前会话';
    const available = body?.phase === 'available' && body.identity === `${sessionId}\n${durableId}\n${senderSessionId}` && windowProof.current?.() === true;
    const info = statusDisplay(body?.row ?? data.row, data.statusAsOf, data.statusStale === true);
    const status = info.stale ? '状态未更新' : ['已进入上下文', '明确回复'].includes(info.label) ? '' : info.label;
    if (mode === 'card') return <SessionLinkCardLayout data={data} open={cardOpen} body={available ? body : body?.phase === 'available' ? { phase: 'unavailable', reason: '事件已不在当前会话窗口' } : body} onToggle={() => setCardOpen(value => !value)} onRetry={() => { setBody(null); setRetry(value => value + 1); }}/>;
    // Bubble mode (user decision 2026-11-06): the timeline only carries the
    // notice capsule. The message body is never laid out inline; clicking the
    // capsule opens the existing exchange dialog with the full interaction, so
    // the body is not even fetched until the reader asks for it.
    // The delivery state belongs inside the capsule; a bare trailing span would be
    // unstyled text that escapes the "capsule only" rule. The glyph follows the
    // same vocabulary as the sender side: ✓ confirmed, spinner waiting, × failed,
    // ? stale/unknown. Its meaning is in the label, so the glyph is decorative.
    // Received capsules never show a check (user decision 2026-11-08). The one
    // real waiting state is a recorded message still waiting to enter context;
    // every other state is already "received" and stays glyph-free.
    const marker = status ? receiverHint(status) : null;
    if (hidden) return null;
    return <div className="sl-chat-event" data-session-link-i18n-root="" data-session-link-direction="received" data-session-link-notice="" data-capsule-count={capsuleCount > 1 ? capsuleCount : undefined}>
      <ExchangeLink selfId={sessionId} peerId={senderSessionId} selfName={to} peerName={from} title={marker?.title}>{capsuleCount > 1 ? `收到消息 ×${capsuleCount}，来自 ${from}` : `收到消息，来自 ${from}`}{marker ? <span className={`sl-delivery-indicator sl-delivery-indicator--${marker.kind}`} role="status" aria-label={marker.title} title={marker.title}><span className="sl-delivery-spinner" aria-hidden="true"/></span> : null}</ExchangeLink>
    </div>;
  }
  return SessionLinkCardView;
}

export const inject = ['sessions', 'uiConversation', 'slots'];

export function installIncomingCards(ctx, { fetchImpl, refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS, onReady, groupStore: sharedGroupStore } = {}) {
  const sessions = ctx.sessions;
  // Capture the fetch function at install time (no late global lookup): a
  // disposed install can never reach a later-injected global fetch.
  const doFetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const refreshMs = Math.max(0, Number(refreshIntervalMs) || 0);
  /** Per-install work counters, exposed through the test seam `onReady`. */
  const stats = { scans: 0, windowWalks: 0, lookups: 0, reregisters: 0 };

  let disposed = false;
  let visibilityInstalled = false;
  /** Disposers of every slot renderer installed by this install. */
  const slotStops = [];

  /** `${sessionId}\n${durableMessageId}` → owner card_lookup row (recipient-confirmed). */
  const verified = new Map();
  /** same key → {asOf, stale}: local freshness of the row above. */
  const freshness = new Map();
  /** exact event object → Set(sessionId) observed holding it in a public event window. */
  const eventScopes = new WeakMap();
  /** `${sessionId}\n${durableMessageId}` already asked (definitive missing stays asked). */
  const queried = new Set();

  let lookupEnabled = true;
  let warnedLookupDisabled = false;
  let scanTimer = null;
  let retryTimer = null;
  /** Consecutive transient-failure retries; capped so a dead Host cannot poll. */
  let retryAttempts = 0;
  let scanning = false;
  let rescanRequested = false;
  let forceRefresh = false;
  let lastRefreshAt = Date.now();
  /**
   * sessionId → {source, stop}: current eventSource generation per session.
   * The source reference is what makes generation replacement detectable —
   * a same-id SessionBinding swap must unsubscribe the old feed.
   */
  const sourceStops = new Map();
  /** sessionId → appended entries captured at notification time (delta work). */
  const pendingDelta = new Map();
  /** sessions whose FULL window must be re-walked (replace/prepend/new source). */
  const dirtyFull = new Set();
  /** sessionId → Set(durableId) relay candidates currently in that window. */
  const windowIds = new Map();
  /** sessionId → Set(durableId) transient lookup failures queued for retry. */
  const retryIds = new Map();

  const scopeKey = (sessionId, durableId) => `${sessionId}\n${durableId}`;

  /** Bubble-mode capsule groups: sessionId → Map(seq → {head,count}). */
  const groupStore = sharedGroupStore ?? createCapsuleGroupStore();

  /** Build the visible capsule timeline from one session's public window. */
  function refreshCapsuleGroups(sessionId, source, { notify = true } = {}) {
    if (typeof source?.getSnapshot !== 'function') return;
    let snap;
    try { snap = source.getSnapshot(); } catch { return; }
    const items = [];
    let turn = null;
    for (const entry of snap.entries ?? []) {
      if (entry?.type !== 'event') continue;
      const event = entry.event;
      const data = event?.data;
      if (!event || typeof event.seq !== 'number') continue;
      if (event.type === 'turn/start') {
        if (Number.isSafeInteger(data?.turn)) turn = data.turn;
        items.push({ kind: 'break' });
        continue;
      }
      if (event.type === 'turn/end') { items.push({ kind: 'break' }); turn = null; continue; }
      if (Number.isSafeInteger(data?.turn)) turn = data.turn;
      if (event.type === 'user/message') {
        const relay = data?.source;
        if (isStandardRelaySource(relay) && typeof data?.id === 'string') {
          const row = verified.get(scopeKey(sessionId, data.id));
          // Use the same identity/surface/peer-claim gate as actual rendering.
          // A relay that falls back to native text is visible and breaks a run.
          if (row !== undefined && match(event) !== null) {
            items.push({
              kind: 'received', seq: event.seq, time: event.time,
              sender: relay.senderSessionId, messageKind: row.kind,
              status: capsuleStatusKey(row, freshness.get(scopeKey(sessionId, data.id))), turn,
            });
          } else items.push({ kind: 'break' });
          continue;
        }
        if (relay?.kind === 'time-context') continue;
        items.push({ kind: 'break' });
        continue;
      }
      if (event.type === 'tool/call') {
        if (['session_link_send', 'session_link_reply', 'session_link_create'].includes(data?.name)) {
          items.push({ kind: 'sent', seq: event.seq, time: event.time });
        } else if (['ask_user_question', 'exit_plan_mode', 'reqpool_request_key_state'].includes(data?.name)) {
          // These controls remain visible even when routine process is hidden.
          items.push({ kind: 'break' });
        }
        continue;
      }
      if (event.type === 'assistant/message') {
        const parts = data?.message?.content;
        const hasText = Array.isArray(parts)
          && parts.some(part => part?.type === 'text' && String(part.text ?? '').trim() !== '');
        if (hasText) items.push({ kind: 'break' });
      }
    }
    groupStore.setItems(sessionId, items, notify);
  }

  /** Public registry handle: route-table pre-check for exclusive conflicts. */
  const eventRegistry = ctx.uiConversation.events;
  /** Re-entrancy latch: a peer's match may call back into ours via the same pre-check. */
  let checkingExclusive = false;

  /**
   * Conservative exclusive-claim conflict guard (public SDK only).
   *
   * The dispatcher THROWS when two Definitions exclusive-claim one event on the
   * same target; the throw happens inside the async rebuild dispatch, where a
   * try/catch around reregister cannot reach it. Before we claim, ask the
   * public route table (`events.forEvent`) whether any OTHER definition with
   * OUR target would also exclusive-claim THIS event; if so, return null —
   * their claim proceeds alone (never swallowed, never doubled, no throw).
   *
   * Safety properties:
   *   - skips our own definition by kind (kind is registry-unique);
   *   - only same-target peers can conflict (claims are keyed per target);
   *   - re-entrancy latch: if a peer's match calls back into ours, the nested
   *     call sees the latch and declines the claim instead of recursing;
   *   - a throwing peer match is treated as conflict → we decline (their own
   *     dispatch call still surfaces their error — nothing is hidden);
   *   - match stays a pure sync function; peers are invoked exactly the way the
   *     dispatcher invokes them (matches are re-run on every rebuild anyway).
   * @param {Record<string, any>} event
   * @returns {boolean} true when another definition would claim this event+target
   */
  function exclusiveConflict(event) {
    if (checkingExclusive) return true; // re-entered from a peer's pre-check
    checkingExclusive = true;
    try {
      const routes = eventRegistry.forEvent?.(event.type);
      if (routes !== undefined && routes !== null) {
        for (const route of routes) {
          const definition = route?.definition;
          if (definition === undefined || definition.kind === KIND) continue; // never our own
          if (definition.target !== 'chat') continue; // conflict only on our target
          let result;
          try {
            result = route.match(event);
          } catch {
            return true; // peer broken → decline; dispatcher still calls them separately
          }
          if (result !== null && result !== undefined && result.exclusive === true) return true;
        }
        return false;
      }
      // Older registry without the route table: fall back to the public entry list.
      for (const definition of eventRegistry.entries?.() ?? []) {
        if (definition.kind === KIND || definition.target !== 'chat') continue;
        let result;
        try {
          result = definition.match.call(definition, event);
        } catch {
          return true;
        }
        if (result !== null && result !== undefined && result.exclusive === true) return true;
      }
      return false;
    } finally {
      checkingExclusive = false;
    }
  }

  /**
   * Sync match over the public event only.
   * Claim (exclusive) exclusively under the three-part gate above; otherwise
   * null → native projection keeps the message (safe fallback, single projection).
   * @param {Record<string, any>} event
   * @returns {{id: string, role: 'start', exclusive: true} | null}
   */
  function match(event) {
    if (event?.type !== 'user/message') return null;
    if (event.surfaceOp !== 'append') return null;
    const source = event.data?.source;
    if (!isStandardRelaySource(source)) return null;
    if (typeof event.data.id !== 'string' || event.data.id.length === 0) return null;
    const scopes = eventScopes.get(event);
    // Unscoped (never seen in a public window), or shared by >1 session
    // (fork/object-reuse conflict): conservatively keep the native projection.
    if (scopes === undefined || scopes.size !== 1) return null;
    const sessionId = scopes.values().next().value;
    const row = verified.get(scopeKey(sessionId, event.data.id));
    if (row === undefined) return null;
    // Exact fact binding against the ledger row, not just id membership:
    // the observed session must be the ledger recipient of this durable id...
    if (row.to !== sessionId) return null;
    // ...and the event's standard-relay sender must equal the ledger from.
    // (Same durable id re-copied with a tampered senderSessionId falls back native.)
    if (row.from !== source.senderSessionId) return null;
    // Never create a second exclusive claim on 'chat' for this event.
    if (exclusiveConflict(event)) return null;
    return { id: String(event.data.id), role: 'start', exclusive: true };
  }

  function start(_context, matchResult) {
    const event = matchResult.event;
    const scopes = eventScopes.get(event);
    const sessionId = scopes !== undefined && scopes.size === 1 ? scopes.values().next().value : undefined;
    const row = sessionId === undefined ? undefined : verified.get(scopeKey(sessionId, event.data.id));
    return {
      seq: event.seq,
      time: event.time,
      event,
      text: textOfUserMessage(event),
      senderSessionId: event.data.source.senderSessionId,
      durableMessageId: event.data.id,
      row: row ?? null,
    };
  }

  function update(context) {
    return context.state;
  }

  function buildViewNode(context) {
    const state = context.state;
    if (state === undefined || state === null) return null;
    const row = state.row;
    const event = state.event;
    const sessionId = typeof row?.to === 'string' ? row.to : '';
    // Subject comes only from the ledger row (server-side displaySubject =
    // sender subject or business-text excerpt) with a short kind label as the
    // last resort. Never excerpt the protocol wrapper into the header.
    const subject =
      typeof row?.subject === 'string' && row.subject.length > 0
        ? row.subject
        : KIND_SUBJECT[row?.kind] ?? '会话消息';
    const fromDisplay = typeof row?.fromTitle === 'string' && row.fromTitle.length > 0
      ? row.fromTitle
      : typeof row?.from === 'string'
        ? row.from
        : '';
    const toDisplay = typeof row?.toTitle === 'string' && row.toTitle.length > 0
      ? row.toTitle
      : typeof row?.to === 'string'
        ? row.to
        : '';
    // Per-node window-aliveness closure (no shared registry key at all): the
    // exact event must still be in THIS session's eventSource, single-scoped,
    // and the ledger facts this card was built from must still hold.
    const durableMessageId = state.durableMessageId;
    const isWindowCurrent =
      typeof durableMessageId === 'string' && durableMessageId.length > 0 && event !== undefined && sessionId !== ''
        ? () => {
            const scopes = eventScopes.get(event);
            if (scopes === undefined || scopes.size !== 1) return false;
            const scopeSessionId = scopes.values().next().value;
            if (scopeSessionId !== sessionId) return false;
            const rowNow = verified.get(scopeKey(scopeSessionId, durableMessageId));
            if (rowNow === undefined) return false;
            if (rowNow.to !== sessionId) return false;
            if (rowNow.from !== state.senderSessionId) return false;
            if (rowNow.durableMessageId !== durableMessageId) return false;
            try {
              const binding = sessions.binding(scopeSessionId);
              if (binding === undefined) return false;
              return binding.eventSource
                .getSnapshot()
                .entries.some((entry) => entry?.type === 'event' && entry.event === event);
            } catch {
              return false;
            }
          }
        : null;
    const fresh = sessionId !== '' ? freshness.get(scopeKey(sessionId, durableMessageId)) : undefined;
    const { seq, time, event: _event, ...rest } = state;
    return {
      key: context.key,
      kind: KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: seq,
      location: context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      // Stay outside the Turn's process disclosure so a received card remains
      // visible mid-step and after whole-turn folding; expected, needs isolated GUI verification.
      groupTree: 'input',
      data: {
        ...rest,
        row: row ?? null,
        subject,
        fromDisplay,
        toDisplay,
        kindMark: KIND_MARK[row?.kind] ?? '',
        // Verified ledger parent link. `session_link_send` can also continue a
        // chain from notifications/requests, so the parent is a REQUEST only
        // for a verified `reply`; every other kind gets the neutral label.
        parentMessageId: typeof row?.parentMessageId === 'string' ? row.parentMessageId : '',
        parentLabel:
          typeof row?.parentMessageId === 'string' && row.parentMessageId.length > 0
            ? row.kind === 'reply'
              ? '关联请求ID'
              : '关联消息ID'
            : '',
        status: typeof row?.status === 'string' ? row.status : '',
        statusAsOf: typeof fresh?.asOf === 'number' ? fresh.asOf : null,
        statusStale: fresh?.stale === true,
        isWindowCurrent,
        capsuleSessionId: sessionId,
        capsuleSeq: seq,
      },
    };
  }

  const definition = {
    kind: KIND,
    target: 'chat',
    // Table form: the dispatcher only routes user/message events to us.
    match: { 'user/message': match },
    start,
    update,
    buildViewNode,
  };

  /** Register once; on later verification batches dispose+re-register (public rebuild trigger). */
  let stopDefinition = ctx.uiConversation.events.register(definition);

  /** One dispose+register pair per batch → the registry listener coalesces a single rebuild. */
  function reregister() {
    if (disposed) return;
    stats.reregisters += 1;
    stopDefinition();
    stopDefinition = ctx.uiConversation.events.register(definition);
  }

  // Unmount abort: every in-flight lookup is cancelled on teardown.
  const aborter = new AbortController();

  /**
   * Host API URL resolved against the document base so a deployment prefix
   * (sub-path hosting) is honoured, matching the shipped client's callApi.
   * @param {string} path
   * @returns {string}
   */
  function apiUrl(path) {
    const base = globalThis.document?.baseURI ?? 'http://127.0.0.1/';
    return new URL(path, base).toString();
  }

  async function cardLookup(sessionId, ids) {
    stats.lookups += 1;
    const response = await doFetch(apiUrl('api/session-link/api'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      signal: aborter.signal,
      body: JSON.stringify({ action: 'card_lookup', payload: { sessionId, ids } }),
    });
    if (!response.ok) throw Object.assign(new Error(`card_lookup HTTP ${response.status}`), { httpStatus: response.status });
    const body = await response.json();
    if (body?.ok !== true) {
      throw Object.assign(new Error(body?.error?.message ?? 'card_lookup failed'), { code: body?.error?.code });
    }
    return body.value ?? { results: [], missing: [] };
  }

  /**
   * Apply one identity-confirmed row to the verified store (expand path).
   * Only updates keys that are ALREADY verified for the row's own recipient —
   * never bootstraps new identity from an expand response.
   * @param {Record<string, any>} row
   */
  function onFreshRow(row) {
    if (disposed || row === null || typeof row !== 'object') return;
    const durableId = typeof row.durableMessageId === 'string' ? row.durableMessageId : null;
    if (durableId === null || typeof row.to !== 'string') return;
    const key = scopeKey(row.to, durableId);
    const previous = verified.get(key);
    if (previous === undefined) return; // not verified → ignore
    if (row.from !== previous.from) return; // identity drift → ignore
    verified.set(key, row);
    freshness.set(key, { asOf: Date.now(), stale: false });
    const source = sessions.binding(row.to)?.eventSource;
    if (source) refreshCapsuleGroups(row.to, source);
    if (displayChanged(previous, row)) reregister();
  }

  /* ── incremental window processing ────────────────────────────────────── */

  /** Per-session window membership: relay durable ids in the CURRENT window. */
  function windowSet(sessionId) {
    let ids = windowIds.get(sessionId);
    if (ids === undefined) {
      ids = new Set();
      windowIds.set(sessionId, ids);
    }
    return ids;
  }

  /**
   * One durable window entry → scope + lookup bookkeeping.
   * Shared by the full-walk and delta paths; returns true when a scope grew.
   * @param {string} sessionId
   * @param {{type?: string, event?: Record<string, any>}} entry
   * @param {Set<string>} ids
   * @param {Map<string, string[]>} bySession
   * @returns {boolean}
   */
  function collectEntry(sessionId, entry, ids, bySession) {
    if (entry?.type !== 'event') return false;
    const event = entry.event;
    if (event?.type !== 'user/message') return false;
    if (event.surfaceOp !== 'append') return false;
    if (!isStandardRelaySource(event.data?.source)) return false;
    if (typeof event.data.id !== 'string' || event.data.id.length === 0) return false;
    let scopes = eventScopes.get(event);
    if (scopes === undefined) {
      scopes = new Set();
      eventScopes.set(event, scopes);
    }
    // A previously single-scoped (possibly already claimed) event gaining
    // ANOTHER session (fork/shared object) invalidates the claim: force a
    // rebuild even when no new verification arrives, so match falls back
    // native. Set.add returns the set (always truthy) — check has() first
    // so repeat scans of an already-shared event do NOT rebuild.
    const added = !scopes.has(sessionId);
    scopes.add(sessionId);
    const scopeChanged = added && scopes.size > 1;
    ids.add(event.data.id);
    const key = scopeKey(sessionId, event.data.id);
    if (verified.has(key) || queried.has(key)) return scopeChanged;
    queried.add(key);
    const bucket = bySession.get(sessionId) ?? [];
    bucket.push(event.data.id);
    bySession.set(sessionId, bucket);
    return scopeChanged;
  }

  /**
   * Coalesced work pass. Incremental by design:
   *   - only sessions whose window actually changed are walked (replace /
   *     prepend / first subscription) — an unchanged window is never re-read;
   *   - appends are processed as a DELTA of the entries captured at
   *     notification time (transient assistant chunks never get this far);
   *   - refresh candidates come from the maintained per-session window id
   *     sets, so out-of-window ids are never queried and no walk is needed.
   */
  async function scan() {
    if (disposed) return;
    if (scanning) {
      rescanRequested = true;
      return;
    }
    scanning = true;
    stats.scans += 1;
    try {
      const fullSessions = [...dirtyFull];
      dirtyFull.clear();
      const deltaSessions = [...pendingDelta.keys()];
      const bySession = new Map();
      let scopeChanged = false;

      // 1a. Full re-walk: replaced/prepended window or first subscription.
      for (const sessionId of fullSessions) {
        // A full walk covers everything the delta would have contributed.
        pendingDelta.delete(sessionId);
        const binding = sessions.binding(sessionId);
        if (binding === undefined) continue;
        let entries;
        try {
          entries = binding.eventSource.getSnapshot().entries;
        } catch {
          continue;
        }
        stats.windowWalks += 1;
        const ids = windowSet(sessionId);
        ids.clear();
        for (const entry of entries ?? []) {
          if (collectEntry(sessionId, entry, ids, bySession)) scopeChanged = true;
        }
      }

      // 1b. Delta appends: only entries captured at notification time.
      for (const sessionId of deltaSessions) {
        const entries = pendingDelta.get(sessionId) ?? [];
        pendingDelta.delete(sessionId);
        const ids = windowSet(sessionId);
        for (const entry of entries) {
          if (collectEntry(sessionId, entry, ids, bySession)) scopeChanged = true;
        }
      }

      // 1c. Transient lookup failures queued for retry (no window walk).
      for (const [sessionId, ids] of retryIds) {
        retryIds.delete(sessionId);
        const bucket = bySession.get(sessionId) ?? [];
        for (const id of ids) {
          const key = scopeKey(sessionId, id);
          if (verified.has(key) || queried.has(key)) continue;
          queried.add(key);
          bucket.push(id);
        }
        bySession.set(sessionId, bucket);
      }

      // 2. Refresh candidates: verified ids STILL in a current window only.
      const refreshBySession = new Map();
      for (const [sessionId, ids] of windowIds) {
        if (sessions.binding(sessionId) === undefined) continue;
        for (const id of ids) {
          if (!verified.has(scopeKey(sessionId, id))) continue;
          const bucket = refreshBySession.get(sessionId) ?? [];
          bucket.push(id);
          refreshBySession.set(sessionId, bucket);
        }
      }

      let refreshChanged = false;
      const refreshDue = lookupEnabled && (forceRefresh || Date.now() - lastRefreshAt >= refreshMs);
      if (refreshDue && refreshBySession.size > 0) {
        // One merged low-frequency pass over in-window verified ids (≤100 per
        // request). Consumes the throttle whether it succeeds or fails, so a
        // broken Host cannot cause a retry storm.
        forceRefresh = false;
        lastRefreshAt = Date.now();
        for (const [sessionId, ids] of refreshBySession) {
          for (let offset = 0; offset < ids.length; offset += LOOKUP_BATCH) {
            const chunk = ids.slice(offset, offset + LOOKUP_BATCH);
            try {
              const value = await cardLookup(sessionId, chunk);
              retryAttempts = 0;
              const returned = new Set();
              for (const row of value?.results ?? []) {
                const durableId = typeof row?.durableMessageId === 'string' ? row.durableMessageId : null;
                const askedId = durableId !== null && chunk.includes(durableId) ? durableId : chunk.includes(row?.id) ? row.id : null;
                if (askedId === null) continue;
                if (row.to !== sessionId) continue;
                const key = scopeKey(sessionId, askedId);
                const previous = verified.get(key);
                if (previous === undefined) continue;
                returned.add(askedId);
                verified.set(key, row);
                freshness.set(key, { asOf: Date.now(), stale: false });
                // Rebuild either way: display fields may have changed AND the
                // as-of stamp must re-render even for an identical row.
                refreshChanged = true;
              }
              for (const id of chunk) {
                if (returned.has(id)) continue;
                const key = scopeKey(sessionId, id);
                if (!verified.has(key)) continue;
                const fresh = freshness.get(key);
                if (fresh !== undefined && fresh.stale !== true) {
                  freshness.set(key, { ...fresh, stale: true });
                  refreshChanged = true;
                }
              }
            } catch (error) {
              if (disposed || aborter.signal.aborted) return;
              const missingHost =
                error?.httpStatus === 404 ||
                error?.code === 'invalid_argument' ||
                String(error?.message ?? '').includes('unknown action');
              if (missingHost) {
                lookupEnabled = false;
                warnedLookupDisabled = true;
                console.warn('[session-link-card] card_lookup unavailable on this Host; cards disabled, native projection kept.', error?.code ?? error?.message);
                break;
              }
              // Transport failure: keep last row, flag 状态未更新 (stale).
              for (const id of chunk) {
                const key = scopeKey(sessionId, id);
                const fresh = freshness.get(key);
                if (verified.has(key) && fresh !== undefined && fresh.stale !== true) {
                  freshness.set(key, { ...fresh, stale: true });
                  refreshChanged = true;
                }
              }
            }
          }
        }
      }

      let newlyVerified = 0;
      if (lookupEnabled && bySession.size > 0) {
        outer: for (const [sessionId, ids] of bySession) {
          for (let offset = 0; offset < ids.length; offset += LOOKUP_BATCH) {
            const chunk = ids.slice(offset, offset + LOOKUP_BATCH);
            try {
              const value = await cardLookup(sessionId, chunk);
              retryAttempts = 0;
              for (const row of value?.results ?? []) {
                const durableId = typeof row?.durableMessageId === 'string' ? row.durableMessageId : null;
                const askedId = durableId !== null && chunk.includes(durableId) ? durableId : chunk.includes(row?.id) ? row.id : null;
                if (askedId === null) continue;
                // The observed window session must be the ledger RECIPIENT of
                // this durable id; sender-side participation never verifies.
                if (row.to !== sessionId) continue;
                const key = scopeKey(sessionId, askedId);
                if (verified.has(key)) continue;
                verified.set(key, row);
                freshness.set(key, { asOf: Date.now(), stale: false });
                newlyVerified += 1;
              }
            } catch (error) {
              if (disposed || aborter.signal.aborted) return;
              const missingHost =
                error?.httpStatus === 404 ||
                error?.code === 'invalid_argument' ||
                String(error?.message ?? '').includes('unknown action');
              if (missingHost) {
                // Host without card_lookup: stay native, never guess identity.
                lookupEnabled = false;
                chunk.forEach((id) => queried.delete(scopeKey(sessionId, id)));
                if (!warnedLookupDisabled) {
                  warnedLookupDisabled = true;
                  console.warn('[session-link-card] card_lookup unavailable on this Host; cards disabled, native projection kept.', error?.code ?? error?.message);
                }
                break outer;
              }
              // Transient failure: retry these ids on the next pass (bounded).
              chunk.forEach((id) => queried.delete(scopeKey(sessionId, id)));
              const retry = retryIds.get(sessionId) ?? new Set();
              chunk.forEach((id) => retry.add(id));
              retryIds.set(sessionId, retry);
              scheduleRetry();
              console.warn('[session-link-card] card_lookup failed; retrying on next scan.', error?.message);
            }
          }
        }
      }

      if (!disposed) {
        // Initialize even a sent-only static window. Receiving a ledger row is
        // not a prerequisite for grouping the sender history on first open.
        const groupSessions = new Set([...fullSessions, ...deltaSessions, ...bySession.keys()]);
        if (refreshChanged) for (const id of refreshBySession.keys()) groupSessions.add(id);
        if (scopeChanged) for (const id of sourceStops.keys()) groupSessions.add(id);
        for (const id of groupSessions) {
          const source = sessions.binding(id)?.eventSource;
          if (source) refreshCapsuleGroups(id, source);
        }
      }
      if ((newlyVerified > 0 || scopeChanged || refreshChanged) && !disposed) {
        // One dispose+register pair per batch → the registry listener coalesces
        // a single rebuild (public API; no private assembler access).
        // scopeChanged also rebuilds: a shared/forked event object must drop any
        // earlier exclusive claim and fall back native even when lookups miss.
        // refreshChanged rebuilds so as-of/stale/status text re-renders.
        reregister();
      }
    } finally {
      scanning = false;
      if (rescanRequested && !disposed) {
        rescanRequested = false;
        scheduleScan();
      }
    }
  }

  function scheduleScan() {
    if (disposed || scanTimer !== null) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      void scan();
    }, SCAN_DEBOUNCE_MS);
  }

  /** Bounded retry for transient lookup failures (one timer, ≤3 rounds). */
  function scheduleRetry() {
    if (disposed || retryTimer !== null || retryAttempts >= RETRY_MAX_ATTEMPTS) return;
    retryAttempts += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      scheduleScan();
    }, RETRY_DELAY_MS);
  }

  /**
   * React to one eventSource publication WITHOUT scanning.
   * The change descriptor is the only thing inspected here: transient live
   * chunks (assistant/live-chunk etc.) match nothing and cost one filter pass —
   * no window walk, no owner lookup, no rebuild.
   * @param {string} sessionId
   * @param {object} source the eventSource generation this listener belongs to
   */
  function onWindowEvent(sessionId, source) {
    if (disposed) return;
    const state = sourceStops.get(sessionId);
    if (state === undefined || state.source !== source) return; // stale generation
    const binding = sessions.binding(sessionId);
    if (binding === undefined || binding.eventSource !== source) return; // replaced
    let snap;
    try {
      snap = source.getSnapshot();
    } catch {
      return;
    }
    const change = snap.change;
    if (change.kind === 'append') {
      let relevant = false;
      let groupDirty = false;
      let bucket;
      for (const entry of change.entries ?? []) {
        if (entry?.type !== 'event') continue; // transient assistant rows
        const event = entry.event;
        const type = event?.type;
        if (type === 'user/message' || type === 'tool/call' || type === 'assistant/message'
          || type === 'turn/start' || type === 'turn/end' || type === 'step/start' || type === 'step/end') {
          groupDirty = true;
        }
        if (type === 'user/message') {
          if (event.surfaceOp !== 'append' || !isStandardRelaySource(event.data?.source)) continue;
          if (typeof event.data.id !== 'string' || event.data.id.length === 0) continue;
          bucket ??= pendingDelta.get(sessionId) ?? [];
          bucket.push(entry);
          pendingDelta.set(sessionId, bucket);
          relevant = true;
        } else if (type === 'step/start' || type === 'step/end' || type === 'turn/start' || type === 'turn/end') {
          // Low-frequency refresh trigger (status as-of pass), not a lookup.
          relevant = true;
        }
      }
      if (groupDirty) refreshCapsuleGroups(sessionId, source);
      if (relevant) scheduleScan();
      return;
    }
    if (change.kind === 'replace' || change.kind === 'prepend') {
      // Window content changed wholesale (compaction / paging / fork rebind):
      // re-walk this one session, never every session.
      dirtyFull.add(sessionId);
      pendingDelta.delete(sessionId);
      refreshCapsuleGroups(sessionId, source);
      scheduleScan();
      return;
    }
    if (change.kind === 'settle-assistant') {
      // Only transient rows are replaced by their durable settlement; relay
      // candidates are durable entries and window membership is unaffected.
      const entry = change.entry;
      if (entry?.type === 'event' && entry.event?.type === 'user/message') {
        dirtyFull.add(sessionId);
        scheduleScan();
      }
      // Durable assistant text can introduce a visible boundary after streaming.
      refreshCapsuleGroups(sessionId, source);
      return;
    }
    // Unknown future change kind: conservative single-session re-walk.
    dirtyFull.add(sessionId);
    refreshCapsuleGroups(sessionId, source);
    scheduleScan();
  }

  /** Revoke per-session identity/caches tied to one eventSource generation. */
  function revokeSession(sessionId) {
    groupStore.removeSession(sessionId);
    const prefix = `${sessionId}\n`;
    for (const key of [...verified.keys()]) if (key.startsWith(prefix)) verified.delete(key);
    for (const key of [...freshness.keys()]) if (key.startsWith(prefix)) freshness.delete(key);
    for (const key of [...queried]) if (key.startsWith(prefix)) queried.delete(key);
    windowIds.delete(sessionId);
    pendingDelta.delete(sessionId);
    dirtyFull.delete(sessionId);
    retryIds.delete(sessionId);
  }

  /**
   * Bind/unbind event feeds, keyed by sessionId AND by the exact eventSource
   * reference: a same-id SessionBinding/generation swap must unsubscribe the
   * old feed (it would otherwise stay silent forever) and re-walk the new one.
   */
  function reconcileSources() {
    if (disposed) return;
    const list = sessions.list.getSnapshot();
    const live = new Set();
    let changed = false;
    for (const summary of Object.values(list.byId ?? {})) {
      if (typeof summary?.id !== 'string') continue;
      live.add(summary.id);
      const binding = sessions.binding(summary.id);
      if (binding === undefined) continue;
      const source = binding.eventSource;
      if (typeof source?.subscribe !== 'function') continue;
      const existing = sourceStops.get(summary.id);
      if (existing !== undefined) {
        if (existing.source === source) continue; // same generation → keep
        // Generation replaced under the same sessionId: drop the old feed and
        // every cache derived from the old window, then bind and re-walk.
        try {
          existing.stop();
        } catch {
          // Already torn down.
        }
        sourceStops.delete(summary.id);
        revokeSession(summary.id);
        changed = true;
      }
      try {
        const stop = source.subscribe(() => onWindowEvent(summary.id, source));
        sourceStops.set(summary.id, { source, stop });
        dirtyFull.add(summary.id); // first subscription → full walk
        changed = true;
      } catch {
        // Stale binding: skip; a later list change retries.
      }
    }
    for (const [sessionId, state] of [...sourceStops]) {
      if (live.has(sessionId)) continue;
      sourceStops.delete(sessionId);
      try {
        state.stop();
      } catch {
        // Already torn down.
      }
      revokeSession(sessionId);
      changed = true;
    }
    scheduleScan();
  }

  // Tab-visible → one forced merged refresh of in-window verified ids.
  const onVisibility = () => {
    if (disposed) return;
    if (globalThis.document?.visibilityState === 'visible') {
      forceRefresh = true;
      scheduleScan();
    }
  };

  /**
   * Idempotent rollback/dispose: releases EVERY non-effect resource installed
   * by this call — Definition, slot renderers, list/source subscriptions,
   * visibility listener, timers, in-flight requests and all identity caches.
   * Used both by `ctx.effect` (normal disposal) and by the setup catch below.
   */
  function releaseAll() {
    if (disposed) return;
    disposed = true;
    // Cancels in-flight card_lookup AND on-demand body fetches.
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
    if (visibilityInstalled) {
      globalThis.document?.removeEventListener?.('visibilitychange', onVisibility);
      visibilityInstalled = false;
    }
    try {
      stopList?.();
    } catch {
      // Already disposed.
    }
    stopList = null;
    for (const state of sourceStops.values()) {
      try {
        state.stop();
      } catch {
        // Teardown best-effort.
      }
    }
    sourceStops.clear();
    if (scanTimer !== null) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    verified.clear();
    freshness.clear();
    windowIds.clear();
    pendingDelta.clear();
    dirtyFull.clear();
    retryIds.clear();
    queried.clear();
  }

  let stopList = null;
  try {
    stopList = sessions.list.subscribe(reconcileSources);
    reconcileSources();

    const fetchCardBody = createBodyFetcher({ url: apiUrl('api/session-link/api'), fetchImpl: doFetch });
    const CardView = createSessionLinkCardView({ fetchCardBody, onFreshRow, groupStore });
    slotStops.push(
      ctx.slots.inject('conversation.chat.node', () =>
        ctx.slots.register({ name: 'conversation.chat.node', key: KIND }, CardView),
      ),
    );

    if (typeof globalThis.document?.addEventListener === 'function') {
      globalThis.document.addEventListener('visibilitychange', onVisibility);
      visibilityInstalled = true;
    }

    ctx.effect(() => () => releaseAll(), 'session-link-card: teardown');

    if (typeof onReady === 'function') {
      onReady({
        stats,
        // Test seam: one forced merged pass (tab-visible semantics).
        scan: () => {
          forceRefresh = true;
          scheduleScan();
        },
      });
    }
  } catch (error) {
    // Synchronous setup failure: remove EVERYTHING already installed (including
    // a Definition registered before this block and any list/source feed,
    // timer or in-flight request), then surface the original error.
    releaseAll();
    throw error;
  }
}
