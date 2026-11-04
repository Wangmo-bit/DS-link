// Owner-only ledger verification for the sender card (PLAN B.5 `card_lookup`).
//
// Wire shape mirrors the shipped engine + the receiver spike's client:
//   POST <base>api/session-link/api
//   { action: 'card_lookup', payload: { sessionId, ids } }
//   → { ok: true, value: { results: [ledgerRow…], missing: [id…] } }
//   ledgerRow: { id, durableMessageId, from, to, fromTitle, toTitle, kind,
//                subject, chainId, parentMessageId, status, replyStatus, receipt }
//
// The endpoint already scopes rows to `from === sessionId || to === sessionId`;
// the card re-checks `row.from === sessionId` before rendering, so a fork that
// merely copied history can never claim a send it did not originate.
//
// Batching / freshness / revocation / window safety (v2 alignment):
//   - one merged request per sessionId per pass, chunked to ≤ 100 ids
//     (PLAN B.5 technical pagination cap);
//   - `verify()` = first-time lookup of unverified ids; `refresh()` re-queries
//     KNOWN ids at most once per `refreshIntervalMs` (default 30s; force for
//     tab-visible/card-expand) — never a per-card high-frequency poll;
//   - every successful lookup stamps local `asOf` (rendered as 截至);
//     a FAILED refresh keeps the last row and flags `stale` (状态未更新);
//   - missing ids are negatively cached for the current window only;
//     `revoke()` drops rows/negatives/freshness for ids that left the windows;
//   - `AbortSignal` cancels in-flight requests; no polling loop anywhere.

const DEFAULT_MAX_IDS = 100;
const DEFAULT_REFRESH_INTERVAL_MS = 30_000;

