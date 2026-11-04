/**
 * Pure input validation shared by tools, RPC, and the durable engine.
 *
 * Validation is strict: unknown keys are rejected instead of silently ignored,
 * and the caller's identity is never accepted from a parameter.
 */

import { LIMITS } from './constants.js'
import { fail } from './errors.js'

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {string} [code]
 * @returns {Record<string, unknown>}
 */
export function assertPlainObject(value, label, code = 'invalid_argument') {
  if (!isPlainObject(value)) throw fail(code, `${label} must be a JSON object`)
  return value
}

/**
 * @param {Record<string, unknown>} value
 * @param {readonly string[]} allowed
 * @param {string} label
 * @param {string} [code]
 */
export function assertAllowedKeys(value, allowed, label, code = 'tool_args') {
  const known = new Set(allowed)
  const unknown = Object.keys(value).filter((key) => !known.has(key))
  if (unknown.length > 0) {
    throw fail(code, `${label} does not accept ${unknown.slice(0, 5).join(', ')}`, { unknown: unknown.slice(0, 5) })
  }
}

/** Count Unicode code points, not UTF-16 code units. */
export function unicodeLength(value) {
  return [...value].length
}

/** @param {string} value */
export function utf8Length(value) {
  return Buffer.byteLength(value, 'utf8')
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {{ min?: number, max?: number, code?: string }} [options]
 * @returns {string}
 */
export function requiredString(value, field, options = {}) {
  const code = options.code ?? 'invalid_argument'
  if (typeof value !== 'string') throw fail(code, `${field} must be a string`)
  if (options.min !== undefined && unicodeLength(value) < options.min) {
    throw fail(code, `${field} is shorter than ${options.min} characters`)
  }
  if (options.max !== undefined && unicodeLength(value) > options.max) {
    throw fail(code, `${field} exceeds ${options.max} characters`)
  }
  return value
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {{ min?: number, max?: number, code?: string }} [options]
 * @returns {string | undefined}
 */
export function optionalString(value, field, options = {}) {
  if (value === undefined || value === null) return undefined
  return requiredString(value, field, options)
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {{ min?: number, max?: number, code?: string }} [options]
 * @returns {number}
 */
export function boundedInteger(value, field, options = {}) {
  const code = options.code ?? 'invalid_argument'
  if (!Number.isSafeInteger(value)) throw fail(code, `${field} must be a safe integer`)
  if (options.min !== undefined && value < options.min) throw fail(code, `${field} is below ${options.min}`)
  if (options.max !== undefined && value > options.max) throw fail(code, `${field} is above ${options.max}`)
  return value
}

/**
 * Normalize the target set to a unique sorted array. Order is not meaningful
 * for delivery; sorting makes the idempotency key independent of caller order.
 * @param {unknown} value
 * @param {string} from
 * @returns {string[]}
 */
export function normalizeTargets(value, from) {
  if (!Array.isArray(value) || value.length === 0) throw fail('tool_args', 'targets must be a non-empty array')
  if (value.length > LIMITS.MAX_TARGETS) throw fail('invalid_argument', `a single call accepts at most ${LIMITS.MAX_TARGETS} targets`)
  const targets = []
  const seen = new Set()
  for (const item of value) {
    const target = requiredString(item, 'target', { min: 1, max: 256, code: 'tool_args' })
    if (target === from) throw fail('self_target', 'a session cannot send to itself')
    if (seen.has(target)) throw fail('invalid_argument', 'targets must be unique')
    seen.add(target)
    targets.push(target)
  }
  return targets.sort()
}

/**
 * @param {unknown} value
 * @returns {Array<{ sessionId: string, seq: number, text: string }>}
 */
export function normalizeReferences(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw fail('tool_args', 'references must be an array')
  if (value.length > LIMITS.MAX_REFERENCES) throw fail('invalid_argument', `references accepts at most ${LIMITS.MAX_REFERENCES} items`)
  return value.map((entry, index) => {
    const object = assertPlainObject(entry, `references[${index}]`, 'tool_args')
    assertAllowedKeys(object, ['sessionId', 'seq', 'text'], `references[${index}]`)
    return {
      sessionId: requiredString(object.sessionId, `references[${index}].sessionId`, {
        min: 1,
        max: LIMITS.MAX_REFERENCE_SESSION_ID_CHARS,
        code: 'tool_args',
      }),
      seq: boundedInteger(object.seq, `references[${index}].seq`, { min: 0, code: 'tool_args' }),
      text: requiredString(object.text, `references[${index}].text`, {
        min: 1,
        max: LIMITS.MAX_REFERENCE_CHARS,
        code: 'tool_args',
      }),
    }
  })
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizePaths(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw fail('tool_args', 'paths must be an array')
  if (value.length > LIMITS.MAX_PATHS) throw fail('invalid_argument', `paths accepts at most ${LIMITS.MAX_PATHS} items`)
  return value.map((entry, index) => {
    const text = requiredString(entry, `paths[${index}]`, {
      min: 1,
      max: LIMITS.MAX_PATH_CHARS,
      code: 'tool_args',
    })
    if (text.includes('\u0000')) throw fail('invalid_argument', `paths[${index}] contains NUL`)
    return text
  })
}

/**
 * Validate and freeze one message payload. The whole serialized payload is
 * bounded so references cannot smuggle an unbounded history dump.
 * @param {{ text?: unknown, references?: unknown, paths?: unknown }} input
 * @param {{ maxTextChars?: number }} [settings]
 * @returns {{ text: string, references: Array<{sessionId:string,seq:number,text:string}>, paths: string[], bytes: number }}
 */
export function normalizeContent(input, settings = {}) {
  const object = assertPlainObject(input ?? {}, 'content', 'tool_args')
  assertAllowedKeys(object, ['text', 'references', 'paths'], 'content')
  const maxTextChars = settings.maxTextChars ?? LIMITS.MAX_TEXT_CHARS
  const text = object.text === undefined ? '' : requiredString(object.text, 'text', { code: 'tool_args' })
  if (unicodeLength(text) > maxTextChars) {
    throw fail('invalid_argument', `text exceeds ${Math.min(maxTextChars, LIMITS.MAX_TEXT_CHARS)} characters`)
  }
  if (utf8Length(text) > LIMITS.MAX_TEXT_BYTES) {
    throw fail('invalid_argument', `text exceeds ${LIMITS.MAX_TEXT_BYTES} UTF-8 bytes`)
  }
  const references = normalizeReferences(object.references)
  const paths = normalizePaths(object.paths)
  if (text.length === 0 && references.length === 0 && paths.length === 0) {
    throw fail('invalid_argument', 'content must include text, references, or paths')
  }
  const bytes = utf8Length(JSON.stringify({ text, references, paths }))
  if (bytes > LIMITS.MAX_CONTENT_BYTES) {
    throw fail('invalid_argument', `content exceeds ${LIMITS.MAX_CONTENT_BYTES} serialized bytes`)
  }
  return { text, references, paths, bytes }
}

const OPERATION_ID = /^slop:(\d{1,16}):([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/

/**
 * @param {string} uuid
 * @param {number} now
 * @returns {string}
 */
export function mintOperationId(uuid, now) {
  if (!Number.isSafeInteger(now) || now < 0) throw fail('internal', 'invalid clock')
  return `slop:${now}:${uuid}`
}

/**
 * Parse the operationId timestamp and enforce the first-submission window.
 * Duplicate operations skip this check (their original acceptance is durable).
 * @param {unknown} value
 * @param {number} now
 * @returns {{ value: string, at: number }}
 */
export function validateOperationId(value, now) {
  const text = requiredString(value, 'operationId', { max: 128, code: 'tool_args' })
  const match = OPERATION_ID.exec(text)
  if (match === null) {
    throw fail('invalid_argument', 'operationId must be minted by session_link_operation (slop:<ms>:<uuid>)')
  }
  const at = Number(match[1])
  if (!Number.isSafeInteger(at)) throw fail('invalid_argument', 'operationId timestamp is invalid')
  if (at < now - LIMITS.OPERATION_PAST_MS) {
    throw fail('operation_expired', 'operationId is older than 24 hours; mint a new one')
  }
  if (at > now + LIMITS.OPERATION_FUTURE_MS) {
    throw fail('operation_expired', 'operationId timestamp is more than five minutes in the future')
  }
  return { value: text, at }
}

/**
 * Canonical fingerprint of one logical call. It deliberately excludes the
 * caller-selected target array order but includes every other call input.
 * @param {{ kind: string, text: string, references: unknown, paths: unknown, parentMessageId?: string|null, targets: readonly string[] }} call
 * @returns {string}
 */
export function callFingerprint(call) {
  return JSON.stringify({
    kind: call.kind,
    text: call.text,
    references: call.references,
    paths: call.paths,
    parentMessageId: call.parentMessageId ?? null,
    targets: [...call.targets].sort(),
  })
}

/**
 * Turn a profile context name into one safe path segment. Never resolves
 * `..` or an empty value into a parent/current directory.
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeProfileName(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '').slice(0, 64)
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') return 'default'
  return cleaned
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
export function absolutePath(value, field) {
  const text = requiredString(value, field, { min: 1, max: 4096 })
  if (!text.startsWith('/')) throw fail('invalid_argument', `${field} must be an absolute path`)
  if (text.includes('\u0000')) throw fail('invalid_argument', `${field} contains NUL`)
  return text
}
