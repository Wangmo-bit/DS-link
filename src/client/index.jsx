// Intent: one owner entry under Settings -> 会话互通 that explains delivery
// evidence and lets the owner stop runaway work; this plugin still has no
// manual send form.
// Palette/surfaces/type: inherit DSH tokens; subtle borders, semantic status,
// 4px spacing grid. The global panel shell owns the page frame; this module
// renders the page and its left-sidebar entry (link glyph).
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
  formatBytes,
  storageWritable,
  technicalLimitRows,
  textOf,
} from './model.js';
import css from './style.css';
import { CARD_CSS, BUBBLE_CSS } from './card-shell.mjs';
import { installIncomingCards } from './incoming-cards.jsx';
import { installOutgoingCards } from './outgoing-cards.jsx';
import { installChatSkin } from './chat-skin.js';
import { installI18n, translateText } from './i18n.js';

export const name = '@wangmo/dsh-session-link';
export const inject = ['slots', 'layout', 'connection', 'uiWorkspace', 'sessions', 'uiConversation', 'locale'];
const PANEL = 'session-link';
const TAB_ORDER = ['settings', 'records'];
const FILTERS = [['all', '全部'], ['pending_reply', '待回复'], ['abnormal', '异常 / 未确认']];
const KIND = { request: '协作请求', notification: '通知', reply: '明确回复' };
const date = value => value ? new Date(value).toLocaleString() : '—';
const short = value => String(value ?? '').slice(0, 8);
const statusOf = message => message.dispatchStatus ?? message.status;

function LinkIcon({ size = 16, active } = {}) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" data-session-link-nav-icon={active ? 'active' : 'idle'}>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
  </svg>;
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
  const inFlight = Number(snapshot.inFlight ?? 0);
  const records = Number(snapshot.total ?? snapshot.messages?.length ?? 0);
  return <p className="sl-statusline" role="status">
    <span>{inFlight > 0 ? `正在投递 ${inFlight} 条消息` : '当前没有正在投递的消息'}</span>
    <span className="sl-muted">{records > 0 ? `已有 ${records} 条通信记录` : '还没有通信记录'}</span>
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
    <div className="sl-settings-grid">
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
    </div>
    {localError && <p className="sl-alert" role="alert">{localError}</p>}
    <div className="sl-actions">
      <button type="submit" className="sl-button sl-primary" disabled={busy || !writable || !dirty}>{saving ? '保存中…' : '保存并应用'}</button>
    </div>
  </form>;
}

function TechnicalDetails({ snapshot }) {
  const rows = technicalLimitRows(snapshot.technicalLimits);
  const migration = snapshot.migration;
  const storage = snapshot.storage;
  const usage = storage
    ? `已用空间 ${formatBytes(storage.bytes)} / 上限 ${formatBytes(storage.maxBytes)} · 待投递 ${formatBytes(storage.queuedBytes)} / ${formatBytes(storage.maxQueuedBytes)}`
    : '';
  const counts = storage ? `共 ${storage.messageCount ?? 0} 条通信记录，${storage.chainCount ?? 0} 组关联通信。` : '';
  return <details className="sl-tech">
    <summary>技术说明</summary>
    <div className="sl-tech-body">
      {usage && <p className="sl-tech-line">{usage}</p>}
      {counts && <p className="sl-tech-line">{counts}</p>}
      {rows.length > 0 && <dl className="sl-tech-list">{rows.map(row => <React.Fragment key={row.key}><dt>{row.label}</dt><dd>{row.value}</dd></React.Fragment>)}</dl>}
      {migration && <p className="sl-tech-line">已从旧版迁移（{date(migration.migratedAt)}）· 原始备份{migration.backupAvailable ? '可用' : '不可用'} · 旧版配额暂停记录 {migration.retiredQuotaPauses ?? 0} 条（已停用）· 旧版锁 {migration.retiredLatches ?? 0} 个（已停用）。</p>}
      <p className="sl-tech-line">以上是本机当前生效的容量与分页/幂等窗口，不是按条数的业务配额；超限会明确报错，不静默截断或丢弃。</p>
    </div>
  </details>;
}

