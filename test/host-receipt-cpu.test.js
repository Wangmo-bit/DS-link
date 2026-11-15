import test from 'node:test'
import assert from 'node:assert/strict'

import { HostAdapter } from '../src/host/adapter.js'
import {
  FakeClock,
  MemoryAdapter,
  makeMockHost,
  openEngine,
  sessionFixture,
  tempRoot,
} from './helpers.js'

function manySessions(count) {
  return [
    sessionFixture({ id: 'A', title: 'Alpha' }),
    sessionFixture({ id: 'B', title: 'Beta' }),
    sessionFixture({ id: 'C', title: 'Gamma' }),
    ...Array.from({ length: count }, (_, index) => sessionFixture({ id: `cold-${index}`, title: `Cold ${index}` })),
  ]
}

test('real HostAdapter catch-up never folds titles or reads unrelated sessions for a missing target', async (t) => {
  const clock = new FakeClock()
  const host = makeMockHost({ clock, sessions: manySessions(300) })
  const adapter = new HostAdapter({
    ctx: host.ctx,
    createUserMessage: host.createUserMessage,
    clock: () => clock.read(),
    cacheMs: 0,
  })
  const root = await tempRoot()
  const { ledger, engine } = await openEngine({ root, adapter, clock })
  t.after(async () => {
    await engine.dispose()
    await ledger.close()
  })

  const sent = await engine.send({
    from: 'A',
    targets: ['B', 'C'],
    kind: 'request',
    text: 'real adapter receipt probe',
    operationId: engine.mintOperation().operationId,
  })
  assert.deepEqual(sent.results.map((entry) => entry.status), ['accepted', 'accepted'])
  await engine.drain()

  // Simulate one target disappearing after its accepted send: registry entry
  // and durable log are both gone, while C remains a readable pending target.
  const index = host.sessions.findIndex((session) => session.id === 'B')
  assert.ok(index >= 0)
  host.sessions.splice(index, 1)
  for (const workspace of host.workspaces) {
    workspace.sessionIds = workspace.sessionIds.filter((id) => id !== 'B')
  }

  const counts = { list: 0, titles: 0, read: [], surfaces: 0 }
  const query = host.ctx.sessionQuery
  const originalList = query.listSessions.bind(query)
  const originalTitles = query.readTitleSnapshots.bind(query)
  const originalRead = query.readSession.bind(query)
  const originalSurface = query.readSurface.bind(query)
  query.listSessions = async () => { counts.list += 1; return originalList() }
  query.readTitleSnapshots = async (ids) => { counts.titles += 1; return originalTitles(ids) }
  query.readSession = async (id) => { counts.read.push(id); return originalRead(id) }
  query.readSurface = async (id) => { counts.surfaces += 1; return originalSurface(id) }

  await engine.start()
  await engine.drain()
  assert.equal(counts.titles, 0, 'receipt catch-up must not fold titles')
  assert.deepEqual(counts.read, ['C'], 'only the readable target may be read')
  assert.equal(counts.surfaces, 0, 'receipt catch-up must not read surfaces')
  assert.ok(counts.list <= 1, 'one header-only list per batch')

  const b = ledger.read().messages.find((message) => message.to === 'B')
  const c = ledger.read().messages.find((message) => message.to === 'C')
  assert.equal(b.receipt.state, 'queued', 'missing target keeps its real receipt state')
  assert.equal(b.receipt.state === 'received', false)
  assert.equal(c.receipt.state, 'queued')

  clock.advance(15_000)
  await engine.tick()
  await engine.drain()
  assert.equal(counts.titles, 0)
  assert.deepEqual(counts.read, ['C'], 'missing target must not trigger readSession on retry')
  assert.ok(counts.list <= 1, 'missing-only retry does not list sessions')
})

test('an overlapping tick is skipped while the first is still running', async (t) => {
  const clock = new FakeClock()
  const adapter = new MemoryAdapter({
    clock,
    autoReceive: false,
    sessions: [sessionFixture({ id: 'A' }), sessionFixture({ id: 'B' })],
  })
  const root = await tempRoot()
  const { ledger, engine } = await openEngine({ root, adapter, clock })
  t.after(async () => {
    await engine.dispose()
    await ledger.close()
  })

  await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'slow retry',
    operationId: engine.mintOperation().operationId,
  })
  adapter.readReceiptsError = 'temporary'
  await engine.start()
  await engine.drain()
  clock.advance(15_000)

  const original = adapter.readTargetReceipts.bind(adapter)
  adapter.readTargetReceipts = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    return original(...args)
  }

  const first = engine.tick()
  const second = await engine.tick()
  assert.deepEqual(second, { skipped: true, reason: 'tick_in_progress' })
  await first
  await engine.drain()
})

