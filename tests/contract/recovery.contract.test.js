// Recovery cleanup contract (Maintenance → Recovery cleanup): the list of
// chats that can't be resolved (synthetic `unknown:` ids, `_resolveFailedAt`
// markers, chats the access registry has paused) and its bulk operations.
//
// Extra seed for this file:
//   - `unknown:Lost Folder` — synthetic id left by a re-index, with one row
//     and file on disk (for delete + purgeDownloads)
//   - `-1001000000009` Zeta Broken — `_resolveFailedAt` marker
//   - `-1001000000010` Eta Ignored — failed AND `_recoveryIgnored`
//   - Gamma Docs — paused by the seeded chat_access row (state 'left')

import fs from 'fs';
import path from 'path';
import { describe, it } from 'vitest';
import { useContract } from './harness.js';

const T = (iso) => Date.parse(`${iso}Z`);
const filters = {
    photos: true,
    videos: true,
    files: false,
    links: false,
    voice: false,
    gifs: false,
    stickers: false,
};
const LOST = 'unknown:Lost Folder';
const ZETA = '-1001000000009';
const ETA = '-1001000000010';
const GAMMA = '-1001000000003';

const h = useContract(import.meta.url, {
    configPatch: (cfg) => {
        cfg.groups.push(
            { id: LOST, name: 'Lost Folder', enabled: true, filters },
            {
                id: ZETA,
                name: 'Zeta Broken',
                enabled: true,
                filters,
                monitorAccount: 'acc-old',
                _resolveFailedAt: T('2024-07-01T00:00:00'),
                _resolveFailedReason: 'CHANNEL_PRIVATE',
            },
            {
                id: ETA,
                name: 'Eta Ignored',
                enabled: false,
                filters,
                _resolveFailedAt: T('2024-07-02T00:00:00'),
                _resolveFailedReason: 'USERNAME_NOT_OCCUPIED',
                _recoveryIgnored: true,
            },
        );
    },
    afterDb: (db) => {
        db.prepare(`
            INSERT INTO downloads (group_id, group_name, message_id, file_name, file_size, file_type, file_path, status, created_at)
            VALUES (?, 'Lost Folder', 900, 'IMG_0900.jpg', 3365, 'photo', 'Lost Folder/images/IMG_0900.jpg', 'completed', '2024-07-03 10:00:00')
        `).run(LOST);
    },
    beforeStart: (dataDir) => {
        const dir = path.join(dataDir, 'downloads', 'Lost Folder', 'images');
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(
            path.join(dataDir, 'downloads', 'Alpha Photos', 'images', 'IMG_0001.jpg'),
            path.join(dir, 'IMG_0900.jpg'),
        );
    },
});

const list = (t, label, q = '') => t.exchange(label, 'GET', `/api/maintenance/recovery/list${q}`);

describe('auth', () => {
    it('guest refused, anon unauthorised', async () => {
        const t = h.t;
        await t.exchange('guest GET recovery/list → 403', 'GET', '/api/maintenance/recovery/list', {
            as: 'guest',
        });
        await t.exchange(
            'anon POST recovery/disable → 401',
            'POST',
            '/api/maintenance/recovery/disable',
            {
                as: 'anon',
                body: { ids: [ZETA] },
            },
        );
    });
});

describe('list', () => {
    it('synthetic, failed and paused chats; ignored ones on request', async () => {
        const t = h.t;
        await list(t, 'recovery/list');
        await list(t, 'recovery/list showIgnored=1', '?showIgnored=1');
        await list(t, 'recovery/list countOnly=1', '?countOnly=1');
        await list(t, 'recovery/list countOnly=1 showIgnored=1', '?countOnly=1&showIgnored=1');
        await t.exchange('recovery/status idle', 'GET', '/api/maintenance/recovery/status');
    });
});

