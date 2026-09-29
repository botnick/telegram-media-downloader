// First-run state: no dashboard password configured yet. Everything but
// the public paths fails closed until POST /api/auth/setup (local only).

import { describe, expect, it } from 'vitest';
import { useContract } from './harness.js';

const h = useContract(import.meta.url, {
    configPatch(cfg) {
        delete cfg.web.passwordHash;
        delete cfg.web.guestPasswordHash;
        cfg.web.guestEnabled = false;
    },
    afterDb(db) {
        db.exec('DELETE FROM web_sessions');
    },
});

describe('before setup', () => {
    it('fails closed', async () => {
        const t = h.t;
        await t.exchange('auth_check before setup', 'GET', '/api/auth_check', { as: 'anon' });
        await t.exchange('api before setup → 503', 'GET', '/api/downloads', { as: 'anon' });
        await t.exchange('POST api before setup → 503', 'POST', '/api/config', {
            as: 'anon',
            body: {},
        });
        await t.exchange('GET / before setup → setup-needed redirect', 'GET', '/', { as: 'anon' });
        await t.exchange('GET /setup-needed.html', 'GET', '/setup-needed.html', { as: 'anon' });
        await t.exchange('GET /api/version before setup (public)', 'GET', '/api/version', {
            as: 'anon',
        });
        await t.exchange('login before setup → 503', 'POST', '/api/login', {
            as: 'anon',
            body: { password: 'anything-at-all' },
        });
        await t.exchange('reset/request before setup → 409', 'POST', '/api/auth/reset/request', {
            as: 'anon',
        });
        const ws = t.ws({ as: 'anon' });
        const r = await ws.opened;
        ws.close();
        t.store.record('ws upgrade before setup', {
            ws: 'dashboard',
            upgrade: r.open ? 'open' : r.status,
        });
    });
});

describe('POST /api/auth/setup', () => {
    it('validates, refuses remote callers, then configures once', async () => {
        const t = h.t;
        await t.exchange('setup short password → 400', 'POST', '/api/auth/setup', {
            as: 'anon',
            body: { password: 'short' },
        });
        await t.exchange('setup non-string password → 400', 'POST', '/api/auth/setup', {
            as: 'anon',
            body: { password: 12345678 },
        });
        await t.exchange('setup from a non-local client → 403', 'POST', '/api/auth/setup', {
            as: 'anon',
            // trust proxy = loopback: the forwarded address becomes req.ip.
            headers: { 'x-forwarded-for': '203.0.113.9' },
            body: { password: 'first-admin-pass' },
        });
        const r = await t.exchange('setup → 200 + admin cookie', 'POST', '/api/auth/setup', {
            as: 'anon',
            body: { password: 'first-admin-pass' },
        });
        const cookie = [].concat(r.headers['set-cookie'] || [])[0]?.split(';')[0];
        expect(cookie).toMatch(/^tg_dl_session=/);
        await t.exchange('auth_check with the setup cookie', 'GET', '/api/auth_check', {
            cookie,
            as: 'setup-admin',
        });
        await t.exchange('setup again → 409', 'POST', '/api/auth/setup', {
            as: 'anon',
            body: { password: 'second-admin-pass' },
        });
        await t.exchange('login with the configured password', 'POST', '/api/login', {
            as: 'anon',
            body: { password: 'first-admin-pass' },
        });
    });
});
