/**
 * Frozen schema chain: v0.1 validation, v1 -> v2 conversion, v2 -> v3 conversion.
 *
 * This module intentionally duplicates old-format rules with literal values.
 * It must never read the current STATE_VERSION for a historical decision: a
 * later protocol change (including 0.3's schema 3) must not silently redefine
 * what v1/v2 data was allowed to contain or how it converted. V2_STATE_VERSION
 * is frozen at 2 and every v2 validation/rollback path uses that literal, while
 * the v0.3 conversion writes schema 3 explicitly.
 */

import { createHash } from 'node:crypto'

import {
  AUTO_HELD_REASONS,
  RETIRED_CHAIN_PAUSE_REASONS,
  V1_STATE_VERSION,
  V2_BACKUP_PREFIX,
} from './constants.js'
import { fail } from './errors.js'
import { isPlainObject } from './validation.js'

/** Frozen schema version produced by the historical v1 -> v2 conversion. */
export const V2_STATE_VERSION = 2
/** Frozen schema version produced by the v0.3 v2 -> v3 conversion. */
export const V3_STATE_VERSION = 3

/** Frozen v0.1 settings vocabulary (nine keys, exactly as shipped in 0.1.0). */
export const V1_DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  emergencyPaused: false,
  autoCollaborate: true,
  maxMessages: 20,
  maxHops: 8,
  maxConcurrent: 2,
  maxTextChars: 12000,
  requestTimeoutMs: 30 * 60 * 1000,
  retentionDays: 30,
})
export const V1_SETTINGS_KEYS = Object.freeze(Object.keys(V1_DEFAULT_SETTINGS))
const V1_SETTINGS_BOUNDS = Object.freeze({
  maxMessages: { min: 2, max: 20 },
  maxHops: { min: 1, max: 8 },
  maxConcurrent: { min: 1, max: 2 },
  maxTextChars: { min: 1000, max: 12000 },
  requestTimeoutMs: { min: 60_000, max: 86_400_000 },
  retentionDays: { min: 1, max: 90 },
})
const V1_MAX_MESSAGES = 10_000
const V1_CHAIN_MAX_MESSAGES = 20
const V1_CHAIN_MAX_HOPS = 8
const V1_DISPATCH_STATUSES = Object.freeze([
  'held',
  'pending',
  'dispatching',
  'accepted',
  'failed',
  'unknown',
  'cancelled',
])
const V1_REPLY_STATUSES = Object.freeze(['none', 'waiting', 'answered', 'timed_out'])
const V1_MESSAGE_KINDS = Object.freeze(['notification', 'request', 'reply'])
const V1_CHAIN_STATES = Object.freeze(['open', 'paused', 'closed'])

/** @param {unknown} error @returns {never} */
function corrupt(message) {
  throw fail('storage_corrupt', message)
}

/** @param {unknown} value @param {string} label */
function record(value, label) {
  if (!isPlainObject(value)) corrupt(`${label} is invalid`)
  return value
}

/** @param {unknown} value @param {string} label */
function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) corrupt(`${label} is invalid`)
}

/** @param {unknown} value @param {string} label @param {number} [min] */
function safeInteger(value, label, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) corrupt(`${label} is invalid`)
}

/** @param {unknown} value @param {string} label */
function optionalTime(value, label) {
  if (value === undefined || value === null) return
  safeInteger(value, label)
}

/** @param {unknown} value */
function validateV1Settings(value) {
  const settings = record(value, 'ledger settings')
  for (const key of V1_SETTINGS_KEYS) {
    if (!(key in settings)) corrupt(`ledger settings are missing ${key}`)
  }
  for (const key of ['enabled', 'emergencyPaused', 'autoCollaborate']) {
    if (typeof settings[key] !== 'boolean') corrupt('ledger settings are invalid')
  }
  for (const [key, bounds] of Object.entries(V1_SETTINGS_BOUNDS)) {
    const number = settings[key]
    if (!Number.isSafeInteger(number) || number < bounds.min || number > bounds.max) {
      corrupt('ledger settings are invalid')
    }
  }
  return {
    enabled: settings.enabled,
    emergencyPaused: settings.emergencyPaused,
    autoCollaborate: settings.autoCollaborate,
    maxMessages: settings.maxMessages,
    maxHops: settings.maxHops,
    maxConcurrent: settings.maxConcurrent,
    maxTextChars: settings.maxTextChars,
    requestTimeoutMs: settings.requestTimeoutMs,
    retentionDays: settings.retentionDays,
  }
}

