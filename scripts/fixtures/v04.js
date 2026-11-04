/**
 * Test-only v0.4 real-host integration fixture.
 *
 * Scope: this module is NOT part of the production package. Lead wires it into
 * scripts/fixtures/index.js only under SESSION_LINK_TEST=1 and a dedicated
 * /tmp/dsh-session-link-* DSH_HOME. It never reads credentials, never touches
 * 127.0.0.1:3080, never starts or stops a Host, and never opens a raw
 * webServer route: the route is registered through ctx.connection.fetch, so the
 * Host's owner-only principal gate and exact-route matching run before the
 * handler.
 *
 * The fixture exists so Lead can measure the new `session_link_create` tool on
 * a real Host:
 *   - `init`     create an isolated actor workspace + ordinary actor session and
 *                an empty registered workspace (0 sessions) with the real SDK.
 *                It deliberately does NOT call selectModel anywhere: a target
 *                session must keep the system new-session default model and
 *                permission, and selectModel may persist a deployment default.
 *   - `invoke`   execute one real `session_link_*` tool through the same
 *                owner/tool path the model uses (definition.execute with
 *                exec.agent = the fixture actor). It is not a second tool
 *                implementation.
 *   - `evidence` bounded sessionQuery read: event ids/bodies/source/turn plus
 *                the session row, registered workspace, durable title, and the
 *                modelSelection/permissions/goal/agentPreset projections. No
 *                environment values and no credentials are ever returned.
 *   - `defaults` the deployment default model / default permission preset used
 *                as the "new session defaults" baseline, plus capability flags.
 *   - `snapshot` workspace/session counts used to prove that a rejected create
 *                produced no new session and no new workspace.
 *   - `guard.owner` the non-owner Peer probe for the owner-only exact route.
 *
 * Contract:
 *   const { installV04Fixture } = await import('./v04.js')
 *   const fixture = await installV04Fixture(ctx, { home, createUserMessage, LlmAdapter })
 *   ctx.effect(() => () => fixture.dispose())
 *
 * Body: bare { action, payload } -> { ok: true, value } |
 *       { ok: false, error: { code, message } }.
 *
 * The fixture does not export `inject` and does not inject `sessionLink`, so a
 * package hot swap cannot silently change what these actions read.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const V04_FIXTURE_PATH = '/api/session-link-v04-fixture'
export const V04_PROVIDER = 'session-link-v04-fixture'
export const V04_MODEL = 'v04-fixture'
export const V04_ACTIONS = Object.freeze(['init', 'invoke', 'evidence', 'defaults', 'snapshot', 'guard.owner'])

const HOME_PREFIX = '/tmp/dsh-session-link-'
const STATE_VERSION = 2
const STATE_FILE = 'v04-state.json'
const ACTOR_DIRECTORY = 'v04-actor'
const EMPTY_WORKSPACE_DIRECTORY = 'v04-empty-workspace'
const TESTROOT_DIRECTORY = 'v04-testroot'
const PARENT_DIRECTORY = 'parent'
const ACTOR_TITLE = 'v04 actor'
const ACTOR2_TITLE = 'v04 actor2'
const EMPTY_WORKSPACE_TITLE = 'v04 empty workspace'

const MAX_BODY_BYTES = 256 * 1024
const MAX_TOOL_RESULT_BYTES = 256 * 1024
const MAX_ARGS_BYTES = 64 * 1024
const MAX_TEXT_CHARS = 4096
const MAX_EVIDENCE_EVENTS = 500
const MAX_SNAPSHOT_SESSIONS = 500
const MAX_SNAPSHOT_WORKSPACES = 200
const MAX_SESSION_IDS_PER_WORKSPACE = 500
const MAX_TITLE_IDS = 200
const MAX_PROJECTION_BYTES = 8 * 1024
const MAX_MODEL_GROUPS = 50
const MAX_MODELS_PER_GROUP = 50
const DEFAULT_TIMEOUT_MS = 30_000
const INVOKE_TIMEOUT_MS = 60_000
const PROJECTION_TIMEOUT_MS = 15_000
const EVIDENCE_EVENT_TYPES = Object.freeze([
  'user/message',
  'assistant/message',
  'agent/inbox/spliced',
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
])
const TOOL_PROBE_NAMES = Object.freeze([
  'session_link_operation',
  'session_link_list',
  'session_link_send',
  'session_link_reply',
  'session_link_status',
  'session_link_create',
  'card_lookup',
])

class FixtureError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** @param {string} code @param {string} message */
function fail(code, message) {
  throw new FixtureError(code, message)
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} error @returns {{ code: string, message: string }} */
function errorInfo(error) {
  const code = typeof error?.code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(error.code) ? error.code : 'fixture_error'
  const message = typeof error?.message === 'string' && error.message.length > 0 ? error.message : 'v04 fixture action failed'
  return { code, message: message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500) }
}

/** @param {string} value @param {string} label */
function assertIsolatedLexical(value, label) {
  if (!value.startsWith(HOME_PREFIX) || value.length <= HOME_PREFIX.length) {
    throw new FixtureError('fixture_guard', `v04 fixture ${label} must be under /tmp/dsh-session-link-*`)
  }
}

/**
 * Fail-closed isolated-home validation, run before the route is installed.
 *
 * DSH_HOME must be present and identical to the requested home, and both must
 * resolve through realpath to the canonical location of that isolated root, so
 * a home such as /tmp/dsh-session-link-evil -> <user-home>/.dsh can never load
 * the fixture. Every later write re-checks that it stays inside this root.
 *
 * @param {string} home
 * @returns {Promise<{ root: string, realRoot: string }>}
 */
