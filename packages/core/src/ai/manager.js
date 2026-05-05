/**
 * AI subsystem manager — fan-out + scan loops.
 *
 * Public surface:
 *   - `runIndexScan({ capabilities, signal, onProgress, onLog })`
 *       Walks every unindexed photo, runs each enabled capability, persists
 *       results. Returns a summary `{ processed, embeddings, faces, tags,
 *       phash, errors }`.
 *   - `runPhashScan(...)`        — phash-only fast path
 *   - `runFacesScan(...)`        — re-cluster every face into people rows
 *   - `runTagsScan(...)`         — auto-tag scan
 *   - `pregenerateAi(downloadId)`  — fire-and-forget hook from the downloader
 *   - `searchByText(query, opts)`  — text-to-image semantic search
 *
 * Every loop honours the AbortSignal threaded in from the JobTracker so a
 * mid-scan cancel returns control to the operator within a few hundred ms.
 */

import path from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

import {
    getDb,
    getUnindexedAiBatch,
    setAiIndexedAt,
    setImageEmbedding,
    setPhash,
    setImageTags,
    insertFace,
    deleteFacesForDownload,
    listAllFaces,
    listAllPhashes,
    clearAllPeople,
    insertPerson,
    setFacePerson,
} from '../db.js';
import { vectorToBlob, blobToVector, l2Normalize, topK as vectorTopK, clearCache as clearVectorCache } from './vector-store.js';
import { embedImage, embedText } from './embeddings.js';
import { detectFaces, embedFace, dbscan, centroidToBlob } from './faces.js';
import { classifyImage } from './tags.js';
import { computePhash, groupNearDuplicates } from './phash.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// Default model ids picked for public HF access (no token required, no
// gated repo). `Xenova/yolov5n-face` + `Xenova/mobilenet_v2` are gated
// even with a valid token — both fall back to similar-size public
// alternatives that work out of the box.
export const AI_DEFAULTS = Object.freeze({
    enabled: false,
    embeddings: { enabled: false, model: 'Xenova/clip-vit-base-patch32' },
    faces:      { enabled: false, model: 'Xenova/yolos-tiny',
                  epsilon: 0.55, minPoints: 3 },
    tags:       { enabled: false, model: 'Xenova/vit-base-patch16-224', topK: 5 },
    phash:      { enabled: false },
    indexConcurrency: 1,
    batchSize: 25,
    fileTypes: ['photo'],
});

/**
 * Resolve a stored file_path (relative or absolute) to an absolute path on
 * disk. Falls back through the same heuristics the NSFW scan loop uses.
 */
function _resolveAbs(storedPath) {
    if (!storedPath) return null;
    if (path.isAbsolute(storedPath) && existsSync(storedPath)) return storedPath;
    let s = String(storedPath).replace(/\\/g, '/');
    while (s.startsWith('data/downloads/')) s = s.slice('data/downloads/'.length);
    const candidate = path.join(DATA_DIR, 'downloads', s);
    if (existsSync(candidate)) return candidate;
    if (existsSync(storedPath)) return storedPath;
    return null;
}

function _coerceConfig(cfg) {
    const merged = {
        ...AI_DEFAULTS,
        ...(cfg || {}),
        embeddings: { ...AI_DEFAULTS.embeddings, ...(cfg?.embeddings || {}) },
        faces:      { ...AI_DEFAULTS.faces,      ...(cfg?.faces || {}) },
        tags:       { ...AI_DEFAULTS.tags,       ...(cfg?.tags || {}) },
        phash:      { ...AI_DEFAULTS.phash,      ...(cfg?.phash || {}) },
        cacheDir: cfg?.cacheDir || null,
    };
    return merged;
}

/**
 * Run one capability against a single image. Returns `{ ok, error }`.
 * Each call is wrapped in try/catch so a per-row failure doesn't kill
 * the surrounding scan loop.
 */
