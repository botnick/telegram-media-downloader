/**
 * Faces scan runner. Search + Auto-tag flows were removed; this module
 * now owns only the face detection + DBSCAN clustering pipeline.
 *
 *   - `startFacesScan(cfg, …)` has two phases:
 *     (a) per-row face detection + persistence into the `faces` table,
 *     (b) one DBSCAN pass over every face embedding to populate `people`
 *         and link `faces.person_id`. Phase (b) runs on a worker thread
 *         (O(N²) — minutes on a large library) so the event loop, and with
 *         it the dashboard + container healthcheck, stays responsive.
 *
 * A row is stamped `ai_indexed_at` only once the sidecar has actually
 * answered for it (faces, no faces, or a per-file error like
 * decode_failed). When the sidecar is down, restarting or still loading
 * its model, the rows stay queued and the scan waits for it to come back
 * (`sidecarWaitMs`, default 5 min) — previously every row the scan
 * touched during an outage was stamped "no faces" and never looked at
 * again. A file that keeps knocking the sidecar over (or keeps timing out)
 * is retried on its own and, after MAX_ITEM_ATTEMPTS, skipped for the rest
 * of the run — still unstamped, so the next scan tries it again.
 *
 * Fire-and-forget: caller polls `getScanState('faces')` or subscribes to
 * the WS events the route layer broadcasts. Single-flight — a second
 * `startFacesScan` while one is running returns `{ alreadyRunning: true }`.
 */

import { existsSync } from 'fs';
import path from 'path';

import {
    deleteFacesForDownload,
    getDb,
    getUnindexedAiBatch,
    insertFace,
    insertPerson,
    setAiIndexedAt,
} from '../db.js';
import { clusterFacesOffThread, FACE_DEFAULTS } from './faces.js';
import {
    detectFacesBatch,
    detectFacesInVideo,
    isSidecarUnavailable,
    waitForSidecarReady,
} from './faces-client.js';
import { resolveFacesValue } from './faces-config.js';
import { getDataDir, getDownloadsDir } from '../paths.js';
import * as gocoreClient from '../gocore/client.js';

const DATA_DIR = getDataDir();

// A file whose request fails with the sidecar unavailable this many times
// is skipped for the rest of the run (never stamped) — it is most likely
// what keeps crashing the sidecar or timing out.
const MAX_ITEM_ATTEMPTS = 3;
// That many distinct files failing points at the sidecar, not the files:
// stop the scan instead of walking the whole library into the skip list.
const MAX_SKIPPED_FILES = 100;
const SIDECAR_WAIT_MS_DEFAULT = 300_000;
const REQUEST_TIMEOUT_MS_DEFAULT = 60_000;
// Phase B: faces loaded per SELECT and person_id updates per transaction.
// Both bounded so no single synchronous stretch holds the event loop.
const CLUSTER_LOAD_CHUNK = 2000;
const FACE_EMBEDDING_PAGE_SIZE = 500;
const CLUSTER_WRITE_CHUNK = 5000;

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

const _yield = () => new Promise((r) => setImmediate(r));

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
        phase: 'A', // 'A' = detection, 'B' = clustering
        faceCount: 0, // total face embeddings found in phase A
        peopleCount: 0, // clusters produced by phase B
        noiseFaces: 0, // faces not assigned to any cluster
        clusterProgress: 0, // phase B, 0..1 (region queries done / faces)
        waitingForSidecar: false, // phase A paused until the sidecar is back
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
 * NSFW resolver — DB stores `Group/images/foo.jpg` relative to the
 * downloads root. That root is `TGDL_DOWNLOADS_DIR` when set (split-disk
 * installs), so it is tried before the legacy `<data>/downloads`.
 */
