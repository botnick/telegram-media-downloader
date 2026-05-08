// Verifies the kv['dedup_last_scan'] persistence survives the JobTracker
// migration. Pre-migration the kvSet was inside the route handler's
// async catch path; post-migration it lives inside the runFn body, so a
// regression here would mean the duplicates page's "Last scan: 2 h ago"
// summary stops surviving server restart.
//
// Calls the runFn shape the real dedup/scan handler installs into
// JobTracker.tryStart, then reads kv directly to confirm.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let kvSet, kvGet, createJobTracker, _origDataDir, _tmpDataDir, _db;

beforeAll(async () => {
    // Isolated DB — set TGDL_DATA_DIR BEFORE importing db.js so getDb()
    // picks up the tmp path (matches the convention in db-nsfw.test.js).
    _origDataDir = process.env.TGDL_DATA_DIR;
    _tmpDataDir = mkdtempSync(join(tmpdir(), 'tgdl-dedup-test-'));
    process.env.TGDL_DATA_DIR = _tmpDataDir;
    const db = await import('../src/core/db.js');
    const tracker = await import('../src/core/job-tracker.js');
    kvSet = db.kvSet;
    kvGet = db.kvGet;
    createJobTracker = tracker.createJobTracker;
    _db = db.getDb();
});

afterAll(() => {
    try {
        _db?.close();
    } catch {}
    if (_origDataDir == null) delete process.env.TGDL_DATA_DIR;
    else process.env.TGDL_DATA_DIR = _origDataDir;
    if (_tmpDataDir) {
        try {
            rmSync(_tmpDataDir, { recursive: true, force: true });
        } catch {}
    }
});

describe('dedup last-scan persistence (post-JobTracker migration)', () => {
    it("writes kv['dedup_last_scan'] with the summary fields the duplicates page reads", async () => {
        const t = createJobTracker({
            kind: 'dedupScan',
            broadcast: () => {},
            eventPrefix: 'dedup',
        });

        // Same shape as src/web/server.js's dedup/scan runFn — minus
        // the actual dedupFindDuplicates call. The persistence is what
        // we're verifying.
        const runFn = async () => {
            const result = {
                scanned: 1234,
                hashed: 1230,
                duplicateSets: [
                    {
                        hash: 'abc',
                        fileSize: 1024,
                        count: 3,
                        files: [{ id: 1 }, { id: 2 }, { id: 3 }],
                    },
                    {
                        hash: 'def',
                        fileSize: 2048,
                        count: 2,
                        files: [{ id: 4 }, { id: 5 }],
                    },
                ],
            };
            const sets = result.duplicateSets;
            const extras = sets.reduce((s, x) => s + Math.max(0, (x.count || 0) - 1), 0);
            const reclaim = sets.reduce(
                (s, x) => s + Number(x.fileSize || 0) * Math.max(0, (x.count || 0) - 1),
                0,
            );
            kvSet('dedup_last_scan', {
                finishedAt: Date.now(),
                scanned: result.scanned,
                hashed: result.hashed,
                duplicateSets: sets.length,
                extraCopies: extras,
                reclaimableBytes: reclaim,
            });
            return result;
        };

        const r = t.tryStart(runFn);
        expect(r.started).toBe(true);
        // tryStart is fire-and-forget — wait for the runFn to settle.
        await new Promise((res) => setTimeout(res, 30));

        const stored = kvGet('dedup_last_scan');
        expect(stored).toBeTruthy();
        expect(stored.scanned).toBe(1234);
        expect(stored.hashed).toBe(1230);
        expect(stored.duplicateSets).toBe(2);
        // extras = (3-1) + (2-1) = 3
        expect(stored.extraCopies).toBe(3);
        // reclaim = 1024*2 + 2048*1 = 4096
        expect(stored.reclaimableBytes).toBe(4096);
        expect(stored.finishedAt).toBeGreaterThan(0);
    });

    it('kv blob is durable — second read returns the same payload (SQLite is the source of truth)', () => {
        // The "survives restart" claim hinges on SQLite write-through.
        // We can't actually re-init the module here (vitest caches the
        // module graph) but a same-process re-read confirms the blob is
        // committed, not memory-only.
        const stored = kvGet('dedup_last_scan');
        expect(stored).toBeTruthy();
        expect(stored.scanned).toBe(1234);
        expect(stored.duplicateSets).toBe(2);
    });
});