test('backoff advances only on a real probe failure, not on ticks before nextAt', async (t) => {
  const clock = new FakeClock()
  const adapter = new MemoryAdapter({
    clock,
    autoReceive: false,
    sessions: [sessionFixture({ id: 'A' }), sessionFixture({ id: 'B' })],
  })
  const root = await tempRoot()
  const { ledger, engine } = await openEngine({ root, adapter, clock })
  t.after(async () => {
    await engine.dispose()
    await ledger.close()
  })

  await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'backoff probe',
    operationId: engine.mintOperation().operationId,
  })
  let reads = 0
  const original = adapter.readTargetReceipts.bind(adapter)
  adapter.readReceiptsError = 'temporary unreadable'
  adapter.readTargetReceipts = async (...args) => {
    reads += 1
    return original(...args)
  }
  await engine.start()
  await engine.drain()
  assert.equal(reads, 1)

  await engine.tick()
  assert.equal(reads, 1, 'not due yet: no read')

  clock.advance(15_000)
  await engine.tick()
  assert.equal(reads, 2, 'first backoff elapsed: one read')

  clock.advance(15_000)
  await engine.tick()
  assert.equal(reads, 2, 'second failure scheduled +30s: no read yet')

  clock.advance(30_000)
  await engine.tick()
  assert.equal(reads, 3, 'second backoff elapsed: one read')

  adapter.readReceiptsError = undefined
  clock.advance(60_000)
  await engine.tick()
  assert.equal(reads, 4)
  const b = ledger.read().messages.find((message) => message.to === 'B')
  assert.equal(b.receipt.state, 'queued')
})

test('a failed batch probe schedules each target once and never per-target re-probes', async (t) => {
  const clock = new FakeClock()
  const host = makeMockHost({ clock, sessions: manySessions(20) })
  const adapter = new HostAdapter({
    ctx: host.ctx,
    createUserMessage: host.createUserMessage,
    clock: () => clock.read(),
    cacheMs: 0,
  })
  const root = await tempRoot()
  const { ledger, engine } = await openEngine({ root, adapter, clock })
  t.after(async () => {
    await engine.dispose()
    await ledger.close()
  })
  await engine.send({
    from: 'A',
    targets: ['B', 'C'],
    kind: 'request',
    text: 'failed probe batch',
    operationId: engine.mintOperation().operationId,
  })
  let listCalls = 0
  let titleCalls = 0
  let readCalls = 0
  const query = host.ctx.sessionQuery
  const originalRead = query.readSession.bind(query)
  query.listSessions = async () => { listCalls += 1; throw new Error('temporary list failure') }
  query.readTitleSnapshots = async () => { titleCalls += 1; return [] }
  query.readSession = async (id) => { readCalls += 1; return originalRead(id) }

  await engine.start()
  await engine.drain()
  assert.equal(listCalls, 1, 'one failed batch probe')
  assert.equal(readCalls, 0, 'failed probe must not fall through to per-target read/probe')
  assert.equal(titleCalls, 0)

  clock.advance(15_000)
  await engine.tick()
  await engine.drain()
  assert.equal(listCalls, 2, 'next due tick probes once more')
  assert.equal(readCalls, 0)
  assert.equal(titleCalls, 0)
})

test('a read already in flight keeps later un-received ids for the next controlled read', async (t) => {
  const clock = new FakeClock()
  const adapter = new MemoryAdapter({
    clock,
    autoReceive: false,
    sessions: [sessionFixture({ id: 'A' }), sessionFixture({ id: 'B' })],
  })
  const root = await tempRoot()
  const { ledger, engine } = await openEngine({ root, adapter, clock })
  t.after(async () => {
    await engine.dispose()
    await ledger.close()
  })

  await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'first in flight',
    operationId: engine.mintOperation().operationId,
  })

  let release
  const gate = new Promise((resolve) => { release = resolve })
  let reads = 0
  const original = adapter.readTargetReceipts.bind(adapter)
  adapter.readTargetReceipts = async (...args) => {
    reads += 1
    if (reads === 1) await gate
    return original(...args)
  }

  const starting = engine.start()
  while (reads === 0) await new Promise((resolve) => setImmediate(resolve))
  await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'later while first read is in flight',
    operationId: engine.mintOperation().operationId,
  })
  release()
  await starting
  await engine.drain()
  assert.equal(reads, 1)

  await engine.tick()
  await engine.drain()
  assert.equal(reads, 2, 'later ids must trigger a controlled follow-up read')

  const later = ledger.read().messages.filter((message) => message.to === 'B')
  assert.equal(later.length, 2)
  assert.equal(later.some((message) => message.receipt.state === 'received'), false)
})
