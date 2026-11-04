// Local deterministic check for the v0.3 scripted model state machine.
// No Host, package install, server start, or network access.
import assert from 'node:assert/strict'

import { installV03Fixture } from '../fixtures/v03.js'

const home = '/tmp/dsh-session-link-v03-model-test'
process.env.SESSION_LINK_TEST = '1'
process.env.DSH_HOME = home

class FakeLlmAdapter {}

let adapter
const ctx = {
  get: () => undefined,
  workspaceRegistry: { list: () => [], archivedSessionIds: [] },
  sessionController: {
    create: async () => ({}),
    selectModel: async () => ({}),
    resolveAgent: async () => ({}),
  },
  sessionQuery: { readSession: async () => ({}), listSessions: async () => [] },
  agents: { get: () => undefined },
  sessions: { flush: async () => true },
  tools: { get: () => undefined, register: () => () => undefined },
  llm: {
    registerAdapter: (_providers, instance) => {
      adapter = instance
      return () => undefined
    },
  },
  connection: { fetch: { register: async () => () => undefined } },
}
const createUserMessage = () => ({})

const fixture = await installV03Fixture(ctx, { home, createUserMessage, LlmAdapter: FakeLlmAdapter })
assert.equal(typeof adapter?.stream, 'function')

const initial = {
  role: 'user',
  content: [{ type: 'text', text: 'V03_HOLD_PROMPT local model test: call v03_hold once.' }],
}
const holdCall = {
  role: 'assistant',
  content: [{ type: 'tool-call', id: 'hold-call', name: 'v03_hold', arguments: JSON.stringify({ tag: 'test' }) }],
}
const holdResult = { role: 'tool', content: [{ type: 'text', text: 'v03_hold released after 10ms' }] }

function inbound(kind, id, text) {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `[session-link ${kind} from sender-session (Sender)]\nmessage: ${id}\nchain: chain-1 · hop: 0\n\n${text}\n`,
      },
    ],
  }
}

async function collect(messages, sessionId = 'target-session') {
  const chunks = []
  for await (const chunk of adapter.stream({ sessionId, messages, signal: new AbortController().signal })) chunks.push(chunk)
  return chunks
}

/** @param {Array<any>} chunks @returns {{name: string, arguments: Record<string, any>}|undefined} */
function toolCall(chunks) {
  const block = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')?.block
  if (block === undefined) return undefined
  return { name: block.name, arguments: JSON.parse(block.arguments) }
}

const first = await collect([initial])
assert.deepEqual(toolCall(first)?.name, 'v03_hold')

const five = [
  inbound('request', 'req-alpha', 'V03_CORE_MSG_1_REQ_ALPHA'),
  inbound('notification', 'note-bravo', 'V03_CORE_MSG_2_NOTE_BRAVO'),
  inbound('request', 'req-charlie', 'V03_CORE_MSG_3_REQ_CHARLIE'),
  inbound('notification', 'note-delta', 'V03_CORE_MSG_4_NOTE_DELTA'),
  inbound('notification', 'note-echo', 'V03_CORE_MSG_5_NOTE_ECHO'),
]
const afterHold = [initial, holdCall, holdResult, ...five]
const second = await collect(afterHold)
assert.deepEqual(toolCall(second)?.name, 'session_link_operation')

const operationCall = (id = 'op-call', operationId = 'slop:1:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee') => ({
  role: 'assistant',
  content: [{ type: 'tool-call', id, name: 'session_link_operation', arguments: '{}' }],
})
const operationResult = {
  role: 'tool',
  content: [{ type: 'text', text: JSON.stringify({ operationId: 'slop:1:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }) }],
}
const third = await collect([...afterHold, operationCall(), operationResult])
const firstReply = toolCall(third)
assert.equal(firstReply?.name, 'session_link_reply')
assert.equal(firstReply?.arguments.messageId, 'req-alpha')
assert.equal(firstReply?.arguments.operationId, 'slop:1:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
assert.match(firstReply?.arguments.text, /^V03_REPLY_FOR_req-alpha/)

const replyCall = (id, messageId) => ({
  role: 'assistant',
  content: [
    {
      type: 'tool-call',
      id,
      name: 'session_link_reply',
      arguments: JSON.stringify({ operationId: 'slop:1:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', messageId, text: `V03_REPLY_FOR_${messageId}` }),
    },
  ],
})
const replyResult = { role: 'tool', content: [{ type: 'text', text: '{"status":"accepted"}' }] }
const afterFirstReply = [...afterHold, operationCall(), operationResult, replyCall('reply-call-1', 'req-alpha'), replyResult]
const fourth = await collect(afterFirstReply)
assert.equal(toolCall(fourth)?.name, 'session_link_operation')

const operation2 = operationCall('op-call-2', 'slop:2:11111111-2222-3333-4444-555555555555')
const operationResult2 = {
  role: 'tool',
  content: [{ type: 'text', text: JSON.stringify({ operationId: 'slop:2:11111111-2222-3333-4444-555555555555' }) }],
}
const fifth = await collect([...afterFirstReply, operation2, operationResult2])
const secondReply = toolCall(fifth)
assert.equal(secondReply?.name, 'session_link_reply')
assert.equal(secondReply?.arguments.messageId, 'req-charlie')
assert.equal(secondReply?.arguments.operationId, 'slop:2:11111111-2222-3333-4444-555555555555')

const finalMessages = [...afterFirstReply, operation2, operationResult2, replyCall('reply-call-2', 'req-charlie'), replyResult]
const sixth = await collect(finalMessages)
const finalText = sixth.find((chunk) => chunk.type === 'text-delta')?.text
assert.match(finalText ?? '', /^V03_TARGET_DONE seen=5 ids=/)
assert.match(finalText, /req-alpha/)
assert.match(finalText, /req-charlie/)

await fixture.dispose()
delete process.env.SESSION_LINK_TEST
delete process.env.DSH_HOME
console.log('v03 fixture model: hold, operation/reply sequencing, and final step passed')
