/**
 * Seekbar sprite generator. One ffmpeg call per video → WebP sprite
 * sheet + JSON sidecar. Deterministic: same source bytes + same config
 * always produce the same on-disk artefacts, so the cache-friendliness
 * promise in the spec holds.
 *
 * Algorithm (per-clip):
 *   1. ffprobe → duration.
 *   2. Pick a frame count: `clamp(ceil(duration / interval), 12, maxTiles)`.
 *      Recompute `interval = duration / frames` so the last sample lands
 *      on the clip's final second.
 *   3. Lay tiles out as `cols × ceil(frames / cols)`.
 *   4. ffmpeg `fps=1/interval, scale=W:-2, tile=COLS×ROWS` → single .webp.
 *      libwebp present → encode in-process. libwebp missing → render a
 *      tiled JPEG and let sharp re-encode to WebP (mirrors thumbs.js).
 *   5. Atomic .tmp → final rename for both the sprite and the JSON.
 */

import { spawn } from 'child_process';
import crypto from 'crypto';
import { existsSync, statSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';

import { loadConfig } from '../../config/manager.js';
import { upsertSeekbarSprite } from '../db.js';
import {
    ffmpegHasLibwebp,
    hasFfmpeg,
    hwaccelUploadPipeline,
    resolveFfmpegBin,
    resolveFfprobeBin,
    runFfmpegArgs,
} from '../thumbs.js';
import {
    cancelJob as sidecarCancelJob,
    deleteSprite as sidecarDeleteSprite,
    downloadSprite as sidecarDownloadSprite,
    fromSidecarPath,
    getJob as sidecarGetJob,
    getSidecarUrl,
    hasFeature as sidecarHasFeature,
    isSourceNotFound,
    submitOne as sidecarSubmitOne,
    toSidecarPath,
    uploadSource as sidecarUploadSource,
} from './client.js';
import { resetNsfwVideoResult } from '../db.js';
import { getDataDir, getDownloadsDir } from '../paths.js';
import * as gocoreClient from '../gocore/client.js';

const DATA_DIR = getDataDir();
const SEEKBAR_DIR = path.join(DATA_DIR, 'seekbar');
const DOWNLOADS_DIR = getDownloadsDir();

export const SEEKBAR_DEFAULTS = Object.freeze({
    enabled: false,
    autoOnDownload: true,
    intervalSec: 4,
    tileWidth: 160,
    columns: 10,
    maxTiles: 240,
    format: 'webp',
    quality: 75,
    concurrency: 8,
    maxRetries: 3,
    hwaccel: null,
});

export function getSeekbarConfig() {
    let stored = {};
    try {
        stored = loadConfig()?.advanced?.seekbar || {};
    } catch {
        /* fall through to defaults */
    }
    return { ...SEEKBAR_DEFAULTS, ...stored };
}

function _spritePath(downloadId, format = 'webp') {
    const ext = format === 'jpeg' || format === 'jpg' ? 'jpg' : 'webp';
    return path.join(SEEKBAR_DIR, `${downloadId}.${ext}`);
}

function _metaPath(downloadId) {
    return path.join(SEEKBAR_DIR, `${downloadId}.json`);
}

export function getSpritePath(downloadId, format = 'webp') {
    return _spritePath(downloadId, format);
}

export function getMetaFilePath(downloadId) {
    return _metaPath(downloadId);
}

function _resolveDownloadAbs(stored) {
    if (!stored) return null;
    if (path.isAbsolute(stored) && existsSync(stored)) return stored;
    let s = String(stored).replace(/\\/g, '/');
    while (s.startsWith('data/downloads/')) s = s.slice('data/downloads/'.length);
    const candidate = path.join(DOWNLOADS_DIR, s);
    if (existsSync(candidate)) return candidate;
    if (existsSync(stored)) return stored;
    return null;
}

async function _ensureSeekbarDir() {
    if (!existsSync(SEEKBAR_DIR)) {
        await fs.mkdir(SEEKBAR_DIR, { recursive: true });
    }
}

function _ffprobeDuration(absPath) {
    return new Promise((resolve) => {
        try {
            const probe = resolveFfprobeBin();
            const args = [
                '-v',
                'error',
                '-show_entries',
                'format=duration',
                '-of',
                'csv=p=0',
                absPath,
            ];
            const p = spawn(probe, args, { windowsHide: true });
            const chunks = [];
            const errChunks = [];
            p.stdout.on('data', (c) => chunks.push(c));
            p.stderr.on('data', (c) => errChunks.push(c));
            p.on('error', () => resolve(null));
            p.on('close', (code) => {
                if (code !== 0) return resolve(null);
                const out = Buffer.concat(chunks).toString('utf8').trim();
                const v = parseFloat(out);
                resolve(Number.isFinite(v) && v > 0 ? v : null);
            });
        } catch {
            resolve(null);
        }
    });
}

// Duration-aware tiers: density = target seconds between frames, absoluteMax = frame budget.
// Scales automatically so the seekbar is never sparse regardless of clip length.
// User-configured maxTiles acts as a hard cap on top of these defaults.
const _SPRITE_TIERS = [
    { upTo: 15, density: 0.5, absoluteMax: 30 },
    { upTo: 60, density: 1.0, absoluteMax: 60 },
    { upTo: 300, density: 3.0, absoluteMax: 100 },
    { upTo: 900, density: 5.0, absoluteMax: 180 },
    { upTo: 1800, density: 7.0, absoluteMax: 300 },
    { upTo: 3600, density: 9.0, absoluteMax: 450 },
    { upTo: 7200, density: 12.0, absoluteMax: 600 },
    { upTo: Infinity, density: 18.0, absoluteMax: 720 },
];

/**
 * Compute the sprite layout for a given duration + config. Pure — exposed
 * for unit tests so the math can be verified without spawning ffmpeg.
 *
 * Dynamic tiers: each duration range gets its own frame density and budget
 * so short clips are dense and long clips (1–2hr) still have full coverage
 * without blank stretches. User-configured intervalSec / maxTiles override
 * the tier defaults but cannot push below 0.5 s/frame minimum.
 */
export function planSprite(durationSec, cfg) {
    const tier = _SPRITE_TIERS.find((t) => durationSec <= t.upTo) ?? _SPRITE_TIERS.at(-1);

    const userInterval = Math.max(0, Number(cfg.intervalSec) || 0);
    const userMaxTiles = Math.max(0, Math.floor(Number(cfg.maxTiles) || 0));

    // Effective density: user interval wins; floor at 0.5 s/frame
    const density = userInterval > 0 ? Math.max(0.5, userInterval) : tier.density;

    let frames = Math.ceil(durationSec / density);
    if (!Number.isFinite(frames) || frames < 8) frames = 8;
    // Tier cap first, then optional user hard cap
    frames = Math.min(frames, tier.absoluteMax);
    if (userMaxTiles > 0) frames = Math.min(frames, userMaxTiles);

    const interval = durationSec / frames;
    const cols = Math.max(2, Math.min(50, Number(cfg.columns) || 10));
    const rows = Math.max(1, Math.ceil(frames / cols));
    const tileW = Math.max(40, Math.min(800, Number(cfg.tileWidth) || 160));
    return { frames, intervalSec: interval, cols, rows, tileW };
}

async function _writeAtomic(absPath, body) {
    const tmp = absPath + '.tmp.' + crypto.randomBytes(4).toString('hex');
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, absPath);
}

