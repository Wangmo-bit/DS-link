import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Static contract test: no host, network, user data, or generated artifacts.
const css = readFileSync(new URL('../src/client/chat-skin.css', import.meta.url), 'utf8');
const incoming = readFileSync(new URL('../src/client/incoming-cards.jsx', import.meta.url), 'utf8');
const outgoing = readFileSync(new URL('../src/client/outgoing-cards.jsx', import.meta.url), 'utf8');
const subagent = readFileSync(new URL('../src/client/subagent-message.jsx', import.meta.url), 'utf8');
const scope = ':root:not([data-sl-card-mode])';
const notice = ':is([data-session-link-notice], .sl-chat-event[data-session-link-card][data-session-link-direction="sent"])';
const button = `${notice} .sl-exchange-link`;
const marker = `${scope} ${notice} .sl-delivery-indicator:not(.sl-delivery-indicator--warning):not(.sl-delivery-indicator--failed)`;
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, selector, body]) => ({ selector: selector.trim(), body: body.trim() }));
function rule(selector) {
  const found = rules.filter(item => item.selector === selector);
  assert.equal(found.length, 1, `exactly one rule for ${selector}`);
  return Object.fromEntries(found[0].body.split(';').map(s => s.trim()).filter(Boolean).map(entry => {
    const split = entry.indexOf(':');
    return [entry.slice(0, split).trim(), entry.slice(split + 1).trim()];
  }));
}
function contrast(a, b) {
  const luminance = hex => {
    const rgb = hex.match(/[0-9a-f]{2}/gi).map(c => parseInt(c, 16) / 255)
      .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  };
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

test('the actual received and sent paths share the scoped notice selector', () => {
  assert.match(incoming, /data-session-link-direction="received" data-session-link-notice=""[\s\S]*?<ExchangeLink/);
  assert.match(outgoing, /className="sl-chat-event" data-session-link-card=\{data\.callId\} data-session-link-i18n-root="" data-session-link-direction="sent"[\s\S]*?<ExchangeLink/);
  assert.match(subagent, /data-session-link-subagent-message="" data-session-link-notice=""/);
  assert.match(subagent, /data-session-link-subagent-sent="" data-session-link-notice=""/);
  assert.match(subagent, /className="sl-exchange-link"/);
  const normal = rule(`${scope} ${button}`);
  assert.deepEqual(Object.keys(normal).sort(), ['--sl-notice-hover', '--sl-notice-ink', '--sl-notice-surface', 'background', 'color'].sort());
  assert.equal(normal.background, 'var(--sl-notice-surface)');
  assert.equal(normal.color, 'var(--sl-notice-ink)');
  assert.deepEqual(rule(`${scope} ${button}:hover`), { background: 'var(--sl-notice-hover)', color: 'var(--sl-notice-ink)' });
  assert.deepEqual(rule(`${scope} ${button}:focus-visible`), { 'outline-color': 'var(--sl-notice-ink)' });
  assert.deepEqual(rule(marker), { color: 'var(--sl-notice-ink)' });
});

test('light and dark normal and hover surfaces retain readable text contrast', () => {
  const light = rule(`${scope} ${button}`);
  const dark = rule(`${scope}[data-ds-dark-theme] ${button},\n${scope} body[data-ds-dark-theme] ${button}`);
  for (const palette of [light, dark]) {
    for (const surface of ['--sl-notice-surface', '--sl-notice-hover']) {
      assert.ok(contrast(palette['--sl-notice-ink'], palette[surface]) >= 4.5, `${surface} text contrast`);
    }
    assert.notEqual(palette['--sl-notice-surface'], palette['--sl-notice-hover']);
  }
  // Focus ring uses the ink colour and remains discernible against the page, too.
  assert.ok(contrast(light['--sl-notice-ink'], '#f1f2f4') >= 3);
  assert.ok(contrast(dark['--sl-notice-ink'], '#24262c') >= 3);
  assert.deepEqual(dark, { '--sl-notice-surface': '#3b4942', '--sl-notice-hover': '#495b50', '--sl-notice-ink': '#dce8dd' });
  assert.equal(light['--sl-notice-surface'], '#dce6df');
  assert.equal(light['--sl-notice-hover'], '#ccdcd0');
  assert.equal(light['--sl-notice-ink'], '#344a3b');
});

test('card link defaults, capsule geometry, focus and receipt semantics remain unchanged', () => {
  assert.deepEqual(rule('.sl-exchange-link'), { border: '0', 'border-radius': '9px', background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer', padding: '4px 8px' });
  assert.deepEqual(rule('.sl-chat-event .sl-exchange-link'), { background: 'color-mix(in srgb, var(--sl-chat-muted) 12%, transparent)', 'border-radius': '999px' });
  assert.deepEqual(rule('.sl-chat-event .sl-exchange-link:hover'), { background: 'color-mix(in srgb, var(--sl-chat-muted) 20%, transparent)' });
  assert.deepEqual(rule('.sl-chat-message button:focus-visible, .sl-chat-process summary:focus-visible, .sl-chat-event button:focus-visible, .sl-exchange-dialog button:focus-visible'), { outline: '2px solid #829aff', 'outline-offset': '3px' });
  assert.match(outgoing, /indicator\.kind === 'received' \? '✓'/);
  assert.match(incoming, /marker\.kind === 'received' \? '✓'/);
  assert.match(subagent, /aria-label="宿主已确认投递，不代表已读或已回复"[^>]*>✓/);
  // Any new notice declarations are strictly bubble-scoped and colour-only.
  const added = rules.filter(item => item.body.includes('--sl-notice-'));
  assert.equal(added.length, 5);
  for (const item of added) assert.ok(item.selector.split(',\n').every(s => s.startsWith(scope)), item.selector);
});
