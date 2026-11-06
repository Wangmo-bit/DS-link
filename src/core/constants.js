/**
 * Shared vocabulary and technical formats for dsh-session-link 0.3.
 *
 * The values in LIMITS are protocol/format protections and storage envelopes,
 * never per-day or per-peer business quotas. Owner-editable daily settings are
 * limited to DEFAULT_SETTINGS.
 */

export const PLUGIN_NAME = 'session-link'
export const PLUGIN_VERSION = '0.6.0'
export const API_VERSION = 3
export const SOURCE_KIND = 'agent-message'
export const SOURCE_FORM = 'relay'

export const STATE_VERSION = 3
export const V1_STATE_VERSION = 1
export const LEDGER_FILE = 'ledger.json'
export const LOCK_FILE = 'writer.lock'
export const LOCK_DB_FILE = 'writer.sqlite'
export const V1_BACKUP_PREFIX = 'ledger.v1-backup.'
/** Exact pre-upgrade v2 bytes kept before the v2 -> v3 schema conversion. */
export const V2_BACKUP_PREFIX = 'ledger.v2-backup.'
/** Exact current v3 bytes kept before an offline v3 -> v2 restore. */
export const V3_ROLLBACK_BACKUP_PREFIX = 'ledger.v3-before-rollback.'
export const V2_ROLLBACK_BACKUP_PREFIX = 'ledger.v2-before-rollback.'

export const TOOL_NAMES = Object.freeze({
  operation: 'session_link_operation',
  list: 'session_link_list',
  history: 'session_link_history',
  send: 'session_link_send',
  reply: 'session_link_reply',
  status: 'session_link_status',
  control: 'session_link_control',
  create: 'session_link_create',
})

/** Durable settings presented by the settings page (exactly five keys). */
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  paused: false,
  maxConcurrent: 3,
  requestTimeoutMs: 30 * 60 * 1000,
  retentionDays: 30,
})

export const SETTINGS_KEYS = Object.freeze(Object.keys(DEFAULT_SETTINGS))

/** v1 keys that must be rejected as a whole rather than silently ignored. */
export const LEGACY_SETTINGS_KEYS = Object.freeze([
  'autoCollaborate',
  'maxMessages',
  'maxHops',
  'maxTextChars',
  'emergencyPaused',
])

export const SETTINGS_BOUNDS = Object.freeze({
  maxConcurrent: { min: 1, max: 10 },
})

/**
 * Technical format limits and storage envelopes. There is deliberately no
 * message-count, chain, pair, window, daily, or per-source quota here.
 */
export const LIMITS = Object.freeze({
  MAX_REFERENCES: 5,
  MAX_REFERENCE_CHARS: 2000,
  MAX_REFERENCE_SESSION_ID_CHARS: 256,
  MAX_PATHS: 10,
  MAX_PATH_CHARS: 1024,
  /** One message content payload (text + references + paths). */
  MAX_CONTENT_BYTES: 64 * 1024,
  /** One send/reply call as received from the model tool arguments. */
  MAX_CALL_BYTES: 1024 * 1024,
  /** Deterministic display excerpt when a sender omitted the subject. */
  SUBJECT_EXCERPT_CHARS: 120,
  /** Deterministic session-title excerpt derived from the task text. */
  TITLE_EXCERPT_CHARS: 60,
  /** One owner card_lookup batch; a technical page bound, not a quota. */
  MAX_CARD_LOOKUP_IDS: 100,
  /** New-inbound active JSON ledger envelope. */
  MAX_LEDGER_BYTES: 50 * 1024 * 1024,
  /** New-inbound undelivered payload envelope (pending + held + dispatching). */
  MAX_QUEUED_BYTES: 16 * 1024 * 1024,
  MAX_PAGE: 50,
  MAX_SNAPSHOT_PAGE: 100,
  HISTORY_MAX_MESSAGES: 20,
  HISTORY_MAX_CHARS: 16000,
  HISTORY_SNIPPET_CHARS: 500,
  /** Fixed metadata tombstone horizon; body retention is owner-editable. */
  MESSAGE_RETENTION_MS: 90 * 24 * 60 * 60 * 1000,
  OPERATION_RETENTION_MS: 90 * 24 * 60 * 60 * 1000,
  /** operationId timestamp acceptance window. */
  OPERATION_PAST_MS: 24 * 60 * 60 * 1000,
  OPERATION_FUTURE_MS: 5 * 60 * 1000,
  /** Largest instant representable by a JavaScript Date. */
  MAX_DATE_MS: 8_640_000_000_000_000,
  /** Forced dispose waits at most this long before refusing the handoff. */
  DISPOSE_DRAIN_MS: 5000,
  /** Bound one tick's read-only receipt catch-up retries and transfer pass. */
  RECEIPT_RETRY_TARGETS: 16,
  TRANSFER_TARGETS_PER_PASS: 16,
  /** A prepared journal that keeps failing its synchronous move becomes uncertain. */
  TRANSFER_MAX_ATTEMPTS: 3,
})

export const DISPATCH_STATUSES = Object.freeze([
  'held',
  'pending',
  'dispatching',
  'accepted',
  'failed',
  'unknown',
  'cancelled',
])

export const REPLY_STATUSES = Object.freeze([
  'none',
  'waiting',
  'answered',
  'timed_out',
])

export const MESSAGE_KINDS = Object.freeze(['notification', 'request', 'reply'])

/**
 * Durable phases of one create journal. `creating` means an external effect
 * may be in flight; `uncertain` is only set when its result cannot be proven.
 * Terminal phases are eligible for the 90-day operation retention window.
 */
export const CREATE_PHASES = Object.freeze([
  'creating',
  'created',
  'attach_failed',
  'renamed',
  'rename_failed',
  'sending',
  'sent',
  'uncertain',
  'failed',
])

/** Phases a completed create operation may never leave again. */
export const CREATE_TERMINAL_PHASES = Object.freeze(['sent', 'attach_failed', 'failed'])

/** Rename attempts are one-shot: a failure is reported, never auto-repeated. */
export const CREATE_RENAME_STATUSES = Object.freeze(['not_attempted', 'pending', 'renamed', 'rename_failed'])

export const CHAIN_STATES = Object.freeze(['open', 'paused', 'closed'])

export const SNAPSHOT_FILTERS = Object.freeze([
  'all',
  'received',
  'sent',
  'pending_reply',
  'abnormal',
  'unknown',
  'held',
  'chain',
])

export const CONTROL_ACTIONS = Object.freeze([
  'cancel',
  'pause',
  'resume',
  'close',
  'release',
  'recheck',
  'resolve_unknown',
  'resume_budget',
])

/** Held reasons that are automatic consequences of broad settings. */
export const AUTO_HELD_REASONS = Object.freeze([
  'paused',
  'disabled',
  'emergency_paused',
  'auto_collaborate_off',
  'held_full',
])

/** Chain pause reasons retired by the v1 -> v2 migration. */
export const RETIRED_CHAIN_PAUSE_REASONS = Object.freeze([
  'hop_exceeded',
  'chain_budget',
  'budget_latched',
])
