import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FakeClock,
  MemoryAdapter,
  openEngine,
  sessionFixture,
  tempRoot,
} from './helpers.js'

async function setup(t) {
  const clock = new FakeClock()
  const adapter = new MemoryAdapter({
    clock,
    autoReceive: false,
    sessions: [sessionFixture({ id: 'A', title: 'Alpha' }), sessionFixture({ id: 'B', title: 'Beta' })],
  })
  adapter.setNativeRunning('B', true)
  const opened = await openEngine({ root: await tempRoot(), adapter, clock })
  t.after(async () => {
    await opened.engine.dispose()
    await opened.ledger.close()
  })
  return { ...opened, adapter, clock }
}

function operation(engine) {
  return engine.mintOperation().operationId
}

/**
 * Create an accepted legacy request whose original host object is queued in the
 * target Agent's native next-turn list, exactly like a 0.2 followup backlog row.
 */
async function legacyNativeRow(t, options = {}) {
  const { engine, ledger, adapter, clock } = await setup(t)
  const sent = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: options.text ?? 'legacy backlog',
    operationId: operation(engine),
  })
  const messageId = sent.results[0].id
  const native = adapter.native.get('B')
  const hostMessage = native.nextStep.pop()
  assert.equal(hostMessage.id, ledger.read().messages.find((entry) => entry.id === messageId).durableMessageId)
  if (options.userBefore === true) {
    native.nextTurn.push({
      id: 'user-message',
      role: 'user',
      content: [{ type: 'text', text: 'a user wrote this' }],
      source: { kind: 'user' },
    })
  }
  native.nextTurn.push(hostMessage)
  await ledger.mutate((state) => {
    const message = state.messages.find((entry) => entry.id === messageId)
    message.receipt.policy = 'legacy-accepted'
    message.receipt.state = 'uncertain'
    message.receipt.timeoutMs = null
    if (options.answered === true) {
      message.replyStatus = 'answered'
      message.answeredAt = clock.read()
      message.completedAt = clock.read()
    }
  })
  return { engine, ledger, adapter, clock, messageId, durableId: hostMessage.id, hostMessage }
}

test('a legacy next-turn row is moved by original id/object and user rows are untouched', async (t) => {
  const row = await legacyNativeRow(t, { userBefore: true })
  const before = row.ledger.read().messages.find((entry) => entry.id === row.messageId)
  await row.engine.tick()
  await row.engine.drain()
  const state = row.ledger.read()
  const message = state.messages.find((entry) => entry.id === row.messageId)
  const native = row.adapter.native.get('B')
  assert.equal(message.durableMessageId, row.durableId)
  assert.equal(native.nextTurn.length, 1)
  assert.equal(native.nextTurn[0].id, 'user-message')
  assert.equal(native.nextStep.length, 1)
  assert.equal(native.nextStep[0].id, row.durableId)
  assert.equal(native.nextStep[0], row.hostMessage)
  assert.equal(native.nextStep[0].id, before.durableMessageId)
  assert.equal(state.transfers[row.messageId].state, 'moved')
  assert.equal(state.transfers[row.messageId].hostMessage.id, row.durableId)
  assert.deepEqual(message.receipt.transfer, { state: 'moved', at: row.clock.read() })
})

test('context-policy rows, answered requests, paused settings, closed chains, and idle targets are not moved', async (t) => {
  const context = await setup(t)
  const sent = await context.engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'context fallback',
    operationId: operation(context.engine),
  })
  const contextId = sent.results[0].id
  context.adapter.native.get('B').nextTurn.push(context.adapter.native.get('B').nextStep.pop())
  await context.engine.tick()
  await context.engine.drain()
  assert.equal(context.adapter.native.get('B').nextTurn.length, 1)
  assert.equal(context.ledger.read().transfers, undefined)

  const answered = await legacyNativeRow(t, { answered: true, text: 'already answered' })
  await answered.engine.tick()
  await answered.engine.drain()
  assert.equal(answered.adapter.native.get('B').nextTurn.length, 1)
  assert.equal(answered.ledger.read().transfers, undefined)

  const paused = await legacyNativeRow(t, { text: 'paused backlog' })
  await paused.engine.updateSettings({
    expectedSettingsRevision: paused.ledger.read().settingsRevision,
    patch: { paused: true },
  })
  await paused.engine.tick()
  await paused.engine.drain()
  assert.equal(paused.adapter.native.get('B').nextTurn.length, 1)
  assert.equal(paused.ledger.read().transfers, undefined)

  const closed = await legacyNativeRow(t, { text: 'closed backlog' })
  const closedMessage = closed.ledger.read().messages.find((entry) => entry.id === closed.messageId)
  await closed.engine.ownerControl({
    expectedRevision: closed.ledger.read().revision,
    action: 'close',
    id: closedMessage.chainId,
  })
  await closed.engine.tick()
  await closed.engine.drain()
  assert.equal(closed.adapter.native.get('B').nextTurn.length, 1)
  assert.equal(closed.ledger.read().transfers, undefined)
  void contextId
})

