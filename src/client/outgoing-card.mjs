// Sender-side session-link card Definition — public SDK only.
//
// Registered through `uiConversation.events.register` (own kind, target `chat`);
// rendered through the public keyed `conversation.chat.node` slot. NON-exclusive
// by owner decision: the native tool execution row / turn-process / turn-tail
// keep every event (business card vs. technical record = two information
// layers, not two business cards).
//
// Rendering gate (user decision — a fork must never masquerade as a new send):
//   1. the tool/call and its tool/result must both be in the CURRENT public
//      window (lib/window-scope.mjs — SessionBinding.eventSource);
//   2. the result must be extractable to ledger message ids (send/reply →
//      results[].id, create → firstMessage.id);
//   3. an owner-only `card_lookup` must return a row for EVERY id with
//      `row.from === current sessionId` (lib/card-verify.mjs);
//   4. per-tool ledger cross-checks must hold:
//        send   → set(row.to) === set(args.targets)
//        reply  → single row && row.parentMessageId === args.messageId
//        create → single row && row.to === result.sessionId
//   Any failure (fork history, lookup missing/404, no result, out-of-window,
//   error result incl. AUTO_REVIEW_DENIED) → buildViewNode returns null and
//   the native tool record stands alone. Nothing is ever guessed.
//
// `claim: 'exclusive'` remains exploration evidence only (it strips shared
// turn-level Definitions — see the gap tests); not a candidate.

import { extractResultIds } from './outgoing-card-verify.mjs';
import { statusDisplay } from './outgoing-status.mjs';
import { capsuleStatusKey } from './capsule-status.mjs';

export const CARD_KIND = 'session-link-sender-card';
const OUR_TOOLS = new Set(['session_link_send', 'session_link_reply', 'session_link_create']);
const BODY_EXCERPT_LIMIT = 80;
const RESULT_EXCERPT_LIMIT = 200;

/** Deterministic first-line short excerpt; no model call (PLAN B.1). */
export function excerpt(text, limit = BODY_EXCERPT_LIMIT) {
  if (typeof text !== 'string') return null;
  // Backend firstLineExcerpt semantics: first NON-empty line (a blank first
  // line must not degrade the subject to a fallback).
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim() !== '') ?? '';
  const trimmed = line.trim();
  if (trimmed === '') return null;
  // Truncate by Unicode CODE POINTS so an emoji is never split in half.
  const points = Array.from(trimmed);
  return points.length <= limit ? trimmed : `${points.slice(0, limit).join('')}…`;
}
/** PLAN B.1 alias: sender subject fallback. */
export const subjectExcerpt = excerpt;

/**
 * Short id for the header: whole id when already short (≤12), else the UUID
 * head block, else the first 8 chars — never a long id in the main visual.
 */
export function shortId(id) {
  if (typeof id !== 'string' || id === '') return '';
  if (id.length <= 12) return id;
  const head = id.split('-')[0];
  if (head.length >= 4 && head.length <= 12) return head;
  return id.slice(0, 8);
}

/** Header side label: ledger title first, short id fallback, honest unknown. */
export function displayLabel(title, id, unknown = '未知') {
  const trimmed = typeof title === 'string' ? title.trim() : '';
  if (trimmed !== '') return trimmed;
  const short = shortId(id);
  return short === '' ? unknown : short;
}

/**
 * Line-1 labels from REAL ledger titles: `fromTitle`/`toTitle` first; identical
 * titles across distinct recipients are disambiguated with the short id;
 * missing titles fall back to the short id. Never a long raw session id.
 */
export function resolveDisplays(rows) {
  const first = rows[0] ?? {};
  const from = displayLabel(first.fromTitle, first.from, '未知发送会话');
  const bases = rows.map((row) => ({
    id: row.to,
    title: typeof row.toTitle === 'string' ? row.toTitle.trim() : '',
    label: displayLabel(row.toTitle, row.to, '未知接收者'),
  }));
  const counts = new Map();
  for (const base of bases) counts.set(base.label, (counts.get(base.label) ?? 0) + 1);
  const to = bases.map((base) => {
    if ((counts.get(base.label) ?? 0) < 2) return base.label;
    const short = shortId(base.id);
    if (base.title !== '') return `${base.title}(${short})`;
    return short === '' ? base.label : short;
  });
  return { from, to };
}