async function _runOneRow(absPath, downloadId, cfg, onLog) {
    const cap = cfg.capabilities || {};
    let touched = false;
    const result = { embedding: false, faces: 0, tags: 0, phash: false };

    if (cap.phash) {
        try {
            const h = await computePhash(absPath);
            if (h != null) {
                setPhash(downloadId, h);
                result.phash = true;
                touched = true;
            }
        } catch (e) {
            try { onLog?.({ source: 'ai', level: 'warn', msg: `phash failed for #${downloadId}: ${e?.message || e}` }); } catch {}
        }
    }

    if (cap.embeddings) {
        try {
            const vec = await embedImage(absPath, cfg.embeddings, undefined, onLog);
            if (vec) {
                setImageEmbedding(downloadId, vectorToBlob(vec), cfg.embeddings.model || '');
                result.embedding = true;
                touched = true;
                clearVectorCache();
            }
        } catch (e) {
            try { onLog?.({ source: 'ai', level: 'warn', msg: `embedding failed for #${downloadId}: ${e?.message || e}` }); } catch {}
        }
    }

    if (cap.tags) {
        try {
            const tags = await classifyImage(absPath, cfg.tags, undefined, onLog);
            if (tags && tags.length) {
                setImageTags(downloadId, tags);
                result.tags = tags.length;
                touched = true;
            }
        } catch (e) {
            try { onLog?.({ source: 'ai', level: 'warn', msg: `tags failed for #${downloadId}: ${e?.message || e}` }); } catch {}
        }
    }

    if (cap.faces) {
        try {
            const dets = await detectFaces(absPath, cfg.faces, undefined, onLog);
            if (dets.length) {
                deleteFacesForDownload(downloadId);
                for (const d of dets) {
                    const fvec = await embedFace(absPath, d, cfg.embeddings, onLog);
                    if (!fvec) continue;
                    insertFace({
                        downloadId,
                        x: d.x, y: d.y, w: d.w, h: d.h,
                        embeddingBlob: vectorToBlob(fvec),
                        personId: null,
                    });
                    result.faces += 1;
                }
                touched = true;
            }
        } catch (e) {
            try { onLog?.({ source: 'ai', level: 'warn', msg: `faces failed for #${downloadId}: ${e?.message || e}` }); } catch {}
        }
    }

    // Mark the row as visited even when nothing succeeded, so the scan loop
    // doesn't retry indefinitely on (e.g.) a corrupt JPEG.
    setAiIndexedAt(downloadId);
    return { ok: touched, ...result };
}

/**
 * Iterate every unindexed photo, run all enabled capabilities. Returns a
 * summary suitable for the JobTracker's `result` payload.
 */
export async function runIndexScan(cfg, { onProgress, signal, onLog } = {}) {
    const merged = _coerceConfig(cfg);
    if (!merged.enabled) {
        return { skipped: true, reason: 'AI subsystem is disabled' };
    }
    const capabilities = {
        embeddings: !!merged.embeddings?.enabled,
        faces:      !!merged.faces?.enabled,
        tags:       !!merged.tags?.enabled,
        phash:      !!merged.phash?.enabled,
    };
    if (!Object.values(capabilities).some(Boolean)) {
        return { skipped: true, reason: 'No AI capabilities enabled' };
    }

    const fileTypes = merged.fileTypes;
    const batchSize = Math.max(1, Math.min(200, Number(merged.batchSize) || 25));

    const summary = { processed: 0, embeddings: 0, faces: 0, tags: 0, phash: 0, errors: 0, total: 0 };

    // Pre-count for a determinate progress bar.
    try {
        const countRow = getDb().prepare(
            `SELECT COUNT(*) AS n FROM downloads WHERE file_type IN (${fileTypes.map(() => '?').join(',')}) AND ai_indexed_at IS NULL`
        ).get(...fileTypes);
        summary.total = countRow.n || 0;
    } catch { /* leave at 0 */ }

    onProgress?.({ stage: 'starting', processed: 0, total: summary.total, capabilities });

    while (!signal?.aborted) {
        const batch = getUnindexedAiBatch({ fileTypes, limit: batchSize });
        if (!batch.length) break;
        for (const row of batch) {
            if (signal?.aborted) break;
            const abs = _resolveAbs(row.file_path);
            if (!abs) {
                setAiIndexedAt(row.id);
                summary.processed += 1;
                continue;
            }
            try {
                const r = await _runOneRow(abs, row.id, { ...merged, capabilities }, onLog);
                summary.processed += 1;
                if (r.embedding) summary.embeddings += 1;
                if (r.faces)     summary.faces      += r.faces;
                if (r.tags)      summary.tags       += r.tags;
                if (r.phash)     summary.phash      += 1;
            } catch (e) {
                summary.errors += 1;
                try { onLog?.({ source: 'ai', level: 'error', msg: `index row #${row.id}: ${e?.message || e}` }); } catch {}
            }
            if (summary.processed % 5 === 0 || summary.processed === summary.total) {
                onProgress?.({
                    stage: 'indexing',
                    processed: summary.processed,
                    total: summary.total,
                    embeddings: summary.embeddings,
                    faces: summary.faces,
                    tags: summary.tags,
                    phash: summary.phash,
                    errors: summary.errors,
                });
            }
        }
    }
    onProgress?.({ stage: 'done', ...summary });
    return summary;
}

