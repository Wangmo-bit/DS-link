import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

test('host bundle uses an exact-version entry to avoid rc.5 bare-specifier cache reuse', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const patch = await fs.readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const specifier = pkg.name
  assert.equal(pkg.name, '@wangmo/dsh-session-link')
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

test('package excludes internal handoffs and the experimental hot-activation helper', async () => {
  const exec = promisify(execFile)
  const { stdout } = await exec('npm', ['pack', '--ignore-scripts', '--dry-run', '--json'], {
    cwd: new URL('..', import.meta.url),
    maxBuffer: 4 * 1024 * 1024,
  })
  const [packed] = JSON.parse(stdout)
  const names = packed.files.map(file => file.path)
  assert.ok(names.includes('README.md'))
  assert.ok(names.includes('src/host/entry-0.5.0.js'))
  assert.ok(names.includes('assets/icon.svg'), 'plugin icon is shipped')
  assert.deepEqual(names.filter(name => /^docs\/[^/]*STATUS[^/]*\.md$/i.test(name)), [])
  assert.ok(!names.includes('scripts/activate-profile-entry.mjs'))
})
