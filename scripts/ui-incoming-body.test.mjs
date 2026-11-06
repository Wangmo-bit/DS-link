import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import React from 'react';

const output = await build({ entryPoints: ['src/client/incoming-cards.jsx'], bundle: true, write: false, format: 'cjs', platform: 'browser', external: ['react', '@deepseek-ai/*'], logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', output.outputFiles[0].text)(name => name === 'react' ? React : { MarkdownText: () => null }, module, module.exports);
const { createSessionLinkCardView } = module.exports;

function harness(Component) {
  const slots = [];
  let cursor = 0;
  const pending = [];
  const dispatcher = {
    useState(initial) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = initial;
      return [slots[at], value => { slots[at] = typeof value === 'function' ? value(slots[at]) : value; }];
    },
    useRef(initial) { const at = cursor++; return slots[at] ??= { current: initial }; },
    useSyncExternalStore(_subscribe, getSnapshot) { cursor++; return getSnapshot(); },
    useEffect(callback, deps) {
      const at = cursor++;
      const previous = slots[at];
      if (previous && deps.every((value, index) => Object.is(value, previous.deps[index]))) return;
      previous?.cleanup?.();
      slots[at] = { deps };
      pending.push(() => { slots[at].cleanup = callback(); });
    },
  };
  return {
    render(node) {
      cursor = 0;
      const ref = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
      const prior = ref.current;
      ref.current = dispatcher;
      try { return Component({ node }); } finally { ref.current = prior; for (const effect of pending.splice(0)) effect(); }
    },
    dispose() { for (const slot of slots) slot?.cleanup?.(); },
  };
}
const node = proof => ({ data: { row: { to: 'B', from: 'A' }, durableMessageId: 'durable-1', senderSessionId: 'A', isWindowCurrent: proof } });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
/** Run one test with a fixed stored display mode. */
function withMode(mode, body) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => mode } });
  return Promise.resolve()
    .then(body)
    .finally(() => { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else delete globalThis.localStorage; });
}
/** The notice capsule a received message renders in bubble mode. */
function noticeOf(tree) {
  assert.equal(tree.props['data-session-link-notice'], '');
  // children may be a single element when the status marker is absent.
  const children = tree.props.children;
  return Array.isArray(children) ? children[0] : children;
}
const labelText = value => value == null || typeof value === 'boolean' ? ''
  : typeof value === 'string' || typeof value === 'number' ? String(value)
  : Array.isArray(value) ? value.map(labelText).join('')
  : labelText(value.props?.children);

test('bubble mode never reads the incoming body: the timeline only carries the capsule', async () => {
  await withMode('bubble', async () => {
    let reads = 0;
    const view = harness(createSessionLinkCardView({ fetchCardBody: async () => { reads++; return { phase: 'available', body: 'canonical body' }; } }));
    const tree = view.render(node(() => true));
    await tick();
    for (let index = 0; index < 20; index++) view.render(node(() => true));
    await tick();
    assert.equal(reads, 0, 'bubble mode must not fetch a body it will not show');
    const link = noticeOf(tree);
    assert.ok(link, 'capsule must render so the reader knows a message arrived');
    view.dispose();
  });
});

test('bubble mode capsule names the sender and opens the exchange dialog on click', async () => {
  await withMode('bubble', async () => {
    const view = harness(createSessionLinkCardView({ fetchCardBody: async () => ({ phase: 'available', body: 'x' }) }));
    const tree = view.render(node(() => true));
    const link = noticeOf(tree);
    // The capsule is the only thing the timeline shows; its label is split by JSX
    // into the static prefix, the sender name and an optional status marker.
    const label = labelText(link.props.children);
    assert.match(label, /收到消息，来自 发送会话/);
    assert.equal(typeof link.type, 'function', 'clicking the capsule is what opens the dialog');
    view.dispose();
  });
});

test('card mode still reads the body once, only after the card is expanded', async () => {
  await withMode('card', async () => {
    let reads = 0, signal;
    const view = harness(createSessionLinkCardView({ fetchCardBody: async request => { reads++; signal = request.signal; return { phase: 'available', body: 'canonical body' }; } }));
    view.render(node(() => true));
    await tick();
    assert.equal(reads, 0, 'a collapsed card must not read the body');
    // Expanding sets cardOpen, which is what gates the read.
    const tree = view.render(node(() => true));
    const toggle = tree.props.onToggle ?? tree.props.children?.[0]?.props?.onToggle;
    assert.equal(typeof toggle, 'function', 'the card exposes an expand toggle');
    toggle();
    view.render(node(() => true));
    await tick();
    assert.equal(reads, 1);
    assert.equal(signal.aborted, false);
    view.dispose();
    assert.equal(signal.aborted, true);
  });
});

test('card mode in-flight body validates the newest scope proof, not a captured old one', async () => {
  await withMode('card', async () => {
    let complete;
    const view = harness(createSessionLinkCardView({ fetchCardBody: () => new Promise(resolve => { complete = resolve; }) }));
    // Expand first: a collapsed card never reads the body.
    view.render(node(() => true)).props.onToggle();
    view.render(node(() => true));            // starts the read while the proof holds
    assert.equal(typeof complete, 'function', 'the expanded card starts one read');
    view.render(node(() => false));           // the event left this window before it resolved
    complete({ phase: 'available', body: 'must not be exposed' });
    await tick();
    const layout = view.render(node(() => false));
    // The stale proof downgrades the body instead of exposing it.
    assert.equal(layout.props.body.phase, 'unavailable');
    view.dispose();
  });
});
