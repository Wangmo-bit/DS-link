/**
 * rc.5 host adapter.
 *
 * Uses only public Host services: workspaceRegistry, sessionQuery, agents, the
 * SessionStore flush checkpoint, Host session/event notifications,
 * sessionController.resolveAgent for delivery, and the host createUserMessage
 * builder injected by the package entry. It never imports a private module,
 * never calls sessionController.prompt, never cancels a recipient's work, and
 * never disposes a target Agent.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { LIMITS } from '../core/constants.js'
import { fail, errorCode } from '../core/errors.js'
import { sha256 } from '../core/migration.js'
import { renderInboundText } from '../core/render.js'
import { assertProjectSegment, isPlainObject } from '../core/validation.js'

const NOOP_LOGGER = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
})

export class HostAdapter {
  /**
   * @param {{
   *   ctx: Record<string, any>,
   *   createUserMessage: (input: Record<string, any>) => Record<string, any>,
   *   clock?: () => number,
   *   logger?: Record<string, (...args: any[]) => void>,
   *   cacheMs?: number,
   * }} options
   */
  constructor(options) {
    if (typeof options?.createUserMessage !== 'function') throw fail('internal', 'createUserMessage is required')
    this.ctx = options.ctx
    this.createUserMessage = options.createUserMessage
    this.clock = options.clock ?? Date.now
    this.logger = options.logger ?? NOOP_LOGGER
    this.cacheMs = options.cacheMs ?? 1500
    this.#cache = undefined
    this.#lastSeq = new Map()
  }

  #cache
  #lastSeq

  /**
   * @param {{ fresh?: boolean }} [options]
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async listSessions(options = {}) {
    return this.#refresh(options.fresh === true)
  }

  /**
   * @param {string} id
   * @param {{ fresh?: boolean }} [options]
   * @returns {Promise<Record<string, any> | undefined>}
   */
  async getSession(id, options = {}) {
    const sessions = await this.#refresh(options.fresh === true)
    return sessions.find((session) => session.id === id)
  }

  /** @param {boolean} fresh @returns {Promise<Array<Record<string, any>>>} */
  async #refresh(fresh) {
    if (!fresh && this.#cache !== undefined && this.clock() - this.#cache.at < this.cacheMs) {
      return this.#cache.sessions
    }
    const [records, workspaces] = await Promise.all([
      this.ctx.sessionQuery.listSessions(),
      Promise.resolve(this.ctx.workspaceRegistry.list()),
    ])
    const workspaceBySession = new Map()
    for (const workspace of workspaces) {
      for (const sessionId of workspace.sessionIds) {
        if (!workspaceBySession.has(sessionId)) {
          workspaceBySession.set(sessionId, {
            id: workspace.id,
            title: workspace.title,
            path: workspace.path,
          })
        }
      }
    }
    const archived = new Set(this.ctx.workspaceRegistry.archivedSessionIds)
    const registered = new Set(workspaceBySession.keys())
    const visible = records.filter((record) => registered.has(record?.header?.id))
    const ids = visible.map((record) => record.header.id)
    let titles = new Map()
    try {
      const observations = ids.length === 0 ? [] : await this.ctx.sessionQuery.readTitleSnapshots(ids)
      titles = new Map(
        observations
          .filter((observation) => observation.status === 'fulfilled')
          .map((observation) => [observation.sessionId, observation.value?.title?.title]),
      )
    } catch (error) {
      this.logger.warn(`session-link: titles unavailable (${errorCode(error)})`)
    }

    const sessions = visible
      .map((record) => {
        const header = record.header
        const id = header.id
        const workspace = workspaceBySession.get(id)
        const subagent = header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
        const isArchived = archived.has(id)
        const formatStatus = record.formatStatus ?? 'current'
        let agentStatus = record.live === true ? 'idle' : 'cold'
        try {
          const agent = this.ctx.agents.get(id)
          if (agent?.status !== undefined) agentStatus = agent.status
        } catch {
          // The registry is allowed to be absent in a narrow test harness.
        }
        const title = titles.get(id) ?? `Session ${String(id).slice(0, 8)}`
        return {
          id,
          title,
          workspaceId: workspace?.id ?? null,
          workspaceTitle: workspace?.title ?? null,
          workspacePath: workspace?.path ?? null,
          createdAt: header.createdAt,
          cwd: header.cwd ?? null,
          parentSession: header.parentSession ?? null,
          origin: header.origin ?? null,
          delegationDepth: header.delegationDepth ?? 0,
          live: record.live === true,
          persisted: record.persisted === true,
          formatStatus,
          archived: isArchived,
          subagent,
          registered: true,
          eligible: !isArchived && !subagent && formatStatus !== 'migration-required',
          agentStatus,
        }
      })
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.id.localeCompare(b.id))

    this.#cache = { at: this.clock(), sessions }
    return sessions
  }

  /**
   * Build the durable host user message for one delivery. The source is the
   * host's standard agent-message attribution with exactly three fields.
   * @param {Record<string, any>} message
   * @returns {Promise<{ hostMessage: Record<string, any>, durableMessageId: string }>}
   */
  async buildDelivery(message) {
    const source = {
      kind: 'agent-message',
      form: 'relay',
      senderSessionId: message.from,
    }
    const hostMessage = this.createUserMessage({
      content: [{ type: 'text', text: message.rendered ?? renderInboundText(message) }],
      source,
    })
    if (typeof hostMessage?.id !== 'string' || hostMessage.id.length === 0) {
      throw fail('message_build_failed', 'host createUserMessage did not return a message id')
    }
    return { hostMessage, durableMessageId: hostMessage.id }
  }

  /**
   * Resolve the target's existing Agent (never a clone), recheck the caller's
   * gate, call steer (nearest next-step; never abort the running tool batch),
   * then require flush() === true. Only a failure before steer is provably
   * un-inserted; the gate callback name is kept for the 0.2 adapter contract.
   * @param {{
   *   targetId: string,
   *   hostMessage: Record<string, any>,
   *   beforeResolve: () => Promise<Record<string, any>>,
   *   beforeFollowup: () => Promise<Record<string, any>>,
   * }} request
   * @returns {Promise<Record<string, any>>}
   */
  async deliver(request) {
    let before
    try {
      before = await request.beforeResolve()
    } catch (error) {
      return { stage: 'blocked', blocked: { action: 'failed', code: errorCode(error), message: 'pre-resolve gate failed' } }
    }
    if (before?.ok !== true) return { stage: 'blocked', blocked: before }

    let resolved
    try {
      resolved = await this.ctx.sessionController.resolveAgent(request.targetId)
    } catch (error) {
      return { stage: 'resolve', error: { code: errorCode(error) } }
    }
    if (resolved === undefined || 'error' in resolved) {
      return {
        stage: 'resolve',
        error: {
          code: resolved?.error?.code ?? 'resolve_failed',
          message: 'target agent could not be resolved',
        },
      }
    }
    const agent = resolved.agent
    if (agent === undefined || agent.id !== request.targetId) {
      return { stage: 'resolve', error: { code: 'agent_identity_mismatch' } }
    }

    try {
      before = await request.beforeFollowup()
    } catch (error) {
      return { stage: 'blocked', blocked: { action: 'failed', code: errorCode(error), message: 'pre-step gate failed' } }
    }
    if (before?.ok !== true) return { stage: 'blocked', blocked: before }

    let insertionStarted = false
    try {
      insertionStarted = true
      if (typeof before?.commit === 'function') {
        // The Engine-owned commit performs a final synchronous state read and
        // calls run() in the same stack; no await sits between the gate and
        // the host insertion.
        const committed = before.commit(() => agent.steer(request.hostMessage))
        if (committed?.ok !== true) return { stage: 'blocked', blocked: committed?.blocked ?? committed }
      } else {
        agent.steer(request.hostMessage)
      }
    } catch (error) {
      return { stage: 'followup', error: { code: errorCode(error) } }
    }
    let flushed
    try {
      flushed = await this.ctx.sessions.flush(agent.session)
    } catch (error) {
      return { stage: 'flush', error: { code: errorCode(error) }, insertionStarted }
    }
    if (flushed !== true) return { stage: 'flush', flush: flushed, insertionStarted, error: { code: 'flush_false' } }
    return { stage: 'accepted' }
  }

  /**
   * Install the single live receipt observer. The callback receives only the
   * normalized facts the engine needs; filtering against the ledger happens in
   * the engine so observation never trusts an unrelated session event.
   * @param {(event: Record<string, any>) => void} listener
   * @returns {() => void}
   */
  installReceiptObserver(listener) {
    if (typeof this.ctx.on !== 'function') {
      throw fail('unsupported_host', 'target Host does not expose the session/event notification API')
    }
    const dispose = this.ctx.on('session/event', (session, event) => {
      try {
        if (session === undefined || event === undefined) return
        if (Number.isSafeInteger(event.seq)) this.#lastSeq.set(session.id, event.seq)
        if (event.type === 'user/message') {
          const message = event.data
          if (!isPlainObject(message) || typeof message.id !== 'string') return
          listener({
            kind: 'message',
            sessionId: session.id,
            messageId: message.id,
            senderSessionId: message.source?.senderSessionId,
            source: message.source,
            seq: event.seq,
            time: event.time,
          })
          return
        }
        if (event.type === 'agent/inbox/spliced') {
          listener({ kind: 'inbox', sessionId: session.id, seq: event.seq, time: event.time })
        }
      } catch (error) {
        this.logger.warn(`session-link receipt observer failed: ${errorCode(error)}`)
      }
    })
    return typeof dispose === 'function' ? dispose : () => undefined
  }

  /**
   * Resolve the live Session for a target without resolving or waking an Agent.
   * The Agent's session is preferred; the SessionStore lookup covers a live
   * session whose Agent is between registrations.
   * @param {string} targetId
   * @returns {Record<string, any> | undefined}
   */
  #liveSession(targetId) {
    try {
      const agent = this.ctx.agents.get(targetId)
      if (agent?.session !== undefined) return agent.session
    } catch {
      // fall through to the store
    }
    try {
      return this.ctx.sessions.get?.(targetId)
    } catch {
      return undefined
    }
  }

  /**
   * Await the target SessionStore flush checkpoint. Only a live session can
   * participate; a cold session returns false and never fakes confirmation.
   * @param {string} targetId
   * @returns {Promise<boolean>}
   */
  async flushTarget(targetId) {
    const session = this.#liveSession(targetId)
    if (session === undefined) return false
    try {
      return (await this.ctx.sessions.flush(session)) === true
    } catch {
      return false
    }
  }

  /**
   * Cold, single-pass receipt evidence for one target. When the target is live,
   * its SessionStore flush must participate and succeed before evidence is
   * returned; a cold target is read from the durable log only.
   * @param {string} targetId
   * @returns {Promise<Record<string, any>>}
   */
  async readTargetReceipts(targetId) {
    const info = await this.getSession(targetId, { fresh: true })
    if (info === undefined || info === null || info.registered !== true || info.subagent === true) {
      return { readable: false, errorCode: 'target_unavailable' }
    }
    const liveSession = this.#liveSession(targetId)
    if (liveSession !== undefined) {
      let flushed = false
      try {
        flushed = (await this.ctx.sessions.flush(liveSession)) === true
      } catch {
        flushed = false
      }
      if (!flushed) return { readable: false, errorCode: 'flush_failed' }
    }
    let snapshot
    try {
      snapshot = await this.ctx.sessionQuery.readSession(targetId)
    } catch (error) {
      return { readable: false, errorCode: errorCode(error) }
    }
    const inherited = Number.isSafeInteger(snapshot.inheritedEventCount) ? snapshot.inheritedEventCount : 0
    const messages = []
    const seen = new Set()
    const lists = { 'next-turn': [], 'next-step': [] }
    let pendingKnown = true
    for (const event of snapshot.events ?? []) {
      if (!Number.isSafeInteger(event?.seq) || event.seq < inherited) continue
      if (event.type === 'user/message') {
        const message = event.data
        if (!isPlainObject(message) || typeof message.id !== 'string') continue
        if (!Number.isSafeInteger(event.time) || event.time < 0) continue
        if (seen.has(message.id)) continue
        seen.add(message.id)
        messages.push({ id: message.id, seq: event.seq, time: event.time, source: message.source })
        continue
      }
      if (event.type === 'agent/inbox/spliced') {
        const data = event.data
        if (
          !isPlainObject(data) ||
          (data.target !== 'next-turn' && data.target !== 'next-step') ||
          !Array.isArray(data.inserted)
        ) {
          pendingKnown = false
          continue
        }
        const start = Number.isSafeInteger(data.start) ? data.start : 0
        const removedCount = Number.isSafeInteger(data.removedCount) ? data.removedCount : 0
        lists[data.target] = spliceMessages(lists[data.target], start, removedCount, data.inserted)
      }
    }
    return {
      readable: true,
      messages,
      pendingKnown,
      pendingIds: [...lists['next-turn'], ...lists['next-step']]
        .map((message) => message?.id)
        .filter((id) => typeof id === 'string'),
    }
  }

  /**
   * Synchronous current native presence for one durable message id. It never
   * resolves or wakes a cold Agent.
   * @param {string} targetId
   * @param {string} durableMessageId
   * @returns {{ known: boolean, pending?: boolean }}
   */
  nativePending(targetId, durableMessageId) {
    if (typeof durableMessageId !== 'string') return { known: false }
    let agent
    try {
      agent = this.ctx.agents.get(targetId)
    } catch {
      return { known: false }
    }
    if (agent?.inbox === undefined) return { known: false }
    try {
      const pending =
        agent.inbox.nextTurn.some((message) => message?.id === durableMessageId) ||
        agent.inbox.nextStep.some((message) => message?.id === durableMessageId)
      return { known: true, pending }
    } catch {
      return { known: false }
    }
  }

  /**
   * Read-only live native inbox snapshot. No resolveAgent, no wake, no cold
   * resume: only an already registered live Agent is inspected.
   * @param {string} targetId
   * @returns {Record<string, any>}
   */
  inspectNativeTarget(targetId) {
    let agent
    try {
      agent = this.ctx.agents.get(targetId)
    } catch {
      return { live: false }
    }
    if (agent === undefined || agent === null) return { live: false }
    let nextTurn
    let nextStep
    try {
      nextTurn = agent.inbox.nextTurn.map((message) => structuredClone(message))
      nextStep = agent.inbox.nextStep.map((message) => structuredClone(message))
    } catch {
      return { live: false }
    }
    let archived = false
    try {
      archived = new Set(this.ctx.workspaceRegistry.archivedSessionIds).has(targetId)
    } catch {
      archived = false
    }
    const hostSessionSeq = this.#lastSeq.get(targetId) ?? -1
    return {
      live: true,
      running: agent.status === 'running',
      archived,
      subagent: false,
      nextTurn,
      nextStep,
      hostSessionSeq,
    }
  }

  /**
   * One synchronous native move: verify the same queued object, remove it from
   * next-turn, then steer that exact object. The SDK has no atomic move, so a
   * throw after remove attempts an in-stack rollback only when both queues are
   * provably empty and the driver is still running.
   * @param {{
   *   targetId: string,
   *   durableMessageId: string,
   *   senderSessionId: string,
   *   queuePosition: number,
   *   digest: string,
   *   guard: () => boolean,
   * }} request
   * @returns {Record<string, any>}
   */
  moveNativePending(request) {
    let agent
    try {
      agent = this.ctx.agents.get(request.targetId)
    } catch {
      return { outcome: 'not_live' }
    }
    if (agent === undefined || agent === null || agent.inbox === undefined) return { outcome: 'not_live' }
    if (agent.status !== 'running') return { outcome: 'not_running' }
    const inbox = agent.inbox
    let nextTurn
    let nextStep
    try {
      nextTurn = inbox.nextTurn
      nextStep = inbox.nextStep
    } catch {
      return { outcome: 'not_running' }
    }
    if (nextStep.some((message) => message?.id === request.durableMessageId)) {
      return { outcome: 'already_claimed' }
    }
    const index = nextTurn.findIndex((message) => message?.id === request.durableMessageId)
    if (index < 0) return { outcome: 'missing' }
    const message = nextTurn[index]
    if (!isStandardSource(message?.source, request.senderSessionId)) return { outcome: 'mismatch' }
    if (digestOf(message) !== request.digest) return { outcome: 'mismatch' }
    let allowed = false
    try {
      allowed = request.guard() === true
    } catch {
      allowed = false
    }
    if (!allowed) return { outcome: 'blocked' }
    let removed = false
    try {
      removed = inbox.remove(request.durableMessageId) === true
    } catch (error) {
      return { outcome: 'uncertain', error: errorCode(error) }
    }
    if (!removed) return { outcome: 'missing' }
    try {
      agent.steer(message)
    } catch (error) {
      let rolledBack = false
      try {
        if (
          agent.status === 'running' &&
          !inbox.nextTurn.some((entry) => entry?.id === request.durableMessageId) &&
          !inbox.nextStep.some((entry) => entry?.id === request.durableMessageId)
        ) {
          const position = Math.max(0, Math.min(request.queuePosition, inbox.nextTurn.length))
          inbox.splice('next-turn', position, 0, [message])
          rolledBack =
            inbox.nextTurn.some((entry) => entry?.id === request.durableMessageId) &&
            !inbox.nextStep.some((entry) => entry?.id === request.durableMessageId)
        }
      } catch {
        rolledBack = false
      }
      return rolledBack ? { outcome: 'rolled_back' } : { outcome: 'uncertain', error: errorCode(error) }
    }
    if (
      inbox.nextStep.some((entry) => entry?.id === request.durableMessageId) &&
      !inbox.nextTurn.some((entry) => entry?.id === request.durableMessageId)
    ) {
      return { outcome: 'moved' }
    }
    if (
      inbox.nextTurn.some((entry) => entry?.id === request.durableMessageId) &&
      !inbox.nextStep.some((entry) => entry?.id === request.durableMessageId)
    ) {
      return { outcome: 'fallback_next_turn' }
    }
    return { outcome: 'uncertain', error: 'post_steer_state_unknown' }
  }

  /**
   * Cold, read-only evidence for one durable message id. Only child-owned
   * events (after the fork-inherited prefix) count. A user/message match also
   * carries the exact original event seq/time for the receipt.
   * @param {{ targetId: string, durableMessageId?: string|null, senderSessionId: string }} request
   * @returns {Promise<Record<string, any>>}
   */
  async readEvidence(request) {
    if (typeof request.durableMessageId !== 'string' || request.durableMessageId.length === 0) {
      return { found: false, readable: true, evidence: 'none' }
    }
    const info = await this.getSession(request.targetId, { fresh: true })
    if (
      info === undefined ||
      info.registered !== true ||
      info.subagent === true ||
      info.archived === true ||
      info.formatStatus === 'migration-required'
    ) {
      return { found: false, readable: false, invalidTarget: true, evidence: 'none' }
    }
    let snapshot
    try {
      snapshot = await this.ctx.sessionQuery.readSession(request.targetId)
    } catch (error) {
      return { found: false, readable: false, errorCode: errorCode(error), evidence: 'none' }
    }
    const inherited = Number.isSafeInteger(snapshot.inheritedEventCount) ? snapshot.inheritedEventCount : 0
    let found = false
    let evidence = 'none'
    let inboxSeen = false
    let identityConflict = false
    let messageSeq
    let messageTime
    const matchesSource = (message) => {
      const source = message?.source
      return (
        isPlainObject(source) &&
        Object.keys(source).length === 3 &&
        source.kind === 'agent-message' &&
        source.form === 'relay' &&
        source.senderSessionId === request.senderSessionId
      )
    }
    for (const event of snapshot.events ?? []) {
      if (!Number.isSafeInteger(event?.seq) || event.seq < inherited) continue
      if (event.type === 'user/message') {
        const message = event.data
        if (message?.id !== request.durableMessageId) continue
        if (!matchesSource(message)) {
          identityConflict = true
          continue
        }
        found = true
        evidence = 'message'
        if (messageSeq === undefined) {
          messageSeq = event.seq
          messageTime = event.time
        }
        continue
      }
      if (event.type === 'agent/inbox/spliced') {
        const inserted = event.data?.inserted
        if (!Array.isArray(inserted)) continue
        for (const message of inserted) {
          if (message?.id !== request.durableMessageId) continue
          if (!matchesSource(message)) {
            identityConflict = true
            continue
          }
          inboxSeen = true
          found = true
          if (evidence !== 'message') evidence = 'inbox'
        }
      }
    }
    return {
      found,
      readable: true,
      evidence,
      inboxSeen,
      identityConflict,
      ...(messageSeq === undefined ? {} : { seq: messageSeq, time: messageTime }),
    }
  }

  /**
   * Bounded, read-only history from the raw session log.
   *
   * Compaction replaces surface nodes but never erases the raw log, so a user
   * asking for another session's history may still search text that is no
   * longer in the current model surface. Only user/assistant text blocks are
   * exposed: tool results, system/developer messages, and their contents are
   * never returned. `readSurface` is used only to mark each raw event as
   * current or shadowed.
   * @param {{
   *   sessionId: string,
   *   mode: 'recent'|'search',
   *   query?: string,
   *   limit: number,
   *   beforeSeq?: number,
   * }} request
   * @returns {Promise<Record<string, any>>}
   */
  async history(request) {
    let snapshot
    try {
      snapshot = await this.ctx.sessionQuery.readSession(request.sessionId)
    } catch (error) {
      throw fail('history_unavailable', 'session history could not be read', { reason: errorCode(error) })
    }
    let surfaceSeqs = null
    try {
      const surface = await this.ctx.sessionQuery.readSurface(request.sessionId)
      surfaceSeqs = new Set(
        (surface.events ?? [])
          .filter((event) => Number.isSafeInteger(event?.seq))
          .map((event) => event.seq),
      )
    } catch {
      // Surface classification is best-effort; raw history remains readable.
      surfaceSeqs = null
    }

    const entries = []
    for (const event of snapshot.events ?? []) {
      if (!Number.isSafeInteger(event?.seq)) continue
      if (request.beforeSeq !== undefined && event.seq >= request.beforeSeq) continue
      let role
      let text
      if (event.type === 'user/message') {
        role = 'user'
        text = textOfContent(event.data?.content)
      } else if (event.type === 'assistant/message') {
        role = 'assistant'
        text = textOfContent(event.data?.message?.content)
      } else {
        continue
      }
      if (text.length === 0) continue
      entries.push({
        seq: event.seq,
        time: event.time,
        role,
        text,
        surface: surfaceSeqs === null ? 'unknown' : surfaceSeqs.has(event.seq) ? 'current' : 'shadowed',
      })
    }
    // Select newest first so a page is always a contiguous newest slice; the
    // returned order is chronological, and the cursor is the oldest selected
    // seq so the next page cannot repeat an item.
    entries.sort((a, b) => b.seq - a.seq)

    const session = await this.getSession(request.sessionId, { fresh: false })
    const base = {
      sessionId: request.sessionId,
      title: session?.title ?? request.sessionId,
      workspaceTitle: session?.workspaceTitle ?? null,
      archived: session?.archived === true,
    }

    if (request.mode === 'search') {
      const needle = request.query.toLowerCase()
      const matches = entries.filter((entry) => entry.text.toLowerCase().includes(needle))
      const selected = []
      let chars = 0
      let truncated = false
      for (const entry of matches) {
        if (selected.length >= request.limit) {
          truncated = true
          break
        }
        const remaining = LIMITS.HISTORY_MAX_CHARS - chars
        if (remaining <= 0) {
          truncated = true
          break
        }
        const fullSnippet = snippetAround(entry.text, needle)
        let snippet = fullSnippet
        if (snippet.length > remaining) {
          snippet = snippet.slice(0, remaining)
          truncated = true
        }
        chars += snippet.length
        selected.push({
          seq: entry.seq,
          time: entry.time,
          role: entry.role,
          surface: entry.surface,
          snippet,
        })
        if (snippet.length < fullSnippet.length) break
      }
      selected.reverse()
      const nextBeforeSeq = selected.length > 0 ? selected[0].seq : null
      return {
        ...base,
        mode: 'search',
        hits: selected,
        total: selected.length,
        truncated,
        chars,
        nextBeforeSeq,
      }
    }

    const selected = []
    let chars = 0
    let truncated = false
    for (const entry of entries) {
      if (selected.length >= request.limit) {
        truncated = true
        break
      }
      const remaining = LIMITS.HISTORY_MAX_CHARS - chars
      if (remaining <= 0) {
        truncated = true
        break
      }
      let text = entry.text
      if (text.length > remaining) {
        text = text.slice(0, remaining)
        truncated = true
      }
      chars += text.length
      selected.push({
        seq: entry.seq,
        time: entry.time,
        role: entry.role,
        surface: entry.surface,
        text,
      })
      if (text.length < entry.text.length) break
    }
    selected.reverse()
    const nextBeforeSeq = selected.length > 0 ? selected[0].seq : null
    return {
      ...base,
      mode: 'recent',
      messages: selected,
      total: selected.length,
      truncated,
      chars,
      nextBeforeSeq,
    }
  }
  // -------------------------------------------------------------------------
  // Create-flow host boundary (session_link_create)
  //
  // Capability is validated at this call boundary, never in the plugin's
  // mount-time required list: a Host without create/rename/workspace keeps
  // mounting the original interop plugin and only this tool reports
  // `unsupported_host`.
  // -------------------------------------------------------------------------

  /** @returns {Promise<void>} */
  async assertCreateCapabilities() {
    const missing = []
    const required = [
      ['workspaceRegistry.create', this.ctx.workspaceRegistry?.create],
      ['workspaceRegistry.get', this.ctx.workspaceRegistry?.get],
      ['sessionController.create', this.ctx.sessionController?.create],
      ['sessionController.rename', this.ctx.sessionController?.rename],
      ['sessionQuery.readSession', this.ctx.sessionQuery?.readSession],
    ]
    for (const [name, value] of required) if (typeof value !== 'function') missing.push(name)
    if (missing.length > 0) {
      throw fail('unsupported_host', 'this Host lacks the creation APIs session_link_create requires', {
        missing,
      })
    }
  }

  /**
   * Read-only existence proof for the pure-random reserved session id. Only
   * an explicit not-found answer means "absent"; any other failure fails
   * closed before a create is attempted.
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async sessionExists(sessionId) {
    try {
      await this.ctx.sessionQuery.readSession(sessionId)
      return true
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : ''
      if (code === 'SESSION_QUERY_SESSION_NOT_FOUND') return false
      throw fail('session_lookup_failed', 'the reserved session id could not be verified', {
        reason: code.length > 0 ? code : errorCode(error),
      })
    }
  }

  /**
   * Read-only validation of a new-project location: an existing canonical
   * parent directory and an absent single-segment target. No directory is
   * created here; the caller still re-runs this check inside
   * {@link ensureProjectDirectory} to keep the TOCTOU window fail-closed.
   * @param {{ parentDir: string, directoryName: string }} request
   * @returns {Promise<{ parentPath: string, targetPath: string }>}
   */
  async checkProjectLocation(request) {
    const directoryName = assertProjectSegment(request?.directoryName, 'newProject.directoryName')
    const parentDir = typeof request?.parentDir === 'string' ? request.parentDir : ''
    if (parentDir.length === 0 || parentDir.includes('\u0000')) {
      throw fail('invalid_argument', 'newProject.parentDir must be an absolute path')
    }
    let parentPath
    try {
      parentPath = await fs.realpath(parentDir)
    } catch {
      throw fail('parent_missing', 'the parent directory does not exist; create it first', {})
    }
    let parentStat
    try {
      parentStat = await fs.lstat(parentPath)
    } catch {
      throw fail('parent_missing', 'the parent directory is not accessible', {})
    }
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw fail('invalid_location', 'the parent path must be a real directory', {})
    }
    const targetPath = path.join(parentPath, directoryName)
    let targetStat
    try {
      targetStat = await fs.lstat(targetPath)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw fail('invalid_location', 'the target path could not be inspected', { reason: errorCode(error) })
      }
      return { parentPath, targetPath }
    }
    if (targetStat.isSymbolicLink()) {
      throw fail('target_exists', 'the target path is a symlink; refusing to take it over', {})
    }
    throw fail('target_exists', 'the target directory already exists; refusing to take it over', {})
  }

  /**
   * Create the single-segment project directory under an existing parent:
   * non-recursive mkdir, no overwrite, endpoint symlink refused, then a
   * post-create verification. A verification failure keeps the created
   * directory in place - nothing is deleted as rollback.
   * @param {{ parentDir: string, directoryName: string }} request
   * @returns {Promise<{ path: string }>}
   */
  async ensureProjectDirectory(request) {
    const { targetPath } = await this.checkProjectLocation(request)
    try {
      await fs.mkdir(targetPath)
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw fail('target_exists', 'the target directory already exists; refusing to take it over', {})
      }
      if (error?.code === 'ENOENT') {
        throw fail('parent_missing', 'the parent directory disappeared before creation', {})
      }
      throw fail('directory_create_failed', 'the project directory could not be created', {
        reason: errorCode(error),
      })
    }
    try {
      const stat = await fs.lstat(targetPath)
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw fail('target_verification_failed', 'the created path is not a plain directory; verify it manually', {})
      }
      const real = await fs.realpath(targetPath)
      if (real !== targetPath) {
        throw fail('target_verification_failed', 'the created path resolves elsewhere; verify it manually', {})
      }
    } catch (error) {
      if (error?.code === 'target_verification_failed') throw error
      throw fail('target_verification_failed', 'the created directory could not be verified; verify it manually', {
        reason: errorCode(error),
      })
    }
    return { path: targetPath }
  }

  /**
   * Register an existing real directory as a workspace. The registry
   * canonicalizes and reuses an identical realpath under host semantics.
   * @param {string} directoryPath
   * @param {string} [title]
   * @returns {Promise<{ id: string, path: string, title: string }>}
   */
  async createWorkspace(directoryPath, title) {
    if (typeof directoryPath !== 'string' || directoryPath.length === 0) {
      throw fail('invalid_argument', 'a workspace path is required')
    }
    let workspace
    try {
      workspace = await this.ctx.workspaceRegistry.create(
        directoryPath,
        typeof title === 'string' && title.length > 0 ? title : undefined,
      )
    } catch (error) {
      throw fail('workspace_register_failed', 'the directory could not be registered as a workspace', {
        reason: typeof error?.code === 'string' ? error.code : errorCode(error),
      })
    }
    if (workspace === undefined || typeof workspace?.id !== 'string') {
      throw fail('workspace_register_failed', 'the workspace registry returned no identity', {})
    }
    return { id: workspace.id, path: workspace.path, title: workspace.title }
  }

  /**
   * Resolve an existing registered workspace and prove its path is an
   * accessible real directory.
   * @param {string} workspaceId
   * @returns {Promise<{ id: string, path: string, title: string }>}
   */
  async getWorkspace(workspaceId) {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined || workspace === null) {
      throw fail('workspace_not_found', 'the workspace is not registered', { workspaceId })
    }
    try {
      const stat = await fs.stat(workspace.path)
      if (!stat.isDirectory()) throw new Error('not a directory')
    } catch {
      throw fail('workspace_path_unavailable', 'the workspace path is not an accessible directory', { workspaceId })
    }
    return { id: workspace.id, path: workspace.path, title: workspace.title }
  }

  /**
   * Create one ordinary session under the reserved id. The host may return a
   * different identity when the reserved id is not reusable; an attach
   * failure still carries the real created id in `details.sessionId`, which
   * this wrapper surfaces so the journal can keep it.
   * @param {{ workspaceId: string, sessionId: string }} request
   * @returns {Promise<{ sessionId: string }>}
   */
  async createSession(request) {
    let created
    try {
      created = await this.ctx.sessionController.create({
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
      })
    } catch (error) {
      if (error?.code === 'session/workspace-attach-failed' && typeof error?.details?.sessionId === 'string') {
        throw fail(
          'session_attach_failed',
          'the session was created but could not attach to the workspace',
          { sessionId: error.details.sessionId, workspaceId: request.workspaceId },
        )
      }
      throw error
    }
    if (typeof created?.sessionId !== 'string' || created.sessionId.length === 0) {
      throw fail('create_result_unknown', 'the host returned no session identity', {})
    }
    return { sessionId: created.sessionId }
  }

  /**
   * Durability barrier after the host reports a created session: a create
   * return only proves the session was published, not that its state (or a
   * title) is on disk. Resolve the actual live agent and require a successful
   * SessionStore flush checkpoint. A false/throw/missing agent is reported as
   * an actionable partial result and never implies the session may be rebuilt.
   * @param {string} sessionId
   * @returns {Promise<{ ok: true } | { ok: false, code: string, message: string }>}
   */
  async confirmSessionDurable(sessionId) {
    let resolved
    try {
      resolved = await this.ctx.sessionController.resolveAgent(sessionId)
    } catch (error) {
      return {
        ok: false,
        code: 'agent_unavailable',
        message: `the created session's live agent could not be resolved (${errorCode(error)})`,
      }
    }
    if (resolved === undefined || resolved === null || 'error' in resolved || resolved.agent === undefined) {
      return { ok: false, code: 'agent_unavailable', message: "the created session has no live agent to confirm" }
    }
    try {
      const flushed = await this.ctx.sessions.flush(resolved.agent.session)
      if (flushed !== true) {
        return { ok: false, code: 'flush_unconfirmed', message: 'the host durability flush did not confirm the created session' }
      }
    } catch (error) {
      return { ok: false, code: 'flush_unconfirmed', message: `the host durability flush failed (${errorCode(error)})` }
    }
    return { ok: true }
  }

  /**
   * One-shot public rename. Failure is recorded by the caller and never
   * blocks the first task message.
   * @param {string} sessionId
   * @param {string} title
   * @returns {Promise<void>}
   */
  async renameSession(sessionId, title) {
    await this.ctx.sessionController.rename({ sessionId, title })
  }

  /**
   * Registered workspaces in durable order with the minimal public fields.
   * @returns {Promise<Array<{ id: string, title: string, path: string }>>}
   */
  async listWorkspaces() {
    return this.ctx.workspaceRegistry.list().map((workspace) => ({
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
    }))
  }
}

