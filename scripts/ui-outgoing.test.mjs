// Product-side unit tests for the outgoing (sender) card modules migrated from
// scripts/v04-sender-spike. Pure Node: real logic modules + the bundled JSX
// entry (esbuild in-memory, react external). No Host, no browser, no network.
// Run: node --test scripts/ui-outgoing.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

import { createWindowScope } from '../src/client/outgoing-window-scope.mjs';
import { createOutgoingCoordinator } from '../src/client/outgoing-coordinator.mjs';
import { createCardVerifier, extractResultIds, parseResultValue } from '../src/client/outgoing-card-verify.mjs';
import { statusDisplay } from '../src/client/outgoing-status.mjs';
import {
  CARD_KIND,
  composeHeader,
  createSenderCardDefinition,
  displayLabel,
  excerpt,
  resolveDisplays,
  shortId,
} from '../src/client/outgoing-card.mjs';
import { CARD_CSS, cardClass } from '../src/client/card-shell.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoReq = createRequire(path.join(here, '../package.json'));

/** Bundle the JSX entry in memory (same externals as the repo build). */
async function loadOutgoingCards() {
  const result = await build({
    absWorkingDir: path.join(here, '..'),
    entryPoints: ['src/client/outgoing-cards.jsx'],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    external: ['react', 'react-dom'],
    logLevel: 'silent',
  });
  const code = result.outputFiles[0].text;
  const module = { exports: {} };
  const req = (name) => {
    if (name === 'react' || name === 'react-dom' || name === 'react/jsx-runtime') return repoReq(name);
    throw new Error(`unexpected require: ${name}`);
  };
  new Function('require', 'module', 'exports', code)(req, module, module.exports);
  return module.exports;
}

// ---- event fixtures (engine.js result shapes) ----

const SEND_ARGS = JSON.stringify({
  targets: ['sess-B', 'sess-C'],
  kind: 'notification',
  text: '第一行主题\n第二行正文。',
  operationId: 'op-1',
  subject: '联调卡片',
});
const SEND_VALUE = {
  operationId: 'op-1',
  idempotent: false,
  chainId: 'chain-1',
  held: false,
  results: [
    { target: 'sess-B', id: 'msg-b', status: 'accepted', error: null },
    { target: 'sess-C', id: 'msg-c', status: 'unknown', error: null },
  ],
};
const SEND_ROWS = [
  { id: 'msg-b', durableMessageId: 'd-b', from: 'sess-A', fromTitle: '主会话A', to: 'sess-B', toTitle: '协作B', kind: 'notification', subject: null, chainId: 'chain-1', parentMessageId: null, status: 'accepted', replyStatus: 'none', receipt: { policy: 'context', state: 'received', receivedAt: 1700000000000, receivedSeq: 7 } },
  { id: 'msg-c', durableMessageId: 'd-c', from: 'sess-A', fromTitle: '主会话A', to: 'sess-C', toTitle: '协作C', kind: 'notification', subject: null, chainId: 'chain-1', parentMessageId: null, status: 'unknown', replyStatus: 'none', receipt: { policy: 'context', state: 'queued', receivedAt: null, receivedSeq: null } },
];

function toolCallEvent({ callId = 'call-1', name = 'session_link_send', args = SEND_ARGS } = {}) {
  return { type: 'tool/call', seq: 7, time: 1700000000009, data: { callId, name, arguments: args, turn: 1, step: 0 } };
}
function toolResultEvent({ callId = 'call-1', value = SEND_VALUE, isError = false } = {}) {
  return {
    type: 'tool/result',
    seq: 8,
    time: 1700000000010,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 0,
      message: {
        source: { callId },
        content: [{ type: 'text', text: JSON.stringify(value) }],
        isError,
      },
    },
  };
}

function fakeWindowScope({ owner = 'sess-A', shared = false } = {}) {
  return {
    resolveResult: () => (shared ? null : owner),
    resolveEvent: () => (shared ? null : owner),
  };
}

function mockVerifier(rowsBySession) {
  const fetchImpl = async (_url, init) => {
    const { sessionId, ids } = JSON.parse(init.body).payload;
    const known = rowsBySession[sessionId] ?? [];
    const results = known.filter((row) => ids.includes(row.id));
    const missing = ids.filter((id) => !results.some((row) => row.id === id));
    return { ok: true, status: 200, json: async () => ({ ok: true, value: { results, missing } }) };
  };
  return createCardVerifier({ fetchImpl });
}

/** Definition + a started context carrying call+result (owner already resolved). */
async function cardContext({ rows = SEND_ROWS, sessionId = 'sess-A', args = SEND_ARGS, value = SEND_VALUE, name = 'session_link_send', isError = false, rowOverride } = {}) {
  const verifier = mockVerifier({ [sessionId]: rowOverride ?? rows });
  await verifier.verify(
    sessionId,
    (rowOverride ?? rows).map((row) => row.id),
  );
  const definition = createSenderCardDefinition({ windowScope: fakeWindowScope({ owner: sessionId }), verifier });
  const callMatch = { event: toolCallEvent({ name, args }) };
  let state = definition.start(null, callMatch);
  state = definition.update({ state }, { event: toolResultEvent({ value, isError }) });
  const startEvent = callMatch.event;
  const context = {
    state,
    current: { get: () => undefined },
    start: { event: startEvent, location: { kind: 'step', turn: { turn: 1 }, step: { step: 0 } } },
    matches: [{ event: startEvent }],
  };
  return { definition, verifier, context };
}

// ---- logic modules ----

test('definition: coexist non-exclusive matches; ordinary tools and error results stay native', async () => {
  const verifier = mockVerifier({ 'sess-A': SEND_ROWS });
  const definition = createSenderCardDefinition({ windowScope: fakeWindowScope(), verifier });

  assert.deepEqual(definition.match(toolCallEvent()), { id: 'call-1', role: 'start' }, 'no exclusive flag (non-exclusive)');
  assert.equal(definition.match(toolCallEvent({ name: 'bash' })), null, 'ordinary tool untouched');
  assert.equal(definition.match(toolResultEvent({ isError: true })), null, 'failed delivery never claimed (AUTO_REVIEW_DENIED gate)');
  assert.equal(definition.match(toolResultEvent()), null, 'unverified result stays native');

  await verifier.verify('sess-A', ['msg-b', 'msg-c']);
  assert.deepEqual(definition.match(toolResultEvent()), { id: 'call-1', role: 'update' }, 'verified result joins the card');
});

test('definition: result ids extracted per engine shapes; unparseable → nothing', () => {
  assert.deepEqual(extractResultIds(toolResultEvent()).ids, ['msg-b', 'msg-c']);
  const create = toolResultEvent({
    value: { operationId: 'op', phase: 'sent', sessionId: 'sess-New', firstMessage: { id: 'msg-f', status: 'pending', error: null } },
  });
  assert.deepEqual(extractResultIds(create).ids, ['msg-f']);
  assert.equal(extractResultIds(create).sessionId, 'sess-New');
  assert.deepEqual(extractResultIds(toolResultEvent({ value: 'not-json' })).ids, []);
  assert.equal(parseResultValue({ data: { message: { content: [] } } }), null);
});

test('four-door negatives: fork row.from / targets / reply parent / create recipient all refuse the card', async () => {
  // Door 3: rows from another session (fork history).
  const fork = await cardContext({ sessionId: 'sess-B', rowOverride: SEND_ROWS.map((row) => ({ ...row, from: 'sess-A' })) });
  assert.equal(fork.context.state.call !== null, true);
  // verifier keyed under sess-B finds nothing → match refused earlier; emulate
  // the residual case where rows exist but from differs:
  const wrongVerifier = mockVerifier({ 'sess-B': SEND_ROWS });
  await wrongVerifier.verify('sess-B', ['msg-b', 'msg-c']);
  const forkDef = createSenderCardDefinition({ windowScope: fakeWindowScope({ owner: 'sess-B' }), verifier: wrongVerifier });
  const forkState = {
    call: { callId: 'call-1', name: 'session_link_send', argsRaw: SEND_ARGS, seq: 7 },
    result: { seq: 8, isError: false, ids: ['msg-b', 'msg-c'], owner: 'sess-B', value: SEND_VALUE, resultSessionId: null, text: null },
  };
  assert.equal(
    forkDef.buildViewNode({ state: forkState, current: { get: () => undefined }, start: { event: toolCallEvent(), location: { kind: 'step', turn: { turn: 1 }, step: { step: 0 } } }, matches: [] }),
    null,
    'row.from !== window session → no card',
  );

  // Door 4a: send target set mismatch.
  const partial = await cardContext({ rowOverride: [SEND_ROWS[0]] });
  assert.equal(partial.definition.buildViewNode(partial.context), null, 'args.targets demand two rows, ledger has one');

  // Door 4b: reply parent mismatch.
  const replyArgs = JSON.stringify({ messageId: 'msg-parent', text: '回复内容', operationId: 'op-3' });
  const replyValue = { operationId: 'op-3', idempotent: false, chainId: 'chain-1', held: false, results: [{ target: 'sess-B', id: 'msg-r', status: 'accepted', error: null }] };
  const replyRow = { id: 'msg-r', from: 'sess-A', to: 'sess-B', kind: 'reply', parentMessageId: 'msg-OTHER', status: 'accepted', chainId: 'chain-1', subject: null, replyStatus: 'none', receipt: null };
  const reply = await cardContext({ rows: [replyRow], args: replyArgs, value: replyValue, name: 'session_link_reply' });
  assert.equal(reply.definition.buildViewNode(reply.context), null, 'ledger parent must match args.messageId');

  // Door 4c: create recipient mismatch (result.sessionId ≠ row.to).
  const createArgs = JSON.stringify({ operationId: 'op-9', task: '任务' });
  const createValue = { operationId: 'op-9', phase: 'sent', sessionId: 'sess-Other', firstMessage: { id: 'msg-f', status: 'pending', error: null }, error: null };
  const createRow = { id: 'msg-f', from: 'sess-A', to: 'sess-New', status: 'pending', parentMessageId: null, chainId: 'c', kind: 'request', subject: null, replyStatus: 'none', receipt: null };
  const create = await cardContext({ rows: [createRow], args: createArgs, value: createValue, name: 'session_link_create' });
  assert.equal(create.definition.buildViewNode(create.context), null, 'recipient must equal result.sessionId');
});

