import test from 'node:test'
import assert from 'node:assert/strict'

import { createSessionLinkPlugin, normalizeConfig, resolveStateRoot } from '../src/host/plugin.js'
import { FakeClock, makeMockHost, sessionFixture, tempRoot } from './helpers.js'

function baseSessions() {
  return [
    sessionFixture({ id: 'A', title: 'Alpha', workspaceId: 'w-1' }),
    sessionFixture({ id: 'B', title: 'Beta', workspaceId: 'w-1' }),
  ]
}

async function mount(options) {
  const { host, root, clock } = options
  const service = await createSessionLinkPlugin(host.ctx, { stateRoot: root, cacheMs: 0 }, {
    createUserMessage: host.createUserMessage,
    clock: () => clock.read(),
  })
  return service
}

test('host delivery resolves the target Agent, uses steer+flush, never prompt, and keeps the standard source', async (t) => {
  const clock = new FakeClock()
  const host = makeMockHost({ clock, sessions: baseSessions() })
  let promptCalls = 0
  host.ctx.sessionController.prompt = () => {
    promptCalls += 1
  }
  const root = await tempRoot()
  const service = await mount({ host, root, clock })
  t.after(() => service.close())

  const sent = await service.engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'host path',
    operationId: service.engine.mintOperation().operationId,
  })
  assert.equal(sent.results[0].status, 'accepted')
  assert.equal(promptCalls, 0)
  assert.equal(host.steers.length, 1)
  assert.equal(host.steers[0].targetId, 'B')
  assert.equal(host.agents.get('B').session.id, 'B')
  assert.deepEqual(Object.keys(host.steers[0].message.source).sort(), ['form', 'kind', 'senderSessionId'])
  assert.equal(host.steers[0].message.source.senderSessionId, 'A')
  assert.match(host.steers[0].message.content[0].text, /session-link request from A/)
})

test('a writer-held target fails before followup; a false flush is unknown', async (t) => {
  const clock = new FakeClock()
  const host = makeMockHost({ clock, sessions: baseSessions() })
  const root = await tempRoot()
  const service = await mount({ host, root, clock })
  t.after(() => service.close())

  const originalResolve = host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent = async () => ({ error: { code: 'agent_writer_held' } })
  clock.advance(1001)
  const failed = await service.engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'writer held',
    operationId: service.engine.mintOperation().operationId,
  })
  assert.equal(failed.results[0].status, 'failed')
  assert.equal(service.ledger.read().messages[0].error.code, 'agent_writer_held')
  assert.equal(host.steers.length, 0)
  host.ctx.sessionController.resolveAgent = originalResolve

  const originalFlush = host.ctx.sessions.flush
  host.ctx.sessions.flush = async () => false
  clock.advance(1001)
  const unknown = await service.engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'flush false',
    operationId: service.engine.mintOperation().operationId,
  })
  assert.equal(unknown.results[0].status, 'unknown')
  assert.equal(host.steers.length, 1)
  host.ctx.sessions.flush = originalFlush
})

test('the same state root is single-writer across plugin instances', async (t) => {
  const clock = new FakeClock()
  const root = await tempRoot()
  const firstHost = makeMockHost({ clock, sessions: baseSessions() })
  const first = await mount({ host: firstHost, root, clock })
  const secondHost = makeMockHost({ clock, sessions: baseSessions() })
  await assert.rejects(mount({ host: secondHost, root, clock }), (error) => error.code === 'lock_active')
  await first.close()
  const thirdHost = makeMockHost({ clock, sessions: baseSessions() })
  const third = await mount({ host: thirdHost, root, clock })
  await third.close()
})

test('plugin restart recovers dispatching rows from the mock host log without resending', async (t) => {
  const clock = new FakeClock()
  const logs = new Map()
  const sessions = baseSessions()
  const root = await tempRoot()
  const firstHost = makeMockHost({ clock, sessions, logs })
  const first = await mount({ host: firstHost, root, clock })
  const sent = await first.engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'recover me',
    operationId: first.engine.mintOperation().operationId,
  })
  await firstHost.claimNextStep('B')
  const durableMessageId = first.ledger.read().messages[0].durableMessageId
  await first.ledger.mutate((state) => {
    state.messages[0].status = 'dispatching'
  })
  await first.close()

  const secondHost = makeMockHost({ clock, sessions, logs })
  const second = await mount({ host: secondHost, root, clock })
  t.after(() => second.close())
  const recovered = second.ledger.read().messages.find((message) => message.id === sent.results[0].id)
  assert.equal(recovered.status, 'accepted')
  assert.equal(recovered.recoveryEvidence, 'message')
  assert.equal(recovered.durableMessageId, durableMessageId)
  assert.equal(secondHost.followups.length, 0)
})

test('deps limits override plugin config and snapshot reports the actual byte envelopes', async (t) => {
  const clock = new FakeClock()
  const host = makeMockHost({ clock, sessions: baseSessions() })
  const root = await tempRoot()
  const service = await createSessionLinkPlugin(
    host.ctx,
    { stateRoot: root, cacheMs: 0, maxLedgerBytes: 999_999, maxQueuedBytes: 888_888 },
    {
      createUserMessage: host.createUserMessage,
      clock: () => clock.read(),
      limits: { maxDiskBytes: 20_000, maxQueuedBytes: 300 },
    },
  )
  t.after(() => service.close())
  const snapshot = await service.snapshot({})
  assert.equal(snapshot.technicalLimits.maxLedgerBytes, 20_000)
  assert.equal(snapshot.technicalLimits.maxQueuedBytes, 300)
  assert.equal(snapshot.storage.maxBytes, 20_000)
  assert.equal(snapshot.storage.maxQueuedBytes, 300)
  assert.throws(() => normalizeConfig({ maxLedgerBytes: 0 }), /positive safe integer/)
  assert.throws(() => normalizeConfig({ maxQueuedBytes: -1 }), /positive safe integer/)
  assert.equal(normalizeConfig({ maxLedgerBytes: 1000, maxQueuedBytes: 2000 }).maxLedgerBytes, 1000)
})

test('profile/state-root resolution uses optional profile context and DSH_HOME without touching a production profile', () => {
  assert.equal(
    resolveStateRoot({ get: (name) => (name === 'profileContext' ? { name: 'dev/profile', home: '/tmp/dsh-home' } : undefined) }, {}),
    '/tmp/dsh-home/state/dsh-session-link/dev_profile',
  )
  assert.equal(
    resolveStateRoot({ get: () => undefined }, { profileName: '../escape' }),
    `${process.env.DSH_HOME?.trim() || `${process.env.HOME}/.dsh`}/state/dsh-session-link/escape`,
  )
  assert.throws(() => normalizeConfig({ stateRoot: 'relative/path' }), /absolute path/)
  assert.throws(() => normalizeConfig({ unknown: true }), /unknown session-link config/)
  assert.throws(() => normalizeConfig({ tickMs: 1 }), /below 1000/)
  assert.equal(normalizeConfig({ profileName: '..' }).profileName, 'default')
})
