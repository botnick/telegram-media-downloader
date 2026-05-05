/**
 * Share-link signing & verification.
 *
 * Generates and validates the HMAC-signed URLs that let an admin hand a
 * single media file to a non-user (e.g. a friend with the URL), without
 * exposing the dashboard password or creating a real account.
 *
 * URL shape (v2.4.1+):
 *   /share/<linkId>/<filename>?s=<base64url-43chars>
 *
 *     - `linkId`    DB row id (share_links.id) — bound into the sig.
 *     - `filename`  cosmetic, helps browsers + download managers pick a
 *                   sensible name; the server still reads the canonical
 *                   filename from the DB. Optional — omitting it gives
 *                   `/share/<linkId>?s=…`.
 *     - `s`         HMAC-SHA256 over "<linkId>|<expEpochSeconds>".
 *                   Database is the single source of truth for the
 *                   expiry; the URL no longer carries `?exp=` so it
 *                   can't tell a friend exactly when their access
 *                   ends, and so an admin can rotate `expires_at` in
 *                   the DB without re-issuing the URL (the old sig
 *                   stops verifying — a feature, not a bug).
 *
 * Backwards compatibility:
 *   The legacy URL shape `/share/<linkId>?exp=<sec>&sig=<43chars>` is
 *   still accepted by the server. The sig there binds the same payload
 *   (`linkId|exp`) which still equals `linkId|row.expires_at` at issue
 *   time, so old URLs verify cleanly against the new code path.
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

// Filename sanitiser for the URL path segment. Strips any character that
// would force percent-encoding into ugliness (control chars, separators,
// reserved chars), collapses whitespace, caps at 80 bytes UTF-8 so a
// pathological filename doesn't push the URL over the 2 KB browser limit.
function sanitiseUrlFilename(name) {
    if (!name || typeof name !== 'string') return null;
    let s = name
        // Strip anything outside printable ASCII + safe punct (browsers/CDNs
        // hate the rest in path segments anyway).
        .replace(/[\x00-\x1F\x7F<>:"/\\|?*#]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!s) return null;
    // Hard cap at 80 chars — long enough to keep "Cool Channel — 2024-01-15.jpg"
    // intact, short enough that the whole URL fits comfortably.
    if (s.length > 80) {
        const dot = s.lastIndexOf('.');
        if (dot > 50 && dot >= s.length - 8) {
            // Preserve extension on long names: "verylongname….jpg".
            s = s.slice(0, 76 - (s.length - dot)) + '…' + s.slice(dot);
        } else {
            s = s.slice(0, 79) + '…';
        }
    }
    return s;
}

/**
 * Build the public path component of a share URL. Caller prefixes the
 * origin (the server doesn't always know its public hostname).
 *
 * @param {number|string} linkId      share_links.id
 * @param {number} expEpochSeconds    db row's expires_at (seconds since epoch)
 * @param {string} [fileName]         optional cosmetic filename; included as
 *                                    a path segment so download managers
 *                                    pick a friendly name and the URL reads
 *                                    naturally (e.g. /share/42/cat.mp4?s=…).
 * @returns {string} e.g. "/share/42/cat.mp4?s=abc..." (or "/share/42?s=abc..."
 *                       when no filename is supplied).
 */
export function buildShareUrlPath(linkId, expEpochSeconds, fileName = null) {
    const sig = signShareToken(linkId, expEpochSeconds);
    const cleanName = sanitiseUrlFilename(fileName);
    const slug = cleanName ? `/${encodeURIComponent(cleanName)}` : '';
    return `/share/${encodeURIComponent(linkId)}${slug}?s=${encodeURIComponent(sig)}`;
}

// ---- TTL clamp -------------------------------------------------------------