test('card data: ledger titles, truth-table status, 截至/stale, per-target labels, honest evidence', async () => {
  const { definition, context } = await cardContext();
  const node = definition.buildViewNode(context);
  assert.ok(node !== null, 'verified send renders');
  assert.equal(node.groupTree, 'turn');
  assert.equal(node.anchorSeq, 7, 'original call time anchor');

  const data = node.data;
  assert.equal(data.from, 'sess-A', 'raw id kept as evidence');
  assert.equal(data.fromDisplay, '主会话A', 'line 1 prefers ledger fromTitle');
  assert.deepEqual(data.toDisplay, ['协作B', '协作C'], 'line 1 prefers ledger toTitle');
  assert.equal(data.subject, '联调卡片');
  assert.equal(data.bodyCollapsed, true);
  assert.equal(data.status, '多目标状态', 'mixed labels stay mixed');
  assert.equal(typeof data.statusAsOf, 'number', 'local 截至 attached');
  assert.equal(data.statusStale, false);
  assert.deepEqual(
    data.targetStatus.map((entry) => ({ target: entry.target, status: entry.status, label: entry.label, stale: entry.stale })),
    [
      { target: 'sess-B', status: 'accepted', label: '已进入上下文', stale: false },
      { target: 'sess-C', status: 'unknown', label: '需核对', stale: false },
    ],
    'per-target labels via the receiver-tested truth table',
  );
  assert.ok(data.targetStatus.every((entry) => typeof entry.asOf === 'number'), 'each target keeps its own local asOf');
  assert.deepEqual(data.evidence.messageIds, ['msg-b', 'msg-c']);
  assert.ok(!JSON.stringify(data).includes('argumentsDelta'), 'no streaming args leakage');
});

test('create card: subject/body from args.task, recipient from result.sessionId ↔ row.to', async () => {
  const createArgs = JSON.stringify({ operationId: 'op-9', task: '新任务第一行\n第二行细节', workspaceId: 'ws-1' });
  const createValue = { operationId: 'op-9', idempotent: false, phase: 'sent', sessionId: 'sess-New', firstMessage: { id: 'msg-f', status: 'pending', error: null }, error: null };
  const createRow = { id: 'msg-f', from: 'sess-A', to: 'sess-New', status: 'pending', parentMessageId: null, chainId: 'chain-9', kind: 'request', subject: null, replyStatus: 'none', receipt: { policy: 'context', state: 'queued', receivedAt: null, receivedSeq: null } };
  const { definition, context } = await cardContext({ rows: [createRow], args: createArgs, value: createValue, name: 'session_link_create' });
  const data = definition.buildViewNode(context).data;
  assert.equal(data.subject, '新任务第一行', 'default subject = first line of the actual task');
  assert.notEqual(data.subject, 'session_link_create', 'tool name never becomes the subject');
  assert.equal(data.body, '新任务第一行\n第二行细节');
  assert.deepEqual(data.to, ['sess-New']);
  assert.equal(data.status, '待投递');
});

test('status truth table (reused from receiver): precise labels, no read/handled claims', () => {
  const t = (row) => statusDisplay(row).label;
  assert.equal(t({ status: 'pending' }), '待投递');
  assert.equal(t({ status: 'held' }), '已暂存·待投递');
  assert.equal(t({ status: 'dispatching' }), '投递中·结果待确认');
  assert.equal(t({ status: 'unknown' }), '需核对');
  assert.equal(t({ status: 'failed' }), '失败');
  assert.equal(t({ status: 'cancelled' }), '已取消');
  assert.equal(t({ status: 'accepted', receipt: { policy: 'legacy-accepted', state: 'received' } }), '宿主已接收·进入上下文未确认');
  assert.equal(t({ status: 'accepted', receipt: { policy: 'context', state: 'queued' } }), '宿主已接收·待进入上下文');
  assert.equal(t({ status: 'accepted', receipt: { policy: 'context', state: 'received', receivedAt: 1700000000000 } }), '已进入上下文');
  assert.equal(t({ status: 'accepted', receipt: { policy: 'context', state: 'received' }, replyStatus: 'answered' }), '明确回复');
  assert.equal(t({ status: 'accepted', receipt: { policy: 'context', state: 'received' }, replyStatus: 'timed_out' }), '已进入上下文 · 等待回复超时');
  assert.equal(t({ status: 'pending', replyStatus: 'timed_out' }), '待投递 · 等待回复超时');
  assert.equal(t(undefined), '需核对');
  assert.equal(statusDisplay({ status: 'pending' }, null, true).stale, true, 'failed refresh keeps row + stale flag');
});

test('header helpers: ledger titles first, short-id fallback, same-title disambiguation', () => {
  assert.equal(displayLabel('', 'sess-A'), 'sess-A');
  assert.equal(shortId('0f8a2c4e-1111-2222-3333-444455556666'), '0f8a2c4e');
  assert.equal(displayLabel('  主会话A  ', 'long-id'), '主会话A');
  const displays = resolveDisplays([
    { from: 'sess-A', fromTitle: '主会话A', to: 'sess-X', toTitle: '同名组' },
    { from: 'sess-A', fromTitle: '主会话A', to: 'sess-Y', toTitle: '同名组' },
    { from: 'sess-A', fromTitle: '主会话A', to: 'sess-Z', toTitle: '独一名' },
  ]);
  assert.deepEqual(displays.to, ['同名组(sess-X)', '同名组(sess-Y)', '独一名']);
  assert.equal(composeHeader(displays), '主会话A → 同名组(sess-X)、同名组(sess-Y)、独一名');
  assert.equal(composeHeader({ from: null, to: null }), '未知发送会话 → 未知接收者');
  assert.equal(excerpt('  主题  \nbody'), '主题');
});

test('verifier: chunked ≤100, negative cache, revoke, stale-on-failed-refresh, no per-card polling', async () => {
  const ids = Array.from({ length: 250 }, (_, index) => `id-${index}`);
  const chunkCalls = [];
  const chunkVerifier = createCardVerifier({
    fetchImpl: async (_url, init) => {
      const { ids: asked } = JSON.parse(init.body).payload;
      chunkCalls.push(asked.length);
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { results: [], missing: asked } }) };
    },
  });
  await chunkVerifier.verify('sess-A', ids);
  assert.deepEqual(chunkCalls, [100, 100, 50], 'technical pagination cap');

  let fail = false;
  let current = [{ id: 'msg-b', durableMessageId: 'd', from: 'sess-A', to: 'sess-B', kind: 'notification', subject: null, chainId: 'c', parentMessageId: null, status: 'pending', replyStatus: 'none', receipt: { policy: 'context', state: 'queued', receivedAt: null, receivedSeq: null } }];
  const calls = [];
  const verifier = createCardVerifier({
    refreshIntervalMs: 60_000,
    fetchImpl: async (_url, init) => {
      const { sessionId, ids } = JSON.parse(init.body).payload;
      calls.push(ids.join(','));
      if (fail) return { ok: false, status: 500, json: async () => ({}) };
      const results = (current ?? []).filter((row) => ids.includes(row.id));
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { results, missing: [] } }) };
    },
  });
  await verifier.verify('sess-A', ['msg-b']);
  assert.equal(typeof verifier.freshnessOf('sess-A', 'msg-b').asOf, 'number');
  await verifier.refresh('sess-A', ['msg-b']);
  assert.equal(calls.length, 1, 'throttled: no per-card high-frequency polling');

  current = [{ ...current[0], status: 'accepted', receipt: { policy: 'context', state: 'received', receivedAt: 1700000005000, receivedSeq: 9 } }];
  await verifier.refresh('sess-A', ['msg-b'], { force: true });
  assert.equal(calls.length, 2, 'forced refresh (tab visible / card expand)');
  assert.equal(verifier.get('sess-A', ['msg-b'])[0].receipt.state, 'received');

  fail = true;
  await verifier.refresh('sess-A', ['msg-b'], { force: true });
  assert.equal(verifier.has('sess-A', ['msg-b']), true, 'last row kept on failure');
  assert.equal(verifier.freshnessOf('sess-A', 'msg-b').stale, true, 'failed refresh → 状态未更新');

  verifier.revoke(() => false);
  assert.equal(verifier.has('sess-A', ['msg-b']), false, 'expired window drops rows + freshness');
});

test('window scope: unique resolution / shared object / missing binding all fall back', () => {
  const bindings = new Map();
  const service = {
    list: { getSnapshot: () => ({ byId: Object.fromEntries([...bindings.keys()].map((id) => [id, { id }])) }) },
    binding: (id) => bindings.get(id),
  };
  const scope = createWindowScope({ sessions: service });
  const call = toolCallEvent();
  const result = toolResultEvent();
  const window = (entries) => ({ getSnapshot: () => ({ entries, revision: 1, change: { kind: 'replace', entries: [] }, hasMore: false }) });
  bindings.set('sess-A', { sessionId: 'sess-A', eventSource: window([{ event: call }, { event: result }]) });

  assert.equal(scope.resolveResult(result, 'call-1'), 'sess-A');
  assert.equal(scope.resolveResult({ ...result }, 'call-1'), null, 'object not in window → null');
  assert.equal(scope.resolveResult(result, 'missing'), null);

  bindings.set('sess-B', { sessionId: 'sess-B', eventSource: window([{ event: call }, { event: result }]) });
  assert.equal(scope.resolveResult(result, 'call-1'), null, 'shared object → null (no guessing)');
  bindings.delete('sess-A');
  bindings.delete('sess-B');
  assert.equal(scope.resolveResult(result, 'call-1'), null, 'no binding → null');
});