function safeJson(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const value = JSON.parse(raw);
    return value !== null && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function resultExcerpt(content) {
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
  if (text === '') return null;
  return text.length <= RESULT_EXCERPT_LIMIT ? text : `${text.slice(0, RESULT_EXCERPT_LIMIT)}…`;
}

function sameStringSet(left, right) {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

/** Line-1 composition, pure and unit-tested: `发送者 → 接收者`. */
export function composeHeader({ from, to }) {
  const sender = typeof from === 'string' && from !== '' ? from : '未知发送会话';
  const recipients = Array.isArray(to) && to.length > 0 ? to.join('、') : '未知接收者';
  return `${sender} → ${recipients}`;
}

/**
 * @param options.windowScope - public window scope (lib/window-scope.mjs).
 * @param options.verifier - owner-only ledger verifier (lib/card-verify.mjs).
 * @param options.claim - 'coexist' (default) | 'exclusive' (exploration only).
 */
export function createSenderCardDefinition({ windowScope, verifier, claim = 'coexist' } = {}) {
  if (windowScope === undefined || typeof windowScope.resolveResult !== 'function') {
    throw new Error('session-link-sender-card requires the public window scope (SessionBinding.eventSource)');
  }
  if (verifier === undefined || typeof verifier.has !== 'function') {
    throw new Error('session-link-sender-card requires the owner-only ledger verifier (card_lookup)');
  }
  if (claim !== 'coexist' && claim !== 'exclusive') throw new Error(`unknown claim strategy ${claim}`);
  const exclusive = claim === 'exclusive';
  const claimFlags = exclusive ? { exclusive: true } : {};

  const isOurTool = (name) => typeof name === 'string' && OUR_TOOLS.has(name);

  return {
    kind: CARD_KIND,
    target: 'chat',
    match(event) {
      if (event.type === 'assistant/live-chunk') {
        const chunk = event.data.chunk;
        // Only claim deltas that already carry OUR name. Anonymous early deltas
        // stay native: they cannot start the native tool root without a name
        // (applyDelta @ui-chat client.js:10184), so assistant-step keeps every
        // streaming chunk and no native row exists yet to duplicate.
        if (chunk.type === 'tool-call-delta' && isOurTool(chunk.name)) {
          return { id: String(chunk.id), role: 'start', ...claimFlags };
        }
        return null;
      }
      if (event.type === 'tool/call' && isOurTool(event.data.name)) {
        return { id: String(event.data.callId), role: 'start', ...claimFlags };
      }
      if (event.type === 'tool/result') {
        // Model-only replacement copies never surface: only append-origin
        // results are evidence (isAppendSurfaceEvent semantics).
        if (event.surfaceOp !== 'append') return null;
        // Failed delivery (incl. AUTO_REVIEW_DENIED / permission denial):
        // the native error row owns it; no business card is ever produced.
        if (event.data?.message?.isError === true) return null;
        const { ids } = extractResultIds(event);
        if (ids.length === 0) return null;
        const callId = String(event.data?.message?.source?.callId ?? '');
        const owner = windowScope.resolveResult(event, callId);
        if (owner === null) return null;
        // Unverified → no claim: native owns the result until card_lookup
        // confirms row.from === owner for every id (then a rebuild re-runs
        // this match and the card appears).
        if (!verifier.has(owner, ids)) return null;
        return { id: callId, role: 'update', ...claimFlags };
      }
      return null;
    },
    start(_context, match) {
      const event = match.event;
      if (event.type === 'tool/call') {
        return {
          call: { callId: String(event.data.callId), name: event.data.name, argsRaw: event.data.arguments, seq: event.seq, time: event.time, turn: event.data.turn },
          result: null,
        };
      }
      return {
        call: { callId: String(event.data.chunk.id), name: event.data.chunk.name, argsRaw: '', seq: event.seq, time: event.time },
        result: null,
      };
    },
    update(context, match) {
      const event = match.event;
      const state = context.state ?? { call: null, result: null };
      if (event.type === 'tool/call') {
        if (state.call === null) {
          return {
            call: { callId: String(event.data.callId), name: event.data.name, argsRaw: event.data.arguments, seq: event.seq, time: event.time, turn: event.data.turn },
            result: state.result,
          };
        }
        // A streaming start is provisional. Grouping, anchors and evidence all
        // bind to the durable call, not to its earlier live-chunk sequence.
        return { ...state, call: { ...state.call, argsRaw: event.data.arguments,
          name: event.data.name ?? state.call.name, seq: event.seq, time: event.time, turn: event.data.turn } };
      }
      if (event.type === 'tool/result') {
        const message = event.data.message;
        const { value, ids, sessionId } = extractResultIds(event);
        return {
          ...state,
          result: {
            seq: event.seq,
            time: event.time,
            isError: message.isError === true,
            text: resultExcerpt(message.content),
            value,
            ids,
            // The unique current window that owns BOTH call and result.
            owner: windowScope.resolveResult(event, String(message?.source?.callId ?? '')),
            resultSessionId: sessionId,
          },
        };
      }
      return state;
    },
    buildViewNode(context) {
      const current = context.current.get('chat');
      const state = context.state;
      if (state === undefined || state.call === null || state.result === null || state.result.isError === true) {
        return current === undefined || current === null ? null : { ...current, visibility: 'hidden' };
      }

      const call = state.call;
      const result = state.result;
      const owner = result.owner;
      const rows = owner === null ? null : verifier.get(owner, result.ids);
      if (rows === null || rows.length !== result.ids.length) return null;
      // Fork/identity hard gate: every row must show THIS window's session as
      // the real sender; a copied history row (from = another session) means
      // this session never sent it → no card, native record only.
      if (rows.some((row) => row.from !== owner)) return null;

      const args = safeJson(call.argsRaw) ?? {};
      switch (call.name) {
        case 'session_link_send': {
          const targets = Array.isArray(args.targets) ? args.targets.filter((t) => typeof t === 'string') : [];
          if (targets.length === 0 || !sameStringSet(targets, rows.map((row) => row.to))) return null;
          break;
        }
        case 'session_link_reply': {
          if (rows.length !== 1) return null;
          if (typeof args.messageId !== 'string' || rows[0].parentMessageId !== args.messageId) return null;
          break;
        }
        case 'session_link_create': {
          if (rows.length !== 1) return null;
          // Recipient comes from result.sessionId and must equal the ledger row.
          if (result.resultSessionId === null || rows[0].to !== result.resultSessionId) return null;
          break;
        }
        default:
          return null;
      }

      // Kind gate: the FIRST-LINE tag comes from the verified ledger row.kind
      // (request / reply; notification carries no tag). Multi-target cards draw
      // only when every row agrees on one non-empty kind — otherwise the card
      // falls back to the native record.
      const kinds = rows.map((row) => (typeof row.kind === 'string' ? row.kind : ''));
      if (kinds.some((kind) => kind === '') || new Set(kinds).size !== 1) return null;
      const kind = kinds[0];
      const kindTag = kind === 'request' ? '请求' : kind === 'reply' ? '回复' : null;

      // Subject/body: explicit subject first; default excerpt of the actually
      // sent text (send/reply) or task (create) — never a tool name or id.
      const bodyCandidate = typeof args.text === 'string' ? args.text : typeof args.task === 'string' ? args.task : null;
      const subject = excerpt(args.subject) ?? excerpt(bodyCandidate);

      // Header labels from ledger titles (short-id fallback/disambiguation).
      const displays = resolveDisplays(rows);

      // Status: receiver-tested truth table per row + local 截至/stale freshness.
      // Multi-target aggregation: the card-level 截至 is the EARLIEST of all
      // known per-target lookups (a newer batch must never make an older
      // target look fresher). If ANY target has no valid asOf, no precise
      // card-level timestamp is claimed and the card is flagged 未更新/需核对;
      // each target keeps its own asOf in the technical details.
      const fresh = rows.map((row) => verifier.freshnessOf(owner, row.id) ?? { asOf: null, stale: false });
      const targetStatus = rows.map((row, index) => {
        const local = fresh[index] ?? {};
        const targetAsOf = typeof local.asOf === 'number' ? local.asOf : null;
        return {
          target: row.to,
          status: row.status,
          label: statusDisplay(row, targetAsOf, local.stale === true).label,
          asOf: targetAsOf,
          stale: local.stale === true,
        };
      });
      const labels = [...new Set(targetStatus.map((entry) => entry.label))];
      const asOfs = targetStatus.map((entry) => entry.asOf);
      const allAsOfKnown = asOfs.length > 0 && asOfs.every((value) => typeof value === 'number');
      const data = {
        callId: call.callId,
        tool: call.name,
        kind,
        kindTag,
        from: rows[0].from,
        fromDisplay: displays.from,
        to: rows.map((row) => row.to),
        toDisplay: displays.to,
        replyTo: rows[0].parentMessageId ?? null,
        subject,
        body: bodyCandidate,
        bodyCollapsed: true,
        status: labels.length === 1 ? labels[0] : '多目标状态',
        time: call.time ?? result.time ?? null,
        turn: call.turn ?? context.start?.location?.turn?.turn ?? null,
        capsuleStatus: rows.length === 1 ? capsuleStatusKey(rows[0], fresh[0]) : null,
        // Earliest known lookup, or NO precise time when any target is unknown.
        statusAsOf: allAsOfKnown ? Math.min(...asOfs) : null,
        // Any failed refresh OR any target without a valid asOf → 状态未更新/需核对.
        statusStale: targetStatus.some((entry) => entry.stale === true) || !allAsOfKnown,
        evidence: {
          callSeq: call.seq,
          resultSeq: result.seq,
          messageIds: [...result.ids],
          resultExcerpt: result.text,
        },
        targetStatus,
      };

      return {
        key: context.key,
        kind: CARD_KIND,
        id: context.id,
        target: 'chat',
        anchorSeq: call.seq,
        location: context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' },
        visibility: 'visible',
        // Outside the completed-Turn process fold (ui-chat DEPTH @175-189,
        // isAtOrOutside @187): the business card survives the process collapse
        // while the native tool row folds with it (two information layers).
        groupTree: 'turn',
        data,
      };
    },
  };
}
