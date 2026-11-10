// Group by verified facts, never by a translated/aggregated display label.
// In particular accepted+queued and accepted+received are different states.
export function capsuleStatusKey(row, freshness = {}) {
  if (!row || typeof row.status !== 'string' || row.status.length === 0) return null;
  return JSON.stringify([
    row.status,
    row.dispatchStatus ?? null,
    row.receipt?.policy ?? null,
    row.receipt?.state ?? null,
    row.replyStatus ?? null,
    freshness.stale === true || !Number.isFinite(freshness.asOf),
  ]);
}
