/**
 * Faces scan runner. Search + Auto-tag flows were removed; this module
 * now owns only the face detection + DBSCAN clustering pipeline.
 *
 *   - `startFacesScan(cfg, …)` has two phases:
 *     (a) per-row face detection + persistence into the `faces` table,
 *     (b) one DBSCAN pass over every face embedding to populate `people`
 *         and link `faces.person_id`. Phase (b) is cheap compared to (a);
 *         we run it inside the same job so the UI sees one done event.
 *
 * Fire-and-forget: caller polls `getScanState('faces')` or subscribes to
 * the WS events the route layer broadcasts. Single-flight — a second
 * `startFacesScan` while one is running returns `{ alreadyRunning: true }`.
 */

import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
    clearAllPeople,
    clearImageTagsForDownload,
    deleteFacesForDownload,
    getDb,
    getUnindexedAiBatch,
    insertFace,
    insertPerson,
    iterateAllFaces,
    setAiIndexedAt,
    setFacePerson,
    setImageTags,
} from '../db.js';
import { clusterFaces, detectFaces } from './faces.js';
import { resolveFacesValue } from './faces-config.js';
import { getSidecarUrl } from './faces-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// Float32Array <-> Buffer helpers. Previously came from vector-store.js
// (deleted with Search/Tags); inlined because clustering is now the only
// remaining caller.
function _f32ToBlob(f) {
    return Buffer.from(new Uint8Array(f.buffer, f.byteOffset, f.byteLength));
}

// Pick the first finite number from a list of candidates; fall back to
// `fallback` if none match. Used to resolve cluster knobs with the
// "new path > legacy alias > env override > default" precedence.
function _pickNumber(candidates, fallback) {
    for (const c of candidates) {
        if (Number.isFinite(c)) return c;
    }
    return fallback;
}
function _blobToF32(blob) {
    const dim = blob.byteLength / 4;
    const out = new Float32Array(dim);
    const view = new Float32Array(blob.buffer, blob.byteOffset, dim);
    out.set(view);
    return out;
}

// Per-feature state.
const _scans = {
    faces: _emptyState(),
    tags: _emptyState(),
};

function _emptyState() {
    return {
        running: false,
        scanned: 0,
        total: 0,
        startedAt: null,
        finishedAt: null,
        error: null,
        abort: null,
    };
}

export function getScanState(feature) {
    const s = _scans[feature];
    if (!s) return null;
    const { abort: _abort, ...rest } = s;
    return rest;
}

export function isScanRunning(feature) {
    return Boolean(_scans[feature]?.running);
}

export function cancelScan(feature) {
    const s = _scans[feature];
    if (!s?.abort) return false;
    try {
        s.abort.abort();
    } catch {}
    return true;
}

/**
 * Resolve a stored relative download path to an absolute one. Mirrors the
 * NSFW resolver — DB stores `Group/images/foo.jpg`, files live under
 * `data/downloads/...`.
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

// Generic envelope: claim slot → run worker → release. Worker owns its own
// progress reporting via the `bump` callback.
async function _runScan(feature, cfg, worker, onProgress, onDone, onLog) {
    const log = (level, msg) => {
        try {
            if (typeof onLog === 'function') onLog({ source: `ai-scan-${feature}`, level, msg });
        } catch {}
    };
    if (_scans[feature]?.running) {
        log('warn', `start${feature} called while already running — ignoring`);
        return { alreadyRunning: true };
    }
    const ctrl = new AbortController();
    const state = (_scans[feature] = {
        ..._emptyState(),
        running: true,
        startedAt: Date.now(),
        abort: ctrl,
    });

    let lastBroadcast = 0;
    const bcast = (force = false) => {
        const now = Date.now();
        if (!force && now - lastBroadcast < 500) return;
        lastBroadcast = now;
        try {
            if (typeof onProgress === 'function') onProgress(getScanState(feature));
        } catch {}
    };
    const bump = ({ scanned, total } = {}) => {
        if (Number.isFinite(scanned)) state.scanned = scanned;
        if (Number.isFinite(total)) state.total = total;
        bcast();
    };

    (async () => {
        try {
            await worker(state, ctrl.signal, bump, log, cfg);
        } catch (e) {
            state.error = e?.message || String(e);
            log('error', `${feature} scan crashed: ${state.error}`);
        } finally {
            state.running = false;
            state.finishedAt = Date.now();
            state.abort = null;
            bcast(true);
            try {
                if (typeof onDone === 'function') onDone(getScanState(feature));
            } catch {}
        }
    })().catch(() => {
        /* never throw out of the IIFE */
    });

    return { started: true };
}

