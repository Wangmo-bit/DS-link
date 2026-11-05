/**
 * session_link_create + subject + card_lookup + workspace scope tests.
 *
 * Everything runs on temp directories and the in-memory adapter; no
 * production profile, port, or installed artifact is touched.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { LIMITS } from '../src/core/constants.js'
import { callFingerprint, createFingerprint, fingerprintMatches, firstLineExcerpt } from '../src/core/validation.js'
import { v04DowngradePreflight } from '../src/core/downgrade.js'
import { Ledger } from '../src/core/ledger.js'
import { createDefaultSettings } from '../src/core/settings.js'
import { FakeClock, MemoryAdapter, openEngine, sessionFixture, tempRoot } from './helpers.js'

async function tempDir(prefix = 'v04-create-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function setup(t, options = {}) {
  const clock = new FakeClock()
  const root = await tempRoot()
  const parent = await tempDir()
  const workspaceDir = options.workspaceDir ?? (await tempDir('v04-default-ws-'))
  const adapter = new MemoryAdapter({
    clock,
    sessions: options.sessions ?? [
      sessionFixture({ id: 'A', title: 'Alpha' }),
      sessionFixture({ id: 'B', title: 'Beta' }),
    ],
    workspaces: options.workspaces ?? [
      { id: 'w-1', title: 'Default WS', path: workspaceDir, sessionIds: ['A', 'B'] },
    ],
  })
  const { ledger, engine } = await openEngine({
    root,
    adapter,
    clock,
    uuid: options.uuid,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  })
  t.after(async () => {
    await engine.dispose()
    await ledger.close()
    await fs.rm(parent, { recursive: true, force: true })
    await fs.rm(workspaceDir, { recursive: true, force: true })
    await fs.rm(root, { recursive: true, force: true })
  })
  return { clock, adapter, ledger, engine, root, parent, workspaceDir }
}

function createArgs(operationId, overrides = {}) {
  return {
    from: 'A',
    operationId,
    task: 'please summarize the failing test',
    ...overrides,
  }
}

/** Full-shape journal fixture matching the strict ledger whitelist. */
function journalFixture(from, operationId, overrides = {}) {
  const key = `${from}|${operationId}`
  return {
    [key]: {
      key,
      from,
      operationId,
      fingerprint: 'fp',
      at: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000,
      phase: 'creating',
      task: 'please summarize the failing test',
      subject: null,
      title: 'Summarize',
      location: { kind: 'workspace', workspaceId: 'w-1', parentDir: null, directoryName: null, workspacePath: null, workspaceTitle: 'WS' },
      requestedSessionId: 'session-reserved',
      sessionId: null,
      workspaceId: 'w-1',
      workspacePath: '/tmp/nowhere',
      renameStatus: 'not_attempted',
      renameError: null,
      sendOperationId: 'slop:1800000000000:00000000-0000-4000-8000-000000000000',
      firstMessageId: null,
      error: null,
      terminalAt: null,
      bodyStripped: false,
      ...overrides,
    },
  }
}

// ---------------------------------------------------------------------------
// A. New project / existing workspace happy paths
// ---------------------------------------------------------------------------

test('create with newProject creates a single-level directory, registers, renames, and sends', async (t) => {
  const { adapter, engine, ledger, parent } = await setup(t)
  const operationId = engine.mintOperation().operationId
  const result = await engine.create(
    createArgs(operationId, {
      newProject: { parentDir: parent, directoryName: 'demo-app', title: 'Demo Project' },
      task: 'build the demo\nsecond line',
      subject: 'demo first task',
      title: 'Demo Session',
    }),
  )
  assert.equal(result.idempotent, false)
  assert.equal(result.phase, 'sent')
  assert.equal(result.error, null)
  assert.ok(result.workspace?.id)
  assert.equal(result.workspace.path, path.join(parent, 'demo-app'))
  assert.ok(result.sessionId)
  assert.equal(result.requestedSessionId, result.sessionId)
  assert.equal(result.title, 'Demo Session')
  assert.equal(result.titleStatus, 'renamed')
  assert.equal(result.firstMessage.status, 'accepted')
  assert.ok(result.sendOperationId.startsWith('slop:'))

  const stat = await fs.stat(path.join(parent, 'demo-app'))
  assert.equal(stat.isDirectory(), true)
  assert.equal(adapter.createCalls.length, 1)
  assert.deepEqual(adapter.renameCalls, [{ sessionId: result.sessionId, title: 'Demo Session' }])
  assert.equal(adapter.deliveries.length, 1)
  const delivered = adapter.built.get('host-msg-1')
  assert.equal(delivered.from, 'A')
  assert.equal(delivered.to, result.sessionId)
  assert.equal(delivered.subject, 'demo first task')
  assert.match(delivered.rendered, /subject: demo first task/)

  const journal = ledger.read().creates[`A|${operationId}`]
  assert.equal(journal.phase, 'sent')
  assert.equal(journal.bodyStripped, true)
  assert.equal(journal.task, '')
  assert.equal(journal.subject, null)
  assert.ok(Number.isSafeInteger(journal.terminalAt))
  assert.equal(journal.sessionId, result.sessionId)
})

test('create in an existing registered workspace reuses it and creates no directory itself', async (t) => {
  const workspaceDir = await tempDir('v04-ws-')
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }))
  const { adapter, engine, parent } = await setup(t, {
    workspaces: [{ id: 'w-1', title: 'Existing WS', path: workspaceDir, sessionIds: ['A'] }],
  })
  const operationId = engine.mintOperation().operationId
  const result = await engine.create(createArgs(operationId, { workspaceId: 'w-1', task: 'do the work' }))
  assert.equal(result.phase, 'sent')
  assert.equal(result.workspace.id, 'w-1')
  assert.equal(result.workspace.path, workspaceDir)
  assert.equal(result.workspace.title, 'Existing WS')
  // No createWorkspace call: the workspace already existed.
  assert.equal(adapter.workspaces.length, 1)
  assert.equal(adapter.createCalls.length, 1)
  assert.equal(adapter.createCalls[0].workspaceId, 'w-1')
  // No stray directory under the unused parent.
  const entries = await fs.readdir(parent)
  assert.deepEqual(entries, [])
  // Deterministic title excerpt from the task when no title is given.
  assert.equal(result.title, 'do the work')
})

// ---------------------------------------------------------------------------
// B. Rejections before any side effect
// ---------------------------------------------------------------------------

test('an existing target directory is never taken over', async (t) => {
  const { adapter, engine, ledger, parent } = await setup(t)
  await fs.mkdir(path.join(parent, 'taken'))
  const operationId = engine.mintOperation().operationId
  await assert.rejects(
    engine.create(createArgs(operationId, { newProject: { parentDir: parent, directoryName: 'taken' } })),
    (error) => error.code === 'target_exists',
  )
  assert.equal(ledger.read().creates, undefined)
  assert.equal(adapter.createCalls.length, 0)
  const entries = await fs.readdir(path.join(parent, 'taken'))
  assert.deepEqual(entries, [], 'existing directory must stay untouched')
})

test('a missing parent directory is not created implicitly', async (t) => {
  const { adapter, engine, ledger, parent } = await setup(t)
  const operationId = engine.mintOperation().operationId
  await assert.rejects(
    engine.create(
      createArgs(operationId, { newProject: { parentDir: path.join(parent, 'missing'), directoryName: 'x' } }),
    ),
    (error) => error.code === 'parent_missing',
  )
  assert.equal(ledger.read().creates, undefined)
  assert.equal(adapter.createCalls.length, 0)
  await assert.rejects(fs.stat(path.join(parent, 'missing')), (error) => error.code === 'ENOENT')
})

test('illegal directory names and non-absolute parents reject with no side effects', async (t) => {
  const { adapter, engine, ledger, parent } = await setup(t)
  const bad = ['a/b', '..', '.', 'a\\b', 'end.']
  for (const directoryName of bad) {
    const operationId = engine.mintOperation().operationId
    await assert.rejects(
      engine.create(createArgs(operationId, { newProject: { parentDir: parent, directoryName } })),
      (error) => ['invalid_argument', 'tool_args'].includes(error.code),
      `directoryName=${JSON.stringify(directoryName)}`,
    )
  }
  const operationId = engine.mintOperation().operationId
  await assert.rejects(
    engine.create(createArgs(operationId, { newProject: { parentDir: 'relative/dir', directoryName: 'ok' } })),
    (error) => error.code === 'invalid_argument',
  )
  assert.equal(ledger.read().creates, undefined)
  assert.equal(adapter.createCalls.length, 0)
  assert.deepEqual(await fs.readdir(parent), [])
})

test('paused and disabled reject a new creation before the journal exists', async (t) => {
  const { adapter, engine, ledger, parent } = await setup(t)
  await engine.updateSettings({ expectedSettingsRevision: 1, patch: { paused: true } })
  await assert.rejects(
    engine.create(createArgs(engine.mintOperation().operationId, { workspaceId: 'w-1' })),
    (error) => error.code === 'paused',
  )
  await engine.updateSettings({ expectedSettingsRevision: 2, patch: { paused: false, enabled: false } })
  await assert.rejects(
    engine.create(createArgs(engine.mintOperation().operationId, { workspaceId: 'w-1' })),
    (error) => error.code === 'disabled',
  )
  assert.equal(ledger.read().creates, undefined)
  assert.equal(adapter.createCalls.length, 0)
  assert.deepEqual(await fs.readdir(parent), [])
})

