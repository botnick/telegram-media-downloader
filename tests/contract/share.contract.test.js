// Share links contract: the admin API (/api/share/links) and the public
// HMAC-gated /share/<id>[/<name>] route (v2 `?s=` and legacy v1
// `?exp=&sig=` URLs, revoked / expired / bad-signature answers, Range,
// ?download=1, access counters, the per-IP limiter).
//
// Time-derived values of NEW links (createdAt, expiresAt, the `s=` sig)
// are masked by the normaliser; the relations that make them correct are
// recorded as explicit derived facts instead:
//   expiresAt − createdAt/1000 == clamped TTL (±1 s: two clock reads)
//   s == base64url(HMAC-SHA256(shareSecret, "<id>|<expiresAt>"))
// The seeded links (fixed expiry) are served with signatures the test
// computes itself — the Go server must accept URLs Node issued.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { SEED, useContract } from './harness.js';

const h = useContract(import.meta.url);

const FAR_S = 4102444800; // seeded expiry of link 1 / 3 (2100-01-01)
const EXPIRED_S = 1717286400; // seeded expiry of link 2
const sign = (id, exp) =>
    crypto
        .createHmac('sha256', Buffer.from(SEED.shareSecret, 'hex'))
        .update(`${id}|${exp}`)
        .digest('base64url');
const sigOf = (url) => new URL(url).searchParams.get('s');

function linkFacts(link, ttl) {
    return {
        id: link.id,
        sigMatchesHmac: sigOf(link.url) === sign(link.id, link.expiresAt),
        ttlApplied:
            ttl === 0
                ? link.expiresAt === 0
                : Math.abs(link.expiresAt - Math.floor(link.createdAt / 1000) - ttl) <= 1,
        createdAtIsEpochMs: link.createdAt > 1e12,
    };
}

describe('admin API: list', () => {
    it('lists the seeded links with filters and paging', async () => {
        const t = h.t;
        const all = await t.exchange('list all', 'GET', '/api/share/links');
        t.store.record('derived: seeded link signatures', {
            derived: Object.fromEntries(
                all.json.links.map((l) => [l.id, sigOf(l.url) === sign(l.id, l.expiresAt)]),
            ),
        });
        await t.exchange('list by downloadId', 'GET', '/api/share/links?downloadId=1');
        await t.exchange('list without revoked', 'GET', '/api/share/links?includeRevoked=0');
        await t.exchange('list limit 1', 'GET', '/api/share/links?limit=1');
        await t.exchange('list limit 1 offset 1', 'GET', '/api/share/links?limit=1&offset=1');
        await t.exchange('list search label', 'GET', '/api/share/links?q=grandma');
        await t.exchange('list search group name', 'GET', '/api/share/links?q=Gamma');
        await t.exchange('list search no match', 'GET', '/api/share/links?q=zzz');
        await t.exchange('list junk paging params', 'GET', '/api/share/links?limit=abc&offset=-5');
        await t.exchange('list limit above cap', 'GET', '/api/share/links?limit=5000');
        await t.exchange('list guest → 403', 'GET', '/api/share/links', { as: 'guest' });
        await t.exchange('list anon → 401', 'GET', '/api/share/links', { as: 'anon' });
    });
});

describe('admin API: create', () => {
    it('validation', async () => {
        const t = h.t;
        const c = (label, body, o = {}) =>
            t.exchange(label, 'POST', '/api/share/links', { body, ...o });
        await c('create without downloadId → 400', {});
        await c('create downloadId 0 → 400', { downloadId: 0 });
        await c('create downloadId abc → 400', { downloadId: 'abc' });
        await c('create unknown download → 404', { downloadId: 9999 });
        await c('create guest → 403', { downloadId: 1 }, { as: 'guest' });
    });

    it('TTL clamping, never-expire and label hygiene', async () => {
        const t = h.t;
        const facts = {};
        const c = async (label, body, ttl) => {
            const r = await t.exchange(label, 'POST', '/api/share/links', { body });
            expect(r.status).toBe(200);
            facts[label] = linkFacts(r.json.link, ttl);
            return r.json.link;
        };
        await c(
            'create 1 h with messy label',
            { downloadId: 9, ttlSeconds: 3600, label: 'week\tlink\nnew  ' },
            3600,
        );
        await c('create never expires (ttl 0)', { downloadId: 11, ttlSeconds: 0 }, 0);
        await c('create ttl "0" string', { downloadId: 11, ttlSeconds: '0' }, 0);
        await c('create ttl below floor → 60 s', { downloadId: 12, ttlSeconds: 10 }, 60);
        await c(
            'create ttl above ceiling → 90 d',
            { downloadId: 12, ttlSeconds: 999999999 },
            7776000,
        );
        await c('create default ttl → 7 d', { downloadId: '13', label: 'x'.repeat(100) }, 604800);
        await c(
            'create negative ttl → default',
            { downloadId: 13, ttlSeconds: -5, label: 42 },
            604800,
        );
        await c(
            'create blank label → null',
            { downloadId: 14, ttlSeconds: 120, label: '   ' },
            120,
        );
        t.store.record('derived: new link expiry and signature', { derived: facts });
        await t.exchange('list after creating', 'GET', '/api/share/links?limit=20');
    });
});

