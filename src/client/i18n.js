// Host-locale-driven UI translation for user-visible chrome. This is deliberately
// a presentation layer: user message bodies, subjects, paths, ids, protocol keys
// and ledger values are marked data-i18n-skip and never translated.
const EN = {
  '我': 'You',
  '消息展示模式': 'Message display mode',
  '仅影响当前浏览器的DS-link展示，不改变消息或投递。': 'Local to this browser; changes presentation, not messages or delivery.',
  '气泡模式': 'Bubble mode',
  '卡片模式': 'Card mode',
  '保存并应用': 'Save and apply',
  '1～10；只限制同时入队的消息，不限制会话同时工作。': '1–10 delivery channels; does not limit how many sessions can work.',
  '我的气泡显示名称': 'My bubble display name',
  '仅当前浏览器显示；留空显示“我”。不改变账号、发送者身份或权限。': 'Local to this browser; leave blank for “You”. Does not change your account, sender identity or permissions.',
  '显示名称限 40 个字符，不能含换行或控制字符。': 'Use up to 40 characters without line breaks or control characters.',
  '浏览器未能保存显示名称；已保存的其他设置不受影响，请检查站点存储权限后重试。': 'Could not save the display name. Other saved settings are unaffected; check site storage permissions and retry.',
  'DS-link': 'DS-link',
  '连接本机 DSH 会话，管理消息投递和通信记录。': 'Connect sessions on this DSH host and manage delivery and records.',
  'DS-link已关闭；重新开启且未暂停后继续。': 'DS-link is off; resume after enabling and unpausing.',
  'DS-link页面': 'DS-link page',
  'DS-link设置': 'DS-link settings',
  'DS-link入口已移至：设置 → DS-link。': 'DS-link moved to: Settings → DS-link.',
  '会话协作，非本人指令': 'Collaboration, not a user instruction',
  '开启DS-link': 'Enable DS-link',
  '关闭后拒绝新通信；记录仍可查看，未投递记录保留。': 'When off, new messages are rejected; records stay visible and undelivered items are kept.',
  'DS-link已关闭：新消息会被拒绝；未投递记录保留，记录仍可查看。': 'DS-link is off: new messages are rejected; undelivered records stay visible.',
  '暂停新消息投递': 'Pause new delivery',
  '暂停时新消息排队，不打断已开始的工作；恢复后继续投递。': 'While paused, new messages queue; started work is not interrupted. Delivery resumes after unpausing.',
  '已暂停新消息投递：新消息排队，不打断已开始的工作；恢复后继续投递。': 'New delivery paused: new messages queue; started work continues. Delivery resumes after unpausing.',
  '全局已暂停新消息投递；恢复后自动继续。': 'New delivery is globally paused; it resumes after unpausing.',
  '更多设置': 'More settings',
  '同时投递通道数': 'Concurrent delivery channels',
  '回复等待时间（分钟）': 'Reply wait (minutes)',
  '回复等待时间必须是正数分钟': 'Reply wait must be a positive number of minutes',
  '已完成消息正文保留天数': 'Retention days for completed message bodies',
  '保存设置': 'Save settings',
  '保存中…': 'Saving…',
  '设置已保存。': 'Settings saved.',
  '没有需要保存的改动。': 'No changes to save.',
  '放弃草稿': 'Discard draft',
  '技术说明（只读）': 'Technical notes (read-only)',
  '以上是本机当前生效的技术容量与分页/幂等窗口，不是按条数的业务配额；超限会明确报错，不静默截断或丢弃。': 'These are the live technical capacity, paging and idempotency windows on this host; they are not per-message business quotas. Limits fail loudly, never truncate or drop silently.',
  '来源': 'From', '目标': 'To', '创建': 'Created', '宿主接收': 'Host received',
  '接收时间': 'Received at', '接收状态': 'Receipt', '转移': 'Move', '等待期限': 'Deadline',
  '类型': 'Kind', '关联消息': 'Related message', '查看关联消息': 'View related message',
  '持久身份': 'Durable identity', '消息详情': 'Message details', '通信记录': 'Records',
  '通信记录列表': 'Record list', '记录筛选': 'Record filter', '全部': 'All',
  '全部会话': 'All sessions', '会话': 'Session', '上一页': 'Previous', '下一页': 'Next',
  '选择一条记录，查看投递证据和关联回复。': 'Select a record to inspect delivery evidence and related replies.',
  '还没有通信记录。让主会话联系另一个会话后，记录会出现在这里。': 'No records yet. After a session contacts another session, records appear here.',
  '此筛选下没有记录。': 'No records under this filter.',
  '正在读取通信记录…': 'Loading records…',
  '刷新页面': 'Refresh page', '关闭提示': 'Dismiss', '重试': 'Retry',
  '· 可刷新重试；失败操作不会显示为成功。': '· You can refresh and retry; failed operations never show as success.',
  '最近一次刷新失败，显示的是上次结果': 'Last refresh failed; showing the previous result',
  '先选择一个会话再查看收件或发件': 'Select a session to inspect received or sent messages',
  '本插件没有手动发送表单。': 'This plugin has no manual send form.',
  '消息可能已执行，但尚无可靠确认。不要直接重发；先核对目标会话。人工结案不等于证明未投递。': 'The message may have executed but has no reliable confirmation. Do not resend; verify the target session. Manual closure is not proof of non-delivery.',
  '只有你已查实目标接收时才确认。此操作不会重发，且会记录人工确认。': 'Confirm only after verifying the target received it. This never resends and records the manual confirmation.',
  '只在你确认这条旧版暂存记录可以投递时才释放；它仍会按当前通道与暂停设置排队，不会绕过全局暂停。': 'Release only when you confirm this legacy held record may be delivered; it still queues under current channels and pause settings, never bypassing a global pause.',
  '取消尚未投递的消息': 'Cancel undelivered messages',
  '明确释放这条暂存消息': 'Release this held message',
  '重新核对宿主证据': 'Re-check host evidence',
  '人工确认已接收': 'Mark manually as received',
  '结束此记录为未确认': 'Close as unconfirmed',
  '暂停这组通信': 'Pause this chain', '恢复这组通信': 'Resume this chain', '结束这组通信': 'End this chain',
  '这组通信已暂停；恢复后继续投递尚未开始的消息，已开始的工作不受影响。': 'This chain is paused; undelivered messages resume after unpausing. Started work is unaffected.',
  '这组通信已结束；未投递的消息已取消，已开始的工作不受影响。': 'This chain ended; undelivered messages were cancelled. Started work is unaffected.',
  '结束这组通信会取消尚未投递的消息；不会撤销已开始的工作。': 'Ending this chain cancels undelivered messages; it does not undo started work.',
  '“已进入上下文”只表示目标会话已接收这条消息，不代表已读或已处理，也不代表请求已发给模型。': '“Received into context” only means the target session accepted the message. It is not read/processed, and not proof the request reached the model.',
  '“已送达 · 待接收”表示宿主已接收并排队，尚未确认进入目标会话上下文；不是已读。': '“Delivered · awaiting receipt” means the host accepted and queued it; it is not yet confirmed in the target context and is not read.',
  '接收需核对：尚无可靠的上下文接收证据；不会自动重发，请核对目标会话。': 'Receipt needs verification: no reliable context-receipt evidence. Nothing is resent automatically; verify the target session.',
  '转移需核对：原消息可能已经移动但无法确认；保留原记录，不自动重发，请核对目标会话的待处理输入。': 'Move needs verification: the original may have moved but cannot be confirmed. The record is kept; nothing is resent. Verify the target session input.',
  '旧计时规则：这条旧记录沿用 0.2 的期限与超时结果，接收证据只作辅助，不重算。': 'Legacy timing: this old record keeps 0.2 deadlines and timeout results; receipt evidence is supporting only and is not recomputed.',
  '“已投递”只表示宿主接收，不代表已读或已处理；超时不撤销任务。': '“Delivered” only means the host received it, not read/processed; timeout does not cancel the task.',
  '“已送达 · 待接收”“已进入上下文”都不是“已读”。超时不撤销任务；停止/归档目标可能影响其待处理输入。': 'Neither “delivered” nor “received into context” means read. Timeouts do not cancel the task; stopping/archiving the target may affect pending input.',
  '关联回复（当前加载页）': 'Related replies (current page)',
  '当前页暂无关联记录。可通过关联消息筛选继续查询。': 'No related records on this page. Use the related-message filter to continue.',
  '当前关联消息：': 'Current related message: ',
  '退出关联筛选': 'Exit related filter',
  '引用的本机路径': 'Referenced local paths',
  '只传路径，不搬运文件；工作目录和权限仍各自独立。': 'Paths are passed, files are not moved; working directories and permissions stay independent.',
  '历史引用': 'Historical references',
  '面板快照分页': 'Snapshot page size', '历史消息分页': 'History page size',
  '历史正文每页': 'History body per page', '工具列表分页': 'Tool list page size',
  '单条正文最大': 'Max body size', '单次调用最大': 'Max call size',
  '单条引用字符': 'Max chars per reference', '单条路径字符': 'Max chars per path',
  '引用条数': 'Max references', '路径条数': 'Max paths',
  '账本容量': 'Ledger capacity', '未投递队列容量': 'Undelivered queue capacity',
  '幂等记录保留': 'Idempotency retention', '幂等首次提交窗口': 'Idempotency first-submit window',
  '容量接近上限（≥90%）：新消息可能被拒绝，已有事务仍可继续。': 'Near capacity (≥90%): new messages may be rejected; existing transactions can continue.',
  '容量已满：新消息会被拒绝，已有事务仍可继续；请清理后再继续通信。': 'At capacity: new messages are rejected; existing transactions can continue. Clean up before continuing.',
  '存储异常：账本只读，保存设置与控制操作均被禁用；请等待安全重开核对后重试。': 'Storage error: ledger is read-only; settings and control actions are disabled. Wait for a safe reopen and retry.',
  '存储异常：记录只读，控制操作已禁用。': 'Storage error: records are read-only; control actions are disabled.',
  '存储异常：设置保存已禁用，当前只读。': 'Storage error: saving settings is disabled; currently read-only.',
  '当前连接无权访问DS-link；仅宿主本人可用。': 'This connection cannot access DS-link; owner-only.',
  '当前页面版本过旧：旧设置项已被移除。请刷新页面后重试。': 'This page is too old: legacy settings were removed. Refresh and retry.',
  '旧版自动协作关闭（迁移保留）；需要人工确认后释放。': 'Legacy auto-collaboration off (kept for migration); requires manual confirmation before release.',
  '旧版紧急暂停（迁移保留）；需要人工确认后释放。': 'Legacy emergency pause (kept for migration); requires manual confirmation before release.',
  '旧版预算操作已被移除；请刷新页面。': 'Legacy budget action was removed; refresh the page.',
  '旧版暂存容量限制（迁移保留）；需要人工确认后释放。': 'Legacy held capacity limit (kept for migration); requires manual confirmation before release.',
  '旧版暂存记录需要人工确认；仅在你确认安全后才释放。': 'Legacy held record needs manual confirmation; release only after you confirm it is safe.',
  '等待确认超时；操作可能已经提交，请刷新核对，不要直接重复执行。': 'Confirmation timed out; the operation may have submitted. Refresh and verify; do not repeat it directly.',
  '异常 / 未确认': 'Error / unconfirmed', '需核对': 'Needs verification', '需要核对': 'Needs verification',
  '状态未知': 'Status unknown', '未知状态': 'Unknown state', '未知原因': 'Unknown reason',
  '未知会话': 'Unknown session', '未知发送会话': 'Unknown sender session', '未知接收者': 'Unknown recipient',
  '未知工具': 'Unknown tool', '缺失': 'Missing', '不可用': 'Unavailable', '正常': 'OK',
  '接近上限': 'Near limit', '已满': 'Full', '已暂停': 'Paused', '已结束': 'Ended',
  '已取消': 'Cancelled', '已回复': 'Replied', '已转移': 'Moved', '已投递': 'Delivered',
  '已进入上下文': 'Received into context', '已送达 · 待接收': 'Delivered · awaiting receipt',
  '宿主已接收·待进入上下文': 'Host received · awaiting context', '宿主已接收·进入上下文未确认': 'Host received · context unconfirmed',
  '宿主已返回结果': 'Host returned a result', '宿主返回错误': 'Host returned an error',
  '尚未创建宿主消息': 'Host message not created yet', '待投递': 'Awaiting delivery',
  '等待投递': 'Awaiting delivery', '等待投递 · 已暂停': 'Awaiting delivery · paused',
  '投递中': 'Delivering', '投递中·结果待确认': 'Delivering · result unconfirmed',
  '投递失败': 'Delivery failed', '待回复': 'Awaiting reply', '明确回复': 'Explicit reply',
  '回复': 'Reply', '请求': 'Request', '通知': 'Notification', '协作请求': 'Collaboration request',
  '人工结案 · 未确认': 'Manual closure · unconfirmed', '等待超时': 'Timed out',
  '等待回复': 'Awaiting reply', '进行中': 'In progress', '执行中': 'Running', '准备中': 'Preparing',
  '准备转移': 'Preparing move', '转移状态未知': 'Move status unknown', '转移需核对': 'Move needs verification',
  '接收需核对': 'Receipt needs verification', '多目标状态': 'Multi-target status',
  '（多目标状态明细见上一行）': '(multi-target details on the previous line)',
  '参数未加载': 'Arguments not loaded', '参数未加载（调用头不在当前窗口）': 'Arguments not loaded (call head outside the current window)',
  '技术详情': 'Technical details', '技术详情/原始消息': 'Technical details / raw message', '查看轨迹': 'View trace',
  '处理中': 'Processing', '已返回': 'Returned', '调用失败': 'Call failed',
  '展开 ⌄': 'Expand ⌄', '收起 ⌃': 'Collapse ⌃', '发件人': 'Sender', '收件人': 'Recipient',
  '主题': 'Subject', '发件': 'Sent', '收件': 'Received', '发送': 'Send', '接收': 'Receive',
  '正文加载中…': 'Loading body…', '正文已清除，无法展示。': 'Body was cleared and cannot be shown.',
  '正文已清理，或此记录无正文。': 'Body was cleaned up or this record has none.',
  '正文已按保留期限清理，或此记录无正文。': 'Body was removed by retention or this record has none.',
  '正文状态不可用': 'Body status unavailable', 'Host 未提供正文': 'Host provided no body',
  '事件已不在当前会话窗口': 'Event is outside the current session window',
  '身份不一致，按原文技术详情显示': 'Identity mismatch; showing raw technical details',
  '（无错误详情）': '(no error details)',
  '通信请求失败': 'Communication request failed', '存储异常': 'Storage error',
  '已暂存·待投递': 'Held · awaiting delivery',
  '迟到回复': 'Late reply', '关联消息ID': 'Related message ID', '关联请求ID': 'Related request ID',
  '关联组已暂停；恢复这组通信后继续，不能绕过。': 'Chain paused; resume the chain to continue. It cannot bypass pause.',
  '关联组已结束；这条暂存记录不会自动投递。': 'Chain ended; this held record will not be delivered automatically.',
  '已开始的工作不会被撤销。': 'Started work is not undone.',
  '清理插件保存的已完成正文，不删除原会话聊天记录。': 'Cleans up completed bodies stored by this plugin; it does not delete the original chat.',
  '等待投递 · 未暂停': 'Awaiting delivery · not paused',
  '设置': 'Settings', '记录': 'Records', '账本': 'Ledger', '正在投递': 'Delivering',
  '通道': 'channels', '未投递': 'undelivered', '关联组': 'chains', '条': 'items', '组': 'groups',
  '失败': 'Failed', '会话消息': 'Session message',
  '正文获取失败': 'Failed to load body', '正文获取失败。': 'Failed to load body.',
  '获取正文失败': 'Failed to load body', '请求失败': 'Request failed',
}

