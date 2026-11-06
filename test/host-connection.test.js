import test from 'node:test'
import assert from 'node:assert/strict'

import { CONNECTION_METHODS, CONNECTION_PATH } from '../src/host/connection.js'
import { createSessionLinkPlugin } from '../src/host/plugin.js'
import { FakeClock, makeMockHost, sessionFixture, tempRoot } from './helpers.js'

async function mount(t) {
  const clock = new FakeClock()
  const host = makeMockHost({
    clock,
    sessions: [
      sessionFixture({ id: 'A', title: 'Alpha' }),
      sessionFixture({ id: 'B', title: 'Beta' }),
    ],
  })
  const service = await createSessionLinkPlugin(host.ctx, { stateRoot: await tempRoot(), cacheMs: 0 }, {
    createUserMessage: host.createUserMessage,
    clock: () => clock.read(),
  })
  t.after(() => service.close())
  const route = host.routes.get(CONNECTION_PATH)
  const request = async (body, init = {}) => {
    const requestBody = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    return route.fetch(
      new Request(`http://127.0.0.1:3098${CONNECTION_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
        ...(requestBody === undefined ? {} : { body: requestBody }),
        ...init,
      }),
    )
  }
  return { clock, host, service, route, request }
}

test('the control plane is one exact POST fetch route with a bare JSON envelope', async (t) => {
  const { route } = await mount(t)
  assert.equal(CONNECTION_PATH, '/api/session-link/api')
  assert.deepEqual([...CONNECTION_METHODS], ['POST'])
  assert.deepEqual([...route.methods], ['POST'])
  assert.equal(route.requestBody, 'buffered')
  assert.equal(typeof route.fetch, 'function')
})

test('snapshot returns revision, settings, messages, chains, sessions, and total', async (t) => {
  const { service, request } = await mount(t)
  const op = service.engine.mintOperation().operationId
  await service.engine.send({ from: 'A', targets: ['B'], kind: 'request', text: 'hello', operationId: op })
  const response = await request({ action: 'snapshot', payload: { limit: 10, offset: 0, filter: 'all' } })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(typeof body.value.revision, 'number')
  assert.equal(body.value.settings.enabled, true)
  assert.equal(body.value.apiVersion, 3)
  assert.equal(body.value.version, '0.5.0')
  assert.equal(typeof body.value.settingsRevision, 'number')
  assert.equal(body.value.storage.health, 'ok')
  assert.equal(body.value.storage.maxQueuedBytes > 0, true)
  assert.equal(body.value.technicalLimits.maxCallBytes, 1024 * 1024)
  assert.equal(body.value.technicalLimits.maxLedgerBytes, 50 * 1024 * 1024)
  assert.equal(body.value.technicalLimits.maxQueuedBytes, 16 * 1024 * 1024)
  assert.equal(body.value.messages.length, 1)
  assert.equal(body.value.messages[0].status, 'accepted')
  assert.equal(body.value.messages[0].dispatchStatus, 'accepted')
  assert.equal(body.value.messages[0].text, 'hello')
  assert.equal(body.value.messages[0].content.text, 'hello')
  assert.equal(body.value.chains.length, 1)
  assert.equal(body.value.sessions.length, 2)
  assert.equal(body.value.sessions[0].id, body.value.sessions[0].sessionId)
  assert.equal(body.value.total, 1)
  assert.deepEqual(body.value.budgetLatches, [])
})

test('snapshot filters received/sent/pending_reply/abnormal/unknown/held and requires sessionId or chainId', async (t) => {
  const { request, service } = await mount(t)
  const op = service.engine.mintOperation().operationId
  const sent = await service.engine.send({ from: 'A', targets: ['B'], kind: 'request', text: 'filter me', operationId: op })
  const invalid = await request({ action: 'snapshot', payload: { filter: 'received' } })
  assert.equal((await invalid.json()).ok, false)
  const chainInvalid = await request({ action: 'snapshot', payload: { filter: 'chain' } })
  assert.equal((await chainInvalid.json()).ok, false)
  const valid = await request({ action: 'snapshot', payload: { filter: 'received', sessionId: 'B' } })
  const validBody = await valid.json()
  assert.equal(validBody.ok, true)
  assert.equal(validBody.value.messages.length, 1)
  const sentFilter = await request({ action: 'snapshot', payload: { filter: 'sent', sessionId: 'A' } })
  assert.equal((await sentFilter.json()).value.messages.length, 1)
  const pending = await request({ action: 'snapshot', payload: { filter: 'pending_reply' } })
  assert.equal((await pending.json()).value.messages.length, 1)
  const chained = await request({ action: 'snapshot', payload: { filter: 'chain', chainId: sent.chainId } })
  const chainedBody = await chained.json()
  assert.equal(chainedBody.value.messages.length, 1)
  assert.equal(chainedBody.value.messages[0].chainId, sent.chainId)
  const bad = await request({ action: 'snapshot', payload: { filter: 'not-a-filter' } })
  const badBody = await bad.json()
  assert.equal(badBody.ok, false)
  assert.equal(badBody.error.code, 'invalid_argument')
})

test('settings use expectedSettingsRevision CAS, reject old parameters, and keep a no-op stable', async (t) => {
  const { request } = await mount(t)
  const initial = await (await request({ action: 'snapshot', payload: {} })).json()
  const revision = initial.value.revision
  const settingsRevision = initial.value.settingsRevision
  const updated = await request({
    action: 'settings',
    payload: { expectedSettingsRevision: settingsRevision, patch: { maxConcurrent: 5 } },
  })
  const updatedBody = await updated.json()
  assert.equal(updatedBody.ok, true)
  assert.equal(updatedBody.value.settings.maxConcurrent, 5)
  assert.equal(updatedBody.value.settingsRevision, settingsRevision + 1)
  assert.equal(updatedBody.value.revision, revision + 1)
  assert.equal(updatedBody.value.queued, 0)
  assert.equal(updatedBody.value.resumed, 0)

  const stale = await request({
    action: 'settings',
    payload: { expectedSettingsRevision: settingsRevision, patch: { maxConcurrent: 6 } },
  })
  const staleBody = await stale.json()
  assert.equal(staleBody.ok, false)
  assert.equal(staleBody.error.code, 'revision_conflict')
  assert.equal(staleBody.error.details.currentSettingsRevision, settingsRevision + 1)

  const oldExpected = await request({
    action: 'settings',
    payload: { expectedRevision: revision, patch: { maxConcurrent: 7 } },
  })
  assert.equal((await oldExpected.json()).error.code, 'invalid_argument')

  const legacy = await request({
    action: 'settings',
    payload: { expectedSettingsRevision: settingsRevision + 1, patch: { maxTextChars: 4000 } },
  })
  const legacyBody = await legacy.json()
  assert.equal(legacyBody.error.code, 'policy_removed')
  assert.equal(legacyBody.error.details.removedKeys.includes('maxTextChars'), true)
})

test('control requires CAS and resume_budget is a policy_removed error without a latch id', async (t) => {
  const { service, request } = await mount(t)
  await service.engine.send({ from: 'A', targets: ['B'], kind: 'notification', text: 'bump', operationId: service.engine.mintOperation().operationId })
  const snapshot = await (await request({ action: 'snapshot', payload: {} })).json()
  const removed = await request({
    action: 'control',
    payload: { expectedRevision: snapshot.value.revision, action: 'resume_budget' },
  })
  assert.equal((await removed.json()).error.code, 'policy_removed')

  const stale = await request({
    action: 'control',
    payload: { expectedRevision: snapshot.value.revision - 1, action: 'cancel', id: 'missing' },
  })
  assert.equal((await stale.json()).error.code, 'revision_conflict')
  assert.equal(service.engine !== undefined, true)
})

test('malformed transport is explicit and unknown actions fail closed', async (t) => {
  const { request } = await mount(t)
  assert.equal((await request('{bad json')).status, 400)
  assert.equal((await request({ action: 'snapshot' }, { headers: { 'content-type': 'text/plain' } })).status, 415)
  const get = await request(undefined, { method: 'GET' })
  assert.equal(get.status, 405)
  const unknown = await request({ action: 'delete-everything' })
  const body = await unknown.json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'invalid_argument')
  const extra = await request({ action: 'snapshot', payload: {}, extra: true })
  assert.equal((await extra.json()).error.code, 'bad_request')
})

test('service.handleRpc applies the same envelope without a transport', async (t) => {
  const { service } = await mount(t)
  const value = await service.handleRpc({ action: 'snapshot', payload: { limit: 1 } })
  assert.equal(typeof value.revision, 'number')
  await assert.rejects(service.handleRpc({ action: 'unknown' }), (error) => error.code === 'invalid_argument')
})

test('snapshot materializes only chains touched by the page plus an explicit chain query', async (t) => {
  const { service, request, clock } = await mount(t)
  clock.advance(1001)
  const first = await service.engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'first chain',
    operationId: service.engine.mintOperation().operationId,
  })
  clock.advance(1001)
  const second = await service.engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'second chain',
    operationId: service.engine.mintOperation().operationId,
  })
  const page = await (await request({ action: 'snapshot', payload: { limit: 1, filter: 'all' } })).json()
  assert.equal(page.value.messages.length, 1)
  assert.equal(page.value.hasMore, true)
  assert.equal(page.value.nextOffset, 1)
  assert.equal(page.value.messages[0].chainId, second.chainId)
  assert.equal(page.value.chains.length, 1)
  assert.equal(page.value.chains[0].id, second.chainId)

  const explicit = await (
    await request({ action: 'snapshot', payload: { limit: 1, filter: 'all', chainId: first.chainId } })
  ).json()
  assert.equal(explicit.value.messages[0].chainId, first.chainId)
  assert.equal(explicit.value.chains.length, 1)
  assert.equal(explicit.value.chains[0].id, first.chainId)
})
