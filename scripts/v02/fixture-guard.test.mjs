// Local smoke test for the v0.2 test fixture guards and uninitialized actions.
// The Host treats a rejected exact-Fetch handler as a fatal load failure, so
// this test asserts error envelopes and zero unhandled rejections.
import assert from 'node:assert/strict'

import { installV02Fixture } from '../fixtures/v02.js'

const unhandled = []
process.on('unhandledRejection', (error) => {
  unhandled.push(error)
})

const home = '/tmp/dsh-session-link-v02-fixture-guard'
const originalHome = process.env.DSH_HOME
const originalTest = process.env.SESSION_LINK_TEST

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
  tools: { get: () => undefined },
  connection: { fetch: { register: async () => () => {} } },
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
await expectGuard(() => installV02Fixture(ctx, { home, createUserMessage }), 'SESSION_LINK_TEST guard')

process.env.SESSION_LINK_TEST = '1'
await expectGuard(() => installV02Fixture(ctx, { home: '/tmp/not-a-session-link-home', createUserMessage }), 'home prefix guard')

process.env.DSH_HOME = '/tmp/dsh-session-link-different'
await expectGuard(() => installV02Fixture(ctx, { home, createUserMessage }), 'DSH_HOME match guard')

process.env.DSH_HOME = home
let handler
const register = async (options) => {
  handler = options.fetch
  return async () => undefined
}
ctx.connection.fetch.register = register
const fixture = await installV02Fixture(ctx, { home, createUserMessage })
assert.equal(typeof handler, 'function')
assert.deepEqual(fixture.actions.includes('barrier.arm'), true)

async function call(action, payload = {}, expectedStatus = 200) {
  const response = await handler(new Request('http://127.0.0.1:3098/api/session-link-v02-fixture', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, payload }),
  }))
  const body = await response.json()
  assert.equal(response.status, expectedStatus)
  assert.equal(body.ok, false)
  assert.equal(typeof body.error?.code, 'string')
  return body.error.code
}

assert.equal(await call('evidence', { sessionId: 'missing' }), 'not_initialized')
assert.equal(await call('idle', { sessionId: 'missing' }), 'not_initialized')
assert.equal(await call('invoke', { sessionId: 'missing', name: 'session_link_list', args: {} }), 'not_initialized')
assert.equal(await call('barrier.arm'), 'service_unavailable')
const emptyStatus = await handler(new Request('http://127.0.0.1:3098/api/session-link-v02-fixture', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'barrier.status', payload: {} }),
}))
const emptyBody = await emptyStatus.json()
assert.equal(emptyBody.ok, true)
assert.equal(emptyBody.value.current.found, false)
assert.equal(await call('state.info'), 'service_unavailable')
assert.equal(await call('legacy.prepare'), 'service_unavailable')
assert.equal(await call('unknown.action', {}, 400), 'unknown_action')

await fixture.dispose()
await new Promise((resolve) => setTimeout(resolve, 50))
assert.deepEqual(unhandled, [])
process.env.DSH_HOME = originalHome
process.env.SESSION_LINK_TEST = originalTest
console.log('v02 fixture guard: environment guards and uninitialized actions returned error envelopes with no unhandled rejection')
