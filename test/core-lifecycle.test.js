import test from 'node:test'
import assert from 'node:assert/strict'

import { FakeClock, MemoryAdapter, openEngine, tempRoot } from './helpers.js'

async function setup(t, options = {}) {
  const clock = new FakeClock()
  const root = await tempRoot()
  const adapter = new MemoryAdapter({ clock, sessions: options.sessions })
  const opened = await openEngine({ root, adapter, clock, limits: options.limits })
  t.after(async () => {
    await opened.engine.dispose()
    await opened.ledger.close()
  })
  return { ...opened, clock, adapter, root }
}

function operation(engine) {
  return engine.mintOperation().operationId
}

test('a notification is accepted with durable attribution and a stable id', async (t) => {
  const { engine, ledger, adapter, clock } = await setup(t)
  const result = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'heads up',
    operationId: operation(engine),
  })
  assert.equal(result.held, false)
  assert.equal(result.results[0].status, 'accepted')
  const message = ledger.read().messages[0]
  assert.equal(message.status, 'accepted')
  assert.equal(message.durableMessageId, 'host-msg-1')
  assert.equal(message.replyStatus, 'none')
  assert.equal(message.deadlineAt, null)
  assert.equal(adapter.deliveries.length, 1)
  assert.equal(adapter.deliveries[0].message.from, 'A')
  assert.equal(adapter.deliveries[0].message.to, 'B')
  assert.equal(message.completedAt, clock.read())
})

test('a request and explicit reply link to the parent and only the first reply answers', async (t) => {
  const { engine, ledger, clock } = await setup(t)
  const sent = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'please do it',
    operationId: operation(engine),
  })
  const requestId = sent.results[0].id
  assert.equal(ledger.read().messages.find((message) => message.id === requestId).replyStatus, 'waiting')

  clock.advance(1001)
  const first = await engine.reply({ from: 'B', messageId: requestId, text: 'done', operationId: operation(engine) })
  assert.equal(first.results[0].status, 'accepted')
  const state = ledger.read()
  const request = state.messages.find((message) => message.id === requestId)
  assert.equal(request.replyStatus, 'answered')
  assert.equal(request.answeredBy, first.results[0].id)
  const reply = state.messages.find((message) => message.id === first.results[0].id)
  assert.equal(reply.kind, 'reply')
  assert.equal(reply.parentMessageId, requestId)
  assert.equal(reply.replyTo, requestId)
  assert.equal(reply.hop, 1)

  clock.advance(1001)
  const second = await engine.reply({ from: 'B', messageId: requestId, text: 'more', operationId: operation(engine) })
  const after = ledger.read().messages.find((message) => message.id === requestId)
  assert.equal(after.replyStatus, 'answered')
  assert.equal(after.answeredBy, first.results[0].id)
  assert.equal(ledger.read().messages.find((message) => message.id === second.results[0].id).parentMessageId, requestId)
})

test('one multi-target call creates one chain with independent per-target results', async (t) => {
  const { engine, ledger } = await setup(t, {
    sessions: [
      { id: 'A', title: 'Alpha' },
      { id: 'B', title: 'Beta' },
      { id: 'C', title: 'Gamma' },
    ].map((session) => ({ ...session, eligible: true, registered: true, archived: false, subagent: false })),
  })
  const result = await engine.send({
    from: 'A',
    targets: ['C', 'B'],
    kind: 'notification',
    text: 'broadcast',
    operationId: operation(engine),
  })
  assert.equal(result.results.length, 2)
  const state = ledger.read()
  assert.equal(new Set(result.results.map((entry) => state.messages.find((message) => message.id === entry.id).chainId)).size, 1)
  assert.equal(state.messages.length, 2)
  assert.deepEqual(result.results.map((entry) => entry.target).sort(), ['B', 'C'])
})