function _resolveAbs(storedPath) {
    if (!storedPath) return null;
    if (path.isAbsolute(storedPath) && existsSync(storedPath)) return storedPath;
    let s = String(storedPath).replace(/\\/g, '/');
    while (s.startsWith('data/downloads/')) s = s.slice('data/downloads/'.length);
    const roots = [getDownloadsDir(), path.join(DATA_DIR, 'downloads')];
    for (const root of roots[0] === roots[1] ? [roots[0]] : roots) {
        const candidate = path.join(root, s);
        if (existsSync(candidate)) return candidate;
    }
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
            state.waitingForSidecar = false;
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

/**
 * Run `fn` inside one transaction, retrying briefly when another writer
 * holds the lock / connection (same shape as index.js's busy retry).
 */
async function _writeTx(db, fn, { retries = 4, backoffMs = 100 } = {}) {
    for (let attempt = 0; ; attempt++) {
        try {
            return db.transaction(fn)();
        } catch (e) {
            const msg = String(e?.message || e);
            const busy =
                msg.includes('database connection is busy') ||
                msg.includes('SQLITE_BUSY') ||
                msg.includes('database is locked') ||
                e?.code === 'SQLITE_BUSY';
            if (!busy || attempt >= retries - 1) throw e;
            await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)));
        }
    }
}

