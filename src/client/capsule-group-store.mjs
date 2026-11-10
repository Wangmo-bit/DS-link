// Shared bubble-mode capsule grouping state. One store is created in the
// plugin entry and handed to BOTH the received-card and sent-card installs, so
// a received/sent direction change always breaks the run on either side.
import { groupCapsules } from './capsule-grouping.mjs';

const EMPTY = { head: true, count: 1 };

export function createCapsuleGroupStore() {
  let snapshot = { version: 0, sessions: new Map() };
  const listeners = new Set();
  const state = new Map(); // sessionId → { items, sentMeta, bySeq }

  function recompute(sessionId) {
    const current = state.get(sessionId);
    if (current === undefined) return;
    current.bySeq = groupCapsules(current.items, { sentMeta: current.sentMeta });
    const sessions = new Map(snapshot.sessions);
    sessions.set(sessionId, current.bySeq);
    snapshot = { version: snapshot.version + 1, sessions };
    for (const fn of [...listeners]) fn();
  }

  return {
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    getSnapshot() { return snapshot; },
    info(snap, sessionId, seq) { return snap.sessions.get(sessionId)?.get(seq) ?? EMPTY; },
    has(sessionId) { return state.has(sessionId); },
    setItems(sessionId, items, notify = true) {
      const current = state.get(sessionId) ?? { sentMeta: new Map(), bySeq: new Map() };
      current.items = items;
      state.set(sessionId, current);
      if (notify) recompute(sessionId);
      else {
        current.bySeq = groupCapsules(items, { sentMeta: current.sentMeta });
        const sessions = new Map(snapshot.sessions);
        sessions.set(sessionId, current.bySeq);
        snapshot = { version: snapshot.version + 1, sessions };
      }
    },
    setSentMeta(sessionId, seq, meta) {
      const current = state.get(sessionId) ?? { items: [], sentMeta: new Map(), bySeq: new Map() };
      current.sentMeta.set(seq, meta);
      state.set(sessionId, current);
      recompute(sessionId);
    },
  };
}
