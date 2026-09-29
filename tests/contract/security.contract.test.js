// Transport-level behaviour shared by every route: security headers,
// compression negotiation, forceHttps + reverse-proxy trust, the optional
// global API rate limit and the production cookie flags.

import { describe, it } from 'vitest';
import { SEED, useContract } from './harness.js';

const h = useContract(import.meta.url);

describe('default server', () => {
    it('HSTS is cleared and X-Forwarded-For is trusted only from loopback', async () => {
        const t = h.t;
        await t.exchange('GET via proxy hop, forceHttps off', 'GET', '/api/version', {
            as: 'anon',
            headers: { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' },
        });
    });

    it('compression follows Accept-Encoding, size and the opt-out header', async () => {
        const t = h.t;
        await t.exchange(
            'gzip negotiated on a large JSON response',
            'GET',
            '/api/downloads/all?limit=50',
            {
                headers: { 'accept-encoding': 'gzip' },
            },
        );
        await t.exchange(
            'br negotiated on a large JSON response',
            'GET',
            '/api/downloads/all?limit=50',
            {
                headers: { 'accept-encoding': 'br' },
            },
        );
        await t.exchange('deflate negotiated on the SPA shell', 'GET', '/index.html', {
            headers: { 'accept-encoding': 'deflate' },
        });
        await t.exchange('small response stays uncompressed', 'GET', '/api/version', {
            headers: { 'accept-encoding': 'gzip' },
        });
        await t.exchange('x-no-compression opt-out', 'GET', '/api/downloads/all?limit=50', {
            headers: { 'accept-encoding': 'gzip', 'x-no-compression': '1' },
        });
        await t.exchange(
            'files are never compressed',
            'GET',
            '/files/Gamma%20Docs/documents/notes.txt',
            {
                headers: { 'accept-encoding': 'gzip' },
            },
        );
    });
});

describe('forceHttps behind a reverse proxy', () => {
    it('redirects remote GETs, refuses remote writes, lets loopback through', async () => {
        const t = await h.extra({
            configPatch(cfg) {
                cfg.web.forceHttps = true;
            },
        });
        await t.exchange('forceHttps: loopback GET passes', 'GET', '/api/version', { as: 'anon' });
        await t.exchange('forceHttps: remote GET → 308 to https', 'GET', '/api/version?x=1', {
            as: 'anon',
            headers: { 'x-forwarded-for': '203.0.113.9' },
        });
        await t.exchange('forceHttps: remote HEAD → 308 to https', 'HEAD', '/login.html', {
            as: 'anon',
            headers: { 'x-forwarded-for': '203.0.113.9' },
        });
        await t.exchange('forceHttps: remote POST → 403', 'POST', '/api/login', {
            as: 'anon',
            headers: { 'x-forwarded-for': '203.0.113.9' },
            body: { password: 'x' },
        });
        await t.exchange(
            'forceHttps: remote over https → HSTS + upgrade-insecure-requests',
            'GET',
            '/api/version',
            {
                as: 'anon',
                headers: { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' },
            },
        );
    });
});

describe('global API rate limit (opt-in)', () => {
    it('counts /api requests per client and answers 429 past the cap', async () => {
        const t = await h.extra({
            configPatch(cfg) {
                cfg.web.rateLimit = { enabled: true, perMinute: 10 };
            },
        });
        // A client address of its own, so the harness' readiness probe
        // doesn't count against it.
        const headers = { 'x-forwarded-for': '198.51.100.7' };
        for (let i = 1; i <= 10; i++) {
            await t.exchange(`rate limit: request ${i} of 10`, 'GET', '/api/version', {
                as: 'anon',
                headers,
            });
        }
        await t.exchange('rate limit: 11th request → 429', 'GET', '/api/version', {
            as: 'anon',
            headers,
        });
        await t.exchange('rate limit: non-API paths are not limited', 'GET', '/login.html', {
            as: 'anon',
            headers,
        });
        await t.exchange('rate limit: another client is unaffected', 'GET', '/api/version', {
            as: 'anon',
            headers: { 'x-forwarded-for': '198.51.100.8' },
        });
    });
});

describe('NODE_ENV=production', () => {
    it('marks the session cookie Secure', async () => {
        const t = await h.extra({ nodeEnv: 'production' });
        await t.exchange('production login cookie flags', 'POST', '/api/login', {
            as: 'anon',
            body: { password: SEED.adminPassword },
        });
        await t.exchange('production logout cookie flags', 'POST', '/api/logout');
    });
});
