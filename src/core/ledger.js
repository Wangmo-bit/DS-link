/**
 * Private, atomic, single-writer v0.2 ledger.
 *
 * - directory 0700, files 0600, same-directory temp + fsync + rename + dir fsync;
 * - one OS-backed SQLite EXCLUSIVE writer claim for the life of the ledger;
 * - v1 ledgers are validated with the frozen v0.1 rules, backed up verbatim,
 *   then converted and atomically persisted as v2;
 * - a persist failure poisons the ledger: reads may show the last confirmed
 *   memory, but no mutation is accepted until a safe reopen;
 * - unknown versions and malformed records fail closed and are never rewritten.
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  CHAIN_STATES,
  CREATE_PHASES,
  CREATE_RENAME_STATUSES,
  DISPATCH_STATUSES,
  LEDGER_FILE,
  LOCK_DB_FILE,
  LOCK_FILE,
  MESSAGE_KINDS,
  REPLY_STATUSES,
  STATE_VERSION,
  LIMITS,
  V1_BACKUP_PREFIX,
  V2_BACKUP_PREFIX,
  V2_ROLLBACK_BACKUP_PREFIX,
  V3_ROLLBACK_BACKUP_PREFIX,
} from './constants.js'
import { fail } from './errors.js'
import { createDefaultSettings, validateStoredSettings } from './settings.js'
import { isPlainObject } from './validation.js'
import {
  migrateV1State,
  migrateV2State,
  rollbackPreflight,
  sha256,
  validateMigrationMarker,
  validateUpgradeMarker,
  validateV1State,
  v3ToV2Preflight,
  V2_STATE_VERSION,
} from './migration.js'

export const SKIP = Symbol('session-link.skip-mutation')

/** @template T @param {T} value @returns {{ [SKIP]: true, value: T }} */
export function skipMutation(value) {
  return { [SKIP]: true, value }
}

class SerialQueue {
  #tail = Promise.resolve()

  /** @template T @param {() => Promise<T> | T} task @returns {Promise<T>} */
  run(task) {
    const result = this.#tail.then(task, task)
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async drain() {
    await this.#tail
  }
}

/** @returns {Record<string, any>} */
function initialState(now) {
  return {
    version: STATE_VERSION,
    revision: 1,
    settingsRevision: 1,
    createdAt: now,
    updatedAt: now,
    settings: createDefaultSettings(),
    messages: [],
    chains: {},
    operations: {},
  }
}

/** @param {string} message */
function corrupt(message) {
  return fail('storage_corrupt', message)
}

/** @param {unknown} value @param {string} label @returns {Record<string, any>} */
function record(value, label) {
  if (!isPlainObject(value)) throw corrupt(`${label} is invalid`)
  return value
}

/** @param {unknown} value @param {string} label */
function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw corrupt(`${label} is invalid`)
}

/** @param {unknown} value @param {string} label @param {number} [min] */
function safeInteger(value, label, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) throw corrupt(`${label} is invalid`)
}

/** @param {unknown} value @param {string} label */
function optionalTime(value, label) {
  if (value === undefined || value === null) return
  safeInteger(value, label)
}

/** @param {unknown} value @param {string} label */
function optionalString(value, label) {
  if (value === undefined || value === null) return
  nonEmptyString(value, label)
}

/** @param {string} id @param {unknown} chain */
function validateChain(id, chain) {
  const value = record(chain, `ledger chain ${id}`)
  if (value.id !== id) throw corrupt(`ledger chain ${id} id mismatch`)
  nonEmptyString(value.rootOwner, `ledger chain ${id} rootOwner`)
  safeInteger(value.createdAt, `ledger chain ${id} createdAt`)
  if (!CHAIN_STATES.includes(value.state)) throw corrupt(`ledger chain ${id} state is invalid`)
  // v1 chain budget fields are inert audit fields in v2 when present.
  if (value.maxMessages !== undefined) safeInteger(value.maxMessages, `ledger chain ${id} maxMessages`, 1)
  if (value.maxHops !== undefined) safeInteger(value.maxHops, `ledger chain ${id} maxHops`, 1)
  if (value.messageCount !== undefined) safeInteger(value.messageCount, `ledger chain ${id} messageCount`)
  optionalTime(value.pausedAt, `ledger chain ${id} pausedAt`)
  optionalTime(value.closedAt, `ledger chain ${id} closedAt`)
  optionalString(value.pausedReason, `ledger chain ${id} pausedReason`)
  optionalString(value.closedBy, `ledger chain ${id} closedBy`)
}

/**
 * @param {unknown} message
 * @param {Set<string>} chainIds
 * @param {Set<string>} messageIds
 * @param {Record<string, any>} chains
 */
