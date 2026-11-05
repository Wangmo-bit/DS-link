/**
 * Shared test fixtures. All state lives under an OS temp directory; nothing
 * here touches a production DSH home, profile, model, or server.
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { SessionLinkEngine } from '../src/core/engine.js'
import { fail } from '../src/core/errors.js'
import { Ledger } from '../src/core/ledger.js'
import { sha256 } from '../src/core/migration.js'
import { HostAdapter } from '../src/host/adapter.js'

export async function tempRoot(prefix = 'session-link-test-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

export class FakeClock {
  constructor(now = 1_800_000_000_000) {
    this.now = now
  }

  /** @returns {number} */
  read() {
    return this.now
  }

  /** @param {number} ms */
  advance(ms) {
    this.now += ms
    return this.now
  }
}

/**
 * @param {Partial<Record<string, any>>} [overrides]
 * @returns {Record<string, any>}
 */
export function sessionFixture(overrides = {}) {
  const id = overrides.id ?? `s-${Math.random().toString(36).slice(2, 10)}`
  return {
    id,
    title: overrides.title ?? `Session ${id}`,
    workspaceId: overrides.workspaceId ?? 'w-1',
    workspaceTitle: overrides.workspaceTitle ?? 'Workspace 1',
    workspacePath: overrides.workspacePath ?? '/tmp/workspace-1',
    archived: false,
    subagent: false,
    registered: true,
    eligible: true,
    live: true,
    persisted: true,
    formatStatus: 'current',
    agentStatus: 'idle',
    delegationDepth: 0,
    parentSession: null,
    origin: null,
    createdAt: 1_800_000_000_000,
    ...overrides,
  }
}

/** @param {Partial<Record<string, any>>} [overrides] */
export function receiptFixture(overrides = {}) {
  return {
    policy: 'legacy-accepted',
    state: 'uncertain',
    receivedAt: null,
    receivedSeq: null,
    timeoutMs: null,
    transfer: null,
    ...overrides,
  }
}

export class MemoryAdapter {
  /**
   * @param {{ sessions?: Array<Record<string, any>>, clock: FakeClock, autoReceive?: boolean }} options
   */
  constructor(options) {
    this.clock = options.clock
    this.sessions = options.sessions ?? [
      sessionFixture({ id: 'A', title: 'Alpha' }),
      sessionFixture({ id: 'B', title: 'Beta' }),
    ]
    this.inserted = new Map()
    this.built = new Map()
    this.deliveries = []
    this.resolveError = undefined
    this.followupError = undefined
    this.flushResult = true
    this.receiptFlushResult = true
    this.readReceiptsError = undefined
    this.beforeResolveHook = undefined
    this.beforeFollowupHook = undefined
    this.deliverOverride = undefined
    /** Deterministic tests consume steered input immediately unless disabled. */
    this.autoReceive = options.autoReceive !== false
    this.native = new Map()
    this.nativeRunning = new Map()
    // Create-flow fixture state: registered workspaces, host create/rename
    // call records, and hooks for attach failure / id replacement / rename
    // failure / missing capabilities.
    this.workspaces = options.workspaces ?? []
    this.createCalls = []
    this.renameCalls = []
    this.createHooks = {}
    this.createCapabilitiesMissing = false
    this.#hostSeq = 0
    this.#receiptSeq = 0
  }

  #hostSeq
  #receiptSeq
  #receiptListener

  async listSessions() {
    return structuredClone(this.sessions)
  }

  async getSession(id) {
    const session = this.sessions.find((candidate) => candidate.id === id)
    return session === undefined ? undefined : structuredClone(session)
  }

  addSession(session) {
    this.sessions.push(session)
  }

  installReceiptObserver(listener) {
    this.#receiptListener = listener
    return () => {
      this.#receiptListener = undefined
    }
  }

  async flushTarget() {
    return this.receiptFlushResult === true
  }

