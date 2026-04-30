/**
 * Share-link signing & verification.
 *
 * Generates and validates the HMAC-signed URLs that let an admin hand a
 * single media file to a non-user (e.g. a friend with the URL), without
 * exposing the dashboard password or creating a real account.
 *
 * URL shape:
 *   /share/<linkId>?exp=<epochSeconds>&sig=<base64url-43chars>
 *
 * Signature input is the canonical string "<linkId>|<expEpochSeconds>"
 * — including `linkId` binds the signature to the specific share row so
 * a sig from share A can't be replayed against share B. Including `exp`
 * means flipping the expiry invalidates the sig (the friend can't extend
 * their own access).
 *
 * The HMAC key (`config.web.shareSecret`) is generated lazily on first
 * use (32 random bytes hex) and persisted via the caller. Rotating it
 * invalidates every outstanding link — documented as a feature, not a
 * bug, of the design.
 *
 * Verification uses `crypto.timingSafeEqual`, with an explicit
 * length-check first to avoid leaking the digest length via early-return
 * timing.
 */

import crypto from 'crypto';

// ---- secret bootstrap ------------------------------------------------------

const SECRET_BYTES = 32;
let _cachedSecret = null;          // hex string
let _cachedSecretFingerprint = '';

/**
 * Pull the secret out of `config.web.shareSecret`. Returns the existing
 * value if present, otherwise generates one and writes it back to the
 * provided config object — caller is responsible for persisting via
 * writeConfigAtomic. Returns `{ secret, generated }` so callers know
 * when a save is needed.
 */
export function ensureShareSecret(config) {
    if (!config.web) config.web = {};
    let s = config.web.shareSecret;
    let generated = false;
    if (typeof s !== 'string' || !/^[0-9a-f]{64}$/i.test(s)) {
        s = crypto.randomBytes(SECRET_BYTES).toString('hex');
        config.web.shareSecret = s;
        generated = true;
    }
    _cachedSecret = s;
    // Cheap fingerprint (first 8 hex chars) so log lines can show "which
    // secret is in play" without leaking the secret itself.
    _cachedSecretFingerprint = s.slice(0, 8);
    return { secret: s, generated };
}

/** Reset cache — used by tests / reset-secret flow. */
export function _resetShareSecretCache() {
    _cachedSecret = null;
    _cachedSecretFingerprint = '';
}

function getCachedSecret() {
    if (!_cachedSecret) {
        throw new Error('share secret not initialised — call ensureShareSecret(config) on boot');
    }
    return _cachedSecret;
}

/** Public-safe handle for log lines / metrics. Never logs the full secret. */
export function getShareSecretFingerprint() {
    return _cachedSecretFingerprint || '(uninit)';
}

// ---- base64url helpers -----------------------------------------------------

function toBase64Url(buf) {
    return buf.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

// Decoder kept for parity / future verification flows that need raw
// digest bytes. Underscore prefix opts out of the no-unused-vars rule.
function _fromBase64Url(s) {
    if (typeof s !== 'string') return Buffer.alloc(0);
    if (!/^[A-Za-z0-9_-]+$/.test(s) || s.length > 512) return Buffer.alloc(0);
    let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    try { return Buffer.from(b64, 'base64'); }
    catch { return Buffer.alloc(0); }
}

// ---- sign / verify ---------------------------------------------------------

/**
 * @param {number|string} linkId    DB row id (share_links.id) — bound into the sig
 * @param {number} expEpochSeconds  Absolute expiry, epoch seconds
 * @returns {string} base64url-encoded SHA-256 HMAC digest (no padding, 43 chars)
 */
export function signShareToken(linkId, expEpochSeconds) {
    const secret = getCachedSecret();
    const payload = `${String(linkId)}|${String(expEpochSeconds)}`;
    const mac = crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(payload).digest();
    return toBase64Url(mac);
}

/**
 * Constant-time signature verification. Returns `true` only when:
 *   - `sig` decodes to exactly 32 bytes (HMAC-SHA256 length)
 *   - the recomputed digest matches via timingSafeEqual
 *
 * NOTE: This is signature-only. The caller MUST separately check the
 * `expires_at`/`revoked_at` row state — a sig that verifies for an
 * expired or revoked link is still expired/revoked.
 */
export function verifyShareToken(linkId, expEpochSeconds, sig) {
    const expected = Buffer.from(signShareToken(linkId, expEpochSeconds), 'utf8');
    const got = Buffer.from(String(sig || ''), 'utf8');
    if (expected.length !== got.length) return false;
    try { return crypto.timingSafeEqual(expected, got); }
    catch { return false; }
}

/**
 * Build the public path component of a share URL. Caller prefixes the
 * origin (the server doesn't always know its public hostname).
 *
 * @returns {string} e.g. "/share/42?exp=1750000000&sig=abc..."
 */
export function buildShareUrlPath(linkId, expEpochSeconds) {
    const sig = signShareToken(linkId, expEpochSeconds);
    return `/share/${encodeURIComponent(linkId)}`
         + `?exp=${encodeURIComponent(expEpochSeconds)}`
         + `&sig=${encodeURIComponent(sig)}`;
}

// ---- TTL clamp -------------------------------------------------------------

export const TTL_MIN_SEC = 60;                // 1 minute floor — anything less is misuse
export const TTL_MAX_SEC = 90 * 24 * 3600;    // 90 days ceiling — caps long-lived shares
export const TTL_DEFAULT_SEC = 7 * 24 * 3600; // 7 days default
// Sentinel: caller passed `0` (or the literal string '0' / null after the
// Number() coerce) → "never expires". The DB stores expires_at = 0 and
// the verifier skips the time-based check entirely. The HMAC still binds
// `exp=0` so the URL is just as tamper-resistant as a TTL'd one.
export const TTL_NEVER = 0;

export function clampTtlSeconds(input) {
    // null / undefined = "not specified" → default. Done BEFORE the 0
    // sentinel because Number(null) === 0 would otherwise be misread as
    // an explicit "never expires".
    if (input == null) return TTL_DEFAULT_SEC;
    // Explicit "never" passes through untouched. Useful for an admin
    // sharing a link that should outlive any reasonable retention window
    // (e.g. a personal cloud-style permanent link to a video).
    if (input === 0 || input === '0') return TTL_NEVER;
    const n = Number(input);
    if (!Number.isFinite(n) || n < 0) return TTL_DEFAULT_SEC;
    if (n === 0) return TTL_NEVER;
    return Math.max(TTL_MIN_SEC, Math.min(TTL_MAX_SEC, Math.floor(n)));
}

/**
 * Mask a `sig=<…>` query value in a URL/path string for logging.
 * Keeps the first 8 chars + `…` so log readers can correlate the same
 * sig across requests without reconstructing it.
 */
export function maskSigInLog(s) {
    if (typeof s !== 'string') return s;
    return s.replace(/(\bsig=)([A-Za-z0-9_\-%]{1,512})/gi, (_, k, v) => {
        const head = v.slice(0, 8);
        return `${k}${head}…`;
    });
}
