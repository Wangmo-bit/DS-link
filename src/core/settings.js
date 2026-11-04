/**
 * Owner-editable v0.2 settings. Exactly five keys are accepted. Removed v0.1
 * keys reject the whole patch with policy_removed so an old page cannot keep
 * showing a stale quota UI while the backend silently ignores its patch.
 */

import {
  DEFAULT_SETTINGS,
  LEGACY_SETTINGS_KEYS,
  LIMITS,
  SETTINGS_BOUNDS,
  SETTINGS_KEYS,
} from './constants.js'
import { fail } from './errors.js'
import { assertAllowedKeys, isPlainObject } from './validation.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** @returns {typeof DEFAULT_SETTINGS} */
export function createDefaultSettings() {
  return { ...DEFAULT_SETTINGS }
}

/**
 * @param {number} value
 * @param {number} now
 * @param {string} label
 */
function validatePositiveSpan(value, now, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw fail('invalid_argument', `${label} must be a positive safe integer`)
  }
  if (value > LIMITS.MAX_DATE_MS) {
    throw fail('invalid_argument', `${label} is outside the representable time range`)
  }
  if (!Number.isSafeInteger(now + value) || now + value > LIMITS.MAX_DATE_MS) {
    throw fail('invalid_argument', `${label} is outside the representable time range`)
  }
}

/**
 * @param {number} days
 * @param {number} now
 */
function validateRetentionDays(days, now) {
  if (!Number.isSafeInteger(days) || days <= 0) {
    throw fail('invalid_argument', 'retentionDays must be a positive integer')
  }
  const ms = days * DAY_MS
  if (!Number.isSafeInteger(ms) || ms > LIMITS.MAX_DATE_MS) {
    throw fail('invalid_argument', 'retentionDays is outside the representable time range')
  }
  if (!Number.isSafeInteger(now + ms) || now + ms > LIMITS.MAX_DATE_MS) {
    throw fail('invalid_argument', 'retentionDays is outside the representable time range')
  }
}

/**
 * Validate a complete owner settings value.
 * @param {Record<string, unknown>} value
 * @param {{ now?: number }} [options]
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function validateSettingsValue(value, options = {}) {
  const now = options.now ?? Date.now()
  const result = createDefaultSettings()
  for (const key of ['enabled', 'paused']) {
    if (typeof value[key] !== 'boolean') throw fail('invalid_argument', `${key} must be a boolean`)
    result[key] = value[key]
  }
  const maxConcurrent = value.maxConcurrent
  if (!Number.isSafeInteger(maxConcurrent)) throw fail('invalid_argument', 'maxConcurrent must be a safe integer')
  if (maxConcurrent < SETTINGS_BOUNDS.maxConcurrent.min || maxConcurrent > SETTINGS_BOUNDS.maxConcurrent.max) {
    throw fail(
      'invalid_argument',
      `maxConcurrent must be between ${SETTINGS_BOUNDS.maxConcurrent.min} and ${SETTINGS_BOUNDS.maxConcurrent.max}`,
    )
  }
  result.maxConcurrent = maxConcurrent
  validatePositiveSpan(value.requestTimeoutMs, now, 'requestTimeoutMs')
  validateRetentionDays(value.retentionDays, now)
  result.requestTimeoutMs = value.requestTimeoutMs
  result.retentionDays = value.retentionDays
  return result
}

/**
 * Validate settings already persisted in a v2 ledger. A stored record must
 * carry exactly the five keys; filling defaults would hide a damaged snapshot.
 * The time checks here are time-independent so reopening later cannot turn a
 * previously valid ledger into a corrupt one.
 * @param {unknown} value
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function validateStoredSettings(value) {
  if (!isPlainObject(value)) throw fail('storage_corrupt', 'ledger settings are not an object')
  const keys = Object.keys(value)
  if (keys.length !== SETTINGS_KEYS.length || SETTINGS_KEYS.some((key) => !(key in value))) {
    throw fail('storage_corrupt', 'ledger settings do not match the v2 fields')
  }
  for (const key of keys) {
    if (!SETTINGS_KEYS.includes(key)) throw fail('storage_corrupt', 'ledger settings have unknown fields')
  }
  if (typeof value.enabled !== 'boolean' || typeof value.paused !== 'boolean') {
    throw fail('storage_corrupt', 'ledger settings booleans are invalid')
  }
  if (!Number.isSafeInteger(value.maxConcurrent)) throw fail('storage_corrupt', 'ledger maxConcurrent is invalid')
  if (value.maxConcurrent < SETTINGS_BOUNDS.maxConcurrent.min || value.maxConcurrent > SETTINGS_BOUNDS.maxConcurrent.max) {
    throw fail('storage_corrupt', 'ledger maxConcurrent is out of range')
  }
  if (!Number.isSafeInteger(value.requestTimeoutMs) || value.requestTimeoutMs <= 0 || value.requestTimeoutMs > LIMITS.MAX_DATE_MS) {
    throw fail('storage_corrupt', 'ledger requestTimeoutMs is invalid')
  }
  if (!Number.isSafeInteger(value.retentionDays) || value.retentionDays <= 0) {
    throw fail('storage_corrupt', 'ledger retentionDays is invalid')
  }
  const retentionMs = value.retentionDays * DAY_MS
  if (!Number.isSafeInteger(retentionMs) || retentionMs > LIMITS.MAX_DATE_MS) {
    throw fail('storage_corrupt', 'ledger retentionDays is outside the representable time range')
  }
  return { ...value }
}

/**
 * Apply an owner patch. Legacy quota keys are a policy removal, not an unknown
 * argument: they are rejected as a whole with a refresh instruction.
 * @param {Record<string, unknown>} current
 * @param {unknown} patch
 * @param {{ now?: number }} [options]
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function applySettingsPatch(current, patch, options = {}) {
  if (!isPlainObject(patch)) throw fail('invalid_argument', 'settings patch must be an object')
  const legacy = LEGACY_SETTINGS_KEYS.filter((key) => key in patch)
  if (legacy.length > 0) {
    throw fail('policy_removed', 'old session-link settings were removed; refresh the page and try again', {
      removedKeys: legacy,
    })
  }
  assertAllowedKeys(patch, SETTINGS_KEYS, 'settings patch', 'invalid_argument')
  if (Object.keys(patch).length === 0) throw fail('invalid_argument', 'settings patch is empty')
  const next = { ...current }
  for (const key of SETTINGS_KEYS) {
    if (key in patch) next[key] = patch[key]
  }
  return validateSettingsValue(next, options)
}
