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
