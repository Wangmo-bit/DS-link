// Intent: one owner entry under Settings -> 会话互通 that explains delivery
// evidence and lets the owner stop runaway work; this plugin still has no
// manual send form.
// Palette/surfaces/type: inherit DSH tokens; subtle borders, semantic status,
// 4px spacing grid. The settings shell owns the dialog; this module only owns
// the embedded section, a hidden compatibility hint for the retired main route,
// and the single nav label (bubbles icon + marker).
import React, { useEffect, useRef, useState } from 'react';
import {
  LIMIT,
  apiCompatible,
  buildSettingsPatch,
  callApi,
  chainStateText,
  describeControlError,
  describeSettingsError,
  healthLabel,
  healthNotice,
  heldHint,
  messageState,
  minutesFromMs,
  msFromMinutes,
  parseIntegerText,
  receiptLegacyHint,
  receiptOf,
  receiptStateText,
  receiptTransferText,
  requestDeadlineVisible,
  sessionLabel,
  storageSummary,
  storageWritable,
  technicalLimitRows,
  textOf,
} from './model.js';
import css from './style.css';
import { CARD_CSS } from './card-shell.mjs';
import { installIncomingCards } from './incoming-cards.jsx';
import { installOutgoingCards } from './outgoing-cards.jsx';
import { installI18n } from './i18n.js';

export const name = '@wangmo/dsh-session-link';
export const inject = ['slots', 'layout', 'connection', 'uiWorkspace', 'sessions', 'uiConversation', 'locale'];
const PANEL = 'session-link';
const TAB_ORDER = ['settings', 'records'];
const FILTERS = [['all', '全部'], ['pending_reply', '待回复'], ['received', '收件'], ['sent', '发件'], ['abnormal', '异常 / 未确认']];
const KIND = { request: '协作请求', notification: '通知', reply: '明确回复' };
const date = value => value ? new Date(value).toLocaleString() : '—';
const short = value => String(value ?? '').slice(0, 8);
const statusOf = message => message.dispatchStatus ?? message.status;

function BubblesIcon({ size = 16 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M4.8 4.6h8.6a2 2 0 0 1 2 2v4.6a2 2 0 0 1-2 2H9.6L6.5 15.9v-2.7H4.8a2 2 0 0 1-2-2V6.6a2 2 0 0 1 2-2Z"/>
    <path d="M12.4 9.9h6.8a2 2 0 0 1 2 2v4.2a2 2 0 0 1-2 2h-1.1v2.4l-2.9-2.4h-4.8a2 2 0 0 1-2-2v-4.2a2 2 0 0 1 2-2Z"/>
  </svg>;
}

// Static label node: the shell renders the returned element inside its nav span.
// It must stay a pure function with no hooks or side effects.
function NavLabel() {
  return <span className="sl-navlabel" data-session-link-nav="">
    <BubblesIcon />
    <span className="sl-navtext">会话互通</span>
  </span>;
}

function Action({ children, onClick, busy, danger, title, disabled }) {
  return <button type="button" className={danger ? 'sl-button sl-danger' : 'sl-button'} disabled={Boolean(busy || disabled)} onClick={onClick} title={title}>{children}</button>;
}

function Tabs({ value, onChange }) {
  const refs = useRef([]);
  const move = index => {
    const next = TAB_ORDER[(index + TAB_ORDER.length) % TAB_ORDER.length];
    onChange(next);
    refs.current[TAB_ORDER.indexOf(next)]?.focus();
  };
  return <div className="sl-tabs" role="tablist" aria-label="会话互通页面">
    {TAB_ORDER.map((key, index) => <button key={key} ref={node => { refs.current[index] = node; }} type="button" role="tab" id={`sl-tab-${key}`} aria-controls={`sl-panel-${key}`} aria-selected={value === key} tabIndex={value === key ? 0 : -1} className="sl-tab" onClick={() => onChange(key)} onKeyDown={event => {
      if (event.key === 'ArrowRight') { event.preventDefault(); move(index + 1); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); move(index - 1); }
      else if (event.key === 'Home') { event.preventDefault(); move(0); }
      else if (event.key === 'End') { event.preventDefault(); move(TAB_ORDER.length - 1); }
    }}>{key === 'settings' ? '设置' : '通信记录'}</button>)}
  </div>;
}

