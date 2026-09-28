// Delete contract (destructive — own server, fixed order):
//   DELETE /api/file?path=…[&id=…]   single file, dedup-aware
//   POST   /api/downloads/bulk-delete  ids and/or paths, fire-and-forget
//                                      job with WS progress
// Download-time dedup means several rows can point at one file: removing
// one row must keep the file while another row still uses it. Deletes
// cascade to share links, faces (→ orphan people) and seekbar sprites.

import { describe, expect, it } from 'vitest';
import { SEED, useContract } from './harness.js';

const IGNORE = ['monitor_status_push', 'stats_push', 'log', 'stats_update'];

const h = useContract(import.meta.url, {
    // Row 21: a second (Gamma) row that reuses Beta's IMG_0009.jpg file.
    afterDb(db) {
        db.prepare(`
            INSERT INTO downloads (group_id, group_name, message_id, file_name, file_size, file_type,
                file_path, status, created_at, file_hash, pinned)
            SELECT ?, 'Gamma Docs', 921, file_name, file_size, file_type, file_path, 'completed',
                '2024-06-02 10:00:00', file_hash, 0
              FROM downloads WHERE id = 9
        `).run(SEED.groups.gamma.id);
    },
});

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const del = (p, qs = '') => `/api/file?path=${encodeURIComponent(p)}${qs}`;

async function withWs(t, label, fn, until) {
    const ws = t.ws({ as: 'admin' });
    await ws.opened;
    ws.drain();
    await fn();
    await ws.waitFor(until);
    ws.close();
    t.recordWs(label, ws.drain(), { ignore: IGNORE });
}

describe('DELETE /api/file', () => {
    it('validation and guards', async () => {
        const t = h.t;
        await t.exchange('delete without path → 400', 'DELETE', '/api/file');
        await t.exchange('delete traversal → 403', 'DELETE', del('../db.sqlite'));
        await t.exchange(
            'delete missing file → 404',
            'DELETE',
            del('Alpha Photos/images/nope.jpg'),
        );
        await t.exchange('delete path in body is ignored → 400', 'DELETE', '/api/file', {
            body: { path: 'Alpha Photos/images/IMG_0003.png' },
        });
        await t.exchange('delete guest → 403', 'DELETE', del('Alpha Photos/images/IMG_0003.png'), {
            as: 'guest',
        });
        await t.exchange('delete anon → 401', 'DELETE', del('Alpha Photos/images/IMG_0003.png'), {
            as: 'anon',
        });
    });

    it('deletes a single-owner file and its row', async () => {
        const t = h.t;
        await withWs(
            t,
            'ws events: delete single-owner file',
            () =>
                t.exchange(
                    'delete IMG_0003.png',
                    'DELETE',
                    del('Alpha Photos/images/IMG_0003.png'),
                ),
            (m) => m.type === 'file_deleted',
        );
        await t.exchange(
            'deleted file is gone from /files',
            'GET',
            `/files/${enc('Alpha Photos/images/IMG_0003.png')}`,
        );
    });

    it('dedup: ?id= removes one row and keeps the shared file', async () => {
        const t = h.t;
        const shared = 'Delta Mixed/images/IMG_0014.jpg';
        await withWs(
            t,
            'ws events: delete one reference of a shared file',
            () => t.exchange('delete shared file ?id=15', 'DELETE', del(shared, '&id=15')),
            (m) => m.type === 'file_deleted',
        );
        await t.exchange('shared file still served', 'GET', `/files/${enc(shared)}`);
        await t.exchange(
            'delta group after ?id= delete',
            'GET',
            `/api/downloads/${SEED.groups.delta.id}`,
        );
        await withWs(
            t,
            'ws events: delete last reference',
            () => t.exchange('delete shared file without id', 'DELETE', del(shared)),
            (m) => m.type === 'file_deleted',
        );
        await t.exchange('shared file gone after last reference', 'GET', `/files/${enc(shared)}`);
    });

    it('?id= of another file falls back to the path', async () => {
        const t = h.t;
        await t.exchange(
            'delete IMG_0002 with id of row 5',
            'DELETE',
            del('Alpha Photos/images/IMG_0002.jpg', '&id=5'),
        );
        await t.exchange(
            'alpha group after mismatched-id delete',
            'GET',
            `/api/downloads/${SEED.groups.alpha.id}`,
        );
    });

    it('cascades to share links and orphaned people', async () => {
        const t = h.t;
        await t.exchange(
            'delete IMG_0001 (shared link, face)',
            'DELETE',
            del('Alpha Photos/images/IMG_0001.jpg', '&id=1'),
        );
        await t.exchange('share links after cascade', 'GET', '/api/share/links');
        await t.exchange('people after cascade', 'GET', '/api/ai/people');
    });
});