async function _runSpriteFfmpeg({ srcAbs, dstAbs, plan, cfg, timeoutMs }) {
    const useWebp =
        (cfg.format === 'webp' || !cfg.format) && ffmpegHasLibwebp() && dstAbs.endsWith('.webp');
    // Upload pipeline: GPU accelerates decode (frames land on CPU for the fps
    // SW filter), then each selected frame is uploaded to GPU for scale and
    // downloaded before the tile SW filter. Falls back to pure SW scale when
    // no GPU scaler is available for the configured backend.
    const { inputArgs: hwa, scaleVf } = hwaccelUploadPipeline(cfg.hwaccel ?? null);
    const swScale = `scale=${plan.tileW}:-2:flags=fast_bilinear`;
    const tmp = dstAbs + '.tmp.' + crypto.randomBytes(4).toString('hex');
    const run = {
        timeoutMs,
        timeoutMessage: `ffmpeg sprite timed out after ${Math.round(timeoutMs / 1000)} s — will retry on the next scan`,
    };
    const filterChain = `fps=1/${plan.intervalSec},${scaleVf ? scaleVf(plan.tileW) : swScale},tile=${plan.cols}x${plan.rows}`;
    if (useWebp) {
        const args = [
            '-hide_banner',
            '-loglevel',
            'error',
            ...hwa,
            '-i',
            srcAbs,
            '-frames:v',
            '1',
            '-an',
            '-vf',
            filterChain,
            '-c:v',
            'libwebp',
            '-quality',
            String(Math.max(1, Math.min(100, Number(cfg.quality) || 70))),
            '-compression_level',
            '6',
            '-f',
            'webp',
            '-y',
            tmp,
        ];
        try {
            await runFfmpegArgs(args, run);
        } catch (e) {
            try {
                if (existsSync(tmp)) await fs.unlink(tmp);
            } catch {}
            throw e;
        }
        await fs.rename(tmp, dstAbs);
        return;
    }
    // JPEG fallback: render a tiled JPEG, optionally re-encode to WebP via
    // sharp so callers asking for `format:'webp'` on a libwebp-less ffmpeg
    // still get a WebP sprite.
    const jpgTmp = tmp + '.jpg';
    try {
        await runFfmpegArgs(
            [
                '-hide_banner',
                '-loglevel',
                'error',
                ...hwa,
                '-i',
                srcAbs,
                '-frames:v',
                '1',
                '-an',
                '-vf',
                filterChain,
                '-q:v',
                String(Math.max(2, Math.min(31, Math.round(31 - (Number(cfg.quality) || 70) / 4)))),
                '-y',
                jpgTmp,
            ],
            run,
        );
        if (!existsSync(jpgTmp)) throw new Error('ffmpeg produced no sprite');
        if (dstAbs.endsWith('.webp')) {
            await sharp(jpgTmp, { failOn: 'none' })
                .webp({
                    quality: Math.max(1, Math.min(100, Number(cfg.quality) || 70)),
                    effort: 6,
                })
                .toFile(tmp);
            await fs.rename(tmp, dstAbs);
        } else {
            await fs.rename(jpgTmp, dstAbs);
        }
    } finally {
        try {
            if (existsSync(jpgTmp)) await fs.unlink(jpgTmp);
        } catch {}
        try {
            if (existsSync(tmp)) await fs.unlink(tmp);
        } catch {}
    }
}

