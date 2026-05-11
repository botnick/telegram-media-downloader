/**
 * MP4 faststart optimizer.
 *
 * MP4 carries its sample table / codec config in a `moov` atom. Browsers
 * (and any HTML5 `<video>` player) need that atom in hand before they
 * can paint a frame, decode audio, or honour a seek. When `moov` lives
 * at the END of the file (the default for many encoders, including the
 * one that produced our archived clips), the player has to download
 * every byte of `mdat` first — which on a slow link looks exactly like
 * "video has no audio and the seek bar is dead".
 *
 * `ffmpeg -movflags +faststart -c copy` rewrites the file with `moov`
 * before `mdat`. No re-encode (audio + video streams are stream-copied
 * unchanged) so the operation is I/O bound, finishes in seconds for
 * sub-100 MB clips, and produces a bit-for-bit identical playback.
 *
 * Detection is cheap: read the first 16 bytes, parse the `ftyp` atom
 * size, peek at whatever follows. If it's `moov`, the file is already
 * faststart-optimised and we skip it. If it's `mdat` (or anything other
 * than `moov`), the file needs the rewrite.
 *
 * Atomic publish: write `<file>.faststart.tmp`, then `fs.rename` over
 * the original. A crash mid-write leaves the original untouched.
 *
 * Concurrency: ffmpeg is I/O-bound here (no decode), but we still
 * bound it so a 10 000-file backfill doesn't saturate the disk.
 * Default 2 in parallel; env-overridable via FASTSTART_CONCURRENCY.
 *
 * Caller integration:
 *   - `optimizeDownload(id)` — single row, used by the downloader's
 *     post-insert hook (fire-and-forget for newly downloaded videos).
 *   - `optimizeAll({ onProgress, signal })` — Maintenance sweep over
 *     every catalogued video; emits progress for the WS bar.
 *   - `getStats()` — counts for the Maintenance UI's "needs attention"
 *     summary (total / optimised / pending).
 */

import path from 'path';
import { existsSync, promises as fs } from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { getDb, kvGet, kvSet } from './db.js';
import { resolveFfmpegBin, hasFfmpeg, purgeThumbsForDownload } from './thumbs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DOWNLOADS_DIR = path.resolve(PROJECT_ROOT, 'data', 'downloads');

// Container extensions where +faststart is meaningful. WebM / MKV use
// their own indexing scheme (Cues atom, not moov) and don't benefit;
// the rest are MP4 / ISOBMFF derivatives where the moov rewrite
// applies.
const FASTSTART_EXTS = new Set(['.mp4', '.m4v', '.mov', '.3gp']);

// kv key for the running auto-optimise counters surfaced on the
// Maintenance → Optimise videos page. Pattern matches the integrity /
// thumbs / cluster stats blobs — increment in-place, don't recompute.
const AUTO_STATS_KV = 'faststart_stats';

// Broadcast hook for per-file `faststart_auto_done` events — wired by
// `setBroadcast(broadcast)` at boot from server.js (mirrors the
// integrity.js + cluster ws-channel pattern). Stays a no-op in the CLI
// monitor path.
let _broadcast = () => {};

/**
 * Inject the WebSocket broadcaster so per-file auto-optimise events
 * surface live in the dashboard. Called once at boot from server.js;
 * the CLI monitor leaves it as a no-op.
 */
export function setBroadcast(fn) {
    if (typeof fn === 'function') _broadcast = fn;
}

// Log once at startup if ffmpeg is missing so the operator sees an
// explicit signal instead of silent skips on every download. Cached so
// re-imports / hot reloads don't spam the log.
let _ffmpegWarnedMissing = false;
function _warnIfMissingFfmpeg() {
    if (_ffmpegWarnedMissing) return;
    if (hasFfmpeg()) return;
    _ffmpegWarnedMissing = true;
    console.warn(
        '[faststart] ffmpeg not on PATH — auto-optimise disabled. New MP4 downloads will be served as-is.',
    );
}

/**
 * Bump the running auto-stats blob after each per-row decision. Cheap —
 * one kv read + one kv write per download (kvSet wraps in a transaction
 * already). Counters are persistent so a restart doesn't reset the
 * "today's progress" the maintenance UI shows.
 *
 * `result` is one of: optimized | already | skipped | errored.
 */
