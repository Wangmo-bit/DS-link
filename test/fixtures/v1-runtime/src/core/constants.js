/**
 * Shared bounds and durable vocabulary for dsh-session-link.
 *
 * Every value here is either a frozen protocol limit or a default that the
 * owner may lower through the authenticated settings API. Hard caps are never
 * raised by settings: a deployment cannot opt into an unbounded chain.
 */

export const PLUGIN_NAME = 'session-link'
export const SOURCE_KIND = 'agent-message'
export const SOURCE_FORM = 'relay'

export const STATE_VERSION = 1
export const LEDGER_FILE = 'ledger.json'
export const LOCK_FILE = 'writer.lock'
export const LOCK_DB_FILE = 'writer.sqlite'

export const TOOL_NAMES = Object.freeze({
  operation: 'session_link_operation',
  list: 'session_link_list',
  history: 'session_link_history',
  send: 'session_link_send',
  reply: 'session_link_reply',
  status: 'session_link_status',
  control: 'session_link_control',
})

/** Durable settings defaults presented by the settings page. */
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  emergencyPaused: false,
  autoCollaborate: true,
  maxMessages: 20,
  maxHops: 8,
  maxConcurrent: 2,
  maxTextChars: 12000,
  requestTimeoutMs: 30 * 60 * 1000,
  retentionDays: 30,
})

/** Inclusive bounds for every owner-editable setting. */
export const SETTINGS_BOUNDS = Object.freeze({
  maxMessages: { min: 2, max: 20 },
  maxHops: { min: 1, max: 8 },
  maxConcurrent: { min: 1, max: 2 },
  maxTextChars: { min: 1000, max: 12000 },
  requestTimeoutMs: { min: 60_000, max: 86_400_000 },
  retentionDays: { min: 1, max: 90 },
})

export const SETTINGS_KEYS = Object.freeze(Object.keys(DEFAULT_SETTINGS))

export const LIMITS = Object.freeze({
  /** Text is bounded in Unicode code points and in UTF-8 bytes. */
  MAX_TEXT_CHARS: 12000,
  MAX_TEXT_BYTES: 48000,
  MAX_REFERENCES: 5,
  MAX_REFERENCE_CHARS: 2000,
  MAX_REFERENCE_SESSION_ID_CHARS: 256,
  MAX_PATHS: 10,
  MAX_PATH_CHARS: 1024,
  /** Whole serialized content payload (text + references + paths). */
  MAX_CONTENT_BYTES: 64 * 1024,
  MAX_TARGETS: 5,
  MAX_PAGE: 50,
  MAX_SNAPSHOT_PAGE: 100,
  HISTORY_MAX_MESSAGES: 20,
  HISTORY_MAX_CHARS: 16000,
  HISTORY_SNIPPET_CHARS: 500,
  /** Chain budgets frozen at chain creation. */
  CHAIN_MAX_MESSAGES: 20,
  CHAIN_MAX_HOPS: 8,
  /** Rolling window (10 minutes). */
  WINDOW_MS: 10 * 60 * 1000,
  WINDOW_SESSION_MESSAGES: 30,
  WINDOW_PAIR_MESSAGES: 12,
  WINDOW_GLOBAL_MESSAGES: 100,
  WINDOW_HOST_DELIVERIES: 40,
  /** Local day boundary is Asia/Shanghai midnight (UTC+08:00). */
  DAILY_MESSAGES: 300,
  DAILY_OFFSET_MS: 8 * 60 * 60 * 1000,
  MIN_SUBMIT_INTERVAL_MS: 1000,
  /** Held queue is bounded per source so closing auto mode cannot fill disk. */
  HELD_PER_SOURCE: 20,
  HELD_TOTAL_BYTES: 256 * 1024,
  /** Ledger safety envelope. */
  MAX_MESSAGES: 10_000,
  MAX_DISK_BYTES: 50 * 1024 * 1024,
  /** Retention horizons. */
  OPERATION_RETENTION_MS: 90 * 24 * 60 * 60 * 1000,
  MESSAGE_RETENTION_MS: 90 * 24 * 60 * 60 * 1000,
  /** operationId timestamp acceptance window. */
  OPERATION_PAST_MS: 24 * 60 * 60 * 1000,
  OPERATION_FUTURE_MS: 5 * 60 * 1000,
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