function StatusLine({ snapshot }) {
  const health = snapshot.storage?.health ?? 'ok';
  const summary = storageSummary(snapshot.storage);
  return <p className="sl-statusline" role="status">
    <span>{`正在投递${snapshot.inFlight ?? 0}，通道${snapshot.settings?.maxConcurrent ?? '—'}`}</span>
    {summary && <><span aria-hidden="true">·</span><span>{summary}</span></>}
    <span className={`sl-health sl-health-${health}`}>{healthLabel(health)}</span>
  </p>;
}

function Banners({ snapshot }) {
  const settings = snapshot.settings ?? {};
  const notice = healthNotice(snapshot.storage?.health);
  return <>
    {!settings.enabled && <p className="sl-note" role="status">会话互通已关闭：新消息会被拒绝；未投递记录保留，记录仍可查看。</p>}
    {settings.enabled && settings.paused && <p className="sl-note" role="status">已暂停新消息投递：新消息排队，不打断已开始的工作；恢复后继续投递。</p>}
    {notice && <p className={notice.tone === 'danger' ? 'sl-alert' : 'sl-note'} role="status">{notice.text}</p>}
    {snapshot.storage?.error && <p className="sl-alert" role="status">存储错误：{snapshot.storage.error.code} {snapshot.storage.error.message}</p>}
  </>;
}

function fieldsOf(settings) {
  const source = settings ?? {};
  return {
    enabled: Boolean(source.enabled),
    paused: Boolean(source.paused),
    maxConcurrent: String(source.maxConcurrent ?? ''),
    timeoutMinutes: minutesFromMs(source.requestTimeoutMs),
    retentionDays: String(source.retentionDays ?? ''),
  };
}

