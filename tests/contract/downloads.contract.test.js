// Library / gallery contract: the per-group sidebar aggregate, the
// all-media feed, per-group pages, full-text search and the pin API.
//
// Pagination, type tabs, pinned filters, federation scope (?include=peers,
// ?peerId=) and the guest downgrade to local-only are all recorded. The
// only mutations are pins; they run last, in a fixed order.

import { describe, expect, it } from 'vitest';
import { SEED, useContract } from './harness.js';

const h = useContract(import.meta.url);
const G = SEED.groups;
const PEER = SEED.peers.alpha.peerId;
const REMOTE_GROUP = '-1009000000001';

describe('sidebar aggregate', () => {
    it('GET /api/downloads per role', async () => {
        const t = h.t;
        await t.exchange('downloads aggregate admin', 'GET', '/api/downloads');
        await t.exchange('downloads aggregate guest', 'GET', '/api/downloads', { as: 'guest' });
    });
});

describe('all-media feed', () => {
    it('defaults, pagination and clamping', async () => {
        const t = h.t;
        await t.exchange('all default', 'GET', '/api/downloads/all');
        await t.exchange('all page 2 limit 5', 'GET', '/api/downloads/all?page=2&limit=5');
        await t.exchange('all page beyond the end', 'GET', '/api/downloads/all?page=9&limit=5');
        await t.exchange(
            'all limit above cap (500)',
            'GET',
            '/api/downloads/all?limit=1000&page=1',
        );
        await t.exchange(
            'all limit=0 and page=0 fall back',
            'GET',
            '/api/downloads/all?limit=0&page=0',
        );
        await t.exchange(
            'all non-numeric page/limit',
            'GET',
            '/api/downloads/all?limit=abc&page=xyz',
        );
    });

    it('type tabs', async () => {
        const t = h.t;
        for (const type of ['images', 'videos', 'documents', 'audio', 'bogus']) {
            await t.exchange(`all type=${type}`, 'GET', `/api/downloads/all?type=${type}&limit=50`);
        }
    });

    it('pinned filter and pinned-first ordering', async () => {
        const t = h.t;
        await t.exchange('all pinned=1', 'GET', '/api/downloads/all?pinned=1');
        await t.exchange('all pinned=true', 'GET', '/api/downloads/all?pinned=true');
        await t.exchange(
            'all pinnedFirst=1 limit 4',
            'GET',
            '/api/downloads/all?pinnedFirst=1&limit=4',
        );
        await t.exchange(
            'all type=images pinnedFirst=true',
            'GET',
            '/api/downloads/all?type=images&pinnedFirst=true&limit=3',
        );
    });

    it('federation scope is admin-only', async () => {
        const t = h.t;
        await t.exchange(
            'all include=peers admin',
            'GET',
            '/api/downloads/all?include=peers&limit=50',
        );
        await t.exchange('all include=all admin', 'GET', '/api/downloads/all?include=all&limit=3');
        await t.exchange(
            'all include=peers peerId filter admin',
            'GET',
            `/api/downloads/all?include=peers&peerId=${PEER}`,
        );
        await t.exchange(
            'all include=peers unknown peerId admin',
            'GET',
            '/api/downloads/all?include=peers&peerId=no-such-peer',
        );
        await t.exchange(
            'all include=peers guest (forced local)',
            'GET',
            '/api/downloads/all?include=peers&limit=3',
            {
                as: 'guest',
            },
        );
        await t.exchange(
            'all peerId guest (ignored)',
            'GET',
            `/api/downloads/all?include=peers&peerId=${PEER}&limit=3`,
            { as: 'guest' },
        );
    });
});

describe('per-group pages', () => {
    it('each seeded group', async () => {
        const t = h.t;
        for (const [k, g] of Object.entries(G)) {
            await t.exchange(`group ${k}`, 'GET', `/api/downloads/${g.id}`);
        }
        await t.exchange('group unknown id', 'GET', '/api/downloads/-100999999');
        await t.exchange('group alpha guest', 'GET', `/api/downloads/${G.alpha.id}`, {
            as: 'guest',
        });
    });

    it('pagination, type and pinned params', async () => {
        const t = h.t;
        const a = G.alpha.id;
        await t.exchange('group alpha page 2 limit 2', 'GET', `/api/downloads/${a}?page=2&limit=2`);
        await t.exchange('group alpha type=images', 'GET', `/api/downloads/${a}?type=images`);
        await t.exchange('group alpha type=videos', 'GET', `/api/downloads/${a}?type=videos`);
        await t.exchange('group beta pinned=1', 'GET', `/api/downloads/${G.beta.id}?pinned=1`);
        await t.exchange(
            'group beta pinnedFirst=1',
            'GET',
            `/api/downloads/${G.beta.id}?pinnedFirst=1`,
        );
        await t.exchange('group alpha limit=-1 (unclamped)', 'GET', `/api/downloads/${a}?limit=-1`);
        await t.exchange('group alpha limit=0 page=0', 'GET', `/api/downloads/${a}?limit=0&page=0`);
    });

    it('a peer-owned group through federation', async () => {
        const t = h.t;
        await t.exchange(
            'remote group include=peers admin',
            'GET',
            `/api/downloads/${REMOTE_GROUP}?include=peers`,
        );
        await t.exchange('remote group local scope admin', 'GET', `/api/downloads/${REMOTE_GROUP}`);
        await t.exchange(
            'remote group include=peers guest',
            'GET',
            `/api/downloads/${REMOTE_GROUP}?include=peers`,
            {
                as: 'guest',
            },
        );
    });
});

