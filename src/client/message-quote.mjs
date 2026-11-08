// Pure helpers for the one-click message quote. The quote itself is inserted by
// the Host's own quote machinery (dsh-message-quotes) through the public
// `inputActions.insertQuote` seat, so the composer keeps its native quote block,
// editing, removal and serialization semantics.
/** User decision 2026-11-08: cap the quoted excerpt so one huge reply cannot
 * bloat the next request; the marker tells the model this is an excerpt. */
export const QUOTE_LIMIT = 1200;

/** @param {unknown} text @returns {string} normalized, possibly excerpted quote */
export function clipQuote(text) {
  const normalized = String(text ?? '').replace(/\r\n?/gu, '\n').trim();
  if (!normalized) return '';
  const codepoints = Array.from(normalized);
  if (codepoints.length <= QUOTE_LIMIT) return normalized;
  return `${codepoints.slice(0, QUOTE_LIMIT).join('').trimEnd()}\n…（引用节选）`;
}

/**
 * Markdown source of one finalized assistant message. The conversation node's
 * `closing.blocks` are the Host's own durable content blocks, so the quote keeps
 * markdown formatting instead of the rendered text.
 * @param {{blocks?: readonly {kind?: string, text?: string}[]}} closing
 * @returns {string}
 */
export function closingQuoteText(closing) {
  const blocks = Array.isArray(closing?.blocks) ? closing.blocks : [];
  return blocks
    .filter(block => block?.kind === 'text' && typeof block.text === 'string' && block.text.trim() !== '')
    .map(block => block.text)
    .join('\n');
}
