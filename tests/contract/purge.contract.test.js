// Destructive group flows: "delete files only" (keeps the config entry),
// per-group purge (drops files, rows, config entry, avatar, access record)
// and the factory reset (DELETE /api/purge/all) on its own server.
//
// The shared seed stores its folders with spaces ("Alpha Photos/…"), while
// the downloader — and the purge code, via sanitizeName() — use
// underscores ("Alpha_Photos/…"). Two extra groups are seeded here with
// downloader-shaped folders so the file side of the purge is exercised
// for real; purging a seed group records what happens when the folder
// name doesn't match (rows go, files stay).

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { describe, it } from 'vitest';
import { AMBIENT_WS_TYPES, SEED, useContract } from './harness.js';

const G = SEED.groups;
const MEDIA = path.join(import.meta.dirname, 'fixtures', 'media');
const ZETA = { id: '-1001000000007', name: 'Zeta Real', dir: 'Zeta_Real' };
const ETA = { id: '-1001000000008', name: 'Eta Real', dir: 'Eta_Real' };
// `stats_update` is a 400 ms-debounced push after stats-changing events;
// its position among the recorded events depends on timing.
const WS_IGNORE = [...AMBIENT_WS_TYPES, 'stats_update'];

// [id, group, media, relative path, type, message id]
const EXTRA_ROWS = [
    [21, ZETA, 'photo-a.jpg', 'Zeta_Real/images/Z1.jpg', 'photo', 201],
    [22, ZETA, 'photo-b.jpg', 'Zeta_Real/images/Z2.jpg', 'photo', 202],
    [23, ZETA, 'clip-a.mp4', 'Zeta_Real/videos/Z3.mp4', 'video', 203],
    // Download-time dedup reference from another group into Zeta's folder.
    [24, G.beta, 'photo-b.jpg', 'Zeta_Real/images/Z2.jpg', 'photo', 299],
    [25, ETA, 'photo-c.png', 'Eta_Real/images/E1.png', 'photo', 301],
    [26, ETA, 'notes.txt', 'Eta_Real/documents/E2.txt', 'document', 302],
];

function seedExtraRows(db) {
    const ins = db.prepare(`
        INSERT INTO downloads (id, group_id, group_name, message_id, file_name, file_size, file_type,
            file_path, status, created_at, file_hash, pinned)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, 0)
    `);
    for (const [id, g, media, rel, type, msg] of EXTRA_ROWS) {
        const buf = fs.readFileSync(path.join(MEDIA, media));
        ins.run(
            id,
            g.id,
            g.name,
            msg,
            path.posix.basename(rel),
            buf.length,
            type,
            rel,
            `2024-07-${String(id - 10).padStart(2, '0')} 10:00:00`,
            crypto.createHash('sha256').update(buf).digest('hex'),
        );
    }
    // A share link and a face on an Eta row: the purge must take them along.
    db.prepare(
        'INSERT INTO share_links (download_id, created_at, expires_at, revoked_at, label, last_accessed_at, access_count) VALUES (25, 1717200000, 4102444800, NULL, ?, NULL, 0)',
    ).run('eta link');
    const now = Date.UTC(2024, 5, 2);
    const vec = Buffer.alloc(512 * 4, 1);
    const pid = db
        .prepare(
            'INSERT INTO people (label, embedding_centroid, face_count, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
        )
        .run('Eta only', vec, now, now).lastInsertRowid;
    db.prepare(
        'INSERT INTO faces (download_id, x, y, w, h, embedding, person_id, quality_score, exif_oriented) VALUES (25, 10, 10, 40, 40, ?, ?, 0.9, 1)',
    ).run(vec, pid);
}

