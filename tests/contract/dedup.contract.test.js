// Duplicate finder contract: hash-coverage stats, duplicate sets rebuilt
// from stored hashes, the catch-up hashing scan (dedup_* WS events), and
// the bulk delete used by the Duplicates page (dedup_delete_* + bulk_delete).
//
// Seed content pairs: rows 1/14/15 (15 is a download-time dedup reference
// to 14's file), 6/8, 7/20, 3/18, 4/19, 2/16, 9/17. Rows 18–20 start
// without a stored hash so the scan has something to hash.

import { describe, it } from 'vitest';
import { useContract } from './harness.js';

const h = useContract(import.meta.url, {
    afterDb: (db) =>
        db.prepare('UPDATE downloads SET file_hash = NULL WHERE id IN (18, 19, 20)').run(),
});

async function runJob(t, label, { path, body, prefix }) {
    const ws = t.ws();
    await ws.opened;
    ws.drain();
    await t.exchange(`${label}: start`, 'POST', path, { body });
    await ws.waitFor((m) => m.type === `${prefix}_done`, 30_000);
    ws.close();
    t.recordWs(`${label}: ws sequence`, ws.drain(), { collapse: [`${prefix}_progress`] });
}

describe('auth', () => {
    it('guest refused, anon unauthorised', async () => {
        const t = h.t;
        await t.exchange('guest GET dedup/sets → 403', 'GET', '/api/maintenance/dedup/sets', {
            as: 'guest',
        });
        await t.exchange('guest POST dedup/delete → 403', 'POST', '/api/maintenance/dedup/delete', {
            as: 'guest',
            body: { ids: [14] },
        });
        await t.exchange('anon POST dedup/scan → 401', 'POST', '/api/maintenance/dedup/scan', {
            as: 'anon',
            body: {},
        });
    });
});

describe('before a scan', () => {
    it('stats count the rows still missing a hash', async () => {
        await h.t.exchange('dedup/stats before scan', 'GET', '/api/maintenance/dedup/stats');
    });
    it('sets are rebuilt from the hashes already stored', async () => {
        await h.t.exchange('dedup/sets before scan', 'GET', '/api/maintenance/dedup/sets');
    });
    it('status is idle; stop while idle is a no-op', async () => {
        const t = h.t;
        await t.exchange('dedup/status idle', 'GET', '/api/maintenance/dedup/status');
        await t.exchange('dedup/scan/stop while idle', 'POST', '/api/maintenance/dedup/scan/stop', {
            body: {},
        });
        await t.exchange('dedup/delete/status idle', 'GET', '/api/maintenance/dedup/delete/status');
    });
});

describe('scan', () => {
    it('hashes the missing rows and reports every duplicate set', async () => {
        const t = h.t;
        await runJob(t, 'dedup/scan', {
            path: '/api/maintenance/dedup/scan',
            body: {},
            prefix: 'dedup',
        });
        await t.exchange('dedup/status after scan', 'GET', '/api/maintenance/dedup/status');
        await t.exchange('dedup/stats after scan', 'GET', '/api/maintenance/dedup/stats');
        await t.exchange('dedup/sets after scan', 'GET', '/api/maintenance/dedup/sets');
    });

    it('a re-scan has nothing left to hash', async () => {
        const t = h.t;
        await runJob(t, 'dedup/scan (again)', {
            path: '/api/maintenance/dedup/scan',
            body: {},
            prefix: 'dedup',
        });
        await t.exchange('dedup/stats after re-scan', 'GET', '/api/maintenance/dedup/stats');
    });
});

describe('delete', () => {
    it('validates the id list', async () => {
        const t = h.t;
        await t.exchange(
            'dedup/delete without body → 400',
            'POST',
            '/api/maintenance/dedup/delete',
            {
                body: {},
            },
        );
        await t.exchange('dedup/delete empty ids → 400', 'POST', '/api/maintenance/dedup/delete', {
            body: { ids: [] },
        });
        await t.exchange(
            'dedup/delete ids not an array → 400',
            'POST',
            '/api/maintenance/dedup/delete',
            {
                body: { ids: '14' },
            },
        );
        await t.exchange(
            'dedup/delete only invalid ids → 400',
            'POST',
            '/api/maintenance/dedup/delete',
            {
                body: { ids: ['abc', -1, 0, 1.5] },
            },
        );
    });

    it('deleting one physical copy takes every row that uses it (14 + reference 15)', async () => {
        const t = h.t;
        await runJob(t, 'dedup/delete [14]', {
            path: '/api/maintenance/dedup/delete',
            body: { ids: [14] },
            prefix: 'dedup_delete',
        });
        await t.exchange(
            'dedup/delete/status after [14]',
            'GET',
            '/api/maintenance/dedup/delete/status',
        );
        await t.exchange('dedup/sets after deleting 14', 'GET', '/api/maintenance/dedup/sets');
        await t.exchange('dedup/stats after deleting 14', 'GET', '/api/maintenance/dedup/stats');
        await t.exchange(
            'deleted copy is gone from /files',
            'GET',
            '/files/Delta%20Mixed/images/IMG_0014.jpg',
        );
        await t.exchange(
            'kept copy still served',
            'GET',
            '/files/Alpha%20Photos/images/IMG_0001.jpg',
            {
                as: 'admin',
            },
        );
    });

    it('mixed batch: a separate copy, an unknown id and a duplicate id', async () => {
        const t = h.t;
        await runJob(t, 'dedup/delete [8, 9999, 8, "7"]', {
            path: '/api/maintenance/dedup/delete',
            body: { ids: [8, 9999, 8, '7'] },
            prefix: 'dedup_delete',
        });
        await t.exchange(
            'dedup/delete/status after mixed batch',
            'GET',
            '/api/maintenance/dedup/delete/status',
        );
        await t.exchange('dedup/sets after mixed batch', 'GET', '/api/maintenance/dedup/sets');
    });
});
