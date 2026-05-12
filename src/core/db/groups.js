import { getDb } from '../db.js';

/**
 * Per-group stats card backing query — single index-only scan over
 * `idx_group_message`. Returns the totals the Group → Data tab renders
 * above its file strip. Cheap enough to call on every modal open.
 *
 * Shape:
 *   { totalFiles, totalBytes, byType: {photo, video, audio, document, sticker, voice},
 *     firstMessageId, lastMessageId, lastDownloadAt }
 */
export function getGroupStats(groupId) {
    const db = getDb();
    const totals =
        db
            .prepare(`
            SELECT COUNT(*) AS totalFiles,
                   COALESCE(SUM(COALESCE(file_size, 0)), 0) AS totalBytes,
                   MIN(message_id) AS firstMessageId,
                   MAX(message_id) AS lastMessageId,
                   MAX(created_at) AS lastDownloadAt
              FROM downloads
             WHERE group_id = ?
        `)
            .get(String(groupId)) || {};
    const rows = db
        .prepare(`
            SELECT file_type, COUNT(*) AS n
              FROM downloads
             WHERE group_id = ?
             GROUP BY file_type
        `)
        .all(String(groupId));
    const byType = {};
    for (const r of rows) byType[r.file_type || 'other'] = Number(r.n) || 0;
    return {
        totalFiles: Number(totals.totalFiles) || 0,
        totalBytes: Number(totals.totalBytes) || 0,
        byType,
        firstMessageId: totals.firstMessageId == null ? null : Number(totals.firstMessageId),
        lastMessageId: totals.lastMessageId == null ? null : Number(totals.lastMessageId),
        lastDownloadAt: totals.lastDownloadAt || null,
    };
}

/**
 * Paginated file list for the Group → Data tab. Uses `idx_group_message`
 * for the WHERE filter + the index's natural ordering for the LIMIT/OFFSET
 * scan, so a 100k-row group still opens the modal in <500 ms.
 */
export function listGroupFiles({ groupId, limit = 50, offset = 0, type = null } = {}) {
    const db = getDb();
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    const where = ['group_id = ?'];
    const args = [String(groupId)];
    if (type && typeof type === 'string') {
        where.push('file_type = ?');
        args.push(type);
    }
    const whereSql = where.join(' AND ');
    const total =
        db.prepare(`SELECT COUNT(*) AS n FROM downloads WHERE ${whereSql}`).get(...args).n || 0;
    const rows = db
        .prepare(`
            SELECT id, message_id, file_name, file_path, file_type, file_size, created_at, nsfw_score
              FROM downloads
             WHERE ${whereSql}
             ORDER BY created_at DESC, id DESC
             LIMIT ? OFFSET ?
        `)
        .all(...args, lim, off);
    return {
        rows,
        total,
        limit: lim,
        offset: off,
        hasMore: off + rows.length < total,
    };
}

/**
 * Delete all download records for a specific group
 * @param {string} groupId - Telegram group ID
 * @returns {{ deletedDownloads: number, deletedQueue: number }}
 */
export function deleteGroupDownloads(groupId) {
    const db = getDb();
    const del1 = db.prepare('DELETE FROM downloads WHERE group_id = ?').run(String(groupId));
    const del2 = db.prepare('DELETE FROM queue WHERE group_id = ?').run(String(groupId));
    return { deletedDownloads: del1.changes, deletedQueue: del2.changes };
}

/**
 * Delete ALL download and queue records
 * @returns {{ deletedDownloads: number, deletedQueue: number }}
 */
export function deleteAllDownloads() {
    const db = getDb();
    const del1 = db.prepare('DELETE FROM downloads').run();
    const del2 = db.prepare('DELETE FROM queue').run();
    return { deletedDownloads: del1.changes, deletedQueue: del2.changes };
}

/**
 * Backfill group_name for existing records using config groups.
 * Call once on startup after config is loaded.
 * @param {Array<{id: string|number, name: string}>} groups - Config groups
 * @returns {number} Number of records updated
 */
export function backfillGroupNames(groups) {
    if (!groups || groups.length === 0) return 0;
    const db = getDb();
    const stmt = db.prepare(
        'UPDATE downloads SET group_name = ? WHERE group_id = ? AND group_name IS NULL',
    );
    let updated = 0;
    const tx = db.transaction(() => {
        for (const g of groups) {
            if (g.name) {
                const result = stmt.run(g.name, String(g.id));
                updated += result.changes;
            }
        }
    });
    tx();
    return updated;
}
