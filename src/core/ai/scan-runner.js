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
import fs from 'fs/promises';
import { spawn } from 'child_process';
import crypto from 'crypto';
import os from 'os';
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
import { addImageObjects } from '../db/faces.js';
import { clusterFaces, computeFaceQualityScore, detectFaces } from './faces.js';
import { resolveFacesValue } from './faces-config.js';
import { getSidecarUrl } from './faces-client.js';
import { hasFfmpeg, resolveFfmpegBin } from '../thumbs.js';

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

function _resolveFfprobeBin() {
    try {
        const ffmpeg = resolveFfmpegBin();
        if (ffmpeg) {
            const probe = ffmpeg.endsWith('ffmpeg.exe')
                ? ffmpeg.slice(0, -10) + 'ffprobe.exe'
                : ffmpeg.endsWith('ffmpeg')
                  ? ffmpeg.slice(0, -6) + 'ffprobe'
                  : '';
            if (probe && existsSync(probe)) return probe;
        }
    } catch {
        /* fall through */
    }
    return process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
}

function _runProc(bin, args) {
    return new Promise((resolve, reject) => {
        const p = spawn(bin, args, { windowsHide: true });
        const out = [];
        const err = [];
        p.stdout.on('data', (c) => out.push(c));
        p.stderr.on('data', (c) => err.push(c));
        p.on('error', reject);
        p.on('close', (code) => {
            if (code === 0) {
                resolve({
                    stdout: Buffer.concat(out).toString('utf8'),
                    stderr: Buffer.concat(err).toString('utf8'),
                });
                return;
            }
            reject(
                new Error(
                    `${bin} exited ${code}: ${Buffer.concat(err).toString('utf8').trim() || 'no stderr'}`,
                ),
            );
        });
    });
}

async function _probeVideoDurationSec(absPath) {
    try {
        const probe = _resolveFfprobeBin();
        const { stdout } = await _runProc(probe, [
            '-v',
            'error',
            '-show_entries',
            'format=duration',
            '-of',
            'csv=p=0',
            absPath,
        ]);
        const v = Number.parseFloat(String(stdout || '').trim());
        return Number.isFinite(v) && v > 0 ? v : null;
    } catch {
        return null;
    }
}