test('an idle target keeps the row and creates no journal', async (t) => {
  const row = await legacyNativeRow(t)
  row.adapter.setNativeRunning('B', false)
  await row.engine.tick()
  await row.engine.drain()
  assert.equal(row.adapter.native.get('B').nextTurn.length, 1)
  assert.equal(row.adapter.native.get('B').nextStep.length, 0)
  assert.equal(row.ledger.read().transfers, undefined)
})

test('a body that no longer matches the ledger is never moved', async (t) => {
  const row = await legacyNativeRow(t)
  row.hostMessage.content[0].text = 'edited by someone else'
  await row.engine.tick()
  await row.engine.drain()
  assert.equal(row.adapter.native.get('B').nextTurn.length, 1)
  assert.equal(row.adapter.native.get('B').nextStep.length, 0)
  assert.equal(row.ledger.read().transfers, undefined)
})

test('a false flush after steer keeps the journal uncertain and is not retried', async (t) => {
  const row = await legacyNativeRow(t)
  row.adapter.receiptFlushResult = false
  await row.engine.tick()
  await row.engine.drain()
  const state = row.ledger.read()
  const message = state.messages.find((entry) => entry.id === row.messageId)
  assert.equal(state.transfers[row.messageId].state, 'uncertain')
  assert.equal(state.transfers[row.messageId].error, 'flush_failed')
  assert.equal(message.receipt.transfer.state, 'uncertain')
  let calls = 0
  const original = row.adapter.moveNativePending.bind(row.adapter)
  row.adapter.moveNativePending = (request) => {
    calls += 1
    return original(request)
  }
  await row.engine.tick()
  await row.engine.drain()
  assert.equal(calls, 0)
})

test('a missing original id after the prepared journal becomes uncertain without a resend', async (t) => {
  const row = await legacyNativeRow(t)
  row.adapter.moveNativePending = () => ({ outcome: 'missing' })
  await row.engine.tick()
  await row.engine.drain()
  let state = row.ledger.read()
  assert.equal(state.transfers[row.messageId].state, 'uncertain')
  assert.equal(state.messages.find((entry) => entry.id === row.messageId).receipt.transfer.state, 'uncertain')
  assert.equal(row.adapter.native.get('B').nextTurn.length, 1)
  assert.equal(row.adapter.native.get('B').nextStep.length, 0)
  let calls = 0
  const original = row.adapter.moveNativePending.bind(row.adapter)
  row.adapter.moveNativePending = (request) => {
    calls += 1
    return original(request)
  }
  state = row.ledger.read()
  await row.engine.tick()
  await row.engine.drain()
  assert.equal(calls, 0)
  assert.equal(row.ledger.read().transfers[row.messageId].state, 'uncertain')
})

test('a prepared journal is retried after a transient not-running result and then moves', async (t) => {
  const row = await legacyNativeRow(t)
  let failOnce = true
  const original = row.adapter.moveNativePending.bind(row.adapter)
  row.adapter.moveNativePending = (request) => {
    if (failOnce) {
      failOnce = false
      return { outcome: 'not_running' }
    }
    return original(request)
  }
  await row.engine.tick()
  await row.engine.drain()
  let state = row.ledger.read()
  assert.equal(state.transfers[row.messageId].state, 'prepared')
  assert.equal(row.adapter.native.get('B').nextTurn.length, 1)
  await row.engine.tick()
  await row.engine.drain()
  state = row.ledger.read()
  assert.equal(state.transfers[row.messageId].state, 'moved')
  assert.deepEqual(row.adapter.native.get('B').nextStep.map((entry) => entry.id), [row.durableId])
})

test('repeated synchronous rollbacks exhaust the private attempt budget into uncertain', async (t) => {
  const row = await legacyNativeRow(t)
  row.adapter.moveNativePending = () => ({ outcome: 'rolled_back' })
  for (let index = 0; index < 3; index += 1) {
    await row.engine.tick()
    await row.engine.drain()
  }
  const state = row.ledger.read()
  assert.equal(state.transfers[row.messageId].state, 'uncertain')
  assert.equal(state.transfers[row.messageId].error, 'move_rolled_back')
  assert.equal(row.adapter.native.get('B').nextStep.length, 0)
})

