// faces-client ↔ a faces sidecar on another host. A fake HTTP server speaks
// the faces-service API behind a reverse-proxy prefix (/faces) and only
// "sees" files under its own mount (/mnt/media).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import sharp from 'sharp';

import * as client from '../../src/core/ai/faces-client.js';

const APP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-faces-ext-'));
const photo = path.join(APP_ROOT, 'g', 'photos', 'a.jpg');
const photo2 = path.join(APP_ROOT, 'g', 'photos', 'b.jpg');
const EMB = Array.from({ length: 8 }, (_, i) => (i === 0 ? 1 : 0));
const FACE = {
    x: 100,
    y: 50,
    w: 40,
    h: 60,
    score: 0.9,
    quality_score: 0.4,
    embedding: EMB,
    landmarks: [
        [110, 60],
        [130, 60],
        [120, 70],
        [112, 90],
        [128, 90],
    ],
};

const S = {
    features: null, // null = pre-0.5.1 /health (no field)
    visible: new Set(),
    requests: [],
    uploadStatus: 200,
};

let server;
let base;

function readBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
    });
}

beforeAll(async () => {
    fs.mkdirSync(path.dirname(photo), { recursive: true });
    await sharp({ create: { width: 64, height: 48, channels: 3, background: '#c86' } })
        .jpeg()
        .toFile(photo);
    fs.copyFileSync(photo, photo2);

    server = http.createServer(async (req, res) => {
        const body = await readBody(req);
        const json = (code, obj) => {
            res.writeHead(code, { 'content-type': 'application/json' });
            res.end(JSON.stringify(obj));
        };
        const url = new URL(req.url, 'http://x');
        if (!url.pathname.startsWith('/faces/')) return json(404, { error: 'no route' });
        const route = url.pathname.slice('/faces'.length);
        const entry = { route, query: Object.fromEntries(url.searchParams), bytes: body.length };
        entry.token = req.headers['x-api-token'] || null;
        S.requests.push(entry);
        if (route === '/health') {
            return json(200, {
                ok: true,
                ready: true,
                version: S.features ? '0.5.1' : '0.5.0',
                ...(S.features ? { features: S.features, max_upload_bytes: 64 << 20 } : {}),
            });
        }
        if (route === '/detect/upload') {
            if (!S.features?.includes('upload') || S.uploadStatus !== 200) {
                return json(S.uploadStatus === 200 ? 404 : S.uploadStatus, { detail: 'Not Found' });
            }
            entry.raw = body;
            return json(200, { faces: [FACE], image_w: 64, image_h: 48, exif_oriented: true });
        }
        const b = body.length ? JSON.parse(body.toString('utf8')) : {};
        entry.json = b;
        if (route === '/detect') {
            if (b.path) {
                if (!b.path.startsWith('/mnt/media/')) {
                    return json(403, { error: 'outside', code: 'path_not_allowed' });
                }
                if (!S.visible.has(b.path))
                    return json(200, { faces: [], error: 'file_not_found' });
                return json(200, { faces: [FACE], exif_oriented: true });
            }
            return json(200, { faces: [FACE], exif_oriented: true });
        }
        if (route === '/detect/batch') {
            return json(200, {
                results: b.files.map((f) =>
                    !f.startsWith('/mnt/media/')
                        ? { file: f, faces: [], error: 'path_not_allowed' }
                        : S.visible.has(f)
                          ? { file: f, faces: [FACE], exif_oriented: true }
                          : { file: f, faces: [], error: 'file_not_found' },
                ),
            });
        }
        if (route === '/detect/video') {
            if (!S.visible.has(b.path)) return json(200, { faces: [], error: 'file_not_found' });
            return json(200, { faces: [{ ...FACE, frame_time_sec: 1.5 }] });
        }
        json(404, { error: 'no route' });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/faces`;
});

afterAll(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(APP_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
    client._resetForTests();
    client.setSidecarUrl(`${base}/`);
    client.applyFacesCfg({ retryBackoffMs: [5], sidecarToken: 'tok' });
    S.features = null;
    S.visible = new Set();
    S.requests = [];
    S.uploadStatus = 200;
});

const routes = () => S.requests.filter((r) => r.route !== '/health').map((r) => r.route);

describe('path mapping', () => {
    it('batch sends mapped paths and keys results back to the caller’s paths', async () => {
        client.applyFacesCfg({ pathMap: `${APP_ROOT}=/mnt/media` });
        S.visible = new Set(['/mnt/media/g/photos/a.jpg', '/mnt/media/g/photos/b.jpg']);
        const out = await client.detectFacesBatch([photo, photo2], {}, null, null, {
            throwOnUnavailable: true,
        });
        expect(out.map((r) => r?.length)).toEqual([1, 1]);
        expect(S.requests.at(-1).json.files).toEqual([
            '/mnt/media/g/photos/a.jpg',
            '/mnt/media/g/photos/b.jpg',
        ]);
        expect(routes()).toEqual(['/detect/batch']);
        expect(S.requests.every((r) => r.token === 'tok')).toBe(true);
    });

    it('single photos and videos use the mapped path too', async () => {
        client.applyFacesCfg({ pathMap: `${APP_ROOT}=/mnt/media` });
        S.visible = new Set(['/mnt/media/g/photos/a.jpg', '/mnt/media/g/v.mp4']);
        expect(await client.detectFaces(photo, {})).toHaveLength(1);
        expect(S.requests.at(-1).json.path).toBe('/mnt/media/g/photos/a.jpg');
        const vid = await client.detectFacesInVideo(path.join(APP_ROOT, 'g', 'v.mp4'), {});
        expect(vid[0].frameTimeSec).toBe(1.5);
        expect(S.requests.at(-1).json.path).toBe('/mnt/media/g/v.mp4');
    });

    it('a mapped file missing on the sidecar is sent as bytes', async () => {
        client.applyFacesCfg({ pathMap: `${APP_ROOT}=/mnt/media` });
        const out = await client.detectFacesBatch([photo], {}, null, null, {
            throwOnUnavailable: true,
        });
        expect(out[0]).toHaveLength(1);
        expect(routes()).toEqual(['/detect/batch', '/detect']);
        expect(S.requests.at(-1).json.image_b64).toBeTruthy();
    });

    it('a new mapping gives path mode another chance', async () => {
        // No mapping: the sidecar rejects the app path → bytes for good…
        await client.detectFaces(photo, {});
        expect(routes()).toEqual(['/detect', '/detect']);
        S.requests = [];
        await client.detectFaces(photo, {});
        expect(S.requests.at(-1).json.image_b64).toBeTruthy();
        // …until a mapping is configured.
        client.applyFacesCfg({ pathMap: `${APP_ROOT}=/mnt/media` });
        S.visible = new Set(['/mnt/media/g/photos/a.jpg']);
        S.requests = [];
        await client.detectFaces(photo, {});
        expect(S.requests.map((r) => r.json?.path)).toEqual(['/mnt/media/g/photos/a.jpg']);
    });
});

describe('bytes transfer', () => {
    it('uses raw /detect/upload when /health lists it, with thresholds in the query', async () => {
        S.features = ['path', 'b64', 'upload'];
        await client.health();
        const out = await client.detectFaces(photo, {
            minDetectionScore: 0.6,
            minFaceSizePx: 40,
            faces: { arRange: [0.4, 2.5] },
        });
        expect(out).toHaveLength(1);
        const up = S.requests.find((r) => r.route === '/detect/upload');
        expect(up.raw.equals(fs.readFileSync(photo))).toBe(true);
        expect(up.query).toEqual({
            min_score: '0.6',
            min_box_px: '40',
            ar_lo: '0.4',
            ar_hi: '2.5',
        });
    });

    it('stays on base64 for a sidecar without the feature (0.5.0)', async () => {
        await client.health();
        await client.detectFaces(photo, {});
        expect(routes()).toEqual(['/detect', '/detect']);
        expect(S.requests.at(-1).json.image_b64).toBe(fs.readFileSync(photo).toString('base64'));
    });

    it('falls back to base64 when /detect/upload disappears', async () => {
        S.features = ['upload'];
        await client.health();
        S.uploadStatus = 404;
        expect(await client.detectFaces(photo, {})).toHaveLength(1);
        expect(routes()).toEqual(['/detect', '/detect/upload', '/detect']);
        S.requests = [];
        await client.detectFaces(photo, {});
        expect(routes()).toEqual(['/detect']); // feature dropped, straight to b64
    });

    it('learns features from the readiness probe the scan runs first', async () => {
        S.features = ['upload'];
        expect(await client.waitForSidecarReady({ timeoutMs: 1000 })).toBe(true);
        await client.detectFaces(photo, {});
        expect(routes()).toContain('/detect/upload');
    });

    it('downscales a photo over the request budget and maps boxes back', async () => {
        const big = path.join(APP_ROOT, 'big.jpg');
        // 6000x3000 stored sideways: EXIF orientation 6 → displayed 3000x6000.
        await sharp({
            create: { width: 6000, height: 3000, channels: 3, background: '#468' },
        })
            .withMetadata({ orientation: 6 })
            .jpeg({ quality: 100 })
            .toFile(big);
        const size = fs.statSync(big).size;
        client._setRequestBudgetForTests(Math.floor(size / 2));
        const out = await client.detectFaces(big, { minFaceSizePx: 60 });
        const sent = S.requests.find((r) => r.json?.image_b64);
        const img = await sharp(Buffer.from(sent.json.image_b64, 'base64')).metadata();
        // Upright (orientation applied) and fitted to 4096 or 2048 px.
        expect(img.height).toBeGreaterThan(img.width);
        expect(Math.max(img.width, img.height)).toBeLessThanOrEqual(4096);
        const scale = img.width / 3000;
        expect(sent.json.min_box_px).toBe(Math.round(60 * scale));
        expect(out[0].exifOriented).toBe(true);
        expect(out[0].x).toBe(Math.round(100 / scale));
        expect(out[0].w).toBe(Math.round(40 / scale));
        expect(out[0].landmarks[0][0]).toBeCloseTo(110 / scale, 5);
        expect(Array.from(out[0].embedding)).toEqual(EMB);
    });

    it('leaves photos under the budget untouched', async () => {
        await client.detectFaces(photo, {});
        const out = await client.detectFaces(photo, {});
        expect(out[0].x).toBe(100);
        expect(S.requests.at(-1).json.image_b64).toBe(fs.readFileSync(photo).toString('base64'));
    });
});

describe('video frame batching', () => {
    it('groups frames by encoded size and count', () => {
        const f = (n) => ({ buf: Buffer.alloc(n), t: 0 });
        const budget = 4000;
        const chunks = client._chunkFramesByBudget(
            [f(1200), f(1200), f(1200), f(5000), f(10)],
            budget,
        );
        // 1200 B → 1604 B of base64: two fit in 4000, the oversized frame goes alone.
        expect(chunks.map((c) => c.length)).toEqual([2, 1, 1, 1]);
        const many = client._chunkFramesByBudget(
            Array.from({ length: 70 }, () => f(10)),
            budget,
        );
        expect(many.map((c) => c.length)).toEqual([30, 30, 10]);
    });
});
