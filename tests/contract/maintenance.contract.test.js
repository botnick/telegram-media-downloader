// Maintenance jobs contract: SQLite integrity check, VACUUM, "Verify files"
// (integrity sweep: prune rows whose file is gone, fix stored sizes) and
// "Re-index from disk".
//
// Every job goes through the shared job tracker: POST answers at once,
// `<prefix>_progress` / `<prefix>_done` arrive over the dashboard socket,
// GET …/status reports the tracker snapshot. Progress-tick counts depend on
// timing, so consecutive `_progress` frames are collapsed in the recorded
// sequences.

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { useContract } from './harness.js';

const h = useContract(import.meta.url, {
    // Row 13 (notes.txt.gz) gets a wrong stored size so the sweep has a
    // size to fix.
    afterDb: (db) => db.prepare('UPDATE downloads SET file_size = 1 WHERE id = 13').run(),
});

async function runJob(t, label, { path: postPath, body, prefix, done, mask }) {
    const ws = t.ws();
    await ws.opened;
    ws.drain();
    await t.exchange(`${label}: start`, 'POST', postPath, { body });
    await ws.waitFor(done ?? ((m) => m.type === `${prefix}_done`), 30_000);
    ws.close();
    t.recordWs(`${label}: ws sequence`, ws.drain(), {
        collapse: [`${prefix}_progress`],
        ...(mask ? { mask } : {}),
    });
}

describe('auth on maintenance job routes', () => {
    it('guest is refused, anon is unauthorised', async () => {
        const t = h.t;
        await t.exchange('guest POST db/integrity → 403', 'POST', '/api/maintenance/db/integrity', {
            as: 'guest',
            body: {},
        });
        await t.exchange(
            'guest GET files/verify/status → 403',
            'GET',
            '/api/maintenance/files/verify/status',
            {
                as: 'guest',
            },
        );
        await t.exchange(
            'anon GET reindex/status → 401',
            'GET',
            '/api/maintenance/reindex/status',
            {
                as: 'anon',
            },
        );
        await t.exchange('anon POST db/vacuum → 401', 'POST', '/api/maintenance/db/vacuum', {
            as: 'anon',
            body: { confirm: true },
        });
    });
});

describe('db integrity check', () => {
    it('idle status, run, final status', async () => {
        const t = h.t;
        await t.exchange('db/integrity/status idle', 'GET', '/api/maintenance/db/integrity/status');
        await runJob(t, 'db/integrity', {
            path: '/api/maintenance/db/integrity',
            body: {},
            prefix: 'db_integrity',
        });
        await t.exchange(
            'db/integrity/status after run',
            'GET',
            '/api/maintenance/db/integrity/status',
        );
    });
});

describe('files verify (integrity sweep)', () => {
    it('prunes the row of a file deleted on disk and fixes a wrong stored size', async () => {
        const t = h.t;
        await t.exchange(
            'files/verify/stats before any run',
            'GET',
            '/api/maintenance/files/verify/stats',
        );
        await t.exchange('files/verify/status idle', 'GET', '/api/maintenance/files/verify/status');
        // Row 11's file disappears behind the app's back.
        if (t.dataDir) {
            fs.rmSync(path.join(t.dataDir, 'downloads', 'Gamma Docs', 'documents', 'notes.txt'));
        }
        await runJob(t, 'files/verify', {
            path: '/api/maintenance/files/verify',
            body: {},
            prefix: 'files_verify',
        });
        await t.exchange(
            'files/verify/status after run',
            'GET',
            '/api/maintenance/files/verify/status',
        );
        await t.exchange(
            'files/verify/stats after run',
            'GET',
            '/api/maintenance/files/verify/stats',
            {
                note: 'lastRun.removed stays 0 although a row was pruned: the summary reads result.removed/dropped, the sweep returns `pruned`',
            },
        );
        await t.exchange(
            'Gamma Docs downloads after the sweep',
            'GET',
            '/api/downloads/-1001000000003',
            {
                note: 'Gamma Docs after the sweep: notes.txt row gone',
            },
        );
    });
});

