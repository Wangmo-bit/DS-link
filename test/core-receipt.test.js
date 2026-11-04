import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_SETTINGS,
  LIMITS,
} from '../src/core/constants.js'
import {
  FakeClock,
  MemoryAdapter,
  openEngine,
  sessionFixture,
  tempRoot,
} from './helpers.js'

function standardSource(senderSessionId) {
  return { kind: 'agent-message', form: 'relay', senderSessionId }
}

async function setup(t, options = {}) {
  const clock = new FakeClock()
  const adapter = new MemoryAdapter({
    clock,
    autoReceive: options.autoReceive !== false,
    sessions: [sessionFixture({ id: 'A', title: 'Alpha' }), sessionFixture({ id: 'B', title: 'Beta' })],
  })
  const root = await tempRoot()
  const opened = await openEngine({ root, adapter, clock })
  t.after(async () => {
    await opened.engine.dispose()
    await opened.ledger.close()
  })
  return { ...opened, adapter, clock }
}

function operation(engine) {
  return engine.mintOperation().operationId
}

test('a context request has no deadline until exact context evidence arrives, then times out from receivedAt', async (t) => {
  const { engine, ledger, adapter, clock } = await setup(t, { autoReceive: false })
  const sent = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'queued request',
    operationId: operation(engine),
  })
  const message = ledger.read().messages.find((entry) => entry.id === sent.results[0].id)
  assert.equal(message.status, 'accepted')
  assert.equal(message.replyStatus, 'waiting')
  assert.equal(message.deadlineAt, null)
  assert.deepEqual(message.receipt, {
    policy: 'context',
    state: 'queued',
    receivedAt: null,
    receivedSeq: null,
    timeoutMs: DEFAULT_SETTINGS.requestTimeoutMs,
    transfer: null,
  })

  clock.advance(DEFAULT_SETTINGS.requestTimeoutMs + 60_000)
  await engine.tick()
  let current = ledger.read().messages.find((entry) => entry.id === message.id)
  assert.equal(current.replyStatus, 'waiting')
  assert.equal(current.deadlineAt, null)

  const receivedAt = clock.advance(1000)
  await adapter.receive('B', message.durableMessageId)
  await engine.drain()
  current = ledger.read().messages.find((entry) => entry.id === message.id)
  assert.equal(current.receipt.state, 'received')
  assert.equal(current.receipt.receivedAt, receivedAt)
  assert.equal(current.receipt.receivedSeq, 0)
  assert.equal(current.deadlineAt, receivedAt + DEFAULT_SETTINGS.requestTimeoutMs)

  clock.advance(DEFAULT_SETTINGS.requestTimeoutMs)
  await engine.tick()
  current = ledger.read().messages.find((entry) => entry.id === message.id)
  assert.equal(current.replyStatus, 'timed_out')
  assert.equal(current.timedOutAt, current.deadlineAt)
})

test('the timeout snapshot belongs to the acceptance, not to a later settings change', async (t) => {
  const { engine, ledger, adapter, clock } = await setup(t, { autoReceive: false })
  const first = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'first snapshot',
    operationId: operation(engine),
  })
  const firstId = first.results[0].id
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { requestTimeoutMs: 60 * 60 * 1000 },
  })
  const receivedFirst = clock.advance(1000)
  await adapter.receive('B', ledger.read().messages.find((entry) => entry.id === firstId).durableMessageId)
  await engine.drain()
  let current = ledger.read().messages.find((entry) => entry.id === firstId)
  assert.equal(current.receipt.timeoutMs, DEFAULT_SETTINGS.requestTimeoutMs)
  assert.equal(current.deadlineAt, receivedFirst + DEFAULT_SETTINGS.requestTimeoutMs)

  const second = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'second snapshot',
    operationId: operation(engine),
  })
  const receivedSecond = clock.advance(1000)
  await adapter.receive('B', ledger.read().messages.find((entry) => entry.id === second.results[0].id).durableMessageId)
  await engine.drain()
  current = ledger.read().messages.find((entry) => entry.id === second.results[0].id)
  assert.equal(current.receipt.timeoutMs, 60 * 60 * 1000)
  assert.equal(current.deadlineAt, receivedSecond + 60 * 60 * 1000)
})

