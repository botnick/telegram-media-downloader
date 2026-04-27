
/**
 * Web GUI Server - Configuration + Profile Photos + SQLite Data
 * Features: Groups, Settings, Viewer, Real Telegram Profile Photos
 */

import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import net from 'net';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import fs from 'fs/promises';
import fsSync, { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import crypto from 'crypto';

import { getOrGenerateSecret } from '../core/secret.js';
import { getDb, getDownloads, getStats as getDbStats, deleteGroupDownloads, deleteAllDownloads, backfillGroupNames, searchDownloads, deleteDownloadsBy } from '../core/db.js';
import { sanitizeName } from '../core/downloader.js';
import { SecureSession } from '../core/security.js';
import { AccountManager } from '../core/accounts.js';
import { loadConfig } from '../config/manager.js';
import { runtime } from '../core/runtime.js';
import { getDiskRotator } from '../core/disk-rotator.js';
import * as integrity from '../core/integrity.js';
import { getRescueSweeper } from '../core/rescue.js';
import { getRescueStats } from '../core/db.js';
import { parseTelegramUrl, parseUrlList, UrlParseError } from '../core/url-resolver.js';
import { listUserStories, listAllStories, storyToJob } from '../core/stories.js';
import { metrics } from '../core/metrics.js';
import {
    hashPassword, loginVerify, isAuthConfigured,
    issueSession, validateSession, revokeSession, revokeAllSessions, startSessionGc,
} from '../core/web-auth.js';
import { suppressNoise, wrapConsoleMethod } from '../core/logger.js';

// Demote gramJS reconnect chatter from stderr/stdout to data/logs/network.log.
// gramJS opens a fresh DC connection per file download (different DCs host
// different media buckets), so a busy monitor logs hundreds of "Disconnecting
// from <ip>:443/TCPFull..." lines per hour through the bare console — which
// drowns out real errors. Both methods are wrapped because gramJS uses
// console.log for most of its lifecycle messages and console.error for the
// occasional warning. TGDL_DEBUG=1 brings them back.
console.log = wrapConsoleMethod(console.log, 'gramjs');
console.error = wrapConsoleMethod(console.error, 'gramjs');
process.on('unhandledRejection', (reason) => {
    const msg = reason?.message || String(reason);
    if (suppressNoise(msg, 'unhandledRejection')) return;
    console.error('Unhandled rejection:', reason);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
const SESSION_PATH = path.join(DATA_DIR, 'session.enc');
const SESSION_PASSWORD = getOrGenerateSecret();

const app = express();
const server = createServer(app);
// noServer: we authenticate the upgrade ourselves before handing the socket
// off to the WebSocketServer. Without this, ws auto-binds to `server` and
// accepts every connection including unauthenticated ones.
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

function parseCookieHeader(header) {
    const out = {};
    if (!header) return out;
    for (const cookie of header.split(';')) {
        const eq = cookie.indexOf('=');
        if (eq < 0) continue;
        const k = cookie.slice(0, eq).trim();
        const v = cookie.slice(eq + 1).trim();
        if (k) out[k] = decodeURIComponent(v);
    }
    return out;
}

server.on('upgrade', async (req, socket, head) => {
    try {
        const config = await readConfigSafe();
        const enabled = config.web?.enabled !== false;
        const configured = isAuthConfigured(config.web);

        // Fail-closed: drop unauth'd upgrades unless auth is intentionally off
        // (which we no longer allow — !configured ⇒ block).
        if (!enabled || !configured) {
            socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
            socket.destroy();
            return;
        }

        const cookies = parseCookieHeader(req.headers.cookie);
        if (!validateSession(cookies['tg_dl_session'])) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    } catch {
        try { socket.destroy(); } catch {}
    }
});

// Telegram client
let telegramClient = null;
let isConnected = false;

// Ensure photos directory exists
if (!fsSync.existsSync(PHOTOS_DIR)) {
    fsSync.mkdirSync(PHOTOS_DIR, { recursive: true });
}

// Trust the first reverse proxy if running behind one (rate-limit needs the
// real client IP via X-Forwarded-For). Disabled when not behind a proxy.
if (process.env.TRUST_PROXY) {
    const v = process.env.TRUST_PROXY;
    app.set('trust proxy', /^\d+$/.test(v) ? parseInt(v, 10) : v);
}

// Force HTTPS — opt-in via config.web.forceHttps (default off, plain HTTP).
// Skips localhost so it doesn't lock you out of local dev. `req.secure`
// honours `X-Forwarded-Proto` only when `trust proxy` is set above, so
// reverse-proxy users must export TRUST_PROXY=1 for this to work.
// Non-GET/HEAD requests get a 403 instead of a 308 — clients shouldn't
// silently retry mutations on a different scheme.
app.use(async (req, res, next) => {
    const config = await readConfigSafe();
    if (!config.web?.forceHttps) return next();
    if (req.secure) return next();
    const ip = req.ip || req.socket?.remoteAddress || '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return res.status(403).json({ error: 'HTTPS required' });
    }
    const host = req.headers.host;
    if (!host) return res.status(400).end();
    return res.redirect(308, `https://${host}${req.originalUrl}`);
});

// Security headers. CSP is on but allows the SPA's two CDN dependencies
// (Tailwind + Remixicon) and the inline event-handlers we still use in
// index.html. Tightening "self"-only is a follow-up once the inline handlers
// are migrated to addEventListener.
app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: true,
        directives: {
            'default-src': ["'self'"],
            'script-src': [
                "'self'", "'unsafe-inline'",
                'https://cdn.tailwindcss.com',
                'https://cdn.jsdelivr.net',
            ],
            // The SPA uses inline onclick / oninput handlers in index.html
            // (toggle UI, range-slider value updaters, modal close-buttons).
            // Helmet's defaults set script-src-attr to 'none' which would
            // block them; allow inline here until the markup is migrated to
            // addEventListener.
            'script-src-attr': ["'unsafe-inline'"],
            'style-src': [
                "'self'", "'unsafe-inline'",
                'https://cdn.jsdelivr.net',
                'https://fonts.googleapis.com',
            ],
            'style-src-attr': ["'unsafe-inline'"],
            'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdn.jsdelivr.net'],
            'img-src': ["'self'", 'data:', 'blob:'],
            'media-src': ["'self'", 'blob:'],
            'connect-src': ["'self'", 'ws:', 'wss:'],
            'object-src': ["'none'"],
            'frame-ancestors': ["'self'"],
        },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
}));

// HTTP caching policy. Browsers (and intermediaries like Cloudflare) will
// happily serve a 200 from disk for several seconds even on responses with
// no cache headers — that surfaces as "the dashboard says I'm logged out
// for 3 s after I log in", "stats look stuck", or "photos refuse to refresh
// after a profile update". Pin each path prefix to an explicit policy:
//
//   /api/*      → never cache (auth-dependent + state mutates constantly)
//   /files/*    → 60 s private (downloads list updates as the queue drains)
//   /photos/*   → 1 d fresh, 7 d stale-while-revalidate (avatars rarely change)
//   /js,/css,/locales → 1 h public (TODO: bump to 1 y immutable when we
//                       hash filenames so cache-busting is automatic)
//   /sw.js      → no-cache (PWA service worker — must always re-check)
//
// Sits BEFORE the static handlers so res.setHeader wins over express.static's
// default ETag/Last-Modified-only behaviour.
app.use((req, res, next) => {
    const p = req.path;
    if (p.startsWith('/api/')) {
        // Auth-dependent — vary on the session cookie so a shared cache
        // (Cloudflare with "Cache Everything", a corporate proxy) can't
        // hand user A's response to user B. Use res.vary() so we APPEND
        // to whatever Vary express may set later (Accept-Encoding etc.)
        // instead of clobbering it.
        res.setHeader('Cache-Control', 'no-store, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.vary('Cookie');
    } else if (p.startsWith('/photos/')) {
        // Avatars are content-addressed by group ID; new uploads overwrite
        // the file in place, so a 1-day TTL is fine. SWR lets the browser
        // serve a stale copy instantly while it revalidates in the background.
        res.setHeader('Cache-Control', 'private, max-age=86400, stale-while-revalidate=604800');
    } else if (p.startsWith('/files/')) {
        // Downloads — content is immutable once written (filenames embed a
        // timestamp; a re-download lands at a new filename), so a long TTL
        // is safe and necessary: video playback issues many 64 KB range
        // requests for a single clip, and a 60 s TTL was forcing the
        // browser to revalidate every chunk through the auth + path-resolve
        // middleware → the source of the playback lag the user reported.
        res.setHeader('Cache-Control', 'private, max-age=2592000, immutable');
    } else if (p === '/sw.js') {
        // Service worker manifest must never be cached or PWA updates stick.
        // (Future PWA agent may also set this; if so, theirs runs first via
        // a more specific route — leave their version alone.)
        res.setHeader('Cache-Control', 'no-cache, max-age=0');
    } else if (p.startsWith('/js/') || p.startsWith('/css/') || p.startsWith('/locales/')) {
        // 1-hour cache until we add hash-busting filenames. Once the build
        // pipeline emits e.g. /js/app.abcdef.js, bump this to:
        //   public, max-age=31536000, immutable
        res.setHeader('Cache-Control', 'public, max-age=3600');
    }
    next();
});

// Defense-in-depth: a coarse global rate limit on every API path. The login
// endpoint has its own stricter limiter below (which is NOT user-toggleable
// — it stays on regardless to slow brute-force).
//
// Default is OFF — a private, auth-gated dashboard with a chatty SPA
// (per-group photo fetches, status polling, gallery scrolling) trips a
// modest cap easily, and the prior 600/min default was masking real
// load as 429s. Users who expose the dashboard publicly can re-enable
// it from Settings → Dashboard security.
//
// `_rateLimitConfig` is refreshed from disk every 30 s, plus immediately
// after POST /api/config so toggling in the UI takes effect without a
// restart. The skip + limit functions read this in-memory cache to stay
// sync (express-rate-limit's hooks don't accept async).
const RATE_LIMIT_DEFAULT_RPM = 10000;
let _rateLimitConfig = { enabled: false, perMinute: RATE_LIMIT_DEFAULT_RPM };

async function refreshRateLimitConfig() {
    try {
        const config = await readConfigSafe();
        const cfg = config.web?.rateLimit || {};
        const rpm = parseInt(cfg.perMinute, 10);
        _rateLimitConfig = {
            enabled: cfg.enabled === true,
            perMinute: Number.isFinite(rpm) && rpm >= 10 ? Math.min(1000000, rpm) : RATE_LIMIT_DEFAULT_RPM,
        };
    } catch { /* keep last-known-good */ }
}
refreshRateLimitConfig();
setInterval(refreshRateLimitConfig, 30 * 1000).unref();

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: () => _rateLimitConfig.perMinute,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (req) => !req.path.startsWith('/api/') || !_rateLimitConfig.enabled,
});
app.use(apiLimiter);

// Body parsing middleware — small, JSON only. Bigger payloads (e.g., bulk
// imports) should get their own dedicated route with a larger limit.
app.use(express.json({ limit: '256kb' }));

// Rolling expiry-cleanup for session tokens. Unref'd so it doesn't keep the
// process alive on shutdown.
startSessionGc();

// ============ AUTHENTICATION ============

// Simple cookie parser middleware
app.use((req, res, next) => {
    const list = {};
    const rc = req.headers.cookie;
    if (rc) {
        rc.split(';').forEach((cookie) => {
            const parts = cookie.split('=');
            list[parts.shift().trim()] = decodeURI(parts.join('='));
        });
    }
    req.cookies = list;
    next();
});

// In-process cache for config.json. checkAuth + the force-https +
// rate-limit middlewares all call readConfigSafe() on every request —
// during a video playback, the browser issues many 64 KB range GETs to
// /files/* and each one used to disk-read + JSON.parse the config. The
// 2-second TTL is short enough that toggle changes feel instant in the
// settings UI but long enough to fold the per-clip request burst into
// a single read.
let _configCache = { at: 0, value: null };
async function readConfigSafe() {
    const now = Date.now();
    if (_configCache.value && now - _configCache.at < 2000) return _configCache.value;
    try {
        const value = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        _configCache = { at: now, value };
        return value;
    } catch {
        _configCache = { at: now, value: {} };
        return {};
    }
}
function invalidateConfigCache() { _configCache = { at: 0, value: null }; }

// Atomic config writer — temp-file + rename so a crash mid-write can't
// leave config.json half-flushed. Several handlers used to call
// `fs.writeFile(CONFIG_PATH, …)` directly; route them through this.
async function writeConfigAtomic(config) {
    const tmp = CONFIG_PATH + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(config, null, 4));
    await fs.rename(tmp, CONFIG_PATH);
    invalidateConfigCache();
}

// Paths that may be reached without an authenticated session.
// PWA bits (manifest, service worker, icons) MUST be reachable pre-login
// — the browser fetches them before the user has a session cookie.
const PUBLIC_PATH_PREFIXES = [
    '/login', '/setup-needed', '/css/', '/js/', '/locales/', '/favicon', '/metrics',
    '/icons/', '/manifest.webmanifest', '/sw.js',
];
const PUBLIC_API_PATHS = new Set([
    '/api/login',
    '/api/auth_check',
    '/api/version',  // public so the status-bar chip can render pre-login
    '/api/auth/setup', // first-run only — guarded inside the handler
    '/api/auth/reset/request',  // logs token to stdout — no body returned
    '/api/auth/reset/confirm',  // requires the stdout token + new password
]);