async function requireTestHome(home) {
  if (process.env.SESSION_LINK_TEST !== '1') {
    throw new FixtureError('fixture_guard', 'v04 fixture requires SESSION_LINK_TEST=1')
  }
  if (typeof home !== 'string' || home.length === 0 || home.includes('\0')) {
    throw new FixtureError('fixture_guard', 'v04 fixture requires an isolated home path')
  }
  const envHome = process.env.DSH_HOME
  if (typeof envHome !== 'string' || envHome.length === 0 || envHome.includes('\0')) {
    throw new FixtureError('fixture_guard', 'v04 fixture requires DSH_HOME to be set to the isolated home')
  }
  const root = path.resolve(home)
  const envRoot = path.resolve(envHome)
  assertIsolatedLexical(root, 'home')
  assertIsolatedLexical(envRoot, 'DSH_HOME')
  if (root !== envRoot) {
    throw new FixtureError('fixture_guard', 'v04 fixture home does not match DSH_HOME')
  }
  let realRoot
  try {
    realRoot = await realpath(root)
  } catch (error) {
    throw new FixtureError('fixture_guard', `v04 fixture home cannot be resolved: ${error?.code ?? error?.message}`)
  }
  let realEnv
  try {
    realEnv = await realpath(envRoot)
  } catch (error) {
    throw new FixtureError('fixture_guard', `DSH_HOME cannot be resolved: ${error?.code ?? error?.message}`)
  }
  if (realRoot !== realEnv) {
    throw new FixtureError('fixture_guard', 'v04 fixture home does not match DSH_HOME after symlink resolution')
  }
  let realTmp
  try {
    realTmp = await realpath('/tmp')
  } catch {
    realTmp = '/tmp'
  }
  const expectedRoot = path.join(realTmp, path.relative('/tmp', root))
  if (realRoot !== expectedRoot) {
    throw new FixtureError('fixture_guard', `v04 fixture home resolves through a symlink outside its isolated root: ${realRoot}`)
  }
  const info = await stat(realRoot)
  if (!info.isDirectory()) throw new FixtureError('fixture_guard', 'v04 fixture home must be a directory')
  return { root, realRoot }
}

/** @param {Record<string, any>} ctx */
function requireHostCapabilities(ctx) {
  if (ctx === undefined || ctx === null) throw new FixtureError('fixture_guard', 'v04 fixture requires ctx')
  for (const name of ['workspaceRegistry', 'sessionController', 'sessionQuery', 'agents', 'sessions', 'tools', 'connection']) {
    if (ctx[name] === undefined || ctx[name] === null) {
      throw new FixtureError('fixture_guard', `v04 fixture requires ctx.${name}`)
    }
  }
  if (typeof ctx.llm?.registerAdapter !== 'function') throw new FixtureError('fixture_guard', 'v04 fixture requires ctx.llm.registerAdapter')
  if (typeof ctx.connection.fetch?.register !== 'function') throw new FixtureError('fixture_guard', 'v04 fixture requires ctx.connection.fetch.register')
  if (typeof ctx.workspaceRegistry.create !== 'function') throw new FixtureError('fixture_guard', 'v04 fixture requires ctx.workspaceRegistry.create')
  if (typeof ctx.workspaceRegistry.list !== 'function') throw new FixtureError('fixture_guard', 'v04 fixture requires ctx.workspaceRegistry.list')
  if (typeof ctx.sessionController.create !== 'function') throw new FixtureError('fixture_guard', 'v04 fixture requires ctx.sessionController.create')
  if (typeof ctx.sessionController.resolveAgent !== 'function') throw new FixtureError('fixture_guard', 'v04 fixture requires ctx.sessionController.resolveAgent')
  if (typeof ctx.sessionController.rename !== 'function') throw new FixtureError('fixture_guard', 'v04 fixture requires ctx.sessionController.rename')
  if (typeof ctx.sessionQuery.readSession !== 'function') throw new FixtureError('fixture_guard', 'v04 fixture requires ctx.sessionQuery.readSession')
  if (typeof ctx.sessionQuery.listSessions !== 'function') throw new FixtureError('fixture_guard', 'v04 fixture requires ctx.sessionQuery.listSessions')
  if (typeof ctx.agents.get !== 'function') throw new FixtureError('fixture_guard', 'v04 fixture requires ctx.agents.get')
  if (typeof ctx.sessions.flush !== 'function') throw new FixtureError('fixture_guard', 'v04 fixture requires ctx.sessions.flush')
  if (typeof ctx.tools.get !== 'function') throw new FixtureError('fixture_guard', 'v04 fixture requires ctx.tools.get')
  // selectModel is intentionally NOT required and never called: it can persist
  // a deployment default, which would break the "new session defaults" rule.
}

/** @param {unknown} value @returns {string} */
function textOfContent(value) {
  if (!Array.isArray(value)) return ''
  return value
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** @param {unknown} value @param {number} [max] @returns {string} */
function boundedText(value, max = MAX_TEXT_CHARS) {
  if (typeof value !== 'string') return ''
  return value.length > max ? value.slice(0, max) : value
}

/** @param {unknown} source @returns {Record<string, string>|null} */
function sourceView(source) {
  if (!isPlainObject(source)) return null
  const result = {}
  for (const key of Object.keys(source).sort()) {
    if (typeof source[key] === 'string') result[key] = source[key]
  }
  return result
}

/** @param {unknown} value @param {readonly string[]} keys @returns {Record<string, any>} */
function pick(value, keys) {
  const out = {}
  if (!isPlainObject(value)) return out
  for (const key of keys) {
    if (value[key] !== undefined) out[key] = value[key]
  }
  return out
}

/** @param {unknown} value @returns {any} */
function jsonSafe(value) {
  if (value === undefined) return null
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    return { unserializable: true }
  }
  if (typeof text !== 'string') return null
  if (Buffer.byteLength(text, 'utf8') > MAX_PROJECTION_BYTES) {
    return { truncated: true, bytes: Buffer.byteLength(text, 'utf8') }
  }
  try {
    return JSON.parse(text)
  } catch {
    return { unserializable: true }
  }
}

