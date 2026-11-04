/**
 * Host plugin assembly. The package entry supplies the only Host value import
 * (`createUserMessage`); this module stays injectable for mock-host tests.
 */

import os from 'node:os'
import path from 'node:path'

import { SessionLinkEngine } from '../core/engine.js'
import { fail, errorCode } from '../core/errors.js'
import { Ledger } from '../core/ledger.js'
import { isPlainObject, absolutePath, boundedInteger, sanitizeProfileName } from '../core/validation.js'
import { HostAdapter } from './adapter.js'
import {
  CONNECTION_PATH,
  createConnectionHandler,
  dispatchRpc,
  registerConnectionRoute,
} from './connection.js'
import { PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER, SESSION_LINK_GUIDANCE } from './prompt.js'
import { createToolDefinitions } from './tools.js'

const NOOP_LOGGER = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
})

/**
 * @param {unknown} config
 * @returns {{ stateRoot?: string, profileName?: string, tickMs: number, cacheMs: number, maxLedgerBytes?: number, maxQueuedBytes?: number }}
 */
export function normalizeConfig(config) {
  const object = config === undefined || config === null ? {} : config
  if (!isPlainObject(object)) throw fail('invalid_argument', 'session-link plugin config must be an object')
  const allowed = new Set(['stateRoot', 'profileName', 'tickMs', 'cacheMs', 'maxLedgerBytes', 'maxQueuedBytes'])
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw fail('invalid_argument', `unknown session-link config key ${key}`)
  }
  const normalized = {
    tickMs: object.tickMs === undefined ? 15_000 : boundedInteger(object.tickMs, 'tickMs', { min: 1000, max: 3_600_000 }),
    cacheMs: object.cacheMs === undefined ? 1500 : boundedInteger(object.cacheMs, 'cacheMs', { min: 0, max: 60_000 }),
  }
  if (object.stateRoot !== undefined) normalized.stateRoot = absolutePath(object.stateRoot, 'stateRoot')
  if (object.profileName !== undefined) {
    if (typeof object.profileName !== 'string') throw fail('invalid_argument', 'profileName must be a string')
    normalized.profileName = sanitizeProfileName(object.profileName)
  }
  for (const key of ['maxLedgerBytes', 'maxQueuedBytes']) {
    if (object[key] === undefined) continue
    const value = object[key]
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw fail('invalid_argument', `${key} must be a positive safe integer`)
    }
    normalized[key] = value
  }
  return normalized
}

/**
 * Resolve the state root from profile context / DSH_HOME, never from a
 * hardcoded production path.
 * @param {Record<string, any>} ctx
 * @param {{ stateRoot?: string, profileName?: string }} config
 * @returns {string}
 */
export function resolveStateRoot(ctx, config) {
  if (config.stateRoot !== undefined) return config.stateRoot
  // profileContext is an optional app-boot contribution, not an inject'ed
  // service. Reading it as a bare property would throw in a plugin whose
  // inject set does not name it, so use the reflection lookup and fall back to
  // the documented environment/home resolution.
  const profileContext = optionalContextService(ctx, 'profileContext')
  const envHome = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  const home = profileContext?.home ?? (envHome.length > 0 ? envHome : path.join(os.homedir(), '.dsh'))
  const profile =
    config.profileName ??
    profileContext?.name ??
    (typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE.trim().length > 0
      ? process.env.DSH_PROFILE.trim()
      : 'default')
  return path.join(home, 'state', 'dsh-session-link', sanitizeProfileName(profile))
}

/**
 * Read an optional Cordis contribution without triggering the proxy's
 * undeclared-service error. `ctx.get(name)` is the reflection API; a plain
 * object context used by tests falls back to an own property.
 * @param {Record<string, any>} ctx
 * @param {string} name
 * @returns {any}
 */
function optionalContextService(ctx, name) {
  try {
    if (typeof ctx.get === 'function') return ctx.get(name)
  } catch {
    return undefined
  }
  return ctx[name]
}

/**
 * @param {Record<string, any>} ctx
 */
