// Pure, injectable scanner coordinator for the outgoing card — no module-level
// state, no test-only hooks: Node tests construct it directly with fakes and
// call `scan()`; production reaches it only through installOutgoingCards.
//
// Responsibilities (all event-driven, never polling):
//   - track DIRTY sessions from public eventSource.change + revision
//     (only a durable `tool/result` append, a prepend, or a replace can change
//     verification candidates — live/token chunks and settlements never scan);
//   - generation-safe source subscriptions (same sessionId re-bound to a new
//     eventSource → unsubscribe the old one, drop that session's window index
//     and verified rows, rebuild from the new source; a stale source publishing
//     afterwards is ignored);
//   - P0-safe scan loop: an event during a pending pass only raises
//     `rescanRequested` (no microtask is queued while a pass is awaiting the
//     network), and at most ONE follow-up pass is scheduled after the pass
//     releases — timers and fetch resolution keep running; abort/error paths
//     always release the flag.
import { extractResultIds } from './outgoing-card-verify.mjs';

/**
 * @param options.sessions - public ClientSessions face.
 * @param options.verifier - owner-only card_lookup verifier.
 * @param options.getSignal - AbortSignal for in-flight lookups.
 * @param options.onPrepend - called once (coalesced by the caller) when an
 *   older page arrives, so the definition can re-run its public rebuild.
 */
