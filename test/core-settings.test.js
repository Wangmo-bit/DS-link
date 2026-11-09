import test from 'node:test'
import assert from 'node:assert/strict'

import { FakeClock, MemoryAdapter, openEngine, sessionFixture, tempRoot } from './helpers.js'

async function setup(t, options = {}) {
  const clock = new FakeClock()
  const root = await tempRoot()
  const adapter = new MemoryAdapter({
    clock,
    sessions: options.sessions ?? [sessionFixture({ id: 'A' }), sessionFixture({ id: 'B' }), sessionFixture({ id: 'C' })],
  })
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

test('message activity changes ledger revision but never settingsRevision', async (t) => {
  const { engine, ledger } = await setup(t)
  const before = await engine.snapshot({})
  await engine.send({ from: 'A', targets: ['B'], kind: 'notification', text: 'activity', operationId: op(engine) })
  const after = await engine.snapshot({})
  assert.equal(after.settingsRevision, before.settingsRevision)
  assert.ok(after.revision > before.revision)
  assert.equal(ledger.read().settingsRevision, 1)
})

test('settings CAS accepts exactly one expectedSettingsRevision and rejects old/mixed parameters', async (t) => {
  const { engine, ledger } = await setup(t)
  const current = ledger.read()
  await assert.rejects(
    engine.updateSettings({ patch: { paused: true } }),
    (error) => error.code === 'invalid_argument',
  )
  await assert.rejects(
    engine.updateSettings({ expectedRevision: current.revision, patch: { paused: true } }),
    (error) => error.code === 'invalid_argument',
  )
  await assert.rejects(
    engine.updateSettings({
      expectedSettingsRevision: current.settingsRevision,
      expectedRevision: current.revision,
      patch: { paused: true },
    }),
    (error) => error.code === 'invalid_argument',
  )
  await assert.rejects(
    engine.updateSettings({ expectedSettingsRevision: current.settingsRevision, patch: { maxMessages: 7 } }),
    (error) => error.code === 'policy_removed' && error.details.removedKeys.includes('maxMessages'),
  )
  await assert.rejects(
    engine.updateSettings({ expectedRevision: current.revision, patch: { maxMessages: 7 } }),
    (error) => error.code === 'policy_removed' && error.details.removedKeys.includes('maxMessages'),
  )
  const beforeNoop = ledger.read()
  const noop = await engine.updateSettings({
    expectedSettingsRevision: beforeNoop.settingsRevision,
    patch: { paused: false },
  })
  assert.equal(noop.revision, beforeNoop.revision)
  assert.equal(noop.settingsRevision, beforeNoop.settingsRevision)
  assert.equal(noop.queued, 0)
  assert.equal(noop.resumed, 0)
})

test('paused/releasable flags distinguish automatic global held, group held, and legacy manual held', async (t) => {
  const { engine, ledger } = await setup(t)
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { paused: true },
  })
  const held = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'global held',
    operationId: op(engine),
  })
  let snapshot = await engine.snapshot({})
  let message = snapshot.messages.find((entry) => entry.id === held.results[0].id)
  assert.equal(message.status, 'held')
  assert.equal(message.releasable, false)

  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { paused: false },
  })
  await engine.drain()
  snapshot = await engine.snapshot({})
  assert.equal(snapshot.messages.find((entry) => entry.id === held.results[0].id).status, 'accepted')

  // A held row on a paused chain stays held and is not releasable.
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { paused: true },
  })
  const groupHeld = await engine.send({
    from: 'A',
    targets: ['C'],
    kind: 'notification',
    text: 'group held',
    operationId: op(engine),
  })
  await engine.ownerControl({
    expectedRevision: ledger.read().revision,
    action: 'pause',
    id: groupHeld.chainId,
  })
  message = (await engine.snapshot({})).messages.find((entry) => entry.id === groupHeld.results[0].id)
  assert.equal(message.releasable, false)
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { paused: false },
  })
  assert.equal((await engine.snapshot({})).messages.find((entry) => entry.id === groupHeld.results[0].id).status, 'held')
  await engine.ownerControl({ expectedRevision: ledger.read().revision, action: 'resume', id: groupHeld.chainId })
  await engine.drain()
  assert.equal(ledger.read().messages.find((entry) => entry.id === groupHeld.results[0].id).status, 'accepted')

  // Unknown legacy reason: no automatic release, but owner release is allowed.
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { paused: true },
  })
  const legacy = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'legacy held',
    operationId: op(engine),
  })
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { paused: false },
  })
  await engine.drain()
  await ledger.mutate((state) => {
    const entry = state.messages.find((candidate) => candidate.id === legacy.results[0].id)
    entry.status = 'held'
    entry.heldReason = 'legacy_mystery'
    entry.heldAt = engine.clock()
    entry.error = { code: 'legacy_mystery', message: 'legacy' }
  })
  message = (await engine.snapshot({})).messages.find((entry) => entry.id === legacy.results[0].id)
  assert.equal(message.releasable, true)
  await engine.ownerControl({ expectedRevision: ledger.read().revision, action: 'release', id: legacy.results[0].id })
  await engine.drain()
  assert.equal(ledger.read().messages.find((entry) => entry.id === legacy.results[0].id).status, 'accepted')
})

