/**
 * Pure input validation shared by tools, RPC, and the durable engine.
 *
 * Validation is strict: unknown keys are rejected instead of silently ignored,
 * and the caller's identity is never accepted from a parameter.
 */

import { createHash } from 'node:crypto'

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
 * bounded so references cannot smuggle an unbounded history dump. There is no
 * separate character/byte text quota: the single 64KiB serialized content
 * envelope is the format protection.
 * @param {{ text?: unknown, references?: unknown, paths?: unknown }} input
 * @returns {{ text: string, references: Array<{sessionId:string,seq:number,text:string}>, paths: string[], bytes: number }}
 */
export function normalizeContent(input) {
  const object = assertPlainObject(input ?? {}, 'content', 'tool_args')
  assertAllowedKeys(object, ['text', 'references', 'paths'], 'content')
  const text = object.text === undefined ? '' : requiredString(object.text, 'text', { code: 'tool_args' })
  // Reject an oversized text before building the full JSON string; this keeps
  // a hostile single field from forcing a large temporary allocation.
  if (utf8Length(text) > LIMITS.MAX_CONTENT_BYTES) {
    throw fail(
      'invalid_argument',
      `content exceeds ${LIMITS.MAX_CONTENT_BYTES} serialized bytes; summarize or use references`,
    )
  }
  const references = normalizeReferences(object.references)
  const paths = normalizePaths(object.paths)
  if (text.length === 0 && references.length === 0 && paths.length === 0) {
    throw fail('invalid_argument', 'content must include text, references, or paths')
  }
  const bytes = utf8Length(JSON.stringify({ text, references, paths }))
  if (bytes > LIMITS.MAX_CONTENT_BYTES) {
    throw fail(
      'invalid_argument',
      `content exceeds ${LIMITS.MAX_CONTENT_BYTES} serialized bytes; summarize or use references`,
    )
  }
  return { text, references, paths, bytes }
}

/**
 * Bound the whole tool call as received from the model. This includes targets,
 * text, references, paths, operationId and parent; it excludes server-derived
 * identity, fingerprint, and durable status. Oversize is an explicit error,
 * never a silent truncation.
 * @param {Record<string, unknown>} call
 * @param {string} [label]
 */
