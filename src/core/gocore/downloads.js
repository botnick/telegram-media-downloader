// Bounded catalog reads shared by bulk operations and background jobs.
import { getDb } from '../db.js';
import * as client from './client.js';

const BATCH_SIZE = 500;
const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));

export async function readDownloadRowsByIds(ids, { signal } = {}) {
    // SQLite's original IN query returns each row once in primary-key order.
    // Sort before chunking so ZIP member order and collision suffixes remain
    // stable even when the caller selects more than one batch in reverse.
    const normalized = [...new Set(
        (Array.isArray(ids) ? ids : []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0),
    )].sort((a, b) => a - b);
    const readLocalChunk = (chunk) =>
        getDb().prepare(`
            SELECT id, group_id, group_name, file_name, file_size, file_type, file_path
              FROM downloads WHERE id IN (${chunk.map(() => '?').join(',')}) ORDER BY id
        `).all(...chunk);
    const readLocal = async () => {
        const rows = [];
        for (let i = 0; i < normalized.length; i += BATCH_SIZE) {
            signal?.throwIfAborted();
            const chunk = normalized.slice(i, i + BATCH_SIZE);
            rows.push(...getDb().prepare(`
                SELECT id, group_id, group_name, file_name, file_size, file_type, file_path
                  FROM downloads WHERE id IN (${chunk.map(() => '?').join(',')}) ORDER BY id
            `).all(...chunk));
            if (i + BATCH_SIZE < normalized.length) await yieldTurn();
        }
        return rows;
    };
    const rows = [];
    const useGo = client.isAvailable('db');
    for (let i = 0; i < normalized.length; i += BATCH_SIZE) {
        signal?.throwIfAborted();
        const chunk = normalized.slice(i, i + BATCH_SIZE);
        let page;
        if (useGo) {
            try {
                page = (await client.downloadsByIds({ ids: chunk }, { timeoutMs: 5000, signal })).rows;
            } catch {
                signal?.throwIfAborted();
                // A mixed Go/local snapshot is harder to reason about than a
                // single local read. Retry the complete request locally.
                return readLocal();
            }
        }
        if (!page) {
            page = await readLocalChunk(chunk, signal);
        }
        rows.push(...page);
        if (i + BATCH_SIZE < normalized.length) await yieldTurn();
    }
    return rows;
}

export async function readGroupDownloadIds(groupId, { signal } = {}) {
    const ids = [];
    let beforeId = Number.MAX_SAFE_INTEGER;
    let useGo = client.isAvailable('db');
    const readLocal = () =>
        getDb()
            .prepare('SELECT id FROM downloads WHERE group_id = ? ORDER BY id')
            .all(String(groupId))
            .map((row) => row.id);
    while (true) {
        signal?.throwIfAborted();
        let page;
        if (useGo) {
            try {
                page = (await client.groupDownloadIds(
                    { groupId, beforeId, limit: BATCH_SIZE }, { timeoutMs: 5000, signal },
                )).rows;
            } catch {
                signal?.throwIfAborted();
                return readLocal();
            }
        }
        if (!page) {
            page = getDb().prepare(
                'SELECT id FROM downloads WHERE group_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
            ).all(String(groupId), beforeId, BATCH_SIZE);
        }
        if (!page.length) break;
        for (const row of page) ids.push(row.id);
        beforeId = page[page.length - 1].id;
        if (page.length < BATCH_SIZE) break;
        await yieldTurn();
    }
    // Existing cache cleanup visits older rows first. IDs still occupy O(n)
    // space, but no query materializes every row object on Node's event loop.
    return ids.reverse();
}