  #nativeState(targetId) {
    let state = this.native.get(targetId)
    if (state === undefined) {
      state = { nextTurn: [], nextStep: [] }
      this.native.set(targetId, state)
    }
    return state
  }

  queueNative(targetId, message, target = 'next-turn') {
    const state = this.#nativeState(targetId)
    const key = target === 'next-step' ? 'nextStep' : 'nextTurn'
    state[key].push(message)
  }

  setNativeRunning(targetId, running) {
    this.nativeRunning.set(targetId, running)
  }

  #recordInsertion(targetId, durableMessageId, senderSessionId, source) {
    const entry = {
      targetId,
      durableMessageId,
      senderSessionId,
      seq: this.#receiptSeq++,
      time: this.clock.read(),
      source: source ?? { kind: 'agent-message', form: 'relay', senderSessionId },
    }
    this.inserted.set(`${targetId}|${durableMessageId}`, entry)
    return entry
  }

  markInserted(targetId, durableMessageId, senderSessionId, source) {
    return this.#recordInsertion(targetId, durableMessageId, senderSessionId, source)
  }

  /** @param {Record<string, any>} entry */
  async #emitMessage(entry) {
    if (this.#receiptListener === undefined) return
    await this.#receiptListener({
      kind: 'message',
      sessionId: entry.targetId,
      messageId: entry.durableMessageId,
      senderSessionId: entry.senderSessionId,
      source: entry.source,
      seq: entry.seq,
      time: entry.time,
    })
  }

  /** Inject an arbitrary receipt event for source/id/identity tests. */
  async emitReceiptEvent(event) {
    if (this.#receiptListener === undefined) return
    await this.#receiptListener(event)
  }

  /** Simulate a host step consuming one injected message. */
  async receive(targetId, durableMessageId) {
    const state = this.#nativeState(targetId)
    const pending = [...state.nextStep, ...state.nextTurn].find((message) => message?.id === durableMessageId)
    state.nextStep = state.nextStep.filter((message) => message?.id !== durableMessageId)
    state.nextTurn = state.nextTurn.filter((message) => message?.id !== durableMessageId)
    let entry = this.inserted.get(`${targetId}|${durableMessageId}`)
    if (entry === undefined) {
      entry = this.#recordInsertion(targetId, durableMessageId, pending?.source?.senderSessionId, pending?.source)
    }
    await this.#emitMessage(entry)
    return entry
  }

  /** Simulate the next pre-step claiming every pending next-step message. */
  async claimNextStep(targetId) {
    const state = this.#nativeState(targetId)
    const claimed = [...state.nextStep]
    state.nextStep = []
    for (const message of claimed) {
      let entry = this.inserted.get(`${targetId}|${message.id}`)
      if (entry === undefined) {
        entry = this.#recordInsertion(targetId, message.id, message.source?.senderSessionId, message.source)
      }
      await this.#emitMessage(entry)
    }
    return claimed
  }

  async buildDelivery(message) {
    const durableMessageId = `host-msg-${++this.#hostSeq}`
    this.built.set(durableMessageId, structuredClone(message))
    return {
      hostMessage: {
        id: durableMessageId,
        role: 'user',
        content: [{ type: 'text', text: message.rendered }],
        source: { kind: 'agent-message', form: 'relay', senderSessionId: message.from },
      },
      durableMessageId,
    }
  }

  async deliver(request) {
    if (this.deliverOverride !== undefined) return this.deliverOverride(request)
    this.deliveries.push({ targetId: request.targetId, message: this.built.get(request.hostMessage.id) })
    const before = await request.beforeResolve()
    if (before?.ok !== true) return { stage: 'blocked', blocked: before }
    if (this.beforeResolveHook !== undefined) await this.beforeResolveHook(request)
    if (this.resolveError !== undefined) return { stage: 'resolve', error: { code: this.resolveError } }
    const gate = await request.beforeFollowup()
    if (gate?.ok !== true) return { stage: 'blocked', blocked: gate }
    if (this.beforeFollowupHook !== undefined) await this.beforeFollowupHook(request)
    if (this.followupError !== undefined) return { stage: 'followup', error: { code: this.followupError } }
    const message = this.built.get(request.hostMessage.id)
    if (this.autoReceive) {
      const entry = this.markInserted(
        request.targetId,
        request.hostMessage.id,
        message?.from,
        request.hostMessage.source,
      )
      await this.#emitMessage(entry)
    } else {
      this.queueNative(request.targetId, request.hostMessage, 'next-step')
    }
    if (this.flushResult !== true) return { stage: 'flush', flush: this.flushResult, error: { code: 'flush_false' } }
    return { stage: 'accepted' }
  }

  async readEvidence({ targetId, durableMessageId, senderSessionId }) {
    const entry = this.inserted.get(`${targetId}|${durableMessageId}`)
    if (entry === undefined) return { found: false, readable: true, evidence: 'none' }
    if (entry.senderSessionId !== senderSessionId) {
      return { found: false, readable: true, evidence: 'none', identityConflict: true }
    }
    return {
      found: true,
      readable: true,
      evidence: 'message',
      inboxSeen: true,
      seq: entry.seq,
      time: entry.time,
    }
  }

  async readTargetReceipts(targetId) {
    if (this.readReceiptsError !== undefined) throw new Error(this.readReceiptsError)
    const state = this.#nativeState(targetId)
    const messages = []
    for (const entry of this.inserted.values()) {
      if (entry.targetId !== targetId) continue
      messages.push({ id: entry.durableMessageId, seq: entry.seq, time: entry.time, source: entry.source })
    }
    return {
      readable: true,
      messages,
      pendingKnown: true,
      pendingIds: [...state.nextTurn, ...state.nextStep].map((message) => message?.id),
    }
  }

  nativePending(targetId, durableMessageId) {
    const state = this.#nativeState(targetId)
    return {
      known: true,
      pending:
        state.nextTurn.some((message) => message?.id === durableMessageId) ||
        state.nextStep.some((message) => message?.id === durableMessageId),
    }
  }

  inspectNativeTarget(targetId) {
    const state = this.#nativeState(targetId)
    return {
      live: true,
      running: this.nativeRunning.get(targetId) !== false,
      archived: false,
      subagent: false,
      nextTurn: structuredClone(state.nextTurn),
      nextStep: structuredClone(state.nextStep),
      hostSessionSeq: 0,
    }
  }

  moveNativePending(request) {
    const state = this.#nativeState(request.targetId)
    if (this.nativeRunning.get(request.targetId) === false) return { outcome: 'not_running' }
    if (state.nextStep.some((message) => message?.id === request.durableMessageId)) {
      return { outcome: 'already_claimed' }
    }
    const index = state.nextTurn.findIndex((message) => message?.id === request.durableMessageId)
    if (index < 0) return { outcome: 'missing' }
    const message = state.nextTurn[index]
    const source = message?.source
    if (
      !source ||
      Object.keys(source).length !== 3 ||
      source.kind !== 'agent-message' ||
      source.form !== 'relay' ||
      source.senderSessionId !== request.senderSessionId
    ) {
      return { outcome: 'mismatch' }
    }
    if (sha256(Buffer.from(JSON.stringify(message), 'utf8')) !== request.digest) {
      return { outcome: 'mismatch' }
    }
    if (request.guard() !== true) return { outcome: 'blocked' }
    const removed = state.nextTurn.splice(index, 1)[0]
    state.nextStep.push(removed)
    this.#receiptListener?.({ kind: 'inbox', sessionId: request.targetId })?.catch?.(() => undefined)
    return { outcome: 'moved' }
  }

  async history(request) {
    return { sessionId: request.sessionId, mode: request.mode, messages: [], hits: [], total: 0, truncated: false }
  }

  // ---- Create-flow surface used by engine.create tests --------------------

  async assertCreateCapabilities() {
    if (this.createCapabilitiesMissing === true) {
      throw fail('unsupported_host', 'this Host lacks the creation APIs session_link_create requires', {
        missing: ['sessionController.create'],
      })
    }
  }

  async sessionExists(sessionId) {
    if (this.createHooks.sessionExistsResult !== undefined) return this.createHooks.sessionExistsResult
    return this.sessions.some((session) => session.id === sessionId)
  }

  async checkProjectLocation(request) {
    return this.#fsHost.checkProjectLocation(request)
  }

  async checkExistingProjectPath(directoryPath) {
    return this.#fsHost.checkExistingProjectPath(directoryPath)
  }

  async ensureProjectDirectory(request) {
    return this.#fsHost.ensureProjectDirectory(request)
  }

  #fsHost = Object.create(HostAdapter.prototype)

  async getWorkspace(workspaceId) {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId)
    if (workspace === undefined) throw fail('workspace_not_found', 'the workspace is not registered', { workspaceId })
    try {
      const stat = await fs.stat(workspace.path)
      if (!stat.isDirectory()) throw new Error('not a directory')
    } catch {
      throw fail('workspace_path_unavailable', 'the workspace path is not an accessible directory', { workspaceId })
    }
    return { id: workspace.id, path: workspace.path, title: workspace.title }
  }

  async createWorkspace(directoryPath, title) {
    const existing = this.workspaces.find((candidate) => candidate.path === directoryPath)
    if (existing !== undefined) return { id: existing.id, path: existing.path, title: existing.title }
    const workspace = {
      id: `w-mock-${this.workspaces.length + 1}`,
      title: title ?? path.basename(directoryPath),
      path: directoryPath,
      sessionIds: [],
    }
    this.workspaces.push(workspace)
    return { id: workspace.id, path: workspace.path, title: workspace.title }
  }

  async createSession(request) {
    this.createCalls.push({ workspaceId: request.workspaceId, sessionId: request.sessionId })
    if (this.createHooks.createSessionDelay !== undefined) await this.createHooks.createSessionDelay
    const hook = this.createHooks.createError
    if (hook !== undefined) throw hook
    const workspace = this.workspaces.find((candidate) => candidate.id === request.workspaceId)
    if (workspace === undefined) throw { code: 'workspace/not-found', message: 'workspace not found' }
    let sessionId = request.sessionId
    const taken = this.sessions.some((session) => session.id === sessionId)
    if (this.createHooks.forceMint === true || taken || sessionId === undefined) {
      sessionId = `session-minted-${this.createCalls.length}`
    }
    const session = sessionFixture({ id: sessionId, workspaceId: workspace.id, title: `Session ${sessionId}` })
    this.sessions.push(session)
    if (this.createHooks.attachError === true) {
      throw fail('session_attach_failed', 'the session was created but could not attach to the workspace', {
        sessionId,
        workspaceId: workspace.id,
      })
    }
    workspace.sessionIds.push(sessionId)
    return { sessionId }
  }

  async confirmSessionDurable(sessionId) {
    const override = this.createHooks.durableResult
    if (override !== undefined) return structuredClone(override)
    const live = this.sessions.some((session) => session.id === sessionId)
    return live ? { ok: true } : { ok: false, code: 'agent_unavailable', message: 'created session is not live' }
  }

  async renameSession(sessionId, title) {
    this.renameCalls.push({ sessionId, title })
    if (this.createHooks.renameError !== undefined) throw this.createHooks.renameError
    const session = this.sessions.find((candidate) => candidate.id === sessionId)
    if (session === undefined) throw { code: 'session/not-found', message: 'session not found' }
    session.title = title
  }

  async listWorkspaces() {
    return this.workspaces.map((workspace) => ({ id: workspace.id, title: workspace.title, path: workspace.path }))
  }
}