describe('search', () => {
    it('queries', async () => {
        const t = h.t;
        const q = (label, qs, o) => t.exchange(label, 'GET', `/api/downloads/search${qs}`, o);
        await q('search without q', '');
        await q('search blank q', '?q=%20%20');
        await q('search IMG', '?q=IMG');
        await q('search by group name', '?q=Gamma');
        await q('search report', '?q=report');
        await q('search unicode', `?q=${encodeURIComponent('ภาพทดสอบ')}`);
        await q('search quote char', `?q=${encodeURIComponent('"')}`);
        await q('search star', '?q=*');
        await q('search FTS operators', `?q=${encodeURIComponent('IMG OR notes')}`);
        await q('search no match', '?q=zzznomatch');
        await q('search IMG page 2 limit 3', '?q=IMG&page=2&limit=3');
        await q('search limit above cap (200)', '?q=IMG&limit=500');
        await q('search IMG in group alpha', `?q=IMG&groupId=${G.alpha.id}`);
        await q('search IMG type=images', '?q=IMG&type=images');
        await q('search VID type=videos', '?q=VID&type=videos');
        await q('search IMG pinned=1', '?q=IMG&pinned=1');
        await q('search IMG pinnedFirst order=newest', '?q=IMG&pinnedFirst=1&order=newest');
        await q('search IMG order=newest', '?q=IMG&order=newest');
        await q('search Remote include=peers admin', '?q=Remote&include=peers');
        await q('search R_0501 include=peers admin', '?q=R_0501&include=peers');
        await q('search Remote include=peers guest', '?q=Remote&include=peers', { as: 'guest' });
        await q('search IMG guest', '?q=IMG&limit=2', { as: 'guest' });
    });
});

describe('pins', () => {
    it('single pin validation', async () => {
        const t = h.t;
        const p = (label, id, body, o = {}) =>
            t.exchange(label, 'POST', `/api/downloads/${id}/pin`, { body, ...o });
        await p('pin invalid id', 'abc', { pinned: true });
        await p('pin id 0', 0, { pinned: true });
        await p('pin missing pinned', 2, {});
        await p('pin non-boolean pinned', 2, { pinned: 'yes' });
        await p('pin unknown id', 9999, { pinned: true });
        await p('pin guest → 403', 2, { pinned: true }, { as: 'guest' });
    });

    it('batch pin validation', async () => {
        const t = h.t;
        const p = (label, body, o = {}) =>
            t.exchange(label, 'POST', '/api/downloads/pin', { body, ...o });
        await p('batch pin missing pinned', { ids: [1] });
        await p('batch pin empty ids', { ids: [], pinned: true });
        await p('batch pin ids not an array', { ids: 3, pinned: true });
        await p('batch pin too many ids', {
            ids: Array.from({ length: 5001 }, (_, i) => i + 1),
            pinned: true,
        });
        await p('batch pin guest → 403', { ids: [2], pinned: true }, { as: 'guest' });
    });

    it('pin / unpin broadcasts and changes the pinned feed', async () => {
        const t = h.t;
        const ws = t.ws({ as: 'admin' });
        await ws.opened;
        ws.drain();
        await t.exchange('pin row 2', 'POST', '/api/downloads/2/pin', { body: { pinned: true } });
        await t.exchange('pinned feed after pin', 'GET', '/api/downloads/all?pinned=1');
        await t.exchange('unpin row 2', 'POST', '/api/downloads/2/pin', {
            body: { pinned: false },
        });
        await t.exchange('batch pin mixed ids', 'POST', '/api/downloads/pin', {
            body: { ids: [3, 4, '5', 9999, -1, 'x', 3], pinned: true },
        });
        await t.exchange('batch pin only unknown ids', 'POST', '/api/downloads/pin', {
            body: { ids: [9999, 8888], pinned: true },
        });
        await t.exchange('pinned feed after batch pin', 'GET', '/api/downloads/all?pinned=1');
        await t.exchange('batch unpin', 'POST', '/api/downloads/pin', {
            body: { ids: [3, 4, 5], pinned: false },
        });
        await ws.waitFor(
            () => ws.messages.filter((m) => m.type === 'downloads_pinned').length >= 2,
        );
        ws.close();
        const seq = ws.drain();
        expect(seq.some((m) => m.type === 'download_pinned')).toBe(true);
        t.recordWs('ws events from pin changes', seq, {
            ignore: ['monitor_status_push', 'stats_push', 'log', 'stats_update'],
            note: 'stats_update (debounced 400 ms, sent outside broadcast()) is not part of this sequence',
        });
    });
});
