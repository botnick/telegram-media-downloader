/**
 * Server-side thumbnail generator.
 *
 * Returns a tiny WebP for any download row whose source can be turned
 * into a still image:
 *   - Image source (jpg/png/webp/gif/avif/heic/heif/bmp) →
 *       sharp resize → WebP. Fast. Honors EXIF orientation.
 *   - Video source (mp4/mov/m4v/webm/mkv/...) →
 *       ffmpeg seeks 1 s in, scales + encodes to WebP in a single
 *       pass (no intermediate JPEG → sharp transcode), reading nothing
 *       beyond the first keyframe + the metadata headers. ~10× faster
 *       than the naive grab-frame-then-resize flow.
 *   - Audio source with embedded cover art →
 *       ffmpeg copies the attached_pic stream → sharp resize → WebP.
 *   - Anything else (audio without cover, document) → null
 *       (caller renders an icon).
 *
 * Cache lives at `data/thumbs/<sha-of-id+w>.webp`. Cache hits stat in
 * microseconds and stream from disk; misses fork sharp / ffmpeg once
 * and the result lives forever (or until purged via the Maintenance
 * UI / `purgeThumbsForDownload`).
 *
 * Concurrency:
 *   - Image jobs: 8 in parallel (sharp is mostly libvips C, RAM-bound).
 *   - Video jobs: 3 in parallel (ffmpeg pins a CPU core during decode).
 * Both caps are env-overridable.
 *
 * In-flight dedupe: 50 simultaneous requests for the same (id, w)
 * collapse to a single generation — without this, a fast scroll spawns
 * a job storm for the same tile.
 *
 * Compactness: WebP, quality 70, effort 5 — typically lands ~6-15 KB
 * for a 240-wide image, ~10-25 KB for a video frame. Even a 10 000-tile
 * library tops out around 100-200 MB on disk.
 */

import crypto from 'crypto';
import path from 'path';
import { existsSync, promises as fs } from 'fs';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import sharp from 'sharp';
import { getDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DOWNLOADS_DIR = path.resolve(PROJECT_ROOT, 'data', 'downloads');
const THUMBS_DIR = path.resolve(PROJECT_ROOT, 'data', 'thumbs');

// Resolve the ffmpeg binary lazily and in priority order:
//   1. FFMPEG_PATH env var (operator override).
//   2. System `/usr/bin/ffmpeg` — what `apt-get install ffmpeg` installs
//      in the Docker container. The published image ships ffmpeg this
//      way so video / audio-cover thumbs work out of the box.
//   3. `@ffmpeg-installer/ffmpeg` — bundles prebuilt binaries for
//      Windows / macOS / glibc-Linux (great DX on the maintainer's
//      laptop). Loaded via createRequire so a missing or incompatible
//      package never crashes module load on a host where it isn't
//      usable.
//   4. Plain `ffmpeg` and let PATH resolve it.
const _localRequire = createRequire(import.meta.url);
let _ffmpegBinResolved = null;
// Exported via `resolveFfmpegBin` below so server.js's hwaccel-probe
// endpoint hits the same resolution logic without duplicating env-var
// + path-fallback rules.
function _resolveFfmpegBin() {
    if (_ffmpegBinResolved !== null) return _ffmpegBinResolved;
    if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) {
        return (_ffmpegBinResolved = process.env.FFMPEG_PATH);
    }
    if (existsSync('/usr/bin/ffmpeg')) return (_ffmpegBinResolved = '/usr/bin/ffmpeg');
    if (existsSync('/usr/local/bin/ffmpeg')) return (_ffmpegBinResolved = '/usr/local/bin/ffmpeg');
    try {
        const inst = _localRequire('@ffmpeg-installer/ffmpeg');
        if (inst?.path && existsSync(inst.path)) return (_ffmpegBinResolved = inst.path);
    } catch { /* package missing or wrong arch — fall through */ }
    return (_ffmpegBinResolved = 'ffmpeg');
}

// Public-friendly wrapper for the resolver above — same value, just
// callable from outside the module (server.js hwaccel-probe endpoint).
export function resolveFfmpegBin() { return _resolveFfmpegBin(); }

