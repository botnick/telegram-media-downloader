// Groups contract: the sidebar list (with cluster federation merge), per-
// group config edits (PUT), avatars, per-group stats / file pages, and the
// two Telegram-backed background sweeps (refresh-info / refresh-photos),
// recorded with no Telegram account configured.
//
// Destructive per-group flows (delete-files, purge) live in
// purge.contract.test.js; chat access state in chats.contract.test.js.

import { describe, it } from 'vitest';
import { AMBIENT_WS_TYPES, SEED, useContract } from './harness.js';

const G = SEED.groups;
// `stats_update` is a 400 ms-debounced push (sent straight to the sockets,
// not through broadcast()) after any stats-changing event; where it lands
// relative to the events recorded here depends on timing.
const WS_IGNORE = [...AMBIENT_WS_TYPES, 'stats_update'];
const LEGACY_ID = '-1001000000006';

const h = useContract(import.meta.url, {
    configPatch(cfg) {
        // An entry an older version auto-disabled (legacy access flags).
        cfg.groups.push({
            id: LEGACY_ID,
            name: 'Zeta Suspended',
            enabled: false,
            suspended: true,
            _resolveFailedAt: Date.UTC(2024, 5, 20),
            _resolveFailedReason: 'resolve:CHANNEL_PRIVATE',
        });
    },
    afterDb(db) {
        // A paired peer's cached group list: one group we also have (→
        // mirroredOn) and one we don't (→ appended with peerId/peerName).
        db.prepare('INSERT INTO peer_groups (peer_id, payload, cached_at) VALUES (?, ?, ?)').run(
            SEED.peers.alpha.peerId,
            JSON.stringify({
                groups: [
                    { id: G.alpha.id, name: 'Alpha on peer', enabled: true },
                    { id: '-1009000000001', name: 'Remote Chat', enabled: true },
                ],
            }),
            Date.UTC(2024, 5, 6),
        );
    },
});

describe('GET /api/groups', () => {
    it('admin sees config groups plus federated peer groups', async () => {
        await h.t.exchange('groups admin', 'GET', '/api/groups');
    });
    it('guest sees local groups only, without account ids', async () => {
        await h.t.exchange('groups guest', 'GET', '/api/groups', { as: 'guest' });
    });
    it('anonymous is refused', async () => {
        await h.t.exchange('groups anon → 401', 'GET', '/api/groups', { as: 'anon' });
    });
});

describe('GET /api/groups/:id/stats and /files', () => {
    it('stats per group', async () => {
        const t = h.t;
        await t.exchange('stats alpha', 'GET', `/api/groups/${G.alpha.id}/stats`);
        await t.exchange(
            'stats epsilon (db-only group)',
            'GET',
            `/api/groups/${G.epsilon.id}/stats`,
        );
        await t.exchange('stats unknown group → zeros', 'GET', '/api/groups/-1009999999999/stats');
        await t.exchange(
            'stats as guest (allow-listed prefix)',
            'GET',
            `/api/groups/${G.beta.id}/stats`,
            {
                as: 'guest',
            },
        );
    });

    it('file pages with paging and type filter', async () => {
        const t = h.t;
        await t.exchange('files alpha default page', 'GET', `/api/groups/${G.alpha.id}/files`);
        await t.exchange(
            'files alpha limit=2 offset=1',
            'GET',
            `/api/groups/${G.alpha.id}/files?limit=2&offset=1`,
        );
        await t.exchange(
            'files alpha type=video',
            'GET',
            `/api/groups/${G.alpha.id}/files?type=video`,
        );
        await t.exchange(
            'files delta (unicode name, dedup ref)',
            'GET',
            `/api/groups/${G.delta.id}/files`,
        );
        await t.exchange(
            'files bad limit/offset fall back',
            'GET',
            `/api/groups/${G.gamma.id}/files?limit=abc&offset=-5`,
        );
        await t.exchange(
            'files limit clamps to 500',
            'GET',
            `/api/groups/${G.gamma.id}/files?limit=9999`,
        );
        await t.exchange('files unknown group', 'GET', '/api/groups/-1009999999999/files');
        await t.exchange('files as guest', 'GET', `/api/groups/${G.beta.id}/files?limit=1`, {
            as: 'guest',
        });
        await t.exchange('files anon → 401', 'GET', `/api/groups/${G.beta.id}/files`, {
            as: 'anon',
        });
    });
});

describe('GET /api/groups/:id/photo', () => {
    it('serves a cached avatar and refuses bad ids', async () => {
        const t = h.t;
        await t.exchange('photo alpha (cached jpg)', 'GET', `/api/groups/${G.alpha.id}/photo`, {
            bodyMode: 'sha256',
        });
        await t.exchange('photo alpha as guest', 'GET', `/api/groups/${G.alpha.id}/photo`, {
            as: 'guest',
            bodyMode: 'sha256',
        });
        await t.exchange(
            'photo beta (none, no Telegram) → 404',
            'GET',
            `/api/groups/${G.beta.id}/photo`,
        );
        await t.exchange(
            'photo gamma (chat not reachable) → 404',
            'GET',
            `/api/groups/${G.gamma.id}/photo`,
        );
        await t.exchange('photo non-numeric id → 400', 'GET', '/api/groups/abc/photo');
        await t.exchange(
            'photo synthetic unknown: id → 404',
            'GET',
            '/api/groups/unknown%3ASome_Folder/photo',
        );
        await t.exchange('photo anon → 401', 'GET', `/api/groups/${G.alpha.id}/photo`, {
            as: 'anon',
        });
    });
});

