// Public-surface smoke test for src/core/ai/index.js. Verifies the
// re-export shape so callers in server.js + downloader.js know what they
// can rely on. No model loading — that path is integration-level.

import { describe, it, expect } from 'vitest';

describe('ai/index public surface', () => {
    // NOTE: Search (embeddings) + Auto-tag (tags) + vector-store were removed
    // in this release. The AI subsystem now exposes faces-only helpers; tests
    // below assert that surface and that the removed helpers are absent.

    it('re-exports face helpers', async () => {
        const ai = await import('../../src/core/ai/index.js');
        expect(typeof ai.detectFaces).toBe('function');
        expect(typeof ai.clusterFaces).toBe('function');
        expect(typeof ai.dbscan).toBe('function');
        expect(typeof ai.euclidean).toBe('function');
        expect(typeof ai.centroid).toBe('function');
        expect(Object.isFrozen(ai.FACE_DEFAULTS)).toBe(true);
    });

    it('does NOT re-export the removed Search/Tags/vector-store helpers', async () => {
        const ai = await import('../../src/core/ai/index.js');
        for (const name of [
            'embedImage',
            'embedText',
            'embedTextBatch',
            'EMBED_DEFAULTS',
            'tagImage',
            'tagFromVec',
            'scoreLabels',
            'TAG_DEFAULTS',
            'f32ToBlob',
            'blobToF32',
            'topK',
            'loadVecExtensionOnce',
            'startEmbedScan',
            'startTagsScan',
        ]) {
            expect(ai[name]).toBeUndefined();
        }
    });

    it('re-exports scan-runner controls (faces-only)', async () => {
        const ai = await import('../../src/core/ai/index.js');
        expect(typeof ai.startFacesScan).toBe('function');
        expect(typeof ai.cancelScan).toBe('function');
        expect(typeof ai.getScanState).toBe('function');
        expect(typeof ai.isScanRunning).toBe('function');
    });

    it('exports pregenerateAi (no-op when AI disabled)', async () => {
        const ai = await import('../../src/core/ai/index.js');
        expect(typeof ai.pregenerateAi).toBe('function');
        expect(() => ai.pregenerateAi(99999)).not.toThrow();
    });
});

describe('scan-runner state machine', () => {
    it('isScanRunning returns false for an unknown feature', async () => {
        const sr = await import('../../src/core/ai/scan-runner.js');
        expect(sr.isScanRunning('unknown')).toBe(false);
    });
    it('getScanState returns null for an unknown feature', async () => {
        const sr = await import('../../src/core/ai/scan-runner.js');
        expect(sr.getScanState('unknown')).toBeNull();
    });
    it('getScanState returns a state object for the faces feature', async () => {
        const sr = await import('../../src/core/ai/scan-runner.js');
        const s = sr.getScanState('faces');
        expect(s).toBeTruthy();
        expect(typeof s.running).toBe('boolean');
        expect(typeof s.scanned).toBe('number');
        expect(typeof s.total).toBe('number');
        expect(s).not.toHaveProperty('abort'); // never leak the controller
    });
    it('getScanState returns null for removed Search/Tags features', async () => {
        const sr = await import('../../src/core/ai/scan-runner.js');
        expect(sr.getScanState('embed')).toBeNull();
        expect(sr.getScanState('tags')).toBeNull();
    });
    it('cancelScan returns false when no scan is in flight', async () => {
        const sr = await import('../../src/core/ai/scan-runner.js');
        sr._resetForTests();
        expect(sr.cancelScan('faces')).toBe(false);
    });
});

describe('faces config exports', () => {
    it('faces-config exports resolveFacesValue + resolveAllFaces', async () => {
        const fc = await import('../../src/core/ai/faces-config.js');
        expect(typeof fc.resolveFacesValue).toBe('function');
        expect(typeof fc.resolveAllFaces).toBe('function');
    });
});
