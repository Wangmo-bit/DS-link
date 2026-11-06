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

test('incoming body is read once despite rebuilt window-proof closures', async () => {
  let reads = 0, signal;
  const view = harness(createSessionLinkCardView({ fetchCardBody: async request => { reads++; signal = request.signal; return { phase: 'available', body: 'canonical body' }; } }));
  view.render(node(() => true));
  await tick();
  for (let index = 0; index < 100; index++) view.render(node(() => true));
  assert.equal(reads, 1);
  assert.equal(signal.aborted, false);
  view.dispose();
  assert.equal(signal.aborted, true);
});

test('in-flight incoming body validates the newest scope proof, not a captured old one', async () => {
  let complete;
  const view = harness(createSessionLinkCardView({ fetchCardBody: () => new Promise(resolve => { complete = resolve; }) }));
  view.render(node(() => true));
  view.render(node(() => false));
  complete({ phase: 'available', body: 'must not be exposed' });
  await tick();
  const tree = view.render(node(() => false));
  const bubble = tree.props.children[1];
  assert.equal(bubble.props.text, undefined);
  view.dispose();
});