/** @param {unknown} budget */
function validateV1Budget(budget) {
  const value = record(budget, 'ledger budget')
  if (!Array.isArray(value.events)) corrupt('ledger budget events are invalid')
  if (value.events.length > V1_MAX_MESSAGES) corrupt('ledger budget event list is oversized')
  for (const [index, event] of value.events.entries()) {
    const entry = record(event, `ledger budget event ${index}`)
    safeInteger(entry.at, `ledger budget event ${index}.at`)
    nonEmptyString(entry.from, `ledger budget event ${index}.from`)
    nonEmptyString(entry.to, `ledger budget event ${index}.to`)
  }
  const lastSubmitAt = record(value.lastSubmitAt, 'ledger budget lastSubmitAt')
  for (const [sessionId, at] of Object.entries(lastSubmitAt)) {
    nonEmptyString(sessionId, 'ledger budget lastSubmitAt session')
    safeInteger(at, `ledger budget lastSubmitAt ${sessionId}`)
  }
  const daily = record(value.daily, 'ledger budget daily')
  for (const [day, count] of Object.entries(daily)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) corrupt('ledger daily key is invalid')
    safeInteger(count, `ledger daily ${day}`)
  }
}

/** @param {unknown} latches */
function validateV1Latches(latches) {
  if (!Array.isArray(latches)) corrupt('ledger latches are invalid')
  const ids = new Set()
  for (const latch of latches) {
    const entry = record(latch, 'ledger latch')
    nonEmptyString(entry.id, 'ledger latch id')
    if (ids.has(entry.id)) corrupt('ledger latch id is duplicated')
    ids.add(entry.id)
    nonEmptyString(entry.scope, 'ledger latch scope')
    nonEmptyString(entry.reason, 'ledger latch reason')
    safeInteger(entry.createdAt, 'ledger latch createdAt')
    optionalTime(entry.releasedAt, 'ledger latch releasedAt')
    if (entry.releasedAt !== undefined && entry.releasedAt < entry.createdAt) {
      corrupt('ledger latch release precedes creation')
    }
  }
}

/** @param {string} id @param {unknown} chain */
function validateV1Chain(id, chain) {
  const value = record(chain, `ledger chain ${id}`)
  if (value.id !== id) corrupt(`ledger chain ${id} id mismatch`)
  nonEmptyString(value.rootOwner, `ledger chain ${id} rootOwner`)
  safeInteger(value.createdAt, `ledger chain ${id} createdAt`)
  if (!V1_CHAIN_STATES.includes(value.state)) corrupt(`ledger chain ${id} state is invalid`)
  safeInteger(value.maxMessages, `ledger chain ${id} maxMessages`, 1)
  if (value.maxMessages > V1_CHAIN_MAX_MESSAGES) corrupt(`ledger chain ${id} maxMessages is oversized`)
  safeInteger(value.maxHops, `ledger chain ${id} maxHops`, 1)
  if (value.maxHops > V1_CHAIN_MAX_HOPS) corrupt(`ledger chain ${id} maxHops is oversized`)
  if (value.messageCount !== undefined) safeInteger(value.messageCount, `ledger chain ${id} messageCount`)
  optionalTime(value.pausedAt, `ledger chain ${id} pausedAt`)
  optionalTime(value.closedAt, `ledger chain ${id} closedAt`)
}

/**
 * @param {unknown} message
 * @param {Set<string>} chainIds
 * @param {Set<string>} messageIds
 * @param {Record<string, any>} chains
 */
