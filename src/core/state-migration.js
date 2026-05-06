/**
 * One-shot import of legacy JSON state files (config.json, disk_usage.json,
 * web-sessions.json) into the SQLite-backed kv / web_sessions tables.
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

import { suggestPublicReplacement, AI_MODEL_DEFAULTS } from './ai/models.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.TGDL_DATA_DIR
    ? path.resolve(process.env.TGDL_DATA_DIR)
    : path.join(__dirname, '../../data');

const CONFIG_JSON = path.join(DATA_DIR, 'config.json');
const DISK_USAGE_JSON = path.join(DATA_DIR, 'disk_usage.json');
const SESSIONS_JSON = path.join(DATA_DIR, 'web-sessions.json');

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
 *
 * `listEmbeddingModels` and `clearStaleEmbeddings` are optional — they only
 * exist after the AI schema migration has run. The reembed step short-
 * circuits when either is missing so the loader stays usable in older
 * tests / fixture DBs that pre-date that schema.
 */
export function runStateMigration({
    db,
    kvGet,
    kvSet,
    insertSession,
    listSessions,
    listEmbeddingModels,
    clearStaleEmbeddings,
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

    // --- gated AI model id sweep ---
    // Operators who installed before AI_MODEL_DEFAULTS was updated still
    // have stale gated model ids saved in kv['config']; those throw 401
    // every scan. Rewrite them to the matching public default in place.
    try {
        touched += _sanitiseAiModelIds({ kvGet, kvSet, log });
    } catch (e) {
        log(`gated-model sweep failed: ${e?.message || e}`);
    }

    // --- embeddings re-embed sweep ---
    // When the default embeddings model changes (e.g. CLIP-EN → SigLIP
    // multilingual at v2.7.x), every existing image_embeddings row is
    // built against the OLD model. Different dimensions + different
    // semantic spaces mean those vectors silently score 0 against new
    // queries. Detect the mismatch on boot and wipe the stale rows so
    // the next scan rebuilds them.
    if (typeof listEmbeddingModels === 'function' && typeof clearStaleEmbeddings === 'function') {
        try {
            touched += _reembedOnModelChange({
                kvGet,
                listEmbeddingModels,
                clearStaleEmbeddings,
                log,
            });
        } catch (e) {
            log(`reembed sweep failed: ${e?.message || e}`);
        }
    }

    if (touched > 0) {
        log(`migration complete (${touched} item${touched === 1 ? '' : 's'} imported)`);
    }
}

/**
 * Walk `kv['config'].advanced.ai.{embeddings,faces,tags}.model` and rewrite
 * any id that appears in `KNOWN_GATED_MODELS` to the matching public default.
 * Idempotent — running on an already-clean config is a no-op. Returns the
 * number of fields rewritten so the outer migration counter stays accurate.
 *
 * Exported so unit tests can drive it directly without spinning up the rest
 * of the migration plumbing.
 */
export function _sanitiseAiModelIds({ kvGet, kvSet, log = () => {} }) {
    const cfg = kvGet('config');
    if (!cfg || typeof cfg !== 'object') return 0;
    const ai = cfg.advanced?.ai;
    if (!ai || typeof ai !== 'object') return 0;

    const caps = ['embeddings', 'faces', 'tags'];
    let rewrites = 0;
    let dirty = false;
    for (const cap of caps) {
        const node = ai[cap];
        const cur = node?.model;
        if (typeof cur !== 'string' || !cur.trim()) continue;
        const repl = suggestPublicReplacement(cur);
        if (!repl) continue;
        log(`rewrote advanced.ai.${cap}.model: ${cur} → ${repl.suggested}`);
        node.model = repl.suggested;
        rewrites += 1;
        dirty = true;
    }
    if (dirty) kvSet('config', cfg);
    return rewrites;
}

/**
 * Detect that `image_embeddings` rows were built against a different
 * embedding-model id than the one currently active, and drop them so
 * the next scan re-embeds with the new model. Returns 1 when a wipe ran,
 * 0 when the table was already in sync.
 *
 *   - currentModel = kv['config'].advanced.ai.embeddings.model
 *                    || AI_MODEL_DEFAULTS.embeddings.modelId
 *   - if every distinct row already matches → no-op
 *   - if a row's model differs (e.g. old CLIP rows after a SigLIP swap)
 *     → DELETE those rows + reset downloads.ai_indexed_at = NULL via
 *     the `clearStaleEmbeddings` helper from db.js
 *
 * Idempotent: a second invocation on a clean table is a no-op.
 *
 * Exported so unit tests can drive it directly.
 */
export function _reembedOnModelChange({
    kvGet,
    listEmbeddingModels,
    clearStaleEmbeddings,
    log = () => {},
}) {
    const cfg = kvGet('config');
    const explicit = cfg?.advanced?.ai?.embeddings?.model;
    const currentModel =
        (typeof explicit === 'string' && explicit.trim()) ||
        AI_MODEL_DEFAULTS.embeddings.modelId;

    let stored;
    try {
        stored = listEmbeddingModels();
    } catch {
        // Table doesn't exist yet (fresh install) — nothing to migrate.
        return 0;
    }
    if (!Array.isArray(stored) || stored.length === 0) return 0;

    const stale = stored.filter((r) => r.model !== currentModel);
    if (!stale.length) return 0;

    const total = stale.reduce((n, r) => n + (Number(r.count) || 0), 0);
    const ids = stale.map((r) => `${r.model || '(empty)'}:${r.count}`).join(', ');
    log(`reembed sweep: dropping ${total} stale row(s) [${ids}] — current=${currentModel}`);

    const result = clearStaleEmbeddings(currentModel);
    log(`reembed sweep: dropped=${result.dropped} requeued=${result.requeued}`);
    return 1;
}
