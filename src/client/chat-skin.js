// Lightweight chat skin: decorate the Host's existing chat rows instead of
// replacing their renderers. This keeps every native action (send, retry,
// approvals, images, scrolling) intact while the visual shell becomes a stable
// bubble with a speaker label. Unknown/custom node rows are left untouched.
const BUBBLE_KINDS = new Set(['user', 'steering', 'assistant-step']);
const SELECTOR = '[data-chat-flow-kind]';
const USER_NAME = '王墨';

export const CHAT_SKIN_CSS = `
/* The speaker is a sibling of the Host's message row, never a pseudo-element
   inside it: the Host's own bubble can then keep its native surface. */
.wm-chat-author {
  display: block;
  width: fit-content;
  max-width: min(82%, 900px);
  margin: 9px 2px 4px;
  color: color-mix(in srgb, currentColor 68%, transparent);
  font-size: 13px;
  line-height: 1.35;
  font-weight: 600;
  letter-spacing: .01em;
  text-align: left;
}
.wm-chat-author[data-wm-kind="user"],
.wm-chat-author[data-wm-kind="steering"] {
  margin-left: auto;
  margin-right: 2px;
  text-align: right;
}
.wm-chat-row img,
.wm-chat-row video,
.wm-chat-row canvas {
  max-width: 100%;
  height: auto;
  border-radius: 10px;
}
.wm-chat-row pre { max-width: 100%; overflow-x: auto; }
@media (max-width: 720px) {
  .wm-chat-author { max-width: 94%; }
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
    if (!row.classList.contains('wm-chat-row')) row.classList.add('wm-chat-row');
    let label = row.previousElementSibling;
    if (!label?.classList?.contains('wm-chat-author')) {
      label = document.createElement('div');
      label.className = 'wm-chat-author';
      row.parentNode?.insertBefore(label, row);
    }
    label.dataset.wmKind = kind;
    if (label.textContent !== author) label.textContent = author;
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
      for (const row of document.querySelectorAll('.wm-chat-row')) row.classList.remove('wm-chat-row');
      for (const label of document.querySelectorAll('.wm-chat-author')) label.remove();
    };
  }, 'session-link chat skin');
}