// Returns true if a workable ffmpeg is on this host. The video / audio
// generators consult this so a host without ffmpeg cleanly returns null
// (caller shows an icon) instead of throwing on every miss.
let _ffmpegOk = null;
export function hasFfmpeg() {
    if (_ffmpegOk !== null) return _ffmpegOk;
    const bin = _resolveFfmpegBin();
    if (bin !== 'ffmpeg' && existsSync(bin)) return (_ffmpegOk = true);
    try {
        const r = spawnSync(bin, ['-version'], { windowsHide: true });
        return (_ffmpegOk = r.status === 0);
    } catch { return (_ffmpegOk = false); }
}

// Detect libwebp at startup (cached). Stripped musl/Alpine ffmpeg builds
// frequently omit it — when missing, single-pass `-c:v libwebp` fails on
// every video and we'd produce zero thumbs. Knowing up-front lets the
// generator pick the JPEG → sharp WebP fallback path automatically.
let _ffmpegLibwebp = null;
function _ffmpegHasLibwebp() {
    if (_ffmpegLibwebp !== null) return _ffmpegLibwebp;
    if (!hasFfmpeg()) return (_ffmpegLibwebp = false);
    try {
        const r = spawnSync(_resolveFfmpegBin(), ['-hide_banner', '-encoders'], { windowsHide: true });
        if (r.status !== 0) return (_ffmpegLibwebp = false);
        const out = (r.stdout || Buffer.alloc(0)).toString('utf8');
        return (_ffmpegLibwebp = /\blibwebp\b/.test(out));
    } catch { return (_ffmpegLibwebp = false); }
}

// Encoding parameters — quality / effort kept in one place so the
// Maintenance "rebuild thumbs" path can replay against the same knobs.
//
// 70 / effort 6 is the sweet spot for thumbnails: the difference
// between effort 5 → 6 trims ~5-10% off the bytes for a few extra ms of
// encode time, but encode happens ONCE per (id, width) and the file
// lives forever, so we pay it gladly. Quality 70 looks identical to 80
// at 240-px width to a human eye but is materially smaller.
const WEBP_QUALITY = 70;            // 0-100
const SHARP_EFFORT = 6;             // 0-6 — max compression
const FFMPEG_WEBP_QUALITY = 70;     // libwebp -quality
const FFMPEG_WEBP_COMPRESSION = 6;  // libwebp -compression_level 0-6

// sharp can run multiple jobs concurrently; ffmpeg pins a core. Cap them
// separately so the more expensive video work doesn't starve image work.
const IMG_CONCURRENCY = Math.max(1, Math.min(32, Number(process.env.THUMBS_IMG_CONCURRENCY) || 8));
const VID_CONCURRENCY = Math.max(1, Math.min(8,  Number(process.env.THUMBS_VID_CONCURRENCY) || 3));

function makeSemaphore(max) {
    let active = 0;
    const queue = [];
    return {
        acquire() {
            return new Promise((resolve) => {
                if (active < max) { active++; resolve(); return; }
                queue.push(resolve);
            });
        },
        release() {
            active--;
            const next = queue.shift();
            if (next) { active++; next(); }
        },
    };
}
const _imgSem = makeSemaphore(IMG_CONCURRENCY);
const _vidSem = makeSemaphore(VID_CONCURRENCY);

// In-flight dedupe — same (id, w) requested 50× collapses to one job.
const _inflight = new Map(); // cacheKey → Promise

// Width must be one of these. Restricting the input keeps the cache
// from exploding and dodges DoS-by-querystring (a hostile caller can't
// fork a generation per pixel).
export const ALLOWED_WIDTHS = [120, 200, 240, 320, 480];
export const DEFAULT_WIDTH = 240;

export function clampWidth(w) {
    const n = parseInt(w, 10);
    if (!Number.isFinite(n)) return DEFAULT_WIDTH;
    let best = ALLOWED_WIDTHS[0];
    let bestDist = Math.abs(n - best);
    for (const cand of ALLOWED_WIDTHS) {
        const d = Math.abs(n - cand);
        if (d < bestDist) { best = cand; bestDist = d; }
    }
    return best;
}

