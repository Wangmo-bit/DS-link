// Guard test for the v0.4 fixture's isolated-home fence.
//
// Everything here uses the real filesystem: mkdtemp homes under
// /tmp/dsh-session-link-*, a second non-prefixed tmp directory as the external
// target, and real symlinks. No Host is started, no server is opened, and every
// temporary path is removed in the finally block. Production directories are
// never touched.
//
//   node --test scripts/v04/fixture-guard.test.mjs
import assert from 'node:assert/strict'
import { lstat, mkdtemp, readdir, rm, stat, symlink, unlink } from 'node:fs/promises'
import path from 'node:path'

import * as fixtureModule from '../fixtures/v04.js'

const unhandled = []
process.on('unhandledRejection', (error) => {
  unhandled.push(error)
})

const originalHome = process.env.DSH_HOME
const originalTest = process.env.SESSION_LINK_TEST
const cleanup = []

async function tmpIsolated(prefix) {
  const target = await mkdtemp(path.join('/tmp', prefix))
  cleanup.push(target)
  return target
}

async function tmpExternal() {
  const target = await mkdtemp(path.join('/tmp', 'v04-external-'))
  cleanup.push(target)
  return target
}

async function tmpLink(target, name) {
  const link = path.join('/tmp', name)
  await symlink(target, link)
  cleanup.push(link)
  return link
}

async function cleanupAll() {
  for (const entry of cleanup.splice(0, cleanup.length)) {
    try {
      const info = await lstat(entry)
      if (info.isSymbolicLink()) await unlink(entry)
      else await rm(entry, { recursive: true, force: true })
    } catch {
      // Already gone.
    }
  }
}

/** Minimal Host stand-in: enough surface for install/init/envelope checks. */
function createFakeHost() {
  const workspaces = []
  const sessions = new Map()
  const agents = new Map()
  const routes = []
  const adapters = []
  const ctx = {
    get: () => undefined,
    workspaceRegistry: {
      get archivedSessionIds() {
        return []
      },
      list: () => workspaces.map((workspace) => ({ ...workspace, sessionIds: [...workspace.sessionIds] })),
      create: async (dir, title) => {
        const workspace = {
          id: `ws-${workspaces.length + 1}`,
          path: dir,
          title,
          sessionIds: [],
          attachSession: async (sessionId) => {
            if (!workspace.sessionIds.includes(sessionId)) workspace.sessionIds.push(sessionId)
          },
        }
        workspaces.push(workspace)
        return { id: workspace.id, path: workspace.path, title: workspace.title, sessionIds: [] }
      },
    },
    sessionController: {
      create: async ({ workspaceId }) => {
        const sessionId = `session-${String(sessions.size + 1).padStart(4, '0')}`
        const workspace = workspaces.find((item) => item.id === workspaceId)
        workspace?.sessionIds.push(sessionId)
        agents.set(sessionId, { id: sessionId, status: 'idle' })
        sessions.set(sessionId, { id: sessionId, title: null })
        return { sessionId }
      },
      rename: async ({ sessionId, title }) => {
        const session = sessions.get(sessionId)
        if (session === undefined) throw new Error('unknown session')
        session.title = title
        return { title, seq: 1 }
      },
      resolveAgent: async (sessionId) => {
        const agent = agents.get(sessionId)
        return agent === undefined ? { error: { code: 'session_not_found' } } : { agent }
      },
      modelCatalog: async () => ({ default: null, routableProviders: [], groups: [], failures: [] }),
      // Mirrors the real dsh-api-session-controller contract: projections reads
      // signal.throwIfAborted() first, so a call without a signal throws.
      projections: async (request, signal) => {
        if (signal === undefined || typeof signal.throwIfAborted !== 'function') {
          throw new TypeError('Cannot read properties of undefined (reading aborted)')
        }
        signal.throwIfAborted()
        if (typeof request?.sessionId !== 'string' || request.sessionId.length === 0) throw new Error('sessionId is required')
        return {
          kind: 'sequenced',
          asOfSeq: 7,
          values: {
            modelSelection: { lastUsed: null, next: null },
            permissions: { currentValue: 'workspace-write' },
            goal: null,
          },
        }
      },
    },
    sessionQuery: {
      readSession: async (sessionId) =>
        sessions.has(sessionId)
          ? { session: { version: 'v4', id: sessionId, createdAt: 1, isSeeded: false }, inheritedEventCount: 0, events: [] }
          : null,
      listSessions: async () =>
        [...sessions.values()].map((session) => ({
          header: { id: session.id, createdAt: 1, isSeeded: false },
          live: true,
          persisted: true,
          formatStatus: 'current',
        })),
      readTitleSnapshots: async (ids) =>
        ids.map((id) => {
          const title = sessions.get(id)?.title
          return {
            sessionId: id,
            status: 'fulfilled',
            value: title ? { title: { title, messageSeqs: [], source: { kind: 'user' }, eventSeq: 0, updatedAt: 1 } } : undefined,
          }
        }),
    },
    agents: { get: (sessionId) => agents.get(sessionId) },
    sessions: { flush: async () => true },
    tools: { get: () => undefined },
    llm: {
      registerAdapter: (providers, adapter) => {
        adapters.push({ providers, adapter })
        return () => undefined
      },
    },
    connection: {
      fetch: {
        register: async (route) => {
          routes.push(route)
          return () => undefined
        },
      },
    },
  }
  return { ctx, routes, adapters, workspaces, sessions }
}