class V04Fixture {
  /**
   * @param {Record<string, any>} ctx
   * @param {string} home validated lexical home root
   * @param {string} realRoot validated real home root
   * @param {(input: Record<string, any>) => Record<string, any>} [createUserMessage]
   * @param {new (...args: any[]) => any} LlmAdapter
   */
  constructor(ctx, home, realRoot, createUserMessage, LlmAdapter) {
    requireHostCapabilities(ctx)
    if (typeof LlmAdapter !== 'function') {
      throw new FixtureError('fixture_guard', 'v04 fixture requires the Host LlmAdapter class')
    }
    if (typeof home !== 'string' || typeof realRoot !== 'string' || home.length === 0 || realRoot.length === 0) {
      throw new FixtureError('fixture_guard', 'v04 fixture requires a validated isolated home root')
    }
    this.ctx = ctx
    this.home = home
    this.realRoot = realRoot
    this.createUserMessage = typeof createUserMessage === 'function' ? createUserMessage : undefined
    this.LlmAdapter = LlmAdapter
    this.stateFile = path.join(home, STATE_FILE)
    this.actorDir = path.join(home, ACTOR_DIRECTORY)
    this.emptyWorkspaceDir = path.join(home, EMPTY_WORKSPACE_DIRECTORY)
    this.testroot = path.join(home, TESTROOT_DIRECTORY)
    this.parentDir = path.join(this.testroot, PARENT_DIRECTORY)
    this.instanceId = randomUUID()
    this.initializations = Promise.resolve()
    this.adapterDispose = undefined
    this.disposed = false
    this.actorId = undefined
  }

