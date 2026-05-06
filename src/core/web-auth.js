/**
 * Web Dashboard authentication.
 *
 * - scrypt-hashed password (per-password random salt, stored under
 *   config.web.passwordHash)
 * - random session tokens persisted in the SQLite `web_sessions` table
 * - timing-safe verification (crypto.timingSafeEqual)
 *
 * Backward compatibility: if config.web.password (legacy plaintext) is set,
 * loginVerify() accepts it and rehashes on first successful login. The legacy
 * field is removed once the hash is stored.
 */

import crypto from 'crypto';
import {
    insertSession,
    findSession,
    deleteSession,
    deleteAllSessions,
    deleteSessionsByRole,
    deleteExpiredSessions,
} from './db.js';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
// Default 7-day cookie lifetime. Callers (server.js) may override per-issue
// via issueSession({ ttlMs }) — pulled from config.advanced.web.sessionTtlDays.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;

// ---- password hashing -----------------------------------------------------

export function hashPassword(plaintext) {
    if (typeof plaintext !== 'string' || plaintext.length === 0) {
        throw new Error('Password must be a non-empty string');
    }
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(plaintext, salt, SCRYPT_PARAMS.keylen, {
        N: SCRYPT_PARAMS.N,
        r: SCRYPT_PARAMS.r,
        p: SCRYPT_PARAMS.p,
    });
    return {
        algo: 'scrypt',
        salt: salt.toString('hex'),
        hash: hash.toString('hex'),
        N: SCRYPT_PARAMS.N,
        r: SCRYPT_PARAMS.r,
        p: SCRYPT_PARAMS.p,
        keylen: SCRYPT_PARAMS.keylen,
    };
}

export function verifyPassword(plaintext, stored) {
    if (!stored || stored.algo !== 'scrypt') return false;
    try {
        const salt = Buffer.from(stored.salt, 'hex');
        const expected = Buffer.from(stored.hash, 'hex');
        const candidate = crypto.scryptSync(plaintext, salt, stored.keylen || expected.length, {
            N: stored.N || SCRYPT_PARAMS.N,
            r: stored.r || SCRYPT_PARAMS.r,
            p: stored.p || SCRYPT_PARAMS.p,
        });
        if (candidate.length !== expected.length) return false;
        return crypto.timingSafeEqual(candidate, expected);
    } catch {
        return false;
    }
}

// Constant-time compare for legacy plaintext stored passwords.
function legacyCompare(a, b) {
    const ab = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ab.length !== bb.length) {
        // Still do a compare to keep timing roughly constant; result discarded.
        crypto.timingSafeEqual(ab, ab);
        return false;
    }
    return crypto.timingSafeEqual(ab, bb);
}

/**
 * Verify a login attempt against the config's web.* fields.
 * Returns:
 *   { ok: true,  role: 'admin'|'guest', upgrade?: true }
 *     upgrade=true ⇒ caller should rehash and persist the admin hash
 *   { ok: false } on mismatch / not configured
 *
 * Admin hash is tried first. If the admin password also happens to match the
 * guest hash (configured equal — rejected at set-time but possible if config
 * is hand-edited), admin wins and the guest never logs in by accident.
 */
export function loginVerify(plaintext, webConfig) {
    if (!webConfig) return { ok: false };
    if (webConfig.passwordHash) {
        if (verifyPassword(plaintext, webConfig.passwordHash)) {
            return { ok: true, role: 'admin' };
        }
    } else if (typeof webConfig.password === 'string' && webConfig.password.length > 0) {
        if (legacyCompare(plaintext, webConfig.password)) {
            return { ok: true, role: 'admin', upgrade: true };
        }
    }
    if (isGuestEnabled(webConfig) && verifyPassword(plaintext, webConfig.guestPasswordHash)) {
        return { ok: true, role: 'guest' };
    }
    return { ok: false };
}

export function isAuthConfigured(webConfig) {
    if (!webConfig) return false;
    if (webConfig.passwordHash) return true;
    if (typeof webConfig.password === 'string' && webConfig.password.length > 0) return true;
    return false;
}

export function isGuestEnabled(webConfig) {
    if (!webConfig) return false;
    if (!webConfig.guestPasswordHash) return false;
    return webConfig.guestEnabled !== false;
}

// ---- session token store --------------------------------------------------
//
// Backed by the SQLite `web_sessions` table. Each accessor maps to a typed
// helper in core/db.js — no in-memory state, no JSON-file persistence, GC
// is an indexed `expires_at <= ?` delete instead of a full-file rewrite.

export function issueSession(opts = {}) {
    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    const now = Date.now();
    // Per-issue override; falls back to the original 7-day default.
    const ttlMs =
        Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? Math.floor(opts.ttlMs) : SESSION_TTL_MS;
    const role = opts.role === 'guest' ? 'guest' : 'admin';
    insertSession({ token, role, expiresAt: now + ttlMs, issuedAt: now });
    return { token, maxAgeMs: ttlMs, role };
}

/**
 * Returns false if the session is invalid/expired, otherwise an object with
 * `{ role }`. findSession() self-cleans expired rows so a stale token never
 * satisfies a request.
 */
export function validateSession(token) {
    if (!token || typeof token !== 'string') return false;
    const row = findSession(token);
    if (!row) return false;
    return { role: row.role === 'guest' ? 'guest' : 'admin' };
}

export function revokeSession(token) {
    if (typeof token !== 'string' || !token) return;
    deleteSession(token);
}

export function revokeAllSessions() {
    deleteAllSessions();
}

export function revokeAllGuestSessions() {
    deleteSessionsByRole('guest');
}

// Periodic cleanup; safe to call repeatedly.
export function startSessionGc(intervalMs = 60 * 60 * 1000) {
    const t = setInterval(() => {
        try {
            deleteExpiredSessions(Date.now());
        } catch {
            /* DB unavailable — try again next tick */
        }
    }, intervalMs);
    if (typeof t.unref === 'function') t.unref();
    return t;
}
