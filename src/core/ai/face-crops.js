/**
 * Face crops for the People grid (person avatar) and per-face thumbnails.
 *
 * The grid fires one avatar request per person, dozens at once. Each one
 * used to decode the full-resolution source again — and for video-only
 * people spawn ffmpeg for a full-res PNG of frame 0 (tens of MB through a
 * 20 MB-capped pipe) and decode that a second time. Now:
 *
 *   - finished crops are cached on disk, keyed by everything that decides
 *     the pixels (source path + mtime + size, face box, frame time,
 *     orientation mode, output size) — an edited file or a re-scan simply
 *     misses the cache instead of serving a stale crop;
 *   - at most `concurrency` crops are rendered at a time
 *     (`TGDL_FACE_CROP_CONCURRENCY`, default 4) and concurrent requests
 *     for the same crop share one render;
 *   - video frames come out of ffmpeg as JPEG, seeked to the frame the
 *     face was found in (`faces.frame_time_sec`, reported by newer
 *     sidecars). Older video rows have no timestamp: a handful of seek
 *     points are tried and the frame whose detected face matches the
 *     stored embedding is used — the stored box belongs to a frame we can
 *     no longer name, and frame 0 (the old behaviour) is often black or a
 *     different shot. Frame 0 remains the last resort.
 *   - photo rows written by a sidecar that reports `exif_oriented` are
 *     cropped from the EXIF-oriented image; legacy rows keep the raw-frame
 *     crop they have always had.
 */

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

import sharp from 'sharp';

const PAD = 0.4;
// Same identity threshold the sidecar uses to dedupe faces across frames.
const MATCH_MIN_COSINE = 0.5;
const LEGACY_SEEK_POINTS = [0.1, 0.3, 0.5, 0.7, 0.9];
const FFMPEG_TIMEOUT_MS = 10_000;

function _runFfmpeg(bin, args, { wantStdout = true } = {}) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(bin, args, {
                stdio: ['ignore', wantStdout ? 'pipe' : 'ignore', 'pipe'],
                windowsHide: true,
            });
        } catch {
            resolve({ code: -1, stdout: Buffer.alloc(0), stderr: '' });
            return;
        }
        const out = [];
        let outBytes = 0;
        let stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), FFMPEG_TIMEOUT_MS);
        child.stdout?.on('data', (d) => {
            outBytes += d.length;
            // A single JPEG frame; anything this big is not what we asked for.
            if (outBytes > 40 * 1024 * 1024) child.kill('SIGKILL');
            else out.push(d);
        });
        child.stderr.on('data', (d) => {
            if (stderr.length < 16_384) stderr += d.toString();
        });
        child.on('error', () => {
            clearTimeout(timer);
            resolve({ code: -1, stdout: Buffer.alloc(0), stderr });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout: Buffer.concat(out), stderr });
        });
    });
}

/** One video frame at `timeSec` as a full-resolution JPEG, or null. */
async function _extractFrame(bin, videoPath, timeSec) {
    const args = ['-hide_banner', '-loglevel', 'error'];
    if (Number.isFinite(timeSec) && timeSec > 0) args.push('-ss', timeSec.toFixed(3));
    args.push(
        '-i',
        videoPath,
        '-an',
        '-sn',
        '-dn',
        '-frames:v',
        '1',
        '-f',
        'image2',
        '-c:v',
        'mjpeg',
        '-q:v',
        '2',
        'pipe:1',
    );
    const r = await _runFfmpeg(bin, args);
    return r.code === 0 && r.stdout.length ? r.stdout : null;
}

