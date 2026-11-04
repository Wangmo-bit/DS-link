import test from 'node:test'
import assert from 'node:assert/strict'

import { FakeClock, MemoryAdapter, openEngine, tempRoot } from './helpers.js'

async function setup(t, sessions) {
  const clock = new FakeClock()
  const root = await tempRoot()
  const adapter = new MemoryAdapter({ clock, sessions })
  const { ledger, engine } = await openEngine({ root, adapter, clock })
  t.after(async () => {
    await engine.dispose()
    await ledger.close()
  })
  return { clock, adapter, ledger, engine }
}

const THREE = [
  { id: 'A', title: 'Alpha', eligible: true, registered: true, archived: false, subagent: false },
  { id: 'B', title: 'Beta', eligible: true, registered: true, archived: false, subagent: false },
  { id: 'C', title: 'Gamma', eligible: true, registered: true, archived: false, subagent: false },
]

test('reusing an operationId with the same call returns the original statuses without resending', async (t) => {
  const { clock, adapter, engine } = await setup(t, THREE)
  const operationId = engine.mintOperation().operationId
  const first = await engine.send({
    from: 'A',
    targets: ['B', 'C'],
    kind: 'notification',
    text: 'same call',
    operationId,
  })
  assert.equal(adapter.deliveries.length, 2)
  clock.advance(1001)
  const retry = await engine.send({
    from: 'A',
    targets: ['C', 'B'],
    kind: 'notification',
    text: 'same call',
    operationId,
  })
  assert.equal(retry.idempotent, true)
  assert.deepEqual(
    retry.results.map((entry) => [entry.target, entry.status]),
    first.results.map((entry) => [entry.target, entry.status]),
  )
  assert.equal(adapter.deliveries.length, 2, 'idempotent retry must not deliver again')
})

test('reusing an operationId with different content, targets, or parent is a conflict', async (t) => {
  const { adapter, engine } = await setup(t, THREE)
  const operationId = engine.mintOperation().operationId
  await engine.send({ from: 'A', targets: ['B'], kind: 'notification', text: 'one', operationId })
  await assert.rejects(
    engine.send({ from: 'A', targets: ['B'], kind: 'notification', text: 'two', operationId }),
    (error) => error.code === 'conflict_operation',
  )
  await assert.rejects(
    engine.send({ from: 'A', targets: ['C'], kind: 'notification', text: 'one', operationId }),
    (error) => error.code === 'conflict_operation',
  )
  await assert.rejects(
    engine.send({ from: 'A', targets: ['B'], kind: 'request', text: 'one', operationId }),
    (error) => error.code === 'conflict_operation',
  )
  assert.equal(adapter.deliveries.length, 1)
})

test('an unused operationId older than 24 hours is rejected, but an existing one still dedupes', async (t) => {
  const { clock, engine } = await setup(t)
  const expired = engine.mintOperation().operationId
  const sent = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'existing',
    operationId: engine.mintOperation().operationId,
  })
  clock.advance(24 * 60 * 60 * 1000 + 1)
  await assert.rejects(
    engine.send({ from: 'A', targets: ['B'], kind: 'notification', text: 'new', operationId: expired }),
    (error) => error.code === 'operation_expired',
  )
  const retry = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'existing',
    operationId: sent.operationId,
  })
  assert.equal(retry.idempotent, true)
  assert.equal(retry.results[0].status, 'accepted')
})

test('operation tombstones expire after 90 days and old ids never revive', async (t) => {
  const { clock, engine, ledger } = await setup(t)
  const operationId = engine.mintOperation().operationId
  const sent = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'tombstone',
    operationId,
  })
  assert.equal(sent.results[0].status, 'accepted')
  clock.advance(91 * 24 * 60 * 60 * 1000)
  await engine.tick()
  assert.equal(Object.keys(ledger.read().operations).length, 0)
  await assert.rejects(
    engine.send({ from: 'A', targets: ['B'], kind: 'notification', text: 'tombstone', operationId }),
    (error) => error.code === 'operation_expired',
  )
})

test('partial target failure preserves per-target status and is not resent on retry', async (t) => {
  const { adapter, engine } = await setup(t, THREE)
  adapter.beforeResolveHook = async (request) => {
    if (request.targetId !== 'B') return
    const target = adapter.sessions.find((session) => session.id === 'C')
    target.archived = true
    target.eligible = false
  }
  const operationId = engine.mintOperation().operationId
  const result = await engine.send({
    from: 'A',
    targets: ['B', 'C'],
    kind: 'notification',
    text: 'partial',
    operationId,
  })
  const byTarget = new Map(result.results.map((entry) => [entry.target, entry.status]))
  assert.equal(byTarget.get('B'), 'accepted')
  assert.equal(byTarget.get('C'), 'failed')
  assert.equal(adapter.deliveries.length, 2)

  const retry = await engine.send({
    from: 'A',
    targets: ['B', 'C'],
    kind: 'notification',
    text: 'partial',
    operationId,
  })
  assert.equal(retry.idempotent, true)
  assert.deepEqual(
    retry.results.map((entry) => [entry.target, entry.status]),
    [
      ['B', 'accepted'],
      ['C', 'failed'],
    ],
  )
  assert.equal(adapter.deliveries.length, 2, 'failed target was not silently retried')
})
