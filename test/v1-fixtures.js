/**
 * Synthetic v0.1 fixtures generated through a SHA256-frozen copy of the
 * accepted v0.1.0 Ledger/Engine, then validated again with that same original
 * loader
 * before a v0.2 test opens the directory. The tracked test/fixtures/v1-runtime
 * copy makes a clean git archive self-contained; artifacts/v01-runtime (if
 * present) remains the untouched reference. No fixture is hand written JSON
 * except the deliberately corrupt cases.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const TRACKED_ROOT = new URL('./fixtures/v1-runtime/', import.meta.url)
const TRACKED_LEDGER = new URL('src/core/ledger.js', TRACKED_ROOT)
const V1_NOW = 1_800_000_000_000

// Frozen files copied from artifacts/dsh-session-link-0.1.0.tgz. If any of
// these test fixtures drift, migration fixtures must fail rather than change
// what "v0.1 accepted" means.
const V1_ARTIFACT_HASHES = Object.freeze({
  'src/core/ledger.js': '03897c89cbcd25832fdf4d5fcf16ebda6be6c8d873af4d1a97d1791801e490fa',
  'src/core/constants.js': 'dbe1f18605ad1351fe306448b343bda70b08734c0bd5da2a56c769b5b3da18ad',
  'src/core/settings.js': '8a23ae6e31697b076440802f5c6367d6abe4f4f7953269d06dc9835a3d44c284',
  'src/core/validation.js': 'd0e3de1130064dc3c27f55a4ac05528b2aa7b0e32b73f1f200abb5010114e2c3',
  'src/core/errors.js': '8e9fd45e0444c47876dde69b9634ac0fd7bb4f3706d38462b8232bfb565a51cf',
  'src/core/budget.js': '8aecbb131888daf0da706c52cb0c74e8db0fb27d6a58058be2a27ce59771e9a2',
  'src/core/engine.js': 'ee68f046c88fb33ab7b229b77f9d5a38bd58a7ab9d4f567865358ddc9e0bbe21',
  'src/core/render.js': '2b33501fae2e2c724b8a0fc1cfdb059b8de7a972e8f3cea02a4d039a432de263',
})

function hash(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

let ledgerClass
let engineClass

async function originalLedgerClass() {
  if (ledgerClass !== undefined) return ledgerClass
  let module
  try {
    module = await import(TRACKED_LEDGER.href)
  } catch (error) {
    throw new Error(
      'v0.2 migration tests require test/fixtures/v1-runtime/src/core/ledger.js and its frozen v0.1 companions',
      { cause: error },
    )
  }
  for (const [relative, expected] of Object.entries(V1_ARTIFACT_HASHES)) {
    const actual = hash(await fs.readFile(new URL(relative, TRACKED_ROOT)))
    if (actual !== expected) {
      throw new Error(`frozen v0.1 test fixture changed: ${relative} (${actual})`)
    }
  }
  ledgerClass = module.Ledger
  return ledgerClass
}

async function originalEngineClass() {
  if (engineClass !== undefined) return engineClass
  await originalLedgerClass()
  const module = await import(new URL('src/core/engine.js', TRACKED_ROOT).href)
  if (typeof module.SessionLinkEngine !== 'function') {
    throw new Error('frozen v0.1 engine did not export SessionLinkEngine')
  }
  engineClass = module.SessionLinkEngine
  return engineClass
}

/** @returns {Record<string, any>} */
export function v1Settings(overrides = {}) {
  return {
    enabled: true,
    emergencyPaused: false,
    autoCollaborate: true,
    maxMessages: 20,
    maxHops: 8,
    maxConcurrent: 2,
    maxTextChars: 12000,
    requestTimeoutMs: 30 * 60 * 1000,
    retentionDays: 30,
    ...overrides,
  }
}

/** @param {string} id @param {Record<string, any>} [overrides] */
export function v1Chain(id, overrides = {}) {
  return {
    id,
    rootOwner: 'A',
    createdAt: V1_NOW - 10_000,
    state: 'open',
    maxMessages: 20,
    maxHops: 8,
    messageCount: 0,
    ...overrides,
  }
}