test('the retired unanswered-request gate no longer blocks a same-pair root', async (t) => {
  const { engine, ledger, clock } = await setup(t, {
    sessions: [
      { id: 'A', title: 'Alpha' },
      { id: 'B', title: 'Beta' },
      { id: 'C', title: 'Gamma' },
    ].map((session) => ({ ...session, eligible: true, registered: true, archived: false, subagent: false })),
  })
  const sent = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'question',
    operationId: operation(engine),
  })
  const requestId = sent.results[0].id

  clock.advance(1001)
  const independent = await engine.send({
    from: 'B',
    targets: ['C'],
    kind: 'notification',
    text: 'independent user task',
    operationId: operation(engine),
  })
  assert.equal(independent.results[0].status, 'accepted')

  clock.advance(1001)
  const samePair = await engine.send({
    from: 'B',
    targets: ['A'],
    kind: 'notification',
    text: 'new root to A',
    operationId: operation(engine),
  })
  assert.equal(samePair.results[0].status, 'accepted')
  assert.notEqual(samePair.chainId, sent.chainId)

  clock.advance(1001)
  const forwarded = await engine.send({
    from: 'B',
    targets: ['C'],
    kind: 'notification',
    text: 'forwarded',
    operationId: operation(engine),
    parentMessageId: requestId,
  })
  assert.equal(forwarded.results[0].status, 'accepted')
  assert.equal(forwarded.chainId, sent.chainId)
  assert.equal(ledger.read().messages.find((message) => message.id === forwarded.results[0].id).hop, 1)

  clock.advance(1001)
  await engine.reply({ from: 'B', messageId: requestId, text: 'answer', operationId: operation(engine) })
})

test('a timed-out request releases the pair gate but keeps the accepted record', async (t) => {
  const { engine, ledger, clock } = await setup(t)
  const sent = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'slow request',
    operationId: operation(engine),
  })
  const requestId = sent.results[0].id
  clock.advance(30 * 60 * 1000 + 1)
  await engine.tick()
  const request = ledger.read().messages.find((message) => message.id === requestId)
  assert.equal(request.replyStatus, 'timed_out')
  assert.ok(Number.isSafeInteger(request.timedOutAt))
  assert.equal(request.status, 'accepted')

  clock.advance(1001)
  const notification = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'new root after timeout',
    operationId: operation(engine),
  })
  assert.equal(notification.results[0].status, 'accepted')

  clock.advance(1001)
  const reply = await engine.reply({ from: 'B', messageId: requestId, text: 'late answer', operationId: operation(engine) })
  assert.equal(reply.results[0].status, 'accepted')
  const late = ledger.read()
  const lateRequest = late.messages.find((message) => message.id === requestId)
  assert.equal(lateRequest.replyStatus, 'answered')
  assert.ok(Number.isSafeInteger(lateRequest.timedOutAt))
  assert.equal(late.messages.find((message) => message.id === reply.results[0].id).late, true)
})

test('paused messages do not reach the host and resume dispatches them automatically', async (t) => {
  const { engine, ledger, adapter } = await setup(t)
  const paused = await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { paused: true },
  })
  assert.equal(paused.settings.paused, true)
  const sent = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'held',
    operationId: operation(engine),
  })
  assert.equal(sent.results[0].status, 'held')
  assert.equal(ledger.read().messages[0].heldReason, 'paused')
  assert.equal(adapter.deliveries.length, 0)

  const resumed = await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { paused: false },
  })
  assert.equal(resumed.resumed, 1)
  await engine.drain()
  assert.equal(ledger.read().messages[0].status, 'accepted')
  assert.equal(adapter.deliveries.length, 1)
})

test('explicit release cannot bypass a global pause, but works on a manual held record', async (t) => {
  const { engine, ledger, adapter } = await setup(t)
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { paused: true },
  })
  const pausedSend = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'held',
    operationId: operation(engine),
  })
  await assert.rejects(
    engine.ownerControl({ expectedRevision: ledger.read().revision, action: 'release', id: pausedSend.results[0].id }),
    (error) => error.code === 'paused',
  )
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { paused: false },
  })
  await engine.drain()
  const chainSend = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'chain paused',
    operationId: operation(engine),
  })
  await engine.ownerControl({ expectedRevision: ledger.read().revision, action: 'pause', id: chainSend.chainId })
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { paused: true },
  })
  const manual = await engine.send({
    from: 'B',
    targets: ['A'],
    kind: 'notification',
    text: 'manual held elsewhere',
    operationId: operation(engine),
  })
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { paused: false },
  })
  await engine.drain()
  assert.equal(ledger.read().messages.find((message) => message.id === manual.results[0].id).status, 'accepted')
  assert.equal(adapter.deliveries.length >= 1, true)
})

