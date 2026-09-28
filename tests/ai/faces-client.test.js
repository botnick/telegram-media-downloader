// Track I — faces-client env overrides + retry behaviour with mocked
// fetch. The full integration is exercised against a live sidecar (gated
// by FACES_SERVICE_URL); these tests pin the wire shape + env-driven
// knobs so a future refactor can't silently drop them.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as client from '../../src/core/ai/faces-client.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
    for (const k of Object.keys(process.env)) {
        if (k.startsWith('TGDL_FACES_')) delete process.env[k];
    }
    client._resetForTests();
    // The client talks to the sidecar through its own undici instance;
    // route it via globalThis.fetch so the spies below can intercept.
    client._setFetchForTests((...args) => globalThis.fetch(...args));
});

afterEach(() => {
    for (const k of Object.keys(process.env)) {
        if (k.startsWith('TGDL_FACES_')) delete process.env[k];
    }
    Object.assign(process.env, ORIGINAL_ENV);
    vi.restoreAllMocks();
});

describe('setSidecarUrl / getSidecarUrl', () => {
    it('trims and normalises trailing slashes', () => {
        client.setSidecarUrl('http://host:8011/');
        expect(client.getSidecarUrl()).toBe('http://host:8011');
        client.setSidecarUrl('');
        expect(client.getSidecarUrl()).toBeNull();
    });
});

describe('health() — basic + enriched fields', () => {
    it('returns sidecar_url_unset when URL is empty', async () => {
        const h = await client.health();
        expect(h.ok).toBe(false);
        expect(h.error).toBe('sidecar_url_unset');
    });

    it('parses enriched Phase-6 fields from /health response', async () => {
        client.setSidecarUrl('http://host:8011');
        const body = {
            ok: true,
            version: '0.1.0',
            model: 'buffalo_l',
            dim: 512,
            ready: true,
            providers_resolved: ['CoreMLExecutionProvider', 'CPUExecutionProvider'],
            providers_requested: 'auto',
            det_size: 640,
            platform: 'darwin/arm64',
            python: '3.12.4',
        };
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => body,
        });
        const h = await client.health();
        expect(h.ok).toBe(true);
        expect(h.providersResolved).toEqual(['CoreMLExecutionProvider', 'CPUExecutionProvider']);
        expect(h.providersRequested).toBe('auto');
        expect(h.detSize).toBe(640);
        expect(h.platform).toBe('darwin/arm64');
        expect(h.python).toBe('3.12.4');
    });

    it('older sidecars (no enriched fields) gracefully return nulls', async () => {
        client.setSidecarUrl('http://host:8011');
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                ok: true,
                version: '0.0.9',
                model: 'buffalo_l',
                dim: 512,
                ready: true,
            }),
        });
        const h = await client.health();
        expect(h.providersResolved).toBeNull();
        expect(h.providersRequested).toBeNull();
        expect(h.detSize).toBeNull();
        expect(h.platform).toBeNull();
        expect(h.python).toBeNull();
    });

    it('caches the health probe within TTL', async () => {
        client.setSidecarUrl('http://host:8011');
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ ok: true }),
        });
        await client.health();
        await client.health();
        await client.health();
        // 3 calls but only 1 fetch because of the 5 s cache.
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
});

describe('applyFacesCfg + runtime knobs', () => {
    it('overrides health TTL / timeout / retries / backoff / concurrency', () => {
        client.applyFacesCfg({
            healthCacheTtlMs: 1234,
            requestTimeoutMs: 9999,
            maxRetries: 7,
            retryBackoffMs: [10, 20, 30],
            sidecarMaxConcurrency: 4,
        });
        const k = client._runtimeKnobs();
        expect(k.healthCacheTtlMs).toBe(1234);
        expect(k.requestTimeoutMs).toBe(9999);
        expect(k.maxRetries).toBe(7);
        expect(k.retryBackoffMs).toEqual([10, 20, 30]);
        expect(k.sidecarMaxConcurrency).toBe(4);
    });

    it('keeps previous value when given a bad input', () => {
        client.applyFacesCfg({ healthCacheTtlMs: 5000, maxRetries: 3 });
        client.applyFacesCfg({ healthCacheTtlMs: -1, maxRetries: 'no' });
        const k = client._runtimeKnobs();
        expect(k.healthCacheTtlMs).toBe(5000);
        expect(k.maxRetries).toBe(3);
    });
});