function validateV1Message(message, chainIds, messageIds, chains) {
  const value = record(message, 'ledger message')
  nonEmptyString(value.id, 'ledger message id')
  if (messageIds.has(value.id)) corrupt('ledger message id is duplicated')
  messageIds.add(value.id)
  nonEmptyString(value.from, `ledger message ${value.id} from`)
  nonEmptyString(value.to, `ledger message ${value.id} to`)
  if (value.from === value.to) corrupt(`ledger message ${value.id} targets itself`)
  if (!V1_MESSAGE_KINDS.includes(value.kind)) corrupt(`ledger message ${value.id} kind is invalid`)
  nonEmptyString(value.chainId, `ledger message ${value.id} chainId`)
  if (!chainIds.has(value.chainId)) corrupt(`ledger message ${value.id} references an unknown chain`)
  safeInteger(value.hop, `ledger message ${value.id} hop`)
  safeInteger(value.createdAt, `ledger message ${value.id} createdAt`)
  if (!V1_DISPATCH_STATUSES.includes(value.status)) corrupt(`ledger message ${value.id} status is invalid`)
  if (!V1_REPLY_STATUSES.includes(value.replyStatus)) corrupt(`ledger message ${value.id} replyStatus is invalid`)
  if (value.operationId !== undefined) nonEmptyString(value.operationId, `ledger message ${value.id} operationId`)
  if (value.deliveryAttempts !== undefined) safeInteger(value.deliveryAttempts, `ledger message ${value.id} deliveryAttempts`)
  if (value.durableMessageId !== undefined && value.durableMessageId !== null) {
    nonEmptyString(value.durableMessageId, `ledger message ${value.id} durableMessageId`)
  }
  const content = record(value.content, `ledger message ${value.id} content`)
  if (typeof content.text !== 'string') corrupt(`ledger message ${value.id} content.text is invalid`)
  if (!Array.isArray(content.references)) corrupt(`ledger message ${value.id} references are invalid`)
  for (const [index, reference] of content.references.entries()) {
    const entry = record(reference, `ledger message ${value.id} reference ${index}`)
    nonEmptyString(entry.sessionId, `ledger message ${value.id} reference sessionId`)
    safeInteger(entry.seq, `ledger message ${value.id} reference seq`)
    if (typeof entry.text !== 'string') corrupt(`ledger message ${value.id} reference text is invalid`)
  }
  if (!Array.isArray(content.paths) || content.paths.some((item) => typeof item !== 'string')) {
    corrupt(`ledger message ${value.id} paths are invalid`)
  }
  if (value.error !== undefined && value.error !== null) {
    const error = record(value.error, `ledger message ${value.id} error`)
    nonEmptyString(error.code, `ledger message ${value.id} error.code`)
    if (typeof error.message !== 'string') corrupt(`ledger message ${value.id} error.message is invalid`)
  }
  for (const [field, time] of [
    ['acceptedAt', value.acceptedAt],
    ['deadlineAt', value.deadlineAt],
    ['timedOutAt', value.timedOutAt],
    ['lateReplyAt', value.lateReplyAt],
    ['heldAt', value.heldAt],
    ['cancelledAt', value.cancelledAt],
    ['budgetReservedAt', value.budgetReservedAt],
  ]) {
    optionalTime(time, `ledger message ${value.id} ${field}`)
  }
  if (value.budgetReservedDay !== undefined) {
    if (typeof value.budgetReservedDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.budgetReservedDay)) {
      corrupt(`ledger message ${value.id} budgetReservedDay is invalid`)
    }
  }
  const chain = chains[value.chainId]
  if (value.hop > chain.maxHops) {
    corrupt(`ledger message ${value.id} hop exceeds its chain budget`)
  }
}

/** @param {string} key @param {unknown} operation */
function validateV1Operation(key, operation) {
  const value = record(operation, `ledger operation ${key}`)
  if (value.key !== undefined && value.key !== key) corrupt('ledger operation key mismatch')
  nonEmptyString(value.from, `ledger operation ${key} from`)
  nonEmptyString(value.operationId, `ledger operation ${key} operationId`)
  nonEmptyString(value.fingerprint, `ledger operation ${key} fingerprint`)
  if (!Array.isArray(value.targets) || value.targets.length === 0) {
    corrupt(`ledger operation ${key} targets are invalid`)
  }
  if (new Set(value.targets).size !== value.targets.length) corrupt(`ledger operation ${key} targets are duplicated`)
  for (const target of value.targets) nonEmptyString(target, `ledger operation ${key} target`)
  const messageIds = record(value.messageIds, `ledger operation ${key} messageIds`)
  for (const target of value.targets) nonEmptyString(messageIds[target], `ledger operation ${key} messageId`)
  safeInteger(value.at, `ledger operation ${key} at`)
}