test('pause interrupts resolve-before-followup and resume schedules the pending message', async (t) => {
  const { engine, ledger, adapter, clock } = await setup(t)
  let pauseOnce = true
  adapter.beforeResolveHook = async (request) => {
    if (!pauseOnce) return
    pauseOnce = false
    const built = adapter.built.get(request.hostMessage.id)
    const state = ledger.read()
    await engine.ownerControl({ expectedRevision: state.revision, action: 'pause', id: built.chainId })
  }
  const sent = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'pause race',
    operationId: operation(engine),
  })
  assert.equal(sent.results[0].status, 'pending')
  const chain = ledger.read().chains[sent.chainId]
  assert.equal(chain.state, 'paused')

  clock.advance(1001)
  await engine.ownerControl({ expectedRevision: ledger.read().revision, action: 'resume', id: sent.chainId })
  await engine.drain()
  assert.equal(ledger.read().messages[0].status, 'accepted')
  assert.equal(adapter.deliveries.length, 2)
})

test('close cancels paused messages and does not touch accepted history', async (t) => {
  const { engine, ledger } = await setup(t)
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { paused: true },
  })
  const sent = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'held',
    operationId: operation(engine),
  })
  await engine.ownerControl({ expectedRevision: ledger.read().revision, action: 'close', id: sent.chainId })
  assert.equal(ledger.read().messages[0].status, 'cancelled')
  assert.equal(ledger.read().chains[sent.chainId].state, 'closed')
})

test('flush false becomes unknown and is never retried automatically', async (t) => {
  const { engine, ledger, adapter } = await setup(t)
  adapter.flushResult = false
  const sent = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'ambiguous',
    operationId: operation(engine),
  })
  assert.equal(sent.results[0].status, 'unknown')
  assert.equal(ledger.read().messages[0].error.code, 'flush_failed')
  assert.equal(adapter.deliveries.length, 1)
  // The operation record still returns the unknown status; no second delivery.
  const retry = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'ambiguous',
    operationId: sent.operationId,
  })
  assert.equal(retry.idempotent, true)
  assert.equal(retry.results[0].status, 'unknown')
  assert.equal(adapter.deliveries.length, 1)
})

test('settings CAS uses settingsRevision and a no-op leaves both revisions unchanged', async (t) => {
  const { engine, ledger } = await setup(t)
  const before = ledger.read()
  const updated = await engine.updateSettings({
    expectedSettingsRevision: before.settingsRevision,
    patch: { maxConcurrent: 4 },
  })
  assert.equal(updated.settings.maxConcurrent, 4)
  assert.equal(updated.settingsRevision, before.settingsRevision + 1)
  assert.equal(updated.revision, before.revision + 1)

  await assert.rejects(
    engine.updateSettings({ expectedSettingsRevision: before.settingsRevision, patch: { maxConcurrent: 5 } }),
    (error) => error.code === 'revision_conflict' && error.details.currentSettingsRevision === updated.settingsRevision,
  )
  const noopBefore = ledger.read()
  const noop = await engine.updateSettings({
    expectedSettingsRevision: noopBefore.settingsRevision,
    patch: { maxConcurrent: 4 },
  })
  assert.equal(noop.revision, noopBefore.revision)
  assert.equal(noop.settingsRevision, noopBefore.settingsRevision)
  assert.equal(noop.queued, 0)
  assert.equal(noop.resumed, 0)
})

test('cold recovery marks dispatching without evidence unknown and never resends', async (t) => {
  const clock = new FakeClock()
  const root = await tempRoot()
  const adapter = new MemoryAdapter({ clock })
  const first = await openEngine({ root, adapter, clock })
  const sent = await first.engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'interrupted',
    operationId: operation(first.engine),
  })
  const messageId = sent.results[0].id
  await first.ledger.mutate((state) => {
    const message = state.messages.find((candidate) => candidate.id === messageId)
    message.status = 'dispatching'
    message.durableMessageId = 'host-interrupted'
  })
  await first.engine.dispose()
  await first.ledger.close()

  const secondAdapter = new MemoryAdapter({ clock })
  const second = await openEngine({ root, adapter: secondAdapter, clock })
  try {
    const summary = await second.engine.start()
    assert.equal(summary.recovered, 0)
    assert.equal(summary.unknown, 1)
    assert.equal(second.ledger.read().messages[0].status, 'unknown')
    assert.equal(secondAdapter.deliveries.length, 0)
    assert.equal(second.ledger.read().messages[0].durableMessageId, 'host-interrupted')
  } finally {
    await second.engine.dispose()
    await second.ledger.close()
  }
})

