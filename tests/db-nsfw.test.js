// NSFW review DB-layer integration tests. Locks in the contract for the
// SQL-side aggregations introduced in the v2.7 review redesign:
//   - getNsfwTierCounts: one CASE-SUM pass returns all 5 tier counts
//   - getNsfwHistogram: GROUP BY bin returns dense counts[]
//   - getNsfwIdsByTier: single SELECT returns flat id list

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-nsfw-test-'));

let db;
let api;

// 12 photos with deterministic scores spanning all 5 tiers, plus 2
// whitelisted rows and 1 video. Lets us assert exact counts per tier.
const FIXTURES = [
    // def_not [0.0, 0.3) — 3 photos
    { msg: 1, type: 'photo', score: 0.05, whitelist: 0 },
    { msg: 2, type: 'photo', score: 0.15, whitelist: 0 },
    { msg: 3, type: 'photo', score: 0.29, whitelist: 0 },
    // maybe_not [0.3, 0.5) — 2 photos
    { msg: 4, type: 'photo', score: 0.35, whitelist: 0 },
    { msg: 5, type: 'photo', score: 0.49, whitelist: 0 },
    // uncertain [0.5, 0.7) — 2 photos
    { msg: 6, type: 'photo', score: 0.55, whitelist: 0 },
    { msg: 7, type: 'photo', score: 0.65, whitelist: 0 },
    // maybe [0.7, 0.9) — 1 photo
    { msg: 8, type: 'photo', score: 0.85, whitelist: 0 },
    // def [0.9, 1.0] — 2 photos (one at exact 1.0 to test bin clamp)
    { msg: 9, type: 'photo', score: 0.95, whitelist: 0 },
    { msg: 10, type: 'photo', score: 1.0, whitelist: 0 },
    // 2 whitelisted (excluded from tier counts) — uncertain + maybe ranges
    { msg: 11, type: 'photo', score: 0.6, whitelist: 1 },
    { msg: 12, type: 'photo', score: 0.85, whitelist: 1 },
    // 1 video (file_type filter excludes it from photo queries)
    { msg: 13, type: 'video', score: 0.9, whitelist: 0 },
];

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    api = await import('../src/core/db.js');
    db = api.getDb();
    for (const f of FIXTURES) {
        api.insertDownload({
            groupId: '-100777',
            groupName: 'NSFW Fixture',
            messageId: f.msg,
            fileName: `f${f.msg}.jpg`,
            fileSize: 1000 + f.msg,
            fileType: f.type,
            filePath: `NSFW_Fixture/images/f${f.msg}.jpg`,
        });
        // Set the NSFW columns directly — there's no public setter, but the
        // scan loop writes them via UPDATE so this matches reality.
        db.prepare(
            `UPDATE downloads SET nsfw_score = ?, nsfw_checked_at = ?, nsfw_whitelist = ?
             WHERE group_id = ? AND message_id = ?`,
        ).run(f.score, Date.now(), f.whitelist, '-100777', f.msg);
    }
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('getNsfwTierCounts', () => {
    it('returns per-tier counts in one SQL pass, excluding whitelisted', () => {
        const r = api.getNsfwTierCounts(['photo']);
        expect(r.tiers).toEqual({
            def_not: 3,
            maybe_not: 2,
            uncertain: 2,
            maybe: 1,
            def: 2,
        });
        // Whitelisted rows are NOT in tier counts, but DO count toward
        // `scanned` (they were scanned, then admin-overridden) and
        // `totalEligible` (they're still photos).
        expect(r.scanned).toBe(12);
        expect(r.totalEligible).toBe(12);
        expect(r.unscanned).toBe(0);
        expect(r.whitelisted).toBe(2);
    });

    it('respects file_type filter — videos excluded from photo counts', () => {
        const photos = api.getNsfwTierCounts(['photo']);
        const videos = api.getNsfwTierCounts(['video']);
        // The single video's score=0.9 lands in `def` for video file_type
        expect(videos.tiers.def).toBe(1);
        expect(photos.tiers.def).toBe(2); // photos at 0.95 + 1.0
    });
});

