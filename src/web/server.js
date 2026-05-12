/**
 * Web GUI Server - Configuration + Profile Photos + SQLite Data
 * Features: Groups, Settings, Viewer, Real Telegram Profile Photos
 */

import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import fs from 'fs/promises';
import fsSync, { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

import { getOrGenerateSecret } from '../core/secret.js';
import { BACKFILL_MAX_LIMIT } from '../core/constants.js';
import {
    getDb,
    backfillGroupNames,
    getShareLinkForServe,
    bumpShareLinkAccess,
    kvGet,
    kvSet,
} from '../core/db.js';
import { SecureSession } from '../core/security.js';
import { AccountManager } from '../core/accounts.js';
import { loadConfig } from '../config/manager.js';
import { runtime } from '../core/runtime.js';
import { getDiskRotator } from '../core/disk-rotator.js';
import * as integrity from '../core/integrity.js';
import { ensureShareSecret, verifyShareToken, applyShareLimits } from '../core/share.js';
import { purgeNonStandardThumbs } from '../core/thumbs.js';
import {
    setBroadcast as setSeekbarBroadcast,
    startSidecar as startSeekbarSidecar,
} from '../core/seekbar/spawn.js';
import { preloadClassifier as nsfwPreloadClassifier } from '../core/nsfw.js';
// Search + Auto-tag + vector index were removed in this release. Stubs
// below keep the existing route handlers compiling until the bigger
// "drop endpoints" cleanup lands. Each stub responds 410 Gone so the SPA
// can render a friendly "feature removed" message instead of crashing.
// Search + Auto-tag were removed in this release; only Face clustering
// survives. The stub constants that used to live here (aiStartEmbedScan,
// aiStartTagsScan, aiEmbedText, aiTopK, aiLoadVecOnce, AI_EMBED_DEFAULTS,
// …) were deleted along with the routes that called them.
import { getRescueSweeper } from '../core/rescue.js';
import * as backup from '../core/backup/index.js';
import { metrics } from '../core/metrics.js';
import { isAuthConfigured, validateSession, startSessionGc } from '../core/web-auth.js';
import { suppressNoise, wrapConsoleMethod, NATIVE_LOAD_FAIL } from '../core/logger.js';
import { createJobTracker } from '../core/job-tracker.js';
import { getSelfPeerId, getClusterToken } from '../core/cluster/identity.js';
import * as clusterWs from '../core/cluster/ws-channel.js';
import { readConfigSafe } from './lib/config-cache.js';
import {
    createVersionRouter,
    readCurrentVersion as _readCurrentVersion,
} from './routes/version.js';
import { createStoriesRouter } from './routes/stories.js';
import { createQueueRouter } from './routes/queue.js';
import { createAuthRouter } from './routes/auth.js';
import {
    pushHistory as pushQueueHistory,
    failedJobMeta as _failedJobMeta,
} from './lib/queue-state.js';
import { writeConfigAtomic } from './lib/config-writer.js';
import { createAccountsRouter } from './routes/accounts.js';
import { createMonitorRouter } from './routes/monitor.js';
import { createHistoryRouter } from './routes/history.js';
import { createAiRouter } from './routes/ai.js';
import { createMaintenanceRouter } from './routes/maintenance.js';
import { createClusterRouter } from './routes/cluster.js';
import { safeResolveDownload } from './lib/resolve-download.js';
import { createBackupRouter } from './routes/backup.js';
import { createShareLinksRouter } from './routes/share.js';
import { createConfigRouter } from './routes/config.js';
import { createGroupsRouter, spawnBackfill } from './routes/groups.js';
import { createDownloadsRouter } from './routes/downloads.js';
import {
    createDialogsRouter,
    invalidateDialogsCache as _invalidateDialogsCache,
    getDialogsNameCache,
    dialogsTypeFor,
} from './routes/dialogs.js';
import { createStatsRouter, broadcastStatsSoon } from './routes/stats.js';
import { createLinkDownloadRouter } from './routes/link-download.js';
import { createFileServingMiddleware } from './middleware/files.js';
import { cookieParser, checkAuth, guestGate } from './middleware/auth.js';
import { resolveGroupNamesFromTelegram } from './lib/resolve-group-names.js';

// Demote gramJS reconnect chatter from stderr/stdout to data/logs/network.log.
// gramJS opens a fresh DC connection per file download (different DCs host
// different media buckets), so a busy monitor logs hundreds of "Disconnecting
// from <ip>:443/TCPFull..." lines per hour through the bare console — which
// drowns out real errors. Both methods are wrapped because gramJS uses
// console.log for most of its lifecycle messages and console.error for the
// occasional warning. TGDL_DEBUG=1 brings them back.
//
// Tee — the same line is appended to the in-memory _logBuffer so the
// `/maintenance/logs` page surfaces every backend write, not just events
// that explicitly call log(). The buffer + LOG_BUFFER_SIZE are declared
// here (not later in the file) so console wrapping below has somewhere
// to write to immediately.
//
// Caps are deliberately tight (2000 × 8 KB ≈ 16 MB worst case) so the
// buffer can't push a small-VM container (Synology with default 512 MB
// heap, etc.) over its limit. Override via TGDL_LOG_BUFFER_SIZE /
// TGDL_LOG_MSG_MAX env vars when chasing a specific incident on a
// host with more headroom.
const LOG_BUFFER_SIZE = Math.max(
    100,
    Math.min(20000, Number(process.env.TGDL_LOG_BUFFER_SIZE) || 2000),
);
const LOG_MSG_MAX = Math.max(256, Math.min(65536, Number(process.env.TGDL_LOG_MSG_MAX) || 8000));
const _logBuffer = [];
function _pushLogEntry(level, source, msg) {
    const entry = {
        ts: Date.now(),
        source,
        level,
        msg: String(msg).slice(0, LOG_MSG_MAX),
    };
    _logBuffer.push(entry);
    if (_logBuffer.length > LOG_BUFFER_SIZE) _logBuffer.shift();
    return entry;
}
const _consoleTee = (level) => (args, joined) => {
    try {
        _pushLogEntry(level, 'console', joined);
    } catch {
        /* never throw out of a console hook */
    }
};
console.log = wrapConsoleMethod(console.log, 'gramjs', _consoleTee('info'));
console.error = wrapConsoleMethod(console.error, 'gramjs', _consoleTee('error'));
const _origConsoleWarn = console.warn;
console.warn = (...args) => {
    try {
        _pushLogEntry(
            'warn',
            'console',
            args.map((a) => (typeof a === 'string' ? a : a?.stack || JSON.stringify(a))).join(' '),
        );
    } catch {}
    _origConsoleWarn(...args);
};
// Native-binary load failures from optional deps must NOT crash the
// process. The most common offender is `onnxruntime-node` (transitive of
// `@huggingface/transformers`, which our optional NSFW classifier uses):
// it ships glibc-only Linux prebuilds, so on musl-based images (alpine)
// the dynamic linker errors with `Error loading shared library
// ld-linux-x86-64.so.2`. We move the dep to optionalDependencies in
// package.json so a default install doesn't pull it at all, but a
// historical install or a re-deploy without `npm prune` may leave the
// broken module on disk. Catch the rejection here, log once, move on.
// The detector pattern lives in core/logger.js so this file, src/index.js,
// and the doctor check can't drift apart.
let _nativeLoadFailWarned = false;
process.on('unhandledRejection', (reason) => {
    const msg = reason?.message || String(reason);
    if (suppressNoise(msg, 'unhandledRejection')) return;
    if (NATIVE_LOAD_FAIL.test(msg)) {
        if (!_nativeLoadFailWarned) {
            _nativeLoadFailWarned = true;
            console.warn(
                '[startup] An optional native module failed to load (' +
                    msg.slice(0, 200) +
                    '). ' +
                    'The dashboard will keep running; only the feature that triggered this load will be unavailable. ' +
                    'Most often this is `onnxruntime-node` from the optional NSFW classifier on a musl-based image — ' +
                    'reinstall with `npm install @huggingface/transformers` on a glibc image (Debian, Ubuntu, our default Dockerfile uses bookworm-slim) or remove it with `npm uninstall @huggingface/transformers`.',
            );
        }
        return;
    }
    console.error('Unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
    const msg = err?.message || String(err);
    if (NATIVE_LOAD_FAIL.test(msg)) {
        if (!_nativeLoadFailWarned) {
            _nativeLoadFailWarned = true;
            console.warn('[startup] Native module load failure swallowed:', msg.slice(0, 200));
        }
        return;
    }
    // Non-native uncaught exceptions are real bugs — surface them and
    // crash so the watchdog can restart cleanly. Stop accepting new
    // connections and give in-flight requests up to 5 s to flush
    // before exiting; without the drain, every unhandled bug produces
    // a 502 burst for every concurrent client during the restart.
    console.error('Uncaught exception:', err);
    try {
        server.close();
    } catch {}
    setTimeout(() => process.exit(1), 5000).unref();
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
const SESSION_PATH = path.join(DATA_DIR, 'session.enc');
const SESSION_PASSWORD = getOrGenerateSecret();

const app = express();
const server = createServer(app);
// Cloudflare's idle/origin window is ~100 s; nginx default proxy_read_timeout
// is 60 s. Setting our own timeouts slightly above keepAliveTimeout avoids
// the Node-default mismatch (5 s) where a long-poll request still inside
// the proxy's window gets reset by the origin and the proxy reports 502.
// headersTimeout must be ≥ keepAliveTimeout per Node docs.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 120_000;
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
        // Cluster WS channel — peer-to-peer, HMAC-authenticated via
        // signed query-string. Skip the cookie/session check entirely.
        if (req.url && req.url.startsWith('/ws/cluster')) {
            try {
                const url = new URL(req.url, 'http://x');
                const params = Object.fromEntries(url.searchParams.entries());
                const verifiedPeer = clusterWs.verifyConnectAuth(params);
                if (!verifiedPeer) {
                    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                    socket.destroy();
                    return;
                }
                wss.handleUpgrade(req, socket, head, (ws) => {
                    ws._clusterPeer = verifiedPeer;
                    clusterWs.registerInboundWs(verifiedPeer, ws);
                });
            } catch {
                try {
                    socket.destroy();
                } catch {
                    /* nothing */
                }
            }
            return;
        }

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
        const session = validateSession(cookies['tg_dl_session']);
        if (!session) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            // Stamp the role on the WS so future per-event filtering
            // (admin-only broadcasts) can reference it without a second
            // session lookup.
            ws.role = session.role;
            wss.emit('connection', ws, req);
        });
    } catch {
        try {
            socket.destroy();
        } catch {}
    }
});