/**
 * Validate one v0.1 ledger with the frozen v0.1 rules. Returns a detached copy
 * so migration cannot mutate the parsed source or its raw backup.
 * @param {unknown} state
 * @returns {Record<string, any>}
 */
export function validateV1State(state) {
  if (!isPlainObject(state)) corrupt('ledger state is not an object')
  const value = structuredClone(state)
  if (value.version !== V1_STATE_VERSION) corrupt(`ledger uses unsupported state version ${String(value.version)}`)
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) corrupt('ledger revision is invalid')
  if (!Number.isSafeInteger(value.createdAt) || value.createdAt < 0) corrupt('ledger createdAt is invalid')
  if (!Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) corrupt('ledger updatedAt is invalid')
  if (!Array.isArray(value.messages)) corrupt('ledger messages are invalid')
  if (value.messages.length > V1_MAX_MESSAGES) corrupt('ledger message count is oversized')
  if (!isPlainObject(value.chains)) corrupt('ledger chains are invalid')
  if (!isPlainObject(value.operations)) corrupt('ledger operations are invalid')
  if (!Array.isArray(value.latches)) corrupt('ledger latches are invalid')
  value.settings = validateV1Settings(value.settings)
  validateV1Budget(value.budget)
  validateV1Latches(value.latches)
  const chainIds = new Set(Object.keys(value.chains))
  for (const [id, chain] of Object.entries(value.chains)) validateV1Chain(id, chain)
  const messageIds = new Set()
  const messagesById = new Map()
  for (const message of value.messages) {
    validateV1Message(message, chainIds, messageIds, value.chains)
    messagesById.set(message.id, message)
  }
  for (const message of value.messages) {
    if (message.replyTo !== undefined && message.replyTo !== null && message.replyTo !== message.parentMessageId) {
      corrupt(`ledger message ${message.id} replyTo mismatch`)
    }
    for (const field of ['parentMessageId', 'replyTo']) {
      const parentId = message[field]
      if (parentId === undefined || parentId === null) continue
      const parent = messagesById.get(parentId)
      if (parent === undefined) corrupt(`ledger message ${message.id} ${field} is dangling`)
      if (parent.chainId !== message.chainId) corrupt(`ledger message ${message.id} ${field} crosses chains`)
      if (message.hop !== parent.hop + 1) corrupt(`ledger message ${message.id} hop does not follow its parent`)
      if (message.kind === 'reply') {
        if (parent.kind !== 'request' || parent.to !== message.from) {
          corrupt(`ledger message ${message.id} reply parent is not a request from the original recipient`)
        }
      } else if (parent.from !== message.from && parent.to !== message.from) {
        corrupt(`ledger message ${message.id} parent does not involve the sender`)
      }
    }
  }
  for (const [key, operation] of Object.entries(value.operations)) validateV1Operation(key, operation)
  return value
}

/** @param {Record<string, any>} settings */
function mapV1Settings(settings) {
  return {
    enabled: settings.enabled,
    paused: settings.emergencyPaused === true || settings.autoCollaborate === false,
    maxConcurrent: settings.maxConcurrent === 2 ? 3 : settings.maxConcurrent,
    requestTimeoutMs: settings.requestTimeoutMs,
    retentionDays: settings.retentionDays,
  }
}

/**
 * v0.1 Engine.send can create a held row with only error.code and no
 * heldReason (emergencyPaused/autoCollaborate=false). Normalize that real old
 * shape to the v2 vocabulary, but never let error.code override an explicit
 * heldReason (manual/custom/unknown stays conservative).
 */
const V1_AUTO_HELD_ERROR_CODES = Object.freeze([
  'emergency_paused',
  'auto_collaborate_off',
  'disabled',
  'held_full',
])

/** @param {Record<string, any>} message */
function normalizeHeldReason(message) {
  if (message.status !== 'held') return
  if (message.heldReason !== undefined && message.heldReason !== null) return
  const code = message.error?.code
  if (typeof code === 'string' && V1_AUTO_HELD_ERROR_CODES.includes(code)) {
    message.heldReason = code
  }
}