// ---- bundled JSX entry ----

test('entry surface: installOutgoingCards registers the non-exclusive definition + exactly three toolview keys', async () => {
  const mod = await loadOutgoingCards();
  assert.equal(typeof mod.installOutgoingCards, 'function');
  assert.deepEqual(mod.inject, ['sessions', 'uiConversation', 'slots']);
  assert.deepEqual([...mod.TOOL_KEYS], ['session_link_send', 'session_link_reply', 'session_link_create']);
  assert.throws(() => mod.assertToolKey('bash'), /refuses toolview key/);

  const registered = { definitions: [], slots: [] };
  const ctx = {
    sessions: {
      list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} },
      binding: () => undefined,
    },
    uiConversation: { events: { register: (def) => { registered.definitions.push(def); return () => {}; } } },
    slots: {
      inject: (name, factory) => factory(),
      register: (descriptor, component) => { registered.slots.push({ descriptor, component }); return () => {}; },
    },
    effect: (fn) => fn(),
  };
  mod.installOutgoingCards(ctx, { fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) });

  const definition = registered.definitions.at(-1);
  assert.equal(definition.kind, CARD_KIND);
  assert.equal(definition.target, 'chat');
  assert.deepEqual(definition.match(toolCallEvent()), { id: 'call-1', role: 'start' }, 'non-exclusive');

  const nodeRenders = registered.slots.filter((slot) => slot.descriptor?.name === 'conversation.chat.node');
  assert.equal(nodeRenders.length, 1);
  assert.equal(nodeRenders[0].descriptor.key, CARD_KIND);
  const toolviews = registered.slots.filter((slot) => slot.descriptor?.name === 'tool.call.toolview');
  assert.deepEqual(toolviews.map((slot) => slot.descriptor.key).sort(), ['session_link_create', 'session_link_reply', 'session_link_send']);
});