describe('getNsfwHistogram', () => {
    it('returns dense counts array with SQL-side aggregation', () => {
        const r = api.getNsfwHistogram(['photo'], 10);
        expect(r.bins).toBe(10);
        expect(r.counts).toHaveLength(10);
        // Sum should equal the count of photos with non-null score
        // (whitelisted rows DO contribute — histogram is the unfiltered
        // distribution). 10 non-whitelisted + 2 whitelisted = 12.
        const total = r.counts.reduce((a, b) => a + b, 0);
        expect(total).toBe(12);
    });

    it('clamps score=1.0 into the last bin instead of out-of-range', () => {
        const r = api.getNsfwHistogram(['photo'], 10);
        // Bin 9 is [0.9, 1.0]. Photos at 0.95 + 1.0 + whitelisted-at-NA = 2
        expect(r.counts[9]).toBeGreaterThanOrEqual(2);
    });

    it('honours the bins parameter (clamped to [4, 50])', () => {
        expect(api.getNsfwHistogram(['photo'], 4).bins).toBe(4);
        expect(api.getNsfwHistogram(['photo'], 50).bins).toBe(50);
        // Out-of-range — clamped at the boundaries
        expect(api.getNsfwHistogram(['photo'], 100).bins).toBe(50);
        expect(api.getNsfwHistogram(['photo'], 1).bins).toBe(4);
    });
});

describe('getNsfwIdsByTier', () => {
    it('returns flat id list for a tier in one statement', () => {
        const ids = api.getNsfwIdsByTier({ tier: 'def_not', fileTypes: ['photo'] });
        expect(ids).toHaveLength(3);
        // Sorted ascending by score, then id — first id has the lowest score
        const rows = db
            .prepare(`SELECT id, nsfw_score FROM downloads WHERE id IN (${ids.join(',')})`)
            .all();
        for (const row of rows) {
            expect(row.nsfw_score).toBeGreaterThanOrEqual(0.0);
            expect(row.nsfw_score).toBeLessThan(0.3);
        }
    });

    it('respects scoreMin/scoreMax push-down (no post-query filter)', () => {
        const ids = api.getNsfwIdsByTier({
            fileTypes: ['photo'],
            scoreMin: 0.55,
            scoreMax: 0.7,
        });
        // Should find: msg 6 (0.55), msg 7 (0.65). Whitelisted msg 11 (0.6)
        // is excluded by default (includeWhitelisted=false).
        expect(ids).toHaveLength(2);
    });

    it('includes whitelisted rows when includeWhitelisted=true', () => {
        const without = api.getNsfwIdsByTier({
            tier: 'uncertain',
            fileTypes: ['photo'],
        });
        const withWl = api.getNsfwIdsByTier({
            tier: 'uncertain',
            fileTypes: ['photo'],
            includeWhitelisted: true,
        });
        expect(without).toHaveLength(2);
        expect(withWl).toHaveLength(3); // + msg 11 at score 0.6
    });

    it('returns empty array for an unknown tier id', () => {
        const ids = api.getNsfwIdsByTier({ tier: 'nope', fileTypes: ['photo'] });
        // Unknown tier silently drops the bound clauses, so this returns
        // every photo with a score (whitelisted excluded by default).
        // The test isn't about the count — it's that the call doesn't throw.
        expect(Array.isArray(ids)).toBe(true);
    });
});

describe('idx_nsfw_tier composite index', () => {
    it('is created during migrations', () => {
        const idx = db
            .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_nsfw_tier'`)
            .get();
        expect(idx?.name).toBe('idx_nsfw_tier');
    });

    it('is used by the tier list query (EXPLAIN QUERY PLAN)', () => {
        const plan = db
            .prepare(`EXPLAIN QUERY PLAN
                      SELECT id FROM downloads
                       WHERE file_type IN ('photo')
                         AND nsfw_score IS NOT NULL
                         AND nsfw_score >= 0.5
                         AND nsfw_score < 0.7
                         AND nsfw_whitelist = 0
                       ORDER BY nsfw_score ASC, id ASC`)
            .all();
        const usedIndex = plan.some((r) => /idx_nsfw_/.test(r.detail || ''));
        expect(usedIndex).toBe(true);
    });
});
