import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { HOST_SHA256, patchHostFlowRc1 } from './dsh-web-flow-bridge-rc1.mjs';

const path = process.env.DSH_CHAT_RC1_CLIENT;
const host = path ? await readFile(path, 'utf8') : null;
const needsHost = { skip: !host && 'set DSH_CHAT_RC1_CLIENT to the exact rc.1 host client artifact' };

test('rc.1 bridge refuses unknown, partial, and already patched hosts', () => {
  for (const s of ['', 'not a host', 'const ChatFlow = (0, react.memo)(function ChatFlow({']) {
    assert.throws(() => patchHostFlowRc1(s), /Unsupported Web Chat artifact/);
  }
});

test('rc.1 bridge adds one scoped adapter with a native fallback', needsHost, () => {
  assert.equal(createHash('sha256').update(host).digest('hex'), HOST_SHA256);
  const candidate = patchHostFlowRc1(host);
  assert.doesNotThrow(() => new Function(candidate));
  assert.match(candidate, /function NativeChatFlow\(\{ slSuppressRunning = false,/);
  assert.match(candidate, /!slSuppressRunning && \(running \|\| holding\)/);
  assert.match(candidate, /key: group\.key, slFlowTurn: this\.turn/);
  assert.match(candidate, /"conversation\.chat\.flow\.adapter": \{ kind: "single", scope: "session" \}/);
  assert.match(candidate, /fallback: \(0, react\.createElement\)\(NativeChatFlow, props\)/);
  assert.match(candidate, /NativeFlowFallback/);
  assert.match(candidate, /react\.useSyncExternalStore\)\(slCardSubscribe, slCardSnapshot/);
  assert.match(candidate, /if \(card\) return \(0, react\.createElement\)\(NativeChatFlow, props\)/);
  assert.match(candidate, /attributeFilter: \['data-sl-card-mode'\]/);
  assert.match(candidate, /observer\.disconnect\(\)/);
  assert.match(candidate, /@scope \(\[data-slot=\\"conversation\.chat\.flow\.adapter\\"\]\)/);
  assert.equal(candidate.split('slFlowRows(elements.column).children').length - 1, 3);
  assert.throws(() => patchHostFlowRc1(candidate), /Unsupported Web Chat artifact/);
});
