import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

test('host bundle uses an exact-version entry to avoid rc.5 bare-specifier cache reuse', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const patch = await fs.readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const specifier = pkg.name
  assert.equal(pkg.name, '@wangmo-bit/ds-link')
  const versioned = pkg.exports[`./runtime-${pkg.version}`]
  assert.equal(typeof versioned, 'string')
  assert.equal(versioned, `./src/host/entry-${pkg.version}.js`)
  assert.equal(pkg.exports['.'], versioned, 'bare root must expose the exact-version physical entry for client discovery')
  const exact = await import(new URL(`../${versioned}`, import.meta.url))
  const generic = await import('../src/host/index.js')
  assert.deepEqual(exact.inject, generic.inject)
  assert.equal(typeof exact.apply, 'function')
  assert.notEqual(exact.apply, generic.apply)
  for (const key of Object.keys(generic)) if (!['name', 'apply'].includes(key)) assert.equal(exact[key], generic[key], `package root must preserve ${key}`)
  assert.equal(pkg.exports['./package.json'], './package.json')
  assert.ok(patch.includes(`name: '${specifier}'\n`))
  assert.ok(patch.includes(`id: session-link-runtime-${pkg.version.replaceAll('.', '-')}\n`))
  assert.equal((patch.match(/- id:/g) ?? []).length, 1)
  assert.equal(pkg.icon, 'assets/icon.svg')
})

test('public package rename keeps the existing tool, API, state and preference namespaces', async () => {
  const { TOOL_NAMES, API_VERSION, STATE_VERSION } = await import('../src/core/constants.js')
  const { resolveStateRoot, name } = await import('../src/host/index.js')
  assert.equal(name, 'session-link')
  assert.equal(API_VERSION, 3)
  assert.equal(STATE_VERSION, 3)
  assert.ok(Object.values(TOOL_NAMES).every(tool => tool.startsWith('session_link_')))
  assert.equal(resolveStateRoot({ profileContext: { home: '/tmp/ds-link-namespace-test', name: 'web' } }, {}), '/tmp/ds-link-namespace-test/state/dsh-session-link/web')
  const label = await fs.readFile(new URL('../src/client/user-label.mjs', import.meta.url), 'utf8')
  const display = await fs.readFile(new URL('../src/client/display-mode.mjs', import.meta.url), 'utf8')
  assert.ok(label.includes('dsh-session-link:user-label:v1'))
  assert.ok(display.includes('dsh-session-link:display-mode:v1'))
})

test('package excludes internal handoffs and the experimental hot-activation helper', async () => {
  const exec = promisify(execFile)
  const { stdout } = await exec('npm', ['pack', '--ignore-scripts', '--dry-run', '--json'], {
    cwd: new URL('..', import.meta.url),
    maxBuffer: 4 * 1024 * 1024,
  })
  const [packed] = JSON.parse(stdout)
  const names = packed.files.map(file => file.path)
  assert.ok(names.includes('README.md'))
  assert.ok(names.includes('src/host/entry-0.8.20-pre.1.js'))
  assert.ok(names.includes('assets/icon.svg'), 'plugin icon is shipped')
  assert.deepEqual(names.filter(name => /^docs\/[^/]*STATUS[^/]*\.md$/i.test(name)), [])
  assert.ok(!names.includes('scripts/activate-profile-entry.mjs'))
})
