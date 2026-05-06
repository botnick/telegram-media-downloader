// Vector-store unit tests.
//
// Coverage:
//   - cosine() correctness (orthogonal / parallel / antiparallel)
//   - l2Normalize() makes ‖v‖ ≈ 1
//   - vectorToBlob ↔ blobToVector round-trip preserves Float32 values
//   - topK ordering — exercised through a tiny in-memory fixture

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

import {
    cosine,
    l2Normalize,
    vectorToBlob,
    blobToVector,
    topK,
    clearCache,
} from '../../src/core/ai/vector-store.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-vec-'));
let downloadsApi;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = TMP;
    downloadsApi = await import('../../src/core/db.js');
    downloadsApi.getDb(); // boot schema
});

afterAll(() => {
    try {
        fs.rmSync(TMP, { recursive: true, force: true });
    } catch {}
    delete process.env.TGDL_DATA_DIR;
});

describe('cosine()', () => {
    it('returns 1 for parallel vectors', () => {
        expect(cosine([1, 0, 0], [2, 0, 0])).toBeCloseTo(1, 6);
    });
    it('returns 0 for orthogonal vectors', () => {
        expect(cosine([1, 0, 0], [0, 1, 0])).toBe(0);
    });
    it('returns -1 for antiparallel vectors', () => {
        expect(cosine([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1, 6);
    });
    it('returns 0 for either zero-vector input', () => {
        expect(cosine([0, 0, 0], [1, 1, 1])).toBe(0);
        expect(cosine([1, 1, 1], [0, 0, 0])).toBe(0);
    });
});

describe('l2Normalize()', () => {
    it('makes the vector unit-length', () => {
        const v = new Float32Array([3, 4]);
        l2Normalize(v);
        const norm = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
        expect(norm).toBeCloseTo(1, 5);
    });
    it('leaves the zero vector untouched', () => {
        const v = new Float32Array([0, 0, 0]);
        l2Normalize(v);
        expect(Array.from(v)).toEqual([0, 0, 0]);
    });
});

describe('BLOB serialisation round-trip', () => {
    it('preserves every Float32 value', () => {
        const src = new Float32Array([0.1, -0.2, 1e-6, 12345.5, -98765.25]);
        const blob = vectorToBlob(src);
        expect(blob).toBeInstanceOf(Buffer);
        expect(blob.byteLength).toBe(src.byteLength);
        const back = blobToVector(blob);
        for (let i = 0; i < src.length; i++) {
            expect(back[i]).toBeCloseTo(src[i], 5);
        }
    });
});

describe('topK()', () => {
    it('returns rows sorted by descending cosine similarity', async () => {
        // Insert 3 downloads and 3 embeddings via the public API. The query
        // vector is intentionally aligned with row #2 so it should rank first.
        const { insertDownload, setImageEmbedding } = downloadsApi;
        const vecs = [
            new Float32Array([1, 0, 0, 0]),
            new Float32Array([0, 1, 0, 0]),
            new Float32Array([0, 0, 1, 0]),
        ];
        for (let i = 0; i < vecs.length; i++) {
            l2Normalize(vecs[i]);
            insertDownload({
                groupId: 'g',
                groupName: 'G',
                messageId: 100 + i,
                fileName: `f${i}.jpg`,
                fileSize: 1000,
                fileType: 'photo',
                filePath: `g/images/f${i}.jpg`,
            });
        }
        // ids start at 1; map back via a SELECT
        const rows = downloadsApi.getDb().prepare('SELECT id FROM downloads ORDER BY id ASC').all();
        for (let i = 0; i < rows.length; i++) {
            setImageEmbedding(rows[i].id, vectorToBlob(vecs[i]), 'test/model');
        }

        clearCache(); // important: per-test isolation
        const q = new Float32Array([0, 1, 0, 0]);
        l2Normalize(q);
        const out = topK(q, { limit: 3 });
        expect(out.length).toBe(3);
        // Strongest match should be vec #1 (also [0,1,0,0]).
        expect(out[0].score).toBeCloseTo(1, 5);
        expect(out[2].score).toBeCloseTo(0, 5);
    });
});
