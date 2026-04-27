import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'db.sqlite');

// Singleton connection
let db;

export function getDb() {
    if (db) return db;

    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    db = new Database(DB_PATH);
    
    // Performance tuning
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');

    initSchema();
    return db;
}

function initSchema() {
    // Downloads Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS downloads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL,
            group_name TEXT,
            message_id INTEGER NOT NULL,
            file_name TEXT,
            file_size INTEGER,
            file_type TEXT, -- photo, video, document
            file_path TEXT,
            status TEXT DEFAULT 'completed',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(group_id, message_id)
        );
        CREATE INDEX IF NOT EXISTS idx_group_id ON downloads(group_id);
        CREATE INDEX IF NOT EXISTS idx_created_at ON downloads(created_at);
    `);

    // Forward-compatible column migrations. Each ALTER is wrapped in its own
    // try/catch so adding column N+1 doesn't get blocked by column N already
    // existing.
    const migrations = [
        'ALTER TABLE downloads ADD COLUMN group_name TEXT',
        'ALTER TABLE downloads ADD COLUMN ttl_seconds INTEGER',
        'ALTER TABLE downloads ADD COLUMN file_hash TEXT',
        // pinned: rows with pinned=1 are protected from auto-rotation sweeps.
        'ALTER TABLE downloads ADD COLUMN pinned INTEGER DEFAULT 0',
        // Rescue Mode: rows with a non-null pending_until are auto-pruned by
        // the rescue sweeper after that timestamp UNLESS the source message
        // was deleted on Telegram first (in which case rescued_at gets set
        // and pending_until is cleared, keeping the file forever).
        'ALTER TABLE downloads ADD COLUMN pending_until INTEGER',
        'ALTER TABLE downloads ADD COLUMN rescued_at INTEGER',
    ];
    for (const sql of migrations) {
        try { db.exec(sql); } catch { /* column already exists */ }
    }
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_filename_size ON downloads(group_id, file_name, file_size)'); } catch {}
    // Speeds up the rescue sweeper's expired-pending scan and the per-message
    // markRescued lookup. Both are cheap CREATE-IF-NOT-EXISTS calls.
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_pending_until ON downloads(pending_until) WHERE pending_until IS NOT NULL'); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_group_message ON downloads(group_id, message_id)'); } catch {}

    // Queue/Pending Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL,
            message_id INTEGER NOT NULL,
            meta TEXT, -- JSON payload
            priority INTEGER DEFAULT 0,
            status TEXT DEFAULT 'pending', -- pending, processing, failed
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
}

export function insertDownload(data) {
    const row = {
        groupId: data.groupId,
        groupName: data.groupName ?? null,
        messageId: data.messageId,
        fileName: data.fileName ?? null,
        fileSize: data.fileSize ?? null,
        fileType: data.fileType ?? null,
        filePath: data.filePath ?? null,
        ttlSeconds: data.ttlSeconds ?? null,
        fileHash: data.fileHash ?? null,
        // Rescue Mode: when set, the rescue sweeper auto-deletes this row
        // after the timestamp unless the source is deleted first.
        pendingUntil: data.pendingUntil ?? null,
    };
    const stmt = getDb().prepare(`
        INSERT OR IGNORE INTO downloads (
            group_id, group_name, message_id, file_name, file_size, file_type, file_path, ttl_seconds, file_hash, pending_until
        ) VALUES (
            @groupId, @groupName, @messageId, @fileName, @fileSize, @fileType, @filePath, @ttlSeconds, @fileHash, @pendingUntil
        )
    `);
    return stmt.run(row);
}

/**
 * Mark a row as rescued — the source message was deleted on Telegram, so
 * the local file gets to live forever. Clears pending_until so the rescue
 * sweeper skips it. Idempotent: a second call with the same id is a no-op.
 *
 * @param {string|number} groupId
 * @param {number} messageId
 * @returns {number} rows updated (0 or 1; >1 only if duplicate inserts exist)
 */
export function markRescued(groupId, messageId) {
    const now = Date.now();
    const r = getDb()
        .prepare(`
            UPDATE downloads
               SET rescued_at = ?, pending_until = NULL
             WHERE group_id = ? AND message_id = ?
               AND rescued_at IS NULL
        `)
        .run(now, String(groupId), Number(messageId));
    return r.changes;
}

/**
 * Rows whose pending window has elapsed without a source-delete event.
 * The rescue sweeper unlinks the file + drops the row for each one.
 */
export function getExpiredPending(now = Date.now()) {
    return getDb()
        .prepare(`
            SELECT id, group_id, group_name, file_name, file_size, file_type, file_path, pending_until
              FROM downloads
             WHERE pending_until IS NOT NULL
               AND pending_until < ?
               AND rescued_at IS NULL
             ORDER BY pending_until ASC
             LIMIT 5000
        `)
        .all(Number(now));
}

/**
 * Counters for the Rescue panel in the SPA. `lastSweepCleared` is updated
 * by the sweeper via setRescueLastSweep().
 */
let _rescueLastSwept = 0;
export function setRescueLastSweep(n) {
    _rescueLastSwept = Number(n) || 0;
}
export function getRescueStats() {
    const db = getDb();
    const pending = db
        .prepare(`SELECT COUNT(*) as c FROM downloads WHERE pending_until IS NOT NULL AND rescued_at IS NULL`)
        .get().c;
    const rescued = db
        .prepare(`SELECT COUNT(*) as c FROM downloads WHERE rescued_at IS NOT NULL`)
        .get().c;
    return { pending, rescued, lastSweepCleared: _rescueLastSwept };
}

/**
 * Lightweight dedup that catches the same file re-uploaded under a new
 * message_id. Returns true if (group_id, file_name, file_size) already
 * exists. Cheap thanks to the (group_id, file_name, file_size) index.
 */
export function fileAlreadyStored(groupId, fileName, fileSize) {
    if (!fileName || !fileSize) return false;
    const r = getDb()
        .prepare('SELECT 1 FROM downloads WHERE group_id = ? AND file_name = ? AND file_size = ? LIMIT 1')
        .get(String(groupId), String(fileName), Number(fileSize));
    return !!r;
}

export function isDownloaded(groupId, messageId) {
    const stmt = getDb().prepare('SELECT 1 FROM downloads WHERE group_id = ? AND message_id = ? LIMIT 1');
    return !!stmt.get(String(groupId), Number(messageId));
}

export function getDownloads(groupId, limit = 50, offset = 0, type = 'all') {
    let query = 'SELECT * FROM downloads WHERE group_id = ?';
    const params = [groupId];

    if (type !== 'all') {
        const typeMap = {
            'images': 'photo',
            'videos': 'video',
            'documents': 'document',
            'audio': 'audio'
        };
        // Use LIKE for flexibility or map precisely
        if (typeMap[type]) {
             query += ' AND file_type = ?';
             params.push(typeMap[type]);
        }
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = getDb().prepare(query);
    const rows = stmt.all(...params);
    
    // Count total for pagination
    let countQuery = 'SELECT COUNT(*) as total FROM downloads WHERE group_id = ?';
    const countParams = [groupId];
    
    // We reuse the type filter logic for count but it's cleaner to separate or build dynamically
    // For simplicity here:
    if (params.length > 3) { // If type filter was added
         countQuery += ' AND file_type = ?';
         countParams.push(params[1]); // existing type param
    }
    
    const total = getDb().prepare(countQuery).get(...countParams).total;

    return { files: rows, total };
}

/**
 * Full-text-ish search over downloaded files. LIKE-based; cheap on the
 * sub-100k row counts we expect.
 *
 * @param {string} query  user input
 * @param {object} [opts]
 * @param {number} [opts.limit=50]
 * @param {number} [opts.offset=0]
 * @param {string} [opts.groupId]  optional restrict to one group
 */
export function searchDownloads(query, opts = {}) {
    const limit = Math.max(1, Math.min(500, parseInt(opts.limit, 10) || 50));
    const offset = Math.max(0, parseInt(opts.offset, 10) || 0);
    const q = `%${String(query || '').trim()}%`;
    const params = [q, q];
    let where = '(file_name LIKE ? OR group_name LIKE ?)';
    if (opts.groupId) { where += ' AND group_id = ?'; params.push(String(opts.groupId)); }
    const rows = getDb()
        .prepare(`SELECT * FROM downloads WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset);
    const total = getDb()
        .prepare(`SELECT COUNT(*) as c FROM downloads WHERE ${where}`)
        .get(...params).c;
    return { files: rows, total };
}

