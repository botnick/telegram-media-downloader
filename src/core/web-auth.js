/**
 * Web Dashboard authentication.
 *
 * Replaces the legacy plaintext-password-as-cookie scheme with:
 *   - scrypt-hashed password (per-password random salt, stored in config.json
 *     under web.passwordHash)
 *   - random session tokens (cookie value), persisted to data/web-sessions.json
 *   - timing-safe verification (crypto.timingSafeEqual)
 *
 * Backward compatibility: if config.web.password (legacy plaintext) is set,
 * loginVerify() accepts it and rehashes on first successful login. The legacy
 * field is removed once the hash is stored.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const SESSIONS_PATH = path.join(DATA_DIR, 'web-sessions.json');

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
        N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p,
    });
    return {
        algo: 'scrypt',
        salt: salt.toString('hex'),
        hash: hash.toString('hex'),
        N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p,
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
 *   { ok: true,  upgrade?: true } on success (upgrade=true ⇒ caller should
 *                                  rehash and persist the new hash, drop legacy)
 *   { ok: false }                  on mismatch / not configured
 */
export function loginVerify(plaintext, webConfig) {
    if (!webConfig) return { ok: false };
    if (webConfig.passwordHash) {
        return { ok: verifyPassword(plaintext, webConfig.passwordHash) };
    }
    if (typeof webConfig.password === 'string' && webConfig.password.length > 0) {
        const ok = legacyCompare(plaintext, webConfig.password);
        return ok ? { ok: true, upgrade: true } : { ok: false };
    }
    return { ok: false };
}

export function isAuthConfigured(webConfig) {
    if (!webConfig) return false;
    if (webConfig.passwordHash) return true;
    if (typeof webConfig.password === 'string' && webConfig.password.length > 0) return true;
    return false;
}

// ---- session token store --------------------------------------------------

let sessions = null; // { [token]: { createdAt, expiresAt } }

function ensureLoaded() {
    if (sessions !== null) return;
    sessions = {};
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        if (fs.existsSync(SESSIONS_PATH)) {
            const raw = fs.readFileSync(SESSIONS_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            const now = Date.now();
            for (const [tok, meta] of Object.entries(parsed || {})) {
                if (meta && meta.expiresAt > now) sessions[tok] = meta;
            }
        }
    } catch {
        sessions = {};
    }
}

function persist() {
    try {
        fs.writeFileSync(SESSIONS_PATH, JSON.stringify(sessions), { mode: 0o600 });
    } catch {
        // Non-fatal: tokens still work in-memory until restart.
    }
}

export function issueSession(opts = {}) {
    ensureLoaded();
    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    const now = Date.now();
    // Per-issue override; falls back to the original 7-day default.
    const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0
        ? Math.floor(opts.ttlMs)
        : SESSION_TTL_MS;
    sessions[token] = { createdAt: now, expiresAt: now + ttlMs };
    persist();
    return { token, maxAgeMs: ttlMs };
}

export function validateSession(token) {
    ensureLoaded();
    if (!token || typeof token !== 'string') return false;
    const meta = sessions[token];
    if (!meta) return false;
    if (meta.expiresAt <= Date.now()) {
        delete sessions[token];
        persist();
        return false;
    }
    return true;
}

export function revokeSession(token) {
    ensureLoaded();
    if (sessions[token]) {
        delete sessions[token];
        persist();
    }
}

export function revokeAllSessions() {
    ensureLoaded();
    sessions = {};
    persist();
}

// Periodic cleanup; safe to call repeatedly.
export function startSessionGc(intervalMs = 60 * 60 * 1000) {
    ensureLoaded();
    const t = setInterval(() => {
        const now = Date.now();
        let dirty = false;
        for (const [tok, meta] of Object.entries(sessions)) {
            if (meta.expiresAt <= now) { delete sessions[tok]; dirty = true; }
        }
        if (dirty) persist();
    }, intervalMs);
    if (typeof t.unref === 'function') t.unref();
    return t;
}