function assertHostCapabilities(ctx) {
  const missing = []
  const read = (dotPath) => {
    let current = ctx
    for (const key of dotPath.split('.')) {
      current = current?.[key]
      if (current === undefined || current === null) return undefined
    }
    return current
  }
  const requiredPaths = [
    'sessions.flush',
    'agents.get',
    'sessionController.resolveAgent',
    'workspaceRegistry.list',
    'workspaceRegistry.archivedSessionIds',
    'sessionQuery.listSessions',
    'sessionQuery.readSession',
    'sessionQuery.readSurface',
    'sessionQuery.readTitleSnapshots',
    'connection.fetch.register',
    'tools.register',
    'systemPrompt.section',
  ]
  for (const dotPath of requiredPaths) {
    if (read(dotPath) === undefined) missing.push(dotPath)
  }
  if (typeof ctx.on !== 'function') missing.push('on (session/event)')
  for (const dotPath of [
    'sessions.flush',
    'agents.get',
    'sessionController.resolveAgent',
    'workspaceRegistry.list',
    'sessionQuery.listSessions',
    'sessionQuery.readSession',
    'sessionQuery.readSurface',
    'sessionQuery.readTitleSnapshots',
    'connection.fetch.register',
    'tools.register',
    'systemPrompt.section',
  ]) {
    if (read(dotPath) !== undefined && typeof read(dotPath) !== 'function') missing.push(`${dotPath} (function)`)
  }
  if (missing.length > 0) {
    throw fail(
      'unsupported_host',
      'target Host is missing public APIs required by session-link; refusing to mount a fallback control plane',
      { missing: [...new Set(missing)].slice(0, 10) },
    )
  }
}

export class SessionLinkService {
  /**
   * @param {{
   *   ctx: Record<string, any>,
   *   config?: Record<string, unknown>,
   *   deps?: Record<string, any>,
   *   ledger?: Ledger,
   *   adapter?: HostAdapter,
   *   engine?: SessionLinkEngine,
   * }} options
   */
  constructor(options) {
    if (options?.ctx === undefined) throw fail('internal', 'SessionLinkService requires ctx')
    this.ctx = options.ctx
    this.name = 'sessionLink'
    this.config = normalizeConfig(options.config)
    this.deps = options.deps ?? {}
    this.logger = this.deps.logger ?? NOOP_LOGGER
    this.ledger = options.ledger
    this.adapter = options.adapter
    this.engine = options.engine
    this.toolDefinitions = []
    this.connectionPath = CONNECTION_PATH
    this.#ownsLedger = options.ledger === undefined
    this.#ownsEngine = options.engine === undefined
    this.#disposers = []
    this.#opened = false
    this.#closed = false
    this.#timer = undefined
    this.#closePromise = undefined
  }

  #ownsLedger
  #ownsEngine
  #disposers
  #opened
  #closed
  #timer
  #closePromise

  /** @returns {Promise<SessionLinkService>} */
  async open() {
    if (this.#opened) return this
    assertHostCapabilities(this.ctx)
    try {
      const maxDiskBytes = this.deps.limits?.maxDiskBytes ?? this.config.maxLedgerBytes
      const maxQueuedBytes = this.deps.limits?.maxQueuedBytes ?? this.config.maxQueuedBytes
      if (this.ledger === undefined) {
        this.ledger = new Ledger({
          root: resolveStateRoot(this.ctx, this.config),
          clock: this.deps.clock,
          hostname: this.deps.hostname,
          pid: this.deps.pid,
          processStart: this.deps.processStart,
          ...(maxDiskBytes === undefined ? {} : { limits: { maxDiskBytes } }),
        })
        await this.ledger.open()
      }
      if (this.adapter === undefined) {
        if (typeof this.deps.createUserMessage !== 'function') {
          throw fail('internal', 'the package entry must inject the Host createUserMessage builder')
        }
        this.adapter = new HostAdapter({
          ctx: this.ctx,
          createUserMessage: this.deps.createUserMessage,
          clock: this.deps.clock,
          logger: this.logger,
          cacheMs: this.config.cacheMs,
        })
      }
      if (this.engine === undefined) {
        this.engine = new SessionLinkEngine({
          ledger: this.ledger,
          adapter: this.adapter,
          clock: this.deps.clock,
          uuid: this.deps.uuid,
          logger: this.logger,
          ...(maxQueuedBytes === undefined ? {} : { maxQueuedBytes }),
        })
      }
      if (this.#ownsEngine) await this.engine.start()

      this.toolDefinitions = createToolDefinitions({
        ctx: this.ctx,
        engine: this.engine,
        adapter: this.adapter,
      })
      for (const definition of this.toolDefinitions) {
        const dispose = this.ctx.tools.register(definition)
        this.#disposers.push(dispose)
      }
      const promptDispose = this.ctx.systemPrompt.section({
        name: PROMPT_SECTION_NAME,
        order: PROMPT_SECTION_ORDER,
        text: SESSION_LINK_GUIDANCE,
        interpolate: false,
      })
      this.#disposers.push(promptDispose)

      const connectionHandler = createConnectionHandler(this)
      const routeDispose = await registerConnectionRoute(this.ctx, connectionHandler)
      this.#disposers.push(routeDispose)

      if (typeof this.ctx.provide === 'function') {
        const provideDispose = this.ctx.provide('sessionLink', this)
        this.#disposers.push(provideDispose)
      } else {
        this.ctx.sessionLink = this
      }

      if (typeof this.ctx.effect === 'function') {
        this.ctx.effect(() => () => this.close(), 'dsh-session-link lifecycle')
      }
      this.#timer = setInterval(() => {
        this.engine.tick().catch((error) => this.logger.warn(`session-link tick failed: ${errorCode(error)}`))
      }, this.config.tickMs)
      this.#timer.unref?.()
      this.#opened = true
      return this
    } catch (error) {
      await this.close().catch(() => undefined)
      throw error
    }
  }