/** Bulk-delete by ids (preferred) or file_paths. Returns the number removed. */
export function deleteDownloadsBy(opts) {
    const db = getDb();
    if (Array.isArray(opts?.ids) && opts.ids.length) {
        const stmt = db.prepare('DELETE FROM downloads WHERE id = ?');
        const tx = db.transaction(() => opts.ids.reduce((n, id) => n + stmt.run(id).changes, 0));
        return tx();
    }
    if (Array.isArray(opts?.filePaths) && opts.filePaths.length) {
        const stmt = db.prepare('DELETE FROM downloads WHERE file_path = ?');
        const tx = db.transaction(() => opts.filePaths.reduce((n, p) => n + stmt.run(p).changes, 0));
        return tx();
    }
    return 0;
}

export function getStats() {
    const db = getDb();
    const totalFiles = db.prepare('SELECT COUNT(*) as count FROM downloads').get().count;
    const totalSize = db.prepare('SELECT SUM(file_size) as size FROM downloads').get().size || 0;
    return { totalFiles, totalSize };
}

/**
 * Sum of file_size across all download rows (NULL sizes are treated as 0).
 * Used by the disk rotator to decide whether the cap is exceeded.
 */
export function getTotalSizeBytes() {
    const r = getDb().prepare('SELECT COALESCE(SUM(file_size), 0) as size FROM downloads').get();
    return Number(r?.size || 0);
}

/**
 * Returns the N oldest download rows (created_at ASC), skipping pinned ones.
 * The rotator pulls from this list and deletes file + row until the cap is
 * back under the limit.
 */
export function getOldestDownloads(count = 50) {
    const limit = Math.max(1, Math.min(10000, parseInt(count, 10) || 50));
    return getDb()
        .prepare(`
            SELECT id, group_id, group_name, file_name, file_size, file_type, file_path, created_at, pinned
            FROM downloads
            WHERE COALESCE(pinned, 0) = 0
            ORDER BY datetime(created_at) ASC, id ASC
            LIMIT ?
        `)
        .all(limit);
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
    const stmt = db.prepare('UPDATE downloads SET group_name = ? WHERE group_id = ? AND group_name IS NULL');
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
