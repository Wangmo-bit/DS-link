import test from 'node:test'
import assert from 'node:assert/strict'

import { FakeClock, MemoryAdapter, openEngine, sessionFixture, tempRoot } from './helpers.js'

function sessions(count) {
  return Array.from({ length: count }, (_, index) => sessionFixture({ id: index === 0 ? 'A' : `T${index - 1}` }))
}

async function setup(t, options = {}) {
  const clock = new FakeClock()
  const root = await tempRoot()
  const adapter = new MemoryAdapter({ clock, sessions: options.sessions ?? sessions(4) })
  const opened = await openEngine({ root, adapter, clock, limits: options.limits })
  t.after(async () => {
    await opened.engine.dispose()
    await opened.ledger.close()
  })
  return { ...opened, clock, adapter }
}

function op(engine) {
  return engine.mintOperation().operationId
}

test('hop and chain thresholds no longer pause: >8 hops and >20 chain messages are accepted', async (t) => {
  const { engine, ledger } = await setup(t, { sessions: sessions(3) })
  const first = await engine.send({
    from: 'A',
    targets: ['T0'],
    kind: 'notification',
    text: 'hop 0',
    operationId: op(engine),
  })
  let parent = first.results[0].id
  let from = 'T0'
  let to = 'A'
  for (let hop = 1; hop <= 12; hop += 1) {
    const next = await engine.send({
      from,
      targets: [to],
      kind: 'notification',
      text: `hop ${hop}`,
      operationId: op(engine),
      parentMessageId: parent,
    })
    assert.equal(next.results[0].status, 'accepted')
    parent = next.results[0].id
    const swap = from
    from = to
    to = swap
  }
  const state = ledger.read()
  assert.equal(state.messages.length, 13)
  assert.equal(state.chains[first.chainId].state, 'open')
  assert.equal(state.messages.every((message) => message.status === 'accepted'), true)
})

test('a chain can exceed 20 messages without a budget pause', async (t) => {
  const { engine, ledger } = await setup(t, { sessions: sessions(11) })
  const targets = Array.from({ length: 10 }, (_, index) => `T${index}`)
  const first = await engine.send({
    from: 'A',
    targets,
    kind: 'notification',
    text: 'twenty plus',
    operationId: op(engine),
  })
  let parent = first.results[0].id
  let from = 'T0'
  let to = 'A'
  for (let index = 0; index < 12; index += 1) {
    const next = await engine.send({
      from,
      targets: [to],
      kind: 'notification',
      text: `continuation ${index}`,
      operationId: op(engine),
      parentMessageId: parent,
    })
    assert.equal(next.results[0].status, 'accepted')
    parent = next.results[0].id
    const swap = from
    from = to
    to = swap
  }
  const state = ledger.read()
  assert.equal(state.messages.length, 22)
  assert.equal(state.chains[first.chainId].state, 'open')
})

test('a request can be answered from unknown status only with matching host evidence', async (t) => {
  const { engine, adapter, ledger } = await setup(t)
  adapter.flushResult = false
  const sent = await engine.send({
    from: 'A',
    targets: ['T0'],
    kind: 'request',
    text: 'unknown but perhaps inserted',
    operationId: op(engine),
  })
  assert.equal(sent.results[0].status, 'unknown')
  adapter.flushResult = true
  const reply = await engine.reply({
    from: 'T0',
    messageId: sent.results[0].id,
    text: 'evidence-backed reply',
    operationId: op(engine),
  })
  assert.equal(reply.results[0].status, 'accepted')
  const request = ledger.read().messages.find((message) => message.id === sent.results[0].id)
  assert.equal(request.status, 'accepted')
  assert.equal(request.replyStatus, 'answered')
})

test('a reply to an unknown parent without evidence is rejected', async (t) => {
  const { engine, adapter } = await setup(t)
  adapter.flushResult = false
  const sent = await engine.send({
    from: 'A',
    targets: ['T0'],
    kind: 'request',
    text: 'no evidence',
    operationId: op(engine),
  })
  adapter.inserted.clear()
  await assert.rejects(
    engine.reply({ from: 'T0', messageId: sent.results[0].id, text: 'guess', operationId: op(engine) }),
    (error) => error.code === 'parent_unacknowledged',
  )
})

test('closed chains reject further replies and continuation sends but allow a new root chain', async (t) => {
  const { engine, ledger } = await setup(t)
  const sent = await engine.send({
    from: 'A',
    targets: ['T0'],
    kind: 'request',
    text: 'start',
    operationId: op(engine),
  })
  await engine.reply({ from: 'T0', messageId: sent.results[0].id, text: 'first', operationId: op(engine) })
  await engine.ownerControl({ expectedRevision: ledger.read().revision, action: 'close', id: sent.chainId })
  await assert.rejects(
    engine.reply({ from: 'T0', messageId: sent.results[0].id, text: 'after close', operationId: op(engine) }),
    (error) => error.code === 'chain_closed',
  )
  await assert.rejects(
    engine.send({
      from: 'A',
      targets: ['T1'],
      kind: 'notification',
      text: 'continuation',
      operationId: op(engine),
      parentMessageId: sent.results[0].id,
    }),
    (error) => error.code === 'chain_closed',
  )
  const fresh = await engine.send({
    from: 'A',
    targets: ['T1'],
    kind: 'notification',
    text: 'new root',
    operationId: op(engine),
  })
  assert.equal(fresh.results[0].status, 'accepted')
})

test('the undelivered queue cap rejects without creating a half record', async (t) => {
  const { engine, ledger } = await setup(t, { limits: { maxQueuedBytes: 1000 } })
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { paused: true },
  })
  const first = await engine.send({
    from: 'A',
    targets: ['T0'],
    kind: 'notification',
    text: 'x'.repeat(600),
    operationId: op(engine),
  })
  assert.equal(first.results[0].status, 'held')
  const before = ledger.read().messages.length
  await assert.rejects(
    engine.send({
      from: 'A',
      targets: ['T0'],
      kind: 'notification',
      text: 'y'.repeat(600),
      operationId: op(engine),
    }),
    (error) => error.code === 'queue_full' && error.details.maxQueuedBytes === 1000,
  )
  assert.equal(ledger.read().messages.length, before, 'queue_full must not leave a half-created message')
})

test('model control cannot cancel another session\'s record or resume a chain', async (t) => {
  const { engine, ledger } = await setup(t)
  const held = await engine.send({
    from: 'A',
    targets: ['T0'],
    kind: 'notification',
    text: 'held by pause',
    operationId: op(engine),
  })
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { paused: true },
  })
  const pausedSend = await engine.send({
    from: 'A',
    targets: ['T0'],
    kind: 'notification',
    text: 'held',
    operationId: op(engine),
  })
  await assert.rejects(
    engine.modelControl({ from: 'T0', action: 'cancel', id: pausedSend.results[0].id }),
    (error) => error.code === 'forbidden',
  )
  await assert.rejects(
    engine.modelControl({ from: 'T0', action: 'pause', id: pausedSend.chainId }),
    (error) => error.code === 'forbidden',
  )
  await assert.rejects(
    engine.modelControl({ from: 'A', action: 'resume', id: pausedSend.chainId }),
    (error) => error.code === 'invalid_argument',
  )
  const cancelled = await engine.modelControl({ from: 'A', action: 'cancel', id: pausedSend.results[0].id })
  assert.equal(cancelled.message.status, 'cancelled')
  assert.equal(held.results[0].status, 'accepted')
})
