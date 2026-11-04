/**
 * Test-only v0.3 real-host timing fixture.
 *
 * This module is deliberately NOT part of the production package. It is
 * installed by scripts/fixtures/index.js only under SESSION_LINK_TEST=1 and a
 * dedicated /tmp/dsh-session-link-* DSH_HOME. It never reads credentials,
 * starts/stops a Host, or opens a raw webServer route. Its route is registered
 * through ctx.connection.fetch, so the Host's owner-only principal gate and
 * exact route matching run before the handler.
 *
 * The fixture drives a real Agent with a local scripted LlmAdapter. It can:
 *   - start one real turn whose first step calls the test-only `v03_hold` tool;
 *   - report the live Agent inbox (`nextTurn`/`nextStep`) while that tool is
 *     still blocked, including the original host message objects;
 *   - release the tool and let the same turn continue to its next step;
 *   - read bounded raw session events with turn/step annotations.
 *
 * Contract:
 *   const { installV03Fixture } = await import('./v03.js')
 *   const fixture = await installV03Fixture(ctx, { home, createUserMessage, LlmAdapter })
 *   ctx.effect(() => () => fixture.dispose())
 *
 * Body: bare { action, payload } -> { ok: true, value } |
 *       { ok: false, error: { code, message } }.
 *
 * The fixture does not inject `sessionLink`. Every service read resolves
 * `ctx.get('sessionLink')` at action time, so the fixture survives a package
 * hot reload and can still release a hold that started under an older package.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export const V03_FIXTURE_PATH = '/api/session-link-v03-fixture'
export const V03_PROVIDER = 'session-link-v03-fixture'
export const V03_MODEL = 'v03-fixture'
export const V03_HOLD_TOOL = 'v03_hold'
export const V03_ACTIONS = Object.freeze([
  'init',
  'invoke',
  'hold.start',
  'hold.status',
  'hold.release',
  'idle',
  'evidence',
  'native.user',
  'service.status',
  'ledger.info',
  'guard.owner',
])

const HOME_PREFIX = '/tmp/dsh-session-link-'
const STATE_VERSION = 1
const STATE_FILE = 'v03-sessions.json'
const WORK_DIRECTORY = 'v03-work'
const MAX_BODY_BYTES = 256 * 1024
const MAX_TOOL_RESULT_BYTES = 256 * 1024
const MAX_TEXT_CHARS = 4096
const MAX_EVIDENCE_EVENTS = 500
const MAX_LEDGER_META_BYTES = 8 * 1024 * 1024
const MAX_INBOX_ITEMS = 50
const MAX_ADAPTER_STEPS = 80
const DEFAULT_TIMEOUT_MS = 30_000
const HOLD_ENTER_TIMEOUT_MS = 30_000
const HOLD_RELEASE_TIMEOUT_MS = 30_000
const IDLE_TIMEOUT_MS = 120_000
const HOLD_PROMPT_MARKER = 'V03_HOLD_PROMPT'
const INBOUND_HEADER = /^\[session-link (notification|request|reply) from ([^\]]+)\]\nmessage: ([^\n]+)/

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
    throw new FixtureError('fixture_guard', 'v03 fixture requires SESSION_LINK_TEST=1')
  }
  if (typeof home !== 'string' || home.length === 0 || home.includes('\0')) {
    throw new FixtureError('fixture_guard', 'v03 fixture requires an isolated home path')
  }
  const resolved = path.resolve(home)
  if (!resolved.startsWith(HOME_PREFIX) || resolved.length <= HOME_PREFIX.length) {
    throw new FixtureError('fixture_guard', 'v03 fixture home must be under /tmp/dsh-session-link-*')
  }
  const envHome = process.env.DSH_HOME === undefined ? undefined : path.resolve(process.env.DSH_HOME)
  if (envHome !== undefined && envHome !== resolved) {
    throw new FixtureError('fixture_guard', 'v03 fixture home does not match DSH_HOME')
  }
  return resolved
}

/** @param {Record<string, any>} ctx */
function requireHostCapabilities(ctx) {
  if (ctx === undefined || ctx === null) throw new FixtureError('fixture_guard', 'v03 fixture requires ctx')
  for (const name of ['workspaceRegistry', 'sessionController', 'sessionQuery', 'agents', 'sessions', 'tools', 'connection']) {
    if (ctx[name] === undefined || ctx[name] === null) {
      throw new FixtureError('fixture_guard', `v03 fixture requires ctx.${name}`)
    }
  }
  if (typeof ctx.get !== 'function') throw new FixtureError('fixture_guard', 'v03 fixture requires ctx.get() reflection')
  if (typeof ctx.llm?.registerAdapter !== 'function') throw new FixtureError('fixture_guard', 'v03 fixture requires ctx.llm.registerAdapter')
  if (typeof ctx.connection.fetch?.register !== 'function') throw new FixtureError('fixture_guard', 'v03 fixture requires ctx.connection.fetch.register')
  if (typeof ctx.sessionController.create !== 'function') throw new FixtureError('fixture_guard', 'v03 fixture requires ctx.sessionController.create')
  if (typeof ctx.sessionController.selectModel !== 'function') throw new FixtureError('fixture_guard', 'v03 fixture requires ctx.sessionController.selectModel')
  if (typeof ctx.sessionController.resolveAgent !== 'function') throw new FixtureError('fixture_guard', 'v03 fixture requires ctx.sessionController.resolveAgent')
  if (typeof ctx.sessionQuery.readSession !== 'function') throw new FixtureError('fixture_guard', 'v03 fixture requires ctx.sessionQuery.readSession')
  if (typeof ctx.sessions.flush !== 'function') throw new FixtureError('fixture_guard', 'v03 fixture requires ctx.sessions.flush')
  if (typeof ctx.tools.register !== 'function') throw new FixtureError('fixture_guard', 'v03 fixture requires ctx.tools.register')
}

