/**
 * Read-only 0.4 -> 0.3 downgrade readiness check for THIS plugin's ledger
 * data. It never mutates, installs, migrates, or deletes anything.
 *
 * Strict full-ledger validation runs FIRST on a structured clone (validators
 * normalize `settings` in place, so the caller's state is never touched), and
 * a malformed or incomplete ledger fails closed instead of being mistaken for
 * "no0.4 constructs". Only a validated state is then checked for the three
 * hard blockers:
 * - `state.creates` (even terminal):0.3 ignores the region, so the same root
 *   operationId could be reused by send/reply and break deduplication;
 * - a non-null `message.subject`:0.3 redaction never clears it, changing body
 *   retention semantics;
 * - sealed `s2:` operation fingerprints:0.3 recomputes raw canonical JSON and
 *   would conflict on a legitimate replay.
 *
 * A clean, validated state only establishes the plugin data-shape necessary
 * condition. It does not claim Host HMR/GUI compatibility, full rollback
 * completeness, or retention safety, and it must not be used to run a
 * production change without the user's explicit consent.
 *
 * This module deliberately lives outside `migration.js`: `ledger.js` imports
 * migration helpers, so importing the ledger validator from migration would
 * create an import cycle.
 * @param {{ currentState?: Record<string, any> } | Record<string, any>} request
 * @returns {{ ok: boolean, reasons: string[], notes?: string[] }}
 */
import { STATE_VERSION } from './constants.js'
import { validateV3State } from './ledger.js'
import { isPlainObject } from './validation.js'

export function v04DowngradePreflight(request) {
  const state = request?.currentState ?? request
  if (!isPlainObject(state) || state.version !== STATE_VERSION) {
    return { ok: false, reasons: ['current state is not a v3 ledger'] }
  }
  let candidate
  try {
    candidate = structuredClone(state)
  } catch {
    return { ok: false, reasons: ['current state cannot be cloned for validation'] }
  }
  try {
    validateV3State(candidate)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reasons: [`ledger failed strict validation: ${message.slice(0, 300)}`] }
  }
  const reasons = []
  const creates = isPlainObject(candidate.creates) ? Object.keys(candidate.creates) : []
  if (creates.length > 0) {
    reasons.push(
      `state.creates holds ${creates.length} create journal(s):0.3 ignores this region, so a root operationId could be reused by send/reply and break deduplication (terminal and unknown records included)`,
    )
  }
  const withSubject = candidate.messages.filter(
    (message) => message?.subject !== undefined && message.subject !== null,
  ).length
  if (withSubject > 0) {
    reasons.push(
      `${withSubject} message(s) carry a subject:0.3 redaction never clears it, so body retention semantics differ`,
    )
  }
  const sealed = Object.values(candidate.operations).filter(
    (operation) => typeof operation?.fingerprint === 'string' && operation.fingerprint.startsWith('s2:'),
  ).length
  if (sealed > 0) {
    reasons.push(
      `${sealed} operation record(s) use sealed s2 fingerprints:0.3 recomputes raw canonical JSON and would conflict on a legitimate replay`,
    )
  }
  if (reasons.length > 0) return { ok: false, reasons }
  return {
    ok: true,
    reasons: [],
    notes: [
      'only the session-link data-shape necessary condition is established; Host HMR/GUI compatibility and full rollback/retention safety are not verified',
    ],
  }
}
