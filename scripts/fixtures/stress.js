/**
 * Ten-session stress fixture for the real DSH 0.2.1-rc.5 host.
 *
 * This module is test-only. It is installed by scripts/fixtures/index.js under
 * the same SESSION_LINK_TEST guard and only into a /tmp/dsh-session-link-* home.
 * It registers one owner-authenticated exact POST route on the host's shared
 * Connection fetch channel; it never opens a raw webServer route, copies
 * credentials, or exposes a production control surface.
 *
 * Contract:
 *   const { installStressFixture } = await import('./stress.js')
 *   const stress = await installStressFixture(ctx, { home, createUserMessage })
 *   ctx.effect(() => () => stress.dispose())
 *
 * The route accepts a bare `{ action, payload }` body and answers
 * `{ ok: true, value }` or `{ ok: false, error: { code, message } }`.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const STRESS_FIXTURE_PATH = '/api/session-link-stress-fixture'
export const STRESS_SESSION_COUNT = 10

const STATE_VERSION = 1
const STATE_FILE = 'stress-sessions.json'
const HOME_PREFIX = '/tmp/dsh-session-link-'
const TOOL_PREFIX = 'session_link_'
const ACTIONS = Object.freeze(['init', 'invoke', 'evidence', 'idle'])
const MAX_BODY_BYTES = 256 * 1024
const MAX_TOOL_RESULT_BYTES = 256 * 1024
const MAX_EVIDENCE_ITEMS = 200
const MAX_TEXT_PREVIEW = 240
const MAX_ARGUMENT_BYTES = 64 * 1024

const INIT_TIMEOUT_MS = 180_000
const INVOKE_TIMEOUT_MS = 30_000
const EVIDENCE_TIMEOUT_MS = 15_000
const IDLE_TIMEOUT_MS = 30_000

class FixtureError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * @param {string} home
 * @returns {string}
 */
function requireTestHome(home) {
  if (process.env.SESSION_LINK_TEST !== '1') {
    throw new FixtureError('fixture_guard', 'stress fixture requires SESSION_LINK_TEST=1')
  }
  if (typeof home !== 'string' || home.length === 0 || home.includes('\0')) {
    throw new FixtureError('fixture_guard', 'stress fixture requires an isolated home path')
  }
  const resolved = path.resolve(home)
  if (!resolved.startsWith(HOME_PREFIX) || resolved.length <= HOME_PREFIX.length) {
    throw new FixtureError('fixture_guard', 'stress fixture home must be under /tmp/dsh-session-link-*')
  }
  const envHome = process.env.DSH_HOME === undefined ? undefined : path.resolve(process.env.DSH_HOME)
  if (envHome !== undefined && envHome !== resolved) {
    throw new FixtureError('fixture_guard', 'stress fixture home does not match DSH_HOME')
  }
  return resolved
}

/**
 * @param {Record<string, any>} ctx
 */
