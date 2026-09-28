// Chats contract: the Telegram dialogs picker, chat lookup (@username /
// t.me links / invites / ids), and the chat-access registry ("chats we
// can't reach": list, re-check, stop, remove, follow a group migration).
//
// Recorded with NO Telegram account configured — the dialogs / lookup /
// re-check paths answer from that state (503 no_account, inconclusive
// re-checks). A second server with a session file but no API credentials
// records the `not_connected` branch.

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { AMBIENT_WS_TYPES, SEED, useContract } from './harness.js';

const G = SEED.groups;
// `stats_update` is a 400 ms-debounced push (sent straight to the sockets,
// not through broadcast()) after any stats-changing event; where it lands
// relative to the events recorded here depends on timing.
const WS_IGNORE = [...AMBIENT_WS_TYPES, 'stats_update'];
const LEGACY_ID = '-1001000000006';
const MIGRATED_TO = '-1001000000098';

const h = useContract(import.meta.url, {
    configPatch(cfg) {
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
        // Delta Mixed was upgraded to a supergroup.
        db.prepare(`
            INSERT INTO chat_access (chat_id, state, code, detail, migrated_to, first_seen_at, checked_at,
                next_check_at, checks, accounts, updated_at)
            VALUES (?, 'migrated', 'CHAT_MIGRATED', NULL, ?, ?, ?, ?, 0, ?, ?)
        `).run(
            G.delta.id,
            MIGRATED_TO,
            Date.UTC(2024, 5, 8),
            Date.UTC(2024, 5, 8),
            Date.UTC(2100, 0, 1),
            JSON.stringify({
                'acc-1': { state: 'migrated', code: 'CHAT_MIGRATED', at: Date.UTC(2024, 5, 8) },
            }),
            Date.UTC(2024, 5, 8),
        );
    },
});

describe('GET /api/chats/access', () => {
    it('lists configured chats that cannot be reached', async () => {
        const t = h.t;
        await t.exchange('access list', 'GET', '/api/chats/access');
        await t.exchange('access countOnly', 'GET', '/api/chats/access?countOnly=1');
        await t.exchange('access guest → 403', 'GET', '/api/chats/access', { as: 'guest' });
        await t.exchange('access anon → 401', 'GET', '/api/chats/access', { as: 'anon' });
    });
});

describe('GET /api/dialogs (no Telegram account)', () => {
    it('answers no_account', async () => {
        const t = h.t;
        await t.exchange('dialogs no account → 503', 'GET', '/api/dialogs');
        await t.exchange('dialogs fresh=1 no account → 503', 'GET', '/api/dialogs?fresh=1');
        await t.exchange('dialogs guest → 403', 'GET', '/api/dialogs', { as: 'guest' });
    });
});

describe('GET /api/chats/lookup', () => {
    it('parses the query before needing an account', async () => {
        const t = h.t;
        const q = (s) => `/api/chats/lookup?q=${encodeURIComponent(s)}`;
        await t.exchange('lookup without q → 400', 'GET', '/api/chats/lookup');
        await t.exchange('lookup blank q → 400', 'GET', q('   '));
        await t.exchange('lookup plain name → kind name', 'GET', q('Some Chat Name'));
        await t.exchange('lookup t.me phone link → 422', 'GET', q('https://t.me/+123456789'));
        await t.exchange('lookup private link without id → 422', 'GET', q('https://t.me/c/abc/5'));
        await t.exchange('lookup non-chat path → 422', 'GET', q('https://t.me/addstickers/Foo'));
        await t.exchange('lookup @username → 503 no_account', 'GET', q('@some_channel'));
        await t.exchange(
            'lookup message link → 503 with message',
            'GET',
            q('https://t.me/some_channel/42'),
        );
        await t.exchange(
            'lookup topic message link → 503 with topic',
            'GET',
            q('https://t.me/c/1234567890/10/77'),
        );
        await t.exchange('lookup invite link → 503', 'GET', q('https://t.me/+AbCdEfGhIjK'));
        await t.exchange('lookup joinchat link → 503', 'GET', q('t.me/joinchat/AbCdEf'));
        await t.exchange('lookup -100 id → 503', 'GET', q('-1001234567890'));
        await t.exchange('lookup guest → 403', 'GET', q('@some_channel'), { as: 'guest' });
    });
});

