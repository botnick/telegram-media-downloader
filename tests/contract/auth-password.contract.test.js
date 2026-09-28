// Password change and the stdout-token password reset, on a server of
// their own (they share the 10-per-15-min login limiter with /api/login).

import { describe, expect, it } from 'vitest';
import { SEED, until, useContract } from './harness.js';

const h = useContract(import.meta.url);

describe('change-password', () => {
    it('refuses a new password equal to the guest one', async () => {
        await h.t.exchange(
            'change-password same as guest → 400',
            'POST',
            '/api/auth/change-password',
            {
                body: { currentPassword: SEED.adminPassword, newPassword: SEED.guestPassword },
            },
        ); // 1
    });

    it('changes the admin password and issues a fresh session', async () => {
        const t = h.t;
        const r = await t.exchange(
            'change-password → 200 + new cookie',
            'POST',
            '/api/auth/change-password',
            {
                body: { currentPassword: SEED.adminPassword, newPassword: 'changed-admin-pass' },
            },
        ); // 2
        expect([].concat(r.headers['set-cookie'] || []).length).toBe(1);
        await t.exchange('old session keeps working after change', 'GET', '/api/auth_check');
        await t.exchange('login with the new password', 'POST', '/api/login', {
            as: 'anon',
            body: { password: 'changed-admin-pass' },
        }); // 3
        await t.exchange('login with the old password → 401', 'POST', '/api/login', {
            as: 'anon',
            body: { password: SEED.adminPassword },
        }); // 4
    });
});

describe('password reset via stdout token', () => {
    let token = null;

    it('request prints a one-time token to the server log', async () => {
        const t = h.t;
        await t.exchange('reset/request → 200', 'POST', '/api/auth/reset/request', { as: 'anon' }); // 5
        token = await until(
            () => {
                for (const line of t.logs()) {
                    const m = /Token:\s*([0-9a-f]{32})\b/.exec(line);
                    if (m) return m[1];
                }
                return null;
            },
            { what: 'reset token in server output' },
        );
        t.store.record('reset token appears on stdout', {
            note: 'the operator copies it from `docker compose logs`; format "Token: <32 hex>"',
            tokenFormat: /^[0-9a-f]{32}$/.test(token) ? '32 lowercase hex chars' : token,
        });
    });

    it('confirm validates input and the token', async () => {
        const t = h.t;
        await t.exchange('reset/confirm missing fields → 400', 'POST', '/api/auth/reset/confirm', {
            as: 'anon',
            body: { token },
        }); // 6
        await t.exchange('reset/confirm short password → 400', 'POST', '/api/auth/reset/confirm', {
            as: 'anon',
            body: { token, newPassword: 'short' },
        }); // 7
        await t.exchange('reset/confirm unknown token → 401', 'POST', '/api/auth/reset/confirm', {
            as: 'anon',
            body: { token: 'f'.repeat(32), newPassword: 'reset-admin-pass' },
        }); // 8
    });

    it('a valid token resets the password and revokes every session', async () => {
        const t = h.t;
        const ws = t.ws({ as: 'admin' });
        await ws.opened;
        await t.exchange('reset/confirm → 200 + cookie', 'POST', '/api/auth/reset/confirm', {
            as: 'anon',
            body: { token, newPassword: 'reset-admin-pass' },
        }); // 9
        await t.exchange('seeded admin session revoked by reset', 'GET', '/api/auth_check');
        await t.exchange('seeded guest session revoked by reset', 'GET', '/api/auth_check', {
            as: 'guest',
        });
        await t.exchange('reset token is single-use → 401', 'POST', '/api/auth/reset/confirm', {
            as: 'anon',
            body: { token, newPassword: 'reset-admin-pass-2' },
        }); // 10
        ws.close();
        t.recordWs('ws events around a password reset', ws.drain(), {
            note: 'the reset revokes sessions in the DB; an already-open socket is not closed',
        });
    });
});
