// Evidence-based status truth table — REUSED VERBATIM from the receiver-side
// spike (scripts/v04-card-spike/addon/src/client.jsx statusDisplay), which
// ships its own tests for this table (v2 alignment: the two sides must show
// identical facts for identical rows). Keep in sync with that implementation.
//
// Readable Chinese small-text only; NEVER claims 已读/已处理/完成 and never
// implies a read receipt. `asOf` is the LOCAL query time (explicitly labelled
// 截至, never presented as receipt evidence); `stale` marks a failed refresh
// (last value kept, flagged 状态未更新/需核对). replyStatus never forges the
// body or source status: `answered` shows 明确回复 (strongest fact),
// `timed_out` appends 等待回复超时 while KEEPING the delivery/receipt facts.
//
// @param row ledger row (card_lookup entry) or null/undefined
// @param asOf local ms epoch of the last successful lookup
// @param stale last refresh attempt failed
// @returns {{ label: string, receiptTime: number|null, asOf: number|null, stale: boolean }}
export function statusDisplay(row, asOf = null, stale = false) {
  const status = row?.status;
  const receipt = row?.receipt ?? null;
  const replyStatus = row?.replyStatus;
  let label;
  if (status === 'failed') {
    label = '失败';
  } else if (status === 'cancelled') {
    label = '已取消';
  } else if (status === 'held') {
    label = '已暂存·待投递';
  } else if (status === 'pending') {
    label = '待投递';
  } else if (status === 'dispatching') {
    // Dispatch started; outcome not yet evidenced — do not claim non-delivery.
    label = '投递中·结果待确认';
  } else if (status === 'unknown') {
    label = '需核对';
  } else if (status === 'accepted') {
    if (receipt?.policy === 'context') {
      if (receipt.state === 'received') {
        label = '已进入上下文';
      } else if (receipt.state === 'queued') {
        label = '宿主已接收·待进入上下文';
      } else {
        // not_sent / uncertain / unknown state: contradictory or unclear vs
        // accepted — verify instead of asserting either direction.
        label = '需核对';
      }
    } else {
      // legacy-accepted or no receipt: entry into context is UNCONFIRMED —
      // do not assert it has not happened.
      label = '宿主已接收·进入上下文未确认';
    }
  } else {
    // missing / unexpected status: verify, don't guess.
    label = '需核对';
  }
  // Reply facts sit ON TOP of delivery facts: answered is the strongest
  // available fact and shows alone; timeout keeps the delivery/receipt label
  // and appends the wait outcome (does not revoke delivery, does not imply
  // the message was unhandled).
  if (replyStatus === 'answered') label = '明确回复';
  else if (replyStatus === 'timed_out') label = `${label} · 等待回复超时`;
  const receiptTime =
    label.startsWith('已进入上下文') && typeof receipt?.receivedAt === 'number' ? receipt.receivedAt : null;
  return {
    label,
    receiptTime,
    asOf: typeof asOf === 'number' ? asOf : null,
    stale: stale === true,
  };
}
