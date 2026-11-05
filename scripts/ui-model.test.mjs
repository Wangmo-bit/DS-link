import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  API_VERSION,
  CHAIN_STATE,
  HELD_REASON,
  LIMIT,
  REPLY_STATUS,
  STATUS,
  apiCompatible,
  buildSettingsPatch,
  callApi,
  chainStateText,
  describeControlError,
  describeSettingsError,
  formatBytes,
  formatSpan,
  healthLabel,
  healthNotice,
  heldHint,
  messageState,
  minutesFromMs,
  msFromMinutes,
  parseIntegerText,
  RECEIPT_STATE,
  receiptLegacyHint,
  receiptOf,
  receiptStateText,
  receiptTransferText,
  requestDeadlineVisible,
  sessionLabel,
  statusText,
  storageSummary,
  storageWritable,
  technicalLimitRows,
  textOf,
  TRANSFER_STATE,
} from '../src/client/model.js';

const BASE_SETTINGS = Object.freeze({ enabled: true, paused: false, maxConcurrent: 3, requestTimeoutMs: 1800000, retentionDays: 30 });
const LIMITS = Object.freeze({
  maxContentBytes: 65536,
  maxCallBytes: 1048576,
  maxLedgerBytes: 52428800,
  maxQueuedBytes: 16777216,
  maxReferences: 5,
  maxReferenceChars: 2000,
  maxPaths: 10,
  maxPathChars: 1024,
  historyPageMax: 20,
  listPageMax: 50,
  historyCharsMax: 16000,
  snapshotPageMax: 100,
  operationFirstSubmitMs: 86400000,
  operationRetentionMs: 7776000000,
});

test('frozen status wording matches the blueprint and never claims read/handled', () => {
  assert.deepEqual(STATUS, { pending: '等待投递', held: '等待投递 · 已暂停', dispatching: '投递中', accepted: '已投递', failed: '投递失败', unknown: '需要核对', cancelled: '已取消' });
  assert.deepEqual(REPLY_STATUS, { waiting: '等待回复', answered: '已回复', timed_out: '等待超时' });
  assert.equal(statusText('missing'), '未知状态');
  assert.equal(messageState({ dispatchStatus: 'accepted', replyStatus: 'timed_out' }), '已投递 · 等待超时');
  assert.equal(messageState({ status: 'unknown' }), '需要核对');
  assert.equal(messageState({ status: 'held', heldReason: 'paused' }), '等待投递 · 已暂停');
  assert.equal(messageState({ dispatchStatus: 'accepted', replyStatus: 'answered', lateReplyAt: 1 }), '已投递 · 已回复 · 迟到回复');
  assert.equal(messageState({ status: 'cancelled', resolution: 'unconfirmed' }), '已取消 · 人工结案 · 未确认');
  assert.doesNotMatch(messageState({ status: 'dispatching' }), /已读|处理中/);
  assert.equal(messageState({ status: 'accepted', replyStatus: 'none' }), '已投递');
});

test('receipt wording reports context evidence without claiming read or handled', () => {
  assert.deepEqual(RECEIPT_STATE, { queued: '已送达 · 待接收', received: '已进入上下文', uncertain: '接收需核对' });
  const context = state => ({ dispatchStatus: 'accepted', receipt: { policy: 'context', state } });
  assert.equal(receiptStateText(context('queued')), '已送达 · 待接收');
  assert.equal(receiptStateText(context('received')), '已进入上下文');
  assert.equal(receiptStateText(context('uncertain')), '接收需核对');
  assert.equal(receiptStateText(context('not_sent')), '', 'not_sent adds no receipt badge');
  assert.equal(receiptStateText({ dispatchStatus: 'accepted' }), '');
  assert.equal(receiptOf({ receipt: null }), null);
  assert.equal(receiptOf({ receipt: [] }), null);

  assert.equal(messageState(context('queued')), '已送达 · 待接收');
  assert.equal(messageState(context('received')), '已进入上下文');
  assert.equal(messageState({ ...context('received'), replyStatus: 'waiting' }), '已进入上下文 · 等待回复');
  assert.equal(messageState(context('uncertain')), '已投递 · 接收需核对');
  assert.equal(messageState({ ...context('received'), status: 'unknown', dispatchStatus: 'unknown' }), '需要核对', 'delivery unknown keeps the primary warning');
  assert.equal(messageState(context('not_sent')), '已投递');
  assert.doesNotMatch(receiptStateText(context('received')), /已读|处理完成/);
});

