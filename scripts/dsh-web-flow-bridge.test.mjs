import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { HOST_SHA256, patchHostFlow } from './dsh-web-flow-bridge.mjs';
const input = process.env.DSH_CHAT_FLOW_CLIENT;
const original = input ? await readFile(input,'utf8') : null;

test('flow bridge rejects unsupported Host artifacts', () => {
  assert.throws(()=>patchHostFlow('unexpected Host artifact'),/Unsupported/);
});
test('flow bridge preserves native Host contracts and previous scroll patch', {skip: !original && 'set DSH_CHAT_FLOW_CLIENT to the installed rc.5 Host artifact'}, () => {
  assert.equal(createHash('sha256').update(original).digest('hex'),HOST_SHA256);
  const patched=patchHostFlow(original);
  assert.equal((patched.match(/const ChatFlow = \(0, react\.memo\)/g)??[]).length,1);
  assert.match(patched,/const NativeChatFlow = \(0, react\.memo\)/);
  assert.match(patched,/slFlowTurn: this\.turn/);
  assert.match(patched,/slSuppressRunning \? false : snapshot\.running/);
  assert.match(patched,/conversation\.chat\.flow\.adapter/);
  assert.match(patched,/fallback: \(0, react\.createElement\)\(NativeChatFlow, props\)/);
  assert.match(patched,/name: "conversation\.chat\.flow\.adapter", priority: 100/,'Host keeps an independently registered native fallback after adapter failure');
  assert.match(patched,/slFlowRows\(elements\.column\)\.children/g,'native scroll owner sees adapter direct rows');
  assert.doesNotMatch(patched,/globalThis\[Symbol\.for\('@wangmo\/dsh-session-link:chat-flow/);
  assert.match(patched,/submissionRoom/,'prior scroll fix remains intact');
});
