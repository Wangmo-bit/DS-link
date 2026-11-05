/**
 * Host-independent v0.3 delivery state machine and owner control plane.
 *
 * The engine owns every durable transition. Host code supplies an adapter for
 * eligibility/discovery, message construction, steer+flush, receipt observation,
 * cold reads, native inbox transfer, and history. The engine never calls
 * `sessionController.prompt`, never cancels a recipient's work, never captures
 * a recipient's last assistant message, and never retries an unknown delivery.
 *
 * A receipt only proves the host committed a matching user/message event into
 * the target's context. It never claims the model read, understood, or acted
 * on it. There are no business quotas here: only message format, the two byte
 * storage envelopes, identity/eligibility, pause/disable, and persisted
 * unknown/terminal state can refuse work.
 */

import { randomUUID } from 'node:crypto'

import {
  API_VERSION,
  AUTO_HELD_REASONS,
  CONTROL_ACTIONS,
  CREATE_TERMINAL_PHASES,
  LEGACY_SETTINGS_KEYS,
  LIMITS,
  PLUGIN_VERSION,
  SNAPSHOT_FILTERS,
} from './constants.js'
import { fail, errorCode } from './errors.js'
import { skipMutation } from './ledger.js'
import { publicMigration, sha256 } from './migration.js'
import { renderInboundText } from './render.js'
import { applySettingsPatch } from './settings.js'
import {
  absolutePath,
  assertAllowedKeys,
  assertCallBytes,
  assertPlainObject,
  assertProjectSegment,
  boundedInteger,
  callFingerprint,
  createFingerprint,
  fingerprintMatches,
  firstLineExcerpt,
  sealFingerprint,
  isPlainObject,
  mintOperationId,
  normalizeContent,
  normalizeSubject,
  normalizeTargets,
  normalizeTask,
  optionalString,
  requiredString,
  utf8Length,
  validateOperationId,
} from './validation.js'

const NOOP_LOGGER = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
})

const DAY_MS = 24 * 60 * 60 * 1000
const ACTIVE_QUEUE_STATUSES = new Set(['pending', 'held', 'dispatching'])
const RECEIPT_STATUSES = new Set(['accepted', 'dispatching', 'unknown'])
const SOURCE_KEYS = Object.freeze(['kind', 'form', 'senderSessionId'])

/**
 * Grant the verified inbound business text on an already-emitted card. Body
 * access needs the CURRENT requested id to equal the durable host id and the
 * viewer to be the recipient; a plugin-id request never grants by itself, and
 * an existing card is only upgraded — never duplicated — so the result is
 * independent of the order the ids arrive in.
 * @param {Record<string, any>} entry
 * @param {Record<string, any>} message
 * @param {string} id
 * @param {string} sessionId
 * @param {boolean} includeBody
 */
function grantInboundBody(entry, message, id, sessionId, includeBody) {
  if (!includeBody || 'body' in entry) return
  if (typeof message.durableMessageId !== 'string' || message.durableMessageId.length === 0) return
  if (id !== message.durableMessageId || sessionId !== message.to) return
  // An unknown delivery is not verified evidence: never present its body as
  // confirmed text. The status metadata stays so the viewer can fall back to
  // the conservative original-message / technical-details path.
  if (message.status === 'unknown') return
  if (message.redactedAt !== undefined && message.redactedAt !== null) {
    entry.body = null
    entry.bodyState = 'redacted'
    return
  }
  entry.body = typeof message.content?.text === 'string' ? message.content.text : ''
  entry.bodyState = 'available'
}

/**
 * Display subject for one durable message: the sender-provided subject when
 * present, otherwise a deterministic first-line excerpt of the body. No model
 * call and no trust decision: the wire `subject:` header stays untrusted.
 * @param {Record<string, any>} message
 * @returns {string}
 */
function displaySubject(message) {
  if (typeof message.subject === 'string' && message.subject.length > 0) return message.subject
  return firstLineExcerpt(message.content?.text, LIMITS.SUBJECT_EXCERPT_CHARS)
}

/**
 * Host rejections that are proven to happen before the host starts creating
 * a session. Anything outside this set may have created a session, so the
 * journal stops as `uncertain` instead of guessing.
 */
const PRE_CREATE_FAILURE_CODES = new Set(['workspace/not-found', 'gateway/bad-request'])

/**
 * @param {unknown} error
 * @param {string} [messageOverride]
 * @returns {{ code: string, message: string }}
 */
function createErrorView(error, messageOverride) {
  const message =
    messageOverride ??
    (typeof error?.message === 'string' && error.message.length > 0
      ? error.message
      : 'the operation failed before its result could be confirmed')
  return { code: errorCode(error), message: message.slice(0, 400) }
}

/**
 * Pure, side-effect-free parsing of one create call: strict keys, exactly one
 * location, a bounded single-line subject, and a deterministic session title.
 * @param {Record<string, unknown>} request
 * @returns {{ from: string, operationId: string, task: string, subject: string | undefined, resolvedTitle: string, location: Record<string, any>, fingerprint: string }}
 */
function parseCreateRequest(request) {
  const object = assertPlainObject(request, 'create request')
  assertAllowedKeys(
    object,
    ['from', 'operationId', 'task', 'workspaceId', 'newProject', 'existingProject', 'title', 'subject'],
    'create request',
  )
  const from = requiredString(object.from, 'from', { min: 1, max: 256 })
  const operationId = requiredString(object.operationId, 'operationId', { max: 128 })
  const task = normalizeTask(object.task)
  const subject = normalizeSubject(object.subject)
  // The first message shares the existing 64 KiB content envelope: the task
  // body plus the optional subject must fit together, checked before any
  // journal or filesystem effect.
  const contentBytes = utf8Length(JSON.stringify({ text: task, references: [], paths: [] }))
  if (contentBytes > LIMITS.MAX_CONTENT_BYTES) {
    throw fail(
      'invalid_argument',
      `task content exceeds ${LIMITS.MAX_CONTENT_BYTES} serialized bytes; shorten the first task`,
      { contentBytes, maxBytes: LIMITS.MAX_CONTENT_BYTES },
    )
  }
  assertSubjectEnvelope(subject, contentBytes)
  const title = optionalString(object.title, 'title', { max: 500 })
  const hasWorkspace = object.workspaceId !== undefined && object.workspaceId !== null
  const hasProject = object.newProject !== undefined && object.newProject !== null
  const hasExisting = object.existingProject !== undefined && object.existingProject !== null
  const locationCount = Number(hasWorkspace) + Number(hasProject) + Number(hasExisting)
  if (locationCount !== 1) {
    throw fail('invalid_argument', 'provide exactly one of workspaceId, newProject, or existingProject')
  }
  let location
  if (hasWorkspace) {
    location = {
      kind: 'workspace',
      workspaceId: requiredString(object.workspaceId, 'workspaceId', { min: 1, max: 256 }),
      parentDir: null,
      directoryName: null,
      workspacePath: null,
      workspaceTitle: null,
    }
  } else if (hasExisting) {
    const existing = assertPlainObject(object.existingProject, 'existingProject')
    assertAllowedKeys(existing, ['path', 'title'], 'existingProject arguments')
    location = {
      kind: 'existing_project',
      workspaceId: null,
      parentDir: null,
      directoryName: null,
      workspacePath: absolutePath(existing.path, 'existingProject.path'),
      workspaceTitle: optionalString(existing.title, 'existingProject.title', { max: 500 }) ?? null,
    }
  } else {
    const project = assertPlainObject(object.newProject, 'newProject')
    assertAllowedKeys(project, ['parentDir', 'directoryName', 'title'], 'newProject arguments')
    location = {
      kind: 'new_project',
      workspaceId: null,
      parentDir: absolutePath(project.parentDir, 'newProject.parentDir'),
      directoryName: assertProjectSegment(project.directoryName, 'newProject.directoryName'),
      workspacePath: null,
      workspaceTitle: optionalString(project.title, 'newProject.title', { max: 500 }) ?? null,
    }
  }
  const resolvedTitle = title ?? firstLineExcerpt(task, LIMITS.TITLE_EXCERPT_CHARS)
  const fingerprint = createFingerprint({
    task,
    targets: [from],
    workspaceId: location.workspaceId,
    parentDir: location.parentDir,
    directoryName: location.directoryName,
    workspacePath: location.workspacePath,
    workspaceTitle: location.workspaceTitle,
    title: resolvedTitle,
    ...(subject === undefined ? {} : { subject }),
  })
  return { from, operationId, task, subject, resolvedTitle, location, fingerprint }
}

/**
 * The optional subject shares the existing 64 KiB content envelope: the
 * message's own contentBytes stay byte-identical to 0.3, and the subject
 * bytes are added only for this call's budget check.
 * @param {string | undefined} subject
 * @param {number} contentBytes
 */
function assertSubjectEnvelope(subject, contentBytes) {
  if (subject === undefined) return
  const subjectBytes = utf8Length(JSON.stringify(subject))
  if (contentBytes + subjectBytes > LIMITS.MAX_CONTENT_BYTES) {
    throw fail(
      'invalid_argument',
      `content and subject exceed ${LIMITS.MAX_CONTENT_BYTES} serialized bytes; shorten the subject or body`,
      { contentBytes, subjectBytes, maxBytes: LIMITS.MAX_CONTENT_BYTES },
    )
  }
}

