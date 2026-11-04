/**
 * Durable anti-loop budget.
 *
 * Every accepted delivery consumes a rolling 10-minute window and a local-day
 * counter before the host is asked to insert anything. Consumption is never
 * refunded by a later failure: a conservative over-count is preferable to a
 * loop that can retry its way around the limit. Exceeding a limit latches the
 * affected scope; a latch is released only by an explicit owner action and
 * never by the rolling window expiring.
 */

import { randomUUID } from 'node:crypto'

import { LIMITS } from './constants.js'
import { fail } from './errors.js'
import { isPlainObject } from './validation.js'

/** @param {number} now @returns {string} local Asia/Shanghai calendar day */
export function dayKey(now) {
  return new Date(now + LIMITS.DAILY_OFFSET_MS).toISOString().slice(0, 10)
}

/**
 * @param {number} now
 * @returns {string} the local day before `now`
 */
function previousDayKey(now) {
  return dayKey(now - 24 * 60 * 60 * 1000)
}

/**
 * Ensure the mutable budget shape exists. Safe on old ledgers and on the
 * first write.
 * @param {Record<string, any>} state
 * @param {number} now
 */
export function ensureBudgetState(state, now) {
  if (!isPlainObject(state.budget)) state.budget = {}
  const budget = state.budget
  if (!Array.isArray(budget.events)) budget.events = []
  if (!isPlainObject(budget.lastSubmitAt)) budget.lastSubmitAt = {}
  if (!isPlainObject(budget.daily)) budget.daily = {}
  if (budget.daily[dayKey(now)] === undefined) budget.daily[dayKey(now)] = 0
  if (!Array.isArray(state.latches)) state.latches = []
}

/**
 * Drop expired window entries and bound the daily map to the current and
 * previous local day. Latches live at state.latches and are never pruned here.
 * @param {Record<string, any>} state
 * @param {number} now
 */
export function pruneBudget(state, now) {
  ensureBudgetState(state, now)
  const budget = state.budget
  const cutoff = now - LIMITS.WINDOW_MS
  let changed = false
  const events = budget.events.filter((event) => isPlainObject(event) && Number.isSafeInteger(event.at) && event.at > cutoff)
  if (events.length !== budget.events.length) changed = true
  budget.events = events
  for (const [sessionId, at] of Object.entries(budget.lastSubmitAt)) {
    if (!Number.isSafeInteger(at) || at <= cutoff) {
      delete budget.lastSubmitAt[sessionId]
      changed = true
    }
  }
  const keepDays = new Set([dayKey(now), previousDayKey(now)])
  for (const key of Object.keys(budget.daily)) {
    if (!keepDays.has(key)) {
      delete budget.daily[key]
      changed = true
    }
  }
  if (budget.daily[dayKey(now)] === undefined) {
    budget.daily[dayKey(now)] = 0
    changed = true
  }
  return changed
}

/** @param {string} a @param {string} b @returns {string} */
export function pairScope(a, b) {
  return `pair:${[a, b].sort().join('|')}`
}

/** @param {string} id @returns {string} */
export function sessionScope(id) {
  return `session:${id}`
}

/** @param {string} scope @returns {boolean} */
export function isGlobalScope(scope) {
  return scope === 'global' || scope.startsWith('daily:')
}

/**
 * Every scope one planned message set touches.
 * @param {string} from
 * @param {readonly string[]} targets
 * @param {number} now
 * @returns {string[]}
 */
export function scopesFor(from, targets, now) {
  const scopes = new Set([sessionScope(from), 'global', `daily:${dayKey(now)}`])
  for (const target of targets) {
    scopes.add(sessionScope(target))
    scopes.add(pairScope(from, target))
  }
  return [...scopes]
}

/**
 * Active latches affecting any of these scopes. A global or daily latch blocks
 * every scope, and a daily latch keeps blocking after the calendar day rolls
 * over until the owner confirms it.
 * @param {Record<string, any>} state
 * @param {readonly string[]} scopes
 * @returns {Array<Record<string, any>>}
 */
export function latchesBlocking(state, scopes) {
  if (!Array.isArray(state.latches)) return []
  const relevant = new Set(scopes)
  return state.latches.filter((latch) => {
    if (!isPlainObject(latch) || typeof latch.scope !== 'string') return false
    if (latch.releasedAt !== undefined) return false
    return isGlobalScope(latch.scope) || relevant.has(latch.scope)
  })
}

/** @param {Record<string, any>} state @returns {Array<Record<string, any>>} */
export function activeLatches(state) {
  if (!Array.isArray(state.latches)) return []
  return state.latches.filter((latch) => isPlainObject(latch) && latch.releasedAt === undefined)
}

/**
 * @param {Record<string, any>} state
 * @param {string} scope
 * @param {string} reason
 * @param {number} now
 * @returns {Record<string, any>}
 */
function addLatch(state, scope, reason, now) {
  ensureBudgetState(state, now)
  const existing = state.latches.find((latch) => latch?.scope === scope && latch.releasedAt === undefined)
  if (existing !== undefined) return existing
  const latch = {
    // Every latch gets a unique id, even when the same scope trips again
    // after an earlier latch was released: releasing one id must never
    // accidentally target a historical release record.
    id: `latch:${scope}:${randomUUID()}`,
    scope,
    reason,
    createdAt: now,
  }
  state.latches.push(latch)
  return latch
}

/**
 * Reserve one batch synchronously inside a ledger mutation.
 *
 * @param {Record<string, any>} state
 * @param {{ from: string, targets: readonly string[], now: number }} request
 * @returns {{ ok: true, reserved: number } | { ok: false, code: string, scopes?: string[], latches?: Array<Record<string, any>>, retryAfterMs?: number, reason?: string }}
 */
