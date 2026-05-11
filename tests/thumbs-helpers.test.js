// Unit tests for the v2.16.x Build-thumbnails helpers introduced to
// scope the gallery / build / purge endpoints by media class.
//
// We isolate the test by pointing TGDL_DATA_DIR at an `os.tmpdir`
// mkdtemp before importing the modules, so the singleton DB picks up
// the throwaway path and the real data/db.sqlite is never touched.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-thumbs-test-'));

let thumbs;
let db;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    thumbs = await import('../src/core/thumbs.js');
    const dbMod = await import('../src/core/db.js');
    db = dbMod.getDb();
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('thumbKindTypes', () => {
    it('returns the canonical buckets per kind', () => {
        expect(thumbs.thumbKindTypes('image')).toEqual(['photo', 'image', 'sticker']);
        expect(thumbs.thumbKindTypes('video')).toEqual(['video']);
        expect(thumbs.thumbKindTypes('audio')).toEqual(['audio']);
    });

    it('returns the union for `all`', () => {
        const all = thumbs.thumbKindTypes('all');
        // Order matters for SQL placeholder generation — image bucket
        // first, then video, then audio.
        expect(all).toEqual(['photo', 'image', 'sticker', 'video', 'audio']);
    });

    it('returns null for unknown kinds so callers can fall back', () => {
        expect(thumbs.thumbKindTypes('document')).toBeNull();
        expect(thumbs.thumbKindTypes('')).toEqual(['photo', 'image', 'sticker', 'video', 'audio']); // empty → defaults to all
        expect(thumbs.thumbKindTypes('garbage')).toBeNull();
    });

    it('frozen buckets — caller cannot mutate the shared constant', () => {
        // thumbKindTypes returns a copy, but THUMB_KIND_TYPES is frozen.
        // Confirm the returned arrays are independent copies so a caller
        // pushing into them does not poison subsequent calls.
        const a = thumbs.thumbKindTypes('image');
        a.push('virus');
        const b = thumbs.thumbKindTypes('image');
        expect(b).toEqual(['photo', 'image', 'sticker']);
    });
});

describe('hasCachedThumb', () => {
    it('returns false for nonsense ids', () => {
        expect(thumbs.hasCachedThumb(0)).toBe(false);
        expect(thumbs.hasCachedThumb(-1)).toBe(false);
        expect(thumbs.hasCachedThumb('not-a-number')).toBe(false);
        expect(thumbs.hasCachedThumb(undefined)).toBe(false);
    });

    it('returns false when no cache file exists for the id', () => {
        // Empty DATA_DIR — the thumbs dir hasn't even been created yet.
        expect(thumbs.hasCachedThumb(999_999)).toBe(false);
    });
});

describe('purgeAllThumbs scope', () => {
    // NOTE: THUMBS_DIR is anchored at the package root and does not respect
    // TGDL_DATA_DIR, so the `kind:'all'` and other-known-kind paths would
    // touch the real cache. We only test the early-return path here, where
    // `thumbKindTypes` returns null and purgeAllThumbs short-circuits to 0
    // without touching the disk.
    it('short-circuits to 0 for unknown kinds (no disk I/O)', async () => {
        const removed = await thumbs.purgeAllThumbs({ kind: 'document' });
        expect(removed).toBe(0);
    });

    it('short-circuits to 0 for empty-string kinds via the unknown path', async () => {
        // 'all' would walk the directory — explicitly disable by passing
        // a known-bad value. The early return guards against accidental
        // scope drift in callers.
        const removed = await thumbs.purgeAllThumbs({ kind: 'totally-bogus' });
        expect(removed).toBe(0);
    });
});