/** @param {'context'|'legacy-accepted'} policy */
function createReceipt(policy) {
  return {
    policy,
    state: policy === 'context' ? 'not_sent' : 'uncertain',
    receivedAt: null,
    receivedSeq: null,
    timeoutMs: null,
    transfer: null,
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
  if (keys.length !== SOURCE_KEYS.length) return false
  return (
    keys.every((key) => SOURCE_KEYS.includes(key)) &&
    source.kind === 'agent-message' &&
    source.form === 'relay' &&
    source.senderSessionId === senderSessionId
  )
}

/** @param {Record<string, any>} hostMessage @returns {string} */
function hostMessageDigest(hostMessage) {
  return sha256(Buffer.from(JSON.stringify(hostMessage), 'utf8'))
}

/** @param {unknown} content @returns {string} */
function textOfHostMessage(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * The native row may only be moved when it is exactly the durable message this
 * ledger recorded: same host id, standard source sender, and rendered body.
 * @param {Record<string, any>} message
 * @param {Record<string, any>} native
 * @returns {boolean}
 */
function hostMessageMatchesLedger(message, native) {
  if (native?.id !== message.durableMessageId) return false
  if (!isStandardSource(native.source, message.from)) return false
  return textOfHostMessage(native.content) === renderInboundText(message)
}

/**
 * Deadline arithmetic stays inside the JavaScript Date range; an unrepresentable
 * deadline is left absent instead of being clamped or fabricated.
 * @param {number} receivedAt
 * @param {number|null} timeoutMs
 * @returns {number | undefined}
 */
function representableDeadline(receivedAt, timeoutMs) {
  if (!Number.isSafeInteger(receivedAt) || receivedAt < 0) return undefined
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return undefined
  const deadline = receivedAt + timeoutMs
  if (!Number.isSafeInteger(deadline) || deadline > LIMITS.MAX_DATE_MS) return undefined
  return deadline
}

/** @param {Record<string, any>} state @param {string} id */
function findMessage(state, id) {
  return state.messages.find((message) => message?.id === id)
}

/** @param {Record<string, any>} state @param {string} chainId */
function chainMessages(state, chainId) {
  return state.messages.filter((message) => message?.chainId === chainId)
}

/** @param {Record<string, any>} message */
function contentBytesOf(message) {
  if (Number.isSafeInteger(message.contentBytes) && message.contentBytes >= 0) return message.contentBytes
  try {
    return Buffer.byteLength(JSON.stringify(message.content ?? {}), 'utf8')
  } catch {
    return 0
  }
}

/** @param {Record<string, any>} state */
/** @param {string | null | undefined} subject @returns {number} */
function subjectPayloadBytes(subject) {
  return typeof subject === 'string' && subject.length > 0 ? Buffer.byteLength(JSON.stringify(subject), 'utf8') : 0
}

/**
 * Bytes one create journal still contributes to the 16 MiB undelivered
 * envelope. A journal is deduplicated only when its matching message is
 * ACTIVE and already counted on the message side; a failed/unknown/missing
 * match with a retained body keeps counting so neither side can silently
 * drop the payload.
 * @param {Record<string, any>} state
 * @param {Record<string, any> | undefined} journal
 * @param {Set<string>} [operationIds]
 * @returns {number}
 */
function createJournalPayloadBytes(state, journal, operationIds) {
  if (!isPlainObject(journal)) return 0
  if (journal.bodyStripped === true) return 0
  if (typeof journal.task !== 'string' || journal.task.length === 0) return 0
  let match
  if (typeof journal.firstMessageId === 'string' && journal.firstMessageId.length > 0) {
    match = state.messages.find((candidate) => candidate.id === journal.firstMessageId)
  } else {
    const index = operationIds ?? new Set(state.messages.map((candidate) => candidate.operationId))
    match =
      typeof journal.sendOperationId === 'string' && index.has(journal.sendOperationId)
        ? state.messages.find((candidate) => candidate.operationId === journal.sendOperationId)
        : undefined
  }
  if (match !== undefined && ACTIVE_QUEUE_STATUSES.has(match.status)) return 0
  return Buffer.byteLength(journal.task, 'utf8') + subjectPayloadBytes(journal.subject)
}

function queuedBytesOf(state) {
  let bytes = 0
  for (const message of state.messages) {
    if (ACTIVE_QUEUE_STATUSES.has(message.status)) {
      bytes += contentBytesOf(message) + subjectPayloadBytes(message.subject)
    }
  }
  if (isPlainObject(state.creates)) {
    const operationIds = new Set(state.messages.map((message) => message.operationId))
    for (const journal of Object.values(state.creates)) {
      bytes += createJournalPayloadBytes(state, journal, operationIds)
    }
  }
  return bytes
}

/**
 * Locate the create journal that owns this internal first-message
 * reservation (same caller + persisted sendOperationId).
 * @param {Record<string, any>} state
 * @param {string} from
 * @param {string} operationId
 * @returns {Record<string, any> | undefined}
 */
function findCreateSendReservation(state, from, operationId) {
  return Object.values(state.creates ?? {}).find(
    (journal) => journal?.from === from && journal?.sendOperationId === operationId,
  )
}

/**
 * Exact reservation match: same caller, the single actual session target,
 * the stored task and subject, a plain request with no parent, references,
 * or paths. Anything else must be rejected as an operationId conflict and
 * may never consume the reservation.
 * @param {Record<string, any> | undefined} journal
 * @param {{ kind: string, targets: readonly string[], text: string, references: readonly any[], paths: readonly string[], subject: string | null, parentMessageId: string | null }} request
 * @returns {boolean}
 */
function createReservationExact(journal, request) {
  if (!isPlainObject(journal)) return false
  return (
    request.kind === 'request' &&
    request.parentMessageId === null &&
    request.targets.length === 1 &&
    request.targets[0] === journal.sessionId &&
    request.text === journal.task &&
    (request.subject ?? null) === (journal.subject ?? null) &&
    request.references.length === 0 &&
    request.paths.length === 0
  )
}

/**
 * Parse the mint timestamp of a `slop:<ms>:<uuid>` operationId.
 * @param {unknown} operationId
 * @returns {number | null}
 */
function parseOperationMintTime(operationId) {
  const match = /^slop:(\d+):/.exec(typeof operationId === 'string' ? operationId : '')
  if (match === null) return null
  const at = Number(match[1])
  return Number.isSafeInteger(at) && at >= 0 ? at : null
}

/** @param {Record<string, any>} message */
function isAutomaticHeld(message) {
  return message.status === 'held' && (message.heldOverflow === true || AUTO_HELD_REASONS.includes(message.heldReason))
}

/**
 * @param {Record<string, any>} state
 * @param {Record<string, any>} message
 * @returns {string[]}
 */
function dispatchBlockers(state, message) {
  const blockers = []
  if (!state.settings.enabled) blockers.push('disabled')
  if (state.settings.paused) blockers.push('paused')
  const chain = state.chains[message.chainId]
  if (chain === undefined) blockers.push('chain_missing')
  else if (chain.state === 'paused') blockers.push('chain_paused')
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
   *   maxQueuedBytes?: number,
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
    this.maxQueuedBytes = options.maxQueuedBytes ?? LIMITS.MAX_QUEUED_BYTES
    if (!Number.isSafeInteger(this.maxQueuedBytes) || this.maxQueuedBytes <= 0) {
      throw fail('invalid_argument', 'maxQueuedBytes must be a positive safe integer')
    }
    this.#slots = 0
    this.#waiters = []
    this.#tasks = new Set()
    this.#starting = new Set()
    this.#attempts = new Set()
    this.#disposed = false
    this.#disposePromise = undefined
    this.#pumpScheduled = false
    this.#receiptIndex = new Map()
    this.#receiptByTarget = new Map()
    this.#receiptRetryTargets = new Set()
    this.#transferScheduled = false
    this.#transferRunning = false
    this.#createsInFlight = new Map()
    this.#rebuildReceiptIndex(this.ledger.read())
    this.#installReceiptObserver()
  }

  #slots
  #waiters
  #tasks
  #starting
  #attempts
  #disposed
  #disposePromise
  #pumpScheduled
  #receiptDispose
  #receiptPoisoned
  #receiptIndex
  #receiptByTarget
  #receiptRetryTargets
  #transferScheduled
  #transferRunning
  #createsInFlight
  #lastCleanup = { timedOut: 0, redacted: 0, prunedMessages: 0, prunedOperations: 0, prunedChains: 0, prunedCreates: 0 }

  // -------------------------------------------------------------------------
  // Operation tracking and storage gate
  // -------------------------------------------------------------------------

  /** @template T @param {() => Promise<T>} task @returns {Promise<T>} */
  #trackOperation(task) {
    if (this.#disposed) throw fail('disposed', 'session-link is shutting down')
    if (!this.ledger.writable) throw this.#storageError()
    const promise = (async () => task())()
    this.#track(promise)
    return promise
  }

  /** @template T @param {Promise<T>} promise @returns {Promise<T>} */
  #track(promise) {
    this.#tasks.add(promise)
    promise.then(
      () => this.#tasks.delete(promise),
      () => this.#tasks.delete(promise),
    )
    return promise
  }

  /** @returns {never} */
  #storageError() {
    return fail('storage_error', 'session-link storage is in storage_error; safe reopen required', {
      ...(this.ledger.storageError ?? {}),
    })
  }

  // -------------------------------------------------------------------------
  // Receipt observation
  // -------------------------------------------------------------------------

  /** @param {Record<string, any>} state */
  #rebuildReceiptIndex(state) {
    this.#receiptIndex.clear()
    this.#receiptByTarget.clear()
    for (const message of state.messages) {
      this.#indexReceiptMessage(message)
    }
  }

  /** @param {Record<string, any>} message */
  #indexReceiptMessage(message) {
    if (typeof message?.durableMessageId !== 'string' || message.durableMessageId.length === 0) return
    const key = `${message.to}|${message.durableMessageId}`
    if (!this.#receiptIndex.has(key)) this.#receiptIndex.set(key, message.id)
    if (message.receipt?.state === 'received') return
    let ids = this.#receiptByTarget.get(message.to)
    if (ids === undefined) {
      ids = new Set()
      this.#receiptByTarget.set(message.to, ids)
    }
    ids.add(message.id)
  }

  #installReceiptObserver() {
    if (typeof this.adapter.installReceiptObserver !== 'function') {
      this.#receiptPoisoned = { code: 'receipt_observer_unavailable', at: this.clock() }
      this.logger.warn('session-link receipt observer is unavailable; live receipts cannot be confirmed')
      return
    }
    try {
      const dispose = this.adapter.installReceiptObserver((event) => this.#onReceiptEvent(event))
      this.#receiptDispose = typeof dispose === 'function' ? dispose : undefined
    } catch (error) {
      this.#poisonReceipt(error)
    }
  }

  /** @param {unknown} event @returns {Promise<void>|undefined} */
  #onReceiptEvent(event) {
    if (this.#disposed || this.#receiptPoisoned !== undefined) return undefined
    try {
      const observed = this.#handleReceiptEvent(event).catch((error) => {
        this.#poisonReceipt(error)
      })
      this.#track(observed)
      // The Host adapter ignores this return value; test adapters may await it
      // to keep an injected receipt deterministic against the same clock.
      return observed
    } catch (error) {
      this.#poisonReceipt(error)
      return undefined
    }
  }

  /** @param {unknown} error */
  #poisonReceipt(error) {
    if (this.#receiptPoisoned !== undefined) return
    this.#receiptPoisoned = { code: errorCode(error), at: this.clock() }
    this.logger.error(`session-link receipt observation stopped: ${errorCode(error)}`)
  }

  /** @param {unknown} event @returns {Promise<void>} */
  async #handleReceiptEvent(event) {
    if (this.#disposed || !isPlainObject(event)) return
    if (event.kind === 'message') {
      await this.#observeMessage(event)
      return
    }
    if (event.kind === 'inbox') await this.#observeInbox(event)
  }

  /** @param {Record<string, any>} event */
  async #observeMessage(event) {
    const sessionId = event.sessionId
    const durableMessageId = event.messageId
    const senderSessionId = event.senderSessionId
    if (
      typeof sessionId !== 'string' ||
      typeof durableMessageId !== 'string' ||
      typeof senderSessionId !== 'string' ||
      !isStandardSource(event.source, senderSessionId) ||
      !Number.isSafeInteger(event.seq) ||
      !Number.isSafeInteger(event.time) ||
      event.seq < 0 ||
      event.time < 0
    ) {
      return
    }
    const ledgerMessageId = this.#receiptIndex.get(`${sessionId}|${durableMessageId}`)
    if (ledgerMessageId === undefined) return
    const before = this.ledger.read()
    const message = findMessage(before, ledgerMessageId)
    if (
      message === undefined ||
      message.to !== sessionId ||
      message.durableMessageId !== durableMessageId ||
      message.from !== senderSessionId ||
      message.receipt === undefined ||
      message.receipt.state === 'received' ||
      !RECEIPT_STATUSES.has(message.status)
    ) {
      return
    }
    let flushed = false
    try {
      flushed = (await this.adapter.flushTarget(sessionId)) === true
    } catch {
      flushed = false
    }
    if (this.#disposed || this.#receiptPoisoned !== undefined) return
    if (!flushed) {
      this.#receiptRetryTargets.add(sessionId)
      return
    }
    await this.#mutate((state) => {
      const current = findMessage(state, ledgerMessageId)
      if (
        current === undefined ||
        current.to !== sessionId ||
        current.durableMessageId !== durableMessageId ||
        current.from !== senderSessionId ||
        current.receipt === undefined ||
        current.receipt.state === 'received' ||
        !RECEIPT_STATUSES.has(current.status)
      ) {
        return skipMutation(undefined)
      }
      return this.#markReceivedInState(state, current, event.time, event.seq, this.clock()) ? true : skipMutation(undefined)
    })
    this.#receiptRetryTargets.delete(sessionId)
  }

  /**
   * @param {Record<string, any>} state
   * @param {Record<string, any>} message
   * @param {number} receivedAt
   * @param {number} receivedSeq
   * @param {number} now
   * @returns {boolean}
   */
  #markReceivedInState(state, message, receivedAt, receivedSeq, now) {
    const receipt = message.receipt
    if (receipt === undefined || receipt.state === 'received') return false
    receipt.state = 'received'
    receipt.receivedAt = receivedAt
    receipt.receivedSeq = receivedSeq
    if (receipt.policy === 'context' && message.status === 'accepted') {
      if (message.kind === 'request') {
        this.#applyDeadlineFromReceipt(state, message)
      } else if (message.kind === 'notification' || message.kind === 'reply') {
        message.completedAt = receivedAt
      }
    }
    const journal = state.transfers?.[message.id]
    if (journal !== undefined && journal.state === 'prepared') {
      journal.state = 'moved'
      journal.at = now
      delete journal.error
      receipt.transfer = { state: 'moved', at: now }
    }
    return true
  }

  /**
   * @param {Record<string, any>} state
   * @param {Record<string, any>} message
   */
  #applyDeadlineFromReceipt(state, message) {
    const receipt = message.receipt
    if (receipt?.state !== 'received' || !Number.isSafeInteger(receipt.receivedAt)) return
    if (message.kind !== 'request' || message.status !== 'accepted' || message.replyStatus !== 'waiting') return
    if (Number.isSafeInteger(message.deadlineAt)) return
    const timeoutMs = Number.isSafeInteger(receipt.timeoutMs) ? receipt.timeoutMs : state.settings.requestTimeoutMs
    const deadlineAt = representableDeadline(receipt.receivedAt, timeoutMs)
    if (deadlineAt !== undefined) message.deadlineAt = deadlineAt
  }

  /** @param {Record<string, any>} event */
  async #observeInbox(event) {
    const sessionId = event.sessionId
    if (typeof sessionId !== 'string') return
    const ids = this.#receiptByTarget.get(sessionId)
    if (ids === undefined || ids.size === 0) return
    const snapshot = this.ledger.read()
    const checks = []
    for (const id of ids) {
      const message = findMessage(snapshot, id)
      if (message === undefined || message.status !== 'accepted' || message.receipt?.state === 'received') continue
      if (message.receipt === undefined) continue
      const journal = snapshot.transfers?.[message.id]
      if (journal?.state === 'prepared') continue
      let presence
      try {
        presence = this.adapter.nativePending(sessionId, message.durableMessageId)
      } catch {
        continue
      }
      if (!isPlainObject(presence) || presence.known !== true) continue
      checks.push({ id, pending: presence.pending === true })
    }
    if (checks.length === 0) return
    await this.#mutate((state) => {
      let changed = false
      for (const check of checks) {
        const message = findMessage(state, check.id)
        if (message === undefined || message.status !== 'accepted') continue
        const receipt = message.receipt
        if (receipt === undefined || receipt.state === 'received') continue
        if (check.pending) {
          if (receipt.state !== 'queued') {
            receipt.state = 'queued'
            changed = true
          }
        } else if (receipt.state !== 'uncertain') {
          receipt.state = 'uncertain'
          changed = true
        }
      }
      return changed ? true : skipMutation(undefined)
    })
  }

  /**
   * Cold, grouped catch-up. One target is read once; all candidate messages are
   * matched from that single index. Never scans the whole history per message.
   * @returns {Promise<void>}
   */
  async #catchUpReceipts() {
    const state = this.ledger.read()
    const groups = new Map()
    for (const message of state.messages) {
      if (typeof message.durableMessageId !== 'string' || message.durableMessageId.length === 0) continue
      if (message.receipt === undefined || message.receipt.state === 'received') continue
      if (!RECEIPT_STATUSES.has(message.status)) continue
      let ids = groups.get(message.to)
      if (ids === undefined) {
        ids = []
        groups.set(message.to, ids)
      }
      ids.push(message.id)
    }
    for (const [targetId, ids] of groups) {
      await this.#catchUpTarget(targetId, ids)
    }
  }

  /**
   * @param {string} targetId
   * @param {string[]} messageIds
   * @returns {Promise<void>}
   */
  async #catchUpTarget(targetId, messageIds) {
    if (typeof this.adapter.readTargetReceipts !== 'function') return
    let result
    try {
      result = await this.adapter.readTargetReceipts(targetId)
    } catch (error) {
      result = { readable: false, errorCode: errorCode(error) }
    }
    if (this.#disposed) return
    if (result?.readable !== true) {
      this.#receiptRetryTargets.add(targetId)
      return
    }
    const evidence = new Map()
    for (const entry of result.messages ?? []) {
      if (isPlainObject(entry) && typeof entry.id === 'string') evidence.set(entry.id, entry)
    }
    const pending = new Set(Array.isArray(result.pendingIds) ? result.pendingIds : [])
    const pendingKnown = result.pendingKnown === true
    await this.#mutate((state) => {
      let changed = false
      for (const id of messageIds) {
        const message = findMessage(state, id)
        if (message === undefined || message.receipt === undefined || message.receipt.state === 'received') continue
        const hit = evidence.get(message.durableMessageId)
        if (
          hit !== undefined &&
          isStandardSource(hit.source, message.from) &&
          Number.isSafeInteger(hit.seq) &&
          hit.seq >= 0 &&
          Number.isSafeInteger(hit.time) &&
          hit.time >= 0
        ) {
          if (this.#markReceivedInState(state, message, hit.time, hit.seq, this.clock())) changed = true
          continue
        }
        if (message.status !== 'accepted' || pendingKnown !== true) continue
        if (pending.has(message.durableMessageId)) {
          if (message.receipt.state !== 'queued') {
            message.receipt.state = 'queued'
            changed = true
          }
        } else if (message.receipt.state !== 'uncertain') {
          message.receipt.state = 'uncertain'
          changed = true
        }
      }
      return changed ? true : skipMutation(undefined)
    })
    this.#receiptRetryTargets.delete(targetId)
  }

  /** @returns {Promise<void>} */
  async #retryReceiptTargets() {
    if (this.#receiptRetryTargets.size === 0) return
    const targets = [...this.#receiptRetryTargets].slice(0, LIMITS.RECEIPT_RETRY_TARGETS)
    for (const targetId of targets) {
      if (this.#disposed) return
      const state = this.ledger.read()
      const ids = state.messages
        .filter(
          (message) =>
            message.to === targetId &&
            typeof message.durableMessageId === 'string' &&
            message.receipt !== undefined &&
            message.receipt.state !== 'received' &&
            RECEIPT_STATUSES.has(message.status),
        )
        .map((message) => message.id)
      if (ids.length === 0) {
        this.#receiptRetryTargets.delete(targetId)
        continue
      }
      await this.#catchUpTarget(targetId, ids)
    }
  }

  /**
   * @template T
   * @param {(state: Record<string, any>) => T} task
   * @param {{ expectedRevision?: number, delivery?: boolean }} [options]
   * @returns {Promise<T>}
   */
  #mutate(task, options = {}) {
    if (this.#disposed) throw fail('disposed', 'session-link is shutting down')
    if (!this.ledger.writable) throw this.#storageError()
    return this.ledger.mutate(task, options)
  }

  /**
   * @param {number} additionalBytes
   * @param {Record<string, any>} state
   */
  #assertQueueCapacity(state, additionalBytes, reservation) {
    // A create journal's own reservation is subtracted only for an exact
    // match, so the create-to-send transfer counts the payload exactly once
    // and a mismatched request is charged in full.
    const reservationBytes = reservation === undefined ? 0 : createJournalPayloadBytes(state, reservation)
    const current = queuedBytesOf(state) - reservationBytes
    if (current + additionalBytes > this.maxQueuedBytes) {
      throw fail('queue_full', 'session-link undelivered payload capacity is full', {
        queuedBytes: current,
        additionalBytes,
        maxQueuedBytes: this.maxQueuedBytes,
      })
    }
  }

  // -------------------------------------------------------------------------
  // Startup recovery
  // -------------------------------------------------------------------------

  /**
   * Cold reconcile every in-flight row without resolving an Agent. No evidence
   * means unknown, never a resend. Then reconcile settings-driven held rows.
   * @returns {Promise<Record<string, any>>}
   */
  async start() {
    return this.#trackOperation(async () => {
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
      const result = await this.#mutate((state) => {
        let recovered = 0
        let unknown = 0
        let changed = false
        // A journal still in `creating` at startup means an external effect
        // may have run without a recorded result. It becomes uncertain and
        // is never re-run automatically, whatever a reserved id suggests.
        for (const journal of Object.values(state.creates ?? {})) {
          if (journal?.phase !== 'creating') continue
          journal.phase = 'uncertain'
          journal.error = {
            code: 'create_interrupted',
            message:
              'the plugin restarted while a create effect may have been in flight; verify the workspace/session manually before retrying',
          }
          journal.updatedAt = now
          changed = true
        }
        for (const message of dispatching) {
          const current = findMessage(state, message.id)
          if (current?.status !== 'dispatching') continue
          const evidenceItem = evidence.get(message.id)
          if (evidenceItem?.found === true && evidenceItem.identityConflict !== true) {
            this.#acceptMessage(state, current, now, {
              recoveryEvidence: evidenceItem.evidence ?? 'unknown',
              inboxSeen: evidenceItem.inboxSeen === true,
            })
            if (
              evidenceItem.evidence === 'message' &&
              Number.isSafeInteger(evidenceItem.seq) &&
              Number.isSafeInteger(evidenceItem.time) &&
              evidenceItem.seq >= 0 &&
              evidenceItem.time >= 0
            ) {
              this.#markReceivedInState(state, current, evidenceItem.time, evidenceItem.seq, now)
            }
            recovered += 1
            changed = true
            continue
          }
          this.#markUnknownInState(state, current, now, {
            code:
              evidenceItem?.identityConflict === true
                ? 'identity_conflict'
                : evidenceItem?.invalidTarget === true
                  ? 'target_unavailable'
                  : evidenceItem?.readable === false
                    ? 'evidence_unreadable'
                    : 'no_insertion_evidence',
            message:
              evidenceItem?.identityConflict === true
                ? 'a different sender identity used the same durable message id'
                : evidenceItem?.invalidTarget === true
                  ? 'target is no longer an eligible ordinary session'
                  : evidenceItem?.readable === false
                    ? 'target history could not be read; treating the delivery as unknown'
                    : 'no insertion evidence was found; the delivery is unknown and was not retried',
          })
          unknown += 1
          changed = true
        }
        const cleaned = this.#cleanupState(state, now)
        changed = changed || cleaned
        const reconciled = this.#reconcileGlobalQueue(state, now)
        changed = changed || reconciled.queued > 0 || reconciled.resumed > 0
        if (!changed) return skipMutation({ dispatching: dispatching.length, recovered, unknown, ...this.#lastCleanup })
        return { dispatching: dispatching.length, recovered, unknown, ...this.#lastCleanup }
      })
      this.#rebuildReceiptIndex(this.ledger.read())
      await this.#catchUpReceipts()
      await this.#recoverTransferJournals()
      this.#rebuildReceiptIndex(this.ledger.read())
      this.#schedulePump()
      this.#scheduleTransfer()
      return result
    })
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
    if (!this.ledger.writable) return { skipped: true, storageError: true }
    return this.#trackOperation(async () => {
      const now = this.clock()
      const summary = await this.#mutate((state) => {
        const changed = this.#cleanupState(state, now)
        if (!changed) return skipMutation({ timedOut: 0, redacted: 0, prunedMessages: 0, prunedOperations: 0, prunedChains: 0, prunedCreates: 0 })
        return { ...this.#lastCleanup }
      })
      this.#rebuildReceiptIndex(this.ledger.read())
      await this.#retryReceiptTargets()
      this.#schedulePump()
      this.#scheduleTransfer()
      return summary
    })
  }

  /**
   * @param {Record<string, any>} state
   * @param {number} now
   * @returns {boolean}
   */
  #cleanupState(state, now) {
    let changed = false
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
          message.completedAt = message.timedOutAt
          timedOut += 1
          changed = true
        }
      }
    }

    const retentionMs = state.settings.retentionDays * DAY_MS
    let redacted = 0
    for (const message of state.messages) {
      if (message.redactedAt !== undefined) continue
      if (message.content.text === '' && message.content.references.length === 0 && message.content.paths.length === 0) continue
      const completedAt = this.#completedAtFor(message, state)
      if (completedAt === undefined) continue
      if (completedAt + retentionMs > now) continue
      if (ACTIVE_QUEUE_STATUSES.has(message.status) || message.status === 'unknown') continue
      message.content = { text: '', references: [], paths: [] }
      message.contentBytes = 2
      message.redactedAt = now
      // Body retention applies to the 0.4 subject too; messages without the
      // field (0.3 rows) are byte-for-byte untouched.
      if (message.subject !== undefined) message.subject = null
      // Body retention applies to the private journal too. A completed move no
      // longer needs recovery evidence; an unresolved journal keeps its
      // identity/digest but loses the copied body once the record is redacted.
      const journal = state.transfers?.[message.id]
      if (journal?.state === 'moved') delete state.transfers[message.id]
      else if (journal !== undefined) journal.hostMessage.content = []
      redacted += 1
      changed = true
    }

    // Verified terminal completions, captured AFTER this round's timeout and
    // redaction updates but BEFORE any message pruning. A journal whose first
    // message is pruned right now may only age out from this same-round
    // evidence; a message already missing in an earlier round must never
    // masquerade as verified.
    const terminalCompletedAt = new Map()
    if (isPlainObject(state.creates) && Object.keys(state.creates).length > 0) {
      for (const message of state.messages) {
        if (message.status === 'unknown' || ACTIVE_QUEUE_STATUSES.has(message.status)) continue
        const completedAt = this.#completedAtFor(message, state)
        if (Number.isSafeInteger(completedAt)) terminalCompletedAt.set(message.id, completedAt)
      }
    }

    const metadataMs = Math.max(LIMITS.MESSAGE_RETENTION_MS, retentionMs)
    const messagesByChain = new Map()
    for (const message of state.messages) {
      let entries = messagesByChain.get(message.chainId)
      if (entries === undefined) {
        entries = []
        messagesByChain.set(message.chainId, entries)
      }
      entries.push(message)
    }
    let prunedMessages = 0
    let prunedChains = 0
    const prunedIds = new Set()
    const prunedChainIds = []
    for (const [chainId, chain] of Object.entries(state.chains)) {
      if (!isPlainObject(chain)) continue
      const messages = messagesByChain.get(chainId) ?? []
      if (messages.length === 0) {
        if (chain.state === 'closed' && Number.isSafeInteger(chain.closedAt) && chain.closedAt + metadataMs <= now) {
          prunedChainIds.push(chainId)
          changed = true
        }
        continue
      }
      let terminal = true
      for (const message of messages) {
        if (message.status === 'unknown' || ACTIVE_QUEUE_STATUSES.has(message.status)) {
          terminal = false
          break
        }
        const completedAt = this.#completedAtFor(message, state)
        if (completedAt === undefined || completedAt + metadataMs > now) {
          terminal = false
          break
        }
      }
      if (!terminal) continue
      for (const message of messages) prunedIds.add(message.id)
      prunedMessages += messages.length
      prunedChainIds.push(chainId)
      changed = true
    }
    if (prunedIds.size > 0) {
      state.messages = state.messages.filter((message) => !prunedIds.has(message.id))
      if (isPlainObject(state.transfers)) {
        for (const id of prunedIds) delete state.transfers[id]
      }
    }
    for (const chainId of prunedChainIds) {
      delete state.chains[chainId]
      prunedChains += 1
    }

    const operationCutoff = now - LIMITS.OPERATION_RETENTION_MS
    let prunedOperations = 0
    const operations = {}
    for (const [key, operation] of Object.entries(state.operations)) {
      if (isPlainObject(operation) && Number.isSafeInteger(operation.at) && operation.at < operationCutoff) {
        prunedOperations += 1
        changed = true
        continue
      }
      operations[key] = operation
    }
    state.operations = operations

    // Create journals: the private task body is dropped as soon as the first
    // message exists; only terminal records age out after the same 90-day
    // operation window, and non-terminal/uncertain records are never cleaned.
    // A pruned record cannot revive an old operationId: first submission
    // still has to pass the 24-hour operationId window.
    let prunedCreates = 0
    if (isPlainObject(state.creates)) {
      const keptCreates = {}
      for (const [key, journal] of Object.entries(state.creates)) {
        if (!isPlainObject(journal)) {
          keptCreates[key] = journal
          continue
        }
        if (journal.phase === 'sent' && journal.bodyStripped !== true && journal.firstMessageId !== null) {
          journal.task = ''
          journal.subject = null
          journal.bodyStripped = true
          journal.updatedAt = now
          changed = true
        }
        if (
          CREATE_TERMINAL_PHASES.includes(journal.phase) &&
          Number.isSafeInteger(journal.terminalAt) &&
          journal.terminalAt < operationCutoff
        ) {
          const firstId = journal.firstMessageId
          const hasFirst = typeof firstId === 'string' && firstId.length > 0
          let mayPrune = !hasFirst
          if (hasFirst) {
            const linked = state.messages.find((candidate) => candidate.id === firstId)
            if (linked !== undefined) {
              if (linked.status === 'unknown' || ACTIVE_QUEUE_STATUSES.has(linked.status)) {
                // Unknown and undelivered first messages keep their root
                // association forever, exactly like the message side.
                mayPrune = false
              } else {
                // A real terminal state ages from its own completion time,
                // never from the earlier root terminalAt anchor.
                const completedAt = terminalCompletedAt.get(firstId)
                mayPrune = Number.isSafeInteger(completedAt) && completedAt < operationCutoff
              }
            } else {
              const verified = terminalCompletedAt.get(firstId)
              if (verified === undefined) {
                // Missing without same-round verified terminal evidence:
                // fail closed, keep the journal, and flag it for review.
                mayPrune = false
                if (journal.error === null) {
                  journal.error = {
                    code: 'first_message_evidence_missing',
                    message:
                      'the associated first message cannot be verified; this create journal is kept for manual review',
                  }
                  journal.updatedAt = now
                  changed = true
                }
              } else {
                mayPrune = verified < operationCutoff
              }
            }
          }
          if (mayPrune) {
            prunedCreates += 1
            changed = true
            continue
          }
        }
        keptCreates[key] = journal
      }
      state.creates = keptCreates
    }

    this.#lastCleanup = { timedOut, redacted, prunedMessages, prunedOperations, prunedChains, prunedCreates }
    return changed
  }

  /**
   * Completion time anchored on explicit terminal evidence. An open request
   * still waiting for a reply is not terminal; answered/timed-out/ended or a
   * request in an explicitly closed group is. Missing evidence stays absent
   * and retention keeps the record.
   * @param {Record<string, any>} message
   * @param {Record<string, any>} state
   * @returns {number | undefined}
   */
  #completedAtFor(message, state) {
    if (Number.isSafeInteger(message.completedAt)) return message.completedAt
    if (message.status === 'failed' && Number.isSafeInteger(message.failedAt)) return message.failedAt
    if (message.status === 'cancelled' && Number.isSafeInteger(message.cancelledAt)) return message.cancelledAt
    if (message.kind === 'notification' || message.kind === 'reply') {
      if (message.receipt?.policy === 'context') {
        return message.receipt.state === 'received' && Number.isSafeInteger(message.receipt.receivedAt)
          ? message.receipt.receivedAt
          : undefined
      }
      return message.status === 'accepted' && Number.isSafeInteger(message.acceptedAt) ? message.acceptedAt : undefined
    }
    if (message.kind === 'request') {
      if (message.replyStatus === 'answered' && Number.isSafeInteger(message.answeredAt)) return message.answeredAt
      if (message.replyStatus === 'timed_out' && Number.isSafeInteger(message.timedOutAt)) return message.timedOutAt
      if (message.status === 'accepted' && message.replyStatus === 'waiting') {
        const chain = state.chains[message.chainId]
        if (chain?.state === 'closed' && Number.isSafeInteger(chain.closedAt)) return chain.closedAt
      }
    }
    return undefined
  }

  /**
   * @param {Record<string, any>} state
   * @param {number} now
   * @returns {{ queued: number, resumed: number }}
   */
  #reconcileGlobalQueue(state, now) {
    let queued = 0
    let resumed = 0
    const settings = state.settings
    if (!settings.enabled) {
      // Disabling is a durable queueing transition, not just a read-time gate:
      // pending rows become held('disabled') in the same settings mutation so
      // the panel state machine never claims an undelivered row is waiting to
      // dispatch while session-link is closed.
      for (const message of state.messages) {
        if (message.status !== 'pending') continue
        if (state.chains[message.chainId] === undefined) continue
        message.status = 'held'
        message.heldAt = now
        message.heldReason = 'disabled'
        message.error = { code: 'disabled', message: 'held until session-link is enabled again' }
        delete message.heldOverflow
        message.releaseAuthorized = false
        queued += 1
      }
    } else if (settings.paused) {
      for (const message of state.messages) {
        if (message.status !== 'pending') continue
        if (state.chains[message.chainId]?.state !== 'open') continue
        message.status = 'held'
        message.heldAt = now
        message.heldReason = 'paused'
        message.error = { code: 'paused', message: 'held until the global pause is cleared' }
        delete message.heldOverflow
        message.releaseAuthorized = false
        queued += 1
      }
    } else {
      for (const message of state.messages) {
        if (!isAutomaticHeld(message)) continue
        if (state.chains[message.chainId]?.state !== 'open') continue
        message.status = 'pending'
        message.heldAt = null
        message.heldReason = null
        message.autoResumedAt = now
        message.error = null
        delete message.heldOverflow
        message.releaseAuthorized = false
        resumed += 1
      }
    }
    return { queued, resumed }
  }

  /**
   * On owner resume of one chain, automatic global held rows can continue when
   * the global settings are open. Owner/unknown legacy held rows stay.
   * @param {Record<string, any>} state
   * @param {Record<string, any>} chain
   * @param {number} now
   * @returns {number}
   */
  #resumeChainHeld(state, chain, now) {
    if (!state.settings.enabled || state.settings.paused) return 0
    let resumed = 0
    for (const message of state.messages) {
      if (message.chainId !== chain.id) continue
      if (!isAutomaticHeld(message)) continue
      message.status = 'pending'
      message.heldAt = null
      message.heldReason = null
      message.autoResumedAt = now
      message.error = null
      delete message.heldOverflow
      message.releaseAuthorized = false
      resumed += 1
    }
    return resumed
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
    const result = await this.#trackOperation(() => this.#send(request))
    this.#schedulePump()
    return result
  }

  async #send(request) {
    const object = assertPlainObject(request, 'send request')
    assertAllowedKeys(
      object,
      ['from', 'fromTitle', 'targets', 'kind', 'text', 'operationId', 'parentMessageId', 'references', 'paths', 'subject'],
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
    const subject = normalizeSubject(object.subject)
    const content = normalizeContent({
      text: object.text,
      references: object.references,
      paths: object.paths,
    })
    assertSubjectEnvelope(subject, content.bytes)
    assertCallBytes(
      {
        targets: object.targets,
        kind,
        text: object.text,
        operationId: object.operationId,
        ...(object.parentMessageId === undefined ? {} : { parentMessageId: object.parentMessageId }),
        ...(object.references === undefined ? {} : { references: object.references }),
        ...(object.paths === undefined ? {} : { paths: object.paths }),
        ...(subject === undefined ? {} : { subject }),
      },
      'send call',
    )
    const fingerprint = callFingerprint({
      kind,
      text: content.text,
      references: content.references,
      paths: content.paths,
      parentMessageId: parentMessageId ?? null,
      targets,
      subject,
    })
    // An operationId owned by a create journal's first-message reservation is
    // only usable for the exact reserved dispatch; anything else conflicts
    // before it could consume or overwrite the reservation.
    const existingState = this.ledger.read()
    const sendReservation = findCreateSendReservation(existingState, from, operationId)
    if (
      sendReservation !== undefined &&
      !createReservationExact(sendReservation, {
        kind,
        targets,
        text: content.text,
        references: content.references,
        paths: content.paths,
        subject: subject ?? null,
        parentMessageId: parentMessageId ?? null,
      })
    ) {
      throw fail('conflict_operation', 'operationId is reserved for a create first message; the payload must match exactly', {
        operationId,
      })
    }
    // Idempotent retry must win before eligibility is rechecked: a target may
    // have been archived since the original call, yet the caller is entitled
    // to the original per-target statuses and no resend.
    const existingOperation = this.#lookupOperation(existingState, from, operationId)
    if (existingOperation !== undefined) {
      if (!fingerprintMatches(existingOperation.fingerprint, fingerprint)) {
        throw fail('conflict_operation', 'operationId was already used with different content, kind, targets, or parent', {
          operationId,
        })
      }
      return this.#operationResult(existingState, existingOperation)
    }
    await this.#requireSender(from)
    const targetInfo = new Map()
    for (const target of targets) targetInfo.set(target, await this.#requireTarget(target))
    const fromInfo = await this.adapter.getSession(from, { fresh: true })
    const fromTitle = optionalString(object.fromTitle, 'fromTitle', { max: 500 }) ?? fromInfo?.title ?? from

    const now = this.clock()
    let created = []
    const result = await this.#mutate(
      (state) => {
        const duplicate = this.#lookupOperation(state, from, operationId)
        if (duplicate !== undefined) {
          if (!fingerprintMatches(duplicate.fingerprint, fingerprint)) {
            throw fail('conflict_operation', 'operationId was already used with different content, kind, targets, or parent', {
              operationId,
            })
          }
          return skipMutation(this.#operationResult(state, duplicate))
        }
        validateOperationId(operationId, now)
        if (!state.settings.enabled) throw fail('disabled', 'session-link is disabled; enable it in settings first')

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
        } else {
          chain = {
            id: this.uuid(),
            rootOwner: from,
            createdAt: now,
            state: 'open',
            messageCount: 0,
          }
          state.chains[chain.id] = chain
        }

        const reservedForSend = findCreateSendReservation(state, from, operationId)
        this.#assertQueueCapacity(
          state,
          (content.bytes + subjectPayloadBytes(subject)) * targets.length,
          createReservationExact(reservedForSend, {
            kind,
            targets,
            text: content.text,
            references: content.references,
            paths: content.paths,
            subject: subject ?? null,
            parentMessageId: parentMessageId ?? null,
          })
            ? reservedForSend
            : undefined,
        )
        const held = state.settings.paused
        const messageIds = {}
        const existingCount = chainMessages(state, chain.id).length
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
            chainId: chain.id,
            replyTo: parentMessageId ?? null,
            parentMessageId: parentMessageId ?? null,
            hop,
            createdAt: now,
            acceptedAt: null,
            completedAt: null,
            deadlineAt: null,
            timedOutAt: null,
            lateReplyAt: null,
            content: structuredClone(content),
            contentBytes: content.bytes,
            subject: subject ?? null,
            status: held ? 'held' : 'pending',
            replyStatus: 'none',
            receipt: createReceipt('context'),
            deliveryAttempts: 0,
            durableMessageId: null,
            error: held
              ? { code: 'paused', message: 'held until the global pause is cleared' }
              : null,
            heldAt: held ? now : null,
            heldReason: held ? 'paused' : null,
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
          fingerprint: sealFingerprint(fingerprint),
          targets: [...targets],
          messageIds,
          at: now,
        }
        created = Object.values(messageIds)
        return {
          operationId,
          idempotent: false,
          chainId: chain.id,
          held,
          results: targets.map((target) => ({
            target,
            id: messageIds[target],
            status: held ? 'held' : 'pending',
            error: held ? { code: 'paused', message: 'held until the global pause is cleared' } : null,
          })),
        }
      },
      { delivery: true },
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
    const result = await this.#trackOperation(() => this.#reply(request))
    this.#schedulePump()
    return result
  }

  async #reply(request) {
    const object = assertPlainObject(request, 'reply request')
    assertAllowedKeys(
      object,
      ['from', 'fromTitle', 'messageId', 'text', 'operationId', 'references', 'paths', 'subject'],
      'reply request',
    )
    const from = requiredString(object.from, 'from', { min: 1, max: 256 })
    const parentMessageId = requiredString(object.messageId, 'messageId', { min: 1, max: 256 })
    const operationId = requiredString(object.operationId, 'operationId', { max: 128 })
    const subject = normalizeSubject(object.subject)
    const content = normalizeContent({
      text: object.text,
      references: object.references,
      paths: object.paths,
    })
    assertSubjectEnvelope(subject, content.bytes)
    assertCallBytes(
      {
        messageId: object.messageId,
        text: object.text,
        operationId: object.operationId,
        ...(object.references === undefined ? {} : { references: object.references }),
        ...(object.paths === undefined ? {} : { paths: object.paths }),
        ...(subject === undefined ? {} : { subject }),
      },
      'reply call',
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
      subject,
    })
    const existingState = this.ledger.read()
    const replyReservation = findCreateSendReservation(existingState, from, operationId)
    if (replyReservation !== undefined) {
      // A reply can never be the reserved first message (kind differs), so
      // reusing that internal id conflicts instead of consuming the reserve.
      throw fail('conflict_operation', 'operationId is reserved for a create first message and cannot be reused', {
        operationId,
      })
    }
    const existingOperation = this.#lookupOperation(existingState, from, operationId)
    if (existingOperation !== undefined) {
      if (!fingerprintMatches(existingOperation.fingerprint, fingerprint)) {
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
    const result = await this.#mutate(
      (state) => {
        const duplicate = this.#lookupOperation(state, from, operationId)
        if (duplicate !== undefined) {
          if (!fingerprintMatches(duplicate.fingerprint, fingerprint)) {
            throw fail('conflict_operation', 'operationId was already used with different content or parent', { operationId })
          }
          return skipMutation(this.#operationResult(state, duplicate))
        }
        validateOperationId(operationId, now)
        if (!state.settings.enabled) throw fail('disabled', 'session-link is disabled; enable it in settings first')
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
        this.#assertQueueCapacity(state, content.bytes + subjectPayloadBytes(subject))
        const held = state.settings.paused
        const existingCount = chainMessages(state, currentParent.chainId).length
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
          hop: nextHop,
          createdAt: now,
          acceptedAt: null,
          completedAt: null,
          deadlineAt: null,
          timedOutAt: null,
          late: currentParent.replyStatus === 'timed_out',
          content: structuredClone(content),
          contentBytes: content.bytes,
          subject: subject ?? null,
          status: held ? 'held' : 'pending',
          replyStatus: 'none',
          receipt: createReceipt('context'),
          deliveryAttempts: 0,
          durableMessageId: null,
          error: held
            ? { code: 'paused', message: 'held until the global pause is cleared' }
            : null,
          heldAt: held ? now : null,
          heldReason: held ? 'paused' : null,
        }
        state.messages.push(message)
        currentChain.messageCount = existingCount + 1
        const operationKey = this.#operationKey(from, operationId, [currentParent.from])
        state.operations[operationKey] = {
          key: operationKey,
          from,
          operationId,
          fingerprint: sealFingerprint(fingerprint),
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
  // Create session + first task
  // -------------------------------------------------------------------------

  /**
   * Create one ordinary session in an explicit location and deliver its first
   * task message through the standard agent-message relay. Every external
   * effect is preceded by a durable journal update; a crash during an effect
   * becomes `uncertain` and is never rebuilt automatically. One caller +
   * operationId may only ever run one effect sequence in this process.
   * @param {Record<string, unknown>} request
   * @returns {Promise<Record<string, any>>}
   */
  async create(request) {
    const parsed = parseCreateRequest(request)
    const key = `${parsed.from}|${parsed.operationId}`
    const pending = this.#createsInFlight.get(key)
    if (pending !== undefined) {
      // Same root operationId with different normalized inputs is a conflict
      // even while the first call is still running.
      if (pending.fingerprint !== parsed.fingerprint) {
        throw fail('conflict_operation', 'operationId is already creating a session with different inputs', {
          operationId: parsed.operationId,
        })
      }
      return pending.promise
    }
    const run = this.#trackOperation(() => this.#create(parsed, key))
    this.#createsInFlight.set(key, { fingerprint: parsed.fingerprint, promise: run })
    try {
      return await run
    } finally {
      if (this.#createsInFlight.get(key)?.promise === run) this.#createsInFlight.delete(key)
    }
  }

  /** @param {ReturnType<typeof parseCreateRequest>} input @param {string} key */
  async #create(input, key) {
    const { from, operationId, fingerprint, location } = input
    const existingState = this.ledger.read()
    const existing = this.#lookupOperation(existingState, from, operationId)
    if (existing !== undefined) {
      // A send/reply fingerprint can never equal a create fingerprint, so a
      // matching record means this exact create operation already exists.
      if (!fingerprintMatches(existing.fingerprint, fingerprint)) {
        throw fail('conflict_operation', 'operationId was already used with different content, kind, targets, or parent', {
          operationId,
        })
      }
      return this.#createAdvance(key, { idempotent: true })
    }
    const now = this.clock()
    validateOperationId(operationId, now)
    if (!existingState.settings.enabled) {
      throw fail('disabled', 'session-link is disabled; enable it in settings first')
    }
    if (existingState.settings.paused) {
      throw fail('paused', 'session-link is paused; clear the global pause before creating a session')
    }
    await this.#requireSender(from)
    // Capability boundary: checked here, before the journal exists, so a host
    // without create/rename/workspace keeps mounting the original plugin.
    await this.adapter.assertCreateCapabilities()

    // Read-only location resolution; any failure precedes the journal and the
    // first external effect, so it is a clean rejection with no side effects.
    let resolvedWorkspacePath = null
    if (location.kind === 'workspace') {
      const workspace = await this.adapter.getWorkspace(location.workspaceId)
      location.workspaceTitle = workspace.title
      resolvedWorkspacePath = workspace.path
    } else {
      if (location.kind === 'existing_project') {
        const project = await this.adapter.checkExistingProjectPath(location.workspacePath)
        location.workspacePath = project.path
        resolvedWorkspacePath = project.path
      } else {
        await this.adapter.checkProjectLocation({
          parentDir: location.parentDir,
          directoryName: location.directoryName,
        })
      }
    }

    // A pure-random reserved id, proven absent before it is offered. Even a
    // proven-absent id never proves a transaction: the host may still return
    // a different identity, and that replacement is recorded, not hidden.
    const requestedSessionId = `session-${this.uuid()}`
    if (await this.adapter.sessionExists(requestedSessionId)) {
      throw fail('session_id_collision', 'the reserved session id already exists; refusing to create', {
        requestedSessionId,
      })
    }

    const sendOperationId = mintOperationId(this.uuid(), now)
    const journal = {
      key,
      from,
      operationId,
      fingerprint: sealFingerprint(fingerprint),
      at: now,
      updatedAt: now,
      phase: 'creating',
      task: input.task,
      subject: input.subject ?? null,
      title: input.resolvedTitle,
      location: structuredClone(location),
      requestedSessionId,
      sessionId: null,
      workspaceId: location.kind === 'workspace' ? location.workspaceId : null,
      workspacePath: resolvedWorkspacePath,
      renameStatus: 'not_attempted',
      renameError: null,
      sendOperationId,
      firstMessageId: null,
      error: null,
      terminalAt: null,
      bodyStripped: false,
    }
    const claimed = await this.#mutate(
      (state) => {
        const duplicate = this.#lookupCreate(state, from, operationId)
        if (duplicate !== undefined) {
          if (!fingerprintMatches(duplicate.fingerprint, fingerprint)) {
            throw fail('conflict_operation', 'operationId was already used with different create inputs', { operationId })
          }
          return skipMutation(false)
        }
        // The intent body joins the same 16 MiB undelivered envelope, checked
        // before this journal is persisted and before any external effect.
        this.#assertQueueCapacity(state, createJournalPayloadBytes(state, journal))
        state.creates = { ...(state.creates ?? {}), [key]: structuredClone(journal) }
        return true
      },
      { delivery: true },
    )
    if (claimed !== true) return this.#createAdvance(key, { idempotent: true })
    return this.#runCreateEffects(key, { idempotent: false })
  }

  /**
   * Run the external effect chain for a journal this process just created.
   * Each effect persists its real outcome before the next effect starts; a
   * failure after the first side effect is reported in the returned view.
   * @param {string} key
   * @param {{ idempotent: boolean }} options
   */
  async #runCreateEffects(key, options) {
    let journal = this.#createJournal(key)
    if (journal === undefined) throw fail('internal', 'create journal disappeared')

    if (journal.location.kind === 'new_project' && journal.workspacePath === null) {
      let directory
      try {
        directory = await this.adapter.ensureProjectDirectory({
          parentDir: journal.location.parentDir,
          directoryName: journal.location.directoryName,
        })
      } catch (error) {
        await this.#journalCreateFailure(key, error)
        return this.#createView(key, options.idempotent)
      }
      await this.#mutate(
        (state) => {
          const current = state.creates?.[key]
          if (current === undefined) return skipMutation(undefined)
          current.workspacePath = directory.path
          current.updatedAt = this.clock()
          return true
        },
        { delivery: true },
      )
    }

    journal = this.#createJournal(key)
    if (journal.workspaceId === null) {
      let workspace
      try {
        workspace = await this.adapter.createWorkspace(
          journal.workspacePath,
          journal.location.workspaceTitle ?? (journal.location.kind === 'existing_project' ? undefined : journal.title),
        )
      } catch (error) {
        await this.#journalCreateFailure(key, error)
        return this.#createView(key, options.idempotent)
      }
      await this.#mutate(
        (state) => {
          const current = state.creates?.[key]
          if (current === undefined) return skipMutation(undefined)
          current.workspaceId = workspace.id
          current.workspacePath = workspace.path
          current.location.workspaceTitle = workspace.title
          current.updatedAt = this.clock()
          return true
        },
        { delivery: true },
      )
    }

    journal = this.#createJournal(key)
    if (journal.sessionId === null) {
      let created
      try {
        created = await this.adapter.createSession({
          workspaceId: journal.workspaceId,
          sessionId: journal.requestedSessionId,
        })
      } catch (error) {
        // The host attach failure carries the real created id in its details;
        // a pre-create rejection proves no session; anything else may have
        // created a session, so the operation stops as uncertain.
        const actualId = typeof error?.details?.sessionId === 'string' ? error.details.sessionId : null
        if (actualId !== null && actualId.length > 0) {
          await this.#mutate(
            (state) => {
              const current = state.creates?.[key]
              if (current === undefined) return skipMutation(undefined)
              current.sessionId = actualId
              current.phase = 'attach_failed'
              current.terminalAt = this.clock()
              current.error = createErrorView(error)
              current.updatedAt = this.clock()
              return true
            },
            { delivery: true },
          )
          return this.#createView(key, options.idempotent)
        }
        if (PRE_CREATE_FAILURE_CODES.has(errorCode(error))) {
          await this.#journalCreateFailure(key, error)
          return this.#createView(key, options.idempotent)
        }
        await this.#mutate(
          (state) => {
            const current = state.creates?.[key]
            if (current === undefined) return skipMutation(undefined)
            current.phase = 'uncertain'
            current.error = createErrorView(
              error,
              'the create result could not be confirmed; a session may already exist — verify manually and do not delete anything',
            )
            current.updatedAt = this.clock()
            return true
          },
          { delivery: true },
        )
        return this.#createView(key, options.idempotent)
      }
      await this.#mutate(
        (state) => {
          const current = state.creates?.[key]
          if (current === undefined) return skipMutation(undefined)
          current.sessionId = created.sessionId
          current.phase = 'created'
          current.error = null
          current.updatedAt = this.clock()
          return true
        },
        { delivery: true },
      )
      // The host create return only proves publication, not durability. The
      // actual live agent must flush before this is reported as persistent or
      // before the first message; a failed barrier is an actionable partial
      // result and is never a reason to rebuild the session.
      const barrier = await this.adapter.confirmSessionDurable(created.sessionId)
      if (barrier.ok !== true) {
        await this.#mutate(
          (state) => {
            const current = state.creates?.[key]
            if (current === undefined) return skipMutation(undefined)
            current.error = { code: barrier.code, message: barrier.message.slice(0, 400) }
            current.updatedAt = this.clock()
            return true
          },
          { delivery: true },
        )
        return this.#createView(key, options.idempotent)
      }
    }

    return this.#createAdvance(key, options)
  }

  /**
   * Idempotent continuation of an existing journal: `creating` (a crash or a
   * stuck effect whose result cannot be proven) becomes `uncertain` and never
   * re-runs an effect; terminal phases replay their real state; otherwise the
   * flow resumes rename-once then the first send with the persisted
   * sendOperationId, which the standard send path deduplicates.
   * @param {string} key
   * @param {{ idempotent: boolean }} options
   */
  async #createAdvance(key, options) {
    let journal = this.#createJournal(key)
    if (journal === undefined) throw fail('internal', 'create journal disappeared')
    if (journal.phase === 'creating') {
      await this.#mutate(
        (state) => {
          const current = state.creates?.[key]
          if (current === undefined || current.phase !== 'creating') return skipMutation(undefined)
          current.phase = 'uncertain'
          current.error = createErrorView(
            fail(
              'create_interrupted',
              'the plugin restarted while a create effect may have been in flight; verify the workspace/session manually before retrying',
            ),
          )
          current.updatedAt = this.clock()
          return true
        },
        { delivery: true },
      )
      journal = this.#createJournal(key)
    }
    const phase = journal.phase
    if (phase === 'uncertain' || phase === 'sent' || phase === 'attach_failed' || phase === 'failed') {
      return this.#createView(key, options.idempotent)
    }

    await this.#requireSender(journal.from)
    const settings = this.ledger.read().settings
    if (!settings.enabled) {
      throw fail('disabled', 'session-link is disabled; enable it in settings first')
    }

    // Durability fence: never continue to rename or the first message unless
    // the created session's live agent confirms the host flush. A failed
    // barrier returns the real partial state; it never rebuilds anything.
    const barrier = await this.adapter.confirmSessionDurable(journal.sessionId)
    if (barrier.ok !== true) {
      await this.#mutate(
        (state) => {
          const current = state.creates?.[key]
          if (current === undefined) return skipMutation(undefined)
          current.error = { code: barrier.code, message: barrier.message.slice(0, 400) }
          current.updatedAt = this.clock()
          return true
        },
        { delivery: true },
      )
      return this.#createView(key, options.idempotent)
    }
    if (journal.error !== null) {
      await this.#mutate(
        (state) => {
          const current = state.creates?.[key]
          if (current === undefined || current.error === null) return skipMutation(undefined)
          current.error = null
          current.updatedAt = this.clock()
          return true
        },
        { delivery: true },
      )
      journal = this.#createJournal(key)
    }

    // Rename exactly once, after the real id is persisted and before the
    // first send. An interrupted claim is recorded as a failed rename, never
    // re-attempted automatically; a rename failure never blocks the first task.
    if (journal.renameStatus === 'pending') {
      await this.#mutate(
        (state) => {
          const current = state.creates?.[key]
          if (current === undefined || current.renameStatus !== 'pending') return skipMutation(undefined)
          current.renameStatus = 'rename_failed'
          current.renameError = 'interrupted'
          current.phase = 'rename_failed'
          current.updatedAt = this.clock()
          return true
        },
        { delivery: true },
      )
      journal = this.#createJournal(key)
    }
    if (journal.renameStatus === 'not_attempted' && journal.sessionId !== null) {
      await this.#mutate(
        (state) => {
          const current = state.creates?.[key]
          if (current === undefined || current.renameStatus !== 'not_attempted') return skipMutation(undefined)
          current.renameStatus = 'pending'
          current.updatedAt = this.clock()
          return true
        },
        { delivery: true },
      )
      try {
        await this.adapter.renameSession(journal.sessionId, journal.title)
        await this.#mutate(
          (state) => {
            const current = state.creates?.[key]
            if (current === undefined) return skipMutation(undefined)
            current.renameStatus = 'renamed'
            current.renameError = null
            current.phase = 'renamed'
            current.updatedAt = this.clock()
            return true
          },
          { delivery: true },
        )
      } catch (error) {
        await this.#mutate(
          (state) => {
            const current = state.creates?.[key]
            if (current === undefined) return skipMutation(undefined)
            current.renameStatus = 'rename_failed'
            current.renameError = errorCode(error)
            current.phase = 'rename_failed'
            current.updatedAt = this.clock()
            return true
          },
          { delivery: true },
        )
      }
      journal = this.#createJournal(key)
    }

    if (journal.sessionId === null) return this.#createView(key, options.idempotent)

    const priorMessage =
      typeof journal.firstMessageId === 'string' && journal.firstMessageId.length > 0
        ? this.ledger.read().messages.find((candidate) => candidate.id === journal.firstMessageId)
        : undefined
    if (typeof journal.firstMessageId === 'string' && journal.firstMessageId.length > 0 && priorMessage === undefined) {
      // The recorded first message is gone (pruned or corrupt): never guess
      // whether it was delivered and never send again.
      await this.#mutate(
        (state) => {
          const current = state.creates?.[key]
          if (current === undefined || current.phase === 'uncertain') return skipMutation(undefined)
          current.phase = 'uncertain'
          current.error = {
            code: 'first_message_evidence_missing',
            message: 'the recorded first message can no longer be verified; delivery is unknown and will not be retried automatically',
          }
          current.updatedAt = this.clock()
          return true
        },
        { delivery: true },
      )
      return this.#createView(key, options.idempotent)
    }
    const priorFailed = priorMessage !== undefined && priorMessage.status === 'failed'
    if (priorMessage !== undefined && !priorFailed) {
      // accepted / held / pending / dispatching / unknown / cancelled keep
      // their original status; unknown is never re-sent. Reconcile a crash
      // window where the message exists but the journal never reached `sent`.
      if (journal.phase !== 'sent') {
        await this.#mutate(
          (state) => {
            const current = state.creates?.[key]
            if (current === undefined || current.phase === 'sent') return skipMutation(undefined)
            current.phase = 'sent'
            current.terminalAt = this.clock()
            current.error = null
            current.task = ''
            current.subject = null
            current.bodyStripped = true
            current.updatedAt = this.clock()
            return true
          },
          { delivery: true },
        )
      }
      return this.#createView(key, options.idempotent)
    }

    // Owed: no first message yet, or the previous attempt failed before the
    // host accepted it (standard send fails only before steer, so a failed
    // record is provably un-inserted and an explicit same-operation retry may
    // continue to the SAME session).
    if (typeof journal.task !== 'string' || journal.task.length === 0) {
      await this.#mutate(
        (state) => {
          const current = state.creates?.[key]
          if (current === undefined) return skipMutation(undefined)
          current.error = {
            code: 'first_task_body_missing',
            message: 'the stored first task body is no longer present; it will not be reconstructed',
          }
          current.updatedAt = this.clock()
          return true
        },
        { delivery: true },
      )
      return this.#createView(key, options.idempotent)
    }

    let sendOperationId = journal.sendOperationId
    if (priorFailed) {
      // The failed message record itself is the proof of an un-inserted
      // attempt, so a fresh persistent internal id is safe.
      sendOperationId = mintOperationId(this.uuid(), this.clock())
      await this.#mutate(
        (state) => {
          const current = state.creates?.[key]
          if (current === undefined) return skipMutation(undefined)
          current.sendOperationId = sendOperationId
          current.updatedAt = this.clock()
          return true
        },
        { delivery: true },
      )
    } else {
      const stateNow = this.ledger.read()
      const priorOperation = Object.values(stateNow.operations).some(
        (candidate) => candidate?.from === journal.from && candidate?.operationId === journal.sendOperationId,
      )
      const priorAnyMessage = stateNow.messages.some(
        (candidate) => candidate.operationId === journal.sendOperationId,
      )
      if (!priorOperation && !priorAnyMessage) {
        let submittable = true
        try {
          validateOperationId(journal.sendOperationId, this.clock())
        } catch {
          submittable = false
        }
        if (!submittable) {
          // Reissuing an expired internal id is allowed only with durable
          // proof it was never submitted: in never-attempted phases the send
          // was never called; in `sending` the absence of any operation or
          // message inside the 90-day tombstone horizon proves no record was
          // created-then-pruned. Otherwise the outcome stays unknown.
          const mintAt = parseOperationMintTime(journal.sendOperationId)
          const neverAttempted =
            journal.phase === 'created' || journal.phase === 'renamed' || journal.phase === 'rename_failed'
          const withinHorizon =
            mintAt !== null && this.clock() - mintAt <= LIMITS.OPERATION_RETENTION_MS
          if (neverAttempted || withinHorizon) {
            sendOperationId = mintOperationId(this.uuid(), this.clock())
            const reissued = sendOperationId
            await this.#mutate(
              (state) => {
                const current = state.creates?.[key]
                if (current === undefined) return skipMutation(undefined)
                current.sendOperationId = reissued
                current.updatedAt = this.clock()
                return true
              },
              { delivery: true },
            )
          } else {
            await this.#mutate(
              (state) => {
                const current = state.creates?.[key]
                if (current === undefined || current.phase === 'uncertain') return skipMutation(undefined)
                current.phase = 'uncertain'
                current.error = {
                  code: 'create_send_unprovable',
                  message:
                    'the internal first-message id expired without durable proof that it was never submitted; delivery stays unknown and is not retried automatically',
                }
                current.updatedAt = this.clock()
                return true
              },
              { delivery: true },
            )
            return this.#createView(key, options.idempotent)
          }
        }
      }
      // Otherwise the old id already owns a durable operation/message: reuse
      // it unchanged so the standard send path deduplicates instead of
      // inserting a second time.
    }

    if (journal.phase !== 'sending') {
      await this.#mutate(
        (state) => {
          const current = state.creates?.[key]
          if (current === undefined || current.firstMessageId !== null) return skipMutation(undefined)
          current.phase = 'sending'
          current.updatedAt = this.clock()
          return true
        },
        { delivery: true },
      )
    }
    try {
      // The persisted sendOperationId makes this call idempotent inside the
      // standard send path: an already-inserted first message is returned,
      // never inserted a second time.
      const result = await this.send({
        from: journal.from,
        targets: [journal.sessionId],
        kind: 'request',
        text: journal.task,
        ...(journal.subject === null || journal.subject === undefined ? {} : { subject: journal.subject }),
        operationId: sendOperationId,
      })
      const messageId = result?.results?.[0]?.id
      if (typeof messageId !== 'string' || messageId.length === 0) {
        throw fail('internal', 'the first message id is missing from the send result')
      }
      const recorded = this.ledger.read().messages.find((candidate) => candidate.id === messageId)
      if (recorded === undefined) {
        // Evidence is insufficient to classify the attempt: mark unknown and
        // do not send again.
        await this.#mutate(
          (state) => {
            const current = state.creates?.[key]
            if (current === undefined || current.phase === 'uncertain') return skipMutation(undefined)
            current.firstMessageId = messageId
            current.phase = 'uncertain'
            current.error = {
              code: 'first_message_evidence_missing',
              message: 'the first message record cannot be verified; delivery is unknown and will not be retried automatically',
            }
            current.updatedAt = this.clock()
            return true
          },
          { delivery: true },
        )
        return this.#createView(key, options.idempotent)
      }
      if (recorded.status === 'failed') {
        // Provably un-inserted: keep the body and the `sending` phase so an
        // explicit retry of this same root operation re-sends to the same
        // session with a fresh internal id.
        await this.#mutate(
          (state) => {
            const current = state.creates?.[key]
            if (current === undefined) return skipMutation(undefined)
            current.firstMessageId = messageId
            current.phase = 'sending'
            current.error = {
              code: recorded.error?.code ?? 'first_send_failed',
              message:
                recorded.error?.message ??
                'the first message was not accepted by the host; retry this same operation to continue to the same session',
            }
            current.updatedAt = this.clock()
            return true
          },
          { delivery: true },
        )
        return this.#createView(key, options.idempotent)
      }
      await this.#mutate(
        (state) => {
          const current = state.creates?.[key]
          if (current === undefined) return skipMutation(undefined)
          current.firstMessageId = messageId
          current.phase = 'sent'
          current.terminalAt = this.clock()
          current.error = null
          // The delivered message owns the body now; the journal keeps only
          // fingerprint, status, and association.
          current.task = ''
          current.subject = null
          current.bodyStripped = true
          current.updatedAt = this.clock()
          return true
        },
        { delivery: true },
      )
    } catch (error) {
      await this.#mutate(
        (state) => {
          const current = state.creates?.[key]
          if (current === undefined) return skipMutation(undefined)
          current.error = createErrorView(error)
          current.updatedAt = this.clock()
          return true
        },
        { delivery: true },
      )
    }

    return this.#createView(key, options.idempotent)
  }

  /** @param {string} key @returns {Record<string, any> | undefined} */
  #createJournal(key) {
    return this.ledger.read().creates?.[key]
  }

  /** @param {string} key @param {unknown} error */
  async #journalCreateFailure(key, error) {
    await this.#mutate(
      (state) => {
        const current = state.creates?.[key]
        if (current === undefined) return skipMutation(undefined)
        current.phase = 'failed'
        current.terminalAt = this.clock()
        current.error = createErrorView(error)
        current.updatedAt = this.clock()
        return true
      },
      { delivery: true },
    )
  }

  /**
   * @param {string} key
   * @param {boolean} idempotent
   * @returns {Record<string, any>}
   */
  #createView(key, idempotent) {
    const state = this.ledger.read()
    const journal = state.creates?.[key]
    if (journal === undefined) throw fail('internal', 'create journal disappeared')
    let firstMessage = null
    if (journal.firstMessageId !== null) {
      const message = state.messages.find((candidate) => candidate.id === journal.firstMessageId)
      firstMessage = {
        id: journal.firstMessageId,
        status: message?.status ?? 'missing',
        error: message?.error ?? null,
      }
    }
    return {
      operationId: journal.operationId,
      idempotent,
      phase: journal.phase,
      workspace:
        journal.workspaceId !== null
          ? {
              id: journal.workspaceId,
              path: journal.workspacePath,
              title: journal.location.workspaceTitle ?? journal.title,
            }
          : null,
      sessionId: journal.sessionId,
      requestedSessionId: journal.requestedSessionId,
      title: journal.title,
      titleStatus: journal.renameStatus,
      firstMessage,
      sendOperationId: journal.sendOperationId,
      error: journal.error ?? null,
    }
  }

  // -------------------------------------------------------------------------
  // Owner card lookup
  // -------------------------------------------------------------------------

  /**
   * Owner-only bounded lookup for one session's cards. Only messages that
   * participate in `sessionId` (from or to) are returned, with the minimal
   * identity/topic/association/status fields; unknown ids and non-participant
   * records are reported as missing instead of fabricated.
   *
   * Optional `includeBody: true` grants the verified inbound business text
   * for exactly one case: the requested id equals the message's durable host
   * id AND `sessionId` is the recipient. The body is the raw ledger content
   * text (never executed, no paths read, never derived from other records or
   * the journal); a redacted message yields `body: null` with
   * `bodyState: 'redacted'`. Without the grant no body field is added, so the
   * default response shape is unchanged.
   * @param {Record<string, unknown>} request
   * @returns {Record<string, any>}
   */
  cardLookup(request) {
    const object = assertPlainObject(request, 'card_lookup request')
    assertAllowedKeys(object, ['sessionId', 'ids', 'includeBody'], 'card_lookup request')
    if (object.includeBody !== undefined && typeof object.includeBody !== 'boolean') {
      throw fail('invalid_argument', 'includeBody must be a boolean')
    }
    const includeBody = object.includeBody === true
    const sessionId = requiredString(object.sessionId, 'sessionId', { min: 1, max: 256 })
    if (!Array.isArray(object.ids)) throw fail('invalid_argument', 'ids must be an array')
    if (object.ids.length === 0 || object.ids.length > LIMITS.MAX_CARD_LOOKUP_IDS) {
      throw fail(
        'invalid_argument',
        `ids must contain between 1 and ${LIMITS.MAX_CARD_LOOKUP_IDS} entries`,
        { maxIds: LIMITS.MAX_CARD_LOOKUP_IDS },
      )
    }
    const ids = object.ids.map((id, index) => requiredString(id, `ids[${index}]`, { min: 1, max: 512 }))
    const state = this.ledger.read()
    const results = []
    const missing = []
    const emitted = new Set()
    // One durable message is one card, however many of its ids were asked;
    // the entry stays addressable so a later exact durable-id request can
    // still grant the body regardless of id order.
    const entryByMessageId = new Map()
    for (const id of ids) {
      if (emitted.has(id)) continue
      emitted.add(id)
      const message = state.messages.find(
        (candidate) =>
          candidate.id === id ||
          (typeof candidate.durableMessageId === 'string' && candidate.durableMessageId === id),
      )
      if (message === undefined || (message.from !== sessionId && message.to !== sessionId)) {
        missing.push(id)
        continue
      }
      const existingEntry = entryByMessageId.get(message.id)
      if (existingEntry !== undefined) {
        grantInboundBody(existingEntry, message, id, sessionId, includeBody)
        continue
      }
      const entry = {
        id: message.id,
        durableMessageId: message.durableMessageId ?? null,
        from: message.from,
        to: message.to,
        fromTitle: message.fromTitle ?? null,
        toTitle: message.toTitle ?? null,
        kind: message.kind,
        subject: displaySubject(message),
        chainId: message.chainId,
        parentMessageId: message.parentMessageId ?? null,
        status: message.status,
        replyStatus: message.replyStatus,
        receipt: structuredClone(message.receipt ?? null),
      }
      grantInboundBody(entry, message, id, sessionId, includeBody)
      entryByMessageId.set(message.id, entry)
      results.push(entry)
    }
    return { results, missing }
  }

  // -------------------------------------------------------------------------
  // Identity and eligibility
  // -------------------------------------------------------------------------

  /** @param {string} sessionId */
  async #requireSender(sessionId) {
    const info = await this.adapter.getSession(sessionId, { fresh: true })
    if (info === undefined || info === null) throw fail('identity_unregistered', 'caller session is not registered')
    if (info.subagent === true) throw fail('identity_subagent', 'subagent sessions cannot use session-link')
    if (info.archived === true) throw fail('identity_archived', 'archived sessions cannot send')
    if (info.registered === false) throw fail('identity_unregistered', 'caller session is not a registered ordinary session')
    if (info.formatStatus === 'migration-required') throw fail('identity_migration_required', 'caller session requires migration')
    if (info.eligible === false) throw fail('identity_unavailable', 'caller session is not an eligible ordinary session')
  }

  /** @param {string} sessionId */
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
    const acquired = await this.#acquireSlot()
    if (!acquired) return undefined
    try {
      return await task()
    } finally {
      this.#releaseSlot()
    }
  }

  /** @returns {Promise<boolean>} */
  async #acquireSlot() {
    while (true) {
      if (this.#disposed) return false
      const max = this.ledger.read().settings.maxConcurrent
      if (this.#slots < max) {
        this.#slots += 1
        return true
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
   * A settings save that raises maxConcurrent must wake every sleeping slot
   * waiter immediately; the old slot owner may stay blocked in the host. Each
   * waiter loops back through #acquireSlot and re-reads the latest durable cap,
   * so waking all is safe for increases and requeues them for decreases.
   */
  #wakeSlotWaiters() {
    if (this.#disposed) return
    const waiters = this.#waiters.splice(0)
    for (const resolve of waiters) resolve()
  }

  /** @param {string} id */
  async #dispatchOne(id) {
    if (this.#disposed || !this.ledger.writable) return
    const message = this.#message(id)
    if (message === undefined || message.status !== 'pending') return
    const token = { id, aborted: false }
    this.#attempts.add(token)
    try {
      if (this.#disposed || token.aborted) return
      const chain = this.ledger.read().chains[message.chainId]
      if (chain === undefined) {
        await this.#markFailed(id, 'chain_missing', 'chain is missing')
        return
      }
      if (chain.state === 'closed') {
        await this.#cancelPending(id, 'chain_closed', 'chain closed before delivery')
        return
      }
      if (chain.state === 'paused') return
      const preflight = dispatchBlockers(this.ledger.read(), message)
      if (preflight.includes('disabled') || preflight.includes('paused')) {
        await this.#heldIfPending(id, preflight.includes('disabled') ? 'disabled' : 'paused')
        return
      }

      let built
      try {
        built = await this.adapter.buildDelivery(this.#publicMessage(message))
      } catch {
        await this.#markFailed(id, 'message_build_failed', 'host message could not be constructed')
        return
      }
      const durableMessageId = built?.durableMessageId
      if (typeof durableMessageId !== 'string' || durableMessageId.length === 0) {
        await this.#markFailed(id, 'message_build_failed', 'host message id is missing')
        return
      }

      const marked = await this.#mutate((state) => {
        const current = findMessage(state, id)
        if (current?.status !== 'pending') return skipMutation(false)
        current.status = 'dispatching'
        current.durableMessageId = durableMessageId
        current.dispatchStartedAt = this.clock()
        delete current.heldOverflow
        current.deliveryAttempts = (current.deliveryAttempts ?? 0) + 1
        current.error = null
        this.#indexReceiptMessage(current)
        return true
      })
      if (marked !== true) return
      if (this.#disposed || token.aborted) return

      let outcome
      try {
        outcome = await this.adapter.deliver({
          targetId: message.to,
          hostMessage: built.hostMessage,
          beforeResolve: () => this.#gateLive(id, false, token),
          beforeFollowup: () => this.#gateLive(id, true, token),
        })
      } catch (error) {
        outcome = { stage: 'followup', error: { code: errorCode(error) } }
      }
      if (this.#disposed || token.aborted) return
      if (!this.ledger.writable) return
      const classified = classifyDeliveryOutcome(outcome)
      if (classified.status === 'accepted') {
        await this.#acceptMessageById(id, this.clock(), { recoveryEvidence: undefined })
        await this.#reconcileAcceptedPresence(id)
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
      await this.#applyBlocked(id, classified)
    } finally {
      this.#attempts.delete(token)
    }
  }

  /**
   * Recheck the serialized pause/disable gate immediately before resolve and
   * again immediately before followup. There is no business budget reservation
   * here; only the final synchronous commit gate remains.
   * @param {string} id
   * @param {boolean} beforeFollowup
   * @param {{ id: string, aborted: boolean }} token
   */
  async #gateLive(id, beforeFollowup, token) {
    if (this.#disposed || token.aborted) {
      return { ok: false, action: 'cancelled', code: 'disposed', message: 'session-link is shutting down' }
    }
    if (!this.ledger.writable) {
      return { ok: false, action: 'cancelled', code: 'storage_error', message: 'session-link storage is unavailable' }
    }
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
    // Re-read the durable gate synchronously after the async eligibility read.
    // A pause acknowledged while that read was in flight must prevent the
    // followup that would otherwise use the old snapshot.
    if (!this.ledger.writable) {
      return { ok: false, action: 'cancelled', code: 'storage_error', message: 'session-link storage is unavailable' }
    }
    const latest = this.ledger.read()
    const checked = this.#checkLiveState(findMessage(latest, id))
    if (checked.ok === true && beforeFollowup === true) {
      checked.commit = (run) => this.#commitFollowup(id, token, run)
    }
    return checked
  }

  /**
   * Final synchronous check immediately around the host followup. The caller
   * invokes `run()` inside this same call stack, so a pause or unload that
   * committed while an earlier async read was in flight cannot slip between
   * the final state check and the host insertion.
   * @param {string} id
   * @param {{ id: string, aborted: boolean }} token
   * @param {() => void} run
   */
  #commitFollowup(id, token, run) {
    if (this.#disposed || token.aborted) {
      return { ok: false, blocked: { ok: false, action: 'cancelled', code: 'disposed', message: 'session-link is shutting down' } }
    }
    if (!this.ledger.writable) {
      return { ok: false, blocked: { ok: false, action: 'cancelled', code: 'storage_error', message: 'session-link storage is unavailable' } }
    }
    const state = this.ledger.read()
    const checked = this.#checkLiveState(findMessage(state, id))
    if (checked.ok !== true) return { ok: false, blocked: checked }
    run()
    return { ok: true }
  }

  /**
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
    if (settings.paused) {
      return { ok: false, action: 'held', code: 'paused', message: 'global pause set before host insertion' }
    }
    return { ok: true }
  }

  /**
   * @param {string} id
   * @param {{ status: string, code?: string, message?: string }} classified
   */
  async #applyBlocked(id, classified) {
    await this.#mutate((state) => {
      const current = findMessage(state, id)
      if (current?.status !== 'dispatching') return skipMutation(undefined)
      const status = classified.status
      current.status = status
      current.error = { code: classified.code ?? 'blocked', message: classified.message ?? 'blocked' }
      current.releaseAuthorized = false
      if (status === 'held') {
        current.heldAt = this.clock()
        current.heldReason = classified.code ?? 'blocked'
      } else {
        current.heldAt = null
        current.heldReason = null
        delete current.heldOverflow
      }
      if (status === 'cancelled') {
        current.cancelledAt = this.clock()
        current.completedAt = current.cancelledAt
      }
      if (status === 'failed') {
        current.failedAt = this.clock()
        current.completedAt = current.failedAt
      }
      if (status === 'unknown') current.unknownAt = this.clock()
      // No host insertion happened, so the host message id cannot be recovery
      // evidence for a later attempt.
      current.durableMessageId = null
      return true
    })
  }

  /**
   * Legacy rows are only queued when native pending evidence still exists.
   * Context rows already became queued at acceptance; a missing legacy row is
   * left uncertain rather than pretending it was received.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async #reconcileAcceptedPresence(id) {
    if (typeof this.adapter.nativePending !== 'function' || this.#disposed) return
    const before = this.ledger.read()
    const message = findMessage(before, id)
    if (
      message?.status !== 'accepted' ||
      message.receipt?.policy !== 'legacy-accepted' ||
      message.receipt.state === 'received' ||
      message.receipt.state === 'queued'
    ) {
      return
    }
    let presence
    try {
      presence = this.adapter.nativePending(message.to, message.durableMessageId)
    } catch {
      return
    }
    if (presence?.known !== true) return
    await this.#mutate((state) => {
      const current = findMessage(state, id)
      if (current?.receipt?.policy !== 'legacy-accepted' || current.receipt.state === 'received') {
        return skipMutation(undefined)
      }
      const next = presence.pending === true ? 'queued' : 'uncertain'
      if (current.receipt.state === next) return skipMutation(undefined)
      current.receipt.state = next
      return true
    })
  }

  /** @param {string} id @param {number} now @param {object} [extras] */
  async #acceptMessageById(id, now, extras = {}) {
    await this.#mutate((state) => {
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
    const justAccepted = message.status !== 'accepted'
    message.status = 'accepted'
    message.acceptedAt = Number.isSafeInteger(message.acceptedAt) ? message.acceptedAt : now
    message.dispatchStatus = 'accepted'
    message.error = null
    if (extras.recoveryEvidence !== undefined) message.recoveryEvidence = extras.recoveryEvidence
    if (extras.inboxSeen === true) message.inboxSeen = true
    this.#applyAcceptedEffects(state, message, now, { justAccepted })
  }

  /**
   * @param {Record<string, any>} state
   * @param {Record<string, any>} message
   * @param {number} now
   * @param {{ justAccepted?: boolean }} [options]
   */
  #applyAcceptedEffects(state, message, now, options = {}) {
    if (message.receipt?.policy === 'context' && message.receipt.state === 'not_sent') {
      message.receipt.state = 'queued'
    }
    if (message.kind === 'request') {
      if (message.replyStatus === undefined || message.replyStatus === 'none') message.replyStatus = 'waiting'
      if (message.replyStatus === 'waiting') this.#applyRequestAcceptedTiming(state, message, options.justAccepted === true)
      return
    }
    if (message.kind === 'notification' || message.kind === 'reply') {
      if (message.receipt?.policy === 'context') {
        if (message.receipt.state === 'received' && Number.isSafeInteger(message.receipt.receivedAt)) {
          message.completedAt = message.receipt.receivedAt
        }
      } else if (message.receipt?.policy === 'legacy-accepted' || message.receipt === undefined) {
        if (options.justAccepted === true && !Number.isSafeInteger(message.completedAt)) {
          message.completedAt = message.acceptedAt
        }
      }
    }
    if (message.kind !== 'reply' || typeof message.parentMessageId !== 'string') return
    const parent = findMessage(state, message.parentMessageId)
    if (parent === undefined || parent.kind !== 'request') return
    if (parent.status === 'dispatching' || parent.status === 'unknown') {
      const parentJustAccepted = parent.status !== 'accepted'
      parent.status = 'accepted'
      parent.acceptedAt = parent.acceptedAt ?? message.acceptedAt ?? now
      parent.dispatchStatus = 'accepted'
      parent.recoveryEvidence = parent.recoveryEvidence ?? 'reply'
      parent.error = null
      this.#applyRequestAcceptedTiming(state, parent, parentJustAccepted)
    }
    if (parent.replyStatus !== 'answered') {
      parent.replyStatus = 'answered'
      parent.answeredAt = message.acceptedAt ?? now
      parent.completedAt = parent.answeredAt
      parent.answeredBy = message.id
    }
    if (parent.timedOutAt !== null && parent.timedOutAt !== undefined) {
      message.late = true
      parent.lateReplyAt = message.acceptedAt ?? now
    }
  }

  /**
   * New context requests snapshot the current timeout and wait for exact
   * context evidence before a deadline exists. Legacy rows keep the 0.2 rule:
   * an already-existing deadline is never touched; a request that is accepted
   * for the first time in 0.3 gets acceptedAt + the timeout current at that
   * acceptance.
   * @param {Record<string, any>} state
   * @param {Record<string, any>} message
   * @param {boolean} justAccepted
   */
  #applyRequestAcceptedTiming(state, message, justAccepted) {
    const receipt = message.receipt
    if (receipt?.policy === 'legacy-accepted') {
      if (!justAccepted || Number.isSafeInteger(message.deadlineAt)) return
      const deadlineAt = representableDeadline(message.acceptedAt, state.settings.requestTimeoutMs)
      if (deadlineAt !== undefined) message.deadlineAt = deadlineAt
      return
    }
    if (receipt?.policy === 'context') {
      if (justAccepted && receipt.timeoutMs === null) receipt.timeoutMs = state.settings.requestTimeoutMs
      if (receipt.state === 'received') this.#applyDeadlineFromReceipt(state, message)
      return
    }
    // Defensive fallback for a malformed pre-v3 row: preserve the old rule
    // rather than inventing a receipt-based timer.
    if (!Number.isSafeInteger(message.deadlineAt)) {
      const deadlineAt = representableDeadline(message.acceptedAt, state.settings.requestTimeoutMs)
      if (deadlineAt !== undefined) message.deadlineAt = deadlineAt
    }
  }

  /** @param {string} id @param {string} code @param {string} message */
  async #markFailed(id, code, message) {
    await this.#mutate((state) => {
      const current = findMessage(state, id)
      if (current === undefined) return skipMutation(undefined)
      if (current.status === 'accepted') return skipMutation(undefined)
      if (current.status !== 'dispatching' && current.status !== 'pending' && current.status !== 'held') return skipMutation(undefined)
      current.status = 'failed'
      current.error = { code, message }
      current.failedAt = this.clock()
      current.completedAt = current.failedAt
      return true
    })
  }

  /** @param {string} id @param {string} code @param {string} message */
  async #markUnknown(id, code, message) {
    await this.#mutate((state) => {
      const current = findMessage(state, id)
      if (current === undefined) return skipMutation(undefined)
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

  /** @param {string} id @param {string} code */
  async #heldIfPending(id, code) {
    await this.#mutate((state) => {
      const message = findMessage(state, id)
      if (message?.status !== 'pending') return skipMutation(undefined)
      message.status = 'held'
      message.heldAt = this.clock()
      message.heldReason = code
      message.error = { code, message: 'held until the global setting is cleared' }
      message.releaseAuthorized = false
      delete message.heldOverflow
      return true
    })
  }

  /** @param {string} id @param {string} code @param {string} message */
  async #cancelPending(id, code, message) {
    await this.#mutate((state) => {
      const current = findMessage(state, id)
      if (current?.status !== 'pending') return skipMutation(undefined)
      current.status = 'cancelled'
      current.cancelledAt = this.clock()
      current.completedAt = current.cancelledAt
      current.error = { code, message }
      return true
    })
  }

  // -------------------------------------------------------------------------
  // Legacy native next-turn transfer
  // -------------------------------------------------------------------------

  #scheduleTransfer() {
    if (this.#disposed || this.#transferScheduled || this.#transferRunning) return
    if (!this.ledger.writable) return
    const settings = this.ledger.read().settings
    if (!settings.enabled || settings.paused) return
    this.#transferScheduled = true
    queueMicrotask(() => {
      this.#transferScheduled = false
      if (this.#disposed || !this.ledger.writable) return
      const task = this.#runTransferPass().catch((error) => {
        this.logger.warn(`session-link transfer pass failed: ${errorCode(error)}`)
      })
      this.#track(task)
    })
  }

  /** @returns {Promise<void>} */
  async #runTransferPass() {
    if (this.#disposed || this.#transferRunning || !this.ledger.writable) return
    const state = this.ledger.read()
    if (!state.settings.enabled || state.settings.paused) return
    this.#transferRunning = true
    try {
      const groups = this.#transferCandidates(state)
      let targets = 0
      for (const [targetId, ids] of groups) {
        if (this.#disposed || targets >= LIMITS.TRANSFER_TARGETS_PER_PASS) break
        targets += 1
        try {
          await this.#transferTarget(targetId, ids)
        } catch (error) {
          if (errorCode(error) === 'storage_error' || errorCode(error) === 'disposed') throw error
          this.logger.warn(`session-link transfer for ${targetId} failed: ${errorCode(error)}`)
        }
      }
    } finally {
      this.#transferRunning = false
    }
  }

  /**
   * Only legacy-accepted rows that are still eligible under D1 participate.
   * @param {Record<string, any>} state
   * @returns {Map<string, string[]>}
   */
  #transferCandidates(state) {
    const groups = new Map()
    for (const message of state.messages) {
      const receipt = message.receipt
      if (receipt?.policy !== 'legacy-accepted') continue
      if (message.status !== 'accepted') continue
      if (message.kind === 'request' && message.replyStatus === 'answered') continue
      if (typeof message.durableMessageId !== 'string' || message.durableMessageId.length === 0) continue
      if (receipt.state === 'received') continue
      const journal = state.transfers?.[message.id]
      if (journal?.state === 'moved' || journal?.state === 'uncertain') continue
      const chain = state.chains[message.chainId]
      if (chain?.state !== 'open') continue
      let ids = groups.get(message.to)
      if (ids === undefined) {
        ids = []
        groups.set(message.to, ids)
      }
      ids.push(message.id)
    }
    return groups
  }

  /**
   * Recover prepared/moved journals on open. This only reads the live native
   * inbox (never resolves a cold Agent) plus exact receipt evidence; a changed
   * or missing row becomes uncertain and is never re-sent automatically.
   * @returns {Promise<void>}
   */
  async #recoverTransferJournals() {
    if (typeof this.adapter.inspectNativeTarget !== 'function') return
    const state = this.ledger.read()
    const transfers = state.transfers
    if (!isPlainObject(transfers)) return
    for (const [messageId, journal] of Object.entries(transfers)) {
      if (this.#disposed) return
      if (journal?.state === 'uncertain') continue
      const message = findMessage(state, messageId)
      if (message === undefined) continue
      if (journal.state === 'prepared') {
        if (message.receipt?.state === 'received') {
          await this.#writeTransferState(messageId, 'moved', undefined, { at: this.clock() })
          continue
        }
        const chain = state.chains[message.chainId]
        if (
          message.status !== 'accepted' ||
          (message.kind === 'request' && message.replyStatus === 'answered') ||
          chain?.state === 'closed'
        ) {
          await this.#writeTransferState(messageId, 'uncertain', 'precondition_lost')
          continue
        }
        if (!state.settings.enabled || state.settings.paused) continue
      }
      let info
      try {
        info = this.adapter.inspectNativeTarget(message.to)
      } catch {
        continue
      }
      if (info?.live !== true) {
        if (message.receipt?.state === 'received' && journal.state !== 'moved') {
          await this.#writeTransferState(messageId, 'moved', undefined, { at: this.clock() })
        }
        continue
      }
      const nextStepIds = new Set((info.nextStep ?? []).map((entry) => entry?.id))
      const nextTurn = (info.nextTurn ?? []).find((entry) => entry?.id === message.durableMessageId)
      if (nextStepIds.has(message.durableMessageId) || message.receipt?.state === 'received') {
        if (journal.state !== 'moved') await this.#writeTransferState(messageId, 'moved', undefined, { at: this.clock() })
        continue
      }
      if (nextTurn !== undefined) {
        if (
          !isStandardSource(nextTurn.source, message.from) ||
          !hostMessageMatchesLedger(message, nextTurn) ||
          hostMessageDigest(nextTurn) !== journal.digest
        ) {
          await this.#writeTransferState(messageId, 'uncertain', 'content_mismatch')
          continue
        }
        if (journal.state === 'moved') {
          // D5: the original ID is still safely in next-turn and matches, so
          // the same row may be attempted again once D1 still holds.
          await this.#writeTransferState(messageId, 'prepared', undefined)
        }
        continue
      }
      await this.#writeTransferState(messageId, 'uncertain', 'not_pending_no_evidence')
    }
  }

  /**
   * @param {string} targetId
   * @param {string[]} messageIds
   * @returns {Promise<void>}
   */
  async #transferTarget(targetId, messageIds) {
    if (typeof this.adapter.inspectNativeTarget !== 'function' || typeof this.adapter.moveNativePending !== 'function') {
      return
    }
    let info
    try {
      info = this.adapter.inspectNativeTarget(targetId)
    } catch {
      return
    }
    if (info?.live !== true || info.running !== true || info.archived === true || info.subagent === true) return
    for (const messageId of messageIds) {
      if (this.#disposed || !this.ledger.writable) return
      const state = this.ledger.read()
      if (!state.settings.enabled || state.settings.paused) return
      const message = findMessage(state, messageId)
      if (message === undefined || !this.#isTransferEligible(state, message)) continue
      const durableId = message.durableMessageId
      const native = (info.nextTurn ?? []).find((entry) => entry?.id === durableId)
      const inNextStep = (info.nextStep ?? []).some((entry) => entry?.id === durableId)
      const existing = state.transfers?.[messageId]
      if (inNextStep) {
        if (existing !== undefined && existing.state !== 'moved') {
          await this.#writeTransferState(messageId, 'moved', undefined, { at: this.clock() })
        }
        continue
      }
      if (native === undefined) {
        if (existing?.state === 'prepared') {
          await this.#writeTransferState(messageId, 'uncertain', 'not_pending_no_evidence')
        }
        continue
      }
      if (!isStandardSource(native.source, message.from) || !hostMessageMatchesLedger(message, native)) {
        if (existing?.state === 'prepared') await this.#writeTransferState(messageId, 'uncertain', 'content_mismatch')
        continue
      }
      const digest = hostMessageDigest(native)
      if (existing?.state === 'prepared' && existing.digest !== digest) {
        await this.#writeTransferState(messageId, 'uncertain', 'content_mismatch')
        continue
      }
      const queuePosition = (info.nextTurn ?? []).findIndex((entry) => entry?.id === durableId)
      if (existing === undefined) {
        const prepared = await this.#persistTransferPrepared(message, native, info, digest, queuePosition)
        if (!prepared) continue
      }
      const guard = () => this.#transferGuard(messageId)
      let outcome
      try {
        outcome = this.adapter.moveNativePending({
          targetId,
          durableMessageId: durableId,
          senderSessionId: message.from,
          queuePosition,
          digest,
          guard,
        })
      } catch (error) {
        outcome = { outcome: 'uncertain', error: errorCode(error) }
      }
      if (!isPlainObject(outcome)) continue
      if (outcome.outcome === 'moved') {
        let flushed = false
        try {
          flushed = (await this.adapter.flushTarget(targetId)) === true
        } catch {
          flushed = false
        }
        if (this.#disposed) return
        if (flushed) {
          await this.#writeTransferState(messageId, 'moved', undefined, { at: this.clock() })
        } else {
          await this.#writeTransferState(messageId, 'uncertain', 'flush_failed')
        }
      } else if (outcome.outcome === 'rolled_back' || outcome.outcome === 'fallback_next_turn') {
        await this.#bumpTransferAttempt(messageId, outcome.outcome === 'fallback_next_turn' ? 'steer_fell_back_next_turn' : 'move_rolled_back')
      } else if (outcome.outcome === 'missing' || outcome.outcome === 'already_claimed') {
        await this.#writeTransferState(messageId, 'uncertain', 'not_pending_no_evidence')
      } else if (outcome.outcome === 'mismatch') {
        await this.#writeTransferState(messageId, 'uncertain', 'content_mismatch')
      } else if (outcome.outcome === 'uncertain' || outcome.outcome === 'threw') {
        await this.#writeTransferState(messageId, 'uncertain', outcome.error ?? 'move_uncertain')
      }
      if (this.#disposed) return
      try {
        info = this.adapter.inspectNativeTarget(targetId)
      } catch {
        return
      }
      if (info?.live !== true || info.running !== true) return
    }
  }

  /**
   * @param {Record<string, any>} state
   * @param {Record<string, any>} message
   * @returns {boolean}
   */
  #isTransferEligible(state, message) {
    if (message.receipt?.policy !== 'legacy-accepted') return false
    if (message.receipt.state === 'received') return false
    if (message.status !== 'accepted') return false
    if (message.kind === 'request' && message.replyStatus === 'answered') return false
    if (typeof message.durableMessageId !== 'string' || message.durableMessageId.length === 0) return false
    if (!state.settings.enabled || state.settings.paused) return false
    return state.chains[message.chainId]?.state === 'open'
  }

  /** @param {string} messageId @returns {boolean} */
  #transferGuard(messageId) {
    if (this.#disposed || !this.ledger.writable) return false
    const state = this.ledger.read()
    const message = findMessage(state, messageId)
    if (message === undefined) return false
    return this.#isTransferEligible(state, message)
  }

  /**
   * @param {Record<string, any>} message
   * @param {Record<string, any>} native
   * @param {Record<string, any>} info
   * @param {string} digest
   * @param {number} queuePosition
   * @returns {Promise<boolean>}
   */
  async #persistTransferPrepared(message, native, info, digest, queuePosition) {
    const now = this.clock()
    let persisted = false
    await this.#mutate((state) => {
      const current = findMessage(state, message.id)
      if (current === undefined || !this.#isTransferEligible(state, current)) return skipMutation(undefined)
      state.transfers ??= {}
      state.transfers[message.id] = {
        messageId: message.id,
        target: current.to,
        durableMessageId: current.durableMessageId,
        hostMessage: structuredClone(native),
        queuePosition: queuePosition < 0 ? 0 : queuePosition,
        hostSessionSeq: Number.isSafeInteger(info.hostSessionSeq) ? info.hostSessionSeq : -1,
        at: now,
        digest,
        state: 'prepared',
        attempts: 0,
      }
      current.receipt.transfer = { state: 'prepared', at: now }
      persisted = true
      return true
    })
    return persisted
  }

  /**
   * @param {string} messageId
   * @param {'prepared'|'moved'|'uncertain'} transferState
   * @param {string} [error]
   * @param {{ at?: number }} [options]
   * @returns {Promise<void>}
   */
  async #writeTransferState(messageId, transferState, error, options = {}) {
    await this.#mutate((state) => {
      const message = findMessage(state, messageId)
      const journal = state.transfers?.[messageId]
      if (message === undefined || journal === undefined) return skipMutation(undefined)
      const at = options.at ?? this.clock()
      journal.state = transferState
      journal.at = at
      if (error === undefined) delete journal.error
      else journal.error = error
      message.receipt.transfer = {
        state: transferState,
        at,
        ...(error === undefined ? {} : { error }),
      }
      return true
    })
  }

  /**
   * @param {string} messageId
   * @param {string} error
   * @returns {Promise<void>}
   */
  async #bumpTransferAttempt(messageId, error) {
    await this.#mutate((state) => {
      const message = findMessage(state, messageId)
      const journal = state.transfers?.[messageId]
      if (message === undefined || journal === undefined) return skipMutation(undefined)
      journal.attempts = (journal.attempts ?? 0) + 1
      if (journal.attempts >= LIMITS.TRANSFER_MAX_ATTEMPTS) {
        const at = this.clock()
        journal.state = 'uncertain'
        journal.at = at
        journal.error = error
        message.receipt.transfer = { state: 'uncertain', at, error }
      } else {
        message.receipt.transfer = { state: 'prepared', at: journal.at }
      }
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
    if (this.#disposed || !this.ledger.writable) return
    const settings = this.ledger.read().settings
    if (!settings.enabled || settings.paused) return
    while (this.#slots < settings.maxConcurrent) {
      if (this.#disposed) return
      const id = this.#nextPendingId()
      if (id === undefined) return
      this.#slots += 1
      this.#starting.add(id)
      const task = this.#dispatchOne(id)
        .catch((error) => this.logger.warn(`dispatch failed: ${errorCode(error)}`))
        .finally(() => {
          this.#starting.delete(id)
          this.#slots -= 1
          const next = this.#waiters.shift()
          if (next !== undefined) next()
          this.#schedulePump()
        })
      this.#track(task)
    }
  }

  /** @returns {string | undefined} */
  #nextPendingId() {
    const state = this.ledger.read()
    for (const message of state.messages) {
      if (message.status !== 'pending') continue
      if (this.#starting.has(message.id)) continue
      if (dispatchBlockers(state, message).length > 0) continue
      return message.id
    }
    return undefined
  }

  /** Wait for currently scheduled attempts and public operations to settle. */
  async drain() {
    await new Promise((resolve) => setImmediate(resolve))
    while (true) {
      const tasks = [...this.#tasks]
      if (tasks.length === 0 && this.#slots === 0) return
      if (tasks.length > 0) await Promise.allSettled(tasks)
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  // -------------------------------------------------------------------------
  // Owner control + settings
  // -------------------------------------------------------------------------

  /**
   * Settings CAS is independent from the message ledger revision. Exactly one
   * expectedSettingsRevision is accepted; old expectedRevision/legacy patches
   * are explicit invalid_argument/policy_removed failures.
   * @param {{ expectedSettingsRevision: number, patch: unknown }} request
   * @returns {Promise<{ revision: number, settingsRevision: number, settings: Record<string, any>, queued: number, resumed: number }>}
   */
  async updateSettings(request) {
    return this.#trackOperation(() => this.#updateSettings(request))
  }

  async #updateSettings(request) {
    const object = assertPlainObject(request, 'settings request')
    // An old page sends expectedRevision together with removed quota fields.
    // The whole patch is a policy removal so the UI is told to refresh instead
    // of reporting a misleading argument error.
    if (isPlainObject(object.patch)) {
      const legacy = LEGACY_SETTINGS_KEYS.filter((key) => key in object.patch)
      if (legacy.length > 0) {
        throw fail('policy_removed', 'old session-link settings were removed; refresh the page and try again', {
          removedKeys: legacy,
        })
      }
    }
    assertAllowedKeys(object, ['expectedSettingsRevision', 'patch'], 'settings request', 'invalid_argument')
    const expectedSettingsRevision = boundedInteger(object.expectedSettingsRevision, 'expectedSettingsRevision', { min: 1 })
    const now = this.clock()
    const result = await this.#mutate((state) => {
      if (state.settingsRevision !== expectedSettingsRevision) {
        throw fail('revision_conflict', 'settings changed since the panel snapshot; refresh and retry', {
          currentSettingsRevision: state.settingsRevision,
        })
      }
      const next = applySettingsPatch(state.settings, object.patch, { now })
      const unchanged = JSON.stringify(next) === JSON.stringify(state.settings)
      if (unchanged) {
        return skipMutation({
          revision: state.revision,
          settingsRevision: state.settingsRevision,
          settings: structuredClone(state.settings),
          queued: 0,
          resumed: 0,
        })
      }
      state.settings = next
      state.settingsRevision += 1
      const reconciled = this.#reconcileGlobalQueue(state, now)
      return {
        revision: state.revision + 1,
        settingsRevision: state.settingsRevision,
        settings: structuredClone(next),
        queued: reconciled.queued,
        resumed: reconciled.resumed,
      }
    })
    this.#wakeSlotWaiters()
    this.#schedulePump()
    this.#scheduleTransfer()
    return result
  }

  /**
   * Authenticated owner control. Every mutation is CAS-guarded on expectedRevision
   * and fails explicitly instead of silently overwriting another tab's change.
   * @param {Record<string, unknown>} request
   * @returns {Promise<Record<string, any>>}
   */
  async ownerControl(request) {
    return this.#trackOperation(() => this.#ownerControl(request))
  }

  async #ownerControl(request) {
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
      throw fail('policy_removed', 'business quotas were removed in 0.2; refresh the page', {
        policyRemoved: true,
      })
    }

    const id = requiredString(object.id, 'id', { min: 1, max: 512 })
    if (action === 'recheck') {
      return this.recheck(id, { revision: expectedRevision, by })
    }
    const result = await this.#mutate(
      (state) => {
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
          const resumed = this.#resumeChainHeld(state, chain, now)
          return { revision: state.revision + 1, chain: this.#chainView(state, chain), resumed }
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
            if (!this.#cancelMessageInState(message, now, 'owner')) {
              throw fail('conflict', 'only a pending or held message can be cancelled')
            }
            return { revision: state.revision + 1, message: this.#messageView(state, message) }
          }
          const chain = this.#chainById(state, id)
          let cancelled = 0
          for (const message of chainMessages(state, chain.id)) {
            if (this.#cancelMessageInState(message, now, 'owner')) cancelled += 1
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
            message.completedAt = now
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

    this.#schedulePump()
    return result
  }

  /**
   * Read-only evidence recheck for an unknown/dispatching record.
   * @param {string} id
   * @param {{ revision?: number, by?: string }} [options]
   */
  async recheck(id, options = {}) {
    return this.#trackOperation(() => this.#recheck(id, options))
  }

  async #recheck(id, options) {
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
    return this.#mutate(
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
          if (
            evidence.evidence === 'message' &&
            Number.isSafeInteger(evidence.seq) &&
            Number.isSafeInteger(evidence.time) &&
            evidence.seq >= 0 &&
            evidence.time >= 0
          ) {
            this.#markReceivedInState(state, message, evidence.time, evidence.seq, this.clock())
          }
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
  }

  /**
   * Model-facing control surface: pause/close only a chain the caller opened,
   * and cancel only the caller's own pending/held records. No global switches,
   * no budget release, no unknown resolution, no resume.
   * @param {{ from: string, action: string, id: string }} request
   */
  async modelControl(request) {
    return this.#trackOperation(() => this.#modelControl(request))
  }

  async #modelControl(request) {
    const object = assertPlainObject(request, 'model control request')
    assertAllowedKeys(object, ['from', 'action', 'id'], 'model control request')
    const from = requiredString(object.from, 'from', { min: 1, max: 256 })
    const action = requiredString(object.action, 'action', { max: 32 })
    const id = requiredString(object.id, 'id', { min: 1, max: 512 })
    const now = this.clock()
    return this.#mutate((state) => {
      if (action === 'cancel') {
        const message = findMessage(state, id)
        if (message !== undefined) {
          if (message.from !== from) throw fail('forbidden', 'a model may cancel only its own pending messages')
          if (!this.#cancelMessageInState(message, now, 'model')) {
            throw fail('conflict', 'only a pending or held message can be cancelled')
          }
          return { revision: state.revision + 1, message: this.#messageView(state, message) }
        }
        const chain = this.#chainById(state, id)
        if (chain.rootOwner !== from) throw fail('forbidden', 'only the root owner may cancel a chain')
        let cancelled = 0
        for (const message of chainMessages(state, chain.id)) {
          if (message.from !== from) continue
          if (this.#cancelMessageInState(message, now, 'model')) cancelled += 1
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
    assertAllowedKeys(object, ['workspace', 'title', 'query', 'cursor', 'limit', 'scope'], 'list request')
    const scope = object.scope === undefined ? 'sessions' : requiredString(object.scope, 'scope', { max: 16 })
    if (scope === 'workspaces') return this.#listWorkspaces(object)
    if (scope !== 'sessions') throw fail('invalid_argument', "scope must be 'sessions' or 'workspaces'")
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
   * Registered-workspace discovery, including empty workspaces a session-only
   * list can never show. Registry order is stable only within one snapshot:
   * concurrent add/remove can move rows between pages, so callers re-check by
   * id. Returns id/title/path only — never credentials or internals.
   * @param {Record<string, any>} object
   */
  async #listWorkspaces(object) {
    if (object.workspace !== undefined) {
      throw fail('invalid_argument', 'the workspace filter is not available with scope=workspaces')
    }
    const limit = boundedInteger(object.limit ?? 20, 'limit', { min: 1, max: LIMITS.MAX_PAGE })
    const offset = decodeCursor(object.cursor)
    const titleFilter = object.title === undefined ? null : requiredString(object.title, 'title', { max: 500 })
    const queryFilter = object.query === undefined ? null : requiredString(object.query, 'query', { max: 500 })
    const workspaces = (await this.adapter.listWorkspaces()).filter((workspace) => {
      if (titleFilter !== null && !`${workspace.title}`.toLowerCase().includes(titleFilter.toLowerCase())) return false
      if (queryFilter !== null) {
        const haystack = `${workspace.title ?? ''} ${workspace.path ?? ''}`.toLowerCase()
        if (!haystack.includes(queryFilter.toLowerCase())) return false
      }
      return true
    })
    const page = workspaces.slice(offset, offset + limit)
    return {
      workspaces: page,
      total: workspaces.length,
      nextCursor: offset + limit < workspaces.length ? encodeCursor(offset + limit) : null,
    }
  }

  /**
   * History is read-only and bounded. Archived sessions are explicitly
   * eligible here, while subagents remain outside the ordinary-session scope.
   * @param {Record<string, unknown>} request
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

  /** @param {{ from: string, messageId?: string, chainId?: string }} request */
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
      hasMore: related.length > limited.length,
      budgetLatches: [],
    }
  }

  /** @param {Record<string, unknown>} [request] */
  async snapshot(request = {}) {
    const object = assertPlainObject(request, 'snapshot request')
    assertAllowedKeys(object, ['limit', 'offset', 'filter', 'sessionId', 'chainId', 'view'], 'snapshot request')
    const view = object.view === undefined ? 'full' : requiredString(object.view, 'view', { max: 16 })
    if (!['full', 'settings'].includes(view)) throw fail('invalid_argument', `unknown snapshot view ${view}`)
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
    if (view === 'settings') {
      // Fast path for the settings surface: no session discovery, no message
      // page, no chain views. This keeps opening the panel cheap even with a
      // large communication history; the records tab requests the full view.
      const stats = this.ledger.stats()
      const queuedBytes = queuedBytesOf(state)
      return {
        apiVersion: API_VERSION,
        version: PLUGIN_VERSION,
        revision: state.revision,
        settingsRevision: state.settingsRevision,
        settings: structuredClone(state.settings),
        messages: undefined,
        chains: [],
        budgetLatches: [],
        sessions: [],
        total: state.messages.length,
        hasMore: false,
        nextOffset: null,
        inFlight: this.#attempts.size,
        storage: this.#storageView(stats, queuedBytes),
        technicalLimits: this.#technicalLimits(stats),
        ...(state.migration === undefined ? {} : { migration: publicMigration(state.migration) }),
      }
    }
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

    const chainIds = new Set(page.map((message) => message.chainId))
    if (chainId !== undefined) chainIds.add(chainId)
    const chains = this.#chainViewsFor(state, chainIds)
    const sessions = await this.adapter.listSessions({})
    const stats = this.ledger.stats()
    const queuedBytes = queuedBytesOf(state)
    const storage = this.#storageView(stats, queuedBytes)
    return {
      apiVersion: API_VERSION,
      version: PLUGIN_VERSION,
      revision: state.revision,
      settingsRevision: state.settingsRevision,
      settings: structuredClone(state.settings),
      messages: page.map((message) => this.#messageView(state, message, sessionId)),
      chains,
      budgetLatches: [],
      sessions: sessions.map((session) => publicSession(session)),
      total,
      hasMore: offset + page.length < total,
      nextOffset: offset + page.length < total ? offset + page.length : null,
      inFlight: this.#attempts.size,
      storage,
      technicalLimits: this.#technicalLimits(stats),
      ...(state.migration === undefined ? {} : { migration: publicMigration(state.migration) }),
    }
  }

  /** @param {Record<string, any>} stats @param {number} queuedBytes */
  #storageView(stats, queuedBytes) {
    const ledgerFull = stats.bytes >= stats.maxBytes
    const queueFull = queuedBytes >= this.maxQueuedBytes
    const ledgerNear = stats.bytes >= stats.maxBytes * 0.9
    const queueNear = queuedBytes >= this.maxQueuedBytes * 0.9
    let health = 'ok'
    if (stats.health === 'storage_error') health = 'storage_error'
    else if (ledgerFull || queueFull) health = 'full'
    else if (ledgerNear || queueNear) health = 'near_capacity'
    return {
      bytes: stats.bytes,
      maxBytes: stats.maxBytes,
      queuedBytes,
      maxQueuedBytes: this.maxQueuedBytes,
      messageCount: stats.messageCount,
      chainCount: stats.chainCount,
      health,
      ...(stats.error === undefined ? {} : { error: structuredClone(stats.error) }),
    }
  }

  /** @param {Record<string, any>} stats */
  #technicalLimits(stats) {
    return {
      maxContentBytes: LIMITS.MAX_CONTENT_BYTES,
      maxCallBytes: LIMITS.MAX_CALL_BYTES,
      maxLedgerBytes: stats.maxBytes,
      maxQueuedBytes: this.maxQueuedBytes,
      maxReferences: LIMITS.MAX_REFERENCES,
      maxReferenceChars: LIMITS.MAX_REFERENCE_CHARS,
      maxPaths: LIMITS.MAX_PATHS,
      maxPathChars: LIMITS.MAX_PATH_CHARS,
      historyPageMax: LIMITS.HISTORY_MAX_MESSAGES,
      listPageMax: LIMITS.MAX_PAGE,
      historyCharsMax: LIMITS.HISTORY_MAX_CHARS,
      snapshotPageMax: LIMITS.MAX_SNAPSHOT_PAGE,
      operationFirstSubmitMs: LIMITS.OPERATION_PAST_MS,
      operationRetentionMs: LIMITS.OPERATION_RETENTION_MS,
    }
  }

  // -------------------------------------------------------------------------
  // State helpers
  // -------------------------------------------------------------------------

  /** @param {string} id */
  #message(id) {
    return this.ledger.read().messages.find((message) => message.id === id)
  }

  /**
   * Root operationId lookup across BOTH durable operation kinds: send/reply
   * records and create journals. The canonical payload includes `kind`, so a
   * create canonical can never equal a send/reply canonical and sealed (s2)
   * digests of different canonicals cannot collide; any cross-kind hit is
   * always a conflict before `#operationResult` could run.
   * @param {Record<string, any>} state
   * @param {string} from
   * @param {string} operationId
   */
  #lookupOperation(state, from, operationId) {
    const operation = Object.values(state.operations).find(
      (candidate) => candidate?.from === from && candidate?.operationId === operationId,
    )
    if (operation !== undefined) return operation
    return this.#lookupCreate(state, from, operationId)
  }

  /**
   * @param {Record<string, any>} state
   * @param {string} from
   * @param {string} operationId
   * @returns {Record<string, any> | undefined}
   */
  #lookupCreate(state, from, operationId) {
    return Object.values(state.creates ?? {}).find(
      (journal) => journal?.from === from && journal?.operationId === operationId,
    )
  }

  /**
   * @param {string} from
   * @param {string} operationId
   * @param {readonly string[]} targets
   */
  #operationKey(from, operationId, targets) {
    return `${from}|${operationId}|${[...targets].sort().join(',')}`
  }

  /**
   * @param {Record<string, any>} state
   * @param {Record<string, any>} operation
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
        message.completedAt = now
        message.cancelReason = 'chain_closed'
        message.error = { code: 'chain_closed', message: 'chain closed before delivery' }
        message.releaseAuthorized = false
        continue
      }
      // An explicitly closed group ends an accepted but still-waiting
      // request. Keep its accepted/replyStatus semantics intact (no fake
      // answer, no work cancellation); only record the completion timestamp
      // used by retention/terminal cleanup.
      if (
        message.status === 'accepted' &&
        message.kind === 'request' &&
        message.replyStatus === 'waiting' &&
        !Number.isSafeInteger(message.completedAt)
      ) {
        message.completedAt = now
        message.completedReason = 'chain_closed'
      }
    }
  }

  /**
   * @param {Record<string, any>} message
   * @param {number} now
   * @param {string} by
   * @returns {boolean}
   */
  #cancelMessageInState(message, now, by) {
    if (message.status !== 'pending' && message.status !== 'held') return false
    message.status = 'cancelled'
    message.cancelledAt = now
    message.completedAt = now
    message.cancelledBy = by
    message.cancelReason = 'cancelled'
    message.error = { code: 'cancelled', message: 'cancelled before host insertion' }
    message.releaseAuthorized = false
    return true
  }

  /**
   * Explicit release for historical/manual held records. It never bypasses a
   * global pause or a paused/closed chain.
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
    if (state.settings.paused) throw fail('paused', 'clear the global pause before releasing held messages')
    message.status = 'pending'
    message.releasedAt = now
    message.heldAt = null
    message.heldReason = null
    message.error = null
    delete message.heldOverflow
    message.releaseAuthorized = false
  }

  /** @param {Record<string, any>} state @param {string} id */
  #chainById(state, id) {
    const chain = state.chains[id]
    if (chain === undefined) throw fail('not_found', 'chain not found')
    return chain
  }

  /**
   * @param {Record<string, any>} state
   * @param {Record<string, any>} chain
   * @param {Record<string, any>} [stats]
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
      id: chain.id,
      state: chain.state,
      rootOwner: chain.rootOwner,
      createdAt: chain.createdAt,
      ...(chain.pausedAt === undefined ? {} : { pausedAt: chain.pausedAt }),
      ...(chain.closedAt === undefined ? {} : { closedAt: chain.closedAt }),
      ...(chain.closedBy === undefined ? {} : { closedBy: chain.closedBy }),
      ...(chain.pausedReason === undefined ? {} : { pausedReason: chain.pausedReason }),
      messageCount: entry.count,
      pending: entry.pending,
      held: entry.held,
      dispatching: entry.dispatching,
      unknown: entry.unknown,
      lastMessageAt: entry.lastMessageAt || null,
    }
  }

  /**
   * @param {Record<string, any>} state
   * @param {Iterable<string>} chainIds
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
   */
  #messageView(state, message, sessionId) {
    const chain = state.chains[message.chainId]
    const automaticHeld = isAutomaticHeld(message)
    const releasable =
      message.status === 'held' &&
      state.settings.enabled &&
      !state.settings.paused &&
      chain?.state === 'open' &&
      !automaticHeld
    return {
      ...structuredClone(message),
      status: message.status,
      dispatchStatus: message.status,
      text: message.content?.text ?? '',
      subject: displaySubject(message),
      direction:
        sessionId === undefined ? null : message.from === sessionId ? 'out' : message.to === sessionId ? 'in' : null,
      chainState: chain?.state ?? null,
      releasable,
      replies: state.messages
        .filter((candidate) => candidate.parentMessageId === message.id)
        .slice(0, 20)
        .map((candidate) => candidate.id),
    }
  }

  /** @param {Record<string, any>} message */
  #publicMessage(message) {
    return { ...structuredClone(message), rendered: renderInboundText(message) }
  }

  /** @returns {{ operationId: string }} */
  mintOperation() {
    return { operationId: mintOperationId(this.uuid(), this.clock()) }
  }

  /** @param {string} id */
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

  /**
   * Stop background scheduling, abort uncommitted followups, and wait at most
   * five seconds. If a task remains, mark still-dispatching rows unknown and
   * report whether it is safe to release the writer; if the mark itself cannot
   * complete, the caller must keep the writer lock instead of risking a
   * second-writer handoff.
   * @returns {Promise<{ drained: boolean, timedOut: boolean, markedUnknown: number, storageSafe: boolean }>}
   */
  async dispose() {
    if (this.#disposePromise !== undefined) return this.#disposePromise
    this.#disposed = true
    if (this.#receiptDispose !== undefined) {
      try {
        this.#receiptDispose()
      } catch {
        // A listener already removed by the host is safe to ignore.
      }
      this.#receiptDispose = undefined
    }
    for (const token of this.#attempts) token.aborted = true
    for (const resolve of this.#waiters.splice(0)) resolve()
    this.#disposePromise = (async () => {
      const drained = await this.#drainWithTimeout(LIMITS.DISPOSE_DRAIN_MS)
      let markedUnknown = 0
      let markComplete = false
      if (drained) {
        markComplete = true
      } else if (this.ledger.writable) {
        try {
          const result = await this.#withTimeout(
            this.ledger.mutate((state) => {
              const now = this.clock()
              let count = 0
              for (const message of state.messages) {
                if (message.status !== 'dispatching') continue
                this.#markUnknownInState(state, message, now, {
                  code: 'dispose_timeout',
                  message: 'session-link unloaded during delivery; the insertion is unknown and was not retried',
                })
                count += 1
              }
              return count === 0 ? skipMutation(0) : count
            }),
            1000,
          )
          markedUnknown = result
          // A completed queued mutation proves the ledger write queue is idle
          // after the abort. Every late task checks `disposed` before enqueueing
          // another write, so the writer can be handed off even if a host await
          // is still outstanding.
          markComplete = true
        } catch {
          markComplete = false
        }
      }
      return {
        drained,
        timedOut: !drained,
        markedUnknown,
        storageSafe: drained || markComplete,
      }
    })()
    return this.#disposePromise
  }

  /** @param {number} ms @returns {Promise<boolean>} */
  async #drainWithTimeout(ms) {
    let timer
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
      timer.unref?.()
    })
    try {
      return await Promise.race([this.drain().then(() => true), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /** @template T @param {Promise<T>} promise @param {number} ms @returns {Promise<T>} */
  async #withTimeout(promise, ms) {
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(fail('timeout', 'operation timed out')), ms)
      timer.unref?.()
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      clearTimeout(timer)
    }
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