// Treat connections from the local machine as "trusted enough" to bootstrap
// the very first password without prior auth. Any other origin still has to
// go through the CLI to set the password.
function isLocalRequest(req) {
    const ip = req.ip || req.socket?.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function isPublicPath(p) {
    if (PUBLIC_API_PATHS.has(p)) return true;
    return PUBLIC_PATH_PREFIXES.some(pre => p === pre || p.startsWith(pre));
}

async function checkAuth(req, res, next) {
    const config = await readConfigSafe();
    const enabled = config.web?.enabled !== false; // default ON

    // Fail-closed: dashboard is locked (or not yet configured).
    if (!enabled || !isAuthConfigured(config.web)) {
        if (req.path.startsWith('/api/') && !PUBLIC_API_PATHS.has(req.path)) {
            return res.status(503).json({
                error: 'Web dashboard not initialised. Run `npm run auth` to set a password.',
                setupRequired: true,
            });
        }
        if (!isPublicPath(req.path)) {
            return res.redirect('/setup-needed.html');
        }
        return next();
    }

    if (isPublicPath(req.path)) return next();

    const token = req.cookies['tg_dl_session'];
    if (validateSession(token)) return next();

    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/login.html');
}

// Stricter rate limit for the login endpoint to slow brute-force attempts.
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

const SESSION_COOKIE_OPTS = {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
};

// Resolve the per-issue session lifetime from config.advanced.web.sessionTtlDays.
// Falls back to the historical 7-day default when missing or out of range so a
// fresh install / older config behaves identically.
function sessionTtlMsFromConfig(config) {
    const days = Number(config?.advanced?.web?.sessionTtlDays);
    if (Number.isFinite(days) && days >= 1 && days <= 365) {
        return Math.floor(days * 24 * 60 * 60 * 1000);
    }
    return 7 * 24 * 60 * 60 * 1000;
}

app.post('/api/login', loginLimiter, async (req, res) => {
    try {
        const { password } = req.body || {};
        if (typeof password !== 'string' || password.length === 0) {
            return res.status(400).json({ error: 'Password required' });
        }

        const config = await readConfigSafe();
        if (!isAuthConfigured(config.web)) {
            return res.status(503).json({
                error: 'Web dashboard not initialised. Run `npm run auth`.',
                setupRequired: true,
            });
        }

        const result = loginVerify(password, config.web);
        metrics.inc('tgdl_login_total', 1, { result: result.ok ? 'ok' : 'fail' });
        if (!result.ok) return res.status(401).json({ error: 'Invalid password' });

        // Auto-upgrade legacy plaintext to scrypt hash on first successful login.
        if (result.upgrade) {
            try {
                config.web.passwordHash = hashPassword(password);
                delete config.web.password;
                await writeConfigAtomic(config);
            } catch (e) {
                console.error('Password rehash failed (non-fatal):', e.message);
            }
        }

        const { token, maxAgeMs } = issueSession({ ttlMs: sessionTtlMsFromConfig(config) });
        res.cookie('tg_dl_session', token, { ...SESSION_COOKIE_OPTS, maxAge: maxAgeMs });
        res.json({ success: true });
    } catch (e) {
        console.error('Login error:', e);
        res.status(500).json({ error: 'Internal error' });
    }
});

app.post('/api/logout', (req, res) => {
    const token = req.cookies['tg_dl_session'];
    if (token) revokeSession(token);
    res.clearCookie('tg_dl_session', SESSION_COOKIE_OPTS);
    res.json({ success: true });
});

// First-run password setup. Allowed only when no password is configured AND
// the request originates from the local machine. After first use, this
// endpoint behaves like /api/auth/change-password (which requires auth +
// current-password). This lets a fresh install be completed entirely from the
// browser instead of having to drop into the CLI.
const setupLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 20,
    standardHeaders: 'draft-7', legacyHeaders: false,
});

app.post('/api/auth/setup', setupLimiter, async (req, res) => {
    try {
        const { password } = req.body || {};
        if (typeof password !== 'string' || password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }
        const config = await readConfigSafe();
        if (isAuthConfigured(config.web)) {
            return res.status(409).json({
                error: 'Already configured — use POST /api/auth/change-password',
            });
        }
        if (!isLocalRequest(req)) {
            return res.status(403).json({
                error: 'Initial setup must be done from the local machine. Run `npm run auth` instead.',
            });
        }

        if (!config.web) config.web = {};
        config.web.enabled = true;
        config.web.passwordHash = hashPassword(password);
        delete config.web.password;
        await writeConfigAtomic(config);

        const { token, maxAgeMs } = issueSession({ ttlMs: sessionTtlMsFromConfig(config) });
        res.cookie('tg_dl_session', token, { ...SESSION_COOKIE_OPTS, maxAge: maxAgeMs });
        res.json({ success: true });
    } catch (e) {
        console.error('Setup error:', e);
        res.status(500).json({ error: 'Internal error' });
    }
});

