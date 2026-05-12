/**
 * Server-side thumbnail generator.
 *
 * Returns a tiny WebP for any download row whose source can be turned
 * into a still image:
 *   - Image source (jpg/png/gif/avif/heic/heif/bmp) →
 *       sharp resize → WebP. Fast. Honors EXIF orientation.
 *   - WebP source → skipped (already web-native; gallery falls back to
 *       the original file URL so no re-encode or ffmpeg involvement).
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
 * Compactness: WebP, quality 62, effort 6 — typically lands ~6-12 KB
 * for a 320-wide image, ~9-20 KB for a video frame. Single canonical
 * width means one cached file per source, so even a 100 000-tile
 * library tops out around 800 MB - 1.5 GB on disk.
 */

import crypto from 'crypto';
import path from 'path';
import { existsSync, promises as fs } from 'fs';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import sharp from 'sharp';
import { getDb } from './db.js';
import { loadConfig } from '../config/manager.js';

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
    } catch {
        /* package missing or wrong arch — fall through */
    }
    return (_ffmpegBinResolved = 'ffmpeg');
}

// Public-friendly wrapper for the resolver above — same value, just
// callable from outside the module (server.js hwaccel-probe endpoint).
export function resolveFfmpegBin() {
    return _resolveFfmpegBin();
}