test('card structure: exactly three compact lines by default; body and closed tech details only after expand', async () => {
  const mod = await loadOutgoingCards();
  const cardData = {
    callId: 'call-1',
    tool: 'session_link_send',
    kind: 'reply',
    kindTag: '回复',
    from: 'sess-A',
    fromDisplay: '主会话A',
    to: ['sess-B'],
    toDisplay: ['协作B'],
    replyTo: 'msg-42-full-uuid-0000',
    subject: '已收到，正在跟进',
    body: '第一行主题\n第二行正文',
    bodyCollapsed: true,
    status: '已进入上下文',
    statusAsOf: 1700000009000,
    statusStale: false,
    evidence: { callSeq: 7, resultSeq: 8, messageIds: ['msg-1'], resultExcerpt: null },
    targetStatus: [{ target: 'sess-B', status: 'accepted', label: '已进入上下文' }],
  };
  const textOf = (element) => {
    if (element === null || element === undefined || typeof element === 'boolean') return '';
    if (typeof element === 'string' || typeof element === 'number') return String(element);
    if (Array.isArray(element)) return element.map(textOf).join('');
    if (typeof element === 'object' && 'props' in element) return textOf(element.props.children);
    return '';
  };
  const findByAttr = (element, attr) => {
    if (element === null || element === undefined || typeof element !== 'object') return null;
    if (Array.isArray(element)) {
      for (const child of element) {
        const hit = findByAttr(child, attr);
        if (hit !== null) return hit;
      }
      return null;
    }
    if (element.props?.[attr] !== undefined) return element;
    return findByAttr(element.props?.children, attr);
  };
  const Layout = mod.SenderCardLayout;

  // ---- default (collapsed): ONLY the two-line clickable header ----
  const refreshCalls = [];
  const toggles = [];
  const collapsed = Layout({
    data: cardData,
    open: false,
    onToggle: () => toggles.push('toggle'),
    onRefresh: (payload) => refreshCalls.push(payload),
  });

  // One outer frame owns the surface; the toggle is not a second card.
  assert.equal(collapsed.type, 'div', 'one outer frame div');
  assert.equal(collapsed.props.className, cardClass('sent'), 'shared sent frame class');
  assert.equal(collapsed.props['data-session-link-direction'], 'sent', 'direction attribute for QA');
  assert.equal(collapsed.props['data-session-link-card'], 'call-1', 'original card data attribute kept');
  assert.match(CARD_CSS, /\.sl-card\s*\{[^}]*border:\s*1px solid #B9C8DE/, 'frame owns the border');
  assert.match(CARD_CSS, /\.sl-card--sent\s*\{[^}]*background:\s*#EDF1F7/, 'frame owns the light sent surface');

  const toggle = findByAttr(collapsed, 'data-session-link-card-toggle');
  assert.ok(toggle !== null, 'one clickable two-line card button');
  assert.equal(toggle.type, 'button', 'native <button> → Enter/Space keyboard toggling');
  assert.equal(toggle.props['aria-expanded'], false, 'collapsed by default');
  assert.equal(toggle.props.className, 'sl-card__toggle', 'shared header toggle class');
  assert.equal(toggle.props.style, undefined, 'no per-node surface styles (CARD_CSS owns them)');
  assert.match(CARD_CSS, /\.sl-card__toggle\s*\{[^}]*border:\s*0/, 'header never draws its own frame border');
  assert.match(CARD_CSS, /\.sl-card__toggle\s*\{[^}]*background:\s*transparent/, 'header is transparent inside the frame');

  // Contrast: no HTML-invalid block children inside <button>.
  const findDiv = (element) => {
    if (element === null || element === undefined || typeof element !== 'object') return null;
    if (Array.isArray(element)) {
      for (const child of element) {
        const hit = findDiv(child);
        if (hit !== null) return hit;
      }
      return null;
    }
    if (element.type === 'div') return element;
    return findDiv(element.props?.children);
  };
  assert.equal(findDiv(toggle), null, 'button children are spans only (valid nesting)');
  // Valid nesting: no interactive/details content inside the header button.
  assert.equal(findByAttr(toggle, 'data-session-link-card-tech'), null, 'no <details> inside the header button');
  assert.equal(findByAttr(toggle, 'data-session-link-card-inspect'), null, 'no nested button inside the header button');
  assert.equal(findByAttr(toggle, 'data-session-link-card-expanded'), null, 'expanded region is a sibling');

  const senderRow = findByAttr(collapsed, 'data-session-link-card-sender-row');
  assert.equal(senderRow.type, 'span', 'line 1 is a span row (not a div inside the button)');
  assert.equal(senderRow.props.className, 'sl-card__party', 'party row layout');
  assert.equal(textOf(findByAttr(senderRow, 'data-session-link-card-sender')).trim(), '主会话A', 'line 1 sender name');
  assert.ok(textOf(senderRow).includes('发件人'), 'line 1 absolute 发件人 label');
  const toggleLabel = findByAttr(senderRow, 'data-session-link-card-toggle-text');
  assert.equal(textOf(toggleLabel).trim(), '展开 ⌄', 'right-top expand text on the same toggle button');
  assert.equal(toggle.props['aria-label'].includes('展开 ⌄'), true, 'toggle accessible name carries the action');
  assert.equal(findByAttr(collapsed, 'data-session-link-card-kind'), null, 'no visible 请求/回复 kind chip');
  assert.ok(!textOf(collapsed).includes('回复'), 'data.kindTag is never rendered as a chip');

  const recipientRow = findByAttr(collapsed, 'data-session-link-card-recipient-row');
  assert.equal(textOf(findByAttr(recipientRow, 'data-session-link-card-recipient')).trim(), '协作B', 'line 2 recipient name');
  assert.ok(textOf(recipientRow).includes('收件人'), 'line 2 absolute 收件人 label');
  assert.equal(findByAttr(collapsed, 'data-session-link-card-chip'), null, 'no direction chip anywhere on the face');

  const subject = findByAttr(collapsed, 'data-session-link-card-subject');
  assert.equal(subject.type, 'span', 'line 3 is a span row');
  assert.equal(subject.props.className, 'sl-card__party');
  assert.equal(textOf(subject).includes('主题'), true, 'line 3 carries the 主题 field label');
  const subjectRowText = textOf(subject);
  assert.ok(subjectRowText.includes('已收到，正在跟进'), 'line 3: real subject');
  const statusChip = findByAttr(collapsed, 'data-session-link-card-status');
  assert.equal(statusChip.type, 'span', 'status is a separate element after the subject');
  assert.equal(statusChip.props.className, 'sl-card__status', 'status flex item never squeezes the subject');
  assert.ok(/截至 \d{2}:\d{2}/.test(textOf(statusChip)), 'short local clock, not a full date');
  assert.ok(!textOf(subject).includes('已进入上下文已收到'), 'subject and status are separate elements, never concatenated');

  // Default must NOT render the body or the technical details at all.
  assert.equal(findByAttr(collapsed, 'data-session-link-card-body'), null, '业务正文 not present when collapsed');
  assert.equal(findByAttr(collapsed, 'data-session-link-card-tech'), null, '技术详情 not present when collapsed');
  assert.equal(findByAttr(collapsed, 'data-session-link-card-expanded'), null, 'no expanded region by default');
  assert.ok(!textOf(collapsed).includes('第一行主题'), 'no business body text in the default tree');

  // Multi-target: every real recipient is shown, never a fabricated single one.
  const multi = Layout({ data: { ...cardData, toDisplay: ['协作B', '协作C'], to: ['sess-B', 'sess-C'] }, open: false });
  assert.equal(textOf(findByAttr(multi, 'data-session-link-card-recipient')).trim(), '协作B、协作C', 'all real recipients listed');
  assert.equal(findByAttr(multi, 'data-session-link-card-recipient').props.title, '协作B、协作C', 'full recipient list recoverable');

  // Container holds exactly [header button, (expanded div only when open)].
  const collapsedChildren = (Array.isArray(collapsed.props.children) ? collapsed.props.children : [collapsed.props.children]).filter((child) => child !== null && child !== undefined);
  assert.equal(collapsedChildren.length, 1, 'collapsed container has the button only');
  assert.equal(collapsedChildren[0].type, 'button', 'the single child is the header button');

  // Clicking the collapsed card requests exactly one refresh and toggles open.
  toggle.props.onClick();
  assert.deepEqual(refreshCalls, [{ sessionId: 'sess-A', ids: ['msg-1'] }], 'expand triggers one batched refresh');
  assert.deepEqual(toggles, ['toggle']);

  // ---- expanded: real body + ONE default-closed technical details ----
  const expanded = Layout({
    data: cardData,
    open: true,
    onToggle: () => toggles.push('toggle-2'),
    onRefresh: (payload) => refreshCalls.push(payload),
  });
  const expandedToggle = findByAttr(expanded, 'data-session-link-card-toggle');
  assert.equal(expandedToggle.props['aria-expanded'], true);
  assert.equal(textOf(findByAttr(expanded, 'data-session-link-card-toggle-text')).trim(), '收起 ⌃', 'expanded label becomes 收起 ⌃ on the same button');
  const expandedChildren = (Array.isArray(expanded.props.children) ? expanded.props.children : [expanded.props.children]).filter((child) => child !== null && child !== undefined);
  assert.equal(expandedChildren.length, 2, 'container = header button + expanded sibling region');
  assert.equal(expandedChildren[0].type, 'button', 'button first');
  assert.equal(expandedChildren[1].type, 'div', 'expanded region is a plain sibling div (valid nesting)');
  assert.equal(expandedChildren[1].props.className, 'sl-card__expanded', 'same frame, expanded is a region not a card');
  assert.equal(expandedChildren[1].props.style, undefined, 'expanded region adds no second border/background');
  assert.match(CARD_CSS, /\.sl-card__expanded\s*\{[^}]*border-top:\s*1px solid/, 'only a thin separator inside the same frame');
  assert.equal(findByAttr(expandedToggle, 'data-session-link-card-tech'), null, 'details never nests in the header button');
  const body = findByAttr(expanded, 'data-session-link-card-body');
  assert.ok(body !== null, 'business body available after expand');
  assert.equal(body.type, 'pre', 'outgoing body keeps the pre element');
  assert.ok(body.props.className.split(/\s+/).includes('sl-card__body--pre'), 'pre uses the wrapping shell class');
  assert.match(CARD_CSS, /\.sl-card__body\s*\{[^}]*white-space:\s*pre-wrap/, 'long body keeps original line breaks');
  assert.match(CARD_CSS, /\.sl-card__body\s*\{[^}]*overflow-wrap:\s*anywhere/, 'long words/URLs break instead of overflowing');
  assert.match(CARD_CSS, /\.sl-card__body--pre\s*\{[^}]*font:\s*inherit/, 'pre inherits the host font');
  assert.ok(textOf(body).includes('第一行主题'), 'real body text shown');
  const tech = findByAttr(expanded, 'data-session-link-card-tech');
  assert.ok(tech !== null, 'single technical details after expand');
  assert.equal(tech.props.open, undefined, 'technical details itself stays default-closed');
  assert.ok(textOf(tech).includes('kind: reply'), 'real ledger kind stays in technical details');
  assert.ok(textOf(tech).includes('关联请求ID: msg-42-full-uuid-0000'), 'parent request semantics kept out of the card face');
  assert.ok(textOf(tech).includes('msg-42-full-uuid-0000'), 'full UUID only inside closed technical details');
  assert.ok(textOf(tech).includes('目标状态:'), 'per-target ledger statuses live in the closed technical details');
  assert.ok(textOf(tech).includes('sess-B=已进入上下文'));
  // Clicking an OPEN card does not refresh again.
  const beforeOpenClick = refreshCalls.length;
  expandedToggle.props.onClick();
  assert.equal(refreshCalls.length, beforeOpenClick, 'collapse click never re-requests evidence');

  // Native inspect entry (owner inspectCall) appears only in the expanded
  // region, is a real button, and forwards the call id.
  const inspected = [];
  const withInspect = Layout({ data: cardData, open: true, inspectCall: (callId) => inspected.push(callId) });
  const inspectButton = findByAttr(withInspect, 'data-session-link-card-inspect');
  assert.ok(inspectButton !== null, '查看轨迹 available when the host provides inspectCall');
  assert.equal(inspectButton.type, 'button');
  assert.equal(findByAttr(findByAttr(withInspect, 'data-session-link-card-toggle'), 'data-session-link-card-inspect'), null, 'not nested in the header button');
  inspectButton.props.onClick();
  assert.deepEqual(inspected, ['call-1'], 'forwards the card callId, never executes args');
  const withoutInspect = Layout({ data: cardData, open: true });
  assert.equal(findByAttr(withoutInspect, 'data-session-link-card-inspect'), null, 'hidden when inspectCall is absent');

  // ---- stale + unknown sides stay honest in the two-line header ----
  const stale = Layout({ data: { ...cardData, statusAsOf: null, statusStale: true } });
  const staleText = textOf(findByAttr(stale, 'data-session-link-card-status'));
  assert.ok(staleText.includes('状态未更新') && !staleText.includes('截至'));
  const unknown = Layout({ data: { ...cardData, fromDisplay: null, from: null, toDisplay: [], to: null } });
  assert.equal(textOf(findByAttr(unknown, 'data-session-link-card-sender')).trim(), '未知发送会话');
  assert.equal(textOf(findByAttr(unknown, 'data-session-link-card-recipient')).trim(), '未知接收者');
});

test('toolview: brief visible status; complete args/result/error in closed tech details; honest missing call', async () => {
  const mod = await loadOutgoingCards();
  const textOf = (element) => {
    if (element === null || element === undefined || typeof element === 'boolean') return '';
    if (typeof element === 'string' || typeof element === 'number') return String(element);
    if (Array.isArray(element)) return element.map(textOf).join('');
    if (typeof element === 'object' && 'props' in element) return textOf(element.props.children);
    return '';
  };
  const findByAttr = (element, attr) => {
    if (element === null || element === undefined || typeof element !== 'object') return null;
    if (Array.isArray(element)) {
      for (const child of element) {
        const hit = findByAttr(child, attr);
        if (hit !== null) return hit;
      }
      return null;
    }
    if (element.props?.[attr] !== undefined) return element;
    return findByAttr(element.props?.children, attr);
  };
  const View = mod.createSessionLinkToolview();

  const start = View({ phase: 'start', callId: 'c', block: { argsRaw: '{"text":"秘密正文"}' } });
  assert.ok(textOf(findByAttr(start, 'data-session-link-toolview-status')).includes('执行中'));
  const startTech = findByAttr(start, 'data-session-link-toolview-tech');
  assert.equal(startTech.props.open, undefined, 'closed by default');
  assert.ok(textOf(startTech).includes('秘密正文'), 'complete args preserved');

  const done = View({
    phase: 'result',
    callId: 'c',
    block: { call: { name: 'session_link_send', argsRaw: '{"targets":["sess-B"]}' }, content: [{ type: 'text', text: '{"ok":true}' }], isError: false },
  });
  const doneTech = textOf(findByAttr(done, 'data-session-link-toolview-tech'));
  assert.ok(doneTech.includes('{"targets":["sess-B"]}') && doneTech.includes('{"ok":true}'));

  const orphan = View({ phase: 'result', callId: 'c', block: { call: null, content: [{ type: 'text', text: 'ok' }], isError: false } });
  const orphanTech = textOf(findByAttr(orphan, 'data-session-link-toolview-tech'));
  assert.ok(orphanTech.includes('参数未加载') && orphanTech.includes('ok'), 'call out of window stated honestly');

  const failed = View({
    phase: 'result',
    callId: 'c',
    block: { call: { name: 'session_link_send', argsRaw: '{}' }, content: [], isError: true, error: { name: 'PermissionError', code: 'AUTO_REVIEW_DENIED', reason: 'denied' } },
  });
  const failedTech = textOf(findByAttr(failed, 'data-session-link-toolview-tech'));
  assert.ok(failedTech.includes('AUTO_REVIEW_DENIED') && failedTech.includes('denied'));
  assert.ok(textOf(findByAttr(failed, 'data-session-link-toolview-status')).includes('宿主返回错误'));

  const preparing = View({ phase: 'preparing', callId: 'c', block: { name: 'session_link_send' } });
  assert.ok(textOf(findByAttr(preparing, 'data-session-link-toolview-tech')).includes('参数流式接收中'));
});

test('install scan: verifies against card_lookup, rebuilds once, never queries error results', async () => {
  const mod = await loadOutgoingCards();
  const call = toolCallEvent();
  const okResult = toolResultEvent();
  const errorResult = toolResultEvent({ isError: true, value: { error: { code: 'AUTO_REVIEW_DENIED' } } });
  const entries = [
    { type: 'event', event: call },
    { type: 'event', event: okResult },
    { type: 'event', event: errorResult },
  ];
  const listeners = new Set();
  const binding = {
    sessionId: 'sess-A',
    eventSource: {
      getSnapshot: () => ({ entries, revision: 1, change: { kind: 'replace', entries: [] }, hasMore: false }),
      subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    },
  };
  const registered = { definitions: [], slots: [] };
  const ctx = {
    sessions: {
      list: { getSnapshot: () => ({ byId: { 'sess-A': { id: 'sess-A' } } }), subscribe: () => () => {} },
      binding: (id) => (id === 'sess-A' ? binding : undefined),
    },
    uiConversation: { events: { register: (def) => { registered.definitions.push(def); return () => {}; } } },
    slots: {
      inject: (name, factory) => factory(),
      register: (descriptor, component) => { registered.slots.push({ descriptor, component }); return () => {}; },
    },
    effect: (fn) => fn(),
  };
  const lookups = [];
  const fetchImpl = async (_url, init) => {
    const { sessionId, ids } = JSON.parse(init.body).payload;
    lookups.push({ sessionId, ids });
    const results = SEND_ROWS.filter((row) => row.from === sessionId && ids.includes(row.id));
    const missing = ids.filter((id) => !results.some((row) => row.id === id));
    return { ok: true, status: 200, json: async () => ({ ok: true, value: { results, missing } }) };
  };
  let scan = null;
  mod.installOutgoingCards(ctx, { fetchImpl, onReady: (handle) => { scan = handle.scan; } });
  const initial = registered.definitions.length;
  assert.equal(typeof scan, 'function', 'coordinator handle injected via options (no module hooks)');
  await scan();
  await new Promise((resolve) => queueMicrotask(resolve));

  assert.deepEqual(lookups, [{ sessionId: 'sess-A', ids: ['msg-b', 'msg-c'] }], 'one merged lookup; error result ids excluded');
  const definition = registered.definitions.at(-1);
  assert.deepEqual(definition.match(okResult), { id: 'call-1', role: 'update' }, 'verified result claims after rebuild');
  assert.equal(registered.definitions.length, initial + 1, 'exactly one dispose+re-register rebuild');
});

// ---- P1: scanner must never starve the event loop ----

/** Fake binding with a publish() that mimics MutableSessionEventSource. */
function makePublishableBinding(initialEntries) {
  const listeners = new Set();
  const state = {
    entries: initialEntries,
    revision: 1,
    change: { kind: 'replace', entries: [] },
    hasMore: false,
  };
  return {
    sessionId: 'sess-A',
    eventSource: {
      getSnapshot: () => ({ ...state, entries: state.entries }),
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
    publish(change, entries = state.entries) {
      state.entries = entries;
      state.revision += 1;
      state.change = change;
      for (const fn of [...listeners]) fn();
    },
  };
}

function installWithFetch(fetchImpl, binding) {
  const registered = { definitions: [], slots: [] };
  const ctx = {
    sessions: {
      list: { getSnapshot: () => ({ byId: { 'sess-A': { id: 'sess-A' } } }), subscribe: () => () => {} },
      binding: (id) => (id === 'sess-A' ? binding : undefined),
    },
    uiConversation: { events: { register: (def) => { registered.definitions.push(def); return () => {}; } } },
    slots: {
      inject: (name, factory) => factory(),
      register: (descriptor, component) => { registered.slots.push({ descriptor, component }); return () => {}; },
    },
    effect: (fn) => fn(),
  };
  return { mod: null, ctx, registered };
}

const okLookup = (rows) => async (_url, init) => {
  const { sessionId, ids } = JSON.parse(init.body).payload;
  const results = rows.filter((row) => row.from === sessionId && ids.includes(row.id));
  const missing = ids.filter((id) => !results.some((row) => row.id === id));
  return { ok: true, status: 200, json: async () => ({ ok: true, value: { results, missing } }) };
};

test('P1: a second event during a pending fetch stays bounded — timers run, exactly one rescan after resolve', async () => {
  const mod = await loadOutgoingCards();
  const call = toolCallEvent();
  const result = toolResultEvent();
  const binding = makePublishableBinding([
    { type: 'event', event: call },
    { type: 'event', event: result },
  ]);

  let releaseFirst;
  const firstPending = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    if (calls === 1) await firstPending;
    return okLookup(SEND_ROWS)(url, init);
  };
  const { ctx, registered } = installWithFetch(fetchImpl, binding);
  let scan = null;
  let stats = null;
  mod.installOutgoingCards(ctx, { fetchImpl, onReady: (handle) => { scan = handle.scan; stats = handle.stats; } });

  const firstScan = scan();
  assert.equal(calls, 1, 'first pass reached the network synchronously');
  assert.equal(stats().passes, 0, 'pass completes only after the pending fetch');

  // Second event WHILE the first fetch is pending: must only raise the flag.
  binding.publish({ kind: 'append', entries: [{ type: 'event', event: result }] });

  // Bounded real-event-loop assertion: a normal timer must still fire while
  // the scan is awaiting the network (no unbounded microtask chain).
  const timerResult = await new Promise((resolve) => {
    const guard = setTimeout(() => resolve('guard-timeout'), 2000);
    setTimeout(() => {
      clearTimeout(guard);
      resolve('fired');
    }, 5);
  });
  assert.equal(timerResult, 'fired', 'setTimeout executes while the scan awaits the network');
  assert.equal(calls, 1, 'no additional scan started while the first pass is pending');

  releaseFirst();
  await firstScan;

  // Bounded (capped) wait for the single follow-up pass — never an unbounded loop.
  for (let i = 0; i < 200 && stats().passes < 2; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stats().passes, 2, 'exactly one rescan after the pending pass resolved');
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stats().passes, 2, 'no runaway rescan chain afterwards (bounded)');
  assert.equal(calls, 1, 'the rescan found the rows already verified → no duplicate HTTP');
  assert.ok(registered.definitions.length >= 1, 'scanner never wedged the install');
});

test('P1: pure live/token chunk appends never scan windows; one durable event does', async () => {
  const mod = await loadOutgoingCards();
  const binding = makePublishableBinding([{ type: 'event', event: toolCallEvent() }]); // no result yet
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    return okLookup(SEND_ROWS)(url, init);
  };
  const { ctx } = installWithFetch(fetchImpl, binding);
  let scan = null;
  mod.installOutgoingCards(ctx, { fetchImpl, onReady: (handle) => { scan = handle.scan; } });
  await scan();
  for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0, 'initial pass has no result candidates → no HTTP');

  // Token chunk (assistant live streaming): must not re-read any window.
  binding.publish(
    { kind: 'append', entries: [{ type: 'transient', event: { type: 'assistant/live-chunk', seq: 99, time: 1, data: { attemptId: 'a', turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'tok' } } } }] },
    [{ type: 'event', event: toolCallEvent() }, { type: 'transient', event: { type: 'assistant/live-chunk', seq: 99, time: 1, data: { attemptId: 'a', turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'tok' } } } }],
  );
  for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0, 'live/token chunk → no window scan (no fetch)');

  // One durable tool/result → exactly one verification pass.
  binding.publish(
    { kind: 'append', entries: [{ type: 'event', event: toolResultEvent() }] },
    [{ type: 'event', event: toolCallEvent() }, { type: 'event', event: toolResultEvent() }],
  );
  for (let i = 0; i < 100 && calls === 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, 'durable event schedules exactly one pass');
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, 'no duplicate pass for the same revision');
});