export function RecordDetail({ message, snapshot, busy, writable, act, open, thread }) {
  const status = statusOf(message);
  const sessions = snapshot.sessions ?? [];
  const chain = (snapshot.chains ?? []).find(item => item.id === message.chainId);
  const chainState = chain?.state ?? message.chainState;
  const messages = thread?.length ? thread : [message];
  const blocked = busy || !writable;
  const hint = heldHint(message, chainState);
  const receipt = receiptOf(message);
  const receiptText = receiptStateText(message);
  const transferText = receiptTransferText(receipt?.transfer);
  const deadlineVisible = requestDeadlineVisible(message);
  const legacyTiming = receiptLegacyHint(message);
  const fromLabel = sessionLabel(message.from, sessions, message.fromTitle);
  const toLabel = sessionLabel(message.to, sessions, message.toTitle);
  return <section className="sl-detail" aria-label="消息详情">
    <div className="sl-thread-head">
      <h3>{fromLabel} <span aria-hidden="true">→</span> {toLabel}</h3>
      <span className={`sl-status sl-${status}`}>{messageState(message)}</span>
    </div>
    <div className="sl-thread" aria-label="完整往返">
      {messages.map(item => <article className={item.id === message.id ? 'sl-thread-msg is-current' : 'sl-thread-msg'} key={item.id}>
        <div className="sl-thread-author">{sessionLabel(item.from, sessions, item.fromTitle)}</div>
        <div className="sl-thread-bubble" data-i18n-skip="">{textOf(item) || '正文已清理，或此记录无正文。'}</div>
        <div className="sl-thread-meta"><span className={`sl-status sl-${statusOf(item)}`}>{messageState(item)}</span><time>{date(item.createdAt)}</time></div>
        {item.error && <p className="sl-alert" role="status" data-i18n-skip="">{typeof item.error === 'string' ? item.error : `${item.error.code}：${item.error.message}`}</p>}
      </article>)}
    </div>
    {status === 'unknown' && <p className="sl-note">消息可能已执行，但尚无可靠确认。不要直接重发；先核对目标会话。人工结案不等于证明未投递。</p>}
    {hint && <p className="sl-note">{hint}</p>}
    {receipt?.state === 'queued' && <p className="sl-note">“已送达 · 待接收”表示宿主已接收并排队，尚未确认进入目标会话上下文；不是已读。</p>}
    {receipt?.state === 'uncertain' && receipt.policy !== 'legacy-accepted' && <p className="sl-note">接收需核对：尚无可靠的上下文接收证据；不会自动重发，请核对目标会话。</p>}
    {receipt?.transfer?.state === 'uncertain' && <p className="sl-alert" role="status">转移需核对：原消息可能已经移动但无法确认；保留原记录，不自动重发，请核对目标会话的待处理输入。</p>}
    {legacyTiming && <p className="sl-note">旧计时规则：这条旧记录沿用 0.2 的期限与超时结果，接收证据只作辅助，不重算。</p>}
    {chainState === 'paused' && <p className="sl-note">这组通信已暂停；恢复后继续投递尚未开始的消息，已开始的工作不受影响。</p>}
    {chainState === 'closed' && <p className="sl-note">这组通信已结束；未投递的消息已取消，已开始的工作不受影响。</p>}
    {!writable && <p className="sl-alert" role="status">存储异常：记录只读，控制操作已禁用。</p>}
    <details className="sl-delivery">
      <summary>投递详情</summary>
      <dl className="sl-meta">
        <dt>创建</dt><dd>{date(message.createdAt)}</dd>
        <dt>宿主接收</dt><dd>{date(message.acceptedAt)}</dd>
        {receipt && receipt.receivedAt != null && <><dt>接收时间</dt><dd>{date(receipt.receivedAt)}{Number.isSafeInteger(receipt.receivedSeq) && <> · seq {receipt.receivedSeq}</>}</dd></>}
        {receipt && receiptText && <><dt>接收状态</dt><dd>{receiptText}</dd></>}
        {receipt?.transfer && <><dt>转移</dt><dd>{transferText} · {date(receipt.transfer.at)}</dd></>}
        {deadlineVisible && <><dt>等待期限</dt><dd>{date(message.deadlineAt)}</dd></>}
        <dt>类型</dt><dd>{KIND[message.kind] ?? message.kind}</dd>
        <dt>关联消息</dt><dd>{messages.length} 条往返记录</dd>
        <dt>持久身份</dt><dd><code data-i18n-skip="">{message.durableMessageId ?? ''}</code>{!message.durableMessageId && <span className="sl-muted">尚未创建宿主消息</span>}</dd>
      </dl>
      <p className="sl-tech-line">“已进入上下文”只表示目标会话已接收这条消息，不代表已读或已处理，也不代表请求已发给模型。</p>
    </details>
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
    </div>
  </section>;
}