// Resolve ffprobe in the same priority order as ffmpeg:
//   1. FFPROBE_PATH env var
//   2. System /usr/bin/ffprobe (Docker / apt)
//   3. Sibling of the resolved ffmpeg binary (e.g. Gyan builds ship both)
//   4. @ffprobe-installer/ffprobe bundled binary
//   5. Plain `ffprobe` and let PATH resolve it.
let _ffprobeBinResolved = null;
function _resolveFfprobeBin() {
    if (_ffprobeBinResolved !== null) return _ffprobeBinResolved;
    if (process.env.FFPROBE_PATH && existsSync(process.env.FFPROBE_PATH)) {
        return (_ffprobeBinResolved = process.env.FFPROBE_PATH);
    }
    if (existsSync('/usr/bin/ffprobe')) return (_ffprobeBinResolved = '/usr/bin/ffprobe');
    if (existsSync('/usr/local/bin/ffprobe')) return (_ffprobeBinResolved = '/usr/local/bin/ffprobe');
    try {
        const ffmpeg = _resolveFfmpegBin();
        if (ffmpeg && ffmpeg !== 'ffmpeg') {
            const sibling = ffmpeg.endsWith('.exe')
                ? ffmpeg.slice(0, -'ffmpeg.exe'.length) + 'ffprobe.exe'
                : ffmpeg.slice(0, -'ffmpeg'.length) + 'ffprobe';
            if (existsSync(sibling)) return (_ffprobeBinResolved = sibling);
        }
    } catch {}
    try {
        const inst = _localRequire('@ffprobe-installer/ffprobe');
        if (inst?.path && existsSync(inst.path)) return (_ffprobeBinResolved = inst.path);
    } catch {
        /* package missing or wrong arch — fall through */
    }
    return (_ffprobeBinResolved = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
}

export function resolveFfprobeBin() {
    return _resolveFfprobeBin();
}

// hwaccel candidates the dropdown allows. Kept aligned with the
// HWACCEL_ALLOW set in server.js POST /api/config so a probe result
// always maps to a value the dropdown will accept.
const HWACCEL_KNOWN = [
    'vaapi',
    'qsv',
    'cuda',
    'videotoolbox',
    'd3d11va',
    'dxva2',
    'opencl',
    'vulkan',
];
const HWACCEL_PROBE_TIMEOUT_MS = 5000;

/**
 * Probe ffmpeg for hardware-acceleration backends that are BOTH compiled
 * into the local binary AND can actually initialise a device on this
 * host. The compile-in list (`ffmpeg -hwaccels`) is misleading on its
 * own — it lists every method the build was configured with, even when
 * the driver is missing or `/dev/dri` isn't passed into Docker. Some
 * Windows ffmpeg builds also print the same method twice. We dedupe,
 * then run `-init_hw_device <name>=hw` against each candidate; only
 * those whose init succeeds end up in `available`. A short timeout
 * guards against a hung driver init on a misconfigured GPU.
 *
 * @returns {Promise<{compiledIn:string[], available:string[], ffmpegPath:string}>}
 */
export async function probeHwaccel() {
    const bin = _resolveFfmpegBin();
    const out = await new Promise((resolve) => {
        const chunks = [];
        try {
            const p = spawn(bin, ['-hide_banner', '-hwaccels'], { windowsHide: true });
            p.stdout.on('data', (c) => chunks.push(c));
            p.stderr.on('data', () => {});
            p.on('error', () => resolve(''));
            p.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
        } catch {
            resolve('');
        }
    });
    const compiledIn = [
        ...new Set(
            out
                .split(/\r?\n/)
                .map((s) => s.trim().toLowerCase())
                .filter((s) => HWACCEL_KNOWN.includes(s)),
        ),
    ];

    const probes = await Promise.all(
        compiledIn.map(
            (name) =>
                new Promise((resolve) => {
                    let settled = false;
                    const finish = (ok) => {
                        if (settled) return;
                        settled = true;
                        resolve({ name, ok });
                    };
                    let p;
                    try {
                        p = spawn(
                            bin,
                            [
                                '-hide_banner',
                                '-v',
                                'error',
                                '-init_hw_device',
                                `${name}=hw`,
                                '-f',
                                'lavfi',
                                '-i',
                                'nullsrc=s=2x2:d=0.04',
                                '-frames:v',
                                '1',
                                '-f',
                                'null',
                                '-',
                            ],
                            { windowsHide: true },
                        );
                    } catch {
                        finish(false);
                        return;
                    }
                    const timer = setTimeout(() => {
                        try {
                            p.kill('SIGKILL');
                        } catch {}
                        finish(false);
                    }, HWACCEL_PROBE_TIMEOUT_MS);
                    p.stdout.on('data', () => {});
                    p.stderr.on('data', () => {});
                    p.on('error', () => {
                        clearTimeout(timer);
                        finish(false);
                    });
                    p.on('close', (code) => {
                        clearTimeout(timer);
                        finish(code === 0);
                    });
                }),
        ),
    );
    const available = probes.filter((p) => p.ok).map((p) => p.name);
    return { compiledIn, available, ffmpegPath: bin };
}

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
    } catch {
        return (_ffmpegOk = false);
    }
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
        const r = spawnSync(_resolveFfmpegBin(), ['-hide_banner', '-encoders'], {
            windowsHide: true,
        });
        if (r.status !== 0) return (_ffmpegLibwebp = false);
        const out = (r.stdout || Buffer.alloc(0)).toString('utf8');
        return (_ffmpegLibwebp = /\blibwebp\b/.test(out));
    } catch {
        return (_ffmpegLibwebp = false);
    }
}

// Encoding parameters — quality / effort kept in one place so the
// Maintenance "rebuild thumbs" path can replay against the same knobs.
//
// v2.x size-reduction tuning (validated against a sample 320-px library):
//   • quality 70 → 62        ≈ -25% bytes; visual delta at 320-px tile
//                              width is imperceptible to the unaided eye
//                              (sub-pixel chroma drift only).
//   • sharp effort 5 → 6     ≈ -8% bytes for ~+15% CPU on the encode.
//                              The encode happens ONCE per (id, width)
//                              and the cache lives forever — we pay the
//                              CPU gladly.
//   • libwebp compression_level already maxed at 6 in v2.x; quality
//                              tracks WEBP_QUALITY so the video / audio
//                              cover paths shrink in lockstep.
// Net: ~30-33% smaller WebPs at parity perceived quality. Combined with
// the v2.x "single canonical width" collapse below, total on-disk thumb
// footprint settles at roughly 20% of the v2.13.x baseline.
const WEBP_QUALITY = 62; // 0-100
const SHARP_EFFORT = 6; // 0-6 — max compression
const FFMPEG_WEBP_QUALITY = 62; // libwebp -quality
const FFMPEG_WEBP_COMPRESSION = 6; // libwebp -compression_level 0-6

