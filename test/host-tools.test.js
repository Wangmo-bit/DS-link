import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createSessionLinkPlugin } from '../src/host/plugin.js'
import { CONNECTION_PATH, dispatchRpc } from '../src/host/connection.js'
import { FakeClock, makeMockHost, sessionFixture, tempRoot } from './helpers.js'

async function mount(t) {
  const clock = new FakeClock()
  const sessions = [
    sessionFixture({ id: 'A', title: 'Alpha', workspaceId: 'w-1' }),
    sessionFixture({ id: 'B', title: 'Beta', workspaceId: 'w-1' }),
    sessionFixture({ id: 'C', title: 'Archived', archived: true, workspaceId: 'w-1' }),
    sessionFixture({ id: 'F', title: 'Fork', parentSession: 'A', workspaceId: 'w-2' }),
    sessionFixture({ id: 'S', title: 'Subagent', subagent: true, origin: 'subagent', workspaceId: 'w-1' }),
  ]
  const host = makeMockHost({ sessions, clock })
  host.logs.set('C', {
    inheritedEventCount: 0,
    events: [
      {
        type: 'user/message',
        seq: 0,
        time: clock.read(),
        data: { id: 'c1', role: 'user', content: [{ type: 'text', text: 'archived history' }], source: { kind: 'user' } },
      },
    ],
  })
  const root = await tempRoot()
  const service = await createSessionLinkPlugin(host.ctx, { stateRoot: root, cacheMs: 0 }, {
    createUserMessage: host.createUserMessage,
    clock: () => clock.read(),
  })
  t.after(() => service.close())
  return { clock, host, root, service }
}

function exec(host, id, args = {}) {
  return { agent: host.agents.get(id), arguments: args }
}

test('plugin mount registers tools, prompt, provider, and the exact authenticated route', async (t) => {
  const { host, service } = await mount(t)
  assert.equal(host.tools.size, 8)
  assert.equal(host.routes.has(CONNECTION_PATH), true)
  assert.equal(host.routes.get(CONNECTION_PATH).methods.includes('POST'), true)
  assert.equal(host.promptSections.length, 1)
  assert.equal(host.provided.get('sessionLink'), service)
  assert.equal(service.engine, host.provided.get('sessionLink').engine)
})

test('tools reject missing, subagent, archived, and non-registered caller identity', async (t) => {
  const { host } = await mount(t)
  const operation = host.tools.get('session_link_operation')
  await assert.rejects(operation.execute({}, {}), (error) => error.code === 'identity_required')
  await assert.rejects(operation.execute({}, { agent: { id: 'A' } }), (error) => error.code === 'identity_mismatch')
  await assert.rejects(operation.execute({}, exec(host, 'S')), (error) => error.code === 'identity_subagent')
  await assert.rejects(operation.execute({}, exec(host, 'C')), (error) => error.code === 'identity_archived')
  await assert.rejects(operation.execute({ from: 'B' }, exec(host, 'A')), (error) => error.code === 'tool_args')
  const send = host.tools.get('session_link_send')
  const op = (await operation.execute({}, exec(host, 'A'))).operationId
  await assert.rejects(
    send.execute({ targets: ['B'], kind: 'notification', text: 'x', operationId: op, from: 'B' }, exec(host, 'A')),
    (error) => error.code === 'tool_args',
  )
  await assert.rejects(
    send.execute({ targets: ['B'], kind: 'notification', text: 'x', operationId: (await operation.execute({}, exec(host, 'A'))).operationId, hop: 4 }, exec(host, 'A')),
    (error) => error.code === 'tool_args',
  )
  await assert.rejects(
    send.execute({ targets: ['A'], kind: 'notification', text: 'self', operationId: (await operation.execute({}, exec(host, 'A'))).operationId }, exec(host, 'A')),
    (error) => error.code === 'self_target',
  )
})