test('an early user/message receipt is recorded before acceptance and acceptance then applies the deadline', async (t) => {
  const { engine, ledger, clock } = await setup(t)
  const receivedAt = clock.read()
  const sent = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'early receipt',
    operationId: operation(engine),
  })
  const message = ledger.read().messages.find((entry) => entry.id === sent.results[0].id)
  assert.equal(message.status, 'accepted')
  assert.equal(message.receipt.state, 'received')
  assert.equal(message.receipt.receivedAt, receivedAt)
  assert.equal(message.deadlineAt, receivedAt + DEFAULT_SETTINGS.requestTimeoutMs)
})

test('only an exact target/id/standard-source user message is accepted as receipt', async (t) => {
  const { engine, ledger, adapter, clock } = await setup(t, { autoReceive: false })
  const sent = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'identity fencing',
    operationId: operation(engine),
  })
  const message = ledger.read().messages.find((entry) => entry.id === sent.results[0].id)
  const durable = message.durableMessageId
  const bad = [
    { sessionId: 'C' },
    { messageId: 'other-id' },
    { source: standardSource('X'), senderSessionId: 'X' },
    { source: { ...standardSource('A'), extra: true }, senderSessionId: 'A' },
  ]
  for (const entry of bad) {
    await adapter.emitReceiptEvent({
      kind: 'message',
      sessionId: entry.sessionId ?? 'B',
      messageId: entry.messageId ?? durable,
      senderSessionId: entry.senderSessionId ?? 'A',
      source: entry.source ?? standardSource('A'),
      seq: 7,
      time: clock.read(),
    })
  }
  await engine.drain()
  assert.equal(ledger.read().messages.find((entry) => entry.id === message.id).receipt.state, 'queued')

  const receivedAt = clock.advance(500)
  await adapter.emitReceiptEvent({
    kind: 'message',
    sessionId: 'B',
    messageId: durable,
    senderSessionId: 'A',
    source: standardSource('A'),
    seq: 9,
    time: receivedAt,
  })
  await engine.drain()
  const current = ledger.read().messages.find((entry) => entry.id === message.id)
  assert.equal(current.receipt.state, 'received')
  assert.equal(current.receipt.receivedAt, receivedAt)
  assert.equal(current.receipt.receivedSeq, 9)

  clock.advance(1000)
  await adapter.emitReceiptEvent({
    kind: 'message',
    sessionId: 'B',
    messageId: durable,
    senderSessionId: 'A',
    source: standardSource('A'),
    seq: 10,
    time: clock.read(),
  })
  await engine.drain()
  const repeated = ledger.read().messages.find((entry) => entry.id === message.id)
  assert.equal(repeated.receipt.receivedAt, receivedAt)
  assert.equal(repeated.receipt.receivedSeq, 9)
})

test('a failed target flush does not confirm receipt; cold catch-up later records the exact event', async (t) => {
  const { engine, ledger, adapter } = await setup(t)
  adapter.receiptFlushResult = false
  const sent = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'flush matters',
    operationId: operation(engine),
  })
  const message = ledger.read().messages.find((entry) => entry.id === sent.results[0].id)
  assert.equal(message.receipt.state, 'queued')
  assert.equal(message.deadlineAt, null)

  adapter.receiptFlushResult = true
  await engine.start()
  await engine.drain()
  const current = ledger.read().messages.find((entry) => entry.id === message.id)
  assert.equal(current.receipt.state, 'received')
  assert.equal(current.receipt.receivedSeq, 0)
  assert.equal(current.deadlineAt, current.receipt.receivedAt + DEFAULT_SETTINGS.requestTimeoutMs)
})

test('cold catch-up reads each target once and keeps still-pending rows queued', async (t) => {
  const { engine, ledger, adapter } = await setup(t, { autoReceive: false })
  const first = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'first queued',
    operationId: operation(engine),
  })
  const second = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'second queued',
    operationId: operation(engine),
  })
  let reads = 0
  const original = adapter.readTargetReceipts.bind(adapter)
  adapter.readTargetReceipts = async (targetId) => {
    reads += 1
    return original(targetId)
  }
  await engine.start()
  await engine.drain()
  assert.equal(reads, 1)
  const state = ledger.read()
  for (const sent of [first, second]) {
    const message = state.messages.find((entry) => entry.id === sent.results[0].id)
    assert.equal(message.receipt.state, 'queued')
    assert.equal(message.deadlineAt, null)
  }
})

