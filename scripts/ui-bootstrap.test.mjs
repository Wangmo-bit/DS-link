// A failed chat-card registration must not remove the established settings entry.
// This test bundles in memory; it does not start a Host or modify a profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireFromRepo = createRequire(path.join(root, 'package.json'));

async function loadClient() {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['src/client/index.jsx'],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    external: ['react', 'react-dom', '@deepseek-ai/*'],
    loader: { '.css': 'text' },
    logLevel: 'silent',
  });
  const module = { exports: {} };
  const localRequire = name => requireFromRepo(name);
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(localRequire, module, module.exports);
  return module.exports;
}

test('card registration failures leave existing settings entry registered', async () => {
  const client = await loadClient();
  const injected = [];
  const warnings = [];
  const priorWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    client.apply({
      effect() {},
      slots: { inject(name) { injected.push(name); } },
      sessions: {},
      uiConversation: { events: { register() { throw new Error('synthetic duplicate kind'); } } },
    });
  } finally {
    console.warn = priorWarn;
  }
  assert.ok(injected.includes('main'));
  assert.ok(injected.includes('sidebar.panellist'));
  assert.ok(!injected.includes('settings.section'));
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some(args => /Incoming cards unavailable; native chat remains available/.test(String(args[0]))));
  assert.ok(warnings.some(args => /Outgoing cards unavailable; native chat remains available/.test(String(args[0]))));
});