test('operation, list, history, send, reply, status, and model control work through tools', async (t) => {
  const { clock, host, service } = await mount(t)
  const operation = host.tools.get('session_link_operation')
  const list = host.tools.get('session_link_list')
  const history = host.tools.get('session_link_history')
  const send = host.tools.get('session_link_send')
  const reply = host.tools.get('session_link_reply')
  const status = host.tools.get('session_link_status')
  const control = host.tools.get('session_link_control')

  const minted = await operation.execute({}, exec(host, 'A'))
  assert.match(minted.operationId, /^slop:\d+:/)

  const listed = await list.execute({}, exec(host, 'A'))
  const listedIds = listed.sessions.map((session) => session.id)
  assert.deepEqual(listedIds.sort(), ['A', 'B', 'F'])
  assert.equal(listed.sessions.every((session) => session.id === session.sessionId), true)

  const byWorkspace = await list.execute({ workspace: 'Workspace 2' }, exec(host, 'A'))
  assert.deepEqual(byWorkspace.sessions.map((session) => session.id), ['F'])

  const archivedHistory = await history.execute({ sessionId: 'C', mode: 'recent', limit: 5 }, exec(host, 'A'))
  assert.equal(archivedHistory.messages[0].text, 'archived history')
  await assert.rejects(
    history.execute({ sessionId: 'S', mode: 'recent' }, exec(host, 'A')),
    (error) => error.code === 'target_subagent',
  )

  clock.advance(1001)
  const sent = await send.execute(
    { targets: ['B'], kind: 'request', text: 'please reply', operationId: minted.operationId },
    exec(host, 'A'),
  )
  assert.equal(sent.results[0].status, 'accepted')
  assert.equal(host.steers.length, 1)
  const delivered = host.steers[0].message
  assert.deepEqual(Object.keys(delivered.source).sort(), ['form', 'kind', 'senderSessionId'])
  assert.equal(delivered.source.kind, 'agent-message')
  assert.equal(delivered.source.form, 'relay')
  assert.equal(delivered.source.senderSessionId, 'A')
  assert.match(delivered.content[0].text, /session-link request from A/)

  clock.advance(1001)
  const mintedReply = await operation.execute({}, exec(host, 'B'))
  const replied = await reply.execute(
    { messageId: sent.results[0].id, text: 'explicit answer', operationId: mintedReply.operationId },
    exec(host, 'B'),
  )
  assert.equal(replied.results[0].status, 'accepted')
  await assert.rejects(
    reply.execute({ messageId: sent.results[0].id, text: 'wrong', operationId: mintedReply.operationId }, exec(host, 'S')),
    (error) => error.code === 'identity_subagent',
  )

  const state = await status.execute({ messageId: sent.results[0].id }, exec(host, 'A'))
  assert.equal(state.messages.length, 1)
  assert.equal(state.messages[0].replyStatus, 'answered')
  assert.equal(state.replies[sent.results[0].id].length, 1)

  clock.advance(1001)
  const paused = await control.execute({ action: 'pause', id: sent.chainId }, exec(host, 'A'))
  assert.equal(paused.chain.state, 'paused')
  await assert.rejects(
    control.execute({ action: 'resume', id: sent.chainId }, exec(host, 'A')),
    (error) => error.code === 'invalid_argument',
  )
  await assert.rejects(
    control.execute({ action: 'close', id: sent.chainId }, exec(host, 'B')),
    (error) => error.code === 'forbidden',
  )
  const closed = await control.execute({ action: 'close', id: sent.chainId }, exec(host, 'A'))
  assert.equal(closed.chain.state, 'closed')
  assert.equal(service.engine, host.provided.get('sessionLink').engine)
})

test('unsupported hosts fail closed instead of mounting a fallback control plane', async () => {
  const clock = new FakeClock()
  const host = makeMockHost({ sessions: [sessionFixture({ id: 'A' })], clock })
  delete host.ctx.connection
  await assert.rejects(
    createSessionLinkPlugin(host.ctx, { stateRoot: await tempRoot() }, {
      createUserMessage: host.createUserMessage,
      clock: () => clock.read(),
    }),
    (error) => error.code === 'unsupported_host' && error.details.missing.includes('connection.fetch.register'),
  )
  assert.equal(host.routes.size, 0)
})