export function reserveBudget(state, request) {
  const { from, targets, now, rateLimit = true } = request
  ensureBudgetState(state, now)
  pruneBudget(state, now)
  const budget = state.budget

  const scopes = scopesFor(from, targets, now)
  const blocked = latchesBlocking(state, scopes)
  if (blocked.length > 0) {
    return { ok: false, code: 'budget_latched', scopes: blocked.map((latch) => latch.scope), latches: blocked }
  }

  if (rateLimit) {
    const lastSubmit = budget.lastSubmitAt[from]
    if (Number.isSafeInteger(lastSubmit) && now - lastSubmit < LIMITS.MIN_SUBMIT_INTERVAL_MS) {
      return { ok: false, code: 'rate_limited', retryAfterMs: LIMITS.MIN_SUBMIT_INTERVAL_MS - (now - lastSubmit) }
    }
  }

  const sessionCounts = new Map()
  const pairCounts = new Map()
  for (const event of budget.events) {
    sessionCounts.set(event.from, (sessionCounts.get(event.from) ?? 0) + 1)
    sessionCounts.set(event.to, (sessionCounts.get(event.to) ?? 0) + 1)
    const pair = pairScope(event.from, event.to)
    pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1)
  }
  const additional = targets.length
  const violations = []
  const addViolation = (scope, reason) => {
    if (!violations.some((item) => item.scope === scope)) violations.push({ scope, reason })
  }

  const fromCount = (sessionCounts.get(from) ?? 0) + additional
  if (fromCount > LIMITS.WINDOW_SESSION_MESSAGES) addViolation(sessionScope(from), 'session')
  for (const target of targets) {
    const targetCount = (sessionCounts.get(target) ?? 0) + 1
    if (targetCount > LIMITS.WINDOW_SESSION_MESSAGES) addViolation(sessionScope(target), 'session')
    const pairCount = (pairCounts.get(pairScope(from, target)) ?? 0) + 1
    if (pairCount > LIMITS.WINDOW_PAIR_MESSAGES) addViolation(pairScope(from, target), 'pair')
  }
  if (budget.events.length + additional > LIMITS.WINDOW_GLOBAL_MESSAGES) addViolation('global', 'global')
  // One host followup per message, so delivery attempts share the same events.
  if (budget.events.length + additional > LIMITS.WINDOW_HOST_DELIVERIES) addViolation('global', 'deliveries')
  const dailyCount = (budget.daily[dayKey(now)] ?? 0) + additional
  if (dailyCount > LIMITS.DAILY_MESSAGES) addViolation(`daily:${dayKey(now)}`, 'daily')

  if (violations.length > 0) {
    const latches = violations.map((violation) => addLatch(state, violation.scope, violation.reason, now))
    return {
      ok: false,
      code: 'budget_latched',
      scopes: violations.map((violation) => violation.scope),
      latches,
      reason: violations.map((violation) => violation.reason).join(','),
    }
  }

  for (const target of targets) budget.events.push({ at: now, from, to: target })
  if (rateLimit) budget.lastSubmitAt[from] = now
  budget.daily[dayKey(now)] = dailyCount
  return { ok: true, reserved: additional }
}

/**
 * Record one source submission (a send/reply call) for the per-second rate
 * limit. This is deliberately separate from delivery reservations: one batch
 * may address up to five targets, while a delayed/held message is charged for
 * a host delivery only when that delivery is actually attempted.
 * @param {Record<string, any>} state
 * @param {{ from: string, now: number }} request
 * @returns {{ ok: true } | { ok: false, code: 'rate_limited', retryAfterMs: number }}
 */
export function recordSubmission(state, request) {
  const { from, now } = request
  ensureBudgetState(state, now)
  pruneBudget(state, now)
  const last = state.budget.lastSubmitAt[from]
  if (Number.isSafeInteger(last) && now - last < LIMITS.MIN_SUBMIT_INTERVAL_MS) {
    return { ok: false, code: 'rate_limited', retryAfterMs: LIMITS.MIN_SUBMIT_INTERVAL_MS - (now - last) }
  }
  state.budget.lastSubmitAt[from] = now
  return { ok: true }
}

/**
 * Release exactly one latched scope. The counts remain: a still-over-limit
 * window cannot be cleared by releasing, only by expiry, while the latch is
 * the explicit acknowledgement that unblocks new work.
 * @param {Record<string, any>} state
 * @param {{ latchId: string, now: number, by?: string }} request
 * @returns {{ latch: Record<string, any> }}
 */
export function releaseLatch(state, request) {
  ensureBudgetState(state, request.now)
  if (!Array.isArray(state.latches)) throw fail('not_found', 'budget latch not found')
  const latch = state.latches.find((entry) => entry?.id === request.latchId)
  if (latch === undefined) throw fail('not_found', 'budget latch not found')
  if (latch.releasedAt !== undefined) throw fail('conflict', 'budget latch is already released')
  latch.releasedAt = request.now
  if (request.by !== undefined) latch.releasedBy = request.by
  return { latch: structuredClone(latch) }
}

/**
 * Human- and UI-facing budget detail without raw event content.
 * @param {Record<string, any>} state
 * @param {number} now
 * @returns {{ latches: Array<Record<string, any>>, windowMessages: number, windowDeliveries: number, dailyMessages: number, day: string }}
 */
export function budgetSummary(state, now) {
  ensureBudgetState(state, now)
  return {
    latches: activeLatches(state).map((latch) => structuredClone(latch)),
    windowMessages: state.budget.events.length,
    windowDeliveries: state.budget.events.length,
    dailyMessages: state.budget.daily[dayKey(now)] ?? 0,
    day: dayKey(now),
  }
}
