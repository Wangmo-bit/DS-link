/**
 * Private, atomic, single-writer ledger.
 *
 * - directory 0700, files 0600, same-directory temp + fsync + rename + dir fsync;
 * - every mutation is serialized in-process and persisted before it becomes
 *   visible to readers;
 * - exactly one writer process owns the root via an O_EXCL lock whose metadata
 *   names the host, pid, and process start;
 * - a live or unknown lock is never stolen; a same-host dead pid is reclaimed
 *   only after a second identity check;
 * - unreadable or unknown-version state fails closed instead of being replaced.
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  CHAIN_STATES,
  DISPATCH_STATUSES,
  LEDGER_FILE,
  LOCK_DB_FILE,
  LOCK_FILE,
  MESSAGE_KINDS,
  REPLY_STATUSES,
  STATE_VERSION,
  LIMITS,
} from './constants.js'
import { fail } from './errors.js'
import { ensureBudgetState } from './budget.js'
import { createDefaultSettings, validateStoredSettings } from './settings.js'
import { isPlainObject } from './validation.js'

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
  const state = {
    version: STATE_VERSION,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    settings: createDefaultSettings(),
    messages: [],
    chains: {},
    operations: {},
    latches: [],
    budget: {},
  }
  ensureBudgetState(state, now)
  return state
}

/**
 * @param {unknown} state
 * @param {number} now
 * @returns {Record<string, any>}
 */
function validateState(state, now) {
  if (!isPlainObject(state)) throw corrupt('ledger state is not an object')
  if (state.version !== STATE_VERSION) throw corrupt(`ledger uses unsupported state version ${String(state.version)}`)
  if (!Number.isSafeInteger(state.revision) || state.revision < 1) throw corrupt('ledger revision is invalid')
  if (!Number.isSafeInteger(state.createdAt) || state.createdAt < 0) throw corrupt('ledger createdAt is invalid')
  if (!Number.isSafeInteger(state.updatedAt) || state.updatedAt < 0) throw corrupt('ledger updatedAt is invalid')
  if (!Array.isArray(state.messages)) throw corrupt('ledger messages are invalid')
  if (state.messages.length > LIMITS.MAX_MESSAGES) throw corrupt('ledger message count is oversized')
  if (!isPlainObject(state.chains)) throw corrupt('ledger chains are invalid')
  if (!isPlainObject(state.operations)) throw corrupt('ledger operations are invalid')
  if (!Array.isArray(state.latches)) throw corrupt('ledger latches are invalid')
  state.settings = validateStoredSettings(state.settings)
  validateBudgetRecord(state.budget)
  validateLatches(state.latches)
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

/** @param {unknown} budget */
function validateBudgetRecord(budget) {
  const value = record(budget, 'ledger budget')
  if (!Array.isArray(value.events)) throw corrupt('ledger budget events are invalid')
  if (value.events.length > LIMITS.MAX_MESSAGES) throw corrupt('ledger budget event list is oversized')
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw corrupt('ledger daily key is invalid')
    safeInteger(count, `ledger daily ${day}`)
  }
}

/** @param {unknown} latches */
function validateLatches(latches) {
  const ids = new Set()
  for (const latch of latches) {
    const entry = record(latch, 'ledger latch')
    nonEmptyString(entry.id, 'ledger latch id')
    if (ids.has(entry.id)) throw corrupt('ledger latch id is duplicated')
    ids.add(entry.id)
    nonEmptyString(entry.scope, 'ledger latch scope')
    nonEmptyString(entry.reason, 'ledger latch reason')
    safeInteger(entry.createdAt, 'ledger latch createdAt')
    optionalTime(entry.releasedAt, 'ledger latch releasedAt')
    if (entry.releasedAt !== undefined && entry.releasedAt < entry.createdAt) {
      throw corrupt('ledger latch release precedes creation')
    }
  }
}