test('create tool, workspace scope, and card_lookup work through the plugin boundary', async (t) => {
  const clock = new FakeClock()
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'v04-host-parent-'))
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v04-host-ws-'))
  const stateRoot = await tempRoot()
  t.after(async () => {
    await fs.rm(parent, { recursive: true, force: true })
    await fs.rm(workspaceDir, { recursive: true, force: true })
    await fs.rm(stateRoot, { recursive: true, force: true })
  })
  const sessions = [
    sessionFixture({ id: 'A', title: 'Alpha', workspaceId: 'w-real' }),
    sessionFixture({ id: 'B', title: 'Beta', workspaceId: 'w-real' }),
  ]
  const host = makeMockHost({
    sessions,
    clock,
    workspaces: [{ id: 'w-real', title: 'Real WS', path: workspaceDir, sessionIds: ['A', 'B'] }],
  })
  const service = await createSessionLinkPlugin(host.ctx, { stateRoot, cacheMs: 0 }, {
    createUserMessage: host.createUserMessage,
    clock: () => clock.read(),
  })
  t.after(() => service.close())

  const operation = host.tools.get('session_link_operation')
  const create = host.tools.get('session_link_create')
  const list = host.tools.get('session_link_list')

  // New project through the tool: directory, registration, rename, first steer.
  const op1 = (await operation.execute({}, exec(host, 'A'))).operationId
  // The tool schema accepts exactly operationId/task/workspaceId/newProject/title/subject.
  await assert.rejects(
    create.execute({ operationId: op1, task: 'x', from: 'B' }, exec(host, 'A')),
    (error) => error.code === 'tool_args',
  )
  await assert.rejects(
    create.execute({ operationId: op1, task: 'no location' }, exec(host, 'A')),
    (error) => error.code === 'invalid_argument',
  )
  const viaProject = await create.execute(
    {
      operationId: op1,
      task: 'second probe',
      subject: 'host probe',
      newProject: { parentDir: parent, directoryName: 'host-demo' },
    },
    exec(host, 'A'),
  )
  assert.equal(viaProject.phase, 'sent')
  const stat = await fs.stat(path.join(parent, 'host-demo'))
  assert.equal(stat.isDirectory(), true)
  assert.equal(host.createCalls.length, 1)
  assert.equal(host.renameCalls.length, 1)
  assert.equal(host.renameCalls[0].title, 'second probe')
  assert.ok(host.steers.length >= 1)
  const first = host.steers[host.steers.length - 1]
  assert.equal(first.message.source.kind, 'agent-message')
  assert.equal(first.message.source.form, 'relay')
  assert.equal(first.message.source.senderSessionId, 'A')
  assert.match(first.message.content[0].text, /subject: host probe/)

  // Workspace scope discovery through the tool, including the empty default.
  const workspaces = await list.execute({ scope: 'workspaces' }, exec(host, 'A'))
  // w-real plus the freshly registered host-demo project workspace.
  assert.deepEqual(workspaces.workspaces.map((entry) => entry.id).sort(), ['w-mock-2', 'w-real'])
  const demo = workspaces.workspaces.find((entry) => entry.id === 'w-mock-2')
  assert.equal(demo.path, path.join(parent, 'host-demo'))
  assert.deepEqual(Object.keys(workspaces.workspaces[0]).sort(), ['id', 'path', 'title'])
  const sessionsPage = await list.execute({}, exec(host, 'A'))
  assert.ok(Array.isArray(sessionsPage.sessions))
  assert.equal(sessionsPage.workspaces, undefined)
  await assert.rejects(list.execute({ scope: 'nope' }, exec(host, 'A')), (error) => error.code === 'invalid_argument')

  // card_lookup through the owner connection dispatch.
  const snapshot = await service.engine.snapshot({ sessionId: viaProject.sessionId })
  const messageId = snapshot.messages[0].id
  const cards = await dispatchRpc(service, {
    action: 'card_lookup',
    payload: { sessionId: viaProject.sessionId, ids: [messageId, 'ghost'] },
  })
  assert.equal(cards.results.length, 1)
  assert.equal(cards.results[0].subject, 'host probe')
  assert.deepEqual(cards.missing, ['ghost'])
  await assert.rejects(
    dispatchRpc(service, { action: 'card_lookup', payload: { sessionId: viaProject.sessionId, ids: [] } }),
    (error) => error.code === 'invalid_argument',
  )

  // A host without create/rename keeps the plugin mounted; only create reports it.
  delete host.ctx.sessionController.create
  await assert.rejects(
    create.execute(
      {
        operationId: (await operation.execute({}, exec(host, 'A'))).operationId,
        task: 'blocked',
        workspaceId: 'w-real',
      },
      exec(host, 'A'),
    ),
    (error) => error.code === 'unsupported_host',
  )
  const stillWorks = await list.execute({}, exec(host, 'A'))
  assert.ok(Array.isArray(stillWorks.sessions), 'original tools keep working without create APIs')
})
