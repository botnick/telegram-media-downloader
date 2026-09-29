// Telegram account list + the phone → code → 2FA add-account wizard.
//
// main target: two saved session files (not decryptable — they are never
//   opened without API credentials) + config metadata for one of them, no
//   API credentials → list works from the session files, everything that
//   needs the AccountManager says NO_API_CREDS.
// `creds` target: API credentials, no sessions. The wizard really starts a
//   gramJS client; the network sandbox refuses the DC connection, gramJS
//   retries (5 × 2 s) and `begin` returns after ~10 s with state "phone".
//   Only the steps that don't need Telegram to answer are recorded
//   (status, validation, wrong-state, cancel).

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { useContract } from './harness.js';

const T = (iso) => Date.parse(`${iso}Z`);

function writeSessions(dataDir) {
    const dir = path.join(dataDir, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    // Listed oldest-mtime first; the first one is the default account.
    const files = [
        ['bob.enc', T('2024-02-01T00:00:00')],
        ['alice.enc', T('2024-03-01T00:00:00')],
    ];
    for (const [name, mtime] of files) {
        const p = path.join(dir, name);
        fs.writeFileSync(p, JSON.stringify({ iv: '00', data: 'not-a-real-session', tag: '00' }));
        fs.utimesSync(p, new Date(mtime), new Date(mtime));
    }
    // Not a session file — must be ignored.
    fs.writeFileSync(path.join(dir, 'README.txt'), 'ignored');
}

const h = useContract(import.meta.url, {
    configPatch: (cfg) => {
        cfg.accounts = [
            { id: 'alice', name: 'Alice Example', username: 'alice_ex', phone: '+10000000001' },
        ];
    },
    beforeStart: writeSessions,
});

// Random 16-hex auth-flow id minted by beginPhoneAuth.
const SESSION_ID_MASK = { sessionId: 'random auth-flow id (crypto.randomBytes(8))' };

describe('account list (no API credentials)', () => {
    it('lists session files with config metadata', async () => {
        const t = h.t;
        await t.exchange('accounts admin', 'GET', '/api/accounts');
        await t.exchange('accounts guest → 403', 'GET', '/api/accounts', { as: 'guest' });
        await t.exchange('accounts anon → 401', 'GET', '/api/accounts', { as: 'anon' });
        await t.exchange(
            'monitor/status counts session files when creds are missing',
            'GET',
            '/api/monitor/status',
        );
    });

    it('wizard and removal need credentials', async () => {
        const t = h.t;
        await t.exchange('auth/begin without API creds → 503', 'POST', '/api/accounts/auth/begin', {
            body: { label: 'carol' },
        });
        await t.exchange('auth/phone without API creds → 400', 'POST', '/api/accounts/auth/phone', {
            body: { sessionId: 'abc', phone: '+10000000002' },
        });
        await t.exchange('auth/code without API creds → 400', 'POST', '/api/accounts/auth/code', {
            body: { sessionId: 'abc', code: '12345' },
        });
        await t.exchange('auth/2fa without API creds → 400', 'POST', '/api/accounts/auth/2fa', {
            body: { sessionId: 'abc', password: 'pw' },
        });
        await t.exchange(
            'auth/cancel without API creds → 400',
            'POST',
            '/api/accounts/auth/cancel',
            {
                body: { sessionId: 'abc' },
            },
        );
        await t.exchange(
            'auth/:sessionId without API creds → 503',
            'GET',
            '/api/accounts/auth/abc',
        );
        await t.exchange('delete account without API creds → 503', 'DELETE', '/api/accounts/alice');
        await t.exchange('auth/begin guest → 403', 'POST', '/api/accounts/auth/begin', {
            as: 'guest',
            body: {},
        });
        await t.exchange('delete account anon → 401', 'DELETE', '/api/accounts/alice', {
            as: 'anon',
        });
    });
});

describe('add-account wizard with API credentials, Telegram unreachable', () => {
    it('begin → status → validation / wrong state → cancel', async () => {
        const c = await h.extra({
            configPatch: (cfg) => {
                cfg.telegram = { apiId: '123456', apiHash: '0123456789abcdef0123456789abcdef' };
            },
        });
        await c.exchange('[creds] accounts without a sessions dir', 'GET', '/api/accounts');
        await c.exchange('[creds] delete unknown account → 404', 'DELETE', '/api/accounts/nobody');
        await c.exchange(
            '[creds] auth/phone unknown session → 400',
            'POST',
            '/api/accounts/auth/phone',
            {
                body: { sessionId: 'deadbeefdeadbeef', phone: '+10000000002' },
            },
        );
        await c.exchange(
            '[creds] auth/:sessionId unknown → 404',
            'GET',
            '/api/accounts/auth/deadbeefdeadbeef',
        );
        await c.exchange(
            '[creds] auth/cancel unknown session',
            'POST',
            '/api/accounts/auth/cancel',
            {
                body: { sessionId: 'deadbeefdeadbeef' },
            },
        );

        const begin = await c.exchange(
            '[creds] auth/begin (DC refused, returns after retries)',
            'POST',
            '/api/accounts/auth/begin',
            {
                body: { label: 'Carol Test' },
                mask: SESSION_ID_MASK,
            },
        );
        const sid = begin.json?.sessionId;
        expect(sid).toMatch(/^[0-9a-f]{16}$/);
        // Requests carry the random id; the recording shows the literal
        // `<sessionId>` placeholder in the request. Responses of these steps
        // don't contain the id, so nothing in them is masked.
        const step = async (label, method, urlTpl, body) => {
            const real = (v) => (typeof v === 'string' ? v.replace('<sessionId>', sid) : v);
            const realBody =
                body && Object.fromEntries(Object.entries(body).map(([k, v]) => [k, real(v)]));
            const res = await c.request(method, real(urlTpl), { body: realBody });
            await c.record(label, { method, path: urlTpl, as: 'admin', body }, res);
        };
        await step(
            '[creds] auth/:sessionId right after begin',
            'GET',
            '/api/accounts/auth/<sessionId>',
        );
        await step('[creds] auth/phone empty phone → 400', 'POST', '/api/accounts/auth/phone', {
            sessionId: '<sessionId>',
            phone: '   ',
        });
        await step('[creds] auth/code in phone state → 400', 'POST', '/api/accounts/auth/code', {
            sessionId: '<sessionId>',
            code: '12345',
        });
        await step('[creds] auth/2fa in phone state → 400', 'POST', '/api/accounts/auth/2fa', {
            sessionId: '<sessionId>',
            password: 'pw',
        });
        await step('[creds] auth/cancel', 'POST', '/api/accounts/auth/cancel', {
            sessionId: '<sessionId>',
        });
        await step(
            '[creds] auth/:sessionId after cancel → 404',
            'GET',
            '/api/accounts/auth/<sessionId>',
        );
        await step('[creds] auth/cancel again → not_found', 'POST', '/api/accounts/auth/cancel', {
            sessionId: '<sessionId>',
        });
    }, 60_000);
});