/**
 * @param {unknown} source
 * @param {string} senderSessionId
 * @returns {boolean}
 */
function isStandardSource(source, senderSessionId) {
  if (!isPlainObject(source)) return false
  const keys = Object.keys(source)
  return (
    keys.length === 3 &&
    keys.every((key) => key === 'kind' || key === 'form' || key === 'senderSessionId') &&
    source.kind === 'agent-message' &&
    source.form === 'relay' &&
    source.senderSessionId === senderSessionId
  )
}

/** @param {unknown} hostMessage @returns {string} */
function digestOf(hostMessage) {
  return sha256(Buffer.from(JSON.stringify(hostMessage), 'utf8'))
}

/**
 * Apply one durable inbox splice with the same truncation/clamp rules the host
 * projection uses, so a cold fold can decide whether one durable id is pending.
 * @param {Array<Record<string, any>>} list
 * @param {number} start
 * @param {number} deleteCount
 * @param {Array<Record<string, any>>} inserted
 * @returns {Array<Record<string, any>>}
 */
function spliceMessages(list, start, deleteCount, inserted) {
  const actualStart = start < 0 ? Math.max(list.length + start, 0) : Math.min(start, list.length)
  const count = Math.min(Math.max(deleteCount, 0), list.length - actualStart)
  return [...list.slice(0, actualStart), ...inserted, ...list.slice(actualStart + count)]
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * @param {string} text
 * @param {string} needle
 * @returns {string}
 */
function snippetAround(text, needle) {
  const index = text.toLowerCase().indexOf(needle)
  if (index < 0) return text.slice(0, 500)
  const start = Math.max(0, index - 160)
  const end = Math.min(text.length, index + needle.length + 160)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`.slice(0, 500)
}
