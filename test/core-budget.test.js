import test from 'node:test'
import assert from 'node:assert/strict'

import { FakeClock, MemoryAdapter, openEngine, sessionFixture, tempRoot } from './helpers.js'

/**
 * These are deliberate reverse tests for the v0.1 quotas. Every case that used
 * to be rejected by a pair/session/global/daily/held cap must now succeed when
 * it only crosses that retired threshold. The only remaining rejections are
 * format/storage envelopes, tested elsewhere.
 */

function sessions(count) {
  return [sessionFixture({ id: 'A' }), ...Array.from({ length: count }, (_, index) => sessionFixture({ id: `T${index}` }))]
}

async function setup(t, options = {}) {
  const clock = new FakeClock()
  const root = await tempRoot()
  const adapter = new MemoryAdapter({ clock, sessions: options.sessions ?? sessions(3) })
  const opened = await openEngine({ root, adapter, clock, limits: options.limits })
  t.after(async () => {
    await opened.engine.dispose()
    await opened.ledger.close()
  })
  return { ...opened, clock, adapter, root }
}

function op(engine) {
  return engine.mintOperation().operationId
}

test('pair and per-session caps are gone: >12 pair messages and >30 one-source sends are accepted', async (t) => {
  const { engine, ledger } = await setup(t)
  for (let index = 0; index < 31; index += 1) {
    const sent = await engine.send({
      from: 'A',
      targets: ['T0'],
      kind: 'notification',
      text: `no quota ${index}`,
      operationId: op(engine),
    })
    assert.equal(sent.results[0].status, 'accepted')
  }
  const state = ledger.read()
  assert.equal(state.messages.filter((message) => message.status === 'accepted').length, 31)
  assert.equal(state.budget, undefined, 'no rolling-window budget state may exist')
  assert.equal(state.latches, undefined, 'no quota latch may exist')
})

test('global/window/delivery/daily caps are gone: >300 zero-pace messages are accepted', async (t) => {
  const { engine, ledger } = await setup(t)
  for (let index = 0; index < 301; index += 1) {
    const sent = await engine.send({
      from: 'A',
      targets: ['T0'],
      kind: 'notification',
      text: `daily ${index}`,
      operationId: op(engine),
    })
    assert.equal(sent.results[0].status, 'accepted')
  }
  const state = ledger.read()
  assert.equal(state.messages.length, 301)
  assert.equal(state.messages.every((message) => message.status === 'accepted'), true)
})

test('ten targets and many unanswered same-pair requests are accepted in one batch', async (t) => {
  const { engine } = await setup(t, { sessions: sessions(10) })
  const targets = Array.from({ length: 10 }, (_, index) => `T${index}`)
  const first = await engine.send({
    from: 'A',
    targets,
    kind: 'request',
    text: 'ten targets',
    operationId: op(engine),
  })
  assert.equal(first.results.length, 10)
  assert.equal(first.results.every((entry) => entry.status === 'accepted'), true)
  for (let index = 0; index < 13; index += 1) {
    const sent = await engine.send({
      from: 'A',
      targets: ['T0'],
      kind: 'request',
      text: `unanswered same pair ${index}`,
      operationId: op(engine),
    })
    assert.equal(sent.results[0].status, 'accepted')
  }
})

test('paused queue accepts >20 records and >256KiB, then resumes all without release', async (t) => {
  const { engine, ledger } = await setup(t)
  const paused = await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { paused: true },
  })
  assert.equal(paused.settings.paused, true)
  for (let index = 0; index < 21; index += 1) {
    const sent = await engine.send({
      from: 'A',
      targets: ['T0'],
      kind: 'notification',
      text: `held ${index}`,
      operationId: op(engine),
    })
    assert.equal(sent.results[0].status, 'held')
  }
  for (let index = 0; index < 5; index += 1) {
    const sent = await engine.send({
      from: 'A',
      targets: ['T0'],
      kind: 'notification',
      text: 'x'.repeat(60_000),
      operationId: op(engine),
    })
    assert.equal(sent.results[0].status, 'held')
  }
  const held = ledger.read().messages.filter((message) => message.status === 'held')
  assert.equal(held.length, 26)
  const queuedBytes = held.reduce((total, message) => total + message.contentBytes, 0)
  assert.ok(queuedBytes > 256 * 1024, `expected >256KiB held payload, got ${queuedBytes}`)

  const resumed = await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { paused: false },
  })
  assert.equal(resumed.resumed, 26)
  await engine.drain()
  assert.equal(ledger.read().messages.every((message) => message.status === 'accepted'), true)
})