test('exactly one location is required', async (t) => {
  const { engine, parent } = await setup(t)
  await assert.rejects(
    engine.create(createArgs(engine.mintOperation().operationId)),
    (error) => error.code === 'invalid_argument',
  )
  await assert.rejects(
    engine.create(
      createArgs(engine.mintOperation().operationId, {
        workspaceId: 'w-1',
        newProject: { parentDir: parent, directoryName: 'x' },
      }),
    ),
    (error) => error.code === 'invalid_argument',
  )
})

// ---------------------------------------------------------------------------
// C. Idempotency, conflicts, partial success, uncertainty
// ---------------------------------------------------------------------------

test('retrying the same create operation replays without a second session, rename, or message', async (t) => {
  const { adapter, engine, parent } = await setup(t)
  const operationId = engine.mintOperation().operationId
  const args = {
    newProject: { parentDir: parent, directoryName: 'once' },
    task: 'only once',
  }
  const first = await engine.create(createArgs(operationId, args))
  const retry = await engine.create(createArgs(operationId, args))
  assert.equal(first.idempotent, false)
  assert.equal(retry.idempotent, true)
  assert.equal(retry.phase, 'sent')
  assert.equal(retry.sessionId, first.sessionId)
  assert.equal(retry.firstMessage.id, first.firstMessage.id)
  assert.equal(adapter.createCalls.length, 1)
  assert.equal(adapter.renameCalls.length, 1)
  assert.equal(adapter.deliveries.length, 1)
})

test('a create operationId conflicts with different inputs and with send/reply in both directions', async (t) => {
  const { adapter, engine } = await setup(t)
  const operationId = engine.mintOperation().operationId
  await engine.create(createArgs(operationId, { workspaceId: 'w-1', task: 'first task' }))
  await assert.rejects(
    engine.create(createArgs(operationId, { workspaceId: 'w-1', task: 'different task' })),
    (error) => error.code === 'conflict_operation',
  )
  // send -> create cross-kind reuse
  const sendOp = engine.mintOperation().operationId
  await engine.send({ from: 'A', targets: ['B'], kind: 'notification', text: 'x', operationId: sendOp })
  await assert.rejects(
    engine.create(createArgs(sendOp, { workspaceId: 'w-1' })),
    (error) => error.code === 'conflict_operation',
  )
  // create -> send cross-kind reuse
  const createOp = engine.mintOperation().operationId
  await engine.create(createArgs(createOp, { workspaceId: 'w-1' }))
  await assert.rejects(
    engine.send({ from: 'A', targets: ['B'], kind: 'notification', text: 'y', operationId: createOp }),
    (error) => error.code === 'conflict_operation',
  )
  assert.equal(adapter.createCalls.length, 2)
})

test('same operationId with only newProject.title changed is a conflict with no new side effects', async (t) => {
  const { adapter, engine, parent } = await setup(t)
  const operationId = engine.mintOperation().operationId
  const first = await engine.create(
    createArgs(operationId, {
      newProject: { parentDir: parent, directoryName: 'titled', title: 'One' },
      task: 'titled project',
    }),
  )
  assert.equal(first.phase, 'sent')
  await assert.rejects(
    engine.create(
      createArgs(operationId, {
        newProject: { parentDir: parent, directoryName: 'titled', title: 'Two' },
        task: 'titled project',
      }),
    ),
    (error) => error.code === 'conflict_operation',
  )
  // Identical normalized input still replays idempotently.
  const retry = await engine.create(
    createArgs(operationId, {
      newProject: { parentDir: parent, directoryName: 'titled', title: 'One' },
      task: 'titled project',
    }),
  )
  assert.equal(retry.idempotent, true)
  assert.equal(adapter.createCalls.length, 1, 'the conflicting retry never touches the host')
  assert.equal(adapter.renameCalls.length, 1)
  assert.equal(adapter.deliveries.length, 1)
})

test('an attach failure keeps the real session id, reports honestly, and never recreates', async (t) => {
  const { adapter, engine, ledger } = await setup(t)
  adapter.createHooks.attachError = true
  const operationId = engine.mintOperation().operationId
  const result = await engine.create(createArgs(operationId, { workspaceId: 'w-1' }))
  assert.equal(result.phase, 'attach_failed')
  assert.ok(result.sessionId, 'the real created id must be reported')
  assert.equal(result.firstMessage, null)
  assert.equal(result.error.code, 'session_attach_failed')
  const journal = ledger.read().creates[`A|${operationId}`]
  assert.equal(journal.phase, 'attach_failed')
  assert.equal(journal.sessionId, result.sessionId)

  const retry = await engine.create(createArgs(operationId, { workspaceId: 'w-1' }))
  assert.equal(retry.idempotent, true)
  assert.equal(retry.phase, 'attach_failed')
  assert.equal(adapter.createCalls.length, 1, 'retry must not create a second session')
})

test('a host-replaced session id is recorded next to the reserved id', async (t) => {
  const { adapter, engine } = await setup(t)
  adapter.createHooks.forceMint = true
  const operationId = engine.mintOperation().operationId
  const result = await engine.create(createArgs(operationId, { workspaceId: 'w-1' }))
  assert.equal(result.phase, 'sent')
  assert.notEqual(result.sessionId, result.requestedSessionId)
  assert.match(result.requestedSessionId, /^session-/)
  assert.match(result.sessionId, /^session-minted-/)
})

test('a rename failure is recorded but never blocks the first task and is never retried', async (t) => {
  const { adapter, engine } = await setup(t)
  adapter.createHooks.renameError = { code: 'session/not-found', message: 'gone' }
  const operationId = engine.mintOperation().operationId
  const result = await engine.create(createArgs(operationId, { workspaceId: 'w-1', title: 'Named' }))
  assert.equal(result.phase, 'sent')
  assert.equal(result.titleStatus, 'rename_failed')
  assert.equal(result.firstMessage.status, 'accepted')
  assert.equal(adapter.renameCalls.length, 1)
  const retry = await engine.create(createArgs(operationId, { workspaceId: 'w-1', title: 'Named' }))
  assert.equal(retry.idempotent, true)
  assert.equal(adapter.renameCalls.length, 1, 'rename must not be attempted twice')
  assert.equal(adapter.createCalls.length, 1)
})

test('a create interrupted in creating becomes uncertain and never re-runs an effect', async (t) => {
  const { adapter, engine, ledger, parent } = await setup(t)
  const operationId = engine.mintOperation().operationId
  const args = { newProject: { parentDir: parent, directoryName: 'ghost' }, task: 'never runs' }
  const fingerprint = createFingerprint({
    task: args.task,
    targets: ['A'],
    workspaceId: null,
    parentDir: parent,
    directoryName: 'ghost',
    title: firstLineExcerpt(args.task, LIMITS.TITLE_EXCERPT_CHARS),
  })
  await ledger.mutate((state) => {
    state.creates = journalFixture('A', operationId, {
      fingerprint,
      location: {
        kind: 'new_project',
        workspaceId: null,
        parentDir: parent,
        directoryName: 'ghost',
        workspacePath: null,
        workspaceTitle: null,
      },
      workspaceId: null,
      workspacePath: null,
      title: firstLineExcerpt(args.task, LIMITS.TITLE_EXCERPT_CHARS),
      task: args.task,
    })
    return true
  })
  await engine.start()
  const journal = ledger.read().creates[`A|${operationId}`]
  assert.equal(journal.phase, 'uncertain')
  assert.equal(journal.error.code, 'create_interrupted')

  const retry = await engine.create(createArgs(operationId, args))
  assert.equal(retry.idempotent, true)
  assert.equal(retry.phase, 'uncertain')
  assert.equal(adapter.createCalls.length, 0, 'no automatic re-create')
  await assert.rejects(fs.stat(path.join(parent, 'ghost')), (error) => error.code === 'ENOENT')
})

test('a journal in created phase resumes rename and first send on the same session', async (t) => {
  const { adapter, engine, ledger } = await setup(t)
  const operationId = engine.mintOperation().operationId
  const args = { workspaceId: 'w-1', task: 'resume me', title: 'Resume' }
  const fingerprint = createFingerprint({
    task: args.task,
    targets: ['A'],
    workspaceId: 'w-1',
    parentDir: null,
    directoryName: null,
    title: args.title,
  })
  await ledger.mutate((state) => {
    state.creates = journalFixture('A', operationId, {
      fingerprint,
      phase: 'created',
      sessionId: 'B',
      title: args.title,
      task: args.task,
      sendOperationId: 'slop:1800000000000:00000000-0000-4000-8000-000000000001',
    })
    return true
  })
  const result = await engine.create(createArgs(operationId, args))
  assert.equal(result.idempotent, true)
  assert.equal(result.phase, 'sent')
  assert.equal(result.sessionId, 'B')
  assert.equal(result.titleStatus, 'renamed')
  assert.equal(result.firstMessage.status, 'accepted')
  assert.equal(adapter.createCalls.length, 0, 'no new session is created')
  assert.equal(adapter.deliveries.length, 1)
})

test('a paused continuation does not rebuild and holds the first message instead of delivering', async (t) => {
  const { adapter, engine, ledger } = await setup(t)
  const operationId = engine.mintOperation().operationId
  const args = { workspaceId: 'w-1', task: 'hold me' }
  const fingerprint = createFingerprint({
    task: args.task,
    targets: ['A'],
    workspaceId: 'w-1',
    parentDir: null,
    directoryName: null,
    title: args.task,
  })
  await ledger.mutate((state) => {
    state.creates = journalFixture('A', operationId, {
      fingerprint,
      phase: 'created',
      sessionId: 'B',
      task: args.task,
      title: args.task,
      sendOperationId: 'slop:1800000000000:00000000-0000-4000-8000-000000000002',
    })
    return true
  })
  await engine.updateSettings({ expectedSettingsRevision: 1, patch: { paused: true } })
  const result = await engine.create(createArgs(operationId, args))
  assert.equal(result.phase, 'sent')
  assert.equal(result.firstMessage.status, 'held')
  assert.equal(adapter.createCalls.length, 0, 'paused must not rebuild')
  assert.equal(adapter.deliveries.length, 0, 'paused must not bypass the gate')
})