function _persistDetection(rowId, detected) {
    if (Array.isArray(detected) && detected.length) {
        deleteFacesForDownload(rowId);
        for (const f of detected) {
            if (!f.embedding || !f.embedding.length) continue;
            insertFace({
                downloadId: rowId,
                x: f.x,
                y: f.y,
                w: f.w,
                h: f.h,
                embeddingBlob: _f32ToBlob(f.embedding),
                qualityScore: Number.isFinite(f.qualityScore)
                    ? f.qualityScore
                    : Number.isFinite(f.score)
                      ? f.score
                      : null,
                exifOriented: f.exifOriented === true,
                frameTimeSec: f.frameTimeSec,
            });
        }
    }
    setAiIndexedAt(rowId);
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

            const scanVideos = facesCfgIn.scanVideos === true;
            // Phase A — detect faces on every photo we haven't visited yet.
            // Visited = "ai_indexed_at IS NOT NULL"; even photos that yield
            // zero faces get stamped so the next pass doesn't re-decode.
            // Keep this count separate from the richer AI status projection:
            // it is refreshed after every batch and must stay cheap.
            const localPendingCount = (types) => {
                const placeholders = types.map(() => '?').join(',');
                return db
                    .prepare(
                        `SELECT COUNT(*) AS n FROM downloads
                          WHERE file_type IN (${placeholders}) AND ai_indexed_at IS NULL`,
                    )
                    .get(...types).n;
            };
            let useGoPending = gocoreClient.isAvailable('db');
            const pendingCount = async (types) => {
                if (signal.aborted) return 0;
                if (useGoPending) {
                    try {
                        return (
                            await gocoreClient.aiPending(
                                { fileTypes: types },
                                { timeoutMs: 5_000, signal },
                            )
                        ).pending;
                    } catch {
                        // Old cores and transient restarts use the local
                        // query. Disable retries for this scan to avoid a
                        // request storm while the core is restarting.
                        useGoPending = false;
                    }
                }
                return localPendingCount(types);
            };
            const phaseATotal = await pendingCount(fileTypes);
            const videoTotal = scanVideos ? await pendingCount(['video']) : 0;
            // Keep the denominator tied to the live queue. New downloads may
            // arrive while a scan is running; recomputing from the remaining
            // unindexed rows prevents scanned/total from ever exceeding 100%.
            const progressTypes = [...new Set(scanVideos ? [...fileTypes, 'video'] : fileTypes)];
            const refreshProgressTotal = async () => {
                const pending = await pendingCount(progressTypes);
                state.total = Math.max(state.scanned, state.scanned + pending);
            };
            await refreshProgressTotal();
            bump();
            log(
                'info',
                `faces scan: ${phaseATotal} photos${videoTotal ? ` + ${videoTotal} videos` : ''} to scan in phase A`,
            );

            // `batchSize` precedence (same model as fileTypes above).
            const envBatch = resolveFacesValue('batchSize', facesCfgIn);
            const batchSizeRaw = _pickNumber([facesCfgIn.batchSize, cfg?.batchSize, envBatch], 16);
            const batchSize = Math.max(1, Math.min(200, Number(batchSizeRaw) || 32));

            // Duty-cycle CPU throttle ratio (0 = off, default 0.5 = rest for
            // half the time spent on detection). Configurable so GPU users
            // can set it to 0 and run at full speed. (`|| 0.5` used to turn
            // an explicit 0 back into the default.)
            const envThrottle = resolveFacesValue('cpuThrottleRatio', facesCfgIn);
            const throttleRatio = Math.max(
                0,
                Math.min(
                    5,
                    _pickNumber(
                        [facesCfgIn.cpuThrottleRatio, cfg?.cpuThrottleRatio, envThrottle],
                        0.5,
                    ),
                ),
            );

            // How long to wait for a sidecar that is down / still loading
            // before giving up; and the per-request budget the sidecar gets.
            const sidecarWaitMs = Math.max(
                0,
                _pickNumber(
                    [resolveFacesValue('sidecarWaitMs', facesCfgIn)],
                    SIDECAR_WAIT_MS_DEFAULT,
                ),
            );
            const requestTimeoutMs = Math.max(
                1000,
                _pickNumber(
                    [resolveFacesValue('requestTimeoutMs', facesCfgIn)],
                    REQUEST_TIMEOUT_MS_DEFAULT,
                ),
            );

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

            // Block until the sidecar can answer; throws (ending the scan
            // with an error, rows left unstamped) when it stays away.
            const ensureSidecar = async (why) => {
                state.waitingForSidecar = true;
                bcast(true);
                const ready = await waitForSidecarReady({
                    signal,
                    timeoutMs: sidecarWaitMs,
                    onLog: log,
                });
                state.waitingForSidecar = false;
                bcast(true);
                if (ready || signal.aborted) return;
                throw new Error(
                    `face sidecar unavailable (${why}) — gave up after ${Math.round(
                        sidecarWaitMs / 1000,
                    )} s. Files not scanned yet stay queued for the next scan.`,
                );
            };

            // row id → sidecar-unavailable failures so far (see header).
            const attempts = new Map();
            // Rows given up on for this run. Not stamped: the next scan
            // retries them.
            const skipped = new Set();
            // Returns true when the row is given up on for this run.
            // `alone` = the failed request carried only this file: a deadline
            // that expired on a single file / video won't pass on a retry
            // with the same deadline, so it is skipped straight away.
            const noteFailure = (row, abs, err, alone = false) => {
                // Misconfiguration (e.g. rejected API token): every file would
                // fail the same way — stop now, nothing stamped.
                if (err?.fatal) throw err;
                const n =
                    alone && err?.timedOut ? MAX_ITEM_ATTEMPTS : (attempts.get(row.id) || 0) + 1;
                attempts.set(row.id, n);
                if (n < MAX_ITEM_ATTEMPTS) return false;
                attempts.delete(row.id);
                skipped.add(row.id);
                log(
                    'warn',
                    `faces scan: skipping ${abs} for this run after ${n} failed attempts (${
                        err?.message || err
                    }) — left unscanned, the next scan retries it`,
                );
                if (skipped.size >= MAX_SKIPPED_FILES) {
                    throw new Error(
                        `${skipped.size} files failed repeatedly — the face sidecar looks unstable; stopping the scan (nothing was marked as scanned)`,
                    );
                }
                return true;
            };
            // Oldest unscanned rows, minus the ones skipped this run.
            const pickBatch = async (types, limit) => {
                if (signal.aborted) return [];
                let rows;
                if (gocoreClient.isAvailable('db')) {
                    try {
                        rows = (
                            await gocoreClient.aiCandidates(
                                { fileTypes: types, limit: limit + skipped.size },
                                { timeoutMs: 5_000, signal },
                            )
                        ).rows;
                    } catch {
                        // Older cores and transient restarts use the local
                        // query; the scan must remain resumable in either mode.
                    }
                }
                if (!rows) {
                    rows = getUnindexedAiBatch({ fileTypes: types, limit: limit + skipped.size });
                }
                return rows.filter((r) => !skipped.has(r.id)).slice(0, limit);
            };

            if (state.total > 0 && !signal.aborted) await ensureSidecar('scan start');

            let _statNull = 0; // sidecar gave no answer for the file / file missing
            let _statSkip = 0; // skipped by excludeExtensions
            let _statEmpty = 0; // detectFaces returned [] (processed but no faces detected)
            let _statFaces = 0; // total face embeddings stored
            let _statPhotos = 0; // photos with ≥1 face
            let _nextStatLog = 200; // log a summary every N photos
            while (!signal.aborted) {
                const batch = await pickBatch(fileTypes, batchSize);
                if (!batch.length) break;
                const items = batch.map((row) => ({ row, abs: _resolveAbs(row.file_path) }));
                const nullItems = items.filter((i) => !i.abs);
                const skipItems = excludeExts.size
                    ? items.filter(
                          (i) => i.abs && excludeExts.has(path.extname(i.abs).toLowerCase()),
                      )
                    : [];
                const skipSet = new Set(skipItems.map((i) => i.row.id));
                const validItems = items.filter((i) => i.abs && !skipSet.has(i.row.id));

                // Rows that already failed once go one per request, on their
                // own, before any new work — a file that crashes the sidecar
                // can then only take itself down.
                const suspects = validItems.filter((i) => attempts.has(i.row.id));
                const work = suspects.length ? suspects.slice(0, 1) : validItems;

                const results = new Map(); // row id → detected (null | [] | faces)
                const givenUp = [];
                let outage = null;
                const _t0 = Date.now();
                if (work.length && !signal.aborted) {
                    // Split the batch into parallel chunks so the sidecar's
                    // concurrency semaphore can process multiple files at once
                    // instead of one sequential batch blocking a single slot.
                    const CHUNK = Math.max(1, Math.min(4, Math.ceil(work.length / 4)));
                    const chunks = [];
                    for (let ci = 0; ci < work.length; ci += CHUNK) {
                        chunks.push(work.slice(ci, ci + CHUNK));
                    }
                    // Every chunk queues behind the others in the sidecar, so
                    // each gets a budget for the whole batch, not just itself.
                    const timeoutMs = Math.max(work.length * requestTimeoutMs, 120_000);
                    await Promise.all(
                        chunks.map(async (chunk) => {
                            try {
                                const out = await detectFacesBatch(
                                    chunk.map((i) => i.abs),
                                    cfg,
                                    log,
                                    signal,
                                    { throwOnUnavailable: true, timeoutMs },
                                );
                                chunk.forEach((it, k) => results.set(it.row.id, out[k] ?? null));
                            } catch (e) {
                                if (!isSidecarUnavailable(e)) {
                                    log('warn', `detectFacesBatch threw: ${e?.message || e}`);
                                }
                                outage = e;
                                for (const it of chunk) {
                                    if (noteFailure(it.row, it.abs, e, chunk.length === 1)) {
                                        givenUp.push(it);
                                    }
                                }
                            }
                        }),
                    );
                }
                if (signal.aborted) break;

                await _writeTx(db, () => {
                    for (const { row } of [...skipItems, ...nullItems]) setAiIndexedAt(row.id);
                    for (const { row } of work) {
                        if (results.has(row.id)) _persistDetection(row.id, results.get(row.id));
                    }
                });

                _statSkip += skipItems.length;
                _statNull += nullItems.length + givenUp.length;
                for (const { row } of work) {
                    if (!results.has(row.id)) continue;
                    attempts.delete(row.id);
                    const detected = results.get(row.id);
                    if (detected === null) {
                        _statNull++;
                    } else if (detected.length === 0) {
                        _statEmpty++;
                    } else {
                        _statFaces += detected.length;
                        _statPhotos++;
                    }
                }
                state.scanned +=
                    skipItems.length + nullItems.length + results.size + givenUp.length;
                await refreshProgressTotal();
                bump();

                if (state.scanned >= _nextStatLog) {
                    log(
                        'info',
                        `faces scan progress: ${state.scanned}/${state.total} — ` +
                            `${_statPhotos} with faces (${_statFaces} total), ` +
                            `${_statEmpty} no-face, ${_statNull} errors` +
                            (_statSkip ? `, ${_statSkip} ext-skipped` : ''),
                    );
                    _nextStatLog = state.scanned + 200;
                }
                if (outage) {
                    await ensureSidecar(outage?.message || String(outage));
                } else if (results.size) {
                    await _throttleSleep(Date.now() - _t0, throttleRatio);
                }
                await _yield();
            }
            log(
                'info',
                `faces scan: phase A (photos) done — ${_statPhotos} photos had faces ` +
                    `(${_statFaces} total embeddings), ` +
                    `${_statEmpty} no-face, ${_statNull} sidecar errors` +
                    (_statSkip ? `, ${_statSkip} ext-skipped` : '') +
                    (skipped.size ? `, ${skipped.size} left for the next scan` : ''),
            );

            // Phase A (videos) — same faces table, same DBSCAN pass in Phase B.
            // One video at a time: each can produce many frames so we don't want
            // to hold a large batch in memory. Faces stored here cluster with
            // photo-source faces automatically because the embedding space is
            // identical regardless of whether the frame came from a photo or video.
            // Gated by cfg.faces.scanVideos — off by default, opt-in via UI toggle.
            if (!signal.aborted && scanVideos && videoTotal > 0) {
                log('info', `faces scan: starting video phase — ${videoTotal} videos`);
                let _vNull = 0,
                    _vEmpty = 0,
                    _vFaces = 0,
                    _vVids = 0;
                while (!signal.aborted) {
                    const [row] = await pickBatch(['video'], 1);
                    if (!row) break;
                    const abs = _resolveAbs(row.file_path);
                    if (!abs) {
                        _vNull++;
                        setAiIndexedAt(row.id);
                        state.scanned += 1;
                        await refreshProgressTotal();
                        bump();
                        continue;
                    }
                    let detected = null;
                    let outage = null;
                    const _tv0 = Date.now();
                    try {
                        detected = await detectFacesInVideo(abs, cfg, log, signal, {
                            throwOnUnavailable: true,
                        });
                    } catch (e) {
                        if (!isSidecarUnavailable(e)) {
                            log('warn', `detectFacesInVideo threw for ${abs}: ${e?.message || e}`);
                        }
                        outage = e;
                    }
                    if (signal.aborted) break;
                    if (outage) {
                        // Never stamp on a failed / timed-out call: the row stays
                        // queued (or skipped for this run after repeated failures).
                        if (noteFailure(row, abs, outage, true)) {
                            _vNull++;
                            state.scanned += 1;
                            await refreshProgressTotal();
                            bump();
                        }
                        await ensureSidecar(outage?.message || String(outage));
                        continue;
                    }
                    attempts.delete(row.id);
                    if (detected === null) {
                        _vNull++;
                    } else if (detected.length === 0) {
                        _vEmpty++;
                    } else {
                        _vFaces += detected.length;
                        _vVids++;
                    }
                    await _writeTx(db, () => _persistDetection(row.id, detected));
                    state.scanned += 1;
                    await refreshProgressTotal();
                    bump();
                    if (!outage) await _throttleSleep(Date.now() - _tv0, throttleRatio);
                    await _yield();
                }
                log(
                    'info',
                    `faces scan: phase A (videos) done — ${_vVids} videos had faces ` +
                        `(${_vFaces} total embeddings), ${_vEmpty} no-face, ${_vNull} errors`,
                );
            }

            // Phase B — DBSCAN over every face embedding. Always re-runs
            // (clusters drift as new faces land).
            if (signal.aborted) return;
            log('info', 'faces scan: starting clustering pass');
            const loaded = await _loadEmbeddings(db, signal, log);
            if (!loaded) return; // aborted mid-load
            const { data, n, dim, ids, weights } = loaded;
            if (!n) {
                log('info', 'faces scan: no faces detected — clustering skipped');
                return;
            }
            // Signal phase transition so the frontend can swap to Phase B UI.
            state.phase = 'B';
            state.faceCount = n;
            bcast(true);
            if (n > 50000) {
                log(
                    'warn',
                    `faces scan: ${n} faces is a large input for DBSCAN — clustering may take a while`,
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
                `faces scan: clustering ${n} faces (eps=${epsForCluster}, minPts=${minPointsForCluster})`,
            );
            const _tc0 = Date.now();
            let nextProgressLog = 0.1;
            let clustered;
            try {
                clustered = await clusterFacesOffThread(
                    { data, n, dim, weights },
                    {
                        eps: epsForCluster,
                        minPts: minPointsForCluster,
                        signal,
                        onProgress: (done, total) => {
                            state.clusterProgress = total ? done / total : 1;
                            bcast();
                            if (state.clusterProgress >= nextProgressLog) {
                                log(
                                    'info',
                                    `faces scan: clustering ${Math.floor(state.clusterProgress * 100)}% (${Math.round((Date.now() - _tc0) / 1000)} s)`,
                                );
                                nextProgressLog = Math.floor(state.clusterProgress * 10) / 10 + 0.1;
                            }
                        },
                    },
                );
            } catch (e) {
                // Cancelled mid-clustering — the previous people are untouched.
                if (signal.aborted || e?.name === 'AbortError') return;
                throw e;
            }
            const { clusters, noiseCount } = clustered;
            state.clusterProgress = 1;

            // Snapshot every labelled centroid BEFORE replacing people. The
            // match runs against the snapshot (in-memory). Renames survive
            // re-runs as long as the new cluster's centroid is within
            // `matchEps` of the old labelled cluster's centroid.
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
                    const cdim = r.embedding_centroid.byteLength / 4;
                    const c = new Float32Array(cdim);
                    const view = new Float32Array(
                        r.embedding_centroid.buffer,
                        r.embedding_centroid.byteOffset,
                        cdim,
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

            if (signal.aborted) return;
            const preservedCount = await _replacePeople(db, clusters, ids, findCarryOverLabel);
            state.peopleCount = clusters.length;
            state.noiseFaces = noiseCount;
            log(
                'info',
                `faces scan: clustered ${n} faces into ${clusters.length} groups in ${Math.round(
                    (Date.now() - _tc0) / 1000,
                )} s (${preservedCount}/${labelSnapshot.length} labels preserved across re-cluster, clusterEps=${epsForCluster}, labelMatchEps=${matchEps.toFixed(3)})`,
            );
        },
        onProgress,
        onDone,
        onLog,
    );
}