test('legacy receipts keep their original delivery and reply result', () => {
  const legacy = (state, extra = {}) => ({
    kind: 'request',
    dispatchStatus: 'accepted',
    replyStatus: 'waiting',
    deadlineAt: 1800000,
    receipt: { policy: 'legacy-accepted', state, receivedAt: null, receivedSeq: null, timeoutMs: null, transfer: null },
    ...extra,
  });
  assert.equal(receiptStateText(legacy('uncertain')), '');
  assert.equal(messageState(legacy('uncertain')), '已投递 · 等待回复');
  assert.equal(requestDeadlineVisible(legacy('uncertain')), true, 'original deadline stays authoritative');
  assert.equal(receiptLegacyHint(legacy('uncertain')), true);
  assert.equal(receiptLegacyHint(legacy('uncertain', { kind: 'notification' })), false);

  assert.equal(messageState(legacy('queued')), '已送达 · 待接收 · 等待回复');
  assert.equal(messageState(legacy('received', { replyStatus: 'timed_out' })), '已进入上下文 · 等待超时');
  assert.equal(messageState(legacy('uncertain', { replyStatus: 'timed_out' })), '已投递 · 等待超时');

  const transferUncertain = legacy('uncertain', { receipt: { policy: 'legacy-accepted', state: 'uncertain', receivedAt: null, receivedSeq: null, timeoutMs: null, transfer: { state: 'uncertain', at: 5 } } });
  assert.equal(receiptStateText(transferUncertain), '接收需核对');
  assert.match(messageState(transferUncertain), /接收需核对/);
});

test('request deadline visibility follows receipt state and never recomputes timing', () => {
  const request = extra => ({ kind: 'request', dispatchStatus: 'accepted', deadlineAt: 1000, ...extra });
  assert.equal(requestDeadlineVisible(request({ receipt: { policy: 'context', state: 'received' } })), true);
  assert.equal(requestDeadlineVisible(request({ receipt: { policy: 'context', state: 'queued', timeoutMs: 60000 } })), false, 'queued has no countdown');
  assert.equal(requestDeadlineVisible(request({ receipt: { policy: 'context', state: 'uncertain', timeoutMs: 60000 } })), false);
  assert.equal(requestDeadlineVisible(request({ receipt: { policy: 'context', state: 'not_sent' } })), false);
  assert.equal(requestDeadlineVisible(request({})), true, 'payload without a receipt keeps the old deadline contract');
  assert.equal(requestDeadlineVisible(request({ deadlineAt: null })), false);
  assert.equal(requestDeadlineVisible({ ...request({}), kind: 'notification' }), false);
  assert.equal(requestDeadlineVisible({ ...request({}), status: 'pending', dispatchStatus: 'pending' }), false);
});

test('transfer summaries expose every journal state, including uncertain', () => {
  assert.deepEqual(TRANSFER_STATE, { prepared: '准备转移', moved: '已转移', uncertain: '转移需核对' });
  assert.equal(receiptTransferText({ state: 'prepared', at: 1 }), '准备转移');
  assert.equal(receiptTransferText({ state: 'moved', at: 1 }), '已转移');
  assert.equal(receiptTransferText({ state: 'uncertain', at: 1, error: 'steer failed' }), '转移需核对：steer failed');
  assert.equal(receiptTransferText({ state: 'other', at: 1 }), '转移状态未知');
  assert.equal(receiptTransferText(null), '');
});

test('same-title sessions include workspace and IDs remain authoritative', () => {
  const sessions = [{ id: 'a', title: '设计师', workspaceTitle: '项目A' }, { sessionId: 'b', title: '设计师', workspaceTitle: '项目B' }];
  assert.equal(sessionLabel('a', sessions), '项目A / 设计师');
  assert.equal(sessionLabel('b', sessions), '项目B / 设计师');
  assert.equal(sessionLabel('missing', sessions), 'missing');
  const duplicates = [{ id: 'session-11111111-aaaa', title: '设计师', workspaceTitle: '项目A' }, { id: 'session-22222222-bbbb', title: '设计师', workspaceTitle: '项目A' }];
  assert.equal(sessionLabel(duplicates[0].id, duplicates), '项目A / 设计师 · #11111111');
  assert.equal(sessionLabel(duplicates[1].id, duplicates), '项目A / 设计师 · #22222222');
});

