import test from 'node:test'
import assert from 'node:assert/strict'

import { HostAdapter } from '../src/host/adapter.js'
import { createSessionLinkPlugin } from '../src/host/plugin.js'
import { sha256 } from '../src/core/migration.js'
import { FakeClock, makeMockHost, sessionFixture, tempRoot } from './helpers.js'

function baseSessions() {
  return [
    sessionFixture({ id: 'A', title: 'Alpha' }),
    sessionFixture({ id: 'B', title: 'Beta' }),
  ]
}

async function mount(t) {
  const clock = new FakeClock()
  const host = makeMockHost({ clock, sessions: baseSessions() })
  const service = await createSessionLinkPlugin(host.ctx, { stateRoot: await tempRoot(), cacheMs: 0 }, {
    createUserMessage: host.createUserMessage,
    clock: () => clock.read(),
  })
  t.after(() => service.close())
  return { clock, host, service }
}

function operation(service) {
  return service.engine.mintOperation().operationId
}

test('five messages during one long turn are all visible at the next step, with no cancellation', async (t) => {
  const { host, service } = await mount(t)
  const target = host.agents.get('B')
  target.status = 'running'
  let cancels = 0
  target.cancel = () => {
    cancels += 1
  }
  const kinds = ['request', 'notification', 'request', 'notification', 'notification']
  const sent = []
  for (let index = 0; index < 5; index += 1) {
    sent.push(
      await service.engine.send({
        from: 'A',
        targets: ['B'],
        kind: kinds[index],
        text: `long-turn ${index}`,
        operationId: operation(service),
      }),
    )
  }
  assert.equal(host.steers.length, 5)
  assert.equal(host.followups.length, 0)
  assert.equal(target.inbox.nextTurn.length, 0)
  assert.equal(target.inbox.nextStep.length, 5)
  assert.equal(cancels, 0)
  for (const result of sent) assert.equal(result.results[0].status, 'accepted')
  for (const message of service.ledger.read().messages) {
    assert.equal(message.receipt.state, 'queued')
    assert.equal(message.deadlineAt, null)
  }

  const claimed = await host.claimNextStep('B')
  assert.equal(claimed.length, 5)
  await service.engine.drain()
  const snapshot = await service.snapshot({})
  assert.equal(snapshot.messages.length, 5)
  for (const message of snapshot.messages) {
    assert.equal(message.status, 'accepted')
    assert.equal(message.dispatchStatus, 'accepted')
    assert.equal(message.receipt.state, 'received')
    assert.ok(Number.isSafeInteger(message.receipt.receivedAt))
    assert.ok(Number.isSafeInteger(message.receipt.receivedSeq))
    if (message.kind === 'request') {
      assert.equal(message.deadlineAt, message.receipt.receivedAt + message.receipt.timeoutMs)
    } else {
      assert.equal(message.deadlineAt, null)
      assert.equal(message.completedAt, message.receipt.receivedAt)
    }
    assert.equal(message.receipt.transfer, null)
  }
  assert.equal(cancels, 0)

  const requestIds = sent.filter((_entry, index) => kinds[index] === 'request').map((entry) => entry.results[0].id)
  const replies = []
  for (const requestId of requestIds) {
    replies.push(
      await service.engine.reply({
        from: 'B',
        messageId: requestId,
        text: `answer ${requestId}`,
        operationId: operation(service),
      }),
    )
  }
  await host.claimNextStep('A')
  await service.engine.drain()
  const replied = service.ledger.read()
  for (const [index, requestId] of requestIds.entries()) {
    const parent = replied.messages.find((entry) => entry.id === requestId)
    const reply = replied.messages.find((entry) => entry.id === replies[index].results[0].id)
    assert.equal(parent.replyStatus, 'answered')
    assert.equal(parent.answeredBy, reply.id)
    assert.equal(reply.parentMessageId, requestId)
    assert.equal(reply.replyTo, requestId)
    assert.equal(reply.receipt.state, 'received')
  }
})

test('an idle target is woken by steer and only gets a deadline after its next step consumes the message', async (t) => {
  const { host, service } = await mount(t)
  const target = host.agents.get('B')
  assert.equal(target.status, 'idle')
  const sent = await service.engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'wake idle target',
    operationId: operation(service),
  })
  assert.equal(sent.results[0].status, 'accepted')
  assert.equal(target.status, 'running')
  assert.equal(target.inbox.nextStep.length, 1)
  let message = service.ledger.read().messages.find((entry) => entry.id === sent.results[0].id)
  assert.equal(message.receipt.state, 'queued')
  assert.equal(message.deadlineAt, null)

  await host.claimNextStep('B')
  await service.engine.drain()
  message = service.ledger.read().messages.find((entry) => entry.id === sent.results[0].id)
  assert.equal(message.receipt.state, 'received')
  assert.ok(Number.isSafeInteger(message.deadlineAt))
})

