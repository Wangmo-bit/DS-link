import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTurnSummary, getFoldState } from '../src/client/chat-skin-model.mjs';

const lineArray = count => Array.from({ length: count }, (_, index) => `line ${index + 1}`);
const lines = count => lineArray(count).join('\n');
const codePointCount = text => Array.from(text).length;
const fieldNames = state => Object.keys(state).sort();

test('getFoldState exposes exactly the frozen contract and never alters text', () => {
  const text = 'short message';
  const state = getFoldState(text);
  assert.deepEqual(fieldNames(state), ['folded', 'preview', 'shouldFold', 'text', 'totalChars']);
  assert.equal(state.text, text);
  assert.equal(state.preview, text);
  assert.equal(state.totalChars, text.length);
  assert.equal(state.shouldFold, false);
  assert.equal(state.folded, false);
});

test('fold threshold is 1,500 Unicode code points or 25 lines', () => {
  const atCharLimit = getFoldState('x'.repeat(1500));
  assert.equal(atCharLimit.totalChars, 1500);
  assert.equal(atCharLimit.shouldFold, false);
  assert.equal(atCharLimit.folded, false);
  assert.equal(atCharLimit.preview, 'x'.repeat(1500));

  const overCharLimit = getFoldState('x'.repeat(1501));
  assert.equal(overCharLimit.totalChars, 1501);
  assert.equal(overCharLimit.shouldFold, true);
  assert.equal(overCharLimit.folded, true);
  assert.equal(overCharLimit.preview, 'x'.repeat(600));

  const atLineLimit = getFoldState(lines(25));
  assert.equal(atLineLimit.shouldFold, false);
  assert.equal(atLineLimit.folded, false);
  assert.equal(atLineLimit.preview, lines(25));

  const overLineLimit = getFoldState(lines(26));
  assert.equal(overLineLimit.shouldFold, true);
  assert.equal(overLineLimit.folded, true);
  assert.equal(overLineLimit.preview, lines(10));
});

test('Unicode limits count code points, not UTF-16 code units', () => {
  const atLimit = '😀'.repeat(1500);
  const atState = getFoldState(atLimit);
  assert.equal(atLimit.length, 3000, 'fixture really uses surrogate pairs');
  assert.equal(atState.totalChars, 1500);
  assert.equal(atState.shouldFold, false);
  assert.equal(atState.preview, atLimit);

  const overLimit = '😀'.repeat(1501);
  const overState = getFoldState(overLimit);
  assert.equal(overState.totalChars, 1501);
  assert.equal(overState.shouldFold, true);
  assert.equal(codePointCount(overState.preview), 600);
  assert.equal(overState.preview, '😀'.repeat(600));
  assert.doesNotMatch(overState.preview, /[\uD800-\uDBFF]$/, 'must not leave a lone high surrogate');

  const cjk = getFoldState('中'.repeat(1501));
  assert.equal(cjk.totalChars, 1501);
  assert.equal(cjk.preview, '中'.repeat(600));

  // The 600th code point is the emoji, so a code-point cut keeps it whole
  // instead of backing up before the surrogate pair.
  const boundary = `${'x'.repeat(599)}😀${'x'.repeat(901)}`;
  const boundaryState = getFoldState(boundary);
  assert.equal(boundaryState.totalChars, 1501);
  assert.equal(boundaryState.preview, `${'x'.repeat(599)}😀`);
  assert.equal(codePointCount(boundaryState.preview), 600);
});

test('preview takes at most ten lines and cuts at a line boundary within 600 code points', () => {
  const fortyLines = getFoldState(lines(40));
  assert.equal(fortyLines.shouldFold, true);
  assert.equal(fortyLines.preview, lines(10));

  const wide = Array.from({ length: 20 }, () => 'y'.repeat(100)).join('\n');
  const widePreview = getFoldState(wide).preview;
  assert.equal(widePreview, Array.from({ length: 5 }, () => 'y'.repeat(100)).join('\n'));
  assert.ok(codePointCount(widePreview) <= 600);
  assert.equal(widePreview.split('\n').length, 5);

  // 10 lines of 59 code points fit in 600; 10 lines of 60 do not and the cut
  // lands on the last complete line under the limit.
  const narrow = Array.from({ length: 30 }, () => 'n'.repeat(59)).join('\n');
  const narrowPreview = getFoldState(narrow).preview;
  assert.equal(narrowPreview, Array.from({ length: 10 }, () => 'n'.repeat(59)).join('\n'));
  assert.equal(codePointCount(narrowPreview), 599);

  const justOver = Array.from({ length: 30 }, () => 'm'.repeat(60)).join('\n');
  const justOverPreview = getFoldState(justOver).preview;
  assert.equal(justOverPreview, Array.from({ length: 9 }, () => 'm'.repeat(60)).join('\n'));
  assert.equal(codePointCount(justOverPreview), 548);
  assert.ok(codePointCount(justOverPreview) <= 600);
  assert.equal(justOverPreview.split('\n').length, 9);
});

test('a single overlong line is cut at 600 code points', () => {
  const state = getFoldState('x'.repeat(1501));
  assert.equal(state.preview, 'x'.repeat(600));
  assert.equal(codePointCount(state.preview), 600);
});

