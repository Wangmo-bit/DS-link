/**
 * Host-independent delivery state machine and owner control plane.
 *
 * The engine owns every durable transition. Host code supplies an adapter for
 * eligibility/discovery, message construction, resolveAgent+followup+flush,
 * cold evidence reads, and history. The engine never calls
 * `sessionController.prompt`, never captures a recipient's last assistant
 * message, and never retries an unknown delivery.
 */

import { randomUUID } from 'node:crypto'

import {
  CONTROL_ACTIONS,
  LIMITS,
  SNAPSHOT_FILTERS,
} from './constants.js'
import {
  activeLatches,
  budgetSummary,
  dayKey,
  latchesBlocking,
  pruneBudget,
  recordSubmission,
  releaseLatch,
  reserveBudget,
  scopesFor,
} from './budget.js'
import { fail, errorCode } from './errors.js'
import { skipMutation } from './ledger.js'
import { renderInboundText } from './render.js'
import { applySettingsPatch } from './settings.js'
import {
  assertAllowedKeys,
  assertPlainObject,
  boundedInteger,
  callFingerprint,
  isPlainObject,
  mintOperationId,
  normalizeContent,
  normalizeTargets,
  optionalString,
  requiredString,
  validateOperationId,
} from './validation.js'

const NOOP_LOGGER = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
})

/**
 * @param {Record<string, any>} state
 * @param {string} id
 * @returns {Record<string, any> | undefined}
 */
function findMessage(state, id) {
  return state.messages.find((message) => message?.id === id)
}

/**
 * @param {Record<string, any>} state
 * @param {string} chainId
 * @returns {Array<Record<string, any>>}
 */
function chainMessages(state, chainId) {
  return state.messages.filter((message) => message?.chainId === chainId)
}

/**
 * @param {Record<string, any>} state
 * @param {Record<string, any>} message
 * @param {number} now
 * @param {object} [settings]
 * @returns {string[]}
 */
function dispatchBlockers(state, message, now, settings = state.settings) {
  const blockers = []
  if (!settings.enabled) blockers.push('disabled')
  if (settings.emergencyPaused) blockers.push('emergency_paused')
  if (!settings.autoCollaborate && message.releaseAuthorized !== true) blockers.push('auto_collaborate_off')
  const chain = state.chains[message.chainId]
  if (chain === undefined) blockers.push('chain_missing')
  else if (chain.state === 'paused') blockers.push('chain_paused')
  const scopes = scopesFor(message.from, [message.to], now)
  const latches = latchesBlocking(state, scopes)
  if (latches.length > 0) blockers.push('budget_latched')
  return blockers
}

/**
 * Translate one adapter delivery outcome into a durable status. Only a
 * synchronous pre-insertion failure may become `failed`; every ambiguous
 * outcome after followup starts is `unknown`.
 * @param {{ stage: string, blocked?: any, error?: any }} outcome
 * @returns {{ status: 'accepted'|'failed'|'unknown'|'held'|'pending'|'cancelled', code?: string, message?: string }}
 */
function classifyDeliveryOutcome(outcome) {
  if (outcome.stage === 'accepted') return { status: 'accepted' }
  if (outcome.stage === 'blocked') {
    const action = outcome.blocked?.action
    if (action === 'held' || action === 'pending' || action === 'cancelled' || action === 'failed') {
      return {
        status: action,
        code: outcome.blocked.code ?? outcome.blocked.reason ?? 'blocked',
        message: outcome.blocked.message ?? 'delivery blocked before host insertion',
      }
    }
    return { status: 'unknown', code: 'blocked_unknown', message: 'delivery gate returned an unknown action' }
  }
  if (outcome.stage === 'resolve') {
    return {
      status: 'failed',
      code: outcome.error?.code ?? 'resolve_failed',
      message: 'target agent could not be resolved; nothing was inserted',
    }
  }
  if (outcome.stage === 'followup') {
    return {
      status: 'unknown',
      code: outcome.error?.code ?? 'followup_failed',
      message: 'followup may have inserted the message; not retried automatically',
    }
  }
  if (outcome.stage === 'flush') {
    return {
      status: 'unknown',
      code: 'flush_failed',
      message: 'host durability flush did not confirm the insertion; not retried automatically',
    }
  }
  return { status: 'unknown', code: 'delivery_unknown', message: 'delivery outcome is unknown' }
}

export class SessionLinkEngine {
  /**
   * @param {{
   *   ledger: import('./ledger.js').Ledger,
   *   adapter: Record<string, any>,
   *   clock?: () => number,
   *   uuid?: () => string,
   *   logger?: Record<string, (...args: any[]) => void>,
   * }} options
   */
  constructor(options) {
    if (options?.ledger === undefined) throw fail('internal', 'engine requires a ledger')
    if (options?.adapter === undefined) throw fail('internal', 'engine requires a host adapter')
    this.ledger = options.ledger
    this.adapter = options.adapter
    this.clock = options.clock ?? Date.now
    this.uuid = options.uuid ?? randomUUID
    this.logger = options.logger ?? NOOP_LOGGER
    this.#slots = 0
    this.#waiters = []
    this.#inflight = new Set()
    this.#starting = new Set()
    this.#disposed = false
    this.#pumpScheduled = false
  }

  #slots
  #waiters
  #inflight
  #starting
  #disposed
  #pumpScheduled

  // -------------------------------------------------------------------------
  // Startup recovery
  // -------------------------------------------------------------------------

