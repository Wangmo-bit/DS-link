// One vocabulary for delivery markers, shared by the send and receive sides.
// User decision 2026-11-08: a check mark always means "the other side's Host
// confirmed receiving this message" and is only used on the outgoing capsule;
// a received capsule never shows a check. Details stay in the label/tooltip.
//   outgoing: spinner = still sending, ✓ = host confirmed, × = failed, ? = unknown
//   incoming: spinner only while the recorded message is still waiting to enter
//             the model context; afterwards the capsule carries no glyph.
const PENDING_LABELS = Object.freeze(['待投递', '已暂存·待投递', '投递中·结果待确认']);
const WAITING_LABELS = Object.freeze([...PENDING_LABELS, '宿主已接收·待进入上下文']);

export function senderIndicator(label) {
  if (label === '已进入上下文') return { kind: 'received', title: '对方宿主已接收，已进入对方上下文' };
  if (label === '明确回复') return { kind: 'received', title: '对方宿主已接收，并收到明确回复' };
  if (label === '宿主已接收·待进入上下文') return { kind: 'received', title: '对方宿主已确认收到，尚未确认进入上下文' };
  if (PENDING_LABELS.includes(label)) return { kind: 'pending', title: label };
  if (label === '失败' || label === '已取消') return { kind: 'failed', title: label === '失败' ? '投递失败' : '已取消' };
  return { kind: 'warning', title: label || '状态需要核对' };
}

/**
 * Received messages never carry a check mark. The only real waiting state is a
 * recorded message that has not entered the model context yet; everything else
 * is simply "received" and stays glyph-free.
 * @param {string} label
 * @returns {{kind:'pending',title:string}|null}
 */
export function receiverHint(label) {
  if (!WAITING_LABELS.includes(label)) return null;
  if (label === '宿主已接收·待进入上下文') return { kind: 'pending', title: '已收到，等待进入上下文' };
  return { kind: 'pending', title: label };
}