function requireHostCapabilities(ctx) {
  if (ctx === undefined || ctx === null) throw new FixtureError('fixture_guard', 'stress fixture requires ctx')
  for (const name of ['workspaceRegistry', 'sessionController', 'sessionQuery', 'agents', 'sessions', 'tools', 'connection']) {
    if (ctx[name] === undefined || ctx[name] === null) {
      throw new FixtureError('fixture_guard', `stress fixture requires ctx.${name}`)
    }
  }
  if (typeof ctx.tools.get !== 'function') throw new FixtureError('fixture_guard', 'ctx.tools.get is required')
  if (typeof ctx.connection.fetch?.register !== 'function') {
    throw new FixtureError('fixture_guard', 'ctx.connection.fetch.register is required')
  }
  if (typeof ctx.sessionController.create !== 'function') {
    throw new FixtureError('fixture_guard', 'ctx.sessionController.create is required')
  }
  if (typeof ctx.sessionController.selectModel !== 'function') {
    throw new FixtureError('fixture_guard', 'ctx.sessionController.selectModel is required')
  }
  if (typeof ctx.sessionController.resolveAgent !== 'function') {
    throw new FixtureError('fixture_guard', 'ctx.sessionController.resolveAgent is required')
  }
  if (typeof ctx.sessionQuery.readSession !== 'function') {
    throw new FixtureError('fixture_guard', 'ctx.sessionQuery.readSession is required')
  }
  if (typeof ctx.sessions.flush !== 'function') throw new FixtureError('fixture_guard', 'ctx.sessions.flush is required')
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {string} code @param {string} message */
function fail(code, message) {
  throw new FixtureError(code, message)
}

/** @template T @param {() => Promise<T>} task @param {number} ms @param {string} label @returns {Promise<T>} */
async function withTimeout(task, ms, label) {
  if (typeof task !== 'function') {
    throw new FixtureError('internal_fixture_error', 'withTimeout requires a lazy task function')
  }
  let timer
  let started
  try {
    started = task()
    return await Promise.race([
      Promise.resolve(started),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new FixtureError('timeout', `${label} timed out after ${ms}ms`)), ms)
        timer.unref?.()
      }),
    ])
  } catch (error) {
    // If task() threw after returning a promise, consume that promise so a
    // fixture bug can never become an unhandled rejection in the host process.
    if (started !== undefined && typeof started.then === 'function') started.catch(() => undefined)
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** @param {unknown} value @returns {string} */
function textOfContent(value) {
  if (!Array.isArray(value)) return ''
  return value
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** @param {unknown} value @returns {Record<string, any> | undefined} */
function parseJsonObject(value) {
  if (typeof value !== 'string') return undefined
  try {
    const parsed = JSON.parse(value)
    return isPlainObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** @param {unknown} value @param {number} max @returns {string | undefined} */
function boundedString(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : undefined
}

/** @param {unknown} source @returns {Record<string, any> | undefined} */
function compactSource(source) {
  if (!isPlainObject(source)) return undefined
  return {
    kind: boundedString(source.kind, 64),
    form: boundedString(source.form, 64),
    senderSessionId: boundedString(source.senderSessionId, 256),
    keys: Object.keys(source).sort(),
  }
}

/** @param {unknown} value @param {string} name @param {number} max @returns {string} */
function requiredString(value, name, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    fail('invalid_argument', `${name} must be a non-empty string of at most ${max} characters`)
  }
  return value
}

/** @param {unknown} value @param {string} name @param {{ min: number, max: number }} bounds @returns {number} */
function boundedInteger(value, name, bounds) {
  if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
    fail('invalid_argument', `${name} must be an integer between ${bounds.min} and ${bounds.max}`)
  }
  return value
}

/** @param {unknown} value @param {string} name @param {number} maxItems @param {number} maxChars @returns {string[] | undefined} */
function optionalStringArray(value, name, maxItems, maxChars) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > maxItems) {
    fail('invalid_argument', `${name} must be an array of at most ${maxItems} strings`)
  }
  for (const item of value) requiredString(item, name, maxChars)
  return value
}