function validateMessage(message, chainIds, messageIds, chains) {
  const value = record(message, 'ledger message')
  nonEmptyString(value.id, 'ledger message id')
  if (messageIds.has(value.id)) throw corrupt('ledger message id is duplicated')
  messageIds.add(value.id)
  nonEmptyString(value.from, `ledger message ${value.id} from`)
  nonEmptyString(value.to, `ledger message ${value.id} to`)
  if (value.from === value.to) throw corrupt(`ledger message ${value.id} targets itself`)
  if (!MESSAGE_KINDS.includes(value.kind)) throw corrupt(`ledger message ${value.id} kind is invalid`)
  nonEmptyString(value.chainId, `ledger message ${value.id} chainId`)
  if (!chainIds.has(value.chainId)) throw corrupt(`ledger message ${value.id} references an unknown chain`)
  safeInteger(value.hop, `ledger message ${value.id} hop`)
  safeInteger(value.createdAt, `ledger message ${value.id} createdAt`)
  if (!DISPATCH_STATUSES.includes(value.status)) throw corrupt(`ledger message ${value.id} status is invalid`)
  if (!REPLY_STATUSES.includes(value.replyStatus)) throw corrupt(`ledger message ${value.id} replyStatus is invalid`)
  optionalString(value.operationId, `ledger message ${value.id} operationId`)
  if (value.deliveryAttempts !== undefined) safeInteger(value.deliveryAttempts, `ledger message ${value.id} deliveryAttempts`)
  if (value.durableMessageId !== undefined && value.durableMessageId !== null) {
    nonEmptyString(value.durableMessageId, `ledger message ${value.id} durableMessageId`)
  }
  const content = record(value.content, `ledger message ${value.id} content`)
  if (typeof content.text !== 'string') throw corrupt(`ledger message ${value.id} content.text is invalid`)
  if (!Array.isArray(content.references)) throw corrupt(`ledger message ${value.id} references are invalid`)
  for (const [index, reference] of content.references.entries()) {
    const entry = record(reference, `ledger message ${value.id} reference ${index}`)
    nonEmptyString(entry.sessionId, `ledger message ${value.id} reference sessionId`)
    safeInteger(entry.seq, `ledger message ${value.id} reference seq`)
    if (typeof entry.text !== 'string') throw corrupt(`ledger message ${value.id} reference text is invalid`)
  }
  if (!Array.isArray(content.paths) || content.paths.some((item) => typeof item !== 'string')) {
    throw corrupt(`ledger message ${value.id} paths are invalid`)
  }
  if (value.error !== undefined && value.error !== null) {
    const error = record(value.error, `ledger message ${value.id} error`)
    nonEmptyString(error.code, `ledger message ${value.id} error.code`)
    if (typeof error.message !== 'string') throw corrupt(`ledger message ${value.id} error.message is invalid`)
  }
  if (value.contentBytes !== undefined) safeInteger(value.contentBytes, `ledger message ${value.id} contentBytes`)
  if (value.subject !== undefined && value.subject !== null && typeof value.subject !== 'string') {
    throw corrupt(`ledger message ${value.id} subject is invalid`)
  }
  for (const [field, time] of [
    ['acceptedAt', value.acceptedAt],
    ['deadlineAt', value.deadlineAt],
    ['timedOutAt', value.timedOutAt],
    ['lateReplyAt', value.lateReplyAt],
    ['heldAt', value.heldAt],
    ['cancelledAt', value.cancelledAt],
    ['failedAt', value.failedAt],
    ['answeredAt', value.answeredAt],
    ['completedAt', value.completedAt],
    ['redactedAt', value.redactedAt],
    ['unknownAt', value.unknownAt],
    ['dispatchStartedAt', value.dispatchStartedAt],
    ['releasedAt', value.releasedAt],
    ['autoResumedAt', value.autoResumedAt],
    ['manualConfirmedAt', value.manualConfirmedAt],
    ['unconfirmedAt', value.unconfirmedAt],
  ]) {
    optionalTime(time, `ledger message ${value.id} ${field}`)
  }
  optionalString(value.heldReason, `ledger message ${value.id} heldReason`)
  if (value.releaseAuthorized !== undefined && typeof value.releaseAuthorized !== 'boolean') {
    throw corrupt(`ledger message ${value.id} releaseAuthorized is invalid`)
  }
  if (value.late !== undefined && typeof value.late !== 'boolean') throw corrupt(`ledger message ${value.id} late is invalid`)
  const chain = chains[value.chainId]
  if (chain === undefined) throw corrupt(`ledger message ${value.id} references an unknown chain`)
}

/** @param {unknown} operation @param {string} key */
function validateOperation(key, operation) {
  const value = record(operation, `ledger operation ${key}`)
  if (value.key !== undefined && value.key !== key) throw corrupt('ledger operation key mismatch')
  nonEmptyString(value.from, `ledger operation ${key} from`)
  nonEmptyString(value.operationId, `ledger operation ${key} operationId`)
  nonEmptyString(value.fingerprint, `ledger operation ${key} fingerprint`)
  if (!Array.isArray(value.targets) || value.targets.length === 0) throw corrupt(`ledger operation ${key} targets are invalid`)
  if (new Set(value.targets).size !== value.targets.length) throw corrupt(`ledger operation ${key} targets are duplicated`)
  for (const target of value.targets) nonEmptyString(target, `ledger operation ${key} target`)
  const messageIds = record(value.messageIds, `ledger operation ${key} messageIds`)
  for (const target of value.targets) nonEmptyString(messageIds[target], `ledger operation ${key} messageId`)
  safeInteger(value.at, `ledger operation ${key} at`)
}

/**
 * Validate a v2 state. There is intentionally no message-count or hop cap here:
 * a legal large v2 ledger must load, and v1 hop limits never block continuations.
 * @param {unknown} state
 * @returns {Record<string, any>}
 */
export function validateV2State(state) {
  if (!isPlainObject(state)) throw corrupt('ledger state is not an object')
  if (state.version !== V2_STATE_VERSION) throw corrupt(`ledger uses unsupported state version ${String(state.version)}`)
  if (!Number.isSafeInteger(state.revision) || state.revision < 1) throw corrupt('ledger revision is invalid')
  if (!Number.isSafeInteger(state.settingsRevision) || state.settingsRevision < 1) {
    throw corrupt('ledger settingsRevision is invalid')
  }
  if (!Number.isSafeInteger(state.createdAt) || state.createdAt < 0) throw corrupt('ledger createdAt is invalid')
  if (!Number.isSafeInteger(state.updatedAt) || state.updatedAt < 0) throw corrupt('ledger updatedAt is invalid')
  if (!Array.isArray(state.messages)) throw corrupt('ledger messages are invalid')
  if (!isPlainObject(state.chains)) throw corrupt('ledger chains are invalid')
  if (!isPlainObject(state.operations)) throw corrupt('ledger operations are invalid')
  state.settings = validateStoredSettings(state.settings)
  if (state.migration !== undefined) validateMigrationMarker(state.migration)
  const chainIds = new Set(Object.keys(state.chains))
  for (const [id, chain] of Object.entries(state.chains)) validateChain(id, chain)
  const messageIds = new Set()
  const messagesById = new Map()
  for (const message of state.messages) {
    validateMessage(message, chainIds, messageIds, state.chains)
    messagesById.set(message.id, message)
  }
  for (const message of state.messages) {
    if (message.replyTo !== undefined && message.replyTo !== null && message.replyTo !== message.parentMessageId) {
      throw corrupt(`ledger message ${message.id} replyTo mismatch`)
    }
    for (const field of ['parentMessageId', 'replyTo']) {
      const parentId = message[field]
      if (parentId === undefined || parentId === null) continue
      const parent = messagesById.get(parentId)
      if (parent === undefined) throw corrupt(`ledger message ${message.id} ${field} is dangling`)
      if (parent.chainId !== message.chainId) throw corrupt(`ledger message ${message.id} ${field} crosses chains`)
      if (message.hop !== parent.hop + 1) throw corrupt(`ledger message ${message.id} hop does not follow its parent`)
      if (message.kind === 'reply') {
        if (parent.kind !== 'request' || parent.to !== message.from) {
          throw corrupt(`ledger message ${message.id} reply parent is not a request from the original recipient`)
        }
      } else if (parent.from !== message.from && parent.to !== message.from) {
        throw corrupt(`ledger message ${message.id} parent does not involve the sender`)
      }
    }
  }
  for (const [key, operation] of Object.entries(state.operations)) validateOperation(key, operation)
  return state
}