/** @param {Record<string, any>} message */
function isAutomaticGlobalHeld(message) {
  if (message.status !== 'held') return false
  if (message.heldReason !== undefined && message.heldReason !== null) {
    return AUTO_HELD_REASONS.includes(message.heldReason)
  }
  if (message.heldOverflow === true) return true
  const code = message.error?.code
  return typeof code === 'string' && V1_AUTO_HELD_ERROR_CODES.includes(code)
}

/** @param {Record<string, any>} message @param {Record<string, any>} chains */
function chainIsOpen(message, chains) {
  return chains[message.chainId]?.state === 'open'
}

/**
 * Derive a completion time only from explicit timestamps the v0.1 record
 * already carries. Missing evidence is left absent so retention keeps the
 * record conservatively.
 * @param {Record<string, any>} message
 * @param {Record<string, any>} chains
 * @returns {number | undefined}
 */
function derivedCompletedAt(message, chains) {
  if (Number.isSafeInteger(message.completedAt)) return message.completedAt
  if (message.status === 'failed') return message.failedAt
  if (message.status === 'cancelled') return message.cancelledAt
  if (message.kind === 'notification' || message.kind === 'reply') {
    return message.status === 'accepted' && Number.isSafeInteger(message.acceptedAt) ? message.acceptedAt : undefined
  }
  if (message.kind === 'request') {
    if (message.replyStatus === 'answered' && Number.isSafeInteger(message.answeredAt)) return message.answeredAt
    if (message.replyStatus === 'timed_out' && Number.isSafeInteger(message.timedOutAt)) return message.timedOutAt
    if (message.status === 'cancelled' && Number.isSafeInteger(message.cancelledAt)) return message.cancelledAt
    if (message.status === 'accepted' && chains[message.chainId]?.state === 'closed' && Number.isSafeInteger(chains[message.chainId].closedAt)) {
      return chains[message.chainId].closedAt
    }
  }
  return undefined
}

/** @param {Record<string, any>} message @param {number} now @param {Record<string, any>} chains @param {Record<string, any>} settings */
function migrateMessage(message, now, chains, settings) {
  const next = structuredClone(message)
  if (!Number.isSafeInteger(next.contentBytes)) {
    try {
      next.contentBytes = Buffer.byteLength(JSON.stringify(next.content), 'utf8')
    } catch {
      next.contentBytes = 0
    }
  }
  normalizeHeldReason(next)
  const completedAt = derivedCompletedAt(next, chains)
  if (completedAt !== undefined && !Number.isSafeInteger(next.completedAt)) next.completedAt = completedAt
  if (isAutomaticGlobalHeld(next) && settings.enabled === true && settings.paused !== true && chainIsOpen(next, chains)) {
    next.status = 'pending'
    next.error = null
    next.heldAt = null
    next.heldReason = null
    next.autoResumedAt = now
    delete next.heldOverflow
    if ('releaseAuthorized' in next) next.releaseAuthorized = false
  }
  // Historical budget reservations/release flags are audit-only in v2.
  delete next.budgetReservedAt
  delete next.budgetReservedDay
  return next
}

/** @param {Record<string, any>} chain */
function migrateChain(chain) {
  const next = structuredClone(chain)
  if (next.state === 'paused' && RETIRED_CHAIN_PAUSE_REASONS.includes(next.pausedReason)) {
    return {
      chain: { ...next, state: 'open', pausedAt: undefined, pausedReason: undefined },
      retired: { chainId: next.id, pausedReason: next.pausedReason, pausedAt: next.pausedAt ?? null },
    }
  }
  return { chain: next, retired: undefined }
}

/** Sort object keys recursively so a digest does not depend on JSON order. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  if (value === undefined) return 'null'
  return JSON.stringify(value)
}

/** @param {unknown} bytes @returns {string} */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Digest used for the conservative rollback gate: the persisted v2 snapshot
 * excluding the mutable revision fields and the private marker itself.
 * @param {Record<string, any>} state
 * @returns {string}
 */
