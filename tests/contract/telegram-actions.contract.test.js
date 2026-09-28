// One-shot Telegram actions: stories (list user / list all / download),
// download-by-link, and the proxy reachability probe.
//
// No Telegram session exists; the main target has no API credentials
// (NO_API_CREDS paths), the `creds` target has credentials but no session
// ("No Telegram accounts loaded"). The network sandbox makes every
// outbound probe fail at once (DNS → ENOTFOUND, public IP → ECONNREFUSED).

import { describe, it } from 'vitest';
import { SEED, useContract } from './harness.js';

const G = SEED.groups;
const h = useContract(import.meta.url);

// The probe's `error` is the OS / runtime socket error text (Node's
// "getaddrinfo ENOTFOUND host", Go's "dial tcp: lookup host …") — the
// contract is `{ ok: false, error: <string> }`.
const PROBE_ERR = { error: 'socket/resolver error text is runtime-specific' };

describe('stories', () => {
    it("list a user's stories", async () => {
        const t = h.t;
        await t.exchange('stories/user without username → 400', 'POST', '/api/stories/user', {
            body: {},
        });
        await t.exchange(
            'stories/user for an unreachable chat id → 409',
            'POST',
            '/api/stories/user',
            {
                body: { username: G.gamma.id },
            },
        );
        await t.exchange('stories/user without API creds → 503', 'POST', '/api/stories/user', {
            body: { username: '@someone' },
        });
        await t.exchange('stories/user guest → 403', 'POST', '/api/stories/user', {
            as: 'guest',
            body: { username: '@someone' },
        });
    });

    it('list all stories', async () => {
        const t = h.t;
        await t.exchange('stories/all without API creds → 503', 'POST', '/api/stories/all', {
            body: {},
        });
        await t.exchange('stories/all anon → 401', 'POST', '/api/stories/all', {
            as: 'anon',
            body: {},
        });
    });

    it('download stories', async () => {
        const t = h.t;
        await t.exchange('stories/download without body → 400', 'POST', '/api/stories/download');
        await t.exchange('stories/download empty storyIds → 400', 'POST', '/api/stories/download', {
            body: { username: '@someone', storyIds: [] },
        });
        await t.exchange(
            'stories/download storyIds not an array → 400',
            'POST',
            '/api/stories/download',
            {
                body: { username: '@someone', storyIds: 5 },
            },
        );
        await t.exchange(
            'stories/download unreachable chat → 409',
            'POST',
            '/api/stories/download',
            {
                body: { username: G.gamma.id, storyIds: [1] },
            },
        );
        await t.exchange(
            'stories/download without API creds → 500',
            'POST',
            '/api/stories/download',
            {
                body: { username: '@someone', storyIds: [1, 2] },
            },
        );
    });
});

describe('download by link', () => {
    it('validation and the no-credentials path', async () => {
        const t = h.t;
        await t.exchange('download/url without body → 400', 'POST', '/api/download/url');
        await t.exchange('download/url blank url → 400', 'POST', '/api/download/url', {
            body: { url: ' \n \n ' },
        });
        await t.exchange('download/url empty urls array → 400', 'POST', '/api/download/url', {
            body: { urls: [] },
        });
        await t.exchange(
            'download/url single link without API creds → 500',
            'POST',
            '/api/download/url',
            {
                body: { url: 'https://t.me/somechannel/42' },
            },
        );
        await t.exchange(
            'download/url bulk list without API creds → 500',
            'POST',
            '/api/download/url',
            {
                body: { urls: ['https://t.me/c/1000000003/7', 'not a link'] },
            },
        );
        await t.exchange('download/url guest → 403', 'POST', '/api/download/url', {
            as: 'guest',
            body: { url: 'https://t.me/somechannel/42' },
        });
    });
});

describe('proxy reachability probe', () => {
    it('validation and SSRF guard', async () => {
        const t = h.t;
        await t.exchange('proxy/test without body → 400', 'POST', '/api/proxy/test');
        await t.exchange('proxy/test missing port → 400', 'POST', '/api/proxy/test', {
            body: { host: 'proxy.example.com' },
        });
        await t.exchange('proxy/test non-string host → 400', 'POST', '/api/proxy/test', {
            body: { host: 12345, port: 1080 },
        });
        await t.exchange('proxy/test over-long host → 400', 'POST', '/api/proxy/test', {
            body: { host: `${'a'.repeat(250)}.com`, port: 1080 },
        });
        for (const host of [
            'localhost',
            '127.0.0.1',
            '10.1.2.3',
            '192.168.1.10',
            '172.20.0.1',
            'nas.local',
            'box.internal',
            '::1',
        ]) {
            await t.exchange(`proxy/test private host ${host} → 400`, 'POST', '/api/proxy/test', {
                body: { host, port: 1080 },
            });
        }
        await t.exchange('proxy/test port 0 → 400', 'POST', '/api/proxy/test', {
            body: { host: 'proxy.example.com', port: 0 },
        });
        await t.exchange('proxy/test port 70000 → 400', 'POST', '/api/proxy/test', {
            body: { host: 'proxy.example.com', port: 70000 },
        });
        await t.exchange('proxy/test guest → 403', 'POST', '/api/proxy/test', {
            as: 'guest',
            body: { host: 'proxy.example.com', port: 1080 },
        });
    });

    it('unreachable targets answer ok:false (network sandbox)', async () => {
        const t = h.t;
        await t.exchange('proxy/test unresolvable host → ok:false', 'POST', '/api/proxy/test', {
            body: { host: 'proxy.invalid', port: 1080 },
            mask: PROBE_ERR,
        });
        await t.exchange('proxy/test public IP refused → ok:false', 'POST', '/api/proxy/test', {
            body: { host: '203.0.113.5', port: '1080' },
            mask: PROBE_ERR,
        });
    });
});

describe('with API credentials but no Telegram session', () => {
    it('every action answers "no accounts"', async () => {
        const c = await h.extra({
            configPatch: (cfg) => {
                cfg.telegram = { apiId: '123456', apiHash: '0123456789abcdef0123456789abcdef' };
            },
        });
        await c.exchange('[creds] stories/user → 409', 'POST', '/api/stories/user', {
            body: { username: '@someone' },
        });
        await c.exchange('[creds] stories/all → 409', 'POST', '/api/stories/all', { body: {} });
        await c.exchange('[creds] stories/download → 409', 'POST', '/api/stories/download', {
            body: { username: '@someone', storyIds: [1] },
        });
        await c.exchange('[creds] download/url → 409', 'POST', '/api/download/url', {
            body: { url: 'https://t.me/somechannel/42' },
        });
    });
});
