import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPSULE_GROUP_WINDOW_MS, groupCapsules } from '../src/client/capsule-grouping.mjs';

const t = (hhmmss) => {
  const [h, m, s] = hhmmss.split(':').map(Number);
  return new Date(2026, 10, 10, h, m, s).getTime();
};
const received = (seq, time, extra = {}) => ({
  kind: 'received', seq, time: t(time), sender: 's-total', messageKind: 'notification', status: 'accepted', turn: 620, ...extra,
});
const sent = (seq, time) => ({ kind: 'sent', seq, time: t(time) });
const brk = () => ({ kind: 'break' });

test('the real REQ-6 sequence becomes 4 capsules: request, notification, sent, five notifications', () => {
  const groups = groupCapsules([
    received(1, '16:20:44', { messageKind: 'request' }),
    received(2, '16:21:18'),
    sent(3, '16:21:51'),
    received(4, '16:24:15'),
    received(5, '16:27:57'),
    received(6, '16:27:57'),
    received(7, '16:32:28'),
    received(8, '16:32:45'),
  ]);
  assert.deepEqual(groups.get(1), { head: true, count: 1 });
  assert.deepEqual(groups.get(2), { head: true, count: 1 });
  assert.deepEqual(groups.get(3), { head: true, count: 1 });
  assert.deepEqual(groups.get(4), { head: true, count: 5 });
  for (const seq of [5, 6, 7, 8]) assert.deepEqual(groups.get(seq), { head: false, count: 5 });
  const heads = [...groups.values()].filter(group => group.head).length;
  assert.equal(heads, 4);
});

test('same kind merges; request and notification never merge', () => {
  const groups = groupCapsules([
    received(1, '10:00:00', { messageKind: 'request' }),
    received(2, '10:00:30', { messageKind: 'notification' }),
    received(3, '10:01:00', { messageKind: 'notification' }),
  ]);
  assert.deepEqual(groups.get(1), { head: true, count: 1 });
  assert.deepEqual(groups.get(2), { head: true, count: 2 });
  assert.deepEqual(groups.get(3), { head: false, count: 2 });
});

test('a five-minute gap splits; exactly five minutes still merges', () => {
  const at = t('10:00:00');
  const groups = groupCapsules([
    received(1, '10:00:00'),
    { ...received(2, '10:05:00'), time: at + CAPSULE_GROUP_WINDOW_MS },
    { ...received(3, '10:10:01'), time: at + 2 * CAPSULE_GROUP_WINDOW_MS + 1 },
  ]);
  assert.deepEqual(groups.get(1), { head: true, count: 2 });
  assert.deepEqual(groups.get(2), { head: false, count: 2 });
  assert.deepEqual(groups.get(3), { head: true, count: 1 });
});

test('different sender, status or turn splits', () => {
  const groups = groupCapsules([
    received(1, '10:00:00'),
    received(2, '10:00:10', { sender: 's-other' }),
    received(3, '10:00:20', { status: 'pending' }),
    received(4, '10:00:30', { turn: 621 }),
  ]);
  for (const seq of [1, 2, 3, 4]) assert.deepEqual(groups.get(seq), { head: true, count: 1 });
});

test('visible text, human message and turn boundary break the run', () => {
  const groups = groupCapsules([
    received(1, '10:00:00'),
    brk(),
    received(2, '10:00:10'),
    brk(),
    received(3, '10:00:20'),
  ]);
  for (const seq of [1, 2, 3]) assert.deepEqual(groups.get(seq), { head: true, count: 1 });
});

test('sent capsules break a received run and are never merged', () => {
  const groups = groupCapsules([
    received(1, '10:00:00'),
    sent(2, '10:00:10'),
    sent(3, '10:00:20'),
    received(4, '10:00:30'),
  ]);
  assert.deepEqual(groups.get(1), { head: true, count: 1 });
  assert.deepEqual(groups.get(2), { head: true, count: 1 });
  assert.deepEqual(groups.get(3), { head: true, count: 1 });
  assert.deepEqual(groups.get(4), { head: true, count: 1 });
});
