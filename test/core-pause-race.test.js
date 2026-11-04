import test from 'node:test'
import assert from 'node:assert/strict'

import { FakeClock, MemoryAdapter, openEngine, sessionFixture, tempRoot } from './helpers.js'

async function setup(t) {
  const clock = new FakeClock()
  const root = await tempRoot()
  const sessions = [sessionFixture({ id: 'A' }), sessionFixture({ id: 'B' }), sessionFixture({ id: 'C' })]
  const adapter = new MemoryAdapter({ clock, sessions })
  const opened = await openEngine({ root, adapter, clock })
  t.after(async () => {
    await opened.engine.dispose()
    await opened.ledger.close()
  })
  return { ...opened, clock, adapter, sessions }
}

/** Delay one target getSession while a delivery is dispatching. */
function blockOneGateRead(adapter, ledger) {
  let release
  let enteredResolve
  const entered = new Promise((resolve) => {
    enteredResolve = resolve
  })
  const original = adapter.getSession.bind(adapter)
  let blocked = false
  adapter.getSession = async (id, options) => {
    const dispatching = ledger.read().messages.some(
      (message) => message.status === 'dispatching' && message.to === id,
    )
    if (!blocked && dispatching) {
      blocked = true
      enteredResolve()
      await new Promise((resolve) => {
        release = resolve
      })
    }
    return original(id, options)
  }
  return {
    entered,
    release: () => release(),
  }
}

test('a pause acknowledged while getSession is in flight prevents followup and auto-resumes', async (t) => {
  const { engine, ledger, adapter, clock } = await setup(t)
  const gate = blockOneGateRead(adapter, ledger)
  const sending = engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'pause during eligibility read',
    operationId: engine.mintOperation().operationId,
  })
  await gate.entered
  const paused = await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { paused: true },
  })
  assert.equal(paused.settings.paused, true)
  gate.release()
  const result = await sending
  assert.equal(result.results[0].status, 'held')
  assert.equal(adapter.inserted.size, 0, 'no host insertion may follow the acknowledged pause')

  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { paused: false },
  })
  await engine.drain()
  assert.equal(ledger.read().messages[0].status, 'accepted')
})

test('the synchronous commit gate blocks a pause committed after the async gate resolved', async (t) => {
  const { engine, ledger, adapter } = await setup(t)
  let committed = false
  adapter.deliver = async (request) => {
    const before = await request.beforeResolve()
    if (before?.ok !== true) return { stage: 'blocked', blocked: before }
    const gate = await request.beforeFollowup()
    if (gate?.ok !== true) return { stage: 'blocked', blocked: gate }
    const built = adapter.built.get(request.hostMessage.id)
    await engine.updateSettings({
      expectedSettingsRevision: ledger.read().settingsRevision,
      patch: { paused: true },
    })
    const result = gate.commit(() => {
      committed = true
      adapter.markInserted(request.targetId, request.hostMessage.id, built.from)
    })
    if (result.ok !== true) return { stage: 'blocked', blocked: result.blocked }
    return { stage: 'accepted' }
  }
  const result = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'commit gate',
    operationId: engine.mintOperation().operationId,
  })
  assert.equal(result.results[0].status, 'held')
  assert.equal(committed, false, 'the commit callback must not run after the pause')
  assert.equal(adapter.inserted.size, 0)
})

test('disabled during an in-flight delivery becomes held(disabled) and re-enable auto-resumes', async (t) => {
  const { engine, ledger, adapter } = await setup(t)
  const gate = blockOneGateRead(adapter, ledger)
  const sending = engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'disable during eligibility read',
    operationId: engine.mintOperation().operationId,
  })
  await gate.entered
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { enabled: false },
  })
  gate.release()
  const result = await sending
  assert.equal(result.results[0].status, 'held')
  assert.equal(ledger.read().messages[0].heldReason, 'disabled')
  assert.equal(adapter.inserted.size, 0)

  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { enabled: true },
  })
  await engine.drain()
  assert.equal(ledger.read().messages[0].status, 'accepted')
})

test('pausing converts waiting pending slots to held and reports the queued count', async (t) => {
  const { engine, ledger, adapter } = await setup(t)
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { maxConcurrent: 1 },
  })
  let release
  let enteredResolve
  const entered = new Promise((resolve) => {
    enteredResolve = resolve
  })
  const originalDeliver = adapter.deliver.bind(adapter)
  adapter.deliver = async (request) => {
    if (request.targetId === 'B') {
      const before = await request.beforeResolve()
      if (before?.ok !== true) return { stage: 'blocked', blocked: before }
      enteredResolve()
      await new Promise((resolve) => {
        release = resolve
      })
    }
    return originalDeliver(request)
  }
  const sending = engine.send({
    from: 'A',
    targets: ['B', 'C'],
    kind: 'notification',
    text: 'waiting slots',
    operationId: engine.mintOperation().operationId,
  })
  await entered
  const paused = await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { paused: true },
  })
  assert.equal(paused.queued, 1, 'the second target was pending and must be moved to held')
  release()
  const result = await sending
  assert.equal(result.results.every((entry) => entry.status === 'held'), true)
  adapter.deliver = originalDeliver
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { paused: false },
  })
  await engine.drain()
  assert.equal(ledger.read().messages.every((message) => message.status === 'accepted'), true)
})

test('disabling converts waiting pending slots to held(disabled) and re-enable auto-resumes', async (t) => {
  const { engine, ledger, adapter } = await setup(t)
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { maxConcurrent: 1 },
  })
  let release
  let enteredResolve
  const entered = new Promise((resolve) => {
    enteredResolve = resolve
  })
  const originalDeliver = adapter.deliver.bind(adapter)
  adapter.deliver = async (request) => {
    if (request.targetId === 'B') {
      const before = await request.beforeResolve()
      if (before?.ok !== true) return { stage: 'blocked', blocked: before }
      enteredResolve()
      await new Promise((resolve) => {
        release = resolve
      })
    }
    return originalDeliver(request)
  }
  const sending = engine.send({
    from: 'A',
    targets: ['B', 'C'],
    kind: 'notification',
    text: 'waiting while disabled',
    operationId: engine.mintOperation().operationId,
  })
  await entered
  const disabled = await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { enabled: false },
  })
  assert.equal(disabled.queued, 1, 'the pending slot must become held in the same mutation')
  release()
  const result = await sending
  assert.equal(result.results.every((entry) => entry.status === 'held'), true)
  assert.equal(ledger.read().messages.every((message) => message.status === 'held'), true)
  assert.equal(ledger.read().messages.every((message) => message.heldReason === 'disabled'), true)
  assert.equal(adapter.inserted.size, 0)
  adapter.deliver = originalDeliver
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { enabled: true },
  })
  await engine.drain()
  assert.equal(ledger.read().messages.every((message) => message.status === 'accepted'), true)
})

test('paused new sends are held and resume dispatches them without any release', async (t) => {
  const { engine, ledger, adapter } = await setup(t)
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { paused: true },
  })
  const sent = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'queued',
    operationId: engine.mintOperation().operationId,
  })
  assert.equal(sent.results[0].status, 'held')
  assert.equal(adapter.deliveries.length, 0)
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { paused: false },
  })
  await engine.drain()
  const state = ledger.read()
  assert.equal(state.messages[0].status, 'accepted')
  assert.equal(state.messages[0].replyStatus, 'waiting')
})