function seedExtraFiles(dataDir) {
    const t = new Date(Date.UTC(2024, 0, 2, 3, 4, 5));
    for (const [, , media, rel] of EXTRA_ROWS) {
        const abs = path.join(dataDir, 'downloads', ...rel.split('/'));
        if (fs.existsSync(abs)) continue;
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.copyFileSync(path.join(MEDIA, media), abs);
        fs.utimesSync(abs, t, t);
    }
    fs.copyFileSync(path.join(MEDIA, 'photo-e.jpg'), path.join(dataDir, 'photos', `${ETA.id}.jpg`));
}

const h = useContract(import.meta.url, {
    configPatch(cfg) {
        cfg.groups.push({ id: ZETA.id, name: ZETA.name, enabled: true });
        cfg.groups.push({ id: ETA.id, name: ETA.name, enabled: true });
    },
    afterDb: seedExtraRows,
    beforeStart: seedExtraFiles,
});

/** Run a group job and record its WS sequence up to `<prefix>_done`. */
async function runJob(
    t,
    label,
    method,
    url,
    body,
    { doneType = 'group_purge_done', extraWait } = {},
) {
    const ws = t.ws({ as: 'admin' });
    await ws.opened;
    ws.drain();
    await t.exchange(label, method, url, body === undefined ? {} : { body });
    await ws.waitFor((m) => m.type === doneType);
    if (extraWait) await ws.waitFor(extraWait);
    ws.close();
    return ws.drain();
}

describe('guards', () => {
    it('guest and anonymous cannot purge', async () => {
        const t = h.t;
        await t.exchange('purge group guest → 403', 'DELETE', `/api/groups/${ZETA.id}/purge`, {
            as: 'guest',
        });
        await t.exchange('purge group anon → 401', 'DELETE', `/api/groups/${ZETA.id}/purge`, {
            as: 'anon',
        });
        await t.exchange(
            'delete-files guest → 403',
            'POST',
            `/api/groups/${ZETA.id}/delete-files`,
            {
                as: 'guest',
                body: {},
            },
        );
        await t.exchange('purge all guest → 403', 'DELETE', '/api/purge/all', { as: 'guest' });
        await t.exchange('purge all anon → 401', 'DELETE', '/api/purge/all', { as: 'anon' });
        await t.exchange('purge all status guest → 403', 'GET', '/api/purge/all/status', {
            as: 'guest',
        });
        await t.exchange(
            'group purge status guest (allow-listed prefix)',
            'GET',
            `/api/groups/${ZETA.id}/purge/status`,
            {
                as: 'guest',
            },
        );
    });
});

describe('POST /api/groups/:id/delete-files', () => {
    it('deletes rows + files but keeps files another group uses and the config entry', async () => {
        const t = h.t;
        await t.exchange('purge status zeta idle', 'GET', `/api/groups/${ZETA.id}/purge/status`);
        const events = await runJob(
            t,
            'delete-files zeta',
            'POST',
            `/api/groups/${ZETA.id}/delete-files`,
            {},
        );
        t.recordWs('ws delete-files zeta', events, { ignore: WS_IGNORE });
        await t.exchange(
            'purge status zeta after delete-files',
            'GET',
            `/api/groups/${ZETA.id}/purge/status`,
        );
        await t.exchange('zeta Z1 file gone', 'GET', '/files/Zeta_Real/images/Z1.jpg');
        await t.exchange('zeta Z2 kept (used by beta)', 'GET', '/files/Zeta_Real/images/Z2.jpg', {
            bodyMode: 'sha256',
        });
        await t.exchange('stats zeta after delete-files', 'GET', `/api/groups/${ZETA.id}/stats`);
        await t.exchange(
            'stats beta keeps its reference row',
            'GET',
            `/api/groups/${G.beta.id}/stats`,
        );
    });

    it('a group with nothing on disk or in the DB', async () => {
        const t = h.t;
        const events = await runJob(
            t,
            'delete-files empty group',
            'POST',
            '/api/groups/-1009999999999/delete-files',
            {},
        );
        t.recordWs('ws delete-files empty group', events, { ignore: WS_IGNORE });
    });
});