// ---- P1: no business caps (32 sessions / 10000 entries) ----

function makeFakeSource(entries, revision = 1, change = { kind: 'replace', entries: [] }) {
  const listeners = new Set();
  const state = { entries, revision, change, hasMore: false };
  return {
    getSnapshot: () => ({ ...state }),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    publish(nextChange, nextEntries = state.entries) {
      state.entries = nextEntries;
      state.revision += 1;
      state.change = nextChange;
      for (const fn of [...listeners]) fn();
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

function makeFakeSessions(specs) {
  const sources = new Map(specs.map((spec) => [spec.id, spec.source]));
  return {
    service: {
      list: {
        getSnapshot: () => ({ byId: Object.fromEntries([...sources.keys()].map((id) => [id, { id }])) }),
        subscribe: () => () => {},
      },
      binding: (id) => {
        const source = sources.get(id);
        return source === undefined ? undefined : { sessionId: id, eventSource: source };
      },
    },
    setSource(id, source) {
      sources.set(id, source);
    },
    remove(id) {
      sources.delete(id);
    },
  };
}

const scopeCall = (callId) => toolCallEvent({ callId });
const scopeResult = (callId) => toolResultEvent({ callId });

test('no cap: the 33rd session participates — shared object is ambiguous, unique object resolves', () => {
  const shared = scopeCall('shared-call');
  const onlyFirst = scopeCall('first-call');
  const only33 = scopeCall('call33');
  const specs = [{ id: 'sess-01', source: makeFakeSource([{ event: shared }, { event: onlyFirst }]) }];
  for (let index = 2; index <= 32; index += 1) {
    specs.push({ id: `sess-${String(index).padStart(2, '0')}`, source: makeFakeSource([{ event: scopeCall(`c-${index}`) }]) });
  }
  // The 33rd binding ALSO holds the shared object (fork-style copy).
  specs.push({ id: 'sess-33', source: makeFakeSource([{ event: shared }, { event: only33 }]) });

  const scope = createWindowScope({ sessions: makeFakeSessions(specs).service });
  assert.equal(scope.resolveEvent(shared), null, 'object shared with session #33 → ambiguity detected (no false uniqueness)');
  assert.equal(scope.stats().sessions, 33, 'every bound session indexed — no 32-session ceiling');
  assert.equal(scope.resolveEvent(only33), 'sess-33', 'session #33 is first-class: its unique object resolves');
  assert.equal(scope.resolveEvent(onlyFirst), 'sess-01');
});

test('no cap: a 10001-entry window still verifies its newest message', () => {
  const fillers = Array.from({ length: 10_000 }, (_, index) => ({ event: { type: 'system/message', seq: index + 1, time: 0, data: {} } }));
  const call = scopeCall('big-call');
  const result = scopeResult('big-call');
  const sessions = makeFakeSessions([{ id: 'sess-big', source: makeFakeSource([...fillers, { event: call }, { event: result }]) }]);
  const scope = createWindowScope({ sessions: sessions.service });
  assert.equal(scope.resolveResult(result, 'big-call'), 'sess-big', 'entry #10001 is never truncated away');
  assert.equal(scope.resolveEvent(result), 'sess-big');
});

test('P1 perf: 1000 live/token chunks stay incremental — zero full rebuilds, zero scans', async () => {
  const call = scopeCall('c-live');
  const result = scopeResult('c-live');
  const source = makeFakeSource([{ event: call }, { event: result }]);
  const sessions = makeFakeSessions([{ id: 'sess-A', source }]);
  const scope = createWindowScope({ sessions: sessions.service });
  assert.equal(scope.resolveResult(result, 'c-live'), 'sess-A');
  const baseline = scope.stats();
  assert.equal(baseline.fullRebuilds, 1, 'one adopt for the first sight');

  const chunk = (seq) => ({
    type: 'transient',
    event: { type: 'assistant/live-chunk', seq, time: seq, data: { attemptId: 'a', turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'tok' } } },
  });
  for (let index = 0; index < 1000; index += 1) {
    source.publish({ kind: 'append', entries: [chunk(index)] }, [...source.getSnapshot().entries, chunk(index)]);
  }
  const afterChunks = scope.stats();
  assert.equal(afterChunks.fullRebuilds, baseline.fullRebuilds, 'no full window rebuild per token (delta only)');
  assert.ok(afterChunks.deltaSyncs >= 1000, 'each chunk applied as an O(delta) index update');

  // The resolution after the burst is a revision no-op — still no rebuild.
  assert.equal(scope.resolveResult(result, 'c-live'), 'sess-A');
  assert.equal(scope.stats().fullRebuilds, baseline.fullRebuilds, 'read after burst never re-scans the window');
});

test('generation replacement: same sessionId + reused revision, different call sets — old evidence never leaks', () => {
  const oldCall = scopeCall('c-old');
  const oldResult = scopeResult('c-old');
  const newCall = scopeCall('c-new');
  const newResult = scopeResult('c-new');
  // Both generations report the SAME revision number (5).
  const sourceA = makeFakeSource([{ event: oldCall }, { event: oldResult }], 5);
  const sourceB = makeFakeSource([{ event: newCall }, { event: newResult }], 5);
  const sessions = makeFakeSessions([{ id: 'sess-A', source: sourceA }]);
  const scope = createWindowScope({ sessions: sessions.service });

  assert.equal(scope.resolveResult(oldResult, 'c-old'), 'sess-A', 'generation A resolves');
  const listenersOnA = sourceA.listenerCount;
  assert.ok(listenersOnA >= 1, 'scope subscribed to generation A');

  // Same sessionId, NEW eventSource (restart/page reload), revision reused.
  sessions.setSource('sess-A', sourceB);

  // The OLD source publishing after the swap must be ignored entirely.
  sourceA.publish({ kind: 'append', entries: [{ event: oldResult }] }, [{ event: oldCall }, { event: oldResult }]);

  assert.equal(scope.resolveResult(oldResult, 'c-old'), null, 'old generation evidence dropped (no stale callId reuse)');
  assert.equal(scope.resolveResult(newResult, 'c-new'), 'sess-A', 'new generation resolves from its own window');
  assert.equal(scope.resolveEvent(newCall), 'sess-A');
  assert.ok(scope.stats().droppedGenerations >= 1, 'generation swap recorded');
  assert.equal(sourceA.listenerCount, 0, 'old source unsubscribed after the swap is observed');
});

// ---- P1: transactional install (no orphan listeners on setup failure) ----

function makeTransactionalCtx({ failSlotKey = null, duplicateKind = false } = {}) {
  const activeKinds = new Set();
  const listListeners = new Set();
  const bindingListeners = new Set();
  const registeredSlots = [];
  const events = [];
  const source = makeFakeSource([{ event: toolCallEvent() }, { event: toolResultEvent() }]);
  // Route source subscriptions through the observable set we assert on.
  const observedSource = {
    getSnapshot: () => source.getSnapshot(),
    subscribe(fn) {
      bindingListeners.add(fn);
      return () => bindingListeners.delete(fn);
    },
  };
  const ctx = {
    sessions: {
      list: {
        getSnapshot: () => ({ byId: { 'sess-A': { id: 'sess-A' } } }),
        subscribe(fn) {
          listListeners.add(fn);
          return () => listListeners.delete(fn);
        },
      },
      binding: (id) => (id === 'sess-A' ? { sessionId: 'sess-A', eventSource: observedSource } : undefined),
    },
    uiConversation: {
      events: {
        register(definition) {
          if (duplicateKind || activeKinds.has(definition.kind)) {
            throw new Error(`conversation Definition "${definition.kind}" is already registered`);
          }
          activeKinds.add(definition.kind);
          return () => activeKinds.delete(definition.kind);
        },
      },
    },
    slots: {
      inject(name, factory) {
        return factory();
      },
      register(descriptor, component) {
        if (failSlotKey !== null && descriptor.key === failSlotKey) throw new Error('slot install boom');
        registeredSlots.push(descriptor);
        return () => {
          const index = registeredSlots.indexOf(descriptor);
          if (index >= 0) registeredSlots.splice(index, 1);
        };
      },
    },
    effect(fn) {
      return fn();
    },
  };
  return { ctx, activeKinds, listListeners, bindingListeners, registeredSlots, source, events };
}

test('P1 transaction: a slot failure mid-install rolls back definition/subscriptions/slots and rethrows', async () => {
  const mod = await loadOutgoingCards();
  const fixture = makeTransactionalCtx({ failSlotKey: 'session_link_reply' });
  let fetchCalls = 0;
  const fetchImpl = async (url, init) => {
    fetchCalls += 1;
    return okLookup(SEND_ROWS)(url, init);
  };

  assert.throws(
    () => mod.installOutgoingCards(fixture.ctx, { fetchImpl }),
    /slot install boom/,
    'setup failure surfaces for the caller’s explicit degradation log',
  );

  assert.equal(fixture.activeKinds.size, 0, 'our definition registration rolled back');
  assert.equal(fixture.registeredSlots.length, 0, 'partially installed slots rolled back');
  assert.equal(fixture.listListeners.size, 0, 'no orphan catalog listener');
  assert.equal(fixture.bindingListeners.size, 0, 'no orphan eventSource listener (addon + window scope)');

  // Even with live windows publishing afterwards, NOTHING keeps requesting.
  fixture.source.publish({ kind: 'append', entries: [{ type: 'event', event: toolResultEvent() }] });
  for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls, 0, 'rolled-back install never issues another lookup');
});

test('P1 transaction: duplicate kind fails before side effects and still leaves zero listeners', async () => {
  const mod = await loadOutgoingCards();
  const fixture = makeTransactionalCtx({ duplicateKind: true });
  assert.throws(
    () => mod.installOutgoingCards(fixture.ctx, { fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) }),
    /already registered/,
  );
  assert.equal(fixture.activeKinds.size, 0, 'no definition leak');
  assert.equal(fixture.listListeners.size, 0);
  assert.equal(fixture.bindingListeners.size, 0);
  assert.equal(fixture.registeredSlots.length, 0);
});

