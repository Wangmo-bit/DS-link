// Pure view-model helpers for the DS-Bot-style chat skin. No DOM, no React:
// node --test can execute this module directly.
//
// The fold state follows DS-Bot's fold.js semantics (first visible lines,
// line-boundary truncation, fence completion) with one deliberate change:
// limits are measured in Unicode code points, not UTF-16 code units. `text`
// is always the exact input and is the only value callers may copy; `preview`
// is display-only.

const FOLD_CODEPOINTS = 1500;
const FOLD_LINES = 25;
const PREVIEW_LINES = 10;
const PREVIEW_CODEPOINTS = 600;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

function countCodePoints(text) {
  let count = 0;
  for (const unused of text) count += 1;
  return count;
}

function firstCodePoints(text, limit) {
  if (limit <= 0) return '';
  let count = 0;
  let end = 0;
  for (const char of text) {
    if (count >= limit) break;
    count += 1;
    end += char.length;
  }
  return text.slice(0, end);
}

// More than `max` lines, counted only as far as needed.
function moreThanLines(text, max) {
  let lines = 1;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) {
    if (++lines > max) return true;
  }
  return false;
}

// The first `max` lines, without a trailing newline. This mirrors
// text.split('\n', max).join('\n') while scanning only until the limit.
function firstLines(text, max) {
  let lines = 1;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) {
    if (++lines > max) return text.slice(0, at);
  }
  return text;
}

// Cut at the last newline at or before the code-point limit; if there is no
// such newline, cut inside the single overlong line exactly at the limit.
// Checking index `limit` inclusive mirrors DS-Bot's lastIndexOf('\n', 600).
function cutAtLine(text, limit) {
  let count = 0;
  let lastNewline = -1;
  for (const char of text) {
    if (count > limit) break;
    if (char === '\n' && count <= limit) lastNewline = count;
    count += 1;
  }
  const cut = lastNewline > 0 ? lastNewline : limit;
  return firstCodePoints(text, cut);
}

// Scan a preview for a fence left open at the cut. A closing fence needs the
// same fence character and at least as many markers as the opener.
function openFence(lines) {
  let marker = null;
  let openLine = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const found = FENCE.exec(lines[index])?.[1];
    if (found === undefined) continue;
    if (marker === null) {
      marker = found;
      openLine = index;
    } else if (found[0] === marker[0] && found.length >= marker.length) {
      marker = null;
    }
  }
  return marker === null ? null : { marker, openLine };
}

// DS-Bot starts the preview at the first visible character and does not fold
// an all-blank message. Everything else is the original text, truncated only.
function buildPreview(text) {
  const body = text.replace(/^(\s*\n)+/, '');
  if (body.trim() === '') return null;

  let head = firstLines(body, PREVIEW_LINES);
  if (countCodePoints(head) > PREVIEW_CODEPOINTS) head = cutAtLine(head, PREVIEW_CODEPOINTS);
  if (head.trim() === '') head = firstCodePoints(body, PREVIEW_CODEPOINTS);

  let lines = head.split('\n');
  let open = openFence(lines);

  // A cut that kept only the fence marker renders an empty block (for example
  // a card opening like ```dsh-ui on its own line). Pull the start of the
  // fenced text into the preview instead, as DS-Bot does.
  if (open !== null && lines.slice(open.openLine + 1).join('').trim() === '') {
    head = firstCodePoints(body, PREVIEW_CODEPOINTS);
    lines = head.split('\n');
    open = openFence(lines);
  }

  if (open === null) return head;
  // A fence cut open in the preview is closed. Its language tag is dropped as
  // in DS-Bot so a downstream renderer cannot claim the half message; the
  // canonical `text` returned to the caller is never changed.
  lines[open.openLine] = open.marker;
  return `${lines.join('\n')}\n${open.marker}`;
}

/**
 * Long-message fold state.
 *
 * @param {string} text canonical message text
 * @param {{ expanded?: boolean, streaming?: boolean }} [options]
 * @returns {{ shouldFold: boolean, folded: boolean, preview: string, text: string, totalChars: number }}
 *
 * `shouldFold` says the text is eligible (over 1,500 Unicode code points or
 * 25 lines, and not blank). `folded` says the preview is currently in use.
 * Expanded or streaming messages never fold. `preview` is the full original
 * text when not folded. Copy actions must use `text`, never `preview`.
 */
export function getFoldState(text, options = {}) {
  const source = typeof text === 'string' ? text : '';
  const totalChars = countCodePoints(source);
  const expanded = options?.expanded === true;
  const streaming = options?.streaming === true;
  const overLimit = totalChars > FOLD_CODEPOINTS || moreThanLines(source, FOLD_LINES);
  const preview = overLimit ? buildPreview(source) : null;
  const shouldFold = preview !== null;
  const folded = shouldFold && !expanded && !streaming;

  return {
    shouldFold,
    folded,
    preview: folded ? preview : source,
    text: source,
    totalChars,
  };
}

function formatElapsed(elapsedMs) {
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

function formatCount(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) return null;
  return `${value} 次${label}`;
}

function statusPrefix(status) {
  if (status === 'interrupted') return '已停止';
  if (status === 'error') return '执行失败';
  return '';
}

/**
 * One-line Chinese turn summary. Missing or invalid fields are omitted, while
 * a real zero is shown. An all-missing ended turn returns an empty string so
 * the caller can hide the line instead of inventing facts.
 *
 * @param {{ running?: boolean, elapsedMs?: number, thinkingCount?: number, toolCount?: number, status?: string }} [turn]
 * @returns {string}
 */
export function formatTurnSummary(turn = {}) {
  if (turn?.running === true) return '思考中';

  const parts = [];
  const elapsed = formatElapsed(turn?.elapsedMs);
  if (elapsed !== null) parts.push(`耗时 ${elapsed}`);
  const thinking = formatCount(turn?.thinkingCount, '思考');
  if (thinking !== null) parts.push(thinking);
  const tools = formatCount(turn?.toolCount, '工具');
  if (tools !== null) parts.push(tools);

  const prefix = statusPrefix(turn?.status);
  const body = parts.join(' · ');
  if (prefix === '') return body;
  return body === '' ? prefix : `${prefix} · ${body}`;
}
