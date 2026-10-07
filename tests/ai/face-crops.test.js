// Face-crop renderer (src/core/ai/face-crops.js): disk cache, concurrency
// cap, EXIF-aware photo crops for rows that ask for it, and the video
// frame lookup (stored frame time, or an embedding-matched search for
// older rows). ffmpeg-dependent cases skip when no ffmpeg is available.

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createFaceCropper, cropFace } from '../../src/core/ai/face-crops.js';
import { resolveFfmpegBin } from '../../src/core/thumbs.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-face-crops-'));
const FFMPEG = resolveFfmpegBin();
const HAS_FFMPEG = !spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).error;

let upright; // 300×200 PNG: left half red, right half blue
let rotated; // same picture stored as raw 200×300 + EXIF Orientation 6
let video; // 3 s clip, 10 fps

beforeAll(async () => {
    const half = (color) => ({
        create: { width: 150, height: 200, channels: 3, background: color },
    });
    upright = path.join(TMP, 'upright.png');
    await sharp({ create: { width: 300, height: 200, channels: 3, background: '#000' } })
        .composite([
            { input: await sharp(half('#ff0000')).png().toBuffer(), left: 0, top: 0 },
            { input: await sharp(half('#0000ff')).png().toBuffer(), left: 150, top: 0 },
        ])
        .png()
        .toFile(upright);
    rotated = path.join(TMP, 'rotated.jpg');
    // Raw pixels rotated 90° CCW, tagged "rotate 90° CW to display".
    await sharp(upright).rotate(-90).withMetadata({ orientation: 6 }).jpeg().toFile(rotated);
    if (HAS_FFMPEG) {
        video = path.join(TMP, 'clip.mp4');
        spawnSync(
            FFMPEG,
            [
                '-y',
                '-loglevel',
                'error',
                '-f',
                'lavfi',
                '-i',
                'testsrc=duration=3:size=320x240:rate=10',
                '-c:v',
                'mpeg4',
                video,
            ],
            { stdio: 'ignore' },
        );
    }
});

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

async function meanColor(buf) {
    const { channels } = await sharp(buf).stats();
    return channels.slice(0, 3).map((c) => Math.round(c.mean));
}

describe('cropFace', () => {
    it('crops the oriented frame when the row is EXIF-oriented', async () => {
        // Box on the red (left) half of the upright picture.
        const box = { x: 20, y: 60, w: 60, h: 60 };
        const [r, , b] = await meanColor(await cropFace(rotated, box, 64, true));
        expect(r).toBeGreaterThan(200);
        expect(b).toBeLessThan(60);
    });

    it('legacy rows keep cropping the raw pixel frame', async () => {
        const box = { x: 20, y: 60, w: 60, h: 60 };
        const legacy = await cropFace(rotated, box, 64, false);
        const raw = await sharp(rotated)
            .extract({ left: 0, top: 36, width: 104, height: 108 })
            .resize(64, 64, { fit: 'cover', position: 'centre' })
            .jpeg({ quality: 82 })
            .toBuffer();
        const [a, b] = await Promise.all([meanColor(legacy), meanColor(raw)]);
        a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThan(6));
    });
});

describe('createFaceCropper', () => {
    it('caches finished crops on disk', async () => {
        const cacheDir = path.join(TMP, 'cache-a');
        const cropper = createFaceCropper({ cacheDir, resolveFfmpeg: () => FFMPEG });
        const row = { x: 20, y: 60, w: 60, h: 60, file_type: 'photo' };
        const first = await cropper.crop(row, upright, 64);
        expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.jpg'))).toHaveLength(1);
        const second = await cropper.crop(row, upright, 64);
        expect(Buffer.compare(first, second)).toBe(0);
        // A different box is a different crop.
        await cropper.crop({ ...row, x: 200 }, upright, 64);
        expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.jpg'))).toHaveLength(2);
    });

    it.skipIf(!HAS_FFMPEG)('video with a stored frame time seeks straight to it', async () => {
        const detectInImage = vi.fn();
        const cropper = createFaceCropper({
            cacheDir: path.join(TMP, 'cache-b'),
            resolveFfmpeg: () => FFMPEG,
            detectInImage,
        });
        const buf = await cropper.crop(
            { x: 100, y: 80, w: 60, h: 60, file_type: 'video', frame_time_sec: 1.5 },
            video,
            64,
        );
        expect((await sharp(buf).metadata()).width).toBe(64);
        expect(detectInImage).not.toHaveBeenCalled();
    });

    it.skipIf(!HAS_FFMPEG)(
        'legacy video rows: first frame whose face matches the stored embedding',
        async () => {
            const stored = Float32Array.from({ length: 8 }, (_, i) => (i === 0 ? 1 : 0));
            const other = Float32Array.from({ length: 8 }, (_, i) => (i === 1 ? 1 : 0));
            const calls = [];
            const detectInImage = vi.fn(async (jpeg) => {
                calls.push(jpeg.length);
                // Seek points 10 / 30 / 50 %: a stranger, nothing, then the person.
                if (calls.length === 1) return [{ x: 5, y: 5, w: 40, h: 40, embedding: other }];
                if (calls.length === 2) return [];
                return [{ x: 150, y: 100, w: 50, h: 50, embedding: stored }];
            });
            const cacheDir = path.join(TMP, 'cache-c');
            const cropper = createFaceCropper({
                cacheDir,
                resolveFfmpeg: () => FFMPEG,
                detectInImage,
            });
            const row = {
                x: 10,
                y: 10,
                w: 60,
                h: 60,
                file_type: 'video',
                embedding: Buffer.from(stored.buffer),
            };
            await cropper.crop(row, video, 64);
            expect(detectInImage).toHaveBeenCalledTimes(3);
            // Found → cached → no second search.
            await cropper.crop(row, video, 64);
            expect(detectInImage).toHaveBeenCalledTimes(3);
        },
    );

    it.skipIf(!HAS_FFMPEG)('sidecar away: falls back to frame 0 without caching', async () => {
        const detectInImage = vi.fn(async () => null);
        const cacheDir = path.join(TMP, 'cache-d');
        const cropper = createFaceCropper({ cacheDir, resolveFfmpeg: () => FFMPEG, detectInImage });
        const row = {
            x: 10,
            y: 10,
            w: 60,
            h: 60,
            file_type: 'video',
            embedding: Buffer.from(new Float32Array([1, 0]).buffer),
        };
        const buf = await cropper.crop(row, video, 64);
        expect((await sharp(buf).metadata()).width).toBe(64);
        expect(fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : []).toHaveLength(0);
        await cropper.crop(row, video, 64);
        expect(detectInImage).toHaveBeenCalledTimes(2); // tried again next time
    });

    it.skipIf(!HAS_FFMPEG)('renders at most `concurrency` crops at once', async () => {
        let active = 0;
        let peak = 0;
        const detectInImage = async () => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((r) => setTimeout(r, 30));
            active--;
            return [];
        };
        const cropper = createFaceCropper({
            cacheDir: path.join(TMP, 'cache-e'),
            concurrency: 2,
            resolveFfmpeg: () => FFMPEG,
            detectInImage,
        });
        const emb = Buffer.from(new Float32Array([1, 0]).buffer);
        await Promise.all(
            [0, 1, 2, 3, 4].map((i) =>
                cropper.crop(
                    { x: 10 + i, y: 10, w: 60, h: 60, file_type: 'video', embedding: emb },
                    video,
                    64,
                ),
            ),
        );
        expect(peak).toBeLessThanOrEqual(2);
    }, 15_000);
});
