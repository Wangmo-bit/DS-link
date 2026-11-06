// One vocabulary for delivery markers, shared by the send and receive sides.
// Kinds: received ✓ / pending spinner / failed × / anything else ?.
export function senderIndicator(label) {
  if (label === '已进入上下文' || label === '明确回复') return { kind: 'received', title: label === '明确回复' ? '已收到明确回复' : '已进入对方上下文' };
  if (['待投递', '已暂存·待投递', '投递中·结果待确认', '宿主已接收·待进入上下文'].includes(label)) return { kind: 'pending', title: label === '宿主已接收·待进入上下文' ? '已送达宿主，等待进入对方上下文' : label };
  if (label === '失败' || label === '已取消') return { kind: 'failed', title: label === '失败' ? '投递失败' : '已取消' };
  return { kind: 'warning', title: label || '状态需要核对' };
}
