import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { Ledger } from '../src/core/ledger.js'
import {
  STATE_VERSION,
  V1_BACKUP_PREFIX,
  V2_BACKUP_PREFIX,
  V2_ROLLBACK_BACKUP_PREFIX,
  V3_ROLLBACK_BACKUP_PREFIX,
} from '../src/core/constants.js'
import { validateV2State } from '../src/core/ledger.js'
import {
  migrateV1State,
  migrateV2State,
  rollbackPreflight,
  sha256,
  v3ToV2Preflight,
  validateV1State,
} from '../src/core/migration.js'
import { FakeClock, MemoryAdapter, openEngine, receiptFixture, sessionFixture, tempRoot } from './helpers.js'
import {
  V1_FIXTURE_NOW,
  largeV1State,
  legacyV1State,
  openOriginalV1,
  v1Chain,
  v1EngineHeldFixture,
  v1Message,
  v1Settings,
  writeV1Fixture,
} from './v1-fixtures.js'

const DAY = 24 * 60 * 60 * 1000

async function migratedLedger(root, now = V1_FIXTURE_NOW) {
  const ledger = new Ledger({ root, clock: () => now })
  await ledger.open()
  return ledger
}

test('real v1 Engine.send held rows without heldReason normalize and auto-resume', async (t) => {
  const cases = [
    { emergencyPaused: true, autoCollaborate: true, code: 'emergency_paused' },
    { emergencyPaused: false, autoCollaborate: false, code: 'auto_collaborate_off' },
  ]
  for (const item of cases) {
    const root = await tempRoot()
    const fixture = await v1EngineHeldFixture({
      root,
      emergencyPaused: item.emergencyPaused,
      autoCollaborate: item.autoCollaborate,
    })
    assert.equal(fixture.result.results[0].status, 'held')
    assert.equal(fixture.message.error.code, item.code)
    assert.equal(Object.prototype.hasOwnProperty.call(fixture.message, 'heldReason'), false)

    const ledger = await migratedLedger(root)
    const migrated = ledger.read().messages.find((message) => message.id === fixture.message.id)
    assert.equal(migrated.status, 'held')
    assert.equal(migrated.heldReason, item.code)
    assert.equal(ledger.read().settings.paused, true)
    await ledger.close()

    const clock = new FakeClock(V1_FIXTURE_NOW)
    const adapter = new MemoryAdapter({
      clock,
      sessions: [sessionFixture({ id: 'A' }), sessionFixture({ id: 'B' })],
    })
    const opened = await openEngine({ root, clock, adapter })
    try {
      await opened.engine.updateSettings({
        expectedSettingsRevision: opened.ledger.read().settingsRevision,
        patch: { paused: false },
      })
      await opened.engine.drain()
      assert.equal(opened.ledger.read().messages.find((message) => message.id === fixture.message.id).status, 'accepted')
      assert.equal(adapter.inserted.size, 1)
    } finally {
      await opened.engine.dispose()
      await opened.ledger.close()
    }
  }
  void t
})

test('known disabled and held_full error codes normalize when heldReason is absent', async () => {
  const root = await tempRoot()
  const state = {
    version: 1,
    revision: 1,
    createdAt: V1_FIXTURE_NOW - 10_000,
    updatedAt: V1_FIXTURE_NOW - 100,
    settings: { ...v1Settings({ emergencyPaused: true }) },
    messages: [
      v1Message('m-disabled-missing', {
        status: 'held',
        heldAt: V1_FIXTURE_NOW - 100,
        error: { code: 'disabled', message: 'held' },
      }),
      v1Message('m-held-full-missing', {
        status: 'held',
        heldAt: V1_FIXTURE_NOW - 100,
        heldOverflow: true,
        error: { code: 'held_full', message: 'held' },
      }),
    ],
    chains: { 'chain-open': v1Chain('chain-open', { messageCount: 2 }) },
    operations: {},
    latches: [],
    budget: { events: [], lastSubmitAt: {}, daily: {} },
  }
  await writeV1Fixture(root, state, { now: V1_FIXTURE_NOW })
  const ledger = await migratedLedger(root)
  try {
    const byId = new Map(ledger.read().messages.map((message) => [message.id, message]))
    assert.equal(byId.get('m-disabled-missing').heldReason, 'disabled')
    assert.equal(byId.get('m-held-full-missing').heldReason, 'held_full')
    assert.equal(byId.get('m-held-full-missing').status, 'held')
  } finally {
    await ledger.close()
  }
})

