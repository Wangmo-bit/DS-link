// Public-SDK session/window identity for the outgoing (sender) card.
//
// Uses ONLY the public session surface:
//   - `sessions.list.getSnapshot()` (catalog)
//   - `sessions.binding(id): SessionBinding | undefined` (service.d.ts:244)
//   - `binding.eventSource` (contract/events.d.ts SessionEventSource).
//
// NEVER uses ConversationBinding.assembler or ConversationNodeAssembler
// internals (non-public per their .d.ts), and NEVER truncates business scope:
// there is NO session-count or window-size cap. Correctness rules:
//   - session-local index per eventSource GENERATION: keyed by the source
//     object identity + its revision (a same-sessionId binding replacement
//     with a REUSED revision can never inherit the old callId set);
//   - incremental maintenance from `eventSource.change` (append/prepend →
//     O(delta); replace/settle → one full rebuild of THAT session only), so a
//     stream of live/token chunks never triggers full window scans;
//   - reads sync every currently bound session (revision no-op when current);
//   - a departed/replaced generation is dropped immediately (unsubscribe +
//     its events leave the scope), so stale windows can never satisfy
//     uniqueness;
//   - ANY internal resource failure sets `limited` and every resolution then
//     fails CLOSED (null) — we never truncate and keep claiming uniqueness.
// Only card_lookup HTTP batches are technically paged (≤100 ids); no message
// or session is ever dropped here.

/** Live index for one session's current eventSource generation. */
function emptyGeneration(source, revision) {
  return { source, revision, events: new Set(), callIds: new Set() };
}

function noteEvent(generation, sessionId, scopes, event) {
  generation.events.add(event);
  if (event?.type === 'tool/call' && typeof event.data?.callId === 'string') generation.callIds.add(event.data.callId);
  let set = scopes.get(event);
  if (set === undefined) {
    set = new Set();
    scopes.set(event, set);
  }
  set.add(sessionId);
}

/**
 * @param {{sessions: {list: {getSnapshot(): {byId?: Record<string, {id: string}>}}, binding(id: string): {eventSource: {getSnapshot(): {entries?: readonly unknown[], revision?: number, change?: {kind: string, entries?: readonly unknown[]}}, subscribe?(fn: () => void): () => void}} | undefined}}} sessions
 *   public ClientSessions face (inject: 'sessions').
 */
