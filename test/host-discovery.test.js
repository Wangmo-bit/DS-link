import test from 'node:test'
import assert from 'node:assert/strict'

import { HostAdapter } from '../src/host/adapter.js'
import { FakeClock, makeMockHost, sessionFixture } from './helpers.js'

function adapterFor(host) {
  return new HostAdapter({
    ctx: host.ctx,
    createUserMessage: host.createUserMessage,
    clock: () => host.clock.read(),
    cacheMs: 0,
  })
}

function hostWith(extra = {}) {
  const clock = new FakeClock()
  const sessions = [
    sessionFixture({ id: 'plain', title: 'Plain Session', workspaceId: 'w-1', workspaceTitle: 'Workspace 1' }),
    sessionFixture({ id: 'fork', title: 'Fork Session', parentSession: 'plain', workspaceId: 'w-2', workspaceTitle: 'Workspace 2' }),
    sessionFixture({ id: 'subagent', title: 'Subagent', origin: 'subagent', workspaceId: 'w-1' }),
    sessionFixture({ id: 'deep', title: 'Deep child', delegationDepth: 2, workspaceId: 'w-1' }),
    sessionFixture({ id: 'archived', title: 'Archived Session', archived: true, workspaceId: 'w-1' }),
    sessionFixture({ id: 'unregistered', title: 'Unregistered', workspaceId: 'w-1' }),
  ]
  const workspaces = [
    { id: 'w-1', title: 'Workspace 1', path: '/tmp/w1', sessionIds: ['plain', 'subagent', 'deep', 'archived'] },
    { id: 'w-2', title: 'Workspace 2', path: '/tmp/w2', sessionIds: ['fork'] },
  ]
  const host = makeMockHost({ sessions, workspaces, clock, ...extra })
  host.clock = clock
  return host
}

test('discovery intersects registered workspaces with sessions; forks are legal, subagents are not', async () => {
  const host = hostWith()
  const adapter = adapterFor(host)
  const sessions = await adapter.listSessions({ fresh: true })
  const ids = sessions.map((session) => session.id)
  assert.deepEqual(ids.sort(), ['archived', 'deep', 'fork', 'plain', 'subagent'])
  const byId = new Map(sessions.map((session) => [session.id, session]))
  assert.equal(byId.get('fork').eligible, true, 'a fork with parentSession remains an ordinary session')
  assert.equal(byId.get('fork').parentSession, 'plain')
  assert.equal(byId.get('plain').workspaceTitle, 'Workspace 1')
  assert.equal(byId.get('fork').workspaceTitle, 'Workspace 2')
  assert.equal(byId.get('subagent').eligible, false)
  assert.equal(byId.get('deep').eligible, false)
  assert.equal(byId.get('archived').eligible, false)
  assert.equal(byId.has('unregistered'), false, 'workspace membership is required')
  assert.equal(byId.get('plain').title, 'Plain Session')
})

test('cold evidence ignores inherited prefix, requires the standard agent-message source, and reads inbox inserts', async () => {
  const host = hostWith()
  const adapter = adapterFor(host)
  const target = 'plain'
  host.logs.set(target, {
    inheritedEventCount: 1,
    events: [
      {
        type: 'user/message',
        seq: 0,
        time: 1,
        data: { id: 'inherited', role: 'user', content: [], source: { kind: 'agent-message', form: 'relay', senderSessionId: 'fork' } },
      },
      {
        type: 'agent/inbox/spliced',
        seq: 1,
        time: 2,
        data: {
          target: 'next-turn',
          start: 0,
          inserted: [
            {
              id: 'inbox-only',
              role: 'user',
              content: [],
              source: { kind: 'agent-message', form: 'relay', senderSessionId: 'fork' },
            },
          ],
        },
      },
      {
        type: 'user/message',
        seq: 2,
        time: 3,
        data: {
          id: 'child-message',
          role: 'user',
          content: [],
          source: { kind: 'agent-message', form: 'relay', senderSessionId: 'fork' },
        },
      },
      {
        type: 'user/message',
        seq: 3,
        time: 4,
        data: {
          id: 'wrong-source',
          role: 'user',
          content: [],
          source: { kind: 'agent-message', form: 'relay', senderSessionId: 'other' },
        },
      },
      {
        type: 'user/message',
        seq: 4,
        time: 5,
        surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 },
        data: {
          id: 'shadowed-message',
          role: 'user',
          content: [],
          source: { kind: 'agent-message', form: 'relay', senderSessionId: 'fork' },
        },
      },
    ],
  })

  assert.deepEqual(await adapter.readEvidence({ targetId: target, durableMessageId: 'inherited', senderSessionId: 'fork' }), {
    found: false,
    readable: true,
    evidence: 'none',
    inboxSeen: false,
    identityConflict: false,
  })
  const messageEvidence = await adapter.readEvidence({ targetId: target, durableMessageId: 'child-message', senderSessionId: 'fork' })
  assert.equal(messageEvidence.found, true)
  assert.equal(messageEvidence.evidence, 'message')
  const inboxEvidence = await adapter.readEvidence({ targetId: target, durableMessageId: 'inbox-only', senderSessionId: 'fork' })
  assert.equal(inboxEvidence.found, true)
  assert.equal(inboxEvidence.evidence, 'inbox')
  assert.equal(inboxEvidence.inboxSeen, true)
  const shadowed = await adapter.readEvidence({ targetId: target, durableMessageId: 'shadowed-message', senderSessionId: 'fork' })
  assert.equal(shadowed.found, true, 'raw replacement events still prove a past insertion')
  const conflict = await adapter.readEvidence({ targetId: target, durableMessageId: 'wrong-source', senderSessionId: 'fork' })
  assert.equal(conflict.identityConflict, true)

  const archived = await adapter.readEvidence({ targetId: 'archived', durableMessageId: 'child-message', senderSessionId: 'fork' })
  assert.equal(archived.invalidTarget, true)
})

