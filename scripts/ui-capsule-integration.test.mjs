// Integration-level regression tests for bubble-mode capsule grouping.
//
// The REAL receiver install (`src/client/incoming-cards.jsx`, bundled in
// memory by esbuild with write:false) and the REAL shared group store
// (`src/client/capsule-group-store.mjs`) run against a synthetic client ctx:
// fake SessionBinding/eventSource windows and a local card_lookup stub. No
// Host, no real session, no network, no browser/ReactDOM, no fixed /tmp path.
//
// The onReady.scan seam is the only scheduler used; every assertion is made
// through the store snapshot/info (the same data the bubble renderer reads).
//
// Baseline expectations at 7c9cf6a (0.8.19): the sent-only first-bind refresh,
// receipt-state/stale distinctions, unknown-turn invalidation, native-fallback
// and visible-boundary cases are the gaps these tests pin down. Run:
//   node --test scripts/ui-capsule-integration.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';

import { createCapsuleGroupStore } from '../src/client/capsule-group-store.mjs';
import { createSenderCardDefinition } from '../src/client/outgoing-card.mjs';
import { createCardVerifier } from '../src/client/outgoing-card-verify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoReq = createRequire(path.join(here, '../package.json'));

/** Bundle the product receiver exactly as the repo build does (in memory). */
async function loadIncoming() {
  const result = await build({
    absWorkingDir: path.join(here, '..'),
    entryPoints: ['src/client/incoming-cards.jsx'],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    external: ['react', 'react-dom', '@deepseek-ai/*'],
    logLevel: 'silent',
  });
  const module = { exports: {} };
  const req = (name) => {
    if (name === 'react' || name === 'react-dom' || name === 'react/jsx-runtime') return repoReq(name);
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: () => null };
    throw new Error(`unexpected require: ${name}`);
  };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(req, module, module.exports);
  return module.exports;
}

const incoming = await loadIncoming();

const SESSION = 'sess-recipient';
const PEER = 'sess-peer';
const T0 = Date.UTC(2026, 10, 10, 8, 0, 0);

function relayEvent({ seq, time, id, sender = PEER, turn }) {
  const data = {
    id,
    source: { kind: 'agent-message', form: 'relay', senderSessionId: sender },
    content: [{ type: 'text', text: 'synthetic notification\nsynthetic body' }],
  };
  if (turn !== undefined) data.turn = turn;
  return { type: 'user/message', surfaceOp: 'append', seq, time, data };
}

function ledgerRow({
  id,
  from = PEER,
  to = SESSION,
  kind = 'notification',
  status = 'accepted',
  turn = 8,
  receiptState = 'received',
  fromTitle = 'Peer A',
} = {}) {
  return {
    id,
    durableMessageId: id,
    from,
    fromTitle,
    to,
    toTitle: 'Recipient',
    kind,
    subject: null,
    chainId: 'chain-synthetic',
    parentMessageId: null,
    status,
    replyStatus: 'none',
    receipt: receiptState === null
      ? null
      : { policy: 'context', state: receiptState, receivedAt: receiptState === 'received' ? T0 : null, receivedSeq: receiptState === 'received' ? 1 : null },
  };
}

function toolCall({ seq, time, name, turn = 8 }) {
  return {
    type: 'tool/call',
    seq,
    time,
    data: { callId: `call-${seq}`, name, arguments: '{}', turn, step: 0 },
  };
}

function makeEventSource(initialEvents) {
  let entries = initialEvents.map((event) => ({ type: 'event', event }));
  let revision = 1;
  let change = { kind: 'replace', entries: entries.slice() };
  const listeners = new Set();
  return {
    getSnapshot: () => ({ entries: entries.slice(), hasMore: false, revision, change }),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    listenerCount: () => listeners.size,
    appendEvent(event) {
      entries = [...entries, { type: 'event', event }];
      revision += 1;
      change = { kind: 'append', entries: [{ type: 'event', event }] };
      for (const fn of [...listeners]) fn();
    },
  };
}