describe('public /share route', () => {
    it('serves a valid link', async () => {
        const t = h.t;
        const s1 = sign(1, FAR_S);
        await t.exchange('share v2 inline', 'GET', `/share/1?s=${s1}`, { as: 'anon' });
        await t.exchange('share v2 with filename slug', 'GET', `/share/1/IMG_0001.jpg?s=${s1}`, {
            as: 'anon',
        });
        await t.exchange('share ?download=1', 'GET', `/share/1?s=${s1}&download=1`, { as: 'anon' });
        await t.exchange('share ?download=true', 'GET', `/share/1?s=${s1}&download=true`, {
            as: 'anon',
        });
        await t.exchange('share range', 'GET', `/share/1?s=${s1}`, {
            as: 'anon',
            headers: { range: 'bytes=0-9' },
        });
        await t.exchange('share unsatisfiable range', 'GET', `/share/1?s=${s1}`, {
            as: 'anon',
            headers: { range: 'bytes=9000-9999' },
            bodyMode: 'text',
        });
        await t.exchange('share HEAD', 'HEAD', `/share/1?s=${s1}`, { as: 'anon' });
        await t.exchange('share legacy v1 exp+sig', 'GET', `/share/1?exp=${FAR_S}&sig=${s1}`, {
            as: 'anon',
        });
        await t.exchange('share with a dashboard cookie too', 'GET', `/share/1?s=${s1}`);
    });

    it('refuses bad, expired, revoked and unknown links', async () => {
        const t = h.t;
        const s1 = sign(1, FAR_S);
        const g = (label, url) => t.exchange(label, 'GET', url, { as: 'anon' });
        await g('share without signature → 400', '/share/1');
        await g('share non-numeric id → 400', `/share/abc?s=${s1}`);
        await g('share id 0 → 400', `/share/0?s=${s1}`);
        await g('share wrong signature → 401', `/share/1?s=${'A'.repeat(43)}`);
        await g('share short signature → 401', '/share/1?s=abc');
        await g('share signature of another link → 401', `/share/1?s=${sign(3, FAR_S)}`);
        await g('share expired → 401', `/share/2?s=${sign(2, EXPIRED_S)}`);
        await g('share revoked → 401', `/share/3?s=${sign(3, FAR_S)}`);
        await g('share unknown id → 401', `/share/999?s=${s1}`);
        await g(
            'share v1 with mismatching exp → 401',
            `/share/1?exp=${FAR_S + 1}&sig=${sign(1, FAR_S + 1)}`,
        );
        await g('share v1 without exp → 401', `/share/1?sig=${s1}`);
    });

    it('new links: never-expiring, unicode names, file gone from disk', async () => {
        const t = h.t;
        const make = async (downloadId, body = {}) =>
            (await t.request('POST', '/api/share/links', { body: { downloadId, ...body } })).json
                .link;
        const never = await make(10, { ttlSeconds: 0 });
        await t.exchange(
            'share never-expiring link',
            'GET',
            `/share/${never.id}?s=${sign(never.id, 0)}`,
            {
                as: 'anon',
            },
        );
        const uni = await make(16);
        await t.exchange(
            'share unicode file name',
            'GET',
            new URL(uni.url).pathname + new URL(uni.url).search,
            {
                as: 'anon',
            },
        );
        const gone = await make(19, { ttlSeconds: 0 });
        fs.rmSync(path.join(t.dataDir, 'downloads', 'Epsilon Archive', 'images', 'IMG_0019.webp'));
        await t.exchange(
            'share file missing on disk → 404',
            'GET',
            `/share/${gone.id}?s=${sign(gone.id, 0)}`,
            {
                as: 'anon',
            },
        );
    });

    it('access counters reflect successful serves only', async () => {
        const t = h.t;
        await t.exchange('link 1 counters after serving', 'GET', '/api/share/links?downloadId=1');
    });
});

describe('admin API: revoke', () => {
    it('revokes once, idempotently afterwards', async () => {
        const t = h.t;
        await t.exchange('revoke link 1', 'DELETE', '/api/share/links/1');
        await t.exchange('revoke link 1 again', 'DELETE', '/api/share/links/1');
        await t.exchange('revoke unknown id', 'DELETE', '/api/share/links/9999');
        await t.exchange('revoke bad id → 400', 'DELETE', '/api/share/links/abc');
        await t.exchange('revoke id 0 → 400', 'DELETE', '/api/share/links/0');
        await t.exchange('revoke guest → 403', 'DELETE', '/api/share/links/4', { as: 'guest' });
        await t.exchange('revoked link no longer serves', 'GET', `/share/1?s=${sign(1, FAR_S)}`, {
            as: 'anon',
        });
        await t.exchange('list after revoke', 'GET', '/api/share/links?downloadId=1');
    });
});

describe('share rate limiter', () => {
    it('config advanced.share.rateLimitMax does not reach the registered limiter today', async () => {
        const t2 = await h.extra({
            configPatch(cfg) {
                cfg.advanced.share = { rateLimitMax: 2, rateLimitWindowMs: 60_000 };
            },
        });
        const s1 = sign(1, FAR_S);
        for (let i = 1; i <= 3; i++) {
            await t2.exchange(
                `limited server: share request ${i} of 3`,
                'GET',
                `/share/1?s=${s1}`,
                {
                    as: 'anon',
                    bodyMode: 'none',
                    note: 'rateLimitMax=2 in config; today the route keeps the boot-time 60/min limiter',
                },
            );
        }
    });
});
