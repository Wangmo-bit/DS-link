// Pure view-model helpers for the session-link settings section. No DOM, no React:
// this module is the only client code the node test suite can execute directly.

export const API_VERSION = 3;
export const LIMIT = 30;

// Frozen wording (V0.2-BLUEPRINT F.1): accepted is not read and not handled.
export const STATUS = Object.freeze({
  pending: '等待投递',
  held: '等待投递 · 已暂停',
  dispatching: '投递中',
  accepted: '已投递',
  failed: '投递失败',
  unknown: '需要核对',
  cancelled: '已取消',
});

export const REPLY_STATUS = Object.freeze({
  waiting: '等待回复',
  answered: '已回复',
  timed_out: '等待超时',
});

// V0.3 receipt wording: evidence that a message reached the target context is
// not "read" and not "handled". A legacy record keeps its original delivery and
// reply badges; an unevidenced legacy `uncertain` receipt is deliberately muted.
export const RECEIPT_STATE = Object.freeze({
  queued: '已送达 · 待接收',
  received: '已进入上下文',
  uncertain: '接收需核对',
});

export const TRANSFER_STATE = Object.freeze({
  prepared: '准备转移',
  moved: '已转移',
  uncertain: '转移需核对',
});

export const CHAIN_STATE = Object.freeze({ open: '进行中', paused: '已暂停', closed: '已结束' });

// Automatic held causes are consequences of broad settings; the backend resumes
// them on its own. Legacy unknown reasons stay parked for human confirmation.
export const HELD_REASON = Object.freeze({
  paused: '全局已暂停新消息投递；恢复后自动继续。',
  disabled: '会话互通已关闭；重新开启且未暂停后继续。',
  emergency_paused: '旧版紧急暂停（迁移保留）；需要人工确认后释放。',
  auto_collaborate_off: '旧版自动协作关闭（迁移保留）；需要人工确认后释放。',
  held_full: '旧版暂存容量限制（迁移保留）；需要人工确认后释放。',
});

const HEALTH_LABEL = Object.freeze({
  ok: '正常',
  near_capacity: '接近上限',
  full: '已满',
  storage_error: '存储异常',
});

const HEALTH_NOTICE = Object.freeze({
  near_capacity: {
    tone: 'warn',
    text: '容量接近上限（≥90%）：新消息可能被拒绝，已有事务仍可继续。',
  },
  full: {
    tone: 'danger',
    text: '容量已满：新消息会被拒绝，已有事务仍可继续；请清理后再继续通信。',
  },
  storage_error: {
    tone: 'danger',
    text: '存储异常：账本只读，保存设置与控制操作均被禁用；请等待安全重开核对后重试。',
  },
});

export function statusText(status) {
  return STATUS[status] ?? '未知状态';
}

export function receiptOf(message) {
  const receipt = message?.receipt;
  return receipt && typeof receipt === 'object' && !Array.isArray(receipt) ? receipt : null;
}

/**
 * Receipt badge. Policy wins for migrated v2 records: their initial
 * `uncertain` state is not evidence of anything, so it must not look red or
 * claim the message is still waiting. Only queued (still pending) or received
 * (context evidence) changes the badge; a journal transfer marked uncertain is
 * always shown because the original message may have moved.
 */
export function receiptStateText(message) {
  const receipt = receiptOf(message);
  if (!receipt) return '';
  if (receipt.transfer?.state === 'uncertain') return RECEIPT_STATE.uncertain;
  if (receipt.policy === 'legacy-accepted' && receipt.state === 'uncertain') return '';
  return RECEIPT_STATE[receipt.state] ?? '';
}

export function receiptLegacyHint(message) {
  return receiptOf(message)?.policy === 'legacy-accepted' && message?.kind === 'request';
}

/**
 * Reply deadline is only meaningful once the request has context evidence. A
 * queued request has no active countdown; legacy records keep their original
 * deadline (and are labelled as old timing in the detail view). deadlineAt is
 * the sole authority: this never recomputes receivedAt + timeoutMs.
 */