describe('re-index from disk', () => {
    const readdirMask = {
        currentGroup:
            'last folder processed; folder walk order is the filesystem readdir order (NTFS alphabetical, ext4 hash order)',
        'progress.currentGroup':
            'last folder processed; folder walk order is the filesystem readdir order (NTFS alphabetical, ext4 hash order)',
    };

    it('stats and status before any run', async () => {
        const t = h.t;
        await t.exchange('reindex/stats before any run', 'GET', '/api/maintenance/reindex/stats');
        await t.exchange('reindex/status idle', 'GET', '/api/maintenance/reindex/status');
    });

    it('first run adds a row for every file whose (chat, message id) pair is unknown', async () => {
        const t = h.t;
        await runJob(t, 'reindex (first)', {
            path: '/api/maintenance/reindex',
            body: {},
            prefix: 'reindex',
            // Two reindex_done frames: integrity.js's own, then the tracker's.
            done: (m) => m.type === 'reindex_done' && m.kind === 'reindex',
        });
        await t.exchange(
            'reindex/status after first run',
            'GET',
            '/api/maintenance/reindex/status',
            {
                mask: readdirMask,
            },
        );
        await t.exchange('reindex/stats after first run', 'GET', '/api/maintenance/reindex/stats');
    });

    it('second run is idempotent (nothing added)', async () => {
        const t = h.t;
        await runJob(t, 'reindex (second)', {
            path: '/api/maintenance/reindex',
            body: {},
            prefix: 'reindex',
            done: (m) => m.type === 'reindex_done' && m.kind === 'reindex',
        });
        await t.exchange(
            'reindex/status after second run',
            'GET',
            '/api/maintenance/reindex/status',
            {
                mask: readdirMask,
            },
        );
    });
});

describe('VACUUM', () => {
    const bytesReason =
        'SQLite page accounting: depends on the free-list/WAL state left by every earlier write (config JSON size, kv rows) — implementation detail; relation checked separately';

    it('requires {"confirm": true}', async () => {
        const t = h.t;
        await t.exchange('db/vacuum without confirm → 400', 'POST', '/api/maintenance/db/vacuum', {
            body: {},
        });
        await t.exchange('db/vacuum confirm:"yes" → 400', 'POST', '/api/maintenance/db/vacuum', {
            body: { confirm: 'yes' },
        });
        await t.exchange('db/vacuum/status idle', 'GET', '/api/maintenance/db/vacuum/status');
    });

    it('runs and reports reclaimed bytes', async () => {
        const t = h.t;
        await runJob(t, 'db/vacuum', {
            path: '/api/maintenance/db/vacuum',
            body: { confirm: true },
            prefix: 'db_vacuum',
            mask: {
                beforeBytes: bytesReason,
                afterBytes: bytesReason,
                reclaimedBytes: bytesReason,
            },
        });
        const res = await t.request('GET', '/api/maintenance/db/vacuum/status');
        await t.record(
            'db/vacuum/status after run',
            { method: 'GET', path: '/api/maintenance/db/vacuum/status', as: 'admin' },
            res,
            {
                mask: {
                    'result.beforeBytes': bytesReason,
                    'result.afterBytes': bytesReason,
                    'result.reclaimedBytes': bytesReason,
                },
            },
        );
        const r = res.json.result;
        const facts = {
            route: 'GET /api/maintenance/db/vacuum/status',
            derived: {
                allIntegers: [r.beforeBytes, r.afterBytes, r.reclaimedBytes].every(
                    Number.isInteger,
                ),
                afterNotLarger: r.afterBytes <= r.beforeBytes,
                reclaimedIsDifference:
                    r.reclaimedBytes === Math.max(0, r.beforeBytes - r.afterBytes),
                pageMultiple: r.beforeBytes % 4096 === 0 && r.afterBytes % 4096 === 0,
            },
        };
        expect(facts.derived.allIntegers).toBe(true);
        t.store.record('db/vacuum result relations', facts);
    });
});