/**
 * Stream every face embedding into one Float32Array (n × dim) plus ids and
 * quality weights, in `id` order (the order clustering has always used).
 * Keyset-paginated, yielding between chunks, so a 100 k-face library loads
 * without one long synchronous stretch. Rows inserted after the COUNT are
 * left for the next run; rows whose dimension differs from the first row
 * (a half-finished model migration) are skipped and stay unassigned.
 *
 * @returns {Promise<{data: Float32Array, n: number, dim: number, ids: Float64Array, weights: Float64Array}|null>}
 *          null when aborted
 */
async function _loadEmbeddingsFromRows(rows, total, signal, log, nextPage) {
    const ids = new Float64Array(total);
    const weights = new Float64Array(total);
    let data = new Float32Array(0);
    let dim = 0;
    let n = 0;
    let skipped = 0;
    let page = rows;
    let afterId = 0;
    while (page.length) {
        if (signal.aborted) return null;
        for (const r of page) {
            if (n >= total) break;
            let blob;
            try {
                blob = Buffer.from(String(r.embedding || ''), 'base64');
            } catch {
                blob = null;
            }
            if (!blob?.byteLength || blob.byteLength % 4 !== 0) {
                skipped++;
                afterId = Number(r.id) || afterId;
                continue;
            }
            if (!dim) {
                dim = blob.byteLength / 4;
                data = new Float32Array(total * dim);
            }
            if (blob.byteLength !== dim * 4) {
                skipped++;
                afterId = Number(r.id) || afterId;
                continue;
            }
            new Uint8Array(data.buffer, n * dim * 4, dim * 4).set(blob);
            ids[n] = r.id;
            weights[n] = Number.isFinite(r.quality_score) ? r.quality_score : Number.NaN;
            n++;
            afterId = Number(r.id) || afterId;
        }
        if (n >= total || page.length < FACE_EMBEDDING_PAGE_SIZE || !nextPage) break;
        page = (await nextPage(afterId)).rows;
        await _yield();
    }
    if (skipped) {
        log('warn', `faces scan: ${skipped} face rows skipped (missing / mismatched embedding)`);
    }
    return { data, n, dim, ids, weights };
}

