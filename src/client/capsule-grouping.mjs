// Bubble-mode capsule grouping (owner decision 2026-11-10).
//
// Only *visible* timeline items are passed in. A `break` item resets the run
// (assistant text, human message, turn boundary, approval/question). A `sent`
// capsule also resets the run and is never merged: its delivery status belongs
// to a different direction. Received capsules merge only when every key below
// matches; request vs notification is deliberately part of the key so a
// request is never hidden inside a notification count.
export const CAPSULE_GROUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * @param {Array<{kind:'received'|'sent'|'break', seq?:number, time?:number,
 *   sender?:string, messageKind?:string, status?:string, turn?:number|null}>} items
 * @param {{windowMs?:number}} [options]
 * @returns {Map<number, {head:boolean, count:number}>} keyed by event seq
 */
export function groupCapsules(items, { windowMs = CAPSULE_GROUP_WINDOW_MS } = {}) {
  const bySeq = new Map();
  let run = null;
  for (const item of items) {
    if (item.kind === 'break') { run = null; continue; }
    if (item.kind === 'sent') {
      if (Number.isSafeInteger(item.seq)) bySeq.set(item.seq, { head: true, count: 1 });
      run = null;
      continue;
    }
    if (item.kind !== 'received' || !Number.isSafeInteger(item.seq)) continue;
    const gap = run === null ? Infinity : item.time - run.lastTime;
    const same = run !== null
      && run.turn === item.turn
      && run.sender === item.sender
      && run.messageKind === item.messageKind
      && run.status === item.status
      && gap <= windowMs;
    if (!same) {
      run = { headSeq: item.seq, turn: item.turn, sender: item.sender, messageKind: item.messageKind, status: item.status, lastTime: item.time, count: 1, members: [item.seq] };
      bySeq.set(item.seq, { head: true, count: 1 });
      continue;
    }
    run.count += 1;
    run.lastTime = item.time;
    run.members.push(item.seq);
    for (const seq of run.members) bySeq.set(seq, { head: seq === run.headSeq, count: run.count });
  }
  return bySeq;
}