export class StressFixture {
  /**
   * @param {Record<string, any>} ctx
   * @param {string} home
   * @param {(input: Record<string, any>) => Record<string, any>} createUserMessage
   */
  constructor(ctx, home, createUserMessage) {
    requireHostCapabilities(ctx)
    if (typeof createUserMessage !== 'function') {
      throw new FixtureError('fixture_guard', 'stress fixture requires the Host createUserMessage builder')
    }
    this.ctx = ctx
    this.home = home
    this.createUserMessage = createUserMessage
    this.stateFile = path.join(home, STATE_FILE)
    this.initializations = Promise.resolve()
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

  /** @returns {Promise<Record<string, any> | undefined>} */
  async #loadState() {
    let raw
    try {
      raw = await readFile(this.stateFile, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw new FixtureError('state_unreadable', 'stress session state could not be read')
    }
    let state
    try {
      state = JSON.parse(raw)
    } catch {
      throw new FixtureError('state_corrupt', 'stress session state is not valid JSON')
    }
    return this.#validateState(state)
  }

  /** @param {unknown} state @returns {Record<string, any>} */
  #validateState(state) {
    if (!isPlainObject(state) || state.version !== STATE_VERSION) {
      fail('state_corrupt', 'stress session state has an unsupported version')
    }
    if (state.home !== this.home) fail('state_corrupt', 'stress session state belongs to a different home')
    if (!Array.isArray(state.sessions) || state.sessions.length !== STRESS_SESSION_COUNT) {
      fail('state_corrupt', `stress session state must contain exactly ${STRESS_SESSION_COUNT} sessions`)
    }
    if (!Array.isArray(state.workspaces) || state.workspaces.length !== 2) {
      fail('state_corrupt', 'stress session state must contain exactly two workspaces')
    }
    const ids = new Set()
    const perWorkspace = new Map()
    for (const session of state.sessions) {
      if (!isPlainObject(session)) fail('state_corrupt', 'stress session record is malformed')
      if (typeof session.id !== 'string' || session.id.length === 0) fail('state_corrupt', 'stress session id is missing')
      if (ids.has(session.id)) fail('state_corrupt', 'stress session ids are not unique')
      ids.add(session.id)
      if (typeof session.workspaceId !== 'string' || session.workspaceId.length === 0) {
        fail('state_corrupt', 'stress session workspace id is missing')
      }
      perWorkspace.set(session.workspaceId, (perWorkspace.get(session.workspaceId) ?? 0) + 1)
      if (typeof session.initText !== 'string' || session.initText.length === 0) {
        fail('state_corrupt', 'stress session init text is missing')
      }
      if (!Number.isSafeInteger(session.initSeq) || session.initSeq < 0) {
        fail('state_corrupt', 'stress session init seq is missing')
      }
    }
    for (const workspace of state.workspaces) {
      if (!isPlainObject(workspace) || typeof workspace.id !== 'string') {
        fail('state_corrupt', 'stress workspace record is malformed')
      }
      if ((perWorkspace.get(workspace.id) ?? 0) !== STRESS_SESSION_COUNT / 2) {
        fail('state_corrupt', 'stress sessions are not split evenly across the two workspaces')
      }
    }
    return state
  }

