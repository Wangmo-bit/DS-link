// Bubble-mode presentation only. Preserve event order and every message record.
// A run needs positive evidence for turn, peer, kind, status and time. Unknown
// evidence is a separate capsule, not permission to join two unknown values.
export const CAPSULE_GROUP_WINDOW_MS = 5 * 60 * 1000;
const MESSAGE_KINDS = new Set(['request', 'notification', 'reply']);
const present = value => typeof value === 'string' && value.length > 0;
const knownTurn = value => Number.isSafeInteger(value) && value >= 0;

/** Adjacent-gap window (not total run duration); returns info by durable seq. */
export function groupCapsules(items, { windowMs = CAPSULE_GROUP_WINDOW_MS, sentMeta } = {}) {
  const bySeq = new Map();
  let run = null;
  // Fill each member once, when its run ends: linear work for long bursts.
  const flush = () => {
    if (!run) return;
    const count = run.members.length;
    for (let i = 0; i < count; i++) bySeq.set(run.members[i], { head: i === 0, count });
    run = null;
  };
  for (const item of items) {
    if (item.kind === 'break') { flush(); continue; }
    if (!Number.isSafeInteger(item.seq) || item.seq < 0) { flush(); continue; }
    let turn, peer, kind, status;
    if (item.kind === 'sent') {
      const meta = sentMeta?.get(item.seq);
      if (meta && !meta.multiTarget) {
        ({ turn, target: peer, kind, status } = meta);
      }
    } else if (item.kind === 'received') {
      ({ turn, sender: peer, messageKind: kind, status } = item);
    } else { flush(); continue; }
    if (!knownTurn(turn) || !present(peer) || !MESSAGE_KINDS.has(kind)
      || !present(status) || !Number.isFinite(item.time)) {
      flush();
      bySeq.set(item.seq, { head: true, count: 1 });
      continue;
    }
    const gap = run ? item.time - run.lastTime : Infinity;
    const same = run && run.direction === item.kind && run.turn === turn
      && run.peer === peer && run.messageKind === kind && run.status === status
      && gap >= 0 && gap <= windowMs;
    if (!same) {
      flush();
      run = { direction: item.kind, turn, peer, messageKind: kind, status, lastTime: item.time, members: [] };
    }
    run.members.push(item.seq);
    run.lastTime = item.time;
  }
  flush();
  return bySeq;
}