/** @param {string} id @param {Record<string, any>} [overrides] */
export function v1Message(id, overrides = {}) {
  const text = overrides.content?.text ?? id
  return {
    id,
    from: 'A',
    to: 'B',
    kind: 'notification',
    chainId: 'chain-open',
    hop: 0,
    createdAt: V1_NOW - 1000,
    acceptedAt: null,
    deadlineAt: null,
    timedOutAt: null,
    lateReplyAt: null,
    content: { text, references: [], paths: [] },
    contentBytes: Buffer.byteLength(text, 'utf8'),
    status: 'accepted',
    replyStatus: 'none',
    deliveryAttempts: 1,
    durableMessageId: `host-${id}`,
    error: null,
    ...overrides,
  }
}

/**
 * Full legacy branch: quota pauses, owner/unknown pauses, closed chain,
 * accepted/request/reply/dispatching/unknown/failed/cancelled/held/overflow,
 * latches, budget counters and operations. The original v1 loader validates it.
 * @param {{ settings?: Record<string, any> }} [options]
 */
export function legacyV1State(options = {}) {
  const settings = v1Settings(options.settings)
  const chains = {
    'chain-open': v1Chain('chain-open', { messageCount: 12 }),
    'chain-hop': v1Chain('chain-hop', { state: 'paused', pausedReason: 'hop_exceeded', pausedAt: V1_NOW - 500, messageCount: 1 }),
    'chain-budget': v1Chain('chain-budget', { state: 'paused', pausedReason: 'chain_budget', pausedAt: V1_NOW - 500, messageCount: 1 }),
    'chain-latch': v1Chain('chain-latch', { state: 'paused', pausedReason: 'budget_latched', pausedAt: V1_NOW - 500, messageCount: 1 }),
    'chain-owner': v1Chain('chain-owner', { state: 'paused', pausedReason: 'owner', pausedAt: V1_NOW - 500, messageCount: 2 }),
    'chain-root-owner': v1Chain('chain-root-owner', { state: 'paused', pausedReason: 'root_owner', pausedAt: V1_NOW - 500, messageCount: 0 }),
    'chain-unknown-reason': v1Chain('chain-unknown-reason', { state: 'paused', pausedReason: 'legacy_custom', pausedAt: V1_NOW - 500, messageCount: 0 }),
    'chain-closed': v1Chain('chain-closed', { state: 'closed', closedAt: V1_NOW - 500, messageCount: 1 }),
  }
  const request = v1Message('m-request', {
    kind: 'request',
    status: 'accepted',
    acceptedAt: V1_NOW - 900,
    replyStatus: 'waiting',
    deadlineAt: V1_NOW + 60_000,
    operationId: 'slop:1800000000:123e4567-e89b-42d3-a456-426614174000',
  })
  const reply = v1Message('m-reply', {
    from: 'B',
    to: 'A',
    kind: 'reply',
    hop: 1,
    status: 'accepted',
    acceptedAt: V1_NOW - 800,
    parentMessageId: 'm-request',
    replyTo: 'm-request',
    operationId: 'slop:1800000001:123e4567-e89b-42d3-a456-426614174001',
  })
  request.replyStatus = 'answered'
  request.answeredAt = V1_NOW - 800
  request.answeredBy = 'm-reply'
  const messages = [
    v1Message('m-notification', { operationId: 'slop:1800000000:123e4567-e89b-42d3-a456-426614174002' }),
    request,
    reply,
    v1Message('m-dispatching', { status: 'dispatching', durableMessageId: 'host-dispatching' }),
    v1Message('m-unknown', { status: 'unknown', durableMessageId: 'host-unknown', error: { code: 'flush_failed', message: 'unknown' } }),
    v1Message('m-failed', { status: 'failed', failedAt: V1_NOW - 400, error: { code: 'target_unavailable', message: 'failed' } }),
    v1Message('m-cancelled', { status: 'cancelled', cancelledAt: V1_NOW - 300, error: { code: 'cancelled', message: 'cancelled' } }),
    v1Message('m-held-auto', {
      status: 'held',
      heldAt: V1_NOW - 200,
      heldReason: 'auto_collaborate_off',
      error: { code: 'auto_collaborate_off', message: 'held' },
    }),
    v1Message('m-held-unknown', {
      status: 'held',
      heldAt: V1_NOW - 200,
      heldReason: 'legacy_mystery',
      error: { code: 'legacy_mystery', message: 'held' },
    }),
    v1Message('m-held-disabled', {
      status: 'held',
      heldAt: V1_NOW - 200,
      heldReason: 'disabled',
      error: { code: 'disabled', message: 'held' },
    }),
    v1Message('m-held-emergency', {
      status: 'held',
      heldAt: V1_NOW - 200,
      heldReason: 'emergency_paused',
      error: { code: 'emergency_paused', message: 'held' },
    }),
    v1Message('m-held-overflow', {
      status: 'held',
      heldAt: V1_NOW - 200,
      heldReason: 'held_full',
      heldOverflow: true,
      error: { code: 'held_full', message: 'overflow' },
    }),
    v1Message('m-owner-held', {
      chainId: 'chain-owner',
      status: 'held',
      heldAt: V1_NOW - 200,
      heldReason: 'emergency_paused',
      error: { code: 'emergency_paused', message: 'held' },
    }),
    v1Message('m-quota-hop', { chainId: 'chain-hop' }),
    v1Message('m-quota-budget', { chainId: 'chain-budget' }),
    v1Message('m-quota-latch', { chainId: 'chain-latch' }),
    v1Message('m-closed', { chainId: 'chain-closed' }),
  ]
  const operations = {
    'A|slop:1800000000:123e4567-e89b-42d3-a456-426614174000|B': {
      key: 'A|slop:1800000000:123e4567-e89b-42d3-a456-426614174000|B',
      from: 'A',
      operationId: 'slop:1800000000:123e4567-e89b-42d3-a456-426614174000',
      fingerprint: 'fingerprint-request',
      targets: ['B'],
      messageIds: { B: 'm-request' },
      at: V1_NOW - 900,
    },
    'A|slop:1800000000:123e4567-e89b-42d3-a456-426614174002|B': {
      key: 'A|slop:1800000000:123e4567-e89b-42d3-a456-426614174002|B',
      from: 'A',
      operationId: 'slop:1800000000:123e4567-e89b-42d3-a456-426614174002',
      fingerprint: 'fingerprint-notification',
      targets: ['B'],
      messageIds: { B: 'm-notification' },
      at: V1_NOW - 1000,
    },
  }
  return {
    version: 1,
    revision: 7,
    createdAt: V1_NOW - 20_000,
    updatedAt: V1_NOW - 100,
    settings,
    messages,
    chains,
    operations,
    latches: [
      { id: 'latch:pair:A|B:1', scope: 'pair:A|B', reason: 'pair', createdAt: V1_NOW - 600 },
      { id: 'latch:global:1', scope: 'global', reason: 'deliveries', createdAt: V1_NOW - 600 },
      { id: 'latch:session:A:1', scope: 'session:A', reason: 'session', createdAt: V1_NOW - 600, releasedAt: V1_NOW - 500 },
    ],
    budget: {
      events: [
        { at: V1_NOW - 1000, from: 'A', to: 'B' },
        { at: V1_NOW - 900, from: 'A', to: 'B' },
      ],
      lastSubmitAt: { A: V1_NOW - 900 },
      daily: { '2026-11-01': 7 },
    },
  }
}