/**
 * Synthetic client context with the same public seams the receiver install
 * consumes. `lookup(sessionId, ids)` is the only data input (local stub).
 */
function makeCtx({ sessions, lookup }) {
  const registered = { registrations: 0 };
  const fetchCalls = [];
  const bindings = new Map();
  const listSubscribers = new Set();
  const cleanups = [];
  for (const spec of sessions) {
    bindings.set(spec.id, { sessionId: spec.id, eventSource: makeEventSource(spec.entries ?? []) });
  }
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    fetchCalls.push({ url: String(url), body });
    assert.equal(body.action, 'card_lookup', 'only the receiver ledger lookup is exercised');
    const value = await lookup(body.payload.sessionId, body.payload.ids.slice(), body.payload);
    return { ok: true, status: 200, json: async () => ({ ok: true, value }) };
  };
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
        register: (definition) => {
          registered.def = definition;
          registered.registrations += 1;
          return () => {
            registered.disposals = (registered.disposals ?? 0) + 1;
          };
        },
        // Route-table pre-check shape; our own definition is skipped by kind.
        forEvent: () => {
          const routes = new Set();
          if (registered.def !== undefined) routes.add({ definition: registered.def, match: () => null });
          return routes;
        },
      },
    },
    slots: {
      inject: (name, fn) => {
        registered.slotInject = name;
        fn();
        return () => {};
      },
      register: (opts, comp) => {
        registered.slot = { opts, comp };
        return () => {};
      },
    },
    effect: (fn) => {
      const cleanup = fn();
      cleanups.push(cleanup);
      return cleanup;
    },
  };
  return { ctx, registered, fetchCalls, bindings, cleanups, fetchImpl };
}

/** Install the real receiver with the shared store; returns the test seam. */
function install({ sessions, lookup, groupStore, refreshIntervalMs }) {
  const env = makeCtx({ sessions, lookup });
  // One shared presentation store for both directions, exactly like the
  // plugin entry hands the same instance to both installs.
  const store = groupStore ?? createCapsuleGroupStore();
  let handle;
  incoming.installIncomingCards(env.ctx, {
    fetchImpl: env.fetchImpl,
    groupStore: store,
    onReady: (h) => { handle = h; },
    ...(refreshIntervalMs === undefined ? {} : { refreshIntervalMs }),
  });
  assert.ok(handle, 'onReady must deliver the controlled scan seam');
  let disposed = false;
  return {
    ...env,
    handle,
    store,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cleanup of env.cleanups) {
        try { cleanup(); } catch { /* best-effort teardown */ }
      }
    },
  };
}