class FakeLlmAdapter {}

async function expectGuard(fn, label) {
  try {
    await fn()
  } catch (error) {
    assert.equal(error?.code, 'fixture_guard', `${label}: expected fixture_guard, got ${error?.code ?? 'success'} (${error?.message ?? ''})`)
    return
  }
  throw new Error(`${label}: expected fixture_guard, call succeeded`)
}

async function post(route, body) {
  const response = await route.fetch(
    new Request('http://127.0.0.1:3098/api/session-link-v04-fixture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  return { status: response.status, body: await response.json() }
}

try {
  const home = await tmpIsolated('dsh-session-link-v04-guard-')
  const otherHome = await tmpIsolated('dsh-session-link-v04-other-')
  const external = await tmpExternal()
  const suffix = path.basename(home).slice(-6)
  const linkExternal = await tmpLink(external, `dsh-session-link-v04-link-${suffix}`)
  const linkOther = await tmpLink(otherHome, `dsh-session-link-v04-link2-${suffix}`)
  const host = createFakeHost()
  const install = (options) =>
    fixtureModule.installV04Fixture(host.ctx, { home, createUserMessage: () => ({}), LlmAdapter: FakeLlmAdapter, ...options })

  delete process.env.SESSION_LINK_TEST
  delete process.env.DSH_HOME
  await expectGuard(() => install(), 'SESSION_LINK_TEST guard')

  process.env.SESSION_LINK_TEST = '1'
  await expectGuard(() => install(), 'DSH_HOME missing guard')
  process.env.DSH_HOME = ''
  await expectGuard(() => install(), 'DSH_HOME empty guard')

  process.env.DSH_HOME = otherHome
  await expectGuard(() => install({ home }), 'different home guard')

  process.env.DSH_HOME = linkExternal
  await expectGuard(() => install({ home: linkExternal }), 'home symlink to non-isolated target guard')

  process.env.DSH_HOME = linkOther
  await expectGuard(() => install({ home: linkOther }), 'home symlink to another isolated home guard')

  process.env.DSH_HOME = external
  await expectGuard(() => install({ home: external }), 'home prefix guard')

  process.env.DSH_HOME = home
  await expectGuard(() => fixtureModule.installV04Fixture(host.ctx, { home, createUserMessage: () => ({}) }), 'LlmAdapter guard')

  assert.equal(host.routes.length, 0, 'no route may be registered before a guarded install succeeds')

  const fixture = await fixtureModule.installV04Fixture(host.ctx, { home, createUserMessage: () => ({}), LlmAdapter: FakeLlmAdapter })
  assert.equal(fixture.path, '/api/session-link-v04-fixture')
  assert.equal(host.routes.length, 1, 'exactly one route must be registered')
  const route = host.routes[0]
  assert.equal(route.path, fixture.path, 'fixture must register its exact route path')
  assert.deepEqual(route.methods, ['POST'])
  assert.equal(route.requestBody, 'buffered')
  assert.equal(typeof route.fetch, 'function')
  assert.deepEqual([...fixture.actions], ['init', 'invoke', 'evidence', 'defaults', 'snapshot', 'guard.owner'])
  assert.equal(fixtureModule.inject, undefined, 'v04 fixture must not export inject')
  assert.equal(host.adapters.length, 1, 'exactly one scripted adapter must be registered')
  assert.deepEqual(host.adapters[0].providers, ['session-link-v04-fixture'])
  assert.equal(host.adapters[0].adapter.constructor.name, 'ScriptedV04Adapter')

  // Route envelope.
  const wrongMethod = await route.fetch(new Request('http://127.0.0.1:3098/api/session-link-v04-fixture', { method: 'GET' }))
  assert.equal(wrongMethod.status, 405)
  assert.equal((await wrongMethod.json()).error.code, 'method_not_allowed')

  const wrongType = await route.fetch(
    new Request('http://127.0.0.1:3098/api/session-link-v04-fixture', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'not json',
    }),
  )
  assert.equal(wrongType.status, 415)

  const badJson = await route.fetch(
    new Request('http://127.0.0.1:3098/api/session-link-v04-fixture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    }),
  )
  assert.equal(badJson.status, 400)

  const extraKey = await post(route, { action: 'defaults', payload: {}, extra: true })
  assert.equal(extraKey.status, 400)
  assert.equal(extraKey.body.error.code, 'bad_request')

  const unknown = await post(route, { action: 'unknown.action', payload: {} })
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body.error.code, 'unknown_action')

  for (const action of ['invoke', 'evidence']) {
    const result = await post(route, { action, payload: {} })
    assert.equal(result.status, 200, `${action}: unexpected status`)
    assert.equal(result.body.ok, false)
    assert.equal(result.body.error.code, 'not_initialized')
  }

  const snapshot = await post(route, { action: 'snapshot', payload: {} })
  assert.equal(snapshot.body.ok, true)
  assert.equal(snapshot.body.value.initialized, false)
  assert.equal(snapshot.body.value.actorId, null)
  assert.deepEqual(snapshot.body.value.counts, { workspaces: 0, sessions: 0 })
  assert.equal(snapshot.body.value.tools.session_link_create, false)

  const defaults = await post(route, { action: 'defaults', payload: {} })
  assert.equal(defaults.body.ok, true)
  assert.equal(defaults.body.value.fixture.provider, 'session-link-v04-fixture')
  assert.deepEqual(defaults.body.value.capabilities, {
    agentDefaultModel: false,
    modelCatalog: true,
    projections: true,
    permissionPresets: false,
    readTitleSnapshots: true,
  })

  const ownerGate = await post(route, { action: 'guard.owner', payload: {} })
  assert.equal(ownerGate.body.ok, true)
  assert.equal(ownerGate.body.value.supported, false)

  await fixture.dispose()

  // ---- Real write fence -------------------------------------------------
  // A `v04-testroot` symlinked out of the home must stop init before anything
  // is created outside, and a clean init must stay inside the home.
  const writeHome = await tmpIsolated('dsh-session-link-v04-guard2-')
  const writeExternal = await tmpExternal()
  await symlink(writeExternal, path.join(writeHome, 'v04-testroot'))
  const writeHost = createFakeHost()
  process.env.DSH_HOME = writeHome
  const writeFixture = await fixtureModule.installV04Fixture(writeHost.ctx, {
    home: writeHome,
    createUserMessage: () => ({}),
    LlmAdapter: FakeLlmAdapter,
  })
  const writeRoute = writeHost.routes[0]

  const escaped = await post(writeRoute, { action: 'init', payload: {} })
  assert.equal(escaped.body.ok, false, 'init through an escaping testroot symlink must be rejected')
  assert.equal(
    escaped.body.error.code,
    'fixture_guard',
    `expected fixture_guard, got ${escaped.body.error.code}: ${escaped.body.error.message}`,
  )
  assert.deepEqual(await readdir(writeExternal), [], 'nothing may be written outside the isolated home')

  await unlink(path.join(writeHome, 'v04-testroot'))
  const init = await post(writeRoute, { action: 'init', payload: {} })
  assert.equal(init.body.ok, true, `init failed: ${JSON.stringify(init.body.error ?? null)}`)
  assert.equal(init.body.value.selectModelUsed, false)
  assert.equal(init.body.value.workspace.path, path.join(writeHome, 'v04-actor'))
  assert.equal(init.body.value.emptyWorkspace.path, path.join(writeHome, 'v04-empty-workspace'))
  assert.equal(init.body.value.testroot.parent, path.join(writeHome, 'v04-testroot/parent'))
  assert.notEqual(init.body.value.actor2.id, init.body.value.actor.id, 'actor and actor2 must be different sessions')
  assert.equal(init.body.value.actor2.title, 'v04 actor2')

  // The projections read must survive the real SDK's signal requirement: the
  // fake host throws exactly like dsh-api-session-controller when no signal is
  // passed, so `present: true` proves the fixture forwarded one.
  const actorEvidence = await post(writeRoute, { action: 'evidence', payload: { sessionId: init.body.value.actor.id } })
  assert.equal(actorEvidence.body.ok, true, `evidence failed: ${JSON.stringify(actorEvidence.body.error ?? null)}`)
  assert.equal(actorEvidence.body.value.projections.present, true, 'projections must be read with a signal')
  assert.equal(actorEvidence.body.value.projections.kind, 'sequenced')
  assert.deepEqual(actorEvidence.body.value.projections.keys, ['goal', 'modelSelection', 'permissions'])
  assert.equal(actorEvidence.body.value.projections.error, undefined)

  // Only the fixture's own ordinary sessions may invoke tools.
  const unknownSession = await post(writeRoute, {
    action: 'invoke',
    payload: { sessionId: 'session-9999', name: 'session_link_operation', args: {} },
  })
  assert.equal(unknownSession.body.ok, false)
  assert.equal(unknownSession.body.error.code, 'forbidden_session')
  const actor2Session = await post(writeRoute, {
    action: 'invoke',
    payload: { sessionId: init.body.value.actor2.id, name: 'session_link_operation', args: {} },
  })
  assert.equal(actor2Session.body.ok, false, 'actor2 must pass the session gate')
  assert.equal(actor2Session.body.error.code, 'tool_unavailable', 'actor2 reached the tool lookup, so the allowlist accepted it')

  for (const relative of ['v04-actor', 'v04-empty-workspace', 'v04-testroot/parent']) {
    const info = await stat(path.join(writeHome, relative))
    assert.equal(info.isDirectory(), true, `${relative} must be a directory inside the home`)
  }
  const stateInfo = await stat(path.join(writeHome, 'v04-state.json'))
  assert.equal(stateInfo.mode & 0o777, 0o600, 'fixture state must be written with mode 0600')
  assert.deepEqual(await readdir(writeExternal), [], 'the clean init must not write outside the home')

  const repeatInit = await post(writeRoute, { action: 'init', payload: {} })
  assert.equal(repeatInit.body.ok, true, 'init must be idempotent for an existing state')
  assert.equal(repeatInit.body.value.actor.id, init.body.value.actor.id)
  assert.equal(repeatInit.body.value.actor2.id, init.body.value.actor2.id)

  await writeFixture.dispose()

  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(unhandled, [], 'guard test produced an unhandled rejection')
  console.log(
    'v04 fixture guard: env/home/DSH_HOME/realpath/symlink fences, write fence, route envelope, and adapter registration hold',
  )
} finally {
  await cleanupAll()
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  if (originalTest === undefined) delete process.env.SESSION_LINK_TEST
  else process.env.SESSION_LINK_TEST = originalTest
}