test('cold recovery accepts only matching durable id plus standard source evidence', async (t) => {
  const clock = new FakeClock()
  const root = await tempRoot()
  const adapter = new MemoryAdapter({ clock })
  const first = await openEngine({ root, adapter, clock })
  const sent = await first.engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'interrupted request',
    operationId: operation(first.engine),
  })
  const messageId = sent.results[0].id
  await first.ledger.mutate((state) => {
    const message = state.messages.find((candidate) => candidate.id === messageId)
    message.status = 'dispatching'
    message.acceptedAt = null
    message.deadlineAt = null
    message.replyStatus = 'none'
    message.durableMessageId = 'host-recovered'
  })
  await first.engine.dispose()
  await first.ledger.close()

  const secondAdapter = new MemoryAdapter({ clock, sessions: adapter.sessions })
  secondAdapter.markInserted('B', 'host-recovered', 'A')
  const second = await openEngine({ root, adapter: secondAdapter, clock })
  try {
    const summary = await second.engine.start()
    assert.equal(summary.recovered, 1)
    const recovered = second.ledger.read().messages[0]
    assert.equal(recovered.status, 'accepted')
    assert.equal(recovered.recoveryEvidence, 'message')
    assert.equal(recovered.replyStatus, 'waiting')
    assert.ok(Number.isSafeInteger(recovered.deadlineAt))
  } finally {
    await second.engine.dispose()
    await second.ledger.close()
  }
})

test('an identity conflict in recovery evidence is unknown, not accepted', async (t) => {
  const clock = new FakeClock()
  const root = await tempRoot()
  const adapter = new MemoryAdapter({ clock })
  const first = await openEngine({ root, adapter, clock })
  const sent = await first.engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'conflict',
    operationId: operation(first.engine),
  })
  await first.ledger.mutate((state) => {
    const message = state.messages[0]
    message.status = 'dispatching'
    message.durableMessageId = 'host-conflict'
  })
  await first.engine.dispose()
  await first.ledger.close()

  const secondAdapter = new MemoryAdapter({ clock, sessions: adapter.sessions })
  secondAdapter.readEvidence = async () => ({ found: false, readable: true, identityConflict: true })
  const second = await openEngine({ root, adapter: secondAdapter, clock })
  try {
    const summary = await second.engine.start()
    assert.equal(summary.unknown, 1)
    assert.equal(second.ledger.read().messages[0].status, 'unknown')
    assert.equal(second.ledger.read().messages[0].error.code, 'identity_conflict')
  } finally {
    await second.engine.dispose()
    await second.ledger.close()
  }
})

test('a reply arriving while the request is dispatching upgrades it with host evidence', async (t) => {
  const clock = new FakeClock()
  const root = await tempRoot()
  class EarlyReplyAdapter extends MemoryAdapter {
    async deliver(request) {
      const built = this.built.get(request.hostMessage.id)
      if (built.kind === 'reply') return super.deliver(request)
      this.deliveries.push({ targetId: request.targetId, message: built })
      const before = await request.beforeResolve()
      if (before?.ok !== true) return { stage: 'blocked', blocked: before }
      const gate = await request.beforeFollowup()
      if (gate?.ok !== true) return { stage: 'blocked', blocked: gate }
      this.markInserted(request.targetId, request.hostMessage.id, built.from)
      await this.engine.reply({
        from: 'B',
        messageId: built.id,
        text: 'early explicit reply',
        operationId: this.engine.mintOperation().operationId,
      })
      return { stage: 'flush', flush: false, error: { code: 'flush_false' } }
    }
  }
  const adapter = new EarlyReplyAdapter({ clock })
  const opened = await openEngine({ root, adapter, clock })
  adapter.engine = opened.engine
  t.after(async () => {
    await opened.engine.dispose()
    await opened.ledger.close()
  })
  const sent = await opened.engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'reply before flush',
    operationId: operation(opened.engine),
  })
  const state = opened.ledger.read()
  const request = state.messages.find((message) => message.id === sent.results[0].id)
  const reply = state.messages.find((message) => message.kind === 'reply')
  assert.equal(request.status, 'accepted')
  assert.equal(request.replyStatus, 'answered')
  assert.equal(request.recoveryEvidence, 'reply')
  assert.equal(reply.status, 'accepted')
  assert.equal(reply.parentMessageId, request.id)
})

