// Bounded merge of the two directional records streams. The existing snapshot
// API sorts newest first by (createdAt DESC, id ASC). Keep independent offsets
// and unconsumed buffers: advancing both offsets together drops messages when
// one direction is more active than the other.
export const EXCHANGE_PAGE_SIZE = 20;

const compareNewest = (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id);
const source = (from, to) => ({ from, to, offset: 0, done: false, buffer: [] });

export function createExchangePager(selfId, peerId) {
  const sources = [source(selfId, peerId)];
  if (selfId !== peerId) sources.push(source(peerId, selfId));
  return { sources, seen: [], revision: null };
}

/**
 * Return at most 20 records, without loading a complete history. Each source is
 * read at most as needed, with a 20-row fetch. `read` returns a snapshot page.
 * A revision change during a multi-page read fails closed instead of silently
 * skipping records when offsets have moved. The caller can restart on demand.
 */
export async function readExchangePage(previous, read, { signal } = {}) {
  const next = { revision: previous.revision, seen: [...previous.seen], sources: previous.sources.map(s => ({ ...s, buffer: [...s.buffer] })) };
  const seen = new Set(next.seen);
  const items = [];
  async function fill(s) {
    while (!s.buffer.length && !s.done) {
      const page = await read({ from: s.from, to: s.to, offset: s.offset, limit: EXCHANGE_PAGE_SIZE, signal });
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (typeof page.revision !== 'number' || !Number.isSafeInteger(page.revision)) throw new Error('invalid_snapshot');
      if (next.revision !== null && page.revision !== next.revision) {
        const error = new Error('记录已更新，请重新载入。');
        error.code = 'exchange_changed';
        throw error;
      }
      next.revision = page.revision;
      const rows = page.messages ?? [];
      if (!Array.isArray(rows) || rows.length > EXCHANGE_PAGE_SIZE || rows.some(row => !row || typeof row.id !== 'string' || typeof row.createdAt !== 'number')) throw new Error('invalid_snapshot');
      s.offset += rows.length;
      s.done = !page.hasMore;
      if (!rows.length && !s.done) throw new Error('invalid_snapshot');
      s.buffer.push(...rows);
    }
  }
  // Fetch sequentially into a private clone so a rejection does not commit one
  // half of a page. One source always remains bounded to at most 20 rows.
  while (items.length < EXCHANGE_PAGE_SIZE) {
    await Promise.all(next.sources.map(fill));
    const choices = next.sources.filter(s => s.buffer.length).sort((a, b) => compareNewest(a.buffer[0], b.buffer[0]));
    if (!choices.length) break;
    const row = choices[0].buffer.shift();
    if (!seen.has(row.id)) { seen.add(row.id); items.push(row); }
  }
  next.seen = [...seen];
  return { pager: next, messages: items.reverse(), hasMore: next.sources.some(s => !s.done || s.buffer.length > 0) };
}