const TERMS = [
  ['已进入上下文', 'received into context'], ['已送达', 'delivered'], ['宿主已接收', 'host received'],
  ['待进入上下文', 'awaiting context'], ['进入上下文未确认', 'context unconfirmed'],
  ['截至', 'as of'], ['未更新', 'stale'], ['需核对', 'needs verification'], ['未知', 'unknown'],
  ['分钟', 'min'], ['小时', 'h'], ['天', 'd'], ['毫秒', 'ms'], ['字符', 'chars'], ['条/页', 'items/page'], ['个', ''],
  ['已回复', 'replied'], ['等待回复', 'awaiting reply'], ['等待投递', 'awaiting delivery'],
  ['投递中', 'delivering'], ['投递失败', 'delivery failed'], ['已取消', 'cancelled'],
  ['正在投递', 'delivering'], ['通道', 'channels'], ['账本', 'ledger'], ['未投递', 'undelivered'],
  ['关联组', 'chains'], ['条', 'items'], ['组', 'groups'], ['，', ', '],
  ['记录', 'records'], ['设置', 'settings'],
]

export const I18N_NS = 'session-link'
let active = 'zh'
const originalText = new WeakMap()
const originalAttrs = new WeakMap()
const appliedText = new WeakMap()

export function translateAttributeText(text) {
  if (active !== 'en' || typeof text !== 'string') return text
  const lead = text.match(/^\s*/)[0]
  const trail = text.match(/\s*$/)[0]
  const body = text.slice(lead.length, text.length - trail.length)
  return lead + (EN[body] !== undefined ? EN[body] : body) + trail
}