function SessionPicker({ label, value, onChange, sessions }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = event => { if (!box.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  const current = value ? sessionLabel(value, sessions) : '全部';
  const options = [{ value: '', label: '全部' }, ...sessions.map(item => {
    const id = item.sessionId ?? item.id;
    return { value: id, label: sessionLabel(id, sessions) };
  })];
  const choose = next => { onChange(next); setOpen(false); };
  const keyDown = event => {
    if (event.key === 'Escape') { setOpen(false); return; }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen(true); }
  };
  return <div className="sl-slicer" ref={box}>
    <span>{label}</span>
    <button type="button" className="sl-slicer__button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(current => !current)} onKeyDown={keyDown}>
      <span className="sl-slicer__value">{current}</span><span className="sl-slicer__chevron" aria-hidden="true">⌄</span>
    </button>
    {open && <div className="sl-slicer__menu" role="listbox" aria-label={label}>
      {options.map(option => <button key={option.value || 'all'} type="button" role="option" aria-selected={option.value === value} className={option.value === value ? 'sl-slicer__option is-selected' : 'sl-slicer__option'} onClick={() => choose(option.value)}>{option.label}</button>)}
    </div>}
  </div>;
}

class RecordBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) return <div className="sl-empty" role="alert">通信记录页加载失败：{this.state.error.message}<button type="button" className="sl-button" onClick={() => this.setState({ error: null })}>重试</button></div>;
    return this.props.children;
  }
}