test('concurrent same-operation creates share one host effect sequence', async (t) => {
  const { adapter, engine, parent } = await setup(t)
  const operationId = engine.mintOperation().operationId
  const args = { newProject: { parentDir: parent, directoryName: 'race' }, task: 'race once' }
  const [first, second] = await Promise.all([
    engine.create(createArgs(operationId, args)),
    engine.create(createArgs(operationId, args)),
  ])
  assert.equal(adapter.createCalls.length, 1, 'exactly one host effect sequence runs')
  assert.equal(first.sessionId, second.sessionId)
  assert.deepEqual(first, second, 'both callers share the single effect result')
  assert.equal(adapter.deliveries.length, 1)
  assert.equal(adapter.renameCalls.length, 1)
})

test('a failed durability barrier reports an actionable partial state and never rebuilds', async (t) => {
  const { adapter, engine } = await setup(t)
  adapter.createHooks.durableResult = { ok: false, code: 'flush_unconfirmed', message: 'flush did not confirm' }
  const operationId = engine.mintOperation().operationId
  const args = { workspaceId: 'w-1', task: 'barrier first', title: 'Later' }
  const result = await engine.create(createArgs(operationId, args))
  assert.equal(result.phase, 'created')
  assert.equal(result.error.code, 'flush_unconfirmed')
  assert.equal(result.firstMessage, null, 'no first message before the durability fence')
  assert.equal(result.titleStatus, 'not_attempted', 'no rename before the durability fence')
  assert.equal(adapter.renameCalls.length, 0)
  assert.equal(adapter.deliveries.length, 0)
  assert.equal(adapter.createCalls.length, 1)

  // The same operation becomes actionable once the host confirms durability.
  delete adapter.createHooks.durableResult
  const retry = await engine.create(createArgs(operationId, args))
  assert.equal(retry.idempotent, true)
  assert.equal(retry.phase, 'sent')
  assert.equal(retry.error, null)
  assert.equal(retry.titleStatus, 'renamed')
  assert.equal(retry.firstMessage.status, 'accepted')
  assert.equal(adapter.createCalls.length, 1, 'the session is never rebuilt')
  assert.equal(adapter.renameCalls.length, 1)
  assert.equal(adapter.deliveries.length, 1)
})

// ---------------------------------------------------------------------------
// D. Crash recovery, retention, and strict journal validation
// ---------------------------------------------------------------------------

test('a sent journal survives a ledger reopen and still replays idempotently', async (t) => {
  const { adapter, engine, ledger, root } = await setup(t)
  const operationId = engine.mintOperation().operationId
  const args = { workspaceId: 'w-1', task: 'persist me' }
  const first = await engine.create(createArgs(operationId, args))
  assert.equal(first.phase, 'sent')
  await engine.dispose()
  await ledger.close()

  const reopened = new Ledger({ root, clock: () => 1_800_000_000_000 })
  await reopened.open()
  const journal = reopened.read().creates[`A|${operationId}`]
  assert.equal(journal.phase, 'sent')
  assert.equal(journal.bodyStripped, true)
  await reopened.close()
  assert.equal(adapter.createCalls.length, 1)
})

test('terminal create journals age out after 90 days while uncertain ones are never cleaned', async (t) => {
  const { clock, adapter, engine, ledger } = await setup(t)
  const sentOp = engine.mintOperation().operationId
  await engine.create(createArgs(sentOp, { workspaceId: 'w-1', task: 'old' }))
  await ledger.mutate((state) => {
    state.creates = {
      ...state.creates,
      ...journalFixture('A', 'slop:1:00000000-0000-4000-8000-0000000000aa', { phase: 'uncertain' }),
    }
    return true
  })
  clock.advance(91 * 24 * 60 * 60 * 1000)
  await engine.tick()
  const state = ledger.read()
  assert.equal(state.creates[`A|${sentOp}`], undefined, 'terminal journal pruned after 90 days')
  assert.ok(state.creates['A|slop:1:00000000-0000-4000-8000-0000000000aa'], 'uncertain journal is never cleaned')

  await assert.rejects(
    engine.create(createArgs(sentOp, { workspaceId: 'w-1', task: 'old' })),
    (error) => error.code === 'operation_expired',
    'a pruned operationId must not revive',
  )
  assert.equal(adapter.createCalls.length, 1)
})

test('the create journal region rejects unknown fields, bad phases, and missing fields on load', async (t) => {
  const base = {
    version: 3,
    revision: 1,
    settingsRevision: 1,
    createdAt: 1,
    updatedAt: 1,
    settings: createDefaultSettings(),
    messages: [],
    chains: {},
    operations: {},
  }
  const record = Object.values(journalFixture('A', 'slop:1:x'))[0]
  const cases = [
    // unknown top-level field inside the record
    { 'A|slop:1:x': { ...record, bogus: 1 } },
    // invalid phase
    { 'A|slop:1:x': { ...record, phase: 'invented' } },
    // missing required field
    (() => {
      const { sendOperationId, ...rest } = record
      void sendOperationId
      return { 'A|slop:1:x': rest }
    })(),
    // key mismatch
    { 'A|slop:1:x': { ...record, key: 'other' } },
    // invalid rename status
    { 'A|slop:1:x': { ...record, renameStatus: 'whatever' } },
    // unknown field inside location
    { 'A|slop:1:x': { ...record, location: { ...record.location, escape: '/etc' } } },
  ]
  for (const creates of cases) {
    const root = await tempRoot()
    await fs.writeFile(path.join(root, 'ledger.json'), JSON.stringify({ ...base, creates }), { mode: 0o600 })
    const ledger = new Ledger({ root, clock: () => 1 })
    await assert.rejects(ledger.open(), (error) => error.code === 'storage_corrupt')
    await fs.rm(root, { recursive: true, force: true })
  }
  // A well-formed journal region loads.
  const root = await tempRoot()
  await fs.writeFile(path.join(root, 'ledger.json'), JSON.stringify({ ...base, creates: journalFixture('A', 'slop:1:x') }), {
    mode: 0o600,
  })
  const ledger = new Ledger({ root, clock: () => 1 })
  await ledger.open()
  assert.ok(ledger.read().creates['A|slop:1:x'])
  await ledger.close()
  await fs.rm(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// E. Subject: fingerprint compatibility, views, envelopes
// ---------------------------------------------------------------------------

test('a call without subject keeps the exact 0.3 fingerprint bytes', () => {
  const legacy = JSON.stringify({
    kind: 'notification',
    text: 'hello',
    references: [],
    paths: [],
    parentMessageId: null,
    targets: ['B'],
  })
  const computed = callFingerprint({
    kind: 'notification',
    text: 'hello',
    references: [],
    paths: [],
    parentMessageId: null,
    targets: ['B'],
    subject: undefined,
  })
  assert.equal(computed, legacy)
  const withSubject = callFingerprint({
    kind: 'notification',
    text: 'hello',
    references: [],
    paths: [],
    parentMessageId: null,
    targets: ['B'],
    subject: 'topic',
  })
  assert.equal(withSubject, `${legacy.slice(0, -1)},"subject":"topic"}`)
})

test('new sends store a sealed fingerprint while legacy raw records still replay byte-exactly', async (t) => {
  const { engine, ledger } = await setup(t)
  const operationId = engine.mintOperation().operationId
  const text = 'first line\nsecond line'
  await engine.send({ from: 'A', targets: ['B'], kind: 'notification', text, operationId })
  const stored = Object.values(ledger.read().operations)[0]
  const canonical = JSON.stringify({
    kind: 'notification',
    text,
    references: [],
    paths: [],
    parentMessageId: null,
    targets: ['B'],
  })
  // New records persist only the sealed hash, never the plaintext canonical.
  assert.match(stored.fingerprint, /^s2:[0-9a-f]{64}$/)
  assert.equal(fingerprintMatches(stored.fingerprint, canonical), true)
  // Simulated0.3 read:0.3 compares raw !== stored, which must be a conflict
  // under its own rules (this is why0.4 ->0.3 downgrade blocks on s2 ops).
  assert.notEqual(stored.fingerprint, canonical)

  const status = await engine.status({ from: 'B' })
  assert.equal(status.messages[0].subject, 'first line')

  // Legacy raw record: same call replays idempotently, changed content conflicts.
  const legacyOp = engine.mintOperation().operationId
  const legacyCanonical = JSON.stringify({
    kind: 'notification',
    text: 'legacy body',
    references: [],
    paths: [],
    parentMessageId: null,
    targets: ['B'],
  })
  await engine.send({ from: 'A', targets: ['B'], kind: 'notification', text: 'legacy body', operationId: legacyOp })
  await ledger.mutate((state) => {
    for (const operation of Object.values(state.operations)) {
      if (operation.operationId === legacyOp) operation.fingerprint = legacyCanonical
    }
    return true
  })
  const replay = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'legacy body',
    operationId: legacyOp,
  })
  assert.equal(replay.idempotent, true)
  await assert.rejects(
    engine.send({ from: 'A', targets: ['B'], kind: 'notification', text: 'changed', operationId: legacyOp }),
    (error) => error.code === 'conflict_operation',
  )
})

test('subject is single-line, bounded, counted in the content envelope, and flows to views', async (t) => {
  const { engine, adapter } = await setup(t)
  await assert.rejects(
    engine.send({
      from: 'A',
      targets: ['B'],
      kind: 'notification',
      text: 'x',
      subject: 'line1\nline2',
      operationId: engine.mintOperation().operationId,
    }),
    (error) => error.code === 'invalid_argument',
  )
  const big = 't'.repeat(LIMITS.MAX_CONTENT_BYTES - 50)
  await assert.rejects(
    engine.send({
      from: 'A',
      targets: ['B'],
      kind: 'notification',
      text: big,
      subject: 's'.repeat(200),
      operationId: engine.mintOperation().operationId,
    }),
    (error) => error.code === 'invalid_argument',
  )

  const operationId = engine.mintOperation().operationId
  await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'body text',
    subject: 'the topic',
    operationId,
  })
  const snapshot = await engine.snapshot({})
  const message = snapshot.messages.find((entry) => entry.operationId === operationId)
  assert.equal(message.subject, 'the topic')
  assert.match(adapter.built.get('host-msg-1').rendered, /subject: the topic/)

  // No independent subject quota: a long single-line subject is accepted and
  // preserved in full; only the shared content envelope bounds it.
  const longSubject = 's'.repeat(201)
  const longOp = engine.mintOperation().operationId
  await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'notification',
    text: 'long subject carrier',
    subject: longSubject,
    operationId: longOp,
  })
  const longView = (await engine.status({ from: 'B' })).messages.find((entry) => entry.operationId === longOp)
  assert.equal(longView.subject, longSubject)
  assert.equal(longView.subject.length, 201)
})