test('recheck can accept evidence later and manual resolution never retries', async (t) => {
  const { engine, ledger, adapter, clock } = await setup(t)
  adapter.flushResult = false
  const sent = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'unknown',
    operationId: operation(engine),
  })
  const id = sent.results[0].id
  adapter.markInserted('B', ledger.read().messages[0].durableMessageId, 'A')
  const rechecked = await engine.ownerControl({
    expectedRevision: ledger.read().revision,
    action: 'recheck',
    id,
  })
  assert.equal(rechecked.status, 'accepted')
  assert.equal(ledger.read().messages[0].status, 'accepted')

  const secondSetup = await setup(t)
  secondSetup.adapter.flushResult = false
  const unknown = await secondSetup.engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'close unknown',
    operationId: operation(secondSetup.engine),
  })
  await secondSetup.engine.ownerControl({
    expectedRevision: secondSetup.ledger.read().revision,
    action: 'resolve_unknown',
    id: unknown.results[0].id,
    resolution: 'closed',
  })
  const resolved = secondSetup.ledger.read().messages[0]
  assert.equal(resolved.status, 'cancelled')
  assert.equal(resolved.resolution, 'unconfirmed')
  assert.equal(resolved.unconfirmedBy, 'owner')
  assert.equal(secondSetup.adapter.deliveries.length, 1)
})

test('retention redacts completed notification/reply/request bodies but never unknown', async (t) => {
  const { engine, ledger, adapter, clock } = await setup(t)
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { retentionDays: 1 },
  })
  const notification = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'notification body',
    operationId: operation(engine),
  })
  const request = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'request body',
    operationId: operation(engine),
  })
  const reply = await engine.reply({
    from: 'B',
    messageId: request.results[0].id,
    text: 'reply body',
    operationId: operation(engine),
  })
  assert.equal(reply.results[0].status, 'accepted')

  const unknownAdapter = new MemoryAdapter({ clock, sessions: adapter.sessions })
  const unknownRoot = await tempRoot()
  const unknown = await openEngine({ root: unknownRoot, adapter: unknownAdapter, clock })
  t.after(async () => {
    await unknown.engine.dispose()
    await unknown.ledger.close()
  })
  unknownAdapter.flushResult = false
  const unknownSent = await unknown.engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'unknown body must stay',
    operationId: operation(unknown.engine),
  })
  clock.advance(2 * 24 * 60 * 60 * 1000)
  await engine.tick()
  await unknown.engine.tick()
  const state = ledger.read()
  assert.equal(state.messages.find((message) => message.id === notification.results[0].id).content.text, '')
  assert.equal(state.messages.find((message) => message.id === request.results[0].id).content.text, '')
  assert.equal(state.messages.find((message) => message.id === reply.results[0].id).content.text, '')
  assert.equal(state.messages.find((message) => message.id === request.results[0].id).redactedAt !== undefined, true)
  const unknownMessage = unknown.ledger.read().messages.find((message) => message.id === unknownSent.results[0].id)
  assert.equal(unknownMessage.status, 'unknown')
  assert.equal(unknownMessage.content.text, 'unknown body must stay')
  assert.equal(unknownMessage.redactedAt, undefined)
})

test('an accepted request waiting for a reply is not metadata-pruned at 90 days', async (t) => {
  const { engine, ledger, clock } = await setup(t)
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { requestTimeoutMs: 200 * 24 * 60 * 60 * 1000, retentionDays: 30 },
  })
  const request = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'still waiting',
    operationId: operation(engine),
  })
  clock.advance(100 * 24 * 60 * 60 * 1000)
  await engine.tick()
  const waiting = ledger.read().messages.find((message) => message.id === request.results[0].id)
  assert.ok(waiting, 'waiting request must be retained')
  assert.equal(waiting.replyStatus, 'waiting')
  assert.equal(waiting.completedAt, null)
  assert.equal(waiting.content.text, 'still waiting')
  assert.equal(waiting.redactedAt, undefined)
})

