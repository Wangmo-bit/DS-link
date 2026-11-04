// Local smoke test for the v0.3 test fixture guards and route envelope.
// The Host treats a rejected exact-Fetch handler as a fatal load failure, so
// this test asserts error envelopes and zero unhandled rejections without a
// live Host, package install, or server start/stop.
import assert from 'node:assert/strict'

import * as fixtureModule from '../fixtures/v03.js'

const unhandled = []
process.on('unhandledRejection', (error) => {
  unhandled.push(error)
})

const home = '/tmp/dsh-session-link-v03-fixture-guard'
const originalHome = process.env.DSH_HOME
const originalTest = process.env.SESSION_LINK_TEST

class FakeLlmAdapter {}

const registeredTools = []
const ctx = {
  get: () => undefined,
  workspaceRegistry: { list: () => [], archivedSessionIds: [] },
  sessionController: {
    create: async () => ({}),
    selectModel: async () => ({}),
    resolveAgent: async () => ({}),
  },
  sessionQuery: { readSession: async () => ({}), listSessions: async () => [] },
  agents: { get: () => undefined },
  sessions: { flush: async () => true },
  tools: {
    get: () => undefined,
    register: (definition) => {
      registeredTools.push(definition)
      return () => undefined
    },
  },
  llm: { registerAdapter: () => () => undefined },
  connection: { fetch: { register: async () => () => undefined } },
}
const createUserMessage = () => ({})

async function expectGuard(fn, label) {
  try {
    await fn()
  } catch (error) {
    assert.equal(error?.code, 'fixture_guard', `${label}: expected fixture_guard, got ${error?.code ?? 'success'}`)
    return
  }
  throw new Error(`${label}: expected fixture_guard, call succeeded`)
}

delete process.env.SESSION_LINK_TEST
delete process.env.DSH_HOME
await expectGuard(() => fixtureModule.installV03Fixture(ctx, { home, createUserMessage, LlmAdapter: FakeLlmAdapter }), 'SESSION_LINK_TEST guard')

process.env.SESSION_LINK_TEST = '1'
await expectGuard(
  () => fixtureModule.installV03Fixture(ctx, { home, createUserMessage }),
  'LlmAdapter guard',
)

await expectGuard(
  () => fixtureModule.installV03Fixture(ctx, { home: '/tmp/not-a-session-link-home', createUserMessage, LlmAdapter: FakeLlmAdapter }),
  'home prefix guard',
)

process.env.DSH_HOME = '/tmp/dsh-session-link-different'
await expectGuard(() => fixtureModule.installV03Fixture(ctx, { home, createUserMessage, LlmAdapter: FakeLlmAdapter }), 'DSH_HOME match guard')

process.env.DSH_HOME = home
let registeredRoute
ctx.connection.fetch.register = async (route) => {
  registeredRoute = route
  return async () => undefined
}
const fixture = await fixtureModule.installV03Fixture(ctx, { home, createUserMessage, LlmAdapter: FakeLlmAdapter })
assert.equal(fixture.path, '/api/session-link-v03-fixture')
assert.equal(registeredRoute?.path, fixture.path, 'fixture must register its exact route path')
assert.deepEqual(registeredRoute?.methods, ['POST'])
assert.equal(registeredRoute?.requestBody, 'buffered')
assert.equal(typeof registeredRoute?.fetch, 'function')
assert.deepEqual(fixture.actions.includes('hold.start'), true)
assert.deepEqual(fixture.actions.includes('evidence'), true)
assert.deepEqual(fixture.actions.includes('guard.owner'), true)
assert.equal(fixtureModule.inject, undefined, 'v03 fixture must not inject sessionLink')
assert.equal(registeredTools.length, 1)
assert.equal(registeredTools[0]?.name, 'v03_hold')
assert.equal(typeof registeredTools[0]?.execute, 'function')

const toolSignal = new AbortController()
await assert.rejects(
  () => registeredTools[0].execute({}, { agent: { id: 'not-the-target' }, signal: toolSignal.signal, callId: 'guard-call' }),
  (error) => error?.code === 'not_initialized',
)

async function call(action, payload = {}, expectedStatus = 200) {
  const response = await registeredRoute.fetch(
    new Request('http://127.0.0.1:3098/api/session-link-v03-fixture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, payload }),
    }),
  )
  const body = await response.json()
  assert.equal(response.status, expectedStatus)
  assert.equal(body.ok, false)
  assert.equal(typeof body.error?.code, 'string')
  return body.error.code
}

const wrongMethod = await registeredRoute.fetch(
  new Request('http://127.0.0.1:3098/api/session-link-v03-fixture', {
    method: 'GET',
  }),
)
assert.equal(wrongMethod.status, 405)
assert.equal((await wrongMethod.json()).error.code, 'method_not_allowed')

const wrongType = await registeredRoute.fetch(
  new Request('http://127.0.0.1:3098/api/session-link-v03-fixture', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'not json',
  }),
)
assert.equal(wrongType.status, 415)

const badJson = await registeredRoute.fetch(
  new Request('http://127.0.0.1:3098/api/session-link-v03-fixture', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  }),
)
assert.equal(badJson.status, 400)

const extraKey = await registeredRoute.fetch(
  new Request('http://127.0.0.1:3098/api/session-link-v03-fixture', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'service.status', payload: {}, extra: true }),
  }),
)
assert.equal(extraKey.status, 400)

assert.equal(await call('unknown.action', {}, 400), 'unknown_action')
assert.equal(await call('hold.status'), 'not_initialized')
assert.equal(await call('evidence'), 'not_initialized')
assert.equal(await call('native.user'), 'not_initialized')
assert.equal(await call('ledger.info'), 'service_unavailable')

const service = await registeredRoute.fetch(
  new Request('http://127.0.0.1:3098/api/session-link-v03-fixture', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'service.status', payload: {} }),
  }),
)
const serviceBody = await service.json()
assert.equal(serviceBody.ok, true)
assert.equal(serviceBody.value.found, false)

const ownerGate = await registeredRoute.fetch(
  new Request('http://127.0.0.1:3098/api/session-link-v03-fixture', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'guard.owner', payload: {} }),
  }),
)
const ownerGateBody = await ownerGate.json()
assert.equal(ownerGateBody.ok, true)
assert.equal(ownerGateBody.value.supported, false)

await fixture.dispose()
await new Promise((resolve) => setTimeout(resolve, 50))
assert.deepEqual(unhandled, [])
process.env.DSH_HOME = originalHome
process.env.SESSION_LINK_TEST = originalTest
console.log('v03 fixture guard: environment guards, exact route envelope, and uninitialized actions produced no unhandled rejection')