/**
 * After a sprite is successfully written, reset the NSFW check state
 * for this video (if it was previously marked as checked with a null
 * score because the sprite didn't exist yet) and re-queue it for
 * classification. Dynamic import of nsfw.js avoids a circular static
 * dependency since nsfw.js imports this module.
 */
async function _notifyNsfwSpriteReady(downloadId) {
    try {
        const changed = resetNsfwVideoResult(downloadId);
        if (changed > 0) {
            const { pregenerateNsfw } = await import('../nsfw.js');
            pregenerateNsfw(downloadId);
        }
    } catch {
        /* best-effort — NSFW re-queue is non-critical */
    }
}

// Errors that mean this file can't produce a sprite at all — the scan marks
// such rows failed and never retries them. Anything else (timeouts, sidecar
// hiccups) is retried by the next scan.
const PERMANENT_ERROR_RE =
    /does not contain any stream|no video stream|Invalid data found|Invalid NAL|moov atom not found/i;

export function isPermanentSeekbarError(msg) {
    return PERMANENT_ERROR_RE.test(String(msg || ''));
}

/**
 * How long one sprite encode may take. A sprite pass decodes the whole
 * clip, so this scales with it: 1× the duration, clamped to 5–60 min.
 */
export function spriteBudgetMs(durationSec) {
    const ms = (Number(durationSec) || 0) * 1000;
    return Math.min(60 * 60_000, Math.max(5 * 60_000, ms));
}