/** @param {string} id @param {unknown} chain */
function validateChain(id, chain) {
  const value = record(chain, `ledger chain ${id}`)
  if (value.id !== id) throw corrupt(`ledger chain ${id} id mismatch`)
  nonEmptyString(value.rootOwner, `ledger chain ${id} rootOwner`)
  safeInteger(value.createdAt, `ledger chain ${id} createdAt`)
  if (!CHAIN_STATES.includes(value.state)) throw corrupt(`ledger chain ${id} state is invalid`)
  safeInteger(value.maxMessages, `ledger chain ${id} maxMessages`, 1)
  if (value.maxMessages > LIMITS.CHAIN_MAX_MESSAGES) throw corrupt(`ledger chain ${id} maxMessages is oversized`)
  safeInteger(value.maxHops, `ledger chain ${id} maxHops`, 1)
  if (value.maxHops > LIMITS.CHAIN_MAX_HOPS) throw corrupt(`ledger chain ${id} maxHops is oversized`)
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
  if (value.operationId !== undefined) nonEmptyString(value.operationId, `ledger message ${value.id} operationId`)
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
      throw corrupt(`ledger message ${value.id} budgetReservedDay is invalid`)
    }
  }
  const chain = chains[value.chainId]
  if (chain !== undefined && value.hop > chain.maxHops) {
    throw corrupt(`ledger message ${value.id} hop exceeds its chain budget`)
  }
}

/**
 * @param {string} key
 * @param {unknown} operation
 */
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

export class Ledger {
  /**
   * @param {{
   *   root: string,
   *   clock?: () => number,
   *   hostname?: string,
   *   pid?: number,
   *   processStart?: string,
   *   limits?: { maxMessages?: number, maxDiskBytes?: number },
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
      maxMessages: options.limits?.maxMessages ?? LIMITS.MAX_MESSAGES,
      maxDiskBytes: options.limits?.maxDiskBytes ?? LIMITS.MAX_DISK_BYTES,
    }
    this.#queue = new SerialQueue()
    this.#opened = false
    this.#state = undefined
    this.#lockNonce = undefined
    this.#lockDb = undefined
  }

  #queue
  #opened
  #state
  #lockNonce
  #lockDb

  /** @returns {Promise<Ledger>} */
  async open() {
    if (this.#opened) return this
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

  /** @returns {Record<string, any>} detached deep copy of the current state */
  read() {
    if (!this.#opened) throw fail('internal', 'ledger is not open')
    return structuredClone(this.#state)
  }

  /** @returns {{ root: string, messageCount: number, chainCount: number, revision: number, bytes: number }} */
  stats() {
    const state = this.read()
    const bytes = Buffer.byteLength(JSON.stringify(state), 'utf8')
    return {
      root: this.root,
      messageCount: state.messages.length,
      chainCount: Object.keys(state.chains).length,
      revision: state.revision,
      bytes,
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

  /**
   * @param {Record<string, any>} state
   * @returns {void}
   */
  #assertCapacity(state) {
    if (state.messages.length > this.limits.maxMessages) {
      throw fail('storage_full', 'session-link message capacity is full', {
        messageCount: state.messages.length,
        maxMessages: this.limits.maxMessages,
      })
    }
    const bytes = Buffer.byteLength(JSON.stringify(state), 'utf8')
    if (bytes > this.limits.maxDiskBytes) {
      throw fail('storage_full', 'session-link ledger disk limit is full', {
        bytes,
        maxDiskBytes: this.limits.maxDiskBytes,
      })
    }
  }

  /** @returns {Promise<Record<string, any>>} */
  async #load() {
    let raw
    try {
      raw = await fs.readFile(this.statePath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return initialState(this.clock())
      throw fail('storage_corrupt', `ledger cannot be read: ${errorCodeOf(error)}`)
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw fail('storage_corrupt', 'ledger JSON is corrupt; refusing to overwrite it')
    }
    return validateState(parsed, this.clock())
  }

  /** @param {Record<string, any>} state @returns {Promise<void>} */
  async #persist(state) {
    const json = JSON.stringify(state)
    const temp = path.join(this.root, `.${LEDGER_FILE}.${this.pid}.${randomUUID()}.tmp`)
    let handle
    try {
      handle = await fs.open(temp, 'wx', 0o600)
      await handle.writeFile(json, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await fs.rename(temp, this.statePath)
      await fs.chmod(this.statePath, 0o600)
      await this.#fsyncDir()
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined)
      await fs.unlink(temp).catch(() => undefined)
      throw fail('storage_failure', `ledger write failed: ${errorCodeOf(error)}`)
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
