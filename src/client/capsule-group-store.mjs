// One presentation store for both directions. No ledger writes or body reads.
import { groupCapsules } from './capsule-grouping.mjs';
const EMPTY = Object.freeze({ head: true, count: 1 });
const equalGroups = (a, b) => a?.size === b.size && [...b].every(([seq, value]) => {
  const previous = a.get(seq);
  return previous?.head === value.head && previous?.count === value.count;
});
const equalMeta = (a, b) => a && ['target', 'kind', 'status', 'turn', 'multiTarget'].every(key => a[key] === b[key]);

export function createCapsuleGroupStore() {
  let snapshot = { version: 0, sessions: new Map(), generations: new Map() };
  const listeners = new Set(), state = new Map(), pending = new Set();
  let queued = false, disposed = false;
  function publish(sessionId, notify = true) {
    const current = state.get(sessionId);
    if (disposed || !current || current.items === null) return;
    const bySeq = groupCapsules(current.items, { sentMeta: current.sentMeta });
    if (equalGroups(snapshot.sessions.get(sessionId), bySeq)) return;
    const sessions = new Map(snapshot.sessions);
    sessions.set(sessionId, bySeq);
    snapshot = { ...snapshot, version: snapshot.version + 1, sessions };
    if (notify) for (const fn of [...listeners]) fn();
  }
  function schedule(sessionId) {
    pending.add(sessionId);
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const ids = [...pending]; pending.clear();
      if (!disposed) for (const id of ids) publish(id);
    });
  }
  return {
    subscribe(fn) { if (disposed) return () => {}; listeners.add(fn); return () => listeners.delete(fn); },
    getSnapshot() { return snapshot; },
    info(snap, sessionId, seq) { return snap.sessions.get(sessionId)?.get(seq) ?? EMPTY; },
    has(sessionId) { return state.has(sessionId) && state.get(sessionId).items !== null; },
    generationOf(snap, sessionId) { return snap.generations.get(sessionId) ?? 0; },
    setItems(sessionId, items, notify = true) {
      if (disposed) return;
      const current = state.get(sessionId) ?? { items: null, sentMeta: new Map() };
      current.items = items;
      const sentSeqs = new Set(items.filter(item => item.kind === 'sent').map(item => item.seq));
      for (const seq of current.sentMeta.keys()) if (!sentSeqs.has(seq)) current.sentMeta.delete(seq);
      state.set(sessionId, current);
      publish(sessionId, notify);
    },
    setSentMeta(sessionId, seq, meta) {
      if (disposed || !Number.isSafeInteger(seq)) return;
      const current = state.get(sessionId) ?? { items: null, sentMeta: new Map() };
      if (equalMeta(current.sentMeta.get(seq), meta)) return;
      current.sentMeta.set(seq, meta);
      state.set(sessionId, current);
      schedule(sessionId);
    },
    removeSession(sessionId) {
      state.delete(sessionId); pending.delete(sessionId);
      const sessions = new Map(snapshot.sessions); sessions.delete(sessionId);
      const generations = new Map(snapshot.generations);
      generations.set(sessionId, (generations.get(sessionId) ?? 0) + 1);
      snapshot = { version: snapshot.version + 1, sessions, generations };
      for (const fn of [...listeners]) fn();
    },
    dispose() {
      disposed = true; state.clear(); pending.clear(); listeners.clear();
      snapshot = { version: snapshot.version + 1, sessions: new Map(), generations: new Map() };
    },
  };
}