// ---- P2 batch: append gate, inspect entry, multi-target detail, asOf, excerpt ----

test('append gate: model-only replacement results are never claimed nor queried', async () => {
  const verifier = mockVerifier({ 'sess-A': SEND_ROWS });
  await verifier.verify('sess-A', ['msg-b', 'msg-c']);
  const definition = createSenderCardDefinition({ windowScope: fakeWindowScope(), verifier });
  const replacement = { ...toolResultEvent(), surfaceOp: 'replace' };
  assert.equal(definition.match(replacement), null, 'non-append result never feeds the card');

  // Coordinator collectCandidates skips non-append results too.
  const mod = await loadOutgoingCards();
  const source = makeFakeSource([
    { event: toolCallEvent() },
    { event: replacement },
  ]);
  const sessions = makeFakeSessions([{ id: 'sess-A', source }]);
  const coordinator = createOutgoingCoordinator({
    sessions: sessions.service,
    verifier,
    getSignal: () => undefined,
  });
  let lookups = 0;
  const countingVerifier = {
    ...verifier,
    verify: async () => {
      lookups += 1;
      return false;
    },
    refresh: async () => false,
    revoke: () => false,
  };
  const counting = createOutgoingCoordinator({ sessions: sessions.service, verifier: countingVerifier, getSignal: () => undefined });
  counting.reconcile();
  await counting.scan();
  await counting.scan();
  assert.equal(lookups, 0, 'a replace-only window is never queried');
  void mod;
  void coordinator;
});

test('toolview: native inspect entry is forwarded as 查看轨迹 when provided, hidden otherwise', async () => {
  const mod = await loadOutgoingCards();
  const View = mod.createSessionLinkToolview();
  const findByAttr = (element, attr) => {
    if (element === null || element === undefined || typeof element !== 'object') return null;
    if (Array.isArray(element)) {
      for (const child of element) {
        const hit = findByAttr(child, attr);
        if (hit !== null) return hit;
      }
      return null;
    }
    if (element.props?.[attr] !== undefined) return element;
    return findByAttr(element.props?.children, attr);
  };

  let inspected = 0;
  const withInspect = View({ phase: 'result', callId: 'c', block: { call: null, content: [], isError: false }, inspect: () => { inspected += 1; } });
  const button = findByAttr(withInspect, 'data-session-link-toolview-inspect');
  assert.ok(button !== null, 'inspect entry shown when the host provides it');
  button.props.onClick();
  assert.equal(inspected, 1, 'the real inspect callback is invoked (no fake, no args execution)');

  const withoutInspect = View({ phase: 'result', callId: 'c', block: { call: null, content: [], isError: false } });
  assert.equal(findByAttr(withoutInspect, 'data-session-link-toolview-inspect'), null, 'no button when inspect is unavailable');
});