test('explicit manual or unknown heldReason is not overwritten by a known error code', async (t) => {
  for (const heldReason of ['manual', 'legacy_custom']) {
    const root = await tempRoot()
    const fixture = await v1EngineHeldFixture({
      root,
      emergencyPaused: true,
      heldReason,
    })
    assert.equal(fixture.message.heldReason, heldReason)
    const ledger = await migratedLedger(root)
    const migrated = ledger.read().messages.find((message) => message.id === fixture.message.id)
    assert.equal(migrated.heldReason, heldReason)
    assert.equal(migrated.status, 'held')
    await ledger.close()

    const clock = new FakeClock(V1_FIXTURE_NOW)
    const adapter = new MemoryAdapter({
      clock,
      sessions: [sessionFixture({ id: 'A' }), sessionFixture({ id: 'B' })],
    })
    const opened = await openEngine({ root, clock, adapter })
    try {
      await opened.engine.updateSettings({
        expectedSettingsRevision: opened.ledger.read().settingsRevision,
        patch: { paused: false },
      })
      await opened.engine.drain()
      const retained = opened.ledger.read().messages.find((message) => message.id === fixture.message.id)
      assert.equal(retained.status, 'held')
      assert.equal(retained.heldReason, heldReason)
      assert.equal(adapter.inserted.size, 0)
    } finally {
      await opened.engine.dispose()
      await opened.ledger.close()
    }
  }
  void t
})

test('a full v1 fixture migrates through the frozen loader with backup and preservation', async (t) => {
  const root = await tempRoot()
  const original = legacyV1State()
  const raw = await writeV1Fixture(root, original, { now: V1_FIXTURE_NOW })
  const ledger = await migratedLedger(root)
  t.after(async () => {
    await ledger.close()
  })
  const state = ledger.read()
  assert.equal(state.version, 3)
  assert.equal(state.settingsRevision, 1)
  assert.deepEqual(state.settings, {
    enabled: true,
    paused: false,
    maxConcurrent: 3,
    requestTimeoutMs: 30 * 60 * 1000,
    retentionDays: 30,
  })
  assert.equal(state.upgrade.fromVersion, 2)
  assert.equal(state.upgrade.migratedRevision, state.revision)
  assert.equal(state.upgrade.migratedSettingsRevision, 1)
  assert.match(state.upgrade.fromStateSha256, /^[0-9a-f]{64}$/)
  assert.match(state.upgrade.baselineStateDigest, /^[0-9a-f]{64}$/)
  assert.equal(path.dirname(state.upgrade.backupPath), root)
  for (const message of state.messages) {
    assert.deepEqual(message.receipt, {
      policy: 'legacy-accepted',
      state: 'uncertain',
      receivedAt: null,
      receivedSeq: null,
      timeoutMs: null,
      transfer: null,
    })
  }
  const v2Backups = (await fs.readdir(root)).filter((name) => name.startsWith(V2_BACKUP_PREFIX))
  assert.equal(v2Backups.length, 1)
  assert.equal(sha256(await fs.readFile(state.upgrade.backupPath)), state.upgrade.fromStateSha256)
  assert.equal(state.migration.fromVersion, 1)
  assert.equal(state.migration.fromStateSha256, sha256(raw))
  assert.equal(state.migration.migratedRevision, state.revision)
  assert.equal(state.migration.migratedSettingsRevision, 1)
  assert.equal(state.migration.settingsBefore.maxConcurrent, 2)
  assert.equal(state.migration.retiredQuotaPauses.length, 3)
  assert.equal(state.migration.retiredLatches.length, 3)
  assert.equal(state.migration.baselineMessageIds.length, original.messages.length)
  assert.equal(state.migration.baselineOperationKeys.length, Object.keys(original.operations).length)
  assert.equal(
    state.operations['A|slop:1800000000:123e4567-e89b-42d3-a456-426614174000|B'].operationId,
    'slop:1800000000:123e4567-e89b-42d3-a456-426614174000',
  )
  assert.match(state.migration.baselineStateDigest, /^[0-9a-f]{64}$/)
  assert.equal(state.budget, undefined)
  assert.equal(state.latches, undefined)

  // Quota pauses are retired; human/unknown pauses survive; closed never opens.
  assert.equal(state.chains['chain-hop'].state, 'open')
  assert.equal(state.chains['chain-budget'].state, 'open')
  assert.equal(state.chains['chain-latch'].state, 'open')
  assert.equal(state.chains['chain-owner'].state, 'paused')
  assert.equal(state.chains['chain-owner'].pausedReason, 'owner')
  assert.equal(state.chains['chain-root-owner'].state, 'paused')
  assert.equal(state.chains['chain-unknown-reason'].state, 'paused')
  assert.equal(state.chains['chain-closed'].state, 'closed')

  // Every message ID and association survives untouched.
  const byId = new Map(state.messages.map((message) => [message.id, message]))
  assert.equal(byId.size, original.messages.length)
  assert.equal(byId.get('m-notification').status, 'accepted')
  assert.equal(byId.get('m-request').replyStatus, 'answered')
  assert.equal(byId.get('m-request').answeredBy, 'm-reply')
  assert.equal(byId.get('m-reply').parentMessageId, 'm-request')
  assert.equal(byId.get('m-reply').replyTo, 'm-request')
  assert.equal(byId.get('m-dispatching').status, 'dispatching')
  assert.equal(byId.get('m-dispatching').durableMessageId, 'host-dispatching')
  assert.equal(byId.get('m-unknown').status, 'unknown')
  assert.equal(byId.get('m-failed').status, 'failed')
  assert.equal(byId.get('m-cancelled').status, 'cancelled')
  assert.equal(byId.get('m-held-auto').status, 'pending')
  assert.equal(byId.get('m-held-overflow').status, 'pending')
  assert.equal(byId.get('m-held-disabled').status, 'pending')
  assert.equal(byId.get('m-held-emergency').status, 'pending')
  assert.equal(byId.get('m-held-unknown').status, 'held')
  assert.equal(byId.get('m-held-unknown').heldReason, 'legacy_mystery')
  assert.equal(byId.get('m-owner-held').status, 'held')
  assert.equal(byId.get('m-owner-held').chainId, 'chain-owner')
  assert.equal(state.messages.filter((message) => message.status === 'accepted').length, 7)

  const backupName = path.basename(state.migration.backupPath)
  assert.equal(backupName, `${V1_BACKUP_PREFIX}${sha256(raw)}.json`)
  const backup = await fs.readFile(state.migration.backupPath)
  assert.equal(sha256(backup), sha256(raw))
  assert.equal((await fs.stat(state.migration.backupPath)).mode & 0o777, 0o600)

  // Reopening the v2 file must not create a second backup or re-migrate.
  const migratedAt = state.migration.migratedAt
  const upgradedAt = state.upgrade.migratedAt
  await ledger.close()
  const reopened = await migratedLedger(root)
  try {
    assert.equal(reopened.read().version, 3)
    assert.equal(reopened.read().migration.migratedAt, migratedAt)
    assert.equal(reopened.read().upgrade.migratedAt, upgradedAt)
    assert.equal((await fs.readdir(root)).filter((name) => name.startsWith(V1_BACKUP_PREFIX)).length, 1)
    assert.equal((await fs.readdir(root)).filter((name) => name.startsWith(V2_BACKUP_PREFIX)).length, 1)
  } finally {
    await reopened.close()
  }
})