describe('validation', () => {
    it('every bulk op needs ids[]; reassign needs monitorAccount', async () => {
        const t = h.t;
        for (const op of ['resolve', 'disable', 'delete', 'reassign', 'ignore', 'unignore']) {
            await t.exchange(
                `recovery/${op} without ids → 400`,
                'POST',
                `/api/maintenance/recovery/${op}`,
                {
                    body: {},
                },
            );
        }
        await t.exchange(
            'recovery/disable ids not an array → 400',
            'POST',
            '/api/maintenance/recovery/disable',
            {
                body: { ids: ZETA },
            },
        );
        await t.exchange(
            'recovery/reassign without monitorAccount → 400',
            'POST',
            '/api/maintenance/recovery/reassign',
            {
                body: { ids: [ZETA] },
            },
        );
    });
});

describe('resolve', () => {
    it('runs as a job; with the engine stopped nothing is resolved', async () => {
        const t = h.t;
        const ws = t.ws();
        await ws.opened;
        ws.drain();
        await t.exchange('recovery/resolve', 'POST', '/api/maintenance/recovery/resolve', {
            body: { ids: [LOST, ZETA, 'no-such-group'] },
        });
        await ws.waitFor((m) => m.type === 'recovery_bulk_done', 20_000);
        ws.close();
        t.recordWs('recovery/resolve: ws sequence', ws.drain(), {
            collapse: ['recovery_bulk_progress'],
        });
        await t.exchange(
            'recovery/status after resolve',
            'GET',
            '/api/maintenance/recovery/status',
        );
    });
});

describe('bulk edits', () => {
    it('disable flips enabled:false for known ids only', async () => {
        const t = h.t;
        await t.exchange('recovery/disable', 'POST', '/api/maintenance/recovery/disable', {
            body: { ids: [LOST, 'no-such-group'] },
        });
        await t.exchange(
            'recovery/disable unknown only',
            'POST',
            '/api/maintenance/recovery/disable',
            {
                body: { ids: ['no-such-group'] },
            },
        );
        await list(t, 'recovery/list after disable');
    });

    it('ignore hides, unignore restores', async () => {
        const t = h.t;
        await t.exchange('recovery/ignore', 'POST', '/api/maintenance/recovery/ignore', {
            body: { ids: [LOST] },
        });
        await list(t, 'recovery/list after ignore');
        await t.exchange('recovery/unignore', 'POST', '/api/maintenance/recovery/unignore', {
            body: { ids: [LOST, ETA] },
        });
        await list(t, 'recovery/list after unignore');
    });

    it('reassign pins an account and clears the failure marker', async () => {
        const t = h.t;
        await t.exchange('recovery/reassign', 'POST', '/api/maintenance/recovery/reassign', {
            body: { ids: [ZETA], monitorAccount: 42 },
        });
        await list(t, 'recovery/list after reassign');
    });
});

describe('delete', () => {
    it('drops the config entry; purgeDownloads also drops its rows', async () => {
        const t = h.t;
        await t.exchange(
            'recovery/delete with purgeDownloads',
            'POST',
            '/api/maintenance/recovery/delete',
            {
                body: { ids: [LOST], purgeDownloads: true },
            },
        );
        await t.exchange(
            'recovery/delete again (already gone)',
            'POST',
            '/api/maintenance/recovery/delete',
            {
                body: { ids: [LOST] },
            },
        );
    });

    it('deleting a paused chat clears its access record (chat_access_changed)', async () => {
        const t = h.t;
        const ws = t.ws();
        await ws.opened;
        ws.drain();
        await t.exchange(
            'recovery/delete paused chat (no purge)',
            'POST',
            '/api/maintenance/recovery/delete',
            {
                body: { ids: [GAMMA] },
            },
        );
        await ws.waitFor((m) => m.type === 'chat_access_changed', 10_000);
        ws.close();
        t.recordWs('recovery/delete paused chat: ws sequence', ws.drain());
        await list(t, 'recovery/list after deletes', '?showIgnored=1');
        await t.exchange(
            'Gamma rows are kept without purgeDownloads',
            'GET',
            `/api/groups/${GAMMA}/stats`,
        );
    });
});