export function createWindowScope({ sessions }) {
  /** sessionId → current-generation index (one per live eventSource). */
  const generations = new Map();
  /** exact event object → Set<sessionId) holding it in a CURRENT window. */
  const scopes = new WeakMap();
  /** sessionId → unsubscribe of its CURRENT source (generation-tracked). */
  const stops = new Map();

  const counters = {
    fullRebuilds: 0,
    deltaSyncs: 0,
    adopted: 0,
    droppedGenerations: 0,
  };
  let limited = false;

  /** Drop one session's whole generation: events leave the scope, source unsubscribed. */
  function forget(sessionId) {
    const generation = generations.get(sessionId);
    if (generation !== undefined) {
      for (const event of generation.events) {
        const set = scopes.get(event);
        if (set === undefined) continue;
        set.delete(sessionId);
        if (set.size === 0) scopes.delete(event);
      }
      generations.delete(sessionId);
    }
    const stop = stops.get(sessionId);
    if (stop !== undefined) {
      stops.delete(sessionId);
      try {
        stop();
      } catch {
        // Already torn down.
      }
    }
  }

  function adopt(sessionId, source, snapshot) {
    const generation = emptyGeneration(source, typeof snapshot.revision === 'number' ? snapshot.revision : -1);
    for (const entry of snapshot.entries ?? []) {
      const event = entry?.event;
      if (event === undefined || event === null) continue;
      noteEvent(generation, sessionId, scopes, event);
    }
    generations.set(sessionId, generation);
    counters.adopted += 1;
    counters.fullRebuilds += 1;
    if (typeof source.subscribe === 'function' && !stops.has(sessionId)) {
      try {
        stops.set(
          sessionId,
          source.subscribe(() => onSourceChange(sessionId, source)),
        );
      } catch {
        // A source that refuses subscription is still readable on demand.
      }
    }
  }

  function applyDelta(generation, sessionId, entries) {
    for (const entry of entries ?? []) {
      const event = entry?.event;
      if (event === undefined || event === null) continue;
      noteEvent(generation, sessionId, scopes, event);
    }
    counters.deltaSyncs += 1;
  }

  /** Bring one session's index to its binding's CURRENT source+revision. */
  function syncSession(sessionId) {
    if (limited) return false;
    let binding;
    try {
      binding = sessions.binding(sessionId);
    } catch {
      binding = undefined;
    }
    if (binding === undefined) {
      // Binding gone: its window is gone — drop the whole generation at once.
      if (generations.has(sessionId)) forget(sessionId);
      return false;
    }
    const source = binding.eventSource;
    let snapshot;
    try {
      snapshot = source.getSnapshot();
    } catch {
      forget(sessionId);
      return false;
    }
    const revision = typeof snapshot.revision === 'number' ? snapshot.revision : -1;
    const generation = generations.get(sessionId);
    if (generation !== undefined && generation.source === source) {
      if (generation.revision === revision) return true;
      const change = snapshot.change;
      if (revision === generation.revision + 1 && (change?.kind === 'append' || change?.kind === 'prepend')) {
        try {
          applyDelta(generation, sessionId, change.entries);
          generation.revision = revision;
          return true;
        } catch {
          // fall through to a full rebuild of this session
        }
      }
      // replace / settle-assistant / missed revisions → one full rebuild.
      try {
        forget(sessionId);
        adopt(sessionId, source, snapshot);
        return true;
      } catch {
        limited = true;
        return false;
      }
    }
    // First sight, or a NEW GENERATION (same sessionId, new eventSource —
    // possibly with a REUSED revision number): never inherit old evidence.
    if (generation !== undefined) {
      counters.droppedGenerations += 1;
      forget(sessionId);
    }
    try {
      adopt(sessionId, source, snapshot);
    } catch {
      limited = true;
      return false;
    }
    return true;
  }

  function onSourceChange(sessionId, source) {
    if (limited) return;
    let binding;
    try {
      binding = sessions.binding(sessionId);
    } catch {
      return;
    }
    // Stale generation publishing after a replacement: ignore it entirely —
    // the old window must never re-enter the scope.
    if (binding === undefined || binding.eventSource !== source) return;
    syncSession(sessionId);
  }

  /** Sync every currently bound session (revision no-ops are cheap reads). */
  function syncAll() {
    if (limited) return;
    let list;
    try {
      list = sessions.list.getSnapshot();
    } catch {
      list = null;
    }
    const live = new Set();
    for (const summary of Object.values(list?.byId ?? {})) {
      if (typeof summary?.id !== 'string') continue;
      live.add(summary.id);
      syncSession(summary.id);
    }
    for (const sessionId of [...generations.keys()]) {
      if (!live.has(sessionId)) forget(sessionId);
    }
  }

  /** Unique CURRENT window holding this exact event object, else null. */
  function resolveEvent(event) {
    syncAll();
    if (limited) return null;
    const set = scopes.get(event);
    if (set === undefined || set.size !== 1) return null;
    return set.values().next().value;
  }

  /**
   * Tie a `tool/result` to the unique current window that BOTH contains its
   * tool/call and this exact result object. No session/window caps: every
   * bound session participates; ambiguity or absence → null (native fallback).
   */
  function resolveResult(event, callId) {
    syncAll();
    if (limited) return null;
    if (typeof callId !== 'string' || callId === '') return null;
    const holders = [];
    for (const [sessionId, generation] of generations) {
      if (generation.callIds.has(callId)) holders.push(sessionId);
    }
    if (holders.length === 0) return null;
    const withEvent = holders.filter((sessionId) => scopes.get(event)?.has(sessionId) === true);
    if (withEvent.length !== 1) return null;
    return withEvent[0];
  }

  /** Force-drop one session's evidence (generation swap / session departed). */
  function dropSession(sessionId) {
    if (generations.has(sessionId)) forget(sessionId);
  }

  /** Live counters for tests/telemetry; `limited` means fail-closed mode. */
  function stats() {
    return { sessions: generations.size, limited, ...counters };
  }

  function dispose() {
    for (const sessionId of [...generations.keys()]) forget(sessionId);
    for (const stop of stops.values()) {
      try {
        stop();
      } catch {
        // Teardown best-effort.
      }
    }
    stops.clear();
  }

  return { resolveEvent, resolveResult, dropSession, stats, dispose };
}
