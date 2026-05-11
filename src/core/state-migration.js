/**
 * One-shot import of legacy JSON state files (config.json, disk_usage.json,
 * web-sessions.json, history-jobs.json, queue-history.json) into the
 * SQLite-backed kv / web_sessions tables.
 *
 * Auto-runs at the tail of getDb() once per process. Idempotent — every step
 * checks whether the destination row(s) already exist before importing, so a
 * mid-migration crash followed by a restart resumes safely.
 *
 * After a successful import each source file is renamed to `<file>.migrated`
 * so it stays on disk as a reversible backup but stops shadowing the DB row.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.TGDL_DATA_DIR
    ? path.resolve(process.env.TGDL_DATA_DIR)
    : path.join(__dirname, '../../data');

const CONFIG_JSON = path.join(DATA_DIR, 'config.json');
const DISK_USAGE_JSON = path.join(DATA_DIR, 'disk_usage.json');
const SESSIONS_JSON = path.join(DATA_DIR, 'web-sessions.json');
const HISTORY_JOBS_JSON = path.join(DATA_DIR, 'history-jobs.json');
const QUEUE_HISTORY_JSON = path.join(DATA_DIR, 'queue-history.json');
const QUEUE_BACKLOG_JSONL = path.join(DATA_DIR, 'logs', 'queue_backlog.jsonl');

function readJsonOrNull(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function archive(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.renameSync(filePath, `${filePath}.migrated`);
        }
    } catch {
        /* keep going — file rename is best-effort */
    }
}

/**
 * Run the migration. Accepts the db module's exports as args so this file
 * doesn't introduce a circular import with db.js (db.js imports this at the
 * tail of getDb()).
 */
export function runStateMigration({
    db,
    kvGet,
    kvSet,
    insertSession,
    listSessions,
    pushQueueBacklog,
}) {
    const log = (msg) => {
        // Plain console.log — we're inside getDb() before logger.js may have
        // wired its sinks. The migration is short and one-shot, so terse is
        // fine; operators see this in the boot transcript.
        // eslint-disable-next-line no-console
        console.log(`[state-migration] ${msg}`);
    };

    let touched = 0;

    // --- config.json ---
    if (fs.existsSync(CONFIG_JSON) && kvGet('config') === null) {
        const parsed = readJsonOrNull(CONFIG_JSON);
        if (parsed && typeof parsed === 'object') {
            kvSet('config', parsed);
            archive(CONFIG_JSON);
            log(`config.json → kv['config'] (archived to config.json.migrated)`);
            touched++;
        }
    } else if (fs.existsSync(CONFIG_JSON)) {
        // kv['config'] already populated and the legacy file is still around —
        // archive it so it stops drifting from the live row.
        archive(CONFIG_JSON);
        log('config.json archived (kv[config] already populated)');
    }

    // --- disk_usage.json ---
    if (fs.existsSync(DISK_USAGE_JSON) && kvGet('disk_usage') === null) {
        const parsed = readJsonOrNull(DISK_USAGE_JSON);
        if (parsed && typeof parsed === 'object') {
            kvSet('disk_usage', parsed);
            archive(DISK_USAGE_JSON);
            log(`disk_usage.json → kv['disk_usage'] (archived)`);
            touched++;
        }
    } else if (fs.existsSync(DISK_USAGE_JSON)) {
        archive(DISK_USAGE_JSON);
    }

    // --- web-sessions.json ---
    if (fs.existsSync(SESSIONS_JSON)) {
        const parsed = readJsonOrNull(SESSIONS_JSON);
        const existingCount = listSessions().length;
        if (parsed && typeof parsed === 'object' && existingCount === 0) {
            const now = Date.now();
            const tx = db.transaction((entries) => {
                for (const [token, meta] of entries) {
                    if (!meta || meta.expiresAt <= now) continue;
                    const role = meta.role === 'guest' ? 'guest' : 'admin';
                    try {
                        insertSession({
                            token,
                            role,
                            expiresAt: Number(meta.expiresAt),
                            issuedAt: Number(meta.createdAt) || now,
                        });
                    } catch {
                        /* duplicate token / bad row — skip */
                    }
                }
            });
            tx(Object.entries(parsed));
            archive(SESSIONS_JSON);
            log(`web-sessions.json → web_sessions table (archived)`);
            touched++;
        } else {
            // Either rows already imported or file empty — archive + move on.
            archive(SESSIONS_JSON);
        }
    }

    // --- history-jobs.json ---
    if (fs.existsSync(HISTORY_JOBS_JSON) && kvGet('history_jobs') === null) {
        const parsed = readJsonOrNull(HISTORY_JOBS_JSON);
        if (Array.isArray(parsed)) {
            kvSet('history_jobs', parsed);
            archive(HISTORY_JOBS_JSON);
            log(`history-jobs.json → kv['history_jobs'] (archived)`);
            touched++;
        }
    } else if (fs.existsSync(HISTORY_JOBS_JSON)) {
        archive(HISTORY_JOBS_JSON);
    }

    // --- queue-history.json ---
    if (fs.existsSync(QUEUE_HISTORY_JSON) && kvGet('queue_history') === null) {
        const parsed = readJsonOrNull(QUEUE_HISTORY_JSON);
        if (Array.isArray(parsed)) {
            kvSet('queue_history', parsed);
            archive(QUEUE_HISTORY_JSON);
            log(`queue-history.json → kv['queue_history'] (archived)`);
            touched++;
        }
    } else if (fs.existsSync(QUEUE_HISTORY_JSON)) {
        archive(QUEUE_HISTORY_JSON);
    }

    // --- queue_backlog.jsonl ---
    // Pre-v2.7 the spillover queue was a JSONL append log. Replay any
    // pending lines into the queue_backlog table so jobs that were
    // mid-spill at upgrade time aren't silently lost. `pushQueueBacklog`
    // is optional so older test fixtures without the table don't crash
    // the loader.
    if (typeof pushQueueBacklog === 'function' && fs.existsSync(QUEUE_BACKLOG_JSONL)) {
        let imported = 0;
        try {
            const raw = fs.readFileSync(QUEUE_BACKLOG_JSONL, 'utf8');
            for (const line of raw.split(/\r?\n/)) {
                if (!line.trim()) continue;
                try {
                    pushQueueBacklog(JSON.parse(line));
                    imported++;
                } catch {
                    /* malformed line — skip */
                }
            }
        } catch {
            /* unreadable — leave it alone */
        }
        archive(QUEUE_BACKLOG_JSONL);
        if (imported > 0) {
            log(`queue_backlog.jsonl → queue_backlog table (${imported} jobs, archived)`);
            touched++;
        } else {
            log(`queue_backlog.jsonl archived (no replayable jobs)`);
        }
    }

    // (Note: v2.13 once stripped the `advanced.ai` namespace because the
    // subsystem had been removed. v2.15 brings it back with a richer
    // schema, so the strip block was deleted. Existing installs that ran
    // a v2.13 boot will simply re-acquire the namespace from defaults
    // when they next save config.)

    if (touched > 0) {
        log(`migration complete (${touched} item${touched === 1 ? '' : 's'} imported)`);
    }
}
