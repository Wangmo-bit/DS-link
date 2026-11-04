/**
 * Test-only v0.2 acceptance fixture for the real DSH 0.2.1-rc.5 host.
 *
 * This module is deliberately NOT part of the production package. It is
 * installed by scripts/fixtures/index.js only under SESSION_LINK_TEST=1 and a
 * dedicated /tmp/dsh-session-link-* DSH_HOME. It never reads credentials or
 * opens a raw webServer route. Its route is registered through
 * ctx.connection.fetch, so the Host's owner-only principal gate and exact
 * route matching run before the handler.
 *
 * It reuses the existing ten-session StressFixture state/API (init/invoke/
 * evidence/idle) instead of creating a second set of sessions. In addition it
 * can:
 *   - reflect the current `sessionLink` service dynamically with ctx.get();
 *   - put a test-only barrier in front of the *current* HostAdapter.deliver so
 *     a runner can observe real slot occupancy / dispatching, then release the
 *     original deliver with its original beforeResolve/beforeFollowup hooks;
 *   - inspect the isolated ledger/lock/backup files for hot-swap evidence;
 *   - prepare a legal v0.1 state through the v0.1 tools/owner controls plus
 *     clearly-marked synthetic residues (unknown record and a budget latch).
 *
 * Contract:
 *   const { installV02Fixture } = await import('./v02.js')
 *   const fixture = await installV02Fixture(ctx, { home, createUserMessage })
 *   ctx.effect(() => () => fixture.dispose())
 *
 * Body: bare { action, payload } -> { ok: true, value } |
 *       { ok: false, error: { code, message } }.
 */

import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { StressFixture } from './stress.js'

export const V02_FIXTURE_PATH = '/api/session-link-v02-fixture'
export const V02_ACTIONS = Object.freeze([
  'init',
  'invoke',
  'evidence',
  'idle',
  'service.status',
  'barrier.arm',
  'barrier.status',
  'barrier.release',
  'barrier.disarm',
  'state.info',
  'legacy.prepare',
])

const HOME_PREFIX = '/tmp/dsh-session-link-'
const MAX_BODY_BYTES = 256 * 1024
const MAX_BARRIER_ENTRIES = 128
const MAX_BACKUP_FILES = 20
const MAX_LEDGER_META_BYTES = 8 * 1024 * 1024
const DEFAULT_HOLD_MS = 10 * 60 * 1000

class FixtureError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** @param {string} code @param {string} message */
function fail(code, message) {
  throw new FixtureError(code, message)
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @template T @param {() => Promise<T>} task @param {number} ms @param {string} label @returns {Promise<T>} */
async function withTimeout(task, ms, label) {
  if (typeof task !== 'function') throw new FixtureError('internal_fixture_error', 'withTimeout requires a lazy task function')
  let timer
  let started
  try {
    started = task()
    return await Promise.race([
      Promise.resolve(started),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new FixtureError('timeout', `${label} timed out after ${ms}ms`)), ms)
        timer.unref?.()
      }),
    ])
  } catch (error) {
    if (started !== undefined && typeof started.then === 'function') started.catch(() => undefined)
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** @param {string} home @returns {string} */
function requireTestHome(home) {
  if (process.env.SESSION_LINK_TEST !== '1') {
    throw new FixtureError('fixture_guard', 'v02 fixture requires SESSION_LINK_TEST=1')
  }
  if (typeof home !== 'string' || home.length === 0 || home.includes('\0')) {
    throw new FixtureError('fixture_guard', 'v02 fixture requires an isolated home path')
  }
  const resolved = path.resolve(home)
  if (!resolved.startsWith(HOME_PREFIX) || resolved.length <= HOME_PREFIX.length) {
    throw new FixtureError('fixture_guard', 'v02 fixture home must be under /tmp/dsh-session-link-*')
  }
  const envHome = process.env.DSH_HOME === undefined ? undefined : path.resolve(process.env.DSH_HOME)
  if (envHome !== undefined && envHome !== resolved) {
    throw new FixtureError('fixture_guard', 'v02 fixture home does not match DSH_HOME')
  }
  return resolved
}

/** @param {Record<string, any>} ctx */
function requireHostCapabilities(ctx) {
  if (ctx === undefined || ctx === null) throw new FixtureError('fixture_guard', 'v02 fixture requires ctx')
  for (const name of ['workspaceRegistry', 'sessionController', 'sessionQuery', 'agents', 'sessions', 'tools', 'connection']) {
    if (ctx[name] === undefined || ctx[name] === null) {
      throw new FixtureError('fixture_guard', `v02 fixture requires ctx.${name}`)
    }
  }
  if (typeof ctx.get !== 'function') throw new FixtureError('fixture_guard', 'v02 fixture requires ctx.get() reflection')
  if (typeof ctx.connection.fetch?.register !== 'function') {
    throw new FixtureError('fixture_guard', 'v02 fixture requires ctx.connection.fetch.register')
  }
  if (typeof ctx.sessionController.resolveAgent !== 'function') {
    throw new FixtureError('fixture_guard', 'v02 fixture requires ctx.sessionController.resolveAgent')
  }
  if (typeof ctx.sessionQuery.readSession !== 'function') {
    throw new FixtureError('fixture_guard', 'v02 fixture requires ctx.sessionQuery.readSession')
  }
  if (typeof ctx.sessions.flush !== 'function') throw new FixtureError('fixture_guard', 'v02 fixture requires ctx.sessions.flush')
}

/** @param {unknown} value @returns {string} */
function textOf(value) {
  if (typeof value !== 'string') return ''
  return value.slice(0, 500)
}

/** @param {unknown} error @returns {{ code: string, message: string }} */
function errorInfo(error) {
  const code = typeof error?.code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(error.code) ? error.code : 'fixture_error'
  const message = typeof error?.message === 'string' && error.message.length > 0 ? error.message : 'v02 fixture action failed'
  return { code, message: message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500) }
}