export function RecordsPanel({ snapshot, busy, writable, act, open, filter, setFilter, senderSessionId, setSenderSessionId, receiverSessionId, setReceiverSessionId, offset, setOffset, selected, setSelected, chainId, setChainId }) {
  const messages = snapshot.messages ?? [];
  const sessions = snapshot.sessions ?? [];
  const message = messages.find(item => item.id === selected);
  const total = snapshot.total ?? messages.length;
  const [thread, setThread] = useState(null);
  useEffect(() => {
    if (!message?.chainId) { setThread(null); return undefined; }
    const controller = new AbortController();
    let alive = true;
    setThread(null);
    callApi('snapshot', { view: 'thread', chainId: message.chainId }, { signal: controller.signal })
      .then(result => { if (alive) setThread(result.messages ?? []); })
      .catch(error => { if (alive && error.name !== 'AbortError') setThread(null); });
    return () => { alive = false; controller.abort(); };
  }, [selected, message?.chainId]);
  const reset = () => { setOffset(0); setSelected(null); };
  const chooseFilter = key => { setFilter(key); setChainId(''); reset(); };
  const chooseSender = next => { setSenderSessionId(next); setChainId(''); reset(); };
  const chooseReceiver = next => { setReceiverSessionId(next); setChainId(''); reset(); };
  return <div className="sl-records">
    {chainId && <div className="sl-note sl-actions"><span>当前关联消息：<code>{chainId}</code></span><Action busy={busy} onClick={() => { setFilter('all'); setChainId(''); setOffset(0); setSelected(null); }}>退出关联筛选</Action></div>}
    <div className="sl-mail-layout">
      <aside className="sl-mail-list" aria-label="通信记录列表">
        <div className="sl-mail-toolbar">
          <div className="sl-filters" aria-label="记录筛选">
            {FILTERS.map(([key, label]) => <button key={key} type="button" aria-pressed={filter === key} onClick={() => chooseFilter(key)}>{label}</button>)}
          </div>
          <div className="sl-slicers">
            <SessionPicker label="发件会话" value={senderSessionId} onChange={next => chooseSender(next)} sessions={sessions}/>
            <SessionPicker label="收件会话" value={receiverSessionId} onChange={next => chooseReceiver(next)} sessions={sessions}/>
          </div>
        </div>
        <section className="sl-list" aria-label="通信记录列表">
          {!messages.length ? <div className="sl-empty">{filter === 'all' && !senderSessionId && !receiverSessionId ? '还没有通信记录。' : '没有符合条件的记录。'}</div> : messages.map(item => <button key={item.id} type="button" className={`sl-record ${selected === item.id ? 'sl-selected' : ''}`} onClick={() => setSelected(item.id)}>
            <div className="sl-route"><span data-i18n-skip="">{sessionLabel(item.from, sessions, item.fromTitle)}</span><span aria-hidden="true">→</span><span data-i18n-skip="">{sessionLabel(item.to, sessions, item.toTitle)}</span></div>
            <div className="sl-preview"><span data-i18n-skip="">{textOf(item) || ''}</span>{!textOf(item) && '正文已清理，或此记录无正文。'}</div>
            <div className="sl-record-meta"><span className={`sl-status sl-${statusOf(item)}`}>{messageState(item)}</span><time>{date(item.createdAt)}</time><code>#{short(item.id)}</code></div>
          </button>)}
        </section>
        <div className="sl-pagination"><Action busy={busy || offset === 0} onClick={() => { setOffset(Math.max(0, offset - LIMIT)); setSelected(null); }}>上一页</Action><span>{total} 条 · 第 {Math.floor(offset / LIMIT) + 1} 页</span><Action busy={busy || offset + LIMIT >= total} onClick={() => { setOffset(offset + LIMIT); setSelected(null); }}>下一页</Action></div>
      </aside>
      <section className="sl-mail-detail" aria-label="通信记录详情">
        {message ? <RecordDetail message={message} snapshot={snapshot} busy={busy} writable={writable} act={act} open={open} thread={thread}/> : <p className="sl-mail-empty">从左侧选择一条记录，查看正文和投递证据。</p>}
      </section>
    </div>
  </div>;
}

function saveNotice(value) {
  const parts = ['设置已保存。'];
  if (value?.queued) parts.push(`已排队 ${value.queued} 条消息。`);
  if (value?.resumed) parts.push(`已恢复投递 ${value.resumed} 条消息。`);
  parts.push('已开始的工作不会被撤销。');
  return parts.map((part) => translateText(part)).join(' ');
}