/** @param {unknown} value @returns {string} */
function textOfContent(value) {
  if (!Array.isArray(value)) return ''
  return value
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** @param {unknown} value @param {number} [max] @returns {string} */
function boundedText(value, max = MAX_TEXT_CHARS) {
  if (typeof value !== 'string') return ''
  return value.length > max ? value.slice(0, max) : value
}

/** @param {string} value @returns {string} */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** @param {unknown} error @returns {{ code: string, message: string }} */
function errorInfo(error) {
  const code = typeof error?.code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(error.code) ? error.code : 'fixture_error'
  const message = typeof error?.message === 'string' && error.message.length > 0 ? error.message : 'v03 fixture action failed'
  return { code, message: message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500) }
}

/** @param {unknown} value @param {number} max @returns {string} */
function hashBytes(value, max = 2 * 1024 * 1024) {
  const hash = createHash('sha256')
  hash.update(value.length > max ? value.subarray(0, max) : value)
  return hash.digest('hex')
}

/** @param {unknown} value @returns {string|undefined} */
function safeString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** @param {unknown} source @returns {Record<string, string>|null} */
function sourceView(source) {
  if (!isPlainObject(source)) return null
  const result = {}
  for (const key of Object.keys(source).sort()) {
    if (typeof source[key] === 'string') result[key] = source[key]
  }
  return result
}

/** @param {Record<string, any>} message @param {number} maxTextChars @returns {Record<string, any>} */
function messageView(message, maxTextChars) {
  const text = textOfContent(message?.content)
  return {
    id: typeof message?.id === 'string' ? message.id : null,
    source: sourceView(message?.source),
    sourceKeyCount: isPlainObject(message?.source) ? Object.keys(message.source).length : null,
    text: boundedText(text, maxTextChars),
    textBytes: Buffer.byteLength(text, 'utf8'),
    textTruncated: text.length > maxTextChars,
    textSha256: sha256(text),
  }
}

/** @param {Record<string, any>} item @param {number} maxTextChars @returns {Record<string, any>} */
function inboxItemView(item, maxTextChars) {
  return {
    id: typeof item?.id === 'string' ? item.id : null,
    source: sourceView(item?.source),
    sourceKeyCount: isPlainObject(item?.source) ? Object.keys(item.source).length : null,
    text: boundedText(textOfContent(item?.content), maxTextChars),
    textBytes: Buffer.byteLength(textOfContent(item?.content), 'utf8'),
  }
}

/** @param {string} text @returns {{ kind: 'notification'|'request'|'reply', senderSessionId: string, messageId: string, body: string }|null} */
function parseInbound(text) {
  if (typeof text !== 'string') return null
  const match = INBOUND_HEADER.exec(text)
  if (match === null) return null
  const sender = match[2].split(' (', 1)[0].trim()
  if (sender.length === 0 || match[3].trim().length === 0) return null
  return {
    kind: /** @type {'notification'|'request'|'reply'} */ (match[1]),
    senderSessionId: sender,
    messageId: match[3].trim(),
    body: text,
  }
}

/** @param {string} text @returns {boolean} */
function isHoldPrompt(text) {
  return typeof text === 'string' && text.includes(HOLD_PROMPT_MARKER)
}

