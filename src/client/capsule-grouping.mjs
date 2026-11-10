// Bubble-mode capsule grouping (owner decision 2026-11-10).
//
// Only *visible* timeline items are passed in. A `break` item resets the run
// (assistant text, human message, turn boundary, approval/question). Received
// and sent capsules never merge with each other: the direction is part of the
// key. Received capsules merge only when every key below matches; request vs
// notification is deliberately part of the key so a request is never hidden
// inside a notification count. Sent capsules merge only when the sent-side view
// registered a single-target meta (multi-target sends stay separate).
export const CAPSULE_GROUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * @param {Array<{kind:'received'|'sent'|'break', seq?:number, time?:number,
 *   sender?:string, messageKind?:string, status?:string, turn?:number|null}>} items
 * @param {{windowMs?:number, sentMeta?:Map<number,{target:string,kind:string,status:string,turn:number|null,multiTarget?:boolean}>}} [options]
 * @returns {Map<number, {head:boolean, count:number}>} keyed by event seq
 */
export function groupCapsules(items, { windowMs = CAPSULE_GROUP_WINDOW_MS, sentMeta } = {}) {
  const bySeq = new Map();
  let run = null;
  const extend = (item) => {
    run.count += 1;
    run.lastTime = item.time;
    run.members.push(item.seq);
    for (const seq of run.members) bySeq.set(seq, { head: seq === run.headSeq, count: run.count });
  };
  for (const item of items) {
    if (item.kind === 'break') { run = null; continue; }
    if (!Number.isSafeInteger(item.seq)) continue;
    if (item.kind === 'sent') {
      const meta = sentMeta?.get(item.seq);
      if (meta === undefined || meta.multiTarget === true) {
        bySeq.set(item.seq, { head: true, count: 1 });
        run = null;
        continue;
      }
      const gap = run === null ? Infinity : item.time - run.lastTime;
      const same = run !== null
        && run.direction === 'sent'
        && run.turn === meta.turn
        && run.peer === meta.target
        && run.messageKind === meta.kind
        && run.status === meta.status
        && gap <= windowMs;
      if (!same) {
        run = {
          direction: 'sent', headSeq: item.seq, turn: meta.turn, peer: meta.target,
          messageKind: meta.kind, status: meta.status, lastTime: item.time, count: 1, members: [item.seq],
        };
        bySeq.set(item.seq, { head: true, count: 1 });
      } else extend(item);
      continue;
    }
    if (item.kind !== 'received') continue;
    const gap = run === null ? Infinity : item.time - run.lastTime;
    const same = run !== null
      && run.direction === 'received'
      && run.turn === item.turn
      && run.peer === item.sender
      && run.messageKind === item.messageKind
      && run.status === item.status
      && gap <= windowMs;
    if (!same) {
      run = {
        direction: 'received', headSeq: item.seq, turn: item.turn, peer: item.sender,
        messageKind: item.messageKind, status: item.status, lastTime: item.time, count: 1, members: [item.seq],
      };
      bySeq.set(item.seq, { head: true, count: 1 });
    } else extend(item);
  }
  return bySeq;
}