export function baselineStateDigest(state) {
  const copy = structuredClone(state)
  delete copy.revision
  delete copy.updatedAt
  delete copy.migration
  return sha256(Buffer.from(canonicalJson(copy), 'utf8'))
}

/**
 * Digest for the v3 -> v2 rollback gate. Unlike the v1 marker digest this keeps
 * the v1 migration marker (it is real v2 content) and ignores only the v3
 * schema upgrade marker plus the mutable revision fields.
 * @param {Record<string, any>} state
 * @returns {string}
 */
export function baselineV3StateDigest(state) {
  const copy = structuredClone(state)
  delete copy.revision
  delete copy.updatedAt
  delete copy.upgrade
  return sha256(Buffer.from(canonicalJson(copy), 'utf8'))
}

/** Fixed legacy receipt created for every row that predates schema 3. */
function legacyReceipt() {
  return {
    policy: 'legacy-accepted',
    state: 'uncertain',
    receivedAt: null,
    receivedSeq: null,
    timeoutMs: null,
    transfer: null,
  }
}

/**
 * Pure v2 -> v3 conversion. It never deletes messages/chains/operations and
 * never runs retention cleanup. Every old row receives a legacy-accepted
 * receipt with no invented timing evidence; all IDs, associations, statuses,
 * content, deadlines, timeout and answer history are preserved byte-for-value.
 * @param {Record<string, any>} v2
 * @param {{ now: number, fromStateSha256: string, backupPath: string }} options
 * @returns {Record<string, any>}
 */
export function migrateV2State(v2, options) {
  const state = structuredClone(v2)
  // v2 never owns these v3-only private fields; drop any unknown copy so a
  // hand-edited v2 file cannot preload a journal or upgrade marker.
  delete state.upgrade
  delete state.transfers
  for (const message of state.messages) message.receipt = legacyReceipt()
  state.version = V3_STATE_VERSION
  state.updatedAt = options.now
  state.upgrade = {
    fromVersion: V2_STATE_VERSION,
    fromStateSha256: options.fromStateSha256,
    migratedAt: options.now,
    migratedRevision: v2.revision,
    migratedSettingsRevision: v2.settingsRevision,
    backupPath: options.backupPath,
    baselineStateDigest: baselineV3StateDigest(state),
  }
  return state
}

/**
 * Validate the private v2 -> v3 upgrade marker.
 * @param {unknown} upgrade
 * @returns {Record<string, any>}
 */
export function validateUpgradeMarker(upgrade) {
  const value = record(upgrade, 'ledger upgrade marker')
  if (value.fromVersion !== V2_STATE_VERSION) corrupt('ledger upgrade fromVersion is invalid')
  if (typeof value.fromStateSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.fromStateSha256)) {
    corrupt('ledger upgrade fromStateSha256 is invalid')
  }
  safeInteger(value.migratedAt, 'ledger upgrade migratedAt')
  safeInteger(value.migratedRevision, 'ledger upgrade migratedRevision', 1)
  safeInteger(value.migratedSettingsRevision, 'ledger upgrade migratedSettingsRevision', 1)
  if (typeof value.backupPath !== 'string' || value.backupPath.length === 0) {
    corrupt('ledger upgrade backupPath is invalid')
  }
  const basename = value.backupPath.split(/[\\/]/).pop() ?? ''
  if (!basename.startsWith(V2_BACKUP_PREFIX)) corrupt('ledger upgrade backupPath is not a v2 backup')
  if (typeof value.baselineStateDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.baselineStateDigest)) {
    corrupt('ledger upgrade baselineStateDigest is invalid')
  }
  return value
}

