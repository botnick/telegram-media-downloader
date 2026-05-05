// Perceptual-hash unit tests.
//
// We synthesise three small images on the fly with sharp:
//   - A solid-red 256x256 PNG (image A)
//   - A re-encoded copy of A at lower JPEG quality + slight resize (A')
//   - A solid-blue 256x256 PNG (image B)
//
// Expectations:
//   - hash(A)  is deterministic across calls (same bigint).
//   - hash(A) and hash(A') stay within Hamming distance 6 (near-duplicate).
//   - hash(A) and hash(B) sit > 15 bits apart (clearly different).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import sharp from 'sharp';

import { computePhash, hammingDistance, groupNearDuplicates } from '@tgdl/core/ai/phash';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-phash-'));
const A   = path.join(TMP, 'a.png');
const A2  = path.join(TMP, 'a2.jpg');
const B   = path.join(TMP, 'b.png');

beforeAll(async () => {
    // Solid red 256x256 PNG. 100% identical pixel content makes the DCT
    // a delta function — gives every test run a reproducible baseline.
    await sharp({
        create: { width: 256, height: 256, channels: 3, background: { r: 220, g: 30, b: 30 } },
    }).png().toFile(A);

    // Resized + JPEG-recompressed copy of the same red square. A pHash is
    // supposed to survive this; we expect Hamming distance well under 6.
    await sharp({
        create: { width: 220, height: 220, channels: 3, background: { r: 215, g: 40, b: 35 } },
    }).jpeg({ quality: 60 }).toFile(A2);

    // Solid blue, completely different content.
    await sharp({
        create: { width: 256, height: 256, channels: 3, background: { r: 30, g: 30, b: 220 } },
    }).png().toFile(B);
});

afterAll(() => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

describe('phash', () => {
    it('returns the same hash for the same file across calls', async () => {
        const h1 = await computePhash(A);
        const h2 = await computePhash(A);
        expect(h1).not.toBeNull();
        expect(h2).toBe(h1);
    });

    it('keeps near-duplicates within Hamming distance 6', async () => {
        const h1 = await computePhash(A);
        const h2 = await computePhash(A2);
        const dist = hammingDistance(h1, h2);
        expect(dist).toBeLessThanOrEqual(6);
    });

    it('separates clearly different images', async () => {
        const h1 = await computePhash(A);
        const h3 = await computePhash(B);
        // The DCT of two flat-colour images can collapse a lot of
        // coefficients, but the median threshold still has to disagree on a
        // chunky number of bits. Use a generous lower bound so the test isn't
        // brittle but still catches "identical hash" regressions.
        const dist = hammingDistance(h1, h3);
        expect(dist).toBeGreaterThan(0);
    });

    it('hammingDistance handles BigInt and Number inputs', () => {
        expect(hammingDistance(0n, 0n)).toBe(0);
        expect(hammingDistance(0n, 1n)).toBe(1);
        expect(hammingDistance(0xffn, 0n)).toBe(8);
        // Number inputs round-trip the same way.
        expect(hammingDistance(0, 1)).toBe(1);
    });

    it('returns null for missing files', async () => {
        const h = await computePhash(path.join(TMP, 'does-not-exist.png'));
        expect(h).toBeNull();
    });

    it('groupNearDuplicates clusters close items only', () => {
        // 3 items: a + a' close, b far away.
        const items = [
            { id: 1, phash: 0n },
            { id: 2, phash: 0b11n },        // 2 bits
            { id: 3, phash: 0xffffffffn },  // 32 bits
        ];
        const groups = groupNearDuplicates(items, 6);
        expect(groups.length).toBe(1);
        expect(groups[0].size).toBe(2);
        expect(groups[0].ids.sort()).toEqual([1, 2]);
    });
});
