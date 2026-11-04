/**
 * Model-facing tools. Identity always comes from exec.agent; no tool accepts
 * `from`, source, hop, budget, or settings parameters. Arguments are strict
 * objects and unknown keys reject before the engine runs.
 */

import { LIMITS, TOOL_NAMES } from '../core/constants.js'
import { fail, errorCode } from '../core/errors.js'
import { assertAllowedKeys, assertPlainObject } from '../core/validation.js'

const OUTPUT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: true })

const SUBJECT_HINT =
  'The optional one-line subject should be filled by the sender whenever it adds meaning; no extra model call is needed and it stays optional. When it is omitted, a readable short excerpt of the body is used instead, and the subject shares the existing byte limits (no new quota).'

/**
 * @param {{ ctx: Record<string, any>, engine: Record<string, any>, adapter: Record<string, any> }} options
 * @returns {Array<Record<string, any>>}
 */
export function createToolDefinitions(options) {
  const { ctx, engine, adapter } = options

  /** @param {Record<string, any>} exec */
  const requireCaller = async (exec) => {
    const agent = exec?.agent
    if (agent === undefined || agent === null || typeof agent.id !== 'string' || agent.id.length === 0) {
      throw fail('identity_required', 'session-link tools require exec.agent; identity cannot be passed as an argument')
    }
    let registered
    try {
      registered = ctx.agents.get(agent.id)
    } catch (error) {
      throw fail('identity_unavailable', `agent registry is unavailable: ${errorCode(error)}`)
    }
    if (registered !== agent) {
      throw fail('identity_mismatch', 'exec.agent is not the registered instance for this session')
    }
    const info = await adapter.getSession(agent.id, { fresh: true })
    if (info === undefined || info === null || info.registered !== true) {
      throw fail('identity_unregistered', 'caller is not a registered ordinary session')
    }
    if (info.subagent === true) throw fail('identity_subagent', 'subagent sessions cannot use session-link tools')
    if (info.archived === true) throw fail('identity_archived', 'archived sessions cannot use session-link tools')
    if (info.formatStatus === 'migration-required') {
      throw fail('identity_migration_required', 'caller session requires migration')
    }
    if (info.eligible !== true) throw fail('identity_unavailable', 'caller is not an eligible ordinary session')
    return { id: agent.id, title: info.title }
  }

  const operationTool = {
    name: TOOL_NAMES.operation,
    description:
      'Mint a unique session-link operationId. Call this before session_link_send, session_link_reply, or session_link_create and reuse the returned id for the exact same call; reusing an operationId with different content, targets, or parent is rejected.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderValue(value) },
    async execute(args, exec) {
      requireEmptyArgs(args)
      await requireCaller(exec)
      return engine.mintOperation()
    },
  }

  const listTool = {
    name: TOOL_NAMES.list,
    description:
      'List ordinary, non-archived sessions registered in this Harness, or with scope=workspaces the registered workspaces (including empty ones) as {id,title,path}. Filter by workspace, title, or a literal keyword. Returns bounded pages with unique ids and nextCursor; workspace pages follow registry order only within one snapshot, so re-check by id after paging. Subagent sessions are never listed.',
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string' },
        title: { type: 'string' },
        query: { type: 'string' },
        cursor: { type: 'string' },
        limit: { type: 'integer' },
        scope: { type: 'string', enum: ['sessions', 'workspaces'] },
      },
      required: [],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderValue(value) },
    async execute(args, exec) {
      const object = assertObject(args)
      assertAllowedKeys(
        object,
        ['workspace', 'title', 'query', 'cursor', 'limit', 'scope'],
        'session_link_list arguments',
      )
      await requireCaller(exec)
      return engine.list(object)
    },
  }

  const historyTool = {
    name: TOOL_NAMES.history,
    description:
      'Read a bounded, read-only slice of another ordinary session history, including archived sessions. Recent mode returns the latest messages with seq provenance; search mode finds a literal keyword and returns cited seq snippets. Never returns a complete log.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        mode: { type: 'string', enum: ['recent', 'search'] },
        query: { type: 'string' },
        limit: { type: 'integer' },
        beforeSeq: { type: 'integer' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderValue(value) },
    async execute(args, exec) {
      const object = assertObject(args)
      assertAllowedKeys(object, ['sessionId', 'mode', 'query', 'limit', 'beforeSeq'], 'session_link_history arguments')
      await requireCaller(exec)
      return engine.history(object)
    },
  }

  const sendTool = {
    name: TOOL_NAMES.send,
    description:
      'Send a notification or collaboration request to one or more ordinary sessions. Use session_link_operation first and pass its operationId. Targets are session ids. There is no per-call target-count quota; the whole call is bounded by the technical 1 MiB envelope. This does not authorize sensitive work for the recipient, and request messages must be answered explicitly with session_link_reply. ' +
      SUBJECT_HINT,
    parameters: {
      type: 'object',
      properties: {
        targets: { type: 'array', items: { type: 'string' } },
        kind: { type: 'string', enum: ['notification', 'request'] },
        text: { type: 'string' },
        operationId: { type: 'string' },
        parentMessageId: { type: 'string' },
        references: { type: 'array', items: { type: 'object', additionalProperties: true } },
        paths: { type: 'array', items: { type: 'string' } },
        subject: { type: 'string' },
      },
      required: ['targets', 'kind', 'text', 'operationId'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderValue(value) },
    async execute(args, exec) {
      const object = assertObject(args)
      assertAllowedKeys(
        object,
        ['targets', 'kind', 'text', 'operationId', 'parentMessageId', 'references', 'paths', 'subject'],
        'session_link_send arguments',
      )
      const caller = await requireCaller(exec)
      return engine.send({
        ...object,
        from: caller.id,
        fromTitle: caller.title,
      })
    },
  }

  const replyTool = {
    name: TOOL_NAMES.reply,
    description:
      'Explicitly reply to a request received through session-link. Only the original recipient may reply, the target is forced to the original sender, and the reply is linked by messageId. Use session_link_operation first and pass its operationId. ' +
      SUBJECT_HINT,
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: 'string' },
        text: { type: 'string' },
        operationId: { type: 'string' },
        references: { type: 'array', items: { type: 'object', additionalProperties: true } },
        paths: { type: 'array', items: { type: 'string' } },
        subject: { type: 'string' },
      },
      required: ['messageId', 'text', 'operationId'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderValue(value) },
    async execute(args, exec) {
      const object = assertObject(args)
      assertAllowedKeys(object, ['messageId', 'text', 'operationId', 'references', 'paths', 'subject'], 'session_link_reply arguments')
      const caller = await requireCaller(exec)
      return engine.reply({
        ...object,
        from: caller.id,
        fromTitle: caller.title,
      })
    },
  }

  const statusTool = {
    name: TOOL_NAMES.status,
    description:
      'Read bounded delivery and reply state for messages involving this session. Pass messageId or chainId to narrow it. No answer means waiting, not success. Use this instead of treating a recipient\'s last assistant message as a reply.',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: 'string' },
        chainId: { type: 'string' },
      },
      required: [],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderValue(value) },
    async execute(args, exec) {
      const object = assertObject(args)
      assertAllowedKeys(object, ['messageId', 'chainId'], 'session_link_status arguments')
      const caller = await requireCaller(exec)
      return engine.status({ ...object, from: caller.id })
    },
  }

  const controlTool = {
    name: TOOL_NAMES.control,
    description:
      'Control a chain you own: pause, close, or cancel your own pending/held messages. Only the root owner may pause or close; a model cannot resume, change global settings, or resolve unknown records. Closing cancels undelivered pending/held messages but cannot withdraw an in-flight delivery.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['pause', 'cancel', 'close'] },
        id: { type: 'string' },
      },
      required: ['action', 'id'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderValue(value) },
    async execute(args, exec) {
      const object = assertObject(args)
      assertAllowedKeys(object, ['action', 'id'], 'session_link_control arguments')
      const caller = await requireCaller(exec)
      return engine.modelControl({ ...object, from: caller.id })
    },
  }

  const createTool = {
    name: TOOL_NAMES.create,
    description:
      'Create a new ordinary session in an explicit location and immediately send it its first task as a request through the standard agent-message relay; empty sessions are not offered. Call session_link_operation first and pass its operationId. Provide exactly one of workspaceId (an existing registered workspace, discoverable with session_link_list scope=workspaces) or newProject:{parentDir,directoryName,title?} — never a bare cwd; the directory is created single-level under an existing parent without overwriting anything. A retry with the same operationId continues the same created session and first message instead of creating another. In the result, phase "sent" only means a first-message record exists — firstMessage.status is authoritative and may be held, pending, or unknown; never treat "sent" as accepted, read, processed, or task started. accepted on the first message only means the Host durably took it, never that the task ran. ' +
      SUBJECT_HINT,
    parameters: {
      type: 'object',
      properties: {
        operationId: { type: 'string' },
        task: { type: 'string' },
        workspaceId: { type: 'string' },
        newProject: {
          type: 'object',
          properties: {
            parentDir: { type: 'string' },
            directoryName: { type: 'string' },
            title: { type: 'string' },
          },
          required: ['parentDir', 'directoryName'],
          additionalProperties: false,
        },
        title: { type: 'string' },
        subject: { type: 'string' },
      },
      required: ['operationId', 'task'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderValue(value) },
    async execute(args, exec) {
      const object = assertObject(args)
      assertAllowedKeys(
        object,
        ['operationId', 'task', 'workspaceId', 'newProject', 'title', 'subject'],
        'session_link_create arguments',
      )
      const caller = await requireCaller(exec)
      return engine.create({
        ...object,
        from: caller.id,
      })
    },
  }

  return [operationTool, listTool, historyTool, sendTool, replyTool, statusTool, controlTool, createTool]
}

/** @param {unknown} args @returns {Record<string, any>} */
function assertObject(args) {
  return assertPlainObject(args ?? {}, 'arguments', 'tool_args')
}

/** @param {unknown} args */
function requireEmptyArgs(args) {
  const object = assertObject(args)
  assertAllowedKeys(object, [], 'session_link_operation arguments')
}

/**
 * Render one bounded JSON value as text. Tool values are small by construction;
 * the cap protects the model context if an unexpected host title is huge.
 * @param {unknown} value
 * @returns {Array<{ type: 'text', text: string }>}
 */
function renderValue(value) {
  const text = JSON.stringify(value, null, 2)
  const bounded = typeof text === 'string' ? text : '{}'
  return [
    {
      type: 'text',
      text: bounded.length > LIMITS.HISTORY_MAX_CHARS ? `${bounded.slice(0, LIMITS.HISTORY_MAX_CHARS - 40)}\n… result truncated` : bounded,
    },
  ]
}