test('card tech details keep the per-target ledger statuses visible (多目标状态 detail)', async () => {
  const mod = await loadOutgoingCards();
  const { definition, context } = await cardContext();
  const node = definition.buildViewNode(context);
  assert.equal(node.data.status, '多目标状态');

  const tree = mod.SenderCardLayout({ data: node.data, open: true });
  const textOf = (element) => {
    if (element === null || element === undefined || typeof element === 'boolean') return '';
    if (typeof element === 'string' || typeof element === 'number') return String(element);
    if (Array.isArray(element)) return element.map(textOf).join('');
    if (typeof element === 'object' && 'props' in element) return textOf(element.props.children);
    return '';
  };
  const findByAttr = (element, attr) => {
    if (element === null || element === undefined || typeof element !== 'object') return null;
    if (Array.isArray(element)) {
      for (const child of element) {
        const hit = findByAttr(child, attr);
        if (hit !== null) return hit;
      }
      return null;
    }
    if (element.props?.[attr] !== undefined) return element;
    return findByAttr(element.props?.children, attr);
  };
  const tech = textOf(findByAttr(tree, 'data-session-link-card-tech'));
  assert.ok(tech.includes('目标状态:'), 'per-target breakdown present in closed tech details');
  assert.ok(tech.includes('sess-B=已进入上下文'));
  assert.ok(tech.includes('sess-C=需核对'));
  assert.ok(tech.includes('多目标状态'), 'the summary reason is stated');
});

test('status asOf is LOCAL time when the lookup RESPONSE completed', async () => {
  const startedAt = Date.now();
  const verifier = createCardVerifier({
    refreshIntervalMs: 0,
    fetchImpl: async (_url, init) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return okLookup([{
        id: 'msg-b', durableMessageId: 'd', from: 'sess-A', to: 'sess-B', kind: 'notification', subject: null,
        chainId: 'c', parentMessageId: null, status: 'pending', replyStatus: 'none',
        receipt: { policy: 'context', state: 'queued', receivedAt: null, receivedSeq: null },
      }])(_url, init);
    },
  });
  await verifier.verify('sess-A', ['msg-b']);
  const asOf = verifier.freshnessOf('sess-A', 'msg-b').asOf;
  assert.ok(asOf >= startedAt + 20, `asOf must be stamped at response completion (${asOf} vs start ${startedAt})`);
});

test('excerpt: first NON-empty line wins; truncation is code-point safe (no split emoji)', () => {
  assert.equal(excerpt('\n\n第二行有正文\n第三行'), '第二行有正文', 'blank first line must not degrade the subject');
  assert.equal(excerpt('   \n\t \nonly-body'), 'only-body');
  assert.equal(excerpt('   \n\t '), null, 'all-blank input stays null');
  const emoji = '😀🎉👍'.repeat(10);
  const cut = excerpt(emoji, 5);
  assert.equal(Array.from(cut).length, 6, '5 code points + ellipsis — never a half surrogate');
  assert.ok(cut.endsWith('…'));
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut), false, 'no lone high surrogate');
  assert.equal(excerpt('显式主题\nignored'), '显式主题');
});

// ---- multi-target 截至 aggregation (earliest known; never claim precise when unknown) ----

function cardState({ ids = ['msg-b', 'msg-c'] } = {}) {
  return {
    call: { callId: 'call-1', name: 'session_link_send', argsRaw: SEND_ARGS, seq: 7 },
    result: { seq: 8, isError: false, ids, owner: 'sess-A', value: SEND_VALUE, resultSessionId: null, text: null },
  };
}
function buildNode(definition) {
  return definition.buildViewNode({
    state: cardState(),
    current: { get: () => undefined },
    start: { event: toolCallEvent(), location: { kind: 'step', turn: { turn: 1 }, step: { step: 0 } } },
    matches: [],
  });
}
function asyncVerifier({ fail = () => false } = {}) {
  return createCardVerifier({
    refreshIntervalMs: 60_000,
    fetchImpl: async (_url, init) => {
      const { sessionId, ids } = JSON.parse(init.body).payload;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (fail(ids)) return { ok: false, status: 500, json: async () => ({}) };
      const results = SEND_ROWS.filter((row) => row.from === sessionId && ids.includes(row.id));
      const missing = ids.filter((id) => !results.some((row) => row.id === id));
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { results, missing } }) };
    },
  });
}

test('multi-target 截至 = EARLIEST known asOf (two async batches never freshen an older target)', async () => {
  const verifier = asyncVerifier();
  const definition = createSenderCardDefinition({ windowScope: fakeWindowScope(), verifier });

  await verifier.verify('sess-A', ['msg-b']);
  const early = verifier.freshnessOf('sess-A', 'msg-b').asOf;
  await new Promise((resolve) => setTimeout(resolve, 20));
  await verifier.verify('sess-A', ['msg-c']);
  const late = verifier.freshnessOf('sess-A', 'msg-c').asOf;
  assert.ok(late > early, 'second batch really completed later');

  const data = buildNode(definition).data;
  assert.equal(data.statusAsOf, early, 'card 截至 must be the EARLIEST target lookup, not the newest');
  assert.equal(data.statusStale, false, 'both targets have valid lookups');
  assert.equal(data.targetStatus[0].asOf, early);
  assert.equal(data.targetStatus[1].asOf, late, 'per-target asOf kept separately');

  // Present in the closed technical details per target.
  const mod = await loadOutgoingCards();
  const tree = mod.SenderCardLayout({ data, open: true });
  const textOf = (element) => {
    if (element === null || element === undefined || typeof element === 'boolean') return '';
    if (typeof element === 'string' || typeof element === 'number') return String(element);
    if (Array.isArray(element)) return element.map(textOf).join('');
    if (typeof element === 'object' && 'props' in element) return textOf(element.props.children);
    return '';
  };
  const findByAttr = (element, attr) => {
    if (element === null || element === undefined || typeof element !== 'object') return null;
    if (Array.isArray(element)) {
      for (const child of element) {
        const hit = findByAttr(child, attr);
        if (hit !== null) return hit;
      }
      return null;
    }
    if (element.props?.[attr] !== undefined) return element;
    return findByAttr(element.props?.children, attr);
  };
  const tech = textOf(findByAttr(tree, 'data-session-link-card-tech'));
  assert.ok(tech.includes('sess-B=已进入上下文（截至'), 'per-target asOf shown in tech details');
  assert.ok(tech.includes('sess-C='), 'second target row present');
});

test('partial stale target: card flags 状态未更新 and keeps no precise 截至 claim', async () => {
  let failing = false;
  const verifier = asyncVerifier({ fail: () => failing });
  const definition = createSenderCardDefinition({ windowScope: fakeWindowScope(), verifier });
  await verifier.verify('sess-A', ['msg-b']);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await verifier.verify('sess-A', ['msg-c']);
  const early = verifier.freshnessOf('sess-A', 'msg-b').asOf;

  failing = true;
  await verifier.refresh('sess-A', ['msg-c'], { force: true });
  assert.equal(verifier.freshnessOf('sess-A', 'msg-c').stale, true);

  const data = buildNode(definition).data;
  assert.equal(data.statusStale, true, 'any stale target flags the card');
  assert.equal(data.statusAsOf, early, 'aggregate keeps the earliest KNOWN lookup for honesty');
  assert.equal(data.targetStatus[1].stale, true, 'stale target marked individually');

  const mod = await loadOutgoingCards();
  const tree = mod.SenderCardLayout({ data, open: false });
  const textOf = (element) => {
    if (element === null || element === undefined || typeof element === 'boolean') return '';
    if (typeof element === 'string' || typeof element === 'number') return String(element);
    if (Array.isArray(element)) return element.map(textOf).join('');
    if (typeof element === 'object' && 'props' in element) return textOf(element.props.children);
    return '';
  };
  const findByAttr = (element, attr) => {
    if (element === null || element === undefined || typeof element !== 'object') return null;
    if (Array.isArray(element)) {
      for (const child of element) {
        const hit = findByAttr(child, attr);
        if (hit !== null) return hit;
      }
      return null;
    }
    if (element.props?.[attr] !== undefined) return element;
    return findByAttr(element.props?.children, attr);
  };
  const statusText = textOf(findByAttr(tree, 'data-session-link-card-status'));
  assert.ok(statusText.includes('状态未更新'), 'card line 2 shows 状态未更新');
  assert.ok(!statusText.includes('截至'), 'stale card never shows a precise 截至');
});

test('unknown per-target asOf: aggregate claims NO precise time and flags 需核对/未更新', () => {
  const rows = SEND_ROWS.map((row) => ({ ...row }));
  const stub = {
    has: () => true,
    get: () => rows,
    freshnessOf: (sessionId, id) => (id === 'msg-b' ? { asOf: 1700000000000, stale: false } : undefined),
  };
  const definition = createSenderCardDefinition({ windowScope: fakeWindowScope(), verifier: stub });
  const data = buildNode(definition).data;
  assert.equal(data.statusAsOf, null, 'no precise card-level 截至 when any target asOf is unknown');
  assert.equal(data.statusStale, true, 'unknown target asOf → 状态未更新/需核对 flag');
  assert.equal(data.targetStatus[0].asOf, 1700000000000, 'known target keeps its own asOf');
  assert.equal(data.targetStatus[1].asOf, null, 'unknown target has no fabricated asOf');

  assert.equal(statusDisplay(rows[1], null, true).label, '需核对', 'truth table still says 需核对 for unknown rows');
});

// ---- first-line kind tag from the VERIFIED ledger row.kind ----