  /** @param {string} lexical @returns {string|null} */
  #expectedReal(lexical) {
    const relative = path.relative(this.home, path.resolve(lexical))
    if (relative === '') return this.realRoot
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null
    return path.join(this.realRoot, relative)
  }

  /**
   * Resolve a write target and fail closed when any existing component
   * crosses a symlink out of the validated isolated root.
   * @param {string} target
   * @returns {Promise<string>}
   */
  async #safeTarget(target) {
    const resolved = path.resolve(target)
    if (!resolved.startsWith(this.home + path.sep)) {
      fail('fixture_guard', `write target escapes the verified isolated home: ${resolved}`)
    }
    let probe = resolved
    for (let depth = 0; depth < 64; depth += 1) {
      let real
      try {
        real = await realpath(probe)
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
          fail('fixture_guard', `write target cannot be resolved: ${error?.code ?? error?.message}`)
        }
        const parent = path.dirname(probe)
        if (parent === probe || (parent !== this.home && !parent.startsWith(this.home + path.sep))) {
          fail('fixture_guard', `write target has no existing ancestor inside the verified home: ${resolved}`)
        }
        probe = parent
        continue
      }
      const expected = this.#expectedReal(probe)
      if (expected === null || real !== expected) {
        fail('fixture_guard', `write target resolves through a symlink outside the verified home: ${resolved} -> ${real}`)
      }
      return resolved
    }
    fail('fixture_guard', `write target ancestor walk exceeded its bound: ${resolved}`)
  }

  /** @param {() => Promise<any>} task @returns {Promise<any>} */
  #serializeInit(task) {
    const run = this.initializations.then(task, task)
    this.initializations = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** @returns {Promise<void>} */
  async start() {
    const fixture = this
    const Base = this.LlmAdapter
    class ScriptedV04Adapter extends Base {
      async listModels(provider) {
        return [{ provider, id: V04_MODEL, name: 'Local scripted v0.4 model (no API cost)', inputModalities: ['text'] }]
      }

      async resolveModel(provider, model) {
        return {
          provider,
          model,
          id: model,
          name: 'Local scripted v0.4 model',
          context: { contextWindow: 262144 },
          inputModalities: ['text'],
        }
      }

      /** @param {Record<string, any>} options */
      async *stream(options) {
        options.signal?.throwIfAborted()
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'V04_FIXTURE_ACK: local scripted model processed the input.' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'V04_FIXTURE_ACK: local scripted model processed the input.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    this.adapterDispose = this.ctx.llm.registerAdapter([V04_PROVIDER], new ScriptedV04Adapter())
    if (typeof this.adapterDispose !== 'function') this.adapterDispose = undefined
  }

  /** @returns {Promise<Record<string, any>|undefined>} */
  async #loadState() {
    const file = await this.#safeTarget(this.stateFile)
    let raw
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw new FixtureError('state_unreadable', 'v04 fixture state could not be read')
    }
    let state
    try {
      state = JSON.parse(raw)
    } catch {
      throw new FixtureError('state_corrupt', 'v04 fixture state is not valid JSON')
    }
    if (!isPlainObject(state) || state.version !== STATE_VERSION) fail('state_corrupt', 'v04 fixture state has an unsupported version')
    if (state.home !== this.home) fail('state_corrupt', 'v04 fixture state belongs to a different home')
    if (!isPlainObject(state.workspace) || !isPlainObject(state.emptyWorkspace) || !isPlainObject(state.sessions?.actor) || !isPlainObject(state.sessions?.actor2)) {
      fail('state_corrupt', 'v04 fixture state is incomplete')
    }
    if (typeof state.sessions.actor.id !== 'string' || state.sessions.actor.id.length === 0) {
      fail('state_corrupt', 'v04 fixture state has no actor session')
    }
    if (typeof state.sessions.actor2.id !== 'string' || state.sessions.actor2.id.length === 0) {
      fail('state_corrupt', 'v04 fixture state has no actor2 session')
    }
    if (state.sessions.actor.id === state.sessions.actor2.id) {
      fail('state_corrupt', 'v04 fixture state reuses one session for actor and actor2')
    }
    if (typeof state.parentDir !== 'string' || state.parentDir !== this.parentDir) {
      fail('state_corrupt', 'v04 fixture state parentDir does not match this home')
    }
    return state
  }

  /**
   * @param {Record<string, any>} state
   * @returns {Promise<void>}
   */
  async #verifyState(state) {
    for (const key of ['actor', 'actor2']) {
      const sessionId = state.sessions[key].id
      const found = await this.ctx.sessionController.resolveAgent(sessionId)
      if (found?.agent?.id !== sessionId || this.ctx.agents.get(sessionId) !== found.agent) {
        fail('state_stale', `v04 ${key} session is no longer a registered live ordinary session`)
      }
    }
    const workspaces = this.ctx.workspaceRegistry.list()
    const actorWorkspace = workspaces.find((item) => item.id === state.workspace.id)
    if (actorWorkspace === undefined || !actorWorkspace.sessionIds.includes(state.sessions.actor.id)) {
      fail('state_stale', 'v04 actor workspace or actor session is no longer registered')
    }
    if (actorWorkspace === undefined || !actorWorkspace.sessionIds.includes(state.sessions.actor2.id)) {
      fail('state_stale', 'v04 actor2 session is no longer registered in the actor workspace')
    }
    if (!workspaces.some((item) => item.id === state.emptyWorkspace.id)) {
      fail('state_stale', 'v04 empty workspace is no longer registered')
    }
    const parent = await stat(this.parentDir).catch(() => undefined)
    if (parent === undefined || !parent.isDirectory()) {
      fail('state_stale', 'v04 testroot parent directory is missing')
    }
  }

  /**
   * Create the isolated actor workspace, the actor ordinary session, the empty
   * registered workspace, and the testroot parent. Every path stays inside the
   * isolated home. No selectModel call is made anywhere.
   * @returns {Promise<Record<string, any>>}
   */
  async #createState() {
    for (const directory of [this.actorDir, this.emptyWorkspaceDir, this.parentDir]) {
      const target = await this.#safeTarget(directory)
      await mkdir(target, { recursive: true, mode: 0o700 })
      const info = await stat(target)
      if (!info.isDirectory()) fail('setup_failed', `${target} exists but is not a directory`)
    }
    const workspaces = this.ctx.workspaceRegistry.list()
    let actorWorkspace = workspaces.find((item) => path.resolve(item.path) === path.resolve(this.actorDir))
    if (actorWorkspace !== undefined && (actorWorkspace.sessionIds?.length ?? 0) > 0) {
      fail('partial_setup', 'v04 actor workspace already has sessions but no v04 state; use a fresh isolated home')
    }
    actorWorkspace ??= await this.ctx.workspaceRegistry.create(this.actorDir, ACTOR_TITLE)

    let emptyWorkspace = this.ctx.workspaceRegistry.list().find((item) => path.resolve(item.path) === path.resolve(this.emptyWorkspaceDir))
    emptyWorkspace ??= await this.ctx.workspaceRegistry.create(this.emptyWorkspaceDir, EMPTY_WORKSPACE_TITLE)
    if ((emptyWorkspace.sessionIds?.length ?? 0) > 0) {
      fail('partial_setup', 'v04 empty workspace already has sessions; use a fresh isolated home')
    }

    const created = await this.ctx.sessionController.create({ workspaceId: actorWorkspace.id })
    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) fail('setup_failed', 'sessionController.create returned no session id')
    const selection = await this.ctx.sessionController.rename({ sessionId, title: ACTOR_TITLE })
    if (selection?.title !== ACTOR_TITLE) fail('setup_failed', 'v04 actor session rename did not stick')

    // A second ordinary caller proves the tools are open to any eligible
    // session, not only the first one. It never gets a selectModel call either.
    const created2 = await this.ctx.sessionController.create({ workspaceId: actorWorkspace.id })
    const sessionId2 = created2?.sessionId
    if (typeof sessionId2 !== 'string' || sessionId2.length === 0) fail('setup_failed', 'sessionController.create returned no actor2 session id')
    if (sessionId2 === sessionId) fail('setup_failed', 'actor and actor2 must be different sessions')
    const selection2 = await this.ctx.sessionController.rename({ sessionId: sessionId2, title: ACTOR2_TITLE })
    if (selection2?.title !== ACTOR2_TITLE) fail('setup_failed', 'v04 actor2 session rename did not stick')

    const liveWorkspace = this.ctx.workspaceRegistry.list().find((item) => item.id === actorWorkspace.id)
    if (liveWorkspace !== undefined && typeof liveWorkspace.attachSession === 'function') {
      for (const id of [sessionId, sessionId2]) {
        if (!liveWorkspace.sessionIds.includes(id)) await liveWorkspace.attachSession(id)
      }
    }

    const state = {
      version: STATE_VERSION,
      home: this.home,
      createdAt: new Date().toISOString(),
      fixtureInstanceId: this.instanceId,
      workspace: { id: actorWorkspace.id, path: this.actorDir, title: ACTOR_TITLE },
      emptyWorkspace: { id: emptyWorkspace.id, path: this.emptyWorkspaceDir, title: EMPTY_WORKSPACE_TITLE },
      sessions: {
        actor: { id: sessionId, title: ACTOR_TITLE },
        actor2: { id: sessionId2, title: ACTOR2_TITLE },
      },
      parentDir: this.parentDir,
      selectModelCalls: 0,
    }
    const stateFile = await this.#safeTarget(this.stateFile)
    await writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 })
    this.actorId = sessionId
    await this.#verifyState(state)
    return state
  }

  /** @returns {Promise<Record<string, any>>} */
  async #requireState() {
    const state = await this.#loadState()
    if (state === undefined) fail('not_initialized', 'v04 fixture has not been initialized')
    this.actorId = state.sessions.actor.id
    return state
  }

  /** @returns {Promise<Record<string, any>>} */
  async init() {
    return await this.#serializeInit(async () => {
      let state = await this.#loadState()
      if (state === undefined) state = await this.#createState()
      else await this.#verifyState(state)
      this.actorId = state.sessions.actor.id
      return {
        fixtureInstanceId: this.instanceId,
        provider: V04_PROVIDER,
        model: V04_MODEL,
        selectModelUsed: false,
        workspace: state.workspace,
        emptyWorkspace: state.emptyWorkspace,
        actor: state.sessions.actor,
        actor2: state.sessions.actor2,
        testroot: { parent: state.parentDir },
      }
    })
  }

  /**
   * Execute one session_link_* tool as one of the fixture's own ordinary
   * sessions. This is the same owner/tool path the model uses; identity comes
   * from exec.agent only.
   * @param {Record<string, any>} payload
   * @returns {Promise<any>}
   */
  async invoke(payload) {
    const state = await this.#requireState()
    const allowed = new Set([state.sessions.actor.id, state.sessions.actor2.id])
    if (!allowed.has(payload.sessionId)) fail('forbidden_session', 'session is not a v04 fixture actor session')
    if (typeof payload.name !== 'string' || !payload.name.startsWith('session_link_')) {
      fail('forbidden_tool', 'only session_link_* tools may be invoked')
    }
    const args = payload.args === undefined ? {} : payload.args
    if (!isPlainObject(args)) fail('invalid_argument', 'args must be a plain object')
    const argumentBytes = Buffer.byteLength(JSON.stringify(args), 'utf8')
    if (argumentBytes > MAX_ARGS_BYTES) fail('invalid_argument', 'args are too large')
    const timeoutMs =
      Number.isSafeInteger(payload.timeoutMs) && payload.timeoutMs >= 1000 && payload.timeoutMs <= 120_000
        ? payload.timeoutMs
        : INVOKE_TIMEOUT_MS
    const found = await this.ctx.sessionController.resolveAgent(payload.sessionId)
    if (found?.agent?.id !== payload.sessionId || this.ctx.agents.get(payload.sessionId) !== found.agent) {
      fail('agent_unavailable', 'v04 fixture agent could not be resolved as the registered instance')
    }
    const definition = this.ctx.tools.get(payload.name)
    if (definition === undefined || definition === null || typeof definition.execute !== 'function') {
      fail('tool_unavailable', `tool ${payload.name} is not registered`)
    }
    let value
    try {
      value = await definition.execute(args, {
        agent: found.agent,
        signal: AbortSignal.timeout(timeoutMs),
        callId: randomUUID(),
      })
    } catch (error) {
      if (error instanceof FixtureError) throw error
      throw new FixtureError(
        typeof error?.code === 'string' ? error.code : 'tool_failed',
        `tool ${payload.name} rejected the call: ${errorInfo(error).message}`,
      )
    }
    const serialized = JSON.stringify(value === undefined ? null : value)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_TOOL_RESULT_BYTES) fail('response_too_large', 'tool result exceeds the fixture bound')
    return JSON.parse(serialized)
  }

  /**
   * Deployment defaults used as the "new session defaults" baseline. Only
   * provider/model ids and preset names are returned: no environment values,
   * no credentials, no API keys.
   * @returns {Promise<Record<string, any>>}
   */
  async defaults() {
    const capabilities = {
      agentDefaultModel: typeof this.ctx.agentDefaultModel?.currentSelection === 'function',
      modelCatalog: typeof this.ctx.sessionController?.modelCatalog === 'function',
      projections: typeof this.ctx.sessionController?.projections === 'function',
      permissionPresets: isPlainObject(this.ctx.permissionPresets),
      readTitleSnapshots: typeof this.ctx.sessionQuery?.readTitleSnapshots === 'function',
    }
    let model = { selection: null, source: 'none' }
    if (capabilities.agentDefaultModel) {
      try {
        const selection = this.ctx.agentDefaultModel.currentSelection()
        if (isPlainObject(selection)) {
          model = { selection: pick(selection, ['provider', 'model', 'reasoningEffort']), source: 'agentDefaultModel' }
        }
      } catch (error) {
        model = { selection: null, source: 'agentDefaultModel', error: errorInfo(error) }
      }
    }
    let catalog = null
    if (capabilities.modelCatalog) {
      try {
        const value = await this.ctx.sessionController.modelCatalog()
        catalog = {
          default: isPlainObject(value?.default) ? pick(value.default, ['provider', 'model', 'reasoningEffort']) : null,
          routableProviders: Array.isArray(value?.routableProviders)
            ? value.routableProviders.filter((item) => typeof item === 'string').slice(0, MAX_MODEL_GROUPS)
            : [],
          groups: Array.isArray(value?.groups)
            ? value.groups.slice(0, MAX_MODEL_GROUPS).map((group) => ({
                provider: typeof group?.provider === 'string' ? group.provider : null,
                models: Array.isArray(group?.models)
                  ? group.models.slice(0, MAX_MODELS_PER_GROUP).map((item) => ({ id: typeof item?.id === 'string' ? item.id : null }))
                  : [],
              }))
            : [],
          failures: Array.isArray(value?.failures)
            ? value.failures.slice(0, 20).map((item) => ({ provider: typeof item?.provider === 'string' ? item.provider : null, code: typeof item?.code === 'string' ? boundedText(item.code, 120) : null }))
            : [],
        }
        if (model.selection === null && isPlainObject(catalog.default)) {
          model = { selection: catalog.default, source: 'modelCatalog' }
        }
      } catch (error) {
        catalog = { error: errorInfo(error) }
      }
    }
    let permission = null
    if (capabilities.permissionPresets) {
      try {
        const service = this.ctx.permissionPresets
        const defaultPreset = typeof service.defaultPreset === 'string' ? service.defaultPreset : null
        let options = null
        if (typeof service.catalog === 'function') {
          const value = service.catalog()
          options = {
            defaultPreset: typeof value?.defaultPreset === 'string' ? value.defaultPreset : defaultPreset,
            values: Array.isArray(value?.options)
              ? value.options.slice(0, 50).map((item) => ({ value: typeof item?.value === 'string' ? item.value : null, name: typeof item?.name === 'string' ? boundedText(item.name, 120) : null }))
              : [],
            defaultOptionValues: Array.isArray(value?.defaultOptions)
              ? value.defaultOptions.slice(0, 50).map((item) => (typeof item?.value === 'string' ? item.value : null))
              : [],
          }
        }
        permission = { defaultPreset, options }
      } catch (error) {
        permission = { defaultPreset: null, options: null, error: errorInfo(error) }
      }
    }
    return {
      fixture: { provider: V04_PROVIDER, model: V04_MODEL },
      capabilities,
      model,
      catalog,
      permission,
      hostPid: process.pid,
    }
  }

  /**
   * Bounded workspace/session inventory used for "no new session/workspace"
   * assertions and for tool-registration preflight.
   * @returns {Promise<Record<string, any>>}
   */
  async snapshot() {
    const state = await this.#loadState().catch(() => undefined)
    const listedWorkspaces = this.ctx.workspaceRegistry.list()
    const workspaces = Array.isArray(listedWorkspaces) ? listedWorkspaces : []
    const archived = new Set(this.ctx.workspaceRegistry.archivedSessionIds ?? [])
    const listedRecords = await this.ctx.sessionQuery.listSessions()
    const records = Array.isArray(listedRecords) ? listedRecords : []
    const workspaceBySession = new Map()
    for (const workspace of workspaces) {
      for (const sessionId of workspace.sessionIds ?? []) {
        if (!workspaceBySession.has(sessionId)) {
          workspaceBySession.set(sessionId, { id: workspace.id, title: workspace.title ?? null, path: workspace.path ?? null })
        }
      }
    }
    const visible = records.filter((record) => workspaceBySession.has(record?.header?.id))
    const ids = visible.map((record) => record.header.id).slice(0, MAX_TITLE_IDS)
    let titles = new Map()
    if (typeof this.ctx.sessionQuery.readTitleSnapshots === 'function' && ids.length > 0) {
      try {
        const observations = await this.ctx.sessionQuery.readTitleSnapshots(ids)
        titles = new Map(
          (Array.isArray(observations) ? observations : [])
            .filter((observation) => observation?.status === 'fulfilled')
            .map((observation) => [observation.sessionId, observation.value?.title?.title]),
        )
      } catch {
        titles = new Map()
      }
    }
    const sessions = visible.slice(0, MAX_SNAPSHOT_SESSIONS).map((record) => {
      const header = record.header
      return {
        id: header.id,
        title: titles.get(header.id) ?? null,
        workspaceId: workspaceBySession.get(header.id)?.id ?? null,
        subagent: header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0,
        archived: archived.has(header.id),
        formatStatus: record.formatStatus ?? 'current',
        live: record.live === true,
        createdAt: header.createdAt ?? null,
      }
    })
    const tools = {}
    for (const name of TOOL_PROBE_NAMES) {
      try {
        tools[name] = typeof this.ctx.tools.get(name)?.execute === 'function'
      } catch {
        tools[name] = false
      }
    }
    return {
      counts: { workspaces: workspaces.length, sessions: records.length },
      workspaces: workspaces.slice(0, MAX_SNAPSHOT_WORKSPACES).map((workspace) => ({
        id: workspace.id,
        title: workspace.title ?? null,
        path: workspace.path ?? null,
        sessionIds: (workspace.sessionIds ?? []).slice(0, MAX_SESSION_IDS_PER_WORKSPACE),
      })),
      sessions,
      tools,
      initialized: state !== undefined,
      actorId: state?.sessions?.actor?.id ?? null,
      truncated: visible.length > MAX_SNAPSHOT_SESSIONS || workspaces.length > MAX_SNAPSHOT_WORKSPACES,
    }
  }

  /**
   * Bounded sessionQuery evidence plus the session row, registered workspace,
   * durable title, and selected projections. Never returns environment values
   * or credentials.
   * @param {Record<string, any>} payload
   * @returns {Promise<Record<string, any>>}
   */
  async evidence(payload = {}) {
    await this.#requireState()
    const sessionId = payload.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) fail('invalid_argument', 'evidence requires a sessionId')
    const limit =
      Number.isSafeInteger(payload.limit) && payload.limit >= 1 && payload.limit <= 2000 ? payload.limit : MAX_EVIDENCE_EVENTS
    const maxTextChars =
      Number.isSafeInteger(payload.maxTextChars) && payload.maxTextChars >= 256 && payload.maxTextChars <= 8192
        ? payload.maxTextChars
        : MAX_TEXT_CHARS
    const afterSeq = Number.isSafeInteger(payload.afterSeq) ? payload.afterSeq : 0

    const snapshot = await this.ctx.sessionQuery.readSession(sessionId)
    if (!isPlainObject(snapshot)) {
      return { sessionId, exists: false, events: [], totalKept: 0, truncated: false, row: null, workspace: null, title: null, projections: null }
    }
    const inherited = Number.isSafeInteger(snapshot.inheritedEventCount) ? snapshot.inheritedEventCount : 0
    const events = []
    let turn = null
    let step = null
    let truncated = false
    let total = 0
    for (const event of Array.isArray(snapshot.events) ? snapshot.events : []) {
      if (!Number.isSafeInteger(event?.seq) || event.seq < inherited || event.seq < afterSeq) continue
      if (event.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) turn = event.data.turn
      if (event.type === 'turn/end') turn = null
      if (event.type === 'step/start' && Number.isSafeInteger(event.data?.step)) step = event.data.step
      if (event.type === 'step/end') step = null
      if (!EVIDENCE_EVENT_TYPES.includes(event.type)) continue
      total += 1
      if (events.length >= limit) {
        truncated = true
        continue
      }
      const item = {
        seq: event.seq,
        type: event.type,
        time: event.time,
        turn: event.type === 'turn/start' ? event.data?.turn ?? null : turn,
        step: event.type === 'step/start' ? event.data?.step ?? null : step,
      }
      if (event.type === 'user/message' || event.type === 'assistant/message') {
        const isUser = event.type === 'user/message'
        const content = isUser ? event.data?.content : event.data?.message?.content
        const text = textOfContent(content)
        item.id = isUser ? (typeof event.data?.id === 'string' ? event.data.id : null) : null
        item.source = isUser ? sourceView(event.data?.source) : null
        item.sourceKeyCount = isUser && isPlainObject(event.data?.source) ? Object.keys(event.data.source).length : null
        item.text = boundedText(text, maxTextChars)
        item.textBytes = Buffer.byteLength(text, 'utf8')
        item.textTruncated = text.length > maxTextChars
        if (!isUser) {
          item.toolCalls = (Array.isArray(content) ? content : [])
            .filter((block) => block?.type === 'tool-call')
            .slice(0, 20)
            .map((block) => ({
              name: typeof block.name === 'string' ? block.name : null,
              arguments: boundedText(typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? null), 2048),
            }))
        }
      } else if (event.type === 'agent/inbox/spliced') {
        item.target = event.data?.target ?? null
        item.removedCount = event.data?.removedCount ?? 0
        item.inserted = Array.isArray(event.data?.inserted)
          ? event.data.inserted.slice(0, 50).map((message) => ({
              id: typeof message?.id === 'string' ? message.id : null,
              source: sourceView(message?.source),
              sourceKeyCount: isPlainObject(message?.source) ? Object.keys(message.source).length : null,
              text: boundedText(textOfContent(message?.content), maxTextChars),
            }))
          : []
      } else if (event.type === 'turn/end') {
        item.reason = event.data?.reason ?? null
      }
      events.push(item)
    }

    let row = null
    try {
      const records = await this.ctx.sessionQuery.listSessions()
      const record = (Array.isArray(records) ? records : []).find((item) => item?.header?.id === sessionId)
      if (record !== undefined) {
        const header = record.header
        row = {
          live: record.live === true,
          persisted: record.persisted === true,
          formatStatus: record.formatStatus ?? 'current',
          header: pick(header, ['id', 'createdAt', 'cwd', 'origin', 'parentSession', 'isSeeded', 'delegationDepth']),
        }
      }
    } catch (error) {
      row = { error: errorInfo(error) }
    }

    const workspaces = this.ctx.workspaceRegistry.list()
    const owning = workspaces.find((workspace) => (workspace.sessionIds ?? []).includes(sessionId))
    const workspace = owning === undefined ? null : { id: owning.id, title: owning.title ?? null, path: owning.path ?? null }

    let title = null
    if (typeof this.ctx.sessionQuery.readTitleSnapshots === 'function') {
      try {
        const observations = await this.ctx.sessionQuery.readTitleSnapshots([sessionId])
        const observation = (Array.isArray(observations) ? observations : []).find((item) => item?.sessionId === sessionId)
        if (observation !== undefined) {
          title = {
            status: observation.status ?? null,
            value: observation.status === 'fulfilled' ? (observation.value?.title?.title ?? null) : null,
          }
        }
      } catch (error) {
        title = { status: 'rejected', value: null, error: errorInfo(error) }
      }
    }

    const projections = await this.#readProjections(sessionId)
    return {
      sessionId,
      exists: true,
      inheritedEventCount: inherited,
      totalKept: total,
      truncated,
      events,
      row,
      workspace,
      title,
      projections,
    }
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<Record<string, any>>}
   */
  async #readProjections(sessionId) {
    if (typeof this.ctx.sessionController?.projections !== 'function') return { supported: false }
    try {
      // The real SDK signature is projections(request, signal); the Host reads
      // signal.throwIfAborted() before touching the session, so a missing
      // signal would throw and masquerade as an absent projection.
      const baseline = await this.ctx.sessionController.projections(
        { sessionId },
        AbortSignal.timeout(PROJECTION_TIMEOUT_MS),
      )
      if (baseline === null || baseline === undefined) return { supported: true, present: false }
      if (baseline.kind !== 'sequenced') {
        return {
          supported: true,
          present: false,
          kind: typeof baseline.kind === 'string' ? baseline.kind : null,
          error: { code: 'projection_not_sequenced', message: `projections returned kind ${String(baseline.kind)}` },
        }
      }
      const values = isPlainObject(baseline.values) ? baseline.values : {}
      const picked = {}
      for (const key of ['modelSelection', 'permissions', 'goal', 'agentPreset']) {
        if (Object.hasOwn(values, key)) picked[key] = jsonSafe(values[key])
      }
      return {
        supported: true,
        present: true,
        kind: 'sequenced',
        asOfSeq: Number.isSafeInteger(baseline.asOfSeq) ? baseline.asOfSeq : null,
        keys: Object.keys(values).sort(),
        values: picked,
      }
    } catch (error) {
      return { supported: true, present: false, error: errorInfo(error) }
    }
  }

  /**
   * Verify the Host's owner-only principal gate and exact-route matching for
   * this fixture route. The Host enforces both outside the handler.
   * @returns {Promise<Record<string, any>>}
   */
  async guardOwner() {
    const connection = this.ctx.connection
    if (typeof connection?.createPeer !== 'function' || typeof connection?.createSharedFetchHandler !== 'function') {
      return { supported: false }
    }
    const guest = connection.createPeer({ principal: { kind: 'session-link-v04-guest' }, interactions: 'none' })
    try {
      const handler = connection.createSharedFetchHandler('/api')
      const request = (pathname) =>
        new Request(`http://127.0.0.1:3098${pathname}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'defaults', payload: {} }),
        })
      const guestResponse = await handler.fetch(request(V04_FIXTURE_PATH), guest)
      const wrongPathResponse = await handler.fetch(request(`${V04_FIXTURE_PATH}/extra`), guest)
      return {
        supported: true,
        guestStatus: guestResponse.status,
        guestBody: boundedText(await guestResponse.text(), 500),
        wrongPathStatus: wrongPathResponse.status,
        wrongPathBody: boundedText(await wrongPathResponse.text(), 500),
      }
    } finally {
      await guest.dispose?.()
    }
  }

  /** @param {string} action @param {Record<string, any>} payload @returns {Promise<any>} */
  async run(action, payload) {
    if (action === 'init') return await this.init()
    if (action === 'invoke') return await this.invoke(payload)
    if (action === 'evidence') return await this.evidence(payload)
    if (action === 'defaults') return await this.defaults()
    if (action === 'snapshot') return await this.snapshot()
    if (action === 'guard.owner') return await this.guardOwner()
    fail('unknown_action', `unknown v04 fixture action ${action}`)
  }

  /** @param {Request} request @returns {Promise<Response>} */
  async handle(request) {
    if (request.method !== 'POST') return response({ ok: false, error: { code: 'method_not_allowed', message: 'POST only' } }, 405)
    const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') {
      return response({ ok: false, error: { code: 'unsupported_media_type', message: 'content-type must be application/json' } }, 415)
    }
    let text
    try {
      text = await request.text()
    } catch {
      return response({ ok: false, error: { code: 'bad_request', message: 'request body could not be read' } }, 400)
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
      return response({ ok: false, error: { code: 'payload_too_large', message: 'request body is too large' } }, 413)
    }
    let body
    try {
      body = JSON.parse(text)
    } catch {
      return response({ ok: false, error: { code: 'bad_request', message: 'body is not JSON' } }, 400)
    }
    if (!isPlainObject(body)) return response({ ok: false, error: { code: 'bad_request', message: 'body must be an object' } }, 400)
    const extra = Object.keys(body).filter((key) => key !== 'action' && key !== 'payload')
    if (extra.length > 0) return response({ ok: false, error: { code: 'bad_request', message: 'body accepts only action and payload' } }, 400)
    if (typeof body.action !== 'string' || !V04_ACTIONS.includes(body.action)) {
      return response({ ok: false, error: { code: 'unknown_action', message: 'unknown v04 fixture action' } }, 400)
    }
    const payload = body.payload === undefined ? {} : body.payload
    if (!isPlainObject(payload)) return response({ ok: false, error: { code: 'bad_request', message: 'payload must be an object' } }, 400)
    try {
      return response({ ok: true, value: await this.run(body.action, payload) })
    } catch (error) {
      return response({ ok: false, error: errorInfo(error) })
    }
  }

  /** @returns {Promise<void>} */
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    try {
      if (typeof this.adapterDispose === 'function') this.adapterDispose()
    } finally {
      this.adapterDispose = undefined
    }
  }
}

/** @param {unknown} body @param {number} [status] @returns {Response} */
function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * Install the test-only route. The Host's Connection fetch registration applies
 * its exact route matching, Host/Origin fence, and owner-only principal gate
 * before this handler runs. No cookie or token is read here.
 *
 * @param {Record<string, any>} ctx
 * @param {{ home: string, createUserMessage?: (input: Record<string, any>) => Record<string, any>, LlmAdapter: new (...args: any[]) => any }} options
 * @returns {Promise<{ path: string, actions: readonly string[], dispose: () => Promise<void> }>}
 */
export async function installV04Fixture(ctx, options = {}) {
  const { root, realRoot } = await requireTestHome(options.home)
  const fixture = new V04Fixture(ctx, root, realRoot, options.createUserMessage, options.LlmAdapter)
  await fixture.start()
  const disposeRoute = await ctx.connection.fetch.register({
    path: V04_FIXTURE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        return await fixture.handle(request)
      } catch (error) {
        return response({ ok: false, error: errorInfo(error) }, 500)
      }
    },
  })
  return {
    path: V04_FIXTURE_PATH,
    actions: V04_ACTIONS,
    async dispose() {
      try {
        if (typeof disposeRoute === 'function') await disposeRoute()
      } finally {
        await fixture.dispose()
      }
    },
  }
}