// Telegram client
let telegramClient = null;
let isConnected = false;

// Ensure photos directory exists
if (!fsSync.existsSync(PHOTOS_DIR)) {
    fsSync.mkdirSync(PHOTOS_DIR, { recursive: true });
}

// Trust the first reverse proxy if running behind one (rate-limit needs
// the real client IP via X-Forwarded-For). When `TRUST_PROXY` is set
// explicitly we honour that value; otherwise we fall back to `'loopback'`
// — which trusts X-Forwarded-* only when the immediate hop is loopback
// (i.e. a sibling reverse proxy on the same host) and otherwise treats
// the connection IP as authoritative. This kills the noisy
// `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` validation warning that
// express-rate-limit emits whenever a Caddy / Traefik / nginx upstream
// forwards X-Forwarded-For without us trusting it, while still rejecting
// spoofed X-Forwarded-For headers from arbitrary internet clients.
//
// Override examples:
//   TRUST_PROXY=1            // trust exactly one proxy hop (most setups)
//   TRUST_PROXY=loopback     // explicit (same as the default)
//   TRUST_PROXY=10.0.0.0/8   // trust an IP CIDR
//   TRUST_PROXY=             // empty string → disable (untrusted env)
const _trustProxyRaw = process.env.TRUST_PROXY;
if (_trustProxyRaw === undefined) {
    app.set('trust proxy', 'loopback');
} else if (_trustProxyRaw !== '') {
    app.set(
        'trust proxy',
        /^\d+$/.test(_trustProxyRaw) ? parseInt(_trustProxyRaw, 10) : _trustProxyRaw,
    );
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
    // HSTS — set on every secure response so browsers remember the
    // upgrade. 1-year max-age + includeSubDomains is the modern baseline;
    // we deliberately omit `preload` because the operator has to opt in
    // to the chrome list separately at hstspreload.org.
    if (req.secure) {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        return next();
    }
    const ip = req.ip || req.socket?.remoteAddress || '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return res.status(403).json({ error: 'HTTPS required' });
    }
    const host = req.headers.host;
    if (!host) return res.status(400).end();
    return res.redirect(308, `https://${host}${req.originalUrl}`);
});

