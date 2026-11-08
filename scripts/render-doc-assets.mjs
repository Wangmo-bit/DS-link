// Offline, fictional product-component showcase. Never reads DSH_HOME, opens
// a live session or sends a message. Native Host areas are explicitly mocks.
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'docs/assets');
const work = join(root, 'output/playwright/docs');
await mkdir(out, { recursive: true }); await mkdir(work, { recursive: true });
const bundle = await build({
  absWorkingDir: root, entryPoints: ['scripts/docs/showcase.jsx'], bundle: true,
  write: false, format: 'iife', platform: 'browser', target: 'es2022',
  loader: { '.css': 'text' },
  alias: { '@deepseek-ai/dsh-client-ui-primitives': resolve(root, 'scripts/docs/markdown-stub.jsx') },
});
const js = bundle.outputFiles[0].text;
const html = join(work, 'showcase.html');
await writeFile(html, '<!doctype html><html><head><meta charset="utf-8"><title>DS-link — fictional documentation fixture</title></head><body><div id="app"></div><script>' + js.replaceAll('</script', '<\\/script') + '</script></body></html>');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const manifest = { kind: 'synthetic-product-component-fixtures', network: 'blocked', host: 'mock shell; no DSH connection', browser: browser.version(), files: {} };
try {
  for (const lang of ['zh', 'en']) {
    const page = await browser.newPage({ viewport: { width: 1120, height: 1300 }, deviceScaleFactor: 1.5 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith('file:') ? route.continue() : route.abort());
    await page.goto(`file://${html}?lang=${lang}`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.showcase);
    await page.evaluate(() => document.fonts.ready);
    for (const scene of ['bubble', 'card', 'quote', 'settings']) {
      await page.evaluate(scene => { window.showcase.setScene(scene); window.showcase.setStage(2); }, scene);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const name = `${scene}-${lang}.png`;
      await page.locator('#capture').screenshot({ path: join(out, name) });
      manifest.files[name] = createHash('sha256').update(await readFile(join(out, name))).digest('hex');
    }
    for (const stage of [0, 1, 2]) {
      await page.evaluate(stage => { window.showcase.setScene('bubble'); window.showcase.setStage(stage); }, stage);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.locator('#capture').screenshot({ path: join(work, `flow-${lang}-${stage}.png`) });
    }
    // This verifies the real quote-action component against the fixture's own
    // composer callback, not against a production draft or a remote session.
    await page.evaluate(() => window.showcase.setScene('quote'));
    await page.locator('.sl-message-action').click();
    if (!(await page.locator('.demo-quote').innerText()).trim()) throw Error('Fixture quote was not populated');
    if (errors.length) throw Error(errors.join('\n'));
    await page.close();
  }
} finally { await browser.close(); }
await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('Rendered 8 labelled synthetic component fixtures. No live Host or session was used.');
console.log('Flow frames for optional GIF assembly:', work);