async function _loadEmbeddings(db, signal, log) {
    if (gocoreClient.isAvailable('db')) {
        try {
            const first = await gocoreClient.faceEmbeddings(
                { afterId: 0, limit: FACE_EMBEDDING_PAGE_SIZE },
                { timeoutMs: 30_000, signal },
            );
            const total = Number(first.total || 0);
            return await _loadEmbeddingsFromRows(
                first.rows,
                total,
                signal,
                log,
                (afterId) =>
                    gocoreClient.faceEmbeddings(
                        { afterId, limit: FACE_EMBEDDING_PAGE_SIZE },
                        { timeoutMs: 30_000, signal },
                    ),
            );
        } catch (e) {
            if (signal.aborted || e?.name === 'AbortError') return null;
            // Old cores and transient restarts use one complete local read.
        }
    }
    const total = db.prepare('SELECT COUNT(*) AS n FROM faces').get().n;
    const ids = new Float64Array(total);
    const weights = new Float64Array(total);
    let data = new Float32Array(0);
    let dim = 0;
    let n = 0;
    let skipped = 0;
    const stmt = db.prepare(
        'SELECT id, embedding, quality_score FROM faces WHERE id > ? ORDER BY id LIMIT ?',
    );
    let lastId = -1;
    while (n < total) {
        if (signal.aborted) return null;
        const rows = stmt.all(lastId, CLUSTER_LOAD_CHUNK);
        if (!rows.length) break;
        lastId = rows[rows.length - 1].id;
        for (const r of rows) {
            if (n >= total) break;
            const blob = r.embedding;
            if (!blob || !blob.byteLength || blob.byteLength % 4 !== 0) {
                skipped++;
                continue;
            }
            if (!dim) {
                dim = blob.byteLength / 4;
                data = new Float32Array(total * dim);
            }
            if (blob.byteLength !== dim * 4) {
                skipped++;
                continue;
            }
            // Byte copy — blob.byteOffset isn't guaranteed 4-byte aligned.
            new Uint8Array(data.buffer, n * dim * 4, dim * 4).set(blob);
            ids[n] = r.id;
            weights[n] = Number.isFinite(r.quality_score) ? r.quality_score : Number.NaN;
            n++;
        }
        await _yield();
    }
    if (skipped) {
        log('warn', `faces scan: ${skipped} face rows skipped (missing / mismatched embedding)`);
    }
    return { data, n, dim, ids, weights };
}