// Sidecar job polling starts quick (short clips finish in a second or two)
// and backs off to every 5 s for long encodes.
const POLL_FIRST_MS = 500;
const POLL_MAX_MS = 5000;

function _sleep(ms, signal) {
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(t);
            signal?.removeEventListener('abort', done);
            resolve();
        };
        const t = setTimeout(done, ms);
        signal?.addEventListener('abort', done, { once: true });
    });
}

/**
 * Wait for a job the sidecar accepted to settle, polling
 * `GET /v1/jobs/:id`. Returns the final job, or null if `signal` aborts.
 * `budgetMs` applies to the time spent queued and, afresh, to the encode
 * once it runs. Throws a retryable error when the budget runs out or the
 * sidecar no longer knows the job (404: it keeps only its last 1000 jobs,
 * and none across a restart).
 */
async function _waitForSidecarJob(job, budgetMs, signal) {
    let deadline = Date.now() + budgetMs;
    let running = false;
    let delay = POLL_FIRST_MS;
    while (job.status === 'pending' || job.status === 'running') {
        if (job.status === 'running' && !running) {
            running = true;
            deadline = Date.now() + budgetMs;
        }
        if (Date.now() >= deadline) {
            sidecarCancelJob(job.id).catch(() => {}); // only cancels a still-queued job
            throw new Error(
                `seekbar sidecar still busy after ${Math.round(budgetMs / 1000)} s — will retry on the next scan`,
            );
        }
        await _sleep(delay, signal);
        delay = Math.min(delay * 2, POLL_MAX_MS);
        if (signal?.aborted) {
            sidecarCancelJob(job.id).catch(() => {});
            return null;
        }
        try {
            job = await sidecarGetJob(job.id, signal);
        } catch (e) {
            if (signal?.aborted) return null;
            if (e?.status === 404) {
                throw new Error(
                    'seekbar sidecar no longer tracks the job (restarted?) — will retry on the next scan',
                );
            }
            throw new Error(`seekbar sidecar poll failed: ${e?.message || e}`);
        }
    }
    return job;
}

// One hint per process: a remote sidecar that can't read our videos and
// can't take uploads leaves the work to local ffmpeg.
let _cantReachHintLogged = false;

function _spriteFormatOf(job, fallback) {
    const f = String(job?.format || '').toLowerCase();
    if (f === 'jpg' || f === 'jpeg') return 'jpeg';
    if (f === 'webp') return 'webp';
    const ext = path.extname(String(job?.sprite_path || '')).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return 'jpeg';
    if (ext === '.webp') return 'webp';
    return fallback;
}