const RECEIPT_POLICIES = Object.freeze(['context', 'legacy-accepted'])
const RECEIPT_STATES = Object.freeze(['not_sent', 'queued', 'received', 'uncertain'])
const TRANSFER_STATES = Object.freeze(['prepared', 'moved', 'uncertain'])
const RECEIPT_KEYS = Object.freeze([
  'policy',
  'state',
  'receivedAt',
  'receivedSeq',
  'timeoutMs',
  'transfer',
])
const TRANSFER_KEYS = Object.freeze(['state', 'at', 'error'])

/** @param {unknown} receipt @param {string} messageId */
function validateReceipt(receipt, messageId) {
  const value = record(receipt, `ledger message ${messageId} receipt`)
  for (const key of Object.keys(value)) {
    if (!RECEIPT_KEYS.includes(key)) throw corrupt(`ledger message ${messageId} receipt has unknown field ${key}`)
  }
  for (const key of RECEIPT_KEYS) {
    if (!(key in value)) throw corrupt(`ledger message ${messageId} receipt is missing ${key}`)
  }
  if (!RECEIPT_POLICIES.includes(value.policy)) {
    throw corrupt(`ledger message ${messageId} receipt.policy is invalid`)
  }
  if (!RECEIPT_STATES.includes(value.state)) {
    throw corrupt(`ledger message ${messageId} receipt.state is invalid`)
  }
  if (value.receivedAt !== null && (!Number.isSafeInteger(value.receivedAt) || value.receivedAt < 0)) {
    throw corrupt(`ledger message ${messageId} receipt.receivedAt is invalid`)
  }
  if (value.receivedSeq !== null && (!Number.isSafeInteger(value.receivedSeq) || value.receivedSeq < 0)) {
    throw corrupt(`ledger message ${messageId} receipt.receivedSeq is invalid`)
  }
  if (value.state === 'received') {
    if (value.receivedAt === null || value.receivedSeq === null) {
      throw corrupt(`ledger message ${messageId} received receipt lacks exact event evidence`)
    }
  } else if (value.receivedAt !== null || value.receivedSeq !== null) {
    throw corrupt(`ledger message ${messageId} non-received receipt carries evidence`)
  }
  if (value.timeoutMs !== null && (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs <= 0)) {
    throw corrupt(`ledger message ${messageId} receipt.timeoutMs is invalid`)
  }
  if (value.transfer !== null) {
    const transfer = record(value.transfer, `ledger message ${messageId} receipt.transfer`)
    for (const key of Object.keys(transfer)) {
      if (!TRANSFER_KEYS.includes(key)) {
        throw corrupt(`ledger message ${messageId} receipt.transfer has unknown field ${key}`)
      }
    }
    if (!TRANSFER_STATES.includes(transfer.state)) {
      throw corrupt(`ledger message ${messageId} receipt.transfer.state is invalid`)
    }
    safeInteger(transfer.at, `ledger message ${messageId} receipt.transfer.at`)
    if (transfer.error !== undefined && typeof transfer.error !== 'string') {
      throw corrupt(`ledger message ${messageId} receipt.transfer.error is invalid`)
    }
  }
}

/**
 * Validate the private transfer journal. Journals never reach the public view:
 * they retain the original host message only for crash recovery and exact
 * identity checks.
 * @param {unknown} transfers
 * @param {Map<string, Record<string, any>>} messagesById
 */
function validateTransfers(transfers, messagesById) {
  const value = record(transfers, 'ledger transfers')
  for (const [messageId, rawJournal] of Object.entries(value)) {
    const journal = record(rawJournal, `ledger transfer ${messageId}`)
    const message = messagesById.get(messageId)
    if (message === undefined) throw corrupt(`ledger transfer ${messageId} references an unknown message`)
    if (journal.messageId !== messageId) throw corrupt(`ledger transfer ${messageId} id mismatch`)
    nonEmptyString(journal.target, `ledger transfer ${messageId} target`)
    if (journal.target !== message.to) throw corrupt(`ledger transfer ${messageId} target mismatch`)
    nonEmptyString(journal.durableMessageId, `ledger transfer ${messageId} durableMessageId`)
    if (journal.durableMessageId !== message.durableMessageId) {
      throw corrupt(`ledger transfer ${messageId} durableMessageId mismatch`)
    }
    const hostMessage = record(journal.hostMessage, `ledger transfer ${messageId} hostMessage`)
    if (hostMessage.id !== journal.durableMessageId) {
      throw corrupt(`ledger transfer ${messageId} hostMessage id mismatch`)
    }
    if (!Array.isArray(hostMessage.content)) {
      throw corrupt(`ledger transfer ${messageId} hostMessage content is invalid`)
    }
    const source = record(hostMessage.source, `ledger transfer ${messageId} hostMessage source`)
    if (Object.keys(source).length !== 3) {
      throw corrupt(`ledger transfer ${messageId} hostMessage source is not the standard shape`)
    }
    if (source.kind !== 'agent-message' || source.form !== 'relay') {
      throw corrupt(`ledger transfer ${messageId} hostMessage source is invalid`)
    }
    if (source.senderSessionId !== message.from) {
      throw corrupt(`ledger transfer ${messageId} hostMessage sender mismatch`)
    }
    safeInteger(journal.queuePosition, `ledger transfer ${messageId} queuePosition`)
    safeInteger(journal.hostSessionSeq, `ledger transfer ${messageId} hostSessionSeq`, -1)
    safeInteger(journal.at, `ledger transfer ${messageId} at`)
    if (journal.attempts !== undefined) safeInteger(journal.attempts, `ledger transfer ${messageId} attempts`)
    if (!TRANSFER_STATES.includes(journal.state)) {
      throw corrupt(`ledger transfer ${messageId} state is invalid`)
    }
    if (typeof journal.digest !== 'string' || !/^[0-9a-f]{64}$/.test(journal.digest)) {
      throw corrupt(`ledger transfer ${messageId} digest is invalid`)
    }
    if (journal.error !== undefined && typeof journal.error !== 'string') {
      throw corrupt(`ledger transfer ${messageId} error is invalid`)
    }
  }
}

