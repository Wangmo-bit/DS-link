import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { Ledger, skipMutation } from '../src/core/ledger.js'
import { receiptFixture, tempRoot } from './helpers.js'

test('ledger persists atomically with private permissions and survives reopen', async () => {
  const root = await tempRoot()
  const ledger = new Ledger({ root })
  await ledger.open()
  const rootStat = await fs.stat(root)
  assert.equal(rootStat.mode & 0o777, 0o700)
  assert.equal((await fs.stat(ledger.lockPath)).mode & 0o777, 0o600)
  assert.equal((await fs.stat(path.join(root, 'writer.sqlite'))).mode & 0o777, 0o600)

  const first = await ledger.mutate((state) => {
    state.chains.c1 = {
      id: 'c1',
      rootOwner: 'A',
      createdAt: 1,
      state: 'open',
      maxMessages: 20,
      maxHops: 8,
      messageCount: 1,
    }
    state.messages.push({
      id: 'm1',
      from: 'A',
      to: 'B',
      kind: 'notification',
      chainId: 'c1',
      hop: 0,
      createdAt: 1,
      content: { text: 'x', references: [], paths: [] },
      status: 'accepted',
      replyStatus: 'none',
      receipt: receiptFixture(),
      deliveryAttempts: 0,
      durableMessageId: null,
      error: null,
    })
    return { revision: state.revision + 1 }
  })
  assert.equal(first.revision, 2)
  const statePath = path.join(root, 'ledger.json')
  assert.equal((await fs.stat(statePath)).mode & 0o777, 0o600)
  const onDisk = JSON.parse(await fs.readFile(statePath, 'utf8'))
  assert.equal(onDisk.messages.length, 1)
  assert.equal(onDisk.revision, 2)
  await ledger.close()

  const reopened = new Ledger({ root })
  await reopened.open()
  assert.equal(reopened.read().messages[0].id, 'm1')
  assert.equal(reopened.read().revision, 2)
  await reopened.close()
})

test('skipped mutations do not bump revision or write', async () => {
  const root = await tempRoot()
  const ledger = new Ledger({ root })
  await ledger.open()
  const before = ledger.read().revision
  const result = await ledger.mutate(() => skipMutation({ ok: true }))
  assert.deepEqual(result, { ok: true })
  assert.equal(ledger.read().revision, before)
  assert.equal((await fs.stat(path.join(root, 'ledger.json')).catch(() => null)), null)
  await ledger.close()
})

test('CAS rejects a stale expected revision and preserves the winning write', async () => {
  const root = await tempRoot()
  const ledger = new Ledger({ root })
  await ledger.open()
  const revision = ledger.read().revision
  await ledger.mutate((state) => {
    state.settings.enabled = false
  })
  await assert.rejects(
    ledger.mutate(() => undefined, { expectedRevision: revision }),
    (error) => error.code === 'revision_conflict' && error.details.currentRevision === revision + 1,
  )
  assert.equal(ledger.read().settings.enabled, false)
  await ledger.close()
})

test('corrupt or unknown state fails closed without being overwritten', async () => {
  const root = await tempRoot()
  await fs.writeFile(path.join(root, 'ledger.json'), '{ not json', { mode: 0o600 })
  const ledger = new Ledger({ root })
  await assert.rejects(ledger.open(), (error) => error.code === 'storage_corrupt')
  assert.equal(await fs.readFile(path.join(root, 'ledger.json'), 'utf8'), '{ not json')

  await fs.writeFile(path.join(root, 'ledger.json'), JSON.stringify({ version: 99, revision: 1 }), { mode: 0o600 })
  const other = new Ledger({ root })
  await assert.rejects(other.open(), (error) => error.code === 'storage_corrupt')
})

test('delivery capacity rejects a write by bytes instead of silently dropping messages', async () => {
  const root = await tempRoot()
  const ledger = new Ledger({ root, limits: { maxDiskBytes: 900 } })
  await ledger.open()
  await assert.rejects(
    ledger.mutate(
      (state) => {
        state.chains.c1 = { id: 'c1', rootOwner: 'A', createdAt: 1, state: 'open', messageCount: 1 }
        state.messages.push({
          id: '1',
          from: 'A',
          to: 'B',
          kind: 'notification',
          chainId: 'c1',
          hop: 0,
          createdAt: 1,
          content: { text: 'x'.repeat(2000), references: [], paths: [] },
          status: 'accepted',
          replyStatus: 'none',
      receipt: receiptFixture(),
        })
      },
      { delivery: true },
    ),
    (error) => error.code === 'storage_full' && error.details.maxBytes === 900,
  )
  assert.equal(ledger.read().messages.length, 0)
  await ledger.close()
})

test('a second writer is refused while the first holds the OS lock', async () => {
  const root = await tempRoot()
  const first = new Ledger({ root })
  await first.open()
  const metadata = JSON.parse(await fs.readFile(first.lockPath, 'utf8'))
  assert.equal(metadata.pid, process.pid)
  assert.equal(typeof metadata.hostname, 'string')
  assert.equal(typeof metadata.processStart, 'string')
  assert.equal(metadata.mechanism, 'sqlite-exclusive')

  const second = new Ledger({ root })
  await assert.rejects(second.open(), (error) => error.code === 'lock_active')
  await first.close()
  await second.open()
  await second.close()
})

test('unknown lock metadata cannot steal an OS-held lock', async () => {
  const root = await tempRoot()
  const first = new Ledger({ root })
  await first.open()
  await fs.writeFile(first.lockPath, 'not metadata', { mode: 0o600 })
  const second = new Ledger({ root })
  await assert.rejects(second.open(), (error) => error.code === 'lock_active')
  await first.close()
})

test('legal JSON with malformed message/chain/budget records fails closed during load', async () => {
  const root = await tempRoot()
  const ledger = new Ledger({ root })
  await ledger.open()
  await ledger.mutate((state) => {
    state.chains.c1 = {
      id: 'c1',
      rootOwner: 'A',
      createdAt: 1,
      state: 'open',
      maxMessages: 20,
      maxHops: 8,
      messageCount: 1,
    }
    state.messages.push({
      id: 'm1',
      from: 'A',
      to: 'B',
      kind: 'notification',
      chainId: 'c1',
      hop: 0,
      createdAt: 1,
      content: { text: 'x', references: [], paths: [] },
      status: 'accepted',
      replyStatus: 'none',
      receipt: receiptFixture(),
      deliveryAttempts: 1,
      durableMessageId: 'host-1',
      error: null,
    })
  })
  await ledger.close()
  const statePath = path.join(root, 'ledger.json')
  const original = await fs.readFile(statePath, 'utf8')

  const variants = [
    (state) => {
      state.messages[0].status = 'bogus'
    },
    (state) => {
      state.chains.c1.state = 'bogus'
    },
    (state) => {
      state.messages[0].parentMessageId = 'missing-parent'
    },
    (state) => {
      delete state.settings.retentionDays
    },
    (state) => {
      state.settings.emergencyPaused = true
    },
    (state) => {
      state.settingsRevision = 0
    },
  ]
  for (const mutate of variants) {
    const parsed = JSON.parse(original)
    mutate(parsed)
    const raw = JSON.stringify(parsed)
    await fs.writeFile(statePath, raw, { mode: 0o600 })
    const reopened = new Ledger({ root })
    await assert.rejects(reopened.open(), (error) => error.code === 'storage_corrupt')
    assert.equal(await fs.readFile(statePath, 'utf8'), raw, 'malformed state must not be normalized or rewritten')
  }
})