// sharp can run multiple jobs concurrently; ffmpeg pins a core. Cap them
// separately so the more expensive video work doesn't starve image work.
const IMG_CONCURRENCY = Math.max(1, Math.min(32, Number(process.env.THUMBS_IMG_CONCURRENCY) || 8));
const VID_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.THUMBS_VID_CONCURRENCY) || 3));

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
const _imgSem = makeSemaphore(IMG_CONCURRENCY);
const _vidSem = makeSemaphore(VID_CONCURRENCY);

// In-flight dedupe — same (id, w) requested 50× collapses to one job.
const _inflight = new Map(); // cacheKey → Promise

// v2.x collapsed the thumb cache from five widths (120 / 200 / 240 / 320 /
// 480 px) to a single canonical 320-px width. Every gallery tile now
// renders at 320 css px on both desktop and mobile, so a single cached
// WebP hits 100% of the time — no more per-viewport regenerations, no
// more 5× duplicate WebPs per source. clampWidth() still exists and
// still snaps any caller-supplied value to the canonical width, so
// stale `?w=120` URLs on bookmarked tabs continue to work; they just
// resolve to the same on-disk file the gallery already cached.
// Net effect on the operator's disk: ~80% smaller thumbs/ directory
// at parity coverage (5 widths → 1, plus the -30% quality/effort win).
export const ALLOWED_WIDTHS = [320];
export const DEFAULT_WIDTH = 320;

export function clampWidth(_w) {
    // Single canonical width — every caller resolves to the same file
    // regardless of the requested ?w=. Kept as a function (not inlined)
    // so legacy callers building `?w=<N>` URLs don't need to change.
    return DEFAULT_WIDTH;
}

function _cacheKey(downloadId, width) {
    return crypto.createHash('sha256').update(`${downloadId}:${width}`).digest('hex').slice(0, 32);
}

function _cachePath(downloadId, width) {
    return path.join(THUMBS_DIR, `${_cacheKey(downloadId, width)}.webp`);
}

/**
 * Cheap existence check used by the Build thumbnails gallery list endpoint
 * to decorate each row with `cached:true|false`. No I/O beyond `existsSync`,
 * no DB lookup — safe to call inside a per-row map().
 */
