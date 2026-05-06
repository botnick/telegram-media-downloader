import { describe, it, expect, beforeEach } from 'vitest';
import {
    hashPassword,
    verifyPassword,
    loginVerify,
    isAuthConfigured,
    isGuestEnabled,
    issueSession,
    validateSession,
    revokeSession,
    revokeAllSessions,
    revokeAllGuestSessions,
} from '../src/core/web-auth.js';

describe('hashPassword / verifyPassword', () => {
    it('round-trips a password', () => {
        const stored = hashPassword('correct horse battery staple');
        expect(stored.algo).toBe('scrypt');
        expect(stored.salt).toBeTruthy();
        expect(stored.hash).toBeTruthy();
        expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
    });

    it('rejects the wrong password', () => {
        const stored = hashPassword('right');
        expect(verifyPassword('wrong', stored)).toBe(false);
    });

    it('rejects a malformed stored object', () => {
        expect(verifyPassword('x', null)).toBe(false);
        expect(verifyPassword('x', { algo: 'unknown' })).toBe(false);
    });

    it('throws on empty input', () => {
        expect(() => hashPassword('')).toThrow();
    });
});

describe('loginVerify (legacy plaintext upgrade)', () => {
    it('upgrades legacy plaintext password and stamps role:admin', () => {
        const cfg = { password: 'plain' };
        expect(loginVerify('plain', cfg)).toEqual({ ok: true, role: 'admin', upgrade: true });
        expect(loginVerify('wrong', cfg)).toEqual({ ok: false });
    });

    it('verifies new-format passwordHash without an upgrade signal', () => {
        const cfg = { passwordHash: hashPassword('newpass') };
        expect(loginVerify('newpass', cfg)).toEqual({ ok: true, role: 'admin' });
        expect(loginVerify('wrong', cfg)).toEqual({ ok: false });
    });

    it('returns ok:false when nothing is configured', () => {
        expect(loginVerify('x', null)).toEqual({ ok: false });
        expect(loginVerify('x', {})).toEqual({ ok: false });
    });
});

describe('loginVerify (guest role)', () => {
    it('matches the guest hash when admin doesn’t match and guest is enabled', () => {
        const cfg = {
            passwordHash: hashPassword('admin-pw'),
            guestPasswordHash: hashPassword('guest-pw'),
            guestEnabled: true,
        };
        expect(loginVerify('admin-pw', cfg)).toEqual({ ok: true, role: 'admin' });
        expect(loginVerify('guest-pw', cfg)).toEqual({ ok: true, role: 'guest' });
        expect(loginVerify('nope', cfg)).toEqual({ ok: false });
    });

    it('rejects guest password when guestEnabled is false', () => {
        const cfg = {
            passwordHash: hashPassword('admin-pw'),
            guestPasswordHash: hashPassword('guest-pw'),
            guestEnabled: false,
        };
        expect(loginVerify('guest-pw', cfg)).toEqual({ ok: false });
    });

    it('rejects guest path when guestPasswordHash is missing even if flag is true', () => {
        const cfg = {
            passwordHash: hashPassword('admin-pw'),
            guestEnabled: true,
        };
        expect(loginVerify('anything', cfg)).toEqual({ ok: false });
    });

    it('admin login still works when guest is configured', () => {
        const cfg = {
            passwordHash: hashPassword('admin-pw'),
            guestPasswordHash: hashPassword('guest-pw'),
            guestEnabled: true,
        };
        expect(loginVerify('admin-pw', cfg).role).toBe('admin');
    });
});

describe('isAuthConfigured / isGuestEnabled', () => {
    it('isAuthConfigured reflects either legacy or hashed presence', () => {
        expect(isAuthConfigured(null)).toBe(false);
        expect(isAuthConfigured({})).toBe(false);
        expect(isAuthConfigured({ password: 'x' })).toBe(true);
        expect(isAuthConfigured({ passwordHash: hashPassword('y') })).toBe(true);
    });

    it('isGuestEnabled requires both hash and the enabled flag', () => {
        expect(isGuestEnabled(null)).toBe(false);
        expect(isGuestEnabled({})).toBe(false);
        expect(isGuestEnabled({ guestPasswordHash: hashPassword('g') })).toBe(true);
        expect(isGuestEnabled({ guestPasswordHash: hashPassword('g'), guestEnabled: false })).toBe(
            false,
        );
        expect(isGuestEnabled({ guestEnabled: true })).toBe(false);
    });
});

describe('session tokens — role', () => {
    beforeEach(() => {
        revokeAllSessions();
    });

    it('issues an admin session by default', () => {
        const { token, role } = issueSession();
        expect(role).toBe('admin');
        expect(validateSession(token)).toEqual({ role: 'admin' });
    });

    it('issues a guest session when role:guest is requested', () => {
        const { token, role } = issueSession({ role: 'guest' });
        expect(role).toBe('guest');
        expect(validateSession(token)).toEqual({ role: 'guest' });
    });

    it('revokeAllGuestSessions only drops guest tokens', () => {
        const admin = issueSession({ role: 'admin' }).token;
        const guest = issueSession({ role: 'guest' }).token;
        revokeAllGuestSessions();
        expect(validateSession(admin)).toEqual({ role: 'admin' });
        expect(validateSession(guest)).toBe(false);
    });

    it('returns false for unknown / empty tokens', () => {
        expect(validateSession('')).toBe(false);
        expect(validateSession('00'.repeat(32))).toBe(false);
    });

    it('issues a 64-char hex token', () => {
        const { token } = issueSession();
        expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('revokeSession removes one token', () => {
        const { token } = issueSession();
        expect(validateSession(token)).toEqual({ role: 'admin' });
        revokeSession(token);
        expect(validateSession(token)).toBe(false);
    });
});