/**
 * Write a v1 ledger through its own Ledger and re-open it with the original
 * v1 loader. Returns the exact pre-migration bytes.
 * @param {string} root
 * @param {Record<string, any>} state
 * @param {{ now?: number }} [options]
 * @returns {Promise<Buffer>}
 */
export async function writeV1Fixture(root, state, options = {}) {
  const now = options.now ?? V1_NOW
  const OriginalLedger = await originalLedgerClass()
  const ledger = new OriginalLedger({ root, clock: () => now })
  await ledger.open()
  await ledger.mutate((draft) => {
    for (const key of Object.keys(draft)) delete draft[key]
    Object.assign(draft, structuredClone(state))
  })
  await ledger.close()
  const checker = new OriginalLedger({ root, clock: () => now })
  await checker.open()
  await checker.close()
  return fs.readFile(`${root}/ledger.json`)
}

/** @param {number} count @param {{ createdAt?: number }} [options] */
export function largeV1State(count, options = {}) {
  const createdAt = options.createdAt ?? V1_NOW - 1000
  const messages = Array.from({ length: count }, (_, index) =>
    v1Message(`large-${index}`, {
      chainId: 'large-chain',
      createdAt,
      acceptedAt: createdAt,
      content: { text: `m${index}`, references: [], paths: [] },
      contentBytes: Buffer.byteLength(`m${index}`, 'utf8'),
      durableMessageId: `host-large-${index}`,
    }),
  )
  return {
    version: 1,
    revision: 2,
    createdAt,
    updatedAt: V1_NOW - 100,
    settings: v1Settings(),
    messages,
    chains: { 'large-chain': v1Chain('large-chain', { createdAt, messageCount: count }) },
    operations: {},
    latches: [],
    budget: { events: [], lastSubmitAt: {}, daily: { '2026-11-01': 0 } },
  }
}