/** @param {unknown} value @returns {Record<string, any>|undefined} */
function parseToolArguments(value) {
  if (isPlainObject(value)) return value
  if (typeof value !== 'string') return undefined
  try {
    const parsed = JSON.parse(value)
    return isPlainObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** @param {Record<string, any>} entry @returns {Record<string, any>} */
function holdView(entry) {
  const now = Date.now()
  const ended = entry.completedAt ?? entry.abortedAt
  return {
    id: entry.id,
    tag: entry.tag,
    sessionId: entry.sessionId,
    callId: entry.callId,
    enteredAt: entry.enteredAt,
    releasedAt: entry.releasedAt,
    completedAt: entry.completedAt,
    abortedAt: entry.abortedAt,
    abortCount: entry.abortCount,
    abortReasons: entry.abortReasons.slice(0, 10),
    state:
      entry.abortCount > 0
        ? 'aborted'
        : entry.completedAt !== null
          ? 'completed'
          : entry.releasedAt !== null
            ? 'released'
            : 'blocked',
    heldMs: Number.isSafeInteger(ended) ? Math.max(0, ended - entry.enteredAt) : Math.max(0, now - entry.enteredAt),
  }
}

/** @param {Record<string, any>} ctx @param {string} sessionId @returns {Promise<Record<string, any>>} */
async function resolveRegisteredAgent(ctx, sessionId) {
  const found = await ctx.sessionController.resolveAgent(sessionId)
  if (found === undefined || found === null || found.agent === undefined || found.agent === null) {
    fail('agent_unavailable', `agent ${sessionId} could not be resolved: ${JSON.stringify(found?.error ?? null)}`)
  }
  if (found.agent.id !== sessionId) fail('agent_identity_mismatch', 'resolved agent identity does not match the session id')
  if (ctx.agents.get(sessionId) !== found.agent) {
    fail('agent_identity_mismatch', 'resolved agent is not the registered registry instance')
  }
  return found.agent
}

class V03Fixture {
  /**
   * @param {Record<string, any>} ctx
   * @param {string} home
   * @param {(input: Record<string, any>) => Record<string, any>} createUserMessage
   * @param {new (...args: any[]) => any} LlmAdapter
   */
  constructor(ctx, home, createUserMessage, LlmAdapter) {
    requireHostCapabilities(ctx)
    if (typeof createUserMessage !== 'function') {
      throw new FixtureError('fixture_guard', 'v03 fixture requires the Host createUserMessage builder')
    }
    if (typeof LlmAdapter !== 'function') {
      throw new FixtureError('fixture_guard', 'v03 fixture requires the Host LlmAdapter class')
    }
    this.ctx = ctx
    this.home = home
    this.createUserMessage = createUserMessage
    this.LlmAdapter = LlmAdapter
    this.stateFile = path.join(home, STATE_FILE)
    this.instanceId = randomUUID()
    this.initializations = Promise.resolve()
    this.holds = new Map()
    this.holdOrder = []
    this.steps = []
    this.nextStream = 0
    this.disposed = false
    this.targetId = undefined
    this.senderId = undefined
    this.holdToolDispose = undefined
    this.adapterDispose = undefined
  }

  /** @param {() => Promise<any>} task @returns {Promise<any>} */
  #serializeInit(task) {
    const run = this.initializations.then(task, task)
    this.initializations = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** @returns {Promise<void>} */
  async start() {
    try {
      const state = await this.#loadState()
      if (state !== undefined) {
        this.targetId = state.sessions.target.id
        this.senderId = state.sessions.sender.id
      }
    } catch {
      // A stale/corrupt state file is reported by init; do not fail installation.
    }
    const fixture = this
    const Base = this.LlmAdapter
    class ScriptedV03Adapter extends Base {
      async listModels(provider) {
        return [{ provider, id: V03_MODEL, name: 'Local scripted v0.3 timing model (no API cost)', inputModalities: ['text'] }]
      }

      async resolveModel(provider, model) {
        return {
          provider,
          model,
          id: model,
          name: 'Local scripted v0.3 timing model',
          context: { contextWindow: 262144 },
          inputModalities: ['text'],
        }
      }

      async *stream(options) {
        yield* fixture.streamModel(options)
      }
    }
    this.adapterDispose = this.ctx.llm.registerAdapter([V03_PROVIDER], new ScriptedV03Adapter())
    if (typeof this.adapterDispose !== 'function') this.adapterDispose = undefined
    this.holdToolDispose = this.ctx.tools.register(this.#holdTool())
    if (typeof this.holdToolDispose !== 'function') this.holdToolDispose = undefined
  }

  /** @returns {Record<string, any>} */
  #holdTool() {
    const fixture = this
    return {
      name: V03_HOLD_TOOL,
      description: 'Test-only v0.3 fixture tool: block the current step until the fixture releases it. Never exposed in production.',
      parameters: {
        type: 'object',
        properties: {
          tag: { type: 'string' },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tag: { type: 'string' },
            heldMs: { type: 'integer' },
            aborted: { type: 'boolean' },
          },
          required: ['tag', 'heldMs', 'aborted'],
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `v03_hold ${value?.aborted === true ? 'aborted' : 'released'} after ${String(value?.heldMs ?? '?')}ms`,
          },
        ],
      },
      async execute(args, exec) {
        if (fixture.disposed) fail('fixture_disposed', 'v03 fixture is disposed')
        if (fixture.targetId === undefined) fail('not_initialized', 'v03 fixture has not been initialized')
        if (exec?.agent?.id !== fixture.targetId) {
          fail('forbidden_tool', `${V03_HOLD_TOOL} is only available to the v03 target session`)
        }
        const active = fixture.#activeHold(fixture.targetId)
        if (active !== undefined) fail('hold_active', 'the v03 target already has an active hold')
        const tag = typeof args?.tag === 'string' && args.tag.length > 0 ? args.tag.slice(0, 200) : `hold-${randomUUID()}`
        const entry = {
          id: randomUUID(),
          tag,
          callId: typeof exec?.callId === 'string' ? exec.callId : null,
          sessionId: fixture.targetId,
          enteredAt: Date.now(),
          releasedAt: null,
          completedAt: null,
          abortedAt: null,
          abortCount: 0,
          abortReasons: [],
          release: undefined,
          done: undefined,
        }
        entry.done = new Promise((resolve) => {
          entry.doneResolve = resolve
        })
        const signal = exec?.signal
        const onAbort = () => {
          entry.abortCount += 1
          entry.abortedAt ??= Date.now()
          const reason = typeof signal?.reason === 'object' && signal.reason !== null ? signal.reason.kind : String(signal?.reason ?? 'aborted')
          entry.abortReasons.push(reason.slice(0, 120))
          entry.release?.()
        }
        if (signal?.aborted === true) onAbort()
        else signal?.addEventListener?.('abort', onAbort, { once: true })
        fixture.holds.set(entry.id, entry)
        fixture.holdOrder.push(entry.id)
        try {
          await new Promise((resolve) => {
            entry.release = resolve
            if (entry.abortedAt !== null) resolve()
          })
        } finally {
          signal?.removeEventListener?.('abort', onAbort)
          entry.release = undefined
          entry.releasedAt ??= Date.now()
          entry.completedAt = Date.now()
          entry.doneResolve?.()
        }
        return {
          tag,
          heldMs: Math.max(0, entry.completedAt - entry.enteredAt),
          aborted: entry.abortCount > 0,
        }
      },
    }
  }

  /** @param {string} sessionId @returns {Record<string, any>|undefined} */
  #activeHold(sessionId) {
    for (let index = this.holdOrder.length - 1; index >= 0; index--) {
      const entry = this.holds.get(this.holdOrder[index])
      if (entry !== undefined && entry.sessionId === sessionId && entry.completedAt === null) return entry
    }
    return undefined
  }

  /** @param {string} sessionId @returns {Record<string, any>|undefined} */
  #latestHold(sessionId) {
    for (let index = this.holdOrder.length - 1; index >= 0; index--) {
      const entry = this.holds.get(this.holdOrder[index])
      if (entry !== undefined && entry.sessionId === sessionId) return entry
    }
    return undefined
  }

  /** @param {Record<string, any>} options @returns {AsyncIterable<any>} */
  async *streamModel(options) {
    if (this.disposed) throw new Error('v03 fixture is disposed')
    options.signal?.throwIfAborted()
    const messages = options.messages ?? []
    const stepIndex = ++this.nextStream
    const initialIndex = findLastIndex(messages, (item) => item.role === 'user' && isHoldPrompt(textOfContent(item.content)))
    const startIndex = initialIndex >= 0 ? initialIndex + 1 : 0
    const afterInitial = messages.slice(startIndex)
    const inbound = []
    for (const item of afterInitial) {
      if (item.role !== 'user') continue
      const parsed = parseInbound(textOfContent(item.content))
      if (parsed !== null) inbound.push(parsed)
    }
    const toolCalls = []
    for (let index = startIndex; index < messages.length; index++) {
      const item = messages[index]
      for (const block of item.content ?? []) {
        if (block?.type !== 'tool-call') continue
        toolCalls.push({
          index,
          id: block.id,
          name: block.name,
          arguments: block.arguments,
          parsed: parseToolArguments(block.arguments),
        })
      }
    }
    const holdCalls = toolCalls.filter((call) => call.name === V03_HOLD_TOOL)
    const replyCalls = toolCalls.filter((call) => call.name === 'session_link_reply')
    const operationCalls = toolCalls.filter((call) => call.name === 'session_link_operation')
    const repliedIds = new Set()
    for (const call of replyCalls) {
      const messageId = safeString(call.parsed?.messageId)
      if (messageId !== undefined) repliedIds.add(messageId)
    }
    const requests = [...new Map(inbound.filter((item) => item.kind === 'request').map((item) => [item.messageId, item])).values()]
    const pending = requests.filter((item) => !repliedIds.has(item.messageId))
    const step = {
      stream: stepIndex,
      at: Date.now(),
      sessionId: typeof options.sessionId === 'string' ? options.sessionId : null,
      messageCount: messages.length,
      initialFound: initialIndex >= 0,
      inbound: inbound.map((item) => ({
        messageId: item.messageId,
        kind: item.kind,
        senderSessionId: item.senderSessionId,
        text: boundedText(item.body, 2048),
      })),
      requests: requests.map((item) => item.messageId),
      pendingRequests: pending.map((item) => item.messageId),
      holdCalls: holdCalls.length,
      replyCalls: replyCalls.length,
      operationCalls: operationCalls.length,
      decision: undefined,
    }
    this.steps.push(step)
    if (this.steps.length > MAX_ADAPTER_STEPS) this.steps.shift()
    if (typeof options.sessionId === 'string' && this.targetId !== undefined && options.sessionId !== this.targetId) {
      step.decision = 'non-target-ack'
      yield* textResponse('V03_SENDER_ACK: local scripted sender observed the tool result.')
      return
    }
    if (holdCalls.length === 0) {
      step.decision = 'hold-call'
      yield* toolResponse(V03_HOLD_TOOL, { tag: stepIndex === 1 ? 'v03-core-hold' : `v03-hold-${stepIndex}` }, randomUUID())
      return
    }
    const lastOperation = operationCalls.at(-1)
    const operationResult =
      lastOperation === undefined
        ? undefined
        : afterInitial
            .slice(lastOperation.index - startIndex + 1)
            .filter((item) => item.role === 'tool')
            .map((item) => textOfContent(item.content))
            .join('\n')
    const operationId = operationResult?.match(/slop:\d+:[a-f0-9-]+/)?.[0]
    if (pending.length > 0) {
      const replyIndex = replyCalls.length
      if (operationId === undefined || (operationCalls.at(-1)?.index ?? -1) < (replyCalls.at(-1)?.index ?? -1)) {
        step.decision = 'operation-call'
        yield* toolResponse('session_link_operation', {}, randomUUID())
        return
      }
      const request = pending[0]
      step.decision = `reply:${request.messageId}`
      yield* toolResponse(
        'session_link_reply',
        {
          operationId,
          messageId: request.messageId,
          text: `V03_REPLY_FOR_${request.messageId} #${replyIndex + 1}`,
        },
        randomUUID(),
      )
      return
    }
    step.decision = 'final'
    const seenIds = [...new Map(inbound.map((item) => [item.messageId, item])).keys()]
    yield* textResponse(`V03_TARGET_DONE seen=${seenIds.length} ids=${seenIds.join(',')}`)
  }

  /** @returns {Promise<Record<string, any>>} */
  async #loadState() {
    let raw
    try {
      raw = await readFile(this.stateFile, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw new FixtureError('state_unreadable', 'v03 session state could not be read')
    }
    let state
    try {
      state = JSON.parse(raw)
    } catch {
      throw new FixtureError('state_corrupt', 'v03 session state is not valid JSON')
    }
    if (!isPlainObject(state) || state.version !== STATE_VERSION) fail('state_corrupt', 'v03 session state has an unsupported version')
    if (state.home !== this.home) fail('state_corrupt', 'v03 session state belongs to a different home')
    if (!isPlainObject(state.workspace) || !isPlainObject(state.sessions)) fail('state_corrupt', 'v03 session state is incomplete')
    for (const key of ['target', 'sender']) {
      if (!isPlainObject(state.sessions[key]) || typeof state.sessions[key].id !== 'string') {
        fail('state_corrupt', `v03 session state has no ${key} session`)
      }
    }
    return state
  }

  /** @param {Record<string, any>} state @returns {Promise<void>} */
  async #verifyState(state) {
    for (const key of ['target', 'sender']) {
      const sessionId = state.sessions[key].id
      const found = await this.ctx.sessionController.resolveAgent(sessionId)
      if (found?.agent?.id !== sessionId || this.ctx.agents.get(sessionId) !== found.agent) {
        fail('state_stale', `v03 ${key} session is no longer a registered live ordinary session`)
      }
    }
    const workspaces = this.ctx.workspaceRegistry.list()
    const workspace = workspaces.find((item) => item.id === state.workspace.id)
    if (workspace === undefined || !workspace.sessionIds.includes(state.sessions.target.id)) {
      fail('state_stale', 'v03 workspace or target session is no longer registered')
    }
    if (!workspace.sessionIds.includes(state.sessions.sender.id)) {
      fail('state_stale', 'v03 sender session is no longer in the v03 workspace')
    }
  }

  /** @returns {Promise<Record<string, any>>} */
  async #createState() {
    const directory = path.join(this.home, WORK_DIRECTORY)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    let workspace = this.ctx.workspaceRegistry.list().find((item) => path.resolve(item.path) === path.resolve(directory))
    if (workspace !== undefined && (workspace.sessionIds?.length ?? 0) > 0) {
      fail('partial_setup', 'v03 workspace already has sessions but no v03 state; use a fresh isolated home')
    }
    workspace ??= await this.ctx.workspaceRegistry.create(directory, 'v03 timing fixture')
    const sessions = {}
    for (const key of ['target', 'sender']) {
      const created = await this.ctx.sessionController.create({ workspaceId: workspace.id })
      const sessionId = created?.sessionId
      if (typeof sessionId !== 'string' || sessionId.length === 0) fail('setup_failed', 'sessionController.create returned no session id')
      const selection = await this.ctx.sessionController.selectModel({ sessionId, provider: V03_PROVIDER, model: V03_MODEL })
      if (selection?.selected?.provider !== V03_PROVIDER || selection?.selected?.model !== V03_MODEL) {
        fail('setup_failed', 'the v03 scripted model was not selected')
      }
      const agent = await resolveRegisteredAgent(this.ctx, sessionId)
      if (agent.id !== sessionId) fail('setup_failed', 'resolved v03 agent identity mismatch')
      await this.ctx.sessionController.rename({ sessionId, title: `v03-${key}` })
      const liveWorkspace = this.ctx.workspaceRegistry.list().find((item) => item.id === workspace.id)
      if (liveWorkspace !== undefined && !liveWorkspace.sessionIds.includes(sessionId) && typeof liveWorkspace.attachSession === 'function') {
        await liveWorkspace.attachSession(sessionId)
      }
      sessions[key] = { id: sessionId, title: `v03-${key}` }
    }
    const state = {
      version: STATE_VERSION,
      home: this.home,
      createdAt: new Date().toISOString(),
      workspace: { id: workspace.id, path: directory, title: 'v03 timing fixture' },
      sessions,
    }
    await writeFile(this.stateFile, JSON.stringify(state, null, 2), { mode: 0o600 })
    this.targetId = sessions.target.id
    this.senderId = sessions.sender.id
    await this.#verifyState(state)
    return state
  }

  /** @returns {Promise<Record<string, any>>} */
  async #requireState() {
    const state = await this.#loadState()
    if (state === undefined) fail('not_initialized', 'v03 fixture has not been initialized')
    this.targetId = state.sessions.target.id
    this.senderId = state.sessions.sender.id
    return state
  }

  /** @returns {Promise<Record<string, any>>} */
  async init() {
    return await this.#serializeInit(async () => {
      let state = await this.#loadState()
      if (state === undefined) state = await this.#createState()
      else await this.#verifyState(state)
      this.targetId = state.sessions.target.id
      this.senderId = state.sessions.sender.id
      return {
        fixtureInstanceId: this.instanceId,
        provider: V03_PROVIDER,
        model: V03_MODEL,
        workspace: state.workspace,
        target: state.sessions.target,
        sender: state.sessions.sender,
      }
    })
  }

  /**
   * Execute one session_link_* tool in a fixture session. This is the same
   * owner/tool path the model uses; it is not a second implementation.
   * @param {Record<string, any>} payload
   * @returns {Promise<any>}
   */
  async invoke(payload) {
    const state = await this.#requireState()
    const allowed = new Set([state.sessions.target.id, state.sessions.sender.id])
    if (!allowed.has(payload.sessionId)) fail('forbidden_session', 'session is not a v03 fixture session')
    if (typeof payload.name !== 'string' || !payload.name.startsWith('session_link_')) {
      fail('forbidden_tool', 'only session_link_* tools may be invoked')
    }
    const args = payload.args === undefined ? {} : payload.args
    if (!isPlainObject(args)) fail('invalid_argument', 'args must be a plain object')
    const argumentBytes = Buffer.byteLength(JSON.stringify(args), 'utf8')
    if (argumentBytes > 64 * 1024) fail('invalid_argument', 'args are too large')
    const timeoutMs =
      Number.isSafeInteger(payload.timeoutMs) && payload.timeoutMs >= 1000 && payload.timeoutMs <= 60_000
        ? payload.timeoutMs
        : DEFAULT_TIMEOUT_MS
    const agent = await resolveRegisteredAgent(this.ctx, payload.sessionId)
    const definition = this.ctx.tools.get(payload.name)
    if (definition === undefined || definition === null || typeof definition.execute !== 'function') {
      fail('tool_unavailable', `tool ${payload.name} is not registered`)
    }
    const value = await withTimeout(
      () =>
        definition.execute(args, {
          agent,
          signal: AbortSignal.timeout(timeoutMs),
          callId: randomUUID(),
        }),
      timeoutMs + 1000,
      `tool ${payload.name}`,
    )
    const serialized = JSON.stringify(value === undefined ? null : value)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_TOOL_RESULT_BYTES) fail('response_too_large', 'tool result exceeds the fixture bound')
    return JSON.parse(serialized)
  }

  /**
   * Start a real target turn whose scripted first step calls v03_hold.
   * @param {Record<string, any>} payload
   * @returns {Promise<Record<string, any>>}
   */
  async holdStart(payload = {}) {
    await this.#requireState()
    if (this.#activeHold(this.targetId) !== undefined) fail('hold_active', 'the v03 target already has an active hold')
    const agent = await resolveRegisteredAgent(this.ctx, this.targetId)
    if (agent.status !== 'idle') fail('agent_busy', `v03 target status is ${agent.status}, expected idle`)
    const marker = typeof payload.marker === 'string' && payload.marker.length > 0 ? payload.marker.slice(0, 200) : `v03-${randomUUID()}`
    const prompt = [
      `${HOLD_PROMPT_MARKER} ${marker}`,
      'This is a local timing fixture target. On this first step call the v03_hold tool exactly once and wait for it.',
      'After it returns, read the collaboration messages that arrived while it was held, explicitly reply to every request, then finish.',
      'Do not call v03_hold again.',
    ].join(' ')
    agent.followup(
      this.createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }),
    )
    const deadline = Date.now() + HOLD_ENTER_TIMEOUT_MS
    let entry
    while (Date.now() < deadline) {
      entry = this.#activeHold(this.targetId)
      if (entry !== undefined) break
      await sleep(25, undefined, { ref: false })
    }
    if (entry === undefined) fail('hold_not_entered', 'v03 target turn did not enter v03_hold before the deadline')
    return {
      fixtureInstanceId: this.instanceId,
      sessionId: this.targetId,
      marker,
      prompt,
      hold: holdView(entry),
      agentStatus: agent.status,
    }
  }

  /** @returns {Promise<Record<string, any>>} */
  async holdStatus() {
    const state = await this.#requireState()
    const agent = this.ctx.agents.get(state.sessions.target.id)
    const active = this.#activeHold(state.sessions.target.id)
    const latest = this.#latestHold(state.sessions.target.id)
    return {
      fixtureInstanceId: this.instanceId,
      targetSessionId: state.sessions.target.id,
      hostPid: process.pid,
      agentStatus: agent?.status ?? 'cold',
      hold: active === undefined ? (latest === undefined ? null : holdView(latest)) : holdView(active),
      activeHoldId: active?.id ?? null,
      inbox: {
        nextTurn: (agent?.inbox?.nextTurn ?? []).slice(0, MAX_INBOX_ITEMS).map((item) => inboxItemView(item, MAX_TEXT_CHARS)),
        nextStep: (agent?.inbox?.nextStep ?? []).slice(0, MAX_INBOX_ITEMS).map((item) => inboxItemView(item, MAX_TEXT_CHARS)),
        nextTurnTotal: agent?.inbox?.nextTurn?.length ?? 0,
        nextStepTotal: agent?.inbox?.nextStep?.length ?? 0,
      },
      adapterSteps: this.steps.slice(-12).map((step) => ({ ...step })),
    }
  }

  /**
   * @param {Record<string, any>} payload
   * @returns {Promise<Record<string, any>>}
   */
  async holdRelease(payload = {}) {
    await this.#requireState()
    let entry
    if (typeof payload.holdId === 'string') entry = this.holds.get(payload.holdId)
    else entry = this.#activeHold(this.targetId) ?? this.#latestHold(this.targetId)
    if (entry === undefined) fail('not_found', 'no v03 hold record exists')
    if (entry.releasedAt === null) entry.releasedAt = Date.now()
    entry.release?.()
    await withTimeout(() => entry.done, HOLD_RELEASE_TIMEOUT_MS, 'v03 hold release')
    return { hold: holdView(entry) }
  }

  /** @param {Record<string, any>} payload @returns {Promise<Record<string, any>>} */
  async idle(payload = {}) {
    const state = await this.#requireState()
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : state.sessions.target.id
    if (![state.sessions.target.id, state.sessions.sender.id].includes(sessionId)) fail('forbidden_session', 'session is not a v03 fixture session')
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined) return { live: false, idle: true, flushed: null, sessionId }
    await withTimeout(() => agent.whenIdle(), IDLE_TIMEOUT_MS, `v03 ${sessionId} idle`)
    const flushed = await this.ctx.sessions.flush(agent.session)
    return { live: true, idle: true, flushed: flushed === true, sessionId, agentStatus: agent.status }
  }

  /**
   * Queue a native user follow-up (not a session-link ledger message) so the
   * upgrade matrix can prove other sources are never moved by migration.
   * @param {Record<string, any>} payload
   * @returns {Promise<Record<string, any>>}
   */
  async nativeUser(payload = {}) {
    const state = await this.#requireState()
    const agent = await resolveRegisteredAgent(this.ctx, state.sessions.target.id)
    if (agent.status !== 'running') fail('agent_idle', 'native.user requires the target to be running (for example blocked in v03_hold)')
    const text =
      typeof payload.text === 'string' && payload.text.length > 0
        ? payload.text.slice(0, 4000)
        : `V03_NATIVE_USER ${randomUUID()} (not present in the session-link ledger)`
    const message = this.createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    agent.followup(message)
    const flushed = await this.ctx.sessions.flush(agent.session)
    if (flushed !== true) fail('flush_false', 'native user message did not flush')
    return { id: message.id, text, flushed: true, sessionId: state.sessions.target.id }
  }

  /**
   * Bounded raw session evidence with turn/step annotations.
   * @param {Record<string, any>} payload
   * @returns {Promise<Record<string, any>>}
   */
  async evidence(payload = {}) {
    const state = await this.#requireState()
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : state.sessions.target.id
    if (![state.sessions.target.id, state.sessions.sender.id].includes(sessionId)) fail('forbidden_session', 'session is not a v03 fixture session')
    const limit =
      Number.isSafeInteger(payload.limit) && payload.limit >= 1 && payload.limit <= 2000 ? payload.limit : MAX_EVIDENCE_EVENTS
    const maxTextChars =
      Number.isSafeInteger(payload.maxTextChars) && payload.maxTextChars >= 256 && payload.maxTextChars <= 8192
        ? payload.maxTextChars
        : MAX_TEXT_CHARS
    const afterSeq = Number.isSafeInteger(payload.afterSeq) ? payload.afterSeq : 0
    const snapshot = await this.ctx.sessionQuery.readSession(sessionId)
    const inherited = Number.isSafeInteger(snapshot.inheritedEventCount) ? snapshot.inheritedEventCount : 0
    const events = []
    let turn = null
    let step = null
    let truncated = false
    let total = 0
    for (const event of snapshot.events ?? []) {
      if (!Number.isSafeInteger(event?.seq) || event.seq < inherited || event.seq < afterSeq) continue
      if (event.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) turn = event.data.turn
      if (event.type === 'turn/end') turn = null
      if (event.type === 'step/start' && Number.isSafeInteger(event.data?.step)) step = event.data.step
      if (event.type === 'step/end') step = null
      if (!['user/message', 'assistant/message', 'agent/inbox/spliced', 'turn/start', 'turn/end', 'step/start', 'step/end'].includes(event.type)) continue
      total += 1
      if (events.length >= limit) {
        truncated = true
        continue
      }
      const item = {
        seq: event.seq,
        type: event.type,
        time: event.time,
        turn: event.type === 'turn/start' ? event.data?.turn ?? null : turn,
        step: event.type === 'step/start' ? event.data?.step ?? null : step,
      }
      if (event.type === 'user/message') {
        Object.assign(item, messageView(event.data, maxTextChars))
      } else if (event.type === 'assistant/message') {
        const content = event.data?.message?.content
        item.text = boundedText(textOfContent(content), maxTextChars)
        item.textBytes = Buffer.byteLength(textOfContent(content), 'utf8')
        item.textTruncated = textOfContent(content).length > maxTextChars
        item.toolCalls = (Array.isArray(content) ? content : [])
          .filter((block) => block?.type === 'tool-call')
          .slice(0, 20)
          .map((block) => ({
            name: typeof block.name === 'string' ? block.name : null,
            arguments: boundedText(typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? null), 2048),
          }))
      } else if (event.type === 'agent/inbox/spliced') {
        item.target = event.data?.target ?? null
        item.start = event.data?.start ?? null
        item.removedCount = event.data?.removedCount ?? 0
        item.outcome = event.data?.outcome ?? null
        item.inserted = Array.isArray(event.data?.inserted)
          ? event.data.inserted.slice(0, MAX_INBOX_ITEMS).map((message) => messageView(message, maxTextChars))
          : []
      } else if (event.type === 'turn/end') {
        item.reason = event.data?.reason ?? null
      }
      events.push(item)
    }
    return {
      sessionId,
      inheritedEventCount: inherited,
      totalKept: total,
      truncated,
      events,
    }
  }

  /** @returns {Promise<Record<string, any>>} */
  async serviceStatus() {
    let service
    try {
      service = this.ctx.get('sessionLink')
    } catch (error) {
      return { found: false, error: errorInfo(error) }
    }
    if (service === undefined || service === null) return { found: false }
    const ledger = service.ledger
    return {
      found: true,
      fixtureInstanceId: this.instanceId,
      hostPid: process.pid,
      version: typeof service.version === 'string' ? service.version : null,
      apiVersion: Number.isSafeInteger(service.apiVersion) ? service.apiVersion : null,
      hasAdapter: typeof service.adapter?.deliver === 'function',
      hasEngine: service.engine !== undefined && service.engine !== null,
      ledgerRoot: typeof ledger?.root === 'string' ? ledger.root : null,
      writable: ledger?.writable === true,
    }
  }

  /** @returns {Promise<Record<string, any>>} */
  async ledgerInfo() {
    const service = this.ctx.get('sessionLink')
    if (service === undefined || service === null) fail('service_unavailable', 'sessionLink service is not mounted')
    const ledger = service.ledger
    if (ledger === undefined || ledger === null) fail('state_unavailable', 'current sessionLink service has no ledger')
    const root = typeof ledger.root === 'string' ? path.resolve(ledger.root) : undefined
    if (root === undefined) fail('state_unavailable', 'ledger has no root path')
    const statePath = typeof ledger.statePath === 'string' ? ledger.statePath : path.join(root, 'ledger.json')
    const info = await stat(statePath)
    if (info.size > MAX_LEDGER_META_BYTES) {
      return { root, statePath, bytes: info.size, sha256: undefined, skipped: 'ledger larger than metadata bound' }
    }
    const bytes = await readFile(statePath)
    let state
    try {
      state = JSON.parse(bytes.toString('utf8'))
    } catch {
      fail('state_corrupt', 'ledger state is not valid JSON')
    }
    return {
      root,
      statePath,
      bytes: info.size,
      sha256: hashBytes(bytes),
      version: state?.version ?? null,
      apiVersion: state?.apiVersion ?? null,
      revision: state?.revision ?? null,
      settingsRevision: state?.settingsRevision ?? null,
      messageCount: Array.isArray(state?.messages) ? state.messages.length : null,
      chainCount: isPlainObject(state?.chains) ? Object.keys(state.chains).length : null,
      messageIds: Array.isArray(state?.messages) ? state.messages.slice(0, 200).map((message) => message?.id ?? null) : null,
    }
  }

  /**
   * Verify the Host's owner-only principal gate and exact-route matching around
   * this fixture route. The Host enforces both outside the handler; this action
   * only reports the observed statuses for a test-created non-owner Peer.
   * @returns {Promise<Record<string, any>>}
   */
  async guardOwner() {
    const connection = this.ctx.connection
    if (typeof connection?.createPeer !== 'function' || typeof connection?.createSharedFetchHandler !== 'function') {
      return { supported: false }
    }
    const guest = connection.createPeer({ principal: { kind: 'session-link-v03-guest' }, interactions: 'none' })
    try {
      const handler = connection.createSharedFetchHandler('/api')
      const request = (pathname) =>
        new Request(`http://127.0.0.1:3098${pathname}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'service.status', payload: {} }),
        })
      const guestResponse = await handler.fetch(request(V03_FIXTURE_PATH), guest)
      const wrongPathResponse = await handler.fetch(request(`${V03_FIXTURE_PATH}/extra`), guest)
      return {
        supported: true,
        guestStatus: guestResponse.status,
        guestBody: boundedText(await guestResponse.text(), 500),
        wrongPathStatus: wrongPathResponse.status,
        wrongPathBody: boundedText(await wrongPathResponse.text(), 500),
      }
    } finally {
      await guest.dispose?.()
    }
  }

  /** @param {string} action @param {Record<string, any>} payload @returns {Promise<any>} */
  async run(action, payload) {
    if (action === 'init') return await this.init()
    if (action === 'invoke') return await this.invoke(payload)
    if (action === 'hold.start') return await withTimeout(() => this.holdStart(payload), HOLD_ENTER_TIMEOUT_MS + 5000, 'v03 hold.start')
    if (action === 'hold.status') return await this.holdStatus()
    if (action === 'hold.release') return await this.holdRelease(payload)
    if (action === 'idle') return await this.idle(payload)
    if (action === 'evidence') return await this.evidence(payload)
    if (action === 'native.user') return await this.nativeUser(payload)
    if (action === 'service.status') return await this.serviceStatus()
    if (action === 'ledger.info') return await this.ledgerInfo()
    if (action === 'guard.owner') return await this.guardOwner()
    fail('unknown_action', `unknown v03 fixture action ${action}`)
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
    if (typeof body.action !== 'string' || !V03_ACTIONS.includes(body.action)) {
      return response({ ok: false, error: { code: 'unknown_action', message: 'unknown v03 fixture action' } }, 400)
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
    for (const entry of this.holds.values()) {
      if (entry.releasedAt === null) entry.releasedAt = Date.now()
      entry.release?.()
      entry.doneResolve?.()
    }
    this.holds.clear()
    this.holdOrder = []
    try {
      if (typeof this.holdToolDispose === 'function') this.holdToolDispose()
    } finally {
      if (typeof this.adapterDispose === 'function') this.adapterDispose()
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

/** @template T @param {ReadonlyArray<T>} items @param {(item: T) => boolean} predicate @returns {number} */
function findLastIndex(items, predicate) {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index])) return index
  }
  return -1
}

/** @param {string} name @param {Record<string, any>} args @param {string} id @returns {AsyncIterable<any>} */
async function* toolResponse(name, args, id) {
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: JSON.stringify(args) }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

/** @param {string} text @returns {AsyncIterable<any>} */
async function* textResponse(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/**
 * Install the test-only route. The Host's Connection fetch registration applies
 * its exact route matching, Host/Origin fence, and owner-only principal gate
 * before this handler runs. No cookie or token is read here.
 *
 * @param {Record<string, any>} ctx
 * @param {{ home: string, createUserMessage: (input: Record<string, any>) => Record<string, any>, LlmAdapter: new (...args: any[]) => any }} options
 * @returns {Promise<{ path: string, actions: readonly string[], dispose: () => Promise<void> }>}
 */
export async function installV03Fixture(ctx, options = {}) {
  const home = requireTestHome(options.home)
  const fixture = new V03Fixture(ctx, home, options.createUserMessage, options.LlmAdapter)
  await fixture.start()
  const disposeRoute = await ctx.connection.fetch.register({
    path: V03_FIXTURE_PATH,
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
    path: V03_FIXTURE_PATH,
    actions: V03_ACTIONS,
    async dispose() {
      try {
        if (typeof disposeRoute === 'function') await disposeRoute()
      } finally {
        await fixture.dispose()
      }
    },
  }
}