async function _probeDuration(bin, videoPath) {
    const r = await _runFfmpeg(bin, ['-hide_banner', '-i', videoPath], { wantStdout: false });
    const m = r.stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

/**
 * Crop a face box (40 % padding, square, centre) out of an image buffer or
 * file path. `oriented` = the box is in the EXIF-oriented frame.
 */
export async function cropFace(source, box, size, oriented = false) {
    const meta = await sharp(source, { failOn: 'none' }).metadata();
    const dims = oriented && meta.autoOrient ? meta.autoOrient : meta;
    const imgW = dims.width || 9999;
    const imgH = dims.height || 9999;
    const left = Math.max(0, Math.round(box.x - box.w * PAD));
    const top = Math.max(0, Math.round(box.y - box.h * PAD));
    const right = Math.min(imgW, Math.round(box.x + box.w + box.w * PAD));
    const bottom = Math.min(imgH, Math.round(box.y + box.h + box.h * PAD));
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    let img = sharp(source, { failOn: 'none' });
    if (oriented) img = img.autoOrient();
    return img
        .extract({ left, top, width, height })
        .resize(size, size, { fit: 'cover', position: 'centre' })
        .jpeg({ quality: 82, progressive: true })
        .toBuffer();
}

function _toF32(blob) {
    if (!blob?.byteLength || blob.byteLength % 4) return null;
    const out = new Float32Array(blob.byteLength / 4);
    new Uint8Array(out.buffer).set(blob);
    return out;
}

function _cosine(a, b) {
    if (!a || !b || a.length !== b.length) return -1;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : -1;
}

/**
 * @param {object} opts
 * @param {string} opts.cacheDir
 * @param {number} [opts.concurrency]
 * @param {() => string} opts.resolveFfmpeg
 * @param {(jpeg: Buffer) => Promise<Array|null>} [opts.detectInImage]
 *        sidecar detection on an in-memory frame; null = sidecar unavailable
 */
export function createFaceCropper({ cacheDir, concurrency = 4, resolveFfmpeg, detectInImage }) {
    const limit = Math.max(1, Math.min(32, Number(concurrency) || 4));
    let active = 0;
    const waiters = [];
    const inflight = new Map(); // cache key → Promise<Buffer>

    async function withSlot(fn) {
        if (active >= limit) await new Promise((resolve) => waiters.push(resolve));
        else active++;
        try {
            return await fn();
        } finally {
            const next = waiters.shift();
            if (next) next();
            else active--;
        }
    }

    async function renderVideo(row, real, size) {
        const bin = resolveFfmpeg();
        if (Number.isFinite(row.frame_time_sec)) {
            const frame = await _extractFrame(bin, real, row.frame_time_sec);
            if (frame) return { buf: await cropFace(frame, row, size), cacheable: true };
        }
        let cacheable = true;
        const stored = _toF32(row.embedding);
        if (stored && typeof detectInImage === 'function') {
            const duration = await _probeDuration(bin, real);
            for (const f of duration > 0 ? LEGACY_SEEK_POINTS : []) {
                const frame = await _extractFrame(bin, real, f * duration);
                if (!frame) continue;
                const faces = await detectInImage(frame);
                if (faces === null) {
                    // Sidecar away: serve the fallback but don't cache it.
                    cacheable = false;
                    break;
                }
                let best = null;
                let bestSim = MATCH_MIN_COSINE;
                for (const face of faces) {
                    const sim = _cosine(face.embedding, stored);
                    if (sim >= bestSim) {
                        best = face;
                        bestSim = sim;
                    }
                }
                if (best) return { buf: await cropFace(frame, best, size), cacheable: true };
            }
        }
        const frame0 = await _extractFrame(bin, real, 0);
        if (!frame0) throw new Error('could not extract a video frame');
        try {
            return { buf: await cropFace(frame0, row, size), cacheable };
        } catch {
            const buf = await sharp(frame0, { failOn: 'none' })
                .resize(size, size, { fit: 'cover', position: 'attention' })
                .jpeg({ quality: 82, progressive: true })
                .toBuffer();
            return { buf, cacheable };
        }
    }

    function render(row, real, size) {
        if (row.file_type === 'video') return renderVideo(row, real, size);
        return cropFace(real, row, size, row.exif_oriented === 1).then((buf) => ({
            buf,
            cacheable: true,
        }));
    }

    /**
     * Cached, concurrency-capped crop. `row`: x/y/w/h, file_type, and
     * optionally exif_oriented / frame_time_sec / embedding (legacy video
     * frame search).
     */
    async function crop(row, real, size) {
        const st = await fs.stat(real);
        const key = createHash('sha1')
            .update(
                [
                    real,
                    st.mtimeMs,
                    st.size,
                    row.file_type || '',
                    row.x,
                    row.y,
                    row.w,
                    row.h,
                    row.exif_oriented === 1 ? 1 : 0,
                    Number.isFinite(row.frame_time_sec) ? row.frame_time_sec : '',
                    size,
                ].join('\0'),
            )
            .digest('hex');
        const dst = path.join(cacheDir, `${key}.jpg`);
        try {
            return await fs.readFile(dst);
        } catch {
            /* not cached yet */
        }
        const pending = inflight.get(key);
        if (pending) return pending;
        const job = withSlot(async () => {
            const { buf, cacheable } = await render(row, real, size);
            if (cacheable) {
                try {
                    await fs.mkdir(cacheDir, { recursive: true });
                    const tmp = `${dst}.${process.pid}.${Date.now()}.tmp`;
                    await fs.writeFile(tmp, buf);
                    await fs.rename(tmp, dst);
                } catch {
                    /* cache is best-effort — the crop itself is still served */
                }
            }
            return buf;
        });
        inflight.set(key, job);
        try {
            return await job;
        } finally {
            inflight.delete(key);
        }
    }

    /** Drop every cached crop (after a reindex every box is new anyway). */
    function purge() {
        return fs.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
    }

    return { crop, purge, _state: () => ({ active, queued: waiters.length }) };
}