export function requestDeadlineVisible(message) {
  if (!message || message.kind !== 'request') return false;
  if ((message.dispatchStatus ?? message.status) !== 'accepted') return false;
  if (!message.deadlineAt) return false;
  const receipt = receiptOf(message);
  if (!receipt) return true;
  if (receipt.policy === 'legacy-accepted') return true;
  return receipt.state === 'received';
}

export function receiptTransferText(transfer) {
  if (!transfer || typeof transfer !== 'object') return '';
  const label = TRANSFER_STATE[transfer.state] ?? '转移状态未知';
  const error = typeof transfer.error === 'string' && transfer.error ? `：${transfer.error}` : '';
  return `${label}${error}`;
}

export function messageState(message) {
  const status = message.dispatchStatus ?? message.status;
  const receipt = receiptStateText(message);
  const replaceAccepted = status === 'accepted'
    && receipt
    && (message.receipt?.state === 'queued' || message.receipt?.state === 'received')
    && message.receipt?.transfer?.state !== 'uncertain';
  const parts = [];
  if (replaceAccepted) parts.push(receipt);
  else {
    parts.push(statusText(status));
    // Delivery unknown is the primary warning; receipt evidence stays auxiliary.
    if (receipt && status !== 'unknown') parts.push(receipt);
  }
  const reply = message.replyStatus;
  if (reply && reply !== 'none' && REPLY_STATUS[reply]) parts.push(REPLY_STATUS[reply]);
  if (message.late === true || message.lateReply === true || message.lateReplyAt != null) parts.push('迟到回复');
  if (message.resolution === 'unconfirmed') parts.push('人工结案 · 未确认');
  return parts.join(' · ');
}

export function chainStateText(state) {
  return CHAIN_STATE[state] ?? '未加载';
}

/**
 * Extra line for a held record: which condition parks it and whether the owner
 * may act. The release button itself is driven only by `message.releasable`.
 */
export function heldHint(message, chainState) {
  if ((message.dispatchStatus ?? message.status) !== 'held') return '';
  if (chainState === 'paused') return '关联组已暂停；恢复这组通信后继续，不能绕过。';
  if (chainState === 'closed') return '关联组已结束；这条暂存记录不会自动投递。';
  return HELD_REASON[message.heldReason] ?? '旧版暂存记录需要人工确认；仅在你确认安全后才释放。';
}

export function healthLabel(health) {
  return HEALTH_LABEL[health] ?? '未知';
}

export function healthNotice(health) {
  return HEALTH_NOTICE[health] ?? null;
}

export function apiCompatible(snapshot) {
  return Boolean(snapshot) && snapshot.apiVersion === API_VERSION;
}

// storage_error forbids every persistent write; other health values only affect
// admission of new messages, so settings and lifecycle controls stay available.
export function storageWritable(storage) {
  return storage?.health !== 'storage_error';
}