describe('POST /api/downloads/bulk-delete', () => {
    it('validation', async () => {
        const t = h.t;
        const b = (label, body, o = {}) =>
            t.exchange(label, 'POST', '/api/downloads/bulk-delete', { body, ...o });
        await b('bulk-delete empty body → 400', {});
        await b('bulk-delete empty lists → 400', { ids: [], paths: [] });
        await b('bulk-delete null id coerces to 0 → 200', { ids: ['x', null] });
        await b('bulk-delete paths not an array → 400', {
            paths: 'Alpha Photos/images/IMG_0004.webp',
        });
        await b('bulk-delete guest → 403', { ids: [4] }, { as: 'guest' });
    });

    const done = (m) => m.type === 'dedup_delete_done';

    it('by ids (unknown ids are counted but harmless)', async () => {
        const t = h.t;
        await withWs(
            t,
            'ws events: bulk-delete by ids',
            () =>
                t.exchange(
                    'bulk-delete ids 4 + 6 + unknown',
                    'POST',
                    '/api/downloads/bulk-delete',
                    {
                        body: { ids: [4, 6, 9999] },
                    },
                ),
            done,
        );
        await t.exchange(
            'bulk-deleted photo is gone',
            'GET',
            `/files/${enc('Alpha Photos/images/IMG_0004.webp')}`,
        );
        await t.exchange('bulk-deleted video sprite is gone', 'GET', '/api/seekbar/meta/6');
    });

    it('by paths, including one that matches nothing', async () => {
        const t = h.t;
        await withWs(
            t,
            'ws events: bulk-delete by paths',
            () =>
                t.exchange('bulk-delete paths', 'POST', '/api/downloads/bulk-delete', {
                    body: { paths: ['Beta Videos/videos/VID_0008.mp4', 'Nowhere/x.jpg'] },
                }),
            done,
        );
        await t.exchange(
            'beta group after path delete',
            'GET',
            `/api/downloads/${SEED.groups.beta.id}`,
        );
    });

    it('a row whose file another row still uses keeps the file', async () => {
        const t = h.t;
        const shared = 'Beta Videos/images/IMG_0009.jpg';
        await withWs(
            t,
            'ws events: bulk-delete one reference of a shared file',
            () =>
                t.exchange(
                    'bulk-delete row 9 (file shared with row 21)',
                    'POST',
                    '/api/downloads/bulk-delete',
                    {
                        body: { ids: [9] },
                    },
                ),
            done,
        );
        await t.exchange(
            'shared file still served after bulk-delete',
            'GET',
            `/files/${enc(shared)}`,
        );
        await withWs(
            t,
            'ws events: bulk-delete by path takes every row of the file',
            () =>
                t.exchange('bulk-delete the shared path', 'POST', '/api/downloads/bulk-delete', {
                    body: { paths: [shared] },
                }),
            done,
        );
        await t.exchange('shared file gone after path bulk-delete', 'GET', `/files/${enc(shared)}`);
    });

    it('library after all deletes', async () => {
        const t = h.t;
        await t.exchange('aggregate after deletes', 'GET', '/api/downloads');
        const all = await t.exchange(
            'all-media after deletes',
            'GET',
            '/api/downloads/all?limit=100',
        );
        expect(all.json.total).toBeGreaterThan(0);
    });
});
