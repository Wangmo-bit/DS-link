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
    ...Array.from({ length: count }, (_, index) => sessionFixture({ id: `cold-${index}`, title: `Cold ${index}`, live: false, agentStatus: 'cold' })),
  ]
}

test('real HostAdapter catch-up never folds titles or reads unrelated sessions for a missing target', async (t) => {
  const clock = new FakeClock()
  const host = makeMockHost({ clock, sessions: manySessions(300) })
  for (const session of host.sessions) {
    if (session.id.startsWith('cold-')) host.agents.delete(session.id)
  }
  assert.equal(host.agents.has('cold-0'), false, 'cold fixture has no live agent instance')
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
    const result = await original(...args)
    if (reads === 1) await gate
    return result
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


test('a stale read cannot swallow a same-id wake that failed its live flush', async (t) => {
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
    text: 'same-id wake',
    operationId: engine.mintOperation().operationId,
  })
  adapter.receiptFlushResult = false

  let release
  const gate = new Promise((resolve) => { release = resolve })
  let reads = 0
  const original = adapter.readTargetReceipts.bind(adapter)
  adapter.readTargetReceipts = async (...args) => {
    reads += 1
    const result = await original(...args)
    if (reads === 1) await gate
    return result
  }

  const starting = engine.start()
  while (reads === 0) await new Promise((resolve) => setImmediate(resolve))
  const message = ledger.read().messages.find((entry) => entry.to === 'B')
  await adapter.emitReceiptEvent({
    kind: 'message',
    sessionId: 'B',
    messageId: message.durableMessageId,
    senderSessionId: 'A',
    source: { kind: 'agent-message', form: 'relay', senderSessionId: 'A' },
    seq: 1,
    time: clock.read(),
  })
  release()
  await starting
  await engine.drain()
  assert.equal(reads, 1)

  await engine.tick()
  await engine.drain()
  assert.equal(reads, 2, 'same-id wake must schedule a controlled re-read')
  assert.equal(ledger.read().messages.find((entry) => entry.to === 'B').receipt.state, 'queued')
})

test('an old in-flight failure cannot overwrite a newer same-id wake', async (t) => {
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
    text: 'old failure wake',
    operationId: engine.mintOperation().operationId,
  })

  let release
  const gate = new Promise((resolve) => { release = resolve })
  let reads = 0
  const original = adapter.readTargetReceipts.bind(adapter)
  adapter.readReceiptsError = 'probe_failed'
  adapter.readTargetReceipts = async (...args) => {
    reads += 1
    if (reads === 4) {
      await gate
      return { readable: false, errorCode: 'probe_failed' }
    }
    return original(...args)
  }

  await engine.start()
  await engine.drain()
  assert.equal(reads, 1)
  clock.advance(15_000)
  await engine.tick()
  assert.equal(reads, 2)
  clock.advance(30_000)
  await engine.tick()
  assert.equal(reads, 3)
  clock.advance(60_000)

  // Fourth read is blocked on an old probe_failed result. A qualified live
  // event arrives and fails its flush, which must wake this target.
  const fourth = engine.tick()
  while (reads < 4) await new Promise((resolve) => setImmediate(resolve))
  const message = ledger.read().messages.find((entry) => entry.to === 'B')
  adapter.receiptFlushResult = false
  await adapter.emitReceiptEvent({
    kind: 'message',
    sessionId: 'B',
    messageId: message.durableMessageId,
    senderSessionId: 'A',
    source: { kind: 'agent-message', form: 'relay', senderSessionId: 'A' },
    seq: 1,
    time: clock.read(),
  })
  adapter.readReceiptsError = undefined
  release()
  await fourth
  await engine.drain()

  await engine.tick()
  await engine.drain()
  assert.equal(reads, 5, 'the wake must make the target due immediately, not after the old 60s backoff')
})

