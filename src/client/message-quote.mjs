// One-click "quote this message" for bubble mode. The Host's quote machinery
// lives in `dsh-message-quotes`: it inserts text as an atomic quote into the
// current composer through the public SessionInput facade. That facade is not
// reachable from a chat-node view, but it IS a standard runtime seat of every
// session-scoped composer slot. A zero-DOM bridge entry in
// `conversation.input.right` captures it per session; the bubble button then
// inserts the rendered message text, exactly like the Host's own selection
// quote, so the composer keeps its native quote block and edit/remove behavior.
const facades = new Map();
/** User decision 2026-11-08: cap the quoted excerpt so a huge reply cannot
 * bloat the next request; the marker tells the model this is an excerpt. */
const QUOTE_LIMIT = 1200;

export function clipQuote(text) {
  const normalized = String(text ?? '').replace(/\r\n?/gu, '\n').trim();
  if (!normalized) return '';
  const codepoints = Array.from(normalized);
  if (codepoints.length <= QUOTE_LIMIT) return normalized;
  return `${codepoints.slice(0, QUOTE_LIMIT).join('').trimEnd()}\n…（引用节选）`;
}

/**
 * Install the zero-DOM composer bridge that captures each session's input facade.
 * @param {*} ctx client plugin context with `slots`
 * @returns {() => void} disposer
 */
export function installMessageQuote(ctx) {
  let stop;
  try {
    stop = ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
      name: 'conversation.input.right',
      id: 'session-link-quote-bridge',
      order: 90,
    }, function SessionLinkQuoteBridge(props) {
      if (typeof props?.sessionId === 'string' && props.inputActions) facades.set(props.sessionId, props.inputActions);
      return null;
    }));
  } catch {
    // The composer slot is absent in some shells; the bubble action then no-ops
    // rather than pretending a quote was inserted.
  }
  return () => { facades.clear(); stop?.(); };
}

/** @param {string} sessionId @returns {boolean} whether quoting is wired there */
export function quoteReady(sessionId) { return facades.has(sessionId); }

/**
 * Quote one message's rendered text into that session's composer.
 * @param {string} sessionId
 * @param {string} text rendered message text
 * @returns {boolean} whether the composer accepted the quote
 */
export function quoteMessage(sessionId, text) {
  const facade = facades.get(sessionId);
  const quote = clipQuote(text);
  if (!facade || typeof facade.insertQuote !== 'function' || quote === '') return false;
  try {
    return facade.insertQuote(quote) === true;
  } catch {
    return false;
  }
}