test('message text fallback does not stringify arbitrary objects', () => {
  assert.equal(textOf({ text: 'plain' }), 'plain');
  assert.equal(textOf({ content: { text: 'nested' } }), 'nested');
  assert.equal(textOf({ content: { password: 'not-rendered' } }), '');
});

test('API preserves deployment prefix, same-origin channel and structured errors', async () => {
  let captured;
  const result = await callApi('snapshot', { limit: LIMIT }, { base: 'https://host.example/dsh/', fetchImpl: async (url, init) => { captured = { url: String(url), init }; return { ok: true, json: async () => ({ ok: true, value: { revision: 1 } }) }; } });
  assert.equal(captured.url, 'https://host.example/dsh/api/session-link/api');
  assert.equal(captured.init.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(captured.init.body), { action: 'snapshot', payload: { limit: LIMIT } });
  assert.equal(result.revision, 1);
  await assert.rejects(callApi('snapshot', {}, { base: 'http://localhost/', fetchImpl: async () => ({ ok: false, status: 403 }) }), /无权/);
  await assert.rejects(
    callApi('settings', {}, { base: 'http://localhost/', fetchImpl: async () => ({ ok: true, json: async () => ({ ok: false, error: { code: 'revision_conflict', message: 'changed', details: { currentSettingsRevision: 7 } } }) }) }),
    error => error.code === 'revision_conflict' && error.details.currentSettingsRevision === 7,
  );
  await assert.rejects(
    callApi('settings', {}, { base: 'http://localhost/', fetchImpl: async () => ({ ok: true, json: async () => ({ ok: false, error: { code: 'policy_removed', message: 'old keys', details: { removedKeys: ['maxHops'] } } }) }) }),
    error => error.code === 'policy_removed' && error.details.removedKeys[0] === 'maxHops',
  );
});

test('minutes input converts to whole milliseconds and rejects invalid values without a business cap', () => {
  assert.equal(msFromMinutes('30').ms, 1800000);
  assert.equal(msFromMinutes('0.5').ms, 30000);
  assert.equal(msFromMinutes('30.5').ms, 1830000);
  assert.equal(msFromMinutes(45).ms, 2700000);
  assert.equal(msFromMinutes(' 2 ').ms, 120000);
  for (const value of ['', '  ', 'abc', '0', '-5', '0.0000001', '1e300']) {
    assert.equal(msFromMinutes(value).ok, false, `expected ${JSON.stringify(value)} to be rejected`);
  }
  // No 24h/90d cap is copied into the client: 100000 minutes is still valid here.
  assert.equal(msFromMinutes('100000').ms, 6000000000);
  assert.equal(minutesFromMs(1800000), '30');
  assert.equal(minutesFromMs(1830000), '30.5');
  assert.equal(minutesFromMs(0), '');
  assert.equal(msFromMinutes(minutesFromMs(1000)).ms, 1000);
  assert.equal(msFromMinutes(minutesFromMs(90000)).ms, 90000);
});

test('integer fields validate ranges instead of clamping', () => {
  assert.deepEqual(parseIntegerText('3', { min: 1, max: 10, label: '通道' }), { ok: true, value: 3 });
  assert.deepEqual(parseIntegerText(' 5 ', { min: 1, max: 10, label: '通道' }), { ok: true, value: 5 });
  assert.equal(parseIntegerText('11', { min: 1, max: 10, label: '通道' }).ok, false);
  assert.equal(parseIntegerText('0', { min: 1, label: '天数' }).ok, false);
  assert.equal(parseIntegerText('1.5', { min: 1, label: '天数' }).ok, false);
  assert.equal(parseIntegerText('abc', { min: 1, label: '天数' }).ok, false);
  assert.equal(parseIntegerText('', { min: 1, label: '天数' }).ok, false);
  assert.equal(parseIntegerText('99999999999999999999', { min: 1, label: '天数' }).ok, false);
  assert.deepEqual(parseIntegerText('365', { min: 1, label: '天数' }), { ok: true, value: 365 });
});