async function _extractVideoFrames(absPath, { intervalSec = 8, maxFrames = 24 } = {}) {
    const duration = await _probeVideoDurationSec(absPath);
    if (!duration) return [];
    const interval = Math.max(1, Number(intervalSec) || 8);
    const cap = Math.max(1, Math.min(200, Number(maxFrames) || 24));
    const frameCount = Math.max(1, Math.min(cap, Math.ceil(duration / interval)));
    const realInterval = duration / frameCount;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tgdl-ai-frames-'));
    const outPattern = path.join(root, 'f-%05d.jpg');
    const ffmpeg = resolveFfmpegBin() || (process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    try {
        await _runProc(ffmpeg, [
            '-hide_banner',
            '-loglevel',
            'error',
            '-i',
            absPath,
            '-vf',
            `fps=1/${realInterval},scale=960:-2:flags=fast_bilinear`,
            '-frames:v',
            String(frameCount),
            '-q:v',
            '3',
            '-y',
            outPattern,
        ]);
        const names = (await fs.readdir(root)).filter((n) => n.endsWith('.jpg')).sort();
        const frames = names.map((n) => path.join(root, n));
        return frames;
    } finally {
        // caller deletes extracted frame files after detection;
        // this finally just guarantees directory exists for cleanup path.
    }
}

async function _cleanupTmpFrames(paths) {
    const dirs = new Set();
    for (const p of paths || []) {
        try {
            await fs.unlink(p);
        } catch {
            /* best effort */
        }
        try {
            dirs.add(path.dirname(p));
        } catch {}
    }
    for (const d of dirs) {
        try {
            await fs.rmdir(d);
        } catch {
            /* best effort */
        }
    }
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
            const includeVideos =
                resolveFacesValue('includeVideos', facesCfgIn) === true ||
                facesCfgIn.includeVideos === true ||
                cfg.includeVideos === true;
            const envFileTypes = resolveFacesValue('fileTypes', facesCfgIn);
            const fileTypesBase = Array.isArray(facesCfgIn.fileTypes)
                ? facesCfgIn.fileTypes
                : Array.isArray(cfg.fileTypes)
                  ? cfg.fileTypes
                  : Array.isArray(envFileTypes)
                    ? envFileTypes
                    : ['photo'];
            const fileTypesSet = new Set(
                fileTypesBase.map((t) => String(t || '').toLowerCase()).filter(Boolean),
            );
            if (includeVideos) fileTypesSet.add('video');
            const fileTypes = [...fileTypesSet];
            const db = getDb();
            const videoFrameIntervalSec = Math.max(
                1,
                Number(
                    resolveFacesValue('videoFrameIntervalSec', facesCfgIn) ??
                        facesCfgIn.videoFrameIntervalSec ??
                        cfg.videoFrameIntervalSec ??
                        8,
                ) || 8,
            );
            const videoMaxFrames = Math.max(
                1,
                Math.min(
                    200,
                    Number(
                        resolveFacesValue('videoMaxFrames', facesCfgIn) ??
                            facesCfgIn.videoMaxFrames ??
                            cfg.videoMaxFrames ??
                            24,
                    ) || 24,
                ),
            );
            const canSampleVideos = includeVideos && hasFfmpeg();
            if (includeVideos && !canSampleVideos) {
                log(
                    'warn',
                    'faces scan: includeVideos=true but ffmpeg is unavailable; skipping video rows',
                );
            }

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
                    let detectedTotal = 0;
                    if (abs) {
                        try {
                            if (String(row.file_type || '').toLowerCase() === 'video') {
                                if (canSampleVideos) {
                                    const framePaths = await _extractVideoFrames(abs, {
                                        intervalSec: videoFrameIntervalSec,
                                        maxFrames: videoMaxFrames,
                                    });
                                    deleteFacesForDownload(row.id);
                                    try {
                                        for (const frameAbs of framePaths) {
                                            if (signal.aborted) break;
                                            const faces = await detectFaces(frameAbs, cfg, log);
                                            if (Array.isArray(faces) && faces.length) {
                                                for (const f of faces) {
                                                    insertFace({
                                                        downloadId: row.id,
                                                        x: f.x,
                                                        y: f.y,
                                                        w: f.w,
                                                        h: f.h,
                                                        embeddingBlob: _f32ToBlob(f.embedding),
                                                        qualityScore: computeFaceQualityScore(
                                                            f,
                                                            cfg,
                                                        ),
                                                    });
                                                    detectedTotal += 1;
                                                }
                                            }
                                        }
                                    } finally {
                                        await _cleanupTmpFrames(framePaths);
                                    }
                                }
                            } else {
                                const detected = await detectFaces(abs, cfg, log);
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
                                            qualityScore: computeFaceQualityScore(f, cfg),
                                        });
                                        detectedTotal += 1;
                                    }
                                }
                            }
                        } catch (e) {
                            log('warn', `detectFaces threw on id=${row.id}: ${e?.message || e}`);
                        }
                    }
                    if (detectedTotal > 0) {
                        log('info', `faces scan: id=${row.id} detected=${detectedTotal}`);
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

/**
 * Start OCR text extraction scan. Processes unscanned images and stores
 * extracted text in the `image_text` table.
 */
export function startOcrScan(cfg, onProgress, onDone, onLog) {
    return _runScan(
        'ocr',
        cfg,
        async (state, signal, bump, log) => {
            const sidecarUrl = getSidecarUrl();
            if (!sidecarUrl) {
                throw new Error(
                    'Python sidecar is not available — cannot extract text. ' +
                        'Check the AI maintenance page for sidecar status.',
                );
            }

            const batchSize = Math.max(1, Math.min(50, Number(cfg.batchSize) || 16));

            while (!signal.aborted) {
                const batch = getUnindexedAiBatch({ limit: batchSize });
                if (!batch.length) {
                    log('info', 'ocr scan: no more unscanned images');
                    break;
                }
                state.total = Math.max(state.total, state.scanned + batch.length * 2);
                bump();

                for (const row of batch) {
                    if (signal.aborted) break;

                    const absPath = _resolveAbs(row.file_path);
                    if (!absPath) {
                        log('warn', `ocr: file not found: ${row.file_path}`);
                        setAiIndexedAt(row.id);
                        state.scanned += 1;
                        bump();
                        continue;
                    }

                    if (row.file_type !== 'photo') {
                        log('debug', `ocr: skipping non-photo: ${row.file_name}`);
                        setAiIndexedAt(row.id);
                        state.scanned += 1;
                        bump();
                        continue;
                    }

                    try {
                        const result = await _extractTextOne(sidecarUrl, absPath, log);
                        if (result && result.text) {
                            const { setImageText } = await import('../db/faces.js');
                            setImageText(row.id, result.text, result.language, result.confidence);
                        }
                    } catch (e) {
                        log('warn', `ocr failed for id=${row.id}: ${e?.message || e}`);
                    }
                    setAiIndexedAt(row.id);
                    state.scanned += 1;
                    bump();
                    await new Promise((r) => setImmediate(r));
                }
            }
            log('info', `ocr scan: finished — ${state.scanned} files scanned`);
        },
        onProgress,
        onDone,
        onLog,
    );
}

/**
 * Call the Python sidecar's ``POST /ocr`` for one image.
 * Returns ``{text, language, confidence}`` or null on failure.
 */
async function _extractTextOne(sidecarUrl, absPath, log) {
    const url = `${sidecarUrl.replace(/\/+$/, '')}/ocr`;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: absPath }),
            signal: AbortSignal.timeout(30000), // 30 s per file
        });
        if (!res.ok) {
            log('warn', `ocr endpoint returned ${res.status} for ${absPath}`);
            return null;
        }
        const data = await res.json();
        return data?.result || null;
    } catch (e) {
        log('warn', `ocr request failed for ${absPath}: ${e?.message || e}`);
        return null;
    }
}