// ---- Faces scan + clustering pass ---------------------------------------

export function startFacesScan(cfg, onProgress, onDone, onLog) {
    return _runScan(
        'faces',
        cfg,
        async (state, signal, bump, log, cfg) => {
            // Resolve `fileTypes` with the same precedence as the cluster
            // knobs: new path > legacy flat alias > env override > default.
            const facesCfgIn = cfg?.faces || {};
            const envFileTypes = resolveFacesValue('fileTypes', facesCfgIn);
            const fileTypes = Array.isArray(facesCfgIn.fileTypes)
                ? facesCfgIn.fileTypes
                : Array.isArray(cfg.fileTypes)
                  ? cfg.fileTypes
                  : Array.isArray(envFileTypes)
                    ? envFileTypes
                    : ['photo'];
            const db = getDb();

            // Phase A — detect faces on every photo we haven't visited yet.
            // Visited = "ai_indexed_at IS NOT NULL"; even photos that yield
            // zero faces get stamped so the next pass doesn't re-decode.
            const phaseATotal = db
                .prepare(`
                    SELECT COUNT(*) AS n FROM downloads
                     WHERE file_type IN (${fileTypes.map(() => '?').join(',')})
                       AND ai_indexed_at IS NULL
                `)
                .get(...fileTypes).n;
            state.total = phaseATotal;
            bump();
            log('info', `faces scan: ${phaseATotal} photos to scan in phase A`);

            // `batchSize` precedence (same model as fileTypes above).
            const envBatch = resolveFacesValue('batchSize', facesCfgIn);
            const batchSizeRaw = _pickNumber([facesCfgIn.batchSize, cfg.batchSize, envBatch], 16);
            const batchSize = Math.max(1, Math.min(200, Number(batchSizeRaw) || 16));
            while (!signal.aborted) {
                const batch = getUnindexedAiBatch({ fileTypes, limit: batchSize });
                if (!batch.length) break;
                for (const row of batch) {
                    if (signal.aborted) break;
                    const abs = _resolveAbs(row.file_path);
                    let detected = null;
                    if (abs) {
                        try {
                            detected = await detectFaces(abs, cfg, log);
                        } catch (e) {
                            log('warn', `detectFaces threw on id=${row.id}: ${e?.message || e}`);
                        }
                    }
                    if (Array.isArray(detected) && detected.length) {
                        deleteFacesForDownload(row.id);
                        for (const f of detected) {
                            insertFace({
                                downloadId: row.id,
                                x: f.x,
                                y: f.y,
                                w: f.w,
                                h: f.h,
                                embeddingBlob: _f32ToBlob(f.embedding),
                            });
                        }
                    }
                    setAiIndexedAt(row.id);
                    state.scanned += 1;
                    bump();
                    await new Promise((r) => setImmediate(r));
                }
            }

            // Phase B — DBSCAN over every face embedding. Always re-runs
            // (clusters drift as new faces land).
            if (signal.aborted) return;
            log('info', 'faces scan: starting clustering pass');
            const faces = [];
            for (const r of iterateAllFaces()) {
                faces.push({ id: r.id, embedding: _blobToF32(r.embedding) });
            }
            if (!faces.length) {
                log('info', 'faces scan: no faces detected — clustering skipped');
                return;
            }
            if (faces.length > 50000) {
                log(
                    'warn',
                    `faces scan: ${faces.length} faces is a large input for DBSCAN — clustering may take a while`,
                );
            }
            const facesCfgForCluster = cfg?.faces || {};
            const epsForCluster = _pickNumber(
                [
                    resolveFacesValue('epsilon', facesCfgForCluster),
                    facesCfgForCluster.epsilon,
                    cfg.facesEpsilon,
                ],
                0.5,
            );
            const minPointsForCluster = _pickNumber(
                [
                    resolveFacesValue('minPoints', facesCfgForCluster),
                    facesCfgForCluster.minPoints,
                    cfg.facesMinPoints,
                ],
                3,
            );
            log(
                'info',
                `faces scan: clustering ${faces.length} faces (eps=${epsForCluster}, minPts=${minPointsForCluster})`,
            );
            const { clusters } = clusterFaces(faces, {
                eps: epsForCluster,
                minPts: minPointsForCluster,
            });
            await new Promise((r) => setImmediate(r));

            // Snapshot every labelled centroid BEFORE wiping people. The
            // match runs against the snapshot (in-memory) because by the
            // time we hit the DB, clearAllPeople has already nuked
            // everything. Renames now survive re-runs as long as the new
            // cluster's centroid is within `matchEps` of the old labelled
            // cluster's centroid.
            //
            // Precedence for the match radius:
            //   1. `cfg.faces.labelMatchEps`            (new nested path)
            //   2. `cfg.facesLabelMatchEps`             (legacy flat key)
            //   3. `TGDL_FACES_LABEL_MATCH_EPS` env     (deployment override)
            //   4. derived from `epsilon * 0.9`         (the default)
            const facesCfg = cfg?.faces || {};
            const epsilonResolved = _pickNumber(
                [resolveFacesValue('epsilon', facesCfg), facesCfg.epsilon, cfg.facesEpsilon],
                0.5,
            );
            const matchEpsEnv = resolveFacesValue('labelMatchEps', facesCfg);
            const matchEps = _pickNumber(
                [facesCfg.labelMatchEps, cfg.facesLabelMatchEps, matchEpsEnv],
                Math.max(0.2, Math.min(0.6, epsilonResolved * 0.9)),
            );
            const labelSnapshot = (() => {
                const out = [];
                const stmt = db.prepare(
                    'SELECT label, embedding_centroid FROM people WHERE label IS NOT NULL',
                );
                for (const r of stmt.iterate()) {
                    if (!r.embedding_centroid) continue;
                    const dim = r.embedding_centroid.byteLength / 4;
                    const c = new Float32Array(dim);
                    const view = new Float32Array(
                        r.embedding_centroid.buffer,
                        r.embedding_centroid.byteOffset,
                        dim,
                    );
                    c.set(view);
                    out.push({ label: r.label, centroid: c });
                }
                return out;
            })();
            const findCarryOverLabel = (centroid) => {
                let best = null;
                let bestDist = Infinity;
                for (const s of labelSnapshot) {
                    if (s.centroid.length !== centroid.length) continue;
                    let sum = 0;
                    for (let i = 0; i < centroid.length; i++) {
                        const d = centroid[i] - s.centroid[i];
                        sum += d * d;
                    }
                    const dist = Math.sqrt(sum);
                    if (dist < bestDist && dist <= matchEps) {
                        bestDist = dist;
                        best = s.label;
                    }
                }
                return best;
            };

            clearAllPeople();
            let i = 0;
            let preservedCount = 0;
            for (const c of clusters) {
                const carryOver = findCarryOverLabel(c.centroid);
                const personId = insertPerson({
                    label: carryOver,
                    centroidBlob: _f32ToBlob(c.centroid),
                    faceCount: c.faceCount,
                });
                if (carryOver) preservedCount += 1;
                for (const memberIdx of c.memberIdxs) {
                    const faceId = faces[memberIdx].id;
                    setFacePerson(faceId, personId);
                }
                i += 1;
                if (i % 100 === 0) await new Promise((r) => setImmediate(r));
            }
            log(
                'info',
                `faces scan: clustered ${faces.length} faces into ${clusters.length} groups (${preservedCount}/${labelSnapshot.length} labels preserved across re-cluster, eps=${matchEps.toFixed(3)})`,
            );
        },
        onProgress,
        onDone,
        onLog,
    );
}