  /** @param {Record<string, any>} state */
  async #saveState(state) {
    await mkdir(this.home, { recursive: true, mode: 0o700 })
    state.updatedAt = new Date().toISOString()
    const temporary = path.join(this.home, `.${STATE_FILE}.${process.pid}.${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 })
    await rename(temporary, this.stateFile)
  }

  /** @param {Record<string, any>} state @returns {Record<string, any>} */
  #summary(state) {
    return {
      fixture: STRESS_FIXTURE_PATH,
      count: state.sessions.length,
      workspaces: state.workspaces.map((workspace) => ({
        key: workspace.key,
        id: workspace.id,
        title: workspace.title,
        sessionCount: state.sessions.filter((session) => session.workspaceId === workspace.id).length,
      })),
      sessions: state.sessions.map((session) => ({
        key: session.key,
        id: session.id,
        title: session.title,
        workspaceId: session.workspaceId,
        model: session.model,
        initSeq: session.initSeq,
      })),
      setupVerified: true,
    }
  }

  /**
   * Verify that every persisted stress session is still a registered,
   * non-archived, non-subagent ordinary session and that its unique setup turn
   * is present in the raw history.
   * @param {Record<string, any>} state
   */
  async #verifyState(state) {
    const workspaces = new Map(this.ctx.workspaceRegistry.list().map((workspace) => [workspace.id, workspace]))
    const archived = new Set(this.ctx.workspaceRegistry.archivedSessionIds ?? [])
    const records = await this.ctx.sessionQuery.listSessions()
    const byId = new Map(records.map((record) => [record?.header?.id, record]))
    for (const session of state.sessions) {
      const record = byId.get(session.id)
      if (record === undefined) fail('state_stale', 'a persisted stress session is no longer registered')
      const header = record.header
      if (header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0) {
        fail('state_stale', 'a persisted stress session became a subagent session')
      }
      if (record.formatStatus === 'migration-required') {
        fail('state_stale', 'a persisted stress session requires migration')
      }
      if (archived.has(session.id)) fail('state_stale', 'a persisted stress session was archived')
      const workspace = workspaces.get(session.workspaceId)
      if (workspace === undefined || !workspace.sessionIds.includes(session.id)) {
        fail('state_stale', 'a persisted stress session is no longer in its workspace')
      }
      const snapshot = await this.ctx.sessionQuery.readSession(session.id)
      const events = Array.isArray(snapshot.events) ? snapshot.events : []
      const initEvent = events.find(
        (event) =>
          event?.type === 'user/message' &&
          event.seq === session.initSeq &&
          textOfContent(event.data?.content).includes(session.initText),
      )
      if (initEvent === undefined) {
        fail('setup_unverified', 'a stress session is missing its unique setup turn')
      }
      const after = events.some((event) => event?.type === 'assistant/message' && event.seq > initEvent.seq)
      if (!after) fail('setup_unverified', 'a stress session setup turn did not complete a model turn')
    }
  }

  /**
   * Create or reuse the two workspaces only when no stress state exists.
   * @param {string} directory
   * @param {string} title
   * @returns {Promise<Record<string, any>>}
   */
  async #ensureWorkspace(directory, title) {
    const canonical = path.resolve(directory)
    const existing = this.ctx.workspaceRegistry.list().find((workspace) => path.resolve(workspace.path) === canonical)
    if (existing !== undefined) {
      if ((existing.sessionIds?.length ?? 0) > 0) {
        fail('partial_setup', 'a stress workspace already has sessions but no stress state; use a fresh home')
      }
      return existing
    }
    return await this.ctx.workspaceRegistry.create(directory, title)
  }

  /** @returns {Promise<Record<string, any>>} */
  async #createState() {
    const definitions = [
      { key: 'a', title: 'stress-workspace-A', directory: path.join(this.home, 'stress-work-a') },
      { key: 'b', title: 'stress-workspace-B', directory: path.join(this.home, 'stress-work-b') },
    ]
    for (const definition of definitions) {
      await mkdir(definition.directory, { recursive: true, mode: 0o700 })
    }
    const workspaces = []
    for (const definition of definitions) {
      const workspace = await this.#ensureWorkspace(definition.directory, definition.title)
      workspaces.push({ key: definition.key, id: workspace.id, title: definition.title, path: definition.directory })
    }

    const sessions = []
    for (let index = 0; index < STRESS_SESSION_COUNT; index++) {
      const workspace = workspaces[index < STRESS_SESSION_COUNT / 2 ? 0 : 1]
      const key = `${workspace.key}${(index % (STRESS_SESSION_COUNT / 2)) + 1}`
      const created = await this.ctx.sessionController.create({ workspaceId: workspace.id })
      const sessionId = created.sessionId
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        fail('setup_failed', 'sessionController.create returned no session id')
      }
      const selection = await this.ctx.sessionController.selectModel({
        sessionId,
        provider: 'session-link-fixture',
        model: 'fixture',
      })
      const selected = selection?.selected
      if (selected?.provider !== 'session-link-fixture' || selected?.model !== 'fixture') {
        fail('setup_failed', 'scripted fixture model was not selected')
      }
      const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
      const agent = resolved?.agent
      if (agent === undefined || agent.id !== sessionId) {
        fail('setup_failed', 'scripted fixture agent could not be resolved')
      }
      if (this.ctx.agents.get(sessionId) !== agent) {
        fail('setup_failed', 'resolved stress agent is not the registered registry instance')
      }

      // Every session gets a distinct user turn. This avoids reusing a blank
      // agent and gives restart evidence a stable setup anchor.
      const initText = `stress init ${key} ${randomUUID()} (unique setup turn)`
      agent.followup(
        this.createUserMessage({
          content: [{ type: 'text', text: initText }],
          source: { kind: 'user' },
        }),
      )
      await withTimeout(() => agent.whenIdle(), INIT_TIMEOUT_MS, `setup ${key} idle`)
      const flushed = await this.ctx.sessions.flush(agent.session)
      if (flushed !== true) fail('setup_failed', `setup ${key} did not flush`)

      const snapshot = await this.ctx.sessionQuery.readSession(sessionId)
      const initEvent = (snapshot.events ?? []).find(
        (event) => event?.type === 'user/message' && textOfContent(event.data?.content).includes(initText),
      )
      if (initEvent === undefined) fail('setup_failed', `setup ${key} turn was not persisted`)
      const assistantAfter = (snapshot.events ?? []).some(
        (event) => event?.type === 'assistant/message' && event.seq > initEvent.seq,
      )
      if (!assistantAfter) fail('setup_failed', `setup ${key} did not complete a scripted model turn`)

      const title = `stress-${key}`
      await this.ctx.sessionController.rename({ sessionId, title })
      sessions.push({
        key,
        id: sessionId,
        workspaceId: workspace.id,
        title,
        model: { provider: 'session-link-fixture', model: 'fixture' },
        initText,
        initSeq: initEvent.seq,
      })
    }

    // create({ workspaceId }) normally accounts the session; attach defensively
    // if a host version reports it only after the live header index catches up.
    for (const session of sessions) {
      const workspace = this.ctx.workspaceRegistry.list().find((item) => item.id === session.workspaceId)
      if (workspace !== undefined && !workspace.sessionIds.includes(session.id)) {
        await workspace.attachSession(session.id)
      }
    }

    return {
      version: STATE_VERSION,
      home: this.home,
      createdAt: new Date().toISOString(),
      workspaces,
      sessions,
    }
  }

  /** @returns {Promise<Record<string, any>>} */
  async init() {
    return this.#serializeInit(async () => {
      const existing = await this.#loadState()
      if (existing !== undefined) {
        await this.#verifyState(existing)
        return this.#summary(existing)
      }
      const state = await this.#createState()
      await this.#saveState(state)
      await this.#verifyState(state)
      return this.#summary(state)
    })
  }

  /** @returns {Promise<Record<string, any>>} */
  async #requireState() {
    const state = await this.#loadState()
    if (state === undefined) fail('not_initialized', 'stress fixture has not been initialized')
    return state
  }

  /**
   * @param {Record<string, any>} payload
   * @returns {Promise<Record<string, any>>}
   */
  async invoke(payload) {
    const state = await this.#requireState()
    const sessionId = requiredString(payload.sessionId, 'sessionId', 256)
    if (!state.sessions.some((session) => session.id === sessionId)) {
      fail('forbidden_session', 'session is not one of the ten stress sessions')
    }
    const name = requiredString(payload.name, 'name', 64)
    if (!name.startsWith(TOOL_PREFIX)) fail('forbidden_tool', 'only session_link_* tools may be invoked')
    const args = payload.args === undefined ? {} : payload.args
    if (!isPlainObject(args)) fail('invalid_argument', 'args must be a plain object')
    const argumentBytes = Buffer.byteLength(JSON.stringify(args), 'utf8')
    if (argumentBytes > MAX_ARGUMENT_BYTES) fail('invalid_argument', 'args are too large')
    const timeoutMs = payload.timeoutMs === undefined ? INVOKE_TIMEOUT_MS : boundedInteger(payload.timeoutMs, 'timeoutMs', { min: 1000, max: 60_000 })

    const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
    const agent = resolved?.agent
    if (agent === undefined || agent.id !== sessionId) fail('agent_unavailable', 'stress session agent could not be resolved')
    if (this.ctx.agents.get(sessionId) !== agent) {
      fail('agent_unavailable', 'resolved agent is not the registered registry instance')
    }
    const definition = this.ctx.tools.get(name)
    if (definition === undefined || definition === null || typeof definition.execute !== 'function') {
      fail('tool_unavailable', `tool ${name} is not registered`)
    }
    const value = await withTimeout(
      () => definition.execute(args, {
        agent,
        signal: AbortSignal.timeout(timeoutMs),
        callId: randomUUID(),
      }),
      timeoutMs + 1000,
      `tool ${name}`,
    )
    const serialized = JSON.stringify(value === undefined ? null : value)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_TOOL_RESULT_BYTES) {
      fail('response_too_large', 'tool result exceeds the stress fixture response bound')
    }
    return JSON.parse(serialized)
  }

  /**
   * Bounded, read-only proof from one target session's raw history.
   * @param {Record<string, any>} payload
   * @returns {Promise<Record<string, any>>}
   */
  async evidence(payload) {
    const state = await this.#requireState()
    const sessionId = requiredString(payload.sessionId, 'sessionId', 256)
    if (!state.sessions.some((session) => session.id === sessionId)) {
      fail('forbidden_session', 'session is not one of the ten stress sessions')
    }
    const messageIds = optionalStringArray(payload.messageIds, 'messageIds', 50, 256)
    const requestIds = optionalStringArray(payload.requestIds, 'requestIds', 50, 256)
    const wanted = messageIds === undefined ? undefined : new Set(messageIds)
    const wantedRequests = requestIds === undefined ? undefined : new Set(requestIds)
    const snapshot = await this.ctx.sessionQuery.readSession(sessionId)
    const inheritedEventCount = Number.isSafeInteger(snapshot.inheritedEventCount) ? snapshot.inheritedEventCount : 0
    const events = (snapshot.events ?? []).filter((event) => Number.isSafeInteger(event?.seq) && event.seq >= inheritedEventCount)

    const inbound = []
    const toolCalls = []
    let assistantMessageCount = 0
    let assistantAckCount = 0
    let truncated = false

    for (const event of events) {
      if (event.type === 'user/message') {
        const data = event.data ?? {}
        if (data.source?.kind !== 'agent-message') continue
        if (wanted !== undefined && !wanted.has(data.id)) continue
        if (inbound.length >= MAX_EVIDENCE_ITEMS) {
          truncated = true
          continue
        }
        inbound.push({
          seq: event.seq,
          messageId: boundedString(data.id, 256),
          source: compactSource(data.source),
          text: textOfContent(data.content).slice(0, MAX_TEXT_PREVIEW),
        })
        continue
      }
      if (event.type !== 'assistant/message') continue
      assistantMessageCount += 1
      const content = event.data?.message?.content
      if (textOfContent(content).includes('FIXTURE_ACK')) assistantAckCount += 1
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block?.type !== 'tool-call' || typeof block.name !== 'string' || !block.name.startsWith(TOOL_PREFIX)) continue
        const parsed = parseJsonObject(block.arguments)
        const callMessageId = boundedString(parsed?.messageId, 256)
        if (wantedRequests !== undefined && (callMessageId === undefined || !wantedRequests.has(callMessageId))) continue
        if (toolCalls.length >= MAX_EVIDENCE_ITEMS) {
          truncated = true
          continue
        }
        toolCalls.push({
          seq: event.seq,
          callId: boundedString(block.id, 256),
          name: block.name.slice(0, 64),
          messageId: callMessageId,
          operationId: boundedString(parsed?.operationId, 128),
          targets: Array.isArray(parsed?.targets) ? parsed.targets.slice(0, 5).filter((item) => typeof item === 'string') : undefined,
          kind: boundedString(parsed?.kind, 32),
          text: boundedString(parsed?.text, 120),
        })
      }
    }

    return {
      sessionId,
      inheritedEventCount,
      eventCount: events.length,
      inbound,
      toolCalls,
      assistantMessageCount,
      assistantAckCount,
      truncated,
    }
  }

  /**
   * Wait for a live session to become idle and flush. Cold sessions are never
   * resolved here: resolving would wake an agent and is not a read-only check.
   * @param {Record<string, any>} payload
   * @returns {Promise<Record<string, any>>}
   */
  async idle(payload) {
    const state = await this.#requireState()
    const sessionId = requiredString(payload.sessionId, 'sessionId', 256)
    if (!state.sessions.some((session) => session.id === sessionId)) {
      fail('forbidden_session', 'session is not one of the ten stress sessions')
    }
    const timeoutMs = payload.timeoutMs === undefined ? IDLE_TIMEOUT_MS : boundedInteger(payload.timeoutMs, 'timeoutMs', { min: 1000, max: 60_000 })
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined || agent === null) return { live: false, idle: true, flushed: null }
    await withTimeout(() => agent.whenIdle(), timeoutMs, 'session idle')
    const flushed = await this.ctx.sessions.flush(agent.session)
    return { live: true, idle: true, flushed: flushed === true }
  }

  /**
   * @param {string} action
   * @param {Record<string, any>} payload
   * @returns {Promise<any>}
   */
  async #run(action, payload) {
    if (action === 'init') {
      return await withTimeout(() => this.init(), INIT_TIMEOUT_MS, 'fixture init')
    }
    if (action === 'invoke') return await withTimeout(() => this.invoke(payload), INVOKE_TIMEOUT_MS + 5000, 'fixture invoke')
    if (action === 'evidence') {
      return await withTimeout(() => this.evidence(payload), EVIDENCE_TIMEOUT_MS, 'fixture evidence')
    }
    if (action === 'idle') {
      return await withTimeout(() => this.idle(payload), IDLE_TIMEOUT_MS + 1000, 'fixture idle')
    }
    fail('unknown_action', `unknown stress fixture action ${action}`)
  }

  /**
   * @param {Request} request
   * @returns {Promise<Response>}
   */
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
    if (!isPlainObject(body)) {
      return response({ ok: false, error: { code: 'bad_request', message: 'body must be an object' } }, 400)
    }
    const extra = Object.keys(body).filter((key) => key !== 'action' && key !== 'payload')
    if (extra.length > 0) {
      return response({ ok: false, error: { code: 'bad_request', message: 'body accepts only action and payload' } }, 400)
    }
    if (typeof body.action !== 'string' || !ACTIONS.includes(body.action)) {
      return response({ ok: false, error: { code: 'unknown_action', message: 'unknown stress fixture action' } }, 400)
    }
    const payload = body.payload === undefined ? {} : body.payload
    if (!isPlainObject(payload)) {
      return response({ ok: false, error: { code: 'bad_request', message: 'payload must be an object' } }, 400)
    }
    try {
      const value = await this.#run(body.action, payload)
      return response({ ok: true, value })
    } catch (error) {
      return response({
        ok: false,
        error: {
          code: sanitizeCode(error?.code),
          message: sanitizeMessage(error?.message),
        },
      })
    }
  }
}

/** @param {unknown} code @returns {string} */
function sanitizeCode(code) {
  return typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? code : 'fixture_error'
}

/** @param {unknown} message @returns {string} */
function sanitizeMessage(message) {
  const text = typeof message === 'string' && message.length > 0 ? message : 'stress fixture action failed'
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500)
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
 * before this handler runs. No cookie or token is parsed here.
 *
 * @param {Record<string, any>} ctx
 * @param {{ home: string, createUserMessage: (input: Record<string, any>) => Record<string, any> }} options
 * @returns {Promise<{ path: string, actions: readonly string[], dispose: () => Promise<void> }>}
 */
export async function installStressFixture(ctx, options = {}) {
  const home = requireTestHome(options.home)
  const fixture = new StressFixture(ctx, home, options.createUserMessage)
  const dispose = await ctx.connection.fetch.register({
    path: STRESS_FIXTURE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        return await fixture.handle(request)
      } catch (error) {
        return response({
          ok: false,
          error: { code: sanitizeCode(error?.code), message: sanitizeMessage(error?.message) },
        }, 500)
      }
    },
  })
  return {
    path: STRESS_FIXTURE_PATH,
    actions: ACTIONS,
    async dispose() {
      if (typeof dispose === 'function') await dispose()
    },
  }
}