  /**
   * Cold reconcile every in-flight row without resolving an Agent. No evidence
   * means unknown, never a resend.
   * @returns {Promise<Record<string, any>>}
   */
  async start() {
    const now = this.clock()
    const before = this.ledger.read()
    const dispatching = before.messages.filter((message) => message.status === 'dispatching')
    const evidence = new Map()
    for (const message of dispatching) {
      try {
        const result = await this.adapter.readEvidence({
          targetId: message.to,
          durableMessageId: message.durableMessageId,
          senderSessionId: message.from,
        })
        evidence.set(message.id, result)
      } catch (error) {
        evidence.set(message.id, { found: false, readable: false, errorCode: errorCode(error) })
      }
    }

    const summary = await this.ledger.mutate((state) => {
      let recovered = 0
      let unknown = 0
      for (const message of dispatching) {
        const current = findMessage(state, message.id)
        if (current?.status !== 'dispatching') continue
        const result = evidence.get(message.id)
        if (result?.found === true && result.identityConflict !== true) {
          this.#acceptMessage(state, current, now, {
            recoveryEvidence: result.evidence ?? 'unknown',
            inboxSeen: result.inboxSeen === true,
          })
          recovered += 1
          continue
        }
        this.#markUnknownInState(state, current, now, {
          code:
            result?.identityConflict === true
              ? 'identity_conflict'
              : result?.invalidTarget === true
                ? 'target_unavailable'
                : result?.readable === false
                  ? 'evidence_unreadable'
                  : 'no_insertion_evidence',
          message:
            result?.identityConflict === true
              ? 'a different sender identity used the same durable message id'
              : result?.invalidTarget === true
                ? 'target is no longer an eligible ordinary session'
                : result?.readable === false
                  ? 'target history could not be read; treating the delivery as unknown'
                  : 'no insertion evidence was found; the delivery is unknown and was not retried',
        })
        unknown += 1
      }
      const cleaned = this.#cleanupState(state, now)
      return { recovered, unknown, cleaned }
    })
    this.#schedulePump()
    return { dispatching: dispatching.length, ...summary }
  }

  // -------------------------------------------------------------------------
  // Timeouts, retention, and disk hygiene
  // -------------------------------------------------------------------------

  /**
   * Periodic sweep: request deadlines, body retention, metadata pruning.
   * @returns {Promise<Record<string, any>>}
   */
  async tick() {
    if (this.#disposed) return { skipped: true }
    const now = this.clock()
    const summary = await this.ledger.mutate((state) => {
      const changed = this.#cleanupState(state, now)
      if (!changed) return skipMutation({ timedOut: 0, redacted: 0, prunedMessages: 0, prunedOperations: 0, prunedChains: 0 })
      return { timedOut: this.#lastCleanup.timedOut, ...this.#lastCleanup }
    })
    this.#schedulePump()
    return summary
  }

  #lastCleanup = { timedOut: 0, redacted: 0, prunedMessages: 0, prunedOperations: 0, prunedChains: 0 }

  /**
   * @param {Record<string, any>} state
   * @param {number} now
   * @returns {boolean}
   */
  #cleanupState(state, now) {
    let changed = pruneBudget(state, now)
    const settings = state.settings
    const retentionMs = settings.retentionDays * 24 * 60 * 60 * 1000
    let timedOut = 0
    for (const message of state.messages) {
      if (
        message.kind === 'request' &&
        message.status === 'accepted' &&
        message.replyStatus === 'waiting' &&
        Number.isSafeInteger(message.deadlineAt) &&
        message.deadlineAt <= now
      ) {
        const chain = state.chains[message.chainId]
        if (chain?.state !== 'closed') {
          message.replyStatus = 'timed_out'
          message.timedOutAt = message.deadlineAt
          timedOut += 1
          changed = true
        }
      }
    }

    let redacted = 0
    for (const message of state.messages) {
      if (message.redactedAt !== undefined) continue
      if (!Number.isSafeInteger(message.createdAt) || message.createdAt + retentionMs > now) continue
      const chain = state.chains[message.chainId]
      const completed =
        message.status === 'failed' ||
        message.status === 'cancelled' ||
        chain?.state === 'closed' ||
        (message.kind === 'request' && (message.replyStatus === 'answered' || message.replyStatus === 'timed_out'))
      if (!completed) continue
      if (message.status === 'pending' || message.status === 'held' || message.status === 'dispatching' || message.status === 'unknown') {
        continue
      }
      message.content = { text: '', references: [], paths: [] }
      message.contentBytes = 2
      message.redactedAt = now
      redacted += 1
      changed = true
    }

    const messageCutoff = now - LIMITS.MESSAGE_RETENTION_MS
    let prunedMessages = 0
    let prunedChains = 0
    // Prune a closed chain as a unit. Pruning individual messages would leave
    // dangling parent/reply references, which the ledger rejects at startup.
    for (const [chainId, chain] of Object.entries(state.chains)) {
      if (!isPlainObject(chain) || chain.state !== 'closed') continue
      if (!Number.isSafeInteger(chain.closedAt) || chain.closedAt >= messageCutoff) continue
      const messages = state.messages.filter((message) => message.chainId === chainId)
      if (messages.length === 0) {
        delete state.chains[chainId]
        prunedChains += 1
        changed = true
        continue
      }
      const terminal = messages.every(
        (message) =>
          Number.isSafeInteger(message.createdAt) &&
          message.createdAt < messageCutoff &&
          (message.status === 'accepted' || message.status === 'failed' || message.status === 'cancelled'),
      )
      if (!terminal) continue
      const ids = new Set(messages.map((message) => message.id))
      state.messages = state.messages.filter((message) => !ids.has(message.id))
      prunedMessages += messages.length
      delete state.chains[chainId]
      prunedChains += 1
      changed = true
    }

    let prunedOperations = 0
    const operations = {}
    for (const [key, operation] of Object.entries(state.operations)) {
      if (isPlainObject(operation) && Number.isSafeInteger(operation.at) && operation.at < messageCutoff) {
        prunedOperations += 1
        changed = true
        continue
      }
      operations[key] = operation
    }
    state.operations = operations

    if (Array.isArray(state.latches)) {
      const latches = state.latches.filter(
        (latch) => !(isPlainObject(latch) && Number.isSafeInteger(latch.releasedAt) && latch.releasedAt < messageCutoff),
      )
      if (latches.length !== state.latches.length) {
        state.latches = latches
        changed = true
      }
    }

    this.#lastCleanup = { timedOut, redacted, prunedMessages, prunedOperations, prunedChains }
    return changed
  }

  // -------------------------------------------------------------------------
  // Send / reply
  // -------------------------------------------------------------------------

  /**
   * @param {{
   *   from: string,
   *   fromTitle?: string,
   *   targets: unknown,
   *   kind: string,
   *   text: unknown,
   *   operationId: string,
   *   parentMessageId?: string,
   *   references?: unknown,
   *   paths?: unknown,
   * }} request
   * @returns {Promise<Record<string, any>>}
   */
  async send(request) {
    const object = assertPlainObject(request, 'send request')
    assertAllowedKeys(
      object,
      ['from', 'fromTitle', 'targets', 'kind', 'text', 'operationId', 'parentMessageId', 'references', 'paths'],
      'send request',
    )
    const from = requiredString(object.from, 'from', { min: 1, max: 256 })
    const kind = requiredString(object.kind, 'kind', { max: 32 })
    if (kind !== 'notification' && kind !== 'request') {
      throw fail('invalid_argument', 'send accepts only notification or request; replies use session_link_reply')
    }
    const targets = normalizeTargets(object.targets, from)
    const operationId = requiredString(object.operationId, 'operationId', { max: 128 })
    const parentMessageId = optionalString(object.parentMessageId, 'parentMessageId', { max: 256 })
    const currentSettings = this.ledger.read().settings
    const content = normalizeContent(
      { text: object.text, references: object.references, paths: object.paths },
      currentSettings,
    )
    const fingerprint = callFingerprint({
      kind,
      text: content.text,
      references: content.references,
      paths: content.paths,
      parentMessageId: parentMessageId ?? null,
      targets,
    })
    // Idempotent retry must win before eligibility is rechecked: a target may
    // have been archived since the original call, yet the caller is entitled
    // to the original per-target statuses and no resend.
    const existingState = this.ledger.read()
    const existingOperation = this.#lookupOperation(existingState, from, operationId)
    if (existingOperation !== undefined) {
      if (existingOperation.fingerprint !== fingerprint) {
        throw fail('conflict_operation', 'operationId was already used with different content, kind, targets, or parent', {
          operationId,
        })
      }
      return this.#operationResult(existingState, existingOperation)
    }
    await this.#requireSender(from)
    const targetInfo = new Map()
    for (const target of targets) {
      targetInfo.set(target, await this.#requireTarget(target))
    }
    const fromInfo = await this.adapter.getSession(from, { fresh: true })
    const fromTitle = optionalString(object.fromTitle, 'fromTitle', { max: 500 }) ?? fromInfo?.title ?? from

    const now = this.clock()
    let created = []
    let chainId
    const result = await this.#deliveryMutation(
      (state) => {
        const duplicate = this.#lookupOperation(state, from, operationId)
        if (duplicate !== undefined) {
          if (duplicate.fingerprint !== fingerprint) {
            throw fail('conflict_operation', 'operationId was already used with different content, kind, targets, or parent', {
              operationId,
            })
          }
          return skipMutation(this.#operationResult(state, duplicate))
        }
        validateOperationId(operationId, now)

        if (!state.settings.enabled) throw fail('disabled', 'session-link is disabled; enable it in settings first')
        const blockedLatches = latchesBlocking(state, scopesFor(from, targets, now))
        if (blockedLatches.length > 0) {
          throw fail('budget_latched', 'session-link budget is latched; an owner must release the latch', {
            latches: blockedLatches,
          })
        }
        const submission = recordSubmission(state, { from, now })
        if (!submission.ok) {
          throw fail('rate_limited', 'one source may submit at most once per second', {
            retryAfterMs: submission.retryAfterMs,
          })
        }

        let chain
        let hop = 0
        if (parentMessageId !== undefined) {
          const parent = findMessage(state, parentMessageId)
          if (parent === undefined) throw fail('parent_not_found', 'parent message not found')
          if (parent.from !== from && parent.to !== from) throw fail('parent_forbidden', 'only a participant may continue this thread')
          if (parent.status !== 'accepted') {
            throw fail('parent_not_accepted', 'send parent must already be accepted; only explicit replies may use unconfirmed parents')
          }
          chain = state.chains[parent.chainId]
          if (chain === undefined) throw fail('chain_missing', 'parent chain is missing')
          if (chain.state === 'closed') throw fail('chain_closed', 'chain is closed')
          if (chain.state === 'paused') throw fail('chain_paused', 'chain is paused')
          hop = parent.hop + 1
          if (hop > chain.maxHops) {
            this.#pauseChainInState(state, chain, 'hop_exceeded', now)
            throw fail('hop_exceeded', 'maximum hop count reached for this chain', { maxHops: chain.maxHops })
          }
          chainId = chain.id
        } else {
          // The gate is pair-scoped: an unanswered request to one peer must not
          // freeze the sender's independent roots with every other session.
          for (const target of targets) this.#assertPairGate(state, from, target, now)
        }

        if (chain === undefined) {
          chainId = this.uuid()
          chain = {
            id: chainId,
            rootOwner: from,
            createdAt: now,
            state: 'open',
            maxMessages: Math.min(state.settings.maxMessages, LIMITS.CHAIN_MAX_MESSAGES),
            maxHops: Math.min(state.settings.maxHops, LIMITS.CHAIN_MAX_HOPS),
            messageCount: 0,
          }
          state.chains[chainId] = chain
        }

        const existingCount = chainMessages(state, chainId).length
        if (existingCount + targets.length > chain.maxMessages) {
          this.#pauseChainInState(state, chain, 'chain_budget', now)
          throw fail('chain_budget', 'chain message budget would be exceeded', {
            maxMessages: chain.maxMessages,
            messages: existingCount,
            requested: targets.length,
          })
        }

        const held = state.settings.emergencyPaused || !state.settings.autoCollaborate
        if (held) {
          this.#assertHeldCapacity(state, from, targets.length, content.bytes * targets.length)
        }

        const messageIds = {}
        for (const target of targets) {
          const info = targetInfo.get(target)
          const message = {
            id: this.uuid(),
            operationId,
            from,
            fromTitle,
            to: target,
            toTitle: info?.title ?? target,
            kind,
            chainId,
            replyTo: parentMessageId ?? null,
            parentMessageId: parentMessageId ?? null,
            hop,
            createdAt: now,
            acceptedAt: null,
            deadlineAt: null,
            timedOutAt: null,
            lateReplyAt: null,
            content: structuredClone(content),
            contentBytes: content.bytes,
            status: held ? 'held' : 'pending',
            replyStatus: 'none',
            deliveryAttempts: 0,
            durableMessageId: null,
            error: held
              ? {
                  code: state.settings.emergencyPaused ? 'emergency_paused' : 'auto_collaborate_off',
                  message: 'held until an owner releases it',
                }
              : null,
            heldAt: held ? now : null,
          }
          state.messages.push(message)
          messageIds[target] = message.id
        }
        chain.messageCount = existingCount + targets.length
        const operationKey = this.#operationKey(from, operationId, targets)
        state.operations[operationKey] = {
          key: operationKey,
          from,
          operationId,
          fingerprint,
          targets: [...targets],
          messageIds,
          at: now,
        }
        created = Object.values(messageIds)
        return {
          operationId,
          idempotent: false,
          chainId,
          held,
          results: targets.map((target) => ({
            target,
            id: messageIds[target],
            status: held ? 'held' : 'pending',
            error: held
              ? {
                  code: state.settings.emergencyPaused ? 'emergency_paused' : 'auto_collaborate_off',
                  message: 'held until an owner releases it',
                }
              : null,
          })),
        }
      },
      { delivery: true },
      parentMessageId,
    )

    if (result.idempotent === true || result.held === true) return result
    await this.#dispatchBatch(created)
    return {
      ...result,
      results: result.results.map((entry) => {
        const message = this.#message(entry.id)
        return {
          ...entry,
          status: message?.status ?? 'missing',
          dispatchStatus: message?.status ?? 'missing',
          error: message?.error ?? null,
        }
      }),
    }
  }

  /**
   * @param {{
   *   from: string,
   *   fromTitle?: string,
   *   messageId: string,
   *   text: unknown,
   *   operationId: string,
   *   references?: unknown,
   *   paths?: unknown,
   * }} request
   * @returns {Promise<Record<string, any>>}
   */
  async reply(request) {
    const object = assertPlainObject(request, 'reply request')
    assertAllowedKeys(
      object,
      ['from', 'fromTitle', 'messageId', 'text', 'operationId', 'references', 'paths'],
      'reply request',
    )
    const from = requiredString(object.from, 'from', { min: 1, max: 256 })
    const parentMessageId = requiredString(object.messageId, 'messageId', { min: 1, max: 256 })
    const operationId = requiredString(object.operationId, 'operationId', { max: 128 })
    const currentSettings = this.ledger.read().settings
    const content = normalizeContent(
      { text: object.text, references: object.references, paths: object.paths },
      currentSettings,
    )
    const parentForFingerprint = this.#message(parentMessageId)
    if (parentForFingerprint === undefined) throw fail('parent_not_found', 'reply parent not found')
    const fingerprint = callFingerprint({
      kind: 'reply',
      text: content.text,
      references: content.references,
      paths: content.paths,
      parentMessageId,
      targets: [parentForFingerprint.from],
    })
    // Idempotent retry must win before eligibility is rechecked: a target may
    // have been archived since the original call, yet the caller is entitled
    // to the original statuses and no resend.
    const existingState = this.ledger.read()
    const existingOperation = this.#lookupOperation(existingState, from, operationId)
    if (existingOperation !== undefined) {
      if (existingOperation.fingerprint !== fingerprint) {
        throw fail('conflict_operation', 'operationId was already used with different content or parent', { operationId })
      }
      return this.#operationResult(existingState, existingOperation)
    }
    await this.#requireSender(from)
    const parent = this.#message(parentMessageId)
    if (parent === undefined) throw fail('parent_not_found', 'reply parent not found')
    if (parent.kind !== 'request') throw fail('parent_not_request', 'only an explicit request can be answered')
    if (parent.to !== from) throw fail('parent_forbidden', 'only the original recipient can reply')
    if (parent.status !== 'accepted' && parent.status !== 'dispatching' && parent.status !== 'unknown') {
      throw fail('parent_not_accepted', 'parent request has not been accepted by the host')
    }
    const chain = this.ledger.read().chains[parent.chainId]
    if (chain === undefined) throw fail('chain_missing', 'parent chain is missing')
    if (chain.state === 'closed') throw fail('chain_closed', 'chain is closed')
    if (chain.state === 'paused') throw fail('chain_paused', 'chain is paused')
    const hop = parent.hop + 1
    if (hop > chain.maxHops) {
      await this.ledger.mutate((state) => {
        const current = state.chains[parent.chainId]
        if (current !== undefined) this.#pauseChainInState(state, current, 'hop_exceeded', this.clock())
      })
      throw fail('hop_exceeded', 'maximum hop count reached for this chain', { maxHops: chain.maxHops })
    }

    if (parent.status === 'dispatching' || parent.status === 'unknown') {
      const evidence = await this.adapter.readEvidence({
        targetId: parent.to,
        durableMessageId: parent.durableMessageId,
        senderSessionId: parent.from,
      })
      if (evidence?.found !== true || evidence.identityConflict === true) {
        throw fail(
          'parent_unacknowledged',
          'the parent request has no host insertion evidence; a reply cannot use it as a parent',
          { parentMessageId },
        )
      }
    }

    const targetInfo = await this.#requireTarget(parent.from)
    const fromInfo = await this.adapter.getSession(from, { fresh: true })
    const fromTitle = optionalString(object.fromTitle, 'fromTitle', { max: 500 }) ?? fromInfo?.title ?? from
    const now = this.clock()
    let created
    const result = await this.#deliveryMutation(
      (state) => {
        const duplicate = this.#lookupOperation(state, from, operationId)
        if (duplicate !== undefined) {
          if (duplicate.fingerprint !== fingerprint) {
            throw fail('conflict_operation', 'operationId was already used with different content or parent', { operationId })
          }
          return skipMutation(this.#operationResult(state, duplicate))
        }
        validateOperationId(operationId, now)
        if (!state.settings.enabled) throw fail('disabled', 'session-link is disabled; enable it in settings first')
        const blockedLatches = latchesBlocking(state, scopesFor(from, [parent.from], now))
        if (blockedLatches.length > 0) {
          throw fail('budget_latched', 'session-link budget is latched; an owner must release the latch', {
            latches: blockedLatches,
          })
        }
        const submission = recordSubmission(state, { from, now })
        if (!submission.ok) {
          throw fail('rate_limited', 'one source may submit at most once per second', {
            retryAfterMs: submission.retryAfterMs,
          })
        }

        const currentParent = findMessage(state, parentMessageId)
        if (currentParent === undefined) throw fail('parent_not_found', 'reply parent not found')
        if (currentParent.kind !== 'request') throw fail('parent_not_request', 'only an explicit request can be answered')
        if (currentParent.to !== from) throw fail('parent_forbidden', 'only the original recipient can reply')
        if (currentParent.status !== 'accepted' && currentParent.status !== 'dispatching' && currentParent.status !== 'unknown') {
          throw fail('parent_not_accepted', 'parent request is no longer acceptable as a reply parent')
        }
        const currentChain = state.chains[currentParent.chainId]
        if (currentChain === undefined) throw fail('chain_missing', 'parent chain is missing')
        if (currentChain.state === 'closed') throw fail('chain_closed', 'chain is closed')
        if (currentChain.state === 'paused') throw fail('chain_paused', 'chain is paused')
        const nextHop = currentParent.hop + 1
        if (nextHop > currentChain.maxHops) {
          this.#pauseChainInState(state, currentChain, 'hop_exceeded', now)
          throw fail('hop_exceeded', 'maximum hop count reached for this chain', { maxHops: currentChain.maxHops })
        }
        const existingCount = chainMessages(state, currentParent.chainId).length
        if (existingCount + 1 > currentChain.maxMessages) {
          this.#pauseChainInState(state, currentChain, 'chain_budget', now)
          throw fail('chain_budget', 'chain message budget would be exceeded', { maxMessages: currentChain.maxMessages })
        }
        const held = state.settings.emergencyPaused || !state.settings.autoCollaborate
        if (held) {
          this.#assertHeldCapacity(state, from, 1, content.bytes)
        }
        const message = {
          id: this.uuid(),
          operationId,
          from,
          fromTitle,
          to: currentParent.from,
          toTitle: targetInfo?.title ?? currentParent.from,
          kind: 'reply',
          chainId: currentParent.chainId,
          replyTo: currentParent.id,
          parentMessageId: currentParent.id,
          hop,
          createdAt: now,
          acceptedAt: null,
          deadlineAt: null,
          timedOutAt: null,
          late: currentParent.replyStatus === 'timed_out',
          content: structuredClone(content),
          contentBytes: content.bytes,
          status: held ? 'held' : 'pending',
          replyStatus: 'none',
          deliveryAttempts: 0,
          durableMessageId: null,
          error: held
            ? {
                code: state.settings.emergencyPaused ? 'emergency_paused' : 'auto_collaborate_off',
                message: 'held until an owner releases it',
              }
            : null,
          heldAt: held ? now : null,
        }
        state.messages.push(message)
        currentChain.messageCount = existingCount + 1
        const operationKey = this.#operationKey(from, operationId, [currentParent.from])
        state.operations[operationKey] = {
          key: operationKey,
          from,
          operationId,
          fingerprint,
          targets: [currentParent.from],
          messageIds: { [currentParent.from]: message.id },
          at: now,
        }
        created = message.id
        return {
          operationId,
          idempotent: false,
          chainId: message.chainId,
          held,
          results: [
            {
              target: message.to,
              id: message.id,
              status: message.status,
              error: message.error,
            },
          ],
        }
      },
      { delivery: true },
      parentMessageId,
    )
    if (result.idempotent === true || result.held === true) return result
    await this.#dispatchBatch([created])
    const message = this.#message(created)
    return {
      ...result,
      results: [
        {
          target: message?.to,
          id: created,
          status: message?.status ?? 'missing',
          dispatchStatus: message?.status ?? 'missing',
          error: message?.error ?? null,
        },
      ],
    }
  }

  // -------------------------------------------------------------------------
  // Identity and eligibility
  // -------------------------------------------------------------------------

  /**
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async #requireSender(sessionId) {
    const info = await this.adapter.getSession(sessionId, { fresh: true })
    if (info === undefined || info === null) throw fail('identity_unregistered', 'caller session is not registered')
    if (info.subagent === true) throw fail('identity_subagent', 'subagent sessions cannot use session-link')
    if (info.archived === true) throw fail('identity_archived', 'archived sessions cannot send')
    if (info.registered === false) throw fail('identity_unregistered', 'caller session is not a registered ordinary session')
    if (info.formatStatus === 'migration-required') throw fail('identity_migration_required', 'caller session requires migration')
    if (info.eligible === false) throw fail('identity_unavailable', 'caller session is not an eligible ordinary session')
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<Record<string, any>>}
   */
  async #requireTarget(sessionId) {
    const info = await this.adapter.getSession(sessionId, { fresh: true })
    if (info === undefined || info === null) throw fail('target_unregistered', 'target session is not registered')
    if (info.subagent === true) throw fail('target_subagent', 'target is a subagent session')
    if (info.archived === true) throw fail('target_archived', 'target session is archived; archived sessions are history-only')
    if (info.registered === false) throw fail('target_unregistered', 'target is not a registered ordinary session')
    if (info.formatStatus === 'migration-required') throw fail('target_migration_required', 'target session requires migration')
    if (info.eligible === false) throw fail('target_unavailable', 'target session is not eligible for delivery')
    return info
  }

  // -------------------------------------------------------------------------
  // Dispatch pipeline
  // -------------------------------------------------------------------------

  /** @param {string[]} ids */
  async #dispatchBatch(ids) {
    for (const id of ids) this.#starting.add(id)
    try {
      await Promise.all(ids.map((id) => this.#withSlot(() => this.#dispatchOne(id))))
    } finally {
      for (const id of ids) this.#starting.delete(id)
    }
  }

  /** @template T @param {() => Promise<T>} task @returns {Promise<T>} */
  async #withSlot(task) {
    await this.#acquireSlot()
    try {
      return await task()
    } finally {
      this.#releaseSlot()
    }
  }

  async #acquireSlot() {
    while (true) {
      const max = this.ledger.read().settings.maxConcurrent
      if (this.#slots < max) {
        this.#slots += 1
        return
      }
      await new Promise((resolve) => this.#waiters.push(resolve))
    }
  }

  #releaseSlot() {
    this.#slots -= 1
    const next = this.#waiters.shift()
    if (next !== undefined) next()
  }

  /**
   * Run one delivery-state mutation; a chain budget/hop rejection is recorded
   * as a paused chain in a second mutation because a throwing transaction is
   * rolled back by the ledger (the requested status, not just the throw, must
   * remain visible).
   * @param {(state: Record<string, any>) => any} task
   * @param {{ delivery: true }} options
   * @param {string|undefined} parentMessageId
   * @returns {Promise<any>}
   */
  async #deliveryMutation(task, options, parentMessageId) {
    try {
      return await this.ledger.mutate(task, options)
    } catch (error) {
      if ((error.code === 'hop_exceeded' || error.code === 'chain_budget') && parentMessageId !== undefined) {
        await this.#pauseChainForParent(parentMessageId, error.code)
      }
      throw error
    }
  }

  /**
   * @param {string} parentMessageId
   * @param {string} reason
   */
  async #pauseChainForParent(parentMessageId, reason) {
    await this.ledger.mutate((state) => {
      const parent = findMessage(state, parentMessageId)
      if (parent === undefined) return skipMutation(undefined)
      const chain = state.chains[parent.chainId]
      if (chain === undefined || chain.state !== 'open') return skipMutation(undefined)
      this.#pauseChainInState(state, chain, reason, this.clock())
      return true
    })
  }

  /**
   * Reserve the actual host-delivery budget immediately before building the
   * host message. A message is reserved at most once: an attempt aborted by a
   * pause keeps its conservative charge instead of double-counting on retry.
   * Held/pending messages crossing a window are charged in the window in which
   * their host dispatch is actually attempted.
   * @param {string} id
   * @returns {Promise<{ ok: boolean, code?: string }>}s
   */
  /**
   * @param {Record<string, any>} message
   * @param {number} now
   * @returns {boolean}
   */
  #hasFreshReservation(message, now) {
    return (
      Number.isSafeInteger(message.budgetReservedAt) &&
      message.budgetReservedAt > now - LIMITS.WINDOW_MS &&
      message.budgetReservedDay === dayKey(now)
    )
  }

  /**
   * Re-reserve at the pre-followup gate when a slow resolve crossed the
   * rolling window or local day. The reservation is persisted before the final
   * synchronous gate and the host followup.
   * @param {string} id
   * @returns {Promise<{ ok: true } | { ok: false, action: string, code?: string, message?: string }>}
   */
  async #reserveForFollowup(id) {
    const result = await this.ledger.mutate((state) => {
      const message = findMessage(state, id)
      if (message?.status !== 'dispatching') {
        return skipMutation({ ok: false, action: 'cancelled', code: 'not_dispatching', message: 'message left dispatching state' })
      }
      const now = this.clock()
      if (this.#hasFreshReservation(message, now)) return skipMutation({ ok: true })
      const reserved = reserveBudget(state, {
        from: message.from,
        targets: [message.to],
        now,
        rateLimit: false,
      })
      if (!reserved.ok) {
        const chain = state.chains[message.chainId]
        if (chain !== undefined && reserved.code === 'budget_latched') {
          this.#pauseChainInState(state, chain, 'budget_latched', now)
        }
        message.error = {
          code: reserved.code,
          message:
            reserved.code === 'budget_latched'
              ? 'budget latch set; an owner must release it before this message can be delivered'
              : 'delivery budget rejected this attempt',
        }
        return { ok: false, action: 'pending', code: reserved.code, message: 'delivery budget rejected before followup' }
      }
      message.budgetReservedAt = now
      message.budgetReservedDay = dayKey(now)
      message.error = null
      return { ok: true }
    })
    return result
  }

  async #reserveForMessage(id) {
    return this.ledger.mutate((state) => {
      const message = findMessage(state, id)
      if (message?.status !== 'pending') return skipMutation({ ok: false, code: 'not_pending' })
      const now = this.clock()
      if (this.#hasFreshReservation(message, now)) return skipMutation({ ok: true, already: true })
      const reserved = reserveBudget(state, {
        from: message.from,
        targets: [message.to],
        now,
        rateLimit: false,
      })
      if (!reserved.ok) {
        const chain = state.chains[message.chainId]
        if (chain !== undefined && reserved.code === 'budget_latched') {
          this.#pauseChainInState(state, chain, 'budget_latched', now)
        }
        message.error = {
          code: reserved.code,
          message:
            reserved.code === 'budget_latched'
              ? 'budget latch set; an owner must release it before this message can be delivered'
              : 'delivery budget rejected this attempt',
        }
        return { ok: false, code: reserved.code }
      }
      message.budgetReservedAt = now
      message.budgetReservedDay = dayKey(now)
      message.error = null
      return { ok: true }
    })
  }

  /** @param {string} id */
  async #dispatchOne(id) {
    if (this.#disposed) return
    const message = this.#message(id)
    if (message === undefined || message.status !== 'pending') return
    const chain = this.ledger.read().chains[message.chainId]
    if (chain === undefined) {
      await this.#mutateIfDispatching(id, (state, current) => {
        current.status = 'failed'
        current.error = { code: 'chain_missing', message: 'chain is missing' }
      })
      return
    }
    if (chain.state === 'closed') {
      await this.#mutateIfPending(id, (state, current) => {
        current.status = 'cancelled'
        current.cancelledAt = this.clock()
        current.error = { code: 'chain_closed', message: 'chain closed before delivery' }
      })
      return
    }
    const preflight = dispatchBlockers(this.ledger.read(), message, this.clock())
    if (preflight.includes('chain_paused') || preflight.includes('budget_latched') || preflight.includes('chain_missing')) {
      return
    }
    if (
      preflight.includes('disabled') ||
      preflight.includes('emergency_paused') ||
      preflight.includes('auto_collaborate_off')
    ) {
      const code =
        preflight.includes('disabled')
          ? 'disabled'
          : preflight.includes('emergency_paused')
            ? 'emergency_paused'
            : 'auto_collaborate_off'
      await this.#heldIfPending(id, code)
      return
    }

    const reservation = await this.#reserveForMessage(id)
    if (reservation.ok !== true) return

    let built
    try {
      built = await this.adapter.buildDelivery(this.#publicMessage(message))
    } catch (error) {
      await this.#markFailed(id, 'message_build_failed', 'host message could not be constructed')
      return
    }
    const durableMessageId = built?.durableMessageId
    if (typeof durableMessageId !== 'string' || durableMessageId.length === 0) {
      await this.#markFailed(id, 'message_build_failed', 'host message id is missing')
      return
    }

    const marked = await this.ledger.mutate((state) => {
      const current = findMessage(state, id)
      if (current?.status !== 'pending') return skipMutation(false)
      current.status = 'dispatching'
      current.durableMessageId = durableMessageId
      current.dispatchStartedAt = this.clock()
      delete current.heldOverflow
      current.deliveryAttempts = (current.deliveryAttempts ?? 0) + 1
      current.error = null
      return true
    })
    if (marked !== true) return

    let outcome
    try {
      outcome = await this.adapter.deliver({
        targetId: message.to,
        hostMessage: built.hostMessage,
        beforeResolve: () => this.#gateLive(id, false),
        beforeFollowup: () => this.#gateLive(id, true),
      })
    } catch (error) {
      outcome = { stage: 'followup', error: { code: errorCode(error) } }
    }
    const classified = classifyDeliveryOutcome(outcome)
    if (classified.status === 'accepted') {
      await this.#acceptMessageById(id, this.clock(), { recoveryEvidence: undefined })
      return
    }
    if (classified.status === 'failed') {
      await this.#markFailed(id, classified.code, classified.message)
      return
    }
    if (classified.status === 'unknown') {
      await this.#markUnknown(id, classified.code, classified.message)
      return
    }
    await this.#applyBlocked(id, classified, outcome.blocked)
  }

  /**
   * Recheck the serialized pause/eligibility gate immediately before resolve
   * and again immediately before followup. Any async resolve is followed by a
   * fresh check, so a pause cannot slip into a new wakeup.
   * @param {string} id
   * @param {boolean} beforeFollowup
   * @returns {Promise<{ ok: true } | { ok: false, action: string, code?: string, message?: string }>}
   */
  async #gateLive(id, beforeFollowup) {
    const state = this.ledger.read()
    const message = findMessage(state, id)
    const initial = this.#checkLiveState(message)
    if (initial.ok !== true) return initial
    const info = await this.adapter.getSession(message.to, { fresh: true })
    if (info === undefined || info === null || info.eligible === false) {
      return {
        ok: false,
        action: 'failed',
        code: info?.archived === true ? 'target_archived' : info?.subagent === true ? 'target_subagent' : 'target_unavailable',
        message: 'target is no longer eligible before host insertion',
      }
    }
    if (beforeFollowup === true) {
      const reservation = await this.#reserveForFollowup(id)
      if (reservation.ok !== true) return reservation
    }
    // Re-read the durable gate synchronously after the async eligibility read
    // and any reservation refresh. A pause acknowledged while those reads were
    // in flight must prevent the followup that would otherwise use the old
    // snapshot.
    const latest = this.ledger.read()
    const checked = this.#checkLiveState(findMessage(latest, id))
    if (checked.ok === true && beforeFollowup === true) {
      checked.commit = (run) => this.#commitFollowup(id, run)
    }
    return checked
  }

  /**
   * Final synchronous check immediately around the host followup. The caller
   * invokes `run()` inside this same call stack, so a pause that committed
   * while an earlier async eligibility read was in flight cannot slip between
   * the final state check and the host insertion.
   * @param {string} id
   * @param {() => void} run
   * @returns {{ ok: true } | { ok: false, blocked: Record<string, any> }}
   */
  #commitFollowup(id, run) {
    const state = this.ledger.read()
    const checked = this.#checkLiveState(findMessage(state, id))
    if (checked.ok !== true) return { ok: false, blocked: checked }
    run()
    return { ok: true }
  }

  /**
   * Synchronous gate over the current durable state. Kept separate so both the
   * pre-resolve and pre-followup paths perform the same final check with no
   * asynchronous operation between that check and the host followup.
   * @param {Record<string, any> | undefined} message
   * @returns {{ ok: true } | { ok: false, action: string, code?: string, message?: string }}
   */
  #checkLiveState(message) {
    if (message === undefined) {
      return { ok: false, action: 'cancelled', code: 'message_missing', message: 'message disappeared' }
    }
    if (message.status !== 'dispatching') {
      return { ok: false, action: 'cancelled', code: 'not_dispatching', message: 'message left dispatching state' }
    }
    const state = this.ledger.read()
    const chain = state.chains[message.chainId]
    if (chain === undefined) {
      return { ok: false, action: 'failed', code: 'chain_missing', message: 'chain is missing' }
    }
    // Close cannot withdraw an already-dispatching attempt; it is reconciled as
    // accepted/unknown exactly as if the close had happened after insertion.
    if (chain.state === 'paused') {
      return { ok: false, action: 'pending', code: 'chain_paused', message: 'chain paused before host insertion' }
    }
    const settings = state.settings
    if (!settings.enabled) {
      return { ok: false, action: 'held', code: 'disabled', message: 'session-link disabled before host insertion' }
    }
    if (settings.emergencyPaused) {
      return {
        ok: false,
        action: 'held',
        code: 'emergency_paused',
        message: 'emergency pause set before host insertion',
      }
    }
    if (!settings.autoCollaborate && message.releaseAuthorized !== true) {
      return {
        ok: false,
        action: 'held',
        code: 'auto_collaborate_off',
        message: 'automatic collaboration disabled before host insertion',
      }
    }
    const latches = latchesBlocking(state, scopesFor(message.from, [message.to], this.clock()))
    if (latches.length > 0) {
      return {
        ok: false,
        action: 'pending',
        code: 'budget_latched',
        message: 'budget latch set before host insertion',
      }
    }
    return { ok: true }
  }

  /**
   * @param {string} id
   * @param {{ status: string, code?: string, message?: string }} classified
   * @param {any} blocked
   */
  async #applyBlocked(id, classified, blocked) {
    await this.ledger.mutate((state) => {
      const current = findMessage(state, id)
      if (current?.status !== 'dispatching') return skipMutation(undefined)
      let status = classified.status
      if (status === 'held') {
        const usage = new Map()
        for (const candidate of state.messages) {
          if (candidate.status !== 'held' || candidate.id === current.id) continue
          this.#addHeldUsage(usage, candidate)
        }
        const source = this.#heldUsage(usage, current.from)
        const bytes = Number.isSafeInteger(current.contentBytes) ? current.contentBytes : 0
        if (
          source.count + 1 > LIMITS.HELD_PER_SOURCE ||
          source.bytes + bytes > LIMITS.HELD_TOTAL_BYTES
        ) {
          status = 'pending'
          current.heldOverflow = true
          current.error = { code: 'held_full', message: 'held capacity is full; kept pending instead' }
        }
      }
      current.status = status
      if (current.error === undefined || status !== 'pending') {
        current.error = { code: classified.code ?? 'blocked', message: classified.message ?? 'blocked' }
      }
      current.releaseAuthorized = false
      if (status === 'held') {
        current.heldAt = this.clock()
        current.heldReason = classified.code ?? 'blocked'
      }
      if (classified.status === 'cancelled') current.cancelledAt = this.clock()
      // No host insertion happened, so the host message id cannot be recovery
      // evidence for a later attempt.
      current.durableMessageId = null
      return true
    })
  }

  /**
   * @param {string} id
   * @param {object} [extras]
   */
  async #acceptMessageById(id, now, extras = {}) {
    await this.ledger.mutate((state) => {
      const message = findMessage(state, id)
      if (message === undefined) return skipMutation(undefined)
      if (message.status === 'accepted') {
        this.#applyAcceptedEffects(state, message, now)
        return true
      }
      if (message.status !== 'dispatching' && message.status !== 'unknown') return skipMutation(undefined)
      this.#acceptMessage(state, message, now, extras)
      return true
    })
  }

  /**
   * @param {Record<string, any>} state
   * @param {Record<string, any>} message
   * @param {number} now
   * @param {{ recoveryEvidence?: string, inboxSeen?: boolean }} [extras]
   */
  #acceptMessage(state, message, now, extras = {}) {
    message.status = 'accepted'
    message.acceptedAt = Number.isSafeInteger(message.acceptedAt) ? message.acceptedAt : now
    message.dispatchStatus = 'accepted'
    message.error = null
    if (extras.recoveryEvidence !== undefined) message.recoveryEvidence = extras.recoveryEvidence
    if (extras.inboxSeen === true) message.inboxSeen = true
    this.#applyAcceptedEffects(state, message, now)
  }

  /**
   * @param {Record<string, any>} state
   * @param {Record<string, any>} message
   * @param {number} now
   */
  #applyAcceptedEffects(state, message, now) {
    if (message.kind === 'request') {
      if (message.replyStatus === undefined || message.replyStatus === 'none') {
        message.replyStatus = 'waiting'
        message.deadlineAt = message.acceptedAt + state.settings.requestTimeoutMs
      }
      return
    }
    if (message.kind !== 'reply' || typeof message.parentMessageId !== 'string') return
    const parent = findMessage(state, message.parentMessageId)
    if (parent === undefined || parent.kind !== 'request') return
    if (parent.status === 'dispatching' || parent.status === 'unknown') {
      parent.status = 'accepted'
      parent.acceptedAt = parent.acceptedAt ?? message.acceptedAt ?? now
      parent.dispatchStatus = 'accepted'
      parent.recoveryEvidence = parent.recoveryEvidence ?? 'reply'
      parent.error = null
      parent.deadlineAt = parent.deadlineAt ?? parent.acceptedAt + state.settings.requestTimeoutMs
    }
    if (parent.replyStatus !== 'answered') {
      parent.replyStatus = 'answered'
      parent.answeredAt = message.acceptedAt ?? now
      parent.answeredBy = message.id
    }
    if (parent.timedOutAt !== null && parent.timedOutAt !== undefined) {
      message.late = true
      parent.lateReplyAt = message.acceptedAt ?? now
    }
  }

  /**
   * @param {string} id
   * @param {string} code
   * @param {string} message
   */
  async #markFailed(id, code, message) {
    await this.ledger.mutate((state) => {
      const current = findMessage(state, id)
      if (current === undefined) return skipMutation(undefined)
      if (current.status === 'accepted') return skipMutation(undefined)
      if (current.status !== 'dispatching' && current.status !== 'pending' && current.status !== 'held') return skipMutation(undefined)
      current.status = 'failed'
      current.error = { code, message }
      current.failedAt = this.clock()
      return true
    })
  }

  /**
   * @param {string} id
   * @param {string} code
   * @param {string} message
   */
  async #markUnknown(id, code, message) {
    await this.ledger.mutate((state) => {
      const current = findMessage(state, id)
      if (current === undefined) return skipMutation(undefined)
      // An accepted delivery is never regressed by a late flush result: a
      // reply already proved the insertion happened.
      if (current.status === 'accepted') return skipMutation(undefined)
      if (current.status !== 'dispatching') return skipMutation(undefined)
      this.#markUnknownInState(state, current, this.clock(), { code, message })
      return true
    })
  }

  /**
   * @param {Record<string, any>} state
   * @param {Record<string, any>} message
   * @param {number} now
   * @param {{ code: string, message: string }} error
   */
  #markUnknownInState(state, message, now, error) {
    message.status = 'unknown'
    message.unknownAt = now
    message.error = { code: error.code, message: error.message }
    // The durable message id and attempt counter remain: the panel must show
    // that an insertion may have happened and that it is never auto-retried.
  }

  /**
   * @param {string} id
   * @param {(state: Record<string, any>, message: Record<string, any>) => void} mutate
   */
  /**
   * @param {string} id
   * @param {string} code
   */
  async #heldIfPending(id, code) {
    await this.#mutateIfPending(id, (state, message) => {
      const usage = new Map()
      for (const candidate of state.messages) {
        if (candidate.status !== 'held' || candidate.id === message.id) continue
        this.#addHeldUsage(usage, candidate)
      }
      const source = this.#heldUsage(usage, message.from)
      const bytes = Number.isSafeInteger(message.contentBytes) ? message.contentBytes : 0
      if (
        source.count + 1 > LIMITS.HELD_PER_SOURCE ||
        source.bytes + bytes > LIMITS.HELD_TOTAL_BYTES
      ) {
        message.heldOverflow = true
        message.error = { code: 'held_full', message: 'held capacity is full; kept pending instead' }
        return
      }
      message.status = 'held'
      message.heldAt = this.clock()
      message.heldReason = code
      message.error = { code, message: 'held until an owner releases it' }
      message.releaseAuthorized = false
    })
  }

  async #mutateIfPending(id, mutate) {
    await this.ledger.mutate((state) => {
      const message = findMessage(state, id)
      if (message?.status !== 'pending') return skipMutation(undefined)
      mutate(state, message)
      return true
    })
  }

  async #mutateIfDispatching(id, mutate) {
    await this.ledger.mutate((state) => {
      const message = findMessage(state, id)
      if (message?.status !== 'dispatching') return skipMutation(undefined)
      mutate(state, message)
      return true
    })
  }

  // -------------------------------------------------------------------------
  // Automatic pump
  // -------------------------------------------------------------------------

  #schedulePump() {
    if (this.#disposed || this.#pumpScheduled) return
    this.#pumpScheduled = true
    queueMicrotask(() => {
      this.#pumpScheduled = false
      void this.#pump().catch(() => undefined)
    })
  }

  async #pump() {
    if (this.#disposed) return
    const current = this.ledger.read()
    const settings = current.settings
    if (!settings.enabled || settings.emergencyPaused) return
    if (!settings.autoCollaborate) {
      // Auto collaboration stays off for normal work, but an already explicit
      // owner release may finish its one authorized dispatch.
      const hasRelease = current.messages.some(
        (message) => message.status === 'pending' && message.releaseAuthorized === true,
      )
      if (!hasRelease) return
    }
    while (this.#slots < settings.maxConcurrent) {
      const id = this.#nextPendingId()
      if (id === undefined) return
      this.#slots += 1
      this.#starting.add(id)
      const task = this.#dispatchOne(id)
        .catch((error) => {
          this.logger.warn(`dispatch failed: ${errorCode(error)}`)
        })
        .finally(() => {
          this.#starting.delete(id)
          this.#slots -= 1
          const next = this.#waiters.shift()
          if (next !== undefined) next()
          this.#schedulePump()
        })
      this.#inflight.add(task)
      task.finally(() => this.#inflight.delete(task)).catch(() => undefined)
    }
  }

  /** @returns {string | undefined} */
  #nextPendingId() {
    const state = this.ledger.read()
    const now = this.clock()
    for (const message of state.messages) {
      if (message.status !== 'pending') continue
      if (this.#starting.has(message.id)) continue
      const chain = state.chains[message.chainId]
      if (chain?.state !== 'open') continue
      if (dispatchBlockers(state, message, now).length > 0) continue
      return message.id
    }
    return undefined
  }

  /** Wait for currently scheduled attempts to settle. */
  async drain() {
    await new Promise((resolve) => setImmediate(resolve))
    while (true) {
      const tasks = [...this.#inflight]
      if (tasks.length === 0 && this.#slots === 0) return
      await Promise.allSettled(tasks)
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  // -------------------------------------------------------------------------
  // Owner control + settings
  // -------------------------------------------------------------------------

  /**
   * @param {{ expectedRevision: number, patch: unknown, by?: string }} request
   * @returns {Promise<Record<string, any>>}
   */
  async updateSettings(request) {
    const object = assertPlainObject(request, 'settings request')
    assertAllowedKeys(object, ['expectedRevision', 'patch', 'by'], 'settings request')
    const expectedRevision = boundedInteger(object.expectedRevision, 'expectedRevision', { min: 1 })
    const now = this.clock()
    const result = await this.ledger.mutate(
      (state) => {
        const next = applySettingsPatch(state.settings, object.patch)
        const unchanged = JSON.stringify(next) === JSON.stringify(state.settings)
        if (unchanged) {
          return skipMutation({ revision: state.revision, settings: structuredClone(state.settings), held: 0 })
        }
        state.settings = next
        let held = 0
        let overflow = 0
        if (!next.enabled || next.emergencyPaused || !next.autoCollaborate) {
          const usage = new Map()
          for (const message of state.messages) {
            if (message.status !== 'held') continue
            this.#addHeldUsage(usage, message)
          }
          for (const message of state.messages) {
            if (message.status !== 'pending') continue
            const source = this.#heldUsage(usage, message.from)
            const bytes = Number.isSafeInteger(message.contentBytes) ? message.contentBytes : 0
            if (
              source.count + 1 > LIMITS.HELD_PER_SOURCE ||
              source.bytes + bytes > LIMITS.HELD_TOTAL_BYTES
            ) {
              overflow += 1
              message.heldOverflow = true
              message.error = { code: 'held_full', message: 'held capacity is full; kept pending instead' }
              continue
            }
            message.status = 'held'
            message.heldAt = now
            message.heldReason = !next.enabled
              ? 'disabled'
              : next.emergencyPaused
                ? 'emergency_paused'
                : 'auto_collaborate_off'
            message.error = { code: message.heldReason, message: 'held until an owner releases it' }
            message.releaseAuthorized = false
            delete message.heldOverflow
            source.count += 1
            source.bytes += bytes
            held += 1
          }
        }
        return { revision: state.revision + 1, settings: structuredClone(next), held, overflow }
      },
      { expectedRevision },
    )
    this.#schedulePump()
    return result
  }

  /**
   * Authenticated owner control. Every mutation is CAS-guarded and fails
   * explicitly instead of silently overwriting another tab's change.
   * @param {Record<string, unknown>} request
   * @returns {Promise<Record<string, any>>}
   */
  async ownerControl(request) {
    const object = assertPlainObject(request, 'control request')
    const action = requiredString(object.action, 'action', { max: 64 })
    if (!CONTROL_ACTIONS.includes(action)) throw fail('invalid_argument', `unknown control action ${action}`)
    assertAllowedKeys(
      object,
      ['expectedRevision', 'action', 'id', 'latchId', 'resolution', 'by'],
      'control request',
    )
    const expectedRevision = boundedInteger(object.expectedRevision, 'expectedRevision', { min: 1 })
    const now = this.clock()
    const by = optionalString(object.by, 'by', { max: 256 }) ?? 'owner'

    if (action === 'resume_budget') {
      const latchId = requiredString(object.latchId, 'latchId', { min: 1, max: 512 })
      const result = await this.ledger.mutate(
        (state) => {
          const released = releaseLatch(state, { latchId, now, by })
          return { revision: state.revision + 1, released: released.latch }
        },
        { expectedRevision },
      )
      this.#schedulePump()
      return result
    }

    const id = requiredString(object.id, 'id', { min: 1, max: 512 })
    if (action === 'recheck') {
      return this.recheck(id, { revision: expectedRevision, by })
    }
    const result = await this.ledger.mutate(
      (state) => {
        if (action === 'settings') throw fail('internal', 'settings use the settings action')
        if (action === 'pause') {
          const chain = this.#chainById(state, id)
          if (chain.state === 'closed') throw fail('chain_closed', 'chain is closed')
          if (chain.state === 'paused') throw fail('conflict', 'chain is already paused')
          chain.state = 'paused'
          chain.pausedAt = now
          chain.pausedReason = 'owner'
          return { revision: state.revision + 1, chain: this.#chainView(state, chain) }
        }
        if (action === 'resume') {
          const chain = this.#chainById(state, id)
          if (chain.state === 'closed') throw fail('chain_closed', 'chain is closed')
          if (chain.state === 'open') throw fail('conflict', 'chain is already open')
          chain.state = 'open'
          delete chain.pausedAt
          delete chain.pausedReason
          return { revision: state.revision + 1, chain: this.#chainView(state, chain) }
        }
        if (action === 'close') {
          const chain = this.#chainById(state, id)
          if (chain.state === 'closed') throw fail('conflict', 'chain is already closed')
          this.#closeChainInState(state, chain, now, 'owner')
          return { revision: state.revision + 1, chain: this.#chainView(state, chain) }
        }
        if (action === 'cancel') {
          const message = findMessage(state, id)
          if (message !== undefined) {
            if (!this.#cancelMessageInState(state, message, now, 'owner')) {
              throw fail('conflict', 'only a pending or held message can be cancelled')
            }
            return { revision: state.revision + 1, message: this.#messageView(state, message) }
          }
          const chain = this.#chainById(state, id)
          let cancelled = 0
          for (const message of chainMessages(state, chain.id)) {
            if (this.#cancelMessageInState(state, message, now, 'owner')) cancelled += 1
          }
          if (cancelled === 0) throw fail('conflict', 'chain has no pending or held messages')
          return { revision: state.revision + 1, cancelled }
        }
        if (action === 'release') {
          const message = findMessage(state, id)
          if (message !== undefined) {
            this.#releaseOne(state, message, now)
            return { revision: state.revision + 1, released: 1 }
          }
          const chain = this.#chainById(state, id)
          let released = 0
          for (const message of chainMessages(state, chain.id)) {
            if (message.status !== 'held') continue
            this.#releaseOne(state, message, now)
            released += 1
          }
          if (released === 0) throw fail('conflict', 'chain has no held messages')
          return { revision: state.revision + 1, released }
        }
        if (action === 'resolve_unknown') {
          const message = findMessage(state, id)
          if (message === undefined) throw fail('not_found', 'message not found')
          if (message.status !== 'unknown') throw fail('conflict', 'only an unknown record can be resolved manually')
          const resolution = requiredString(object.resolution, 'resolution', { max: 32 })
          if (resolution === 'accepted') {
            message.manualConfirmedAt = now
            message.manualConfirmedBy = by
            this.#acceptMessage(state, message, now, { recoveryEvidence: 'manual' })
            return { revision: state.revision + 1, message: this.#messageView(state, message) }
          }
          if (resolution === 'closed') {
            message.status = 'cancelled'
            message.cancelledAt = now
            message.resolution = 'unconfirmed'
            message.unconfirmedAt = now
            message.unconfirmedBy = by
            message.error = { code: 'owner_closed_unconfirmed', message: 'owner closed this record without confirming receipt' }
            return { revision: state.revision + 1, message: this.#messageView(state, message) }
          }
          throw fail('invalid_argument', "resolution must be 'accepted' or 'closed'")
        }
        throw fail('invalid_argument', `unknown control action ${action}`)
      },
      { expectedRevision },
    )

    if (action === 'release') {
      const message = findMessage(this.ledger.read(), id)
      if (message !== undefined && message.status === 'pending') {
        await this.#dispatchBatch([message.id])
      } else {
        const chain = this.ledger.read().chains[id]
        if (chain !== undefined) {
          const ids = chainMessages(this.ledger.read(), id)
            .filter((message) => message.status === 'pending' && message.releasedAt !== undefined)
            .map((message) => message.id)
          if (ids.length > 0) await this.#dispatchBatch(ids)
        }
      }
    } else {
      this.#schedulePump()
    }
    return result
  }

  /**
   * Read-only evidence recheck for an unknown/dispatching record.
   * @param {string} id
   * @param {{ revision?: number, by?: string }} [options]
   * @returns {Promise<Record<string, any>>}
   */
  async recheck(id, options = {}) {
    const before = this.#message(id)
    if (before === undefined) throw fail('not_found', 'message not found')
    if (before.status !== 'unknown' && before.status !== 'dispatching') {
      throw fail('conflict', 'only an unknown or dispatching record can be rechecked')
    }
    let evidence
    try {
      evidence = await this.adapter.readEvidence({
        targetId: before.to,
        durableMessageId: before.durableMessageId,
        senderSessionId: before.from,
      })
    } catch (error) {
      evidence = { found: false, readable: false, errorCode: errorCode(error) }
    }
    const result = await this.ledger.mutate(
      (state) => {
        const message = findMessage(state, id)
        if (message === undefined) throw fail('not_found', 'message not found')
        if (message.status !== 'unknown' && message.status !== 'dispatching') {
          throw fail('conflict', 'message is no longer unknown or dispatching')
        }
        if (evidence?.found === true && evidence.identityConflict !== true) {
          this.#acceptMessage(state, message, this.clock(), {
            recoveryEvidence: evidence.evidence ?? 'manual_recheck',
            inboxSeen: evidence.inboxSeen === true,
          })
          return { revision: state.revision + 1, status: 'accepted', evidence: evidence.evidence ?? 'host' }
        }
        this.#markUnknownInState(state, message, this.clock(), {
          code:
            evidence?.identityConflict === true
              ? 'identity_conflict'
              : evidence?.readable === false
                ? 'evidence_unreadable'
                : 'no_insertion_evidence',
          message: 'recheck found no valid insertion evidence; the record remains unknown',
        })
        return { revision: state.revision + 1, status: 'unknown', evidence: 'none' }
      },
      options.revision === undefined ? {} : { expectedRevision: options.revision },
    )
    return result
  }

  /**
   * Model-facing control surface: pause/close only a chain the caller opened,
   * and cancel only the caller's own pending/held records. No global switches,
   * no budget release, no unknown resolution, no resume.
   * @param {{ from: string, action: string, id: string }} request
   * @returns {Promise<Record<string, any>>}
   */
  async modelControl(request) {
    const object = assertPlainObject(request, 'model control request')
    assertAllowedKeys(object, ['from', 'action', 'id'], 'model control request')
    const from = requiredString(object.from, 'from', { min: 1, max: 256 })
    const action = requiredString(object.action, 'action', { max: 32 })
    const id = requiredString(object.id, 'id', { min: 1, max: 512 })
    const now = this.clock()
    return this.ledger.mutate((state) => {
      if (action === 'cancel') {
        const message = findMessage(state, id)
        if (message !== undefined) {
          if (message.from !== from) throw fail('forbidden', 'a model may cancel only its own pending messages')
          if (!this.#cancelMessageInState(state, message, now, 'model')) {
            throw fail('conflict', 'only a pending or held message can be cancelled')
          }
          return { revision: state.revision + 1, message: this.#messageView(state, message) }
        }
        const chain = this.#chainById(state, id)
        if (chain.rootOwner !== from) throw fail('forbidden', 'only the root owner may cancel a chain')
        let cancelled = 0
        for (const message of chainMessages(state, chain.id)) {
          // A model may cancel only its own messages; other participants own
          // their own pending/held records.
          if (message.from !== from) continue
          if (this.#cancelMessageInState(state, message, now, 'model')) cancelled += 1
        }
        if (cancelled === 0) throw fail('conflict', 'chain has no pending or held messages owned by the caller')
        return { revision: state.revision + 1, cancelled }
      }
      if (action === 'pause' || action === 'close') {
        const chain = this.#chainById(state, id)
        if (chain.rootOwner !== from) throw fail('forbidden', 'only the root owner may pause or close this chain')
        if (action === 'pause') {
          if (chain.state === 'closed') throw fail('chain_closed', 'chain is closed')
          if (chain.state === 'paused') throw fail('conflict', 'chain is already paused')
          chain.state = 'paused'
          chain.pausedAt = now
          chain.pausedReason = 'root_owner'
          return { revision: state.revision + 1, chain: this.#chainView(state, chain) }
        }
        if (chain.state === 'closed') throw fail('conflict', 'chain is already closed')
        this.#closeChainInState(state, chain, now, 'root_owner')
        return { revision: state.revision + 1, chain: this.#chainView(state, chain) }
      }
      throw fail('invalid_argument', 'model control accepts cancel, pause, or close')
    })
  }

  // -------------------------------------------------------------------------
  // Discovery, history, status, snapshot
  // -------------------------------------------------------------------------

  /**
   * @param {Record<string, unknown>} [request]
   * @returns {Promise<Record<string, any>>}
   */
  async list(request = {}) {
    const object = assertPlainObject(request, 'list request')
    assertAllowedKeys(object, ['workspace', 'title', 'query', 'cursor', 'limit'], 'list request')
    const limit = boundedInteger(object.limit ?? 20, 'limit', { min: 1, max: LIMITS.MAX_PAGE })
    const offset = decodeCursor(object.cursor)
    const sessions = (await this.adapter.listSessions({ fresh: true }))
      .filter((session) => session.archived !== true && session.subagent !== true && session.eligible === true)
      .filter((session) => matchesSessionFilter(session, object))
      .sort((a, b) => (a.title ?? a.id).localeCompare(b.title ?? b.id))
    const page = sessions.slice(offset, offset + limit)
    return {
      sessions: page.map((session) => publicSession(session)),
      total: sessions.length,
      nextCursor: offset + limit < sessions.length ? encodeCursor(offset + limit) : null,
    }
  }

  /**
   * History is read-only and bounded. Archived sessions are explicitly
   * eligible here, while subagents remain outside the ordinary-session scope.
   * @param {Record<string, unknown>} request
   * @returns {Promise<Record<string, any>>}
   */
  async history(request) {
    const object = assertPlainObject(request, 'history request')
    assertAllowedKeys(object, ['sessionId', 'mode', 'query', 'limit', 'beforeSeq'], 'history request')
    const sessionId = requiredString(object.sessionId, 'sessionId', { min: 1, max: 256 })
    const mode = object.mode === undefined ? 'recent' : requiredString(object.mode, 'mode', { max: 16 })
    if (mode !== 'recent' && mode !== 'search') throw fail('invalid_argument', "mode must be 'recent' or 'search'")
    const limit = boundedInteger(object.limit ?? 10, 'limit', { min: 1, max: LIMITS.HISTORY_MAX_MESSAGES })
    const beforeSeq =
      object.beforeSeq === undefined ? undefined : boundedInteger(object.beforeSeq, 'beforeSeq', { min: 0 })
    const query = mode === 'search' ? requiredString(object.query, 'query', { min: 1, max: 500 }) : undefined
    const info = await this.adapter.getSession(sessionId, { fresh: true })
    if (info === undefined || info === null) throw fail('target_unregistered', 'session is not registered')
    if (info.subagent === true) throw fail('target_subagent', 'subagent sessions have no session-link history')
    if (info.registered === false) throw fail('target_unregistered', 'session is not registered')
    return this.adapter.history({ sessionId, mode, query, limit, beforeSeq })
  }

  /**
   * @param {{ from: string, messageId?: string, chainId?: string }} request
   * @returns {Promise<Record<string, any>>}
   */
  async status(request) {
    const object = assertPlainObject(request, 'status request')
    assertAllowedKeys(object, ['from', 'messageId', 'chainId'], 'status request')
    const from = requiredString(object.from, 'from', { min: 1, max: 256 })
    const messageId = optionalString(object.messageId, 'messageId', { max: 256 })
    const chainId = optionalString(object.chainId, 'chainId', { max: 256 })
    const state = this.ledger.read()
    let related = state.messages.filter((message) => message.from === from || message.to === from)
    if (messageId !== undefined) related = related.filter((message) => message.id === messageId)
    if (chainId !== undefined) related = related.filter((message) => message.chainId === chainId)
    related.sort((a, b) => b.createdAt - a.createdAt)
    const limited = related.slice(0, LIMITS.MAX_PAGE)
    const chains = []
    const seen = new Set()
    for (const message of limited) {
      if (seen.has(message.chainId)) continue
      seen.add(message.chainId)
      const chain = state.chains[message.chainId]
      if (chain !== undefined) chains.push(this.#chainView(state, chain))
    }
    const replies = {}
    for (const message of limited) {
      const children = state.messages.filter((candidate) => candidate.parentMessageId === message.id)
      if (children.length > 0) {
        replies[message.id] = children.slice(0, 20).map((child) => ({
          id: child.id,
          from: child.from,
          to: child.to,
          status: child.status,
          createdAt: child.createdAt,
          late: child.late === true,
        }))
      }
    }
    return {
      messages: limited.map((message) => this.#messageView(state, message, from)),
      chains,
      replies,
      total: related.length,
      budgetLatches: activeLatches(state).map((latch) => structuredClone(latch)),
    }
  }

  /**
   * @param {Record<string, unknown>} [request]
   * @returns {Promise<Record<string, any>>}
   */
  async snapshot(request = {}) {
    const object = assertPlainObject(request, 'snapshot request')
    assertAllowedKeys(object, ['limit', 'offset', 'filter', 'sessionId', 'chainId'], 'snapshot request')
    const limit = boundedInteger(object.limit ?? LIMITS.MAX_PAGE, 'limit', { min: 1, max: LIMITS.MAX_SNAPSHOT_PAGE })
    const offset = boundedInteger(object.offset ?? 0, 'offset', { min: 0 })
    const filter = object.filter === undefined ? 'all' : requiredString(object.filter, 'filter', { max: 32 })
    if (!SNAPSHOT_FILTERS.includes(filter)) throw fail('invalid_argument', `unknown snapshot filter ${filter}`)
    const sessionId = optionalString(object.sessionId, 'sessionId', { max: 256 })
    const chainId = optionalString(object.chainId, 'chainId', { max: 256 })
    if ((filter === 'received' || filter === 'sent') && sessionId === undefined) {
      throw fail('invalid_argument', `${filter} filter requires sessionId`)
    }
    if (filter === 'chain' && chainId === undefined) {
      throw fail('invalid_argument', 'chain filter requires chainId')
    }

    const state = this.ledger.read()
    let messages = state.messages
    if (sessionId !== undefined) {
      messages = messages.filter((message) => message.from === sessionId || message.to === sessionId)
    }
    if (chainId !== undefined) messages = messages.filter((message) => message.chainId === chainId)
    messages = messages.filter((message) => {
      if (filter === 'all' || filter === 'chain') return true
      if (filter === 'received') return message.to === sessionId
      if (filter === 'sent') return message.from === sessionId
      if (filter === 'pending_reply') {
        return message.kind === 'request' && message.status === 'accepted' && message.replyStatus === 'waiting'
      }
      if (filter === 'abnormal') {
        return (
          message.status === 'failed' ||
          message.status === 'unknown' ||
          (message.kind === 'request' && message.replyStatus === 'timed_out')
        )
      }
      if (filter === 'unknown') return message.status === 'unknown'
      if (filter === 'held') return message.status === 'held'
      return true
    })
    messages = [...messages].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    const total = messages.length
    const page = messages.slice(offset, offset + limit)

    // Only chains touched by this page (plus one explicitly queried chain)
    // are materialized. Scanning every message for every chain would make a
    // default snapshot O(messages x chains).
    const chainIds = new Set(page.map((message) => message.chainId))
    if (chainId !== undefined) chainIds.add(chainId)
    const chains = this.#chainViewsFor(state, chainIds)

    const sessions = await this.adapter.listSessions({})
    return {
      revision: state.revision,
      settings: structuredClone(state.settings),
      messages: page.map((message) => this.#messageView(state, message, sessionId)),
      chains,
      budgetLatches: activeLatches(state).map((latch) => structuredClone(latch)),
      sessions: sessions.map((session) => publicSession(session)),
      total,
      inFlight: state.messages.filter((message) => message.status === 'dispatching').length,
      budget: budgetSummary(state, this.clock()),
      storage: this.ledger.stats(),
    }
  }

  // -------------------------------------------------------------------------
  // State helpers
  // -------------------------------------------------------------------------

  /**
   * @param {string} id
   * @returns {Record<string, any> | undefined}
   */
  #message(id) {
    return this.ledger.read().messages.find((message) => message.id === id)
  }

  /**
   * @param {Record<string, any>} state
   * @param {string} from
   * @param {string} operationId
   * @returns {Record<string, any> | undefined}
   */
  #lookupOperation(state, from, operationId) {
    return Object.values(state.operations).find(
      (operation) => operation?.from === from && operation?.operationId === operationId,
    )
  }

  /**
   * @param {string} from
   * @param {string} operationId
   * @param {readonly string[]} targets
   * @returns {string}
   */
  #operationKey(from, operationId, targets) {
    return `${from}|${operationId}|${[...targets].sort().join(',')}`
  }

  /**
   * @param {Record<string, any>} state
   * @param {Record<string, any>} operation
   * @returns {Record<string, any>}
   */
  #operationResult(state, operation) {
    return {
      operationId: operation.operationId,
      idempotent: true,
      chainId: state.messages.find((message) => message.id === operation.messageIds[operation.targets[0]])?.chainId,
      held: operation.targets.every((target) => findMessage(state, operation.messageIds[target])?.status === 'held'),
      results: operation.targets.map((target) => {
        const message = findMessage(state, operation.messageIds[target])
        return {
          target,
          id: operation.messageIds[target],
          status: message?.status ?? 'missing',
          dispatchStatus: message?.status ?? 'missing',
          error: message?.error ?? null,
        }
      }),
    }
  }

  /**
   * @param {Record<string, any>} state
   * @param {Record<string, any>} chain
   * @param {string} reason
   * @param {number} now
   */
  #pauseChainInState(state, chain, reason, now) {
    if (chain.state === 'closed' || chain.state === 'paused') return
    chain.state = 'paused'
    chain.pausedAt = now
    chain.pausedReason = reason
  }

  /**
   * @param {Record<string, any>} state
   * @param {Record<string, any>} chain
   * @param {number} now
   * @param {string} by
   */
  #closeChainInState(state, chain, now, by) {
    chain.state = 'closed'
    chain.closedAt = now
    chain.closedBy = by
    for (const message of chainMessages(state, chain.id)) {
      if (message.status === 'pending' || message.status === 'held') {
        message.status = 'cancelled'
        message.cancelledAt = now
        message.cancelReason = 'chain_closed'
        message.error = { code: 'chain_closed', message: 'chain closed before delivery' }
        message.releaseAuthorized = false
      }
    }
  }

  /**
   * @param {Record<string, any>} state
   * @param {Record<string, any>} message
   * @param {number} now
   * @param {string} by
   * @returns {boolean}
   */
  #cancelMessageInState(state, message, now, by) {
    if (message.status !== 'pending' && message.status !== 'held') return false
    message.status = 'cancelled'
    message.cancelledAt = now
    message.cancelledBy = by
    message.cancelReason = 'cancelled'
    message.error = { code: 'cancelled', message: 'cancelled before host insertion' }
    message.releaseAuthorized = false
    return true
  }

  /**
   * @param {Record<string, any>} state
   * @param {Record<string, any>} message
   * @param {number} now
   */
  #releaseOne(state, message, now) {
    if (message.status !== 'held') throw fail('conflict', 'only a held message can be released')
    const chain = state.chains[message.chainId]
    if (chain === undefined) throw fail('chain_missing', 'chain is missing')
    if (chain.state === 'closed') throw fail('chain_closed', 'chain is closed')
    if (chain.state === 'paused') throw fail('chain_paused', 'resume the chain before releasing held messages')
    if (!state.settings.enabled) throw fail('disabled', 'enable session-link before releasing held messages')
    if (state.settings.emergencyPaused) throw fail('emergency_paused', 'clear the emergency pause before releasing held messages')
    const latches = latchesBlocking(state, scopesFor(message.from, [message.to], now))
    if (latches.length > 0) {
      throw fail('budget_latched', 'release the budget latch before releasing held messages', {
        latches: latches.map((latch) => structuredClone(latch)),
      })
    }
    // Delivery budget is reserved at the actual dispatch attempt, not at
    // release time, so a released message cannot spend a stale window budget.
    const existingCount = chainMessages(state, chain.id).length
    if (existingCount > chain.maxMessages) {
      this.#pauseChainInState(state, chain, 'chain_budget', now)
      throw fail('chain_budget', 'chain message budget is exhausted')
    }
    message.status = 'pending'
    message.releasedAt = now
    message.releaseAuthorized = true
    message.heldAt = null
    message.heldReason = null
    message.error = null
  }

  /**
   * @param {Record<string, any>} state
   * @param {string} from
   * @param {number} count
   * @param {number} bytes
   */
  #assertHeldCapacity(state, from, count, bytes) {
    const usage = new Map()
    for (const message of state.messages) {
      if (message.status !== 'held') continue
      this.#addHeldUsage(usage, message)
    }
    const source = this.#heldUsage(usage, from)
    if (source.count + count > LIMITS.HELD_PER_SOURCE) {
      throw fail('held_full', 'held queue for this source is full', {
        held: source.count,
        max: LIMITS.HELD_PER_SOURCE,
      })
    }
    if (source.bytes + bytes > LIMITS.HELD_TOTAL_BYTES) {
      throw fail('held_full', 'held payload for this source is full', {
        bytes: source.bytes + bytes,
        maxBytes: LIMITS.HELD_TOTAL_BYTES,
      })
    }
  }

  /** @param {Map<string, {count:number, bytes:number}>} usage @param {Record<string, any>} message */
  #addHeldUsage(usage, message) {
    const source = this.#heldUsage(usage, message.from)
    source.count += 1
    source.bytes += Number.isSafeInteger(message.contentBytes) ? message.contentBytes : 0
  }

  /**
   * @param {Map<string, {count:number, bytes:number}>} usage
   * @param {string} from
   * @returns {{ count: number, bytes: number }}
   */
  #heldUsage(usage, from) {
    let source = usage.get(from)
    if (source === undefined) {
      source = { count: 0, bytes: 0 }
      usage.set(from, source)
    }
    return source
  }

  /**
   * @param {Record<string, any>} state
   * @param {string} from
   * @param {string} target
   */
  #assertPairGate(state, from, target, now) {
    const pending = state.messages.find(
      (message) =>
        message.kind === 'request' &&
        message.status === 'accepted' &&
        message.replyStatus === 'waiting' &&
        state.chains[message.chainId]?.state !== 'closed' &&
        (!Number.isSafeInteger(message.deadlineAt) || message.deadlineAt > now) &&
        ((message.from === from && message.to === target) || (message.from === target && message.to === from)),
    )
    if (pending !== undefined) {
      throw fail('parent_required', 'this pair already has an unanswered accepted request; answer it, continue it with parentMessageId, or let it time out', {
        requestId: pending.id,
        chainId: pending.chainId,
      })
    }
  }

  /**
   * @param {Record<string, any>} state
   * @param {string} id
   * @returns {Record<string, any>}
   */
  #chainById(state, id) {
    const chain = state.chains[id]
    if (chain === undefined) throw fail('not_found', 'chain not found')
    return chain
  }

  /**
   * @param {Record<string, any>} state
   * @param {Record<string, any>} chain
   * @returns {Record<string, any>}
   */
  #chainView(state, chain, stats) {
    let entry = stats
    if (entry === undefined) {
      const messages = chainMessages(state, chain.id)
      entry = {
        count: messages.length,
        pending: messages.filter((message) => message.status === 'pending').length,
        held: messages.filter((message) => message.status === 'held').length,
        dispatching: messages.filter((message) => message.status === 'dispatching').length,
        unknown: messages.filter((message) => message.status === 'unknown').length,
        lastMessageAt: messages.reduce((latest, message) => Math.max(latest, message.createdAt ?? 0), 0),
      }
    }
    return {
      ...structuredClone(chain),
      messageCount: entry.count,
      pending: entry.pending,
      held: entry.held,
      dispatching: entry.dispatching,
      unknown: entry.unknown,
      lastMessageAt: entry.lastMessageAt || null,
    }
  }

  /**
   * Materialize a bounded set of chains in one pass over messages.
   * @param {Record<string, any>} state
   * @param {Iterable<string>} chainIds
   * @returns {Array<Record<string, any>>}
   */
  #chainViewsFor(state, chainIds) {
    const stats = new Map()
    for (const id of chainIds) {
      if (state.chains[id] === undefined) continue
      stats.set(id, { count: 0, pending: 0, held: 0, dispatching: 0, unknown: 0, lastMessageAt: 0 })
    }
    if (stats.size > 0) {
      for (const message of state.messages) {
        const entry = stats.get(message.chainId)
        if (entry === undefined) continue
        entry.count += 1
        if (message.status === 'pending') entry.pending += 1
        else if (message.status === 'held') entry.held += 1
        else if (message.status === 'dispatching') entry.dispatching += 1
        else if (message.status === 'unknown') entry.unknown += 1
        if (Number.isSafeInteger(message.createdAt) && message.createdAt > entry.lastMessageAt) {
          entry.lastMessageAt = message.createdAt
        }
      }
    }
    return [...stats.entries()].map(([id, entry]) => this.#chainView(state, state.chains[id], entry))
  }

  /**
   * @param {Record<string, any>} state
   * @param {Record<string, any>} message
   * @param {string} [sessionId]
   * @returns {Record<string, any>}
   */
  #messageView(state, message, sessionId) {
    const chain = state.chains[message.chainId]
    return {
      ...structuredClone(message),
      status: message.status,
      dispatchStatus: message.status,
      text: message.content?.text ?? '',
      direction:
        sessionId === undefined ? null : message.from === sessionId ? 'out' : message.to === sessionId ? 'in' : null,
      chainState: chain?.state ?? null,
      replies: state.messages
        .filter((candidate) => candidate.parentMessageId === message.id)
        .slice(0, 20)
        .map((candidate) => candidate.id),
    }
  }

  /**
   * Public delivery payload for adapter.buildDelivery.
   * @param {Record<string, any>} message
   * @returns {Record<string, any>}
   */
  #publicMessage(message) {
    return { ...structuredClone(message), rendered: renderInboundText(message) }
  }

  /**
   * Mint one operationId. Identity is checked by the tool before this point.
   * @returns {{ operationId: string }}
   */
  mintOperation() {
    return { operationId: mintOperationId(this.uuid(), this.clock()) }
  }

  /** @param {string} id @returns {Record<string, any> | undefined} */
  inspect(id) {
    const state = this.ledger.read()
    const message = findMessage(state, id)
    if (message === undefined) return undefined
    const chain = state.chains[message.chainId]
    return {
      message: this.#messageView(state, message),
      chain: chain === undefined ? null : this.#chainView(state, chain),
      replies: state.messages.filter((candidate) => candidate.parentMessageId === message.id),
    }
  }

  /** Stop background scheduling and wait for in-flight attempts. */
  async dispose() {
    this.#disposed = true
    await this.drain()
  }
}

