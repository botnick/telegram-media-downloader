
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
import { parseTelegramUrl, parseUrlList, UrlParseError } from '../core/url-resolver.js';
import { listUserStories, listAllStories, storyToJob } from '../core/stories.js';
import {
    hashPassword, loginVerify, isAuthConfigured,
    issueSession, validateSession, revokeSession, startSessionGc,
} from '../core/web-auth.js';

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

// Defense-in-depth: a coarse global rate limit on every API path. The login
// endpoint has its own stricter limiter below.
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 600,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (req) => !req.path.startsWith('/api/'),
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

async function readConfigSafe() {
    try { return JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8')); }
    catch { return {}; }
}

// Paths that may be reached without an authenticated session.
const PUBLIC_PATH_PREFIXES = ['/login', '/setup-needed', '/css/', '/js/', '/locales/', '/favicon'];
const PUBLIC_API_PATHS = new Set([
    '/api/login',
    '/api/auth_check',
    '/api/auth/setup', // first-run only — guarded inside the handler
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
        if (!result.ok) return res.status(401).json({ error: 'Invalid password' });

        // Auto-upgrade legacy plaintext to scrypt hash on first successful login.
        if (result.upgrade) {
            try {
                config.web.passwordHash = hashPassword(password);
                delete config.web.password;
                await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 4));
            } catch (e) {
                console.error('Password rehash failed (non-fatal):', e.message);
            }
        }

        const { token, maxAgeMs } = issueSession();
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
        await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 4));

        const { token, maxAgeMs } = issueSession();
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
        await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 4));

        // Issue a fresh session and let the SPA replace the old cookie. We
        // don't revoke other sessions automatically — the SPA exposes a
        // separate "Sign out everywhere" affordance that hits revokeAllSessions.
        const { token, maxAgeMs } = issueSession();
        res.cookie('tg_dl_session', token, { ...SESSION_COOKIE_OPTS, maxAge: maxAgeMs });
        res.json({ success: true });
    } catch (e) {
        console.error('change-password:', e);
        res.status(500).json({ error: 'Internal error' });
    }
});

// Tells the SPA whether auth is configured + whether the current request is
// authenticated. Always returns 200; the SPA decides what to render.
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

const _historyJobs = new Map(); // jobId → { state, processed, downloaded, error }