describe('PUT /api/groups/:id', () => {
    it('updates an existing group and broadcasts the whole config', async () => {
        const t = h.t;
        const admin = t.ws({ as: 'admin' });
        const guest = t.ws({ as: 'guest' });
        await admin.opened;
        await guest.opened;
        admin.drain();
        guest.drain();
        await t.exchange(
            'put alpha: filters, topics, rescue, accounts',
            'PUT',
            `/api/groups/${G.alpha.id}`,
            {
                body: {
                    filters: { files: true, stickers: true },
                    autoForward: { enabled: true, destination: '@somewhere' },
                    topics: { enabled: true, ids: ['5', 'x', 7] },
                    rescueMode: 'off',
                    rescueRetentionHours: 1000,
                    monitorAccount: 'acc-1',
                    forwardAccount: '',
                    ownerPeerId: SEED.peers.alpha.peerId,
                    backupPeerId: '',
                },
            },
        );
        await admin.waitFor((m) => m.type === 'config_updated');
        await guest.waitFor((m) => m.type === 'config_updated');
        t.recordWs('ws admin after put alpha', admin.drain(), { ignore: WS_IGNORE });
        t.recordWs('ws guest after put alpha', guest.drain(), {
            ignore: WS_IGNORE,
            note: 'config_updated carries the full config (password hashes, shareSecret) to every socket, guests included',
        });
        admin.close();
        guest.close();

        await t.exchange(
            'put alpha: clear topics, invalid rescue values',
            'PUT',
            `/api/groups/${G.alpha.id}`,
            {
                body: {
                    topics: null,
                    rescueMode: 'bogus',
                    rescueRetentionHours: 0,
                    monitorAccount: '',
                },
            },
        );
        await t.exchange('put beta: rename + disable', 'PUT', `/api/groups/${G.beta.id}`, {
            body: { name: 'Beta Renamed', enabled: false },
        });
    });

    it('creates groups that are not in the config yet', async () => {
        const t = h.t;
        await t.exchange('put new group with a name', 'PUT', '/api/groups/-1001000000077', {
            body: { name: 'Brand New Chat', enabled: false },
        });
        await t.exchange(
            'put new group without a name (no Telegram to resolve)',
            'PUT',
            '/api/groups/-1001000000078',
            {
                body: {},
            },
        );
        await t.exchange(
            'put new group enabled (auto-backfill needs an account)',
            'PUT',
            '/api/groups/-1001000000079',
            {
                body: { name: 'Group 79', enabled: true },
            },
        );
        await t.exchange('put new non-negative id kept as string', 'PUT', '/api/groups/12345', {
            body: { name: 'User Chat' },
        });
    });

    it('refuses to re-enable a suspended legacy entry', async () => {
        await h.t.exchange('put suspended enable → 403', 'PUT', `/api/groups/${LEGACY_ID}`, {
            body: { enabled: true },
        });
        await h.t.exchange('put suspended rename is fine', 'PUT', `/api/groups/${LEGACY_ID}`, {
            body: { name: 'Zeta Still Suspended' },
        });
    });

    it('guest and anonymous are refused', async () => {
        await h.t.exchange('put guest → 403', 'PUT', `/api/groups/${G.alpha.id}`, {
            as: 'guest',
            body: { enabled: false },
        });
        await h.t.exchange('put anon → 401', 'PUT', `/api/groups/${G.alpha.id}`, {
            as: 'anon',
            body: { enabled: false },
        });
    });

    it('the list reflects the edits', async () => {
        await h.t.exchange('groups admin after edits', 'GET', '/api/groups');
    });
});

describe('refresh-info / refresh-photos background sweeps', () => {
    it('refresh-info resolves nothing without an account', async () => {
        const t = h.t;
        await t.exchange('refresh-info status idle', 'GET', '/api/groups/refresh-info/status');
        const ws = t.ws({ as: 'admin' });
        await ws.opened;
        ws.drain();
        await t.exchange('refresh-info start', 'POST', '/api/groups/refresh-info', { body: {} });
        await ws.waitFor((m) => m.type === 'groups_refresh_info_done');
        ws.close();
        t.recordWs('ws refresh-info', ws.drain(), { ignore: WS_IGNORE });
        await t.exchange('refresh-info status done', 'GET', '/api/groups/refresh-info/status');
        await t.exchange('refresh-info guest → 403', 'POST', '/api/groups/refresh-info', {
            as: 'guest',
            body: {},
        });
        await t.exchange(
            'refresh-info status as guest (allow-listed prefix)',
            'GET',
            '/api/groups/refresh-info/status',
            {
                as: 'guest',
            },
        );
    });

    it('refresh-photos keeps cached avatars and finds no others', async () => {
        const t = h.t;
        await t.exchange('refresh-photos status idle', 'GET', '/api/groups/refresh-photos/status');
        const ws = t.ws({ as: 'admin' });
        await ws.opened;
        ws.drain();
        await t.exchange('refresh-photos start', 'POST', '/api/groups/refresh-photos', {
            body: {},
        });
        await ws.waitFor((m) => m.type === 'groups_refresh_photos_done');
        ws.close();
        t.recordWs('ws refresh-photos', ws.drain(), { ignore: WS_IGNORE });
        await t.exchange('refresh-photos status done', 'GET', '/api/groups/refresh-photos/status');
        await t.exchange('refresh-photos anon → 401', 'POST', '/api/groups/refresh-photos', {
            as: 'anon',
            body: {},
        });
    });
});
