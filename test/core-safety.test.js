import test from 'node:test'
import assert from 'node:assert/strict'

import { FakeClock, MemoryAdapter, openEngine, receiptFixture, sessionFixture, tempRoot } from './helpers.js'

async function setup(t, options = {}) {
  const clock = new FakeClock()
  const root = await tempRoot()
  const sessions = options.sessions ?? [
    sessionFixture({ id: 'A' }),
    sessionFixture({ id: 'B' }),
    sessionFixture({ id: 'C' }),
    sessionFixture({ id: 'D' }),
  ]
  const adapter = new MemoryAdapter({ clock, sessions })
  const { ledger, engine } = await openEngine({ root, adapter, clock, limits: options.limits })
  t.after(async () => {
    await engine.dispose()
    await ledger.close()
  })
  return { clock, adapter, ledger, engine, sessions }
}

function op(engine) {
  return engine.mintOperation().operationId
}

async function waitFor(predicate, label) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 2500) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setImmediate(resolve))
  }
}

test('archived targets are rejected before any record is created', async (t) => {
  const sessions = [
    sessionFixture({ id: 'A' }),
    sessionFixture({ id: 'B', archived: true, eligible: false }),
  ]
  const { engine, adapter, ledger } = await setup(t, { sessions })
  await assert.rejects(
    engine.send({ from: 'A', targets: ['B'], kind: 'notification', text: 'no', operationId: op(engine) }),
    (error) => error.code === 'target_archived',
  )
  assert.equal(ledger.read().messages.length, 0)
  assert.equal(adapter.deliveries.length, 0)
})

test('the default three channels are reached and a lowering cannot create a fourth attempt', async (t) => {
  const { engine, adapter } = await setup(t)
  let active = 0
  let peak = 0
  let release
  const overlap = new Promise((resolve) => {
    release = resolve
  })
  adapter.deliver = async (request) => {
    const before = await request.beforeResolve()
    if (before?.ok !== true) return { stage: 'blocked', blocked: before }
    const gate = await request.beforeFollowup()
    if (gate?.ok !== true) return { stage: 'blocked', blocked: gate }
    active += 1
    peak = Math.max(peak, active)
    if (active >= 3) release()
    await Promise.race([overlap, new Promise((resolve) => setTimeout(resolve, 1500))])
    const message = adapter.built.get(request.hostMessage.id)
    adapter.markInserted(request.targetId, request.hostMessage.id, message?.from)
    active -= 1
    return { stage: 'accepted' }
  }
  const sent = await engine.send({
    from: 'A',
    targets: ['B', 'C', 'D'],
    kind: 'notification',
    text: 'concurrent',
    operationId: op(engine),
  })
  assert.equal(sent.results.every((entry) => entry.status === 'accepted'), true)
  assert.equal(peak, 3)
})

test('channels are dynamically 1 and 10, and ten parallel attempts are possible', async (t) => {
  const sessions = [sessionFixture({ id: 'A' }), ...Array.from({ length: 10 }, (_, index) => sessionFixture({ id: `T${index}` }))]
  const { engine, adapter, ledger } = await setup(t, { sessions })
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { maxConcurrent: 1 },
  })
  let active = 0
  let peak = 0
  let release
  const barrier = new Promise((resolve) => {
    release = resolve
  })
  adapter.deliver = async (request) => {
    const before = await request.beforeResolve()
    if (before?.ok !== true) return { stage: 'blocked', blocked: before }
    const gate = await request.beforeFollowup()
    if (gate?.ok !== true) return { stage: 'blocked', blocked: gate }
    active += 1
    peak = Math.max(peak, active)
    if (active >= 10) release()
    await Promise.race([barrier, new Promise((resolve) => setTimeout(resolve, 1500))])
    const message = adapter.built.get(request.hostMessage.id)
    adapter.markInserted(request.targetId, request.hostMessage.id, message?.from)
    active -= 1
    return { stage: 'accepted' }
  }
  const one = await engine.send({
    from: 'A',
    targets: ['T0'],
    kind: 'notification',
    text: 'one channel',
    operationId: op(engine),
  })
  assert.equal(one.results[0].status, 'accepted')
  assert.equal(peak, 1)
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { maxConcurrent: 10 },
  })
  const ten = await engine.send({
    from: 'A',
    targets: Array.from({ length: 10 }, (_, index) => `T${index}`),
    kind: 'notification',
    text: 'ten channels',
    operationId: op(engine),
  })
  assert.equal(ten.results.length, 10)
  assert.equal(ten.results.every((entry) => entry.status === 'accepted'), true)
  assert.equal(peak, 10)
})


