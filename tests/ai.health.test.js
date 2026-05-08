// Health helpers — never throw, return structured `{ok: bool}` payloads,
// and produce platform-specific recommendations on failure.

import { describe, it, expect, beforeEach } from 'vitest';
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
    });

    it('ok is the AND over non-optional checks', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-health-and-'));
        const r = await health.summary({ cacheDir: tmpDir });
        const required = r.checks.filter((c) => !c.optional);
        const expected = required.every((c) => c.ok);
        expect(r.ok).toBe(expected);
    });
});