describe('DELETE /api/groups/:id/purge', () => {
    it('purges a group with a downloader-shaped folder', async () => {
        const t = h.t;
        const events = await runJob(t, 'purge eta', 'DELETE', `/api/groups/${ETA.id}/purge`);
        t.recordWs('ws purge eta', events, { ignore: WS_IGNORE });
        await t.exchange('purge status eta done', 'GET', `/api/groups/${ETA.id}/purge/status`);
        await t.exchange('eta file gone', 'GET', '/files/Eta_Real/images/E1.png');
        await t.exchange('eta avatar gone', 'GET', `/api/groups/${ETA.id}/photo`);
        await t.exchange('eta share link cascaded away', 'GET', '/api/share/links?downloadId=25');
        await t.exchange('stats eta after purge', 'GET', `/api/groups/${ETA.id}/stats`);
    });

    it('purges a seed group whose folder name does not match sanitizeName', async () => {
        const t = h.t;
        const ws = t.ws({ as: 'admin' });
        await ws.opened;
        ws.drain();
        await t.exchange('purge gamma (blocked chat)', 'DELETE', `/api/groups/${G.gamma.id}/purge`);
        await ws.waitFor((m) => m.type === 'group_purge_done');
        await ws.waitFor((m) => m.type === 'chat_access_changed');
        ws.close();
        const events = ws.drain();
        // The access-record change is flushed on its own 500 ms timer, so
        // it is recorded apart from the purge sequence.
        t.recordWs('ws purge gamma', events, { ignore: [...WS_IGNORE, 'chat_access_changed'] });
        t.recordWs(
            'ws purge gamma access change',
            events.filter((m) => m.type === 'chat_access_changed'),
        );
        await t.exchange(
            'gamma file still on disk',
            'GET',
            '/files/Gamma%20Docs/documents/notes.txt',
        );
        await t.exchange('stats gamma after purge', 'GET', `/api/groups/${G.gamma.id}/stats`);
        await t.exchange('access list after gamma purge', 'GET', '/api/chats/access');
    });

    it('purging an id nobody knows still runs', async () => {
        const t = h.t;
        const events = await runJob(
            t,
            'purge unknown group',
            'DELETE',
            '/api/groups/-1009999999998/purge',
        );
        t.recordWs('ws purge unknown group', events, { ignore: WS_IGNORE });
        await t.exchange(
            'purge status unknown group',
            'GET',
            '/api/groups/-1009999999998/purge/status',
        );
    });

    it('the group list reflects the purges', async () => {
        await h.t.exchange('groups after purges', 'GET', '/api/groups');
    });
});

describe('DELETE /api/purge/all (factory reset, own server)', () => {
    it('wipes files, rows, caches, config groups and avatars', async () => {
        const t2 = await h.extra();
        await t2.exchange('purge all status idle', 'GET', '/api/purge/all/status');
        const events = await runJob(t2, 'purge all', 'DELETE', '/api/purge/all', undefined, {
            doneType: 'purge_all_done',
        });
        t2.recordWs('ws purge all', events, { ignore: WS_IGNORE });
        await t2.exchange('purge all status done', 'GET', '/api/purge/all/status');
        await t2.exchange('groups after purge all', 'GET', '/api/groups');
        await t2.exchange('downloads after purge all', 'GET', '/api/downloads');
        await t2.exchange(
            'alpha avatar gone after purge all',
            'GET',
            `/api/groups/${G.alpha.id}/photo`,
        );
        await t2.exchange(
            'alpha file gone after purge all',
            'GET',
            '/files/Alpha%20Photos/images/IMG_0001.jpg',
        );
        const again = await runJob(
            t2,
            'purge all again (empty library)',
            'DELETE',
            '/api/purge/all',
            undefined,
            {
                doneType: 'purge_all_done',
            },
        );
        t2.recordWs('ws purge all again', again, { ignore: WS_IGNORE });
        await t2.exchange('purge all status after second run', 'GET', '/api/purge/all/status');
    });
});