test('kind stays data-only: request is not a visible chip; status keeps 明确回复 separately', async () => {
  const requestRow = {
    id: 'msg-b', durableMessageId: 'd-b', from: 'sess-A', to: 'sess-B', kind: 'request', subject: null,
    chainId: 'chain-1', parentMessageId: null, status: 'accepted', replyStatus: 'answered',
    receipt: { policy: 'context', state: 'received', receivedAt: 1700000000000, receivedSeq: 7 },
  };
  const singleValue = { operationId: 'op-1', idempotent: false, chainId: 'chain-1', held: false, results: [{ target: 'sess-B', id: 'msg-b', status: 'accepted', error: null }] };
  const singleArgs = JSON.stringify({ targets: ['sess-B'], kind: 'request', text: '请协助跟进', operationId: 'op-1' });

  const { definition, context } = await cardContext({
    rows: [requestRow],
    args: singleArgs,
    value: singleValue,
  });
  const data = definition.buildViewNode(context).data;
  assert.equal(data.kind, 'request');
  assert.equal(data.kindTag, '请求', 'underlying kind data may stay for technical details');
  assert.equal(data.status, '明确回复', 'a request that got an explicit reply still shows its status');

  const mod = await loadOutgoingCards();
  const Layout = mod.SenderCardLayout;
  const textOf = (element) => {
    if (element === null || element === undefined || typeof element === 'boolean') return '';
    if (typeof element === 'string' || typeof element === 'number') return String(element);
    if (Array.isArray(element)) return element.map(textOf).join('');
    if (typeof element === 'object' && 'props' in element) return textOf(element.props.children);
    return '';
  };
  const findByAttr = (element, attr) => {
    if (element === null || element === undefined || typeof element !== 'object') return null;
    if (Array.isArray(element)) {
      for (const child of element) {
        const hit = findByAttr(child, attr);
        if (hit !== null) return hit;
      }
      return null;
    }
    if (element.props?.[attr] !== undefined) return element;
    return findByAttr(element.props?.children, attr);
  };
  const tree = Layout({ data, open: false });
  assert.equal(findByAttr(tree, 'data-session-link-card-kind'), null, 'no visible 请求/回复 kind chip');
  assert.equal(findByAttr(tree, 'data-session-link-card-chip'), null, 'no direction chip on the face');
  const line2 = textOf(findByAttr(tree, 'data-session-link-card-subject'));
  assert.ok(line2.includes('明确回复'), 'status stays on line 2 — never mistaken for the card kind');
  assert.ok(!textOf(tree).includes('请求'), 'kind data is not rendered on the card face');
  assert.ok(!textOf(tree).includes('msg-b'), 'no long ids on the card face');
  assert.ok(textOf(findByAttr(Layout({ data, open: true }), 'data-session-link-card-tech')).includes('kind: request'), 'real kind kept in technical details');
});

function cardNodeWithRows(rows) {
  const stub = {
    has: () => true,
    get: () => rows,
    freshnessOf: () => ({ asOf: 1700000000000, stale: false }),
  };
  const definition = createSenderCardDefinition({ windowScope: fakeWindowScope(), verifier: stub });
  return definition.buildViewNode({
    state: {
      call: { callId: 'call-1', name: 'session_link_send', argsRaw: SEND_ARGS, seq: 7 },
      result: { seq: 8, isError: false, ids: rows.map((row) => row.id), owner: 'sess-A', value: SEND_VALUE, resultSessionId: null, text: null },
    },
    current: { get: () => undefined },
    start: { event: toolCallEvent(), location: { kind: 'step', turn: { turn: 1 }, step: { step: 0 } } },
    matches: [],
  });
}

test('kind gate: multi-target rows must agree on one non-empty kind, else the native record stands', () => {
  assert.equal(
    cardNodeWithRows([{ ...SEND_ROWS[0], kind: 'request' }, { ...SEND_ROWS[1], kind: 'reply' }]),
    null,
    'inconsistent kinds never render a card',
  );
  assert.equal(cardNodeWithRows([{ ...SEND_ROWS[0], kind: undefined }]), null, 'missing ledger kind → unverifiable → native fallback');
  assert.equal(cardNodeWithRows([{ ...SEND_ROWS[0], kind: '' }]), null, 'empty kind → native fallback');
  const consistent = cardNodeWithRows(SEND_ROWS.map((row) => ({ ...row, kind: 'request' })));
  assert.ok(consistent !== null, 'consistent multi-target kind still renders');
  assert.deepEqual(consistent.data.to, ['sess-B', 'sess-C']);
  assert.equal(consistent.data.kindTag, '请求');
});

test('notification with a parent link is NOT labelled 回复 (chain continuation ≠ explicit reply)', async () => {
  const parent = 'msg-parent-1234';
  const args = JSON.stringify({ targets: ['sess-B'], kind: 'notification', text: '继续链上的通知', operationId: 'op-2', parentMessageId: parent });
  const value = { operationId: 'op-2', idempotent: false, chainId: 'chain-1', held: false, results: [{ target: 'sess-B', id: 'msg-b', status: 'accepted', error: null }] };
  const row = {
    id: 'msg-b', durableMessageId: 'd-b', from: 'sess-A', to: 'sess-B', kind: 'notification', subject: null,
    chainId: 'chain-1', parentMessageId: parent, status: 'accepted', replyStatus: 'none',
    receipt: { policy: 'context', state: 'received', receivedAt: 1700000000000, receivedSeq: 7 },
  };
  const { definition, context } = await cardContext({ rows: [row], args, value });
  const data = definition.buildViewNode(context).data;
  assert.equal(data.kind, 'notification');
  assert.equal(data.kindTag, null, 'notification with a parent is still never tagged 回复');
  assert.equal(data.replyTo, parent, 'real parent linkage kept');

  const mod = await loadOutgoingCards();
  const Layout = mod.SenderCardLayout;
  const textOf = (element) => {
    if (element === null || element === undefined || typeof element === 'boolean') return '';
    if (typeof element === 'string' || typeof element === 'number') return String(element);
    if (Array.isArray(element)) return element.map(textOf).join('');
    if (typeof element === 'object' && 'props' in element) return textOf(element.props.children);
    return '';
  };
  const findByAttr = (element, attr) => {
    if (element === null || element === undefined || typeof element !== 'object') return null;
    if (Array.isArray(element)) {
      for (const child of element) {
        const hit = findByAttr(child, attr);
        if (hit !== null) return hit;
      }
      return null;
    }
    if (element.props?.[attr] !== undefined) return element;
    return findByAttr(element.props?.children, attr);
  };
  const tree = Layout({ data, open: true });
  assert.equal(findByAttr(tree, 'data-session-link-card-kind'), null, 'no 回复/请求 tag on line 1');
  assert.equal(findByAttr(tree, 'data-session-link-card-chip'), null, 'no direction chip on the face');
  const tech = textOf(findByAttr(tree, 'data-session-link-card-tech'));
  assert.ok(tech.includes(`关联消息ID: ${parent}`), 'chain-continuation parent is 关联消息ID');
  assert.ok(!tech.includes('关联请求ID'), 'never 关联请求ID without a verified reply row');
});

test('verified reply row names its parent 关联请求ID; other kinds keep 关联消息ID', async () => {
  const parent = 'msg-parent-42';
  const replyArgs = JSON.stringify({ messageId: parent, text: '回复内容', operationId: 'op-3' });
  const replyValue = { operationId: 'op-3', idempotent: false, chainId: 'chain-1', held: false, results: [{ target: 'sess-B', id: 'msg-r', status: 'accepted', error: null }] };
  const replyRow = {
    id: 'msg-r', durableMessageId: 'd-r', from: 'sess-A', to: 'sess-B', kind: 'reply', subject: null,
    chainId: 'chain-1', parentMessageId: parent, status: 'accepted', replyStatus: 'none',
    receipt: { policy: 'context', state: 'received', receivedAt: 1700000000000, receivedSeq: 7 },
  };
  const { definition, context } = await cardContext({ rows: [replyRow], args: replyArgs, value: replyValue, name: 'session_link_reply' });
  const data = definition.buildViewNode(context).data;
  assert.equal(data.kindTag, '回复', 'underlying kind data stays available');
  assert.equal(data.kind, 'reply');

  const mod = await loadOutgoingCards();
  const tree = mod.SenderCardLayout({ data, open: true });
  const textOf = (element) => {
    if (element === null || element === undefined || typeof element === 'boolean') return '';
    if (typeof element === 'string' || typeof element === 'number') return String(element);
    if (Array.isArray(element)) return element.map(textOf).join('');
    if (typeof element === 'object' && 'props' in element) return textOf(element.props.children);
    return '';
  };
  const findByAttr = (element, attr) => {
    if (element === null || element === undefined || typeof element !== 'object') return null;
    if (Array.isArray(element)) {
      for (const child of element) {
        const hit = findByAttr(child, attr);
        if (hit !== null) return hit;
      }
      return null;
    }
    if (element.props?.[attr] !== undefined) return element;
    return findByAttr(element.props?.children, attr);
  };
  const tech = textOf(findByAttr(tree, 'data-session-link-card-tech'));
  assert.equal(findByAttr(tree, 'data-session-link-card-kind'), null, 'no visible 回复 chip');
  assert.equal(findByAttr(tree, 'data-session-link-card-chip'), null, 'no direction chip on the face');
  assert.ok(tech.includes(`关联请求ID: ${parent}`), 'verified reply row names its parent 关联请求ID');
  assert.ok(!tech.includes('关联消息ID'), 'reply does not fall back to the generic label');
  assert.ok(tech.includes('kind: reply'), 'kind preserved in technical details');
});

function cardNodesOf(nodes) {
  return nodes.filter((node) => node.kind === CARD_KIND);
}