test('expanded returns the original and streaming never folds', () => {
  const text = `${lines(40)}\n${'tail '.repeat(400)}`;
  const folded = getFoldState(text);
  assert.equal(folded.shouldFold, true);
  assert.equal(folded.folded, true);
  assert.notEqual(folded.preview, text);

  const expanded = getFoldState(text, { expanded: true });
  assert.equal(expanded.shouldFold, true, 'expanded keeps the eligibility fact');
  assert.equal(expanded.folded, false);
  assert.equal(expanded.preview, text);
  assert.equal(expanded.text, text);
  assert.equal(expanded.totalChars, codePointCount(text));

  const streaming = getFoldState(text, { streaming: true });
  assert.equal(streaming.shouldFold, true, 'streaming keeps the eligibility fact');
  assert.equal(streaming.folded, false);
  assert.equal(streaming.preview, text);
  assert.equal(streaming.text, text);

  const short = getFoldState('short', { expanded: true, streaming: true });
  assert.deepEqual(short, { shouldFold: false, folded: false, preview: 'short', text: 'short', totalChars: 5 });

  assert.equal(getFoldState(text, { expanded: false, streaming: false }).folded, true);
});

test('copy always uses the untouched canonical text', () => {
  const text = `\n\n${lines(40)}\n${'copy me '.repeat(300)}`;
  for (const options of [undefined, { expanded: true }, { streaming: true }, { expanded: true, streaming: true }]) {
    const state = getFoldState(text, options);
    assert.equal(state.text, text, 'exact same string, including leading blank lines');
  }
  const folded = getFoldState(text);
  assert.notEqual(folded.preview, folded.text);
  assert.equal(folded.text.includes(lines(40)), true);
  assert.equal(folded.text.includes('copy me '.repeat(300)), true);
});

test('the preview starts at the first visible line and all-blank text never folds', () => {
  const leading = `\n\n\n${'x'.repeat(1500)}`;
  const state = getFoldState(leading);
  assert.equal(state.totalChars, 1503);
  assert.equal(state.shouldFold, true);
  assert.equal(state.preview, 'x'.repeat(600));
  assert.equal(state.text, leading);

  const blank = `${' '.repeat(1600)}\n${'\n'.repeat(30)}`;
  const blankState = getFoldState(blank);
  assert.equal(blankState.totalChars, codePointCount(blank));
  assert.equal(blankState.shouldFold, false);
  assert.equal(blankState.folded, false);
  assert.equal(blankState.preview, blank);
});

test('a fence cut open in the preview is completed, backtick and tilde alike', () => {
  const backtick = ['Here:', '```js', ...lineArray(30), '```'].join('\n');
  const backtickPreview = getFoldState(backtick).preview;
  assert.equal(backtickPreview, ['Here:', '```', ...lineArray(8), '```'].join('\n'));

  const tilde = ['~~~~', '```', ...lineArray(30)].join('\n');
  const tildePreview = getFoldState(tilde).preview;
  assert.equal(tildePreview, ['~~~~', '```', ...lineArray(8), '~~~~'].join('\n'));

  const four = ['````', 'x'.repeat(1500)].join('\n');
  const fourPreview = getFoldState(four).preview;
  assert.equal(fourPreview, ['````', 'x'.repeat(595), '````'].join('\n'));

  const noFence = lines(40);
  assert.equal(getFoldState(noFence).preview.includes('```'), false);
});

test('a closed fence is not completed again', () => {
  const closed = ['```', 'a', '```', ...lineArray(30)].join('\n');
  assert.equal(getFoldState(closed).preview, ['```', 'a', '```', ...lineArray(7)].join('\n'));
});

test('a fence-only first line still previews the fenced content', () => {
  const card = ['```dsh-ui', 'x'.repeat(2000)].join('\n');
  const state = getFoldState(card);
  assert.equal(state.preview, ['```', 'x'.repeat(590), '```'].join('\n'));
  assert.equal(state.text, card);

  const emojiCode = ['```js', '😀'.repeat(2000)].join('\n');
  const emojiPreview = getFoldState(emojiCode).preview;
  assert.equal(emojiPreview, ['```', '😀'.repeat(594), '```'].join('\n'));
  assert.doesNotMatch(emojiPreview, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, 'no lone high surrogate in preview');
});

test('unknown or non-string fold inputs are handled without throwing', () => {
  assert.deepEqual(getFoldState(undefined), { shouldFold: false, folded: false, preview: '', text: '', totalChars: 0 });
  assert.deepEqual(getFoldState(null), { shouldFold: false, folded: false, preview: '', text: '', totalChars: 0 });
  assert.deepEqual(getFoldState(123), { shouldFold: false, folded: false, preview: '', text: '', totalChars: 0 });
});

test('running turn shows exactly 思考中', () => {
  assert.equal(formatTurnSummary({ running: true }), '思考中');
  assert.equal(formatTurnSummary({ running: true, elapsedMs: 125000, thinkingCount: 9, toolCount: 8 }), '思考中');
  assert.equal(formatTurnSummary({ running: true, status: 'error' }), '思考中');
});

