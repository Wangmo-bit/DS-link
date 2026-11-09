// Presentation-only workaround for a Host Markdown parser that interprets
// `$60 ... $30` as one inline math span. Keep this conservative: a leading
// numeric dollar is escaped only when its next dollar is also followed by a
// number and the intervening text looks like prose. Ambiguous mathematical
// source stays untouched where there is no prose evidence. Original text must
// remain the source for storage, copy, quotes, and Host interaction APIs.
const isDigit = c => c >= '0' && c <= '9';
const numberAfterDollar = (text, at) => isDigit(text[at + 1]) || (text[at + 1] === '.' && isDigit(text[at + 2]));
const proseBetween = text => /[\p{Script=Han}]/u.test(text) || /(?:\s[\p{L}]{2,}(?:\s|[.,:;!?])|[,，、。；：!?！？])/u.test(text);

/** Return display Markdown, never mutate the original message. */
export function escapeAmbiguousCurrencyMath(text) {
  if (typeof text !== 'string' || !text.includes('$')) return text;
  const escapes = new Set();
  let dollars = [];
  const finish = () => {
    for (let n = 0; n + 1 < dollars.length;) {
      const a = dollars[n], b = dollars[n + 1];
      // Both dollar signs must look like amount prefixes; a normal closing
      // delimiter such as `$2 + 3$` therefore remains a real math span. If we
      // preserve a pair, consume both tokens: its closing delimiter must not
      // later be mistaken for a new price in e.g. `$2$3 is $5`.
      const next = dollars[n + 2];
      const nextLooksLikeMath = next !== undefined && !numberAfterDollar(text, b)
        && !/\s/u.test(text[b + 1] ?? '') && text[b + 1] !== '$';
      if (numberAfterDollar(text, a) && proseBetween(text.slice(a + 1, b))
        && (numberAfterDollar(text, b) || nextLooksLikeMath)) {
        escapes.add(a);
        n++;
      } else n += 2;
    }
    dollars = [];
  };
  let i = 0;
  let lineStart = true;
  let fence = null;
  while (i < text.length) {
    if (lineStart) {
      const end = text.indexOf('\n', i);
      const lineEnd = end < 0 ? text.length : end;
      const line = text.slice(i, lineEnd);
      // Fences can be nested under blockquotes or start in list items. Keep
      // their contents byte-exact; an escaped dollar would show up in code.
      const match = /^(?: {0,3}>[ \t]?)*(?: {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+)? {0,3}(`{3,}|~{3,})/u.exec(line);
      if (fence) {
        if (match && match[1][0] === fence[0] && match[1].length >= fence.length && /^\s*$/u.test(line.slice(match[0].length))) fence = null;
        i = lineEnd; lineStart = false; continue;
      }
      if (match) { finish(i); fence = match[1]; i = lineEnd; lineStart = false; continue; }
      // Indented code blocks, and blank lines that separate Markdown paragraphs.
      if (/^(?: {4}|\t)/u.test(line) || /^\s*$/u.test(line)) { finish(i); i = lineEnd; lineStart = false; continue; }
      lineStart = false;
    }
    const char = text[i];
    if (char === '\n') { i++; lineStart = true; continue; }
    if (char === '\\') {
      if ((text[i + 1] === '(' || text[i + 1] === '[')) {
        const close = text[i + 1] === '(' ? '\\)' : '\\]';
        const end = text.indexOf(close, i + 2);
        finish(i); i = end < 0 ? text.length : end + 2; continue;
      }
      i += Math.min(2, text.length - i); continue;
    }
    if (char === '`') {
      let endTicks = i + 1;
      while (text[endTicks] === '`') endTicks++;
      const marker = text.slice(i, endTicks);
      let end = endTicks;
      while (end < text.length) {
        const at = text.indexOf('`', end);
        if (at < 0) { end = -1; break; }
        let after = at + 1;
        while (text[after] === '`') after++;
        if (text.slice(at, after) === marker) { end = after; break; }
        end = after;
      }
      // Unclosed inline backticks are literal; don't hide the rest of text.
      if (end >= 0) { finish(i); i = end; continue; }
      i = endTicks; continue;
    }
    if (char === '<') {
      // Preserve literal HTML code/pre blocks and comments, including dollars
      // in their content. Ordinary tags/autolinks are skipped individually.
      const protectedHtml = /^<(code|pre|script|style)(?:\s|>)/iu.exec(text.slice(i));
      if (protectedHtml) {
        const close = new RegExp(`</${protectedHtml[1]}\\s*>`, 'iu');
        const tail = text.slice(i + protectedHtml[0].length);
        const match = close.exec(tail);
        finish(i);
        i = match ? i + protectedHtml[0].length + match.index + match[0].length : text.length;
        continue;
      }
      if (text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i + 4);
        finish(i); i = end < 0 ? text.length : end + 3; continue;
      }
      const end = text.indexOf('>', i + 1);
      if (end >= 0 && !text.slice(i, end).includes('\n')) { finish(i); i = end + 1; continue; }
    }
    // Skip a Markdown link/image destination, which is not rendered as text.
    if (char === ']' && text[i + 1] === '(') {
      let end = i + 2, depth = 1;
      while (end < text.length && depth) {
        if (text[end] === '\\') { end += 2; continue; }
        if (text[end] === '(') depth++;
        if (text[end] === ')') depth--;
        end++;
      }
      if (!depth) { finish(i); i = end; continue; }
    }
    if (char === '$') {
      if (text[i + 1] === '$') {
        finish(i);
        const end = text.indexOf('$$', i + 2);
        i = end < 0 ? text.length : end + 2; continue;
      }
      dollars.push(i);
    }
    i++;
  }
  finish(text.length);
  if (!escapes.size) return text;
  let result = '', last = 0;
  for (const at of escapes) { result += text.slice(last, at) + '\\$'; last = at + 1; }
  return result + text.slice(last);
}

/** A rendering-only snapshot; the Host's stored node and actions stay intact. */
export function currencySafeAssistantNode(node) {
  const data = node?.data;
  if (node?.kind !== 'assistant-step' || !data || data.status === 'running' || !Array.isArray(data.blocks)) return node;
  let changed = false;
  const blocks = data.blocks.map(block => {
    if (block?.kind !== 'text' || typeof block.text !== 'string') return block;
    const text = escapeAmbiguousCurrencyMath(block.text);
    if (text === block.text) return block;
    changed = true;
    return { ...block, text };
  });
  return changed ? { ...node, data: { ...data, blocks } } : node;
}
