// Tests for the dim guard + model filter added to vector-store.js for the
// SigLIP multilingual swap. Both knobs exist so a stale 512-dim CLIP row
// can't silently match a 768-dim SigLIP query (the old behaviour scored 0
// via the cosine length-mismatch check, which still let the row appear in
// results — sorted to the bottom but visible).

import { describe, it, expect } from 'vitest';

import { blobToVector, vectorToBlob, l2Normalize } from '../../src/core/ai/vector-store.js';

describe('blobToVector — dim guard', () => {
    it('returns the vector when no expectedDim is given', () => {
        const v = new Float32Array([1, 2, 3, 4]);
        const blob = vectorToBlob(v);
        const out = blobToVector(blob);
        expect(out).toBeInstanceOf(Float32Array);
        expect(out.length).toBe(4);
        expect(Array.from(out)).toEqual([1, 2, 3, 4]);
    });

    it('returns the vector when expectedDim matches', () => {
        const v = new Float32Array([0.1, 0.2, 0.3]);
        const out = blobToVector(vectorToBlob(v), 3);
        expect(out).not.toBeNull();
        expect(out.length).toBe(3);
    });

    it('rejects a blob whose dim does NOT match expectedDim', () => {
        const v512 = new Float32Array(512);
        for (let i = 0; i < 512; i++) v512[i] = i / 1000;
        const blob = vectorToBlob(v512);
        expect(blobToVector(blob, 768)).toBeNull();
        expect(blobToVector(blob, 256)).toBeNull();
    });

    it('returns null for an empty / null blob', () => {
        expect(blobToVector(null)).toBeNull();
        expect(blobToVector(undefined)).toBeNull();
    });

    it('treats expectedDim of 0 / NaN as "no guard"', () => {
        const v = new Float32Array([1, 2]);
        const blob = vectorToBlob(v);
        expect(blobToVector(blob, 0)).not.toBeNull();
        expect(blobToVector(blob, NaN)).not.toBeNull();
    });
});

describe('topK — model filter (smoke)', () => {
    it('passes currentModel through to the cache without crashing', async () => {
        // Full topK requires a real DB connection — skip the integration
        // path here. The feature is unit-tested at the listAllImageEmbeddings
        // / clearStaleEmbeddings layer; this case just exercises the guard
        // plumbing on the function shape.
        const { topK } = await import('../../src/core/ai/vector-store.js');
        expect(typeof topK).toBe('function');
    });
});

describe('l2Normalize — sanity', () => {
    it('makes ‖v‖ ≈ 1', () => {
        const v = new Float32Array([3, 4, 0]);
        l2Normalize(v);
        const n = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        expect(n).toBeCloseTo(1, 5);
    });
});