/** @param {unknown} value @param {number} max @returns {string} */
function hashBytes(value, max = 2 * 1024 * 1024) {
  const hash = createHash('sha256')
  hash.update(value.length > max ? value.subarray(0, max) : value)
  return hash.digest('hex')
}

/** @param {Record<string, any>} service @returns {Record<string, any>|undefined} */
function serviceLedger(service) {
  const ledger = service?.ledger
  return isPlainObject(ledger) || ledger !== undefined ? ledger : undefined
}

class V02Fixture {
  /**
   * @param {Record<string, any>} ctx
   * @param {string} home
   * @param {(input: Record<string, any>) => Record<string, any>} createUserMessage
   */
  constructor(ctx, home, createUserMessage) {
    requireHostCapabilities(ctx)
    if (typeof createUserMessage !== 'function') {
      throw new FixtureError('fixture_guard', 'v02 fixture requires the Host createUserMessage builder')
    }
    this.ctx = ctx
    this.home = home
    this.createUserMessage = createUserMessage
    this.stress = new StressFixture(ctx, home, createUserMessage)
    this.instanceId = randomUUID()
    this.services = new WeakMap()
    this.timeline = []
    this.closeRecords = new WeakMap()
    this.nextGeneration = 0
    this.barriers = new Map()
    this.disposed = false
  }