describe('POST /api/chats/access/recheck', () => {
    it('single chat: answered inline, inconclusive without accounts', async () => {
        const t = h.t;
        await t.exchange('recheck one blocked chat', 'POST', '/api/chats/access/recheck', {
            body: { id: G.gamma.id },
        });
        await t.exchange('recheck one unknown chat', 'POST', '/api/chats/access/recheck', {
            body: { id: '-1009999999999' },
        });
        await t.exchange('recheck nothing to do', 'POST', '/api/chats/access/recheck', {
            body: {},
        });
        await t.exchange('recheck empty ids', 'POST', '/api/chats/access/recheck', {
            body: { ids: [] },
        });
        await t.exchange('recheck guest → 403', 'POST', '/api/chats/access/recheck', {
            as: 'guest',
            body: { id: G.gamma.id },
        });
    });

    it('bulk: background job, one chat every 2 s, single-flight', async () => {
        const t = h.t;
        await t.exchange('recheck status idle', 'GET', '/api/chats/access/recheck/status');
        const ws = t.ws({ as: 'admin' });
        await ws.opened;
        ws.drain();
        await t.exchange('recheck bulk ids start', 'POST', '/api/chats/access/recheck', {
            body: { ids: [G.gamma.id, G.delta.id, G.gamma.id] },
        });
        // The first chat is checked at once, the second after a 2 s gap —
        // a second start inside that window is refused.
        await t.exchange('recheck bulk while running → 409', 'POST', '/api/chats/access/recheck', {
            body: { all: true },
        });
        await ws.waitFor((m) => m.type === 'chat_access_recheck_done');
        t.recordWs('ws bulk recheck', ws.drain(), { ignore: WS_IGNORE });
        await t.exchange('recheck status done', 'GET', '/api/chats/access/recheck/status');

        await t.exchange(
            'recheck all (every blocked configured chat)',
            'POST',
            '/api/chats/access/recheck',
            {
                body: { all: true },
            },
        );
        await ws.waitFor((m) => m.type === 'chat_access_recheck_done');
        ws.close();
        t.recordWs('ws recheck all', ws.drain(), { ignore: WS_IGNORE });
        await t.exchange('recheck status after all', 'GET', '/api/chats/access/recheck/status');
    }, 30_000);
});

describe('POST /api/chats/access/stop and /remove', () => {
    it('stop switches monitoring off (config only)', async () => {
        const t = h.t;
        const ws = t.ws({ as: 'admin' });
        await ws.opened;
        ws.drain();
        await t.exchange('stop without ids → 400', 'POST', '/api/chats/access/stop', { body: {} });
        await t.exchange('stop delta', 'POST', '/api/chats/access/stop', {
            body: { ids: [G.delta.id, '-1009999999999'] },
        });
        await t.exchange('stop already disabled gamma', 'POST', '/api/chats/access/stop', {
            body: { ids: [G.gamma.id] },
        });
        await ws.waitFor((m) => m.type === 'config_updated');
        ws.close();
        t.recordWs('ws stop', ws.drain(), { ignore: WS_IGNORE });
    });

    it('remove drops the config entry and forgets the access record', async () => {
        const t = h.t;
        const ws = t.ws({ as: 'admin' });
        await ws.opened;
        ws.drain();
        await t.exchange('remove without ids → 400', 'POST', '/api/chats/access/remove', {
            body: { ids: 'nope' },
        });
        await t.exchange('remove gamma', 'POST', '/api/chats/access/remove', {
            body: { ids: [G.gamma.id] },
        });
        await ws.waitFor((m) => m.type === 'chat_access_changed');
        ws.close();
        t.recordWs('ws remove', ws.drain(), { ignore: WS_IGNORE });
        await t.exchange('remove unknown id', 'POST', '/api/chats/access/remove', {
            body: { ids: ['-1009999999999'] },
        });
        await t.exchange('access list after stop + remove', 'GET', '/api/chats/access');
    });
});

describe('POST /api/chats/:id/follow-migration', () => {
    it('adds the new supergroup with the old settings and switches the old one off', async () => {
        const t = h.t;
        await t.exchange(
            'follow-migration unknown chat → 404',
            'POST',
            '/api/chats/-1009999999999/follow-migration',
            {
                body: {},
            },
        );
        await t.exchange(
            'follow-migration not migrated → 409',
            'POST',
            `/api/chats/${LEGACY_ID}/follow-migration`,
            {
                body: {},
            },
        );
        const ws = t.ws({ as: 'admin' });
        await ws.opened;
        ws.drain();
        await t.exchange(
            'follow-migration delta',
            'POST',
            `/api/chats/${G.delta.id}/follow-migration`,
            {
                body: {},
            },
        );
        await ws.waitFor((m) => m.type === 'config_updated');
        ws.close();
        t.recordWs('ws follow-migration', ws.drain(), { ignore: WS_IGNORE });
        await t.exchange(
            'follow-migration delta again (target exists)',
            'POST',
            `/api/chats/${G.delta.id}/follow-migration`,
            {
                body: {},
            },
        );
        await t.exchange(
            'follow-migration guest → 403',
            'POST',
            `/api/chats/${G.delta.id}/follow-migration`,
            {
                as: 'guest',
                body: {},
            },
        );
        await t.exchange('groups after migration', 'GET', '/api/groups');
    });
});

describe('dialogs / lookup with a session file but no API credentials', () => {
    it('answers not_connected', async () => {
        const t2 = await h.extra({
            beforeStart(dataDir) {
                const dir = path.join(dataDir, 'sessions');
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(path.join(dir, 'acc-1.enc'), 'not a real session');
            },
        });
        const r = await t2.exchange(
            'dialogs session file, no creds → 503 not_connected',
            'GET',
            '/api/dialogs',
        );
        expect(r.status).toBe(503);
        await t2.exchange(
            'lookup session file, no creds → 503',
            'GET',
            '/api/chats/lookup?q=%40some_channel',
        );
        await t2.exchange(
            'recheck one with session file, no creds',
            'POST',
            '/api/chats/access/recheck',
            {
                body: { id: G.gamma.id },
            },
        );
    });
});