describe('env auto-bootstrap (no applyFacesCfg yet)', () => {
    it('reads TGDL_FACES_HEALTH_CACHE_TTL_MS on first health() call', async () => {
        process.env.TGDL_FACES_HEALTH_CACHE_TTL_MS = '100';
        client.setSidecarUrl('http://host:8011');
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ ok: true }),
        });
        await client.health();
        const k = client._runtimeKnobs();
        expect(k.healthCacheTtlMs).toBe(100);
    });
});

describe('detectFaces retry behaviour', () => {
    it('retries on 503 then succeeds', async () => {
        process.env.TGDL_FACES_RETRY_BACKOFF_MS = '1,1';
        process.env.TGDL_FACES_MAX_RETRIES = '3';
        client.setSidecarUrl('http://host:8011');
        // First two calls 503, third 200.
        const calls = [];
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
            calls.push({ url, body: JSON.parse(init.body) });
            if (calls.length < 3) {
                return {
                    ok: false,
                    status: 503,
                    clone() {
                        return this;
                    },
                    json: async () => ({ error: 'service unavailable' }),
                };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    faces: [
                        {
                            x: 10,
                            y: 20,
                            w: 100,
                            h: 100,
                            score: 0.9,
                            embedding: new Array(512).fill(0.1),
                        },
                    ],
                    image_w: 1000,
                    image_h: 1000,
                }),
            };
        });

        const out = await client.detectFaces('/tmp/x.jpg', { minDetectionScore: 0.5 });
        expect(out).toHaveLength(1);
        expect(out[0].embedding).toBeInstanceOf(Float32Array);
        expect(out[0].embedding.length).toBe(512);
        expect(calls).toHaveLength(3);
        // All calls hit /detect.
        for (const c of calls) {
            expect(c.url).toBe('http://host:8011/detect');
        }
    });

    it('returns null after exhausting retries on persistent 503', async () => {
        process.env.TGDL_FACES_RETRY_BACKOFF_MS = '1';
        process.env.TGDL_FACES_MAX_RETRIES = '2';
        client.setSidecarUrl('http://host:8011');
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: false,
            status: 503,
            clone() {
                return this;
            },
            json: async () => ({ error: 'unavailable' }),
        });
        const out = await client.detectFaces('/tmp/x.jpg', {});
        expect(out).toBeNull();
        // 2 retries on path-mode (b64 fallback not triggered because the
        // error is 503, not 403 path_not_allowed).
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('forwards ar_range from cfg.faces.arRange', async () => {
        client.setSidecarUrl('http://host:8011');
        let capturedBody = null;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
            capturedBody = JSON.parse(init.body);
            return {
                ok: true,
                status: 200,
                json: async () => ({ faces: [], image_w: 100, image_h: 100 }),
            };
        });
        await client.detectFaces('/tmp/x.jpg', {
            faces: { arRange: [0.7, 1.4] },
        });
        expect(capturedBody.ar_range).toEqual([0.7, 1.4]);
    });
});