  /** @returns {Record<string, any>|undefined} */
  #service() {
    if (this.disposed) return undefined
    try {
      const service = this.ctx.get('sessionLink')
      return service === undefined || service === null ? undefined : service
    } catch {
      return undefined
    }
  }

  /** @returns {Record<string, any>} */
  #requireService() {
    const service = this.#service()
    if (service === undefined) fail('service_unavailable', 'sessionLink service is not mounted')
    return service
  }

  /**
   * Assign a stable generation to each distinct service object and observe its
   * async close() so hot-swap evidence can show how long the old generation
   * took to release the writer. The fixture deliberately does not inject the
   * sessionLink service, so this memory survives a package hot reload.
   * @param {Record<string, any>} service
   * @returns {Record<string, any>}
   */
  #serviceInfo(service) {
    let observation = this.services.get(service)
    if (observation === undefined) {
      observation = { generation: ++this.nextGeneration, firstSeenAt: Date.now() }
      this.services.set(service, observation)
      this.timeline.push(observation)
    }
    if (!this.closeRecords.has(service) && typeof service.close === 'function') {
      const record = { startedAt: null, finishedAt: null, error: null }
      const original = service.close.bind(service)
      service.close = async function observedClose(...args) {
        record.startedAt = Date.now()
        observation.closeStartedAt = record.startedAt
        try {
          return await original(...args)
        } catch (error) {
          record.error = errorInfo(error).code
          observation.closeError = record.error
          throw error
        } finally {
          record.finishedAt = Date.now()
          observation.closeFinishedAt = record.finishedAt
        }
      }
      this.closeRecords.set(service, record)
      observation.closeStartedAt = null
      observation.closeFinishedAt = null
      observation.closeError = null
      observation.record = record
    }
    const close = this.closeRecords.get(service)
    const ledger = service.ledger
    return {
      found: true,
      generation: observation.generation,
      firstSeenAt: observation.firstSeenAt,
      closeStartedAt: close?.startedAt ?? null,
      closeFinishedAt: close?.finishedAt ?? null,
      closeError: close?.error ?? null,
      closeDurationMs:
        Number.isFinite(close?.startedAt) && Number.isFinite(close?.finishedAt)
          ? close.finishedAt - close.startedAt
          : null,
      hostPid: process.pid,
      instanceId: this.instanceId,
      pluginVersion: typeof service.version === 'string' ? service.version : null,
      hasAdapter: typeof service.adapter?.deliver === 'function',
      hasEngine: service.engine !== undefined && service.engine !== null,
      ledgerRoot: typeof ledger?.root === 'string' ? ledger.root : null,
      writable: ledger?.writable === true,
    }
  }

  /** @returns {Array<Record<string, any>>} */
  #timeline() {
    return this.timeline.map((observation) => ({
      generation: observation.generation,
      firstSeenAt: observation.firstSeenAt,
      closeStartedAt: observation.closeStartedAt ?? null,
      closeFinishedAt: observation.closeFinishedAt ?? null,
      closeError: observation.closeError ?? null,
      closeDurationMs:
        Number.isFinite(observation.closeStartedAt) && Number.isFinite(observation.closeFinishedAt)
          ? observation.closeFinishedAt - observation.closeStartedAt
          : null,
    }))
  }

  /** @returns {Promise<Record<string, any>>} */
  async serviceStatus() {
    const service = this.#service()
    return {
      fixtureInstanceId: this.instanceId,
      hostPid: process.pid,
      current: service === undefined ? { found: false } : this.#serviceInfo(service),
      generations: this.nextGeneration,
      timeline: this.#timeline(),
      barriers: [...this.barriers.values()].map((barrier) => this.#barrierView(barrier)),
    }
  }

  /**
   * Wrap the current service's adapter.deliver. The wrapper waits *before*
   * calling the original deliver, so the engine already holds its slot and has
   * persisted status=dispatching while the barrier is observed. The original
   * request object is passed unchanged to the original deliver, preserving its
   * beforeResolve/beforeFollowup gates.
   * @param {Record<string, any>} payload
   * @returns {Promise<Record<string, any>>}
   */
  async barrierArm(payload = {}) {
    const service = this.#requireService()
    const adapter = service.adapter
    if (adapter === undefined || adapter === null || typeof adapter.deliver !== 'function') {
      fail('barrier_unavailable', 'current sessionLink service has no HostAdapter.deliver')
    }
    let barrier = this.barriers.get(adapter)
    if (barrier !== undefined && barrier.entries.some((entry) => entry.releasedAt === null)) {
      fail('barrier_active', 'a delivery is already held by this barrier')
    }
    if (barrier === undefined) {
      barrier = {
        adapter,
        service,
        generation: this.#serviceInfo(service).generation,
        original: adapter.deliver,
        wrapper: undefined,
        entries: [],
        armed: false,
        timer: undefined,
        timeoutReleased: false,
      }
      const self = this
      barrier.wrapper = async function barrierDeliver(request) {
        if (!barrier.armed || self.disposed) return await barrier.original.call(adapter, request)
        if (barrier.entries.length >= MAX_BARRIER_ENTRIES) {
          // The fixture must never silently turn an overload into a hang. This
          // is test-only; the normal matrices hold at most ten deliveries.
          fail('barrier_overflow', 'too many deliveries held by the v02 fixture barrier')
        }
        const entry = {
          targetId: textOf(request?.targetId),
          enteredAt: Date.now(),
          releasedAt: null,
          completedAt: null,
          outcome: undefined,
          error: undefined,
          release: undefined,
          done: undefined,
          resolveDone: undefined,
        }
        entry.done = new Promise((resolve) => {
          entry.resolveDone = resolve
        })
        barrier.entries.push(entry)
        await new Promise((resolve) => {
          entry.release = resolve
        })
        entry.releasedAt = Date.now()
        try {
          const outcome = await barrier.original.call(adapter, request)
          entry.outcome = {
            stage: typeof outcome?.stage === 'string' ? outcome.stage : 'unknown',
            blockedCode: typeof outcome?.blocked?.code === 'string' ? outcome.blocked.code : null,
            errorCode: typeof outcome?.error?.code === 'string' ? outcome.error.code : null,
          }
          return outcome
        } catch (error) {
          const info = errorInfo(error)
          entry.error = info
          throw error
        } finally {
          entry.completedAt = Date.now()
          entry.resolveDone?.()
        }
      }
      adapter.deliver = barrier.wrapper
      this.barriers.set(adapter, barrier)
    }
    barrier.entries = []
    barrier.armed = true
    barrier.timeoutReleased = false
    const holdMs = Number.isSafeInteger(payload.maxHoldMs) && payload.maxHoldMs > 0 ? payload.maxHoldMs : DEFAULT_HOLD_MS
    if (barrier.timer !== undefined) clearTimeout(barrier.timer)
    barrier.timer = setTimeout(() => {
      barrier.timeoutReleased = true
      barrier.armed = false
      for (const entry of barrier.entries) entry.release?.()
    }, holdMs)
    barrier.timer.unref?.()
    return this.#barrierView(barrier)
  }

  /** @returns {Record<string, any>} */
  async barrierStatus() {
    return {
      fixtureInstanceId: this.instanceId,
      hostPid: process.pid,
      current: this.#service() === undefined ? { found: false } : this.#serviceInfo(this.#service()),
      timeline: this.#timeline(),
      barriers: [...this.barriers.values()].map((barrier) => this.#barrierView(barrier)),
    }
  }

  /**
   * @param {Record<string, any>} payload
   * @returns {Promise<Record<string, any>>}
   */
  async barrierRelease(payload = {}) {
    const disarm = payload.disarm !== false
    let released = 0
    for (const barrier of this.barriers.values()) {
      if (payload.generation !== undefined && barrier.generation !== payload.generation) continue
      for (const entry of barrier.entries) {
        if (entry.releasedAt !== null) continue
        entry.release?.()
        entry.release = undefined
        released += 1
      }
      if (disarm) {
        barrier.armed = false
        if (barrier.timer !== undefined) clearTimeout(barrier.timer)
        barrier.timer = undefined
      }
    }
    const entries = [...this.barriers.values()].flatMap((barrier) => barrier.entries)
    const pending = entries.filter((entry) => entry.releasedAt !== null && entry.completedAt === null)
    if (pending.length > 0) {
      await Promise.race([
        Promise.all(pending.map((entry) => entry.done)),
        sleep(2000, undefined, { ref: false }).catch(() => undefined),
      ])
    }
    return {
      released,
      disarm,
      barriers: [...this.barriers.values()].map((barrier) => this.#barrierView(barrier)),
    }
  }

  /** @param {Record<string, any>|undefined} barrier @returns {Record<string, any>} */
  #barrierView(barrier) {
    if (barrier === undefined) return { found: false }
    const entries = barrier.entries.map((entry) => ({
      targetId: entry.targetId,
      state: entry.releasedAt === null ? 'blocked' : entry.completedAt === null ? 'released' : 'completed',
      enteredAt: entry.enteredAt,
      releasedAt: entry.releasedAt,
      completedAt: entry.completedAt,
      outcome: entry.outcome ?? null,
      error: entry.error ?? null,
    }))
    return {
      found: true,
      generation: barrier.generation,
      armed: barrier.armed,
      timeoutReleased: barrier.timeoutReleased,
      installed: barrier.adapter.deliver === barrier.wrapper,
      total: entries.length,
      blocked: entries.filter((entry) => entry.state === 'blocked').length,
      released: entries.filter((entry) => entry.state === 'released').length,
      completed: entries.filter((entry) => entry.state === 'completed').length,
      entries: entries.slice(-40),
    }
  }

  /**
   * The stress fixture's bounded evidence reader plus an explicit raw scan for
   * the requested host message ids in both persisted user messages and
   * agent-inbox splice events. The hot-reload check uses this to prove that a
   * late barrier release inserted no followup at all.
   * @param {Record<string, any>} payload
   * @returns {Promise<Record<string, any>>}
   */
  async rawEvidence(payload) {
    const base = await this.stress.evidence(payload)
    const ids = new Set(Array.isArray(payload.messageIds) ? payload.messageIds : [])
    const matches = []
    if (ids.size > 0) {
      const snapshot = await this.ctx.sessionQuery.readSession(payload.sessionId)
      for (const event of snapshot.events ?? []) {
        if (!Number.isSafeInteger(event?.seq)) continue
        if (event.type === 'user/message' && ids.has(event.data?.id)) {
          matches.push({ seq: event.seq, type: event.type, id: event.data.id })
        } else if (event.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted)) {
          for (const item of event.data.inserted) {
            if (ids.has(item?.id)) matches.push({ seq: event.seq, type: event.type, id: item.id })
          }
        }
        if (matches.length >= 50) break
      }
    }
    return { ...base, rawMatches: matches }
  }

  /** @returns {Promise<Record<string, any>>} */
  async stateInfo() {
    const service = this.#requireService()
    const ledger = serviceLedger(service)
    if (ledger === undefined) fail('state_unavailable', 'current sessionLink service has no ledger')
    const root = typeof ledger.root === 'string' ? path.resolve(ledger.root) : undefined
    if (root === undefined) fail('state_unavailable', 'ledger has no root path')
    const statePath = typeof ledger.statePath === 'string' ? ledger.statePath : path.join(root, 'ledger.json')
    const lockPath = typeof ledger.lockPath === 'string' ? ledger.lockPath : path.join(root, 'writer.lock')
    let lock = null
    try {
      lock = JSON.parse(await readFile(lockPath, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') lock = { error: errorInfo(error).code }
    }
    let backups = []
    try {
      const names = (await readdir(root)).filter((name) => name.startsWith('ledger.v1-backup.') || name.startsWith('ledger.v2-before-rollback.')).sort()
      for (const name of names.slice(-MAX_BACKUP_FILES)) {
        const file = path.join(root, name)
        const info = await stat(file)
        const bytes = await readFile(file)
        backups.push({ name, bytes: info.size, sha256: hashBytes(bytes) })
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') backups = [{ error: errorInfo(error).code }]
    }
    let ledgerMeta = null
    try {
      const info = await stat(statePath)
      if (info.size <= MAX_LEDGER_META_BYTES) {
        const state = JSON.parse(await readFile(statePath, 'utf8'))
        ledgerMeta = {
          version: state?.version ?? null,
          revision: state?.revision ?? null,
          settingsRevision: state?.settingsRevision ?? null,
          messageCount: Array.isArray(state?.messages) ? state.messages.length : null,
          chainCount: isPlainObject(state?.chains) ? Object.keys(state.chains).length : null,
          operationKeys: isPlainObject(state?.operations) ? Object.keys(state.operations).sort().slice(0, 1000) : null,
          bytes: info.size,
          sha256: hashBytes(await readFile(statePath)),
        }
      } else {
        ledgerMeta = { bytes: info.size, skipped: 'ledger larger than metadata bound' }
      }
    } catch (error) {
      ledgerMeta = { error: errorInfo(error).code }
    }
    return {
      fixtureInstanceId: this.instanceId,
      hostPid: process.pid,
      service: this.#serviceInfo(service),
      root,
      statePath,
      lockPath,
      writable: ledger.writable === true,
      lock,
      backups,
      ledger: ledgerMeta,
    }
  }

  /**
   * Prepare legal v0.1 data through the v0.1 tool/owner paths. Only the
   * unknown record and the latch are synthetic residues created through
   * ledger.mutate; they are explicitly marked as construction, never as a real
   * network crash. The returned baseline is used by the v0.2 verification pass.
   * @returns {Promise<Record<string, any>>}
   */
  async legacyPrepare() {
    const service = this.#requireService()
    const initial = await service.snapshot({ limit: 1, filter: 'all' })
    if (initial.total !== 0) fail('legacy_home_not_fresh', 'legacy migration home must not already contain session-link messages')
    if (!isPlainObject(initial.settings) || !('emergencyPaused' in initial.settings) || !('autoCollaborate' in initial.settings)) {
      fail('legacy_host_required', 'legacy.prepare must run on the v0.1 plugin generation')
    }
    const setup = await withTimeout(() => this.stress.init(), 190_000, 'legacy fixture init')
    const byKey = new Map((setup.sessions ?? []).map((session) => [session.key, session]))
    const keys = ['a1', 'a2', 'a3', 'a4', 'a5', 'b1', 'b2', 'b3', 'b4', 'b5']
    if (!keys.every((key) => byKey.has(key))) fail('setup_incomplete', 'legacy fixture did not return a1..a5/b1..b5')
    const sessions = Object.fromEntries(keys.map((key) => [key, byKey.get(key).id]))

    const invoke = async (sessionId, name, args) =>
      await withTimeout(
        () => this.stress.invoke({ sessionId, name, args, timeoutMs: 30_000 }),
        40_000,
        `legacy tool ${name}`,
      )
    const mint = async (sessionId) => {
      const value = await invoke(sessionId, 'session_link_operation', {})
      if (typeof value?.operationId !== 'string' || !value.operationId.startsWith('slop:')) {
        fail('operation_invalid', 'v0.1 operation tool did not return an operationId')
      }
      return value.operationId
    }
    const send = async (sessionId, args) => await invoke(sessionId, 'session_link_send', args)
    const reply = async (sessionId, args) => await invoke(sessionId, 'session_link_reply', args)
    const revision = async () => (await service.snapshot({ limit: 1, filter: 'all' })).revision
    const snapshot = async () => await service.snapshot({ limit: 100, filter: 'all' })
    const waitFor = async (predicate, label, timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const value = await predicate()
        if (value?.ok === true) return value.value
        await sleep(100)
      }
      fail('timeout', `legacy prepare timed out waiting for ${label}`)
    }
    const waitMessage = async (id, status) =>
      await waitFor(async () => {
        const state = await snapshot()
        const message = state.messages.find((item) => item.id === id)
        return message?.status === status ? { ok: true, value: message } : undefined
      }, `message ${id} ${status}`)
    const waitChain = async (id, stateName, reason) =>
      await waitFor(async () => {
        const state = await snapshot()
        const chain = state.chains.find((item) => item.id === id)
        if (chain?.state !== stateName) return undefined
        if (reason !== undefined && chain.pausedReason !== reason) return undefined
        return { ok: true, value: chain }
      }, `chain ${id} ${stateName}`)

    // 1) Real accepted request + explicit linked reply.
    const acceptedRequestArgs = {
      operationId: await mint(sessions.a1),
      targets: [sessions.b1],
      kind: 'request',
      text: `LEGACY_ACCEPTED_REQUEST ${randomUUID()}`,
    }
    const acceptedRequest = await send(sessions.a1, acceptedRequestArgs)
    const acceptedRequestId = acceptedRequest.results?.[0]?.id
    if (typeof acceptedRequestId !== 'string') fail('legacy_send_failed', 'accepted request has no id')
    await waitMessage(acceptedRequestId, 'accepted')
    const acceptedReply = await reply(sessions.b1, {
      operationId: await mint(sessions.b1),
      messageId: acceptedRequestId,
      text: `LEGACY_ACCEPTED_REPLY ${randomUUID()}`,
    })
    const acceptedReplyId = acceptedReply.results?.[0]?.id
    if (typeof acceptedReplyId !== 'string') fail('legacy_reply_failed', 'accepted reply has no id')
    await waitMessage(acceptedReplyId, 'accepted')

    // 2) Real accepted notification.
    const notification = await send(sessions.a2, {
      operationId: await mint(sessions.a2),
      targets: [sessions.b2],
      kind: 'notification',
      text: `LEGACY_ACCEPTED_NOTIFICATION ${randomUUID()}`,
    })
    const notificationId = notification.results?.[0]?.id
    if (typeof notificationId !== 'string') fail('legacy_send_failed', 'accepted notification has no id')
    await waitMessage(notificationId, 'accepted')

    // 3) Owner-paused chain (must survive migration unchanged).
    const ownerRequest = await send(sessions.a3, {
      operationId: await mint(sessions.a3),
      targets: [sessions.b3],
      kind: 'request',
      text: `LEGACY_OWNER_PAUSE ${randomUUID()}`,
    })
    const ownerRequestId = ownerRequest.results?.[0]?.id
    const ownerChainId = ownerRequest.chainId
    if (typeof ownerRequestId !== 'string' || typeof ownerChainId !== 'string') fail('legacy_send_failed', 'owner-pause request has no id/chain')
    await waitMessage(ownerRequestId, 'accepted')
    await service.control({ expectedRevision: await revision(), action: 'pause', id: ownerChainId })
    await waitChain(ownerChainId, 'paused', 'owner')

    // 4) Real quota-paused chain: create hop 0..8 with paced tools, then the
    //    hop-9 attempt hits the v0.1 maxHops and pauses the chain.
    let parent = undefined
    let hopSender = sessions.a5
    let hopTarget = sessions.b5
    for (let step = 0; step <= 8; step++) {
      const sent = await send(hopSender, {
        operationId: await mint(hopSender),
        targets: [hopTarget],
        kind: 'notification',
        text: `LEGACY_HOP_${step} ${randomUUID()}`,
        ...(parent === undefined ? {} : { parentMessageId: parent.id }),
      })
      const id = sent.results?.[0]?.id
      if (typeof id !== 'string') fail('legacy_send_failed', `hop ${step} has no id`)
      await waitMessage(id, 'accepted')
      parent = { id, from: hopSender }
      const next = hopSender
      hopSender = hopTarget
      hopTarget = next
      await sleep(1200)
    }
    const hopChainId = (await snapshot()).messages.find((item) => item.id === parent.id)?.chainId
    if (typeof hopChainId !== 'string') fail('legacy_send_failed', 'hop chain id is missing')
    let hopError
    try {
      await send(hopSender, {
        operationId: await mint(hopSender),
        targets: [hopTarget],
        kind: 'notification',
        text: `LEGACY_HOP_9 ${randomUUID()}`,
        parentMessageId: parent.id,
      })
    } catch (error) {
      hopError = errorInfo(error)
    }
    if (hopError?.code !== 'hop_exceeded') fail('legacy_hop_not_paused', `expected v0.1 hop_exceeded, got ${hopError?.code ?? 'success'}`)
    await waitChain(hopChainId, 'paused', 'hop_exceeded')

    // 5) Real autoCollaborate-off held record (v0.1 stores the known global
    //    reason only in error.code; migration must use it as a safe fallback),
    //    then a real emergency-paused held record and a cancelled held record.
    await service.settings({ expectedRevision: await revision(), patch: { autoCollaborate: false } })
    const autoHeldSent = await send(sessions.a4, {
      operationId: await mint(sessions.a4),
      targets: [sessions.b4],
      kind: 'notification',
      text: `LEGACY_HELD_AUTO_OFF ${randomUUID()}`,
    })
    const autoHeldId = autoHeldSent.results?.[0]?.id
    if (typeof autoHeldId !== 'string') fail('legacy_send_failed', 'auto-off held message has no id')
    await waitMessage(autoHeldId, 'held')
    const autoHeldError = (await snapshot()).messages.find((item) => item.id === autoHeldId)?.error?.code
    if (autoHeldError !== 'auto_collaborate_off') fail('legacy_auto_hold', `auto-off held error is ${autoHeldError}`)

    await service.settings({ expectedRevision: await revision(), patch: { autoCollaborate: true, emergencyPaused: true } })
    const emergencySent = await send(sessions.a5, {
      operationId: await mint(sessions.a5),
      targets: [sessions.b5],
      kind: 'notification',
      text: `LEGACY_HELD_EMERGENCY ${randomUUID()}`,
    })
    const emergencyHeldId = emergencySent.results?.[0]?.id
    if (typeof emergencyHeldId !== 'string') fail('legacy_send_failed', 'emergency held message has no id')
    await waitMessage(emergencyHeldId, 'held')
    const emergencyError = (await snapshot()).messages.find((item) => item.id === emergencyHeldId)?.error?.code
    if (emergencyError !== 'emergency_paused') fail('legacy_emergency_hold', `emergency held error is ${emergencyError}`)

    const cancelled = await send(sessions.a1, {
      operationId: await mint(sessions.a1),
      targets: [sessions.b1],
      kind: 'notification',
      text: `LEGACY_CANCELLED ${randomUUID()}`,
    })
    const cancelledId = cancelled.results?.[0]?.id
    if (typeof cancelledId !== 'string') fail('legacy_send_failed', 'cancelled message has no id')
    await waitMessage(cancelledId, 'held')
    await service.control({ expectedRevision: await revision(), action: 'cancel', id: cancelledId })
    await waitMessage(cancelledId, 'cancelled')

    // 6) Synthetic residues, deliberately constructed for migration coverage:
    //    an unknown record (no host insertion), one explicit manual hold, one
    //    unknown-reason hold, and one legacy latch. These are not presented as
    //    a real network crash. The two held residues are used to prove that
    //    global resume releases only known automatic reasons.
    const now = Date.now()
    const unknownChainId = randomUUID()
    const unknownId = `legacy-unknown-${randomUUID()}`
    const unknownDurableId = `legacy-durable-${randomUUID()}`
    const manualChainId = randomUUID()
    const manualHeldId = `legacy-manual-held-${randomUUID()}`
    const unknownHeldChainId = randomUUID()
    const unknownHeldId = `legacy-unknown-held-${randomUUID()}`
    const latchId = `latch:legacy-synthetic-${randomUUID()}`
    const unknownText = `LEGACY_UNKNOWN_SYNTHETIC ${randomUUID()}`
    const manualHeldText = `LEGACY_MANUAL_HELD ${randomUUID()}`
    const unknownHeldText = `LEGACY_UNKNOWN_HELD ${randomUUID()}`
    const syntheticChain = (id, rootOwner) => ({
      id,
      rootOwner,
      createdAt: now,
      state: 'open',
      maxMessages: 20,
      maxHops: 8,
      messageCount: 1,
    })
    const syntheticMessage = (id, from, to, chainId, text, overrides = {}) => ({
      id,
      from,
      to,
      kind: 'notification',
      chainId,
      hop: 0,
      createdAt: now,
      acceptedAt: null,
      deadlineAt: null,
      timedOutAt: null,
      lateReplyAt: null,
      content: { text, references: [], paths: [] },
      contentBytes: Buffer.byteLength(text, 'utf8'),
      status: 'held',
      replyStatus: 'none',
      deliveryAttempts: 0,
      durableMessageId: null,
      error: { code: 'legacy_hold', message: 'constructed held residue for migration acceptance' },
      heldAt: now,
      ...overrides,
    })
    await service.ledger.mutate((state) => {
      state.chains[unknownChainId] = syntheticChain(unknownChainId, sessions.b4)
      state.messages.push({
        ...syntheticMessage(unknownId, sessions.b4, sessions.a4, unknownChainId, unknownText),
        status: 'unknown',
        deliveryAttempts: 1,
        durableMessageId: unknownDurableId,
        error: { code: 'evidence_unreadable', message: 'constructed unknown residue for migration acceptance' },
      })
      state.chains[manualChainId] = syntheticChain(manualChainId, sessions.b4)
      state.messages.push(
        syntheticMessage(manualHeldId, sessions.b4, sessions.a4, manualChainId, manualHeldText, {
          error: { code: 'owner_hold', message: 'constructed explicit manual hold' },
          heldReason: 'owner',
        }),
      )
      state.chains[unknownHeldChainId] = syntheticChain(unknownHeldChainId, sessions.a1)
      state.messages.push(
        syntheticMessage(unknownHeldId, sessions.a1, sessions.b1, unknownHeldChainId, unknownHeldText, {
          error: { code: 'legacy_unknown_hold', message: 'constructed unknown-reason hold' },
        }),
      )
      state.latches.push({
        id: latchId,
        scope: 'global',
        reason: 'deliveries',
        createdAt: now,
      })
      return true
    })

    const final = await service.snapshot({ limit: 100, filter: 'all' })
    const raw = service.ledger.read()
    const ordered = final.messages
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    return {
      scenario: 'legacy-v1',
      fixtureInstanceId: this.instanceId,
      hostPid: process.pid,
      setup,
      sessions,
      accepted: { requestId: acceptedRequestId, replyId: acceptedReplyId, notificationId },
      ownerPause: { chainId: ownerChainId, requestId: ownerRequestId },
      quotaPause: { chainId: hopChainId, hopError, messageId: parent.id },
      autoHeld: { messageId: autoHeldId, target: sessions.b4, errorCode: autoHeldError },
      emergencyHeld: { messageId: emergencyHeldId, target: sessions.b5, errorCode: emergencyError },
      held: { messageId: emergencyHeldId },
      manualHeld: { messageId: manualHeldId, target: sessions.a4, heldReason: 'owner' },
      unknownHeld: { messageId: unknownHeldId, target: sessions.b1, errorCode: 'legacy_unknown_hold' },
      cancelled: { messageId: cancelledId },
      unknown: { messageId: unknownId, durableMessageId: unknownDurableId, text: unknownText },
      synthetic: {
        latchId,
        construction: 'test-only ledger.mutate: unknown, explicit-manual-held, unknown-held, and legacy latch; not a simulated host crash',
      },
      baseline: {
        settings: final.settings,
        revision: final.revision,
        messageCount: raw.messages.length,
        messages: ordered.map((message) => ({
          id: message.id,
          from: message.from,
          to: message.to,
          kind: message.kind,
          chainId: message.chainId,
          hop: message.hop,
          parentMessageId: message.parentMessageId ?? null,
          replyTo: message.replyTo ?? null,
          status: message.status,
          replyStatus: message.replyStatus,
          durableMessageId: message.durableMessageId ?? null,
        })),
        operationKeys: Object.keys(raw.operations).sort(),
        chainIds: Object.keys(raw.chains).sort(),
      },
      state: await this.stateInfo(),
    }
  }

  /** @param {string} action @param {Record<string, any>} payload @returns {Promise<any>} */
  async run(action, payload) {
    if (action === 'init') return await withTimeout(() => this.stress.init(), 190_000, 'fixture init')
    if (action === 'invoke') return await withTimeout(() => this.stress.invoke(payload), 130_000, 'fixture invoke')
    if (action === 'evidence') return await withTimeout(() => this.rawEvidence(payload), 20_000, 'fixture evidence')
    if (action === 'idle') return await withTimeout(() => this.stress.idle(payload), 35_000, 'fixture idle')
    if (action === 'service.status') return await this.serviceStatus()
    if (action === 'barrier.arm') return await this.barrierArm(payload)
    if (action === 'barrier.status') return await this.barrierStatus()
    if (action === 'barrier.release' || action === 'barrier.disarm') return await this.barrierRelease({ ...payload, disarm: action === 'barrier.disarm' ? true : payload.disarm })
    if (action === 'state.info') return await this.stateInfo()
    if (action === 'legacy.prepare') return await this.legacyPrepare()
    fail('unknown_action', `unknown v02 fixture action ${action}`)
  }

  /** @param {Request} request @returns {Promise<Response>} */
  async handle(request) {
    if (request.method !== 'POST') return response({ ok: false, error: { code: 'method_not_allowed', message: 'POST only' } }, 405)
    const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') {
      return response({ ok: false, error: { code: 'unsupported_media_type', message: 'content-type must be application/json' } }, 415)
    }
    let text
    try {
      text = await request.text()
    } catch {
      return response({ ok: false, error: { code: 'bad_request', message: 'request body could not be read' } }, 400)
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
      return response({ ok: false, error: { code: 'payload_too_large', message: 'request body is too large' } }, 413)
    }
    let body
    try {
      body = JSON.parse(text)
    } catch {
      return response({ ok: false, error: { code: 'bad_request', message: 'body is not JSON' } }, 400)
    }
    if (!isPlainObject(body)) return response({ ok: false, error: { code: 'bad_request', message: 'body must be an object' } }, 400)
    const extra = Object.keys(body).filter((key) => key !== 'action' && key !== 'payload')
    if (extra.length > 0) return response({ ok: false, error: { code: 'bad_request', message: 'body accepts only action and payload' } }, 400)
    if (typeof body.action !== 'string' || !V02_ACTIONS.includes(body.action)) {
      return response({ ok: false, error: { code: 'unknown_action', message: 'unknown v02 fixture action' } }, 400)
    }
    const payload = body.payload === undefined ? {} : body.payload
    if (!isPlainObject(payload)) return response({ ok: false, error: { code: 'bad_request', message: 'payload must be an object' } }, 400)
    try {
      return response({ ok: true, value: await this.run(body.action, payload) })
    } catch (error) {
      return response({ ok: false, error: errorInfo(error) })
    }
  }

  /** @returns {Promise<void>} */
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    const tasks = []
    for (const barrier of this.barriers.values()) {
      barrier.armed = false
      if (barrier.timer !== undefined) clearTimeout(barrier.timer)
      barrier.timer = undefined
      for (const entry of barrier.entries) entry.release?.()
      tasks.push(...barrier.entries.map((entry) => entry.done))
      if (barrier.adapter.deliver === barrier.wrapper) barrier.adapter.deliver = barrier.original
    }
    this.barriers.clear()
    if (tasks.length > 0) {
      await Promise.race([
        Promise.all(tasks),
        sleep(2000, undefined, { ref: false }).catch(() => undefined),
      ])
    }
  }
}

/** @param {unknown} body @param {number} [status] @returns {Response} */
function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * Install the test-only route. The route's owner-only gate is enforced by the
 * Host's Connection fetch registration before this handler runs. No cookie or
 * token is read here.
 *
 * @param {Record<string, any>} ctx
 * @param {{ home: string, createUserMessage: (input: Record<string, any>) => Record<string, any> }} options
 * @returns {Promise<{ path: string, actions: readonly string[], dispose: () => Promise<void> }>}
 */
export async function installV02Fixture(ctx, options = {}) {
  const home = requireTestHome(options.home)
  const fixture = new V02Fixture(ctx, home, options.createUserMessage)
  const disposeRoute = await ctx.connection.fetch.register({
    path: V02_FIXTURE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        return await fixture.handle(request)
      } catch (error) {
        return response({ ok: false, error: errorInfo(error) }, 500)
      }
    },
  })
  return {
    path: V02_FIXTURE_PATH,
    actions: V02_ACTIONS,
    async dispose() {
      try {
        if (typeof disposeRoute === 'function') await disposeRoute()
      } finally {
        await fixture.dispose()
      }
    },
  }
}