app.post('/api/history', async (req, res) => {
    try {
        const { groupId, limit = 100, offsetId = 0 } = req.body || {};
        if (!groupId) return res.status(400).json({ error: 'groupId required' });
        const lim = Math.max(1, Math.min(50000, parseInt(limit, 10) || 100));

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
        const job = { id: jobId, state: 'running', processed: 0, downloaded: 0, error: null, group: group.name };
        _historyJobs.set(jobId, job);

        history.on('progress', (s) => {
            job.processed = s.processed; job.downloaded = s.downloaded;
            broadcast({ type: 'history_progress', jobId, ...s, group: group.name });
        });

        history.downloadHistory(groupId, { limit: lim, offsetId: parseInt(offsetId, 10) || 0 })
            .then(() => {
                job.state = 'done';
                broadcast({ type: 'history_done', jobId, group: group.name, ...job });
                if (standalone) downloader.stop().catch(() => {});
                setTimeout(() => _historyJobs.delete(jobId), 5 * 60 * 1000);
            })
            .catch((err) => {
                job.state = 'error';
                job.error = err?.message || String(err);
                broadcast({ type: 'history_error', jobId, error: job.error });
                if (standalone) downloader.stop().catch(() => {});
            });

        res.json({ success: true, jobId, group: group.name, limit: lim });
    } catch (e) {
        console.error('POST /api/history:', e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/history/:jobId', (req, res) => {
    const job = _historyJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
});

app.get('/api/history', (req, res) => {
    res.json(Array.from(_historyJobs.values()));
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
app.get('/api/dialogs', async (req, res) => {
    try {
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

        res.json({ success: true, dialogs: results, allowDM });
    } catch (error) {
        console.error('GET /api/dialogs:', error);
        res.status(500).json({ error: 'Internal error' });
    }
});

// 3. Config Groups List (with Photo URLs)
app.get('/api/groups', async (req, res) => {
    try {
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        const groupsWithPhotos = await Promise.all((config.groups || []).map(async (group) => {
            const photoPath = path.join(PHOTOS_DIR, `${group.id}.jpg`);
            const hasPhoto = existsSync(photoPath);
            return {
                ...group,
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

        // Query DB for aggregation with group_name (MAX ignores NULLs)
        const rows = db.prepare(`
            SELECT group_id, MAX(group_name) as group_name, COUNT(*) as count, SUM(file_size) as size
            FROM downloads 
            GROUP BY group_id
        `).all();
        
        const results = rows.map(r => {
            const cfg = configGroups.find(g => String(g.id) === r.group_id);
            const name = cfg?.name || r.group_name;
            if (!name) return null; // Skip groups without a resolved name
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

// 5. Downloads Per Group (SQLite Pagination)
app.get('/api/downloads/:groupId', async (req, res) => {
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

        // DB file_path stores bare filename only.
        // Actual path on disk: sanitizedGroupName/typeFolder/filename
        const files = result.files.map(row => {
            // Map DB file_type to folder name
            const typeFolder = row.file_type === 'photo' ? 'images' 
                : row.file_type === 'video' ? 'videos' 
                : row.file_type === 'audio' ? 'audio' 
                : row.file_type === 'sticker' ? 'stickers'
                : 'documents';
            
            const fullPath = `${groupFolder}/${typeFolder}/${row.file_name}`;
            
            return {
                name: row.file_name,
                path: row.file_path,
                fullPath,
                size: row.file_size,
                sizeFormatted: formatBytes(row.file_size),
                type: typeFolder,
                extension: path.extname(row.file_name),
                modified: row.created_at
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
    if (typeof userPath !== 'string' || userPath.length === 0) return null;
    if (userPath.includes('\0')) return null;
    const normalized = path.normalize(userPath);
    if (path.isAbsolute(normalized)) return null;
    const candidate = path.join(DOWNLOADS_DIR, normalized);
    const rootReal = await fs.realpath(DOWNLOADS_DIR).catch(() => path.resolve(DOWNLOADS_DIR));
    let real;
    try { real = await fs.realpath(candidate); } catch { return null; }
    if (!real.startsWith(rootReal + path.sep) && real !== rootReal) return null;
    return real;
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
            return {
                id: row.id,
                groupId: row.group_id,
                groupName: row.group_name,
                name: row.file_name,
                fullPath: `${folder}/${typeFolder}/${row.file_name}`,
                size: row.file_size,
                sizeFormatted: formatBytes(row.file_size),
                type: typeFolder,
                modified: row.created_at,
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
            const real = await safeResolveDownload(p);
            if (real) {
                try { await fs.unlink(real); unlinked++; } catch (e) { if (e.code !== 'ENOENT') throw e; }
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
                const real = await safeResolveDownload(candidate);
                if (real) {
                    try { await fs.unlink(real); unlinked++; } catch (e) { if (e.code !== 'ENOENT') throw e; }
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

        const real = await safeResolveDownload(filePath);
        if (!real) return res.status(403).json({ error: 'Access denied' });

        await fs.unlink(real);
        console.log(`🗑️ Deleted: ${filePath}`);

        // Remove from DB (by basename — the DB stores filenames, not paths).
        const db = getDb();
        const fileName = path.basename(real);
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
        await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 4));

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
        await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 4));

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

        // Reset the lazy AccountManager singleton if Telegram credentials
        // changed — a stale instance would still be wired to the old apiId.
        if (req.body.telegram && _accountManager) {
            try { await _accountManager.disconnectAll(); } catch {}
            _accountManager = null;
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
            // Create new
            // Resolve real name from Telegram if not provided or generic
            let groupName = req.body.name;
            if (!groupName || groupName.startsWith('Group ')) {
                try {
                    if (telegramClient && isConnected) {
                        const entity = await telegramClient.getEntity(BigInt(groupId));
                        groupName = entity?.title || entity?.firstName || entity?.username || groupName;
                    }
                } catch { /* keep whatever name we have */ }
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
        
        await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 4));
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

        const real = await safeResolveDownload(reqPath);
        if (!real) return res.status(403).send('Forbidden');

        const inline = req.query.inline === '1';
        const baseName = path.basename(real);
        // Quote-safe filename (RFC 6266 fallback handled by encodeURIComponent).
        const dispKind = inline ? 'inline' : 'attachment';
        res.setHeader(
            'Content-Disposition',
            `${dispKind}; filename*=UTF-8''${encodeURIComponent(baseName)}`
        );
        res.sendFile(real);
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
    try {
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        const sessionString = await loadSession();
        if (!sessionString) return null;

        const stringSession = new StringSession(sessionString);
        telegramClient = new TelegramClient(stringSession, parseInt(config.telegram.apiId), config.telegram.apiHash, { connectionRetries: 3, useWSS: false });
        telegramClient.setLogLevel('none');
        await telegramClient.connect();

        if (await telegramClient.isUserAuthorized()) {
            isConnected = true;
            console.log('✅ Connected to Telegram (for profile photos)');
            return telegramClient;
        }
    } catch (error) {
        console.log('⚠️ Telegram connection failed:', error.message);
    }
    return null;
}

// Entity & Photo Helpers
const entityCache = new Map();
async function downloadProfilePhoto(groupId) {
    const idStr = String(groupId);
    const photoPath = path.join(PHOTOS_DIR, `${idStr}.jpg`);
    if (existsSync(photoPath)) return `/photos/${idStr}.jpg`;

    const client = await connectTelegram();
    if (!client) return null;

    try {
        let entity = entityCache.get(idStr);
        if (!entity) {
            try { entity = await client.getEntity(idStr); } catch (e) {}
            if (!entity) {
                 try { entity = await client.getEntity(BigInt(idStr)); } catch (e) {}
            }
        }

        if (entity) {
            entityCache.set(idStr, entity);
            if (entity.photo) {
                const buffer = await client.downloadProfilePhoto(entity, { isBig: false });
                if (buffer) {
                    await fs.writeFile(photoPath, buffer);
                    return `/photos/${idStr}.jpg`;
                }
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

    console.log(`
╔════════════════════════════════════════════════════════════╗
║   🌐 Telegram Downloader - SQLite Edition                 ║
║   Server: http://localhost:${PORT}                          ║
╚════════════════════════════════════════════════════════════╝
`);
    await connectTelegram();

    // Resolve group names from Telegram for any DB records still unnamed
    await resolveGroupNamesFromTelegram();
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
            await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 4));
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