/**
 * Create one real held row through the frozen v0.1 Engine.send. In v0.1,
 * emergencyPaused/autoCollaborate=false creates held with only error.code and
 * no heldReason; this helper must not hand-fill the field it is testing.
 * @param {{
 *   root: string,
 *   emergencyPaused?: boolean,
 *   autoCollaborate?: boolean,
 *   heldReason?: string,
 *   text?: string,
 * }} options
 * @returns {Promise<{ root: string, raw: Buffer, state: Record<string, any>, result: Record<string, any>, message: Record<string, any> }>}
 */
export async function v1EngineHeldFixture(options) {
  const root = options?.root
  if (typeof root !== 'string' || root.length === 0) throw new Error('v1EngineHeldFixture requires a root')
  const OriginalLedger = await originalLedgerClass()
  const OriginalEngine = await originalEngineClass()
  const ledger = new OriginalLedger({ root, clock: () => V1_NOW })
  await ledger.open()
  await ledger.mutate((state) => {
    state.settings.emergencyPaused = options.emergencyPaused === true
    state.settings.autoCollaborate = options.autoCollaborate !== false
  })
  const adapter = {
    async getSession(id) {
      return {
        id,
        title: id,
        archived: false,
        subagent: false,
        registered: true,
        eligible: true,
        live: true,
        formatStatus: 'current',
      }
    },
  }
  let seq = 0
  const engine = new OriginalEngine({
    ledger,
    adapter,
    clock: () => V1_NOW,
    uuid: () => `v1-engine-${++seq}`,
  })
  const result = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: options.text ?? `v1 engine held ${options.emergencyPaused === true ? 'emergency' : 'auto'}`,
    operationId: 'slop:1800000000000:123e4567-e89b-42d3-a456-426614174000',
  })
  if (result.results?.[0]?.status !== 'held') {
    throw new Error(`frozen v0.1 Engine.send did not create a held row: ${JSON.stringify(result)}`)
  }
  if (options.heldReason !== undefined) {
    await ledger.mutate((state) => {
      state.messages[0].heldReason = options.heldReason
    })
  }
  const state = ledger.read()
  const message = state.messages[0]
  if (options.heldReason === undefined && Object.prototype.hasOwnProperty.call(message, 'heldReason')) {
    throw new Error('frozen v0.1 Engine.send unexpectedly wrote heldReason')
  }
  await ledger.close()
  const checker = await openOriginalV1(root)
  await checker.close()
  const raw = await fs.readFile(path.join(root, 'ledger.json'))
  return { root, raw, state, result, message }
}

export const V1_FIXTURE_NOW = V1_NOW

/** @param {string} root @param {number} [now] */
export async function openOriginalV1(root, now = V1_NOW) {
  const OriginalLedger = await originalLedgerClass()
  const ledger = new OriginalLedger({ root, clock: () => now })
  await ledger.open()
  return ledger
}