test('settings patch only carries changed fields and reports field errors', () => {
  const same = buildSettingsPatch({ enabled: true, paused: false, maxConcurrent: '3', timeoutMinutes: '30', retentionDays: '30' }, BASE_SETTINGS);
  assert.deepEqual(same, { ok: true, errors: {}, patch: {}, empty: true });
  const toggles = buildSettingsPatch({ enabled: false, paused: true, maxConcurrent: '3', timeoutMinutes: '30', retentionDays: '30' }, BASE_SETTINGS);
  assert.deepEqual(toggles.patch, { enabled: false, paused: true });
  const numbers = buildSettingsPatch({ enabled: true, paused: false, maxConcurrent: '10', timeoutMinutes: '30.5', retentionDays: '365' }, BASE_SETTINGS);
  assert.deepEqual(numbers.patch, { maxConcurrent: 10, requestTimeoutMs: 1830000, retentionDays: 365 });
  assert.equal(numbers.empty, false);
  const invalid = buildSettingsPatch({ enabled: true, paused: false, maxConcurrent: '11', timeoutMinutes: 'abc', retentionDays: '0' }, BASE_SETTINGS);
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.maxConcurrent, /不能大于 10/);
  assert.match(invalid.errors.timeoutMinutes, /正数分钟/);
  assert.match(invalid.errors.retentionDays, /不能小于 1/);
  assert.deepEqual(invalid.patch, {});
});

test('byte and span formatting come from snapshot values only', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KiB');
  assert.equal(formatBytes(16384), '16.0 KiB');
  assert.equal(formatBytes(52428800), '50.0 MiB');
  assert.equal(formatBytes(undefined), '—');
  assert.equal(formatSpan(86400000), '1 天');
  assert.equal(formatSpan(7776000000), '90 天');
  assert.equal(formatSpan(1800000), '30 分钟');
  assert.equal(formatSpan(500), '500 毫秒');
  assert.equal(formatSpan(0), '—');
});

test('technical rows render all 14 backend limits and tolerate missing fields', () => {
  const rows = technicalLimitRows(LIMITS);
  assert.equal(rows.length, 14);
  const byKey = Object.fromEntries(rows.map(row => [row.key, row.value]));
  assert.equal(byKey.maxContentBytes, '64.0 KiB');
  assert.equal(byKey.maxCallBytes, '1.0 MiB');
  assert.equal(byKey.maxLedgerBytes, '50.0 MiB');
  assert.equal(byKey.maxQueuedBytes, '16.0 MiB');
  assert.equal(byKey.maxReferences, '5 个');
  assert.equal(byKey.maxReferenceChars, '2000 字符');
  assert.equal(byKey.maxPaths, '10 个');
  assert.equal(byKey.maxPathChars, '1024 字符');
  assert.equal(byKey.historyPageMax, '20 条/页');
  assert.equal(byKey.listPageMax, '50 条/页');
  assert.equal(byKey.historyCharsMax, '16000 字符/页');
  assert.equal(byKey.snapshotPageMax, '100 条/页');
  assert.equal(byKey.operationFirstSubmitMs, '1 天');
  assert.equal(byKey.operationRetentionMs, '90 天');
  assert.deepEqual(technicalLimitRows(undefined), []);
  assert.deepEqual(technicalLimitRows({ maxPaths: 0, maxPathChars: -1 }), []);
  assert.equal(technicalLimitRows({ maxPaths: 3 }).length, 1);
});

test('storage summary, health wording and writability follow the frozen contract', () => {
  const storage = { bytes: 1048576, maxBytes: 52428800, queuedBytes: 2048, maxQueuedBytes: 16777216, messageCount: 12, chainCount: 4, health: 'near_capacity' };
  assert.equal(storageSummary(storage), '账本 1.0 MiB / 50.0 MiB · 未投递 2.0 KiB / 16.0 MiB · 记录 12 条 · 关联组 4 组');
  assert.equal(storageSummary(undefined), '');
  assert.equal(healthLabel('ok'), '正常');
  assert.equal(healthLabel('full'), '已满');
  assert.equal(healthLabel('storage_error'), '存储异常');
  assert.equal(healthNotice('ok'), null);
  assert.equal(healthNotice('near_capacity').tone, 'warn');
  assert.equal(healthNotice('full').tone, 'danger');
  assert.equal(healthNotice('storage_error').tone, 'danger');
  assert.match(healthNotice('storage_error').text, /只读/);
  assert.equal(storageWritable(storage), true);
  assert.equal(storageWritable({ health: 'full' }), true);
  assert.equal(storageWritable({ health: 'storage_error' }), false);
  assert.equal(storageWritable(undefined), true);
});