test('corrupt or unknown v1 state fails closed without backup or rewrite', async (t) => {
  const cases = [
    '{ not json',
    JSON.stringify({ version: 1, revision: 1, createdAt: 1, updatedAt: 1, settings: {}, messages: [], chains: {}, operations: {}, latches: [], budget: {} }),
    JSON.stringify({ version: 99, revision: 1 }),
  ]
  for (const raw of cases) {
    const root = await tempRoot()
    await fs.writeFile(path.join(root, 'ledger.json'), raw, { mode: 0o600 })
    const ledger = new Ledger({ root })
    await assert.rejects(ledger.open(), (error) => error.code === 'storage_corrupt')
    assert.equal(await fs.readFile(path.join(root, 'ledger.json'), 'utf8'), raw)
    const names = await fs.readdir(root)
    assert.equal(names.some((name) => name.startsWith(V1_BACKUP_PREFIX)), false)
  }
})

test('a v1 migration product that would fail v2 validation is rejected before persist', async () => {
  const root = await tempRoot()
  const state = legacyV1State()
  const chain = state.chains['chain-open']
  chain.state = 'paused'
  chain.pausedAt = V1_FIXTURE_NOW - 1000
  chain.pausedReason = ''
  const raw = await writeV1Fixture(root, state, { now: V1_FIXTURE_NOW })
  const ledger = new Ledger({ root, clock: () => V1_FIXTURE_NOW })
  await assert.rejects(ledger.open(), (error) => error.code === 'storage_corrupt')
  await ledger.close()
  assert.equal((await fs.readFile(path.join(root, 'ledger.json'))).toString('utf8'), raw.toString('utf8'))

  const retry = new Ledger({ root, clock: () => V1_FIXTURE_NOW })
  await assert.rejects(retry.open(), (error) => error.code === 'storage_corrupt')
  await retry.close()
})

test('an existing mismatching v1 backup is never overwritten', async () => {
  const root = await tempRoot()
  const raw = await writeV1Fixture(root, legacyV1State(), { now: V1_FIXTURE_NOW })
  const digest = sha256(raw)
  const backupPath = path.join(root, `${V1_BACKUP_PREFIX}${digest}.json`)
  await fs.writeFile(backupPath, 'wrong backup', { mode: 0o600 })
  const ledger = new Ledger({ root })
  await assert.rejects(ledger.open(), (error) => error.code === 'storage_error')
  assert.equal(await fs.readFile(path.join(root, 'ledger.json'), 'utf8'), raw.toString('utf8'))
  assert.equal(await fs.readFile(backupPath, 'utf8'), 'wrong backup')
})

test('legacy data over the new capacity opens, rejects new sends, cleans, then accepts again', async (t) => {
  const root = await tempRoot()
  await writeV1Fixture(root, largeV1State(60, { createdAt: V1_FIXTURE_NOW - 100 * DAY }), { now: V1_FIXTURE_NOW })
  const clock = new FakeClock(V1_FIXTURE_NOW)
  const adapter = new MemoryAdapter({
    clock,
    sessions: [sessionFixture({ id: 'A' }), sessionFixture({ id: 'B' })],
  })
  const { ledger, engine } = await openEngine({ root, adapter, clock, limits: { maxDiskBytes: 3500 } })
  t.after(async () => {
    await engine.dispose()
    await ledger.close()
  })
  assert.equal(ledger.read().version, 3)
  assert.equal((await engine.snapshot({})).storage.health, 'full')
  await assert.rejects(
    engine.send({
      from: 'A',
      targets: ['B'],
      kind: 'notification',
      text: 'over capacity',
      operationId: engine.mintOperation().operationId,
    }),
    (error) => error.code === 'storage_full',
  )
  const beforeCleanup = ledger.read().messages.length
  assert.ok(beforeCleanup > 0)
  await engine.start()
  assert.equal(ledger.read().messages.length, 0, 'old completed records should be cleanable while over capacity')
  const sent = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'after cleanup',
    operationId: engine.mintOperation().operationId,
  })
  assert.equal(sent.results[0].status, 'accepted')
})