/** Parse one tool/result content payload into its JSON value (rc5 renderValue). */
export function parseResultValue(event) {
  const content = event?.data?.message?.content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
  if (text === '') return null;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Extract the ledger message ids a result proves, per tool shape (engine.js):
 *   send/reply -> value.results[].id
 *   create     -> value.firstMessage.id (+ value.sessionId = recipient)
 * @returns {{value: object|null, ids: string[], sessionId: string|null}}
 */
export function extractResultIds(event) {
  const value = parseResultValue(event);
  if (value === null) return { value: null, ids: [], sessionId: null };
  const ids = [];
  if (Array.isArray(value.results)) {
    for (const entry of value.results) if (typeof entry?.id === 'string' && entry.id !== '') ids.push(entry.id);
  }
  if (typeof value.firstMessage?.id === 'string' && value.firstMessage.id !== '') ids.push(value.firstMessage.id);
  return {
    value,
    ids: [...new Set(ids)],
    sessionId: typeof value.sessionId === 'string' && value.sessionId !== '' ? value.sessionId : null,
  };
}

function key(sessionId, id) {
  return `${sessionId}\n${id}`;
}

function defaultApiUrl(path) {
  const base = globalThis.document?.baseURI ?? 'http://127.0.0.1/';
  return new URL(path, base).toString();
}

/**
 * @param options.fetchImpl - injectable fetch (tests); defaults to global fetch.
 * @param options.maxIds - technical cap per request (default 100, PLAN B.5).
 * @param options.refreshIntervalMs - min gap between automatic re-lookups of
 *   the same id (default 30s; test-overridable; force bypasses it).
 */
export function createCardVerifier({
  fetchImpl = (...args) => globalThis.fetch(...args),
  apiUrl = defaultApiUrl,
  maxIds = DEFAULT_MAX_IDS,
  refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
} = {}) {
  /** `${sessionId}\n${id}` → verified ledger row. */
  const rows = new Map();
  /** `${sessionId}\n${id}` → {asOf, stale} local freshness of the last attempt. */
  const freshness = new Map();
  /** Negatively cached misses for the CURRENT window lifetime. */
  const missing = new Set();
  /** batch keys currently in flight (merge, no duplicates). */
  const inFlight = new Set();
  const listeners = new Set();

  function notify() {
    for (const listener of [...listeners]) listener();
  }

  function has(sessionId, ids) {
    if (typeof sessionId !== 'string' || sessionId === '' || !Array.isArray(ids) || ids.length === 0) return false;
    return ids.every((id) => rows.has(key(sessionId, id)));
  }

  /** Verified rows for these ids, in id order; incomplete → null. */
  function get(sessionId, ids) {
    if (!has(sessionId, ids)) return null;
    return ids.map((id) => rows.get(key(sessionId, id)));
  }

  /** Local freshness of one verified id: {asOf, stale} | undefined. */
  function freshnessOf(sessionId, id) {
    return freshness.get(key(sessionId, id));
  }

  function remember(sessionId, id, row) {
    const k = key(sessionId, id);
    missing.delete(k);
    const previous = rows.get(k);
    rows.set(k, row);
    freshness.set(k, { asOf: Date.now(), stale: false });
    return previous === undefined || JSON.stringify(previous) !== JSON.stringify(row);
  }

  /** One HTTP pass; throws on failure (caller decides stale bookkeeping). */
  async function lookup(sessionId, chunk, signal) {
    const response = await fetchImpl(apiUrl('api/session-link/api'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      signal,
      body: JSON.stringify({ action: 'card_lookup', payload: { sessionId, ids: chunk } }),
    });
    if (!response?.ok) throw Object.assign(new Error(`card_lookup HTTP ${response?.status}`), { httpStatus: response?.status });
    const body = await response.json();
    if (body?.ok !== true) throw new Error(body?.error?.message ?? 'card_lookup failed');
    return body.value ?? { results: [], missing: [] };
  }

  function storeValue(sessionId, value) {
    let changed = false;
    for (const row of value.results ?? []) {
      if (row === null || typeof row !== 'object') continue;
      if (typeof row.id !== 'string') continue;
      // Endpoint scope already requires from/to === sessionId; remember
      // anyway and let the card re-check row.from before rendering.
      if (remember(sessionId, row.id, row)) changed = true;
    }
    for (const id of value.missing ?? []) {
      if (typeof id === 'string' && !rows.has(key(sessionId, id))) missing.add(key(sessionId, id));
    }
    return changed;
  }

  function markStale(sessionId, ids) {
    let changed = false;
    for (const id of ids) {
      const k = key(sessionId, id);
      const fresh = freshness.get(k);
      if (rows.has(k) && fresh !== undefined && fresh.stale !== true) {
        freshness.set(k, { ...fresh, stale: true });
        changed = true;
      }
    }
    return changed;
  }

  async function runChunks(sessionId, todo, signal) {
    let changed = false;
    for (let offset = 0; offset < todo.length; offset += maxIds) {
      const chunk = todo.slice(offset, offset + maxIds);
      try {
        const value = await lookup(sessionId, chunk, signal);
        changed = storeValue(sessionId, value) || changed;
      } catch (error) {
        if (error?.name === 'AbortError') break;
        // Initial verify: missing rows simply keep the card native.
        // Refresh of KNOWN rows: keep the last row, flag 状态未更新 (stale).
        changed = markStale(sessionId, chunk) || changed;
      }
    }
    return changed;
  }

  /**
   * First-time verification pass for ONE session: chunked, negatively cached,
   * never throws (fail → keep native fallback).
   * @returns {Promise<boolean>} whether any NEW row was stored.
   */
  async function verify(sessionId, ids, { signal } = {}) {
    if (typeof sessionId !== 'string' || sessionId === '' || !Array.isArray(ids)) return false;
    const fresh = [...new Set(ids)].filter((id) => typeof id === 'string' && id !== '');
    const todo = fresh.filter((id) => !rows.has(key(sessionId, id)) && !missing.has(key(sessionId, id)));
    if (todo.length === 0) return false;
    const batchKey = `verify\n${sessionId}\n${todo.join(' ')}`;
    if (inFlight.has(batchKey)) return false;
    inFlight.add(batchKey);
    let changed = false;
    try {
      changed = await runChunks(sessionId, todo, signal);
    } finally {
      inFlight.delete(batchKey);
    }
    if (changed) notify();
    return changed;
  }

  /**
   * Status refresh for ALREADY-VERIFIED ids in this session. Throttled to one
   * automatic pass per `refreshIntervalMs` per id unless `force` (tab visible,
   * card expand). Transport failure keeps the last row and flags stale.
   * @returns {Promise<boolean>} whether anything observable changed.
   */
  async function refresh(sessionId, ids, { signal, force = false } = {}) {
    if (typeof sessionId !== 'string' || sessionId === '' || !Array.isArray(ids)) return false;
    const now = Date.now();
    const todo = [...new Set(ids)].filter((id) => {
      if (!rows.has(key(sessionId, id))) return false;
      if (force) return true;
      const fresh = freshness.get(key(sessionId, id));
      return fresh === undefined || now - fresh.asOf >= refreshIntervalMs;
    });
    if (todo.length === 0) return false;
    const batchKey = `refresh\n${sessionId}\n${todo.join(' ')}`;
    if (inFlight.has(batchKey)) return false;
    inFlight.add(batchKey);
    let changed = false;
    try {
      changed = await runChunks(sessionId, todo, signal);
      // Successful lookup stamps a new asOf even when content is unchanged —
      // the card's 截至 label may advance (bounded by the refresh interval).
      // The stamp is LOCAL TIME WHEN THE RESPONSE COMPLETED, never the time
      // the request was planned.
      if (!changed) {
        const completedAt = Date.now();
        for (const id of todo) {
          const fresh = freshness.get(key(sessionId, id));
          if (fresh !== undefined && fresh.stale === false) {
            freshness.set(key(sessionId, id), { ...fresh, asOf: completedAt });
            changed = true;
          }
        }
      }
    } finally {
      inFlight.delete(batchKey);
    }
    if (changed) notify();
    return changed;
  }

  /**
   * Drop every cached verdict for ids that left the current windows
   * (replace/prepend/compaction), so a later return re-verifies honestly.
   * @param keep - predicate (sessionId, id) → keep when still current.
   */
  function revoke(keep) {
    let changed = false;
    for (const k of [...rows.keys()]) {
      const [sessionId, id] = k.split('\n');
      if (keep(sessionId, id) !== true) {
        rows.delete(k);
        freshness.delete(k);
        changed = true;
      }
    }
    for (const k of [...missing]) {
      const [sessionId, id] = k.split('\n');
      if (keep(sessionId, id) !== true) missing.delete(k);
    }
    for (const k of [...freshness.keys()]) {
      const [sessionId, id] = k.split('\n');
      if (keep(sessionId, id) !== true) freshness.delete(k);
    }
    if (changed) notify();
    return changed;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { has, get, freshnessOf, verify, refresh, revoke, subscribe };
}