test('start rechecks a prepared journal against D1 and then moves when the target is running', async (t) => {
  const row = await legacyNativeRow(t)
  row.adapter.moveNativePending = () => ({ outcome: 'rolled_back' })
  await row.engine.tick()
  await row.engine.drain()
  assert.equal(row.ledger.read().transfers[row.messageId].state, 'prepared')
  row.adapter.setNativeRunning('B', false)
  await row.engine.start()
  await row.engine.drain()
  assert.equal(row.ledger.read().transfers[row.messageId].state, 'prepared')
  assert.equal(row.adapter.native.get('B').nextTurn.length, 1)

  const original = row.adapter.moveNativePending
  row.adapter.moveNativePending = (request) => {
    const state = row.adapter.native.get('B')
    const index = state.nextTurn.findIndex((entry) => entry.id === request.durableMessageId)
    if (index < 0) return { outcome: 'missing' }
    const message = state.nextTurn.splice(index, 1)[0]
    state.nextStep.push(message)
    return { outcome: 'moved' }
  }
  row.adapter.setNativeRunning('B', true)
  await row.engine.start()
  await row.engine.drain()
  assert.equal(row.ledger.read().transfers[row.messageId].state, 'moved')
  assert.deepEqual(row.adapter.native.get('B').nextStep.map((entry) => entry.id), [row.durableId])
  void original
})

test('an already claimed or deleted original id is left alone and creates no journal', async (t) => {
  const claimed = await legacyNativeRow(t)
  const native = claimed.adapter.native.get('B')
  native.nextStep.push(native.nextTurn.pop())
  await claimed.engine.tick()
  await claimed.engine.drain()
  assert.equal(claimed.ledger.read().transfers, undefined)
  assert.equal(native.nextTurn.length, 0)
  assert.equal(native.nextStep.length, 1)

  const deleted = await legacyNativeRow(t)
  deleted.adapter.native.get('B').nextTurn.pop()
  await deleted.engine.tick()
  await deleted.engine.drain()
  assert.equal(deleted.ledger.read().transfers, undefined)
  assert.equal(deleted.adapter.native.get('B').nextStep.length, 0)
})

test('a journal prepared but already consumed by a next-step claim is confirmed moved on start', async (t) => {
  const row = await legacyNativeRow(t)
  row.adapter.moveNativePending = () => ({ outcome: 'rolled_back' })
  await row.engine.tick()
  await row.engine.drain()
  assert.equal(row.ledger.read().transfers[row.messageId].state, 'prepared')
  const native = row.adapter.native.get('B')
  native.nextStep.push(native.nextTurn.pop())
  await row.engine.start()
  await row.engine.drain()
  assert.equal(row.ledger.read().transfers[row.messageId].state, 'moved')
  assert.equal(row.ledger.read().messages.find((entry) => entry.id === row.messageId).receipt.transfer.state, 'moved')
})

test('a prepared journal whose rows vanished without user/message evidence becomes uncertain and is never re-sent', async (t) => {
  const row = await legacyNativeRow(t)
  row.adapter.moveNativePending = () => ({ outcome: 'rolled_back' })
  await row.engine.tick()
  await row.engine.drain()
  row.adapter.native.get('B').nextTurn.length = 0
  await row.engine.start()
  await row.engine.drain()
  assert.equal(row.ledger.read().transfers[row.messageId].state, 'uncertain')
  assert.equal(row.adapter.native.get('B').nextStep.length, 0)
  const calls = { count: 0 }
  row.adapter.moveNativePending = () => {
    calls.count += 1
    return { outcome: 'moved' }
  }
  await row.engine.start()
  await row.engine.drain()
  assert.equal(calls.count, 0)
})

test('a moved journal whose original id is back in next-turn is rechecked and safely moved again', async (t) => {
  const row = await legacyNativeRow(t)
  await row.engine.tick()
  await row.engine.drain()
  assert.equal(row.ledger.read().transfers[row.messageId].state, 'moved')
  const native = row.adapter.native.get('B')
  const moved = native.nextStep.pop()
  native.nextTurn.push(moved)
  await row.engine.start()
  await row.engine.drain()
  assert.equal(row.ledger.read().transfers[row.messageId].state, 'moved')
  assert.deepEqual(native.nextStep.map((entry) => entry.id), [row.durableId])
  assert.equal(native.nextStep[0], moved)
})