function _cacheKey(downloadId, width) {
    return crypto.createHash('sha256')
        .update(`${downloadId}:${width}`)
        .digest('hex')
        .slice(0, 32);
}

function _cachePath(downloadId, width) {
    return path.join(THUMBS_DIR, `${_cacheKey(downloadId, width)}.webp`);
}

async function _ensureThumbsDir() {
    if (!existsSync(THUMBS_DIR)) {
        await fs.mkdir(THUMBS_DIR, { recursive: true });
    }
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

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.heic', '.heif', '.bmp', '.tif', '.tiff']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.flv', '.wmv', '.mpg', '.mpeg', '.3gp', '.ts', '.ogv']);
const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.flac', '.ogg', '.opus', '.wav', '.aac', '.wma', '.alac']);

function _kindFromPath(absPath, declaredType) {
    if (declaredType === 'photo' || declaredType === 'image' || declaredType === 'sticker') return 'image';
    if (declaredType === 'video') return 'video';
    if (declaredType === 'audio') return 'audio';
    const ext = path.extname(absPath).toLowerCase();
    if (IMAGE_EXTS.has(ext)) return 'image';
    if (VIDEO_EXTS.has(ext)) return 'video';
    if (AUDIO_EXTS.has(ext)) return 'audio';
    return null;
}

// ---- Generators ------------------------------------------------------------

async function _generateImageThumb(srcAbs, width, dstAbs) {
    // failOn: 'none'  → tolerate slightly malformed inputs (truncated
    //                  GIFs, weird ICC profiles).
    // rotate()        → honor EXIF orientation BEFORE resize so a portrait
    //                  phone shot doesn't render sideways.
    // withoutEnlargement → small originals stay small (no upscale waste).
    await sharp(srcAbs, { failOn: 'none' })
        .rotate()
        .resize({ width, withoutEnlargement: true, fit: 'inside' })
        .webp({ quality: WEBP_QUALITY, effort: SHARP_EFFORT })
        .toFile(dstAbs);
}