test('v1 pause mapping keeps automatic held queued until resume, and preserves timeout/retention', async () => {
  const root = await tempRoot()
  const original = legacyV1State({
    settings: {
      emergencyPaused: true,
      maxConcurrent: 1,
      requestTimeoutMs: 86_400_000,
      retentionDays: 90,
    },
  })
  await writeV1Fixture(root, original, { now: V1_FIXTURE_NOW })
  const ledger = await migratedLedger(root)
  try {
    const state = ledger.read()
    assert.equal(state.settings.paused, true)
    assert.equal(state.settings.enabled, true)
    assert.equal(state.settings.maxConcurrent, 1)
    assert.equal(state.settings.requestTimeoutMs, 86_400_000)
    assert.equal(state.settings.retentionDays, 90)
    const byId = new Map(state.messages.map((message) => [message.id, message]))
    assert.equal(byId.get('m-held-auto').status, 'held')
    assert.equal(byId.get('m-held-overflow').status, 'held')
    assert.equal(byId.get('m-held-unknown').status, 'held')
    assert.equal(state.chains['chain-hop'].state, 'open')
  } finally {
    await ledger.close()
  }
})

test('legacy queue data over the new payload envelope loads, rejects new sends, and resumes after cleanup', async (t) => {
  const root = await tempRoot()
  const original = legacyV1State({
    settings: { autoCollaborate: false },
  })
  for (let index = 0; index < 3; index += 1) {
    original.messages.push(
      v1Message(`m-big-held-${index}`, {
        status: 'held',
        heldAt: V1_FIXTURE_NOW - 100,
        heldReason: 'auto_collaborate_off',
        error: { code: 'auto_collaborate_off', message: 'held' },
        content: { text: 'x'.repeat(1000), references: [], paths: [] },
        contentBytes: 1000,
      }),
    )
  }
  original.chains['chain-open'].messageCount += 3
  await writeV1Fixture(root, original, { now: V1_FIXTURE_NOW })
  const clock = new FakeClock(V1_FIXTURE_NOW)
  const adapter = new MemoryAdapter({
    clock,
    sessions: [sessionFixture({ id: 'A' }), sessionFixture({ id: 'B' })],
  })
  const { ledger, engine } = await openEngine({ root, adapter, clock, limits: { maxQueuedBytes: 1500 } })
  t.after(async () => {
    await engine.dispose()
    await ledger.close()
  })
  await engine.start()
  assert.equal(ledger.read().settings.paused, true)
  assert.equal((await engine.snapshot({})).storage.health, 'full')
  await assert.rejects(
    engine.send({
      from: 'A',
      targets: ['B'],
      kind: 'notification',
      text: 'new while over queue',
      operationId: engine.mintOperation().operationId,
    }),
    (error) => error.code === 'queue_full',
  )
  const resumed = await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { paused: false },
  })
  assert.ok(resumed.resumed >= 4)
  await engine.drain()
  const sent = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'after drain',
    operationId: engine.mintOperation().operationId,
  })
  assert.equal(sent.results[0].status, 'accepted')
})

test('snapshot exposes only the public migration summary, not the private backup path', async (t) => {
  const root = await tempRoot()
  await writeV1Fixture(root, legacyV1State(), { now: V1_FIXTURE_NOW })
  const clock = new FakeClock(V1_FIXTURE_NOW)
  const adapter = new MemoryAdapter({
    clock,
    sessions: [sessionFixture({ id: 'A' }), sessionFixture({ id: 'B' })],
  })
  const { ledger, engine } = await openEngine({ root, adapter, clock })
  t.after(async () => {
    await engine.dispose()
    await ledger.close()
  })
  const snapshot = await engine.snapshot({})
  assert.equal(snapshot.migration.fromVersion, 1)
  assert.equal(snapshot.migration.backupAvailable, true)
  assert.equal(snapshot.migration.retiredQuotaPauses, 3)
  assert.equal(snapshot.migration.retiredLatches, 3)
  assert.equal(snapshot.migration.backupPath, undefined)
  assert.equal(snapshot.migration.settingsBefore, undefined)
})

