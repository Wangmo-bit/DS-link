// Product-side unit tests for the receiver card module
// (src/client/incoming-cards.jsx) migrated from the verified v04 receiver
// prototype. Pure Node: esbuild in-memory bundle + fake client ctx; the
// exclusive-conflict cases additionally load the REAL shipped
// @deepseek-ai/dsh-client-ui-conversation registry/assembler. No Host, no
// browser, no network (fetch is stubbed per test).
// Run: node --test scripts/ui-incoming.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import {
  CARD_CSS,
  CARD_DIRECTION,
  CARD_PARTY,
  cardClass,
  directionAttribute,
  directionLabel,
  toggleText,
} from '../src/client/card-shell.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoReq = createRequire(path.join(here, '../package.json'));

/** Bundle the JSX module in memory (same externals as the repo build). */
async function loadIncoming() {
  const result = await build({
    absWorkingDir: path.join(here, '..'),
    entryPoints: ['src/client/incoming-cards.jsx'],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    external: ['react', 'react-dom'],
    logLevel: 'silent',
  });
  const module = { exports: {} };
  const req = (name) => {
    if (name === 'react' || name === 'react-dom' || name === 'react/jsx-runtime') return repoReq(name);
    throw new Error(`unexpected require: ${name}`);
  };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(req, module, module.exports);
  return module.exports;
}

const incoming = await loadIncoming();

/* ── installed-SDK loader (exclusive-conflict evidence) ─────────────────── */

const CONV_CANDIDATES = [
  process.env.DSH_CLIENT_CONVERSATION,
].filter((p) => typeof p === 'string' && p.length > 0);
const CONV = CONV_CANDIDATES.find((p) => existsSync(p));
const skipConv = CONV === undefined ? 'installed dsh-client-ui-conversation bundle not found' : false;

/** Lazy recursive proxy: satisfies any shape a missing client package wants. */
function stubModule() {
  const fn = function () {
    return stubModule();
  };
  return new Proxy(fn, {
    get: (_t, prop) => (prop === 'then' || prop === Symbol.toPrimitive ? undefined : stubModule()),
    apply: () => stubModule(),
    construct: () => stubModule(),
  });
}

function loadConversation() {
  let spec = null;
  globalThis.window = { __ModuleLoader__: { load: (s) => { spec = s; } } };
  new Function(readFileSync(CONV, 'utf8'))();
  assert.ok(spec, 'conversation bundle must register');
  const dshReq = createRequire(CONV);
  return spec.factory((name) => {
    try {
      if (name === 'react' || name === 'react/jsx-runtime' || name === 'react-dom') return repoReq(name);
      if (name === '@deepseek-ai/cordis' || name === 'zod') return dshReq(name);
    } catch {
      // fall through to the structural stub
    }
    return stubModule();
  });
}

/* ── fixtures ───────────────────────────────────────────────────────────── */

function relayEvent(overrides = {}) {
  return {
    type: 'user/message',
    surfaceOp: 'append',
    seq: 7,
    time: 1700000000000,
    data: {
      id: 'durable-1',
      source: { kind: 'agent-message', form: 'relay', senderSessionId: 'sess-A' },
      content: [
        {
          type: 'text',
          text: '[session-link notification from sess-A]\nmessage: durable-1\nchain: chain-1 · hop: 1\nnotification only; no reply is required\n\n跟进需求确认\nsecond line\n\nThis is Agent collaboration, not authorization from the user.',
        },
      ],
      ...overrides.data,
    },
    ...overrides.top,
  };
}

const RELAY_EVENT = relayEvent();

const LEDGER_ROW = {
  id: 'ledger-1',
  durableMessageId: 'durable-1',
  from: 'sess-A',
  to: 'sess-B',
  fromTitle: '主会话 A',
  toTitle: '协作会话 B',
  kind: 'notification',
  subject: null,
  chainId: 'chain-1',
  parentMessageId: null,
  status: 'accepted',
  replyStatus: null,
  receipt: { policy: 'context', state: 'queued', receivedAt: null, receivedSeq: null },
};

/**
 * Fake client ctx with mutable per-session event feeds (public window API
 * shape: entries + change descriptors), a fake event registry (register +
 * forEvent), slot seams, an effect that actually invokes, and a fetch stub.
 */
function makeCtx({ sessions, lookup, control = {}, peers = [] }) {
  const registered = {};
  const fetchCalls = [];
  const bindings = new Map();
  const listSubscribers = new Set();
  const cleanups = [];
  const peerDefs = [...peers];
  for (const spec of sessions) {
    bindings.set(spec.id, { sessionId: spec.id, eventSource: makeEventSource(spec.entries) });
  }
  function makeEventSource(initialEvents, revisionStart = 0) {
    const list = initialEvents;
    let revision = revisionStart;
    const snapshotEntries = () => list.map((event) => ({ type: 'event', event }));
    let change = { kind: 'replace', entries: snapshotEntries() };
    const listeners = new Set();
    const notify = () => {
      for (const fn of [...listeners]) fn();
    };
    return {
      getSnapshot: () => ({ entries: snapshotEntries(), hasMore: false, revision, change }),
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      listenerCount: () => listeners.size,
      appendEvent(event) {
        list.push(event);
        revision += 1;
        change = { kind: 'append', entries: [{ type: 'event', event }] };
        notify();
      },
      appendTransient(event) {
        revision += 1;
        change = { kind: 'append', entries: [{ type: 'transient', event }] };
        notify();
      },
      replaceWindow(events) {
        list.length = 0;
        list.push(...events);
        revision += 1;
        change = { kind: 'replace', entries: snapshotEntries() };
        notify();
      },
    };
  }
  const ctx = {
    sessions: {
      list: {
        getSnapshot: () => ({ byId: Object.fromEntries([...bindings.keys()].map((id) => [id, { id }])) }),
        subscribe: (fn) => {
          listSubscribers.add(fn);
          return () => listSubscribers.delete(fn);
        },
      },
      binding: (id) => bindings.get(id),
    },
    uiConversation: {
      events: {
        register: (def) => {
          registered.def = def;
          registered.registrations = (registered.registrations ?? 0) + 1;
          return () => {
            registered.disposals = (registered.disposals ?? 0) + 1;
          };
        },
        forEvent: (type) => {
          const routes = new Set();
          if (registered.def) routes.add({ definition: registered.def, match: () => null });
          for (const peer of peerDefs) {
            const handler = peer.match?.[type];
            if (typeof handler !== 'function') continue;
            routes.add({ definition: peer, match: (event) => handler(event) });
          }
          return routes;
        },
      },
    },
    slots: {
      inject: (name, fn) => {
        if (control.slotFail === true) {
          control.slotFail = false; // one-shot failure, retry must work
          throw new Error('slot inject failed');
        }
        registered.slotInject = name;
        fn();
        return () => {
          registered.slotDisposals = (registered.slotDisposals ?? 0) + 1;
        };
      },
      register: (opts, comp) => {
        registered.slot = { opts, comp };
        return () => {};
      },
    },
    effect: (fn, _name) => {
      const cleanup = fn();
      cleanups.push(cleanup);
      if (control.effectFail === true) {
        control.effectFail = false; // one-shot failure, retry must work
        throw new Error('effect failed');
      }
      return cleanup;
    },
  };
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    fetchCalls.push({ url: String(url), body, signal: init.signal });
    if (control.hang === true) {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener?.('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    if (control.fail === true) {
      return { ok: false, status: 500, json: async () => ({ ok: false, error: { code: 'internal', message: 'HTTP 500' } }) };
    }
    const value = lookup(body.payload.sessionId, body.payload.ids, body.payload);
    return { ok: true, json: async () => ({ ok: true, value }) };
  };
  function addSession(id, entries) {
    bindings.set(id, { sessionId: id, eventSource: makeEventSource(entries) });
    poke();
  }
  function removeSession(id) {
    bindings.delete(id);
    poke();
  }
  function replaceSource(id, entries, revisionStart = 0) {
    const binding = bindings.get(id);
    const previous = binding.eventSource;
    binding.eventSource = makeEventSource(entries, revisionStart);
    poke();
    return previous;
  }
  function poke() {
    for (const fn of listSubscribers) fn();
  }
  return { ctx, registered, fetchCalls, bindings, cleanups, addSession, removeSession, replaceSource, poke };
}

