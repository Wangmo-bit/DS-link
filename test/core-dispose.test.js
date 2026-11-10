import test from 'node:test'
import assert from 'node:assert/strict'

import { SessionLinkEngine } from '../src/core/engine.js'
import { createSessionLinkPlugin } from '../src/host/plugin.js'
import { FakeClock, MemoryAdapter, makeMockHost, openEngine, sessionFixture, tempRoot } from './helpers.js'

async function setup(t) {
  const clock = new FakeClock()
  const root = await tempRoot()
  const adapter = new MemoryAdapter({
    clock,
    sessions: [sessionFixture({ id: 'A' }), sessionFixture({ id: 'B' }), sessionFixture({ id: 'C' })],
  })
  const opened = await openEngine({ root, adapter, clock })
  t.after(async () => {
    await opened.engine.dispose()
    await opened.ledger.close()
  })
  return { ...opened, clock, adapter, root }
}

test('dispose aborts an uncommitted followup and leaves cold evidence to the next generation', async (t) => {
  const { engine, ledger, adapter, clock } = await setup(t)
  let release
  let enteredResolve
  const entered = new Promise((resolve) => {
    enteredResolve = resolve
  })
  adapter.deliver = async (request) => {
    const before = await request.beforeResolve()
    if (before?.ok !== true) return { stage: 'blocked', blocked: before }
    enteredResolve()
    await new Promise((resolve) => {
      release = resolve
    })
    const gate = await request.beforeFollowup()
    if (gate?.ok !== true) return { stage: 'blocked', blocked: gate }
    adapter.markInserted(request.targetId, request.hostMessage.id, request.hostMessage.source?.senderSessionId)
    return { stage: 'accepted' }
  }
  const sending = engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'unload during dispatch',
    operationId: engine.mintOperation().operationId,
  })
  await entered
  const disposing = engine.dispose()
  release()
  const result = await sending
  const disposed = await disposing
  assert.equal(disposed.drained, true)
  assert.equal(disposed.storageSafe, true)
  assert.equal(adapter.inserted.size, 0, 'the final gate must abort the followup after dispose')
  assert.equal(result.results[0].status === 'dispatching' || result.results[0].status === 'pending', true)
  assert.equal(ledger.read().messages[0].status, 'dispatching')

  const next = new SessionLinkEngine({ ledger, adapter, clock: () => clock.read() })
  await next.start()
  assert.equal(ledger.read().messages[0].status, 'unknown')
  assert.equal(adapter.inserted.size, 0, 'the next generation must not resend')
  await next.dispose()
})


test('close starts engine disposal before awaiting a blocked async disposer', async (t) => {
  const clock = new FakeClock()
  const root = await tempRoot()
  const sessions = [sessionFixture({ id: 'A' }), sessionFixture({ id: 'B' })]
  const host = makeMockHost({ sessions, clock })
  const originalRegister = host.ctx.connection.fetch.register.bind(host.ctx.connection.fetch)
  let releaseDisposer
  let disposerEnteredResolve
  const disposerEntered = new Promise((resolve) => {
    disposerEnteredResolve = resolve
  })
  const disposerGate = new Promise((resolve) => {
    releaseDisposer = resolve
  })
  host.ctx.connection.fetch.register = (route) => {
    const dispose = originalRegister(route)
    return async () => {
      disposerEnteredResolve()
      await disposerGate
      await dispose()
    }
  }
  const service = await createSessionLinkPlugin(host.ctx, { stateRoot: root, cacheMs: 0 }, {
    createUserMessage: host.createUserMessage,
    clock: () => clock.read(),
  })
  let releaseAttempt
  let attemptEnteredResolve
  const attemptEntered = new Promise((resolve) => {
    attemptEnteredResolve = resolve
  })
  const originalDeliver = service.engine.adapter.deliver.bind(service.engine.adapter)
  service.engine.adapter.deliver = async (request) => {
    if (request.targetId === 'B') {
      attemptEnteredResolve()
      await new Promise((resolve) => {
        releaseAttempt = resolve
      })
    }
    return originalDeliver(request)
  }
  t.after(async () => {
    releaseAttempt?.()
    releaseDisposer?.()
    await service.close().catch(() => undefined)
  })
  const sending = service.engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'blocked by disposer',
    operationId: service.engine.mintOperation().operationId,
  })
  await attemptEntered
  const closing = service.close()
  assert.equal(service.close(), closing)
  await disposerEntered
  releaseAttempt()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(host.followups.length, 0, 'a blocked disposer must not let the old attempt follow up')
  releaseDisposer()
  await closing
  await sending
  assert.equal(host.followups.length, 0)
})


