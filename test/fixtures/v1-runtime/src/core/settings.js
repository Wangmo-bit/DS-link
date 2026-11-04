/**
 * Owner-editable settings. Validation never widens a hard protocol bound and
 * never rewrites existing chain budgets: those are frozen in the chain record.
 */

import { DEFAULT_SETTINGS, SETTINGS_BOUNDS, SETTINGS_KEYS } from './constants.js'
import { fail } from './errors.js'
import { assertAllowedKeys, isPlainObject } from './validation.js'

/** @returns {typeof DEFAULT_SETTINGS} */
export function createDefaultSettings() {
  return { ...DEFAULT_SETTINGS }
}

/**
 * @param {unknown} settings
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function normalizeStoredSettings(settings) {
  if (!isPlainObject(settings)) throw fail('storage_corrupt', 'ledger settings are not an object')
  const merged = createDefaultSettings()
  for (const key of SETTINGS_KEYS) {
    if (!(key in settings)) continue
    merged[key] = settings[key]
  }
  return validateSettingsValue(merged)
}

/**
 * Validate a complete settings value (already merged with defaults).
 * @param {Record<string, unknown>} value
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function validateSettingsValue(value) {
  const result = createDefaultSettings()
  for (const key of ['enabled', 'emergencyPaused', 'autoCollaborate']) {
    if (typeof value[key] !== 'boolean') throw fail('invalid_argument', `${key} must be a boolean`)
    result[key] = value[key]
  }
  for (const [key, bounds] of Object.entries(SETTINGS_BOUNDS)) {
    const number = value[key]
    if (!Number.isSafeInteger(number)) throw fail('invalid_argument', `${key} must be a safe integer`)
    if (number < bounds.min || number > bounds.max) {
      throw fail('invalid_argument', `${key} must be between ${bounds.min} and ${bounds.max}`)
    }
    result[key] = number
  }
  return result
}

/**
 * Apply a partial owner patch to the current settings and return the next
 * complete value. Unknown keys and non-integer/out-of-range values reject the
 * whole patch; nothing is partially applied.
 * @param {Record<string, unknown>} current
 * @param {unknown} patch
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function applySettingsPatch(current, patch) {
  if (!isPlainObject(patch)) throw fail('invalid_argument', 'settings patch must be an object')
  assertAllowedKeys(patch, SETTINGS_KEYS, 'settings patch', 'invalid_argument')
  if (Object.keys(patch).length === 0) throw fail('invalid_argument', 'settings patch is empty')
  const next = { ...current }
  for (const key of SETTINGS_KEYS) {
    if (key in patch) next[key] = patch[key]
  }
  return validateSettingsValue(next)
}

/**
 * Validate settings already persisted in a ledger. Unlike a caller patch, a
 * stored record must carry every key; silently filling defaults would hide a
 * damaged settings snapshot.
 * @param {unknown} value
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function validateStoredSettings(value) {
  if (!isPlainObject(value)) throw fail('storage_corrupt', 'ledger settings are not an object')
  for (const key of SETTINGS_KEYS) {
    if (!(key in value)) throw fail('storage_corrupt', `ledger settings are missing ${key}`)
  }
  try {
    return validateSettingsValue(value)
  } catch {
    throw fail('storage_corrupt', 'ledger settings are invalid')
  }
}
