// Regression tests for the v2.7.x API hardening changes:
//   1. Express error middleware converts a thrown route handler into a
//      JSON 500 instead of letting the response hang until the proxy
//      times out (manifests as 502 to the client).
//   2. api.js fetch wrapper aborts after `timeoutMs` and surfaces an
//      Error with `timedOut === true` so callers can render a specific
//      toast instead of an indefinite spinner.
//   3. findPhashGroups strips the BigInt `phash` column from response
//      rows so res.json()/JSON.stringify never throws "Do not know how
//      to serialize a BigInt" on /api/ai/perceptual-dedup/groups.
//
// (1) duplicates the middleware shape from src/web/server.js inline —
// running the full server module here would bind a port, open the DB,
// and call process.exit() on EADDRINUSE. The duplication is small and
// the manual smoke step in the plan covers the wire-up.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';

// ---------------------------------------------------------------------------
// 1. Express error middleware
// ---------------------------------------------------------------------------

describe('Express error middleware', () => {
    it('converts a synchronous throw or next(err) into a JSON 500 response', async () => {
        const app = express();
        app.get('/sync-throw', (_req, _res) => {
            throw new Error('boom-sync');
        });
        // Express 4 doesn't auto-forward rejections from `async` handlers —
        // existing routes use try/catch and call next(err) explicitly. Test
        // that path so the middleware is exercised end-to-end.
        app.get('/next-err', async (_req, _res, next) => {
            try {
                await Promise.reject(new Error('boom-next'));
            } catch (e) {
                next(e);
            }
        });
        // Same shape as src/web/server.js — keep them in sync.
        app.use((err, _req, res, _next) => {
            if (res.headersSent) return;
            res.status(500).json({ error: err?.message || 'Internal Server Error' });
        });

        const server = app.listen(0);
        const port = server.address().port;
        try {
            for (const route of ['/sync-throw', '/next-err']) {
                const res = await fetch(`http://127.0.0.1:${port}${route}`);
                const body = await res.json();
                expect(res.status).toBe(500);
                expect(body.error).toMatch(/^boom-/);
            }
        } finally {
            await new Promise((r) => server.close(r));
        }
    });

    it('does nothing when headers were already sent', () => {
        const handler = (err, _req, res, _next) => {
            if (res.headersSent) return;
            res.status(500).json({ error: err?.message });
        };
        const calls = [];
        const fakeRes = {
            headersSent: true,
            status: (c) => {
                calls.push(['status', c]);
                return fakeRes;
            },
            json: (b) => {
                calls.push(['json', b]);
                return fakeRes;
            },
        };
        handler(new Error('after headers'), {}, fakeRes, () => {});
        expect(calls).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// 2. api.js fetch timeout
// ---------------------------------------------------------------------------

describe('api.js request timeout', () => {
    let originalFetch;

    beforeAll(() => {
        originalFetch = globalThis.fetch;
    });

    afterAll(() => {
        globalThis.fetch = originalFetch;
    });

    it('aborts after timeoutMs and surfaces timedOut=true', async () => {
        // Mock fetch with a Promise that only rejects when the abort
        // signal fires — mimics a stalled backend.
        globalThis.fetch = vi.fn((_url, init) => {
            return new Promise((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => {
                    const err = new Error('aborted');
                    err.name = 'AbortError';
                    reject(err);
                });
            });
        });

        const { api } = await import('../src/web/public/js/api.js');

        const t0 = Date.now();
        await expect(api.get('/x', { timeoutMs: 80 })).rejects.toMatchObject({
            timedOut: true,
            status: 0,
        });
        // Sanity: the abort fired close to the configured deadline,
        // not at the default 60 000.
        expect(Date.now() - t0).toBeLessThan(2000);
    });
});

// ---------------------------------------------------------------------------
// 3. findPhashGroups response is JSON-serialisable (no BigInt)
// ---------------------------------------------------------------------------

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-phash-resp-'));
let db;
let dbApi;
let aiManager;

describe('findPhashGroups response shape', () => {
    beforeAll(async () => {
        process.env.TGDL_DATA_DIR = DATA_DIR;
        dbApi = await import('../src/core/db.js');
        db = dbApi.getDb();
        aiManager = await import('../src/core/ai/manager.js');

        // Two near-duplicate fixtures with phashes that differ in only one
        // bit (Hamming = 1 ≤ default threshold 6 → grouped together).
        // Use a value > 2^53 so SQLite stores it as 64-bit and
        // safeIntegers(true) round-trips it back as a BigInt.
        const phashA = (1n << 60n) | 0xdeadbeefn;
        const phashB = phashA ^ 1n; // flip the lowest bit

        for (const [i, h] of [
            [1, phashA],
            [2, phashB],
        ]) {
            dbApi.insertDownload({
                groupId: '-100777',
                groupName: 'pHash response fixture',
                messageId: i,
                fileName: `f${i}.jpg`,
                fileSize: 1000 + i,
                fileType: 'photo',
                filePath: `pHash_response_fixture/images/f${i}.jpg`,
            });
            const row = db.prepare('SELECT id FROM downloads WHERE message_id = ?').get(i);
            dbApi.setPhash(row.id, h);
        }
    });

    afterAll(() => {
        try {
            db.close();
        } catch {}
        delete process.env.TGDL_DATA_DIR;
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
    });

    it('returns rows without a BigInt phash field', () => {
        const r = aiManager.findPhashGroups({ threshold: 6, fileTypes: ['photo'] });
        expect(r.total).toBeGreaterThanOrEqual(1);
        for (const g of r.groups) {
            for (const row of g.rows) {
                expect(row).not.toHaveProperty('phash');
                // Belt-and-braces: every visible field is JSON-safe.
                for (const v of Object.values(row)) {
                    expect(typeof v).not.toBe('bigint');
                }
            }
        }
    });

    it('JSON.stringify on the full response does not throw', () => {
        const r = aiManager.findPhashGroups({ threshold: 6, fileTypes: ['photo'] });
        expect(() => JSON.stringify({ success: true, ...r })).not.toThrow();
    });
});