test('held hints name the parking reason and never invent a bypass', () => {
  assert.equal(heldHint({ status: 'pending' }, 'open'), '');
  assert.match(heldHint({ status: 'held', heldReason: 'paused' }, 'open'), /恢复后自动继续/);
  assert.match(heldHint({ status: 'held', heldReason: 'disabled' }, 'open'), /会话互通已关闭/);
  assert.match(heldHint({ status: 'held', heldReason: 'emergency_paused' }, 'open'), /旧版紧急暂停/);
  assert.match(heldHint({ status: 'held', heldReason: 'legacy_unknown_reason' }, 'open'), /人工确认/);
  assert.match(heldHint({ status: 'held' }, 'paused'), /关联组已暂停/);
  assert.match(heldHint({ status: 'held' }, 'closed'), /关联组已结束/);
  assert.equal(Object.keys(HELD_REASON).includes('legacy_unknown_reason'), false);
});

test('api version gate and chain state wording', () => {
  assert.equal(API_VERSION, 3);
  assert.equal(apiCompatible({ apiVersion: 3 }), true);
  assert.equal(apiCompatible({ apiVersion: 2 }), false);
  assert.equal(apiCompatible({}), false);
  assert.equal(apiCompatible(null), false);
  assert.deepEqual(CHAIN_STATE, { open: '进行中', paused: '已暂停', closed: '已结束' });
  assert.equal(chainStateText('paused'), '已暂停');
  assert.equal(chainStateText('missing'), '未加载');
});

test('error wording distinguishes CAS, policy removal and storage failure', () => {
  assert.match(describeSettingsError({ code: 'revision_conflict', details: { currentSettingsRevision: 9 } }), /设置版本 9/);
  assert.match(describeSettingsError({ code: 'policy_removed' }), /刷新页面/);
  assert.match(describeSettingsError({ code: 'storage_error', message: 'safe reopen required' }), /存储异常/);
  assert.match(describeSettingsError({ code: 'invalid_argument', message: 'bad patch' }), /bad patch/);
  assert.match(describeControlError({ code: 'revision_conflict', details: { currentRevision: 4 } }), /revision 4/);
  assert.match(describeControlError({ code: 'policy_removed' }), /预算/);
  assert.match(describeControlError({ code: 'storage_error', message: 'readonly' }), /存储异常/);
});

test('global panel page is the only entry and registers the left sidebar row', async () => {
  const source = await readFile(new URL('../src/client/index.jsx', import.meta.url), 'utf8');
  assert.match(source, /export const name = '@wangmo\/dsh-session-link'/);
  assert.match(source, /style\.dataset\.plugin = name/);
  assert.doesNotMatch(source, /export const name = 'dsh-session-link'/);
  assert.doesNotMatch(source, /settings\.section/);
  assert.doesNotMatch(source, /sidebarHidden/);
  assert.doesNotMatch(source, /sl-migrate/);
  assert.match(source, /name: 'sidebar\.panellist'/);
  assert.match(source, /id: PANEL/);
  assert.match(source, /label: \(\) => translateText\('会话互通'\)/);
  assert.match(source, /name: 'main',/);
  assert.match(source, /key: PANEL/);
  assert.match(source, /<h1>会话互通<\/h1>/);
  assert.match(source, /className="sl-section sl-page"/);
  assert.match(source, /className="sl-page-card"/);
  assert.match(source, /className="sl-page-card-head"/);
  assert.match(source, /className="sl-page-card-body"/);
  assert.match(source, /保存并应用/);
  assert.doesNotMatch(source, /保存后立即生效/);
  assert.match(source, /className="sl-diagnostics"/);
  assert.doesNotMatch(source, /className="sl-page-card-desc"/);
  assert.match(source, /aria-label="会话互通页面"/);
  assert.match(source, /role="tablist"/);
  assert.match(source, /role="tab"/);
  assert.match(source, /role="tabpanel"/);
  assert.match(source, /useState\('settings'\)/);
  assert.match(source, /设置/);
  assert.match(source, /通信记录/);
});