/** Exact per-record whitelist for the optional create journal region. */
const CREATE_JOURNAL_KEYS = Object.freeze([
  'key',
  'from',
  'operationId',
  'fingerprint',
  'at',
  'updatedAt',
  'phase',
  'task',
  'subject',
  'title',
  'location',
  'requestedSessionId',
  'sessionId',
  'workspaceId',
  'workspacePath',
  'renameStatus',
  'renameError',
  'sendOperationId',
  'firstMessageId',
  'error',
  'terminalAt',
  'bodyStripped',
])

const CREATE_LOCATION_KEYS = Object.freeze([
  'kind',
  'workspaceId',
  'parentDir',
  'directoryName',
  'workspacePath',
  'workspaceTitle',
])

const CREATE_ERROR_KEYS = Object.freeze(['code', 'message'])

/**
 * Validate the optional create journal region with a strict per-record
 * whitelist: an unknown field, phase, rename status, or malformed effect
 * rejects the whole ledger load instead of being silently dropped. Records
 * keep their private task body only until the first message is delivered;
 * a stripped record carries an empty `task`/`null` `subject` and keeps its
 * fingerprint, status, and association fields.
 * @param {unknown} creates
 */
function validateCreates(creates) {
  const value = record(creates, 'ledger creates')
  for (const [key, rawJournal] of Object.entries(value)) {
    const journal = record(rawJournal, `ledger create ${key}`)
    for (const field of Object.keys(journal)) {
      if (!CREATE_JOURNAL_KEYS.includes(field)) {
        throw corrupt(`ledger create ${key} has unknown field ${field}`)
      }
    }
    for (const field of CREATE_JOURNAL_KEYS) {
      if (!(field in journal)) throw corrupt(`ledger create ${key} is missing ${field}`)
    }
    nonEmptyString(journal.from, `ledger create ${key} from`)
    nonEmptyString(journal.operationId, `ledger create ${key} operationId`)
    if (journal.key !== key || key !== `${journal.from}|${journal.operationId}`) {
      throw corrupt(`ledger create ${key} key mismatch`)
    }
    nonEmptyString(journal.fingerprint, `ledger create ${key} fingerprint`)
    safeInteger(journal.at, `ledger create ${key} at`)
    safeInteger(journal.updatedAt, `ledger create ${key} updatedAt`)
    if (!CREATE_PHASES.includes(journal.phase)) throw corrupt(`ledger create ${key} phase is invalid`)
    if (typeof journal.task !== 'string') throw corrupt(`ledger create ${key} task is invalid`)
    if (journal.subject !== null && typeof journal.subject !== 'string') {
      throw corrupt(`ledger create ${key} subject is invalid`)
    }
    if (journal.title !== null && typeof journal.title !== 'string') {
      throw corrupt(`ledger create ${key} title is invalid`)
    }
    const location = record(journal.location, `ledger create ${key} location`)
    for (const field of Object.keys(location)) {
      if (!CREATE_LOCATION_KEYS.includes(field)) {
        throw corrupt(`ledger create ${key} location has unknown field ${field}`)
      }
    }
    for (const field of CREATE_LOCATION_KEYS) {
      // workspacePath is additive for the existing_project mode; older 0.4
      // journals (workspace/new_project) legitimately lack it.
      if (field === 'workspacePath') continue
      if (!(field in location)) throw corrupt(`ledger create ${key} location is missing ${field}`)
    }
    if (location.kind !== 'workspace' && location.kind !== 'new_project' && location.kind !== 'existing_project') {
      throw corrupt(`ledger create ${key} location.kind is invalid`)
    }
    for (const field of ['workspaceId', 'parentDir', 'directoryName', 'workspacePath', 'workspaceTitle']) {
      // workspacePath is additive; an older journal missing it entirely is
      // valid, while a present value must be a string or null.
      if (field === 'workspacePath' && !(field in location)) continue
      if (location[field] !== null && typeof location[field] !== 'string') {
        throw corrupt(`ledger create ${key} location.${field} is invalid`)
      }
    }
    if (location.kind === 'workspace' && typeof location.workspaceId !== 'string') {
      throw corrupt(`ledger create ${key} workspace location lacks workspaceId`)
    }
    if (location.kind === 'new_project' && (typeof location.parentDir !== 'string' || typeof location.directoryName !== 'string')) {
      throw corrupt(`ledger create ${key} new_project location lacks parentDir/directoryName`)
    }
    if (location.kind === 'existing_project' && typeof location.workspacePath !== 'string') {
      throw corrupt(`ledger create ${key} existing_project location lacks workspacePath`)
    }
    for (const field of ['requestedSessionId', 'sessionId', 'workspaceId', 'workspacePath', 'sendOperationId', 'firstMessageId']) {
      if (journal[field] !== null && typeof journal[field] !== 'string') {
        throw corrupt(`ledger create ${key} ${field} is invalid`)
      }
    }
    if (!CREATE_RENAME_STATUSES.includes(journal.renameStatus)) {
      throw corrupt(`ledger create ${key} renameStatus is invalid`)
    }
    if (journal.renameError !== null && typeof journal.renameError !== 'string') {
      throw corrupt(`ledger create ${key} renameError is invalid`)
    }
    if (journal.error !== null) {
      const error = record(journal.error, `ledger create ${key} error`)
      for (const field of Object.keys(error)) {
        if (!CREATE_ERROR_KEYS.includes(field)) throw corrupt(`ledger create ${key} error has unknown field ${field}`)
      }
      nonEmptyString(error.code, `ledger create ${key} error.code`)
      if (typeof error.message !== 'string') throw corrupt(`ledger create ${key} error.message is invalid`)
    }
    if (journal.terminalAt !== null) safeInteger(journal.terminalAt, `ledger create ${key} terminalAt`)
    if (typeof journal.bodyStripped !== 'boolean') throw corrupt(`ledger create ${key} bodyStripped is invalid`)
  }
}