test('history reads raw events, cites seq, supports literal search, and allows archived sessions', async () => {
  const host = hostWith()
  const adapter = adapterFor(host)
  const target = 'archived'
  const events = []
  for (let index = 0; index < 30; index += 1) {
    events.push({
      type: index % 2 === 0 ? 'user/message' : 'assistant/message',
      seq: index,
      time: 1000 + index,
      data:
        index % 2 === 0
          ? { id: `u${index}`, role: 'user', content: [{ type: 'text', text: `question ${index} keyword` }], source: { kind: 'user' } }
          : {
              message: {
                id: `a${index}`,
                role: 'assistant',
                content: [{ type: 'text', text: `answer ${index}` }],
                source: { kind: 'model', provider: 'test', model: 'test' },
              },
            },
    })
  }
  host.logs.set(target, { inheritedEventCount: 0, events })

  const recent = await adapter.history({ sessionId: target, mode: 'recent', limit: 20 })
  assert.equal(recent.messages.length, 20)
  assert.equal(recent.truncated, true)
  assert.ok(recent.nextBeforeSeq !== null)
  assert.equal(recent.messages[0].seq, 10)
  assert.equal(recent.messages.at(-1).seq, 29)
  assert.equal(recent.messages[0].role, 'user')
  assert.equal(recent.archived, true)

  const page = await adapter.history({ sessionId: target, mode: 'recent', limit: 5, beforeSeq: recent.messages[0].seq })
  assert.equal(page.messages.length, 5)
  assert.ok(page.messages.every((message) => message.seq < 10))

  const search = await adapter.history({ sessionId: target, mode: 'search', query: 'keyword', limit: 20 })
  assert.equal(search.hits.length, 15)
  assert.ok(search.hits.every((hit) => hit.seq % 2 === 0))
  assert.equal(search.hits[0].seq, 0)
})

test('history keeps compacted raw text searchable, marks current/shadowed, excludes tool secrets, and paginates without duplicates', async () => {
  const host = hostWith()
  const adapter = adapterFor(host)
  const target = 'archived'
  const events = []
  for (let index = 0; index < 30; index += 1) {
    events.push({
      type: index % 2 === 0 ? 'user/message' : 'assistant/message',
      seq: index,
      time: 5000 + index,
      data:
        index % 2 === 0
          ? {
              id: `u${index}`,
              role: 'user',
              content: [{ type: 'text', text: `compacted keyword raw ${index}` }],
              source: { kind: 'user' },
            }
          : {
              message: {
                id: `a${index}`,
                role: 'assistant',
                content: [{ type: 'text', text: `compacted keyword answer ${index}` }],
                source: { kind: 'model', provider: 'test', model: 'test' },
              },
            },
    })
  }
  events.push({
    type: 'tool/result',
    seq: 30,
    time: 5100,
    data: {
      toolCallId: 'secret-call',
      content: [{ type: 'text', text: 'TOOL_SECRET_MUST_NOT_APPEAR' }],
    },
  })
  host.logs.set(target, { inheritedEventCount: 0, events })
  // Pretend compaction left only the five newest surface nodes; older raw
  // events are shadowed but remain in the raw log.
  host.ctx.sessionQuery.readSurface = async () => ({
    session: { version: 'v4', id: target, createdAt: 1, isSeeded: false },
    inheritedEventCount: 0,
    capturedThroughSeq: 30,
    events: events.slice(25, 30),
  })

  const recent = await adapter.history({ sessionId: target, mode: 'recent', limit: 10 })
  assert.equal(recent.messages.length, 10)
  assert.deepEqual(
    recent.messages.map((message) => message.seq),
    [20, 21, 22, 23, 24, 25, 26, 27, 28, 29],
  )
  assert.equal(recent.messages[0].surface, 'shadowed')
  assert.equal(recent.messages.at(-1).surface, 'current')
  assert.equal(recent.messages[0].text.includes('compacted keyword raw 20'), true)
  assert.equal(recent.messages.some((message) => message.text.includes('TOOL_SECRET')), false)
  assert.equal(recent.nextBeforeSeq, 20)

  const first = await adapter.history({ sessionId: target, mode: 'search', query: 'compacted keyword', limit: 10 })
  assert.equal(first.hits.length, 10)
  assert.deepEqual(
    first.hits.map((hit) => hit.seq),
    [20, 21, 22, 23, 24, 25, 26, 27, 28, 29],
  )
  assert.equal(first.hits[0].surface, 'shadowed')
  assert.equal(first.hits.at(-1).surface, 'current')
  assert.equal(first.nextBeforeSeq, 20)
  assert.equal(first.hits.some((hit) => hit.snippet.includes('TOOL_SECRET')), false)

  const second = await adapter.history({
    sessionId: target,
    mode: 'search',
    query: 'compacted keyword',
    limit: 10,
    beforeSeq: first.nextBeforeSeq,
  })
  assert.deepEqual(
    second.hits.map((hit) => hit.seq),
    [10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
  )
  assert.equal(second.nextBeforeSeq, 10)
  const firstSeqs = new Set(first.hits.map((hit) => hit.seq))
  assert.equal(second.hits.every((hit) => !firstSeqs.has(hit.seq)), true)
  assert.equal(
    [...first.hits, ...second.hits].some((hit) => hit.snippet.includes('TOOL_SECRET')),
    false,
  )
})
