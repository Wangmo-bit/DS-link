// Node-subprocess guard for the stress fixture's uninitialized actions.
//
// The host treats a rejected exact-Fetch handler as a fatal load failure. This
// test intentionally calls actions before `init`, asserts they return the
// `{ok:false,error}` envelope, and fails if any rejected promise escapes as an
// unhandled rejection.
import assert from 'node:assert/strict'
import { StressFixture } from '../fixtures/stress.js'

const unhandled = []
process.on('unhandledRejection', (error) => {
  unhandled.push(error)
})

const ctx = {
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

const home = '/tmp/dsh-session-link-fixture-guard'
const fixture = new StressFixture(ctx, home, () => ({}))

async function call(action, payload = {}) {
  const request = new Request('http://127.0.0.1:3098/api/session-link-stress-fixture', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, payload }),
  })
  const response = await fixture.handle(request)
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.ok, false)
  assert.equal(typeof body.error?.code, 'string')
  return body.error.code
}

const evidenceCode = await call('evidence', { sessionId: 'missing' })
const idleCode = await call('idle', { sessionId: 'missing' })
const invokeCode = await call('invoke', { sessionId: 'missing', name: 'session_link_list', args: {} })
await new Promise((resolve) => setTimeout(resolve, 50))
assert.deepEqual(unhandled, [])
assert.equal(evidenceCode, 'not_initialized')
assert.equal(idleCode, 'not_initialized')
assert.equal(invokeCode, 'not_initialized')
console.log('fixture guard: uninitialized evidence/idle/invoke returned error envelopes with no unhandled rejection')