// ---- Tags scan (CLIP-based zero-shot tagging) ---------------------------

/**
 * Start a background scan that tags every unindexed photo via the Python
 * sidecar's ``/tag`` endpoint. Single-flight — a second call while one is
 * running returns ``{ alreadyRunning: true }``.
 *
 * Tags are persisted into the ``image_tags`` table via ``setImageTags()``
 * and ``ai_indexed_at`` is stamped so the row isn't re-processed.
 */
export function startTagsScan(cfg, onProgress, onDone, onLog) {
    return _runScan(
        'tags',
        cfg,
        async (state, signal, bump, log, cfg) => {
            const db = getDb();
            const fileTypes = Array.isArray(cfg.fileTypes) ? cfg.fileTypes : ['photo'];

            const total = db
                .prepare(
                    `SELECT COUNT(*) AS n FROM downloads
                     WHERE file_type IN (${fileTypes.map(() => '?').join(',')})
                       AND ai_indexed_at IS NULL`,
                )
                .get(...fileTypes).n;
            state.total = total;
            bump();
            log('info', `tags scan: ${total} files to tag`);

            if (total === 0) {
                log('info', 'tags scan: nothing to tag');
                return;
            }

            const sidecarUrl = getSidecarUrl();
            if (!sidecarUrl) {
                throw new Error(
                    'Python sidecar is not available — cannot tag images. ' +
                        'Check the AI maintenance page for sidecar status.',
                );
            }

            // Resolve custom tag labels from config. Falls back to the
            // sidecar's default vocabulary when empty.
            const tagLabels = Array.isArray(cfg.tagLabels) ? cfg.tagLabels.filter(Boolean) : [];

            const batchSize = Math.max(1, Math.min(50, Number(cfg.batchSize) || 16));

            while (!signal.aborted) {
                const batch = getUnindexedAiBatch({ fileTypes, limit: batchSize });
                if (!batch.length) break;

                for (const row of batch) {
                    if (signal.aborted) break;
                    const abs = _resolveAbs(row.file_path);
                    let tags = [];
                    if (abs) {
                        try {
                            tags = await _tagOne(sidecarUrl, abs, tagLabels, log);
                        } catch (e) {
                            log('warn', `tagging failed for id=${row.id}: ${e?.message || e}`);
                        }
                    }
                    // Write tags to DB
                    if (Array.isArray(tags) && tags.length) {
                        clearImageTagsForDownload(row.id);
                        setImageTags(
                            row.id,
                            tags.map((t) => ({ tag: t.tag, score: t.score })),
                        );
                    }
                    setAiIndexedAt(row.id);
                    state.scanned += 1;
                    bump();
                    await new Promise((r) => setImmediate(r));
                }
            }
            log('info', `tags scan: finished — ${state.scanned} files tagged`);
        },
        onProgress,
        onDone,
        onLog,
    );
}

/**
 * Call the Python sidecar's ``POST /tag`` for one image.
 * Returns ``[{tag, score}, …]`` or an empty array on failure.
 *
 * If ``tagLabels`` is non-empty, it overrides the sidecar's default
 * vocabulary for this request.
 */
async function _tagOne(sidecarUrl, absPath, tagLabels, log) {
    const url = `${sidecarUrl.replace(/\/+$/, '')}/tag`;
    const body = { path: absPath };
    if (Array.isArray(tagLabels) && tagLabels.length) {
        body.vocabulary = tagLabels;
    }
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30000), // 30 s per file
        });
        if (!res.ok) {
            log('warn', `tag endpoint returned ${res.status} for ${absPath}`);
            return [];
        }
        const data = await res.json();
        return Array.isArray(data?.tags) ? data.tags : [];
    } catch (e) {
        log('warn', `tag request failed for ${absPath}: ${e?.message || e}`);
        return [];
    }
}

/** For tests — clear in-memory state so the next test starts fresh. */
export function _resetForTests() {
    _scans.faces = _emptyState();
    _scans.tags = _emptyState();
}
