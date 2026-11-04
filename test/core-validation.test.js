import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertCallBytes,
  callFingerprint,
  mintOperationId,
  normalizeContent,
  normalizeTargets,
  sanitizeProfileName,
  validateOperationId,
} from '../src/core/validation.js'
import { applySettingsPatch, createDefaultSettings } from '../src/core/settings.js'
import { DEFAULT_SETTINGS, LIMITS } from '../src/core/constants.js'

const UUID = '123e4567-e89b-42d3-a456-426614174000'
const NOW = 1_800_000_000_000

test('operationId embeds its creation time and enforces the first-submission window', () => {
  const id = mintOperationId(UUID, NOW)
  assert.equal(id, `slop:${NOW}:${UUID}`)
  assert.equal(validateOperationId(id, NOW).at, NOW)
  assert.throws(() => validateOperationId(id, NOW + 24 * 60 * 60 * 1000 + 1), /older than 24 hours/)
  assert.throws(() => validateOperationId(id, NOW - 5 * 60 * 1000 - 1), /more than five minutes/)
  assert.throws(() => validateOperationId('not-an-operation', NOW), /minted/)
  assert.throws(() => validateOperationId(`slop:${NOW}:not-a-uuid`, NOW), /minted/)
})

test('content keeps the 64KiB envelope and drops the old 12000/48000 text caps', () => {
  assert.deepEqual(normalizeContent({ text: 'hello' }), {
    text: 'hello',
    references: [],
    paths: [],
    bytes: Buffer.byteLength(JSON.stringify({ text: 'hello', references: [], paths: [] })),
  })
  assert.equal(normalizeContent({ text: '😀'.repeat(12001) }).text.length > 0, true)
  assert.throws(() => normalizeContent({ text: 'x'.repeat(70_000) }), /serialized bytes/)
  assert.throws(() => normalizeContent({ text: '' }), /must include/)
  assert.throws(
    () =>
      normalizeContent({
        text: 'x'.repeat(64_000),
        references: Array.from({ length: 5 }, (_, i) => ({ sessionId: 's', seq: i, text: 'y'.repeat(2000) })),
      }),
    /serialized bytes/,
  )
  assert.throws(
    () => normalizeContent({ text: 'x', references: Array.from({ length: 6 }, (_, i) => ({ sessionId: 's', seq: i, text: 'y' })) }),
    /at most 5/,
  )
  assert.throws(() => normalizeContent({ text: 'x', paths: ['ok', 'bad\u0000path'] }), /NUL/)
  assert.throws(() => normalizeContent({ text: 'x', extra: true }), /does not accept extra/)
})

test('targets are unique, sorted, and have no target-count quota', () => {
  assert.deepEqual(normalizeTargets(['b', 'a'], 'x'), ['a', 'b'])
  assert.throws(() => normalizeTargets(['a', 'a'], 'x'), /unique/)
  assert.throws(() => normalizeTargets(['x'], 'x'), /itself/)
  assert.throws(() => normalizeTargets([], 'x'), /non-empty/)
  const ten = Array.from({ length: 10 }, (_, index) => `t${index}`)
  assert.equal(normalizeTargets(ten, 'x').length, 10)
  const many = Array.from({ length: 500 }, (_, index) => `t${index}`)
  assert.equal(normalizeTargets(many, 'x').length, 500)
})

test('the whole call is bounded at 1MiB, not by a target count', () => {
  assert.doesNotThrow(() => assertCallBytes({ targets: Array.from({ length: 500 }, (_, index) => `t${index}`), text: 'x' }))
  assert.throws(
    () => assertCallBytes({ targets: ['a'], text: 'x'.repeat(LIMITS.MAX_CALL_BYTES) }),
    (error) => error.code === 'invalid_argument' && error.details.maxBytes === LIMITS.MAX_CALL_BYTES,
  )
})

test('v2 settings accept 1..10 channels and unbounded positive time/retention values', () => {
  const defaults = createDefaultSettings()
  assert.equal(DEFAULT_SETTINGS.maxConcurrent, 3)
  assert.deepEqual(applySettingsPatch(defaults, { maxConcurrent: 10 }, { now: NOW }), { ...defaults, maxConcurrent: 10 })
  assert.deepEqual(applySettingsPatch(defaults, { paused: true }, { now: NOW }), { ...defaults, paused: true })
  assert.deepEqual(applySettingsPatch(defaults, { requestTimeoutMs: 48 * 60 * 60 * 1000 }, { now: NOW }), {
    ...defaults,
    requestTimeoutMs: 48 * 60 * 60 * 1000,
  })
  assert.deepEqual(applySettingsPatch(defaults, { retentionDays: 365 }, { now: NOW }), { ...defaults, retentionDays: 365 })
  assert.throws(() => applySettingsPatch(defaults, { maxConcurrent: 11 }, { now: NOW }), /between 1 and 10/)
  assert.throws(() => applySettingsPatch(defaults, { requestTimeoutMs: 0 }, { now: NOW }), /positive safe integer/)
  assert.throws(() => applySettingsPatch(defaults, { retentionDays: 0 }, { now: NOW }), /positive integer/)
  assert.throws(() => applySettingsPatch(defaults, { requestTimeoutMs: 1.5 }, { now: NOW }), /positive safe integer/)
  assert.throws(() => applySettingsPatch(defaults, { unknown: true }, { now: NOW }), /does not accept unknown/)
  assert.throws(() => applySettingsPatch(defaults, {}, { now: NOW }), /empty/)
})

test('old quota settings patches are policy_removed as a whole', () => {
  const defaults = createDefaultSettings()
  for (const key of ['emergencyPaused', 'autoCollaborate', 'maxMessages', 'maxHops', 'maxTextChars']) {
    assert.throws(
      () => applySettingsPatch(defaults, { [key]: true, paused: true }, { now: NOW }),
      (error) => error.code === 'policy_removed' && error.details.removedKeys.includes(key),
    )
  }
})

test('call fingerprint ignores target order but includes parent and content', () => {
  const base = {
    kind: 'request',
    text: 'hello',
    references: [],
    paths: [],
    parentMessageId: null,
    targets: ['b', 'a'],
  }
  assert.equal(callFingerprint(base), callFingerprint({ ...base, targets: ['a', 'b'] }))
  assert.notEqual(callFingerprint(base), callFingerprint({ ...base, parentMessageId: 'p' }))
  assert.notEqual(callFingerprint(base), callFingerprint({ ...base, text: 'other' }))
})

test('profile names cannot escape their state directory', () => {
  assert.equal(sanitizeProfileName('../evil'), 'evil')
  assert.equal(sanitizeProfileName('..'), 'default')
  assert.equal(sanitizeProfileName('/a/b'), 'a_b')
  assert.equal(sanitizeProfileName(''), 'default')
  assert.equal(sanitizeProfileName('a'.repeat(100)).length, 64)
})