function _runFfmpeg(args) {
    return new Promise((resolve, reject) => {
        const p = spawn(_resolveFfmpegBin(), args, { windowsHide: true });
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

// Hardware acceleration prefix for ffmpeg. Two configuration paths,
// both opt-in (default off → pure-CPU decode that works everywhere):
//
//   1. **Admin UI**: Settings → Advanced → "Video thumb hardware
//      acceleration" dropdown (`config.advanced.thumbs.hwaccel`). Live-
//      reads on every thumb job so changes take effect without a
//      restart. The setter is validated against the allow-list below.
//   2. **Env var override**: `FFMPEG_HWACCEL=<backend>` for headless
//      deploys where the operator can't reach the dashboard yet. Wins
//      over the config when set.
//
// Allow-listed backends:
//   vaapi        — Intel iGPU + AMD on Linux/Docker (needs /dev/dri)
//   qsv          — Intel Quick Sync (alternative VAAPI driver)
//   cuda         — NVIDIA NVDEC
//   videotoolbox — macOS (Intel + Apple Silicon)
//   d3d11va      — Windows 8+ DirectX 11 video acceleration
//   dxva2        — older Windows DirectX video acceleration
//
// Anything else (including empty / unknown) falls through to a no-op.
//
// The single-pass libwebp encode path needs frames in CPU memory by
// the time the encoder runs, so we ask the decoder to upload to GPU
// (`-hwaccel <x>`) but skip the `-hwaccel_output_format` flag. ffmpeg
// does an implicit download before the encoder. Net win is ~3-5× on
// Intel iGPU vs. pure CPU decode even without staying on the GPU.
const _HWACCEL_ALLOW = new Set(['vaapi', 'cuda', 'qsv', 'videotoolbox', 'd3d11va', 'dxva2']);

let _hwaccelConfigCache = { at: 0, value: '' };
const _HWACCEL_CACHE_TTL_MS = 30 * 1000;

async function _hwaccelFromConfig() {
    const now = Date.now();
    if ((now - _hwaccelConfigCache.at) < _HWACCEL_CACHE_TTL_MS) return _hwaccelConfigCache.value;
    let value = '';
    try {
        const cfgPath = path.join(PROJECT_ROOT, 'data', 'config.json');
        if (existsSync(cfgPath)) {
            const raw = await fs.readFile(cfgPath, 'utf8');
            const parsed = JSON.parse(raw);
            const v = String(parsed?.advanced?.thumbs?.hwaccel || '').toLowerCase().trim();
            if (_HWACCEL_ALLOW.has(v)) value = v;
        }
    } catch { /* missing / corrupt config → CPU fallback, never throw */ }
    _hwaccelConfigCache = { at: now, value };
    return value;
}

async function _hwaccelPrefix() {
    // Env var takes precedence — power-user / headless override.
    const env = String(process.env.FFMPEG_HWACCEL || '').toLowerCase().trim();
    if (env && _HWACCEL_ALLOW.has(env)) return ['-hwaccel', env];
    const cfg = await _hwaccelFromConfig();
    return cfg ? ['-hwaccel', cfg] : [];
}

async function _generateVideoThumb(srcAbs, width, dstAbs) {
    // Two paths, picked once at boot from `_ffmpegHasLibwebp()`:
    //   • Fast (libwebp present): single-pass — seek + scale + libwebp encode
    //     all inside ffmpeg. Reads only the first keyframe + headers. ~10×
    //     faster than the naive grab-frame-then-resize flow.
    //   • Fallback (libwebp missing): write a temp JPEG via ffmpeg, then
    //     hand it to sharp for the WebP encode. Bulletproof on stripped
    //     ffmpeg builds (Alpine/musl, Windows static binaries).
    // The seek tries 1 s first (skips opening titles); a fallback to 0 s
    // handles ultra-short clips where seeking past the end yields no frame.
    const useSinglePass = _ffmpegHasLibwebp();
    const hwa = await _hwaccelPrefix();
    const tryAt = useSinglePass
        ? async (sec) => {
            const args = [
                '-hide_banner', '-loglevel', 'error',
                ...hwa,
                '-ss', String(sec),
                '-i', srcAbs,
                '-frames:v', '1',
                '-an',
                '-vf', `scale='min(${width},iw)':-2:flags=fast_bilinear`,
                '-c:v', 'libwebp',
                '-quality', String(FFMPEG_WEBP_QUALITY),
                '-compression_level', String(FFMPEG_WEBP_COMPRESSION),
                '-y',
                dstAbs,
            ];
            await _runFfmpeg(args);
        }
        : async (sec) => {
            const tmpJpg = dstAbs + '.frame.jpg';
            try {
                await _runFfmpeg([
                    '-hide_banner', '-loglevel', 'error',
                    '-ss', String(sec),
                    '-i', srcAbs,
                    '-frames:v', '1',
                    '-an',
                    '-vf', `scale='min(${width},iw)':-2:flags=fast_bilinear`,
                    '-q:v', '3',
                    '-y',
                    tmpJpg,
                ]);
                if (existsSync(tmpJpg)) {
                    await sharp(tmpJpg, { failOn: 'none' })
                        .rotate()
                        .resize({ width, withoutEnlargement: true, fit: 'inside' })
                        .webp({ quality: WEBP_QUALITY, effort: SHARP_EFFORT })
                        .toFile(dstAbs);
                }
            } finally {
                try { if (existsSync(tmpJpg)) await fs.unlink(tmpJpg); } catch { /* best-effort */ }
            }
        };
    try {
        await tryAt(1);
        if (!existsSync(dstAbs)) await tryAt(0);
    } catch (_e) {
        // First try failed (common on very short clips) — fall back to t=0.
        await tryAt(0);
    }
}

async function _generateAudioThumb(srcAbs, width, dstAbs) {
    // Pull the embedded cover-art (attached_pic stream) into a temp jpg,
    // then let sharp size + encode it. ID3v2 / Vorbis / FLAC pictures are
    // all surfaced this way by ffmpeg. If there's no cover, the ffmpeg
    // call exits non-zero and we propagate so getOrCreateThumb returns
    // null and the UI renders the audio icon instead.
    const tmpJpg = dstAbs + '.cover.jpg';
    try {
        await _runFfmpeg([
            '-hide_banner', '-loglevel', 'error',
            '-i', srcAbs,
            '-an',
            '-vcodec', 'copy',
            '-map', '0:v?',
            '-y',
            tmpJpg,
        ]);
        if (!existsSync(tmpJpg)) throw new Error('no cover art');
        await sharp(tmpJpg, { failOn: 'none' })
            .resize({ width, withoutEnlargement: true, fit: 'inside' })
            .webp({ quality: WEBP_QUALITY, effort: SHARP_EFFORT })
            .toFile(dstAbs);
    } finally {
        try { if (existsSync(tmpJpg)) await fs.unlink(tmpJpg); } catch {}
    }
}

// ---- Public API ------------------------------------------------------------

/**
 * Resolve (or generate) the on-disk WebP thumbnail for a downloads.id
 * at the given width. Returns `{ path, width, mtime }` on success, or
 * `null` when the source can't be thumbnailed.
 *
 * Thread-safe: multiple concurrent calls for the same (id, width) wait
 * on a single in-flight generation.
 */
export async function getOrCreateThumb(downloadId, widthHint) {
    const id = parseInt(downloadId, 10);
    if (!Number.isInteger(id) || id <= 0) return null;
    const width = clampWidth(widthHint);
    const cacheAbs = _cachePath(id, width);

    // Cache hit — by far the hot path once a gallery has scrolled once.
    if (existsSync(cacheAbs)) {
        try {
            const st = await fs.stat(cacheAbs);
            return { path: cacheAbs, width, mtime: st.mtimeMs };
        } catch { /* fall through — regenerate */ }
    }

    const row = getDb().prepare(
        'SELECT file_path, file_type FROM downloads WHERE id = ?'
    ).get(id);
    if (!row) return null;
    const srcAbs = _resolveDownloadAbs(row.file_path);
    if (!srcAbs) return null;

    const kind = _kindFromPath(srcAbs, row.file_type);
    if (!kind) return null;

    const inflightKey = `${id}:${width}`;
    if (_inflight.has(inflightKey)) {
        try { await _inflight.get(inflightKey); } catch { /* swallow */ }
        if (existsSync(cacheAbs)) {
            const st = await fs.stat(cacheAbs);
            return { path: cacheAbs, width, mtime: st.mtimeMs };
        }
        return null;
    }

    const sem = (kind === 'image' || kind === 'audio') ? _imgSem : _vidSem;
    const job = (async () => {
        await _ensureThumbsDir();
        await sem.acquire();
        const tmpAbs = cacheAbs + '.tmp';
        try {
            if (kind === 'image') {
                await _generateImageThumb(srcAbs, width, tmpAbs);
            } else if (kind === 'video') {
                await _generateVideoThumb(srcAbs, width, tmpAbs);
            } else {
                // audio
                await _generateAudioThumb(srcAbs, width, tmpAbs);
            }
            // Atomic publish — the .tmp → final rename means a partial
            // file never becomes a "valid" cache hit on crash mid-write.
            if (existsSync(tmpAbs)) await fs.rename(tmpAbs, cacheAbs);
        } finally {
            try { if (existsSync(tmpAbs)) await fs.unlink(tmpAbs); } catch {}
            sem.release();
        }
    })();
    _inflight.set(inflightKey, job);
    try {
        await job;
    } catch (_e) {
        // Audio with no cover art ends up here as well — that's expected.
        return null;
    } finally {
        _inflight.delete(inflightKey);
    }

    if (!existsSync(cacheAbs)) return null;
    const st = await fs.stat(cacheAbs);
    return { path: cacheAbs, width, mtime: st.mtimeMs };
}

/**
 * Background pre-generation hook — fired by the downloader right after
 * a successful insert so the FIRST gallery scroll already finds the
 * thumb in cache. Generates only the default width to keep boot-time
 * cost predictable; widening hits the on-demand generator. Failures
 * (no cover art, weird container) are silent — the on-demand path will
 * try again and fall through to an icon if needed.
 */
export function pregenerateThumb(downloadId) {
    queueMicrotask(() => {
        getOrCreateThumb(downloadId, DEFAULT_WIDTH).catch(() => {});
    });
}

/**
 * Drop the on-disk cache for one download id (every cached width).
 * Called when a file is deleted / replaced so the next request
 * regenerates against the new bytes.
 */
export async function purgeThumbsForDownload(downloadId) {
    if (!existsSync(THUMBS_DIR)) return 0;
    const id = parseInt(downloadId, 10);
    if (!Number.isInteger(id) || id <= 0) return 0;
    let removed = 0;
    for (const w of ALLOWED_WIDTHS) {
        const p = _cachePath(id, w);
        if (existsSync(p)) {
            try { await fs.unlink(p); removed++; } catch {}
        }
    }
    return removed;
}

/** Wipe the entire thumbs cache. Used by Maintenance "Rebuild thumbs". */
export async function purgeAllThumbs() {
    if (!existsSync(THUMBS_DIR)) return 0;
    const names = await fs.readdir(THUMBS_DIR).catch(() => []);
    let removed = 0;
    for (const n of names) {
        if (!n.endsWith('.webp') && !n.endsWith('.tmp')) continue;
        try { await fs.unlink(path.join(THUMBS_DIR, n)); removed++; } catch {}
    }
    return removed;
}

/**
 * Build thumbnails for every download row that doesn't already have a
 * cached default-width thumb. Used by the Maintenance "Build thumbnails
 * for older files" button — covers everything that landed before
 * v2.3.29 introduced auto-generation.
 *
 * Honours the same per-kind concurrency caps as on-demand generation,
 * so kicking this off from the UI never starves the gallery. Each
 * processed row fires `onProgress({stage,processed,total,built,skipped,errored})`
 * — server.js forwards this over WS so the UI can render a determinate
 * progress bar.
 *
 * @param {Object} [opts]
 * @param {(p: object) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ scanned:number, built:number, skipped:number, errored:number }>}
 */
export async function buildAllThumbnails(opts = {}) {
    const { onProgress, signal } = opts;
    const rows = getDb().prepare(`
        SELECT id FROM downloads
         WHERE file_path IS NOT NULL
         ORDER BY created_at DESC
    `).all();
    const total = rows.length;
    let processed = 0, built = 0, skipped = 0, errored = 0;

    const tick = () => {
        if (onProgress) onProgress({ stage: 'building', processed, total, built, skipped, errored });
    };
    tick();

    for (const r of rows) {
        if (signal?.aborted) break;
        processed++;
        const cacheAbs = _cachePath(r.id, DEFAULT_WIDTH);
        if (existsSync(cacheAbs)) { skipped++; if (processed % 25 === 0 || processed === total) tick(); continue; }
        try {
            const thumb = await getOrCreateThumb(r.id, DEFAULT_WIDTH);
            if (thumb) built++;
            else skipped++;
        } catch {
            errored++;
        }
        if (processed % 10 === 0 || processed === total) tick();
    }

    if (onProgress) onProgress({ stage: 'done', processed, total, built, skipped, errored });
    return { scanned: total, built, skipped, errored };
}

/** Stat the cache directory — used by the Maintenance UI to show usage. */
export async function getThumbsCacheStats() {
    if (!existsSync(THUMBS_DIR)) return { count: 0, bytes: 0 };
    const names = await fs.readdir(THUMBS_DIR).catch(() => []);
    let count = 0, bytes = 0;
    for (const n of names) {
        if (!n.endsWith('.webp')) continue;
        try {
            const st = await fs.stat(path.join(THUMBS_DIR, n));
            count++;
            bytes += st.size;
        } catch {}
    }
    return { count, bytes };
}

export const THUMBS_PATHS = { DOWNLOADS_DIR, THUMBS_DIR };