export function translateText(text) {
  if (active !== 'en' || typeof text !== 'string' || text.trim() === '') return text
  const lead = text.match(/^\s*/)[0]
  const trail = text.match(/\s*$/)[0]
  const body = text.slice(lead.length, text.length - trail.length)
  if (EN[body] !== undefined) return lead + EN[body] + trail
  let out = body
  const timeout = out.match(/^超时只标记，不停止任务、不自动重发；当前换算 (\d+) 毫秒。$/)
  if (timeout) return lead + `Timeouts only mark the request; they do not stop work or resend. Current value: ${timeout[1]} ms.` + trail
  const queued = out.match(/^已排队 (\d+) 条消息。$/)
  if (queued) return lead + `Queued ${queued[1]} messages.` + trail
  const resumed = out.match(/^已恢复投递 (\d+) 条消息。$/)
  if (resumed) return lead + `Resumed delivery of ${resumed[1]} messages.` + trail
  for (const [zh, en] of TERMS) out = out.split(zh).join(en)
  return lead + out + trail
}

function insideRoot(el) {
  return !!el?.closest?.('[data-session-link-i18n-root]')
}

function containsRoot(el) {
  return !!el?.querySelector?.('[data-session-link-i18n-root]')
}

function skip(node) {
  const el = node.nodeType === 1 ? node : node.parentElement
  if (!el) return true
  if (!insideRoot(el)) return true
  return el.closest?.('[data-i18n-skip], [contenteditable="true"], script, style, textarea, input') ?? null
}