test('ended turn formats elapsed time and real counts, including zero', () => {
  assert.equal(
    formatTurnSummary({ running: false, elapsedMs: 125000, thinkingCount: 9, toolCount: 8 }),
    '耗时 2 分 5 秒 · 9 次思考 · 8 次工具',
  );
  assert.equal(
    formatTurnSummary({ running: false, elapsedMs: 0, thinkingCount: 0, toolCount: 0 }),
    '耗时 0 秒 · 0 次思考 · 0 次工具',
  );
  assert.equal(formatTurnSummary({ thinkingCount: 0 }), '0 次思考');
  assert.equal(formatTurnSummary({ toolCount: 0 }), '0 次工具');
  assert.doesNotMatch(formatTurnSummary({ thinkingCount: 0, toolCount: 0 }), /undefined|NaN|null/);
});

test('time format switches to minutes and seconds at 60 seconds', () => {
  assert.equal(formatTurnSummary({ elapsedMs: 0 }), '耗时 0 秒');
  assert.equal(formatTurnSummary({ elapsedMs: 999 }), '耗时 0 秒');
  assert.equal(formatTurnSummary({ elapsedMs: 59000 }), '耗时 59 秒');
  assert.equal(formatTurnSummary({ elapsedMs: 59999 }), '耗时 59 秒');
  assert.equal(formatTurnSummary({ elapsedMs: 60000 }), '耗时 1 分 0 秒');
  assert.equal(formatTurnSummary({ elapsedMs: 61000 }), '耗时 1 分 1 秒');
  assert.equal(formatTurnSummary({ elapsedMs: 125900 }), '耗时 2 分 5 秒');
  assert.equal(formatTurnSummary({ elapsedMs: 3599000 }), '耗时 59 分 59 秒');
  assert.equal(formatTurnSummary({ elapsedMs: 3600000 }), '耗时 60 分 0 秒');
  assert.equal(formatTurnSummary({ elapsedMs: 3661000 }), '耗时 61 分 1 秒');
});

test('missing or invalid fields are omitted instead of fabricated', () => {
  assert.equal(formatTurnSummary(), '');
  assert.equal(formatTurnSummary(null), '');
  assert.equal(
    formatTurnSummary({ running: false, elapsedMs: null, thinkingCount: undefined, toolCount: null }),
    '',
  );
  assert.equal(formatTurnSummary({ elapsedMs: undefined, thinkingCount: 3, toolCount: undefined }), '3 次思考');
  assert.equal(formatTurnSummary({ elapsedMs: 5000, thinkingCount: undefined, toolCount: 0 }), '耗时 5 秒 · 0 次工具');
  assert.equal(formatTurnSummary({ elapsedMs: NaN, thinkingCount: NaN, toolCount: Infinity }), '');
  assert.equal(formatTurnSummary({ elapsedMs: -1, thinkingCount: -2, toolCount: -3 }), '');
  assert.equal(formatTurnSummary({ elapsedMs: '60000', thinkingCount: '3', toolCount: '2' }), '');
  assert.equal(formatTurnSummary({ elapsedMs: 1000, thinkingCount: 1.5, toolCount: 2.5 }), '耗时 1 秒');
});

test('interrupted and error statuses use the frozen prefixes', () => {
  assert.equal(
    formatTurnSummary({ status: 'interrupted', elapsedMs: 65000, thinkingCount: 0, toolCount: 0 }),
    '已停止 · 耗时 1 分 5 秒 · 0 次思考 · 0 次工具',
  );
  assert.equal(
    formatTurnSummary({ status: 'error', elapsedMs: 3000, thinkingCount: 2 }),
    '执行失败 · 耗时 3 秒 · 2 次思考',
  );
  assert.equal(formatTurnSummary({ status: 'interrupted' }), '已停止');
  assert.equal(formatTurnSummary({ status: 'error', toolCount: 1 }), '执行失败 · 1 次工具');
  assert.equal(formatTurnSummary({ status: 'error', running: false }), '执行失败');
});

test('unknown status adds no invented prefix and the result stays a single line', () => {
  assert.equal(formatTurnSummary({ status: 'unknown', elapsedMs: 1000 }), '耗时 1 秒');
  assert.equal(
    formatTurnSummary({ status: 'unknown', elapsedMs: 0, thinkingCount: 0, toolCount: 0 }),
    '耗时 0 秒 · 0 次思考 · 0 次工具',
    'unknown status does not hide real zero values',
  );
  assert.equal(formatTurnSummary({ status: 'completed', elapsedMs: 61000, thinkingCount: 0, toolCount: 0 }), '耗时 1 分 1 秒 · 0 次思考 · 0 次工具');
  assert.equal(formatTurnSummary({ status: 'any-unknown-value' }), '');
  for (const summary of [
    { running: true },
    { elapsedMs: 125000, thinkingCount: 9, toolCount: 8 },
    { status: 'interrupted', elapsedMs: 125000, thinkingCount: 9, toolCount: 8 },
    { status: 'error' },
  ]) {
    assert.doesNotMatch(formatTurnSummary(summary), /\n/);
  }
});