  /** @returns {Promise<void>} */
  close() {
    if (this.#closePromise !== undefined) return this.#closePromise
    this.#closed = true
    // Start the engine's abort immediately, before any async disposer can
    // yield. An old attempt blocked inside a slow disposer must already see
    // `disposed` and must never reach a new followup.
    const engineDisposePromise =
      this.engine === undefined
        ? undefined
        : this.engine.dispose().then(
            (value) => ({ ok: true, value }),
            (error) => ({ ok: false, error }),
          )
    this.#closePromise = this.#closeImpl(engineDisposePromise)
    return this.#closePromise
  }

  async #closeImpl(engineDisposePromise) {
    this.#opened = false
    if (this.#timer !== undefined) {
      clearInterval(this.#timer)
      this.#timer = undefined
    }
    const failures = []
    for (const dispose of this.#disposers.reverse()) {
      try {
        if (typeof dispose === 'function') await dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    this.#disposers = []
    let engineResult
    const engineOutcome = await engineDisposePromise
    if (engineOutcome?.ok === false) {
      failures.push(engineOutcome.error)
      engineResult = { storageSafe: false }
    } else {
      engineResult = engineOutcome?.value
    }
    if (this.#ownsLedger) {
      if (engineResult?.storageSafe === false) {
        failures.push(
          fail('dispose_timeout', 'session-link dispose could not prove the writer safe; keeping the writer lock', {
            ...(engineResult ?? {}),
          }),
        )
      } else {
        try {
          await this.ledger?.close()
        } catch (error) {
          failures.push(error)
        }
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'session-link disposal failed')
  }

  // Fixture/UI-facing delegates. All identity-bearing calls require the
  // caller id supplied by the host adapter/tool layer, never by an RPC body.
  snapshot(request) {
    return this.engine.snapshot(request)
  }

  settings(request) {
    return this.engine.updateSettings(request)
  }

  control(request) {
    return this.engine.ownerControl(request)
  }

  list(request) {
    return this.engine.list(request)
  }

  listSessions(request) {
    return this.engine.list(request)
  }

  history(request) {
    return this.engine.history(request)
  }

  send(request) {
    return this.engine.send(request)
  }

  reply(request) {
    return this.engine.reply(request)
  }

  status(request) {
    return this.engine.status(request)
  }

  inspect(id) {
    return this.engine.inspect(id)
  }

  mintOperation() {
    return this.engine.mintOperation()
  }

  handleRpc(body) {
    return dispatchRpc(this, body)
  }
}

/**
 * @param {Record<string, any>} ctx
 * @param {Record<string, unknown>|undefined} config
 * @param {Record<string, any>} deps
 * @returns {Promise<SessionLinkService>}
 */
export async function createSessionLinkPlugin(ctx, config, deps) {
  const service = new SessionLinkService({ ctx, config, deps })
  await service.open()
  return service
}
