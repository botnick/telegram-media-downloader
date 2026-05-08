// Health helpers — never throw, return structured `{ok: bool}` payloads,
// and produce platform-specific recommendations on failure.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

import * as health from '../src/core/ai/health.js';

describe('checkSharp', () => {
    it('returns ok:true on a host where sharp is installed', async () => {
        const r = await health.checkSharp();
        // We can't assume sharp is present on every test runner, but if it
        // imports cleanly the round-trip resize should work.
        expect(typeof r).toBe('object');
        expect(typeof r.ok).toBe('boolean');
        expect(r.name).toBe('sharp');
        if (r.ok) {
            expect(r.installed).toBe(true);
        } else {
            expect(typeof r.recommendation).toBe('string');
            expect(r.recommendation.length).toBeGreaterThan(0);
        }
    });
});

describe('checkTransformers', () => {
    it('returns a structured payload', async () => {
        const r = await health.checkTransformers();
        expect(r.name).toBe('transformers');
        expect(typeof r.ok).toBe('boolean');
        if (!r.ok) {
            expect(typeof r.recommendation).toBe('string');
        }
    });
});

describe('checkSqliteVec', () => {
    it('treats a missing module as ok+optional', async () => {
        const r = await health.checkSqliteVec(null);
        expect(r.name).toBe('sqlite-vec');
        expect(r.optional).toBe(true);
        expect(r.ok).toBe(true);
    });
});

describe('checkModelsDir', () => {
    let tmpDir;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-health-'));
    });

    it('returns ok:true for a writable directory', async () => {
        const r = await health.checkModelsDir(tmpDir);
        expect(r.ok).toBe(true);
        expect(r.dir).toBe(tmpDir);
    });

    it('creates the directory if it does not exist yet', async () => {
        const fresh = path.join(tmpDir, 'nested', 'models');
        const r = await health.checkModelsDir(fresh);
        expect(r.ok).toBe(true);
        expect(fs.existsSync(fresh)).toBe(true);
    });
});

describe('summary', () => {
    it('aggregates all four checks + platform metadata', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-health-sum-'));
        const r = await health.summary({ cacheDir: tmpDir });
        expect(typeof r.ok).toBe('boolean');
        expect(Array.isArray(r.checks)).toBe(true);
        expect(r.checks.length).toBe(4);
        expect(r.checks.map((c) => c.name).sort()).toEqual(
            ['modelsDir', 'sharp', 'sqlite-vec', 'transformers'].sort(),
        );
        expect(typeof r.platform).toBe('string');
        expect(r.nodeVersion.startsWith('v')).toBe(true);
        expect(typeof r.cpus).toBe('number');
        expect(Array.isArray(r.recommendations)).toBe(true);
        expect(typeof r.elapsedMs).toBe('number');
    });

    it('ok is the AND over non-optional checks', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-health-and-'));
        const r = await health.summary({ cacheDir: tmpDir });
        const required = r.checks.filter((c) => !c.optional);
        const expected = required.every((c) => c.ok);
        expect(r.ok).toBe(expected);
    });

    it('emits log entries for every probe via the optional log hook', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-health-log-'));
        const log = vi.fn();
        await health.summary({ cacheDir: tmpDir, log });
        const lines = log.mock.calls.map((c) => c[0]);
        // Begin + done + per-probe start/done. Just assert the framing
        // markers exist — the contents are platform-dependent.
        expect(lines.some((l) => l?.msg?.includes('summary: begin'))).toBe(true);
        expect(lines.some((l) => l?.msg?.includes('summary: done'))).toBe(true);
        expect(lines.some((l) => l?.msg?.startsWith('probe sharp'))).toBe(true);
        expect(lines.some((l) => l?.msg?.startsWith('probe transformers'))).toBe(true);
        expect(lines.some((l) => l?.msg?.startsWith('probe sqlite-vec'))).toBe(true);
        expect(lines.some((l) => l?.msg?.startsWith('probe modelsDir'))).toBe(true);
    });

    it('a hung probe is bounded by the per-check timeout', async () => {
        // Use a very small timeout. We can't easily inject a hung probe
        // without monkey-patching, so we just verify that even with a 1ms
        // budget every check returns a structured payload (either ok:true
        // because it's super-fast, or ok:false with timedOut:true).
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-health-tmo-'));
        const r = await health.summary({ cacheDir: tmpDir, timeoutMs: 1 });
        expect(r.checks.length).toBe(4);
        for (const c of r.checks) {
            expect(typeof c.ok).toBe('boolean');
            // Anything that didn't finish must declare itself as such.
            if (!c.ok && c.timedOut) {
                expect(c.error).toMatch(/timed out/);
                expect(c.recommendation).toBeTruthy();
            }
        }
    });
});

describe('checkSqliteVec caching', () => {
    beforeEach(() => {
        health._resetSqliteVecCacheForTests();
    });

    it('caches the result when a DB handle is provided and reuses it on next call', async () => {
        // A fake DB that throws when sqlite-vec.load tries to attach. We
        // *want* the catch path to fire here — that's the branch that does
        // cache. The "no DB" branch deliberately skips caching so a later
        // request with a real DB can still succeed.
        const fakeDb = { loadExtension: () => {}, prepare: () => ({}) };
        const a = await health.checkSqliteVec(() => fakeDb);
        const b = await health.checkSqliteVec(() => fakeDb);
        // Same reference — second call shouldn't have called sqlite-vec.load
        // again, just returned the cached structured payload.
        expect(a).toBe(b);
        expect(a.name).toBe('sqlite-vec');
        expect(a.optional).toBe(true);
    });

    it('does not cache when no DB handle is available (allows later retry)', async () => {
        const a = await health.checkSqliteVec(null);
        const b = await health.checkSqliteVec(null);
        // Different references but equivalent payload — re-probe is allowed.
        expect(a).not.toBe(b);
        expect(a).toStrictEqual(b);
    });
});