// Optional gzip/deflate/br compression for text responses (HTML / JS / CSS /
// JSON / SVG). The middleware ships as a separate npm package so we
// `createRequire` it here and silently skip when the host hasn't installed
// it (e.g. an old `node_modules/`). When present, configure to skip
// already-compressed media (image/* / video/* / audio/*) and tunable level
// via `COMPRESSION_LEVEL` (1-9, default 6 — the same default the package
// uses, exposed for operators on slow CPUs who want a lower setting).
try {
    const _localRequire = createRequire(import.meta.url);
    const compression = _localRequire('compression');
    const lvlEnv = parseInt(process.env.COMPRESSION_LEVEL, 10);
    const level = Number.isFinite(lvlEnv) && lvlEnv >= 0 && lvlEnv <= 9 ? lvlEnv : 6;
    app.use(
        compression({
            level,
            // Skip already-compressed payloads — gzipping a JPEG or MP4 burns
            // CPU for a fraction of a percent of size win and breaks
            // range-request semantics that the video player depends on.
            filter: (req, res) => {
                if (req.headers['x-no-compression']) return false;
                const ct = String(res.getHeader('Content-Type') || '');
                if (/^(image|video|audio)\//i.test(ct)) return false;
                return compression.filter(req, res);
            },
        }),
    );
    if (process.env.TGDL_DEBUG === '1') {
        console.log(`[startup] compression middleware enabled (level=${level})`);
    }
} catch {
    // Module not installed — fine, dashboard runs uncompressed (Cloudflare /
    // a reverse proxy in front will usually handle it instead).
}

// Security headers. CSP is on but allows the SPA's two CDN dependencies
// (Tailwind + Remixicon) and the inline event-handlers we still use in
// index.html. Tightening "self"-only is a follow-up once the inline handlers
// are migrated to addEventListener.
//
// `https://cdnjs.cloudflare.com` is allow-listed for the viewer's
// lazy-loaded preview helpers — highlight.js (code blocks), marked
// (markdown), and DOMPurify (sanitise rendered markdown). Only fetched
// the first time the operator opens a code / markdown file in the modal,
// then cached by the browser.
// `frame-src: 'self'` lets the viewer's PDF container point an iframe
// at `/files/<path>?inline=1#toolbar=1` so the browser's native PDF
// viewer renders it without leaving the dashboard.
app.use(
    helmet({
        contentSecurityPolicy: {
            useDefaults: true,
            directives: {
                'default-src': ["'self'"],
                'script-src': [
                    "'self'",
                    "'unsafe-inline'",
                    'https://cdn.tailwindcss.com',
                    'https://cdn.jsdelivr.net',
                    'https://cdnjs.cloudflare.com',
                ],
                // The SPA uses inline onclick / oninput handlers in index.html
                // (toggle UI, range-slider value updaters, modal close-buttons).
                // Helmet's defaults set script-src-attr to 'none' which would
                // block them; allow inline here until the markup is migrated to
                // addEventListener.
                'script-src-attr': ["'unsafe-inline'"],
                'style-src': [
                    "'self'",
                    "'unsafe-inline'",
                    'https://cdn.jsdelivr.net',
                    'https://cdnjs.cloudflare.com',
                    'https://fonts.googleapis.com',
                ],
                'style-src-attr': ["'unsafe-inline'"],
                'font-src': [
                    "'self'",
                    'data:',
                    'https://fonts.gstatic.com',
                    'https://cdn.jsdelivr.net',
                ],
                'img-src': ["'self'", 'data:', 'blob:'],
                'media-src': ["'self'", 'blob:'],
                'connect-src': ["'self'", 'ws:', 'wss:'],
                'object-src': ["'none'"],
                'frame-src': ["'self'"],
                'frame-ancestors': ["'self'"],
            },
        },
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'same-origin' },
    }),
);

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
    } else if (p.startsWith('/js/') || p.startsWith('/css/') || p.startsWith('/icons/')) {
        // Asset cache-busting middleware (further down) appends a
        // ?v=<APP_VERSION> query string to every internal `<script>`,
        // `<link>`, and `import` so the URL changes on every release.
        // That makes it safe to cap the HTTP cache at the maximum
        // (1 year + immutable) for any request that carries the `?v=`
        // — the URL itself guarantees freshness on the next deploy.
        // Bare requests (no `?v=`, e.g. someone curls the file
        // directly) get the conservative 1 h fallback.
        if (req.query && req.query.v) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
            res.setHeader('Cache-Control', 'public, max-age=3600');
        }
    } else if (p.startsWith('/locales/')) {
        // Translations evolve more often than JS / CSS — keep the cap
        // short (1 h) AND must-revalidate so a hash mismatch on the
        // strings doesn't ship a week of stale labels. The cache-bust
        // ?v= still works for instant invalidation when the SPA loads.
        res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
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
            perMinute:
                Number.isFinite(rpm) && rpm >= 10 ? Math.min(1000000, rpm) : RATE_LIMIT_DEFAULT_RPM,
        };
    } catch {
        /* keep last-known-good */
    }
}
refreshRateLimitConfig();
setInterval(refreshRateLimitConfig, 30 * 1000).unref();

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: () => _rateLimitConfig.perMinute,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (req) => !req.path.startsWith('/api/') || !_rateLimitConfig.enabled,
    // `xForwardedForHeader` is a self-help diagnostic from express-rate-
    // limit v7 that flooded stderr with `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`
    // every time the upstream proxy forwarded an X-Forwarded-For header
    // without us trusting it. We've already configured `app.set('trust
    // proxy', …)` correctly above (loopback by default, overridable via
    // TRUST_PROXY env) so the validate warning is just noise. Other
    // validators stay enabled — only this one pair is muted.
    validate: { xForwardedForHeader: false, trustProxy: false },
});
app.use(apiLimiter);

// Body parsing middleware — small, JSON only. Bigger payloads (e.g., bulk
// imports) should get their own dedicated route with a larger limit. The
// `verify` hook captures the raw bytes onto req.rawBody so cluster-mode
// HMAC verification (src/core/cluster/hmac.js) can hash exactly what the
// remote peer signed — re-stringifying the parsed object would change
// whitespace and break the signature.
app.use(
    express.json({
        limit: '256kb',
        verify: (req, _res, buf) => {
            req.rawBody = buf;
        },
    }),
);