describe('detectFacesInVideo', () => {
    it('returns null when sidecar URL is unset', async () => {
        const out = await client.detectFacesInVideo('/tmp/video.mp4', {});
        expect(out).toBeNull();
    });

    it('calls POST /detect/video with correct body shape', async () => {
        client.setSidecarUrl('http://host:8011');
        let capturedUrl = null;
        let capturedBody = null;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
            capturedUrl = url;
            capturedBody = JSON.parse(init.body);
            return {
                ok: true,
                status: 200,
                json: async () => ({ faces: [], image_w: 0, image_h: 0 }),
            };
        });
        await client.detectFacesInVideo('/tmp/video.mp4', {});
        expect(capturedUrl).toBe('http://host:8011/detect/video');
        expect(capturedBody.path).toBe('/tmp/video.mp4');
        expect(capturedBody.max_frames).toBe(120);
        expect(Number.isFinite(capturedBody.min_score)).toBe(true);
        expect(Number.isFinite(capturedBody.min_box_px)).toBe(true);
        expect(Array.isArray(capturedBody.ar_range)).toBe(true);
        expect(capturedBody.ar_range).toHaveLength(2);
    });

    it('returns Float32Array embeddings on success', async () => {
        client.setSidecarUrl('http://host:8011');
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                faces: [
                    {
                        x: 10,
                        y: 20,
                        w: 80,
                        h: 80,
                        score: 0.92,
                        embedding: new Array(512).fill(0.1),
                    },
                ],
                image_w: 1280,
                image_h: 720,
            }),
        });
        const out = await client.detectFacesInVideo('/tmp/video.mp4', {});
        expect(out).toHaveLength(1);
        expect(out[0].embedding).toBeInstanceOf(Float32Array);
        expect(out[0].embedding.length).toBe(512);
    });

    it('returns null on 403 — no b64 fallback for video', async () => {
        client.setSidecarUrl('http://host:8011');
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: false,
            status: 403,
            json: async () => ({ code: 'path_not_allowed', error: 'outside roots' }),
        });
        const out = await client.detectFacesInVideo('/tmp/video.mp4', {});
        expect(out).toBeNull();
    });

    it('returns [] on 200 + error: file_not_found (soft error)', async () => {
        client.setSidecarUrl('http://host:8011');
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ faces: [], error: 'file_not_found', image_w: 0, image_h: 0 }),
        });
        const out = await client.detectFacesInVideo('/tmp/video.mp4', {});
        expect(out).toEqual([]);
    });

    it('returns [] on 200 + error: no_frames (soft error)', async () => {
        client.setSidecarUrl('http://host:8011');
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ faces: [], error: 'no_frames', image_w: 0, image_h: 0 }),
        });
        const out = await client.detectFacesInVideo('/tmp/video.mp4', {});
        expect(out).toEqual([]);
    });

    it('returns null on network error', async () => {
        client.setSidecarUrl('http://host:8011');
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
        const out = await client.detectFacesInVideo('/tmp/video.mp4', {});
        expect(out).toBeNull();
    });

    it('respects cfg.faces.videoMaxFrames → sets max_frames in body', async () => {
        client.setSidecarUrl('http://host:8011');
        let capturedBody = null;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
            capturedBody = JSON.parse(init.body);
            return {
                ok: true,
                status: 200,
                json: async () => ({ faces: [], image_w: 0, image_h: 0 }),
            };
        });
        await client.detectFacesInVideo('/tmp/video.mp4', { faces: { videoMaxFrames: 60 } });
        expect(capturedBody.max_frames).toBe(60);
    });

    it('clamps max_frames to 500 max', async () => {
        client.setSidecarUrl('http://host:8011');
        let capturedBody = null;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
            capturedBody = JSON.parse(init.body);
            return {
                ok: true,
                status: 200,
                json: async () => ({ faces: [], image_w: 0, image_h: 0 }),
            };
        });
        await client.detectFacesInVideo('/tmp/video.mp4', { faces: { videoMaxFrames: 9999 } });
        expect(capturedBody.max_frames).toBe(500);
    });
});