function translateAttributes(el) {
  if (!el.getAttribute || !insideRoot(el) || el.closest?.('[data-i18n-skip]')) return
  for (const attr of ['aria-label', 'title', 'placeholder', 'alt']) {
    const value = el.getAttribute(attr)
    if (value === null) continue
    let saved = originalAttrs.get(el)
    if (!saved) { saved = {}; originalAttrs.set(el, saved) }
    if (!(attr in saved)) saved[attr] = value
    // Attributes often embed user-controlled session titles/subjects. Only
    // exact chrome strings are translated; never partial term replacement.
    el.setAttribute(attr, translateAttributeText(saved[attr]))
  }
}

function translateNode(node) {
  if (node.nodeType === 3) {
    if (skip(node)) return
    const parent = node.parentElement
    if (!parent) return
    const current = node.nodeValue
    if (!originalText.has(node)) originalText.set(node, current)
    const next = translateText(originalText.get(node))
    if (current !== next) { node.nodeValue = next; appliedText.set(node, next) }
    return
  }
  if (node.nodeType !== 1) return
  // Added DOM is often a wrapper around the plugin root (React mounts the
  // card inside a transcript fragment). Traverse containers that merely
  // contain a plugin root, but never translate outside plugin-owned roots.
  if (!insideRoot(node) && !containsRoot(node)) return
  if (insideRoot(node) && skip(node)) return
  if (insideRoot(node)) translateAttributes(node)
  for (const child of node.childNodes) translateNode(child)
}