/**
 * Pure v3 -> v2 preflight for Lead-owned offline scripts. It is deliberately
 * conservative: any post-upgrade revision/settings change, receipt observation,
 * message/operation change, or backup mismatch rejects the restore.
 * @param {{ currentState: unknown, upgrade: unknown, backupRaw: string|Buffer }} request
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function v3ToV2Preflight(request) {
  const reasons = []
  const state = request?.currentState
  if (!isPlainObject(state) || state.version !== V3_STATE_VERSION) {
    return { ok: false, reasons: ['current state is not a v3 ledger'] }
  }
  let marker
  try {
    marker = validateUpgradeMarker(request.upgrade)
  } catch {
    return { ok: false, reasons: ['upgrade marker is invalid'] }
  }
  if (canonicalJson(marker) !== canonicalJson(state.upgrade)) {
    return { ok: false, reasons: ['upgrade marker does not belong to the current state'] }
  }
  const raw = request.backupRaw
  const digest = sha256(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''), 'utf8'))
  if (digest !== marker.fromStateSha256) reasons.push('v2 backup digest does not match the upgrade marker')
  if (state.revision !== marker.migratedRevision) reasons.push('ledger revision changed after the v2 upgrade')
  if (state.settingsRevision !== marker.migratedSettingsRevision) reasons.push('settings changed after the v2 upgrade')
  let currentDigest
  try {
    currentDigest = baselineV3StateDigest(state)
  } catch {
    reasons.push('current state cannot be canonicalized')
  }
  if (currentDigest !== undefined && currentDigest !== marker.baselineStateDigest) {
    reasons.push('state content changed after the v2 upgrade')
  }
  return { ok: reasons.length === 0, reasons }
}

/**
 * Pure v1 -> v2 conversion. It never deletes messages, chains, or operations
 * and never runs retention cleanup; only the documented status/settings/pause
 * transformations are applied.
 * @param {Record<string, any>} v1
 * @param {{ now: number, fromStateSha256: string, backupPath: string }} options
 * @returns {Record<string, any>}
 */
export function migrateV1State(v1, options) {
  const settings = mapV1Settings(v1.settings)
  const chains = {}
  const retiredQuotaPauses = []
  for (const [id, chain] of Object.entries(v1.chains)) {
    const migrated = migrateChain(chain)
    chains[id] = migrated.chain
    if (migrated.retired !== undefined) retiredQuotaPauses.push(migrated.retired)
  }
  const messages = v1.messages.map((message) => migrateMessage(message, options.now, chains, settings))
  // The converted state's held -> pending pass already happened per message;
  // chain references above use the chain ids, not the messages.
  for (const chain of Object.values(chains)) {
    if (chain.pausedAt === undefined) delete chain.pausedAt
    if (chain.pausedReason === undefined) delete chain.pausedReason
  }
  const operations = structuredClone(v1.operations)
  const state = {
    version: V2_STATE_VERSION,
    revision: v1.revision,
    settingsRevision: 1,
    createdAt: v1.createdAt,
    updatedAt: options.now,
    settings,
    messages,
    chains,
    operations,
  }
  const digest = baselineStateDigest(state)
  state.migration = {
    fromVersion: V1_STATE_VERSION,
    fromStateSha256: options.fromStateSha256,
    migratedAt: options.now,
    migratedRevision: v1.revision,
    migratedSettingsRevision: 1,
    backupPath: options.backupPath,
    settingsBefore: structuredClone(v1.settings),
    retiredQuotaPauses,
    retiredLatches: structuredClone(v1.latches),
    baselineMessageIds: messages.map((message) => message.id),
    baselineOperationKeys: Object.keys(operations),
    baselineStateDigest: digest,
  }
  return state
}

/**
 * Public, minimal migration summary for snapshot. The private marker retains
 * backup paths, baseline lists, and retired audit arrays.
 * @param {Record<string, any>} migration
 * @returns {Record<string, any>}
 */
export function publicMigration(migration) {
  if (!isPlainObject(migration)) return undefined
  return {
    fromVersion: migration.fromVersion,
    migratedAt: migration.migratedAt,
    migratedRevision: migration.migratedRevision,
    migratedSettingsRevision: migration.migratedSettingsRevision,
    backupAvailable: typeof migration.backupPath === 'string' && migration.backupPath.length > 0,
    retiredQuotaPauses: Array.isArray(migration.retiredQuotaPauses) ? migration.retiredQuotaPauses.length : 0,
    retiredLatches: Array.isArray(migration.retiredLatches) ? migration.retiredLatches.length : 0,
  }
}

/**
 * Validate the public migration summary/full marker enough for the v2 loader.
 * @param {unknown} migration
 */
