import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeAmbiguousCurrencyMath as display, currencySafeAssistantNode } from '../src/client/currency-markdown.mjs';

test('amounts separated by prose are not swallowed as one formula', () => {
  const raw = '你的 $60 是 **额度**，不是“无限”。估计 $0.30/M。';
  assert.equal(display(raw), '你的 \\$60 是 **额度**，不是“无限”。估计 $0.30/M。');
  assert.equal(raw, '你的 $60 是 **额度**，不是“无限”。估计 $0.30/M。');
  assert.equal(display('Prices: $5 and $10 and $20.'), 'Prices: \\$5 and \\$10 and $20.');
  assert.equal(display('金额 $5、$10'), '金额 \\$5、$10');
});

test('math, code, link destinations, escaped dollars and fences stay untouched', () => {
  const cases = [
    '$2 + 3$ and $x_1 + x_2$', '$5$', '$5 + 10$', '$\\alpha + \\beta$',
    '$2$3 是 $5', '$42$5 and $10',
    '$$x = 5 + 10$$', '\\( $5 and $10 \\)', '\\[ $5 and $10 \\]',
    '`$5 and $10`', '`` `$5 and $10` ``', '    $5 and $10',
    '```txt\n$5 and $10\n```', '~~~md\n$5 and $10\n~~~',
    '> ```txt\n> $5 and $10\n> ```', '- ```txt\n  $5 and $10\n  ```',
    '<code>$5 and $10</code>', '<pre>\n$5 and $10\n</pre>', '<!-- $5 and $10 -->',
    '[example](https://example.test/$5-and-$10)', '<https://example.test/$5-and-$10>',
    '\\$5 and \\$10', '$5\n\n$10',
  ];
  for (const source of cases) assert.equal(display(source), source, source);
});

test('long malformed Markdown fails safe without quadratic rescans', () => {
  const source = '<'.repeat(100_000) + '\n' + '<'.repeat(100_000) + ' $1';
  assert.equal(display(source), source);
  const links = ']('.repeat(30_000) + ' $5 and $10';
  assert.equal(display(links), links);
  const unclosedCode = '金额 $5 and $10 `unfinished';
  assert.equal(display(unclosedCode), unclosedCode);
});

test('the native-flow view transforms only settled assistant text without mutating the node', () => {
  const raw = '你的 $60 是 **额度**，估计 $0.30。';
  const node = { key:'node-1', kind:'assistant-step', data: { status:'settled', blocks:[{ kind:'text', text:raw }, { kind:'image', attachment:{ id:'a' } }] }, location:{ turn:1 } };
  const result = currencySafeAssistantNode(node);
  assert.notEqual(result, node);
  assert.equal(result.key, node.key);
  assert.equal(result.location, node.location);
  assert.equal(result.data.blocks[0].text, '你的 \\$60 是 **额度**，估计 $0.30。');
  assert.equal(result.data.blocks[1], node.data.blocks[1]);
  assert.equal(node.data.blocks[0].text, raw);
  const streaming = { ...node, data:{ ...node.data, status:'running' } };
  assert.equal(currencySafeAssistantNode(streaming), streaming);
  const other = { ...node, kind:'turn-tail' };
  assert.equal(currencySafeAssistantNode(other), other);
});

test('does not erase real math adjacent to currency prose', () => {
  const source = 'Formula $2+3$; amounts $5 and $10. Next $x+y$.';
  assert.equal(display(source), 'Formula $2+3$; amounts \\$5 and \\$10. Next $x+y$.');
  assert.equal(display('价格 $5，公式 $x^2$'), '价格 \\$5，公式 $x^2$');
  assert.equal(display(null), null);
  assert.equal(display('plain text'), 'plain text');
});