/**
 * Validate a v3 state. The v2 rules remain frozen in validateV2State; this
 * validator adds the public receipt, the private upgrade marker, and the
 * private transfer journal without relaxing any 0.2 invariant.
 * @param {unknown} state
 * @returns {Record<string, any>}
 */
export function validateV3State(state) {
  if (!isPlainObject(state)) throw corrupt('ledger state is not an object')
  if (state.version !== STATE_VERSION) throw corrupt(`ledger uses unsupported state version ${String(state.version)}`)
  if (!Number.isSafeInteger(state.revision) || state.revision < 1) throw corrupt('ledger revision is invalid')
  if (!Number.isSafeInteger(state.settingsRevision) || state.settingsRevision < 1) {
    throw corrupt('ledger settingsRevision is invalid')
  }
  if (!Number.isSafeInteger(state.createdAt) || state.createdAt < 0) throw corrupt('ledger createdAt is invalid')
  if (!Number.isSafeInteger(state.updatedAt) || state.updatedAt < 0) throw corrupt('ledger updatedAt is invalid')
  if (!Array.isArray(state.messages)) throw corrupt('ledger messages are invalid')
  if (!isPlainObject(state.chains)) throw corrupt('ledger chains are invalid')
  if (!isPlainObject(state.operations)) throw corrupt('ledger operations are invalid')
  state.settings = validateStoredSettings(state.settings)
  if (state.migration !== undefined) validateMigrationMarker(state.migration)
  if (state.upgrade !== undefined) validateUpgradeMarker(state.upgrade)
  const chainIds = new Set(Object.keys(state.chains))
  for (const [id, chain] of Object.entries(state.chains)) validateChain(id, chain)
  const messageIds = new Set()
  const messagesById = new Map()
  for (const message of state.messages) {
    validateMessage(message, chainIds, messageIds, state.chains)
    validateReceipt(message.receipt, message.id)
    messagesById.set(message.id, message)
  }
  for (const message of state.messages) {
    if (message.replyTo !== undefined && message.replyTo !== null && message.replyTo !== message.parentMessageId) {
      throw corrupt(`ledger message ${message.id} replyTo mismatch`)
    }
    for (const field of ['parentMessageId', 'replyTo']) {
      const parentId = message[field]
      if (parentId === undefined || parentId === null) continue
      const parent = messagesById.get(parentId)
      if (parent === undefined) throw corrupt(`ledger message ${message.id} ${field} is dangling`)
      if (parent.chainId !== message.chainId) throw corrupt(`ledger message ${message.id} ${field} crosses chains`)
      if (message.hop !== parent.hop + 1) throw corrupt(`ledger message ${message.id} hop does not follow its parent`)
      if (message.kind === 'reply') {
        if (parent.kind !== 'request' || parent.to !== message.from) {
          throw corrupt(`ledger message ${message.id} reply parent is not a request from the original recipient`)
        }
      } else if (parent.from !== message.from && parent.to !== message.from) {
        throw corrupt(`ledger message ${message.id} parent does not involve the sender`)
      }
    }
  }
  for (const [key, operation] of Object.entries(state.operations)) validateOperation(key, operation)
  if (state.creates !== undefined) validateCreates(state.creates)
  if (state.transfers !== undefined) validateTransfers(state.transfers, messagesById)
  return state
}

export class Ledger {
  /**
   * @param {{
   *   root: string,
   *   clock?: () => number,
   *   hostname?: string,
   *   pid?: number,
   *   processStart?: string,
   *   limits?: { maxDiskBytes?: number },
   * }} options
   */
  constructor(options) {
    if (typeof options?.root !== 'string' || options.root.length === 0) throw fail('invalid_argument', 'ledger root is required')
    this.root = path.resolve(options.root)
    this.statePath = path.join(this.root, LEDGER_FILE)
    this.lockPath = path.join(this.root, LOCK_FILE)
    this.lockDbPath = path.join(this.root, LOCK_DB_FILE)
    this.clock = options.clock ?? Date.now
    this.hostname = options.hostname ?? os.hostname()
    this.pid = options.pid ?? process.pid
    this.processStart =
      options.processStart ?? new Date(Date.now() - process.uptime() * 1000).toISOString()
    this.limits = {
      maxDiskBytes: options.limits?.maxDiskBytes ?? LIMITS.MAX_LEDGER_BYTES,
    }
    if (!Number.isSafeInteger(this.limits.maxDiskBytes) || this.limits.maxDiskBytes <= 0) {
      throw fail('invalid_argument', 'ledger maxDiskBytes must be a positive safe integer')
    }
    this.#queue = new SerialQueue()
    this.#opened = false
    this.#state = undefined
    this.#lockNonce = undefined
    this.#lockDb = undefined
    this.#poisoned = undefined
  }

  #queue
  #opened
  #state
  #lockNonce
  #lockDb
  #poisoned

