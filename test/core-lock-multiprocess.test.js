import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { Ledger } from '../src/core/ledger.js'
import { tempRoot } from './helpers.js'

const HOLDER = fileURLToPath(new URL('./fixtures/lock-holder.mjs', import.meta.url))
const RACE = fileURLToPath(new URL('./fixtures/lock-race.mjs', import.meta.url))

async function waitFor(predicate, timeoutMs = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

function waitExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode)
    child.once('exit', (code, signal) => resolve(code ?? signal))
  })
}

test('another process holding the lock blocks a second writer; killing it releases the OS lock', async () => {
  const root = await tempRoot()
  const ready = path.join(root, 'ready.json')
  const child = spawn(process.execPath, [HOLDER, root, ready], { stdio: 'ignore' })
  try {
    assert.equal(await waitFor(async () => (await fs.stat(ready).catch(() => null)) !== null), true)
    const status = JSON.parse(await fs.readFile(ready, 'utf8'))
    assert.equal(status.ok, true)

    const blocked = new Ledger({ root })
    await assert.rejects(blocked.open(), (error) => error.code === 'lock_active')

    child.kill('SIGTERM')
    await waitExit(child)
    const recovered = new Ledger({ root })
    await recovered.open()
    await recovered.close()
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
  }
})

test('concurrent recovery across processes produces exactly one writer', async () => {
  const root = await tempRoot()
  const barrier = path.join(root, 'barrier')
  const results = path.join(root, 'results')
  await fs.mkdir(results)
  const count = 6
  const children = []
  try {
    for (let index = 0; index < count; index += 1) {
      children.push(
        spawn(process.execPath, [RACE, root, barrier, results, String(index)], {
          stdio: 'ignore',
        }),
      )
    }
    await fs.writeFile(barrier, 'go')
    assert.equal(
      await waitFor(async () => {
        const entries = await fs.readdir(results).catch(() => [])
        return entries.length === count
      }),
      true,
    )
    const outcomes = []
    for (let index = 0; index < count; index += 1) {
      outcomes.push(JSON.parse(await fs.readFile(path.join(results, `${index}.json`), 'utf8')))
    }
    const winners = outcomes.filter((outcome) => outcome.ok === true)
    assert.equal(winners.length, 1, `expected exactly one writer, got ${JSON.stringify(outcomes)}`)
    assert.equal(outcomes.filter((outcome) => outcome.ok === false).every((outcome) => outcome.code === 'lock_active'), true)
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGTERM')
    }
    await Promise.all(children.map((child) => waitExit(child)))
  }

  const reopened = new Ledger({ root })
  await reopened.open()
  await reopened.close()
})