test('create shares the 64 KiB content envelope between task and subject before any effect', async (t) => {
  const { adapter, engine, ledger, parent } = await setup(t)
  const nearFullTask = 't'.repeat(LIMITS.MAX_CONTENT_BYTES - 100)
  await assert.rejects(
    engine.create(
      createArgs(engine.mintOperation().operationId, {
        newProject: { parentDir: parent, directoryName: 'envelope' },
        task: nearFullTask,
        subject: 's'.repeat(100),
      }),
    ),
    (error) => error.code === 'invalid_argument',
  )
  assert.equal(adapter.createCalls.length, 0, 'an envelope overflow has no side effects')
  assert.equal(ledger.read().creates, undefined, 'an envelope overflow writes no journal')

  // The same near-full task without an oversized subject, and a long subject
  // with a short task, are both accepted.
  const acceptedOp = engine.mintOperation().operationId
  const result = await engine.create(
    createArgs(acceptedOp, { workspaceId: 'w-1', task: 'short task', subject: 'x'.repeat(500) }),
  )
  assert.equal(result.phase, 'sent')
  assert.equal(result.firstMessage.status, 'accepted')
  const view = (await engine.status({ from: result.sessionId })).messages.find(
    (entry) => entry.operationId === result.sendOperationId,
  )
  assert.ok(view, 'the first message is visible for its session')
  assert.equal(view.subject.length, 500)
})

// ---------------------------------------------------------------------------
// F. card_lookup
// ---------------------------------------------------------------------------

test('card_lookup returns only minimal participant fields and honest missing entries', async (t) => {
  const { engine } = await setup(t)
  const operationId = engine.mintOperation().operationId
  const sent = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'do it',
    subject: 'card topic',
    operationId,
  })
  const messageId = sent.results[0].id
  const message = engine.inspect(messageId).message
  const durableId = message.durableMessageId
  assert.ok(durableId)

  const found = engine.cardLookup({ sessionId: 'B', ids: [messageId, durableId, 'no-such-id'] })
  assert.deepEqual(found.missing, ['no-such-id'])
  assert.equal(found.results.length, 1)
  assert.deepEqual(Object.keys(found.results[0]).sort(), [
    'chainId',
    'durableMessageId',
    'from',
    'fromTitle',
    'id',
    'kind',
    'parentMessageId',
    'receipt',
    'replyStatus',
    'status',
    'subject',
    'to',
    'toTitle',
  ])
  assert.equal(found.results[0].subject, 'card topic')
  assert.equal(found.results[0].from, 'A')
  assert.equal(found.results[0].to, 'B')

  // Non-participant session sees nothing for this message.
  const outsider = engine.cardLookup({ sessionId: 'C', ids: [messageId] })
  assert.deepEqual(outsider.results, [])
  assert.deepEqual(outsider.missing, [messageId])

  assert.throws(() => engine.cardLookup({ sessionId: 'B', ids: [] }), (error) => error.code === 'invalid_argument')
  assert.throws(
    () =>
      engine.cardLookup({
        sessionId: 'B',
        ids: Array.from({ length: LIMITS.MAX_CARD_LOOKUP_IDS + 1 }, (_, i) => `id-${i}`),
      }),
    (error) => error.code === 'invalid_argument',
  )
  assert.throws(
    () => engine.cardLookup({ sessionId: 'B', ids: [messageId], extra: 1 }),
    (error) => ['invalid_argument', 'tool_args'].includes(error.code),
  )
})

// ---------------------------------------------------------------------------
// G. list scope=workspaces
// ---------------------------------------------------------------------------

test('list scope=workspaces discovers empty workspaces without changing the sessions shape', async (t) => {
  const dirA = await tempDir('v04-wa-')
  const dirB = await tempDir('v04-wb-')
  t.after(async () => {
    await fs.rm(dirA, { recursive: true, force: true })
    await fs.rm(dirB, { recursive: true, force: true })
  })
  const { engine } = await setup(t, {
    workspaces: [
      { id: 'w-1', title: 'Alpha WS', path: dirA, sessionIds: ['A'] },
      { id: 'w-2', title: 'Empty WS', path: dirB, sessionIds: [] },
    ],
  })
  const all = await engine.list({ scope: 'workspaces' })
  assert.deepEqual(all.workspaces.map((workspace) => workspace.id), ['w-1', 'w-2'])
  assert.deepEqual(Object.keys(all.workspaces[0]).sort(), ['id', 'path', 'title'])
  assert.equal(all.total, 2)
  assert.equal(all.nextCursor, null)
  assert.equal(all.sessions, undefined)

  const filtered = await engine.list({ scope: 'workspaces', query: 'Empty' })
  assert.deepEqual(filtered.workspaces.map((workspace) => workspace.id), ['w-2'])

  const paged = await engine.list({ scope: 'workspaces', limit: 1 })
  assert.equal(paged.workspaces.length, 1)
  assert.ok(paged.nextCursor)
  const next = await engine.list({ scope: 'workspaces', limit: 1, cursor: paged.nextCursor })
  assert.deepEqual(next.workspaces.map((workspace) => workspace.id), ['w-2'])

  // Legacy sessions scope is unchanged.
  const sessions = await engine.list({})
  assert.ok(Array.isArray(sessions.sessions))
  assert.equal(sessions.workspaces, undefined)

  await assert.rejects(engine.list({ scope: 'bogus' }), (error) => error.code === 'invalid_argument')
  await assert.rejects(
    engine.list({ scope: 'workspaces', workspace: 'Alpha' }),
    (error) => error.code === 'invalid_argument',
  )
})

// ---------------------------------------------------------------------------
// H. Concurrent fingerprint conflict, failed/unknown first-message handling
// ---------------------------------------------------------------------------