test('removing a queued row without user/message evidence becomes uncertain and starts no timer', async (t) => {
  const { engine, ledger, adapter, clock } = await setup(t, { autoReceive: false })
  const sent = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'discarded before context',
    operationId: operation(engine),
  })
  const message = ledger.read().messages.find((entry) => entry.id === sent.results[0].id)
  adapter.native.get('B').nextStep = []
  await adapter.emitReceiptEvent({ kind: 'inbox', sessionId: 'B', seq: 5, time: clock.read() })
  await engine.drain()
  const current = ledger.read().messages.find((entry) => entry.id === message.id)
  assert.equal(current.receipt.state, 'uncertain')
  assert.equal(current.deadlineAt, null)
  clock.advance(DEFAULT_SETTINGS.requestTimeoutMs + 1)
  await engine.tick()
  assert.equal(ledger.read().messages.find((entry) => entry.id === message.id).replyStatus, 'waiting')
})

test('notification completion and retention use receivedAt, while an unreceived row keeps its body', async (t) => {
  const { engine, ledger, adapter, clock } = await setup(t, { autoReceive: false })
  const sent = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'received notification',
    operationId: operation(engine),
  })
  const message = ledger.read().messages.find((entry) => entry.id === sent.results[0].id)
  assert.equal(message.completedAt, null)
  const receivedAt = clock.advance(1000)
  await adapter.receive('B', message.durableMessageId)
  await engine.drain()
  let current = ledger.read().messages.find((entry) => entry.id === message.id)
  assert.equal(current.completedAt, receivedAt)

  clock.advance(31 * 24 * 60 * 60 * 1000)
  await engine.tick()
  current = ledger.read().messages.find((entry) => entry.id === message.id)
  assert.equal(current.content.text, '')
  assert.ok(Number.isSafeInteger(current.redactedAt))

  const unreceived = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'never received',
    operationId: operation(engine),
  })
  clock.advance(31 * 24 * 60 * 60 * 1000)
  await engine.tick()
  const kept = ledger.read().messages.find((entry) => entry.id === unreceived.results[0].id)
  assert.equal(kept.content.text, 'never received')
  assert.equal(kept.redactedAt, undefined)
})

test('an unknown delivery keeps receipt evidence but does not create a deadline until owner resolution', async (t) => {
  const { engine, ledger, adapter, clock } = await setup(t, { autoReceive: false })
  adapter.flushResult = false
  const sent = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'unknown delivery with evidence',
    operationId: operation(engine),
  })
  const message = ledger.read().messages.find((entry) => entry.id === sent.results[0].id)
  assert.equal(message.status, 'unknown')
  const receivedAt = clock.advance(1000)
  await adapter.emitReceiptEvent({
    kind: 'message',
    sessionId: 'B',
    messageId: message.durableMessageId,
    senderSessionId: 'A',
    source: standardSource('A'),
    seq: 3,
    time: receivedAt,
  })
  await engine.drain()
  let current = ledger.read().messages.find((entry) => entry.id === message.id)
  assert.equal(current.status, 'unknown')
  assert.equal(current.receipt.state, 'received')
  assert.equal(current.deadlineAt, null)

  await engine.ownerControl({
    expectedRevision: ledger.read().revision,
    action: 'resolve_unknown',
    id: message.id,
    resolution: 'accepted',
  })
  current = ledger.read().messages.find((entry) => entry.id === message.id)
  assert.equal(current.status, 'accepted')
  assert.equal(current.receipt.timeoutMs, DEFAULT_SETTINGS.requestTimeoutMs)
  assert.equal(current.deadlineAt, receivedAt + DEFAULT_SETTINGS.requestTimeoutMs)
})