export function assertCallBytes(call, label = 'call') {
  const bytes = utf8Length(JSON.stringify(call))
  if (bytes > LIMITS.MAX_CALL_BYTES) {
    throw fail(
      'invalid_argument',
      `${label} exceeds ${LIMITS.MAX_CALL_BYTES} serialized bytes; summarize or use references`,
      { bytes, maxBytes: LIMITS.MAX_CALL_BYTES },
    )
  }
  return bytes
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
 *
 * `subject` is appended only when the caller provided it, so a pre-0.4
 * request without the field produces byte-identical JSON to its 0.3
 * fingerprint and a durable duplicate keeps the original result.
 * @param {{ kind: string, text: string, references: unknown, paths: unknown, parentMessageId?: string|null, targets: readonly string[], subject?: string }} call
 * @returns {string}
 */
/**
 * Sealed fingerprint form for NEW durable records: `s2:` + SHA-256 of the
 * canonical payload. The plaintext canonical is computed but never persisted,
 * so a body retained in a fingerprint does not survive redaction semantics.
 * Legacy raw records keep their exact 0.3 bytes.
 * @param {string} canonical
 * @returns {string}
 */
export function sealFingerprint(canonical) {
  return `s2:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
}

/**
 * Dual-form fingerprint comparison. A sealed record compares by recomputing
 * the hash; a legacy raw record compares byte-exactly against the canonical
 * payload, which is what0.3 stored and what an old binary re-derives.
 * @param {unknown} stored
 * @param {string} canonical
 * @returns {boolean}
 */
export function fingerprintMatches(stored, canonical) {
  if (typeof stored !== 'string' || typeof canonical !== 'string') return false
  if (stored.startsWith('s2:')) return stored === sealFingerprint(canonical)
  return stored === canonical
}

export function callFingerprint(call) {
  const payload = {
    kind: call.kind,
    text: call.text,
    references: call.references,
    paths: call.paths,
    parentMessageId: call.parentMessageId ?? null,
    targets: [...call.targets].sort(),
  }
  if (call.workspacePath !== undefined && call.workspacePath !== null) payload.workspacePath = call.workspacePath
  if (call.subject !== undefined) payload.subject = call.subject
  return JSON.stringify(payload)
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
/** @param {string} text @returns {boolean} */
function hasControlCharacter(text) {
  for (const character of text) {
    const code = character.codePointAt(0)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

/**
 * Validate the optional single-line card subject. Display cleanup (trimming,
 * ellipses) belongs to the viewer; this only enforces the technical envelope:
 * one line, bounded, no control characters.
 * @param {unknown} value
 * @param {string} [field]
 * @returns {string | undefined}
 */
export function normalizeSubject(value, field = 'subject') {
  if (value === undefined || value === null) return undefined
  // No independent length quota: a subject is bounded only by the shared
  // 64 KiB content / 1 MiB call envelopes (and one-line control-char rules).
  const text = requiredString(value, field)
  if (text.trim().length === 0) throw fail('invalid_argument', `${field} must not be blank`)
  if (hasControlCharacter(text)) {
    throw fail('invalid_argument', `${field} must be a single line without control characters`)
  }
  return text
}

/**
 * Deterministic first-line excerpt used when no subject was supplied. No
 * model call: only whitespace normalization, control-character stripping, and
 * a fixed character bound.
 * @param {unknown} text
 * @param {number} maxChars
 * @returns {string}
 */
export function firstLineExcerpt(text, maxChars) {
  if (typeof text !== 'string' || text.length === 0) return ''
  const line =
    text
      .split('\n')
      .map((candidate) =>
        [...candidate]
          .filter((character) => {
            const code = character.codePointAt(0)
            return code > 0x1f && code !== 0x7f
          })
          .join('')
          .trim(),
      )
      .find((candidate) => candidate.length > 0) ?? ''
  if (line.length === 0) return ''
  return [...line].length <= maxChars ? line : `${[...line].slice(0, maxChars).join('')}…`
}

/**
 * Reject any project directory name that could escape its parent: path
 * separators (either spelling), `.`/`..`, NUL, control characters, or an
 * empty/overlong segment. This is input validation, not an OS sandbox claim.
 * @param {unknown} value
 * @param {string} [field]
 * @returns {string}
 */
export function assertProjectSegment(value, field = 'directoryName') {
  const text = requiredString(value, field, { min: 1, max: 255 })
  if (text === '.' || text === '..') throw fail('invalid_argument', `${field} must not be '.' or '..'`)
  if (text.includes('/') || text.includes('\\')) {
    throw fail('invalid_argument', `${field} must be a single path segment without separators`)
  }
  if (hasControlCharacter(text)) {
    throw fail('invalid_argument', `${field} contains an illegal character`)
  }
  if (text.endsWith(' ') || text.endsWith('.')) {
    throw fail('invalid_argument', `${field} must not end with a space or dot`)
  }
  return text
}

/**
 * The first task message body: non-empty text bounded by the same 64 KiB
 * content envelope a send/reply payload uses.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeTask(value) {
  const text = requiredString(value, 'task', { min: 1 })
  if (text.trim().length === 0) throw fail('invalid_argument', 'task must not be blank')
  if (utf8Length(text) > LIMITS.MAX_CONTENT_BYTES) {
    throw fail('invalid_argument', `task exceeds ${LIMITS.MAX_CONTENT_BYTES} serialized bytes; shorten the first task`)
  }
  return text
}

/**
 * Canonical fingerprint of one create operation: the complete normalized
 * input, including the project workspace title (`newProject.title`). `subject`
 * stays conditional exactly like {@link callFingerprint}; the `kind`
 * discriminator guarantees a create operationId can never collide with a
 * send/reply fingerprint.
 *
 * Omitted `newProject.title` (null) and an explicit value are different
 * normalized inputs on purpose: the host defaults an omitted title while an
 * explicit one is displayed verbatim. Only byte-identical normalized inputs
 * share a fingerprint.
 * @param {{ task: string, targets: readonly string[], workspaceId?: string|null, parentDir?: string|null, directoryName?: string|null, workspacePath?: string|null, workspaceTitle?: string|null, title?: string|null, subject?: string }} call
 * @returns {string}
 */
export function createFingerprint(call) {
  const payload = {
    kind: 'create',
    task: call.task,
    parentMessageId: null,
    targets: [...call.targets].sort(),
    workspaceId: call.workspaceId ?? null,
    parentDir: call.parentDir ?? null,
    directoryName: call.directoryName ?? null,
    workspaceTitle: call.workspaceTitle ?? null,
    title: call.title ?? null,
  }
  if (call.workspacePath !== undefined && call.workspacePath !== null) payload.workspacePath = call.workspacePath
  if (call.subject !== undefined) payload.subject = call.subject
  return JSON.stringify(payload)
}

export function absolutePath(value, field) {
  const text = requiredString(value, field, { min: 1, max: 4096 })
  if (!text.startsWith('/')) throw fail('invalid_argument', `${field} must be an absolute path`)
  if (text.includes('\u0000')) throw fail('invalid_argument', `${field} contains NUL`)
  return text
}