test('waking an overdue target keeps its original due position in a 17-target batch', async (t) => {
  const clock = new FakeClock()
  const targets = Array.from({ length: 17 }, (_, index) => `T${index}`)
  const adapter = new MemoryAdapter({
    clock,
    autoReceive: false,
    sessions: [sessionFixture({ id: 'A' }), ...targets.map((id) => sessionFixture({ id }))],
  })
  const root = await tempRoot()
  const { ledger, engine } = await openEngine({ root, adapter, clock })
  t.after(async () => {
    await engine.dispose()
    await ledger.close()
  })

  await engine.send({
    from: 'A',
    targets,
    kind: 'notification',
    text: 'seventeen targets',
    operationId: engine.mintOperation().operationId,
  })
  adapter.readReceiptsError = 'probe_failed'
  await engine.start()
  await engine.drain()
  clock.advance(15_001)

  // Wake the oldest target only after it is already overdue. Its original
  // nextAt must be preserved, otherwise the 16-slot batch can freeze it out.
  await engine.send({
    from: 'A',
    targets: ['T0'],
    kind: 'notification',
    text: 'wake overdue T0',
    operationId: engine.mintOperation().operationId,
  })
  adapter.readReceiptsError = undefined
  const order = []
  const original = adapter.readTargetReceipts.bind(adapter)
  adapter.readTargetReceipts = async (targetId, ...args) => {
    order.push(targetId)
    return original(targetId, ...args)
  }
  await engine.tick()
  await engine.drain()
  assert.equal(order.length, 16)
  assert.equal(order.includes('T0'), true, 'the overdue target must not be pushed out by the wake')
})

test('real HostAdapter live flush failure is retried as transient without reading the target log', async (t) => {
  const clock = new FakeClock()
  const host = makeMockHost({
    clock,
    sessions: [sessionFixture({ id: 'A' }), sessionFixture({ id: 'B' })],
  })
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
    targets: ['B'],
    kind: 'request',
    text: 'live flush failure',
    operationId: engine.mintOperation().operationId,
  })

  let reads = 0
  const originalRead = host.ctx.sessionQuery.readSession.bind(host.ctx.sessionQuery)
  host.ctx.sessionQuery.readSession = async (id) => { reads += 1; return originalRead(id) }
  const originalFlush = host.ctx.sessions.flush.bind(host.ctx.sessions)
  host.ctx.sessions.flush = async () => false

  await engine.start()
  await engine.drain()
  assert.equal(reads, 0, 'flush_failed must return before readSession')
  let message = ledger.read().messages.find((entry) => entry.to === 'B')
  assert.equal(message.receipt.state, 'queued')

  host.ctx.sessions.flush = originalFlush
  clock.advance(15_000)
  await engine.tick()
  await engine.drain()
  assert.equal(reads, 1, 'transient flush failure leaves a retry that reads after backoff')
  message = ledger.read().messages.find((entry) => entry.to === 'B')
  assert.equal(message.receipt.state, 'queued')
})

test('a qualified wake during the batch header probe survives the probe failure', async (t) => {
  const clock = new FakeClock()
  const host = makeMockHost({
    clock,
    sessions: [sessionFixture({ id: 'A' }), sessionFixture({ id: 'B' })],
  })
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
    targets: ['B'],
    kind: 'request',
    text: 'wake during probe',
    operationId: engine.mintOperation().operationId,
  })

  let release
  const gate = new Promise((resolve) => { release = resolve })
  let listCalls = 0
  const query = host.ctx.sessionQuery
  const originalList = query.listSessions.bind(query)
  query.listSessions = async () => {
    listCalls += 1
    if (listCalls === 1) {
      await gate
      throw new Error('old header probe failure')
    }
    return originalList()
  }
  const originalFlush = host.ctx.sessions.flush.bind(host.ctx.sessions)
  host.ctx.sessions.flush = async () => false
  let reads = 0
  const originalRead = query.readSession.bind(query)
  query.readSession = async (id) => { reads += 1; return originalRead(id) }

  const starting = engine.start()
  while (listCalls === 0) await new Promise((resolve) => setImmediate(resolve))
  const message = ledger.read().messages.find((entry) => entry.to === 'B')
  host.emitEvent('B', 'user/message', {
    id: message.durableMessageId,
    role: 'user',
    content: [{ type: 'text', text: 'wake during probe' }],
    source: { kind: 'agent-message', form: 'relay', senderSessionId: 'A' },
  })
  await new Promise((resolve) => setImmediate(resolve))
  release()
  await starting
  await engine.drain()

  host.ctx.sessions.flush = originalFlush
  query.listSessions = originalList
  await engine.tick()
  await engine.drain()
  assert.ok(reads > 0, 'the wake must make the target due after the failed header probe')
  assert.equal(ledger.read().messages.find((entry) => entry.to === 'B').receipt.state, 'received')
})