// Spec defaults — used when config.advanced.share isn't set. The mutable
// `_ttl*` variables below shadow them once the server applies a config.
// Importers that want the *current* effective limits should call
// `getShareLimits()` rather than reading these constants directly.
export const TTL_MIN_SEC_DEFAULT = 60;                 // 1 minute floor
export const TTL_MAX_SEC_DEFAULT = 90 * 24 * 3600;     // 90 days ceiling
export const TTL_DEFAULT_SEC_DEFAULT = 7 * 24 * 3600;  // 7 days
// Backwards-compat aliases. Existing callers (and the test suite) read
// these as plain constants; they keep returning the spec default values.
export const TTL_MIN_SEC = TTL_MIN_SEC_DEFAULT;
export const TTL_MAX_SEC = TTL_MAX_SEC_DEFAULT;
export const TTL_DEFAULT_SEC = TTL_DEFAULT_SEC_DEFAULT;
// Sentinel: caller passed `0` (or the literal string '0' / null after the
// Number() coerce) → "never expires". The DB stores expires_at = 0 and
// the verifier skips the time-based check entirely. The HMAC still binds
// `exp=0` so the URL is just as tamper-resistant as a TTL'd one.
export const TTL_NEVER = 0;

let _ttlMin = TTL_MIN_SEC_DEFAULT;
let _ttlMax = TTL_MAX_SEC_DEFAULT;
let _ttlDefault = TTL_DEFAULT_SEC_DEFAULT;

/**
 * Update the runtime TTL limits from `config.advanced.share`. Called by
 * the server on boot and after every config_updated broadcast. Each
 * field is clamped to a sane range so a hand-edited config can't disable
 * the floor or invert min/max.
 *
 * @param {{ ttlMinSec?: number, ttlMaxSec?: number, ttlDefaultSec?: number }} cfg
 */
export function applyShareLimits(cfg = {}) {
    const minIn = Number(cfg.ttlMinSec);
    const maxIn = Number(cfg.ttlMaxSec);
    const defIn = Number(cfg.ttlDefaultSec);
    // Floor: at least 1 second; can't go below 1 or the URL is meaningless.
    const min = Number.isFinite(minIn) && minIn >= 1
        ? Math.floor(minIn) : TTL_MIN_SEC_DEFAULT;
    // Ceiling: at most 10 years (defensive — keeps signed-integer epoch
    // math comfortably inside JS safe range).
    const TEN_YEARS_SEC = 10 * 365 * 24 * 3600;
    const max = Number.isFinite(maxIn) && maxIn >= min
        ? Math.min(TEN_YEARS_SEC, Math.floor(maxIn)) : TTL_MAX_SEC_DEFAULT;
    const def = Number.isFinite(defIn)
        ? Math.max(min, Math.min(max, Math.floor(defIn))) : TTL_DEFAULT_SEC_DEFAULT;
    _ttlMin = min;
    _ttlMax = max;
    _ttlDefault = def;
}

export function getShareLimits() {
    return { ttlMinSec: _ttlMin, ttlMaxSec: _ttlMax, ttlDefaultSec: _ttlDefault };
}

export function clampTtlSeconds(input) {
    // null / undefined = "not specified" → default. Done BEFORE the 0
    // sentinel because Number(null) === 0 would otherwise be misread as
    // an explicit "never expires".
    if (input == null) return _ttlDefault;
    // Explicit "never" passes through untouched. Useful for an admin
    // sharing a link that should outlive any reasonable retention window
    // (e.g. a personal cloud-style permanent link to a video).
    if (input === 0 || input === '0') return TTL_NEVER;
    const n = Number(input);
    if (!Number.isFinite(n) || n < 0) return _ttlDefault;
    if (n === 0) return TTL_NEVER;
    return Math.max(_ttlMin, Math.min(_ttlMax, Math.floor(n)));
}

/**
 * Mask a `sig=<…>` query value in a URL/path string for logging.
 * Keeps the first 8 chars + `…` so log readers can correlate the same
 * sig across requests without reconstructing it.
 */
export function maskSigInLog(s) {
    if (typeof s !== 'string') return s;
    // Mask both the legacy `?sig=` and the new `?s=` parameter shapes.
    return s.replace(/(\b(?:sig|s)=)([A-Za-z0-9_\-%]{1,512})/gi, (_, k, v) => {
        const head = v.slice(0, 8);
        return `${k}${head}…`;
    });
}