test('settings draft is CAS-guarded by settingsRevision and controls use revision', async () => {
  const source = await readFile(new URL('../src/client/index.jsx', import.meta.url), 'utf8');
  assert.match(source, /callApi\('settings', \{ expectedSettingsRevision, patch \}\)/);
  assert.match(source, /expectedRevision: snapshot\.revision/);
  assert.match(source, /storageWritable\(snapshot\?\.storage\)/);
  assert.match(source, /apiCompatible\(snapshot\)/);
  assert.match(source, /describeSettingsError\(err\)/);
  assert.match(source, /describeControlError\(err\)/);
  assert.match(source, /message\.releasable === true/);
  for (const legacy of ['autoCollaborate', 'emergencyPaused', 'maxMessages', 'maxHops', 'maxTextChars']) {
    assert.doesNotMatch(source, new RegExp(legacy));
  }
});

test('no budget UI, no manual send form and no hard-coded old capacities', async () => {
  const source = await readFile(new URL('../src/client/index.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /budgetLatches|resume_budget|pausedReason/);
  assert.doesNotMatch(source, /<textarea|callApi\('send|action: 'send'/);
  assert.doesNotMatch(source, /\b10000\b/);
  assert.doesNotMatch(source, /50 MiB|16 MiB|20 条|8 跳/);
  assert.match(source, /<summary>技术说明<\/summary>/);
  assert.doesNotMatch(source, /技术说明（只读）/);
  assert.match(source, /发件会话/);
  assert.match(source, /收件会话/);
  assert.match(source, /sl-mail-layout/);
  assert.match(source, /const view = tab === 'records'/);
  assert.match(source, /sl-settings-grid/);
  assert.doesNotMatch(source, /放弃草稿/);
  assert.match(source, /migration\.backupAvailable/);
  assert.doesNotMatch(source, /backupPath/);
  assert.match(source, /const TAB_ORDER = \['settings', 'records'\]/);
  assert.equal((source.match(/<input /g) ?? []).length, 5, 'the section keeps exactly five settings');
  assert.doesNotMatch(source, /发送消息|投递方式/);
});

test('records detail keeps truthful receipt wording and bounded polling', async () => {
  const source = await readFile(new URL('../src/client/index.jsx', import.meta.url), 'utf8');
  assert.match(source, /查看关联消息/);
  assert.match(source, /暂停这组通信/);
  assert.match(source, /恢复这组通信/);
  assert.match(source, /结束这组通信/);
  assert.match(source, /不代表已读或已处理/);
  assert.match(source, /receiptStateText\(message\)/);
  assert.match(source, /requestDeadlineVisible\(message\)/);
  assert.match(source, /receiptLegacyHint\(message\)/);
  assert.match(source, /接收时间/);
  assert.match(source, /接收状态/);
  assert.match(source, /转移需核对/);
  assert.match(source, /旧计时规则/);
  assert.match(source, /“已送达 · 待接收”表示/);
  assert.match(source, /正在投递/);
  assert.match(source, /通道/);
  assert.match(source, /if \(typeof close === 'function'\) close\(\)/);
  assert.match(source, /openSession\?\.\(id\)/);
  assert.match(source, /document\.visibilityState !== 'hidden'/);
  assert.match(source, /setTimeout\(tick/);
  assert.match(source, /Math\.min\(30000/);
  assert.match(source, /LIMIT/);
});

test('stylesheet has no retired nav/migration hooks and stays single-column at narrow widths', async () => {
  const css = await readFile(new URL('../src/client/style.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /data-session-link-nav|sl-migrate|sl-navlabel|:has\(/);
  assert.match(css, /html\[data-ds-dark-theme\] \.sl-section\.sl-page/);
  assert.match(css, /html\[data-ds-dark-theme\] \.sl-section\.sl-page,[\s\S]*?body\[data-ds-dark-theme\] \.sl-section\.sl-page\{[^}]*--sl-paper:#1a1e24/);
  assert.match(css, /@media \(max-width:700px\)/);
  assert.match(css, /flex-direction:column/);
  assert.match(css, /grid-template-columns:minmax\(280px,38%\)/);
  assert.match(css, /@media \(max-width:1000px\)/);
  assert.match(css, /\.sl-mail-layout\{display:grid/);
  assert.match(css, /\.sl-settings-grid\{display:grid/);
});
