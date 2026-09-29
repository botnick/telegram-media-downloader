// Auth / session contract: auth_check, login/logout, the login rate
// limiter, guest allow-list gate, CSRF origin check, guest-password admin
// API and the dashboard WebSocket's session check.
//
// Login budget: /api/login, /api/auth/change-password and
// /api/auth/reset/* share ONE limiter (10 per 15 min per IP) per server
// process. This file spends exactly 10 and then records the 11th (429).
// Password change / reset live in auth-password.contract.test.js on their
// own server.

import { describe, expect, it } from 'vitest';
import { SEED, useContract } from './harness.js';

const h = useContract(import.meta.url);

let loginCookie = null;

describe('auth_check and public paths', () => {
    it('auth_check reports role per session kind', async () => {
        const t = h.t;
        await t.exchange('auth_check anon', 'GET', '/api/auth_check', { as: 'anon' });
        await t.exchange('auth_check admin', 'GET', '/api/auth_check', { as: 'admin' });
        await t.exchange('auth_check guest', 'GET', '/api/auth_check', { as: 'guest' });
        await t.exchange('auth_check unknown token', 'GET', '/api/auth_check', {
            cookie: `tg_dl_session=${'0'.repeat(64)}`,
        });
        await t.exchange('auth_check malformed cookie header', 'GET', '/api/auth_check', {
            cookie: 'tg_dl_session',
        });
    });

    it('unauthenticated requests are refused or redirected', async () => {
        const t = h.t;
        await t.exchange('anon GET /api/downloads → 401', 'GET', '/api/downloads', { as: 'anon' });
        await t.exchange('anon POST /api/config → 401', 'POST', '/api/config', {
            as: 'anon',
            body: { pollingInterval: 5 },
        });
        await t.exchange('anon GET / → login redirect', 'GET', '/', { as: 'anon' });
        await t.exchange(
            'anon GET /files/x → login redirect',
            'GET',
            '/files/Alpha%20Photos/images/IMG_0001.jpg',
            {
                as: 'anon',
            },
        );
        await t.exchange('anon GET /login.html', 'GET', '/login.html', { as: 'anon' });
        await t.exchange('anon GET /api/version (public)', 'GET', '/api/version', { as: 'anon' });
        await t.exchange('anon GET unknown api path → 401', 'GET', '/api/does-not-exist', {
            as: 'anon',
        });
    });

    it('unknown routes with a session fall through to the default 404', async () => {
        const t = h.t;
        await t.exchange('admin GET unknown api path', 'GET', '/api/does-not-exist');
        await t.exchange('admin POST unknown api path', 'POST', '/api/does-not-exist', {
            body: {},
        });
        await t.exchange('admin GET unknown static path', 'GET', '/nope/not-here.txt');
    });
});

describe('guest allow-list gate', () => {
    it('guest may read the library but nothing operational', async () => {
        const t = h.t;
        await t.exchange('guest GET /api/downloads (allowed)', 'GET', '/api/downloads', {
            as: 'guest',
        });
        await t.exchange('guest GET /api/config → 403', 'GET', '/api/config', { as: 'guest' });
        await t.exchange('guest POST /api/config → 403', 'POST', '/api/config', {
            as: 'guest',
            body: { pollingInterval: 5 },
        });
        await t.exchange('guest DELETE /api/file → 403', 'DELETE', '/api/file', {
            as: 'guest',
            body: { path: 'Alpha Photos/images/IMG_0001.jpg' },
        });
        await t.exchange('guest GET unknown api path → 403', 'GET', '/api/does-not-exist', {
            as: 'guest',
        });
        await t.exchange('guest GET /api/monitor/status (allowed)', 'GET', '/api/monitor/status', {
            as: 'guest',
        });
    });
});

describe('CSRF origin check on state-changing requests', () => {
    it('rejects foreign or malformed Origin/Referer, accepts same host', async () => {
        const t = h.t;
        await t.exchange('POST with foreign Origin → 403', 'POST', '/api/share/links', {
            headers: { origin: 'http://evil.example' },
            body: { downloadId: 1 },
        });
        await t.exchange('POST with malformed Origin → 403', 'POST', '/api/share/links', {
            headers: { origin: 'not a url' },
            body: { downloadId: 1 },
        });
        await t.exchange('DELETE with foreign Referer → 403', 'DELETE', '/api/share/links/1', {
            headers: { referer: 'https://evil.example/page' },
        });
        await t.exchange(
            'POST with localhost Origin aliasing 127.0.0.1 → handled',
            'POST',
            '/api/share/links',
            { headers: { origin: `http://localhost:${t.port}` }, body: {} },
        );
    });
});