/** Install the product module with the test seams; returns the onReady handle. */
function install(ctx, options = {}) {
  const fetchStub = globalThis.fetch;
  let handle;
  incoming.installIncomingCards(ctx, {
    fetchImpl: (...args) => fetchStub(...args),
    ...options,
    onReady: (h) => {
      handle = h;
    },
  });
  assert.ok(handle, 'onReady must deliver the work handle');
  return handle;
}

async function waitFor(predicate, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function buildCard(registered, event) {
  const claim = registered.def.match['user/message'](event);
  assert.ok(claim, 'expected a claim for this event');
  const state = registered.def.start({}, { ...claim, event, location: { kind: 'turn', turn: { turn: 3 } } });
  return registered.def.buildViewNode({
    key: 'k1',
    id: claim.id,
    state,
    start: { location: { kind: 'turn', turn: { turn: 3 } } },
  });
}

/** Plain text of a React element tree (works for the pure layout output). */
function textOf(element) {
  if (element === null || element === undefined || typeof element === 'boolean') return '';
  if (typeof element === 'string' || typeof element === 'number') return String(element);
  if (Array.isArray(element)) return element.map(textOf).join('');
  if (typeof element === 'object' && 'props' in element) return textOf(element.props.children);
  return '';
}

/** First element carrying a data attribute (any value, including ""). */
function findByAttr(element, attr) {
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
}

/** Every element of one type (validity checks inside the header button). */
function findAllByType(element, type, out = []) {
  if (element === null || element === undefined || typeof element !== 'object') return out;
  if (Array.isArray(element)) {
    for (const child of element) findAllByType(child, type, out);
    return out;
  }
  if (element.type === type) out.push(element);
  findAllByType(element.props?.children, type, out);
  return out;
}

/* ── shared visual shell ───────────────────────────────────────────────── */

test('shared shell: one frame per direction, party rows + toggle text, theme tokens, no inline styles', () => {
  assert.deepEqual(CARD_DIRECTION, { sent: '发送', received: '接收' });
  assert.equal(directionLabel('sent'), '发送');
  assert.equal(directionLabel('received'), '接收');
  assert.equal(cardClass('sent'), 'sl-card sl-card--sent');
  assert.equal(cardClass('received'), 'sl-card sl-card--received');
  assert.deepEqual(CARD_PARTY, { sender: '发件人', recipient: '收件人', subject: '主题' });
  assert.doesNotMatch(CARD_CSS, /\.sl-card__chip/, 'no direction chip in the shell');
  assert.equal(toggleText(false), '展开 ⌄');
  assert.equal(toggleText(true), '收起 ⌃');
  assert.deepEqual(directionAttribute('sent'), { 'data-session-link-direction': 'sent' });
  assert.deepEqual(directionAttribute('received'), { 'data-session-link-direction': 'received' });

  // Light surfaces (default) and the host's existing dark-theme marker.
  assert.match(CARD_CSS, /\.sl-card--sent\s*\{[^}]*background:\s*#EDF1F7/);
  assert.match(CARD_CSS, /\.sl-card--sent\s*\{[^}]*border-color:\s*#B9C8DE/);
  assert.match(CARD_CSS, /\.sl-card--sent\s*\{[^}]*color:\s*#212A38/);
  assert.match(CARD_CSS, /\.sl-card--received\s*\{[^}]*background:\s*#ECF3F0/);
  assert.match(CARD_CSS, /\.sl-card--received\s*\{[^}]*border-color:\s*#BFD6CC/);
  assert.match(CARD_CSS, /\.sl-card--received\s*\{[^}]*color:\s*#223029/);
  assert.match(CARD_CSS, /body\[data-ds-dark-theme\] \.sl-card--sent\s*\{[^}]*background:\s*#1C2636/);
  assert.match(CARD_CSS, /body\[data-ds-dark-theme\] \.sl-card--sent\s*\{[^}]*border-color:\s*#3C5477/);
  assert.match(CARD_CSS, /body\[data-ds-dark-theme\] \.sl-card--received\s*\{[^}]*background:\s*#1A2C29/);
  assert.match(CARD_CSS, /body\[data-ds-dark-theme\] \.sl-card--received\s*\{[^}]*border-color:\s*#3E655B/);
  assert.match(CARD_CSS, /body\[data-ds-dark-theme\] \.sl-card--sent\s*\{[^}]*color:\s*#E6E8ED/);

  // Frame ownership: only the outer card carries border/background.
  assert.match(CARD_CSS, /\.sl-card\s*\{[^}]*border:\s*1px solid #B9C8DE/);
  assert.match(CARD_CSS, /\.sl-card__toggle\s*\{[^}]*border:\s*0/);
  assert.match(CARD_CSS, /\.sl-card__toggle\s*\{[^}]*background:\s*transparent/);
  assert.match(CARD_CSS, /\.sl-card__expanded\s*\{[^}]*border-top:\s*1px solid/);
  assert.match(CARD_CSS, /\.sl-card__party\s*\{[^}]*display:\s*flex/);
  assert.match(CARD_CSS, /\.sl-card__party-label\s*\{[^}]*flex:\s*none/);
  assert.match(CARD_CSS, /\.sl-card__party-name\s*\{[^}]*min-width:\s*0/);
  assert.match(CARD_CSS, /\.sl-card__party-name\s*\{[^}]*overflow:\s*hidden/);
  assert.match(CARD_CSS, /\.sl-card__party-name\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.match(CARD_CSS, /\.sl-card__party-name\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(CARD_CSS, /\.sl-card__toggle-text\s*\{[^}]*flex:\s*none/);
  assert.match(CARD_CSS, /\.sl-card__toggle-text\s*\{[^}]*white-space:\s*nowrap/);
});

/* ── identity + card data ───────────────────────────────────────────────── */


test('install uses only public seams and registers a chat node renderer', () => {
  assert.deepEqual(incoming.inject, ['sessions', 'uiConversation', 'slots']);
  assert.equal(typeof incoming.installIncomingCards, 'function');
  const { ctx, registered } = makeCtx({
    sessions: [{ id: 'sess-B', entries: [RELAY_EVENT] }],
    lookup: () => ({ results: [LEDGER_ROW], missing: [] }),
  });
  install(ctx);
  assert.equal(registered.def.kind, 'session-link-card');
  assert.equal(registered.def.target, 'chat');
  assert.equal(registered.slotInject, 'conversation.chat.node');
  assert.equal(registered.slot.opts.key, 'session-link-card');
  assert.equal(typeof registered.slot.comp, 'function');
});

test('verified relay message claims exclusively and builds a two-line card node', async () => {
  const { ctx, registered, fetchCalls } = makeCtx({
    sessions: [{ id: 'sess-B', entries: [RELAY_EVENT] }],
    lookup: (sessionId, ids) => {
      assert.equal(sessionId, 'sess-B');
      assert.deepEqual(ids, ['durable-1']);
      return { results: [LEDGER_ROW], missing: [] };
    },
  });
  install(ctx);
  assert.equal(registered.def.match['user/message'](RELAY_EVENT), null, 'unverified event must not claim');

  await waitFor(() => fetchCalls.length >= 1, 'card_lookup call');
  assert.match(fetchCalls[0].url, /\/api\/session-link\/api$/, 'API path resolves against document base');
  assert.equal(fetchCalls[0].body.action, 'card_lookup');
  assert.deepEqual(fetchCalls[0].body.payload, { sessionId: 'sess-B', ids: ['durable-1'] });
  assert.ok(!('includeBody' in fetchCalls[0].body.payload), 'default scan must NOT request body');

  await waitFor(() => (registered.registrations ?? 0) >= 2, 'definition re-registration after verification');
  const claim = registered.def.match['user/message'](RELAY_EVENT);
  assert.ok(claim, 'verified event must claim');
  assert.equal(claim.exclusive, true, 'single projection via exclusive claim');
  assert.equal(claim.id, 'durable-1');
  assert.equal(claim.role, 'start');

  const node = buildCard(registered, RELAY_EVENT);
  assert.equal(node.kind, 'session-link-card');
  assert.equal(node.target, 'chat');
  assert.equal(node.groupTree, 'input');
  assert.equal(node.visibility, 'visible');
  assert.equal(node.data.fromDisplay, '主会话 A');
  assert.equal(node.data.toDisplay, '协作会话 B');
  assert.equal(node.data.status, 'accepted');
  assert.equal(node.data.subject, '通知');
  assert.ok(!node.data.subject.includes('session-link'), 'no protocol wrapper in subject');
  assert.ok(!node.data.subject.includes('durable-1'), 'no debug/id text in subject');
  assert.equal(typeof node.data.statusAsOf, 'number');
  assert.equal(node.data.statusStale, false);
  assert.equal(typeof node.data.isWindowCurrent, 'function');
});

test('sender-filled real subject wins over kind fallback', async () => {
  const { ctx, registered } = makeCtx({
    sessions: [{ id: 'sess-B', entries: [RELAY_EVENT] }],
    lookup: () => ({ results: [{ ...LEDGER_ROW, subject: '跟进需求确认' }], missing: [] }),
  });
  install(ctx);
  await waitFor(() => (registered.registrations ?? 0) >= 2, 'verification');
  assert.equal(buildCard(registered, RELAY_EVENT).data.subject, '跟进需求确认');
});

test('renderer: received shell — 发件人/收件人 rows + 展开 toggle, one frame, kind/parent in closed tech, wrapping body', async () => {
  const row = { ...LEDGER_ROW, kind: 'reply', parentMessageId: 'ledger-parent-1', subject: '跟进需求确认' };
  const { ctx, registered } = makeCtx({
    sessions: [{ id: 'sess-B', entries: [RELAY_EVENT] }],
    lookup: () => ({ results: [row], missing: [] }),
  });
  install(ctx);
  await waitFor(() => (registered.registrations ?? 0) >= 2, 'verification');
  const node = buildCard(registered, RELAY_EVENT);
  const Layout = incoming.SessionLinkCardLayout;
  assert.equal(typeof Layout, 'function', 'pure layout exported for structural tests');

  // ---- collapsed: ONLY the two-line header, inside ONE outer frame ----
  const collapsed = Layout({ data: node.data, open: false, body: null });
  assert.equal(collapsed.type, 'div');
  assert.equal(collapsed.props.className, cardClass('received'), 'single received frame class');
  assert.equal(collapsed.props['data-session-link-direction'], 'received');
  assert.equal(collapsed.props['data-session-link-card'], '', 'original card data attribute kept');
  assert.equal(collapsed.props['data-session-link-card-status'], 'accepted', 'status data attribute kept');
  assert.match(CARD_CSS, /\.sl-card\s*\{[^}]*border:\s*1px solid #B9C8DE/, 'outer frame owns the border');
  assert.match(CARD_CSS, /\.sl-card--received\s*\{[^}]*background:\s*#ECF3F0/, 'outer frame owns the surface');

  const toggle = findByAttr(collapsed, 'data-session-link-card-toggle');
  assert.ok(toggle !== null, 'one header button');
  assert.equal(toggle.type, 'button');
  assert.equal(toggle.props.className, 'sl-card__toggle');
  assert.equal(toggle.props.style, undefined, 'no inline styles in the shared shell');
  assert.equal(toggle.props['aria-expanded'], false);
  assert.equal(findAllByType(toggle.props.children, 'div').length, 0, 'header button holds spans only');
  assert.equal(findAllByType(toggle.props.children, 'button').length, 0, 'no nested button in the header');
  assert.equal(findAllByType(toggle.props.children, 'details').length, 0, 'no details inside the header button');

  assert.equal(findByAttr(collapsed, 'data-session-link-card-kind'), null, 'no visible 请求/回复 kind chip');
  const senderRow = findByAttr(collapsed, 'data-session-link-card-sender-row');
  assert.equal(textOf(findByAttr(senderRow, 'data-session-link-card-sender')).trim(), '主会话 A', 'line 1 sender name');
  assert.equal(textOf(senderRow).includes('发件人'), true, 'line 1 absolute 发件人 label');
  const recipientRow = findByAttr(collapsed, 'data-session-link-card-recipient-row');
  assert.equal(textOf(findByAttr(recipientRow, 'data-session-link-card-recipient')).trim(), '协作会话 B', 'line 2 recipient name');
  assert.equal(textOf(recipientRow).includes('收件人'), true, 'line 2 absolute 收件人 label');
  assert.equal(findByAttr(collapsed, 'data-session-link-card-chip'), null, 'no direction chip anywhere on the face');
  assert.equal(textOf(findByAttr(collapsed, 'data-session-link-card-toggle-text')).trim(), '展开 ⌄', 'right-top expand text on the same toggle button');
  assert.equal(findByAttr(collapsed, 'data-session-link-card-toggle').props['aria-label'].includes('展开 ⌄'), true, 'toggle accessible name carries the action');
  assert.equal(findByAttr(collapsed, 'data-session-link-card-subject-text').props.className, 'sl-card__subject', 'line 3 subject');
  const subjectRow = findByAttr(collapsed, 'data-session-link-card-subject');
  assert.equal(subjectRow.props.className, 'sl-card__party');
  assert.equal(textOf(subjectRow).includes('主题'), true, 'line 3 carries the 主题 field label');
  assert.equal(findByAttr(collapsed, 'data-session-link-card-subject-text').props.className, 'sl-card__subject');
  assert.equal(findByAttr(collapsed, 'data-session-link-card-statuslabel').props.className, 'sl-card__status');
  assert.ok(!textOf(collapsed).includes('第一行：业务正文'), 'no business body before expand');
  assert.equal(findByAttr(collapsed, 'data-session-link-card-text'), null, 'body text absent when collapsed');
  assert.equal(findByAttr(collapsed, 'data-session-link-card-technical'), null, 'technical details absent when collapsed');
  assert.equal(findByAttr(collapsed, 'data-session-link-card-expanded'), null, 'no expanded region by default');

  // ---- expanded: same frame, business body pre-wrap, closed technical details ----
  const longBody = '第一行：业务正文\n第二行：https://example.com/' + 'a'.repeat(240) + ' 结束';
  const expanded = Layout({ data: node.data, open: true, body: { phase: 'available', body: longBody } });
  const expandedRegion = findByAttr(expanded, 'data-session-link-card-expanded');
  assert.ok(expandedRegion !== null, 'expanded sibling region');
  assert.equal(expandedRegion.type, 'div');
  assert.equal(expandedRegion.props.className, 'sl-card__expanded', 'same frame: expanded is a region, not a second card');
  assert.equal(expandedRegion.props.style, undefined, 'expanded adds no independent border/background');
  assert.match(CARD_CSS, /\.sl-card__expanded\s*\{[^}]*border-top:\s*1px solid/, 'only a thin separator inside the frame');
  assert.equal(textOf(findByAttr(expanded, 'data-session-link-card-toggle-text')).trim(), '收起 ⌃', 'expanded label becomes 收起 ⌃ on the same button');
  const body = findByAttr(expanded, 'data-session-link-card-text');
  assert.equal(body.props.className, 'sl-card__body');
  assert.equal(body.props.style, undefined, 'wrapping comes from CARD_CSS, not inline style');
  assert.ok(textOf(body).includes('第一行：业务正文\n第二行：'), 'original line breaks preserved verbatim');
  assert.match(CARD_CSS, /\.sl-card__body\s*\{[^}]*white-space:\s*pre-wrap/, 'pre-wrap for received body');
  assert.match(CARD_CSS, /\.sl-card__body\s*\{[^}]*overflow-wrap:\s*anywhere/, 'long URLs break instead of overflowing');
  const tech = findByAttr(expanded, 'data-session-link-card-technical');
  assert.ok(tech !== null);
  assert.equal(tech.props.open, undefined, 'technical details stays default-closed');
  const techText = textOf(tech);
  assert.ok(techText.includes('kind: reply'), 'real ledger kind preserved in technical details');
  assert.ok(techText.includes('关联请求ID: ledger-parent-1'), 'parent request semantics kept');
  assert.ok(!textOf(findByAttr(expanded, 'data-session-link-card-toggle')).includes('ledger-parent-1'), 'parent id never on the card face');

  // No ledger kind → honest placeholder, never a fabricated kind.
  const noKindData = { ...node.data, row: { ...node.data.row, kind: undefined } };
  const noKind = Layout({ data: noKindData, open: true, body: { phase: 'unavailable', reason: 'Host 未提供正文' } });
  assert.ok(textOf(findByAttr(noKind, 'data-session-link-card-technical')).includes('kind: —'), 'missing kind is — in tech details');

  // Production data shape: buildViewNode only puts `status` at data top level,
  // never `replyStatus`; the ledger reply protocol must still show in tech.
  const answeredData = {
    ...node.data,
    row: { ...node.data.row, kind: 'request', replyStatus: 'answered' },
  };
  delete answeredData.replyStatus;
  const answered = Layout({ data: answeredData, open: true, body: { phase: 'unavailable', reason: 'Host 未提供正文' } });
  assert.ok(
    textOf(findByAttr(answered, 'data-session-link-card-technical')).includes('reply: answered'),
    'ledger reply protocol survives in technical details without a top-level data.replyStatus',
  );
});

test('forged or foreign events never claim (native fallback)', () => {
  const { ctx, registered } = makeCtx({
    sessions: [{ id: 'sess-B', entries: [RELAY_EVENT] }],
    lookup: () => ({ results: [], missing: [] }),
  });
  install(ctx);
  const cases = [
    ['human source', relayEvent({ data: { source: { kind: 'user' } } })],
    ['4-field source', relayEvent({ data: { source: { kind: 'agent-message', form: 'relay', senderSessionId: 'sess-A', extra: 1 } } })],
    ['wrong form', relayEvent({ data: { source: { kind: 'agent-message', form: 'recall', senderSessionId: 'sess-A' } } })],
    ['replacement op', relayEvent({ top: { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 } } })],
    ['missing id', relayEvent({ data: { id: '' } })],
  ];
  for (const [label, event] of cases) {
    assert.equal(registered.def.match['user/message'](event), null, `${label} must not claim`);
  }
});

test('same durable id with tampered senderSessionId does not authenticate', async () => {
  const tampered = relayEvent({ data: { source: { kind: 'agent-message', form: 'relay', senderSessionId: 'sess-EVIL' } } });
  const { ctx, registered } = makeCtx({
    sessions: [{ id: 'sess-B', entries: [tampered] }],
    lookup: () => ({ results: [LEDGER_ROW], missing: [] }),
  });
  install(ctx);
  await waitFor(() => (registered.registrations ?? 0) >= 2, 'verification pass');
  assert.equal(registered.def.match['user/message'](tampered), null, 'tampered sender must not claim');
});

test('row.to must equal the observing session (wrong target never verifies)', async () => {
  const wrongTarget = { ...LEDGER_ROW, to: 'sess-OTHER' };
  const { ctx, registered, fetchCalls } = makeCtx({
    sessions: [{ id: 'sess-B', entries: [RELAY_EVENT] }],
    lookup: () => ({ results: [wrongTarget], missing: [] }),
  });
  install(ctx);
  await waitFor(() => fetchCalls.length >= 1, 'lookup attempted');
  await delay(300);
  assert.equal(registered.def.match['user/message'](RELAY_EVENT), null, 'wrong-target row must never claim');
});

test('same id in two sessions: per-node window proof never leaks across sessions', async () => {
  const eventB = relayEvent();
  const eventF = relayEvent();
  assert.notEqual(eventB, eventF);
  const { ctx, registered, bindings } = makeCtx({
    sessions: [
      { id: 'sess-B', entries: [eventB] },
      { id: 'fork-F', entries: [eventF] },
    ],
    lookup: (sessionId, ids) => {
      if (sessionId === 'sess-B') return { results: [LEDGER_ROW], missing: [] };
      return { results: [], missing: ids.slice() };
    },
  });
  install(ctx);
  await waitFor(() => (registered.registrations ?? 0) >= 2, 'verification pass');
  assert.ok(registered.def.match['user/message'](eventB), 'recipient session must claim');
  assert.equal(registered.def.match['user/message'](eventF), null, 'fork copy must not claim');

  const nodeB = buildCard(registered, eventB);
  const isCurrentB = nodeB.data.isWindowCurrent;
  assert.equal(isCurrentB(), true);
  bindings.get('sess-B').eventSource.replaceWindow([]);
  assert.equal(isCurrentB(), false, 'card invalidates once its window no longer holds the event');
});

test('event object observed in two sessions (fork/reuse) never claims', async () => {
  const { ctx, registered, fetchCalls } = makeCtx({
    sessions: [
      { id: 'sess-B', entries: [RELAY_EVENT] },
      { id: 'fork-F', entries: [RELAY_EVENT] },
    ],
    lookup: (sessionId, ids) => {
      if (sessionId === 'sess-B') return { results: [LEDGER_ROW], missing: [] };
      return { results: [], missing: ids.slice() };
    },
  });
  install(ctx);
  await waitFor(() => (registered.registrations ?? 0) >= 2, 'verification pass');
  await waitFor(() => fetchCalls.some((c) => c.body.payload.sessionId === 'fork-F'), 'fork scope lookup');
  await delay(250);
  assert.equal(registered.def.match['user/message'](RELAY_EVENT), null, 'multi-scope event must not claim');
});

/* ── status semantics ──────────────────────────────────────────────────── */

test('status truth table: precise labels, no read/handled claims, timed_out keeps facts', () => {
  const t = (row, asOf = null, stale = false) => incoming.statusDisplay(row, asOf, stale);
  const cases = [
    [{ status: 'pending' }, '待投递'],
    [{ status: 'held' }, '已暂存·待投递'],
    [{ status: 'dispatching' }, '投递中·结果待确认'],
    [{ status: 'unknown' }, '需核对'],
    [{ status: 'cancelled' }, '已取消'],
    [{ status: 'failed' }, '失败'],
    [{ status: 'accepted', receipt: null }, '宿主已接收·进入上下文未确认'],
    [{ status: 'accepted', receipt: { policy: 'legacy-accepted', state: 'received' } }, '宿主已接收·进入上下文未确认'],
    [{ status: 'accepted', receipt: { policy: 'context', state: 'queued' } }, '宿主已接收·待进入上下文'],
    [{ status: 'accepted', receipt: { policy: 'context', state: 'not_sent' } }, '需核对'],
    [{ status: 'accepted', receipt: { policy: 'context', state: 'uncertain' } }, '需核对'],
    [{ status: 'accepted', receipt: { policy: 'context', state: 'received', receivedAt: 1700000000000 } }, '已进入上下文'],
    [{ status: 'accepted', receipt: { policy: 'context', state: 'received' }, replyStatus: 'answered' }, '明确回复'],
    [{ status: 'accepted', receipt: { policy: 'context', state: 'received' }, replyStatus: 'timed_out' }, '已进入上下文 · 等待回复超时'],
    [{ status: 'pending', replyStatus: 'timed_out' }, '待投递 · 等待回复超时'],
    [{ status: 'accepted', replyStatus: 'waiting' }, '宿主已接收·进入上下文未确认'],
    [null, '需核对'],
    [{ status: 'something-new' }, '需核对'],
  ];
  for (const [row, expected] of cases) {
    const info = t(row);
    assert.equal(info.label, expected, `label for ${JSON.stringify(row)}`);
    assert.ok(!/已读|已处理|完成/.test(info.label), `forbidden claim in ${info.label}`);
  }
  const received = t({ status: 'accepted', receipt: { policy: 'context', state: 'received', receivedAt: 1700000000000 } });
  assert.equal(received.receiptTime, 1700000000000);
  assert.equal(t({ status: 'accepted', receipt: { policy: 'context', state: 'queued' } }).receiptTime, null);
  const fresh = t({ status: 'pending' }, 1700000001000, true);
  assert.equal(fresh.asOf, 1700000001000);
  assert.equal(fresh.stale, true);
});

test('status freshness: queued→received refresh updates card; failed refresh keeps last + stale', async () => {
  let currentRow = { ...LEDGER_ROW, receipt: { policy: 'context', state: 'queued', receivedAt: null, receivedSeq: null } };
  const control = { fail: false };
  const { ctx, registered, poke } = makeCtx({
    sessions: [{ id: 'sess-B', entries: [RELAY_EVENT] }],
    lookup: () => ({ results: [currentRow], missing: [] }),
    control,
  });
  install(ctx, { refreshIntervalMs: 0 }); // every scan is a refresh pass
  await waitFor(() => (registered.registrations ?? 0) >= 2, 'initial verification');
  const node1 = buildCard(registered, RELAY_EVENT);
  assert.equal(node1.data.statusStale, false);
  const asOf1 = node1.data.statusAsOf;

  await delay(5);
  currentRow = { ...LEDGER_ROW, receipt: { policy: 'context', state: 'received', receivedAt: 1700000005000, receivedSeq: 42 } };
  const before = registered.registrations;
  poke();
  await waitFor(() => (registered.registrations ?? 0) > before, 'refresh rebuild');
  const node2 = buildCard(registered, RELAY_EVENT);
  assert.equal(incoming.statusDisplay(node2.data.row).label, '已进入上下文');
  assert.ok(node2.data.statusAsOf >= asOf1, 'as-of advances');
  assert.equal(node2.data.statusStale, false);

  control.fail = true;
  const beforeFail = registered.registrations;
  poke();
  await waitFor(() => (registered.registrations ?? 0) > beforeFail, 'stale rebuild');
  const node3 = buildCard(registered, RELAY_EVENT);
  assert.equal(node3.data.statusStale, true, 'failed refresh marks stale');
  assert.equal(incoming.statusDisplay(node3.data.row).label, '已进入上下文', 'stale keeps last evidenced value');
});

test('on-demand body: includeBody only with exact id/session and re-validated facts', async () => {
  const calls = [];
  const row = { ...LEDGER_ROW, subject: '跟进需求确认', body: '这是业务正文。', bodyState: 'available' };
  const okFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    return { ok: true, json: async () => ({ ok: true, value: { results: [row], missing: [] } }) };
  };
  const fetchCardBody = incoming.createBodyFetcher({ url: 'http://127.0.0.1/api/session-link/api', fetchImpl: okFetch });
  const result = await fetchCardBody({ sessionId: 'sess-B', durableId: 'durable-1', senderSessionId: 'sess-A' });
  assert.equal(result.phase, 'available');
  assert.equal(result.body, '这是业务正文。');
  assert.equal(result.row.to, 'sess-B');
  assert.deepEqual(calls[0].body.payload, { sessionId: 'sess-B', ids: ['durable-1'], includeBody: true });

  const withRow = (patched) =>
    incoming.createBodyFetcher({
      url: 'http://x/api/session-link/api',
      fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, value: { results: [patched], missing: [] } }) }),
    })({ sessionId: 'sess-B', durableId: 'durable-1', senderSessionId: 'sess-A' });

  assert.equal((await withRow({ ...row, to: 'sess-OTHER' })).phase, 'unavailable');
  assert.equal((await withRow({ ...row, from: 'sess-EVIL' })).phase, 'unavailable');
  assert.equal((await withRow({ ...row, body: null, bodyState: 'redacted' })).phase, 'redacted');
  const withheld = await withRow({ id: 'ledger-1', durableMessageId: 'durable-1', from: 'sess-A', to: 'sess-B', status: 'unknown' });
  assert.equal(withheld.phase, 'unavailable');
});

test('ledger kind is data/tech-only: face is 发件人/收件人; parent semantics unchanged', async () => {
  const cases = [
    { kind: 'reply', parentMessageId: 'ledger-parent-1', subject: '跟进需求确认', mark: '回复', parentLabel: '关联请求ID' },
    { kind: 'request', parentMessageId: null, subject: null, mark: '请求', parentLabel: '' },
    { kind: 'notification', parentMessageId: null, subject: null, mark: '', parentLabel: '' },
    { kind: 'something-new', parentMessageId: null, subject: null, mark: '', parentLabel: '' },
  ];
  for (const c of cases) {
    const row = { ...LEDGER_ROW, kind: c.kind, parentMessageId: c.parentMessageId, subject: c.subject };
    const { ctx, registered } = makeCtx({
      sessions: [{ id: 'sess-B', entries: [RELAY_EVENT] }],
      lookup: () => ({ results: [row], missing: [] }),
    });
    install(ctx);
    await waitFor(() => (registered.registrations ?? 0) >= 2, `verification (${c.kind})`);
    const node = buildCard(registered, RELAY_EVENT);
    // data.kindMark may stay as data (host-side bookkeeping), but it is NEVER
    // rendered as a chip: the card face shows only the direction.
    assert.equal(node.data.kindMark, c.mark, `${c.kind} underlying data mark only`);
    assert.equal(node.data.parentMessageId, c.parentMessageId ?? '', `${c.kind} parent id (none fabricated)`);
    assert.equal(node.data.parentLabel, c.parentLabel, `${c.kind} parent link label`);
    // The mark is separate from the subject: the two-line layout keeps the
    // sender subject/first-line text intact (no squeezing by re-labeling).
    if (c.subject) assert.equal(node.data.subject, c.subject, 'subject unaffected by the mark');
    if (c.kind === 'reply') assert.equal(node.data.subject, '跟进需求确认');
    // Default (pre-expand) payload never contains the business body.
    assert.equal('body' in (node.data.row ?? {}), false, 'body only on expand, never in the default row');
    // Raw envelope text is preserved verbatim for the technical disclosure.
    assert.ok(node.data.text.includes('notification only'), 'raw event text kept as-is');
    const face = incoming.SessionLinkCardLayout({ data: node.data, open: false });
    assert.equal(findByAttr(face, 'data-session-link-card-chip'), null, 'no direction chip on the face');
    assert.equal(textOf(findByAttr(face, 'data-session-link-card-toggle-text')).trim(), '展开 ⌄', 'expand text stays on the face');
    assert.equal(findByAttr(face, 'data-session-link-card-kind'), null, `${c.kind} renders no visible kind chip`);
    const tech = textOf(findByAttr(incoming.SessionLinkCardLayout({ data: node.data, open: true }), 'data-session-link-card-technical'));
    assert.ok(tech.includes(`kind: ${c.kind}`), `${c.kind} real kind stays in technical details`);
  }
});

test('parent link label: only a verified reply calls it 关联请求ID; other kinds continue a chain', async () => {
  const cases = [
    { kind: 'reply', parentMessageId: 'ledger-parent-1', parentLabel: '关联请求ID' },
    // session_link_send can continue a chain from notifications/requests too,
    // so their parent is NOT necessarily a request.
    { kind: 'notification', parentMessageId: 'ledger-parent-2', parentLabel: '关联消息ID' },
    { kind: 'request', parentMessageId: 'ledger-parent-3', parentLabel: '关联消息ID' },
    { kind: 'something-new', parentMessageId: 'ledger-parent-4', parentLabel: '关联消息ID' },
    // No parent → nothing shown/labelled (never fabricated).
    { kind: 'notification', parentMessageId: null, parentLabel: '' },
    { kind: 'reply', parentMessageId: '', parentLabel: '' },
  ];
  for (const c of cases) {
    const row = { ...LEDGER_ROW, kind: c.kind, parentMessageId: c.parentMessageId };
    const { ctx, registered } = makeCtx({
      sessions: [{ id: 'sess-B', entries: [RELAY_EVENT] }],
      lookup: () => ({ results: [row], missing: [] }),
    });
    install(ctx);
    await waitFor(() => (registered.registrations ?? 0) >= 2, `verification (${c.kind}+${c.parentMessageId})`);
    const node = buildCard(registered, RELAY_EVENT);
    assert.equal(node.data.parentMessageId, typeof c.parentMessageId === 'string' ? c.parentMessageId : '', 'raw ledger parent id only');
    assert.equal(node.data.parentLabel, c.parentLabel, `${c.kind} with parent=${c.parentMessageId} label`);
  }
});

/* ── incremental performance ────────────────────────────────────────────── */

test('incremental: 1000 transient stream tokens cause zero scans, walks, lookups, rebuilds', async () => {
  const { ctx, registered, fetchCalls, bindings } = makeCtx({
    sessions: [{ id: 'sess-B', entries: [RELAY_EVENT] }],
    lookup: () => ({ results: [LEDGER_ROW], missing: [] }),
  });
  const handle = install(ctx);
  await waitFor(() => (registered.registrations ?? 0) >= 2, 'initial verification');
  const before = { fetch: fetchCalls.length, reg: registered.registrations, ...handle.stats };

  const source = bindings.get('sess-B').eventSource;
  for (let i = 0; i < 1000; i += 1) {
    source.appendTransient({ type: 'assistant/live-chunk', seq: 1000 + i, time: 1700000000000 + i, data: { text: 'tok' } });
  }
  await delay(500);

  assert.equal(fetchCalls.length, before.fetch, 'streaming tokens must not trigger owner lookups');
  assert.equal(registered.registrations, before.reg, 'streaming tokens must not trigger rebuilds');
  assert.equal(handle.stats.scans, before.scans, 'streaming tokens must not schedule scans');
  assert.equal(handle.stats.windowWalks, before.windowWalks, 'streaming tokens must not walk any window');
  assert.ok(registered.def.match['user/message'](RELAY_EVENT), 'earlier verified claim stays valid');
});

test('incremental: relay append is a delta — one lookup with only the new id, no window walk', async () => {
  const { ctx, registered, fetchCalls, bindings } = makeCtx({
    sessions: [{ id: 'sess-B', entries: [RELAY_EVENT] }],
    lookup: (sessionId, ids) => ({
      results: ids.map((id) => ({ ...LEDGER_ROW, id: `ledger-${id}`, durableMessageId: id })),
      missing: [],
    }),
  });
  const handle = install(ctx);
  await waitFor(() => (registered.registrations ?? 0) >= 2, 'initial verification');

  const before = { ...handle.stats };
  const regBefore = registered.registrations;
  const relay2 = relayEvent({ top: { seq: 8 }, data: { id: 'durable-2' } });
  bindings.get('sess-B').eventSource.appendEvent(relay2);

  await waitFor(() => fetchCalls.some((c) => c.body.payload.ids.includes('durable-2')), 'delta lookup');
  const deltaCall = fetchCalls.find((c) => c.body.payload.ids.includes('durable-2'));
  assert.deepEqual(deltaCall.body.payload, { sessionId: 'sess-B', ids: ['durable-2'] }, 'only the new id is queried');
  assert.equal(handle.stats.windowWalks, before.windowWalks, 'delta append must not re-walk the window');
  await waitFor(() => registered.registrations > regBefore, 'rebuild after delta verification');
  assert.equal(registered.registrations, regBefore + 1, 'one coalesced rebuild per batch');
  assert.ok(registered.def.match['user/message'](relay2), 'delta message claims');
});

/* ── transactional install (setup failure must leak nothing) ───────────── */

test('install is transactional: slot failure rolls back definition, feeds, timers', async () => {
  const { ctx, registered, fetchCalls, bindings } = makeCtx({
    sessions: [{ id: 'sess-B', entries: [RELAY_EVENT] }],
    lookup: () => ({ results: [LEDGER_ROW], missing: [] }),
    control: { slotFail: true },
  });
  assert.throws(() => install(ctx), /slot inject failed/);

  assert.ok((registered.disposals ?? 0) >= 1, 'registered Definition must be released');
  assert.equal(registered.registrations, 1, 'exactly the one failed registration');
  assert.equal(bindings.get('sess-B').eventSource.listenerCount(), 0, 'source feed must be unsubscribed');
  assert.equal(registered.slotDisposals, undefined, 'slot never installed in this case');

  // The pending scan timer was cancelled: no owner lookup appears afterwards.
  await delay(500);
  assert.equal(fetchCalls.length, 0, 'no leaked timer may produce a lookup');

  // Retry on the same context works end to end (register → re-register after
  // verification is the SECOND registration of the retry, not just the first).
  const regBeforeRetry = registered.registrations;
  install(ctx);
  await waitFor(() => (registered.registrations ?? 0) >= regBeforeRetry + 2, 'retry verification');
  assert.ok(registered.def.match['user/message'](RELAY_EVENT), 'retry produces a working card');
});

test('install is transactional: effect failure rolls back everything installed', async () => {
  const { ctx, registered, fetchCalls, bindings, cleanups } = makeCtx({
    sessions: [{ id: 'sess-B', entries: [RELAY_EVENT] }],
    lookup: () => ({ results: [LEDGER_ROW], missing: [] }),
    control: { effectFail: true },
  });
  assert.throws(() => install(ctx), /effect failed/);

  assert.ok((registered.disposals ?? 0) >= 1, 'Definition released');
  assert.equal(registered.slotDisposals, 1, 'slot renderer released');
  assert.equal(bindings.get('sess-B').eventSource.listenerCount(), 0, 'source feed unsubscribed');
  await delay(500);
  assert.equal(fetchCalls.length, 0, 'no leaked timer may produce a lookup');

  // A host that still invokes the recorded cleanup later must not break.
  for (const cleanup of cleanups) assert.doesNotThrow(() => cleanup());

  const regBeforeRetry = registered.registrations;
  install(ctx); // retry
  await waitFor(() => (registered.registrations ?? 0) >= regBeforeRetry + 2, 'retry verification');
  assert.ok(registered.def.match['user/message'](RELAY_EVENT), 'retry produces a working card');
});

/* ── generation replacement / unbind / unmount ─────────────────────────── */

test('same-sessionId source swap: old feed unsubscribed, caches revoked, new feed works', async () => {
  const { ctx, registered, fetchCalls, bindings, replaceSource } = makeCtx({
    sessions: [{ id: 'sess-B', entries: [RELAY_EVENT] }],
    lookup: (sessionId, ids) => ({
      results: ids.map((id) => ({ ...LEDGER_ROW, id: `ledger-${id}`, durableMessageId: id })),
      missing: [],
    }),
  });
  install(ctx);
  await waitFor(() => (registered.registrations ?? 0) >= 2, 'initial verification');
  assert.ok(registered.def.match['user/message'](RELAY_EVENT), 'pre-swap claim holds');

  const oldSource = bindings.get('sess-B').eventSource;
  assert.equal(oldSource.listenerCount(), 1);
  const lookupsBefore = fetchCalls.length;
  const regBefore = registered.registrations;

  replaceSource('sess-B', [RELAY_EVENT], 7); // same id, new feed, reused revision
  const newSource = bindings.get('sess-B').eventSource;
  assert.notEqual(newSource, oldSource);
  assert.equal(oldSource.listenerCount(), 0, 'old generation feed unsubscribed on swap');

  await waitFor(() => fetchCalls.length > lookupsBefore, 're-verification after swap');
  await waitFor(() => registered.registrations > regBefore, 'rebuild after re-verification');
  assert.ok(registered.def.match['user/message'](RELAY_EVENT), 'new generation relay claims again');

  const beforeOld = fetchCalls.length;
  oldSource.appendEvent(relayEvent({ top: { seq: 99 }, data: { id: 'durable-old' } }));
  await delay(400);
  assert.equal(fetchCalls.length, beforeOld, 'stale generation feed must not trigger work');

  const relay3 = relayEvent({ top: { seq: 9 }, data: { id: 'durable-3' } });
  newSource.appendEvent(relay3);
  await waitFor(() => fetchCalls.some((c) => c.body.payload.ids.includes('durable-3')), 'new generation delta');
  await waitFor(() => registered.def.match['user/message'](relay3) !== null, 'new generation claim');
});

test('unbind: a session removed from the list stops causing work', async () => {
  const { ctx, registered, fetchCalls, bindings, removeSession } = makeCtx({
    sessions: [{ id: 'sess-B', entries: [RELAY_EVENT] }],
    lookup: () => ({ results: [LEDGER_ROW], missing: [] }),
  });
  install(ctx);
  await waitFor(() => (registered.registrations ?? 0) >= 2, 'initial verification');
  const source = bindings.get('sess-B').eventSource;
  assert.equal(source.listenerCount(), 1);
  removeSession('sess-B');
  assert.equal(source.listenerCount(), 0, 'removed session feed unsubscribed');
  const before = fetchCalls.length;
  source.appendEvent(relayEvent({ top: { seq: 50 }, data: { id: 'durable-x' } }));
  await delay(400);
  assert.equal(fetchCalls.length, before, 'unbound session events must not look up anything');
});

test('unmount: in-flight lookup is aborted and no later work happens', async () => {
  const { ctx, registered, fetchCalls, bindings, cleanups } = makeCtx({
    sessions: [{ id: 'sess-B', entries: [RELAY_EVENT] }],
    lookup: () => ({ results: [LEDGER_ROW], missing: [] }),
    control: { hang: true },
  });
  install(ctx);
  await waitFor(() => fetchCalls.length >= 1, 'in-flight lookup');
  const signal = fetchCalls[0].signal;
  assert.equal(signal.aborted, false);
  cleanups[0]();
  assert.equal(signal.aborted, true, 'unmount must abort the in-flight request');
  assert.ok((registered.disposals ?? 0) >= 1, 'definition disposed');
  const before = fetchCalls.length;
  bindings.get('sess-B').eventSource.appendEvent(relayEvent({ top: { seq: 60 }, data: { id: 'durable-after' } }));
  await delay(400);
  assert.equal(fetchCalls.length, before, 'no lookups after unmount');
  assert.equal(bindings.get('sess-B').eventSource.listenerCount(), 0, 'no feeds left subscribed');
});

/* ── exclusive-claim conflict guard (fake registry) ─────────────────────── */

test('exclusive conflict: same-target peer exclusive claim wins; we back off without throwing', async () => {
  const peer = {
    kind: 'peer-card',
    target: 'chat',
    match: { 'user/message': () => ({ id: 'peer-msg', role: 'start', exclusive: true }) },
  };
  const { ctx, registered } = makeCtx({
    sessions: [{ id: 'sess-B', entries: [RELAY_EVENT] }],
    lookup: () => ({ results: [LEDGER_ROW], missing: [] }),
    peers: [peer],
  });
  install(ctx);
  await waitFor(() => (registered.registrations ?? 0) >= 2, 'verification');
  assert.equal(registered.def.match['user/message'](RELAY_EVENT), null, 'decline rather than double-claim');
  assert.equal(peer.match['user/message'](RELAY_EVENT).exclusive, true, 'peer keeps its claim');
});

test('exclusive on another target (or another event) does not block our claim', async () => {
  const peers = [
    { kind: 'peer-workspace', target: 'workspace', match: { 'user/message': () => ({ id: 'p', role: 'start', exclusive: true }) } },
    { kind: 'peer-other-event', target: 'chat', match: { 'user/message': () => null } },
  ];
  const { ctx, registered } = makeCtx({
    sessions: [{ id: 'sess-B', entries: [RELAY_EVENT] }],
    lookup: () => ({ results: [LEDGER_ROW], missing: [] }),
    peers,
  });
  install(ctx);
  await waitFor(() => (registered.registrations ?? 0) >= 2, 'verification');
  assert.ok(registered.def.match['user/message'](RELAY_EVENT), 'non-conflicting peers must not block');
});

test('mutual pre-check does not recurse: peer calls our match back, exactly one side claims', async () => {
  let nestedCalls = 0;
  const peer = {
    kind: 'peer-loop',
    target: 'chat',
    match: {
      'user/message': (event) => {
        nestedCalls += 1;
        const ours = registered.def?.match?.['user/message']?.(event);
        assert.equal(ours, null, 're-entrant call must decline (no recursion)');
        return { id: 'peer-loop', role: 'start', exclusive: true };
      },
    },
  };
  const { ctx, registered } = makeCtx({
    sessions: [{ id: 'sess-B', entries: [RELAY_EVENT] }],
    lookup: () => ({ results: [LEDGER_ROW], missing: [] }),
    peers: [peer],
  });
  install(ctx);
  await waitFor(() => (registered.registrations ?? 0) >= 2, 'verification');
  assert.equal(registered.def.match['user/message'](RELAY_EVENT), null, 'we decline under mutual pre-check');
  assert.equal(nestedCalls, 1, 'peer evaluated once, no recursion');
});

/* ── exclusive-claim conflict guard against the REAL dispatcher ─────────── */

/** Minimal fake client ctx wired to a REAL ConversationEventRegistry. */
function makeRealRegistryCtx(registry) {
  const bindings = new Map([
    ['sess-B', { sessionId: 'sess-B', eventSource: { getSnapshot: () => ({ entries: [{ type: 'event', event: RELAY_EVENT }], hasMore: false, revision: 1, change: { kind: 'replace', entries: [] } }), subscribe: () => () => {} } }],
  ]);
  const listSubscribers = new Set();
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.action, 'card_lookup');
    return { ok: true, json: async () => ({ ok: true, value: { results: [LEDGER_ROW], missing: [] } }) };
  };
  return {
    sessions: {
      list: {
        getSnapshot: () => ({ byId: { 'sess-B': { id: 'sess-B' } } }),
        subscribe: (fn) => {
          listSubscribers.add(fn);
          return () => listSubscribers.delete(fn);
        },
      },
      binding: (id) => bindings.get(id),
    },
    uiConversation: { events: registry },
    slots: { inject: (_n, fn) => fn(), register: () => () => {} },
    effect: (fn) => fn(),
  };
}

function claimedKinds(pending) {
  const kinds = new Set();
  for (const matches of pending.values()) for (const match of matches) kinds.add(match.definition.kind);
  return kinds;
}

async function waitRealVerified(Conv, registry, handle) {
  const assembler = new Conv.ConversationNodeAssembler(registry, { entries: () => [] });
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (handle.stats.lookups >= 1) {
      await delay(50);
      return assembler;
    }
    await delay(25);
  }
  throw new Error('addon never performed its verification lookup');
}

test('real dispatcher: two naive exclusive claimers on one event+target throw', { skip: skipConv }, () => {
  const Conv = loadConversation();
  const registry = new Conv.ConversationEventRegistry({ effect: (fn) => fn() });
  const assembler = new Conv.ConversationNodeAssembler(registry, { entries: () => [] });
  const claimer = (kind) => ({
    kind,
    target: 'chat',
    buildViewNode: () => null,
    match: { 'user/message': () => ({ id: 'dup', role: 'start', exclusive: true }) },
  });
  registry.register(claimer('naive-one'));
  registry.register(claimer('naive-two'));
  assert.throws(
    () => assembler.collectInput({ type: 'event', event: RELAY_EVENT }, new Map()),
    /both claim user\/message/,
    'real dispatcher must throw on a double exclusive claim (harness is not vacuous)',
  );
});

test('real dispatcher: third-party exclusive + our module → no throw, peer keeps claim', { skip: skipConv }, async () => {
  const Conv = loadConversation();
  const registry = new Conv.ConversationEventRegistry({ effect: (fn) => fn() });
  registry.register({
    kind: 'third-party-card',
    target: 'chat',
    buildViewNode: () => null,
    match: { 'user/message': () => ({ id: 'peer-msg', role: 'start', exclusive: true }) },
  });
  const handle = install(makeRealRegistryCtx(registry));
  const assembler = await waitRealVerified(Conv, registry, handle);

  const pending = new Map();
  assembler.collectInput({ type: 'event', event: RELAY_EVENT }, pending);
  const kinds = claimedKinds(pending);
  assert.ok(kinds.has('third-party-card'), 'peer claim must survive (not swallowed)');
  assert.equal(kinds.has('session-link-card'), false, 'our definition must decline the contested claim');
});

test('real dispatcher: without a conflicting peer our module claims normally', { skip: skipConv }, async () => {
  const Conv = loadConversation();
  const registry = new Conv.ConversationEventRegistry({ effect: (fn) => fn() });
  const handle = install(makeRealRegistryCtx(registry));
  const assembler = await waitRealVerified(Conv, registry, handle);
  const pending = new Map();
  assembler.collectInput({ type: 'event', event: RELAY_EVENT }, pending);
  assert.deepEqual([...claimedKinds(pending)], ['session-link-card'], 'only our claim, exactly once');
});

test('real dispatcher: mutual pre-check terminates with exactly one claim (no recursion)', { skip: skipConv }, async () => {
  const Conv = loadConversation();
  const registry = new Conv.ConversationEventRegistry({ effect: (fn) => fn() });
  let peerCalls = 0;
  registry.register({
    kind: 'mutual-peer',
    target: 'chat',
    buildViewNode: () => null,
    match: {
      'user/message': (event) => {
        peerCalls += 1;
        for (const route of registry.forEvent(event.type)) {
          if (route.definition.kind === 'session-link-card') route.match(event);
        }
        return { id: 'mutual-peer', role: 'start', exclusive: true };
      },
    },
  });
  const handle = install(makeRealRegistryCtx(registry));
  const assembler = await waitRealVerified(Conv, registry, handle);
  const pending = new Map();
  assembler.collectInput({ type: 'event', event: RELAY_EVENT }, pending);
  assert.deepEqual([...claimedKinds(pending)], ['mutual-peer'], 'exactly one claim survives');
  assert.ok(peerCalls >= 1, 'peer match executed');
});