test('an aborted activity fallback parks the message in next-turn without faking a deadline', async (t) => {
  const { host, service } = await mount(t)
  const target = host.agents.get('B')
  target.status = 'running'
  target.steer = (message) => {
    target.inbox.splice('next-turn', Infinity, 0, [message])
  }
  const sent = await service.engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'parked by abort fallback',
    operationId: operation(service),
  })
  assert.equal(sent.results[0].status, 'accepted')
  assert.equal(target.inbox.nextStep.length, 0)
  assert.equal(target.inbox.nextTurn.length, 1)
  const message = service.ledger.read().messages.find((entry) => entry.id === sent.results[0].id)
  assert.equal(message.receipt.state, 'queued')
  assert.equal(message.deadlineAt, null)
})

function nativeMessage(id = 'host-old') {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text: 'original body' }],
    source: { kind: 'agent-message', form: 'relay', senderSessionId: 'A' },
  }
}

function moveRequest(hostMessage, queuePosition = 0, guard = () => true) {
  return {
    targetId: 'B',
    durableMessageId: hostMessage.id,
    senderSessionId: 'A',
    queuePosition,
    digest: sha256(Buffer.from(JSON.stringify(hostMessage), 'utf8')),
    guard,
  }
}

test('native move rolls the exact object back when steer throws and both queues are empty', async (t) => {
  const clock = new FakeClock()
  const host = makeMockHost({ clock, sessions: baseSessions() })
  const agent = host.agents.get('B')
  const message = nativeMessage()
  agent.inbox.splice('next-turn', 0, 0, [message])
  agent.status = 'running'
  const adapter = new HostAdapter({ ctx: host.ctx, createUserMessage: host.createUserMessage, clock: () => clock.read() })
  agent.steer = () => {
    throw new Error('steer failed')
  }
  const outcome = adapter.moveNativePending(moveRequest(message))
  assert.equal(outcome.outcome, 'rolled_back')
  assert.equal(agent.inbox.nextStep.length, 0)
  assert.equal(agent.inbox.nextTurn.length, 1)
  assert.equal(agent.inbox.nextTurn[0], message)
})

test('native move reports uncertain when remove commits but throws, and when steer falls back to next-turn', async (t) => {
  const clock = new FakeClock()
  const host = makeMockHost({ clock, sessions: baseSessions() })
  const agent = host.agents.get('B')
  const adapter = new HostAdapter({ ctx: host.ctx, createUserMessage: host.createUserMessage, clock: () => clock.read() })

  const first = nativeMessage('host-throw')
  agent.inbox.splice('next-turn', 0, 0, [first])
  agent.status = 'running'
  const originalRemove = agent.inbox.remove
  agent.inbox.remove = (id) => {
    originalRemove(id)
    throw new Error('remove acknowledged then threw')
  }
  const thrown = adapter.moveNativePending(moveRequest(first))
  assert.equal(thrown.outcome, 'uncertain')
  assert.equal(agent.inbox.nextTurn.length, 0)
  assert.equal(agent.inbox.nextStep.length, 0)

  agent.inbox.remove = originalRemove
  const second = nativeMessage('host-fallback')
  agent.inbox.splice('next-turn', 0, 0, [second])
  agent.steer = (message) => {
    agent.inbox.splice('next-turn', Infinity, 0, [message])
  }
  const fallback = adapter.moveNativePending(moveRequest(second))
  assert.equal(fallback.outcome, 'fallback_next_turn')
  assert.equal(agent.inbox.nextStep.length, 0)
  assert.equal(agent.inbox.nextTurn.length, 1)
})

test('native move refuses a source/body/digest mismatch or a false guard without touching the queue', async (t) => {
  const clock = new FakeClock()
  const host = makeMockHost({ clock, sessions: baseSessions() })
  const agent = host.agents.get('B')
  const adapter = new HostAdapter({ ctx: host.ctx, createUserMessage: host.createUserMessage, clock: () => clock.read() })
  const message = nativeMessage()
  agent.inbox.splice('next-turn', 0, 0, [message])
  agent.status = 'running'
  const request = moveRequest(message)
  assert.equal(adapter.moveNativePending({ ...request, digest: 'f'.repeat(64) }).outcome, 'mismatch')
  assert.equal(adapter.moveNativePending({ ...request, senderSessionId: 'X' }).outcome, 'mismatch')
  assert.equal(adapter.moveNativePending({ ...request, guard: () => false }).outcome, 'blocked')
  assert.equal(agent.inbox.nextTurn.length, 1)
  assert.equal(agent.inbox.nextStep.length, 0)
})