function _bumpAutoStats(result, errorMsg = null) {
    try {
        const prev = kvGet(AUTO_STATS_KV) || {};
        const next = {
            total: (prev.total || 0) + 1,
            optimized: (prev.optimized || 0) + (result === 'optimized' ? 1 : 0),
            already: (prev.already || 0) + (result === 'already' ? 1 : 0),
            skipped: (prev.skipped || 0) + (result === 'skipped' ? 1 : 0),
            errored: (prev.errored || 0) + (result === 'errored' ? 1 : 0),
            lastAt: Date.now(),
            lastResult: result,
            lastError: result === 'errored' ? String(errorMsg || '').slice(0, 200) : null,
        };
        kvSet(AUTO_STATS_KV, next);
    } catch {
        // kv writes can fail mid-shutdown when better-sqlite3 is closed
        // out from under us — never let counters break the download path.
    }
}

const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.FASTSTART_CONCURRENCY) || 2));

function makeSemaphore(max) {
    let active = 0;
    const queue = [];
    return {
        acquire() {
            return new Promise((resolve) => {
                if (active < max) {
                    active++;
                    resolve();
                    return;
                }
                queue.push(resolve);
            });
        },
        release() {
            active--;
            const next = queue.shift();
            if (next) {
                active++;
                next();
            }
        },
    };
}
const _sem = makeSemaphore(CONCURRENCY);

// Same path-resolution logic thumbs.js uses — rows store paths relative
// to data/downloads/, but tolerate a stray leading `data/downloads/`
// prefix from older insertions.
function _resolveAbs(stored) {
    if (!stored) return null;
    if (path.isAbsolute(stored) && existsSync(stored)) return stored;
    let s = String(stored).replace(/\\/g, '/');
    while (s.startsWith('data/downloads/')) s = s.slice('data/downloads/'.length);
    const candidate = path.join(DOWNLOADS_DIR, s);
    if (existsSync(candidate)) return candidate;
    return null;
}

/**
 * Read the atom that follows `ftyp`. Faststart-optimised files have
 * `moov` here; un-optimised files typically have `mdat`. Either way we
 * only touch the first ~64 bytes of the file.
 *
 * Returns:
 *   'moov'   — already optimised, skip
 *   'mdat'   — needs rewrite (the common case)
 *   'other'  — some other atom (free / mfra / unknown) — assume needs
 *              rewrite, ffmpeg will scan deeper
 *   null     — file unreadable / not an MP4 / truncated
 */
async function _peekSecondAtom(absPath) {
    let fh;
    try {
        fh = await fs.open(absPath, 'r');
        const head = Buffer.alloc(64);
        const { bytesRead } = await fh.read(head, 0, 64, 0);
        if (bytesRead < 16) return null;
        // ftyp at offset 0: 4 bytes size, 4 bytes 'ftyp'
        if (head.slice(4, 8).toString('ascii') !== 'ftyp') return null;
        const ftypSize = head.readUInt32BE(0);
        // Sanity: ftyp typically 16-64 bytes; a runaway value means we
        // should bail rather than seek past EOF.
        if (ftypSize < 8 || ftypSize > 1024) return null;
        // Need to read more if ftyp is bigger than our 64-byte peek.
        if (ftypSize + 8 > bytesRead) {
            const extra = Buffer.alloc(8);
            const r2 = await fh.read(extra, 0, 8, ftypSize);
            if (r2.bytesRead < 8) return null;
            const atom = extra.slice(4, 8).toString('ascii');
            if (atom === 'moov') return 'moov';
            if (atom === 'mdat') return 'mdat';
            return 'other';
        }
        const atom = head.slice(ftypSize + 4, ftypSize + 8).toString('ascii');
        if (atom === 'moov') return 'moov';
        if (atom === 'mdat') return 'mdat';
        return 'other';
    } catch {
        return null;
    } finally {
        try {
            await fh?.close();
        } catch {
            /* best-effort */
        }
    }
}

/** True iff `_peekSecondAtom(abs)` says the file already has moov up front. */
async function _isOptimized(absPath) {
    return (await _peekSecondAtom(absPath)) === 'moov';
}

