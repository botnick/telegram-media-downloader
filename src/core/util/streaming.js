// Big-data helpers — keeps "walk the table" sweeps and growing in-memory
// caches from blowing the V8 heap on a 1M-row library. See `CLAUDE.md`
// section "Big-data patterns" for the four invariants every new feature
// must follow; this module is the canonical implementation those rules
// reference.

/**
 * Stream rows from a better-sqlite3 prepared statement, processing them
 * in fixed-size batches with an event-loop yield between batches. Use
 * this in every `walk every row of a high-cardinality table` sweep so
 * neither the heap nor the event loop is starved.
 *
 *   await streamRows({
 *       db,
 *       sql: 'SELECT id, file_path FROM downloads WHERE file_path IS NOT NULL',
 *       args: [],
 *       batchSize: 64,
 *       onBatch: async (rows) => { … },
 *   });
 *
 * `onBatch` receives an Array<row> sized at most `batchSize`. It may be
 * sync or async; the iterator yields control via `setImmediate` after
 * each batch resolves, so WebSocket progress events flush in real time
 * instead of queueing behind the loop.
 *
 * Returns `{ processed: number }`.
 *
 * IMPORTANT — connection safety: this helper uses `.all(batchSize, offset)`
 * (LIMIT/OFFSET pagination) rather than `.iterate()`. A live `.iterate()`
 * cursor holds the better-sqlite3 connection open for its full lifetime;
 * when `onBatch` contains an `await`, other DB writers (download manager,
 * kv flush timer, AI pregenerate) collide on the busy connection and throw
 * "This database connection is busy executing a query". With LIMIT/OFFSET
 * paging each `.all()` call opens and closes the statement synchronously
 * before any async work begins.
 *
 * Callers whose SQL supports a stable ORDER BY column should prefer
 * keyset pagination (see seekbar/scan-runner.js) over this helper's
 * OFFSET approach to avoid O(N²) seeks on very large tables.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {string} opts.sql       — must not already contain LIMIT/OFFSET
 * @param {any[]} [opts.args]
 * @param {number} [opts.batchSize]
 * @param {(rows: any[]) => Promise<void> | void} opts.onBatch
 * @param {AbortSignal} [opts.signal]
 */
export async function streamRows({ db, sql, args = [], batchSize = 64, onBatch, signal }) {
    if (typeof onBatch !== 'function') {
        throw new TypeError('streamRows: onBatch is required');
    }
    const lim = Math.max(1, Number(batchSize) || 64);
    // Append LIMIT/OFFSET so the statement closes before any async work.
    const stmt = db.prepare(`${sql} LIMIT ? OFFSET ?`);
    let processed = 0;
    let offset = 0;
    while (true) {
        if (signal?.aborted) break;
        // `.all()` completes synchronously — cursor is closed before we
        // hit the await inside onBatch.
        const batch = stmt.all(...args, lim, offset);
        if (!batch.length) break;
        await onBatch(batch);
        processed += batch.length;
        offset += batch.length;
        // Yield to the event loop so WS broadcasts and other I/O can flush.
        await new Promise((r) => setImmediate(r));
        if (batch.length < lim) break;
    }
    return { processed };
}

/**
 * Drop the oldest entries from a Map until its size is at or below `max`.
 * Map iteration order is insertion order in modern JS engines, so the
 * oldest keys land at the front. Callers that want strict LRU should
 * `map.delete(key)` + re-set on access; this helper is the bare cap.
 *
 *   _failedJobMeta.set(key, value);
 *   lruCap(_failedJobMeta, 5000);
 *
 * @param {Map<any, any>} map
 * @param {number} max
 * @returns {number} number of entries evicted
 */
export function lruCap(map, max) {
    if (!map || typeof map.size !== 'number' || typeof map.delete !== 'function') return 0;
    if (map.size <= max) return 0;
    let evicted = 0;
    const it = map.keys();
    while (map.size > max) {
        const { value, done } = it.next();
        if (done) break;
        map.delete(value);
        evicted += 1;
    }
    return evicted;
}

/**
 * Paginate an envelope response. Server endpoints that return a list
 * should ALWAYS wrap the rows in this envelope so frontend pagination
 * stays consistent across features.
 *
 *   res.json(paginate(rows, total, page, limit));
 */
export function paginate(rows, total, page, limit) {
    const lim = Math.max(1, Number(limit) || 50);
    const p = Math.max(1, Number(page) || 1);
    const t = Math.max(0, Number(total) || rows.length);
    return {
        rows,
        total: t,
        page: p,
        pageSize: lim,
        totalPages: Math.max(1, Math.ceil(t / lim)),
        hasMore: p * lim < t,
    };
}
