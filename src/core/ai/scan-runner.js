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

import {
    clearAllPeople,
    deleteFacesForDownload,
    getDb,
    getUnindexedAiBatch,
    insertFace,
    insertPerson,
    iterateAllFaces,
    setAiIndexedAt,
    setFacePerson,
} from '../db.js';
import { clusterFaces, FACE_DEFAULTS } from './faces.js';
import { detectFacesBatch, detectFacesInVideo } from './faces-client.js';
import { resolveFacesValue } from './faces-config.js';
import { getDataDir } from '../paths.js';

const DATA_DIR = getDataDir();

// Float32Array <-> Buffer helpers. Previously came from vector-store.js
// (deleted with Search/Tags); inlined because clustering is now the only
// remaining caller.
function _f32ToBlob(f) {
    return Buffer.from(new Uint8Array(f.buffer, f.byteOffset, f.byteLength));
}

// Duty-cycle throttle: sleep for `ratio * elapsedMs` after a detection call
// so the CPU gets proportional rest between work bursts. Dynamic by design —
// slow hardware (long elapsed) gets longer rests; fast GPU barely notices it.
// Capped at 5 000 ms so a single stalled video doesn't freeze the loop.
async function _throttleSleep(elapsedMs, ratio) {
    if (!ratio || ratio <= 0) return;
    const sleepMs = Math.min(Math.round(elapsedMs * ratio), 5000);
    if (sleepMs >= 10) await new Promise((r) => setTimeout(r, sleepMs));
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

// Per-feature state. Only `faces` survives; the slot map is kept for
// shape compatibility with callers that read `getScanState(feature)`.
const _scans = {
    faces: _emptyState(),
};

function _emptyState() {
    return {
        running: false,
        scanned: 0,
        total: 0,
        startedAt: null,
        finishedAt: null,
        error: null,
        phase: 'A',       // 'A' = detection, 'B' = clustering
        faceCount: 0,     // total face embeddings found in phase A
        peopleCount: 0,   // clusters produced by phase B
        noiseFaces: 0,    // faces not assigned to any cluster
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
    const log = (levelOrEntry, msg) => {
        try {
            if (typeof onLog !== 'function') return;
            if (levelOrEntry !== null && typeof levelOrEntry === 'object') {
                // faces.js / faces-client.js call onLog({source, level, msg}) directly.
                // Pass the object through so the server's log() can destructure it.
                onLog(levelOrEntry);
            } else {
                onLog({ source: `ai-scan-${feature}`, level: levelOrEntry, msg });
            }
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
            await worker(state, ctrl.signal, bump, log, cfg, bcast);
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
        async (state, signal, bump, log, cfg, bcast) => {
            // Resolve `fileTypes` with the same precedence as the cluster
            // knobs: new path > legacy flat alias > env override > default.
            const facesCfgIn = cfg?.faces || {};
            const envFileTypes = resolveFacesValue('fileTypes', facesCfgIn);
            const fileTypes = Array.isArray(facesCfgIn.fileTypes)
                ? facesCfgIn.fileTypes
                : Array.isArray(cfg?.fileTypes)
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
            const scanVideos = facesCfgIn.scanVideos === true;
            const videoTotal = scanVideos
                ? db.prepare(`SELECT COUNT(*) AS n FROM downloads WHERE file_type = 'video' AND ai_indexed_at IS NULL`).get().n
                : 0;
            state.total = phaseATotal + videoTotal;
            bump();
            log('info', `faces scan: ${phaseATotal} photos${videoTotal ? ` + ${videoTotal} videos` : ''} to scan in phase A`);

            // `batchSize` precedence (same model as fileTypes above).
            const envBatch = resolveFacesValue('batchSize', facesCfgIn);
            const batchSizeRaw = _pickNumber([facesCfgIn.batchSize, cfg?.batchSize, envBatch], 16);
            const batchSize = Math.max(1, Math.min(200, Number(batchSizeRaw) || 16));

            // Duty-cycle CPU throttle ratio (0 = off, default 0.5 = rest for
            // half the time spent on detection). Configurable so GPU users
            // can set it to 0 and run at full speed.
            const envThrottle = resolveFacesValue('cpuThrottleRatio', facesCfgIn);
            const throttleRatioRaw = _pickNumber(
                [facesCfgIn.cpuThrottleRatio, cfg?.cpuThrottleRatio, envThrottle],
                0.5,
            );
            const throttleRatio = Math.max(0, Math.min(5, Number(throttleRatioRaw) || 0.5));

            // Extensions to skip without sending to the sidecar — stamped as
            // indexed immediately so they don't appear in future scans.
            // Useful for animated WebP stickers that reliably decode_failed.
            const envExclude = resolveFacesValue('excludeExtensions', facesCfgIn);
            const excludeExtsRaw = Array.isArray(facesCfgIn.excludeExtensions)
                ? facesCfgIn.excludeExtensions
                : Array.isArray(envExclude)
                  ? envExclude
                  : [];
            const excludeExts = new Set(
                excludeExtsRaw.map((e) => String(e).toLowerCase().replace(/^\.?/, '.')),
            );

            let _statNull = 0; // detectFaces returned null (sidecar error / file missing)
            let _statSkip = 0; // skipped by excludeExtensions
            let _statEmpty = 0; // detectFaces returned [] (processed but no faces detected)
            let _statFaces = 0; // total face embeddings stored
            let _statPhotos = 0; // photos with ≥1 face
            let _nextStatLog = 200; // log a summary every N photos
            while (!signal.aborted) {
                const batch = getUnindexedAiBatch({ fileTypes, limit: batchSize });
                if (!batch.length) break;
                // One HTTP round-trip for the whole batch — the sidecar's
                // /detect/batch endpoint processes files sequentially in its
                // threadpool and returns all results together. This replaces
                // the old Promise.all approach that sent N concurrent requests
                // to a CPU-only sidecar, causing queue build-up and timeouts.
                const items = batch.map((row) => ({ row, abs: _resolveAbs(row.file_path) }));
                const nullItems = items.filter((i) => !i.abs);
                const skipItems = excludeExts.size
                    ? items.filter(
                          (i) =>
                              i.abs &&
                              excludeExts.has(path.extname(i.abs).toLowerCase()),
                      )
                    : [];
                const skipSet = new Set(skipItems.map((i) => i.row.id));
                const validItems = items.filter((i) => i.abs && !skipSet.has(i.row.id));

                for (const { row } of skipItems) {
                    _statSkip++;
                    setAiIndexedAt(row.id);
                    state.scanned += 1;
                    bump();
                }

                for (const { row } of nullItems) {
                    _statNull++;
                    setAiIndexedAt(row.id);
                    state.scanned += 1;
                    bump();
                }

                if (signal.aborted) continue;

                let batchResults = [];
                if (validItems.length) {
                    const _t0 = Date.now();
                    try {
                        batchResults = await detectFacesBatch(
                            validItems.map((i) => i.abs),
                            cfg,
                            log,
                        );
                    } catch (e) {
                        log('warn', `detectFacesBatch threw: ${e?.message || e}`);
                        batchResults = validItems.map(() => null);
                    }
                    await _throttleSleep(Date.now() - _t0, throttleRatio);
                }

                for (let bi = 0; bi < validItems.length; bi++) {
                    const { row } = validItems[bi];
                    const detected = batchResults[bi] ?? null;
                    if (detected === null) {
                        _statNull++;
                    } else if (detected.length === 0) {
                        _statEmpty++;
                    } else {
                        _statFaces += detected.length;
                        _statPhotos++;
                    }
                    if (Array.isArray(detected) && detected.length) {
                        deleteFacesForDownload(row.id);
                        for (const f of detected) {
                            if (!f.embedding || !f.embedding.length) continue;
                            insertFace({
                                downloadId: row.id,
                                x: f.x,
                                y: f.y,
                                w: f.w,
                                h: f.h,
                                embeddingBlob: _f32ToBlob(f.embedding),
                                qualityScore: Number.isFinite(f.qualityScore) ? f.qualityScore : (Number.isFinite(f.score) ? f.score : null),
                            });
                        }
                    }
                    setAiIndexedAt(row.id);
                    state.scanned += 1;
                    bump();
                }
                if (state.scanned >= _nextStatLog) {
                    log(
                        'info',
                        `faces scan progress: ${state.scanned}/${phaseATotal} — ` +
                            `${_statPhotos} with faces (${_statFaces} total), ` +
                            `${_statEmpty} no-face, ${_statNull} errors` +
                            (_statSkip ? `, ${_statSkip} ext-skipped` : ''),
                    );
                    _nextStatLog = state.scanned + 200;
                }
                await new Promise((r) => setImmediate(r));
            }
            log(
                'info',
                `faces scan: phase A (photos) done — ${_statPhotos} photos had faces ` +
                    `(${_statFaces} total embeddings), ` +
                    `${_statEmpty} no-face, ${_statNull} sidecar errors` +
                    (_statSkip ? `, ${_statSkip} ext-skipped` : ''),
            );

            // Phase A (videos) — same faces table, same DBSCAN pass in Phase B.
            // One video at a time: each can produce many frames so we don't want
            // to hold a large batch in memory. Faces stored here cluster with
            // photo-source faces automatically because the embedding space is
            // identical regardless of whether the frame came from a photo or video.
            // Gated by cfg.faces.scanVideos — off by default, opt-in via UI toggle.
            if (!signal.aborted && scanVideos) {
                if (videoTotal > 0) {
                    log('info', `faces scan: starting video phase — ${videoTotal} videos`);
                    let _vNull = 0, _vEmpty = 0, _vFaces = 0, _vVids = 0;
                    while (!signal.aborted) {
                        const [row] = getUnindexedAiBatch({ fileTypes: ['video'], limit: 1 });
                        if (!row) break;
                        const abs = _resolveAbs(row.file_path);
                        if (!abs) {
                            _vNull++;
                            setAiIndexedAt(row.id);
                            state.scanned += 1;
                            bump();
                            continue;
                        }
                        let detected = null;
                        const _tv0 = Date.now();
                        try {
                            detected = await detectFacesInVideo(abs, cfg, log);
                        } catch (e) {
                            log('warn', `detectFacesInVideo threw for ${abs}: ${e?.message || e}`);
                        }
                        await _throttleSleep(Date.now() - _tv0, throttleRatio);
                        if (detected === null) {
                            _vNull++;
                        } else if (detected.length === 0) {
                            _vEmpty++;
                        } else {
                            _vFaces += detected.length;
                            _vVids++;
                        }
                        if (Array.isArray(detected) && detected.length) {
                            deleteFacesForDownload(row.id);
                            for (const f of detected) {
                                if (!f.embedding || !f.embedding.length) continue;
                                insertFace({
                                    downloadId: row.id,
                                    x: f.x,
                                    y: f.y,
                                    w: f.w,
                                    h: f.h,
                                    embeddingBlob: _f32ToBlob(f.embedding),
                                    qualityScore: Number.isFinite(f.qualityScore) ? f.qualityScore : (Number.isFinite(f.score) ? f.score : null),
                                });
                            }
                        }
                        setAiIndexedAt(row.id);
                        state.scanned += 1;
                        bump();
                        await new Promise((r) => setImmediate(r));
                    }
                    log(
                        'info',
                        `faces scan: phase A (videos) done — ${_vVids} videos had faces ` +
                            `(${_vFaces} total embeddings), ${_vEmpty} no-face, ${_vNull} errors`,
                    );
                }
            }

            // Phase B — DBSCAN over every face embedding. Always re-runs
            // (clusters drift as new faces land).
            if (signal.aborted) return;
            log('info', 'faces scan: starting clustering pass');
            const faces = [];
            // Collect faces first so we know faceCount before clustering.
            for (const r of iterateAllFaces()) {
                faces.push({
                    id: r.id,
                    embedding: _blobToF32(r.embedding),
                    qualityScore: Number.isFinite(r.quality_score) ? r.quality_score : null,
                });
            }
            if (!faces.length) {
                log('info', 'faces scan: no faces detected — clustering skipped');
                return;
            }
            // Signal phase transition so the frontend can swap to Phase B UI.
            state.phase = 'B';
            state.faceCount = faces.length;
            bcast(true);
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
                FACE_DEFAULTS.facesEpsilon,
            );
            const minPointsForCluster = _pickNumber(
                [
                    resolveFacesValue('minPoints', facesCfgForCluster),
                    facesCfgForCluster.minPoints,
                    cfg.facesMinPoints,
                ],
                FACE_DEFAULTS.facesMinPoints,
            );
            log(
                'info',
                `faces scan: clustering ${faces.length} faces (eps=${epsForCluster}, minPts=${minPointsForCluster})`,
            );
            const { clusters, noise } = clusterFaces(faces, {
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
                FACE_DEFAULTS.facesEpsilon,
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
            state.peopleCount = clusters.length;
            state.noiseFaces = noise.length;
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

/** For tests — clear in-memory state so the next test starts fresh. */
export function _resetForTests() {
    _scans.faces = _emptyState();
}
