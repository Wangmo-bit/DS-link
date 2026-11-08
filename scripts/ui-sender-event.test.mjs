import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { build } from 'esbuild';
const result = await build({ entryPoints:['src/client/outgoing-cards.jsx'],bundle:true,write:false,format:'cjs',platform:'browser',external:['react','@deepseek-ai/*'],logLevel:'silent' });
const module={exports:{}};
new Function('require','module','exports',result.outputFiles[0].text)(name => name === 'react' ? React : {MarkdownText:()=>null},module,module.exports);
const render = module.exports.createSenderCardView();
const { receiverHint } = await import('../src/client/delivery-indicator.mjs');
function text(value) {
  if (value == null || typeof value === 'boolean') return '';
  if (Array.isArray(value)) return value.map(text).join('');
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return text(value.props?.children);
}
function roles(value) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(roles);
  return [...(value.props?.role ? [value.props.role] : []), ...roles(value.props?.children)];
}
function view(targetStatus) {
  const ref=React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher, previous=ref.current;
  ref.current={useSyncExternalStore:(_subscribe,get)=>get(),useState:value=>[value,()=>{}]};
  try { return render({node:{data:{callId:'call',from:'A',fromDisplay:'甲',to:['B','C'],toDisplay:['乙','丙'],status:'多目标状态',targetStatus}}}); }
  finally { ref.current=previous; }
}
test('successful delivery is a compact link without duplicate status or refresh', () => {
  const tree=view([{target:'B',label:'已进入上下文',asOf:1},{target:'C',label:'明确回复',asOf:1}]);
  assert.match(text(tree),/已发消息给 乙/);
  assert.match(text(tree),/已发消息给 丙/);
  assert.doesNotMatch(text(tree),/已进入上下文|明确回复|↻/);
  assert.equal(roles(tree).filter(role=>role==='status').length,2);
});
test('a failed, uncertain or stale destination still has a visible status', () => {
  const tree=view([{target:'B',label:'需核对',asOf:1},{target:'C',label:'已进入上下文',asOf:null}]);
  assert.equal(module.exports.senderIndicator('需核对').kind,'warning');
  assert.equal(module.exports.senderIndicator('失败').kind,'failed');
  assert.equal(module.exports.senderIndicator('已取消').kind,'failed');
  assert.equal(module.exports.senderIndicator('宿主已接收·进入上下文未确认').kind,'warning');
  // User decision 2026-11-08: the check means the other Host confirmed receiving.
  assert.deepEqual(module.exports.senderIndicator('宿主已接收·待进入上下文'),{kind:'received',title:'对方宿主已确认收到，尚未确认进入上下文'});
  assert.deepEqual(module.exports.senderIndicator('已进入上下文'),{kind:'received',title:'对方宿主已接收，已进入对方上下文'});
  assert.equal(receiverHint('已进入上下文'),null,'received capsules never carry a check');
  assert.equal(receiverHint('明确回复'),null);
  assert.deepEqual(receiverHint('宿主已接收·待进入上下文'),{kind:'pending',title:'已收到，等待进入上下文'});
  assert.equal(module.exports.senderIndicator('已进入上下文 · 等待回复超时').kind,'warning');
  assert.equal(roles(tree).filter(role=>role==='status').length,2);
});