// CSRF defence-in-depth on top of `sameSite=strict` cookies. Reject any
// state-changing request whose Origin or Referer header points at a
// different host than the one we're serving from. CLI / extension /
// curl clients that send neither header pass through — they can't have
// obtained the session cookie cross-site anyway thanks to sameSite=strict.
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
app.use((req, res, next) => {
    if (!STATE_CHANGING_METHODS.has(req.method)) return next();
    const headerOrigin = req.headers.origin || req.headers.referer;
    if (!headerOrigin) return next(); // CLI / native client — sameSite still gates them
    let originHost;
    try {
        originHost = new URL(headerOrigin).host;
    } catch {
        originHost = null;
    }
    if (!originHost) {
        return res.status(403).json({ error: 'Invalid Origin/Referer' });
    }
    const expected = req.headers.host;
    if (originHost === expected) return next();
    // Allow localhost and 127.0.0.1 to alias each other on dev setups
    // where the SPA loads from one and posts to the other.
    const localPair = (a, b) =>
        /^(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?$/i.test(a) &&
        /^(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?$/i.test(b) &&
        a.split(':')[1] === b.split(':')[1];
    if (localPair(originHost, expected)) return next();
    return res.status(403).json({ error: 'Cross-origin request blocked' });
});

// Rolling expiry-cleanup for session tokens. Unref'd so it doesn't keep the
// process alive on shutdown.
startSessionGc();

// Bootstrap the share-link HMAC secret + apply runtime limits from
// config. Lazy-generated secret on first boot, persisted to
// config.web.shareSecret. Done inside an async IIFE so a missing config
// file (very-first boot) doesn't crash module load — re-runs on the
// next request that touches `readConfigSafe`.
(async () => {
    try {
        const cfg = await readConfigSafe();
        const { generated } = ensureShareSecret(cfg);
        if (generated) {
            await writeConfigAtomic(cfg);
            console.log('[share] generated new HMAC secret (first boot or rotation).');
        }
        applyShareLimits(cfg.advanced?.share || {});
    } catch (e) {
        // Non-fatal — verifyShareToken will throw at first /share/* request
        // and the user will see a 500. Better than crashing the whole web.
        console.warn('[share] secret bootstrap deferred:', e?.message || e);
    }
})();

// Bootstrap cluster identity at boot — generates peer_id + cluster_token
// on first launch, no-op afterwards. Ensures the kv['peer_id'] /
// kv['cluster_token'] rows are present before the operator opens
// Maintenance → Cluster (and before any signed inbound request needs to
// answer with our identity).
try {
    getSelfPeerId();
    getClusterToken();
} catch (e) {
    console.warn('[cluster] identity bootstrap deferred:', e?.message || e);
}

// ============ AUTHENTICATION ============

app.use(cookieParser);

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

// ====== Public share-link route (HMAC-gated, no dashboard cookie) ==========
//
// Registered BEFORE the global checkAuth so a friend with a valid /share
// URL never sees a /login redirect. Three independent gates protect the
// route:
//   1. shareLimiter      — per-IP rate limit (configurable via
//                          config.advanced.share.rateLimit{Window,Max})
//   2. verifyShareToken  — HMAC-SHA256, timing-safe constant-time compare
//   3. getShareLinkForServe — DB row check (revoked? expired?)
//
// Only after all three pass do we delegate to safeResolveDownload + the
// existing file-streaming code (so Range requests and Content-Type
// behave identically to /files/*). Cache-Control: no-store keeps a
// shared CDN/proxy from hijacking the bytes for the next visitor.
//
// Both windowMs and limit are passed as functions so a config_updated
// broadcast that changes them takes effect on the next request without a
// process restart.
const shareLimiter = rateLimit({
    windowMs: () => {
        const ms = Number(_currentShareConfig().rateLimitWindowMs);
        return Number.isFinite(ms) && ms > 0 ? ms : 60_000;
    },
    limit: () => {
        const lim = Number(_currentShareConfig().rateLimitMax);
        return Number.isFinite(lim) && lim > 0 ? lim : 60;
    },
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests — slow down.' },
});

// Tiny cache around the last-loaded config so the rate-limit getters
// don't sync-read disk on every share request. Refreshed by the
// config_updated WS broadcast handler below + on first use.
let _shareConfigCache = null;
function _currentShareConfig() {
    if (!_shareConfigCache) {
        try {
            _shareConfigCache = loadConfig().advanced?.share || {};
        } catch {
            _shareConfigCache = {};
        }
    }
    return _shareConfigCache;
}
function _invalidateShareConfigCache() {
    _shareConfigCache = null;
}

// v2 URL shape: `/share/<linkId>?s=<sig>` (or `/share/<linkId>/<filename>?s=<sig>`
// when `buildShareUrlPath()` was called with a friendly slug). The signature
// embeds the row's `expires_at`, so the URL only needs the linkId + sig —
// verifier looks up the row and re-derives the expected sig from the stored
// expiry. Tolerates the legacy v1 `?exp=&sig=` shape as a fallback so links
// minted before the v2 cutover still work until they expire naturally.
app.get(['/share/:linkId', '/share/:linkId/:fileName'], shareLimiter, async (req, res, next) => {
    try {
        const linkId = parseInt(req.params.linkId, 10);
        const sigV2 = typeof req.query.s === 'string' ? req.query.s : '';
        const sigV1 = typeof req.query.sig === 'string' ? req.query.sig : '';
        const expV1 = parseInt(req.query.exp, 10);
        if (!Number.isInteger(linkId) || linkId <= 0 || (!sigV2 && !sigV1)) {
            return res.status(400).type('text/plain').send('Invalid share link');
        }

        // Lookup first — we need `row.expires_at` to verify the v2 sig
        // against. `getShareLinkForServe` also returns the revoked/expired
        // reason so we can fail fast.
        const lookup = getShareLinkForServe(linkId, Math.floor(Date.now() / 1000));
        if (!lookup || lookup.reason) {
            const code =
                lookup?.reason === 'revoked'
                    ? 'revoked'
                    : lookup?.reason === 'expired'
                      ? 'expired'
                      : 'not_found';
            return res.status(401).json({ error: 'Share link is not valid', code });
        }

        // v2 path: derive expected sig from `row.expires_at` (the value
        // that was signed at mint time). v1 fallback: trust the URL's
        // `exp` value but still require it to match the row's expiry so
        // a stale link can't outlive a re-mint.
        let sigOk = false;
        if (sigV2) {
            sigOk = verifyShareToken(linkId, lookup.row.expires_at, sigV2);
        } else if (sigV1 && Number.isInteger(expV1) && expV1 > 0) {
            sigOk = expV1 === lookup.row.expires_at && verifyShareToken(linkId, expV1, sigV1);
        }
        if (!sigOk) {
            return res.status(401).json({ error: 'Share link is not valid', code: 'bad_sig' });
        }

        const row = lookup.row;
        const r = await safeResolveDownload(row.file_path);
        if (!r.ok) {
            // File row exists but disk file is gone — surface as 404 so the
            // friend doesn't think the link is wrong.
            return res.status(404).type('text/plain').send('File not found');
        }

        // Bump access counter — cheap, non-blocking on errors.
        bumpShareLinkAccess(linkId);

        // Anti-CDN cache + don't allow shared caches to cache. Bytes are
        // gated per-token; if the token is later revoked, no cache layer
        // should keep handing the file out.
        res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        // Block clickjacking-style framing of the raw stream from a third
        // party site (defence-in-depth — bytes themselves rarely matter
        // here, but a video tag in an iframe could fingerprint the user).
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');

        // Force download when ?download=1, otherwise let the browser pick
        // (mirrors /files/* semantics so an image/video plays inline by
        // default and a generic file goes to the download tray).
        const forceDl = req.query.download === '1' || req.query.download === 'true';
        const safeName = (row.file_name || `file-${linkId}`).replace(/[\r\n"]/g, '_');
        const disp = forceDl ? 'attachment' : 'inline';
        // RFC 5987 filename* for non-ASCII filenames + ASCII fallback.
        res.setHeader(
            'Content-Disposition',
            `${disp}; filename="${safeName.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
        );

        // Hand off to express's static-style sendFile which supports Range.
        // sendFile sets Content-Type from the extension, which is what we
        // want — sniff-protection lives in helmet's nosniff header.
        return res.sendFile(r.real, (err) => {
            if (err && !res.headersSent) next(err);
        });
    } catch (e) {
        console.error('share serve:', e);
        if (!res.headersSent) res.status(500).type('text/plain').send('Internal error');
    }
});

// Apply Auth Globally
app.use(checkAuth);
// Guest sessions: default-deny everything not on the explicit allowlist.
// Mounted right after auth so every authenticated /api request is gated.
app.use('/api', guestGate);

// Serve static files AFTER auth
// Asset cache-busting — append `?v=<APP_VERSION>` to every internal
// `<script src="/js/...">` in the SPA HTML AND to every relative
// `import './X.js'` inside the JS modules themselves. Without it, a
// new deploy that doesn't change a file's bytes (or one whose change
// the browser missed) keeps serving the previously-cached copy from
// the HTTP cache for the full max-age window. With `?v=` the URL
// changes on every release, so a stale cache hit is impossible — and
// we can safely upgrade the JS Cache-Control to `immutable` + 1 y
// (handled in the cache-headers middleware further up).
//
// In-memory cache so we only do the regex once per file per process
// lifetime; a server restart re-reads (which is exactly what we want
// after a `docker compose pull`).
const _cacheBust = new Map();
const _publicDir = path.join(__dirname, 'public');
// Resolve the running version ONCE at module load — same source the
// /api/version handler uses, but cached as a string here for the
// per-request rewriters to avoid re-reading package.json each call.
const appVersion = _readCurrentVersion();

function _rewriteHtmlSrc(html) {
    // Cover `/js/`, `/locales/`, AND `/css/` so a release that ships only
    // CSS changes (UI polish without JS edits) still busts the cache.
    // Without /css/ here, a stale main.css can outlive a deploy — the
    // SW + browser HTTP cache happily serves yesterday's stylesheet
    // even though the SPA shipped new selectors.
    return html.replace(
        /\b(src|href)="(\/(?:js|locales|css)\/[^"?]+\.(?:js|json|css))"/g,
        (m, attr, url) => `${attr}="${url}?v=${appVersion}"`,
    );
}

function _rewriteJsImports(js) {
    // Match: `from './X.js'`, `import './X.js'`, `import('./X.js')`.
    // Skip any specifier that already carries a query string.
    return js.replace(
        /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"?]+\.js)\2/g,
        (m, lead, q, spec) => `${lead}${q}${spec}?v=${appVersion}${q}`,
    );
}

function _serveCacheBusted(reqPath, mime, rewrite, res) {
    let body = _cacheBust.get(reqPath);
    if (!body) {
        try {
            const filePath = path.join(_publicDir, reqPath);
            const real = fsSync.realpathSync(filePath);
            const root = fsSync.realpathSync(_publicDir);
            if (!real.startsWith(root + path.sep) && real !== root) return false;
            body = rewrite(fsSync.readFileSync(real, 'utf8'));
            _cacheBust.set(reqPath, body);
        } catch {
            return false;
        }
    }
    res.setHeader('Content-Type', mime);
    res.send(body);
    return true;
}

app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    // HTML entry points — rewrite the two `<script>` tags + any
    // future inline asset link the index gains.
    if (
        req.path === '/' ||
        req.path === '/index.html' ||
        req.path === '/login.html' ||
        req.path === '/setup-needed.html' ||
        req.path === '/add-account.html'
    ) {
        const file = req.path === '/' ? '/index.html' : req.path;
        if (_serveCacheBusted(file, 'text/html; charset=utf-8', _rewriteHtmlSrc, res)) return;
        return next();
    }
    // JS modules — rewrite every relative `import './X.js'` so the
    // child URL inherits the same `?v=` and the browser HTTP cache
    // can't stale-serve a single module while the rest of the bundle
    // is fresh. The Cache-Control middleware further up keys off the
    // `?v=` query string to upgrade these to immutable.
    if (req.path.startsWith('/js/') && req.path.endsWith('.js')) {
        if (
            _serveCacheBusted(
                req.path,
                'application/javascript; charset=utf-8',
                _rewriteJsImports,
                res,
            )
        )
            return;
        return next();
    }
    next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/photos', express.static(PHOTOS_DIR));

// Serve CHANGELOG.md from the project root for the in-app changelog
// viewer (changelog-viewer.js). Read on every request so a `git pull`
// without a process restart picks up the new content. Cap at a sane
// size so we never accidentally try to stream a 50 MB file. 1 hour
// browser cache is fine — the SPA invalidates it via the `?v=` token.
app.get('/CHANGELOG.md', async (req, res) => {
    try {
        const p = path.resolve(__dirname, '../../CHANGELOG.md');
        const st = await fs.stat(p).catch(() => null);
        if (!st || !st.isFile())
            return res.status(404).type('text/plain').send('CHANGELOG not found');
        if (st.size > 2 * 1024 * 1024)
            return res.status(413).type('text/plain').send('CHANGELOG too large');
        const body = await fs.readFile(p, 'utf8');
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
        res.send(body);
    } catch (e) {
        res.status(500).type('text/plain').send(e.message);
    }
});

// ============ API ENDPOINTS ============

// ====== Monitor / runtime control ==========================================
//
// Starts the realtime monitor inside the web process so users don't have to
// keep a separate terminal open. Engine events are forwarded to all
// authenticated WebSocket clients.

runtime.on('state', (s) => broadcast({ type: 'monitor_state', state: s.state, error: s.error }));
runtime.on('event', (e) => broadcast({ type: 'monitor_event', ...e }));

// Catch-up backfill — fired by monitor when boot-time inspection finds a
// group whose newest stored message_id lags Telegram's current top by
// more than `advanced.history.autoCatchUpThreshold`. We spawn an
// internal backfill in `catch-up` mode so the gap that built up while
// the container was down closes itself with no user action required.
runtime.on('catch_up_needed', ({ groupId, gap }) => {
    const histCfg = loadConfig().advanced?.history || {};
    // Bound the catch-up size — a group that fell weeks behind could
    // need ~10000s of messages, so cap at a sane ceiling. Falls back
    // to "unlimited" when autoFirstLimit is 0 (operator opt-in for
    // long catch-ups).
    const ceiling = Number(histCfg.autoFirstLimit ?? 100);
    const limit = ceiling > 0 ? Math.min(ceiling * 10, BACKFILL_MAX_LIMIT) : null;
    spawnBackfill({
        groupId,
        limit,
        mode: 'catch-up',
        reason: 'auto-catch-up',
    })
        .then((jobId) => {
            if (jobId)
                console.log(
                    `[catch-up] gap=${gap} → spawned backfill ${jobId} (limit=${limit ?? 'all'})`,
                );
        })
        .catch((e) => console.warn('[catch-up] spawn failed:', e?.message || e));
});

// ====== History batch download =============================================
//
// Run an out-of-band backfill against a configured group. Re-uses the
// runtime's downloader if it's running so the worker pool isn't doubled;
// otherwise spins one up just for this request and tears it down on
// completion.
//
// Persistence — past jobs (last 30 days) live in kv['history_jobs'] in
// SQLite so the Backfill page can show a rolling history across server
// restarts. The map below holds active jobs (with the live HistoryDownloader
// instance attached) plus a hot copy of recent finished ones; the kv row
// is the source of truth for anything older.

// Capture finishes/failures off the runtime event stream so the snapshot
// always has a populated "recent" tail even after a server restart.
runtime.on('event', (e) => {
    if (e.type === 'download_complete' && e.payload) {
        const p = e.payload;
        // Normalise `filePath` to a path that's relative to DOWNLOADS_DIR
        // — the form the SPA's `/files/<path>?inline=1` route expects.
        //
        // The downloader's `buildPath()` defaults to `'./data/downloads'`,
        // so the emitted filePath is usually a RELATIVE string like
        // `data/downloads/<group>/images/<file>`. Older code path (before
        // v2.3.19) only stripped an ABSOLUTE prefix, which made every
        // queue-history entry ship with a literal `data/downloads/`
        // segment — and `/files/data/downloads/...` then got joined to
        // DOWNLOADS_DIR a second time and 404'd. Walk three forms:
        //   1. absolute under DOWNLOADS_DIR
        //   2. relative starting with `./data/downloads/` or `data/downloads/`
        //   3. already canonical `<group>/<type>/<file>` — leave alone
        let relPath = null;
        if (p.filePath) {
            let s = String(p.filePath).replace(/\\/g, '/');
            const absRoot = path.resolve(DOWNLOADS_DIR).replace(/\\/g, '/');
            if (s.startsWith(absRoot + '/')) {
                relPath = s.slice(absRoot.length + 1);
            } else if (s.startsWith('./data/downloads/')) {
                relPath = s.slice('./data/downloads/'.length);
            } else if (s.startsWith('data/downloads/')) {
                relPath = s.slice('data/downloads/'.length);
            } else {
                relPath = s;
            }
        }
        pushQueueHistory({
            key: p.key,
            groupId: String(p.groupId || ''),
            groupName: p.groupName || null,
            mediaType: p.mediaType || null,
            messageId: p.messageId ?? null,
            fileName: p.fileName || (p.filePath ? p.filePath.split(/[\\/]/).pop() : null),
            filePath: relPath,
            fileSize: p.fileSize || 0,
            status: 'done',
            // Surfaces "file was already on disk under another (group, msg)
            // mapping" — `registerDownload()` set this on dedup. The queue UI
            // renders a small "Duplicate" tag when present.
            deduped: p.deduped === true,
            addedAt: p.addedAt || null,
            finishedAt: Date.now(),
            error: null,
        });
        _failedJobMeta.delete(p.key);

        // v2.10 — push the new row to every paired peer over /ws/cluster
        // so their cached `peer_downloads` table updates in real time.
        // Lookup the canonical row by (group_id, message_id) so receivers
        // get the same shape as the polling /downloads/since endpoint.
        try {
            const row = getDb()
                .prepare(
                    `SELECT id, group_id, group_name, message_id, file_name, file_size,
                            file_type, file_path, file_hash, status, created_at, nsfw_score
                       FROM downloads WHERE group_id = ? AND message_id = ?
                       ORDER BY id DESC LIMIT 1`,
                )
                .get(String(p.groupId || ''), Number(p.messageId || 0));
            if (row) clusterWs.broadcastClusterEvent('download_added', row);
        } catch {
            /* never fail a download because of a cluster broadcast */
        }
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

// ============ FILE SERVING ============
app.use('/files', createFileServingMiddleware({ broadcast }));

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
    try {
        config = loadConfig();
    } catch (e) {
        if (e.code !== 'ENOENT') console.log('⚠️ Could not read config.json:', e.message);
        return null;
    }
    if (!config.telegram?.apiId || !config.telegram?.apiHash) return null;

    try {
        const sessionString = await loadSession();
        if (!sessionString) return null;
        const stringSession = new StringSession(sessionString);
        telegramClient = new TelegramClient(
            stringSession,
            parseInt(config.telegram.apiId),
            config.telegram.apiHash,
            { connectionRetries: 3, useWSS: false },
        );
        telegramClient.setLogLevel('none');
        await telegramClient.connect();
        if (await telegramClient.isUserAuthorized()) {
            isConnected = true;
            console.log(
                '✅ Telegram connected (legacy single-session client; AccountManager is the canonical source)',
            );
            return telegramClient;
        }
    } catch (error) {
        console.log('⚠️ Telegram connect attempt failed:', error.message);
    }
    return null;
}

// Entity & Photo Helpers — stores `{ entity, client, at }` (NOT bare entity).
// Previous version stored `e` on insert but returned `{entity, client}` on
// cache miss; subsequent cache-hit returns lacked the wrapper, so callers
// reading `.entity` got `undefined` after the first lookup. Bounded by TTL +
// hard cap so a long-running process doesn't grow this Map without bound.
const entityCache = new Map();
const ENTITY_CACHE_TTL_MS = 30 * 60 * 1000;
const ENTITY_CACHE_MAX = 5000;

/** Walk every loaded account looking for one that can resolve `idStr`. */
async function resolveEntityAcrossAccounts(idStr) {
    const cached = entityCache.get(idStr);
    if (cached && Date.now() - cached.at < ENTITY_CACHE_TTL_MS) {
        return { entity: cached.entity, client: cached.client };
    }

    let am;
    try {
        am = await getAccountManager();
    } catch {
        am = null;
    }
    const candidates = [];
    if (am) for (const [, c] of am.clients) candidates.push(c);
    // Legacy single-session client as last resort.
    const legacy = await connectTelegram();
    if (legacy && !candidates.includes(legacy)) candidates.push(legacy);

    const cacheHit = (e, c) => {
        // Hard-cap the cache by evicting the oldest entry on overflow.
        if (entityCache.size >= ENTITY_CACHE_MAX) {
            const firstKey = entityCache.keys().next().value;
            if (firstKey !== undefined) entityCache.delete(firstKey);
        }
        entityCache.set(idStr, { entity: e, client: c, at: Date.now() });
        return { entity: e, client: c };
    };

    for (const c of candidates) {
        try {
            const e = await c.getEntity(idStr);
            if (e) return cacheHit(e, c);
        } catch {}
        try {
            const e = await c.getEntity(BigInt(idStr));
            if (e) return cacheHit(e, c);
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

// Trigger types that change footer/statusbar metrics. Touching any of these
// pokes the debounced `broadcastStatsSoon()` so connected clients receive a
// fresh `stats_update` push without needing to refetch /api/stats.
const _STATS_TRIGGER_TYPES = new Set([
    'bulk_delete',
    'file_deleted',
    'group_purged',
    'purge_all',
    'config_updated',
    'download_complete',
]);

function broadcast(data) {
    const message = JSON.stringify(data);
    for (const client of clients) {
        try {
            if (client.readyState === 1) client.send(message);
        } catch (err) {
            // Ignore send failures (closed/dead connections)
        }
    }
    // Side-channel: if the event meaningfully changed stats, schedule a
    // single recompute + push. Debounce inside broadcastStatsSoon() makes
    // a 50-row bulk delete still cost one stats broadcast, not fifty.
    try {
        if (
            data &&
            typeof data === 'object' &&
            typeof data.type === 'string' &&
            _STATS_TRIGGER_TYPES.has(data.type) &&
            typeof broadcastStatsSoon === 'function'
        ) {
            broadcastStatsSoon();
        }
    } catch {}
}

// ---- In-memory log ring + WS stream ---------------------------------------
//
// `_logBuffer` and LOG_BUFFER_SIZE are declared at the top of the file so
// the early console.* tee can write to them. `log()` is the structured
// entry point; it shares the same ring buffer and broadcasts each entry
// over WS so admin clients can live-tail.
//
// Each entry: { ts:number(ms), source:string, level:'info'|'warn'|'error', msg:string }

function log({ source = 'app', level = 'info', msg = '' }) {
    const entry = _pushLogEntry(level, source, msg);
    try {
        broadcast({ type: 'log', ...entry });
    } catch {}
    // Mirror to stdout/stderr so the docker logs / journald path keeps
    // working — the web view is additive, not a replacement. The console
    // call goes through the wrapped console.* (which would tee back into
    // _logBuffer); guard against the duplicate by tagging this branch
    // with a sentinel suffix the tee can detect — but in practice the
    // duplicate is harmless (same entry shape, sub-millisecond apart) and
    // the simpler path is to skip the mirror when called from log() itself.
    const line = `[${new Date(entry.ts).toISOString()}] [${source}] [${level}] ${entry.msg}`;
    // Bypass the wrapped console so we don't double-record. process.stdout
    // is the un-wrapped underlying writer.
    try {
        if (level === 'error') process.stderr.write(line + '\n');
        else process.stdout.write(line + '\n');
    } catch {}
}

// ---- Shared job-tracker registry -----------------------------------------
//
// One tracker per logical job kind. Defined here so they have access to
// the closures over `broadcast` and `log` declared above. The set is
// referenced from Maintenance + Groups endpoints further up the file.
//
// Per-group purge is keyed dynamically because multi-flight is OK
// across distinct groups (purging chat A and chat B in parallel doesn't
// conflict). Single-flight is enforced per group id.
const _jobTrackers = {
    filesVerify: createJobTracker({
        kind: 'filesVerify',
        broadcast,
        log,
        eventPrefix: 'files_verify',
    }),
    dbVacuum: createJobTracker({ kind: 'dbVacuum', broadcast, log, eventPrefix: 'db_vacuum' }),
    dbIntegrity: createJobTracker({
        kind: 'dbIntegrity',
        broadcast,
        log,
        eventPrefix: 'db_integrity',
    }),
    restartMonitor: createJobTracker({
        kind: 'restartMonitor',
        broadcast,
        log,
        eventPrefix: 'restart_monitor',
    }),
    resyncDialogs: createJobTracker({
        kind: 'resyncDialogs',
        broadcast,
        log,
        eventPrefix: 'resync_dialogs',
    }),
    dedupDelete: createJobTracker({
        kind: 'dedupDelete',
        broadcast,
        log,
        eventPrefix: 'dedup_delete',
    }),
    // Migrated from hand-rolled `let _dedupRunning` flag — prefix kept as
    // 'dedup' so the existing dedup_progress / dedup_done WS listeners on
    // the duplicates page need no change.
    dedupScan: createJobTracker({ kind: 'dedupScan', broadcast, log, eventPrefix: 'dedup' }),
    // Migrated from hand-rolled `let _reindexBgRunning` (which OR'd with
    // integrity.isReindexRunning() — that dual-state snapshot would mask
    // which subsystem owned the job). Prefix 'reindex' preserved.
    reindex: createJobTracker({ kind: 'reindex', broadcast, log, eventPrefix: 'reindex' }),
    nsfwBulk: createJobTracker({ kind: 'nsfwBulk', broadcast, log, eventPrefix: 'nsfw_bulk' }),
    thumbsRebuild: createJobTracker({
        kind: 'thumbsRebuild',
        broadcast,
        log,
        eventPrefix: 'thumbs_rebuild',
    }),
    // Migrated from hand-rolled `let _thumbBuildRunning` — fixed the
    // double-click race where the catch block broadcast `thumbs_done`
    // BEFORE the finally block reset the flag, so a retry after error
    // got a spurious 409 ALREADY_RUNNING. Prefix 'thumbs' preserved.
    thumbsBuild: createJobTracker({ kind: 'thumbsBuild', broadcast, log, eventPrefix: 'thumbs' }),
    seekbarBuild: createJobTracker({
        kind: 'seekbarBuild',
        broadcast,
        log,
        eventPrefix: 'seekbar',
    }),
    seekbarRebuild: createJobTracker({
        kind: 'seekbarRebuild',
        broadcast,
        log,
        eventPrefix: 'seekbar_rebuild',
    }),
    // Same race fix as thumbsBuild — `let _faststartRunning` had the
    // identical broadcast-before-flag-reset window. Prefix 'faststart'
    // preserved so the video page's WS listeners don't change.
    faststart: createJobTracker({ kind: 'faststart', broadcast, log, eventPrefix: 'faststart' }),
    autoUpdate: createJobTracker({ kind: 'autoUpdate', broadcast, log, eventPrefix: 'update' }),
    groupsRefreshInfo: createJobTracker({
        kind: 'groupsRefreshInfo',
        broadcast,
        log,
        eventPrefix: 'groups_refresh_info',
    }),
    groupsRefreshPhotos: createJobTracker({
        kind: 'groupsRefreshPhotos',
        broadcast,
        log,
        eventPrefix: 'groups_refresh_photos',
    }),
    purgeAll: createJobTracker({ kind: 'purgeAll', broadcast, log, eventPrefix: 'purge_all' }),
    recoveryBulk: createJobTracker({
        kind: 'recoveryBulk',
        broadcast,
        log,
        eventPrefix: 'recovery_bulk',
    }),
    // AI subsystem — multiple independent scans owned by the same page.
    // Event prefixes match the WS contract used by maintenance-ai.js:
    // ai_index_progress / ai_index_done, ai_tags_*, ai_people_*, ai_ocr_*, ai_objects_*.
    aiIndex: createJobTracker({ kind: 'aiIndex', broadcast, log, eventPrefix: 'ai_index' }),
    aiTags: createJobTracker({ kind: 'aiTags', broadcast, log, eventPrefix: 'ai_tags' }),
    aiOcr: createJobTracker({ kind: 'aiOcr', broadcast, log, eventPrefix: 'ai_ocr' }),
    aiObjects: createJobTracker({ kind: 'aiObjects', broadcast, log, eventPrefix: 'ai_objects' }),
    aiPeople: createJobTracker({ kind: 'aiPeople', broadcast, log, eventPrefix: 'ai_people' }),
};
// ---- Router mounts (registered here so _jobTrackers + broadcast are in scope)
app.use('/api', createVersionRouter({ broadcast, autoUpdateTracker: _jobTrackers.autoUpdate }));
app.use('/api', createStoriesRouter({ getAccountManager }));
app.use('/api', createQueueRouter({ broadcast }));
app.use('/api', createAuthRouter({ broadcast }));
app.use('/api', createAccountsRouter({ getAccountManager }));
app.use('/api', createMonitorRouter({ getAccountManager }));
app.use(
    '/api',
    createHistoryRouter({
        getAccountManager,
        broadcast,
        log,
        invalidateDialogsCache: _invalidateDialogsCache,
    }),
);
app.use('/api', createAiRouter({ broadcast, log, jobTrackers: _jobTrackers }));
app.use(
    '/api',
    createMaintenanceRouter({
        broadcast,
        log,
        jobTrackers: _jobTrackers,
        getAccountManager,
        resolveEntityAcrossAccounts,
        downloadProfilePhoto,
    }),
);
app.use('/api', createClusterRouter({ broadcast, log }));
app.use('/api', createBackupRouter({ log }));
app.use('/api', createShareLinksRouter({ log }));
app.use(
    '/api',
    createConfigRouter({
        broadcast,
        invalidateDialogsCache: _invalidateDialogsCache,
        invalidateShareConfigCache: _invalidateShareConfigCache,
        refreshRateLimitConfig,
    }),
);
app.use(
    '/api',
    createGroupsRouter({
        broadcast,
        log,
        invalidateDialogsCache: _invalidateDialogsCache,
        getDialogsNameCache,
        dialogsTypeFor,
        resolveEntityAcrossAccounts,
        downloadProfilePhoto,
        jobTrackers: _jobTrackers,
        getAccountManager,
    }),
);

app.use(
    '/api',
    createDownloadsRouter({
        broadcast,
        log,
        jobTrackers: _jobTrackers,
        getDialogsNameCache,
        dialogsTypeFor,
    }),
);
app.use(
    '/api',
    createDialogsRouter({ getAccountManager, getTelegramClient: () => telegramClient }),
);
app.use(
    '/api',
    createStatsRouter({ broadcast, getAccountManager, getIsConnected: () => isConnected }),
);
app.use('/api', createLinkDownloadRouter({ getAccountManager }));

// Snapshot for GET /api/maintenance/logs/recent — newest first, capped.
// Explicit no-store so a sticky proxy (Cloudflare, Caddy with caching) can
// never serve a stale buffer slice; the page must always reflect the live
// in-memory ring.
app.get('/api/maintenance/logs/recent', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    const limit = Math.max(1, Math.min(LOG_BUFFER_SIZE, Number(req.query.limit) || 500));
    const sources = req.query.source ? String(req.query.source).split(',') : null;
    const minLevel = req.query.level || null; // 'info'|'warn'|'error'
    const levelOrder = { info: 0, warn: 1, error: 2 };
    const minLvl = minLevel ? (levelOrder[minLevel] ?? 0) : 0;
    const filtered = _logBuffer.filter((e) => {
        if (sources && !sources.includes(e.source)) return false;
        if ((levelOrder[e.level] ?? 0) < minLvl) return false;
        return true;
    });
    res.json({
        logs: filtered.slice(-limit),
        bufferSize: LOG_BUFFER_SIZE,
        total: _logBuffer.length,
    });
});

wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
});

// Last-resort handler — converts any throw or rejected promise that
// escaped a route into a JSON 500 instead of leaving the response open
// until the reverse proxy times out (manifests as 502 to the client).
// Must be registered after all routes/middleware and before listen().
app.use((err, req, res, _next) => {
    if (res.headersSent) return;
    log({
        source: 'http',
        level: 'error',
        msg: `${req.method} ${req.url} → ${err?.stack || err?.message || err}`,
    });
    res.status(500).json({ error: err?.message || 'Internal Server Error' });
});

const PORT = process.env.PORT || 3000;
// Without this, EADDRINUSE made the container exit silently with no clue
// where to look. Print a clear message + exit non-zero so docker-compose
// surfaces the failure instead of looping a hidden restart.
server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.error(
            `\n[fatal] Port ${PORT} is already in use. Stop the other process or set PORT=<free> in the environment.\n`,
        );
    } else {
        console.error('[fatal] HTTP server error:', e?.message || e);
    }
    process.exit(1);
});
server.listen(PORT, async () => {
    // Backfill group names for existing records
    try {
        const config = loadConfig();
        const updated = backfillGroupNames(config.groups || []);
        if (updated > 0) console.log(`📝 Backfilled group names for ${updated} records`);
    } catch (e) {
        /* config not ready yet */
    }

    // Friendly boot banner. Tells the user where to go and what state we're
    // in (configured vs first-run) instead of dumping a generic header.
    let cfgState = 'first-run';
    try {
        const cfg = loadConfig();
        if (isAuthConfigured(cfg.web)) cfgState = 'ready';
        else if (cfg.telegram?.apiId) cfgState = 'needs-password';
    } catch {
        /* no config → first-run */
    }

    let appVersion = process.env.npm_package_version;
    if (!appVersion) {
        try {
            appVersion = JSON.parse(
                fsSync.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'),
            ).version;
        } catch {
            appVersion = '?';
        }
    }
    const url = `http://localhost:${PORT}`;
    const tip =
        cfgState === 'first-run'
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

    // Seekbar sidecar — auto-spawn the Go binary (or attach to an
    // operator-provided URL). Best-effort; the maintenance page renders
    // the status either way.
    try {
        setSeekbarBroadcast(broadcast);
        startSeekbarSidecar().catch((e) => {
            console.warn('[seekbar-sidecar] start failed:', e?.message || e);
        });
    } catch (e) {
        console.warn('[seekbar-sidecar] wiring failed:', e?.message || e);
    }

    // One-shot v2.x cache migration — collapse the thumb cache from five
    // widths (120 / 200 / 240 / 320 / 480 px) down to a single canonical
    // 320-px width. Pre-upgrade caches still hold the legacy WebPs as
    // dead bytes; this walks the downloads table once and unlinks every
    // legacy-width file. Guarded by a kv flag so it doesn't repeat on
    // every boot. Idempotent if the flag is cleared by hand.
    // Fires inside `setImmediate` so the HTTP listener is already
    // accepting connections before we touch the disk — operators get
    // the dashboard right away; the sweep finishes in the background.
    setImmediate(() => {
        try {
            if (kvGet('thumbs_widths_unified_v1') === true) return;
            purgeNonStandardThumbs()
                .then(({ removed, bytes }) => {
                    kvSet('thumbs_widths_unified_v1', true);
                    if (removed > 0) {
                        console.log(
                            `[thumbs] purged ${removed} legacy-width WebPs (${bytes} bytes freed)`,
                        );
                    }
                })
                .catch((e) => {
                    console.warn('[thumbs] one-shot legacy-width purge failed:', e.message);
                });
        } catch (e) {
            console.warn('[thumbs] one-shot purge guard threw:', e.message);
        }
    });

    // Boot the disk rotator. No-op when diskManagement.enabled is false —
    // safe to call at every startup. Restarts via POST /api/config (above).
    // The `getActiveFilePaths` accessor lets the rotator skip any file the
    // downloader is currently writing — without this, a sweep firing during
    // a slow large download would unlink the .part out from under it,
    // producing the "Downloaded file is empty (0 bytes)" failures we kept
    // seeing in the wild.
    try {
        const rotator = getDiskRotator({
            loadConfig,
            broadcast,
            getActiveFilePaths: () => runtime?._downloader?._activeFilePaths || null,
        });
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
        const integ = cfg?.advanced?.integrity || {};
        integrity.start({
            broadcast,
            intervalMin: Number(integ.intervalMin) > 0 ? Number(integ.intervalMin) : 60,
            batchSize: Number(integ.batchSize) > 0 ? Number(integ.batchSize) : 64,
        });
    } catch (e) {
        console.warn('[integrity] start failed:', e.message);
    }

    // Wire the WS broadcaster for per-file auto-optimise events so the
    // maintenance dashboard can animate its counters live as fresh
    // downloads land. Mirrors the `integrity.start({ broadcast })`
    // injection pattern — the core module stays standalone-runnable
    // (CLI monitor leaves it a no-op).
    try {
        const { setBroadcast: setFaststartBroadcast } = await import('../core/faststart.js');
        setFaststartBroadcast(broadcast);
    } catch (e) {
        console.warn('[faststart] setBroadcast failed:', e.message);
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

    // Backup subsystem — multi-provider mirror + snapshot worker. The
    // manager hooks the runtime's download_complete event so newly-arrived
    // files fan out to every enabled mirror destination automatically.
    // Any persisted destination from a previous boot has its worker
    // restarted (and stuck `uploading` rows reset to `pending`) inside
    // backup.init().
    try {
        backup.init({
            broadcast,
            log,
            getShareSecret: () => {
                try {
                    const cfg = loadConfig();
                    return cfg?.web?.shareSecret || null;
                } catch {
                    return null;
                }
            },
            runtime,
        });
    } catch (e) {
        console.warn('[backup] init failed:', e.message);
    }

    // Pre-fetch the NSFW classifier in the background when the operator
    // has enabled both `advanced.nsfw.enabled` and `advanced.nsfw.preload`.
    // Fire-and-forget — boot is never blocked by the model download.
    try {
        const _nsfw = loadConfig().advanced?.nsfw || {};
        const cfg = { enabled: _nsfw.enabled === true, preload: _nsfw.preload, ..._nsfw };
        if (cfg.enabled && cfg.preload === true) {
            nsfwPreloadClassifier(
                cfg,
                (p) => {
                    try {
                        broadcast({ type: 'nsfw_model_downloading', ...p });
                    } catch {}
                },
                (entry) => log(entry),
            ).catch(() => {
                /* errors land in the realtime log via onLog */
            });
        }
    } catch (e) {
        console.warn('[nsfw] preload-on-boot skipped:', e.message);
    }

    // Auto-spawn the face-clustering Python sidecar. Fire-and-forget — the
    // module handles three modes (docker env, operator override, local
    // spawn) and surfaces every state transition via the `ai_faces_status`
    // WS broadcast plus `getSidecarStatus()` for /api/ai/status.
    import('../core/ai/faces-spawn.js')
        .then((m) => m.startSidecar())
        .catch((e) => {
            console.warn('[ai-faces-spawn] boot skipped:', e?.message || e);
        });

    // Resolve group names from Telegram for any DB records still unnamed
    await resolveGroupNamesFromTelegram({
        getTelegramClient: () => telegramClient,
        getIsConnected: () => isConnected,
    });

    // Auto-start the realtime monitor on container boot when at least one
    // group is enabled and at least one Telegram account is loaded. Lets
    // `docker compose up -d` boot a ready-to-monitor instance without a
    // manual click on Settings → Engine → Start. Opt out via
    // `monitor.autoStart: false` in config.json.
    try {
        const cfg = loadConfig();
        const autoStart = cfg.monitor?.autoStart !== false;
        const enabled = Array.isArray(cfg.groups) && cfg.groups.some((g) => g?.enabled !== false);
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

// Graceful shutdown — Docker / systemd / Ctrl-C send SIGTERM/SIGINT and
// expect the process to exit fast. Without this we just relied on
// `.unref()` on background timers and an OS kill timeout (10 s default
// in Docker), which made `docker compose restart` feel sluggish and
// left WS clients with abrupt connection drops. The 5 s hard-exit
// safety net catches any handle that refuses to release.
let _shuttingDown = false;
async function gracefulShutdown(signal) {
    if (_shuttingDown) return;
    _shuttingDown = true;
    console.log(`\n[shutdown] ${signal} received — cleaning up…`);

    // Stop background sweepers first so their setInterval callbacks
    // don't try to write to a closing DB / broadcast to dead clients.
    try {
        integrity.stop?.();
    } catch (e) {
        console.warn('[shutdown] integrity.stop:', e.message);
    }
    try {
        getRescueSweeper()?.stop();
    } catch (e) {
        console.warn('[shutdown] rescue.stop:', e.message);
    }
    try {
        getDiskRotator()?.stop();
    } catch (e) {
        console.warn('[shutdown] rotator.stop:', e.message);
    }

    // Stop the monitor + its keep-alive ping.
    try {
        if (runtime?.state === 'running') await runtime.stop();
    } catch (e) {
        console.warn('[shutdown] runtime.stop:', e.message);
    }
    try {
        _accountManager?.stopKeepAlive?.();
    } catch (e) {
        console.warn('[shutdown] keep-alive.stop:', e.message);
    }

    // Close every WebSocket so browsers see a clean close-frame instead
    // of a TCP RST and don't spam reconnect attempts during the bounce.
    try {
        for (const c of clients) {
            try {
                c.close(1001, 'server shutting down');
            } catch {}
        }
    } catch {}

    // Stop accepting new HTTP connections; let the in-flight ones drain.
    try {
        server.close(() => process.exit(0));
    } catch {
        process.exit(0);
    }

    // Hard exit if anything refuses to release within 5 s. Anything we
    // hadn't accounted for would otherwise hang the container teardown.
    setTimeout(() => {
        console.warn('[shutdown] forced exit (timed out waiting for handles)');
        process.exit(0);
    }, 5_000).unref?.();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export { broadcast };
