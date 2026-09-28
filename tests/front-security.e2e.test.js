// Security behaviour through the tgdl-core front server.
//
// Every scenario runs against two instances seeded identically: `front`
// (tgdl-core on PORT, Node behind it — the default) and `node` (no
// tgdl-core, so Node answers PORT itself — how the app behaved before).
// Each check asserts the expected outcome AND that both instances answer
// the same.
//
//   - /api/auth/setup (first-run, localhost-only): allowed for a local
//     client, refused for a remote one — a real non-loopback connection,
//     a client behind a trusted local proxy (X-Forwarded-For), and a
//     remote client forging the front server's private headers.
//   - TRUST_PROXY: default (loopback), empty (trust nothing), hop count.
//   - forceHttps: remote plain HTTP is redirected / refused, a secure
//     request gets HSTS + upgrade-insecure-requests, local requests pass.
//   - The /api rate limit counts requests tgdl-core could have answered
//     itself (thumbnail hits), per client IP.
//   - /files bearer tokens: expired, forged, legacy.
//   - Node's loopback port ignores a forged X-Tgdl-Front token.

import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findOrBuildGoCore, GOCORE_TEST } from './helpers/gocore-bin.js';
import { PARITY_SHARE_SECRET } from './helpers/front-parity.js';
import {
    lanAddress,
    parityFileTokens,
    rawRequest,
    startPair,
    upstreamPort,
} from './helpers/front-server.js';

const SKIP = process.env.TGDL_SKIP_E2E === '1';
const LAN = lanAddress();
const ADMIN = { Cookie: `tg_dl_session=${'a'.repeat(64)}` };
const CLIP = '/files/G1/videos/clip.mp4?inline=1';

let bin = null;
const pairs = [];

async function pair(opts) {
    const p = await startPair({ ...opts, bin });
    pairs.push(p);
    return p;
}

const HOST = 'tgdl.test:8080';

/** Send the same request (same Host) to both instances; resolves [front, node]. */
async function both(p, req) {
    const r = { ...req, headers: { Host: HOST, ...req.headers } };
    return Promise.all([rawRequest(p.front.port, r), rawRequest(p.node.port, r)]);
}

/** The parts of a response a client can observe, minus Date. */
function visible(r) {
    const h = { ...r.headers };
    delete h.date;
    if (h['set-cookie']) {
        // A new session's token is random (the rest of the cookie is not).
        h['set-cookie'] = h['set-cookie'].map((c) =>
            c
                .replace(/Expires=[^;]+/i, 'Expires=<date>')
                .replace(/^tg_dl_session=[0-9a-f]{64}/, 'tg_dl_session=<new>'),
        );
    }
    if (h.ratelimit) h.ratelimit = h.ratelimit.replace(/reset=\d+/, 'reset=<n>');
    return { status: r.status, headers: h, body: r.body };
}

/**
 * The front server's own-answer counters (null for the Node-only instance
 * or when the front isn't running).
 */
async function fastCounts(p) {
    const r = await rawRequest(p.front.port, { path: '/api/system/health', headers: ADMIN });
    return JSON.parse(r.body)?.goCoreFront?.stats?.fast ?? null;
}

async function same(p, req) {
    const [f, n] = await both(p, req);
    expect(visible(f), `${req.method || 'GET'} ${req.path}`).toEqual(visible(n));
    return f;
}

beforeAll(async () => {
    if (SKIP) return;
    bin = await findOrBuildGoCore();
}, 300_000);

afterAll(async () => {
    for (const p of pairs) await p.close();
});

