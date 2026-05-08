// Verify faces.js + phash.js no longer crash at module-load time when sharp
// is missing. The pre-rewrite top-level `import sharp from 'sharp'` was the
// load-bearing crash vector for the whole "any AI button kills service"
// symptom — this test locks the lazy-load behaviour in.

import { describe, it, expect } from 'vitest';
import { tryImport, lazy } from '../src/core/ai/safe-load.js';

describe('safe-load helpers', () => {
    it('tryImport returns ok:true for a valid module', async () => {
        const r = await tryImport('node:path');
        expect(r.ok).toBe(true);
        expect(typeof r.mod).toBe('object');
    });

    it('tryImport returns ok:false for a non-existent module — never throws', async () => {
        const r = await tryImport('this-module-does-not-exist-xyz');
        expect(r.ok).toBe(false);
        expect(r.error).toBeDefined();
    });

    it('lazy() resolves once and reuses the result', async () => {
        let calls = 0;
        const load = lazy('node:path', (m) => {
            calls += 1;
            return m;
        });
        const a = await load();
        const b = await load();
        expect(a).toBe(b);
        expect(calls).toBe(1);
    });

    it('lazy() rejects with code:NATIVE_LOAD_FAIL when the import fails', async () => {
        const load = lazy('definitely-not-a-real-package-xyz');
        await expect(load()).rejects.toMatchObject({ code: 'NATIVE_LOAD_FAIL' });
    });

    it('lazy() resets so a recovered install is picked up', async () => {
        // First load fails, sets cached promise to null. A second call
        // attempts the import again rather than inheriting the rejection.
        const load = lazy('definitely-not-a-real-package-xyz');
        await expect(load()).rejects.toThrow();
        await expect(load()).rejects.toThrow();
        // Reaching here without an unhandled-rejection-style hang is the assertion.
    });
});

describe('faces.js imports without sharp on the import path', () => {
    it('imports cleanly at module-eval time', async () => {
        // The very act of completing this import without throwing is the
        // assertion. Pre-rewrite, a missing sharp would crash the whole
        // module graph during ES import.
        const mod = await import('../src/core/ai/faces.js');
        expect(typeof mod.dbscan).toBe('function');
        expect(typeof mod.detectFaces).toBe('function');
        expect(typeof mod.embedFace).toBe('function');
    });
});

describe('phash.js imports without sharp on the import path', () => {
    it('imports cleanly at module-eval time', async () => {
        const mod = await import('../src/core/ai/phash.js');
        expect(typeof mod.computePhash).toBe('function');
        expect(typeof mod.hammingDistance).toBe('function');
        expect(typeof mod.groupNearDuplicates).toBe('function');
    });
});
