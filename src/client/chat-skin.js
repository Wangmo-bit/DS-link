// Lightweight chat skin: decorate the Host's existing chat rows instead of
// replacing their renderers. This keeps every native action (send, retry,
// approvals, images, scrolling) intact while the visual shell becomes a stable
// bubble with a speaker label. Unknown/custom node rows are left untouched.
const BUBBLE_KINDS = new Set(['user', 'steering', 'assistant-step']);
const SELECTOR = '[data-chat-flow-kind]';
const USER_NAME = '王墨';

export const CHAT_SKIN_CSS = `
.wm-chat-row {
  position: relative;
  box-sizing: border-box;
  width: fit-content;
  max-width: min(82%, 900px);
  margin: 8px 0;
  padding: 10px 14px 11px;
  border: 0;
  border-radius: 16px;
  background: color-mix(in srgb, currentColor 6%, transparent);
}
.wm-chat-row::before {
  content: attr(data-wm-author);
  display: block;
  margin: 0 0 4px;
  color: color-mix(in srgb, currentColor 55%, transparent);
  font-size: 11px;
  line-height: 1.4;
  font-weight: 500;
}
.wm-chat-row[data-chat-flow-kind="user"],
.wm-chat-row[data-chat-flow-kind="steering"] {
  margin-left: auto;
  margin-right: 0;
  border-radius: 16px 16px 5px 16px;
  background: color-mix(in srgb, #4d6bfe 14%, transparent);
}
.wm-chat-row[data-chat-flow-kind="assistant-step"] {
  margin-left: 0;
  margin-right: auto;
  border-radius: 16px 16px 16px 5px;
}
.wm-chat-row img,
.wm-chat-row video,
.wm-chat-row canvas {
  max-width: 100%;
  height: auto;
  border-radius: 10px;
}
.wm-chat-row pre {
  max-width: 100%;
  overflow-x: auto;
}
body[data-ds-dark-theme] .wm-chat-row {
  background: color-mix(in srgb, #fff 6%, transparent);
}
body[data-ds-dark-theme] .wm-chat-row[data-chat-flow-kind="user"],
body[data-ds-dark-theme] .wm-chat-row[data-chat-flow-kind="steering"] {
  background: color-mix(in srgb, #5b7bff 20%, transparent);
}
@media (max-width: 720px) {
  .wm-chat-row { max-width: 94%; }
}
`;

function assistantName() {
  // The Host does not expose one stable title attribute on the flow row. The
  // document title is the closest user-facing name; never fall back to an id.
  const title = typeof document === 'string' ? '' : String(document.title ?? '').split(' - ')[0].trim();
  return title && title !== 'DeepSeek Harness' ? title : '助手';
}

function decorate(root = document) {
  const rows = root.querySelectorAll?.(SELECTOR) ?? [];
  for (const row of rows) {
    const kind = row.getAttribute('data-chat-flow-kind');
    if (!BUBBLE_KINDS.has(kind)) continue;
    const author = kind === 'user' || kind === 'steering' ? USER_NAME : assistantName();
    if (row.getAttribute('data-wm-author') !== author) row.setAttribute('data-wm-author', author);
    if (!row.classList.contains('wm-chat-row')) row.classList.add('wm-chat-row');
  }
}

export function installChatSkin(ctx) {
  return ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = 'session-link-chat-skin';
    style.textContent = CHAT_SKIN_CSS;
    document.head.append(style);
    let queued = false;
    const run = () => {
      queued = false;
      try { decorate(); } catch { /* skin must never break the chat */ }
    };
    const schedule = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(run);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-chat-flow-kind'] });
    run();
    return () => {
      observer.disconnect();
      style.remove();
      for (const row of document.querySelectorAll('.wm-chat-row')) {
        row.classList.remove('wm-chat-row');
        row.removeAttribute('data-wm-author');
      }
    };
  }, 'session-link chat skin');
}