/**
 * @param {{
 *   root: string,
 *   adapter: MemoryAdapter,
 *   clock: FakeClock,
 *   limits?: { maxMessages?: number, maxDiskBytes?: number },
 * }} options
 */
export async function openEngine(options) {
  const ledger = new Ledger({
    root: options.root,
    clock: () => options.clock.read(),
    limits: options.limits,
  })
  await ledger.open()
  const engine = new SessionLinkEngine({
    ledger,
    adapter: options.adapter,
    clock: () => options.clock.read(),
    uuid: options.uuid,
    ...(options.limits?.maxQueuedBytes === undefined ? {} : { maxQueuedBytes: options.limits.maxQueuedBytes }),
  })
  return { ledger, engine }
}

/**
 * Build a mock rc.5 Host context around a set of sessions. The mock keeps
 * enough session log to exercise the real HostAdapter and tools without
 * starting a server or model.
 * @param {{
 *   sessions: Array<Record<string, any>>,
 *   workspaces?: Array<Record<string, any>>,
 *   clock: FakeClock,
 *   logs?: Map<string, { inheritedEventCount?: number, events?: Array<any> }>,
 *   home?: string,
 * }} options
 */
export function makeMockHost(options) {
  const clock = options.clock
  const sessions = options.sessions
  const logs = options.logs ?? new Map()
  const workspaces =
    options.workspaces ??
    [
      { id: 'w-1', title: 'Workspace 1', path: '/tmp/workspace-1', sessionIds: sessions.filter((s) => s.workspaceId === 'w-1').map((s) => s.id) },
      { id: 'w-2', title: 'Workspace 2', path: '/tmp/workspace-2', sessionIds: sessions.filter((s) => s.workspaceId === 'w-2').map((s) => s.id) },
    ]
  const agents = new Map()
  const followups = []
  const steers = []
  const createCalls = []
  const renameCalls = []
  const createHooks = {}
  const toolMap = new Map()
  const routes = new Map()
  const promptSections = []
  const provided = new Map()
  const effects = []
  const listeners = new Map()
  let hostSeq = 0
  const unmounted = []

  const emitEvent = (sessionId, type, data, extra = {}) => {
    const log = logs.get(sessionId) ?? { inheritedEventCount: 0, events: [] }
    log.events ??= []
    const event = { type, seq: log.events.length, time: clock.read(), data, ...extra }
    log.events.push(event)
    logs.set(sessionId, log)
    for (const listener of listeners.get('session/event') ?? []) listener({ id: sessionId }, event)
    return event
  }

  const buildAgent = (session) => {
    const log = logs.get(session.id) ?? { inheritedEventCount: 0, events: [] }
    log.events ??= []
    logs.set(session.id, log)
    const inboxState = { nextTurn: [], nextStep: [] }
    const splice = (target, start, deleteCount, inserted) => {
      const list = target === 'next-turn' ? inboxState.nextTurn : inboxState.nextStep
      const actualStart = start < 0 ? Math.max(list.length + start, 0) : Math.min(start, list.length)
      const actualCount = Math.min(Math.max(Number.isFinite(deleteCount) ? deleteCount : 0, 0), list.length - actualStart)
      const removed = list.splice(actualStart, actualCount, ...inserted)
      emitEvent(session.id, 'agent/inbox/spliced', {
        target,
        start: actualStart,
        ...(actualCount === 0 ? {} : { removedCount: actualCount }),
        inserted,
      })
      return removed
    }
    const remove = (messageId) => {
      for (const target of ['next-turn', 'next-step']) {
        const list = target === 'next-turn' ? inboxState.nextTurn : inboxState.nextStep
        const index = list.findIndex((message) => message?.id === messageId)
        if (index >= 0) {
          splice(target, index, 1, [])
          return true
        }
      }
      return false
    }
    const agent = {
      id: session.id,
      status: session.agentStatus ?? 'idle',
      session: {
        id: session.id,
        snapshotEvents() {
          return log.events
        },
      },
      inbox: {
        get nextTurn() {
          return inboxState.nextTurn
        },
        get nextStep() {
          return inboxState.nextStep
        },
        remove,
        splice,
        append(target, message) {
          splice(target, Infinity, 0, [message])
        },
      },
      followup(message) {
        followups.push({ targetId: session.id, message })
        agent.status = 'running'
        splice('next-turn', Infinity, 0, [message])
      },
      steer(message) {
        steers.push({ targetId: session.id, message })
        agent.status = 'running'
        splice('next-step', Infinity, 0, [message])
      },
    }
    agents.set(session.id, agent)
    return agent
  }

  for (const session of sessions) {
    if (session.live === false) continue
    buildAgent(session)
  }

  const ctx = {
    profileContext: { name: 'mock', home: options.home ?? '/tmp/dsh-session-link-mock' },
    on(name, listener) {
      const entries = listeners.get(name) ?? []
      entries.push(listener)
      listeners.set(name, entries)
      return () => {
        const current = listeners.get(name) ?? []
        const index = current.indexOf(listener)
        if (index >= 0) current.splice(index, 1)
      }
    },
    agents: {
      get(id) {
        return agents.get(id)
      },
      list() {
        return [...agents.values()]
      },
    },
    sessions: {
      async flush(session) {
        return agents.has(session.id)
      },
    },
    sessionController: {
      async resolveAgent(id) {
        const agent = agents.get(id)
        if (agent === undefined) return { error: { code: 'session_not_found' } }
        return { agent }
      },
      async create(request) {
        createCalls.push(structuredClone(request))
        if (createHooks.createError !== undefined) throw createHooks.createError
        if (request?.workspaceId === undefined && request?.cwd === undefined) {
          const error = new Error('session.create accepts workspaceId or cwd, not both')
          error.code = 'gateway/bad-request'
          throw error
        }
        let workspace
        if (request.workspaceId !== undefined) {
          workspace = workspaces.find((candidate) => candidate.id === request.workspaceId)
          if (workspace === undefined) {
            const error = new Error(`workspace "${request.workspaceId}" not found`)
            error.code = 'workspace/not-found'
            throw error
          }
        }
        const cwd = workspace?.path ?? request.cwd
        // The real host createAgent ensures the project directory recursively;
        // in the mock it must already exist so tests prove who created it.
        await fs.mkdir(cwd, { recursive: true })
        let sessionId = request.sessionId
        const stored = sessionId !== undefined && sessions.some((session) => session.id === sessionId)
        if (sessionId === undefined || stored || createHooks.forceMint === true) {
          sessionId = `session-${randomUUID()}`
        }
        const session = sessionFixture({ id: sessionId, workspaceId: workspace?.id, title: `Session ${sessionId}` })
        sessions.push(session)
        buildAgent(session)
        if (createHooks.attachError === true) {
          const error = new Error('session was created but could not attach to the workspace')
          error.code = 'session/workspace-attach-failed'
          error.details = { sessionId, workspaceId: workspace?.id }
          throw error
        }
        if (workspace !== undefined) workspace.sessionIds.push(sessionId)
        return { sessionId }
      },
      async rename(request) {
        renameCalls.push(structuredClone(request))
        if (createHooks.renameError !== undefined) throw createHooks.renameError
        const session = sessions.find((candidate) => candidate.id === request?.sessionId)
        if (session === undefined) {
          const error = new Error(`session "${request?.sessionId}" not found`)
          error.code = 'session/not-found'
          throw error
        }
        session.title = request.title
        return { title: request.title, seq: 0 }
      },
    },
    workspaceRegistry: {
      list() {
        return structuredClone(workspaces)
      },
      get(id) {
        return workspaces.find((workspace) => workspace.id === id)
      },
      async create(directoryPath, title) {
        if (createHooks.workspaceCreateError !== undefined) throw createHooks.workspaceCreateError
        let real
        try {
          real = await fs.realpath(directoryPath)
        } catch {
          const error = new Error(`workspace path "${directoryPath}" does not exist`)
          error.code = 'workspace/nonexistent-path'
          throw error
        }
        const stat = await fs.stat(real)
        if (!stat.isDirectory()) {
          const error = new Error('workspace path is not a directory')
          error.code = 'workspace/not-directory'
          throw error
        }
        const existing = workspaces.find((workspace) => workspace.path === real || workspace.path === directoryPath)
        if (existing !== undefined) return { ...existing, sessionIds: [...existing.sessionIds] }
        const workspace = {
          id: `w-mock-${workspaces.length + 1}`,
          title: title ?? path.basename(real),
          path: real,
          sessionIds: [],
        }
        workspaces.push(workspace)
        return { ...workspace, sessionIds: [...workspace.sessionIds] }
      },
      get archivedSessionIds() {
        return sessions.filter((session) => session.archived === true).map((session) => session.id)
      },
    },
    sessionQuery: {
      async listSessions() {
        return sessions.map((session) => ({
          header: {
            version: 'v4',
            id: session.id,
            createdAt: session.createdAt ?? clock.read(),
            cwd: session.workspacePath ?? '/tmp/workspace-1',
            isSeeded: session.parentSession !== null,
            ...(session.parentSession ? { parentSession: session.parentSession } : {}),
            ...(session.origin ? { origin: session.origin } : {}),
            ...(session.delegationDepth ? { delegationDepth: session.delegationDepth } : {}),
          },
          live: session.live === true,
          persisted: session.persisted !== false,
          formatStatus: session.formatStatus ?? 'current',
        }))
      },
      async readTitleSnapshots(ids) {
        return ids.map((id) => {
          const session = sessions.find((candidate) => candidate.id === id)
          return {
            sessionId: id,
            status: 'fulfilled',
            value: {
              session: { version: 'v4', id, createdAt: clock.read(), isSeeded: false },
              title: session?.title
                ? { title: session.title, messageSeqs: [], source: { kind: 'user' }, eventSeq: 0, updatedAt: clock.read() }
                : undefined,
            },
          }
        })
      },
      async readSession(id) {
        if (!sessions.some((session) => session.id === id)) {
          const error = new Error(`session "${id}" not found`)
          error.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
          throw error
        }
        const log = logs.get(id) ?? { inheritedEventCount: 0, events: [] }
        return {
          session: { version: 'v4', id, createdAt: clock.read(), isSeeded: false },
          inheritedEventCount: log.inheritedEventCount ?? 0,
          events: structuredClone(log.events ?? []),
        }
      },
      async readSurface(id) {
        const log = logs.get(id) ?? { inheritedEventCount: 0, events: [] }
        return {
          session: { version: 'v4', id, createdAt: clock.read(), isSeeded: false },
          inheritedEventCount: log.inheritedEventCount ?? 0,
          capturedThroughSeq: (log.events?.length ?? 1) - 1,
          events: structuredClone(log.events ?? []),
        }
      },
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return async () => {
            routes.delete(route.path)
          }
        },
      },
    },
    tools: {
      register(definition) {
        toolMap.set(definition.name, definition)
        return () => {
          toolMap.delete(definition.name)
        }
      },
    },
    systemPrompt: {
      section(section) {
        promptSections.push(section)
        return () => {
          const index = promptSections.indexOf(section)
          if (index >= 0) promptSections.splice(index, 1)
        }
      },
    },
    provide(name, value) {
      provided.set(name, value)
      return () => {
        provided.delete(name)
      }
    },
    effect(fn) {
      effects.push(fn())
      return () => undefined
    },
    unmounted,
  }

  const createUserMessage = ({ content, source }) => ({
    id: `host-${++hostSeq}`,
    role: 'user',
    content,
    source,
  })

  const claimNextStep = (sessionId) => {
    const agent = agents.get(sessionId)
    if (agent === undefined) return []
    const claimed = [...agent.inbox.nextStep]
    agent.inbox.splice('next-step', 0, claimed.length, [])
    for (const message of claimed) emitEvent(sessionId, 'user/message', message, { surfaceOp: 'append' })
    return claimed
  }

  return {
    ctx,
    sessions,
    workspaces,
    logs,
    agents,
    followups,
    steers,
    claimNextStep,
    emitEvent,
    tools: toolMap,
    routes,
    promptSections,
    provided,
    effects,
    createUserMessage,
    createCalls,
    renameCalls,
    createHooks,
    buildAgent,
  }
}

/**
 * @param {ReturnType<typeof makeMockHost>} host
 * @param {string} sessionId
 * @returns {Record<string, any>}
 */
export function requireTool(host, sessionId) {
  const tool = host.tools.get(sessionId)
  if (tool === undefined) throw new Error(`missing tool ${sessionId}`)
  return tool
}

/**
 * @param {ReturnType<typeof makeMockHost>} host
 * @param {string} sessionId
 * @param {Record<string, any>} [args]
 */
export function execFor(host, sessionId, args = {}) {
  return { agent: host.agents.get(sessionId), arguments: args }
}