export function hasCachedThumb(downloadId, width = DEFAULT_WIDTH) {
    const id = parseInt(downloadId, 10);
    if (!Number.isInteger(id) || id <= 0) return false;
    return existsSync(_cachePath(id, width));
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

const IMAGE_EXTS = new Set([
    '.jpg',
    '.jpeg',
    '.png',
    '.webp',
    '.gif',
    '.avif',
    '.heic',
    '.heif',
    '.bmp',
    '.tif',
    '.tiff',
]);
const VIDEO_EXTS = new Set([
    '.mp4',
    '.mov',
    '.m4v',
    '.webm',
    '.mkv',
    '.avi',
    '.flv',
    '.wmv',
    '.mpg',
    '.mpeg',
    '.3gp',
    '.ts',
    '.ogv',
]);
const AUDIO_EXTS = new Set([
    '.mp3',
    '.m4a',
    '.flac',
    '.ogg',
    '.opus',
    '.wav',
    '.aac',
    '.wma',
    '.alac',
]);

function _kindFromPath(absPath, declaredType) {
    if (declaredType === 'photo' || declaredType === 'image' || declaredType === 'sticker')
        return 'image';
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

function _hwaccelFromConfig() {
    const now = Date.now();
    if (now - _hwaccelConfigCache.at < _HWACCEL_CACHE_TTL_MS) return _hwaccelConfigCache.value;
    let value = '';
    try {
        // Pre-v2.7 read the legacy `data/config.json` file directly,
        // which silently broke after the JSON→SQLite state migration
        // archived the file to `*.migrated`. Source the value from the
        // canonical kv['config'] row via loadConfig() instead so a
        // dashboard-set `advanced.thumbs.hwaccel` actually takes effect.
        const cfg = loadConfig();
        const v = String(cfg?.advanced?.thumbs?.hwaccel || '')
            .toLowerCase()
            .trim();
        if (_HWACCEL_ALLOW.has(v)) value = v;
    } catch {
        /* missing / corrupt config → CPU fallback, never throw */
    }
    _hwaccelConfigCache = { at: now, value };
    return value;
}

async function _hwaccelPrefix() {
    // Env var takes precedence — power-user / headless override.
    const env = String(process.env.FFMPEG_HWACCEL || '')
        .toLowerCase()
        .trim();
    if (env && _HWACCEL_ALLOW.has(env)) return ['-hwaccel', env];
    const cfg = await _hwaccelFromConfig();
    return cfg ? ['-hwaccel', cfg] : [];
}

// Public wrapper for callers outside this module (seekbar generator,
// future video encoders). Accepts an explicit `override` so the caller
// can pin a backend (e.g. seekbar's per-feature override) without going
// through the kv config / env cascade. `override` of `null` / `undefined`
// falls back to the cascade; an empty string forces CPU.
export async function hwaccelPrefix(override) {
    if (override === null || override === undefined) return _hwaccelPrefix();
    const v = String(override).toLowerCase().trim();
    if (v === '') return [];
    if (_HWACCEL_ALLOW.has(v)) return ['-hwaccel', v];
    // Unknown override → fall back to the cascade rather than crashing.
    return _hwaccelPrefix();
}

// Public ffmpeg arg-runner. Exported so the seekbar module can spawn a
// sprite encode without copy/pasting the stderr-capture wrapper.
export function runFfmpegArgs(args) {
    return _runFfmpeg(args);
}

// True when the local ffmpeg build links libwebp. Seekbar uses this to
// pick between the single-pass `-c:v libwebp` path and the JPEG fallback,
// mirroring the thumbs.js gate.
export function ffmpegHasLibwebp() {
    return _ffmpegHasLibwebp();
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
                  '-hide_banner',
                  '-loglevel',
                  'error',
                  ...hwa,
                  '-ss',
                  String(sec),
                  '-i',
                  srcAbs,
                  '-frames:v',
                  '1',
                  '-an',
                  '-vf',
                  `scale='min(${width},iw)':-2:flags=fast_bilinear`,
                  '-c:v',
                  'libwebp',
                  '-quality',
                  String(FFMPEG_WEBP_QUALITY),
                  '-compression_level',
                  String(FFMPEG_WEBP_COMPRESSION),
                  // Force the WebP muxer explicitly. dstAbs ends in `.webp.tmp`
                  // for atomic-rename writes; ffmpeg on Debian/Ubuntu won't
                  // infer the format from the `.tmp` suffix and dies with
                  // "Unable to find a suitable output format" on every video.
                  '-f',
                  'webp',
                  '-y',
                  dstAbs,
              ];
              await _runFfmpeg(args);
          }
        : async (sec) => {
              const tmpJpg = dstAbs + '.frame.jpg';
              try {
                  await _runFfmpeg([
                      '-hide_banner',
                      '-loglevel',
                      'error',
                      '-ss',
                      String(sec),
                      '-i',
                      srcAbs,
                      '-frames:v',
                      '1',
                      '-an',
                      '-vf',
                      `scale='min(${width},iw)':-2:flags=fast_bilinear`,
                      '-q:v',
                      '3',
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
                  try {
                      if (existsSync(tmpJpg)) await fs.unlink(tmpJpg);
                  } catch {
                      /* best-effort */
                  }
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
            '-hide_banner',
            '-loglevel',
            'error',
            '-i',
            srcAbs,
            '-an',
            '-vcodec',
            'copy',
            '-map',
            '0:v?',
            '-y',
            tmpJpg,
        ]);
        if (!existsSync(tmpJpg)) throw new Error('no cover art');
        await sharp(tmpJpg, { failOn: 'none' })
            .resize({ width, withoutEnlargement: true, fit: 'inside' })
            .webp({ quality: WEBP_QUALITY, effort: SHARP_EFFORT })
            .toFile(dstAbs);
    } finally {
        try {
            if (existsSync(tmpJpg)) await fs.unlink(tmpJpg);
        } catch {}
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
        } catch {
            /* fall through — regenerate */
        }
    }

    const row = getDb().prepare('SELECT file_path, file_type FROM downloads WHERE id = ?').get(id);
    if (!row) return null;
    const srcAbs = _resolveDownloadAbs(row.file_path);
    if (!srcAbs) return null;

    // WebP source files are already web-native images — no thumbnail
    // generation needed. sharp can technically re-encode them but some
    // WebPs (animated, unusual EXIF, stripped ICC) cause ffmpeg/sharp
    // errors. Returning null here lets the gallery fall back to the
    // original file URL, which is already the right format for the browser.
    if (path.extname(srcAbs).toLowerCase() === '.webp') return null;

    const kind = _kindFromPath(srcAbs, row.file_type);
    if (!kind) return null;

    const inflightKey = `${id}:${width}`;
    if (_inflight.has(inflightKey)) {
        try {
            await _inflight.get(inflightKey);
        } catch {
            /* swallow */
        }
        if (existsSync(cacheAbs)) {
            const st = await fs.stat(cacheAbs);
            return { path: cacheAbs, width, mtime: st.mtimeMs };
        }
        return null;
    }

    const sem = kind === 'image' || kind === 'audio' ? _imgSem : _vidSem;
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
            try {
                if (existsSync(tmpAbs)) await fs.unlink(tmpAbs);
            } catch {}
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

// Legacy widths that were active before the v2.x single-width collapse.
// Kept here (rather than removed) so `purgeThumbsForDownload()` and the
// one-shot `purgeNonStandardThumbs()` migration can still find + unlink
// any stale on-disk WebPs that pre-date the upgrade. After the boot-time
// purge runs once, the THUMBS_DIR holds only 320-px files; this list
// then becomes a no-op fall-through.
const _LEGACY_WIDTHS = [120, 200, 240, 480];

/**
 * Drop the on-disk cache for one download id. Cleans the canonical width
 * AND every legacy width (120 / 200 / 240 / 480 px) — operators upgrading
 * from a pre-v2.x install may still have those files on disk until the
 * boot-time `purgeNonStandardThumbs()` sweep finishes.
 *
 * Called when a file is deleted / replaced so the next request
 * regenerates against the new bytes.
 */
export async function purgeThumbsForDownload(downloadId) {
    if (!existsSync(THUMBS_DIR)) return 0;
    const id = parseInt(downloadId, 10);
    if (!Number.isInteger(id) || id <= 0) return 0;
    let removed = 0;
    const widths = [DEFAULT_WIDTH, ..._LEGACY_WIDTHS];
    for (const w of widths) {
        const p = _cachePath(id, w);
        if (existsSync(p)) {
            try {
                await fs.unlink(p);
                removed++;
            } catch {}
        }
    }
    return removed;
}

/**
 * One-shot cache-migration helper for the v2.x single-width collapse.
 * Walks the THUMBS_DIR and unlinks every cached WebP whose filename
 * corresponds to one of the legacy widths (120 / 200 / 240 / 480 px).
 *
 * Idempotent — running it twice is a no-op on the second call because
 * the legacy files are already gone. Guarded at the call site by a kv
 * flag so the sweep doesn't repeat on every boot.
 *
 * Implementation: the cache filename is `sha256(id:width)[:32].webp`,
 * so we can't tell a legacy file apart from the canonical one just by
 * looking at the bytes. Instead, we materialise every legacy filename
 * for every download id and unlink the hits. The walk uses .iterate()
 * over the downloads table to stay flat on heap on a 1M-row library.
 *
 * @returns {Promise<{ removed:number, bytes:number }>}
 */
export async function purgeNonStandardThumbs() {
    if (!existsSync(THUMBS_DIR)) return { removed: 0, bytes: 0 };
    let removed = 0;
    let bytes = 0;
    const db = getDb();
    // Keyset-paginated `.all()` — same connection-safety rationale as
    // `purgeAllThumbs`: `.iterate()` + `await fs.stat/unlink` holds the
    // DB connection open across async I/O, blocking concurrent writes.
    const PAGE_SIZE = 200;
    const pageStmt = db.prepare(
        'SELECT id FROM downloads WHERE id < ? ORDER BY id DESC LIMIT ?',
    );
    let beforeId = Number.MAX_SAFE_INTEGER;
    while (true) {
        const page = pageStmt.all(beforeId, PAGE_SIZE);
        if (!page.length) break;
        for (const row of page) {
            for (const w of _LEGACY_WIDTHS) {
                const p = _cachePath(row.id, w);
                if (existsSync(p)) {
                    try {
                        const st = await fs.stat(p);
                        await fs.unlink(p);
                        removed++;
                        bytes += st.size || 0;
                    } catch {
                        /* best-effort */
                    }
                }
            }
        }
        beforeId = Number(page[page.length - 1].id);
        await new Promise((r) => setImmediate(r));
        if (page.length < PAGE_SIZE) break;
    }
    return { removed, bytes };
}

/** Wipe the entire thumbs cache. Used by Maintenance "Rebuild thumbs". */
// Maps the public `kind` query value used by /api/maintenance/thumbs/*
// to the set of `file_type` values stored on the downloads row. Single
// source of truth — every caller that scopes by kind reads from here so
// the gallery list, the build sweep and the purge agree.
//   image  → photos, stickers, generic images
//   video  → mp4 / mov / mkv …
//   audio  → mp3 / m4a / voice
//   all    → union of the above (document is excluded — most aren't
//            thumbnailable; the few that are, like a PDF first page,
//            never had thumbs in v1 anyway)
export const THUMB_KIND_TYPES = Object.freeze({
    image: Object.freeze(['photo', 'image', 'sticker']),
    video: Object.freeze(['video']),
    audio: Object.freeze(['audio']),
});
export function thumbKindTypes(kind) {
    const k = String(kind || 'all').toLowerCase();
    if (k === 'all')
        return [...THUMB_KIND_TYPES.image, ...THUMB_KIND_TYPES.video, ...THUMB_KIND_TYPES.audio];
    return THUMB_KIND_TYPES[k] ? [...THUMB_KIND_TYPES[k]] : null;
}

/**
 * Purge cached thumbnails. With no options, behaves as a fast bulk
 * directory unlink (current default). When `kind` is supplied, falls
 * back to per-row lookup because cache filenames are sha256 of the id
 * and don't encode kind on disk.
 *
 * @param {object} [opts]
 * @param {('all'|'image'|'video'|'audio')} [opts.kind='all']
 * @returns {Promise<number>}
 */
export async function purgeAllThumbs(opts = {}) {
    if (!existsSync(THUMBS_DIR)) return 0;
    const kind = String(opts.kind || 'all').toLowerCase();

    // Fast path — directory walk and unlink everything.
    if (kind === 'all') {
        const names = await fs.readdir(THUMBS_DIR).catch(() => []);
        let removed = 0;
        for (const n of names) {
            if (!n.endsWith('.webp') && !n.endsWith('.tmp')) continue;
            try {
                await fs.unlink(path.join(THUMBS_DIR, n));
                removed++;
            } catch {}
        }
        return removed;
    }

    const types = thumbKindTypes(kind);
    if (!types || !types.length) return 0;
    const placeholders = types.map(() => '?').join(',');
    // Keyset-paginated `.all()` — `.iterate()` + `await purgeThumbsForDownload`
    // held the connection open across async unlink calls, blocking concurrent
    // DB writes with "This database connection is busy executing a query".
    const db = getDb();
    const PAGE_SIZE = 200;
    const pageStmt = db.prepare(
        `SELECT id FROM downloads
          WHERE file_type IN (${placeholders})
            AND id < ?
          ORDER BY id DESC
          LIMIT ?`,
    );
    let removed = 0;
    let beforeId = Number.MAX_SAFE_INTEGER;
    while (true) {
        const page = pageStmt.all(...types, beforeId, PAGE_SIZE);
        if (!page.length) break;
        for (const row of page) {
            removed += await purgeThumbsForDownload(row.id);
        }
        beforeId = Number(page[page.length - 1].id);
        await new Promise((r) => setImmediate(r));
        if (page.length < PAGE_SIZE) break;
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
    const { onProgress, signal, kind = 'all' } = opts;
    // Keyset-paginated `.all()` — `.iterate()` + `await getOrCreateThumb`
    // held the connection open across async sharp/ffmpeg calls, blocking
    // concurrent DB writes with "This database connection is busy".
    // ORDER BY id DESC is equivalent for this scan: the goal is to
    // prefer recent rows, and id correlates with created_at.
    const db = getDb();
    const types = thumbKindTypes(kind);
    const typeFilter =
        types && types.length ? `AND file_type IN (${types.map(() => '?').join(',')})` : '';
    const typeArgs = types && types.length ? types : [];
    // Exclude WebP source files at the SQL level — browser renders them natively.
    const webpFilter = "AND (file_path IS NULL OR LOWER(file_path) NOT LIKE '%.webp')";
    const total = db
        .prepare(`
        SELECT COUNT(*) AS n FROM downloads
         WHERE file_path IS NOT NULL ${typeFilter} ${webpFilter}
    `)
        .get(...typeArgs).n;
    const PAGE_SIZE = 50;
    const pageStmt = db.prepare(`
        SELECT id FROM downloads
         WHERE file_path IS NOT NULL ${typeFilter} ${webpFilter}
           AND id < ?
         ORDER BY id DESC
         LIMIT ?
    `);
    let processed = 0,
        built = 0,
        skipped = 0,
        errored = 0;

    const tick = () => {
        if (onProgress)
            onProgress({ stage: 'building', processed, total, built, skipped, errored });
    };
    tick();

    let beforeId = Number.MAX_SAFE_INTEGER;
    while (true) {
        if (signal?.aborted) break;
        const page = pageStmt.all(...typeArgs, beforeId, PAGE_SIZE);
        if (!page.length) break;
        for (const r of page) {
            if (signal?.aborted) break;
            processed++;
            const cacheAbs = _cachePath(r.id, DEFAULT_WIDTH);
            if (existsSync(cacheAbs)) {
                skipped++;
                if (processed % 25 === 0 || processed === total) tick();
                continue;
            }
            try {
                const thumb = await getOrCreateThumb(r.id, DEFAULT_WIDTH);
                if (thumb) built++;
                else skipped++;
            } catch {
                errored++;
            }
            if (processed % 10 === 0 || processed === total) tick();
        }
        beforeId = Number(page[page.length - 1].id);
        await new Promise((r) => setImmediate(r));
        if (page.length < PAGE_SIZE) break;
    }

    if (onProgress) onProgress({ stage: 'done', processed, total, built, skipped, errored });
    return { scanned: total, built, skipped, errored };
}

/** Stat the cache directory — used by the Maintenance UI to show usage. */
export async function getThumbsCacheStats() {
    if (!existsSync(THUMBS_DIR)) return { count: 0, bytes: 0 };
    const names = await fs.readdir(THUMBS_DIR).catch(() => []);
    let count = 0,
        bytes = 0;
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