/**
 * Phash-only scan — fast path, no model download required. Walks every
 * photo where `phash IS NULL` and computes the hash. Useful as a one-shot
 * before enabling near-duplicate dedup.
 */
export async function runPhashScan({ onProgress, signal, onLog, fileTypes = ['photo'] } = {}) {
    const summary = { processed: 0, total: 0, phash: 0, errors: 0 };
    const types = fileTypes.length ? fileTypes : ['photo'];
    const ph = types.map(() => '?').join(',');
    try {
        const c = getDb().prepare(
            `SELECT COUNT(*) AS n FROM downloads WHERE phash IS NULL AND file_type IN (${ph})`
        ).get(...types);
        summary.total = c?.n || 0;
    } catch {}

    onProgress?.({ stage: 'starting', processed: 0, total: summary.total });

    const batchSize = 50;
    while (!signal?.aborted) {
        const batch = getDb().prepare(`
            SELECT id, file_path FROM downloads
             WHERE phash IS NULL
               AND file_type IN (${ph})
             ORDER BY created_at ASC
             LIMIT ?
        `).all(...types, batchSize);
        if (!batch.length) break;
        for (const row of batch) {
            if (signal?.aborted) break;
            const abs = _resolveAbs(row.file_path);
            if (!abs) continue;
            try {
                const h = await computePhash(abs);
                if (h != null) {
                    setPhash(row.id, h);
                    summary.phash += 1;
                }
            } catch (e) {
                summary.errors += 1;
                try { onLog?.({ source: 'ai', level: 'warn', msg: `phash row #${row.id}: ${e?.message || e}` }); } catch {}
            }
            summary.processed += 1;
            if (summary.processed % 25 === 0 || summary.processed === summary.total) {
                onProgress?.({ stage: 'phash', ...summary });
            }
        }
    }
    onProgress?.({ stage: 'done', ...summary });
    return summary;
}

/**
 * Re-cluster every face row into people. Wipes the existing people table
 * first — faces survive (their embeddings are preserved) and get re-assigned.
 */
export async function runFaceClustering(cfg, { onProgress, signal, onLog: _onLog = null } = {}) {
    const merged = _coerceConfig(cfg);
    onProgress?.({ stage: 'loading_faces' });
    const faces = listAllFaces();
    if (!faces.length) {
        onProgress?.({ stage: 'done', faces: 0, people: 0 });
        return { faces: 0, people: 0 };
    }
    const items = faces.map((f) => {
        const vec = blobToVector(f.embedding);
        if (vec) l2Normalize(vec);
        return { id: f.id, vec };
    }).filter((x) => x.vec);

    if (signal?.aborted) return { aborted: true };
    onProgress?.({ stage: 'clustering', faces: items.length });

    const clusters = dbscan(items, {
        epsilon: merged.faces?.epsilon ?? AI_DEFAULTS.faces.epsilon,
        minPoints: merged.faces?.minPoints ?? AI_DEFAULTS.faces.minPoints,
    });

    if (signal?.aborted) return { aborted: true };
    clearAllPeople();
    onProgress?.({ stage: 'persisting', clusters: clusters.length });

    for (const c of clusters) {
        const personId = insertPerson({
            label: null,
            centroidBlob: centroidToBlob(c.centroid),
            faceCount: c.size,
        });
        for (const faceId of c.members) {
            try { setFacePerson(faceId, personId); } catch {}
        }
    }

    const result = { faces: items.length, people: clusters.length };
    onProgress?.({ stage: 'done', ...result });
    return result;
}