test('a migration persist failure before rename leaves the v1 file intact and reuses the backup', async () => {
  const root = await tempRoot()
  const raw = await writeV1Fixture(root, legacyV1State(), { now: V1_FIXTURE_NOW })
  const originalRename = fs.rename
  fs.rename = async () => {
    throw Object.assign(new Error('injected before rename'), { code: 'EIO' })
  }
  try {
    const ledger = new Ledger({ root, clock: () => V1_FIXTURE_NOW })
    await assert.rejects(ledger.open(), (error) => error.code === 'storage_error' && typeof error.details.mayHaveWritten === 'boolean')
  } finally {
    fs.rename = originalRename
  }
  assert.equal((await fs.readFile(path.join(root, 'ledger.json'))).toString('utf8'), raw.toString('utf8'))
  const backups = (await fs.readdir(root)).filter((name) => name.startsWith(V1_BACKUP_PREFIX))
  assert.equal(backups.length, 1)
  const ledger = await migratedLedger(root)
  try {
    assert.equal(ledger.read().version, 3)
    assert.equal((await fs.readdir(root)).filter((name) => name.startsWith(V1_BACKUP_PREFIX)).length, 1)
  } finally {
    await ledger.close()
  }
})

test('a migration persist failure after rename opens the persisted v3 on the next attempt', async () => {
  const root = await tempRoot()
  await writeV1Fixture(root, legacyV1State(), { now: V1_FIXTURE_NOW })
  const originalRename = fs.rename
  fs.rename = async (...args) => {
    await originalRename(...args)
    throw Object.assign(new Error('injected after rename'), { code: 'EIO' })
  }
  try {
    const ledger = new Ledger({ root, clock: () => V1_FIXTURE_NOW })
    await assert.rejects(ledger.open(), (error) => error.code === 'storage_error' && error.details.mayHaveWritten === true)
  } finally {
    fs.rename = originalRename
  }
  const ledger = await migratedLedger(root)
  try {
    assert.equal(ledger.read().version, 3)
    assert.equal(ledger.read().migration.fromVersion, 1)
  } finally {
    await ledger.close()
  }
})

test('a migrated dispatching row is reconciled by cold evidence and never resent', async (t) => {
  const root = await tempRoot()
  await writeV1Fixture(root, legacyV1State(), { now: V1_FIXTURE_NOW })
  const clock = new FakeClock(V1_FIXTURE_NOW)
  const adapter = new MemoryAdapter({
    clock,
    sessions: [sessionFixture({ id: 'A' }), sessionFixture({ id: 'B' })],
  })
  adapter.markInserted('B', 'host-dispatching', 'A')
  const { ledger, engine } = await openEngine({ root, adapter, clock })
  t.after(async () => {
    await engine.dispose()
    await ledger.close()
  })
  const summary = await engine.start()
  assert.equal(summary.recovered, 1)
  const message = ledger.read().messages.find((entry) => entry.id === 'm-dispatching')
  assert.equal(message.status, 'accepted')
  assert.equal(message.recoveryEvidence, 'message')
  assert.equal(adapter.deliveries.length, 0)
})

test('a legal v2 ledger with more than 10000 records loads without a count gate', async (t) => {
  const root = await tempRoot()
  const ledger = new Ledger({ root })
  await ledger.open()
  const now = 1_800_000_000_000
  await ledger.mutate((state) => {
    state.chains.large = {
      id: 'large',
      rootOwner: 'A',
      createdAt: now,
      state: 'open',
      messageCount: 10_001,
    }
    for (let index = 0; index < 10_001; index += 1) {
      state.messages.push({
        id: `m-${index}`,
        from: 'A',
        to: 'B',
        kind: 'notification',
        chainId: 'large',
        hop: 0,
        createdAt: now,
        acceptedAt: now,
        completedAt: now,
        content: { text: 'x', references: [], paths: [] },
        contentBytes: 1,
        status: 'accepted',
        replyStatus: 'none',
        receipt: receiptFixture(),
      })
    }
  })
  await ledger.close()
  const reopened = new Ledger({ root })
  await reopened.open()
  try {
    assert.equal(reopened.read().messages.length, 10_001)
    assert.equal(reopened.read().chains.large.messageCount, 10_001)
  } finally {
    await reopened.close()
  }
})