describe('login, logout and the login rate limiter', () => {
    it('validates the body and the password', async () => {
        const t = h.t;
        await t.exchange('login without body → 400', 'POST', '/api/login', { as: 'anon' }); // 1
        await t.exchange('login with empty password → 400', 'POST', '/api/login', {
            as: 'anon',
            body: { password: '' },
        }); // 2
        await t.exchange('login with wrong password → 401', 'POST', '/api/login', {
            as: 'anon',
            body: { password: 'definitely-wrong' },
        }); // 3
    });

    it('admin and guest passwords each open a session of their role', async () => {
        const t = h.t;
        const r = await t.exchange('login admin → 200 + cookie', 'POST', '/api/login', {
            as: 'anon',
            body: { password: SEED.adminPassword },
        }); // 4
        const set = [].concat(r.headers['set-cookie'] || [])[0] || '';
        loginCookie = set.split(';')[0];
        expect(loginCookie).toMatch(/^tg_dl_session=[0-9a-f]{64}$/);
        await t.exchange('auth_check with the issued cookie', 'GET', '/api/auth_check', {
            cookie: loginCookie,
            as: 'issued-admin',
        });
        await t.exchange('login guest → 200 guest role', 'POST', '/api/login', {
            as: 'anon',
            body: { password: SEED.guestPassword },
        }); // 5
    });

    it('change-password guards (shares the login limiter)', async () => {
        const t = h.t;
        await t.exchange('change-password anon → 401', 'POST', '/api/auth/change-password', {
            as: 'anon',
            body: { currentPassword: SEED.adminPassword, newPassword: 'another-password-1' },
        }); // 6
        await t.exchange('change-password guest → 403', 'POST', '/api/auth/change-password', {
            as: 'guest',
            body: { currentPassword: SEED.adminPassword, newPassword: 'another-password-1' },
        }); // 7
        await t.exchange(
            'change-password missing fields → 400',
            'POST',
            '/api/auth/change-password',
            {
                body: { currentPassword: SEED.adminPassword },
            },
        ); // 8
        await t.exchange('change-password short → 400', 'POST', '/api/auth/change-password', {
            body: { currentPassword: SEED.adminPassword, newPassword: 'short' },
        }); // 9
        await t.exchange(
            'change-password wrong current → 401',
            'POST',
            '/api/auth/change-password',
            {
                body: { currentPassword: 'wrong-current-pw', newPassword: 'another-password-1' },
            },
        ); // 10
    });

    it('the 11th attempt inside the window is rate limited', async () => {
        const t = h.t;
        await t.exchange('login 11th attempt → 429', 'POST', '/api/login', {
            as: 'anon',
            body: { password: SEED.adminPassword },
        });
        await t.exchange('reset/request while limited → 429', 'POST', '/api/auth/reset/request', {
            as: 'anon',
        });
    });

    it('logout revokes the session and clears the cookie', async () => {
        const t = h.t;
        await t.exchange('logout with issued cookie', 'POST', '/api/logout', {
            cookie: loginCookie,
            as: 'issued-admin',
        });
        await t.exchange('auth_check after logout', 'GET', '/api/auth_check', {
            cookie: loginCookie,
            as: 'issued-admin',
        });
        await t.exchange('logout without a session', 'POST', '/api/logout', { as: 'anon' });
    });

    it('/api/auth/setup refuses once a password exists', async () => {
        const t = h.t;
        await t.exchange('setup when configured → 409', 'POST', '/api/auth/setup', {
            as: 'anon',
            body: { password: 'brand-new-password' },
        });
        await t.exchange('setup with short password → 400', 'POST', '/api/auth/setup', {
            as: 'anon',
            body: { password: 'x' },
        });
    });
});

describe('dashboard WebSocket session check', () => {
    it('refuses anonymous and unknown sessions, accepts admin and guest', async () => {
        const t = h.t;
        const anon = t.ws({ as: 'anon' });
        const bad = t.ws({ cookie: `tg_dl_session=${'0'.repeat(64)}` });
        const admin = t.ws({ as: 'admin' });
        const guest = t.ws({ as: 'guest' });
        const results = {
            anon: await anon.opened,
            unknownToken: await bad.opened,
            admin: await admin.opened,
            guest: await guest.opened,
        };
        for (const s of [anon, bad, admin, guest]) s.close();
        t.store.record('ws upgrade by session kind', {
            ws: 'dashboard',
            upgrade: Object.fromEntries(
                Object.entries(results).map(([k, v]) => [k, v.open ? 'open' : v.status]),
            ),
        });
    });
});

describe('guest password administration', () => {
    it('guards and validation', async () => {
        const t = h.t;
        await t.exchange('guest-password anon → 401', 'POST', '/api/auth/guest-password', {
            as: 'anon',
            body: { enabled: false },
        });
        await t.exchange('guest-password guest → 403', 'POST', '/api/auth/guest-password', {
            as: 'guest',
            body: { enabled: false },
        });
        await t.exchange('guest-password empty body → 400', 'POST', '/api/auth/guest-password', {
            body: {},
        });
        await t.exchange('guest-password short → 400', 'POST', '/api/auth/guest-password', {
            body: { password: 'short' },
        });
        await t.exchange(
            'guest-password equal to admin → 400',
            'POST',
            '/api/auth/guest-password',
            {
                body: { password: SEED.adminPassword },
            },
        );
    });

    it('disable → enable → new password → clear, with config_updated broadcasts', async () => {
        const t = h.t;
        const ws = t.ws({ as: 'admin' });
        await ws.opened;
        ws.drain();
        await t.exchange('guest-password disable', 'POST', '/api/auth/guest-password', {
            body: { enabled: false },
        });
        await t.exchange('guest session revoked after disable', 'GET', '/api/auth_check', {
            as: 'guest',
        });
        await t.exchange('auth_check shows guest disabled', 'GET', '/api/auth_check', {
            as: 'anon',
        });
        await t.exchange('guest-password enable', 'POST', '/api/auth/guest-password', {
            body: { enabled: true },
        });
        await t.exchange('guest-password set new', 'POST', '/api/auth/guest-password', {
            body: { password: 'new-guest-password' },
        });
        await t.exchange('guest-password clear', 'POST', '/api/auth/guest-password', {
            body: { clear: true },
        });
        await t.exchange(
            'guest-password enable without a password → 400',
            'POST',
            '/api/auth/guest-password',
            { body: { enabled: true } },
        );
        await ws.waitFor(
            (m) =>
                m.type === 'config_updated' &&
                ws.messages.filter((x) => x.type === 'config_updated').length >= 4,
        );
        ws.close();
        t.recordWs('ws events from guest-password changes', ws.drain());
    });
});