export function retranslateDocument(doc = globalThis.document) {
  if (!doc?.body) return
  for (const root of doc.querySelectorAll('[data-session-link-i18n-root]')) translateNode(root)
  for (const el of doc.querySelectorAll('[data-session-link-i18n-root] [aria-label], [data-session-link-i18n-root] [title], [data-session-link-i18n-root] [placeholder], [data-session-link-i18n-root] [alt]')) translateAttributes(el)
}

export function setI18nLocale(id) { active = id === 'en' ? 'en' : 'zh'; }

export function installI18n(ctx) {
  if (!ctx?.locale?.getSnapshot || !ctx?.locale?.subscribe) return undefined
  let observer = null
  const sync = () => {
    const snapshot = ctx.locale.getSnapshot()
    setI18nLocale(snapshot?.active)
    retranslateDocument()
  }
  const unsubscribe = ctx.locale.subscribe(sync)
  sync()
  if (globalThis.document?.body && typeof MutationObserver === 'function') {
    observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'characterData') {
          // A node we translated ourselves is already reflected in appliedText;
          // anything else is a fresh React write, so re-read the source text.
          if (appliedText.get(record.target) !== record.target.nodeValue) {
            originalText.set(record.target, record.target.nodeValue)
            translateNode(record.target)
          }
        } else for (const node of record.addedNodes) translateNode(node)
      }
    })
    observer.observe(globalThis.document.body, { childList: true, subtree: true, characterData: true })
  }
  return () => {
    try { unsubscribe?.() } catch {}
    try { observer?.disconnect() } catch {}
  }
}