test('v1 and v2 closed waiting requests share the same retention horizon', async (t) => {
  const closedAt = V1_FIXTURE_NOW - 100 * DAY
  const sessions = [sessionFixture({ id: 'A' }), sessionFixture({ id: 'B' })]

  const v1Root = await tempRoot()
  const legacy = legacyV1State()
  legacy.chains['chain-closed-wait'] = v1Chain('chain-closed-wait', {
    state: 'closed',
    closedAt,
    messageCount: 1,
  })
  legacy.messages.push(v1Message('m-closed-wait', {
    chainId: 'chain-closed-wait',
    kind: 'request',
    status: 'accepted',
    acceptedAt: closedAt - 1000,
    replyStatus: 'waiting',
    deadlineAt: closedAt + 60_000,
    content: { text: 'legacy closed waiting', references: [], paths: [] },
  }))
  await writeV1Fixture(v1Root, legacy, { now: V1_FIXTURE_NOW })
  const v1Clock = new FakeClock(V1_FIXTURE_NOW)
  const v1 = await openEngine({
    root: v1Root,
    adapter: new MemoryAdapter({ clock: v1Clock, sessions }),
    clock: v1Clock,
  })
  let v2
  t.after(async () => {
    await v1.engine.dispose()
    await v1.ledger.close()
    if (v2 !== undefined) {
      await v2.engine.dispose()
      await v2.ledger.close()
    }
  })
  const migrated = v1.ledger.read().messages.find((message) => message.id === 'm-closed-wait')
  assert.equal(migrated.completedAt, closedAt)
  await v1.engine.tick()
  assert.equal(v1.ledger.read().messages.find((message) => message.id === 'm-closed-wait'), undefined)

  const v2Root = await tempRoot()
  const v2Clock = new FakeClock(closedAt - 1000)
  v2 = await openEngine({
    root: v2Root,
    adapter: new MemoryAdapter({ clock: v2Clock, sessions }),
    clock: v2Clock,
  })
  const sent = await v2.engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'v2 closed waiting',
    operationId: v2.engine.mintOperation().operationId,
  })
  v2Clock.now = closedAt
  await v2.engine.ownerControl({
    expectedRevision: v2.ledger.read().revision,
    action: 'close',
    id: sent.chainId,
  })
  const current = v2.ledger.read().messages.find((message) => message.id === sent.results[0].id)
  assert.equal(current.completedAt, closedAt)
  v2Clock.now = V1_FIXTURE_NOW
  await v2.engine.tick()
  assert.equal(v2.ledger.read().messages.find((message) => message.id === sent.results[0].id), undefined)
})

test('offline v3 -> v2 restore reuses the exact v2 backup and never overwrites v3 on failure', async () => {
  const root = await tempRoot()
  const v1Raw = await writeV1Fixture(root, legacyV1State(), { now: V1_FIXTURE_NOW })
  const ledger = await migratedLedger(root)
  const baseline = ledger.read()
  const v2BackupPath = baseline.upgrade.backupPath
  const v2Raw = await fs.readFile(v2BackupPath)
  assert.equal(sha256(v2Raw), baseline.upgrade.fromStateSha256)
  assert.equal(JSON.parse(v2Raw.toString('utf8')).version, 2)

  const originalRename = fs.rename
  fs.rename = async () => {
    throw Object.assign(new Error('injected before rename'), { code: 'EIO' })
  }
  try {
    await assert.rejects(ledger.restoreV2Backup(), (error) => error.code === 'storage_error')
  } finally {
    fs.rename = originalRename
  }
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'ledger.json'), 'utf8')).version, 3)
  await ledger.close()

  const retry = await migratedLedger(root)
  const restored = await retry.restoreV2Backup()
  await retry.close()
  assert.equal(restored.v2BackupPath, v2BackupPath)
  assert.equal(sha256(await fs.readFile(path.join(root, 'ledger.json'))), sha256(v2Raw))
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'ledger.json'), 'utf8')).version, 2)
  assert.equal(path.basename(restored.v3BackupPath).startsWith(V3_ROLLBACK_BACKUP_PREFIX), true)
  assert.equal((await fs.stat(restored.v3BackupPath)).mode & 0o777, 0o600)
  assert.equal((await fs.readdir(root)).filter((name) => name.startsWith(V3_ROLLBACK_BACKUP_PREFIX)).length, 1)
  void v1Raw
})

test('v3 -> v2 restore fails closed after a post-upgrade transaction or mismatched backup', async () => {
  const root = await tempRoot()
  await writeV1Fixture(root, legacyV1State(), { now: V1_FIXTURE_NOW })
  const ledger = await migratedLedger(root)
  const baseline = ledger.read()
  await assert.rejects(
    ledger.restoreV1Backup(),
    (error) => error.code === 'rollback_conflict' && /v1 restore only supports a v2 ledger/.test(error.message),
  )
  await ledger.mutate((state) => {
    state.chains.extra = { id: 'extra', rootOwner: 'A', createdAt: V1_FIXTURE_NOW, state: 'open', messageCount: 0 }
  })
  await assert.rejects(ledger.restoreV2Backup(), (error) => error.code === 'rollback_conflict')
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'ledger.json'), 'utf8')).version, 3)
  await ledger.close()

  // A mismatching backup is rejected before any v3 rollback backup or replace.
  const mismatchRoot = await tempRoot()
  await writeV1Fixture(mismatchRoot, legacyV1State(), { now: V1_FIXTURE_NOW })
  const mismatch = await migratedLedger(mismatchRoot)
  const upgrade = mismatch.read().upgrade
  await fs.writeFile(upgrade.backupPath, 'not the v2 state', { mode: 0o600 })
  await assert.rejects(mismatch.restoreV2Backup(), (error) => error.code === 'rollback_conflict')
  assert.equal(JSON.parse(await fs.readFile(path.join(mismatchRoot, 'ledger.json'), 'utf8')).version, 3)
  assert.equal(await fs.readFile(upgrade.backupPath, 'utf8'), 'not the v2 state')
  assert.equal((await fs.readdir(mismatchRoot)).filter((name) => name.startsWith(V3_ROLLBACK_BACKUP_PREFIX)).length, 0)
  await mismatch.close()
  void baseline
})