/**
 * @param {Record<string, any>} session
 * @param {Record<string, unknown>} filter
 * @returns {boolean}
 */
function matchesSessionFilter(session, filter) {
  const workspace = filter.workspace
  if (workspace !== undefined) {
    const text = requiredString(workspace, 'workspace', { max: 500, code: 'tool_args' })
    const haystack = `${session.workspaceTitle ?? ''} ${session.workspaceId ?? ''}`.toLowerCase()
    if (!haystack.includes(text.toLowerCase())) return false
  }
  const title = filter.title
  if (title !== undefined) {
    const text = requiredString(title, 'title', { max: 500, code: 'tool_args' })
    if (!`${session.title ?? ''}`.toLowerCase().includes(text.toLowerCase())) return false
  }
  const query = filter.query
  if (query !== undefined) {
    const text = requiredString(query, 'query', { max: 500, code: 'tool_args' })
    const haystack = `${session.title ?? ''} ${session.workspaceTitle ?? ''} ${session.id}`
    if (!haystack.toLowerCase().includes(text.toLowerCase())) return false
  }
  return true
}

/**
 * @param {Record<string, any>} session
 * @returns {Record<string, any>}
 */
export function publicSession(session) {
  return {
    id: session.id,
    sessionId: session.id,
    title: session.title ?? session.id,
    workspaceId: session.workspaceId ?? null,
    workspaceTitle: session.workspaceTitle ?? null,
    status: session.agentStatus ?? (session.live === true ? 'idle' : 'cold'),
    agentStatus: session.agentStatus ?? (session.live === true ? 'idle' : 'cold'),
    live: session.live === true,
    archived: session.archived === true,
    subagent: session.subagent === true,
    eligible: session.eligible === true,
    formatStatus: session.formatStatus ?? 'current',
  }
}

/** @param {string|undefined} cursor @returns {number} */
function decodeCursor(cursor) {
  if (cursor === undefined || cursor === null) return 0
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 512) {
    throw fail('invalid_argument', 'cursor is invalid')
  }
  let decoded
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw fail('invalid_argument', 'cursor is invalid')
  }
  if (!isPlainObject(decoded) || decoded.v !== 1 || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0) {
    throw fail('invalid_argument', 'cursor is invalid')
  }
  if (decoded.offset > 1_000_000) throw fail('invalid_argument', 'cursor is out of range')
  return decoded.offset
}

/** @param {number} offset @returns {string} */
function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ v: 1, offset }), 'utf8').toString('base64url')
}