test('snapshot exposes v2 contract, computed storage, and no active budget fields', async (t) => {
  const { engine, ledger } = await setup(t, { limits: { maxQueuedBytes: 700, maxDiskBytes: 50_000 } })
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { paused: true },
  })
  const held = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'x'.repeat(600),
    operationId: op(engine),
  })
  const snapshot = await engine.snapshot({})
  assert.equal(snapshot.apiVersion, 3)
  assert.equal(snapshot.version, '0.8.16-pre.5')
  assert.deepEqual(Object.keys(snapshot.settings).sort(), ['enabled', 'maxConcurrent', 'paused', 'requestTimeoutMs', 'retentionDays'])
  assert.equal(snapshot.budget, undefined)
  assert.deepEqual(snapshot.budgetLatches, [])
  assert.equal(snapshot.storage.queuedBytes, ledger.read().messages[0].contentBytes)
  assert.equal(snapshot.storage.maxQueuedBytes, 700)
  assert.equal(snapshot.storage.health, 'near_capacity')
  assert.equal(snapshot.technicalLimits.maxContentBytes, 64 * 1024)
  assert.equal(snapshot.technicalLimits.maxCallBytes, 1024 * 1024)
  assert.equal(snapshot.technicalLimits.historyPageMax, 20)
  assert.equal(snapshot.technicalLimits.listPageMax, 50)
  assert.equal(snapshot.technicalLimits.snapshotPageMax, 100)
  assert.equal(snapshot.technicalLimits.operationFirstSubmitMs, 24 * 60 * 60 * 1000)
  assert.equal(snapshot.technicalLimits.operationRetentionMs, 90 * 24 * 60 * 60 * 1000)
  assert.equal(snapshot.technicalLimits.maxLedgerBytes, 50_000)
  assert.equal(snapshot.technicalLimits.maxQueuedBytes, 700)
  assert.equal(snapshot.messages.find((entry) => entry.id === held.results[0].id).releasable, false)
  const status = await engine.status({ from: 'A' })
  assert.deepEqual(status.budgetLatches, [])
  assert.equal(status.hasMore, false)
  assert.equal(status.total, 1)
})

test('a settings timeout change never rewrites an already accepted request deadline', async (t) => {
  const { engine, ledger, clock } = await setup(t)
  const first = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'old deadline',
    operationId: op(engine),
  })
  const originalDeadline = ledger.read().messages.find((entry) => entry.id === first.results[0].id).deadlineAt
  clock.advance(1000)
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { requestTimeoutMs: 48 * 60 * 60 * 1000 },
  })
  assert.equal(ledger.read().messages.find((entry) => entry.id === first.results[0].id).deadlineAt, originalDeadline)
  const second = await engine.send({
    from: 'A',
    targets: ['C'],
    kind: 'request',
    text: 'new deadline',
    operationId: op(engine),
  })
  const acceptedAt = ledger.read().messages.find((entry) => entry.id === second.results[0].id).acceptedAt
  assert.equal(
    ledger.read().messages.find((entry) => entry.id === second.results[0].id).deadlineAt,
    acceptedAt + 48 * 60 * 60 * 1000,
  )
})


test('settings-view snapshot skips session discovery and the message page', async (t) => {
  const { adapter, engine } = await setup(t)
  let listCalls = 0
  const original = adapter.listSessions.bind(adapter)
  adapter.listSessions = async (...args) => { listCalls += 1; return original(...args) }
  const light = await engine.snapshot({ view: 'settings' })
  assert.equal(light.messages, undefined)
  assert.equal(light.sessions.length, 0)
  assert.equal(light.total, 0)
  assert.equal(listCalls, 0)
  const full = await engine.snapshot({})
  assert.ok(Array.isArray(full.messages))
  assert.equal(listCalls, 1)
})


test('records view skips session discovery while sessions view loads only the roster', async (t) => {
  const { adapter, engine } = await setup(t)
  let listCalls = 0
  const original = adapter.listSessions.bind(adapter)
  adapter.listSessions = async (...args) => { listCalls += 1; return original(...args) }
  const records = await engine.snapshot({ view: 'records', limit: 20 })
  assert.ok(Array.isArray(records.messages))
  assert.equal(records.sessions.length, 0)
  assert.equal(listCalls, 0, 'records first page must not wait for session discovery')
  const sessions = await engine.snapshot({ view: 'sessions' })
  assert.ok(sessions.sessions.length > 0)
  assert.equal(sessions.messages, undefined)
  assert.equal(listCalls, 1)
})