test('explicit close completes a waiting request at closedAt without faking an answer, and keeps closed unknown', async (t) => {
  const { engine, ledger, adapter, clock } = await setup(t)
  const request = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'close waiting',
    operationId: operation(engine),
  })
  const requestId = request.results[0].id
  await engine.ownerControl({
    expectedRevision: ledger.read().revision,
    action: 'close',
    id: request.chainId,
  })
  const closedAt = ledger.read().chains[request.chainId].closedAt
  const completed = ledger.read().messages.find((message) => message.id === requestId)
  assert.equal(completed.status, 'accepted')
  assert.equal(completed.replyStatus, 'waiting')
  assert.equal(completed.completedAt, closedAt)
  assert.equal(completed.completedReason, 'chain_closed')
  assert.equal(completed.answeredAt, undefined)
  assert.equal(completed.answeredBy, undefined)

  adapter.flushResult = false
  const unknown = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'closed unknown',
    operationId: operation(engine),
  })
  const unknownId = unknown.results[0].id
  assert.equal(unknown.results[0].status, 'unknown')
  await engine.ownerControl({
    expectedRevision: ledger.read().revision,
    action: 'close',
    id: unknown.chainId,
  })
  assert.equal(ledger.read().messages.find((message) => message.id === unknownId).status, 'unknown')

  clock.advance(100 * 24 * 60 * 60 * 1000)
  await engine.tick()
  const state = ledger.read()
  assert.equal(state.messages.find((message) => message.id === requestId), undefined)
  assert.equal(state.chains[request.chainId], undefined)
  const retainedUnknown = state.messages.find((message) => message.id === unknownId)
  assert.ok(retainedUnknown, 'closed unknown must never be cleaned')
  assert.equal(retainedUnknown.status, 'unknown')
  assert.equal(retainedUnknown.content.text, 'closed unknown')
})

test('a closed waiting request without completedAt falls back to chain.closedAt', async (t) => {
  const { engine, ledger, clock } = await setup(t)
  const sent = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'closed without derived completion',
    operationId: operation(engine),
  })
  const closedAt = clock.read()
  await ledger.mutate((state) => {
    const chain = state.chains[sent.chainId]
    chain.state = 'closed'
    chain.closedAt = closedAt
    const message = state.messages.find((candidate) => candidate.id === sent.results[0].id)
    message.completedAt = null
  })
  clock.advance(100 * 24 * 60 * 60 * 1000)
  await engine.tick()
  assert.equal(ledger.read().messages.find((message) => message.id === sent.results[0].id), undefined)
})

test('a request waiting for 30 days is retained for 365 days after it is answered', async (t) => {
  const { engine, ledger, clock } = await setup(t)
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { retentionDays: 365, requestTimeoutMs: 40 * 24 * 60 * 60 * 1000 },
  })
  const request = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'long wait',
    operationId: operation(engine),
  })
  clock.advance(30 * 24 * 60 * 60 * 1000)
  await engine.tick()
  assert.equal(ledger.read().messages.find((message) => message.id === request.results[0].id).replyStatus, 'waiting')
  await engine.reply({ from: 'B', messageId: request.results[0].id, text: 'late but timely', operationId: operation(engine) })
  clock.advance(90 * 24 * 60 * 60 * 1000)
  await engine.tick()
  const after90 = ledger.read().messages.find((message) => message.id === request.results[0].id)
  assert.ok(after90, '90 days after completion must not delete a 365-day retention group')
  assert.equal(after90.content.text, 'long wait')
  clock.advance(276 * 24 * 60 * 60 * 1000)
  await engine.tick()
  const after366 = ledger.read().messages.find((message) => message.id === request.results[0].id)
  assert.equal(after366 === undefined || after366.content.text === '', true)
})

test('enabled=false rejects new sends while list/status remain readable; paused holds', async (t) => {
  const { engine, ledger, adapter } = await setup(t)
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { enabled: false },
  })
  await assert.rejects(
    engine.send({ from: 'A', targets: ['B'], kind: 'notification', text: 'disabled', operationId: operation(engine) }),
    (error) => error.code === 'disabled',
  )
  assert.equal((await engine.snapshot({})).messages.length, 0)
  assert.equal((await engine.list({})).sessions.length >= 2, true)

  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { enabled: true, paused: true },
  })
  const held = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'paused',
    operationId: operation(engine),
  })
  assert.equal(held.results[0].status, 'held')
  assert.equal(adapter.deliveries.length, 0)
})