export function createOutgoingCoordinator({ sessions, verifier, getSignal, onPrepend } = {}) {
  if (sessions === undefined || verifier === undefined) {
    throw new Error('createOutgoingCoordinator requires sessions and verifier');
  }

  let disposed = false;
  let scanQueued = false;
  let scanning = false;
  let rescanRequested = false;
  let forceRefresh = false;
  /** Completed scanPass() count — bounded observability for tests/telemetry. */
  let passes = 0;

  /** Sessions whose public window changed since the last pass (revision-filtered). */
  const dirtySessions = new Set();
  /** sessionId → last window revision this coordinator fully processed. */
  const scannedRevision = new Map();
  /** sessionId → {source, stop} for the CURRENT generation only. */
  const sourceStops = new Map();

  function scheduleScan() {
    if (disposed || scanQueued) return;
    scanQueued = true;
    queueMicrotask(() => {
      scanQueued = false;
      void scan();
    });
  }

  function onSourceEvent(sessionId, source) {
    if (disposed) return;
    let binding;
    try {
      binding = sessions.binding(sessionId);
    } catch {
      return;
    }
    // STALE GENERATION: a replaced binding's old eventSource must never feed
    // this coordinator (same sessionId can be re-bound with a reused revision).
    if (binding === undefined || binding.eventSource !== source) return;
    let snapshot;
    try {
      snapshot = source.getSnapshot();
    } catch {
      return;
    }
    const change = snapshot?.change;
    if (change?.kind === 'append') {
      const entries = change.entries ?? [];
      // Only a durable tool/result can change verification candidates —
      // live/token chunks and ordinary assistant rows never scan windows.
      if (!entries.some((entry) => entry?.event?.type === 'tool/result')) return;
    } else if (change?.kind === 'settle-assistant') {
      // Settlements retire transient rows; tool/result ids are unchanged.
      return;
    }
    // Revision filter: already processed at this exact window revision → skip.
    if (scannedRevision.get(sessionId) === snapshot.revision) return;
    dirtySessions.add(sessionId);
    // A prepend can bring a tool/call whose result was already dispatched
    // unclaimed → rebuild so match re-runs against the wider window.
    if (change?.kind === 'prepend') onPrepend?.();
    scheduleScan();
  }

  /**
   * Reconcile source subscriptions against the public catalog: bind new
   * sessions, detect GENERATION replacements (same id, new eventSource) and
   * disappearances — both immediately unsubscribe the old source and drop its
   * window index + this session's verified rows (re-verified from scratch).
   */
  function reconcile() {
    if (disposed) return;
    let list;
    try {
      list = sessions.list.getSnapshot();
    } catch {
      return;
    }
    const live = new Set();
    for (const summary of Object.values(list.byId ?? {})) {
      if (typeof summary?.id !== 'string') continue;
      live.add(summary.id);
      // Never scanned (first reconcile / newly bound) → needs a full pass.
      if (!scannedRevision.has(summary.id)) dirtySessions.add(summary.id);
      let binding;
      try {
        binding = sessions.binding(summary.id);
      } catch {
        continue;
      }
      const stored = sourceStops.get(summary.id);
      if (binding === undefined) {
        if (stored !== undefined) {
          sourceStops.delete(summary.id);
          try {
            stored.stop();
          } catch {
            // Already torn down.
          }
          windowForget(summary.id);
          scannedRevision.delete(summary.id);
        }
        continue;
      }
      const source = binding.eventSource;
      if (stored !== undefined) {
        if (stored.source === source) continue; // same generation
        sourceStops.delete(summary.id);
        try {
          stored.stop();
        } catch {
          // Already torn down.
        }
        windowForget(summary.id);
        scannedRevision.delete(summary.id);
        dirtySessions.add(summary.id);
      }
      try {
        sourceStops.set(summary.id, { source, stop: source.subscribe(() => onSourceEvent(summary.id, source)) });
      } catch {
        // Stale binding: a later list change retries.
      }
    }
    for (const [sessionId, stored] of [...sourceStops]) {
      if (live.has(sessionId)) continue;
      sourceStops.delete(sessionId);
      try {
        stored.stop();
      } catch {
        // Already torn down.
      }
      windowForget(sessionId);
      scannedRevision.delete(sessionId);
    }
    scheduleScan();
  }

  /** Generation drop hook: window-scope index + verified rows for ONE session. */
  let forgetSession = (sessionId) => {
    void sessionId;
  };
  function windowForget(sessionId) {
    forgetSession(sessionId);
    verifier.revoke((sid) => sid !== sessionId);
  }

  /**
   * Install the session→evidence drop wiring (window-scope lives in the
   * installer because it is also read by the Definition).
   */
  function attachWindowScope(windowScope) {
    forgetSession = (sessionId) => windowScope.dropSession(sessionId);
  }

  /** Candidates for the DIRTY sessions only — never a full catalog sweep. */
  function collectCandidates(targetSessions) {
    const bySession = new Map();
    const windowIds = new Map();
    const revisions = new Map();
    for (const sessionId of targetSessions) {
      let binding;
      try {
        binding = sessions.binding(sessionId);
      } catch {
        continue;
      }
      if (binding === undefined) continue;
      let snapshot;
      try {
        snapshot = binding.eventSource.getSnapshot();
      } catch {
        continue;
      }
      const entries = snapshot?.entries ?? [];
      const ids = new Set();
      const wanted = [];
      for (const entry of entries) {
        const event = entry?.event;
        if (event?.type !== 'tool/result') continue;
        // Model-only replacement copies never surface or get queried.
        if (event.surfaceOp !== 'append') continue;
        const { ids: extracted } = extractResultIds(event);
        for (const id of extracted) ids.add(id);
        if (event.data?.message?.isError === true) continue;
        if (extracted.length === 0) continue;
        wanted.push(...extracted);
      }
      windowIds.set(sessionId, ids);
      revisions.set(sessionId, typeof snapshot?.revision === 'number' ? snapshot.revision : -1);
      if (wanted.length > 0) bySession.set(sessionId, wanted);
    }
    return { bySession, windowIds, revisions };
  }

  function markAllSessionsDirty() {
    let list;
    try {
      list = sessions.list.getSnapshot();
    } catch {
      return;
    }
    for (const summary of Object.values(list.byId ?? {})) {
      if (typeof summary?.id === 'string') dirtySessions.add(summary.id);
    }
  }

  async function scanPass() {
    const force = forceRefresh;
    forceRefresh = false;
    if (force) markAllSessionsDirty();
    if (dirtySessions.size === 0) return;
    const processed = [...dirtySessions];
    dirtySessions.clear();
    const { bySession, windowIds, revisions } = collectCandidates(processed);
    const signal = typeof getSignal === 'function' ? getSignal() : undefined;
    for (const sessionId of processed) {
      if (disposed) return;
      const inWindow = windowIds.get(sessionId) ?? new Set();
      // Window-safe revocation scoped to THIS session (clean sessions' rows
      // are never touched — their windows did not change).
      verifier.revoke((sid, id) => sid !== sessionId || inWindow.has(id));
      const ids = bySession.get(sessionId) ?? [];
      if (ids.length > 0) {
        await verifier.verify(sessionId, ids, { signal });
        await verifier.refresh(sessionId, ids, { signal, force });
      }
      scannedRevision.set(sessionId, revisions.get(sessionId) ?? -1);
    }
  }

  /**
   * P0 contract: a second event DURING a pending pass only sets
   * `rescanRequested`; no microtask is queued while `scanning`, so timers and
   * the fetch resolution keep running. After the pass releases `scanning`, at
   * most ONE follow-up pass is scheduled — also on abort/error paths.
   */
  async function scan() {
    if (disposed) return;
    if (scanning) {
      rescanRequested = true;
      return;
    }
    scanning = true;
    try {
      do {
        rescanRequested = false;
        await scanPass();
        passes += 1;
      } while (rescanRequested && !disposed);
    } catch {
      // A failed pass must never wedge the scanner; the next event re-arms it.
    } finally {
      scanning = false;
    }
    if (rescanRequested && !disposed) scheduleScan();
  }

  function requestForce() {
    if (disposed) return;
    forceRefresh = true;
  }

  function dispose() {
    disposed = true;
    forceRefresh = false;
    dirtySessions.clear();
    scannedRevision.clear();
    for (const stored of sourceStops.values()) {
      try {
        stored.stop();
      } catch {
        // Teardown best-effort.
      }
    }
    sourceStops.clear();
  }

  function stats() {
    return {
      disposed,
      scanning,
      rescanRequested,
      passes,
      dirty: dirtySessions.size,
      sources: sourceStops.size,
      scanned: scannedRevision.size,
    };
  }

  return { reconcile, scan, scheduleScan, requestForce, attachWindowScope, dispose, stats };
}