export function SettingsForm({ snapshot, writable, busy, save }) {
  const revision = snapshot.settingsRevision;
  const [draft, setDraft] = useState(() => fieldsOf(snapshot.settings));
  const [dirty, setDirty] = useState(false);
  const [external, setExternal] = useState(false);
  const [localError, setLocalError] = useState('');
  const [saving, setSaving] = useState(false);
  const base = useRef({ settingsRevision: revision, settings: snapshot.settings });
  const savingRef = useRef(false);

  useEffect(() => {
    if (!dirty) {
      base.current = { settingsRevision: revision, settings: snapshot.settings };
      setDraft(fieldsOf(snapshot.settings));
      setExternal(false);
    } else if (!savingRef.current && revision !== base.current.settingsRevision) {
      setExternal(true);
    }
  }, [revision, dirty]);

  const change = (key, value) => { setDraft(current => ({ ...current, [key]: value })); setDirty(true); setLocalError(''); };
  const reset = () => {
    setDraft(fieldsOf(snapshot.settings));
    base.current = { settingsRevision: revision, settings: snapshot.settings };
    setDirty(false);
    setExternal(false);
    setLocalError('');
  };
  const submit = async event => {
    event.preventDefault();
    setLocalError('');
    const built = buildSettingsPatch(draft, base.current.settings);
    if (!built.ok) { setLocalError(Object.values(built.errors).join(' ')); return; }
    if (built.empty) { setLocalError('没有需要保存的改动。'); return; }
    savingRef.current = true;
    setSaving(true);
    let result;
    try {
      result = await save(built.patch, base.current.settingsRevision);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
    if (result?.ok) {
      setDirty(false);
      setExternal(false);
      if (result.value?.settings) {
        base.current = { settingsRevision: result.value.settingsRevision ?? revision, settings: result.value.settings };
        setDraft(fieldsOf(result.value.settings));
      }
    }
  };

  const concurrent = parseIntegerText(draft.maxConcurrent, { min: 1, max: 10, label: '同时投递通道数' });
  const timeout = msFromMinutes(draft.timeoutMinutes);
  const retention = parseIntegerText(draft.retentionDays, { min: 1, label: '已完成消息正文保留天数' });

  return <form className="sl-settings" aria-label="会话互通设置" onSubmit={submit}>
    {!writable && <p className="sl-alert" role="status">存储异常：设置保存已禁用，当前只读。</p>}
    {external && <p className="sl-alert" role="status">设置已在其他页面更新（当前设置版本 {revision}）。保存可能冲突，可先重新载入。</p>}
    <label className="sl-setting">
      <span><strong>开启会话互通</strong><small>关闭后拒绝新通信；记录仍可查看，未投递记录保留。</small></span>
      <input type="checkbox" checked={Boolean(draft.enabled)} onChange={event => change('enabled', event.target.checked)} disabled={busy || !writable}/>
    </label>
    <label className="sl-setting">
      <span><strong>暂停新消息投递</strong><small>暂停时新消息排队，不打断已开始的工作；恢复后继续投递。</small></span>
      <input type="checkbox" checked={Boolean(draft.paused)} onChange={event => change('paused', event.target.checked)} disabled={busy || !writable}/>
    </label>
    <details className="sl-more">
      <summary>更多设置</summary>
      <label className="sl-setting sl-field">
        <span><strong>同时投递通道数</strong><small>{concurrent.ok ? '1～10；只限制同时入队的消息，不限制会话同时工作。' : concurrent.error}</small></span>
        <input type="number" min="1" max="10" step="1" value={draft.maxConcurrent} onChange={event => change('maxConcurrent', event.target.value)} disabled={busy || !writable}/>
      </label>
      <label className="sl-setting sl-field">
        <span><strong>回复等待时间（分钟）</strong><small>{timeout.ok ? `超时只标记，不停止任务、不自动重发；当前换算 ${timeout.ms} 毫秒。` : timeout.error}</small></span>
        <input type="number" min="0" step="any" inputMode="decimal" value={draft.timeoutMinutes} onChange={event => change('timeoutMinutes', event.target.value)} disabled={busy || !writable}/>
      </label>
      <label className="sl-setting sl-field">
        <span><strong>已完成消息正文保留天数</strong><small>{retention.ok ? '清理插件保存的已完成正文，不删除原会话聊天记录。' : retention.error}</small></span>
        <input type="number" min="1" step="1" value={draft.retentionDays} onChange={event => change('retentionDays', event.target.value)} disabled={busy || !writable}/>
      </label>
    </details>
    {localError && <p className="sl-alert" role="alert">{localError}</p>}
    <div className="sl-actions">
      <button type="submit" className="sl-button sl-primary" disabled={busy || !writable || !dirty}>{saving ? '保存中…' : '保存设置'}</button>
      <Action onClick={reset} busy={busy} disabled={!dirty}>放弃草稿</Action>
    </div>
  </form>;
}

function TechnicalDetails({ snapshot }) {
  const rows = technicalLimitRows(snapshot.technicalLimits);
  const migration = snapshot.migration;
  return <details className="sl-tech">
    <summary>技术说明（只读）</summary>
    <p className="sl-muted">{storageSummary(snapshot.storage)}</p>
    {rows.length > 0 && <dl className="sl-tech-list">{rows.map(row => <React.Fragment key={row.key}><dt>{row.label}</dt><dd>{row.value}</dd></React.Fragment>)}</dl>}
    {migration && <p className="sl-muted">已从 v1 迁移（{date(migration.migratedAt)}）· 原始备份{migration.backupAvailable ? '可用' : '不可用'} · 旧版配额暂停记录 {migration.retiredQuotaPauses ?? 0} 条（已停用）· 旧版锁 {migration.retiredLatches ?? 0} 个（已停用）。</p>}
    <p className="sl-muted">以上是本机当前生效的技术容量与分页/幂等窗口，不是按条数的业务配额；超限会明确报错，不静默截断或丢弃。</p>
  </details>;
}

export function RecordDetail({ message, snapshot, busy, writable, act, open, selectChain }) {
  const status = statusOf(message);
  const sessions = snapshot.sessions ?? [];
  const chain = (snapshot.chains ?? []).find(item => item.id === message.chainId);
  const chainState = chain?.state ?? message.chainState;
  const related = (snapshot.messages ?? []).filter(item => item.id !== message.id && (item.replyTo === message.id || item.id === message.replyTo));
  const blocked = busy || !writable;
  const hint = heldHint(message, chainState);
  const receipt = receiptOf(message);
  const receiptText = receiptStateText(message);
  const transferText = receiptTransferText(receipt?.transfer);
  const deadlineVisible = requestDeadlineVisible(message);
  const legacyTiming = receiptLegacyHint(message);
  return <section className="sl-detail" aria-label="消息详情">
    <div className="sl-section-head"><h3>消息 #{short(message.id)}</h3><span className={`sl-status sl-${status}`}>{messageState(message)}</span></div>
    <dl className="sl-meta">
      <dt>来源</dt><dd><button type="button" className="sl-text-button" data-i18n-skip="" onClick={() => open(message.from)}>{sessionLabel(message.from, sessions, message.fromTitle)}</button></dd>
      <dt>目标</dt><dd><button type="button" className="sl-text-button" data-i18n-skip="" onClick={() => open(message.to)}>{sessionLabel(message.to, sessions, message.toTitle)}</button></dd>
      <dt>创建</dt><dd>{date(message.createdAt)}</dd>
      <dt>宿主接收</dt><dd>{date(message.acceptedAt)}</dd>
      {receipt && receipt.receivedAt != null && <><dt>接收时间</dt><dd>{date(receipt.receivedAt)}{Number.isSafeInteger(receipt.receivedSeq) && <> · seq {receipt.receivedSeq}</>}</dd></>}
      {receipt && receiptText && <><dt>接收状态</dt><dd>{receiptText}</dd></>}
      {receipt?.transfer && <><dt>转移</dt><dd>{transferText} · {date(receipt.transfer.at)}</dd></>}
      {deadlineVisible && <><dt>等待期限</dt><dd>{date(message.deadlineAt)}</dd></>}
      <dt>类型</dt><dd>{KIND[message.kind] ?? message.kind}</dd>
      <dt>关联消息</dt><dd><button type="button" className="sl-text-button" onClick={() => selectChain(message.chainId)}>查看关联消息</button> · {chainStateText(chainState)} · {chain?.messageCount ?? '—'} 条</dd>
      <dt>持久身份</dt><dd><code data-i18n-skip="">{message.durableMessageId ?? ''}</code>{!message.durableMessageId && <span className="sl-muted">尚未创建宿主消息</span>}</dd>
    </dl>
    {message.error && <p className="sl-alert" role="status" data-i18n-skip="">{typeof message.error === 'string' ? message.error : `${message.error.code}：${message.error.message}`}</p>}
    {status === 'unknown' && <p className="sl-note">消息可能已执行，但尚无可靠确认。不要直接重发；先核对目标会话。人工结案不等于证明未投递。</p>}
    {hint && <p className="sl-note">{hint}</p>}
    {receipt?.state === 'received' && <p className="sl-note">“已进入上下文”只表示目标会话已接收这条消息，不代表已读或已处理，也不代表请求已发给模型。</p>}
    {receipt?.state === 'queued' && <p className="sl-note">“已送达 · 待接收”表示宿主已接收并排队，尚未确认进入目标会话上下文；不是已读。</p>}
    {receipt?.state === 'uncertain' && receipt.policy !== 'legacy-accepted' && <p className="sl-note">接收需核对：尚无可靠的上下文接收证据；不会自动重发，请核对目标会话。</p>}
    {receipt?.transfer?.state === 'uncertain' && <p className="sl-alert" role="status">转移需核对：原消息可能已经移动但无法确认；保留原记录，不自动重发，请核对目标会话的待处理输入。</p>}
    {legacyTiming && <p className="sl-note">旧计时规则：这条旧记录沿用 0.2 的期限与超时结果，接收证据只作辅助，不重算。</p>}
    {status === 'accepted' && !receipt && <p className="sl-note">“已投递”只表示宿主接收，不代表已读或已处理；超时不撤销任务。</p>}
    {chainState === 'paused' && <p className="sl-note">这组通信已暂停；恢复后继续投递尚未开始的消息，已开始的工作不受影响。</p>}
    {chainState === 'closed' && <p className="sl-note">这组通信已结束；未投递的消息已取消，已开始的工作不受影响。</p>}
    {!writable && <p className="sl-alert" role="status">存储异常：记录只读，控制操作已禁用。</p>}
    <pre className="sl-message-body" data-i18n-skip="">{textOf(message) || ''}</pre>
    {!textOf(message) && <p className="sl-muted">正文已按保留期限清理，或此记录无正文。</p>}
    {!!message.paths?.length && <div><h3>引用的本机路径</h3><ul>{message.paths.map((path, index) => <li key={index} data-i18n-skip=""><code>{path}</code></li>)}</ul><p className="sl-muted">只传路径，不搬运文件；工作目录和权限仍各自独立。</p></div>}
    {!!message.references?.length && <div><h3>历史引用</h3>{message.references.map((ref, index) => <blockquote key={index} data-i18n-skip=""><button type="button" className="sl-text-button" onClick={() => open(ref.sessionId)}>{ref.sessionId} · seq {ref.seq}</button><pre>{ref.text}</pre></blockquote>)}</div>}
    <div className="sl-actions">
      {['pending', 'held'].includes(status) && <Action busy={blocked} onClick={() => act('cancel', message.id)}>取消尚未投递的消息</Action>}
      {status === 'held' && message.releasable === true && <Action busy={blocked} onClick={() => { if (confirm('只在你确认这条旧版暂存记录可以投递时才释放；它仍会按当前通道与暂停设置排队，不会绕过全局暂停。')) act('release', message.id); }}>明确释放这条暂存消息</Action>}
      {status === 'unknown' && <>
        <Action busy={blocked} onClick={() => act('recheck', message.id)}>重新核对宿主证据</Action>
        <Action busy={blocked} onClick={() => { if (confirm('只有你已查实目标接收时才确认。此操作不会重发，且会记录人工确认。')) act('resolve_unknown', message.id, { resolution: 'accepted' }); }}>人工确认已接收</Action>
        <Action busy={blocked} onClick={() => { if (confirm('结案为未确认；不代表未执行，也不会重发。')) act('resolve_unknown', message.id, { resolution: 'closed' }); }}>结束此记录为未确认</Action>
      </>}
      {chain && chain.state === 'open' && <Action busy={blocked} onClick={() => act('pause', chain.id)}>暂停这组通信</Action>}
      {chain && chain.state === 'paused' && <Action busy={blocked} onClick={() => act('resume', chain.id)}>恢复这组通信</Action>}
      {chain && chain.state !== 'closed' && <Action busy={blocked} danger onClick={() => { if (confirm('结束这组通信会取消尚未投递的消息；不会撤销已开始的工作。')) act('close', chain.id); }}>结束这组通信</Action>}
    </div>
    <h3>关联回复（当前加载页）</h3>
    {related.length ? related.map(item => <article className="sl-related" key={item.id}><div>#{short(item.id)} · {messageState(item)}</div><pre>{textOf(item)}</pre></article>) : <p className="sl-muted">当前页暂无关联记录。可通过关联消息筛选继续查询。</p>}
    <p className="sl-note">“已送达 · 待接收”“已进入上下文”都不是“已读”。超时不撤销任务；停止/归档目标可能影响其待处理输入。</p>
  </section>;
}

export function RecordsPanel({ snapshot, busy, writable, act, open, filter, setFilter, sessionId, setSessionId, offset, setOffset, selected, setSelected, chainId, setChainId }) {
  const messages = snapshot.messages ?? [];
  const sessions = snapshot.sessions ?? [];
  const message = messages.find(item => item.id === selected);
  const total = snapshot.total ?? messages.length;
  return <div className="sl-records">
    {chainId && <div className="sl-note sl-actions"><span>当前关联消息：<code>{chainId}</code></span><Action busy={busy} onClick={() => { setFilter('all'); setChainId(''); setOffset(0); setSelected(null); }}>退出关联筛选</Action></div>}
    <div className="sl-filters" aria-label="记录筛选">
      {FILTERS.map(([key, label]) => <button key={key} type="button" disabled={['received', 'sent'].includes(key) && !sessionId} title={['received', 'sent'].includes(key) && !sessionId ? '先选择一个会话再查看收件或发件' : undefined} aria-pressed={filter === key} onClick={() => { setFilter(key); setChainId(''); setOffset(0); setSelected(null); }}>{label}</button>)}
      <label className="sl-session-filter">会话<select value={sessionId} onChange={event => { setSessionId(event.target.value); if (!event.target.value && ['received', 'sent'].includes(filter)) setFilter('all'); setOffset(0); setSelected(null); }}><option value="">全部会话</option>{sessions.map(item => { const id = item.sessionId ?? item.id; return <option key={id} value={id}>{sessionLabel(id, sessions)}</option>; })}</select></label>
    </div>
    <section className="sl-list" aria-label="通信记录列表">
      {!messages.length ? <div className="sl-empty">{filter === 'all' ? '还没有通信记录。让主会话联系另一个会话后，记录会出现在这里。' : '此筛选下没有记录。'}<p className="sl-muted">本插件没有手动发送表单。</p></div> : messages.map(item => <button key={item.id} type="button" className={`sl-record ${selected === item.id ? 'sl-selected' : ''}`} onClick={() => setSelected(item.id)}>
        <div className="sl-route"><span data-i18n-skip="">{sessionLabel(item.from, sessions, item.fromTitle)}</span><span aria-hidden="true">→</span><span>{sessionLabel(item.to, sessions, item.toTitle)}</span></div>
        <div className="sl-preview">{textOf(item) || '正文已清理，或此记录无正文。'}</div>
        <div className="sl-record-meta"><span className={`sl-status sl-${statusOf(item)}`}>{messageState(item)}</span><time>{date(item.createdAt)}</time><code>#{short(item.id)}</code></div>
      </button>)}
      <div className="sl-pagination"><Action busy={busy || offset === 0} onClick={() => { setOffset(Math.max(0, offset - LIMIT)); setSelected(null); }}>上一页</Action><span>{total} 条 · 第 {Math.floor(offset / LIMIT) + 1} 页</span><Action busy={busy || offset + LIMIT >= total} onClick={() => { setOffset(offset + LIMIT); setSelected(null); }}>下一页</Action></div>
    </section>
    {message ? <RecordDetail message={message} snapshot={snapshot} busy={busy} writable={writable} act={act} open={open} selectChain={id => { setFilter('chain'); setChainId(id); setSessionId(''); setOffset(0); setSelected(null); }}/> : <p className="sl-muted">选择一条记录，查看投递证据和关联回复。</p>}
  </div>;
}

// Retired main route: a fixed hint only. It must not render a second page of
// records or settings, and it is not a visible entry (no sidebar registration).
export function MigrationNotice() {
  return <div className="sl-migrate"><p>会话互通入口已移至：设置 → 会话互通。</p></div>;
}

function saveNotice(value) {
  const parts = ['设置已保存。'];
  if (value?.queued) parts.push(`已排队 ${value.queued} 条消息。`);
  if (value?.resumed) parts.push(`已恢复投递 ${value.resumed} 条消息。`);
  parts.push('已开始的工作不会被撤销。');
  return parts.join(' ');
}

export function GlobalSettingsPage({ close, openSession }) {
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('settings');
  const [filter, setFilter] = useState('all');
  const [sessionId, setSessionId] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState(null);
  const [chainId, setChainId] = useState('');
  const alive = useRef(true), refresh = useRef(async () => {}), request = useRef(null);

  useEffect(() => {
    alive.current = true;
    let timer, failures = 0, stopped = false;
    const load = async () => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      try {
        const result = await callApi('snapshot', { limit: LIMIT, offset, filter, ...(sessionId ? { sessionId } : {}), ...(chainId ? { chainId } : {}) }, { signal: controller.signal });
        if (!stopped && !controller.signal.aborted) { setSnapshot(result); setError(''); failures = 0; }
      } catch (err) {
        if (!stopped && err.name !== 'AbortError') { setError(err.message); failures++; }
      }
    };
    refresh.current = load;
    const tick = async () => { if (document.visibilityState !== 'hidden') await load(); if (!stopped) timer = setTimeout(tick, Math.min(30000, 3000 * 2 ** failures)); };
    void tick();
    return () => { stopped = true; alive.current = false; clearTimeout(timer); request.current?.abort(); };
  }, [filter, sessionId, offset, chainId]);

  const writable = storageWritable(snapshot?.storage);
  const compatible = apiCompatible(snapshot);

  const mutate = async (action, payload) => {
    setBusy(true); setNotice(''); setActionError('');
    try {
      await callApi(action, payload);
      if (alive.current) setNotice('操作已提交；记录已刷新。');
      await refresh.current();
      return true;
    } catch (err) {
      if (alive.current) setActionError(action === 'settings' ? describeSettingsError(err) : describeControlError(err));
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const saveSettings = async (patch, expectedSettingsRevision) => {
    setBusy(true); setNotice(''); setActionError('');
    try {
      const value = await callApi('settings', { expectedSettingsRevision, patch });
      if (alive.current) {
        // Apply the authoritative revisions immediately so a failed follow-up
        // poll cannot show pre-save settings again.
        setSnapshot(current => current ? {
          ...current,
          revision: value?.revision ?? current.revision,
          settingsRevision: value?.settingsRevision ?? current.settingsRevision,
          settings: value?.settings ?? current.settings,
        } : current);
        setNotice(saveNotice(value));
      }
      await refresh.current();
      return { ok: true, value };
    } catch (err) {
      if (alive.current) setActionError(describeSettingsError(err));
      return { ok: false, error: err };
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const act = (action, id, extra = {}) => mutate('control', { expectedRevision: snapshot.revision, action, id, ...extra });
  const open = id => {
    if (!id) return;
    try { if (typeof close === 'function') close(); } catch (err) { setActionError(err.message); return; }
    try { openSession?.(id); } catch (err) { setActionError(err.message); }
  };

  return <section className="sl-section" aria-label="会话互通页面" data-sl-root="" data-session-link-i18n-root="">
    <h2>会话互通</h2>
    {!snapshot && !error && <p className="sl-empty" role="status">正在读取通信记录…</p>}
    {error && <div className="sl-alert" role="alert">{error}<span> · 可刷新重试；失败操作不会显示为成功。</span></div>}
    {snapshot && !compatible && <div className="sl-alert" role="alert">此页面与插件版本不一致（apiVersion {String(snapshot.apiVersion ?? '缺失')}）。请刷新页面；若仍出现，请更新插件后再打开设置。<button type="button" className="sl-button" onClick={() => globalThis.location?.reload()}>刷新页面</button></div>}
    {actionError && <div className="sl-alert" role="alert">操作未完成：{actionError} <Action busy={false} onClick={() => setActionError('')}>关闭提示</Action></div>}
    {notice && <div className="sl-notice" role="status">{notice}</div>}
    {snapshot && compatible && <>
      <StatusLine snapshot={snapshot}/>
      <Banners snapshot={snapshot}/>
      <Tabs value={tab} onChange={setTab}/>
      <div id="sl-panel-settings" role="tabpanel" aria-labelledby="sl-tab-settings" hidden={tab !== 'settings'}>
        <SettingsForm snapshot={snapshot} writable={writable} busy={busy} save={saveSettings}/>
        <TechnicalDetails snapshot={snapshot}/>
      </div>
      <div id="sl-panel-records" role="tabpanel" aria-labelledby="sl-tab-records" hidden={tab !== 'records'}>
        <RecordsPanel snapshot={snapshot} busy={busy} writable={writable} act={act} open={open} filter={filter} setFilter={setFilter} sessionId={sessionId} setSessionId={setSessionId} offset={offset} setOffset={setOffset} selected={selected} setSelected={setSelected} chainId={chainId} setChainId={setChainId}/>
      </div>
    </>}
  </section>;
}

export function apply(ctx) {
  try {
    const disposeI18n = installI18n(ctx);
    if (typeof disposeI18n === 'function') ctx.effect(() => disposeI18n, 'session-link i18n');
  } catch {
    console.warn('[session-link] Locale translation unavailable; UI stays Chinese.');
  }
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = name;
    style.textContent = css + CARD_CSS;
    document.head.append(style);
    return () => style.remove();
  });
  // The retired main route only explains where the entry went; it is not a
  // second visible entry and it never renders records or settings.
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, MigrationNotice));
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'session-link-settings',
    // Static ReactNode label: the settings shell renders it inside the nav row.
    label: () => <NavLabel />,
    order: 337,
    inject: () => ({ openSession: target => ctx.uiWorkspace.openSession(target) }),
  }, GlobalSettingsPage));
  try {
    installIncomingCards(ctx);
  } catch {
    // A failed card setup must not take the existing settings entry down.
    console.warn('[session-link] Incoming cards unavailable; native chat remains available.');
  }
  try {
    installOutgoingCards(ctx);
  } catch {
    console.warn('[session-link] Outgoing cards unavailable; native chat remains available.');
  }
}