// Change password from inside the dashboard. Requires the *current* password
// to be supplied along with the new one — even an active session can't be used
// alone, so a stolen cookie can't take over the account.
//
// This route is registered BEFORE the global checkAuth middleware (so it can
// share definition order with the rest of the /api/auth/* routes), so it must
// enforce its own auth check explicitly.
app.post('/api/auth/change-password', loginLimiter, async (req, res) => {
    try {
        if (!validateSession(req.cookies['tg_dl_session'])) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const { currentPassword, newPassword } = req.body || {};
        if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
            return res.status(400).json({ error: 'currentPassword and newPassword required' });
        }
        if (newPassword.length < 8) {
            return res.status(400).json({ error: 'New password must be at least 8 characters' });
        }
        const config = await readConfigSafe();
        if (!isAuthConfigured(config.web)) {
            return res.status(409).json({ error: 'No password configured yet — use /api/auth/setup' });
        }
        const verify = loginVerify(currentPassword, config.web);
        if (!verify.ok) return res.status(401).json({ error: 'Current password is incorrect' });

        config.web.passwordHash = hashPassword(newPassword);
        delete config.web.password;
        await writeConfigAtomic(config);

        // Issue a fresh session and let the SPA replace the old cookie. We
        // don't revoke other sessions automatically — the SPA exposes a
        // separate "Sign out everywhere" affordance that hits revokeAllSessions.
        const { token, maxAgeMs } = issueSession({ ttlMs: sessionTtlMsFromConfig(config) });
        res.cookie('tg_dl_session', token, { ...SESSION_COOKIE_OPTS, maxAge: maxAgeMs });
        res.json({ success: true });
    } catch (e) {
        console.error('change-password:', e);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ====== Password reset (token-gated) =======================================
//
// "I forgot my password" without dropping into the CLI. The flow is:
//   1. POST /api/auth/reset/request — server prints a one-time, 10-min TTL
//      token to its own stdout (visible via `docker compose logs` or the
//      Maintenance "Download log" button). Returns 200 with no token in the
//      body, so a network attacker can't see it.
//   2. POST /api/auth/reset/confirm { token, newPassword } — verifies the
//      token, rehashes the password, revokes ALL existing sessions, and
//      issues a fresh cookie.
//
// The token is single-use and only valid until consumed or expired. Rate
// limiter is `loginLimiter` (10 attempts / 15 min) so an attacker who guesses
// the token still gets bounced.
const _resetTokens = new Map(); // token → expiresAt
const RESET_TOKEN_TTL_MS = 10 * 60 * 1000;

function _gcResetTokens() {
    const now = Date.now();
    for (const [tok, exp] of _resetTokens) if (exp <= now) _resetTokens.delete(tok);
}

app.post('/api/auth/reset/request', loginLimiter, async (req, res) => {
    try {
        _gcResetTokens();
        const config = await readConfigSafe();
        if (!isAuthConfigured(config.web)) {
            return res.status(409).json({ error: 'No password configured yet — use /api/auth/setup' });
        }
        const token = crypto.randomBytes(16).toString('hex');
        _resetTokens.set(token, Date.now() + RESET_TOKEN_TTL_MS);
        // Eye-catching banner so it's easy to spot in `docker compose logs`.
        console.log('\n' + '='.repeat(60));
        console.log('🔐  DASHBOARD PASSWORD RESET TOKEN');
        console.log('    Token: ' + token);
        console.log('    Valid for 10 minutes. Single-use.');
        console.log('    Paste it into the dashboard reset form to continue.');
        console.log('='.repeat(60) + '\n');
        res.json({ success: true, ttlSeconds: Math.floor(RESET_TOKEN_TTL_MS / 1000) });
    } catch (e) {
        console.error('reset/request:', e);
        res.status(500).json({ error: 'Internal error' });
    }
});

app.post('/api/auth/reset/confirm', loginLimiter, async (req, res) => {
    try {
        _gcResetTokens();
        const { token, newPassword } = req.body || {};
        if (typeof token !== 'string' || typeof newPassword !== 'string') {
            return res.status(400).json({ error: 'token and newPassword required' });
        }
        if (newPassword.length < 8) {
            return res.status(400).json({ error: 'New password must be at least 8 characters' });
        }
        const exp = _resetTokens.get(token);
        if (!exp || exp <= Date.now()) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }
        // Single-use — burn the token before we do anything else so a retry
        // can't replay it even if the rest of the flow throws.
        _resetTokens.delete(token);

        const config = await readConfigSafe();
        if (!config.web) config.web = {};
        config.web.passwordHash = hashPassword(newPassword);
        config.web.enabled = true;
        delete config.web.password;
        await writeConfigAtomic(config);

        // Revoke every existing session — if someone reset the password,
        // assume the previous owner is locked out and shouldn't be trusted.
        revokeAllSessions();
        const { token: sessionTok, maxAgeMs } = issueSession({ ttlMs: sessionTtlMsFromConfig(config) });
        res.cookie('tg_dl_session', sessionTok, { ...SESSION_COOKIE_OPTS, maxAge: maxAgeMs });
        res.json({ success: true });
    } catch (e) {
        console.error('reset/confirm:', e);
        res.status(500).json({ error: 'Internal error' });
    }
});

// Tells the SPA whether auth is configured + whether the current request is
// authenticated. Always returns 200; the SPA decides what to render.
// Build identity for the status-bar version chip + bug reports.
// `commit` falls back to "dev" outside of CI; the Docker build passes it
// in via a `GIT_SHA` build arg → ENV. `builtAt` likewise.
app.get('/api/version', (req, res) => {
    res.json({
        version: process.env.npm_package_version || (() => {
            try {
                return JSON.parse(fsSync.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')).version;
            } catch { return 'unknown'; }
        })(),
        commit: (process.env.GIT_SHA || 'dev').slice(0, 7),
        builtAt: process.env.BUILT_AT || null,
    });
});

app.get('/api/auth_check', async (req, res) => {
    const config = await readConfigSafe();
    const configured = isAuthConfigured(config.web);
    const enabled = config.web?.enabled !== false;
    const authed = configured && enabled && validateSession(req.cookies['tg_dl_session']);
    res.json({
        configured,
        enabled,
        authenticated: !!authed,
        setupRequired: !configured || !enabled,
    });
});

// ====== Shared AccountManager (lazy) =======================================
//
// The web layer needs a Telegram client + account-management surface that
// matches what the CLI's AccountManager already does. We initialise on
// demand so a fresh install (no Telegram credentials yet) doesn't crash on
// boot. Use getAccountManager() inside route handlers.
let _accountManager = null;
async function getAccountManager() {
    if (_accountManager) return _accountManager;
    const config = loadConfig();
    if (!config.telegram?.apiId || !config.telegram?.apiHash) {
        const e = new Error('Telegram API credentials not configured');
        e.code = 'NO_API_CREDS';
        throw e;
    }
    _accountManager = new AccountManager(config);
    await _accountManager.loadAll();
    return _accountManager;
}

// PWA: serve the service worker and the web app manifest BEFORE the auth
// middleware so they're reachable on a fresh / logged-out browser. Both
// have explicit Content-Type headers (some hosts mis-detect .webmanifest)
// and the SW gets `Service-Worker-Allowed: /` so it can claim the whole
// origin even though the script itself lives at a different path.
app.get('/sw.js', (req, res) => {
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Service-Worker-Allowed', '/');
    // Don't let intermediaries cache an old SW — the SW is the thing that
    // controls cache behaviour for everything else, so it must update fast.
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

app.get('/manifest.webmanifest', (req, res) => {
    res.set('Content-Type', 'application/manifest+json; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.sendFile(path.join(__dirname, 'public', 'manifest.webmanifest'));
});

// Public Prometheus / OpenMetrics scrape — registered BEFORE the global
// auth gate so a scrape job without a session cookie can still reach it.
// Set TGDL_METRICS_TOKEN if you want gating; clients then need ?token=…
app.get('/metrics', (req, res) => {
    const wanted = process.env.TGDL_METRICS_TOKEN;
    if (wanted && req.query.token !== wanted) {
        res.status(401).type('text/plain').send('# unauthorized\n');
        return;
    }
    runtime.status(); // refresh gauges
    res.type('text/plain; version=0.0.4').send(metrics.render());
});

// Apply Auth Globally
app.use(checkAuth);

// Serve static files AFTER auth
app.use(express.static(path.join(__dirname, 'public')));
app.use('/photos', express.static(PHOTOS_DIR));

// ============ API ENDPOINTS ============

// 0. Accounts API — List saved accounts with metadata
app.get('/api/accounts', async (req, res) => {
    try {
        const sessionsDir = path.join(DATA_DIR, 'sessions');
        if (!existsSync(sessionsDir)) {
            return res.json([]);
        }
        const files = fsSync.readdirSync(sessionsDir)
            .filter(f => f.endsWith('.enc'))
            .sort((a, b) => {
                const statA = fsSync.statSync(path.join(sessionsDir, a));
                const statB = fsSync.statSync(path.join(sessionsDir, b));
                return statA.mtimeMs - statB.mtimeMs;
            });

        // Try to load metadata from config
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        const configAccounts = config.accounts || [];

        const accounts = files.map((f, index) => {
            const id = path.basename(f, '.enc');
            const meta = configAccounts.find(a => a.id === id) || {};
            return {
                id,
                name: meta.name || id,
                username: meta.username || '',
                phone: meta.phone || '',
                isDefault: index === 0
            };
        });
        res.json(accounts);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ====== Telegram account add: phone → OTP → 2FA wizard ====================
//
// Each begin call returns a sessionId; subsequent submits use that id. The
// underlying state machine lives in AccountManager._authFlows and parks
// gramJS callbacks on deferred Promises.

function tgAuthErrorBody(e) {
    if (e?.code === 'NO_API_CREDS') {
        return {
            status: 503,
            body: { error: 'Telegram API credentials not configured. Add telegram.apiId and telegram.apiHash in Settings first.', code: 'NO_API_CREDS' },
        };
    }
    return { status: 400, body: { error: e?.message || 'Bad request' } };
}

app.post('/api/accounts/auth/begin', async (req, res) => {
    try {
        const { label } = req.body || {};
        const am = await getAccountManager();
        const result = await am.beginPhoneAuth(label);
        res.json(result);
    } catch (e) {
        const { status, body } = tgAuthErrorBody(e);
        res.status(status).json(body);
    }
});

app.post('/api/accounts/auth/phone', async (req, res) => {
    try {
        const { sessionId, phone } = req.body || {};
        const am = await getAccountManager();
        res.json(await am.submitPhone(sessionId, phone));
    } catch (e) {
        res.status(400).json({ error: e?.message || 'Bad request' });
    }
});

app.post('/api/accounts/auth/code', async (req, res) => {
    try {
        const { sessionId, code } = req.body || {};
        const am = await getAccountManager();
        res.json(await am.submitCode(sessionId, code));
    } catch (e) {
        res.status(400).json({ error: e?.message || 'Bad request' });
    }
});

app.post('/api/accounts/auth/2fa', async (req, res) => {
    try {
        const { sessionId, password } = req.body || {};
        const am = await getAccountManager();
        res.json(await am.submit2fa(sessionId, password));
    } catch (e) {
        res.status(400).json({ error: e?.message || 'Bad request' });
    }
});

app.post('/api/accounts/auth/cancel', async (req, res) => {
    try {
        const { sessionId } = req.body || {};
        const am = await getAccountManager();
        res.json(await am.cancelAuth(sessionId));
    } catch (e) {
        res.status(400).json({ error: e?.message || 'Bad request' });
    }
});

app.get('/api/accounts/auth/:sessionId', async (req, res) => {
    try {
        const am = await getAccountManager();
        const status = am.getAuthStatus(req.params.sessionId);
        if (!status) return res.status(404).json({ error: 'Auth session not found' });
        res.json(status);
    } catch (e) {
        const { status, body } = tgAuthErrorBody(e);
        res.status(status).json(body);
    }
});

// Remove a saved Telegram account.
app.delete('/api/accounts/:id', async (req, res) => {
    try {
        const am = await getAccountManager();
        const id = req.params.id;
        if (!am.metadata.has(id)) return res.status(404).json({ error: 'Account not found' });
        await am.removeAccount(id);
        res.json({ success: true });
    } catch (e) {
        const { status, body } = tgAuthErrorBody(e);
        res.status(status).json(body);
    }
});

// ====== Monitor / runtime control ==========================================
//
// Starts the realtime monitor inside the web process so users don't have to
// keep a separate terminal open. Engine events are forwarded to all
// authenticated WebSocket clients.

runtime.on('state', (s) => broadcast({ type: 'monitor_state', state: s.state, error: s.error }));
runtime.on('event', (e) => broadcast({ type: 'monitor_event', ...e }));

app.get('/api/monitor/status', async (req, res) => {
    const status = runtime.status();
    // Report on-disk session count even when the runtime is stopped, so the
    // dashboard can tell the user "you have N accounts saved" before they
    // hit Start. Fall back to a directory listing when the lazy AM can't be
    // built (e.g. no API creds yet).
    if (status.accounts === 0) {
        try {
            const am = await getAccountManager();
            status.accounts = am.count;
        } catch {
            try {
                const dir = path.join(DATA_DIR, 'sessions');
                if (existsSync(dir)) {
                    status.accounts = fsSync.readdirSync(dir).filter(f => f.endsWith('.enc')).length;
                }
            } catch { /* ignore */ }
        }
    }
    // Surface the next-step hint so the SPA can render an empty-state
    // call-to-action without re-deriving it from multiple endpoints.
    const config = await readConfigSafe();
    status.hint = !config.telegram?.apiId || !config.telegram?.apiHash
        ? 'configure-api'
        : status.accounts === 0
            ? 'add-account'
            : (config.groups || []).filter(g => g.enabled).length === 0
                ? 'enable-group'
                : null;
    res.json(status);
});

app.post('/api/monitor/start', async (req, res) => {
    try {
        const am = await getAccountManager();
        if (am.count === 0) {
            return res.status(409).json({
                error: 'No Telegram accounts loaded. Add one in Settings → Accounts first.',
            });
        }
        await runtime.start({ config: loadConfig(), accountManager: am });
        res.json({ success: true, status: runtime.status() });
    } catch (e) {
        const { status, body } = tgAuthErrorBody(e);
        res.status(status === 400 ? 500 : status).json(body.error ? body : { error: e.message });
    }
});

app.post('/api/monitor/stop', async (req, res) => {
    try {
        await runtime.stop();
        res.json({ success: true, status: runtime.status() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ====== History batch download =============================================
//
// Run an out-of-band backfill against a configured group. Re-uses the
// runtime's downloader if it's running so the worker pool isn't doubled;
// otherwise spins one up just for this request and tears it down on
// completion.
//
// Persistence — past jobs (last 30 days) are written to data/history-jobs.json
// so the new Backfill page can show a rolling history across server restarts.
// JSON file is enough at this scale; if we ever cross ~10k rows we'll port to
// SQLite. The map below holds active jobs (with the live HistoryDownloader
// instance attached) plus a hot copy of recent finished ones; the file is
// considered the source of truth for anything older.

const HISTORY_JOBS_PATH = path.join(DATA_DIR, 'history-jobs.json');
const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// jobId → { id, state, processed, downloaded, error, group, groupId, limit,
//           startedAt, finishedAt, cancelled, _runner }
// `_runner` is stripped before serialising to disk (it's the live downloader).
const _historyJobs = new Map();

async function loadHistoryJobsFromDisk() {
    try {
        const raw = await fs.readFile(HISTORY_JOBS_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const cutoff = Date.now() - HISTORY_RETENTION_MS;
        return parsed.filter(j => j && (j.finishedAt || j.startedAt || 0) >= cutoff);
    } catch {
        return [];
    }
}

async function saveHistoryJobsToDisk() {
    // Snapshot finished jobs (state !== running) without the _runner ref.
    const finished = Array.from(_historyJobs.values())
        .filter(j => j.state !== 'running')
        .map(({ _runner, ...rest }) => rest);
    // Merge with anything still on disk that isn't in memory (older history).
    const onDisk = await loadHistoryJobsFromDisk();
    const byId = new Map();
    for (const j of onDisk) byId.set(j.id, j);
    for (const j of finished) byId.set(j.id, j);
    const cutoff = Date.now() - HISTORY_RETENTION_MS;
    const all = Array.from(byId.values())
        .filter(j => (j.finishedAt || j.startedAt || 0) >= cutoff)
        .sort((a, b) => (b.finishedAt || b.startedAt || 0) - (a.finishedAt || a.startedAt || 0));
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.writeFile(HISTORY_JOBS_PATH, JSON.stringify(all, null, 2), 'utf-8');
    } catch (e) {
        console.error('history-jobs.json write failed:', e?.message || e);
    }
}

app.post('/api/history', async (req, res) => {
    try {
        const { groupId, limit = 100, offsetId = 0 } = req.body || {};
        if (!groupId) return res.status(400).json({ error: 'groupId required' });
        // limit === 0 (or "0") means "no limit" → backfill the entire history.
        // Anything else is clamped into a sane positive range.
        const limRaw = parseInt(limit, 10);
        const lim = (limRaw === 0)
            ? null
            : Math.max(1, Math.min(50000, Number.isFinite(limRaw) ? limRaw : 100));

        const am = await getAccountManager();
        if (am.count === 0) return res.status(409).json({ error: 'No Telegram accounts loaded' });

        const config = loadConfig();
        const group = (config.groups || []).find(g => String(g.id) === String(groupId));
        if (!group) return res.status(404).json({ error: 'Group not configured' });

        const { HistoryDownloader } = await import('../core/history.js');
        const { DownloadManager } = await import('../core/downloader.js');
        const { RateLimiter } = await import('../core/security.js');

        const standalone = !runtime._downloader;
        const downloader = runtime._downloader || new DownloadManager(
            am.getDefaultClient(), config, new RateLimiter(config.rateLimits),
        );
        if (standalone) {
            await downloader.init();
            downloader.start();
        }

        const history = new HistoryDownloader(am.getDefaultClient(), downloader, config, am);

        const jobId = crypto.randomBytes(6).toString('hex');
        const job = {
            id: jobId,
            state: 'running',
            processed: 0,
            downloaded: 0,
            error: null,
            group: group.name,
            groupId: String(group.id),
            limit: lim, // null = "all"
            startedAt: Date.now(),
            finishedAt: null,
            cancelled: false,
            _runner: history,
        };
        _historyJobs.set(jobId, job);

        history.on('progress', (s) => {
            job.processed = s.processed; job.downloaded = s.downloaded;
            broadcast({
                type: 'history_progress',
                jobId, ...s,
                group: group.name,
                groupId: job.groupId,
                limit: job.limit,
                startedAt: job.startedAt,
            });
        });

        history.downloadHistory(groupId, { limit: lim ?? undefined, offsetId: parseInt(offsetId, 10) || 0 })
            .then(() => {
                job.state = job.cancelled ? 'cancelled' : 'done';
                job.finishedAt = Date.now();
                delete job._runner;
                // Two distinct terminal events so the dashboard can flash
                // green for natural completions and amber for user cancels
                // without sniffing payload fields.
                const evt = job.cancelled ? 'history_cancelled' : 'history_done';
                broadcast({ type: evt, jobId, group: group.name, ...job });
                if (standalone) downloader.stop().catch(() => {});
                saveHistoryJobsToDisk().catch(() => {});
                // Drop the in-memory entry after a grace window so the UI has
                // time to grab it via /api/history/jobs.
                setTimeout(() => _historyJobs.delete(jobId), 5 * 60 * 1000);
            })
            .catch((err) => {
                job.state = 'error';
                job.error = err?.message || String(err);
                job.finishedAt = Date.now();
                delete job._runner;
                broadcast({ type: 'history_error', jobId, error: job.error, group: group.name, groupId: job.groupId });
                if (standalone) downloader.stop().catch(() => {});
                saveHistoryJobsToDisk().catch(() => {});
            });

        res.json({ success: true, jobId, group: group.name, limit: lim });
    } catch (e) {
        console.error('POST /api/history:', e);
        res.status(500).json({ error: e.message });
    }
});

// New endpoints powering the Backfill page.
//
// /api/history/jobs returns BOTH the live + recent finished jobs combined.
// MUST be mounted before /api/history/:jobId so :jobId doesn't swallow "/jobs".
// /api/history/:jobId/cancel flips the cancel flag on the live runner so the
// iteration loop bails out gracefully.

app.get('/api/history/jobs', async (req, res) => {
    try {
        const onDisk = await loadHistoryJobsFromDisk();
        const live = Array.from(_historyJobs.values()).map(({ _runner, ...rest }) => rest);
        const byId = new Map();
        for (const j of onDisk) byId.set(j.id, j);
        for (const j of live) byId.set(j.id, j); // live overrides disk (same id)
        const all = Array.from(byId.values()).sort(
            (a, b) => (b.startedAt || 0) - (a.startedAt || 0)
        );
        const recent = all.filter(j => j.state !== 'running').slice(0, 30);
        res.json({
            active: all.filter(j => j.state === 'running'),
            // `recent` is the canonical key the dashboard reads; `past` is
            // kept as an alias for any older client still in flight.
            recent,
            past: recent,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/history/:jobId/cancel', (req, res) => {
    const job = _historyJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.state !== 'running') {
        return res.status(409).json({ error: `Job is ${job.state}, cannot cancel` });
    }
    try {
        job.cancelled = true;
        if (typeof job._runner?.cancel === 'function') job._runner.cancel();
        broadcast({ type: 'history_cancelling', jobId: job.id, group: job.group });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/history/:jobId', (req, res) => {
    const job = _historyJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const { _runner, ...safe } = job;
    res.json(safe);
});

app.get('/api/history', (req, res) => {
    res.json(Array.from(_historyJobs.values()).map(({ _runner, ...rest }) => rest));
});

// ====== Queue (IDM-style download manager) =================================
//
// Drives the new #/queue page. The page boots from /api/queue/snapshot,
// then patches its in-memory store from existing WS events
// (download_start / _progress / _complete / _error) plus a new
// `queue_changed` event emitted by the downloader when jobs are
// paused/resumed/cancelled/retried. Per-row + global actions live under
// /api/queue/* below.
//
// Recent (last N finished/failed) is persisted to disk so a page reload
// doesn't drop the tail. We keep it small (cap = 100) and fire-and-forget
// the writes so this can never block the WS event loop.

const QUEUE_HISTORY_PATH = path.join(DATA_DIR, 'queue-history.json');
const QUEUE_HISTORY_CAP = 100;
let _queueHistory = []; // newest first
let _queueHistoryDirty = false;
let _queueHistoryFlushTimer = null;
// Map<key, jobMeta> — keeps original job objects around so /retry can
// re-enqueue without the client having to round-trip the message ref.
const _failedJobMeta = new Map();

(async function loadQueueHistory() {
    try {
        const raw = await fs.readFile(QUEUE_HISTORY_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) _queueHistory = parsed.slice(0, QUEUE_HISTORY_CAP);
    } catch { /* first-run, no file yet */ }
})();

function flushQueueHistorySoon() {
    _queueHistoryDirty = true;
    if (_queueHistoryFlushTimer) return;
    _queueHistoryFlushTimer = setTimeout(async () => {
        _queueHistoryFlushTimer = null;
        if (!_queueHistoryDirty) return;
        _queueHistoryDirty = false;
        try {
            await fs.mkdir(DATA_DIR, { recursive: true });
            await fs.writeFile(QUEUE_HISTORY_PATH, JSON.stringify(_queueHistory.slice(0, QUEUE_HISTORY_CAP)), 'utf-8');
        } catch (e) {
            console.error('queue-history.json write failed:', e?.message || e);
        }
    }, 1500).unref?.();
}

function pushQueueHistory(entry) {
    if (!entry || !entry.key) return;
    // Dedup by key — last write wins so a retry → success replaces the
    // old failed row instead of stacking duplicates.
    _queueHistory = [entry, ..._queueHistory.filter(e => e.key !== entry.key)].slice(0, QUEUE_HISTORY_CAP);
    flushQueueHistorySoon();
}

// Subscribe directly to the downloader's `error` event whenever the
// runtime spins one up so we can stash the raw job (incl. live `message`
// reference) for the retry path. The serialized payload broadcast over WS
// strips `message`, which gramJS needs to actually re-download.
runtime.on('state', (s) => {
    if (s.state !== 'running' || !runtime._downloader) return;
    const dl = runtime._downloader;
    if (dl.__queueWired) return;
    dl.__queueWired = true;
    dl.on('error', ({ job }) => {
        if (job?.key) _failedJobMeta.set(job.key, job);
    });
    dl.on('complete', (job) => {
        if (job?.key) _failedJobMeta.delete(job.key);
    });
});

// Capture finishes/failures off the runtime event stream so the snapshot
// always has a populated "recent" tail even after a server restart.
runtime.on('event', (e) => {
    if (e.type === 'download_complete' && e.payload) {
        const p = e.payload;
        pushQueueHistory({
            key: p.key,
            groupId: String(p.groupId || ''),
            groupName: p.groupName || null,
            mediaType: p.mediaType || null,
            messageId: p.messageId ?? null,
            fileName: p.fileName || (p.filePath ? p.filePath.split(/[\\/]/).pop() : null),
            fileSize: p.fileSize || 0,
            status: 'done',
            addedAt: p.addedAt || null,
            finishedAt: Date.now(),
            error: null,
        });
        _failedJobMeta.delete(p.key);
    } else if (e.type === 'download_error' && e.payload?.job) {
        const p = e.payload.job;
        const errMsg = e.payload.error || 'Download failed';
        pushQueueHistory({
            key: p.key,
            groupId: String(p.groupId || ''),
            groupName: p.groupName || null,
            mediaType: p.mediaType || null,
            messageId: p.messageId ?? null,
            fileName: p.fileName || null,
            fileSize: p.fileSize || 0,
            status: 'failed',
            addedAt: p.addedAt || null,
            finishedAt: Date.now(),
            error: errMsg,
        });
    }
});

function requireDownloader(res) {
    if (!runtime._downloader) {
        res.status(409).json({ error: 'Engine is not running. Start the monitor first.' });
        return null;
    }
    return runtime._downloader;
}

app.get('/api/queue/snapshot', (req, res) => {
    try {
        const dl = runtime._downloader;
        const snap = dl ? dl.snapshot() : { active: [], queued: [], globalPaused: false, pausedCount: 0, workers: 0, pending: 0 };
        res.json({
            ...snap,
            recent: _queueHistory.slice(0, QUEUE_HISTORY_CAP),
            engineRunning: runtime.state === 'running',
            maxSpeed: (runtime._downloader?.config?.download?.maxSpeed) || null,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/queue/pause-all', (req, res) => {
    const dl = requireDownloader(res); if (!dl) return;
    dl.pauseAll();
    broadcast({ type: 'queue_changed', payload: { op: 'pause-all' } });
    res.json({ success: true });
});

app.post('/api/queue/resume-all', (req, res) => {
    const dl = requireDownloader(res); if (!dl) return;
    dl.resumeAll();
    broadcast({ type: 'queue_changed', payload: { op: 'resume-all' } });
    res.json({ success: true });
});

app.post('/api/queue/cancel-all', (req, res) => {
    const dl = requireDownloader(res); if (!dl) return;
    const removed = dl.cancelAllQueued();
    broadcast({ type: 'queue_changed', payload: { op: 'cancel-all', removed } });
    res.json({ success: true, removed });
});

app.post('/api/queue/clear-finished', (req, res) => {
    _queueHistory = [];
    flushQueueHistorySoon();
    _failedJobMeta.clear();
    broadcast({ type: 'queue_changed', payload: { op: 'clear-finished' } });
    res.json({ success: true });
});

// Per-row routes. Keys look like "<chatId>_<messageId>"; URL-encode them.
app.post('/api/queue/:key/pause', (req, res) => {
    const dl = requireDownloader(res); if (!dl) return;
    const key = decodeURIComponent(req.params.key);
    const ok = dl.pauseJob(key);
    broadcast({ type: 'queue_changed', payload: { op: 'pause', key } });
    res.json({ success: ok });
});

app.post('/api/queue/:key/resume', (req, res) => {
    const dl = requireDownloader(res); if (!dl) return;
    const key = decodeURIComponent(req.params.key);
    const ok = dl.resumeJob(key);
    broadcast({ type: 'queue_changed', payload: { op: 'resume', key } });
    res.json({ success: ok });
});

app.post('/api/queue/:key/cancel', async (req, res) => {
    const dl = requireDownloader(res); if (!dl) return;
    const key = decodeURIComponent(req.params.key);
    // Best-effort delete of any partial file the worker may have left
    // behind. We don't know the exact path until the download path is
    // built (config-dependent), so this is intentionally a no-op for the
    // cases the downloader hasn't reached yet.
    const removed = dl.cancelJob(key);
    _failedJobMeta.delete(key);
    broadcast({ type: 'queue_changed', payload: { op: 'cancel', key } });
    res.json({ success: removed });
});

app.post('/api/queue/:key/retry', async (req, res) => {
    const dl = requireDownloader(res); if (!dl) return;
    const key = decodeURIComponent(req.params.key);
    const meta = _failedJobMeta.get(key);
    if (!meta) {
        // No cached job means we never saw the original message — surface
        // a friendly error instead of silently doing nothing. The caller
        // can fall back to re-pasting the link from the viewer.
        return res.status(404).json({ error: 'Cannot retry: original job no longer in memory. Re-trigger from the source (link / backfill / monitor).' });
    }
    dl.retryJob(meta);
    broadcast({ type: 'queue_changed', payload: { op: 'retry', key } });
    res.json({ success: true });
});

// ====== Proxy test =========================================================
//
// Briefly opens a TCP connection to host:port to confirm the proxy is
// reachable. We don't speak SOCKS/MTProto here — that's the job of gramJS at
// the next monitor start — but a TCP open is enough to catch typos and DNS
// misconfiguration without needing a full Telegram round-trip.

// ====== Stories ============================================================

app.post('/api/stories/user', async (req, res) => {
    try {
        const { username } = req.body || {};
        if (!username) return res.status(400).json({ error: 'username required' });
        const am = await getAccountManager();
        if (am.count === 0) return res.status(409).json({ error: 'No Telegram accounts loaded' });
        const r = await listUserStories(am.getDefaultClient(), username);
        res.json({ success: true, ...r });
    } catch (e) {
        const { status, body } = tgAuthErrorBody(e);
        res.status(status === 400 ? 502 : status).json(body.error ? body : { error: e.message });
    }
});

app.post('/api/stories/all', async (req, res) => {
    try {
        const am = await getAccountManager();
        if (am.count === 0) return res.status(409).json({ error: 'No Telegram accounts loaded' });
        const r = await listAllStories(am.getDefaultClient());
        res.json({ success: true, ...r });
    } catch (e) {
        const { status, body } = tgAuthErrorBody(e);
        res.status(status === 400 ? 502 : status).json(body.error ? body : { error: e.message });
    }
});

app.post('/api/stories/download', async (req, res) => {
    try {
        const { username, storyIds } = req.body || {};
        if (!username || !Array.isArray(storyIds) || storyIds.length === 0) {
            return res.status(400).json({ error: 'username and storyIds required' });
        }
        const am = await getAccountManager();
        if (am.count === 0) return res.status(409).json({ error: 'No Telegram accounts loaded' });
        const client = am.getDefaultClient();
        const entity = await client.getEntity(username);
        const r = await client.invoke(new (await import('telegram')).Api.stories.GetPeerStories({ peer: entity }));
        const stories = r?.stories?.stories || [];
        const wanted = new Set(storyIds.map(Number));
        const matched = stories.filter(s => wanted.has(Number(s.id)));

        const { DownloadManager } = await import('../core/downloader.js');
        const { RateLimiter } = await import('../core/security.js');
        const config = loadConfig();
        const standalone = !runtime._downloader;
        const downloader = runtime._downloader || new DownloadManager(client, config, new RateLimiter(config.rateLimits));
        if (standalone) { await downloader.init(); downloader.start(); }

        let queued = 0;
        for (const story of matched) {
            const job = storyToJob({ peer: entity, story, peerLabel: entity.username || entity.firstName || username });
            if (await downloader.enqueue(job, 1)) queued++;
        }
        if (standalone) {
            (async () => {
                while (downloader.pendingCount > 0 || downloader.active.size > 0) {
                    await new Promise(r => setTimeout(r, 1000));
                }
                downloader.stop().catch(() => {});
            })();
        }
        res.json({ success: true, queued, requested: storyIds.length });
    } catch (e) {
        console.error('POST /api/stories/download:', e);
        res.status(500).json({ error: e.message });
    }
});

// Refuse to probe addresses that are obviously private or local — without
// this, an authenticated user could use the dashboard as a port scanner for
// the host's internal network. RFC 1918 + loopback + link-local + IPv6
// ULA / loopback / link-local + multicast are all blocked.
const SSRF_BLOCKLIST = [
    /^127\./,                      // 127.0.0.0/8
    /^10\./,                       // 10.0.0.0/8
    /^192\.168\./,                 // 192.168.0.0/16
    /^172\.(1[6-9]|2\d|3[01])\./,  // 172.16.0.0/12
    /^169\.254\./,                 // 169.254.0.0/16 link-local
    /^0\./,                        // 0.0.0.0/8
    /^22[4-9]\./, /^23\d\./,       // multicast
    /^::1$/, /^fe80:/i, /^fc00:/i, /^fd[0-9a-f]{2}:/i,
];

function isPrivateHost(host) {
    if (!host) return true;
    const lower = host.toLowerCase();
    if (lower === 'localhost' || lower.endsWith('.local') || lower.endsWith('.internal')) return true;
    return SSRF_BLOCKLIST.some(re => re.test(host));
}

app.post('/api/proxy/test', async (req, res) => {
    const { host, port } = req.body || {};
    if (!host || !port) return res.status(400).json({ error: 'host and port required' });
    if (typeof host !== 'string' || host.length > 253) {
        return res.status(400).json({ error: 'invalid host' });
    }
    if (isPrivateHost(host)) {
        return res.status(400).json({
            error: 'Private / loopback / link-local addresses are not allowed for proxy probes.',
        });
    }
    const p = parseInt(port, 10);
    if (!Number.isFinite(p) || p < 1 || p > 65535) {
        return res.status(400).json({ error: 'port must be 1-65535' });
    }
    const start = Date.now();
    const sock = new net.Socket();
    let done = false;
    const finish = (ok, error) => {
        if (done) return; done = true;
        try { sock.destroy(); } catch {}
        if (ok) return res.json({ ok: true, ms: Date.now() - start });
        return res.json({ ok: false, error });
    };
    sock.setTimeout(5000);
    sock.once('connect', () => finish(true));
    sock.once('error', (e) => finish(false, e.message));
    sock.once('timeout', () => finish(false, 'timeout'));
    sock.connect(p, host);
});

// ====== Download-by-Link ===================================================
//
// Paste any t.me message link (or a tg:// URL) and pull just that media
// into the queue. Supports private channels (/c/<id>/...), forum topics
// (extra path segment), and bulk newline-separated input.

function detectMediaType(message) {
    const m = message?.media || message;
    if (m?.sticker || message?.sticker) return 'stickers';
    if (m?.photo || m?.className === 'MessageMediaPhoto') return 'photos';
    const doc = m?.document || (m?.className === 'MessageMediaDocument' ? m : null);
    if (doc) {
        const mime = doc.mimeType || '';
        if (mime.startsWith('video/')) return 'videos';
        if (mime.startsWith('audio/')) return mime.includes('ogg') ? 'voice' : 'audio';
        if (mime.includes('gif') || (doc.attributes || []).some(a => a.className === 'DocumentAttributeAnimated')) return 'gifs';
        if (mime.includes('image/webp') || mime.includes('application/x-tgsticker')) return 'stickers';
        return 'documents';
    }
    return null;
}

app.post('/api/download/url', async (req, res) => {
    try {
        const { url, urls } = req.body || {};
        const list = Array.isArray(urls) ? urls : (url ? parseUrlList(url) : []);
        if (!list.length) return res.status(400).json({ error: 'Provide url or urls' });

        const am = await getAccountManager();
        if (am.count === 0) return res.status(409).json({ error: 'No Telegram accounts loaded' });

        const { DownloadManager } = await import('../core/downloader.js');
        const { RateLimiter } = await import('../core/security.js');

        const config = loadConfig();
        const standalone = !runtime._downloader;
        const downloader = runtime._downloader || new DownloadManager(
            am.getDefaultClient(), config, new RateLimiter(config.rateLimits),
        );
        if (standalone) {
            await downloader.init();
            downloader.start();
        }

        const results = [];
        for (const raw of list) {
            try {
                const parsed = parseTelegramUrl(raw);
                // Try every account until one can read the chat
                let resolved = null;
                let workingClient = null;
                for (const [, c] of am.clients) {
                    try {
                        const entity = await c.getEntity(parsed.chatRef);
                        const messages = await c.getMessages(entity, { ids: [parsed.messageId] });
                        if (messages?.[0]) {
                            resolved = { entity, message: messages[0] };
                            workingClient = c;
                            break;
                        }
                    } catch { /* try next */ }
                }
                if (!resolved) { results.push({ url: raw, ok: false, error: 'No account could read the message' }); continue; }

                const mediaType = detectMediaType(resolved.message);
                if (!mediaType) { results.push({ url: raw, ok: false, error: 'Message has no downloadable media' }); continue; }

                const groupId = String(resolved.entity.id);
                const groupName = resolved.entity.title || resolved.entity.username || resolved.entity.firstName || groupId;
                // Switch the downloader's reference client for this enqueue if
                // the runtime's client differs from the resolver's. The
                // downloader's .client is used to actually fetch bytes.
                downloader.client = workingClient;
                const ok = await downloader.enqueue({
                    message: resolved.message,
                    groupId,
                    groupName,
                    mediaType,
                }, 1); // realtime priority
                results.push({ url: raw, ok, group: groupName, messageId: parsed.messageId, mediaType });
            } catch (e) {
                results.push({ url: raw, ok: false, error: e instanceof UrlParseError ? e.message : (e?.message || 'Failed') });
            }
        }

        if (standalone) {
            // Tear down once jobs drain — fire-and-forget.
            (async () => {
                while (downloader.pendingCount > 0 || downloader.active.size > 0) {
                    await new Promise(r => setTimeout(r, 1000));
                }
                downloader.stop().catch(() => {});
            })();
        }

        res.json({ success: true, results });
    } catch (e) {
        console.error('POST /api/download/url:', e);
        res.status(500).json({ error: e.message });
    }
});


// 1. Stats API (SQLite)
app.get('/api/stats', async (req, res) => {
    try {
        const dbStats = getDbStats(); // From DB
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        
        // Disk Usage Cache (or read from disk_usage.json if preferred)
        let diskUsage = 0;
        const diskUsagePath = path.join(DATA_DIR, 'disk_usage.json');
        if (existsSync(diskUsagePath)) {
            const d = JSON.parse(await fs.readFile(diskUsagePath, 'utf8'));
            diskUsage = d.size;
        }

        // Account count: reflect the on-disk session files even when no
        // TelegramClient is currently connected.
        let accountCount = 0;
        try {
            const am = await getAccountManager();
            accountCount = am.count;
        } catch {
            try {
                const dir = path.join(DATA_DIR, 'sessions');
                if (existsSync(dir)) {
                    accountCount = fsSync.readdirSync(dir).filter(f => f.endsWith('.enc')).length;
                }
            } catch { /* ignore */ }
        }

        res.json({
            // DB Stats
            totalFiles: dbStats.totalFiles,
            totalSize: dbStats.totalSize,

            // Disk Stats
            diskUsage: diskUsage,
            diskUsageFormatted: formatBytes(diskUsage),
            maxDiskSize: config.diskManagement?.maxTotalSize || '0',

            // Config Stats
            totalGroups: config.groups?.length || 0,
            enabledGroups: config.groups?.filter(g => g.enabled).length || 0,
            accounts: accountCount,
            apiConfigured: !!(config.telegram?.apiId && config.telegram?.apiHash),
            telegramConnected: isConnected || (runtime.state === 'running'),
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. Dialogs API (Groups)
// /api/dialogs response cache. Telegram rate-limits getDialogs aggressively
// and the picker is opened many times in a typical session — caching the
// fully-built result for 5 min cuts the Telegram round-trip out of every
// repeat open. `?fresh=1` forces a refetch if the user wants to see a
// just-added chat.
let _dialogsResponseCache = { at: 0, body: null };

app.get('/api/dialogs', async (req, res) => {
    try {
        const wantFresh = req.query.fresh === '1';
        const now = Date.now();
        if (!wantFresh
            && _dialogsResponseCache.body
            && now - _dialogsResponseCache.at < 5 * 60 * 1000) {
            return res.json(_dialogsResponseCache.body);
        }

        // Prefer the AccountManager-managed default client; fall back to the
        // legacy single-session client for installs that haven't migrated.
        let client = null;
        try {
            const am = await getAccountManager();
            client = am.getDefaultClient();
        } catch { /* no creds yet */ }
        if ((!client || !client.connected) && telegramClient?.connected) client = telegramClient;
        if (!client || !client.connected) {
            return res.status(503).json({ error: 'Telegram client not connected' });
        }

        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        const configGroups = config.groups || [];
        const allowDM = config.allowDmDownloads === true;

        // Pull both active and archived in parallel so a sometimes-archived
        // backup channel doesn't disappear from the picker.
        const [active, archived] = await Promise.all([
            client.getDialogs({ limit: 500 }).catch(() => []),
            client.getDialogs({ limit: 200, archived: true }).catch(() => []),
        ]);

        // Side-effect: warm the name cache used by /api/groups + /api/downloads.
        // Free since we already have the dialog objects in hand.
        const nameById = new Map(_dialogsNameCache.byId);
        for (const d of [...active, ...archived]) {
            const id = String(d.id);
            const nm = d.title
                || d.name
                || ((d.entity?.firstName || '') + (d.entity?.lastName ? ' ' + d.entity.lastName : '')).trim()
                || d.entity?.username
                || null;
            if (nm && !nameLooksUnresolved(nm, id)) nameById.set(id, nm);
        }
        _dialogsNameCache = { at: now, byId: nameById };
        const seen = new Set();
        const merged = [];
        for (const d of [...active, ...archived]) {
            const id = String(d.id);
            if (seen.has(id)) continue;
            seen.add(id);
            merged.push({ d, archived: archived.includes(d) });
        }

        const results = merged
            .filter(({ d }) => {
                if (d.isGroup || d.isChannel) return true;
                // DMs (user/bot conversations) are off by default for privacy;
                // gated behind the allowDmDownloads master switch.
                return !!d.isUser && allowDM;
            })
            .map(({ d, archived }) => {
                const id = d.id.toString();
                const configGroup = configGroups.find(g => String(g.id) === id);
                let type = 'group';
                if (d.isChannel) type = 'channel';
                else if (d.isUser && d.entity?.bot) type = 'bot';
                else if (d.isUser) type = 'user';
                return {
                    id,
                    name: d.title || d.name || (d.entity?.firstName || '') + (d.entity?.lastName ? ' ' + d.entity.lastName : '') || 'Unknown',
                    type,
                    username: d.username,
                    archived,
                    members: d.entity?.participantsCount || null,
                    enabled: configGroup?.enabled || false,
                    inConfig: !!configGroup,
                    filters: configGroup?.filters || { photos: true, videos: true, files: true, links: true, voice: false, gifs: false, stickers: false },
                    autoForward: configGroup?.autoForward || { enabled: false, destination: null, deleteAfterForward: false },
                    photoUrl: `/api/groups/${id}/photo`,
                };
            });

        const body = { success: true, dialogs: results, allowDM };
        _dialogsResponseCache = { at: now, body };
        res.json(body);
    } catch (error) {
        console.error('GET /api/dialogs:', error);
        res.status(500).json({ error: 'Internal error' });
    }
});

// 3. Config Groups List (with Photo URLs)
// Mirror of the SPA's `looksUnresolved`. If a name is empty / "Unknown" /
// the bare numeric id / a "Group ..." placeholder, the caller should
// prefer any other source instead of trusting it.
function nameLooksUnresolved(name, id) {
    if (!name) return true;
    const s = String(name).trim();
    if (!s) return true;
    if (s === 'Unknown' || s === 'unknown') return true;
    if (id != null && s === String(id)) return true;
    if (/^-?\d{6,}$/.test(s)) return true;
    if (/^Group\s/i.test(s)) return true;
    return false;
}

// Best-available name for a group id. Resolution priority:
//   1. Live Telegram dialogs name (same source the Browse-chats picker
//      uses — most authoritative; reflects renames immediately).
//   2. Config-set label.
//   3. DB's most-recently-saved `group_name` for that id.
//   4. Last-resort placeholder — never the bare numeric id.
function bestGroupName(id, configName, dbName, dialogsName) {
    if (!nameLooksUnresolved(dialogsName, id)) return dialogsName;
    if (!nameLooksUnresolved(configName, id)) return configName;
    if (!nameLooksUnresolved(dbName, id)) return dbName;
    return `Unknown chat (#${id})`;
}

// Server-side cache of `id -> name` from every connected account's
// dialog list. Refreshed on demand with a 5-minute TTL — Telegram
// rate-limits getDialogs heavily, so we don't want to call it on
// every /api/groups request.
let _dialogsNameCache = { at: 0, byId: new Map() };
async function getDialogsNameCache() {
    const now = Date.now();
    if (now - _dialogsNameCache.at < 5 * 60 * 1000 && _dialogsNameCache.byId.size > 0) {
        return _dialogsNameCache.byId;
    }
    const byId = new Map();
    try {
        const am = await getAccountManager();
        const clients = [];
        for (const [, c] of am.clients) clients.push(c);
        if (telegramClient?.connected && !clients.includes(telegramClient)) clients.push(telegramClient);

        for (const client of clients) {
            if (!client?.connected) continue;
            try {
                const [active, archived] = await Promise.all([
                    client.getDialogs({ limit: 500 }).catch(() => []),
                    client.getDialogs({ limit: 200, archived: true }).catch(() => []),
                ]);
                for (const d of [...active, ...archived]) {
                    const id = String(d.id);
                    const name = d.title
                        || d.name
                        || ((d.entity?.firstName || '') + (d.entity?.lastName ? ' ' + d.entity.lastName : '')).trim()
                        || d.entity?.username
                        || null;
                    if (name && !nameLooksUnresolved(name, id) && !byId.has(id)) {
                        byId.set(id, name);
                    }
                }
            } catch { /* one bad client doesn't kill the whole sweep */ }
        }
    } catch { /* no AM — fresh install */ }
    _dialogsNameCache = { at: now, byId };
    return byId;
}

app.get('/api/groups', async (req, res) => {
    try {
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        // Pull the best DB-side name per group_id so a config row with
        // "Unknown" doesn't shadow a real name we already saved at
        // download time. Plain MAX(group_name) misbehaves on this
        // schema because "Unknown" sorts above most ASCII titles —
        // a group with rows ["Unknown", "Cool Channel"] would surface
        // "Unknown". CASE-filter out the placeholders before MAX, then
        // fall back to MAX(any) only if every row was a placeholder.
        let dbNames = new Map();
        try {
            const rows = getDb().prepare(`
                SELECT group_id,
                       MAX(CASE
                             WHEN group_name IS NOT NULL
                              AND group_name != ''
                              AND group_name != 'Unknown'
                              AND group_name != 'unknown'
                              AND group_name NOT GLOB '-?[0-9]*'
                              AND group_name NOT GLOB 'Group [0-9]*'
                           THEN group_name END) AS best_name,
                       MAX(group_name) AS any_name
                  FROM downloads
                 GROUP BY group_id`).all();
            for (const r of rows) dbNames.set(String(r.group_id), r.best_name || r.any_name);
        } catch {}

        // Live dialogs from every connected account — same source the
        // Browse-chats picker uses, so the sidebar shows the same name.
        const dialogsNames = await getDialogsNameCache();

        const groupsWithPhotos = await Promise.all((config.groups || []).map(async (group) => {
            const photoPath = path.join(PHOTOS_DIR, `${group.id}.jpg`);
            const hasPhoto = existsSync(photoPath);
            return {
                ...group,
                name: bestGroupName(group.id, group.name, dbNames.get(String(group.id)), dialogsNames.get(String(group.id))),
                photoUrl: hasPhoto ? `/photos/${group.id}.jpg` : null
            };
        }));
        res.json(groupsWithPhotos);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. Downloads Aggregate (Folders + DB Counts)
app.get('/api/downloads', async (req, res) => {
    try {
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        const configGroups = config.groups || [];
        const db = getDb();

        // CASE-filter "Unknown" / numeric-id placeholders BEFORE MAX so
        // a group with mixed rows ["Cool Channel", "Unknown"] returns
        // "Cool Channel" instead of the lexically-larger "Unknown".
        const rows = db.prepare(`
            SELECT group_id,
                   MAX(CASE
                         WHEN group_name IS NOT NULL
                          AND group_name != ''
                          AND group_name != 'Unknown'
                          AND group_name != 'unknown'
                          AND group_name NOT GLOB '-?[0-9]*'
                          AND group_name NOT GLOB 'Group [0-9]*'
                       THEN group_name END) AS best_name,
                   MAX(group_name) AS any_name,
                   COUNT(*) as count,
                   SUM(file_size) as size
              FROM downloads
             GROUP BY group_id
        `).all();

        const dialogsNames = await getDialogsNameCache();

        const results = rows.map(r => {
            const cfg = configGroups.find(g => String(g.id) === r.group_id);
            // Best-available: live Telegram dialogs name → config → DB → placeholder.
            const name = bestGroupName(
                r.group_id,
                cfg?.name,
                r.best_name || r.any_name,
                dialogsNames.get(String(r.group_id)),
            );
            const hasPhoto = existsSync(path.join(PHOTOS_DIR, `${r.group_id}.jpg`));

            return {
                id: r.group_id,
                name: name,
                totalFiles: r.count,
                sizeFormatted: formatBytes(r.size || 0),
                photoUrl: hasPhoto ? `/photos/${r.group_id}.jpg` : null,
                enabled: cfg ? cfg.enabled : false
            };
        }).filter(Boolean);

        res.json(results);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 5. Downloads Per Group (SQLite Pagination).
// Reject the literal "search" segment up-front — Express matches routes in
// declaration order, and there's a `GET /api/downloads/search` further down
// that the SPA calls for free-text search. Without this guard the search
// route would be shadowed and always return an empty group payload.
app.get('/api/downloads/:groupId', async (req, res, next) => {
    if (req.params.groupId === 'search') return next();
    try {
        const { groupId } = req.params;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const type = req.query.type || 'all';
        const offset = (page - 1) * limit;

        // Find group name from config or DB to build correct folder path
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        const configGroup = (config.groups || []).find(g => String(g.id) === String(groupId));
        const dbRow = getDb().prepare('SELECT group_name FROM downloads WHERE group_id = ? AND group_name IS NOT NULL LIMIT 1').get(String(groupId));
        const groupFolder = sanitizeName(configGroup?.name || dbRow?.group_name || 'unknown');

        const result = getDownloads(groupId, limit, offset, type);

        // DB `file_path` stores the path RELATIVE to data/downloads (set
        // by downloader.js via path.relative(DOWNLOADS_DIR, …)). USE that
        // as the source of truth — re-deriving from sanitize(group.name)
        // breaks every file that was downloaded under a different folder
        // name (e.g. "Unknown" before the group was named, or a renamed
        // group whose old folder still has the old files).
        const files = result.files.map(row => {
            // Map DB file_type to folder name (used only as a hint when
            // file_path is missing or invalid).
            const typeFolder = row.file_type === 'photo' ? 'images'
                : row.file_type === 'video' ? 'videos'
                : row.file_type === 'audio' ? 'audio'
                : row.file_type === 'sticker' ? 'stickers'
                : 'documents';

            // Prefer the stored relative path. Normalise Windows-style
            // backslashes into forward slashes for the URL.
            const stored = (row.file_path || '').replace(/\\/g, '/');
            const fullPath = stored && stored.includes('/')
                ? stored
                : `${groupFolder}/${typeFolder}/${row.file_name}`;
            
            return {
                name: row.file_name,
                path: row.file_path,
                fullPath,
                size: row.file_size,
                sizeFormatted: formatBytes(row.file_size),
                type: typeFolder,
                extension: path.extname(row.file_name),
                modified: row.created_at,
                // Rescue Mode surface — null when not in rescue mode.
                pendingUntil: row.pending_until || null,
                rescuedAt: row.rescued_at || null,
            };
        });

        res.json({
            files,
            total: result.total,
            page,
            totalPages: Math.ceil(result.total / limit)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Resolve a user-supplied path inside DOWNLOADS_DIR safely. Rejects NUL bytes,
// normalizes, and resolves symlinks so a symlink inside downloads/ can't be
// used to escape the root. Returns null if the request is unsafe or the file
// doesn't exist.
async function safeResolveDownload(userPath) {
    if (typeof userPath !== 'string' || userPath.length === 0) return { ok: false, reason: 'forbidden' };
    if (userPath.includes('\0')) return { ok: false, reason: 'forbidden' };
    const normalized = path.normalize(userPath);
    if (path.isAbsolute(normalized)) return { ok: false, reason: 'forbidden' };
    if (normalized.split(path.sep).includes('..')) return { ok: false, reason: 'forbidden' };
    const candidate = path.join(DOWNLOADS_DIR, normalized);
    const rootReal = await fs.realpath(DOWNLOADS_DIR).catch(() => path.resolve(DOWNLOADS_DIR));
    let real;
    try { real = await fs.realpath(candidate); }
    catch (e) {
        // ENOENT → genuinely missing (deleted / never written / DB drift).
        // Tell the caller so the route can return 404 instead of a
        // misleading 403 that makes users think it's a permission bug.
        return { ok: false, reason: e.code === 'ENOENT' ? 'missing' : 'forbidden' };
    }
    if (!real.startsWith(rootReal + path.sep) && real !== rootReal) {
        return { ok: false, reason: 'forbidden' };
    }
    return { ok: true, real };
}

// Search across all downloads (filename + group name).
app.get('/api/downloads/search', async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        if (!q) return res.json({ files: [], total: 0, page: 1, totalPages: 0 });
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
        const groupId = req.query.groupId ? String(req.query.groupId) : undefined;
        const r = searchDownloads(q, { limit, offset: (page - 1) * limit, groupId });

        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        const groupFolderById = new Map();
        for (const g of (config.groups || [])) groupFolderById.set(String(g.id), sanitizeName(g.name));

        const files = r.files.map(row => {
            const folder = groupFolderById.get(String(row.group_id)) || sanitizeName(row.group_name || 'unknown');
            const typeFolder = row.file_type === 'photo' ? 'images'
                : row.file_type === 'video' ? 'videos'
                : row.file_type === 'audio' ? 'audio'
                : row.file_type === 'sticker' ? 'stickers' : 'documents';
            // Use the stored relative path when present (matches the actual
            // on-disk location even if the group has since been renamed).
            const stored = (row.file_path || '').replace(/\\/g, '/');
            const fullPath = stored && stored.includes('/')
                ? stored
                : `${folder}/${typeFolder}/${row.file_name}`;
            return {
                id: row.id,
                groupId: row.group_id,
                groupName: row.group_name,
                name: row.file_name,
                fullPath,
                size: row.file_size,
                sizeFormatted: formatBytes(row.file_size),
                type: typeFolder,
                modified: row.created_at,
                pendingUntil: row.pending_until || null,
                rescuedAt: row.rescued_at || null,
            };
        });
        res.json({ files, total: r.total, page, totalPages: Math.ceil(r.total / limit), q });
    } catch (e) {
        console.error('GET /api/downloads/search:', e);
        res.status(500).json({ error: 'Internal error' });
    }
});

// Bulk delete by id list or fullPath list.
app.post('/api/downloads/bulk-delete', async (req, res) => {
    try {
        const { ids, paths } = req.body || {};
        const idList = Array.isArray(ids) ? ids.map(Number).filter(Number.isFinite) : [];
        const pathList = Array.isArray(paths) ? paths : [];
        if (!idList.length && !pathList.length) {
            return res.status(400).json({ error: 'ids or paths required' });
        }

        // Resolve every supplied path safely; ignore those that escape the root.
        let unlinked = 0;
        for (const p of pathList) {
            const r = await safeResolveDownload(p);
            if (r.ok) {
                try { await fs.unlink(r.real); unlinked++; } catch (e) { if (e.code !== 'ENOENT') throw e; }
            }
        }
        // For id-based deletion we still need to find the on-disk path. The DB
        // stores file_name only; resolve via the same group-folder mapping.
        if (idList.length) {
            const db = getDb();
            const rows = db.prepare(`SELECT id, group_id, group_name, file_name, file_type FROM downloads WHERE id IN (${idList.map(() => '?').join(',')})`).all(...idList);
            const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
            const folderById = new Map();
            for (const g of (config.groups || [])) folderById.set(String(g.id), sanitizeName(g.name));
            for (const row of rows) {
                const folder = folderById.get(String(row.group_id)) || sanitizeName(row.group_name || 'unknown');
                const typeFolder = row.file_type === 'photo' ? 'images'
                    : row.file_type === 'video' ? 'videos'
                    : row.file_type === 'audio' ? 'audio'
                    : row.file_type === 'sticker' ? 'stickers' : 'documents';
                const candidate = `${folder}/${typeFolder}/${row.file_name}`;
                const r = await safeResolveDownload(candidate);
                if (r.ok) {
                    try { await fs.unlink(r.real); unlinked++; } catch (e) { if (e.code !== 'ENOENT') throw e; }
                }
            }
        }
        const dbDeleted = deleteDownloadsBy({ ids: idList, filePaths: pathList });
        broadcast({ type: 'bulk_delete', unlinked, dbDeleted });
        res.json({ success: true, unlinked, dbDeleted });
    } catch (e) {
        console.error('POST /api/downloads/bulk-delete:', e);
        res.status(500).json({ error: 'Internal error' });
    }
});

// 6. Delete File (Physical + DB)
app.delete('/api/file', async (req, res) => {
    try {
        const filePath = req.query.path;
        if (!filePath) return res.status(400).json({ error: 'Path required' });

        const r = await safeResolveDownload(filePath);
        if (!r.ok) {
            const status = r.reason === 'missing' ? 404 : 403;
            return res.status(status).json({ error: r.reason === 'missing' ? 'File not found' : 'Access denied' });
        }

        await fs.unlink(r.real);
        console.log(`🗑️ Deleted: ${filePath}`);

        // Remove from DB (by basename — the DB stores filenames, not paths).
        const db = getDb();
        const fileName = path.basename(r.real);
        db.prepare('DELETE FROM downloads WHERE file_name = ?').run(fileName);

        broadcast({ type: 'file_deleted', path: filePath });
        res.json({ success: true });
    } catch (error) {
        if (error.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
        console.error('DELETE /api/file:', error);
        res.status(500).json({ error: 'Internal error' });
    }
});

// 6b. Purge Group (Files + DB + Config + Photo — No Trace)
app.delete('/api/groups/:id/purge', async (req, res) => {
    try {
        const groupId = req.params.id;
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        const configGroup = (config.groups || []).find(g => String(g.id) === String(groupId));
        const dbRow = getDb().prepare('SELECT group_name FROM downloads WHERE group_id = ? AND group_name IS NOT NULL LIMIT 1').get(String(groupId));
        const groupName = configGroup?.name || dbRow?.group_name || 'unknown';
        const folderName = sanitizeName(groupName);

        // 1. Delete files on disk
        const folderPath = path.join(DOWNLOADS_DIR, folderName);
        let filesDeleted = 0;
        if (existsSync(folderPath)) {
            // Count files before deleting
            const countFiles = (dir) => {
                let count = 0;
                const items = fsSync.readdirSync(dir, { withFileTypes: true });
                for (const item of items) {
                    if (item.isDirectory()) count += countFiles(path.join(dir, item.name));
                    else count++;
                }
                return count;
            };
            filesDeleted = countFiles(folderPath);
            await fs.rm(folderPath, { recursive: true, force: true });
        }

        // 2. Delete DB records
        const dbResult = deleteGroupDownloads(groupId);

        // 3. Remove from config
        config.groups = (config.groups || []).filter(g => String(g.id) !== String(groupId));
        await writeConfigAtomic(config);

        // 4. Delete profile photo
        const photoPath = path.join(PHOTOS_DIR, `${groupId}.jpg`);
        if (existsSync(photoPath)) await fs.unlink(photoPath);

        console.log(`🗑️ PURGED: ${groupName} — ${filesDeleted} files, ${dbResult.deletedDownloads} DB records`);
        broadcast({ type: 'group_purged', groupId });
        res.json({
            success: true,
            deleted: {
                files: filesDeleted,
                dbRecords: dbResult.deletedDownloads,
                queueRecords: dbResult.deletedQueue,
                group: groupName
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 6c. Purge ALL (Everything — Factory Reset)
app.delete('/api/purge/all', async (req, res) => {
    try {
        // 1. Delete all download folders
        let totalFiles = 0;
        if (existsSync(DOWNLOADS_DIR)) {
            const dirs = fsSync.readdirSync(DOWNLOADS_DIR, { withFileTypes: true });
            for (const dir of dirs) {
                if (dir.isDirectory()) {
                    const dirPath = path.join(DOWNLOADS_DIR, dir.name);
                    totalFiles += fsSync.readdirSync(dirPath, { recursive: true }).length;
                    await fs.rm(dirPath, { recursive: true, force: true });
                }
            }
        }

        // 2. Delete all DB records
        const dbResult = deleteAllDownloads();

        // 3. Clear groups from config
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        config.groups = [];
        await writeConfigAtomic(config);

        // 4. Delete all profile photos
        if (existsSync(PHOTOS_DIR)) {
            const photos = fsSync.readdirSync(PHOTOS_DIR);
            for (const photo of photos) {
                await fs.unlink(path.join(PHOTOS_DIR, photo));
            }
        }

        console.log(`🗑️ PURGE ALL: ${totalFiles} files, ${dbResult.deletedDownloads} DB records`);
        broadcast({ type: 'purge_all' });
        res.json({
            success: true,
            deleted: {
                files: totalFiles,
                dbRecords: dbResult.deletedDownloads,
                queueRecords: dbResult.deletedQueue
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ MAINTENANCE ENDPOINTS ===========================================
//
// Web parity for everything the CLI used to be the only path to do. Every
// destructive endpoint here:
//   - lives behind the global checkAuth middleware (so only logged-in users
//     hit it),
//   - requires `confirm: true` in the JSON body to prevent CSRF / fat-finger
//     accidents,
//   - logs what it did to stdout for the audit trail.
//
// Read endpoints (resync dialogs, log download, integrity check) don't need
// the confirm flag — they don't mutate user data.

const LOGS_DIR = path.join(DATA_DIR, 'logs');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

function _requireConfirm(req, res) {
    if (req.body?.confirm !== true) {
        res.status(400).json({ error: 'Pass {"confirm": true} in the request body to proceed.' });
        return false;
    }
    return true;
}

// Stronger guard for irreversible / sensitive ops (export Telegram session,
// sign-out-everywhere). Forces the user to retype their dashboard password
// in the request body — the cookie alone isn't enough because a session
// hijacker would already have it.
async function _requirePassword(req, res) {
    const supplied = req.body?.password;
    if (typeof supplied !== 'string' || !supplied) {
        res.status(400).json({ error: 'Password required' });
        return false;
    }
    try {
        const config = await readConfigSafe();
        if (!isAuthConfigured(config.web)) {
            res.status(403).json({ error: 'Auth not configured' });
            return false;
        }
        // SECURITY: loginVerify returns `{ok: boolean, upgrade?: boolean}`,
        // NOT a bare boolean. Treating the object as truthy (the previous
        // bug) made any non-empty string a valid "password" — turning
        // Export-Session into a full account-takeover surface for anyone
        // who already holds a session cookie.
        const result = loginVerify(supplied, config.web);
        if (!result?.ok) {
            res.status(403).json({ error: 'Invalid password' });
            return false;
        }
    } catch {
        res.status(500).json({ error: 'Internal error' });
        return false;
    }
    return true;
}

// Force re-resolve every group entity (name + photo) against Telegram. This is
// /api/groups/refresh-info under a friendlier name; the SPA already calls the
// underlying handler, this is the explicit "Resync now" button.
app.post('/api/maintenance/resync-dialogs', async (req, res) => {
    try {
        const am = await getAccountManager();
        if (am.count === 0) return res.status(409).json({ error: 'No Telegram accounts loaded' });
        // Drop the entity cache so re-resolution actually hits Telegram.
        try { entityCache.clear(); } catch {}
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        const ids = new Set((config.groups || []).map(g => String(g.id)));
        try {
            const rows = getDb().prepare('SELECT DISTINCT group_id FROM downloads').all();
            for (const r of rows) ids.add(String(r.group_id));
        } catch {}

        let updated = 0;
        let mutated = false;
        for (const id of ids) {
            const resolved = await resolveEntityAcrossAccounts(id);
            if (!resolved) continue;
            const e = resolved.entity;
            const realName = e?.title
                || (e?.firstName && (e.firstName + (e.lastName ? ' ' + e.lastName : '')))
                || e?.username || null;
            if (realName) {
                const cg = (config.groups || []).find(g => String(g.id) === id);
                if (cg && (!cg.name || cg.name === 'Unknown' || cg.name === id || cg.name.startsWith('Group '))) {
                    cg.name = realName;
                    mutated = true;
                }
                try {
                    getDb().prepare(`UPDATE downloads SET group_name = ? WHERE group_id = ? AND (group_name IS NULL OR group_name = '' OR group_name = 'Unknown' OR group_name = ?)`).run(realName, id, id);
                } catch {}
                updated++;
            }
            await downloadProfilePhoto(id).catch(() => {});
        }
        if (mutated) await writeConfigAtomic(config);
        // Invalidate the dialogs cache so the next /api/dialogs and the next
        // /api/groups pick up the freshly-resolved names without waiting for
        // the 5-min TTL.
        _dialogsResponseCache = { at: 0, body: null };
        _dialogsNameCache = { at: 0, byId: new Map() };
        broadcast({ type: 'config_updated' });
        res.json({ success: true, scanned: ids.size, updated });
    } catch (e) {
        const { status, body } = tgAuthErrorBody(e);
        res.status(status === 400 ? 500 : status).json(body.error ? body : { error: e.message });
    }
});

// Restart the realtime monitor: stop → start. Useful after settings changes
// (proxy, accounts, rate limits) without needing to bounce the container.
app.post('/api/maintenance/restart-monitor', async (req, res) => {
    if (!_requireConfirm(req, res)) return;
    try {
        const wasRunning = runtime.state === 'running';
        if (runtime.state !== 'stopped') {
            try { await runtime.stop(); } catch (e) { console.warn('restart-monitor stop:', e.message); }
        }
        if (!wasRunning) {
            return res.json({ success: true, restarted: false, note: 'Monitor was not running; nothing to restart.' });
        }
        const am = await getAccountManager();
        if (am.count === 0) {
            return res.status(409).json({ error: 'No Telegram accounts loaded' });
        }
        await runtime.start({ config: loadConfig(), accountManager: am });
        res.json({ success: true, restarted: true, status: runtime.status() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// SQLite integrity check (PRAGMA integrity_check). Returns "ok" on a clean DB
// or a list of corruption messages. Read-only.
app.post('/api/maintenance/db/integrity', async (req, res) => {
    try {
        const db = getDb();
        const rows = db.prepare('PRAGMA integrity_check').all();
        const messages = rows.map(r => r.integrity_check).filter(Boolean);
        const ok = messages.length === 1 && messages[0] === 'ok';
        res.json({ success: true, ok, messages });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Walk every download row, drop the ones whose file is missing or
// 0 bytes. Same logic as the periodic boot-time sweep, surfaced as a
// button so users can force-clean stale entries on demand.
app.post('/api/maintenance/files/verify', async (req, res) => {
    try {
        const result = await integrity.sweep();
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// VACUUM the SQLite database. Reclaims space after lots of deletions.
// Locks the DB briefly — guard with confirm so the user can't trigger it by
// accident in the middle of a heavy backfill.
app.post('/api/maintenance/db/vacuum', async (req, res) => {
    if (!_requireConfirm(req, res)) return;
    try {
        const db = getDb();
        const beforePages = db.pragma('page_count', { simple: true });
        const pageSize = db.pragma('page_size', { simple: true });
        db.exec('VACUUM');
        const afterPages = db.pragma('page_count', { simple: true });
        res.json({
            success: true,
            beforeBytes: Number(beforePages) * Number(pageSize),
            afterBytes: Number(afterPages) * Number(pageSize),
            reclaimedBytes: Math.max(0, (Number(beforePages) - Number(afterPages)) * Number(pageSize)),
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// List logfiles under data/logs/ with size + mtime — used by the SPA to
// populate the "Download log" picker.
app.get('/api/maintenance/logs', async (req, res) => {
    try {
        if (!existsSync(LOGS_DIR)) return res.json({ files: [] });
        const names = fsSync.readdirSync(LOGS_DIR).filter(f => f.endsWith('.log'));
        const files = names.map(name => {
            try {
                const st = fsSync.statSync(path.join(LOGS_DIR, name));
                return { name, size: st.size, modified: st.mtime.toISOString() };
            } catch { return null; }
        }).filter(Boolean);
        files.sort((a, b) => b.modified.localeCompare(a.modified));
        res.json({ files });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Stream the tail of a logfile as plain text. `name` is restricted to a single
// path segment so a malicious caller can't traverse out of LOGS_DIR.
app.get('/api/maintenance/logs/download', async (req, res) => {
    try {
        const name = String(req.query.name || '');
        if (!name || name.includes('/') || name.includes('\\') || name.includes('\0') || !name.endsWith('.log')) {
            return res.status(400).json({ error: 'Invalid log name' });
        }
        const lines = Math.max(10, Math.min(100000, parseInt(req.query.lines, 10) || 5000));
        const filePath = path.join(LOGS_DIR, name);
        if (!existsSync(filePath)) return res.status(404).json({ error: 'Log not found' });

        // Naive tail — read whole file (logs are bounded), keep last N lines.
        // Acceptable up to a few hundred MB; if logs ever grow bigger we'd
        // switch to a stream-with-ring-buffer reader.
        const raw = await fs.readFile(filePath, 'utf8');
        const all = raw.split(/\r?\n/);
        const tail = all.slice(Math.max(0, all.length - lines)).join('\n');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
        res.send(tail);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Export a Telegram account session as a portable string. The session is
// AES-256 encrypted on disk under data/sessions/<id>.enc; this endpoint
// decrypts it with the local SecureSession key and returns the raw gramJS
// string (which itself is the long-form telegram session payload). The user
// can paste this into another instance to migrate without re-doing the OTP
// flow. We never log the value.
app.post('/api/maintenance/session/export', async (req, res) => {
    if (!_requireConfirm(req, res)) return;
    if (!(await _requirePassword(req, res))) return;
    try {
        const { accountId } = req.body || {};
        if (typeof accountId !== 'string' || !accountId) {
            return res.status(400).json({ error: 'accountId required' });
        }
        // Path-segment guard — accountId becomes a filename.
        if (accountId.includes('/') || accountId.includes('\\') || accountId.includes('..') || accountId.includes('\0')) {
            return res.status(400).json({ error: 'Invalid accountId' });
        }
        const sessionFile = path.join(SESSIONS_DIR, `${accountId}.enc`);
        if (!existsSync(sessionFile)) {
            return res.status(404).json({ error: 'Session file not found for that account' });
        }
        const raw = await fs.readFile(sessionFile, 'utf8');
        const encrypted = JSON.parse(raw);
        const sessionString = _secureSession.decrypt(encrypted);
        res.json({ success: true, accountId, session: sessionString });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Revoke every dashboard session token. Forces every browser (including the
// caller) back to the login page. Useful after a suspected compromise or after
// rotating the password from another device.
app.post('/api/maintenance/sessions/revoke-all', async (req, res) => {
    if (!_requireConfirm(req, res)) return;
    if (!(await _requirePassword(req, res))) return;
    try {
        revokeAllSessions();
        res.clearCookie('tg_dl_session', SESSION_COOKIE_OPTS);
        broadcast({ type: 'sessions_revoked' });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Surface the raw config.json (with secrets redacted) so power users can
// review what's on disk without SSHing into the container. Sensitive fields
// are stripped — see /api/config for the existing redaction policy.
app.get('/api/maintenance/config/raw', async (req, res) => {
    try {
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        if (config.telegram?.apiHash) config.telegram.apiHash = '••••••• (redacted)';
        if (config.web?.passwordHash) config.web.passwordHash = '••••••• (redacted)';
        if (config.web?.password) config.web.password = '••••••• (redacted)';
        if (config.proxy?.password) config.proxy.password = '••••••• (redacted)';
        if (Array.isArray(config.accounts)) {
            // Phone numbers are stored alongside the metadata; keep but show
            // the user what they're about to download.
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.send(JSON.stringify(config, null, 2));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/config', async (req, res) => {
    try {
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        const safe = JSON.parse(JSON.stringify(config));
        // The Telegram apiId is essentially public (it identifies the
        // application registration, not a user) so we surface it to the SPA
        // for editing. apiHash IS sensitive — replace with a presence flag.
        if (safe.telegram) {
            const hashSet = !!safe.telegram.apiHash;
            delete safe.telegram.apiHash;
            safe.telegram.apiHashSet = hashSet;
        }
        if (safe.web) {
            delete safe.web.password;
            delete safe.web.passwordHash;
        }
        if (Array.isArray(safe.accounts)) {
            safe.accounts = safe.accounts.map(a => ({
                id: a.id, name: a.name, username: a.username,
            }));
        }
        // Per-group account assignments are an internal mapping; surface only
        // a boolean so the SPA can show "(custom account)".
        if (Array.isArray(safe.groups)) {
            safe.groups = safe.groups.map(g => {
                const out = { ...g };
                if (out.monitorAccount) { out.hasMonitorAccount = true; delete out.monitorAccount; }
                if (out.forwardAccount) { out.hasForwardAccount = true; delete out.forwardAccount; }
                return out;
            });
        }
        res.json(safe);
    } catch (error) {
        console.error('GET /api/config:', error);
        res.status(500).json({ error: 'Internal error' });
    }
});

// Rescue Mode stats — counters for the SPA's Rescue panel.
app.get('/api/rescue/stats', async (req, res) => {
    try {
        res.json(getRescueStats());
    } catch (e) {
        console.error('GET /api/rescue/stats:', e);
        res.status(500).json({ error: 'Internal error' });
    }
});

// 7b. Config Update
app.post('/api/config', async (req, res) => {
    try {
        // Reject anything that smells like an attempt to inject auth state
        // through the config endpoint. Web auth lives in dedicated routes.
        if (req.body?.web?.password || req.body?.web?.passwordHash) {
            return res.status(400).json({
                error: 'Use /api/auth/setup or /api/auth/change-password to manage dashboard auth.',
            });
        }

        const currentConfig = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        const newConfig = { ...currentConfig, ...req.body };

        // Deep-merge sub-sections so a partial PATCH (e.g., only telegram.apiId)
        // doesn't blow away the rest of that section (e.g., telegram.apiHash).
        if (req.body.telegram) newConfig.telegram = { ...currentConfig.telegram, ...req.body.telegram };
        if (req.body.download) newConfig.download = { ...currentConfig.download, ...req.body.download };
        if (req.body.rateLimits) newConfig.rateLimits = { ...currentConfig.rateLimits, ...req.body.rateLimits };
        if (req.body.diskManagement) newConfig.diskManagement = { ...currentConfig.diskManagement, ...req.body.diskManagement };
        if (req.body.rescue) newConfig.rescue = { ...(currentConfig.rescue || {}), ...req.body.rescue };
        if (req.body.proxy === null) newConfig.proxy = null; // explicit clear
        else if (req.body.proxy && typeof req.body.proxy === 'object') {
            // Deep-merge so the SPA can omit unchanged fields (e.g., the
            // password) without wiping them. Pass an explicit `null` for a
            // field to remove it.
            const merged = { ...(currentConfig.proxy || {}), ...req.body.proxy };
            for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
            newConfig.proxy = merged;
        }
        if (req.body.web) {
            // Allow toggling enabled flag, but never let the route alter
            // password/passwordHash regardless of source.
            const safeWeb = { ...currentConfig.web, ...req.body.web };
            delete safeWeb.password;
            if (!currentConfig.web?.passwordHash) delete safeWeb.passwordHash;
            else safeWeb.passwordHash = currentConfig.web.passwordHash;
            newConfig.web = safeWeb;
        }

        // Advanced runtime tuning — two-level deep-merge so a PATCH that
        // touches one sub-namespace (e.g. only advanced.downloader) keeps the
        // others intact. Per-field clamping below; out-of-range values are
        // silently dropped to the original constants instead of 400-ing the
        // whole save (the SPA shouldn't fail to save the rest of the form
        // because someone typed `0` into a number field).
        if (req.body.advanced && typeof req.body.advanced === 'object') {
            const cur = currentConfig.advanced || {};
            const inc = req.body.advanced || {};
            const clampInt = (v, lo, hi, def) => {
                const n = parseInt(v, 10);
                if (!Number.isFinite(n)) return def;
                return Math.max(lo, Math.min(hi, n));
            };
            const merged = {
                downloader: {
                    ...(cur.downloader || {}),
                    ...(inc.downloader || {}),
                },
                history: {
                    ...(cur.history || {}),
                    ...(inc.history || {}),
                },
                diskRotator: {
                    ...(cur.diskRotator || {}),
                    ...(inc.diskRotator || {}),
                },
                integrity: {
                    ...(cur.integrity || {}),
                    ...(inc.integrity || {}),
                },
                web: {
                    ...(cur.web || {}),
                    ...(inc.web || {}),
                },
            };
            // Clamp every numeric so a typo can't ban the user from logging
            // in (sessionTtlDays=0) or hose the downloader (minConcurrency=0).
            const d = merged.downloader;
            d.minConcurrency      = clampInt(d.minConcurrency,       1,    100, 3);
            d.maxConcurrency      = clampInt(d.maxConcurrency,       1,    100, 20);
            if (d.maxConcurrency < d.minConcurrency) d.maxConcurrency = d.minConcurrency;
            d.scalerIntervalSec   = clampInt(d.scalerIntervalSec,    1,    600, 5);
            d.idleSleepMs         = clampInt(d.idleSleepMs,         50,  10000, 200);
            d.spilloverThreshold  = clampInt(d.spilloverThreshold, 100, 100000, 2000);

            const h = merged.history;
            h.backpressureCap         = clampInt(h.backpressureCap,         10, 100000, 500);
            h.backpressureMaxWaitMs   = clampInt(h.backpressureMaxWaitMs, 5000, 3600000, 300000);
            h.shortBreakEveryN        = clampInt(h.shortBreakEveryN,         0, 100000, 100);
            h.longBreakEveryN         = clampInt(h.longBreakEveryN,          0, 1000000, 1000);

            const r = merged.diskRotator;
            r.sweepBatch         = clampInt(r.sweepBatch,         1,   1000, 50);
            r.maxDeletesPerSweep = clampInt(r.maxDeletesPerSweep, 1, 100000, 5000);

            const it = merged.integrity;
            it.intervalMin = clampInt(it.intervalMin, 1, 10080, 60);
            it.batchSize   = clampInt(it.batchSize,   1,  1024, 64);

            const w = merged.web;
            w.sessionTtlDays = clampInt(w.sessionTtlDays, 1, 365, 7);

            newConfig.advanced = merged;
        }

        // Range / type sanity for the most-abused fields
        const dl = newConfig.download || {};
        if (dl.concurrent != null && (dl.concurrent < 1 || dl.concurrent > 50)) {
            return res.status(400).json({ error: 'download.concurrent must be 1-50' });
        }
        if (dl.retries != null && (dl.retries < 0 || dl.retries > 50)) {
            return res.status(400).json({ error: 'download.retries must be 0-50' });
        }
        if (newConfig.pollingInterval != null && newConfig.pollingInterval < 1) {
            return res.status(400).json({ error: 'pollingInterval must be >= 1 (seconds)' });
        }

        // Atomic write — write to a temp file then rename so a crash mid-write
        // can't leave config.json half-flushed.
        const tmpPath = CONFIG_PATH + '.tmp';
        await fs.writeFile(tmpPath, JSON.stringify(newConfig, null, 4));
        await fs.rename(tmpPath, CONFIG_PATH);
        invalidateConfigCache();

        // Reset the lazy AccountManager singleton if Telegram credentials
        // changed — a stale instance would still be wired to the old apiId.
        if (req.body.telegram && _accountManager) {
            try { await _accountManager.disconnectAll(); } catch {}
            _accountManager = null;
        }

        // Refresh the cached rate-limit config so the toggle / RPM change
        // takes effect immediately instead of waiting for the 30s sweep.
        if (req.body.web?.rateLimit) refreshRateLimitConfig();

        // Restart the disk rotator if the user changed any diskManagement
        // field — picks up the new cap / enabled / interval on the very next
        // sweep instead of waiting for whatever was already scheduled.
        if (req.body.diskManagement || req.body.advanced?.diskRotator) {
            try { getDiskRotator()?.restart(); } catch (e) { console.warn('[disk-rotator] restart failed:', e.message); }
        }
        // Same story for the rescue sweeper — sweep cadence (and the global
        // enabled flag, since per-group 'auto' follows it) needs to take
        // effect immediately, not on the next scheduled tick.
        if (req.body.rescue) {
            try { getRescueSweeper()?.restart(); } catch (e) { console.warn('[rescue] restart failed:', e.message); }
        }
        // Re-arm the integrity sweeper when its cadence/batch changes so the
        // user doesn't have to wait a full hour for the new interval to kick
        // in. Reads the merged config (newConfig) for the latest values.
        if (req.body.advanced?.integrity) {
            try {
                const ai = newConfig?.advanced?.integrity || {};
                integrity.start({
                    broadcast,
                    intervalMin: Number(ai.intervalMin) > 0 ? Number(ai.intervalMin) : 60,
                    batchSize:   Number(ai.batchSize)   > 0 ? Number(ai.batchSize)   : 64,
                });
            } catch (e) { console.warn('[integrity] restart failed:', e.message); }
        }

        broadcast({ type: 'config_updated' });
        res.json({ success: true });
    } catch (error) {
        console.error('POST /api/config:', error);
        res.status(500).json({ error: 'Internal error' });
    }
});

// 8. Group Update
app.put('/api/groups/:id', async (req, res) => {
    try {
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        const groupId = req.params.id;
        let groupIndex = config.groups.findIndex(g => String(g.id) === groupId);
        
        if (groupIndex === -1) {
            // Create new — resolve a real name from any loaded account.
            let groupName = req.body.name;
            if (!groupName || groupName === 'Unknown' || groupName === groupId || groupName.startsWith('Group ')) {
                const r = await resolveEntityAcrossAccounts(groupId);
                if (r?.entity) {
                    const e = r.entity;
                    groupName = e.title
                        || (e.firstName && (e.firstName + (e.lastName ? ' ' + e.lastName : '')))
                        || e.username
                        || groupName;
                }
            }
            const newGroup = {
                id: groupId.startsWith('-') ? parseInt(groupId) : groupId,
                name: groupName || `Unknown`,
                enabled: req.body.enabled ?? false,
                filters: { photos: true, videos: true, files: true, links: true, voice: false, gifs: false, stickers: false },
                autoForward: { enabled: false, destination: null, deleteAfterForward: false },
                trackUsers: { enabled: false, users: [] },
                topics: { enabled: false, ids: [] }
            };
            config.groups.push(newGroup);
            groupIndex = config.groups.length - 1;
        }
        
        // Update fields
        const group = config.groups[groupIndex];
        if (req.body.enabled !== undefined) group.enabled = req.body.enabled;
        if (req.body.name) group.name = req.body.name;
        if (req.body.filters) {
            group.filters = { ...group.filters, ...req.body.filters };
        }
        if (req.body.autoForward) {
            group.autoForward = { ...group.autoForward, ...req.body.autoForward };
        }
        if (req.body.topics !== undefined) {
            // Allow {enabled, ids:[]} or null to clear.
            if (req.body.topics === null) delete group.topics;
            else group.topics = {
                enabled: !!req.body.topics.enabled,
                ids: Array.isArray(req.body.topics.ids) ? req.body.topics.ids.map(Number).filter(Number.isFinite) : [],
            };
        }

        // Multi-Account assignments
        if (req.body.monitorAccount !== undefined) {
            if (!req.body.monitorAccount) delete group.monitorAccount;
            else group.monitorAccount = req.body.monitorAccount;
        }
        if (req.body.forwardAccount !== undefined) {
            if (!req.body.forwardAccount) delete group.forwardAccount;
            else group.forwardAccount = req.body.forwardAccount;
        }

        // Rescue Mode (per-group). 'auto' = follow global cfg.rescue.enabled,
        // 'on' / 'off' override. Empty / null falls back to default ('auto').
        if (req.body.rescueMode !== undefined) {
            const v = req.body.rescueMode;
            if (v === 'on' || v === 'off' || v === 'auto') group.rescueMode = v;
            else delete group.rescueMode;
        }
        if (req.body.rescueRetentionHours !== undefined) {
            const n = parseInt(req.body.rescueRetentionHours, 10);
            if (Number.isFinite(n) && n > 0) {
                group.rescueRetentionHours = Math.max(1, Math.min(720, n));
            } else {
                delete group.rescueRetentionHours;
            }
        }
        
        await writeConfigAtomic(config);
        broadcast({ type: 'config_updated', config });
        res.json({ success: true, group: config.groups[groupIndex] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 9. Profile Photos
app.get('/api/groups/:id/photo', async (req, res) => {
    const id = req.params.id;
    const photoPath = path.join(PHOTOS_DIR, `${id}.jpg`);
    
    if (existsSync(photoPath)) return res.sendFile(photoPath);
    
    // Try download if not exists
    const url = await downloadProfilePhoto(id);
    if (url && existsSync(photoPath)) return res.sendFile(photoPath);
    
    res.status(404).send('Not found');
});

// Walks every group (config-defined and DB-only) and tries to resolve a
// human-readable name + cached profile photo. Used by the SPA when it
// detects a row whose name is "Unknown" or just the numeric id.
app.post('/api/groups/refresh-info', async (req, res) => {
    try {
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        const ids = new Set((config.groups || []).map(g => String(g.id)));
        // Add IDs that exist in DB but not in config (e.g. paste-link only).
        try {
            const rows = getDb().prepare('SELECT DISTINCT group_id, group_name FROM downloads').all();
            for (const r of rows) ids.add(String(r.group_id));
        } catch {}

        let updated = 0;
        let mutatedConfig = false;
        // Per-id name pairs broadcast to every connected SPA so each tab
        // can merge them into its canonical `state.groupNameCache` without
        // a full /api/groups round-trip. Also returned in the HTTP body
        // so the caller can update its own state immediately.
        const updates = [];
        for (const id of ids) {
            const resolved = await resolveEntityAcrossAccounts(id);
            if (!resolved) continue;
            const { entity } = resolved;
            const realName = entity?.title
                || (entity?.firstName && (entity.firstName + (entity.lastName ? ' ' + entity.lastName : '')))
                || entity?.username || null;
            if (realName) {
                // Update config entry name (if exists).
                const cg = (config.groups || []).find(g => String(g.id) === id);
                if (cg && (!cg.name || cg.name === 'Unknown' || cg.name === id || cg.name.startsWith('Group '))) {
                    cg.name = realName;
                    mutatedConfig = true;
                }
                // Update DB rows that still have the placeholder.
                try {
                    const stmt = getDb().prepare(`UPDATE downloads SET group_name = ? WHERE group_id = ? AND (group_name IS NULL OR group_name = '' OR group_name = 'Unknown' OR group_name = ?)`);
                    stmt.run(realName, id, id);
                } catch {}
                updates.push({ id, name: realName });
                updated++;
            }
            // Photo (best-effort)
            await downloadProfilePhoto(id).catch(() => {});
        }
        if (mutatedConfig) await writeConfigAtomic(config);
        if (updates.length) {
            try { broadcast({ type: 'groups_refreshed', updates }); } catch {}
        }
        res.json({ success: true, updated, scanned: ids.size, updates });
    } catch (e) {
        console.error('refresh-info:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/groups/refresh-photos', async (req, res) => {
   try {
       const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
       const results = [];
       for (const group of config.groups || []) {
           const url = await downloadProfilePhoto(group.id);
           results.push({ id: group.id, url });
       }
       res.json({ success: true, results });
   } catch (e) {
       res.status(500).json({ error: e.message });
   }
});

// ============ FILE SERVING (Performance) ============
const directoryCache = new Map(); // Normalized -> Real Name

// Serve files from data/downloads. Uses safeResolveDownload to reject path
// traversal, NUL bytes, and symlink escapes. Adds Content-Disposition so a
// rogue HTML file can't be rendered inline (the browser still inlines images
// and videos via the explicit ?inline=1 query parameter the SPA passes).
app.use('/files', async (req, res, next) => {
    try {
        let reqPath;
        try { reqPath = decodeURIComponent(req.path).replace(/^\//, ''); }
        catch { return res.status(400).send('Bad request'); }
        if (!reqPath) return next();
        if (reqPath.includes('\0')) return res.status(400).send('Bad request');

        const r = await safeResolveDownload(reqPath);
        if (!r.ok) {
            // Distinguish "genuinely missing" from "blocked for safety" so
            // users see "File not found" instead of a misleading "Forbidden"
            // when a file was rotated/deleted but the DB row lingered.
            const status = r.reason === 'missing' ? 404 : 403;
            // Auto-prune the DB row for genuinely-missing files so the
            // gallery stops listing them on next refresh. STRICT match on
            // file_path only — matching by file_name was unsafe because
            // two groups can hold files with the same timestamp-based
            // basename, and a 404 on one would mass-delete the other's
            // rows. Done in the background so the HTTP response isn't
            // blocked by the DB write.
            if (r.reason === 'missing') {
                queueMicrotask(() => {
                    try {
                        const fwd = reqPath.replace(/\\/g, '/');
                        const bwd = fwd.replace(/\//g, '\\');
                        const db = getDb();
                        const result = db.prepare(
                            `DELETE FROM downloads WHERE file_path = ? OR file_path = ?`
                        ).run(fwd, bwd);
                        if (result.changes > 0) {
                            broadcast({ type: 'file_deleted', path: fwd, autoPruned: true });
                        }
                    } catch { /* never let a stray request crash the server */ }
                });
            }
            return res.status(status).send(r.reason === 'missing' ? 'File not found' : 'Forbidden');
        }

        const inline = req.query.inline === '1';
        const baseName = path.basename(r.real);
        // Quote-safe filename (RFC 6266 fallback handled by encodeURIComponent).
        const dispKind = inline ? 'inline' : 'attachment';
        res.setHeader(
            'Content-Disposition',
            `${dispKind}; filename*=UTF-8''${encodeURIComponent(baseName)}`
        );
        res.sendFile(r.real);
    } catch (e) {
        next();
    }
});


// ============ TELEGRAM CONNECTION ============

const _secureSession = new SecureSession(SESSION_PASSWORD);
async function loadSession() {
    try {
        if (existsSync(SESSION_PATH)) {
            const encryptedStr = await fs.readFile(SESSION_PATH, 'utf8');
            const encrypted = JSON.parse(encryptedStr);
            return _secureSession.decrypt(encrypted);
        }
    } catch (e) {
        console.log('Could not load session:', e.message);
    }
    return '';
}

async function connectTelegram() {
    if (telegramClient && isConnected) return telegramClient;
    // Quiet, configuration-aware: no creds → no work, no scary warning.
    let config;
    try { config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8')); }
    catch (e) {
        if (e.code !== 'ENOENT') console.log('⚠️ Could not read config.json:', e.message);
        return null;
    }
    if (!config.telegram?.apiId || !config.telegram?.apiHash) return null;

    try {
        const sessionString = await loadSession();
        if (!sessionString) return null;
        const stringSession = new StringSession(sessionString);
        telegramClient = new TelegramClient(stringSession, parseInt(config.telegram.apiId), config.telegram.apiHash, { connectionRetries: 3, useWSS: false });
        telegramClient.setLogLevel('none');
        await telegramClient.connect();
        if (await telegramClient.isUserAuthorized()) {
            isConnected = true;
            console.log('✅ Telegram connected (legacy single-session client; AccountManager is the canonical source)');
            return telegramClient;
        }
    } catch (error) {
        console.log('⚠️ Telegram connect attempt failed:', error.message);
    }
    return null;
}

// Entity & Photo Helpers
const entityCache = new Map();

/** Walk every loaded account looking for one that can resolve `idStr`. */
async function resolveEntityAcrossAccounts(idStr) {
    if (entityCache.has(idStr)) return entityCache.get(idStr);

    let am;
    try { am = await getAccountManager(); } catch { am = null; }
    const candidates = [];
    if (am) for (const [, c] of am.clients) candidates.push(c);
    // Legacy single-session client as last resort.
    const legacy = await connectTelegram();
    if (legacy && !candidates.includes(legacy)) candidates.push(legacy);

    for (const c of candidates) {
        try {
            const e = await c.getEntity(idStr);
            if (e) { entityCache.set(idStr, e); return { entity: e, client: c }; }
        } catch {}
        try {
            const e = await c.getEntity(BigInt(idStr));
            if (e) { entityCache.set(idStr, e); return { entity: e, client: c }; }
        } catch {}
    }
    return null;
}

async function downloadProfilePhoto(groupId) {
    const idStr = String(groupId);
    const photoPath = path.join(PHOTOS_DIR, `${idStr}.jpg`);
    if (existsSync(photoPath)) return `/photos/${idStr}.jpg`;

    const resolved = await resolveEntityAcrossAccounts(idStr);
    if (!resolved) return null;
    const { entity, client } = resolved;
    try {
        if (entity?.photo) {
            const buffer = await client.downloadProfilePhoto(entity, { isBig: false });
            if (buffer) {
                await fs.writeFile(photoPath, buffer);
                return `/photos/${idStr}.jpg`;
            }
        }
    } catch (e) {
        console.log(`Error processing ${idStr}:`, e.message);
    }
    return null;
}

// ============ SERVER START ============

function normalizeName(name) {
    if (!name) return '';
    return name.replace(/[_|]+/g, ' ').replace(/\s+/g, ' ').replace(/[\/\\:*?"<>]/g, '').trim().toLowerCase();
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function broadcast(data) {
    const message = JSON.stringify(data);
    clients.forEach(client => {
        if (client.readyState === 1) client.send(message);
    });
}

wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    // Backfill group names for existing records
    try {
        const config = JSON.parse(fsSync.readFileSync(CONFIG_PATH, 'utf8'));
        const updated = backfillGroupNames(config.groups || []);
        if (updated > 0) console.log(`📝 Backfilled group names for ${updated} records`);
    } catch (e) { /* config not ready yet */ }

    // Friendly boot banner. Tells the user where to go and what state we're
    // in (configured vs first-run) instead of dumping a generic header.
    let cfgState = 'first-run';
    try {
        const cfg = JSON.parse(fsSync.readFileSync(CONFIG_PATH, 'utf8'));
        if (isAuthConfigured(cfg.web)) cfgState = 'ready';
        else if (cfg.telegram?.apiId) cfgState = 'needs-password';
    } catch { /* no config → first-run */ }

    let appVersion = process.env.npm_package_version;
    if (!appVersion) {
        try {
            appVersion = JSON.parse(fsSync.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')).version;
        } catch { appVersion = '?'; }
    }
    const url = `http://localhost:${PORT}`;
    const tip = cfgState === 'first-run'
        ? `   First run? Open ${url} from this machine to set up the dashboard password.`
        : cfgState === 'needs-password'
            ? `   Open ${url} and run \`npm run auth\` to set the dashboard password.`
            : `   Sign in at ${url}`;
    console.log(`
🌐  Telegram Downloader   v${appVersion}
    Dashboard: ${url}
${tip}
`);
    // Try to bring up the legacy client in the background — if there are no
    // credentials yet, this is a silent no-op (see connectTelegram). The
    // AccountManager-driven path covers everything else lazily.
    connectTelegram().catch(() => {});

    // Boot the disk rotator. No-op when diskManagement.enabled is false —
    // safe to call at every startup. Restarts via POST /api/config (above).
    try {
        const rotator = getDiskRotator({ loadConfig, broadcast });
        rotator.start();
    } catch (e) {
        console.warn('[disk-rotator] start failed:', e.message);
    }

    // Periodic integrity sweep — walks every DB row, drops the ones whose
    // file is missing or zero-bytes. Self-heals after a manual delete, an
    // auto-rotator pass, a crash mid-write, or a partial volume restore.
    // 30 s after boot for the first pass, then every advanced.integrity.intervalMin
    // minutes (default 60) with stat() concurrency advanced.integrity.batchSize
    // (default 64).
    try {
        const cfg = loadConfig();
        const ai = cfg?.advanced?.integrity || {};
        integrity.start({
            broadcast,
            intervalMin: Number(ai.intervalMin) > 0 ? Number(ai.intervalMin) : 60,
            batchSize:   Number(ai.batchSize)   > 0 ? Number(ai.batchSize)   : 64,
        });
    } catch (e) {
        console.warn('[integrity] start failed:', e.message);
    }

    // Boot the rescue sweeper. Always armed — even when cfg.rescue.enabled
    // is false, individual groups can opt in via rescueMode='on'. Refreshed
    // on POST /api/config when the body carries a `rescue` block (above).
    try {
        const sweeper = getRescueSweeper({ loadConfig, broadcast });
        sweeper.start();
    } catch (e) {
        console.warn('[rescue] start failed:', e.message);
    }

    // Resolve group names from Telegram for any DB records still unnamed
    await resolveGroupNamesFromTelegram();

    // Auto-start the realtime monitor on container boot when at least one
    // group is enabled and at least one Telegram account is loaded. Lets
    // `docker compose up -d` boot a ready-to-monitor instance without a
    // manual click on Settings → Engine → Start. Opt out via
    // `monitor.autoStart: false` in config.json.
    try {
        const cfg = loadConfig();
        const autoStart = cfg.monitor?.autoStart !== false;
        const enabled = Array.isArray(cfg.groups) && cfg.groups.some(g => g?.enabled !== false);
        if (autoStart && enabled) {
            const am = await getAccountManager().catch(() => null);
            if (am && am.count > 0) {
                await runtime.start({ config: cfg, accountManager: am });
                console.log('[monitor] auto-started on boot');
            }
        }
    } catch (e) {
        console.warn('[monitor] auto-start skipped:', e.message);
    }
});

/**
 * Resolve group names from Telegram API for DB records with NULL or default group_name.
 * Strategy: 1) fetch dialogs and match by normalized ID, 2) fallback to getEntity for unmatched.
 * Also fixes config.json entries with generic names.
 */
async function resolveGroupNamesFromTelegram() {
    if (!telegramClient || !isConnected) return;
    try {
        // Collect all IDs that need fixing (from config)
        let config;
        try {
            config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        } catch {
            config = { groups: [] };
        }
        const configUnknowns = (config.groups || []).filter(g => !g.name || g.name.startsWith('Group '));

        // Also check DB
        const db = getDb();
        const dbUnknowns = db.prepare(`SELECT DISTINCT group_id FROM downloads WHERE group_name IS NULL OR group_name LIKE 'Group %'`).all();

        if (dbUnknowns.length === 0 && configUnknowns.length === 0) return;

        // Collect all unique IDs that need resolution
        const needIds = new Set();
        configUnknowns.forEach(g => needIds.add(String(g.id)));
        dbUnknowns.forEach(r => needIds.add(r.group_id));

        console.log(`🔍 Resolving names for ${needIds.size} groups: ${[...needIds].join(', ')}`);

        // Strategy 1: Fetch dialogs and build lookup
        const resolvedNames = new Map(); // raw ID string -> resolved name
        try {
            const dialogs = await telegramClient.getDialogs({ limit: 500 });
            const normalize = (id) => String(id).replace(/^-100/, '').replace(/^-/, '');
            
            for (const rawId of needIds) {
                const nid = normalize(rawId);
                for (const d of dialogs) {
                    const dnid = normalize(d.id);
                    if (dnid === nid) {
                        const title = d.title || d.name;
                        if (title) {
                            resolvedNames.set(rawId, title);
                            console.log(`  📌 Dialog match: ${rawId} → "${title}"`);
                        }
                        break;
                    }
                }
            }
        } catch (e) {
            console.log(`  ⚠️ getDialogs failed: ${e.message}`);
        }

        // Strategy 2: For unresolved, try getEntity directly
        for (const rawId of needIds) {
            if (resolvedNames.has(rawId)) continue;
            
            // Try multiple ID formats
            const candidates = [
                Number(rawId),
                BigInt(rawId),
            ];
            // If it starts with -, also try -100 prefix variant
            if (rawId.startsWith('-') && !rawId.startsWith('-100')) {
                candidates.push(Number('-100' + rawId.slice(1)));
                candidates.push(BigInt('-100' + rawId.slice(1)));
            }

            for (const tryId of candidates) {
                try {
                    const entity = await telegramClient.getEntity(tryId);
                    if (entity) {
                        const title = entity.title || entity.firstName || entity.username;
                        if (title) {
                            resolvedNames.set(rawId, title);
                            console.log(`  📌 Entity match: ${rawId} → "${title}"`);
                            break;
                        }
                    }
                } catch { /* try next format */ }
            }
        }

        // Apply fixes to DB
        let dbResolved = 0;
        const stmt = db.prepare(`UPDATE downloads SET group_name = ? WHERE group_id = ? AND (group_name IS NULL OR group_name LIKE 'Group %')`);
        for (const row of dbUnknowns) {
            const name = resolvedNames.get(row.group_id);
            if (name) {
                stmt.run(name, row.group_id);
                dbResolved++;
            }
        }

        // Apply fixes to config
        let configChanged = false;
        let configResolved = 0;
        for (const g of configUnknowns) {
            const name = resolvedNames.get(String(g.id));
            if (name) {
                g.name = name;
                configChanged = true;
                configResolved++;
            }
        }
        if (configChanged) {
            await writeConfigAtomic(config);
        }

        const total = resolvedNames.size;
        const failed = needIds.size - total;
        if (total > 0) console.log(`✅ Resolved ${total} group names (${dbResolved} DB, ${configResolved} config)`);
        if (failed > 0) console.log(`⚠️  ${failed} groups could not be resolved (may have left the group)`);
    } catch (e) {
        console.log('⚠️ Could not resolve group names:', e.message);
    }
}

export { broadcast };