test('legacy rows accepted for the first time in 0.3 keep the 0.2 acceptedAt + timeout rule', async (t) => {
  const { engine, ledger, adapter, clock } = await setup(t, { autoReceive: false })
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { paused: true },
  })
  const sent = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'legacy pending',
    operationId: operation(engine),
  })
  const messageId = sent.results[0].id
  await ledger.mutate((state) => {
    const message = state.messages.find((entry) => entry.id === messageId)
    message.status = 'pending'
    message.heldAt = null
    message.heldReason = null
    message.error = null
    message.receipt = {
      policy: 'legacy-accepted',
      state: 'uncertain',
      receivedAt: null,
      receivedSeq: null,
      timeoutMs: null,
      transfer: null,
    }
  })
  clock.advance(1000)
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { paused: false },
  })
  await engine.drain()
  const current = ledger.read().messages.find((entry) => entry.id === messageId)
  assert.equal(current.status, 'accepted')
  assert.equal(current.receipt.policy, 'legacy-accepted')
  assert.equal(current.receipt.state, 'queued')
  assert.equal(current.receipt.timeoutMs, null)
  assert.equal(current.deadlineAt, current.acceptedAt + DEFAULT_SETTINGS.requestTimeoutMs)
  assert.ok(current.deadlineAt < LIMITS.MAX_DATE_MS)
})

test('a transient observation read failure is retried on tick without a full-history scan', async (t) => {
  const { engine, ledger, adapter } = await setup(t, { autoReceive: false })
  const sent = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'retry me',
    operationId: operation(engine),
  })
  adapter.readReceiptsError = 'temporary unreadable'
  await engine.start()
  await engine.drain()
  let message = ledger.read().messages.find((entry) => entry.id === sent.results[0].id)
  assert.equal(message.receipt.state, 'queued')

  adapter.readReceiptsError = undefined
  await engine.tick()
  await engine.drain()
  message = ledger.read().messages.find((entry) => entry.id === sent.results[0].id)
  assert.equal(message.receipt.state, 'queued')
  assert.ok(Number.isSafeInteger(message.receipt.timeoutMs))
  assert.equal(message.deadlineAt, null)
})

test('a late receipt event after dispose cannot write', async (t) => {
  const { engine, ledger, adapter, clock } = await setup(t, { autoReceive: false })
  const sent = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'late event',
    operationId: operation(engine),
  })
  const message = ledger.read().messages.find((entry) => entry.id === sent.results[0].id)
  await engine.dispose()
  await adapter.emitReceiptEvent({
    kind: 'message',
    sessionId: 'B',
    messageId: message.durableMessageId,
    senderSessionId: 'A',
    source: standardSource('A'),
    seq: 1,
    time: clock.read(),
  })
  await engine.drain()
  assert.equal(ledger.read().messages.find((entry) => entry.id === message.id).receipt.state, 'queued')
})

test('receipt observation never bumps settingsRevision', async (t) => {
  const { engine, ledger, adapter, clock } = await setup(t, { autoReceive: false })
  const sent = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'settings revision',
    operationId: operation(engine),
  })
  const message = ledger.read().messages.find((entry) => entry.id === sent.results[0].id)
  const revision = ledger.read().settingsRevision
  await adapter.receive('B', message.durableMessageId)
  await engine.drain()
  clock.advance(1000)
  ledger.read()
  assert.equal(ledger.read().settingsRevision, revision)
})

test('acceptance itself queues every context row, including the last, with no later event or tick', async (t) => {
  const { engine, ledger } = await setup(t, { autoReceive: false })
  for (let index = 0; index < 5; index += 1) {
    const sent = await engine.send({
      from: 'A',
      targets: ['B'],
      kind: 'request',
      text: `accepted ${index}`,
      operationId: operation(engine),
    })
    const message = ledger.read().messages.find((entry) => entry.id === sent.results[0].id)
    assert.equal(message.status, 'accepted')
    assert.equal(message.receipt.state, 'queued')
    assert.equal(message.receipt.timeoutMs, DEFAULT_SETTINGS.requestTimeoutMs)
    assert.equal(message.deadlineAt, null)
    assert.equal(message.receipt.receivedAt, null)
  }
})