describe.skipIf(SKIP)('front server: security behaviour is unchanged', () => {
    describe('first-run /api/auth/setup is localhost-only', () => {
        let p;
        beforeAll(async () => {
            p = await pair({ webPatch: { passwordHash: null, guestPasswordHash: null } });
        }, 60_000);

        const setup = (extra = {}) => ({
            method: 'POST',
            path: '/api/auth/setup',
            body: { password: 'a-long-password' },
            ...extra,
        });

        it('refuses a client behind a trusted local proxy (X-Forwarded-For)', async () => {
            const r = await same(p, setup({ headers: { 'X-Forwarded-For': '203.0.113.9' } }));
            expect(r.status).toBe(403);
        });

        it.skipIf(!LAN)('refuses a real non-loopback client', async () => {
            const r = await same(p, setup({ host: LAN, localAddress: LAN }));
            expect(r.status).toBe(403);
        });

        it.skipIf(!LAN)('refuses a remote client forging the private headers', async () => {
            const r = await same(
                p,
                setup({
                    host: LAN,
                    localAddress: LAN,
                    headers: {
                        'X-Tgdl-Front': crypto.randomBytes(32).toString('hex'),
                        'X-Tgdl-Client-Addr': '127.0.0.1',
                        'X-Forwarded-For': '127.0.0.1',
                    },
                }),
            );
            expect(r.status).toBe(403);
        });

        it('Node behind tgdl-core ignores a forged front token', async () => {
            const up = upstreamPort(p.front);
            if (bin || GOCORE_TEST) expect(up).toBeTruthy();
            if (!up) return;
            // A wrong token: the address header is ignored, the request is
            // judged by its real (loopback) peer and its X-Forwarded-For.
            const r = await rawRequest(
                up,
                setup({
                    headers: {
                        'X-Tgdl-Front': 'wrong',
                        'X-Tgdl-Client-Addr': '127.0.0.1',
                        'X-Forwarded-For': '203.0.113.9',
                    },
                }),
            );
            expect(r.status).toBe(403);
        });

        it('allows a local client (and only once)', async () => {
            const [f, n] = await both(p, setup());
            expect(f.status).toBe(200);
            expect(n.status).toBe(200);
            const [f2, n2] = await both(p, setup());
            expect(f2.status).toBe(409);
            expect(n2.status).toBe(409);
        });
    });

    describe('TRUST_PROXY variants', () => {
        it('empty TRUST_PROXY: X-Forwarded-For from a local client is ignored', async () => {
            const p = await pair({
                webPatch: { passwordHash: null, guestPasswordHash: null },
                env: { TRUST_PROXY: '' },
            });
            if (LAN) {
                const r = await same(p, {
                    method: 'POST',
                    path: '/api/auth/setup',
                    host: LAN,
                    localAddress: LAN,
                    headers: { 'X-Forwarded-For': '127.0.0.1' },
                    body: { password: 'a-long-password' },
                });
                expect(r.status).toBe(403);
            }
            const r = await same(p, {
                method: 'POST',
                path: '/api/auth/setup',
                headers: { 'X-Forwarded-For': '203.0.113.9' },
                body: { password: 'a-long-password' },
            });
            expect(r.status).toBe(200);
        }, 60_000);

        it.skipIf(!LAN)(
            'TRUST_PROXY=1: one hop is trusted, as Express does',
            async () => {
                const p = await pair({
                    webPatch: { passwordHash: null, guestPasswordHash: null },
                    env: { TRUST_PROXY: '1' },
                });
                const r = await same(p, {
                    method: 'POST',
                    path: '/api/auth/setup',
                    host: LAN,
                    localAddress: LAN,
                    headers: { 'X-Forwarded-For': '198.51.100.4' },
                    body: { password: 'a-long-password' },
                });
                expect(r.status).toBe(403);
            },
            60_000,
        );
    });

    describe('forceHttps', () => {
        let p;
        beforeAll(async () => {
            p = await pair({ webPatch: { forceHttps: true } });
        }, 60_000);

        it.skipIf(!LAN)('redirects a remote plain-HTTP GET, refuses a POST', async () => {
            const g = await same(p, { path: CLIP, host: LAN, localAddress: LAN, headers: ADMIN });
            expect(g.status).toBe(308);
            expect(g.headers.location).toMatch(/^https:\/\//);
            const post = await same(p, {
                method: 'POST',
                path: '/api/logout',
                host: LAN,
                localAddress: LAN,
                headers: ADMIN,
            });
            expect(post.status).toBe(403);
        });

        it.skipIf(!LAN)('an untrusted X-Forwarded-Proto does not count as HTTPS', async () => {
            const r = await same(p, {
                path: CLIP,
                host: LAN,
                localAddress: LAN,
                headers: { ...ADMIN, 'X-Forwarded-Proto': 'https' },
            });
            expect(r.status).toBe(308);
        });

        it('a secure request (trusted proxy) gets HSTS and upgrade-insecure-requests', async () => {
            const before = await fastCounts(p);
            for (const extra of [{}, { Range: 'bytes=0-99' }]) {
                const r = await same(p, {
                    path: CLIP,
                    headers: { ...ADMIN, 'X-Forwarded-Proto': 'https', ...extra },
                });
                expect([200, 206]).toContain(r.status);
                expect(r.headers['strict-transport-security']).toBe(
                    'max-age=31536000; includeSubDomains',
                );
                expect(r.headers['content-security-policy']).toMatch(/;upgrade-insecure-requests$/);
            }
            const t = await same(p, {
                path: '/api/thumbs/1',
                headers: { ...ADMIN, 'X-Forwarded-Proto': 'https' },
            });
            expect(t.status).toBe(200);
            // …and tgdl-core answered them itself.
            const after = await fastCounts(p);
            if (GOCORE_TEST) {
                expect(after.files - before.files).toBe(2);
                expect(after.thumbs - before.thumbs).toBe(1);
            }
        });

        it('a local plain-HTTP request passes without HSTS', async () => {
            const r = await same(p, { path: CLIP, headers: ADMIN });
            expect(r.status).toBe(200);
            expect(r.headers['strict-transport-security']).toBeUndefined();
        });
    });

    describe('/api rate limit', () => {
        it('counts thumbnail hits per client, like any /api request', async () => {
            const p = await pair({});
            // Switched on from the dashboard (Settings → Dashboard security).
            const on = await both(p, {
                method: 'POST',
                path: '/api/config',
                headers: ADMIN,
                body: { web: { rateLimit: { enabled: true, perMinute: 10 } } },
            });
            expect(on.map((r) => r.status)).toEqual([200, 200]);
            await new Promise((r) => setTimeout(r, 300));
            const thumb = (ip) => ({
                path: '/api/thumbs/1',
                headers: { ...ADMIN, 'X-Forwarded-For': ip },
            });
            for (let i = 0; i < 10; i++) {
                const r = await same(p, thumb('198.51.100.1'));
                expect(r.status).toBe(200);
                expect(r.headers.ratelimit).toMatch(/limit=10/);
            }
            expect((await same(p, thumb('198.51.100.1'))).status).toBe(429);
            expect((await same(p, thumb('198.51.100.2'))).status).toBe(200);
            // None of them was answered without Node counting it.
            if (GOCORE_TEST) expect((await fastCounts(p)).thumbs).toBe(0);
        }, 60_000);
    });

    describe('/files bearer tokens', () => {
        let p;
        let secret;
        beforeAll(async () => {
            p = await pair({});
            secret = Buffer.from(PARITY_SHARE_SECRET, 'hex');
        }, 60_000);

        const sig = (key, payload) =>
            crypto.createHmac('sha256', key).update(payload).digest('base64url');
        const withToken = (t) => `${CLIP}&token=${encodeURIComponent(t)}`;

        it('valid admin / guest tokens are accepted', async () => {
            const { fileTokenAdmin, fileTokenGuest } = await parityFileTokens();
            expect((await same(p, { path: withToken(fileTokenAdmin) })).status).toBe(200);
            expect((await same(p, { path: withToken(fileTokenGuest) })).status).toBe(200);
        });

        it('expired, forged and wrong-secret tokens are refused', async () => {
            const past = Math.floor(Date.now() / 1000) - 5;
            const future = Math.floor(Date.now() / 1000) + 600;
            const other = crypto.randomBytes(32);
            for (const t of [
                `${past}.${sig(secret, `filetoken:admin|${past}`)}`,
                `${future}.${sig(other, `filetoken:admin|${future}`)}`,
                `${future}.${sig(secret, `filetoken:root|${future}`)}`,
                `${future}.`,
                `0${future}.${sig(secret, `filetoken:admin|0${future}`)}`,
            ]) {
                const r = await same(p, { path: withToken(t) });
                expect(r.status).toBe(302);
            }
        });

        it('legacy (pre-role) tokens and non-canonical spellings behave as before', async () => {
            const future = Math.floor(Date.now() / 1000) + 600;
            const legacy = `${future}.${sig(secret, `filetoken|${future}`)}`;
            expect((await same(p, { path: withToken(legacy) })).status).toBe(200);
            // Number('0<exp>') === exp: Node accepts it (signed over "<exp>").
            const padded = `0${future}.${sig(secret, `filetoken:guest|${future}`)}`;
            expect((await same(p, { path: withToken(padded) })).status).toBe(200);
        });
    });
});