export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${units[unit]}`;
}

export function formatSpan(ms) {
  if (!Number.isSafeInteger(ms) || ms <= 0) return '—';
  const day = 24 * 60 * 60 * 1000;
  const hour = 60 * 60 * 1000;
  const minute = 60 * 1000;
  if (ms % day === 0) return `${ms / day} 天`;
  if (ms % hour === 0) return `${ms / hour} 小时`;
  if (ms % minute === 0) return `${ms / minute} 分钟`;
  return `${ms} 毫秒`;
}

/** Minutes as shown in the owner input; keeps decimals but never scientific noise. */
export function minutesFromMs(ms) {
  if (!Number.isSafeInteger(ms) || ms <= 0) return '';
  return String(Number((ms / 60000).toFixed(6)));
}

/**
 * Owner input is minutes (decimals allowed). Convert to whole milliseconds and
 * reject anything that is not a positive safe integer. No 24h/90d cap is added
 * here: representable-time checks stay authoritative on the backend.
 */
export function msFromMinutes(value) {
  const text = String(value ?? '').trim();
  if (text === '') return { ok: false, error: '请输入回复等待时间（分钟）' };
  const minutes = Number(text);
  if (!Number.isFinite(minutes) || minutes <= 0) return { ok: false, error: '回复等待时间必须是正数分钟' };
  const ms = Math.round(minutes * 60000);
  if (!Number.isSafeInteger(ms) || ms <= 0) return { ok: false, error: '换算后的毫秒数必须是正安全整数' };
  return { ok: true, ms };
}

export function parseIntegerText(value, { min = 1, max, label = '数值' } = {}) {
  const text = String(value ?? '').trim();
  if (text === '') return { ok: false, error: `${label}不能为空` };
  if (!/^[0-9]+$/.test(text)) return { ok: false, error: `${label}必须是正整数` };
  const number = Number(text);
  if (!Number.isSafeInteger(number)) return { ok: false, error: `${label}超出安全整数范围` };
  if (number < min) return { ok: false, error: `${label}不能小于 ${min}` };
  if (max !== undefined && number > max) return { ok: false, error: `${label}不能大于 ${max}` };
  return { ok: true, value: number };
}

/**
 * Diff the owner form against the snapshot baseline and produce the exact
 * settings patch. Invalid fields are reported instead of being silently clamped.
 */
export function buildSettingsPatch(fields, base) {
  const errors = {};
  const patch = {};
  if (typeof fields.enabled === 'boolean' && fields.enabled !== base.enabled) patch.enabled = fields.enabled;
  if (typeof fields.paused === 'boolean' && fields.paused !== base.paused) patch.paused = fields.paused;
  const concurrent = parseIntegerText(fields.maxConcurrent, { min: 1, max: 10, label: '同时投递通道数' });
  if (!concurrent.ok) errors.maxConcurrent = concurrent.error;
  else if (concurrent.value !== base.maxConcurrent) patch.maxConcurrent = concurrent.value;
  const timeout = msFromMinutes(fields.timeoutMinutes);
  if (!timeout.ok) errors.timeoutMinutes = timeout.error;
  else if (timeout.ms !== base.requestTimeoutMs) patch.requestTimeoutMs = timeout.ms;
  const retention = parseIntegerText(fields.retentionDays, { min: 1, label: '已完成消息正文保留天数' });
  if (!retention.ok) errors.retentionDays = retention.error;
  else if (retention.value !== base.retentionDays) patch.retentionDays = retention.value;
  const ok = Object.keys(errors).length === 0;
  return { ok, errors, patch, empty: ok && Object.keys(patch).length === 0 };
}

/** Read-only technical rows. Values come from the snapshot, never from constants. */
const LIMIT_ROWS = Object.freeze([
  ['maxContentBytes', '单条正文最大', formatBytes],
  ['maxCallBytes', '单次调用最大', formatBytes],
  ['maxLedgerBytes', '账本容量', formatBytes],
  ['maxQueuedBytes', '未投递队列容量', formatBytes],
  ['maxReferences', '引用条数', value => `${value} 个`],
  ['maxReferenceChars', '单条引用字符', value => `${value} 字符`],
  ['maxPaths', '路径条数', value => `${value} 个`],
  ['maxPathChars', '单条路径字符', value => `${value} 字符`],
  ['historyPageMax', '历史消息分页', value => `${value} 条/页`],
  ['listPageMax', '工具列表分页', value => `${value} 条/页`],
  ['historyCharsMax', '历史正文每页', value => `${value} 字符/页`],
  ['snapshotPageMax', '面板快照分页', value => `${value} 条/页`],
  ['operationFirstSubmitMs', '幂等首次提交窗口', formatSpan],
  ['operationRetentionMs', '幂等记录保留', formatSpan],
]);

export function technicalLimitRows(limits) {
  if (!limits || typeof limits !== 'object') return [];
  const rows = [];
  for (const [key, label, format] of LIMIT_ROWS) {
    const value = limits[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    rows.push({ key, label, value: format(value) });
  }
  return rows;
}

export function storageSummary(storage) {
  if (!storage || typeof storage !== 'object') return '';
  const parts = [];
  if (Number.isFinite(storage.bytes) && Number.isFinite(storage.maxBytes)) {
    parts.push(`账本 ${formatBytes(storage.bytes)} / ${formatBytes(storage.maxBytes)}`);
  }
  if (Number.isFinite(storage.queuedBytes) && Number.isFinite(storage.maxQueuedBytes)) {
    parts.push(`未投递 ${formatBytes(storage.queuedBytes)} / ${formatBytes(storage.maxQueuedBytes)}`);
  }
  if (Number.isSafeInteger(storage.messageCount)) parts.push(`记录 ${storage.messageCount} 条`);
  if (Number.isSafeInteger(storage.chainCount)) parts.push(`关联组 ${storage.chainCount} 组`);
  return parts.join(' · ');
}

export function describeSettingsError(error) {
  const code = error?.code;
  const current = error?.details?.currentSettingsRevision;
  if (code === 'revision_conflict') {
    return `设置已在其他页面更新（当前设置版本 ${current ?? '未知'}）；请重新载入后再保存。`;
  }
  if (code === 'policy_removed') return '当前页面版本过旧：旧设置项已被移除。请刷新页面后重试。';
  if (code === 'storage_error') return `存储异常，设置未保存：${error.message}`;
  return `设置未保存：${error?.message ?? '未知错误'}`;
}

export function describeControlError(error) {
  const code = error?.code;
  if (code === 'revision_conflict') {
    const current = error?.details?.currentRevision;
    return `记录已在其他页面更新（当前 revision ${current ?? '未知'}）；请刷新后重试。`;
  }
  if (code === 'policy_removed') return '旧版预算操作已被移除；请刷新页面。';
  if (code === 'storage_error') return `存储异常，操作未执行：${error.message}`;
  return `操作未完成：${error?.message ?? '未知错误'}`;
}

// API snapshots are immutable in the view. Index each array once, not once per option.
const sessionIndexes = new WeakMap();
export function sessionLabel(id, sessions, fallback) {
  let labels = sessionIndexes.get(sessions);
  if (!labels) {
    const base = item => `${item.workspaceTitle ?? item.workspace?.title ?? item.workspaceId ?? '工作区'} / ${item.title ?? item.sessionTitle ?? item.sessionId ?? item.id}`;
    const counts = new Map();
    for (const item of sessions) counts.set(base(item), (counts.get(base(item)) ?? 0) + 1);
    labels = new Map();
    for (const item of sessions) {
      const key = item.sessionId ?? item.id, label = base(item);
      labels.set(key, counts.get(label) > 1 ? `${label} · #${String(key).replace(/^session-/, '').slice(0, 8)}` : label);
    }
    sessionIndexes.set(sessions, labels);
  }
  return labels.get(id) ?? (fallback || id || '未知会话');
}

export function textOf(message) {
  return typeof message.text === 'string' ? message.text : typeof message.content === 'string' ? message.content : message.content?.text ?? '';
}

export async function callApi(action, payload, { signal, fetchImpl = globalThis.fetch, base = globalThis.document?.baseURI } = {}) {
  const url = new URL('api/session-link/api', base);
  const deadline = AbortSignal.timeout(15000);
  const boundedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let response;
  try { response = await fetchImpl(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, payload }), signal: boundedSignal }); }
  catch (error) { if (deadline.aborted) throw Object.assign(new Error('等待确认超时；操作可能已经提交，请刷新核对，不要直接重复执行。'), { code: 'confirmation_timeout' }); throw error; }
  if (!response.ok) throw Object.assign(new Error(response.status === 403 ? '当前连接无权访问会话互通；仅宿主本人可用。' : `通信接口返回 HTTP ${response.status}`), { code: `http_${response.status}` });
  const body = await response.json();
  if (!body.ok) throw Object.assign(new Error(body.error?.message ?? '通信请求失败'), { code: body.error?.code ?? 'request_failed', details: body.error?.details });
  return body.value;
}