test('an uncertain move result keeps the journal for manual checks and never resends', async (t) => {
  const row = await legacyNativeRow(t)
  row.adapter.moveNativePending = () => ({ outcome: 'uncertain', error: 'remove_failed' })
  await row.engine.tick()
  await row.engine.drain()
  const state = row.ledger.read()
  assert.equal(state.transfers[row.messageId].state, 'uncertain')
  assert.equal(state.transfers[row.messageId].error, 'remove_failed')
  assert.equal(state.messages.find((entry) => entry.id === row.messageId).receipt.transfer.state, 'uncertain')
  assert.equal(row.adapter.native.get('B').nextTurn.length, 1)
  assert.equal(row.adapter.native.get('B').nextStep.length, 0)
})

test('snapshot exposes the minimal receipt transfer but never the private journal body', async (t) => {
  const row = await legacyNativeRow(t)
  await row.engine.tick()
  await row.engine.drain()
  const snapshot = await row.engine.snapshot({})
  const message = snapshot.messages.find((entry) => entry.id === row.messageId)
  assert.deepEqual(Object.keys(message.receipt).sort(), [
    'policy',
    'receivedAt',
    'receivedSeq',
    'state',
    'timeoutMs',
    'transfer',
  ])
  assert.deepEqual(Object.keys(message.receipt.transfer).sort(), ['at', 'state'])
  assert.equal(message.hostMessage, undefined)
  assert.equal(message.transfers, undefined)
  assert.equal(JSON.stringify(snapshot).includes('user-message'), false)
})

test('a paused start does not move the backlog; the global resume starts the bounded transfer pass', async (t) => {
  const row = await legacyNativeRow(t)
  await row.engine.updateSettings({
    expectedSettingsRevision: row.ledger.read().settingsRevision,
    patch: { paused: true },
  })
  await row.engine.start()
  await row.engine.drain()
  assert.equal(row.ledger.read().transfers, undefined)
  assert.equal(row.adapter.native.get('B').nextTurn.length, 1)

  await row.engine.updateSettings({
    expectedSettingsRevision: row.ledger.read().settingsRevision,
    patch: { paused: false },
  })
  await row.engine.drain()
  assert.equal(row.ledger.read().transfers[row.messageId].state, 'moved')
  assert.deepEqual(row.adapter.native.get('B').nextStep.map((entry) => entry.id), [row.durableId])
})

test('the prepared hoisted site shape moves five legacy rows and leaves the one human next-turn row untouched', async (t) => {
  const { engine, ledger, adapter, clock } = await setup(t)
  const hostRows = []
  for (let index = 0; index < 5; index += 1) {
    const sent = await engine.send({
      from: 'A',
      targets: ['B'],
      kind: index < 2 ? 'request' : 'notification',
      text: `hoisted legacy ${index}`,
      operationId: operation(engine),
    })
    const message = ledger.read().messages.find((entry) => entry.id === sent.results[0].id)
    const native = adapter.native.get('B')
    const hostMessage = native.nextStep.pop()
    hostRows.push({ id: message.id, durableId: hostMessage.id, hostMessage })
    await ledger.mutate((state) => {
      const current = state.messages.find((entry) => entry.id === message.id)
      current.receipt.policy = 'legacy-accepted'
      current.receipt.state = 'uncertain'
      current.receipt.timeoutMs = null
    })
  }
  const human = {
    id: 'human-next-turn',
    role: 'user',
    content: [{ type: 'text', text: 'human input must not move' }],
    source: { kind: 'user' },
  }
  const native = adapter.native.get('B')
  native.nextTurn.push(human)
  for (const row of hostRows) native.nextTurn.push(row.hostMessage)
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { paused: true },
  })
  await engine.start()
  await engine.drain()
  assert.equal(native.nextTurn.length, 6)
  assert.equal(native.nextStep.length, 0)
  assert.equal(ledger.read().transfers, undefined)

  clock.advance(1000)
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { paused: false },
  })
  await engine.drain()
  const state = ledger.read()
  assert.equal(native.nextTurn.length, 1)
  assert.equal(native.nextTurn[0], human)
  assert.deepEqual(
    native.nextStep.map((entry) => entry.id),
    hostRows.map((row) => row.durableId),
  )
  for (const [index, row] of hostRows.entries()) {
    assert.equal(native.nextStep[index], row.hostMessage)
    assert.equal(state.transfers[row.id].state, 'moved')
    assert.equal(state.messages.find((entry) => entry.id === row.id).durableMessageId, row.durableId)
    assert.equal(state.messages.find((entry) => entry.id === row.id).receipt.transfer.state, 'moved')
  }
  assert.equal(new Set(hostRows.map((row) => row.durableId)).size, 5)
  assert.equal(native.nextTurn.some((entry) => entry.id === human.id), true)
})