test('concurrent same operationId with different inputs conflicts and only one session is created', async (t) => {
  const { adapter, engine } = await setup(t)
  let release
  adapter.createHooks.createSessionDelay = new Promise((resolve) => {
    release = resolve
  })
  const operationId = engine.mintOperation().operationId
  const first = engine.create(createArgs(operationId, { workspaceId: 'w-1', task: 'original task' }))
  const started = Date.now()
  while (adapter.createCalls.length < 1) {
    if (Date.now() - started > 5000) throw new Error('create never reached the host')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  await assert.rejects(
    engine.create(createArgs(operationId, { workspaceId: 'w-1', task: 'different task' })),
    (error) => error.code === 'conflict_operation',
  )
  release()
  const result = await first
  assert.equal(result.phase, 'sent')
  assert.equal(adapter.createCalls.length, 1)
  assert.equal(adapter.deliveries.length, 1)
})

test('a failed first message is re-sent to the same session only on explicit same-operation retry', async (t) => {
  const { adapter, engine, ledger } = await setup(t)
  adapter.resolveError = 'agent_unavailable'
  const operationId = engine.mintOperation().operationId
  const args = { workspaceId: 'w-1', task: 'retry me', title: 'Retry' }
  const first = await engine.create(createArgs(operationId, args))
  assert.equal(first.phase, 'sending')
  assert.equal(first.firstMessage.status, 'failed')
  assert.equal(first.titleStatus, 'renamed', 'rename happened before the first send')
  const journalAfterFailure = ledger.read().creates[`A|${operationId}`]
  assert.equal(journalAfterFailure.task, 'retry me', 'the body stays for a proven-uninserted retry')
  assert.equal(journalAfterFailure.bodyStripped, false)
  const failedSendOperationId = journalAfterFailure.sendOperationId
  assert.ok(failedSendOperationId.startsWith('slop:'))

  // The host recovers; the SAME root operation continues to the SAME session.
  adapter.resolveError = undefined
  const retry = await engine.create(createArgs(operationId, args))
  assert.equal(retry.idempotent, true)
  assert.equal(retry.phase, 'sent')
  assert.equal(retry.sessionId, first.sessionId)
  assert.equal(retry.firstMessage.status, 'accepted')
  assert.equal(retry.error, null)
  const journalAfterRetry = ledger.read().creates[`A|${operationId}`]
  assert.notEqual(journalAfterRetry.sendOperationId, failedSendOperationId, 'a fresh persistent internal id after proven failure')
  assert.equal(journalAfterRetry.bodyStripped, true)
  assert.equal(adapter.createCalls.length, 1, 'no second session')
  assert.equal(adapter.renameCalls.length, 1, 'no second rename')
  assert.equal(adapter.deliveries.length, 2, 'one failed attempt plus one retry attempt')
  assert.equal(adapter.inserted.size, 1, 'exactly one durable insertion')
})

test('an unknown first message is never re-sent on retry and accepted never repeats', async (t) => {
  const { adapter, engine } = await setup(t)
  adapter.followupError = 'steer_failed'
  const unknownOp = engine.mintOperation().operationId
  const unknownArgs = { workspaceId: 'w-1', task: 'maybe delivered', title: 'Unknown' }
  const first = await engine.create(createArgs(unknownOp, unknownArgs))
  assert.equal(first.phase, 'sent')
  assert.equal(first.firstMessage.status, 'unknown')
  assert.equal(first.error, null)
  adapter.followupError = undefined

  const retry = await engine.create(createArgs(unknownOp, unknownArgs))
  assert.equal(retry.idempotent, true)
  assert.equal(retry.firstMessage.status, 'unknown')
  assert.equal(adapter.deliveries.length, 1, 'unknown is never re-sent')
  assert.equal(adapter.createCalls.length, 1)

  // Accepted path: a plain retry replays without a second delivery.
  const acceptedOp = engine.mintOperation().operationId
  const acceptedArgs = { workspaceId: 'w-1', task: 'accepted once', title: 'Accepted' }
  await engine.create(createArgs(acceptedOp, acceptedArgs))
  const deliveriesAfterAccept = adapter.deliveries.length
  const again = await engine.create(createArgs(acceptedOp, acceptedArgs))
  assert.equal(again.idempotent, true)
  assert.equal(again.firstMessage.status, 'accepted')
  assert.equal(adapter.deliveries.length, deliveriesAfterAccept, 'accepted is never repeated')
})

// ---------------------------------------------------------------------------
// I. Queue capacity: reservation, subjects, unfinished journals, dedupe
// ---------------------------------------------------------------------------

test('the create reservation lets a half-full queue transfer exactly once', async (t) => {
  const { adapter, engine, ledger } = await setup(t, { limits: { maxQueuedBytes: 1500 } })
  const operationId = engine.mintOperation().operationId
  const task = 'a'.repeat(1000)
  const args = { workspaceId: 'w-1', task, title: 'Half' }
  const fingerprint = createFingerprint({
    task,
    targets: ['A'],
    workspaceId: 'w-1',
    parentDir: null,
    directoryName: null,
    workspaceTitle: null,
    title: 'Half',
  })
  await ledger.mutate((state) => {
    state.creates = journalFixture('A', operationId, {
      fingerprint,
      phase: 'created',
      sessionId: 'B',
      title: 'Half',
      task,
      sendOperationId: 'slop:1800000000000:00000000-0000-4000-8000-000000000003',
    })
    return true
  })

  // The reservation id with a mismatched payload conflicts before capacity.
  await assert.rejects(
    engine.send({
      from: 'A',
      targets: ['B'],
      kind: 'request',
      text: 'not the reserved task',
      operationId: 'slop:1800000000000:00000000-0000-4000-8000-000000000003',
    }),
    (error) => error.code === 'conflict_operation',
  )
  // The same payload under a different operationId gets no reservation discount.
  await assert.rejects(
    engine.send({
      from: 'A',
      targets: ['B'],
      kind: 'request',
      text: task,
      operationId: engine.mintOperation().operationId,
    }),
    (error) => error.code === 'queue_full',
  )

  // Half-full transfer succeeds: journal1000 + message 1039 would exceed 1500
  // without the exact-match reservation subtraction.
  const result = await engine.create(createArgs(operationId, args))
  assert.equal(result.phase, 'sent')
  assert.equal(result.firstMessage.status, 'accepted')
  const message = ledger.read().messages.find((candidate) => candidate.id === result.firstMessage.id)
  assert.equal(message.status, 'accepted')
  const journalAfter = ledger.read().creates[`A|${operationId}`]
  assert.equal(journalAfter.bodyStripped, true, 'the transferred journal no longer carries the body')
  const snapshot = await engine.snapshot({})
  // Delivered message + stripped journal: nothing undelivered remains, so the
  // envelope shows zero residue instead of a double charge.
  assert.equal(snapshot.storage.queuedBytes, 0)
  assert.ok(message.contentBytes <= 1500)
  assert.equal(adapter.createCalls.length, 0, 'the resumed journal never re-creates the session')
  assert.equal(adapter.renameCalls.length, 1)
  assert.equal(adapter.deliveries.length, 1)
})

test('unfinished create bodies share the queue and the next intent fails before persisting', async (t) => {
  const { adapter, engine, ledger } = await setup(t, { limits: { maxQueuedBytes: 2500 } })
  adapter.createHooks.durableResult = { ok: false, code: 'flush_unconfirmed', message: 'no flush' }
  const first = await engine.create(
    createArgs(engine.mintOperation().operationId, { workspaceId: 'w-1', task: 'x'.repeat(1000), title: 'One' }),
  )
  assert.equal(first.phase, 'created', 'barrier failed, body retained')
  await engine.create(
    createArgs(engine.mintOperation().operationId, { workspaceId: 'w-1', task: 'y'.repeat(1000), title: 'Two' }),
  )
  assert.equal(Object.keys(ledger.read().creates).length, 2)
  const beforeCalls = adapter.createCalls.length
  await assert.rejects(
    engine.create(
      createArgs(engine.mintOperation().operationId, { workspaceId: 'w-1', task: 'z'.repeat(1000), title: 'Three' }),
    ),
    (error) => error.code === 'queue_full',
  )
  assert.equal(Object.keys(ledger.read().creates).length, 2, 'the intent is rejected before it persists')
  assert.equal(adapter.createCalls.length, beforeCalls, 'and before any host effect')
})

test('a held message counts its subject while subject-less payloads keep the old bytes', async (t) => {
  const { engine, ledger } = await setup(t, { limits: { maxQueuedBytes: 100000 } })
  await engine.updateSettings({ expectedSettingsRevision: 1, patch: { paused: true } })
  const plainOp = engine.mintOperation().operationId
  await engine.send({ from: 'A', targets: ['B'], kind: 'notification', text: 't'.repeat(40), operationId: plainOp })
  const plain = ledger.read().messages.find((message) => message.operationId === plainOp)
  assert.equal(plain.status, 'held')
  const snapshotBefore = await engine.snapshot({})
  assert.equal(snapshotBefore.storage.queuedBytes, plain.contentBytes, 'subject-less rows keep exact0.3 bytes')

  // Reopen the queue so only the subject delta decides.
  await engine.updateSettings({ expectedSettingsRevision: 2, patch: { paused: false } })
  const root = await tempRoot()
  const clock = new FakeClock()
  const limit = plain.contentBytes + 1
  const adapter = new MemoryAdapter({ clock })
  const small = await openEngine({ root, adapter, clock, limits: { maxQueuedBytes: limit } })
  t.after(async () => {
    await small.engine.dispose()
    await small.ledger.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  await small.engine.updateSettings({ expectedSettingsRevision: 1, patch: { paused: true } })
  await small.engine.send({ from: 'A', targets: ['B'], kind: 'notification', text: 't'.repeat(40), operationId: plainOp })
  await assert.rejects(
    small.engine.send({
      from: 'A',
      targets: ['B'],
      kind: 'notification',
      text: 't'.repeat(40),
      subject: 's'.repeat(30),
      operationId: small.engine.mintOperation().operationId,
    }),
    (error) => error.code === 'queue_full',
    'subject bytes count toward the same queue envelope',
  )
  assert.equal(small.ledger.read().messages.length, 1, 'the rejected subject send persisted nothing')
})

test('an unstripped journal is deduplicated only behind an ACTIVE message', async (t) => {
  const { adapter, engine, ledger } = await setup(t)
  // ACTIVE match: held message + unstripped journal share one payload.
  await engine.updateSettings({ expectedSettingsRevision: 1, patch: { paused: true } })
  const activeOp = engine.mintOperation().operationId
  await engine.send({ from: 'A', targets: ['B'], kind: 'request', text: 'held body', operationId: activeOp })
  const held = ledger.read().messages.find((message) => message.operationId === activeOp)
  assert.equal(held.status, 'held')
  await ledger.mutate((state) => {
    state.creates = {
      ...state.creates,
      ...journalFixture('A', 'slop:1:00000000-0000-4000-8000-0000000000a1', {
        phase: 'sending',
        firstMessageId: null,
        sendOperationId: activeOp,
        task: 'held body',
        subject: null,
      }),
    }
    return true
  })
  const snapshot = await engine.snapshot({})
  assert.equal(snapshot.storage.queuedBytes, held.contentBytes, 'ACTIVE match deduplicates the journal body')

  // A failed (non-active) match must not swallow the retained journal body.
  // Retire the held row first so only the failed pair is on the envelope.
  await engine.modelControl({ from: 'A', action: 'cancel', id: held.id })
  await engine.updateSettings({ expectedSettingsRevision: 2, patch: { paused: false } })
  adapter.resolveError = 'agent_unavailable'
  const failedOp = engine.mintOperation().operationId
  await engine.send({ from: 'A', targets: ['B'], kind: 'notification', text: 'failed body', operationId: failedOp })
  const failed = ledger.read().messages.find((message) => message.operationId === failedOp)
  assert.equal(failed.status, 'failed')
  const retained = 'failed body retained'
  await ledger.mutate((state) => {
    delete state.creates['A|slop:1:00000000-0000-4000-8000-0000000000a1']
    state.creates = {
      ...state.creates,
      ...journalFixture('A', 'slop:1:00000000-0000-4000-8000-0000000000a2', {
        phase: 'sending',
        firstMessageId: null,
        sendOperationId: failedOp,
        task: retained,
        subject: null,
      }),
    }
    return true
  })
  const snapshotAfter = await engine.snapshot({})
  assert.equal(
    snapshotAfter.storage.queuedBytes,
    Buffer.byteLength(retained, 'utf8'),
    'the failed message counts zero while the retained journal body still counts',
  )
})

// ---------------------------------------------------------------------------
// J. Read-only 0.4 -> 0.3 downgrade preflight
// ---------------------------------------------------------------------------

/** A complete, strictly valid legacy-shaped v3 ledger for preflight tests. */
function validLedgerState() {
  return {
    version: 3,
    revision: 7,
    settingsRevision: 2,
    createdAt: 100,
    updatedAt: 200,
    settings: createDefaultSettings(),
    messages: [
      {
        id: 'm1',
        from: 'A',
        to: 'B',
        kind: 'notification',
        chainId: 'c1',
        hop: 0,
        createdAt: 150,
        status: 'accepted',
        replyStatus: 'none',
        content: { text: 'legacy body', references: [], paths: [] },
        contentBytes: 30,
        receipt: {
          policy: 'legacy-accepted',
          state: 'uncertain',
          receivedAt: null,
          receivedSeq: null,
          timeoutMs: null,
          transfer: null,
        },
      },
    ],
    chains: { c1: { id: 'c1', rootOwner: 'A', createdAt: 150, state: 'open', messageCount: 1 } },
    operations: {
      'A|slop:1:x|B': {
        key: 'A|slop:1:x|B',
        from: 'A',
        operationId: 'slop:1:x',
        fingerprint:
          '{"kind":"notification","text":"legacy body","references":[],"paths":[],"parentMessageId":null,"targets":["B"]}',
        targets: ['B'],
        messageIds: { B: 'm1' },
        at: 160,
      },
    },
  }
}

test('v04DowngradePreflight blocks on creates, subjects, and sealed fingerprints', () => {
  const clean = validLedgerState()
  const ok = v04DowngradePreflight({ currentState: clean })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.reasons, [])
  assert.ok(Array.isArray(ok.notes) && ok.notes.length > 0)
  assert.match(ok.notes[0], /necessary condition/)
  assert.match(ok.notes[0], /not verified/)

  const withCreates = { ...validLedgerState(), creates: journalFixture('A', 'slop:1:x') }
  const createsResult = v04DowngradePreflight({ currentState: withCreates })
  assert.equal(createsResult.ok, false)
  assert.match(createsResult.reasons.join(' | '), /state\.creates/)

  const subjectLedger = validLedgerState()
  subjectLedger.messages.push({ ...subjectLedger.messages[0], id: 'm2', subject: 'topic' })
  const subjectResult = v04DowngradePreflight({ currentState: subjectLedger })
  assert.equal(subjectResult.ok, false)
  assert.match(subjectResult.reasons.join(' | '), /subject/)

  const sealLedger = validLedgerState()
  sealLedger.operations['A|slop:1:x|B'].fingerprint = 's2:deadbeef'
  const sealResult = v04DowngradePreflight({ currentState: sealLedger })
  assert.equal(sealResult.ok, false)
  assert.match(sealResult.reasons.join(' | '), /sealed s2/)

  const notV3 = v04DowngradePreflight({ currentState: { version: 2 } })
  assert.equal(notV3.ok, false)
  assert.match(notV3.reasons.join(' | '), /not a v3 ledger/)
})

test('v04DowngradePreflight fails closed on malformed ledgers and never mutates its input', () => {
  const legal = validLedgerState()
  const before = JSON.stringify(legal)
  const ok = v04DowngradePreflight({ currentState: legal })
  assert.equal(ok.ok, true)
  assert.match(ok.notes[0], /necessary condition/)
  assert.equal(JSON.stringify(legal), before, 'the input state is never mutated')

  // Wrong-typed or incomplete regions must fail validation first, never be
  // mistaken for "no0.4 constructs".
  const malformed = [
    { version: 3, creates: [], messages: 'bad', operations: null, settings: createDefaultSettings(), chains: {} },
    { version: 3, creates: 'bad', messages: [], operations: {}, settings: createDefaultSettings(), chains: {} },
    { version: 3, creates: null, messages: [], operations: {}, settings: createDefaultSettings(), chains: {} },
    { version: 3, messages: [], operations: {}, chains: {} },
    { version: 3, messages: [], operations: null, settings: createDefaultSettings(), chains: {} },
    { version: 3, messages: [], operations: {}, settings: createDefaultSettings(), chains: 'bad' },
    {
      version: 3,
      messages: [{ id: 'broken' }],
      operations: {},
      settings: createDefaultSettings(),
      chains: {},
    },
    { version: 99, messages: [], operations: {}, settings: createDefaultSettings(), chains: {} },
    { version: 3 },
    // incomplete but well-typed: missing revision / settings / chains must
    // still fail full-ledger validation, not pass as "empty collections"
    (() => {
      const state = validLedgerState()
      delete state.settings
      return state
    })(),
    (() => {
      const state = validLedgerState()
      delete state.chains
      return state
    })(),
    (() => {
      const state = validLedgerState()
      delete state.revision
      return state
    })(),
    (() => {
      const state = validLedgerState()
      state.revision = 0
      return state
    })(),
    (() => {
      const state = validLedgerState()
      state.revision = 'seven'
      return state
    })(),
    (() => {
      const state = validLedgerState()
      state.messages[0].status = 'invented'
      return state
    })(),
    (() => {
      const state = validLedgerState()
      state.chains.c1.state = 'invented'
      return state
    })(),
  ]
  for (const state of malformed) {
    const result = v04DowngradePreflight({ currentState: state })
    assert.equal(result.ok, false, `must fail closed: ${JSON.stringify(state).slice(0, 80)}`)
    assert.ok(result.reasons.length > 0)
    assert.equal(result.notes, undefined)
  }
})

// ---------------------------------------------------------------------------
// K. Cross-90-day journal retention (cold review BLOCK)
// ---------------------------------------------------------------------------

test('create journals for unknown and held first messages survive past 90 days without a resend', async (t) => {
  const { adapter, engine, ledger, clock } = await setup(t)

  // unknown root
  adapter.followupError = 'steer_failed'
  const unknownOp = engine.mintOperation().operationId
  const unknownArgs = { workspaceId: 'w-1', task: 'unknown root', title: 'UnknownRoot' }
  const unknownFirst = await engine.create(createArgs(unknownOp, unknownArgs))
  assert.equal(unknownFirst.phase, 'sent')
  assert.equal(unknownFirst.firstMessage.status, 'unknown')
  adapter.followupError = undefined

  // accepted root, made explicitly terminal by closing its chain
  const acceptedOp = engine.mintOperation().operationId
  const acceptedArgs = { workspaceId: 'w-1', task: 'accepted root', title: 'AcceptedRoot' }
  const acceptedFirst = await engine.create(createArgs(acceptedOp, acceptedArgs))
  const acceptedMessage = ledger.read().messages.find((m) => m.id === acceptedFirst.firstMessage.id)
  await engine.modelControl({ from: 'A', action: 'close', id: acceptedMessage.chainId })

  // held root: paused settings reject new creations, so it resumes an existing journal
  const heldOp = engine.mintOperation().operationId
  const heldTask = 'held root'
  const heldArgs = { workspaceId: 'w-1', task: heldTask, title: 'HeldRoot' }
  const heldFingerprint = createFingerprint({
    task: heldTask,
    targets: ['A'],
    workspaceId: 'w-1',
    parentDir: null,
    directoryName: null,
    workspaceTitle: null,
    title: 'HeldRoot',
  })
  await ledger.mutate((state) => {
    state.creates = {
      ...state.creates,
      ...journalFixture('A', heldOp, {
        fingerprint: heldFingerprint,
        phase: 'created',
        sessionId: 'B',
        title: 'HeldRoot',
        task: heldTask,
        sendOperationId: 'slop:1800000000000:00000000-0000-4000-8000-000000000005',
      }),
    }
    return true
  })
  await engine.updateSettings({ expectedSettingsRevision: 1, patch: { paused: true } })
  const heldFirst = await engine.create(createArgs(heldOp, heldArgs))
  assert.equal(heldFirst.phase, 'sent')
  assert.equal(heldFirst.firstMessage.status, 'held')

  clock.advance(91 * 24 * 60 * 60 * 1000)
  await engine.tick()
  const state = ledger.read()
  assert.ok(state.creates[`A|${unknownOp}`], 'unknown root journal survives past 90 days')
  assert.ok(state.creates[`A|${heldOp}`], 'held root journal survives past 90 days')
  assert.equal(state.creates[`A|${acceptedOp}`], undefined, 'explicitly terminal root prunes per retention')
  assert.ok(state.messages.some((m) => m.status === 'unknown'), 'the unknown message itself is kept')
  assert.ok(
    state.messages.some((m) => m.id === heldFirst.firstMessage.id),
    'the held message itself is kept',
  )

  // Same-root replay keeps the association and never resends.
  const deliveriesBefore = adapter.deliveries.length
  const unknownReplay = await engine.create(createArgs(unknownOp, unknownArgs))
  assert.equal(unknownReplay.idempotent, true)
  assert.equal(unknownReplay.phase, 'sent')
  assert.equal(unknownReplay.firstMessage.status, 'unknown')
  const heldReplay = await engine.create(createArgs(heldOp, heldArgs))
  assert.equal(heldReplay.idempotent, true)
  assert.equal(heldReplay.firstMessage.status, 'held')
  assert.equal(adapter.deliveries.length, deliveriesBefore, 'no resend for unknown or held roots')

  // The pruned accepted root cannot revive.
  await assert.rejects(
    engine.create(createArgs(acceptedOp, acceptedArgs)),
    (error) => error.code === 'operation_expired',
  )
})

test('a journal ages from its message completedAt, not from the earlier root terminalAt', async (t) => {
  const { engine, ledger, clock } = await setup(t)
  const operationId = engine.mintOperation().operationId
  const args = { workspaceId: 'w-1', task: 'late completion', title: 'Late' }
  const first = await engine.create(createArgs(operationId, args))
  const message = ledger.read().messages.find((m) => m.id === first.firstMessage.id)

  // Complete the message at day 50; the root terminalAt stays at day 0.
  clock.advance(50 * 24 * 60 * 60 * 1000)
  await engine.modelControl({ from: 'A', action: 'close', id: message.chainId })

  // Day 91: the old terminalAt anchor would already prune, but the message
  // completedAt (day 50) has not reached its own 90-day window yet.
  clock.advance(41 * 24 * 60 * 60 * 1000)
  await engine.tick()
  assert.ok(ledger.read().creates[`A|${operationId}`], 'journal kept until completedAt ages')
  assert.ok(
    ledger.read().messages.some((m) => m.id === first.firstMessage.id),
    'message kept in the same window',
  )

  // Day 142: completedAt (day 50) + 90 days passed — message and journal are
  // cleaned in the same round using the same-round verified terminal map.
  clock.advance(51 * 24 * 60 * 60 * 1000)
  await engine.tick()
  assert.equal(ledger.read().creates[`A|${operationId}`], undefined, 'journal pruned after its own window')
  assert.equal(
    ledger.read().messages.some((m) => m.id === first.firstMessage.id),
    false,
    'message pruned in the same round',
  )
})

test('an explicitly terminal root and its message are both cleaned after a full 90 days', async (t) => {
  const { engine, ledger, clock } = await setup(t)
  const operationId = engine.mintOperation().operationId
  const args = { workspaceId: 'w-1', task: 'finish me', title: 'Finished' }
  const first = await engine.create(createArgs(operationId, args))
  const message = ledger.read().messages.find((m) => m.id === first.firstMessage.id)
  await engine.modelControl({ from: 'A', action: 'close', id: message.chainId })

  clock.advance(91 * 24 * 60 * 60 * 1000)
  await engine.tick()
  const state = ledger.read()
  assert.equal(state.creates[`A|${operationId}`], undefined, 'journal cleaned with its terminal message')
  assert.equal(
    state.messages.some((m) => m.id === first.firstMessage.id),
    false,
    'message cleaned in the same round',
    )
})

test('a journal whose first message is missing fails closed: kept and flagged for review', async (t) => {
  const { engine, ledger, clock } = await setup(t)
  const operationId = engine.mintOperation().operationId
  const agedTerminalAt = clock.read() - 91 * 24 * 60 * 60 * 1000
  await ledger.mutate((state) => {
    state.creates = {
      ...state.creates,
      ...journalFixture('A', operationId, {
        phase: 'sent',
        firstMessageId: 'msg-does-not-exist',
        terminalAt: agedTerminalAt,
        bodyStripped: true,
        task: '',
      }),
    }
    return true
  })
  await engine.tick()
  let journal = ledger.read().creates[`A|${operationId}`]
  assert.ok(journal, 'fail-closed: never pruned without verified evidence')
  assert.equal(journal.error?.code, 'first_message_evidence_missing')

  // Even far beyond the window it stays: historical absence is never treated
  // as same-round verified completion.
  clock.advance(180 * 24 * 60 * 60 * 1000)
  await engine.tick()
  journal = ledger.read().creates[`A|${operationId}`]
  assert.ok(journal, 'still kept after another half year')
  assert.equal(journal.error?.code, 'first_message_evidence_missing')
})

test('a waiting request timing out across one 91-day jump cleans message and journal in the same round', async (t) => {
  const { engine, ledger, clock } = await setup(t)
  const operationId = engine.mintOperation().operationId
  const first = await engine.create(
    createArgs(operationId, { workspaceId: 'w-1', task: 'await reply', title: 'Waiter' }),
  )
  assert.equal(first.firstMessage.status, 'accepted')

  // One jump past the reply deadline and both 90-day windows: the timeout
  // loop completes the request in this very round, the message is pruned in
  // this round, and the journal must be verified and cleaned with it instead
  // of failing closed forever.
  clock.advance(91 * 24 * 60 * 60 * 1000)
  await engine.tick()
  const state = ledger.read()
  assert.equal(state.creates[`A|${operationId}`], undefined, 'journal cleaned in the timeout round')
  assert.equal(
    state.messages.some((m) => m.id === first.firstMessage.id),
    false,
    'message cleaned in the same round',
  )
})

// ---------------------------------------------------------------------------
// L. card_lookup includeBody (B UI read-only support)
// ---------------------------------------------------------------------------

test('card_lookup includeBody grants verified inbound business text only', async (t) => {
  const { engine, ledger } = await setup(t)
  const operationId = engine.mintOperation().operationId
  const scripty = 'do <script>alert(1)</script> ${x} \u0000 untouched'
  const sent = await engine.send({ from: 'A', targets: ['B'], kind: 'request', text: scripty, operationId })
  const messageId = sent.results[0].id
  const durableId = engine.inspect(messageId).message.durableMessageId
  assert.ok(durableId)

  // Default shape: no body fields at all (full0.3/A compatibility).
  const plain = engine.cardLookup({ sessionId: 'B', ids: [durableId] })
  assert.equal('body' in plain.results[0], false)
  assert.equal('bodyState' in plain.results[0], false)
  const explicitFalse = engine.cardLookup({ sessionId: 'B', ids: [durableId], includeBody: false })
  assert.equal('body' in explicitFalse.results[0], false)

  // Granted: recipient + exact durable host id → raw business text verbatim.
  const granted = engine.cardLookup({ sessionId: 'B', ids: [durableId], includeBody: true })
  assert.equal(granted.results.length, 1)
  assert.equal(granted.results[0].body, scripty)
  assert.equal(granted.results[0].bodyState, 'available')
  assert.equal(granted.results[0].status, 'accepted')

  // Plugin id request: metadata stays, body is withheld.
  const viaPluginId = engine.cardLookup({ sessionId: 'B', ids: [messageId], includeBody: true })
  assert.equal(viaPluginId.results.length, 1)
  assert.equal('body' in viaPluginId.results[0], false)

  // Same-session sender is a participant but never gets the inbound body.
  const fromSender = engine.cardLookup({ sessionId: 'A', ids: [durableId], includeBody: true })
  assert.equal(fromSender.results.length, 1)
  assert.equal('body' in fromSender.results[0], false)

  // A non-participant session still gets honest missing, never another record.
  const outsider = engine.cardLookup({ sessionId: 'C', ids: [durableId], includeBody: true })
  assert.deepEqual(outsider.results, [])
  assert.deepEqual(outsider.missing, [durableId])

  // includeBody is strictly boolean; other keys stay rejected.
  for (const bad of ['true', 1, null, {}]) {
    assert.throws(
      () => engine.cardLookup({ sessionId: 'B', ids: [durableId], includeBody: bad }),
      (error) => error.code === 'invalid_argument',
      `includeBody=${JSON.stringify(bad)}`,
    )
  }
  assert.throws(
    () => engine.cardLookup({ sessionId: 'B', ids: [durableId], includeBody: true, extra: 1 }),
    (error) => ['invalid_argument', 'tool_args'].includes(error.code),
  )

  // A redacted message never leaks its text.
  await ledger.mutate((state) => {
    const message = state.messages.find((candidate) => candidate.id === messageId)
    message.content = { text: '', references: [], paths: [] }
    message.contentBytes = 2
    message.redactedAt = 1_800_000_000_000
    return true
  })
  const redacted = engine.cardLookup({ sessionId: 'B', ids: [durableId], includeBody: true })
  assert.equal(redacted.results.length, 1)
  assert.equal(redacted.results[0].body, null)
  assert.equal(redacted.results[0].bodyState, 'redacted')
  assert.equal(redacted.results[0].status, 'accepted')
})

test('card_lookup includeBody withholds the body for messages that have no durable id', async (t) => {
  const { engine, ledger } = await setup(t)
  await ledger.mutate((state) => {
    state.creates = state.creates ?? {}
    const message = {
      id: 'no-durable',
      from: 'A',
      to: 'B',
      kind: 'notification',
      chainId: 'c-x',
      hop: 0,
      createdAt: 1_800_000_000_000,
      status: 'pending',
      replyStatus: 'none',
      content: { text: 'never inserted', references: [], paths: [] },
      contentBytes: 20,
      durableMessageId: null,
      receipt: {
        policy: 'legacy-accepted',
        state: 'uncertain',
        receivedAt: null,
        receivedSeq: null,
        timeoutMs: null,
        transfer: null,
      },
    }
    state.chains['c-x'] = { id: 'c-x', rootOwner: 'A', createdAt: 1_800_000_000_000, state: 'open', messageCount: 1 }
    state.messages.push(message)
    return true
  })
  const found = engine.cardLookup({ sessionId: 'B', ids: ['no-durable'], includeBody: true })
  assert.equal(found.results.length, 1)
  assert.equal('body' in found.results[0], false, 'no durable id means no granted body')
  assert.equal(found.results[0].durableMessageId, null)
})

test('card_lookup includeBody is order-independent for mixed plugin/durable id requests', async (t) => {
  const { engine } = await setup(t)
  const operationId = engine.mintOperation().operationId
  const text = 'verified inbound body'
  const sent = await engine.send({ from: 'A', targets: ['B'], kind: 'request', text, operationId })
  const messageId = sent.results[0].id
  const durableId = engine.inspect(messageId).message.durableMessageId
  assert.ok(durableId)
  assert.notEqual(messageId, durableId)

  // Both orders produce exactly one card with the same granted body.
  const pluginFirst = engine.cardLookup({ sessionId: 'B', ids: [messageId, durableId], includeBody: true })
  const durableFirst = engine.cardLookup({ sessionId: 'B', ids: [durableId, messageId], includeBody: true })
  assert.equal(pluginFirst.results.length, 1, 'one card, no duplicates')
  assert.equal(durableFirst.results.length, 1, 'one card, no duplicates')
  assert.deepEqual(pluginFirst, durableFirst, 'order must not change the response')
  assert.equal(pluginFirst.results[0].body, text)
  assert.equal(pluginFirst.results[0].bodyState, 'available')
  assert.deepEqual(pluginFirst.missing, [])

  // Repeated ids stay one card and keep the body.
  const repeated = engine.cardLookup({
    sessionId: 'B',
    ids: [messageId, durableId, messageId],
    includeBody: true,
  })
  assert.equal(repeated.results.length, 1)
  assert.equal(repeated.results[0].body, text)

  // Plugin id alone is conservative: metadata only, in either order context.
  const pluginOnly = engine.cardLookup({ sessionId: 'B', ids: [messageId], includeBody: true })
  assert.equal(pluginOnly.results.length, 1)
  assert.equal('body' in pluginOnly.results[0], false)

  // The sender side never gains a body from either ordering.
  const senderMixed = engine.cardLookup({ sessionId: 'A', ids: [durableId, messageId], includeBody: true })
  assert.equal(senderMixed.results.length, 1)
  assert.equal('body' in senderMixed.results[0], false)
  const senderReversed = engine.cardLookup({ sessionId: 'A', ids: [messageId, durableId], includeBody: true })
  assert.equal(senderReversed.results.length, 1)
  assert.equal('body' in senderReversed.results[0], false)
  assert.deepEqual(senderMixed, senderReversed)
})

test('card_lookup withholds the unknown first-message body until evidence accepts it', async (t) => {
  const { adapter, engine, ledger } = await setup(t)
  adapter.followupError = 'steer_failed'
  const operationId = engine.mintOperation().operationId
  const sent = await engine.send({
    from: 'A',
    targets: ['B'],
    kind: 'request',
    text: 'unconfirmed body',
    operationId,
  })
  adapter.followupError = undefined
  const messageId = sent.results[0].id
  const unknown = ledger.read().messages.find((m) => m.id === messageId)
  assert.equal(unknown.status, 'unknown')
  assert.ok(
    typeof unknown.durableMessageId === 'string' && unknown.durableMessageId.length > 0,
    'dispatch already recorded a durable id',
  )
  const durableId = unknown.durableMessageId

  // Recipient + exact durable id, but the delivery is unknown: metadata only.
  const withheld = engine.cardLookup({ sessionId: 'B', ids: [durableId], includeBody: true })
  assert.equal(withheld.results.length, 1)
  assert.equal(withheld.results[0].status, 'unknown')
  assert.equal('body' in withheld.results[0], false)
  assert.equal('bodyState' in withheld.results[0], false)

  // Same request with mixed ids stays conservative in both orders.
  const mixed = engine.cardLookup({ sessionId: 'B', ids: [messageId, durableId], includeBody: true })
  assert.equal(mixed.results.length, 1)
  assert.equal('body' in mixed.results[0], false)

  // After real evidence accepts the message, the verified body is granted.
  await ledger.mutate((state) => {
    const message = state.messages.find((m) => m.id === messageId)
    message.status = 'accepted'
    message.acceptedAt = 1_800_000_000_001
    return true
  })
  const accepted = engine.cardLookup({ sessionId: 'B', ids: [durableId], includeBody: true })
  assert.equal(accepted.results.length, 1)
  assert.equal(accepted.results[0].status, 'accepted')
  assert.equal(accepted.results[0].body, 'unconfirmed body')
  assert.equal(accepted.results[0].bodyState, 'available')
})

// ---------------------------------------------------------------------------
// A2. Existing project directory registration
// ---------------------------------------------------------------------------

test('create with existingProject registers the explicit directory and sends its first task', async (t) => {
  const { adapter, engine, ledger, workspaceDir } = await setup(t)
  const project = await tempDir('v04-existing-')
  // A marker proves the plugin never writes, moves, renames or deletes the
  // user's directory contents during registration.
  await fs.writeFile(path.join(project, 'README.md'), 'keep me\n', 'utf8')
  t.after(async () => fs.rm(project, { recursive: true, force: true }))

  const operationId = engine.mintOperation().operationId
  const result = await engine.create(
    createArgs(operationId, {
      existingProject: { path: project, title: 'Notification Repo' },
      task: 'implement notification plugin',
      title: '通知插件 - 开发伙伴',
    }),
  )

  assert.equal(result.idempotent, false)
  assert.equal(result.phase, 'sent')
  assert.equal(result.error, null)
  const realProject = await fs.realpath(project)
  assert.equal(result.workspace.path, realProject)
  assert.equal(result.workspace.title, 'Notification Repo')
  assert.ok(adapter.workspaces.some((item) => item.path === realProject))
  assert.deepEqual(await fs.readFile(path.join(project, 'README.md'), 'utf8'), 'keep me\n')
  assert.deepEqual(await fs.readdir(project), ['README.md'])
  assert.equal(ledger.read().creates?.[`A|${operationId}`]?.location.kind, 'existing_project')

  const retry = await engine.create(
    createArgs(operationId, {
      existingProject: { path: project, title: 'Notification Repo' },
      task: 'implement notification plugin',
      title: '通知插件 - 开发伙伴',
    }),
  )
  assert.equal(retry.idempotent, true)
  assert.equal(retry.sessionId, result.sessionId)
  assert.equal(adapter.createCalls.length, 1, 'retry must not create a second session')
})

test('existingProject reuses an already registered identical realpath', async (t) => {
  const { adapter, engine } = await setup(t)
  const operationId = engine.mintOperation().operationId
  const result = await engine.create(createArgs(operationId, { existingProject: { path: adapter.workspaces[0].path } }))
  assert.equal(result.phase, 'sent')
  assert.equal(adapter.workspaces.length, 1)
  assert.equal(result.workspace.id, 'w-1')
})

test('existingProject rejects relative, missing, and non-directory paths before any effect', async (t) => {
  const { adapter, engine, ledger } = await setup(t)
  const file = path.join(await tempDir('v04-existing-file-'), 'not-a-dir.txt')
  await fs.writeFile(file, 'x', 'utf8')
  t.after(async () => fs.rm(file, { recursive: true, force: true }))

  for (const existingProject of [
    { path: 'relative/project' },
    { path: '/definitely/missing/session-link-project' },
    { path: file },
  ]) {
    const operationId = engine.mintOperation().operationId
    await assert.rejects(
      engine.create(createArgs(operationId, { existingProject })),
      (error) => ['invalid_argument', 'project_missing', 'invalid_location'].includes(error.code),
    )
  }
  assert.deepEqual(ledger.read().creates ?? {}, {})
  assert.equal(adapter.createCalls.length, 0)
})

test('existingProject is mutually exclusive with workspaceId and newProject', async (t) => {
  const { engine, parent } = await setup(t)
  await assert.rejects(
    engine.create(createArgs(engine.mintOperation().operationId, {
      workspaceId: 'w-1',
      existingProject: { path: parent },
    })),
    (error) => error.code === 'invalid_argument',
  )
  await assert.rejects(
    engine.create(createArgs(engine.mintOperation().operationId, {
      newProject: { parentDir: parent, directoryName: 'x' },
      existingProject: { path: parent },
    })),
    (error) => error.code === 'invalid_argument',
  )
})

test('existingProject retry after session failure reuses the registered workspace and creates one session', async (t) => {
  const { adapter, engine } = await setup(t)
  const project = await tempDir('v04-existing-retry-')
  t.after(async () => fs.rm(project, { recursive: true, force: true }))
  const operationId = engine.mintOperation().operationId
  adapter.createHooks.createError = { code: 'HOST_CREATE_FAILED', message: 'synthetic create failure' }
  const first = await engine.create(createArgs(operationId, { existingProject: { path: project } }))
  assert.notEqual(first.phase, 'sent')
  const realProject = await fs.realpath(project)
  const registered = adapter.workspaces.filter((item) => item.path === realProject)
  assert.equal(registered.length, 1)

  const second = await engine.create(createArgs(operationId, { existingProject: { path: project } }))
  // The host create failed with an unknown error, so the operation is kept
  // uncertain and is not blindly re-executed; the workspace is reused and no
  // second session/message is created.
  assert.equal(second.idempotent, true)
  assert.equal(second.phase, first.phase)
  assert.equal(adapter.workspaces.filter((item) => item.path === realProject).length, 1)
  assert.equal(adapter.createCalls.length, 1)
})

test('existingProject retry with a changed path/title is rejected as a conflicting operation', async (t) => {
  const { engine } = await setup(t)
  const a = await tempDir('v04-existing-a-')
  const b = await tempDir('v04-existing-b-')
  t.after(async () => { await fs.rm(a, { recursive: true, force: true }); await fs.rm(b, { recursive: true, force: true }) })
  const operationId = engine.mintOperation().operationId
  await engine.create(createArgs(operationId, { existingProject: { path: a, title: 'A' } }))
  await assert.rejects(
    engine.create(createArgs(operationId, { existingProject: { path: b, title: 'A' } })),
    (error) => error.code === 'conflict_operation',
  )
})