function _samePath(a, b) {
    const n = (p) => path.resolve(p).replace(/\\/g, '/');
    return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

function _sizeOf(p) {
    try {
        return statSync(p).size;
    } catch {
        return null;
    }
}

/**
 * Put the sidecar's finished sprite at `dstAbs`. In order:
 *   - it already wrote there (local sidecar, or a shared output dir —
 *     mapped, or unmapped but byte-for-byte the job's size);
 *   - its output path is visible here through the path map → copy;
 *   - otherwise download it (`GET /sprite/:id`, any sidecar version) and
 *     drop the sidecar's staging copy.
 * Throws a retryable error when none works, so the row isn't recorded
 * with a sprite the app can't serve.
 */
async function _collectSidecarSprite(job, id, dstAbs, signal) {
    const local = job.sprite_path ? fromSidecarPath(job.sprite_path) : null;
    if (local && _samePath(local, dstAbs) && existsSync(dstAbs)) return;
    if (local && existsSync(local)) {
        await fs.copyFile(local, dstAbs);
        return;
    }
    const size = _sizeOf(dstAbs);
    if (size && Number(job.bytes) > 0 && size === Number(job.bytes)) return;
    try {
        await sidecarDownloadSprite(job.video_id ?? String(id), dstAbs, { signal });
    } catch (e) {
        throw new Error(
            `seekbar sidecar: sprite not reachable from the app (${e?.message || e}) — will retry on the next scan`,
        );
    }
    sidecarDeleteSprite(job.video_id ?? String(id)).catch(() => {});
}

/**
 * Generate the sprite + JSON for one downloads.id. Returns the metadata
 * row that was written to `seekbar_sprites`, or null if the source
 * couldn't be processed (file missing, ffprobe failed, …).
 *
 * `opts.overwrite` controls deterministic skipping:
 *   'never'      — never regenerate; if sprite + JSON exist, return null
 *   'if-changed' — regenerate only when source size / mtime changed
 *                  since last sprite (default)
 *   'always'     — regenerate regardless of cache state
 */
export async function generateForDownload(row, cfg = null, opts = {}) {
    if (!hasFfmpeg()) return null;
    if (!row || row.id == null) return null;
    if (row.file_type && row.file_type !== 'video') return null;
    const id = Number(row.id);
    if (!Number.isInteger(id) || id <= 0) return null;
    const conf = { ...(cfg || getSeekbarConfig()) };
    const overwrite = opts.overwrite || 'if-changed';
    const srcAbs = _resolveDownloadAbs(row.file_path);
    if (!srcAbs) return { skipped: 'missing' };

    const sourceStat = (() => {
        try {
            const st = statSync(srcAbs);
            return { size: st.size, mtime: Math.floor(st.mtimeMs) };
        } catch {
            return { size: null, mtime: null };
        }
    })();

    const format = conf.format === 'jpeg' || conf.format === 'jpg' ? 'jpeg' : 'webp';
    const dstAbs = _spritePath(id, format);
    const metaAbs = _metaPath(id);

    if (overwrite !== 'always' && existsSync(dstAbs) && existsSync(metaAbs)) {
        if (overwrite === 'never') return null;
        // 'if-changed' — read prior meta and compare source fingerprint.
        try {
            const prior = JSON.parse(await fs.readFile(metaAbs, 'utf8'));
            if (
                prior &&
                prior.source_size === sourceStat.size &&
                prior.source_mtime === sourceStat.mtime &&
                prior.frames > 0
            ) {
                // Sprite exists on disk but DB row may be missing (interrupted
                // scan). Backfill the row so pageMissingSeekbarVideos stops
                // re-selecting this video every scan.
                try {
                    upsertSeekbarSprite({
                        downloadId: id,
                        spritePath: dstAbs,
                        metaPath: metaAbs,
                        durationSec: prior.duration_sec ?? null,
                        frames: prior.frames,
                        cols: prior.cols ?? 0,
                        rows: prior.rows ?? 0,
                        tileW: prior.tile_w ?? 0,
                        tileH: prior.tile_h ?? null,
                        intervalSec: prior.interval_sec ?? null,
                        format: prior.format || format,
                        bytes: prior.bytes ?? null,
                        sourceSize: sourceStat.size,
                        sourceMtime: sourceStat.mtime,
                        generatedAt: prior.generated_at ?? Date.now(),
                    });
                } catch {}
                return null;
            }
        } catch {
            /* unreadable / stale meta → regenerate */
        }
    }

    if (opts.signal?.aborted) return null;
    const duration = await _ffprobeDuration(srcAbs);
    if (opts.signal?.aborted) return null;
    if (!duration) return { skipped: 'no_duration' };

    const plan = planSprite(duration, conf);
    await _ensureSeekbarDir();

    // Prefer the Go sidecar when it's healthy — same on-disk layout, but
    // benefits from the multi-arch hwaccel matrix and the dedicated
    // worker pool. Only a failed submit falls back to in-process ffmpeg
    // (so `npm start` works without the binary): once the sidecar has
    // accepted the job it owns the encode, and a second, local ffmpeg on
    // the same video would just double the work.
    let job = null;
    if (getSidecarUrl()) {
        // A meta file whose sprite is gone would let the sidecar's own
        // cache check (seekbar-service < 0.4.0 shares this file) answer
        // "done" without writing a sprite.
        if (!existsSync(dstAbs) && existsSync(metaAbs)) {
            try {
                await fs.unlink(metaAbs);
            } catch {}
        }
        let submitErr = null;
        try {
            job = await sidecarSubmitOne({
                videoId: String(id),
                srcPath: toSidecarPath(srcAbs),
                async: true,
                cfg: conf,
                // We already decided the sprite is stale (our own cache
                // check above); don't let the sidecar's cache disagree.
                overwrite: 'always',
                signal: opts.signal || null,
            });
        } catch (e) {
            submitErr = e;
        }
        // A sidecar on another host can't read the file: send it over
        // (0.4.0+), in chunks small enough for any reverse proxy.
        if (!job && isSourceNotFound(submitErr) && sidecarHasFeature('upload')) {
            try {
                const uploadId = await sidecarUploadSource(srcAbs, { signal: opts.signal || null });
                job = await sidecarSubmitOne({
                    videoId: String(id),
                    uploadId,
                    async: true,
                    cfg: conf,
                    overwrite: 'always',
                    signal: opts.signal || null,
                });
                submitErr = null;
            } catch (e) {
                submitErr = e;
            }
        }
        if (!job && submitErr) {
            if (opts.signal?.aborted) return null;
            if (isSourceNotFound(submitErr) && !_cantReachHintLogged) {
                _cantReachHintLogged = true;
                console.warn(
                    "[seekbar-generator] the seekbar sidecar can't read the app's videos — set a path mapping for a shared mount, or run seekbar-service 0.4.0+ so videos are uploaded to it. Using local ffmpeg meanwhile.",
                );
            }
            console.warn(
                '[seekbar-generator] sidecar submit failed, falling back to local ffmpeg:',
                String(submitErr?.message || submitErr).slice(0, 160),
            );
        }
    }
    if (job?.id) {
        const r = await _waitForSidecarJob(job, spriteBudgetMs(duration), opts.signal);
        if (!r) return null; // cancelled by the caller
        if (r.status === 'failed') {
            const errMsg = String(r.error || 'unknown error');
            // A bad file stays bad — let the scan mark it. Anything else
            // (hwaccel hiccup, disk full, …) is retried by the next scan.
            if (isPermanentSeekbarError(errMsg)) throw new Error(`ffmpeg: ${errMsg}`);
            throw new Error(`seekbar sidecar: ${errMsg}`);
        }
        if (r.status !== 'done' || !r.sprite_path) {
            throw new Error(`seekbar sidecar job ended as '${r.status}' without a sprite`);
        }
        // The sidecar's own settings may differ from ours (older remote
        // sidecars ignore per-job params) — store under what it produced.
        const outFormat = _spriteFormatOf(r, format);
        const outAbs = _spritePath(id, outFormat);
        await _collectSidecarSprite(r, id, outAbs, opts.signal);
        if (outAbs !== dstAbs && existsSync(dstAbs)) {
            try {
                await fs.unlink(dstAbs); // stale sprite in the other format
            } catch {}
        }
        const outBytes = _sizeOf(outAbs);
        const sidecarMeta = {
            version: 1,
            download_id: id,
            sprite_url: `/api/seekbar/sprite/${id}`,
            meta_url: `/api/seekbar/meta/${id}`,
            duration_sec: r.duration ?? duration,
            frames: r.frames ?? plan.frames,
            cols: r.cols ?? plan.cols,
            rows: r.rows ?? plan.rows,
            tile_w: r.tile_w ?? plan.tileW,
            tile_h: r.tile_h ?? null,
            interval_sec: r.interval_sec ?? plan.intervalSec,
            format: outFormat,
            bytes: outBytes ?? r.bytes ?? null,
            source_size: sourceStat.size,
            source_mtime: sourceStat.mtime,
            generated_at: Date.now(),
        };
        await _writeAtomic(metaAbs, JSON.stringify(sidecarMeta, null, 0));
        upsertSeekbarSprite({
            downloadId: id,
            spritePath: outAbs,
            metaPath: metaAbs,
            durationSec: sidecarMeta.duration_sec,
            frames: sidecarMeta.frames,
            cols: sidecarMeta.cols,
            rows: sidecarMeta.rows,
            tileW: sidecarMeta.tile_w,
            tileH: sidecarMeta.tile_h,
            intervalSec: sidecarMeta.interval_sec,
            format: sidecarMeta.format,
            bytes: sidecarMeta.bytes,
            sourceSize: sourceStat.size,
            sourceMtime: sourceStat.mtime,
            generatedAt: sidecarMeta.generated_at,
        });
        await _notifyNsfwSpriteReady(id);
        return sidecarMeta;
    }

    const timeoutMs = spriteBudgetMs(duration);
    let renderedByGo = false;
    if (gocoreClient.isAvailable('seekbar')) {
        const goTmp = `${dstAbs}.go-tmp-${crypto.randomBytes(4).toString('hex')}`;
        try {
            await gocoreClient.generateSeekbarSprite(srcAbs, goTmp, {
                frames: plan.frames,
                intervalSec: plan.intervalSec,
                cols: plan.cols,
                rows: plan.rows,
                tileWidth: plan.tileW,
                format,
                quality: Math.max(1, Math.min(100, Number(conf.quality) || 70)),
                timeoutMs,
                ffmpegPath: resolveFfmpegBin(),
                hwaccel: conf.hwaccel ?? null,
                signal: opts.signal,
            });
            await fs.rename(goTmp, dstAbs);
            renderedByGo = true;
        } catch (e) {
            if (opts.signal?.aborted) return null;
            console.warn(
                '[seekbar-generator] Go sprite failed, falling back to local ffmpeg:',
                String(e?.message || e).slice(0, 160),
            );
        } finally {
            try {
                await fs.unlink(goTmp);
            } catch {}
        }
    }
    let lastErr = null;
    if (!renderedByGo) {
        for (let attempt = 0; attempt < Math.max(1, Number(conf.maxRetries) || 1) + 1; attempt++) {
            try {
                await _runSpriteFfmpeg({ srcAbs, dstAbs, plan, cfg: conf, timeoutMs });
                lastErr = null;
                break;
            } catch (e) {
                lastErr = e;
                // Neither a bad file nor a clip too long for the budget gets
                // better by running it again right away.
                if (isPermanentSeekbarError(e?.message) || e?.timedOut) break;
                await new Promise((r) => setTimeout(r, 50 + attempt * 100));
            }
        }
    }
    if (lastErr) throw lastErr;
    if (!existsSync(dstAbs)) throw new Error('sprite missing after ffmpeg success');

    const spriteSize = (() => {
        try {
            return statSync(dstAbs).size;
        } catch {
            return null;
        }
    })();
    if (!spriteSize) {
        try {
            await fs.unlink(dstAbs);
        } catch {}
        throw new Error('does not contain any stream (0-byte sprite)');
    }

    const meta = {
        version: 1,
        download_id: id,
        sprite_url: `/api/seekbar/sprite/${id}`,
        meta_url: `/api/seekbar/meta/${id}`,
        duration_sec: duration,
        frames: plan.frames,
        cols: plan.cols,
        rows: plan.rows,
        tile_w: plan.tileW,
        // Real tile height comes from ffmpeg (depends on aspect ratio);
        // the player can compute it from the sprite image's height /
        // rows, but we still emit the tileW here as the canonical width.
        // The viewer reads cols/rows + the sprite image dims to figure
        // tileH at runtime — matches how mediaelement / video.js plugins
        // handle this.
        tile_h: null,
        interval_sec: plan.intervalSec,
        format,
        bytes: spriteSize,
        source_size: sourceStat.size,
        source_mtime: sourceStat.mtime,
        generated_at: Date.now(),
    };
    await _writeAtomic(metaAbs, JSON.stringify(meta, null, 0));

    upsertSeekbarSprite({
        downloadId: id,
        spritePath: dstAbs,
        metaPath: metaAbs,
        durationSec: duration,
        frames: plan.frames,
        cols: plan.cols,
        rows: plan.rows,
        tileW: plan.tileW,
        tileH: null,
        intervalSec: plan.intervalSec,
        format,
        bytes: spriteSize,
        sourceSize: sourceStat.size,
        sourceMtime: sourceStat.mtime,
        generatedAt: meta.generated_at,
    });
    await _notifyNsfwSpriteReady(id);

    return meta;
}