export function GlobalSettingsPage({ close, openSession }) {
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('settings');
  const [filter, setFilter] = useState('all');
  const [senderSessionId, setSenderSessionId] = useState('');
  const [receiverSessionId, setReceiverSessionId] = useState('');
  const [sessions, setSessions] = useState([]);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState(null);
  const [chainId, setChainId] = useState('');
  const alive = useRef(true), refresh = useRef(async () => {}), request = useRef(null), sessionsLoaded = useRef(false);

  useEffect(() => {
    alive.current = true;
    let timer, failures = 0, stopped = false;
    const loadSessions = async () => {
      if (sessionsLoaded.current) return;
      try {
        const result = await callApi('snapshot', { view: 'sessions' });
        if (!stopped) { sessionsLoaded.current = true; setSessions(result.sessions ?? []); }
      } catch (err) {
        if (!stopped && err.name !== 'AbortError') setError(err.message);
      }
    };
    const load = async () => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      try {
        const view = tab === 'records' ? 'records' : 'settings';
        const payload = {
          limit: LIMIT,
          offset,
          filter,
          ...(senderSessionId ? { senderSessionId } : {}),
          ...(receiverSessionId ? { receiverSessionId } : {}),
          ...(chainId ? { chainId } : {}),
        };
        let result;
        try {
          result = await callApi('snapshot', { view, ...payload }, { signal: controller.signal });
        } catch (error) {
          if (view !== 'records' || error.name === 'AbortError') throw error;
          result = await callApi('snapshot', payload, { signal: controller.signal });
        }
        if (!stopped && !controller.signal.aborted) {
          setSnapshot(result); setError(''); failures = 0;
          if (view === 'records') void loadSessions();
        }
      } catch (err) {
        if (!stopped && err.name !== 'AbortError') { setError(err.message); failures++; }
      }
    };
    refresh.current = load;
    const tick = async () => { if (document.visibilityState !== 'hidden') await load(); if (!stopped) timer = setTimeout(tick, Math.min(30000, 3000 * 2 ** failures)); };
    void tick();
    return () => { stopped = true; alive.current = false; clearTimeout(timer); request.current?.abort(); };
  }, [tab, filter, senderSessionId, receiverSessionId, offset, chainId]);

  const panelSnapshot = snapshot && sessions.length ? { ...snapshot, sessions } : snapshot;
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

  return <section className="sl-section sl-page" aria-label="会话互通页面" data-sl-root="" data-session-link-i18n-root="">
    <header className="sl-page-head">
      <h1>会话互通</h1>
      <p className="sl-lead">管理会话之间的消息投递和通信记录。</p>
    </header>
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
        <section className="sl-page-card">
          <div className="sl-page-card-body">
            <SettingsForm snapshot={snapshot} writable={writable} busy={busy} save={saveSettings}/>
          </div>
        </section>
      </div>
      <div id="sl-panel-records" role="tabpanel" aria-labelledby="sl-tab-records" hidden={tab !== 'records'}>
        <section className="sl-page-card">
          <div className="sl-page-card-body">
            {snapshot.messages ? <RecordBoundary><RecordsPanel snapshot={panelSnapshot} busy={busy} writable={writable} act={act} open={open} filter={filter} setFilter={setFilter} senderSessionId={senderSessionId} setSenderSessionId={setSenderSessionId} receiverSessionId={receiverSessionId} setReceiverSessionId={setReceiverSessionId} offset={offset} setOffset={setOffset} selected={selected} setSelected={setSelected} chainId={chainId} setChainId={setChainId}/></RecordBoundary> : <p className="sl-empty" role="status">正在读取通信记录…</p>}
          </div>
        </section>
      </div>
      <div className="sl-diagnostics"><TechnicalDetails snapshot={snapshot}/></div>
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
    style.textContent = css + CARD_CSS + BUBBLE_CSS;
    document.head.append(style);
    return () => style.remove();
  });
  // The page lives in the global panel row, not inside Settings. The main slot
  // renders it; sidebar.panellist owns the always-visible left-side entry.
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL,
    inject: () => ({ openSession: target => ctx.uiWorkspace.openSession(target) }),
  }, GlobalSettingsPage));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL,
    order: 30,
    label: () => translateText('会话互通'),
  }, LinkIcon));
  try {
    installChatSkin(ctx);
  } catch {
    // A visual skin failure must not take messaging down.
    console.warn('[session-link] Chat skin unavailable; native chat remains.');
  }
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