/**
 * Swap the `people` generation for the fresh clusters. New person rows are
 * inserted first (AUTOINCREMENT ids continue exactly as they did after the
 * old wipe-then-insert), faces are pointed at them in bounded transactions,
 * then the previous generation is dropped and any face still pointing at it
 * (noise this time round) is cleared. Same end state as the old
 * `clearAllPeople()` + per-face UPDATE loop, but each face row (≈2 KB with
 * its embedding) is rewritten once instead of twice, and the People grid
 * is never empty in between.
 *
 * @returns {Promise<number>} how many clusters inherited a label
 */
async function _replacePeople(db, clusters, ids, findCarryOverLabel) {
    const oldMax = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM people').get().m;
    const personIds = new Array(clusters.length);
    let preservedCount = 0;
    await _writeTx(db, () => {
        preservedCount = 0;
        for (let c = 0; c < clusters.length; c++) {
            const carryOver = findCarryOverLabel(clusters[c].centroid);
            if (carryOver) preservedCount += 1;
            personIds[c] = insertPerson({
                label: carryOver,
                centroidBlob: _f32ToBlob(clusters[c].centroid),
                faceCount: clusters[c].faceCount,
            });
        }
    });
    const setPerson = db.prepare('UPDATE faces SET person_id = ? WHERE id = ?');
    // Cursor over (cluster, member); only advanced once a chunk commits so
    // a busy-retry of the transaction replays the same range.
    let cursor = { c: 0, m: 0 };
    while (cursor.c < clusters.length) {
        cursor = await _writeTx(db, () => {
            let { c, m } = cursor;
            let written = 0;
            while (c < clusters.length && written < CLUSTER_WRITE_CHUNK) {
                const members = clusters[c].memberIdxs;
                for (; m < members.length && written < CLUSTER_WRITE_CHUNK; m++, written++) {
                    setPerson.run(personIds[c], ids[members[m]]);
                }
                if (m >= members.length) {
                    c++;
                    m = 0;
                }
            }
            return { c, m };
        });
        await _yield();
    }
    await _writeTx(db, () => {
        db.prepare('UPDATE faces SET person_id = NULL WHERE person_id <= ?').run(oldMax);
        db.prepare('DELETE FROM people WHERE id <= ?').run(oldMax);
    });
    return preservedCount;
}

/** For tests — clear in-memory state so the next test starts fresh. */
export function _resetForTests() {
    _scans.faces = _emptyState();
}