async function waitFor(predicate, label, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(15);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/**
 * Drive exactly the controlled onReady.scan pass. A verification batch must
 * re-register the Definition after refreshing the group store; wait for that
 * rebuild so assertions never race the ledger fetch.
 */
async function scanOnce(env, { expectRebuild = true, label = 'scan' } = {}) {
  const scansBefore = env.handle.stats.scans;
  const registrationsBefore = env.registered.registrations;
  env.handle.scan();
  await waitFor(() => env.handle.stats.scans > scansBefore, `${label}: scan started`);
  if (expectRebuild) {
    await waitFor(
      () => env.registered.registrations > registrationsBefore,
      `${label}: verification rebuild`,
    );
  } else {
    await delay(30);
  }
}

function groupInfo(env, seq) {
  return env.store.info(env.store.getSnapshot(), SESSION, seq);
}

function assertGroups(env, expected, label) {
  for (const [seq, info] of Object.entries(expected)) {
    assert.deepEqual(
      groupInfo(env, Number(seq)),
      info,
      `${label}: seq ${seq} grouping`,
    );
  }
}

const rowsFor = (rows) => (sessionId, ids) => ({
  results: rows.filter((row) => row.to === sessionId && ids.includes(row.durableMessageId)),
  missing: ids.filter((id) => !rows.some((row) => row.to === sessionId && row.durableMessageId === id)),
});

/* ── 1. sent-only first binding ─────────────────────────────────────────── */

test('sent-only first bind: setSentMeta then one scan groups two same-turn/same-target sent capsules', async (t) => {
  const groupStore = createCapsuleGroupStore();
  const env = install({
    sessions: [{
      id: SESSION,
      entries: [
        toolCall({ seq: 1101, time: T0, name: 'session_link_send', turn: 8 }),
        toolCall({ seq: 1102, time: T0 + 1000, name: 'session_link_send', turn: 8 }),
      ],
    }],
    lookup: () => ({ results: [], missing: [] }),
    groupStore,
  });
  t.after(() => env.dispose());

  const meta = { target: PEER, kind: 'notification', status: '已进入上下文', turn: 8, multiTarget: false };
  let metaError = null;
  try {
    // Real sender view writes meta before asking the receiver side to re-scan.
    groupStore.setSentMeta(SESSION, 1101, meta);
    groupStore.setSentMeta(SESSION, 1102, meta);
  } catch (error) {
    metaError = error;
  }
  assert.equal(metaError, null, `setSentMeta before the first scan must not throw: ${metaError?.message ?? ''}`);
  await Promise.resolve(); // let a store implementation coalesce the writes

  await scanOnce(env, { expectRebuild: false, label: 'sent-only first bind' });
  assertGroups(env, {
    1101: { head: true, count: 2 },
    1102: { head: false, count: 2 },
  }, 'sent-only first bind');
});

/* ── 2. receipt state is part of the visible status ─────────────────────── */

test('received: accepted+received never merges with accepted+queued', async (t) => {
  const rows = [
    ledgerRow({ id: 'd-201', turn: 8, receiptState: 'received' }),
    ledgerRow({ id: 'd-202', turn: 8, receiptState: 'received' }),
    ledgerRow({ id: 'd-203', turn: 8, receiptState: 'queued' }),
  ];
  const env = install({
    sessions: [{
      id: SESSION,
      entries: [
        relayEvent({ seq: 201, time: T0, id: 'd-201', turn: 8 }),
        relayEvent({ seq: 202, time: T0 + 1000, id: 'd-202', turn: 8 }),
        relayEvent({ seq: 203, time: T0 + 2000, id: 'd-203', turn: 8 }),
      ],
    }],
    lookup: rowsFor(rows),
  });
  t.after(() => env.dispose());

  await scanOnce(env, { label: 'receipt states' });
  assertGroups(env, {
    201: { head: true, count: 2 },
    202: { head: false, count: 2 },
    203: { head: true, count: 1 },
  }, 'accepted+received vs accepted+queued');
});

/* ── 3. unknown turn is not positive evidence of "same turn" ────────────── */

test('unknown turn never merges two received capsules', async (t) => {
  const rows = [
    ledgerRow({ id: 'd-301', turn: null, receiptState: 'received' }),
    ledgerRow({ id: 'd-302', turn: null, receiptState: 'received' }),
  ];
  const env = install({
    sessions: [{
      id: SESSION,
      // No turn/start and no data.turn in either event: the turn is unknown.
      entries: [
        relayEvent({ seq: 301, time: T0, id: 'd-301' }),
        relayEvent({ seq: 302, time: T0 + 1000, id: 'd-302' }),
      ],
    }],
    lookup: rowsFor(rows),
  });
  t.after(() => env.dispose());

  await scanOnce(env, { label: 'unknown turn' });
  assertGroups(env, {
    301: { head: true, count: 1 },
    302: { head: true, count: 1 },
  }, 'unknown turn');
});

/* ── 4. visible native fallback breaks a run ────────────────────────────── */

test('verified relay → unverified native-fallback relay → verified relay never joins across', async (t) => {
  const rows = [
    ledgerRow({ id: 'd-401', turn: 8 }),
    ledgerRow({ id: 'd-403', turn: 8 }),
  ];
  const env = install({
    sessions: [{
      id: SESSION,
      entries: [
        relayEvent({ seq: 401, time: T0, id: 'd-401', turn: 8 }),
        // Standard relay shape but absent from the owner ledger → native text.
        relayEvent({ seq: 402, time: T0 + 1000, id: 'd-402', turn: 8 }),
        relayEvent({ seq: 403, time: T0 + 2000, id: 'd-403', turn: 8 }),
      ],
    }],
    lookup: rowsFor(rows),
  });
  t.after(() => env.dispose());

  await scanOnce(env, { label: 'native fallback boundary' });
  assertGroups(env, {
    401: { head: true, count: 1 },
    403: { head: true, count: 1 },
  }, 'native-fallback relay is visible and breaks the run');
});

/* ── 5. controls / create remain visible boundaries ─────────────────────── */

test('ask_user_question, exit_plan_mode and session_link_create are visible boundaries', async (t) => {
  for (const tool of ['ask_user_question', 'exit_plan_mode', 'session_link_create']) {
    const rows = [
      ledgerRow({ id: 'd-501', turn: 8 }),
      ledgerRow({ id: 'd-503', turn: 8 }),
    ];
    const env = install({
      sessions: [{
        id: SESSION,
        entries: [
          relayEvent({ seq: 501, time: T0, id: 'd-501', turn: 8 }),
          toolCall({ seq: 502, time: T0 + 1000, name: tool, turn: 8 }),
          relayEvent({ seq: 503, time: T0 + 2000, id: 'd-503', turn: 8 }),
        ],
      }],
      lookup: rowsFor(rows),
    });
    try {
      await scanOnce(env, { label: `${tool} boundary` });
      assertGroups(env, {
        501: { head: true, count: 1 },
        503: { head: true, count: 1 },
      }, `${tool} is a visible boundary`);
    } finally {
      env.dispose();
    }
  }
});

/* ── 6. turn grouping positives and negatives ───────────────────────────── */

test('same turn ×3 groups; turns 8/9/10 stay separate', async (t) => {
  {
    const rows = [8, 8, 8].map((turn, index) => ledgerRow({ id: `d-60${index + 1}`, turn }));
    const env = install({
      sessions: [{
        id: SESSION,
        entries: rows.map((_, index) => relayEvent({
          seq: 601 + index,
          time: T0 + index * 1000,
          id: `d-60${index + 1}`,
          turn: 8,
        })),
      }],
      lookup: rowsFor(rows),
    });
    try {
      await scanOnce(env, { label: 'same turn' });
      assertGroups(env, {
        601: { head: true, count: 3 },
        602: { head: false, count: 3 },
        603: { head: false, count: 3 },
      }, 'same turn ×3');
    } finally {
      env.dispose();
    }
  }
  {
    const turns = [8, 9, 10];
    const rows = turns.map((turn, index) => ledgerRow({ id: `d-61${index + 1}`, turn }));
    const env = install({
      sessions: [{
        id: SESSION,
        entries: rows.map((_, index) => relayEvent({
          seq: 611 + index,
          time: T0 + index * 1000,
          id: `d-61${index + 1}`,
          turn: turns[index],
        })),
      }],
      lookup: rowsFor(rows),
    });
    try {
      await scanOnce(env, { label: 'different turns' });
      assertGroups(env, {
        611: { head: true, count: 1 },
        612: { head: true, count: 1 },
        613: { head: true, count: 1 },
      }, 'turns 8/9/10');
    } finally {
      env.dispose();
    }
  }
});

/* ── 7. stale and fresh evidence never share a capsule ──────────────────── */

test('stale and fresh received capsules do not merge', async (t) => {
  const originalWarn = console.warn;
  console.warn = () => {}; // one synthetic refresh failure is expected
  t.after(() => { console.warn = originalWarn; });

  const failIds = new Set();
  const rows = [
    ledgerRow({ id: 'd-701', turn: 8 }),
    ledgerRow({ id: 'd-702', turn: 8 }),
  ];
  const env = install({
    sessions: [{
      id: SESSION,
      entries: [relayEvent({ seq: 701, time: T0, id: 'd-701', turn: 8 })],
    }],
    lookup: (sessionId, ids) => {
      if (ids.some((id) => failIds.has(id))) throw new Error('synthetic transport failure');
      return rowsFor(rows)(sessionId, ids);
    },
    refreshIntervalMs: 0,
  });
  t.after(() => env.dispose());

  await scanOnce(env, { label: 'stale/fresh initial verification' });
  assert.deepEqual(groupInfo(env, 701), { head: true, count: 1 });

  // A newer same-key message arrives fresh; the older one's refresh fails.
  failIds.add('d-701');
  env.bindings.get(SESSION).eventSource.appendEvent(
    relayEvent({ seq: 702, time: T0 + 1000, id: 'd-702', turn: 8 }),
  );
  await scanOnce(env, { label: 'stale/fresh second pass' });

  assertGroups(env, {
    701: { head: true, count: 1 },
    702: { head: true, count: 1 },
  }, 'stale must not merge with fresh');
});

/* ── 8. fake sender identity / fork gate never hides a capsule ──────────── */

test('fake sender identity and fork-shared events break the run instead of hiding capsules', async (t) => {
  {
    // 8a: ledger identity (from) differs from the relay's claimed sender, so
    // the card gate falls back native; it must be a boundary, not an item.
    const rows = [
      ledgerRow({ id: 'd-801', from: PEER, turn: 8 }),
      ledgerRow({ id: 'd-802', from: 'sess-impostor', turn: 8 }),
      ledgerRow({ id: 'd-803', from: PEER, turn: 8 }),
    ];
    const env = install({
      sessions: [{
        id: SESSION,
        entries: [
          relayEvent({ seq: 801, time: T0, id: 'd-801', sender: PEER, turn: 8 }),
          // Same claimed sender as the real capsules, ledger says otherwise.
          relayEvent({ seq: 802, time: T0 + 1000, id: 'd-802', sender: PEER, turn: 8 }),
          relayEvent({ seq: 803, time: T0 + 2000, id: 'd-803', sender: PEER, turn: 8 }),
        ],
      }],
      lookup: rowsFor(rows),
    });
    try {
      await scanOnce(env, { label: 'fake sender identity' });
      assertGroups(env, {
        801: { head: true, count: 1 },
        803: { head: true, count: 1 },
      }, 'fake sender identity is a visible boundary');
    } finally {
      env.dispose();
    }
  }
  {
    // 8b: the SAME event object is observed in the target window and a fork.
    // The fork gate refuses the claim; the native copy is visible, so the
    // verified capsules on both sides must not be folded into one group.
    const shared = relayEvent({ seq: 812, time: T0 + 1000, id: 'd-812', sender: PEER, turn: 8 });
    const rows = [
      ledgerRow({ id: 'd-811', from: PEER, turn: 8 }),
      ledgerRow({ id: 'd-812', from: PEER, turn: 8 }),
      ledgerRow({ id: 'd-813', from: PEER, turn: 8 }),
    ];
    const env = install({
      sessions: [
        {
          id: SESSION,
          entries: [
            relayEvent({ seq: 811, time: T0, id: 'd-811', sender: PEER, turn: 8 }),
            shared,
            relayEvent({ seq: 813, time: T0 + 2000, id: 'd-813', sender: PEER, turn: 8 }),
          ],
        },
        { id: 'sess-fork', entries: [shared] },
      ],
      lookup: (sessionId, ids) => (sessionId === SESSION
        ? rowsFor(rows)(sessionId, ids)
        : { results: [], missing: ids.slice() }),
    });
    try {
      await scanOnce(env, { label: 'fork-shared event' });
      assertGroups(env, {
        811: { head: true, count: 1 },
        813: { head: true, count: 1 },
      }, 'fork gate is a visible boundary, not a hidden group member');
    } finally {
      env.dispose();
    }
  }
});

/* ── outgoing Definition: evidence.callSeq is durable seq/time ──────────── */

const SEND_ARGS = JSON.stringify({
  targets: [PEER],
  kind: 'notification',
  text: 'synthetic subject\nsynthetic body',
  operationId: 'op-synthetic',
  subject: 'synthetic subject',
});
const SEND_VALUE = {
  operationId: 'op-synthetic',
  idempotent: false,
  chainId: 'chain-synthetic',
  held: false,
  results: [{ target: PEER, id: 'msg-1', status: 'accepted', error: null }],
};
const SEND_ROW = {
  id: 'msg-1',
  durableMessageId: 'd-msg-1',
  from: 'sess-sender',
  fromTitle: 'Sender',
  to: PEER,
  toTitle: 'Peer',
  kind: 'notification',
  subject: 'synthetic subject',
  chainId: 'chain-synthetic',
  parentMessageId: null,
  status: 'accepted',
  replyStatus: 'none',
  receipt: { policy: 'context', state: 'received', receivedAt: T0, receivedSeq: 1 },
};

function mockVerifier(rows) {
  const fetchImpl = async (_url, init) => {
    const { ids } = JSON.parse(init.body).payload;
    const results = rows.filter((row) => ids.includes(row.id));
    const missing = ids.filter((id) => !results.some((row) => row.id === id));
    return { ok: true, status: 200, json: async () => ({ ok: true, value: { results, missing } }) };
  };
  return createCardVerifier({ fetchImpl });
}

test('outgoing Definition keeps the durable call seq/time in evidence after live-chunk → call → result', async () => {
  const LIVE_SEQ = 900;
  const LIVE_TIME = T0;
  const CALL_SEQ = 42;
  const CALL_TIME = T0 + 5000;
  const RESULT_SEQ = 43;
  const RESULT_TIME = T0 + 6000;

  const verifier = mockVerifier([SEND_ROW]);
  await verifier.verify('sess-sender', ['msg-1']);
  const definition = createSenderCardDefinition({
    windowScope: { resolveResult: () => 'sess-sender' },
    verifier,
  });

  const liveChunk = {
    type: 'assistant/live-chunk',
    seq: LIVE_SEQ,
    time: LIVE_TIME,
    data: {
      attemptId: 'attempt-1',
      turn: 1,
      step: 0,
      chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'session_link_send' },
    },
  };
  const callEvent = {
    type: 'tool/call',
    seq: CALL_SEQ,
    time: CALL_TIME,
    data: { callId: 'call-1', name: 'session_link_send', arguments: SEND_ARGS, turn: 1, step: 0 },
  };
  const resultEvent = {
    type: 'tool/result',
    seq: RESULT_SEQ,
    time: RESULT_TIME,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 0,
      message: {
        source: { callId: 'call-1' },
        content: [{ type: 'text', text: JSON.stringify(SEND_VALUE) }],
        isError: false,
      },
    },
  };

  const claim = definition.match(liveChunk);
  assert.ok(claim, 'live tool-call delta starts the real Definition');
  let state = definition.start(null, { event: liveChunk, ...claim });
  state = definition.update({ state }, { event: callEvent });
  state = definition.update({ state }, { event: resultEvent });

  const context = {
    state,
    current: { get: () => undefined },
    start: { event: liveChunk, location: { kind: 'step', turn: { turn: 1 }, step: { step: 0 } } },
    matches: [{ event: liveChunk }],
  };
  const node = definition.buildViewNode(context);
  assert.ok(node, 'verified durable result builds the card');
  assert.equal(node.data.evidence.callSeq, CALL_SEQ, 'evidence.callSeq must be the durable tool/call seq, not the live-chunk seq');
  assert.equal(node.data.time, CALL_TIME, 'card time must be the durable tool/call time, not the live-chunk time');
  assert.equal(node.data.evidence.resultSeq, RESULT_SEQ, 'result seq stays the durable result seq');
});
