// Tests for the embedding output-shape adapter in src/core/ai/embeddings.js.
//
// Transformers.js text/image pipelines return varying shapes across models
// + patch versions. We added a `_toFloat32` adapter that handles:
//   - Float32Array               (rare, no shape hint)
//   - { data: Float32Array }     (older image-feature-extraction)
//   - { dims: [1, dim], data }   (CLIP image / pooled text)
//   - { dims: [1, seq, dim], data } (SigLIP text encoder when pooling
//                                    didn't get applied — mean-pool the
//                                    sequence axis)
//   - [{ data, dims }]           (some text pipelines wrap)

import { describe, it, expect } from 'vitest';

import { _internals } from '../../src/core/ai/embeddings.js';

const { toFloat32 } = _internals;

function l2Norm(arr) {
    let n = 0;
    for (const x of arr) n += x * x;
    return Math.sqrt(n);
}

describe('toFloat32', () => {
    it('handles a 2-D [batch, dim] tensor (CLIP-style pooled text)', () => {
        const dim = 512;
        const buf = new Float32Array(dim);
        for (let i = 0; i < dim; i++) buf[i] = (i % 7) * 0.01;
        const out = toFloat32({ dims: [1, dim], data: buf });
        expect(out).not.toBeNull();
        expect(out.length).toBe(dim);
        expect(l2Norm(out)).toBeCloseTo(1, 5);
    });

    it('mean-pools a 3-D [batch, seq, dim] tensor (SigLIP-style raw)', () => {
        const seq = 4;
        const dim = 6;
        const buf = new Float32Array(seq * dim);
        // Every seq position has the same vector → mean-pool returns the
        // same vector unchanged. After L2-normalise, ratios match input.
        const constant = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
        for (let s = 0; s < seq; s++) {
            for (let d = 0; d < dim; d++) buf[s * dim + d] = constant[d];
        }
        const out = toFloat32({ dims: [1, seq, dim], data: buf });
        expect(out).not.toBeNull();
        expect(out.length).toBe(dim);
        const n = l2Norm(constant);
        for (let d = 0; d < dim; d++) {
            expect(out[d]).toBeCloseTo(constant[d] / n, 5);
        }
    });

    it('mean-pools a varying-token 3-D tensor correctly', () => {
        // [1, 2, 3] tensor with tokens [1,2,3] and [3,2,1] → mean = [2,2,2]
        const buf = new Float32Array([1, 2, 3, 3, 2, 1]);
        const out = toFloat32({ dims: [1, 2, 3], data: buf });
        expect(out).not.toBeNull();
        expect(out.length).toBe(3);
        // Mean is [2,2,2] → after L2-norm → [1,1,1] / sqrt(3)
        const expected = 1 / Math.sqrt(3);
        for (let i = 0; i < 3; i++) {
            expect(out[i]).toBeCloseTo(expected, 5);
        }
    });

    it('handles a flat Float32Array (1-D)', () => {
        const buf = new Float32Array([1, 0, 0, 0, 0]);
        const out = toFloat32(buf);
        expect(out).not.toBeNull();
        expect(out.length).toBe(5);
        expect(out[0]).toBeCloseTo(1, 5);
    });

    it('handles { data } payload without dims hint', () => {
        const out = toFloat32({ data: new Float32Array([0, 1, 0, 0]) });
        expect(out).not.toBeNull();
        expect(out.length).toBe(4);
        expect(out[1]).toBeCloseTo(1, 5);
    });

    it('handles a wrapped [ { data, dims } ] payload', () => {
        const buf = new Float32Array([0.1, 0.2, 0.3]);
        const out = toFloat32([{ dims: [1, 3], data: buf }]);
        expect(out).not.toBeNull();
        expect(out.length).toBe(3);
    });

    it('handles plain number arrays', () => {
        const out = toFloat32([1, 0, 0, 0]);
        expect(out).not.toBeNull();
        expect(out.length).toBe(4);
        expect(out[0]).toBeCloseTo(1, 5);
    });

    it('returns null on null / undefined / empty', () => {
        expect(toFloat32(null)).toBeNull();
        expect(toFloat32(undefined)).toBeNull();
        expect(toFloat32({ data: new Float32Array(0) })).toBeNull();
    });
});