/**
 * Start object detection scan. Processes unscanned images and stores
 * detected objects in the `image_objects` table.
 */
export function startObjectDetectionScan(cfg, onProgress, onDone, onLog) {
    return _runScan(
        'objects',
        cfg,
        async (state, signal, bump, log) => {
            const sidecarUrl = getSidecarUrl();
            if (!sidecarUrl) {
                throw new Error(
                    'Python sidecar is not available — cannot detect objects. ' +
                        'Check the AI maintenance page for sidecar status.',
                );
            }

            const batchSize = Math.max(1, Math.min(50, Number(cfg.batchSize) || 16));
            const minConfidence = Math.max(0, Math.min(1, Number(cfg.minConfidence) || 0.5));

            while (!signal.aborted) {
                const batch = getUnindexedAiBatch({ limit: batchSize });
                if (!batch.length) {
                    log('info', 'objects scan: no more unscanned images');
                    break;
                }
                state.total = Math.max(state.total, state.scanned + batch.length * 2);
                bump();

                for (const row of batch) {
                    if (signal.aborted) break;

                    const absPath = _resolveAbs(row.file_path);
                    if (!absPath) {
                        log('warn', `objects: file not found: ${row.file_path}`);
                        setAiIndexedAt(row.id);
                        state.scanned += 1;
                        bump();
                        continue;
                    }

                    if (row.file_type !== 'photo') {
                        log('debug', `objects: skipping non-photo: ${row.file_name}`);
                        setAiIndexedAt(row.id);
                        state.scanned += 1;
                        bump();
                        continue;
                    }

                    try {
                        const objects = await _detectObjectsOne(
                            sidecarUrl,
                            absPath,
                            minConfidence,
                            log,
                        );
                        if (Array.isArray(objects) && objects.length > 0) {
                            addImageObjects(row.id, objects);
                        }
                    } catch (e) {
                        log(
                            'warn',
                            `objects detection failed for id=${row.id}: ${e?.message || e}`,
                        );
                    }
                    setAiIndexedAt(row.id);
                    state.scanned += 1;
                    bump();
                    await new Promise((r) => setImmediate(r));
                }
            }
            log('info', `objects scan: finished — ${state.scanned} files scanned`);
        },
        onProgress,
        onDone,
        onLog,
    );
}

/**
 * Call the Python sidecar's ``POST /detect-objects`` for one image.
 * Returns array of {object, confidence, x, y, w, h} or empty array on failure.
 */
async function _detectObjectsOne(sidecarUrl, absPath, confidence, log) {
    const url = `${sidecarUrl.replace(/\/+$/, '')}/detect-objects`;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: absPath, confidence }),
            signal: AbortSignal.timeout(60000), // 60 s per file (inference can be slow)
        });
        if (!res.ok) {
            log('warn', `detect-objects endpoint returned ${res.status} for ${absPath}`);
            return [];
        }
        const data = await res.json();
        return Array.isArray(data?.objects) ? data.objects : [];
    } catch (e) {
        log('warn', `detect-objects request failed for ${absPath}: ${e?.message || e}`);
        return [];
    }
}

/** For tests — clear in-memory state so the next test starts fresh. */
export function _resetForTests() {
    _scans.faces = _emptyState();
    _scans.tags = _emptyState();
}