describe('throwOnUnavailable — outages are not "no faces"', () => {
    const okBatch = (results) => ({ ok: true, status: 200, json: async () => ({ results }) });

    it('network error: default returns nulls, strict throws SIDECAR_UNAVAILABLE', async () => {
        client.setSidecarUrl('http://host:8011');
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(
            Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
        );
        expect(await client.detectFacesBatch(['/a.jpg'], {})).toEqual([null]);
        await expect(
            client.detectFacesBatch(['/a.jpg'], {}, null, null, { throwOnUnavailable: true }),
        ).rejects.toMatchObject({ code: 'SIDECAR_UNAVAILABLE' });
    });

    it('503 model_loading throws in strict mode; 400 stays all-null', async () => {
        client.setSidecarUrl('http://host:8011');
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        fetchSpy.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
        await expect(
            client.detectFacesBatch(['/a.jpg'], {}, null, null, { throwOnUnavailable: true }),
        ).rejects.toSatisfy(client.isSidecarUnavailable);
        fetchSpy.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) });
        expect(
            await client.detectFacesBatch(['/a.jpg'], {}, null, null, { throwOnUnavailable: true }),
        ).toEqual([null]);
    });

    it('unset URL throws in strict mode', async () => {
        await expect(
            client.detectFacesBatch(['/a.jpg'], {}, null, null, { throwOnUnavailable: true }),
        ).rejects.toMatchObject({ code: 'SIDECAR_UNAVAILABLE' });
    });

    it('a cancelled scan is not reported as an outage', async () => {
        client.setSidecarUrl('http://host:8011');
        const ctrl = new AbortController();
        ctrl.abort();
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(
            Object.assign(new Error('aborted'), { name: 'AbortError' }),
        );
        expect(
            await client.detectFacesBatch(['/a.jpg'], {}, null, ctrl.signal, {
                throwOnUnavailable: true,
            }),
        ).toEqual([null]);
    });

    it('per-file soft errors stay [] and exif_oriented is carried onto faces', async () => {
        client.setSidecarUrl('http://host:8011');
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            okBatch([
                { file: '/a.jpg', faces: [], error: 'decode_failed' },
                {
                    file: '/b.jpg',
                    exif_oriented: true,
                    faces: [{ x: 1, y: 2, w: 3, h: 4, score: 0.9, embedding: [1, 0] }],
                },
                {
                    file: '/c.jpg',
                    faces: [{ x: 1, y: 2, w: 3, h: 4, score: 0.9, embedding: [0, 1] }],
                },
            ]),
        );
        const out = await client.detectFacesBatch(['/a.jpg', '/b.jpg', '/c.jpg'], {}, null, null, {
            throwOnUnavailable: true,
        });
        expect(out[0]).toEqual([]);
        expect(out[1][0].exifOriented).toBe(true);
        expect(out[2][0].exifOriented).toBeUndefined();
    });

    it('does not leak abort listeners onto the scan signal', async () => {
        client.setSidecarUrl('http://host:8011');
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(okBatch([{ file: '/a.jpg', faces: [] }]));
        const ctrl = new AbortController();
        const add = vi.spyOn(ctrl.signal, 'addEventListener');
        const remove = vi.spyOn(ctrl.signal, 'removeEventListener');
        for (let i = 0; i < 5; i++) {
            await client.detectFacesBatch(['/a.jpg'], {}, null, ctrl.signal);
        }
        expect(add).toHaveBeenCalledTimes(5);
        expect(remove).toHaveBeenCalledTimes(5);
    });
});

describe('waitForSidecarReady', () => {
    it('waits through "model loading" until ready', async () => {
        client.setSidecarUrl('http://host:8011');
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        fetchSpy
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ ok: true, ready: false }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ ok: true, ready: true }),
            });
        const t0 = Date.now();
        expect(await client.waitForSidecarReady({ timeoutMs: 10_000 })).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(Date.now() - t0).toBeLessThan(5000);
    });

    it('treats a /health without `ready` (older sidecars) as ready', async () => {
        client.setSidecarUrl('http://host:8011');
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ ok: true }),
        });
        expect(await client.waitForSidecarReady({ timeoutMs: 1000 })).toBe(true);
    });

    it('gives up after the timeout and returns false', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
        client.setSidecarUrl('http://host:8011');
        expect(await client.waitForSidecarReady({ timeoutMs: 50 })).toBe(false);
    });

    it('returns promptly when the signal aborts', async () => {
        const ctrl = new AbortController();
        const p = client.waitForSidecarReady({ timeoutMs: 60_000, signal: ctrl.signal });
        setTimeout(() => ctrl.abort(), 20);
        const t0 = Date.now();
        expect(await p).toBe(false);
        expect(Date.now() - t0).toBeLessThan(2000);
    });
});

describe('real HTTP through the undici client', () => {
    it('talks to a live server (no fetch mock) and parses the batch reply', async () => {
        const http = await import('node:http');
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => {
                body += c;
            });
            req.on('end', () => {
                const { files } = JSON.parse(body);
                // Slow-ish reply: the answer arrives well after the request.
                setTimeout(() => {
                    res.setHeader('content-type', 'application/json');
                    res.end(
                        JSON.stringify({
                            results: files.map((file) => ({
                                file,
                                exif_oriented: true,
                                faces: [
                                    { x: 1, y: 1, w: 90, h: 90, score: 0.9, embedding: [1, 0] },
                                ],
                            })),
                        }),
                    );
                }, 150);
            });
        });
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        try {
            client._setFetchForTests(); // back to the real undici client
            client.setSidecarUrl(`http://127.0.0.1:${server.address().port}`);
            const out = await client.detectFacesBatch(['/x.jpg'], {}, null, null, {
                throwOnUnavailable: true,
            });
            expect(out).toHaveLength(1);
            expect(out[0][0].embedding).toBeInstanceOf(Float32Array);
            expect(out[0][0].exifOriented).toBe(true);
        } finally {
            server.close();
        }
    });
});