function _runFfmpeg(args) {
    return new Promise((resolve, reject) => {
        const p = spawn(resolveFfmpegBin(), args, { windowsHide: true });
        const errChunks = [];
        p.stderr.on('data', (c) => errChunks.push(c));
        p.on('error', reject);
        p.on('close', (code) => {
            if (code !== 0) {
                const stderr = Buffer.concat(errChunks).toString('utf8');
                return reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 400)}`));
            }
            resolve();
        });
    });
}

// Windows races a lot of readers on a freshly-downloaded MP4: the web
// server may be streaming `/files/<path>?inline=1`, the thumb generator
// is reading the first keyframe, the NSFW scanner is decoding it,
// Defender is doing an open-on-write scan. Any of those holds the
// destination handle open just long enough for `fs.rename` to throw
// `EPERM`/`EBUSY`/`EACCES`. Retry with linear backoff; fall back to
// `copy + unlink` as a last resort (still atomic-enough for our use —
// the on-disk path always points at a valid MP4, just one of two
// possible mtimes).
async function _renameWithRetry(from, to, { retries = 6 } = {}) {
    const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);
    let lastErr = null;
    for (let i = 0; i < retries; i++) {
        try {
            await fs.rename(from, to);
            return;
        } catch (e) {
            lastErr = e;
            if (!RETRY_CODES.has(e.code)) throw e;
            // 200, 400, 800, 1600, 3200, 6400 ms — total ≈ 12.6 s budget
            // before falling back. Windows file locks typically clear in
            // sub-second; the long tail covers antivirus quarantine scans.
            await new Promise((r) => setTimeout(r, 200 * 2 ** i));
        }
    }
    // Last resort — copy + unlink. Not atomic but the only way out when
    // some reader truly won't release the destination handle. The window
    // between copyFile and unlink is short; readers in flight see the
    // old bytes, new readers see the new bytes.
    try {
        await fs.copyFile(from, to);
        await fs.unlink(from);
        return;
    } catch (e2) {
        const code = lastErr?.code || e2.code || 'UNKNOWN';
        throw new Error(`rename ${code} after ${retries} retries + copy fallback: ${e2.message}`);
    }
}

async function _remuxInPlace(absPath) {
    const tmp = absPath + '.faststart.tmp';
    // Stream-copy both A and V, only rewrite container metadata. `-y`
    // overwrites any stale .tmp left over from a prior crash.
    await _runFfmpeg([
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        absPath,
        '-c',
        'copy',
        '-map',
        '0', // copy every stream (video + audio + subs + …)
        '-movflags',
        '+faststart',
        '-f',
        'mp4', // explicit muxer — `.tmp` defeats inference (same lesson as thumbs.js)
        '-y',
        tmp,
    ]);
    if (!existsSync(tmp)) throw new Error('ffmpeg produced no output');
    // Sanity check: tmp should be roughly the same size as the source.
    // A wildly different size means something went wrong (codec
    // mismatch, container conversion). Bail rather than overwrite.
    const [srcStat, tmpStat] = await Promise.all([fs.stat(absPath), fs.stat(tmp)]);
    if (tmpStat.size < srcStat.size * 0.95 || tmpStat.size > srcStat.size * 1.1) {
        try {
            await fs.unlink(tmp);
        } catch {}
        throw new Error(`tmp size sanity check failed: src=${srcStat.size} tmp=${tmpStat.size}`);
    }
    await _renameWithRetry(tmp, absPath);
    return tmpStat.size;
}

// ---- Public API ----------------------------------------------------------

/**
 * Idempotently faststart-optimise the video on disk for one downloads
 * row. Returns one of:
 *   { status:'optimized', newSize }   — rewrote moov to head
 *   { status:'already' }              — file was already optimised
 *   { status:'skipped',  reason }     — not a video / not on disk / ffmpeg missing
 *   { status:'errored',  error }      — remux threw
 *
 * Updates `downloads.file_size` after a successful rewrite (the file
 * grows by the size of the relocated moov atom — a few KB).
 */
export async function optimizeDownload(id) {
    const dlId = parseInt(id, 10);
    if (!Number.isInteger(dlId) || dlId <= 0) return { status: 'skipped', reason: 'bad id' };
    if (!hasFfmpeg()) return { status: 'skipped', reason: 'no ffmpeg' };
    const row = getDb()
        .prepare('SELECT id, file_path, file_type FROM downloads WHERE id = ?')
        .get(dlId);
    if (!row) return { status: 'skipped', reason: 'no row' };
    // Operator-mode downloads often land as `file_type='document'` even
    // though the container IS MP4 (Telegram doesn't always set the video
    // attribute). Decide by extension, not just by file_type — that
    // means a `.mp4` document still gets the moov rewrite, but a
    // `.pdf`/`.zip` document still gets skipped.
    if (row.file_type !== 'video' && row.file_type !== 'document') {
        return { status: 'skipped', reason: 'not video/document' };
    }
    const abs = _resolveAbs(row.file_path);
    if (!abs) return { status: 'skipped', reason: 'file missing' };
    const ext = path.extname(abs).toLowerCase();
    if (!FASTSTART_EXTS.has(ext)) return { status: 'skipped', reason: 'container not mp4' };
    if (await _isOptimized(abs)) return { status: 'already' };

    await _sem.acquire();
    try {
        const newSize = await _remuxInPlace(abs);
        // file_size in the DB needs to follow the on-disk reality. The
        // moov rewrite typically adds a few KB; gallery code displays
        // this number on the row. Keep it honest.
        try {
            getDb().prepare('UPDATE downloads SET file_size = ? WHERE id = ?').run(newSize, dlId);
        } catch {
            /* best-effort; the file is already optimised */
        }
        // The video thumb (if cached) was generated against the old
        // file path's first keyframe. The frame is bit-identical after
        // a stream-copy, so the cached webp would still be valid — but
        // mtime-based cache validation might end up serving a 304 with
        // a now-stale Last-Modified. Cheaper to drop the cache and let
        // the next gallery render regenerate.
        try {
            await purgeThumbsForDownload(dlId);
        } catch {}
        return { status: 'optimized', newSize };
    } catch (e) {
        return { status: 'errored', error: e?.message || String(e) };
    } finally {
        _sem.release();
    }
}

/**
 * Background hook fired by the downloader after a successful insert
 * for a video / document row whose container could be MP4. Same fire-
 * and-forget shape as `pregenerateThumb`: runs in a microtask so the
 * download flow returns immediately. Logs every entry + exit so the
 * operator can confirm auto-optimise is running, bumps the persistent
 * `kv['faststart_stats']` counters used by the Maintenance UI, and
 * broadcasts `faststart_auto_done` per file so the dashboard updates
 * live without polling.
 */
export function optimizeDownloadInBackground(id) {
    _warnIfMissingFfmpeg();
    queueMicrotask(async () => {
        let r;
        try {
            r = await optimizeDownload(id);
        } catch (e) {
            r = { status: 'errored', error: e?.message || String(e) };
        }
        const status = r?.status || 'errored';
        const newSize = r?.newSize || 0;
        const reason = r?.reason || null;
        const error = r?.error || null;
        // Single log line per file — `result=optimized|already|skipped|errored`
        // makes the stream greppable. Skipped includes a `reason` so the
        // operator can tell "not an MP4" from "ffmpeg missing".
        const detail = status === 'skipped' && reason ? ` reason=${reason}` : '';
        const sizeBit = status === 'optimized' ? ` size=${newSize}` : '';
        const errBit = status === 'errored' ? ` error=${String(error).slice(0, 160)}` : '';
        const line = `[faststart] id=${id} result=${status}${detail}${sizeBit}${errBit}`;
        if (status === 'errored') console.warn(line);
        else console.log(line);
        // Persist running counters even for skipped rows — the
        // operator's mental model is "how many downloads did the auto
        // hook see?", not "how many actually rewrote". Errored rows are
        // counted separately so the UI can surface "2 failed today".
        _bumpAutoStats(status, error);
        // WS event distinct from the sweep's `faststart_done` (which
        // JobTracker emits with aggregate sweep numbers). Per-file
        // broadcasts let the auto-stats card animate live as the
        // backfill catches up.
        try {
            _broadcast({
                type: 'faststart_auto_done',
                downloadId: Number(id) || id,
                result: status,
                reason,
                newSize,
                error,
            });
        } catch {
            // broadcast failure (no WS clients, server shutting down) is
            // never the downloader's problem.
        }
    });
}

/**
 * Walk every catalogued video, optimise the ones whose moov atom is
 * not already at the head. Used by the Maintenance "Optimize videos
 * for streaming" button.
 *
 * Emits `onProgress({stage,processed,total,optimized,already,skipped,errored})`
 * approximately every 5 rows so the WS bar stays smooth.
 */
export async function optimizeAll(opts = {}) {
    const { onProgress, signal } = opts;
    // Stream — `.all()` over the full video list runs the box out of heap
    // on libraries with 100k+ video rows.
    const db = getDb();
    const total = db
        .prepare(`
        SELECT COUNT(*) AS n FROM downloads
         WHERE file_type = 'video' AND file_path IS NOT NULL
    `)
        .get().n;
    const iter = db
        .prepare(`
        SELECT id FROM downloads
         WHERE file_type = 'video' AND file_path IS NOT NULL
         ORDER BY id DESC
    `)
        .iterate();
    let processed = 0,
        optimized = 0,
        already = 0,
        skipped = 0,
        errored = 0;

    const tick = () => {
        if (onProgress)
            onProgress({
                stage: 'optimizing',
                processed,
                total,
                optimized,
                already,
                skipped,
                errored,
            });
    };
    tick();

    for (const r of iter) {
        if (signal?.aborted) break;
        processed++;
        try {
            const result = await optimizeDownload(r.id);
            if (result.status === 'optimized') optimized++;
            else if (result.status === 'already') already++;
            else if (result.status === 'errored') errored++;
            else skipped++;
        } catch {
            errored++;
        }
        if (processed % 5 === 0 || processed === total) tick();
    }

    if (onProgress)
        onProgress({
            stage: 'done',
            processed,
            total,
            optimized,
            already,
            skipped,
            errored,
        });
    return { scanned: total, optimized, already, skipped, errored };
}

/**
 * Fast read-only summary for the Maintenance dashboard. Walks every
 * video row, peeks the second atom, returns counts. ~64 bytes of disk
 * I/O per file, so a 10 000-file library finishes in well under a
 * second on SSD. Errors are silently coerced into the "unknown" bucket.
 */
export async function getStats() {
    // Stream — same OOM risk as optimizeAll on very large libraries.
    const iter = getDb()
        .prepare(`
        SELECT id, file_path FROM downloads
         WHERE file_type = 'video' AND file_path IS NOT NULL
    `)
        .iterate();
    let total = 0,
        optimized = 0,
        pending = 0,
        missing = 0,
        unknown = 0;
    for (const r of iter) {
        total++;
        const abs = _resolveAbs(r.file_path);
        if (!abs) {
            missing++;
            continue;
        }
        const ext = path.extname(abs).toLowerCase();
        if (!FASTSTART_EXTS.has(ext)) {
            unknown++;
            continue;
        }
        const which = await _peekSecondAtom(abs);
        if (which === 'moov') optimized++;
        else if (which === 'mdat' || which === 'other') pending++;
        else unknown++;
    }
    return { total, optimized, pending, missing, unknown };
}

/**
 * Snapshot of the persistent auto-optimise counters surfaced by
 * `/api/maintenance/faststart/auto-stats`. Includes the same shape the
 * post-insert hook writes via `_bumpAutoStats` plus a `ffmpegAvailable`
 * flag so the UI can show a "ffmpeg missing" chip without a separate
 * roundtrip.
 */
export function getAutoStats() {
    const blob = kvGet(AUTO_STATS_KV) || {};
    return {
        total: blob.total || 0,
        optimized: blob.optimized || 0,
        already: blob.already || 0,
        skipped: blob.skipped || 0,
        errored: blob.errored || 0,
        lastAt: blob.lastAt || null,
        lastResult: blob.lastResult || null,
        lastError: blob.lastError || null,
        ffmpegAvailable: hasFfmpeg(),
    };
}