test('v3 rollback preflight is conservative and a fresh upgrade can be restored offline', async () => {
  const root = await tempRoot()
  const v1Raw = await writeV1Fixture(root, legacyV1State(), { now: V1_FIXTURE_NOW })
  const ledger = await migratedLedger(root)
  const baseline = ledger.read()
  const v2Raw = await fs.readFile(baseline.upgrade.backupPath)
  assert.deepEqual(v3ToV2Preflight({ currentState: baseline, upgrade: baseline.upgrade, backupRaw: v2Raw }), {
    ok: true,
    reasons: [],
  })
  assert.equal(
    rollbackPreflight({ currentState: baseline, migration: baseline.migration, backupRaw: v1Raw }).ok,
    false,
  )

  const revisionChanged = structuredClone(baseline)
  revisionChanged.revision += 1
  assert.equal(v3ToV2Preflight({ currentState: revisionChanged, upgrade: revisionChanged.upgrade, backupRaw: v2Raw }).ok, false)
  const settingsChanged = structuredClone(baseline)
  settingsChanged.settings.maxConcurrent = 4
  settingsChanged.settingsRevision += 1
  assert.equal(v3ToV2Preflight({ currentState: settingsChanged, upgrade: settingsChanged.upgrade, backupRaw: v2Raw }).ok, false)
  const messageAdded = structuredClone(baseline)
  messageAdded.messages.push({ ...structuredClone(baseline.messages[0]), id: 'new-message' })
  assert.equal(v3ToV2Preflight({ currentState: messageAdded, upgrade: messageAdded.upgrade, backupRaw: v2Raw }).ok, false)
  assert.equal(v3ToV2Preflight({ currentState: baseline, upgrade: baseline.upgrade, backupRaw: 'tampered' }).ok, false)

  await assert.rejects(ledger.restoreV1Backup(), (error) => error.code === 'rollback_conflict')
  const restored = await ledger.restoreV2Backup()
  assert.equal(restored.restored, true)
  await ledger.close()
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'ledger.json'), 'utf8')).version, 2)
  assert.equal(
    (await fs.readdir(root)).filter((name) => name.startsWith(V2_BACKUP_PREFIX)).length,
    1,
  )
})

test('the frozen v1 -> v2 conversion still emits schema 2 while the v0.3 current state is 3', async () => {
  const v1 = validateV1State(legacyV1State())
  const v2 = migrateV1State(v1, {
    now: V1_FIXTURE_NOW,
    fromStateSha256: sha256(Buffer.from('v1-bytes')),
    backupPath: path.join('/tmp', `${V1_BACKUP_PREFIX}${'a'.repeat(64)}.json`),
  })
  assert.equal(v2.version, 2)
  assert.equal(v2.messages.some((message) => 'receipt' in message), false)
  assert.equal(v2.upgrade, undefined)
  const v3 = migrateV2State(v2, {
    now: V1_FIXTURE_NOW + 1,
    fromStateSha256: sha256(Buffer.from(JSON.stringify(v2))),
    backupPath: path.join('/tmp', `${V2_BACKUP_PREFIX}${'b'.repeat(64)}.json`),
  })
  assert.equal(v3.version, 3)
  assert.equal(v3.upgrade.fromVersion, 2)
  assert.equal(v3.migration.fromVersion, 1)
  assert.equal(v3.messages.every((message) => message.receipt.policy === 'legacy-accepted'), true)
  assert.equal(v3.messages.every((message) => message.receipt.state === 'uncertain'), true)
  assert.equal(v3.messages.length, v2.messages.length)
  assert.equal(v3.settingsRevision, v2.settingsRevision)
  assert.equal(v3.revision, v2.revision)
  assert.equal(STATE_VERSION, 3)
  assert.throws(
    () => validateV2State(v3),
    (error) => error.code === 'storage_corrupt',
    'the frozen v2 validator must never accept a v3 product',
  )
})