export function validateMigrationMarker(migration) {
  const value = record(migration, 'ledger migration marker')
  if (value.fromVersion !== V1_STATE_VERSION) corrupt('ledger migration fromVersion is invalid')
  if (typeof value.fromStateSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.fromStateSha256)) {
    corrupt('ledger migration fromStateSha256 is invalid')
  }
  safeInteger(value.migratedAt, 'ledger migration migratedAt')
  safeInteger(value.migratedRevision, 'ledger migration migratedRevision', 1)
  safeInteger(value.migratedSettingsRevision, 'ledger migration migratedSettingsRevision', 1)
  if (typeof value.backupPath !== 'string' || value.backupPath.length === 0) {
    corrupt('ledger migration backupPath is invalid')
  }
  if (!isPlainObject(value.settingsBefore)) corrupt('ledger migration settingsBefore is invalid')
  if (!Array.isArray(value.retiredQuotaPauses)) corrupt('ledger migration retiredQuotaPauses is invalid')
  for (const [index, entry] of value.retiredQuotaPauses.entries()) {
    const item = record(entry, `ledger migration retiredQuotaPauses ${index}`)
    nonEmptyString(item.chainId, `ledger migration retiredQuotaPauses ${index}.chainId`)
    nonEmptyString(item.pausedReason, `ledger migration retiredQuotaPauses ${index}.pausedReason`)
    optionalTime(item.pausedAt, `ledger migration retiredQuotaPauses ${index}.pausedAt`)
  }
  if (!Array.isArray(value.retiredLatches)) corrupt('ledger migration retiredLatches is invalid')
  validateV1Latches(value.retiredLatches)
  if (!Array.isArray(value.baselineMessageIds)) corrupt('ledger migration baselineMessageIds is invalid')
  for (const id of value.baselineMessageIds) nonEmptyString(id, 'ledger migration baselineMessageId')
  if (!Array.isArray(value.baselineOperationKeys)) corrupt('ledger migration baselineOperationKeys is invalid')
  for (const key of value.baselineOperationKeys) nonEmptyString(key, 'ledger migration baselineOperationKey')
  if (typeof value.baselineStateDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.baselineStateDigest)) {
    corrupt('ledger migration baselineStateDigest is invalid')
  }
  return value
}

/**
 * Pure rollback preflight. Lead-owned offline scripts call this with the
 * current v2 state, its private marker, and the exact v1 backup bytes; the
 * function never writes anything. It is deliberately conservative: any new
 * message, operation, status transition, or settings change rejects rollback.
 * @param {{ currentState: unknown, migration: unknown, backupRaw: string|Buffer }} request
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function rollbackPreflight(request) {
  const reasons = []
  const state = request?.currentState
  if (!isPlainObject(state) || state.version !== V2_STATE_VERSION) {
    return { ok: false, reasons: ['current state is not a v2 ledger'] }
  }
  let marker
  try {
    marker = validateMigrationMarker(request.migration)
  } catch {
    return { ok: false, reasons: ['migration marker is invalid'] }
  }
  const raw = request.backupRaw
  const digest = sha256(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''), 'utf8'))
  if (digest !== marker.fromStateSha256) reasons.push('v1 backup digest does not match the migration marker')
  if (state.settingsRevision !== marker.migratedSettingsRevision) reasons.push('settings changed after migration')
  const stateIds = state.messages.map((message) => message.id)
  if (
    stateIds.length !== marker.baselineMessageIds.length ||
    stateIds.some((id, index) => id !== marker.baselineMessageIds[index])
  ) {
    reasons.push('message IDs differ from the migration baseline')
  }
  const operationKeys = Object.keys(state.operations)
  if (
    operationKeys.length !== marker.baselineOperationKeys.length ||
    operationKeys.some((key, index) => key !== marker.baselineOperationKeys[index])
  ) {
    reasons.push('operation keys differ from the migration baseline')
  }
  let currentDigest
  try {
    currentDigest = baselineStateDigest(state)
  } catch {
    reasons.push('current state cannot be canonicalized')
  }
  if (currentDigest !== undefined && currentDigest !== marker.baselineStateDigest) {
    reasons.push('state content, IDs, associations, durable IDs, or statuses changed after migration')
  }
  if (state.revision !== marker.migratedRevision) reasons.push('ledger revision changed after migration')
  return { ok: reasons.length === 0, reasons }
}
