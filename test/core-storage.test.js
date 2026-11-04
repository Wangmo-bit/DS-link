import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

import { FakeClock, MemoryAdapter, openEngine, sessionFixture, tempRoot } from './helpers.js'

async function setup(t) {
  const clock = new FakeClock()
  const root = await tempRoot()
  const adapter = new MemoryAdapter({
    clock,
    sessions: [sessionFixture({ id: 'A' }), sessionFixture({ id: 'B' })],
  })
  const opened = await openEngine({ root, adapter, clock })
  t.after(async () => {
    await fs.chmod(root, 0o700).catch(() => undefined)
    await opened.engine.dispose()
    await opened.ledger.close()
  })
  return { ...opened, clock, adapter, root }
}

test('a pre-rename persistence failure poisons reads but rejects all writes and host insertion', async (t) => {
  const { engine, ledger, adapter, root } = await setup(t)
  const first = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'persisted',
    operationId: engine.mintOperation().operationId,
  })
  assert.equal(first.results[0].status, 'accepted')
  const deliveriesBefore = adapter.deliveries.length
  await fs.chmod(root, 0o500)
  await assert.rejects(
    engine.send({
      from: 'A',
      targets: ['B'],
      kind: 'notification',
      text: 'cannot persist',
      operationId: engine.mintOperation().operationId,
    }),
    (error) => error.code === 'storage_error' && error.details.mayHaveWritten === false,
  )
  assert.equal(ledger.writable, false)
  assert.equal(ledger.stats().health, 'storage_error')
  assert.equal(ledger.read().messages.length, 1, 'the last confirmed memory remains readable')
  assert.equal(adapter.deliveries.length, deliveriesBefore, 'no host insertion may follow a poison')
  const snapshot = await engine.snapshot({})
  assert.equal(snapshot.storage.health, 'storage_error')
  assert.equal(snapshot.storage.error.mayHaveWritten, false)
  await assert.rejects(
    engine.ownerControl({ expectedRevision: snapshot.revision, action: 'cancel', id: first.results[0].id }),
    (error) => error.code === 'storage_error' || error.code === 'conflict',
  )
  await assert.rejects(
    engine.updateSettings({ expectedSettingsRevision: snapshot.settingsRevision, patch: { retentionDays: 31 } }),
    (error) => error.code === 'storage_error',
  )
  await fs.chmod(root, 0o700)
})

test('a post-rename failure never lets old memory overwrite the new disk state', async (t) => {
  const { engine, ledger, adapter, root, clock } = await setup(t)
  const first = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'first',
    operationId: engine.mintOperation().operationId,
  })
  assert.equal(first.results[0].status, 'accepted')
  const originalRename = fs.rename
  fs.rename = async (...args) => {
    await originalRename(...args)
    throw Object.assign(new Error('injected after rename'), { code: 'EIO' })
  }
  try {
    await assert.rejects(
      engine.send({
        from: 'A',
        targets: ['B'],
        kind: 'notification',
        text: 'persisted on disk before fsync failure',
        operationId: engine.mintOperation().operationId,
      }),
      (error) => error.code === 'storage_error' && error.details.mayHaveWritten === true,
    )
    assert.equal(ledger.writable, false)
    assert.equal(ledger.read().messages.length, 1, 'old memory must not be treated as the new disk state')
    assert.equal(adapter.deliveries.length, 1, 'the failed inbound mutation must not reach the host')
    assert.equal((await engine.snapshot({})).storage.error.mayHaveWritten, true)
  } finally {
    fs.rename = originalRename
  }
  await engine.dispose()
  await ledger.close()
  const reopened = await openEngine({ root, adapter, clock })
  try {
    assert.equal(reopened.ledger.read().messages.length, 2, 'the post-rename disk state is authoritative')
    assert.equal(reopened.ledger.writable, true)
  } finally {
    await reopened.engine.dispose()
    await reopened.ledger.close()
  }
})