test('raising channels wakes slot waiters before the blocked host attempt releases, and lowering does not over-admit', async (t) => {
  const sessions = [sessionFixture({ id: 'A' }), ...Array.from({ length: 11 }, (_, index) => sessionFixture({ id: `T${index}` }))]
  const { engine, adapter, ledger } = await setup(t, { sessions })
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { maxConcurrent: 1 },
  })
  let active = 0
  let started = 0
  let peak = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const originalDeliver = adapter.deliver.bind(adapter)
  adapter.deliver = async (request) => {
    started += 1
    active += 1
    peak = Math.max(peak, active)
    await gate
    try {
      return await originalDeliver(request)
    } finally {
      active -= 1
    }
  }
  t.after(() => release())

  const sends = Array.from({ length: 10 }, (_, index) => engine.send({
    from: 'A',
    targets: [`T${index}`],
    kind: 'notification',
    text: `slot ${index}`,
    operationId: op(engine),
  }))
  await waitFor(() => started === 1, 'the first host attempt must enter')
  assert.equal(active, 1)
  assert.equal(ledger.read().messages.filter((message) => message.status === 'dispatching').length, 1)
  assert.equal(ledger.read().messages.filter((message) => message.status === 'pending').length, 9)

  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { maxConcurrent: 10 },
  })
  await waitFor(() => active === 10, 'raising the cap must release all nine waiting slots')
  assert.equal(peak, 10)

  const extra = engine.send({
    from: 'A',
    targets: ['T10'],
    kind: 'notification',
    text: 'lowered while active',
    operationId: op(engine),
  })
  await waitFor(() => ledger.read().messages.find((message) => message.to === 'T10')?.status === 'pending', 'the extra send must be pending')
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { maxConcurrent: 1 },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started, 10, 'lowering must not admit the extra waiter while ten attempts are in flight')
  assert.equal(active, 10)

  release()
  const results = await Promise.all([...sends, extra])
  assert.equal(results.every((result) => result.results[0].status === 'accepted'), true)
  assert.equal(started, 11)
  assert.equal(peak, 10)
  assert.equal(ledger.read().settings.maxConcurrent, 1)
})

test('lowering the channel count does not withdraw already in-flight attempts', async (t) => {
  const { engine, adapter, ledger } = await setup(t)
  let active = 0
  let peak = 0
  let release
  let reachedResolve
  const reached = new Promise((resolve) => {
    reachedResolve = resolve
  })
  const barrier = new Promise((resolve) => {
    release = resolve
  })
  adapter.deliver = async (request) => {
    const before = await request.beforeResolve()
    if (before?.ok !== true) return { stage: 'blocked', blocked: before }
    const gate = await request.beforeFollowup()
    if (gate?.ok !== true) return { stage: 'blocked', blocked: gate }
    active += 1
    peak = Math.max(peak, active)
    if (active >= 3) reachedResolve()
    await Promise.race([barrier, new Promise((resolve) => setTimeout(resolve, 1500))])
    const message = adapter.built.get(request.hostMessage.id)
    adapter.markInserted(request.targetId, request.hostMessage.id, message?.from)
    active -= 1
    return { stage: 'accepted' }
  }
  const sending = engine.send({
    from: 'A',
    targets: ['B', 'C', 'D'],
    kind: 'notification',
    text: 'in flight before lowering',
    operationId: op(engine),
  })
  await reached
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { maxConcurrent: 1 },
  })
  release()
  const sent = await sending
  assert.equal(sent.results.every((entry) => entry.status === 'accepted'), true)
  assert.equal(peak, 3)
  assert.equal(ledger.read().settings.maxConcurrent, 1)
})

test('hop is derived from the parent and cannot be supplied by the caller', async (t) => {
  const { engine } = await setup(t)
  await assert.rejects(
    engine.send({ from: 'A', targets: ['B'], kind: 'notification', text: 'spoof', operationId: op(engine), hop: 0 }),
    (error) => error.code === 'tool_args',
  )
})

test('recovery accepts an inbox-only insertion and records the inbox evidence', async (t) => {
  const clock = new FakeClock()
  const root = await tempRoot()
  const adapter = new MemoryAdapter({ clock })
  const first = await openEngine({ root, adapter, clock })
  await first.ledger.mutate((state) => {
    state.chains['c-recover'] = {
      id: 'c-recover',
      rootOwner: 'A',
      createdAt: clock.read(),
      state: 'open',
      messageCount: 1,
    }
    state.messages.push({
      id: 'm-recover',
      operationId: 'slop:1:123e4567-e89b-42d3-a456-426614174000',
      from: 'A',
      to: 'B',
      kind: 'notification',
      chainId: 'c-recover',
      hop: 0,
      createdAt: clock.read(),
      acceptedAt: null,
      deadlineAt: null,
      content: { text: 'x', references: [], paths: [] },
      contentBytes: 1,
      status: 'dispatching',
      replyStatus: 'none',
      receipt: receiptFixture(),
      deliveryAttempts: 1,
      durableMessageId: 'host-inbox',
      error: null,
    })
  })
  await first.engine.dispose()
  await first.ledger.close()

  const secondAdapter = new MemoryAdapter({ clock, sessions: adapter.sessions })
  secondAdapter.readEvidence = async () => ({
    found: true,
    readable: true,
    evidence: 'inbox',
    inboxSeen: true,
  })
  const second = await openEngine({ root, adapter: secondAdapter, clock })
  try {
    await second.engine.start()
    const message = second.ledger.read().messages[0]
    assert.equal(message.status, 'accepted')
    assert.equal(message.recoveryEvidence, 'inbox')
    assert.equal(message.inboxSeen, true)
  } finally {
    await second.engine.dispose()
    await second.ledger.close()
  }
})