test('forced dispose is bounded, counts slot waiters, and ignores a late host result', async (t) => {
  const { engine, ledger, adapter } = await setup(t)
  await engine.updateSettings({
    expectedSettingsRevision: ledger.read().settingsRevision,
    patch: { maxConcurrent: 1 },
  })
  let releaseDelivery
  let enteredResolve
  const entered = new Promise((resolve) => {
    enteredResolve = resolve
  })
  adapter.deliver = async (request) => {
    const before = await request.beforeResolve()
    if (before?.ok !== true) return { stage: 'blocked', blocked: before }
    if (request.targetId === 'B') {
      enteredResolve()
      await new Promise((resolve) => {
        releaseDelivery = resolve
      })
    }
    const gate = await request.beforeFollowup()
    if (gate?.ok !== true) return { stage: 'blocked', blocked: gate }
    adapter.markInserted(request.targetId, request.hostMessage.id, 'A')
    return { stage: 'accepted' }
  }
  const sending = engine.send({
    from: 'A',
    targets: ['B', 'C'],
    kind: 'notification',
    text: 'hung host',
    operationId: engine.mintOperation().operationId,
  })
  await entered
  const started = Date.now()
  const disposed = await engine.dispose()
  const elapsed = Date.now() - started
  assert.equal(disposed.timedOut, true)
  assert.ok(elapsed >= 4500, `dispose should wait about five seconds, got ${elapsed}ms`)
  assert.equal(disposed.storageSafe, true)
  assert.equal(disposed.markedUnknown, 1)
  const byTarget = new Map(ledger.read().messages.map((message) => [message.to, message]))
  assert.equal(byTarget.get('B').status, 'unknown')
  assert.equal(byTarget.get('C').status, 'pending', 'the slot waiter must not be left dispatching')
  releaseDelivery()
  const result = await sending
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(ledger.read().messages.find((message) => message.to === 'B').status, 'unknown')
  assert.equal(adapter.inserted.size, 0)
  assert.equal(result.results.find((entry) => entry.target === 'C').status, 'pending')
})

test('plugin close is idempotent, disposes route/tools/section, and a new generation opens the same root', async (t) => {
  const clock = new FakeClock()
  const root = await tempRoot()
  const sessions = [sessionFixture({ id: 'A', title: 'Alpha' }), sessionFixture({ id: 'B', title: 'Beta' })]
  const firstHost = makeMockHost({ sessions, clock })
  const first = await createSessionLinkPlugin(firstHost.ctx, { stateRoot: root, cacheMs: 0 }, {
    createUserMessage: firstHost.createUserMessage,
    clock: () => clock.read(),
  })
  const sent = await first.engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'before unload',
    operationId: first.engine.mintOperation().operationId,
  })
  assert.equal(sent.results[0].status, 'accepted')

  const close1 = first.close()
  const close2 = first.close()
  assert.equal(close1, close2)
  await Promise.all([close1, close2])
  assert.equal(firstHost.tools.size, 0)
  assert.equal(firstHost.routes.size, 0)
  assert.equal(firstHost.promptSections.length, 0)
  assert.equal(firstHost.provided.has('sessionLink'), false)

  const secondHost = makeMockHost({ sessions, clock })
  const second = await createSessionLinkPlugin(secondHost.ctx, { stateRoot: root, cacheMs: 0 }, {
    createUserMessage: secondHost.createUserMessage,
    clock: () => clock.read(),
  })
  t.after(() => second.close())
  assert.equal((await second.snapshot({})).version, '0.8.19-pre.2')
  assert.equal((await second.snapshot({})).messages.length, 1)
  const again = await second.engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'after reload',
    operationId: second.engine.mintOperation().operationId,
  })
  assert.equal(again.results[0].status, 'accepted')
  assert.equal(secondHost.tools.size, 8)
  assert.equal(secondHost.routes.size, 1)
})