test('a real v2 ledger migrates to v3 with an exact backup and preserves timeout/queued/unknown/operation history', async () => {
  const root = await tempRoot()
  const v1 = validateV1State(legacyV1State())
  const now = V1_FIXTURE_NOW
  const v2 = migrateV1State(v1, {
    now,
    fromStateSha256: sha256(Buffer.from('v1')),
    backupPath: path.join(root, `${V1_BACKUP_PREFIX}${'c'.repeat(64)}.json`),
  })
  const request = v2.messages.find((message) => message.id === 'm-request')
  request.replyStatus = 'timed_out'
  request.deadlineAt = now - 1000
  request.timedOutAt = now - 1000
  request.completedAt = now - 1000
  delete request.answeredAt
  delete request.answeredBy
  const operationKeys = Object.keys(v2.operations).sort()
  const raw = Buffer.from(JSON.stringify(v2), 'utf8')
  await fs.writeFile(path.join(root, 'ledger.json'), raw, { mode: 0o600 })

  const ledger = new Ledger({ root, clock: () => now })
  await ledger.open()
  const state = ledger.read()
  assert.equal(state.version, 3)
  assert.deepEqual(Object.keys(state.operations).sort(), operationKeys)
  assert.equal(state.settingsRevision, v2.settingsRevision)
  assert.equal(state.revision, v2.revision)
  assert.deepEqual(state.settings, v2.settings)
  assert.equal(state.messages.find((message) => message.id === 'm-unknown').status, 'unknown')
  assert.equal(state.messages.find((message) => message.id === 'm-held-auto').status, 'pending')
  assert.equal(state.upgrade.fromVersion, 2)
  assert.equal(state.upgrade.fromStateSha256, sha256(raw))
  assert.equal(state.migration.fromVersion, 1)
  assert.equal((await fs.readFile(state.upgrade.backupPath)).equals(raw), true)
  assert.equal((await fs.stat(state.upgrade.backupPath)).mode & 0o777, 0o600)
  const migratedRequest = state.messages.find((message) => message.id === 'm-request')
  assert.equal(migratedRequest.replyStatus, 'timed_out')
  assert.equal(migratedRequest.deadlineAt, now - 1000)
  assert.equal(migratedRequest.timedOutAt, now - 1000)
  assert.equal(migratedRequest.completedAt, now - 1000)
  assert.equal(migratedRequest.receipt.policy, 'legacy-accepted')
  assert.equal(migratedRequest.receipt.state, 'uncertain')
  assert.equal(migratedRequest.receipt.receivedAt, null)
  for (const message of state.messages) {
    assert.equal(message.receipt.policy, 'legacy-accepted')
    assert.equal(message.receipt.state, 'uncertain')
    assert.equal(message.receipt.receivedAt, null)
    assert.equal(message.receipt.receivedSeq, null)
    assert.equal(message.receipt.timeoutMs, null)
    assert.equal(message.receipt.transfer, null)
  }
  await ledger.close()
  const reopened = new Ledger({ root, clock: () => now })
  await reopened.open()
  assert.equal((await fs.readdir(root)).filter((name) => name.startsWith(V2_BACKUP_PREFIX)).length, 1)
  assert.equal(reopened.read().upgrade.migratedAt, state.upgrade.migratedAt)
  await reopened.close()
})

test('malformed v3 receipts, upgrade markers, and journals fail closed without rewrite', async () => {
  const baseRoot = await tempRoot()
  await writeV1Fixture(baseRoot, legacyV1State(), { now: V1_FIXTURE_NOW })
  const base = await migratedLedger(baseRoot)
  const baseRaw = JSON.stringify(base.read())
  await base.close()
  const variants = [
    (state) => { delete state.messages[0].receipt },
    (state) => { state.messages[0].receipt.state = 'bogus' },
    (state) => { state.messages[0].receipt.receivedAt = 1 },
    (state) => { state.messages[0].receipt.transfer = { state: 'moved' } },
    (state) => { state.upgrade.fromVersion = 1 },
    (state) => { state.transfers = { [state.messages[0].id]: {} } },
  ]
  for (const mutate of variants) {
    const root = await tempRoot()
    const state = JSON.parse(baseRaw)
    mutate(state)
    const raw = JSON.stringify(state)
    await fs.writeFile(path.join(root, 'ledger.json'), raw, { mode: 0o600 })
    const ledger = new Ledger({ root })
    await assert.rejects(ledger.open(), (error) => error.code === 'storage_corrupt')
    assert.equal(await fs.readFile(path.join(root, 'ledger.json'), 'utf8'), raw)
    assert.equal((await fs.readdir(root)).some((name) => name.startsWith(V2_BACKUP_PREFIX)), false)
  }
})

test('a post-upgrade transfer journal blocks v3 -> v2 rollback and preserves the v2 backup', async () => {
  const root = await tempRoot()
  await writeV1Fixture(root, legacyV1State(), { now: V1_FIXTURE_NOW })
  const ledger = await migratedLedger(root)
  const baseline = ledger.read()
  const message = baseline.messages.find((entry) => typeof entry.durableMessageId === 'string')
  assert.ok(message !== undefined)
  const v2Before = await fs.readFile(baseline.upgrade.backupPath)
  await ledger.mutate((state) => {
    const current = state.messages.find((entry) => entry.id === message.id)
    state.transfers = {
      [current.id]: {
        messageId: current.id,
        target: current.to,
        durableMessageId: current.durableMessageId,
        hostMessage: {
          id: current.durableMessageId,
          role: 'user',
          content: [{ type: 'text', text: 'journal body' }],
          source: { kind: 'agent-message', form: 'relay', senderSessionId: current.from },
        },
        queuePosition: 0,
        hostSessionSeq: 7,
        at: V1_FIXTURE_NOW,
        digest: 'd'.repeat(64),
        state: 'moved',
        attempts: 1,
      },
    }
    current.receipt.transfer = { state: 'moved', at: V1_FIXTURE_NOW }
  })
  await assert.rejects(
    ledger.restoreV2Backup(),
    (error) => error.code === 'rollback_conflict',
  )
  assert.equal(ledger.read().version, 3)
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'ledger.json'), 'utf8')).version, 3)
  const state = ledger.read()
  assert.equal((await fs.readFile(state.upgrade.backupPath)).equals(v2Before), true)
  assert.equal((await fs.readdir(root)).some((name) => name.startsWith(V3_ROLLBACK_BACKUP_PREFIX)), false)
  await ledger.close()
})