/**
 * Compute groups of near-duplicate photos using stored phashes.
 *
 * Returns `{ groups: [{ ids, size, rows }], total }`. Largest groups first.
 */
export function findPhashGroups({ threshold = 6, fileTypes = ['photo'] } = {}) {
    const rows = listAllPhashes({ fileTypes });
    const items = rows.map((r) => ({ id: r.id, phash: r.phash }));
    const clusters = groupNearDuplicates(items, threshold);
    const idToRow = new Map(rows.map((r) => [r.id, r]));
    return {
        groups: clusters.map((c) => ({
            ids: c.ids,
            size: c.size,
            rows: c.ids.map((id) => idToRow.get(id)).filter(Boolean),
        })),
        total: clusters.length,
    };
}

/**
 * Search by free-text query — returns top-K rows ranked by CLIP cosine
 * similarity. Returns `{ results: [...], total }` where each result has
 * `{ download_id, score, ...row }`.
 */
export async function searchByText(query, cfg, { limit = 20, fileTypes = null, onLog = null } = {}) {
    const merged = _coerceConfig(cfg);
    const vec = await embedText(query, merged.embeddings, undefined, onLog);
    if (!vec) return { results: [], total: 0 };
    const top = vectorTopK(vec, { limit, fileTypes });
    return {
        results: top.map((r) => ({
            download_id: r.download_id,
            score: r.score,
            file_name: r.row.file_name,
            file_path: r.row.file_path,
            file_type: r.row.file_type,
            file_size: r.row.file_size,
            group_id:  r.row.group_id,
            group_name: r.row.group_name,
            created_at: r.row.created_at,
        })),
        total: top.length,
    };
}

// ---- Background single-row indexer (downloader hook) ----------------------

const _bgQueue = [];
let _bgRunning = false;

/**
 * Fired by the downloader when a new file lands. Best-effort fire-and-forget;
 * no-ops when the AI subsystem is disabled.
 */
export function pregenerateAi(downloadId) {
    queueMicrotask(() => {
        if (_bgQueue.length > 200) return;
        _bgQueue.push(downloadId);
        _drainBg();
    });
}

async function _drainBg() {
    if (_bgRunning) return;
    _bgRunning = true;
    try {
        const { loadConfig } = await import('../../config/manager.js');
        let cfg;
        try {
            const live = loadConfig();
            cfg = _coerceConfig(live.advanced?.ai || {});
        } catch { cfg = _coerceConfig({}); }
        if (!cfg.enabled) { _bgQueue.length = 0; return; }
        const capabilities = {
            embeddings: !!cfg.embeddings?.enabled,
            faces:      !!cfg.faces?.enabled,
            tags:       !!cfg.tags?.enabled,
            phash:      !!cfg.phash?.enabled,
        };
        if (!Object.values(capabilities).some(Boolean)) { _bgQueue.length = 0; return; }
        const db = getDb();
        const lookup = db.prepare('SELECT id, file_path, file_type, ai_indexed_at FROM downloads WHERE id = ?');
        while (_bgQueue.length) {
            const id = _bgQueue.shift();
            const row = lookup.get(Number(id));
            if (!row) continue;
            if (row.ai_indexed_at != null) continue;
            const eligible = (cfg.fileTypes || ['photo']).includes(String(row.file_type || '').toLowerCase());
            if (!eligible) continue;
            const abs = _resolveAbs(row.file_path);
            if (!abs) {
                setAiIndexedAt(row.id);
                continue;
            }
            try {
                await _runOneRow(abs, row.id, { ...cfg, capabilities });
            } catch { /* per-file failure is silent — the next batch scan will retry */ }
        }
    } finally {
        _bgRunning = false;
    }
}