  /** @returns {Promise<Ledger>} */
  async open() {
    if (this.#opened) return this
    // A failed open may have poisoned this instance mid-migration. A fresh
    // open starts from the on-disk state and must re-evaluate health.
    this.#poisoned = undefined
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
    await fs.chmod(this.root, 0o700)
    await this.#acquireLock()
    try {
      this.#state = await this.#load()
      this.#opened = true
      return this
    } catch (error) {
      await this.#releaseLock().catch(() => undefined)
      throw error
    }
  }

  get opened() {
    return this.#opened
  }

  /** @returns {boolean} */
  get writable() {
    return this.#opened && this.#poisoned === undefined
  }

  /** @returns {Record<string, any> | undefined} */
  get storageError() {
    return this.#poisoned === undefined ? undefined : structuredClone(this.#poisoned)
  }

  /** @returns {Record<string, any>} detached deep copy of the current state */
  read() {
    if (!this.#opened) throw fail('internal', 'ledger is not open')
    return structuredClone(this.#state)
  }

  /**
   * @returns {{
   *   root: string, messageCount: number, chainCount: number, revision: number,
   *   bytes: number, maxBytes: number,
   *   health: 'ok'|'near_capacity'|'full'|'storage_error',
   *   error?: Record<string, any>,
   * }}
   */
  stats() {
    const state = this.read()
    const bytes = Buffer.byteLength(JSON.stringify(state), 'utf8')
    const maxBytes = this.limits.maxDiskBytes
    let health = 'ok'
    if (this.#poisoned !== undefined) health = 'storage_error'
    else if (bytes >= maxBytes) health = 'full'
    else if (bytes >= maxBytes * 0.9) health = 'near_capacity'
    return {
      root: this.root,
      messageCount: state.messages.length,
      chainCount: Object.keys(state.chains).length,
      revision: state.revision,
      bytes,
      maxBytes,
      health,
      ...(this.#poisoned === undefined ? {} : { error: structuredClone(this.#poisoned) }),
    }
  }

  /**
   * Serialize one read-modify-write transaction.
   *
   * A task may return {@link skipMutation} to report a value without writing.
   * Otherwise revision is incremented, the full state is durably replaced, and
   * only then does the new state become visible to readers.
   *
   * @template T
   * @param {(state: Record<string, any>) => T | { [SKIP]: true, value: T }} task
   * @param {{ expectedRevision?: number, delivery?: boolean }} [options]
   * @returns {Promise<T>}
   */
  mutate(task, options = {}) {
    return this.#queue.run(async () => {
      if (!this.#opened) throw fail('internal', 'ledger is not open')
      if (this.#poisoned !== undefined) throw this.#poisonError()
      const draft = structuredClone(this.#state)
      if (options.expectedRevision !== undefined && draft.revision !== options.expectedRevision) {
        throw fail('revision_conflict', 'state changed since the panel snapshot; refresh and retry', {
          currentRevision: draft.revision,
        })
      }
      const result = task(draft)
      if (isPlainObject(result) && result[SKIP] === true) return result.value
      draft.revision = this.#state.revision + 1
      draft.updatedAt = this.clock()
      if (options.delivery === true) this.#assertCapacity(draft)
      await this.#persist(draft)
      this.#state = draft
      return cloneResult(result)
    })
  }

  async close() {
    if (!this.#opened) return
    await this.#queue.run(async () => {
      this.#opened = false
    })
    await this.#releaseLock()
  }

  /** @returns {never} */
  #poisonError() {
    return fail('storage_error', 'session-link ledger is in storage_error; safe reopen required', {
      ...(this.#poisoned ?? {}),
    })
  }

  /** @param {{ stage: string, mayHaveWritten: boolean, message: string }} detail */
  #poison(detail) {
    if (this.#poisoned !== undefined) return
    this.#poisoned = {
      code: 'storage_error',
      stage: detail.stage,
      mayHaveWritten: detail.mayHaveWritten,
      message: detail.message,
      at: this.clock(),
    }
  }

  /**
   * @param {Record<string, any>} state
   * @returns {void}
   */
  #assertCapacity(state) {
    const bytes = Buffer.byteLength(JSON.stringify(state), 'utf8')
    if (bytes > this.limits.maxDiskBytes) {
      throw fail('storage_full', 'session-link ledger capacity is full', {
        bytes,
        maxBytes: this.limits.maxDiskBytes,
      })
    }
  }

  /** @returns {Promise<Record<string, any>>} */
  async #load() {
    let raw
    try {
      raw = await fs.readFile(this.statePath)
    } catch (error) {
      if (error?.code === 'ENOENT') return initialState(this.clock())
      throw fail('storage_corrupt', `ledger cannot be read: ${errorCodeOf(error)}`)
    }
    let parsed
    try {
      parsed = JSON.parse(raw.toString('utf8'))
    } catch {
      throw fail('storage_corrupt', 'ledger JSON is corrupt; refusing to overwrite it')
    }
    if (!isPlainObject(parsed)) throw corrupt('ledger state is not an object')
    if (parsed.version === 1) {
      const v1 = validateV1State(parsed)
      const fromStateSha256 = sha256(raw)
      const backupPath = await this.#writeExactBackup(raw, fromStateSha256, V1_BACKUP_PREFIX, 'v1')
      const migratedV2 = migrateV1State(v1, {
        now: this.clock(),
        fromStateSha256,
        backupPath,
      })
      // Never persist a migration product that the next open would reject.
      // The raw v1 file and backup remain untouched if this fails.
      validateV2State(migratedV2)
      // The v1 -> v2 rules stay frozen at schema 2. Take an exact private v2
      // snapshot of that validated product, then run the separate v2 -> v3
      // conversion so a later 0.3 change cannot pollute the historical chain.
      const v2Bytes = Buffer.from(JSON.stringify(migratedV2), 'utf8')
      const v2Digest = sha256(v2Bytes)
      const v2BackupPath = await this.#writeExactBackup(v2Bytes, v2Digest, V2_BACKUP_PREFIX, 'v2')
      const migratedV3 = migrateV2State(migratedV2, {
        now: this.clock(),
        fromStateSha256: v2Digest,
        backupPath: v2BackupPath,
      })
      validateV3State(migratedV3)
      await this.#persist(migratedV3)
      return migratedV3
    }
    if (parsed.version === V2_STATE_VERSION) {
      const v2 = validateV2State(parsed)
      const v2Digest = sha256(raw)
      const v2BackupPath = await this.#writeExactBackup(raw, v2Digest, V2_BACKUP_PREFIX, 'v2')
      const migrated = migrateV2State(v2, {
        now: this.clock(),
        fromStateSha256: v2Digest,
        backupPath: v2BackupPath,
      })
      validateV3State(migrated)
      await this.#persist(migrated)
      return migrated
    }
    if (parsed.version === STATE_VERSION) return validateV3State(parsed)
    throw corrupt(`ledger uses unsupported state version ${String(parsed.version)}`)
  }

  /**
   * Write exact bytes under an O_EXCL backup name. An existing file is reused
   * only when its digest matches; a backup is never overwritten.
   * @param {Buffer} raw
   * @param {string} digest
   * @param {string} prefix
   * @param {string} label
   * @returns {Promise<string>}
   */
  async #writeExactBackup(raw, digest, prefix, label) {
    const backupPath = path.join(this.root, `${prefix}${digest}.json`)
    try {
      const handle = await fs.open(backupPath, 'wx', 0o600)
      try {
        await handle.writeFile(raw)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.#fsyncDir()
      return backupPath
    } catch (error) {
      if (error?.code === 'EEXIST') {
        const existing = await fs.readFile(backupPath)
        if (sha256(existing) !== digest) {
          throw fail('storage_error', `an existing ${label} backup does not match the ledger being migrated`, {
            backupPath,
          })
        }
        await fs.chmod(backupPath, 0o600)
        return backupPath
      }
      await fs.unlink(backupPath).catch(() => undefined)
      throw fail('storage_failure', `${label} backup cannot be written: ${errorCodeOf(error)}`)
    }
  }

  /** @param {Record<string, any>} state @returns {Promise<void>} */
  async #persist(state) {
    await this.#persistRaw(JSON.stringify(state))
  }

  /** @param {string|Buffer} json @returns {Promise<void>} */
  async #persistRaw(json) {
    const temp = path.join(this.root, `.${LEDGER_FILE}.${this.pid}.${randomUUID()}.tmp`)
    let handle
    let stage = 'write'
    try {
      handle = await fs.open(temp, 'wx', 0o600)
      await handle.writeFile(json)
      await handle.sync()
      await handle.close()
      handle = undefined
      stage = 'rename'
      await fs.rename(temp, this.statePath)
      stage = 'chmod'
      await fs.chmod(this.statePath, 0o600)
      stage = 'fsync'
      await this.#fsyncDir()
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined)
      await fs.unlink(temp).catch(() => undefined)
      const mayHaveWritten = stage === 'rename' || stage === 'chmod' || stage === 'fsync'
      this.#poison({
        stage,
        mayHaveWritten,
        message: `ledger write failed: ${errorCodeOf(error)}`,
      })
      throw fail('storage_error', 'ledger write failed; safe reopen required before further writes', {
        stage,
        mayHaveWritten,
      })
    }
  }

  async #fsyncDir() {
    let handle
    try {
      handle = await fs.open(this.root, 'r')
      await handle.sync()
    } catch (error) {
      // Directory fsync is unsupported on a few filesystems; a failed metadata
      // flush is still a storage failure on the supported Linux target.
      if (error?.code === 'EINVAL' || error?.code === 'ENOTSUP' || error?.code === 'EISDIR') return
      throw error
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  /**
   * Acquire the one-writer claim with an OS-backed SQLite EXCLUSIVE
   * transaction held for the life of this Ledger. The kernel releases it on
   * any process exit, so a crashed writer needs no stale-pid heuristics and
   * two concurrent recoverers cannot both unlink and rebuild a lock file.
   *
   * `writer.lock` remains as bounded, human-readable metadata; it is written
   * only while the database transaction is held and is never consulted to
   * decide ownership.
   * @returns {Promise<void>}
   */
  async #acquireLock() {
    try {
      const handle = await fs.open(this.lockDbPath, 'a', 0o600)
      await handle.close()
      await fs.chmod(this.lockDbPath, 0o600)
    } catch (error) {
      throw fail('storage_failure', `writer lock database cannot be created: ${errorCodeOf(error)}`)
    }

    let db
    try {
      db = new DatabaseSync(this.lockDbPath)
      db.exec('PRAGMA busy_timeout = 0')
      db.exec('BEGIN EXCLUSIVE')
    } catch (error) {
      db?.close?.()
      if (isLocked(error)) {
        throw fail('lock_active', 'session-link state is locked by another live writer')
      }
      throw fail('storage_failure', `writer lock cannot be acquired: ${errorCodeOf(error)}`)
    }

    const nonce = randomUUID()
    const metadata = {
      version: 1,
      plugin: 'dsh-session-link',
      hostname: this.hostname,
      pid: this.pid,
      processStart: this.processStart,
      nonce,
      createdAt: this.clock(),
      mechanism: 'sqlite-exclusive',
    }
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS writer (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          version INTEGER NOT NULL,
          plugin TEXT NOT NULL,
          hostname TEXT NOT NULL,
          pid INTEGER NOT NULL,
          processStart TEXT NOT NULL,
          nonce TEXT NOT NULL,
          createdAt INTEGER NOT NULL
        )
      `)
      db.exec('DELETE FROM writer')
      db.prepare(
        'INSERT INTO writer (id, version, plugin, hostname, pid, processStart, nonce, createdAt) VALUES (1, ?, ?, ?, ?, ?, ?, ?)',
      ).run(metadata.version, metadata.plugin, metadata.hostname, metadata.pid, metadata.processStart, metadata.nonce, metadata.createdAt)
      await fs.writeFile(this.lockPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 })
      await fs.chmod(this.lockPath, 0o600)
      await this.#fsyncDir()
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {}
      db.close()
      throw fail('storage_failure', `writer lock metadata cannot be written: ${errorCodeOf(error)}`)
    }
    this.#lockDb = db
    this.#lockNonce = nonce
  }

  /** @returns {Promise<void>} */
  async #releaseLock() {
    if (this.#lockDb === undefined) return
    const db = this.#lockDb
    this.#lockDb = undefined
    const nonce = this.#lockNonce
    this.#lockNonce = undefined
    try {
      db.exec('COMMIT')
    } catch {
      try {
        db.exec('ROLLBACK')
      } catch {}
    }
    try {
      db.close()
    } finally {
      let raw
      try {
        raw = await fs.readFile(this.lockPath, 'utf8')
      } catch (error) {
        if (error?.code !== 'ENOENT') throw fail('storage_failure', 'writer lock metadata cannot be read during release')
      }
      if (raw !== undefined) {
        let metadata
        try {
          metadata = JSON.parse(raw)
        } catch {
          metadata = undefined
        }
        if (metadata?.nonce === nonce) {
          await fs.unlink(this.lockPath).catch((error) => {
            if (error?.code !== 'ENOENT') throw fail('storage_failure', 'writer lock metadata cannot be removed')
          })
          await this.#fsyncDir()
        }
      }
    }
  }

  /**
   * Offline rollback helper for Lead-owned scripts. The caller must ensure the
   * running service is stopped; this method still requires the writer lock and
   * re-checks the preflight inside it. It writes a v2 backup, then atomically
   * replaces ledger.json with the exact v1 backup (emergencyPaused=true).
   * It is intentionally not exposed by the running plugin/service.
   * @returns {Promise<{ restored: true, v2BackupPath: string, v1BackupPath: string }>}
   */
  async restoreV1Backup() {
    if (!this.#opened) throw fail('internal', 'ledger is not open')
    if (this.#poisoned !== undefined) throw this.#poisonError()
    const state = this.read()
    // A v3 ledger has already run the separate v2 -> v3 upgrade. Restoring the
    // old v1 bytes here would silently discard schema-3 receipts and journals;
    // the only supported v3 exit is the exact v2 backup restore below.
    if (state.version !== V2_STATE_VERSION) {
      throw fail('rollback_conflict', 'v1 restore only supports a v2 ledger; use the v2 upgrade backup for 0.3', {
        stateVersion: state.version,
      })
    }
    const marker = state.migration
    if (!isPlainObject(marker)) throw fail('invalid_argument', 'ledger has no v1 migration marker')
    const v1BackupPath = path.resolve(String(marker.backupPath))
    if (
      path.dirname(v1BackupPath) !== this.root ||
      !path.basename(v1BackupPath).startsWith(V1_BACKUP_PREFIX)
    ) {
      throw fail('storage_error', 'migration backup path is outside the state root')
    }
    let raw
    try {
      raw = await fs.readFile(v1BackupPath)
    } catch (error) {
      throw fail('storage_failure', `v1 backup cannot be read for rollback: ${errorCodeOf(error)}`)
    }
    const v1 = validateV1State(JSON.parse(raw.toString('utf8')))
    const preflight = rollbackPreflight({ currentState: state, migration: marker, backupRaw: raw })
    if (preflight.ok !== true) {
      throw fail('rollback_conflict', 'rollback preflight rejected; keep 0.2 and export data for manual merge', {
        reasons: preflight.reasons,
      })
    }
    const currentJson = JSON.stringify(state)
    const v2Digest = sha256(Buffer.from(currentJson, 'utf8'))
    const v2BackupPath = await this.#writeExactBackup(
      Buffer.from(currentJson, 'utf8'),
      v2Digest,
      V2_ROLLBACK_BACKUP_PREFIX,
      'rollback v2',
    )
    v1.settings.emergencyPaused = true
    v1.updatedAt = this.clock()
    await this.#persist(v1)
    this.#state = v1
    return { restored: true, v2BackupPath, v1BackupPath }
  }

  /**
   * Offline v3 -> v2 restore for Lead-owned scripts. It requires the exact v2
   * backup recorded by the v2 -> v3 upgrade and rejects any write after the
   * upgrade (revision/settingsRevision or baseline content changed). It writes
   * an exact v3 backup first, then atomically replaces ledger.json with the
   * original v2 bytes. The running service must be stopped; this method is not
   * exposed by the plugin.
   * @returns {Promise<{ restored: true, v3BackupPath: string, v2BackupPath: string }>}
   */
  async restoreV2Backup() {
    if (!this.#opened) throw fail('internal', 'ledger is not open')
    if (this.#poisoned !== undefined) throw this.#poisonError()
    const state = this.read()
    if (state.version !== STATE_VERSION) {
      throw fail('rollback_conflict', 'v2 upgrade restore only supports a v3 ledger', {
        stateVersion: state.version,
      })
    }
    const upgrade = state.upgrade
    if (!isPlainObject(upgrade)) throw fail('invalid_argument', 'ledger has no v2 upgrade marker')
    const v2BackupPath = path.resolve(String(upgrade.backupPath))
    if (
      path.dirname(v2BackupPath) !== this.root ||
      !path.basename(v2BackupPath).startsWith(V2_BACKUP_PREFIX)
    ) {
      throw fail('storage_error', 'upgrade backup path is outside the state root')
    }
    let raw
    try {
      raw = await fs.readFile(v2BackupPath)
    } catch (error) {
      throw fail('storage_failure', `v2 backup cannot be read for rollback: ${errorCodeOf(error)}`)
    }
    let v2
    try {
      v2 = validateV2State(JSON.parse(raw.toString('utf8')))
    } catch {
      throw fail('rollback_conflict', 'the recorded v2 upgrade backup is invalid; refusing to replace v3')
    }
    const preflight = v3ToV2Preflight({ currentState: state, upgrade, backupRaw: raw })
    if (preflight.ok !== true) {
      throw fail('rollback_conflict', 'v3 -> v2 preflight rejected; no post-upgrade transaction is allowed', {
        reasons: preflight.reasons,
      })
    }
    const currentJson = Buffer.from(JSON.stringify(state), 'utf8')
    const v3Digest = sha256(currentJson)
    const v3BackupPath = await this.#writeExactBackup(
      currentJson,
      v3Digest,
      V3_ROLLBACK_BACKUP_PREFIX,
      'rollback v3',
    )
    await this.#persistRaw(raw)
    this.#state = v2
    return { restored: true, v3BackupPath, v2BackupPath }
  }
}

/** @param {unknown} error @returns {boolean} */
function isLocked(error) {
  return (
    (error && typeof error === 'object' && (error.errcode === 5 || error.errstr === 'database is locked')) ||
    (error instanceof Error && error.message.toLowerCase().includes('database is locked'))
  )
}

/** @param {unknown} error @returns {string} */
function errorCodeOf(error) {
  if (error && typeof error === 'object' && typeof error.code === 'string') return error.code
  return 'unknown'
}

/** @param {unknown} value */
function cloneResult(value) {
  if (value === undefined) return undefined
  try {
    return structuredClone(value)
  } catch {
    return value
  }
}

export { rollbackPreflight } from './migration.js'
