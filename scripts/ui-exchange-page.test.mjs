import test from 'node:test';
import assert from 'node:assert/strict';
import { createExchangePager, readExchangePage } from '../src/client/exchange-page.mjs';

function rows(from, to, stamps) { return stamps.map((createdAt, index) => ({ id: `${from}-${index}`, from, to, createdAt })); }
function fixture(a, b) {
  let revision = 1;
  const calls = [];
  const data = { 'A-B': a, 'B-A': b };
  return {
    calls,
    setRevision(value) { revision = value; },
    read: async ({ from, to, offset, limit }) => {
      calls.push({ from, to, offset, limit });
      const records = data[`${from}-${to}`] ?? [];
      return { revision, messages: records.slice(offset, offset + limit), hasMore: offset + limit < records.length };
    },
  };
}

test('first view shows 20 newest combined, not 20 per direction', async () => {
  const f = fixture(rows('A', 'B', [20,18,16,14,12,10,8,6,4,2,0]), rows('B', 'A', [19,17,15,13,11,9,7,5,3,1]));
  const page = await readExchangePage(createExchangePager('A','B'), f.read);
  assert.deepEqual(page.messages.map(row => row.createdAt), Array.from({length:20}, (_, i) => i+1));
  assert.equal(page.hasMore, true);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.offset === 0 && call.limit === 20));
});

test('unbalanced directions paginate without dropping or duplicating rows', async () => {
  const f = fixture(rows('A','B', Array.from({length: 37}, (_, i) => 100 - i)), rows('B','A', [4,3]));
  let pager = createExchangePager('A','B'), more = true;
  const pages = [];
  while (more) { const page = await readExchangePage(pager, f.read); pages.push(page.messages); pager = page.pager; more = page.hasMore; }
  assert.deepEqual(pages.map(page => page.length), [20,19]);
  const all = pages.flat().map(row => row.id);
  assert.equal(all.length, 39); assert.equal(new Set(all).size, 39);
  assert.ok(f.calls.every(call => call.limit === 20));
});

test('ties follow snapshot id ordering and self-pair is fetched once', async () => {
  const f = fixture([{ id:'b', createdAt:3 }, {id:'c',createdAt:3}], [{id:'a',createdAt:3}]);
  const page = await readExchangePage(createExchangePager('A','B'), f.read);
  assert.deepEqual(page.messages.map(row => row.id), ['c','b','a']);
  const calls = [];
  await readExchangePage(createExchangePager('A','A'), async request => { calls.push(request); return {revision: 1, messages: [], hasMore:false}; });
  assert.equal(calls.length, 1);
});

test('revision change fails closed without mutating the last committed cursor', async () => {
  const f = fixture(rows('A','B',Array.from({length:25}, (_, i) => 100-i)), []);
  const first = await readExchangePage(createExchangePager('A','B'), f.read);
  const prior = JSON.stringify(first.pager);
  f.setRevision(2);
  await assert.rejects(readExchangePage(first.pager, f.read), error => error.code === 'exchange_changed');
  assert.equal(JSON.stringify(first.pager), prior);
});

test('reject inconsistent pages and aborts instead of spinning', async () => {
  await assert.rejects(readExchangePage(createExchangePager('A','B'), async () => ({revision:1,messages:[],hasMore:true})), /invalid_snapshot/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readExchangePage(createExchangePager('A','B'), async () => ({revision:1,messages:[],hasMore:false}), {signal:controller.signal}), {name:'AbortError'});
});
