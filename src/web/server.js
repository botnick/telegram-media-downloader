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
import { createRequire } from 'module';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import crypto from 'crypto';

import { getOrGenerateSecret } from '../core/secret.js';
import {
    getDb,
    getDownloads,
    getAllDownloads,
    getStats as getDbStats,
    deleteGroupDownloads,
    deleteAllDownloads,
    backfillGroupNames,
    searchDownloads,
    deleteDownloadsBy,
    createShareLink,
    getShareLinkForServe,
    bumpShareLinkAccess,
    revokeShareLink,
    listShareLinks,
    getNsfwTierCounts,
    getNsfwHistogram,
    getNsfwListByTier,
    getNsfwIdsByTier,
    reclassifyNsfw,
    unwhitelistNsfw,
    NSFW_TIERS,
    setDownloadPinned,
    getDownloadById,
    getAiCounts,
    listPeople,
    listPhotosForPerson,
    renamePerson,
    deletePerson,
    listAllTags,
    listPhotosForTag,
} from '../core/db.js';
import * as ai from '../core/ai/index.js';
import { sanitizeName } from '../core/downloader.js';
import { SecureSession } from '../core/security.js';
import { AccountManager } from '../core/accounts.js';
import { loadConfig, saveConfig } from '../config/manager.js';
import { runtime } from '../core/runtime.js';
import { getDiskRotator } from '../core/disk-rotator.js';
import * as integrity from '../core/integrity.js';
import {
    findDuplicates as dedupFindDuplicates,
    deleteByIds as dedupDeleteByIds,
} from '../core/dedup.js';
import {
    ensureShareSecret,
    verifyShareToken,
    buildShareUrlPath,
    clampTtlSeconds,
    applyShareLimits,
} from '../core/share.js';
import {
    getOrCreateThumb,
    purgeThumbsForDownload,
    purgeAllThumbs,
    getThumbsCacheStats,
    buildAllThumbnails,
    hasFfmpeg,
    ALLOWED_WIDTHS as THUMB_WIDTHS,
} from '../core/thumbs.js';
import {
    startScan as nsfwStartScan,
    cancelScan as nsfwCancelScan,
    isScanRunning as nsfwIsScanRunning,
    getScanState as nsfwGetScanState,
    preloadClassifier as nsfwPreloadClassifier,
    clearClassifierCache as nsfwClearCache,
    classifierReady as nsfwClassifierReady,
    NSFW_DEFAULTS,
    getNsfwStats,
    getNsfwDeleteCandidates,
    whitelistNsfw,
} from '../core/nsfw.js';
import { runAutoUpdate, autoUpdateStatus } from '../core/updater.js';
import { getRescueSweeper } from '../core/rescue.js';
import { getRescueStats } from '../core/db.js';
import * as backup from '../core/backup/index.js';
import { parseTelegramUrl, parseUrlList, UrlParseError } from '../core/url-resolver.js';
import { listUserStories, listAllStories, storyToJob } from '../core/stories.js';
import { metrics } from '../core/metrics.js';
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
    startSessionGc,
} from '../core/web-auth.js';
import { suppressNoise, wrapConsoleMethod } from '../core/logger.js';
import { createJobTracker } from '../core/job-tracker.js';

// Demote gramJS reconnect chatter from stderr/stdout to data/logs/network.log.
// gramJS opens a fresh DC connection per file download (different DCs host
// different media buckets), so a busy monitor logs hundreds of "Disconnecting
// from <ip>:443/TCPFull..." lines per hour through the bare console — which
// drowns out real errors. Both methods are wrapped because gramJS uses
// console.log for most of its lifecycle messages and console.error for the
// occasional warning. TGDL_DEBUG=1 brings them back.
console.log = wrapConsoleMethod(console.log, 'gramjs');
console.error = wrapConsoleMethod(console.error, 'gramjs');
// Native-binary load failures from optional deps must NOT crash the
// process. The most common offender is `onnxruntime-node` (transitive of
// `@huggingface/transformers`, which our optional NSFW classifier uses):
// it ships glibc-only Linux prebuilds, so on musl-based images (alpine)
// the dynamic linker errors with `Error loading shared library
// ld-linux-x86-64.so.2`. We move the dep to optionalDependencies in
// package.json so a default install doesn't pull it at all, but a
// historical install or a re-deploy without `npm prune` may leave the
// broken module on disk. Catch the rejection here, log once, move on.
const NATIVE_LOAD_FAIL =
    /(ld-linux|ld-musl|libonnxruntime|GLIBC_|NODE_MODULE_VERSION|cannot open shared object|Error loading shared library)/i;
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
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
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

// Recursive directory size — used by /api/stats as the fallback when the DB
// catalogue is empty. We can't trust `data/disk_usage.json` alone because
// older builds wrote it sparingly and never invalidated on `Purge all`, so a
// purged dashboard would footer-report a multi-week-old "930 KB" snapshot.
async function scanDirectorySize(dir) {
    let total = 0;
    async function walk(current) {
        let entries;
        try {
            entries = await fs.readdir(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
                continue;
            }
            try {
                const st = await fs.stat(fullPath);
                if (st.isFile()) total += st.size;
            } catch {
                /* file disappeared mid-scan */
            }
        }
    }
    await walk(dir);
    return total;
}

async function writeDiskUsageCache(size) {
    try {
        await fs.writeFile(
            path.join(DATA_DIR, 'disk_usage.json'),
            JSON.stringify({
                size,
                lastScan: Date.now(),
            }),
        );
    } catch {
        /* best-effort cache */
    }
}

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
// imports) should get their own dedicated route with a larger limit.
app.use(express.json({ limit: '256kb' }));

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

// Module-level config cache (definition; the `readConfigSafe` helper that
// uses it is declared further down). Hoisted to ABOVE the share-secret
// bootstrap IIFE because that IIFE awaits `readConfigSafe()` synchronously
// up to its first internal await, and inside the helper we read
// `_configCache.value` immediately — if the `let` below were still in its
// original position (after the IIFE) it would be in TDZ at that read,
// crashing module load with "Cannot access '_configCache' before
// initialization". Logged in the wild as `[share] secret bootstrap deferred`.
let _configCache = { at: 0, value: null };

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

// In-process cache for the config tree. checkAuth + the force-https +
// rate-limit middlewares all call readConfigSafe() on every request —
// during a video playback, the browser issues many 64 KB range GETs to
// /files/* and each one would otherwise hit the kv table. The 2-second
// TTL is short enough that toggle changes feel instant in the settings
// UI but long enough to fold the per-clip request burst into a single
// read. (better-sqlite3 is fast, but a Map lookup is still cheaper.)
//
// Note: the `let _configCache` variable is declared further up (right
// before the share-secret bootstrap IIFE) to dodge a temporal dead-zone
// crash on module load. See the comment there for the why.
async function readConfigSafe() {
    const now = Date.now();
    if (_configCache.value && now - _configCache.at < 2000) return _configCache.value;
    try {
        const value = loadConfig();
        _configCache = { at: now, value };
        return value;
    } catch {
        _configCache = { at: now, value: {} };
        return {};
    }
}
function invalidateConfigCache() {
    _configCache = { at: 0, value: null };
}

// Atomic config writer. Backed by kv['config'] in SQLite — the SQLite
// transaction inside saveConfig() gives us the same all-or-nothing
// guarantee the previous tmp-file + rename pattern provided, with the
// added benefit that other readers see the new tree the instant the
// transaction commits.
async function writeConfigAtomic(config) {
    saveConfig(config);
    invalidateConfigCache();
}

// Paths that may be reached without an authenticated session.
// PWA bits (manifest, service worker, icons) MUST be reachable pre-login
// — the browser fetches them before the user has a session cookie.
const PUBLIC_PATH_PREFIXES = [
    '/login',
    '/setup-needed',
    '/css/',
    '/js/',
    '/locales/',
    '/favicon',
    '/metrics',
    '/icons/',
    '/manifest.webmanifest',
    '/sw.js',
    // Share-link public route — auth is the HMAC sig + DB row check inside
    // the handler, NOT the dashboard cookie. Without this prefix, friends
    // following a share URL would be redirected to /login.html.
    '/share/',
];
const PUBLIC_API_PATHS = new Set([
    '/api/login',
    '/api/auth_check',
    '/api/version', // public so the status-bar chip can render pre-login
    '/api/version/check', // public update-check (GitHub releases poll, cached)
    '/api/auth/setup', // first-run only — guarded inside the handler
    '/api/auth/reset/request', // logs token to stdout — no body returned
    '/api/auth/reset/confirm', // requires the stdout token + new password
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
    return PUBLIC_PATH_PREFIXES.some((pre) => p === pre || p.startsWith(pre));
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
    const session = validateSession(token);
    if (session) {
        req.role = session.role;
        return next();
    }

    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/login.html');
}

// ---- Guest authorization ---------------------------------------------------
//
// Default-deny: guest sessions can ONLY hit the explicit allowlist below.
// Anything else (including endpoints that don't exist yet) returns 403 with
// `adminRequired: true`. This is intentionally a chokepoint instead of
// per-route requireAdmin() — a future dev who adds a new mutation route
// gets admin-gating for free; forgetting to add `requireAdmin` would leak
// the route, which is a much worse failure mode than the occasional 403
// when a new read endpoint forgets to ask for guest access.
// Guest scope: browse downloaded media, view their own files, sign out.
// Operational surfaces (Groups picker, Backfill, Queue, Engine, Maintenance)
// are admin-only on both the front (route gating) and the back (this list).
// Frontend modules that touch these endpoints either skip the call when
// `body[data-role="guest"]` is set, or fail-soft on the 403.
const GUEST_GET_ALLOW = [
    '/api/auth_check',
    '/api/me',
    '/api/version',
    '/api/version/check',
    '/api/downloads', // Library — list + per-group + paginated /all
    '/api/groups', // sidebar list of downloaded folders (no config secrets in the response)
    '/api/stats', // footer disk + file counters
    '/api/thumbs', // GET /api/thumbs/:id — image thumb stream
];
const GUEST_OTHER_ALLOW = new Set(['POST /api/logout']);

function isGuestAllowed(req) {
    // The middleware is mounted at `/api`, so inside this function `req.path`
    // is RELATIVE to the mount point ('/monitor/status' instead of
    // '/api/monitor/status'). The allowlist below is written with full paths
    // for legibility — read the full path from `req.baseUrl + req.path` so
    // the two halves agree. (Pre-fix every guest GET landed here as 403.)
    const fullPath = (req.baseUrl || '') + req.path;
    if (req.method === 'GET') {
        return GUEST_GET_ALLOW.some((pre) => fullPath === pre || fullPath.startsWith(pre + '/'));
    }
    return GUEST_OTHER_ALLOW.has(`${req.method} ${fullPath}`);
}

function guestGate(req, res, next) {
    if (req.role === 'admin') return next();
    if (req.role === 'guest' && isGuestAllowed(req)) return next();
    if (req.role === 'guest') {
        return res.status(403).json({ error: 'Admin only', adminRequired: true });
    }
    // No role on req → checkAuth let the request through as a public path,
    // so don't second-guess it.
    return next();
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
        metrics.inc('tgdl_login_total', 1, {
            result: result.ok ? 'ok' : 'fail',
            role: result.ok ? result.role : 'none',
        });
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

        const { token, maxAgeMs } = issueSession({
            ttlMs: sessionTtlMsFromConfig(config),
            role: result.role,
        });
        res.cookie('tg_dl_session', token, { ...SESSION_COOKIE_OPTS, maxAge: maxAgeMs });
        res.json({ success: true, role: result.role });
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
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
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

        const { token, maxAgeMs } = issueSession({
            ttlMs: sessionTtlMsFromConfig(config),
            role: 'admin',
        });
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
        const session = validateSession(req.cookies['tg_dl_session']);
        if (!session) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        // Guests cannot change the admin password (and have no separate
        // password of their own to change — admin manages the guest hash
        // from the Dashboard Security panel).
        if (session.role !== 'admin') {
            return res.status(403).json({ error: 'Admin only', adminRequired: true });
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
            return res
                .status(409)
                .json({ error: 'No password configured yet — use /api/auth/setup' });
        }
        // Match against the admin hash specifically (loginVerify also accepts
        // a guest password, which would let a stolen guest cookie pivot to
        // admin if we used the broad verifier here).
        const adminMatches = config.web.passwordHash
            ? verifyPassword(currentPassword, config.web.passwordHash)
            : typeof config.web.password === 'string' && currentPassword === config.web.password;
        if (!adminMatches) return res.status(401).json({ error: 'Current password is incorrect' });

        // Reject collisions with the guest password — otherwise admin and
        // guest become indistinguishable at the login form.
        if (
            config.web.guestPasswordHash &&
            verifyPassword(newPassword, config.web.guestPasswordHash)
        ) {
            return res.status(400).json({
                error: 'New password must differ from the guest password',
                code: 'SAME_AS_GUEST',
            });
        }

        config.web.passwordHash = hashPassword(newPassword);
        delete config.web.password;
        await writeConfigAtomic(config);

        // Issue a fresh session and let the SPA replace the old cookie. We
        // don't revoke other sessions automatically — the SPA exposes a
        // separate "Sign out everywhere" affordance that hits revokeAllSessions.
        const { token, maxAgeMs } = issueSession({
            ttlMs: sessionTtlMsFromConfig(config),
            role: 'admin',
        });
        res.cookie('tg_dl_session', token, { ...SESSION_COOKIE_OPTS, maxAge: maxAgeMs });
        res.json({ success: true });
    } catch (e) {
        console.error('change-password:', e);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ====== Guest password (admin-managed) =====================================
//
// One slot for an optional read-only "guest" role alongside the admin
// password. Stored under config.web.guestPasswordHash + config.web.guestEnabled.
// Guests can browse the gallery and watch media but cannot mutate state
// (the guestGate middleware enforces this server-side).
//
// Body (one field required):
//   { password }    → hash + store, set guestEnabled=true
//   { enabled }     → flip the guestEnabled flag (revokes all guest sessions
//                     when turning off so existing guest cookies stop working
//                     immediately)
//   { clear: true } → wipe the hash + disable + revoke
app.post('/api/auth/guest-password', async (req, res) => {
    try {
        // Registered before the global checkAuth middleware (same as all
        // /api/auth/* routes), so enforce auth + admin role explicitly here.
        const session = validateSession(req.cookies['tg_dl_session']);
        if (!session) return res.status(401).json({ error: 'Unauthorized' });
        if (session.role !== 'admin') {
            return res.status(403).json({ error: 'Admin only', adminRequired: true });
        }
        const { password, enabled, clear } = req.body || {};
        const config = await readConfigSafe();
        if (!config.web) config.web = {};

        if (clear === true) {
            delete config.web.guestPasswordHash;
            config.web.guestEnabled = false;
            await writeConfigAtomic(config);
            revokeAllGuestSessions();
            broadcast({ type: 'config_updated' });
            return res.json({ success: true, configured: false, enabled: false });
        }

        if (typeof password === 'string' && password.length > 0) {
            if (password.length < 8) {
                return res
                    .status(400)
                    .json({ error: 'Guest password must be at least 8 characters' });
            }
            // Reject equality with the admin password — otherwise the guest
            // role can never actually be reached from the login form.
            const adminHash = config.web.passwordHash;
            const adminMatches = adminHash
                ? verifyPassword(password, adminHash)
                : typeof config.web.password === 'string' && password === config.web.password;
            if (adminMatches) {
                return res.status(400).json({
                    error: 'Guest password must differ from the admin password',
                    code: 'SAME_AS_ADMIN',
                });
            }
            config.web.guestPasswordHash = hashPassword(password);
            config.web.guestEnabled = true;
            await writeConfigAtomic(config);
            // Any guest signed in with the previous password should be
            // bounced — same posture as admin password change.
            revokeAllGuestSessions();
            broadcast({ type: 'config_updated' });
            return res.json({ success: true, configured: true, enabled: true });
        }

        if (typeof enabled === 'boolean') {
            if (!config.web.guestPasswordHash && enabled) {
                return res
                    .status(400)
                    .json({ error: 'Set a guest password before enabling guest access' });
            }
            config.web.guestEnabled = enabled;
            await writeConfigAtomic(config);
            if (!enabled) revokeAllGuestSessions();
            broadcast({ type: 'config_updated' });
            return res.json({
                success: true,
                configured: !!config.web.guestPasswordHash,
                enabled,
            });
        }

        return res.status(400).json({ error: 'Provide one of: password, enabled, clear' });
    } catch (e) {
        console.error('guest-password:', e);
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
            return res
                .status(409)
                .json({ error: 'No password configured yet — use /api/auth/setup' });
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
        const { token: sessionTok, maxAgeMs } = issueSession({
            ttlMs: sessionTtlMsFromConfig(config),
            role: 'admin',
        });
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
function _readCurrentVersion() {
    if (process.env.npm_package_version) return process.env.npm_package_version;
    try {
        return JSON.parse(fsSync.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'))
            .version;
    } catch {
        return 'unknown';
    }
}

app.get('/api/version', (req, res) => {
    res.json({
        version: _readCurrentVersion(),
        commit: (process.env.GIT_SHA || 'dev').slice(0, 7),
        builtAt: process.env.BUILT_AT || null,
    });
});

// Update-check: poll the GitHub Releases API for the latest tag, cache it for
// 6 hours, and tell the SPA whether a newer version is out. Fail-soft — any
// network/parse error returns updateAvailable:false and we keep serving the
// last-known good answer (marked stale) so a flaky GitHub doesn't blank the
// status-bar chip. Public path so the chip can render pre-login.
//
// TTL evolution: 6 h (initial) → 1 h (v2.3.11) → 10 min (v2.3.12) after
// the user asked for "near-real-time" notifications. 6 upstream calls
// per hour per instance is comfortably under GitHub's 60-req-per-hour
// unauthenticated rate limit (cache is shared across all clients of
// one instance — multiple browser tabs / users behind the same dashboard
// hit the same in-memory cache). Combined with the
// `current >= cached_latest` bypass below, an instance running the
// freshly-shipped version always re-checks immediately rather than
// trusting a now-stale "no update" answer from the previous window.
const UPDATE_CHECK_TTL_MS = 10 * 60 * 1000;
const UPDATE_CHECK_REPO = 'botnick/telegram-media-downloader';
let _updateCache = { fetchedAt: 0, data: null };

function _cmpSemver(a, b) {
    const norm = (s) =>
        String(s || '')
            .replace(/^v/i, '')
            .split('-')[0]
            .split('.')
            .map((n) => parseInt(n, 10) || 0);
    const A = norm(a),
        B = norm(b);
    const len = Math.max(A.length, B.length);
    for (let i = 0; i < len; i++) {
        const x = A[i] || 0,
            y = B[i] || 0;
        if (x > y) return 1;
        if (x < y) return -1;
    }
    return 0;
}

async function _fetchLatestRelease() {
    if (typeof fetch !== 'function') return null;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    try {
        const r = await fetch(`https://api.github.com/repos/${UPDATE_CHECK_REPO}/releases/latest`, {
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'tgdl-update-check' },
            signal: ctrl.signal,
        });
        if (!r.ok) return null;
        const j = await r.json();
        return {
            tag: j.tag_name,
            name: j.name || j.tag_name,
            url: j.html_url,
            publishedAt: j.published_at,
        };
    } catch {
        return null;
    } finally {
        clearTimeout(t);
    }
}

app.get('/api/version/check', async (req, res) => {
    const current = _readCurrentVersion();
    const now = Date.now();
    const force = req.query.force === '1';
    if (!force && _updateCache.data && now - _updateCache.fetchedAt < UPDATE_CHECK_TTL_MS) {
        const { latest } = _updateCache.data;
        // Bypass the cache when the running container is at-or-newer
        // than the cached "latest". That state means we just rolled
        // forward (e.g. user pulled v2.3.10 while cache still says
        // v2.3.7); the cached "no update" answer is informationally
        // stale and would mask any release shipped in the meantime.
        // Re-fetch instead of trusting the cache.
        if (_cmpSemver(current, latest) >= 0) {
            // fall through to re-fetch
        } else {
            const updateAvailable = _cmpSemver(latest, current) > 0;
            return res.json({ current, ..._updateCache.data, updateAvailable, cached: true });
        }
    }
    const latest = await _fetchLatestRelease();
    if (!latest) {
        if (_updateCache.data) {
            const updateAvailable = _cmpSemver(_updateCache.data.latest, current) > 0;
            return res.json({
                current,
                ..._updateCache.data,
                updateAvailable,
                cached: true,
                stale: true,
            });
        }
        return res.json({ current, latest: null, updateAvailable: false, error: 'unreachable' });
    }
    const data = {
        latest: latest.tag,
        latestName: latest.name,
        releaseUrl: latest.url,
        publishedAt: latest.publishedAt,
    };
    _updateCache = { fetchedAt: now, data };
    res.json({
        current,
        ...data,
        updateAvailable: _cmpSemver(latest.tag, current) > 0,
        cached: false,
    });
});

// ====== Auto-update (Docker via watchtower sidecar) ========================
//
// `GET /api/update/status` — capability probe. Returns `{ available, …reasons }`
// so the SPA can render either the active "Install update" button or a
// disabled state with a help tooltip ("enable the auto-update profile in
// docker-compose.yml…").
//
// `POST /api/update` — admin-only kickoff. Snapshots the SQLite DB into
// `data/backups/`, then signals the watchtower sidecar to pull + recreate
// this container. Returns 200 immediately; the actual swap happens out of
// band moments later (the SPA's WS reconnect logic detects the cycle).
app.get('/api/update/status', async (req, res) => {
    res.json(autoUpdateStatus());
});

app.post('/api/update', async (req, res) => {
    const tracker = _jobTrackers.autoUpdate;
    const r = tracker.tryStart(async () => {
        const result = await runAutoUpdate();
        // Heads-up to every open tab — fires BEFORE watchtower kills us so
        // the toast shows up while the WS is still alive. The SPA's
        // existing reconnect logic handles the gap; the new container's
        // healthcheck has to pass before it's reachable. Kept alongside
        // the standard `update_done` event the JobTracker emits.
        try {
            broadcast({ type: 'update_started', backup: result.backup });
        } catch {}
        return { backup: result.backup };
    });
    if (!r.started) {
        return res
            .status(409)
            .json({ error: 'An update is already in progress', code: 'ALREADY_RUNNING' });
    }
    res.json({ success: true, started: true });
});

app.get('/api/auto-update/status', async (req, res) => {
    res.json(_jobTrackers.autoUpdate.getStatus());
});

app.get('/api/auth_check', async (req, res) => {
    const config = await readConfigSafe();
    const configured = isAuthConfigured(config.web);
    const enabled = config.web?.enabled !== false;
    const session = configured && enabled ? validateSession(req.cookies['tg_dl_session']) : false;
    res.json({
        configured,
        enabled,
        authenticated: !!session,
        // Role surfaced so the SPA can mark `<body data-role>` and hide
        // admin-only UI for guest sessions in a single source-of-truth pass.
        role: session ? session.role : null,
        setupRequired: !configured || !enabled,
        guestEnabled: isGuestEnabled(config.web),
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

// 0. Accounts API — List saved accounts with metadata
app.get('/api/accounts', async (req, res) => {
    try {
        const sessionsDir = path.join(DATA_DIR, 'sessions');
        if (!existsSync(sessionsDir)) {
            return res.json([]);
        }
        const files = fsSync
            .readdirSync(sessionsDir)
            .filter((f) => f.endsWith('.enc'))
            .sort((a, b) => {
                const statA = fsSync.statSync(path.join(sessionsDir, a));
                const statB = fsSync.statSync(path.join(sessionsDir, b));
                return statA.mtimeMs - statB.mtimeMs;
            });

        // Try to load metadata from config
        const config = loadConfig();
        const configAccounts = config.accounts || [];

        const accounts = files.map((f, index) => {
            const id = path.basename(f, '.enc');
            const meta = configAccounts.find((a) => a.id === id) || {};
            return {
                id,
                name: meta.name || id,
                username: meta.username || '',
                phone: meta.phone || '',
                isDefault: index === 0,
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
            body: {
                error: 'Telegram API credentials not configured. Add telegram.apiId and telegram.apiHash in Settings first.',
                code: 'NO_API_CREDS',
            },
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
    const limit = ceiling > 0 ? Math.min(ceiling * 10, 50000) : null;
    _spawnInternalBackfill({
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

// Build the monitor-status snapshot. Used by both the GET endpoint
// (for the SPA's first paint / a manual refresh) AND the periodic
// WS broadcaster below — keeping them on one code path so a future
// field never lands in one place but not the other.
async function _buildMonitorStatusSnapshot() {
    const status = runtime.status();
    if (status.accounts === 0) {
        try {
            const am = await getAccountManager();
            status.accounts = am.count;
        } catch {
            try {
                const dir = path.join(DATA_DIR, 'sessions');
                if (existsSync(dir)) {
                    status.accounts = fsSync
                        .readdirSync(dir)
                        .filter((f) => f.endsWith('.enc')).length;
                }
            } catch {
                /* ignore */
            }
        }
    }
    const config = await readConfigSafe();
    status.hint =
        !config.telegram?.apiId || !config.telegram?.apiHash
            ? 'configure-api'
            : status.accounts === 0
              ? 'add-account'
              : (config.groups || []).filter((g) => g.enabled).length === 0
                ? 'enable-group'
                : null;
    return status;
}

app.get('/api/monitor/status', async (req, res) => {
    res.json(await _buildMonitorStatusSnapshot());
});

// Push the monitor-status snapshot every 3 s so the SPA's status-bar
// queue / active counters update live without polling. Skip the
// broadcast when nobody's connected (no WS clients) — saves a DB hit
// the SPA wouldn't have asked for. Coalesces across overlapping
// async builds via the in-flight flag.
let _statusPushBusy = false;
async function _pushMonitorStatus() {
    if (_statusPushBusy || clients.size === 0) return;
    _statusPushBusy = true;
    try {
        const snap = await _buildMonitorStatusSnapshot();
        broadcast({ type: 'monitor_status_push', payload: snap });
    } catch {
        /* best-effort */
    } finally {
        _statusPushBusy = false;
    }
}
const _monitorStatusTimer = setInterval(_pushMonitorStatus, 3000);
_monitorStatusTimer.unref?.();

// Push the gallery /api/stats snapshot every 30 s. Less frequent than
// monitor/status because the numbers (total files, disk usage) only
// change when downloads finish — and those events already trigger an
// SPA refresh of their own. This is the safety net for a long-idle
// session where the user wandered to another tab.
let _statsPushBusy = false;
async function _pushStats() {
    if (_statsPushBusy || clients.size === 0) return;
    _statsPushBusy = true;
    try {
        const dbStats = getDbStats();
        const total = Number(dbStats.totalSize) || 0;
        broadcast({
            type: 'stats_push',
            payload: {
                totalFiles: dbStats.totalFiles,
                totalSize: total,
                diskUsage: total,
                diskUsageFormatted: formatBytes(total),
            },
        });
    } catch {
        /* best-effort */
    } finally {
        _statsPushBusy = false;
    }
}
const _statsPushTimer = setInterval(_pushStats, 30000);
_statsPushTimer.unref?.();

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
// Resolved from config.advanced.history.retentionDays at every call so a
// `config_updated` save changes the prune cutoff without a restart.
// Spec default = 30 days.
function historyRetentionMs() {
    try {
        const days = Number(loadConfig().advanced?.history?.retentionDays);
        if (Number.isFinite(days) && days >= 1 && days <= 3650) {
            return days * 24 * 60 * 60 * 1000;
        }
    } catch {}
    return 30 * 24 * 60 * 60 * 1000;
}

// jobId → { id, state, processed, downloaded, error, group, groupId, limit,
//           startedAt, finishedAt, cancelled, _runner }
// `_runner` is stripped before serialising to disk (it's the live downloader).
const _historyJobs = new Map();

async function loadHistoryJobsFromDisk() {
    try {
        const raw = await fs.readFile(HISTORY_JOBS_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const cutoff = Date.now() - historyRetentionMs();
        return parsed.filter((j) => j && (j.finishedAt || j.startedAt || 0) >= cutoff);
    } catch {
        return [];
    }
}

async function saveHistoryJobsToDisk() {
    // Snapshot finished jobs (state !== running) without the _runner ref.
    const finished = Array.from(_historyJobs.values())
        .filter((j) => j.state !== 'running')
        .map(({ _runner, ...rest }) => rest);
    // Merge with anything still on disk that isn't in memory (older history).
    const onDisk = await loadHistoryJobsFromDisk();
    const byId = new Map();
    for (const j of onDisk) byId.set(j.id, j);
    for (const j of finished) byId.set(j.id, j);
    const cutoff = Date.now() - historyRetentionMs();
    const all = Array.from(byId.values())
        .filter((j) => (j.finishedAt || j.startedAt || 0) >= cutoff)
        .sort((a, b) => (b.finishedAt || b.startedAt || 0) - (a.finishedAt || a.startedAt || 0));
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.writeFile(HISTORY_JOBS_PATH, JSON.stringify(all, null, 2), 'utf-8');
    } catch (e) {
        console.error('history-jobs.json write failed:', e?.message || e);
    }
}

// Module-level guard: at most ONE backfill per groupId at any time.
// Without this, a fast double-click on Backfill spawns two HistoryDownloader
// instances against the same group → two parallel iterations of the same
// Telegram timeline, two streams of `getMessages` calls, doubled FloodWait
// risk. The instances would still produce no duplicate downloads (the DB's
// UNIQUE(group_id, message_id) catches them), but the API churn is wasted.
const _activeBackfillsByGroup = new Map(); // groupId(string) → jobId(string)

app.post('/api/history', async (req, res) => {
    try {
        const { groupId, limit = 100, offsetId = 0, mode } = req.body || {};
        if (!groupId) return res.status(400).json({ error: 'groupId required' });
        const groupKey = String(groupId);
        if (_activeBackfillsByGroup.has(groupKey)) {
            return res.status(409).json({
                error: 'A backfill is already running for this group',
                code: 'ALREADY_RUNNING',
                jobId: _activeBackfillsByGroup.get(groupKey),
            });
        }
        // limit === 0 (or "0") means "no limit" → backfill the entire history.
        // Anything else is clamped into a sane positive range.
        const limRaw = parseInt(limit, 10);
        const lim =
            limRaw === 0
                ? null
                : Math.max(1, Math.min(50000, Number.isFinite(limRaw) ? limRaw : 100));

        const am = await getAccountManager();
        if (am.count === 0) return res.status(409).json({ error: 'No Telegram accounts loaded' });

        const config = loadConfig();
        const group = (config.groups || []).find((g) => String(g.id) === String(groupId));
        if (!group) return res.status(404).json({ error: 'Group not configured' });

        const { HistoryDownloader } = await import('../core/history.js');
        const { DownloadManager } = await import('../core/downloader.js');
        const { RateLimiter } = await import('../core/security.js');

        const standalone = !runtime._downloader;
        const downloader =
            runtime._downloader ||
            new DownloadManager(am.getDefaultClient(), config, new RateLimiter(config.rateLimits));
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
        _activeBackfillsByGroup.set(groupKey, jobId);

        history.on('progress', (s) => {
            job.processed = s.processed;
            job.downloaded = s.downloaded;
            broadcast({
                type: 'history_progress',
                jobId,
                ...s,
                group: group.name,
                groupId: job.groupId,
                limit: job.limit,
                startedAt: job.startedAt,
                mode: job.mode || 'pull-older',
            });
        });
        // Mirror the chosen mode onto the job so the UI shows it ("pull
        // older" / "catch up" / "rescan") even after the worker exits.
        history.on('start', (s) => {
            if (s?.mode) job.mode = s.mode;
        });

        history
            .downloadHistory(groupId, {
                limit: lim ?? undefined,
                offsetId: parseInt(offsetId, 10) || 0,
                mode: mode === 'catch-up' || mode === 'rescan' ? mode : 'pull-older',
            })
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
                // Release the per-group lock so a new backfill can spawn.
                if (_activeBackfillsByGroup.get(groupKey) === jobId) {
                    _activeBackfillsByGroup.delete(groupKey);
                }
                // Drop the in-memory entry after a grace window so the UI has
                // time to grab it via /api/history/jobs.
                setTimeout(() => _historyJobs.delete(jobId), 5 * 60 * 1000);
            })
            .catch((err) => {
                job.state = 'error';
                job.error = err?.message || String(err);
                job.finishedAt = Date.now();
                delete job._runner;
                broadcast({
                    type: 'history_error',
                    jobId,
                    error: job.error,
                    group: group.name,
                    groupId: job.groupId,
                });
                // Surface the failure on the realtime log channel so the
                // operator sees WHY a backfill flashed red instead of just
                // "it failed". Hint when the message points at account
                // access — easy to misread as "downloader is broken" when
                // the real fix is "log in to a Telegram account that's a
                // member of the group". Common causes hit by this branch:
                // session expired, account left the group, FloodWait
                // bouncing all retries, group went private.
                const hint = /no available account/i.test(job.error)
                    ? ' (no logged-in account can read this group — check Settings → Telegram Accounts and make sure at least one is a member)'
                    : '';
                log({
                    source: 'backfill',
                    level: 'error',
                    msg: `backfill failed for "${group.name}" (${group.id}): ${job.error}${hint}`,
                });
                if (standalone) downloader.stop().catch(() => {});
                saveHistoryJobsToDisk().catch(() => {});
                if (_activeBackfillsByGroup.get(groupKey) === jobId) {
                    _activeBackfillsByGroup.delete(groupKey);
                }
            });

        log({
            source: 'backfill',
            level: 'info',
            msg: `backfill started for "${group.name}" (${group.id}) — limit=${lim} mode=${job.mode || 'pull-older'}`,
        });
        res.json({
            success: true,
            jobId,
            group: group.name,
            limit: lim,
            mode: job.mode || 'pull-older',
        });
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
            (a, b) => (b.startedAt || 0) - (a.startedAt || 0),
        );
        const recent = all.filter((j) => j.state !== 'running').slice(0, 30);
        res.json({
            active: all.filter((j) => j.state === 'running'),
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

// Remove a single finished history entry from the Recent backfills list.
// Running jobs cannot be deleted — they have to be cancelled first.
app.delete('/api/history/:jobId', async (req, res) => {
    try {
        const id = req.params.jobId;
        const inMem = _historyJobs.get(id);
        if (inMem && inMem.state === 'running') {
            return res.status(409).json({ error: 'Cannot delete a running job — cancel first.' });
        }
        if (inMem) _historyJobs.delete(id);

        // Drop from on-disk store too. Atomic write via fs.writeFile (the
        // existing saveHistoryJobsToDisk pattern handles concurrency by
        // reading + filtering + writing in one tick).
        const onDisk = await loadHistoryJobsFromDisk();
        const filtered = onDisk.filter((j) => j.id !== id);
        try {
            await fs.mkdir(DATA_DIR, { recursive: true });
            await fs.writeFile(HISTORY_JOBS_PATH, JSON.stringify(filtered, null, 2), 'utf-8');
        } catch (e) {
            console.error('history-jobs.json write failed:', e?.message || e);
        }

        broadcast({ type: 'history_deleted', jobId: id });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Clear every finished entry from the Recent backfills list. Running jobs
// are preserved — same posture as the per-row delete (cancel first).
app.delete('/api/history', async (req, res) => {
    try {
        let removed = 0;
        for (const [id, job] of Array.from(_historyJobs.entries())) {
            if (job.state !== 'running') {
                _historyJobs.delete(id);
                removed++;
            }
        }
        // Wipe the on-disk store of finished jobs.
        try {
            await fs.mkdir(DATA_DIR, { recursive: true });
            await fs.writeFile(HISTORY_JOBS_PATH, JSON.stringify([], null, 2), 'utf-8');
        } catch (e) {
            console.error('history-jobs.json wipe failed:', e?.message || e);
        }
        broadcast({ type: 'history_cleared' });
        res.json({ success: true, removed });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
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
    } catch {
        /* first-run, no file yet */
    }
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
            await fs.writeFile(
                QUEUE_HISTORY_PATH,
                JSON.stringify(_queueHistory.slice(0, QUEUE_HISTORY_CAP)),
                'utf-8',
            );
        } catch (e) {
            console.error('queue-history.json write failed:', e?.message || e);
        }
    }, 1500).unref?.();
}

function pushQueueHistory(entry) {
    if (!entry || !entry.key) return;
    // Dedup by key — last write wins so a retry → success replaces the
    // old failed row instead of stacking duplicates.
    _queueHistory = [entry, ..._queueHistory.filter((e) => e.key !== entry.key)].slice(
        0,
        QUEUE_HISTORY_CAP,
    );
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
        const snap = dl
            ? dl.snapshot()
            : {
                  active: [],
                  queued: [],
                  globalPaused: false,
                  pausedCount: 0,
                  workers: 0,
                  pending: 0,
              };
        res.json({
            ...snap,
            recent: _queueHistory.slice(0, QUEUE_HISTORY_CAP),
            engineRunning: runtime.state === 'running',
            maxSpeed: runtime._downloader?.config?.download?.maxSpeed || null,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/queue/pause-all', (req, res) => {
    const dl = requireDownloader(res);
    if (!dl) return;
    dl.pauseAll();
    broadcast({ type: 'queue_changed', payload: { op: 'pause-all' } });
    res.json({ success: true });
});

app.post('/api/queue/resume-all', (req, res) => {
    const dl = requireDownloader(res);
    if (!dl) return;
    dl.resumeAll();
    broadcast({ type: 'queue_changed', payload: { op: 'resume-all' } });
    res.json({ success: true });
});

app.post('/api/queue/cancel-all', (req, res) => {
    const dl = requireDownloader(res);
    if (!dl) return;
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
    const dl = requireDownloader(res);
    if (!dl) return;
    const key = decodeURIComponent(req.params.key);
    const ok = dl.pauseJob(key);
    broadcast({ type: 'queue_changed', payload: { op: 'pause', key } });
    res.json({ success: ok });
});

app.post('/api/queue/:key/resume', (req, res) => {
    const dl = requireDownloader(res);
    if (!dl) return;
    const key = decodeURIComponent(req.params.key);
    const ok = dl.resumeJob(key);
    broadcast({ type: 'queue_changed', payload: { op: 'resume', key } });
    res.json({ success: ok });
});

app.post('/api/queue/:key/cancel', async (req, res) => {
    const dl = requireDownloader(res);
    if (!dl) return;
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
    const dl = requireDownloader(res);
    if (!dl) return;
    const key = decodeURIComponent(req.params.key);
    const meta = _failedJobMeta.get(key);
    if (!meta) {
        // No cached job means we never saw the original message — surface
        // a friendly error instead of silently doing nothing. The caller
        // can fall back to re-pasting the link from the viewer.
        return res.status(404).json({
            error: 'Cannot retry: original job no longer in memory. Re-trigger from the source (link / backfill / monitor).',
        });
    }
    dl.retryJob(meta);
    broadcast({ type: 'queue_changed', payload: { op: 'retry', key } });
    res.json({ success: true });
});

// Retry every failed job we still have a cached message for. Skips rows
// whose source message has already aged out of `_failedJobMeta` (cleared
// by `clear-finished` or evicted on engine restart) — surfaced as
// `skipped` in the response so the UI can toast "retried N, skipped M".
app.post('/api/queue/retry-all', (req, res) => {
    const dl = requireDownloader(res);
    if (!dl) return;
    let retried = 0;
    const skippedKeys = [];
    for (const [key, meta] of _failedJobMeta) {
        if (!meta) {
            skippedKeys.push(key);
            continue;
        }
        try {
            dl.retryJob(meta);
            retried++;
        } catch (e) {
            skippedKeys.push(key);
        }
    }
    broadcast({ type: 'queue_changed', payload: { op: 'retry-all', retried } });
    res.json({ success: true, retried, skipped: skippedKeys.length });
});

// Multi-row batch action. Single endpoint instead of "POST /batch/pause",
// "POST /batch/resume" etc. so the client can fire one request per user
// gesture regardless of which action the floating bar invoked. Continues
// past per-row failures so a single missing key (e.g. just-completed
// between snapshot and click) doesn't abort the whole batch.
app.post('/api/queue/batch', async (req, res) => {
    const dl = requireDownloader(res);
    if (!dl) return;
    const { keys, action } = req.body || {};
    if (!Array.isArray(keys) || keys.length === 0) {
        return res.status(400).json({ error: 'keys must be a non-empty array' });
    }
    const ALLOWED = new Set(['pause', 'resume', 'cancel', 'retry', 'dismiss']);
    if (!ALLOWED.has(action)) {
        return res
            .status(400)
            .json({ error: `action must be one of: ${Array.from(ALLOWED).join(', ')}` });
    }
    let ok = 0;
    const failed = [];
    for (const rawKey of keys) {
        const key = String(rawKey || '');
        if (!key) {
            failed.push({ key: rawKey, reason: 'empty key' });
            continue;
        }
        try {
            if (action === 'pause') {
                if (dl.pauseJob(key)) ok++;
                else failed.push({ key, reason: 'not pausable' });
            } else if (action === 'resume') {
                if (dl.resumeJob(key)) ok++;
                else failed.push({ key, reason: 'not paused' });
            } else if (action === 'cancel') {
                dl.cancelJob(key);
                _failedJobMeta.delete(key);
                ok++;
            } else if (action === 'retry') {
                const meta = _failedJobMeta.get(key);
                if (!meta) {
                    failed.push({ key, reason: 'meta evicted' });
                    continue;
                }
                dl.retryJob(meta);
                ok++;
            } else if (action === 'dismiss') {
                _failedJobMeta.delete(key);
                ok++;
            }
        } catch (e) {
            failed.push({ key, reason: e?.message || 'unknown' });
        }
    }
    // One coalesced WS frame instead of N. The Queue page already has
    // per-row WS hooks (queue_changed/pause/resume/cancel/retry) firing
    // through the downloader's emit chain — this is a hint to the SPA
    // that "a batch happened" so it can refresh aggregates / pill counts
    // in one tick.
    broadcast({
        type: 'queue_changed',
        payload: { op: 'batch', action, ok, failed: failed.length },
    });
    res.json({ success: true, ok, failed });
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
        const r = await client.invoke(
            new (await import('telegram')).Api.stories.GetPeerStories({ peer: entity }),
        );
        const stories = r?.stories?.stories || [];
        const wanted = new Set(storyIds.map(Number));
        const matched = stories.filter((s) => wanted.has(Number(s.id)));

        const { DownloadManager } = await import('../core/downloader.js');
        const { RateLimiter } = await import('../core/security.js');
        const config = loadConfig();
        const standalone = !runtime._downloader;
        const downloader =
            runtime._downloader ||
            new DownloadManager(client, config, new RateLimiter(config.rateLimits));
        if (standalone) {
            await downloader.init();
            downloader.start();
        }

        const storiesAccountId = am.getIdForClient(client);
        const storiesMeta = storiesAccountId ? am.metadata?.get?.(storiesAccountId) : null;
        const storiesAccountName =
            storiesMeta?.name ||
            storiesMeta?.username ||
            storiesMeta?.phone ||
            (storiesAccountId ? `#${storiesAccountId}` : null);
        let queued = 0;
        for (const story of matched) {
            const job = storyToJob({
                peer: entity,
                story,
                peerLabel: entity.username || entity.firstName || username,
            });
            job.client = client;
            job.accountId = storiesAccountId || null;
            job.accountName = storiesAccountName || null;
            if (await downloader.enqueue(job, 1)) queued++;
        }
        if (standalone) {
            (async () => {
                while (downloader.pendingCount > 0 || downloader.active.size > 0) {
                    await new Promise((r) => setTimeout(r, 1000));
                }
                downloader.stop().catch(() => {});
            })().catch((e) => console.warn('[stories] standalone drain failed:', e?.message || e));
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
    /^127\./, // 127.0.0.0/8
    /^10\./, // 10.0.0.0/8
    /^192\.168\./, // 192.168.0.0/16
    /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
    /^169\.254\./, // 169.254.0.0/16 link-local
    /^0\./, // 0.0.0.0/8
    /^22[4-9]\./,
    /^23\d\./, // multicast
    /^::1$/,
    /^fe80:/i,
    /^fc00:/i,
    /^fd[0-9a-f]{2}:/i,
];

function isPrivateHost(host) {
    if (!host) return true;
    const lower = host.toLowerCase();
    if (lower === 'localhost' || lower.endsWith('.local') || lower.endsWith('.internal'))
        return true;
    return SSRF_BLOCKLIST.some((re) => re.test(host));
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
        if (done) return;
        done = true;
        try {
            sock.destroy();
        } catch {}
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
        if (
            mime.includes('gif') ||
            (doc.attributes || []).some((a) => a.className === 'DocumentAttributeAnimated')
        )
            return 'gifs';
        if (mime.includes('image/webp') || mime.includes('application/x-tgsticker'))
            return 'stickers';
        return 'documents';
    }
    return null;
}

app.post('/api/download/url', async (req, res) => {
    try {
        const { url, urls } = req.body || {};
        const list = Array.isArray(urls) ? urls : url ? parseUrlList(url) : [];
        if (!list.length) return res.status(400).json({ error: 'Provide url or urls' });

        const am = await getAccountManager();
        if (am.count === 0) return res.status(409).json({ error: 'No Telegram accounts loaded' });

        const { DownloadManager } = await import('../core/downloader.js');
        const { RateLimiter } = await import('../core/security.js');

        const config = loadConfig();
        const standalone = !runtime._downloader;
        const downloader =
            runtime._downloader ||
            new DownloadManager(am.getDefaultClient(), config, new RateLimiter(config.rateLimits));
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
                    } catch {
                        /* try next */
                    }
                }
                if (!resolved) {
                    results.push({
                        url: raw,
                        ok: false,
                        error: 'No account could read the message',
                    });
                    continue;
                }

                const mediaType = detectMediaType(resolved.message);
                if (!mediaType) {
                    results.push({
                        url: raw,
                        ok: false,
                        error: 'Message has no downloadable media',
                    });
                    continue;
                }

                const groupId = String(resolved.entity.id);
                const groupName =
                    resolved.entity.title ||
                    resolved.entity.username ||
                    resolved.entity.firstName ||
                    groupId;
                // Pin the resolver's client to this job. We used to mutate
                // `downloader.client` here, but that race-condition'd any
                // concurrent download — every in-flight job suddenly tried
                // to fetch bytes through the URL-resolver's session. Per-
                // job `client` lets each download stick to the session that
                // can actually read the message.
                const accountId = am.getIdForClient(workingClient);
                const meta = accountId ? am.metadata?.get?.(accountId) : null;
                const accountName =
                    meta?.name ||
                    meta?.username ||
                    meta?.phone ||
                    (accountId ? `#${accountId}` : null);
                const ok = await downloader.enqueue(
                    {
                        message: resolved.message,
                        groupId,
                        groupName,
                        mediaType,
                        client: workingClient,
                        accountId: accountId || null,
                        accountName: accountName || null,
                    },
                    1,
                ); // realtime priority
                results.push({
                    url: raw,
                    ok,
                    group: groupName,
                    messageId: parsed.messageId,
                    mediaType,
                });
            } catch (e) {
                results.push({
                    url: raw,
                    ok: false,
                    error: e instanceof UrlParseError ? e.message : e?.message || 'Failed',
                });
            }
        }

        if (standalone) {
            // Tear down once jobs drain — fire-and-forget.
            (async () => {
                while (downloader.pendingCount > 0 || downloader.active.size > 0) {
                    await new Promise((r) => setTimeout(r, 1000));
                }
                downloader.stop().catch(() => {});
            })().catch((e) =>
                console.warn('[download/url] standalone drain failed:', e?.message || e),
            );
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
        const config = loadConfig();

        // Disk usage: prefer the live `SUM(file_size)` from the DB because
        // it's always in sync with the row count we just read. If the DB
        // sum is zero (catalogue empty after a Purge / before first run),
        // walk `data/downloads/` for the real on-disk size and refresh the
        // JSON cache — never trust a stale `disk_usage.json` snapshot, the
        // legacy cache was never invalidated on purge so a wiped dashboard
        // would footer-report a multi-week-old "930 KB".
        let diskUsage = Number(dbStats.totalSize) || 0;
        if (diskUsage <= 0) {
            diskUsage = await scanDirectorySize(DOWNLOADS_DIR);
            await writeDiskUsageCache(diskUsage);
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
                    accountCount = fsSync.readdirSync(dir).filter((f) => f.endsWith('.enc')).length;
                }
            } catch {
                /* ignore */
            }
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
            enabledGroups: config.groups?.filter((g) => g.enabled).length || 0,
            accounts: accountCount,
            apiConfigured: !!(config.telegram?.apiId && config.telegram?.apiHash),
            telegramConnected: isConnected || runtime.state === 'running',
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
// `at` is wallclock milliseconds; comparisons elsewhere always use Math.max(0, …)
// to stay safe across NTP backward jumps.
let _dialogsResponseCache = { at: 0, body: null };

app.get('/api/dialogs', async (req, res) => {
    try {
        const wantFresh = req.query.fresh === '1';
        const now = Date.now();
        if (
            !wantFresh &&
            _dialogsResponseCache.body &&
            Math.max(0, now - _dialogsResponseCache.at) < 5 * 60 * 1000
        ) {
            return res.json(_dialogsResponseCache.body);
        }

        // Collect every connected client + its account metadata. Manage
        // Groups must surface chats from EVERY linked account — using only
        // the default client made groups visible to a second/third account
        // silently disappear from the picker. We also keep `[accountId, meta]`
        // pairs so the response can attribute each dialog back to the account
        // it came from.
        const clientPairs = []; // [{ id, meta, client }]
        try {
            const am = await getAccountManager();
            for (const [accountId, c] of am.clients) {
                if (!c?.connected) continue;
                const meta = am.metadata.get(accountId) || { id: accountId };
                clientPairs.push({ id: accountId, meta, client: c });
            }
        } catch {
            /* no creds yet */
        }
        if (telegramClient?.connected && !clientPairs.some((p) => p.client === telegramClient)) {
            clientPairs.push({
                id: 'legacy',
                meta: { id: 'legacy', name: 'Default', phone: '', username: '' },
                client: telegramClient,
            });
        }
        if (clientPairs.length === 0) {
            // Distinguish "no Telegram account configured yet" (operator
            // hasn't run through Add Account) from "client is briefly
            // disconnected" — the SPA renders a friendly empty-state with
            // an Add Account CTA for the former, vs. a red error for the
            // latter.
            const sessionsDir = path.join(DATA_DIR, 'sessions');
            const hasSession =
                existsSync(sessionsDir) &&
                fsSync.readdirSync(sessionsDir).some((f) => f.endsWith('.enc'));
            if (!hasSession) {
                return res
                    .status(503)
                    .json({ error: 'no_account', message: 'No Telegram account configured' });
            }
            return res
                .status(503)
                .json({ error: 'not_connected', message: 'Telegram client not connected' });
        }

        const config = loadConfig();
        const configGroups = config.groups || [];
        const allowDM = config.allowDmDownloads === true;

        // Fan out across every account — active + archived per client in
        // parallel. One bad client (e.g. mid-reconnect) doesn't kill the
        // sweep; we just lose its chats from this response and pick them
        // up on the next refresh.
        const perClient = await Promise.all(
            clientPairs.map(async (p) => {
                const [a, ar] = await Promise.all([
                    p.client.getDialogs({ limit: 500 }).catch(() => []),
                    p.client.getDialogs({ limit: 200, archived: true }).catch(() => []),
                ]);
                return { accountId: p.id, accountMeta: p.meta, active: a, archived: ar };
            }),
        );

        // Build maps keyed by dialog id:
        //   firstDialog[id] -> { d, archived } picked on first sighting (active wins over archived)
        //   accountIds[id]  -> Set of every accountId that sees this chat
        const firstDialog = new Map();
        const accountIds = new Map();
        const nameById = new Map(_dialogsNameCache.byId);

        for (const p of perClient) {
            for (const isArchived of [false, true]) {
                const list = isArchived ? p.archived : p.active;
                for (const d of list) {
                    const id = String(d.id);

                    if (!accountIds.has(id)) accountIds.set(id, new Set());
                    accountIds.get(id).add(p.accountId);

                    if (!firstDialog.has(id)) firstDialog.set(id, { d, archived: isArchived });

                    // Side-effect: warm the name cache used by /api/groups +
                    // /api/downloads. Free since we already have the dialog
                    // objects in hand.
                    const nm =
                        d.title ||
                        d.name ||
                        (
                            (d.entity?.firstName || '') +
                            (d.entity?.lastName ? ' ' + d.entity.lastName : '')
                        ).trim() ||
                        d.entity?.username ||
                        null;
                    if (nm && !nameLooksUnresolved(nm, id)) nameById.set(id, nm);
                }
            }
        }
        _dialogsNameCache = { at: now, byId: nameById };

        // Account directory for the response — lets the SPA render account
        // chips by id without a second round-trip to /api/accounts.
        const accounts = clientPairs.map((p) => ({
            id: p.id,
            name: p.meta?.name || p.meta?.username || p.id,
            phone: p.meta?.phone || '',
            username: p.meta?.username || '',
        }));

        const merged = [];
        for (const [, entry] of firstDialog) {
            merged.push(entry);
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
                const configGroup = configGroups.find((g) => String(g.id) === id);
                let type = 'group';
                if (d.isChannel) type = 'channel';
                else if (d.isUser && d.entity?.bot) type = 'bot';
                else if (d.isUser) type = 'user';
                // Stable order so the SPA can render account chips deterministically.
                const accIds = Array.from(accountIds.get(id) || []).sort();
                return {
                    id,
                    name:
                        d.title ||
                        d.name ||
                        (d.entity?.firstName || '') +
                            (d.entity?.lastName ? ' ' + d.entity.lastName : '') ||
                        'Unknown',
                    type,
                    username: d.username,
                    archived,
                    members: d.entity?.participantsCount || null,
                    enabled: configGroup?.enabled || false,
                    inConfig: !!configGroup,
                    filters: configGroup?.filters || {
                        photos: true,
                        videos: true,
                        files: true,
                        links: true,
                        voice: false,
                        gifs: false,
                        stickers: false,
                    },
                    autoForward: configGroup?.autoForward || {
                        enabled: false,
                        destination: null,
                        deleteAfterForward: false,
                    },
                    photoUrl: `/api/groups/${id}/photo`,
                    accountIds: accIds,
                };
            });

        const body = { success: true, dialogs: results, allowDM, accounts };
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
// Parallel type cache so the sidebar's Downloaded Groups list can
// distinguish channel / group / user / bot icons (matches what Manage
// Groups already shows). Keyed by the same string id; values are one
// of 'channel' | 'group' | 'user' | 'bot'.
let _dialogsTypeCache = new Map();
async function getDialogsNameCache() {
    const now = Date.now();
    if (
        Math.max(0, now - _dialogsNameCache.at) < 5 * 60 * 1000 &&
        _dialogsNameCache.byId.size > 0
    ) {
        return _dialogsNameCache.byId;
    }
    const byId = new Map();
    const typeById = new Map();
    try {
        const am = await getAccountManager();
        const clients = [];
        for (const [, c] of am.clients) clients.push(c);
        if (telegramClient?.connected && !clients.includes(telegramClient))
            clients.push(telegramClient);

        for (const client of clients) {
            if (!client?.connected) continue;
            try {
                const [active, archived] = await Promise.all([
                    client.getDialogs({ limit: 500 }).catch(() => []),
                    client.getDialogs({ limit: 200, archived: true }).catch(() => []),
                ]);
                for (const d of [...active, ...archived]) {
                    const id = String(d.id);
                    const name =
                        d.title ||
                        d.name ||
                        (
                            (d.entity?.firstName || '') +
                            (d.entity?.lastName ? ' ' + d.entity.lastName : '')
                        ).trim() ||
                        d.entity?.username ||
                        null;
                    if (name && !nameLooksUnresolved(name, id) && !byId.has(id)) {
                        byId.set(id, name);
                    }
                    if (!typeById.has(id)) {
                        let t = 'group';
                        if (d.isChannel) t = 'channel';
                        else if (d.isUser && d.entity?.bot) t = 'bot';
                        else if (d.isUser) t = 'user';
                        typeById.set(id, t);
                    }
                }
            } catch {
                /* one bad client doesn't kill the whole sweep */
            }
        }
    } catch {
        /* no AM — fresh install */
    }
    _dialogsNameCache = { at: now, byId };
    _dialogsTypeCache = typeById;
    return byId;
}

// Lookup helper used by /api/groups and /api/downloads to enrich each
// row with its dialog type. Falls back to null when the type isn't
// known yet — the front-end then leans on the avatar's id-based
// heuristic (which is correct often but conflates supergroups with
// channels because both share the `-100…` id prefix).
function dialogsTypeFor(id) {
    return _dialogsTypeCache.get(String(id)) || null;
}

app.get('/api/groups', async (req, res) => {
    try {
        const config = loadConfig();
        // Pull the best DB-side name per group_id so a config row with
        // "Unknown" doesn't shadow a real name we already saved at
        // download time. Plain MAX(group_name) misbehaves on this
        // schema because "Unknown" sorts above most ASCII titles —
        // a group with rows ["Unknown", "Cool Channel"] would surface
        // "Unknown". CASE-filter out the placeholders before MAX, then
        // fall back to MAX(any) only if every row was a placeholder.
        let dbNames = new Map();
        try {
            const rows = getDb()
                .prepare(`
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
                 GROUP BY group_id`)
                .all();
            for (const r of rows) dbNames.set(String(r.group_id), r.best_name || r.any_name);
        } catch {}

        // Live dialogs from every connected account — same source the
        // Browse-chats picker uses, so the sidebar shows the same name.
        const dialogsNames = await getDialogsNameCache();

        const groupsWithPhotos = await Promise.all(
            (config.groups || []).map(async (group) => {
                const photoPath = path.join(PHOTOS_DIR, `${group.id}.jpg`);
                const hasPhoto = existsSync(photoPath);
                return {
                    ...group,
                    name: bestGroupName(
                        group.id,
                        group.name,
                        dbNames.get(String(group.id)),
                        dialogsNames.get(String(group.id)),
                    ),
                    // Sidebar uses `type` to render the right corner icon
                    // (megaphone vs group vs user/bot). Without this the
                    // Downloaded Groups list defaulted to the id-prefix
                    // heuristic in createAvatar() which painted every
                    // supergroup as a channel.
                    type: group.type || dialogsTypeFor(group.id),
                    photoUrl: hasPhoto ? `/photos/${group.id}.jpg` : null,
                };
            }),
        );
        res.json(groupsWithPhotos);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. Downloads Aggregate (Folders + DB Counts)
app.get('/api/downloads', async (req, res) => {
    try {
        const config = loadConfig();
        const configGroups = config.groups || [];
        const db = getDb();

        // CASE-filter "Unknown" / numeric-id placeholders BEFORE MAX so
        // a group with mixed rows ["Cool Channel", "Unknown"] returns
        // "Cool Channel" instead of the lexically-larger "Unknown".
        const rows = db
            .prepare(`
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
        `)
            .all();

        const dialogsNames = await getDialogsNameCache();

        const results = rows
            .map((r) => {
                const cfg = configGroups.find((g) => String(g.id) === r.group_id);
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
                    // Type drives the sidebar avatar's corner badge
                    // (channel = megaphone / group = group icon / user / bot).
                    // Prefer config (sticky), fall back to live-dialogs cache.
                    type: cfg?.type || dialogsTypeFor(r.group_id),
                    totalFiles: r.count,
                    sizeFormatted: formatBytes(r.size || 0),
                    photoUrl: hasPhoto ? `/photos/${r.group_id}.jpg` : null,
                    enabled: cfg ? cfg.enabled : false,
                };
            })
            .filter(Boolean);

        res.json(results);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 5a. All-Media: paginated cross-group feed. Pre-v2.3.6 the SPA simulated
// this by fanning out 20 per-group queries × 20 files = a hard cap of 400
// files visible regardless of how big the library actually was. Now the DB
// does the ORDER BY across every group, the SPA gets clean infinite-scroll,
// and per-tab type filters (`?type=images|videos|documents|audio`) produce
// accurate counts.
app.get('/api/downloads/all', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 50));
        const type = req.query.type || 'all';
        const offset = (page - 1) * limit;
        // Pinned filter chip (`?pinned=1`) and "surface pinned at top"
        // setting (`?pinnedFirst=1`) — both opt-in, both default off so
        // existing callers behave identically.
        const pinnedOnly = req.query.pinned === '1' || req.query.pinned === 'true';
        const pinnedFirst = req.query.pinnedFirst === '1' || req.query.pinnedFirst === 'true';
        const result = getAllDownloads(limit, offset, type, { pinnedOnly, pinnedFirst });

        // Same row → tile shape as `/api/downloads/:groupId` so the SPA
        // renderer is unchanged. Per-row group_name + group_id are
        // preserved on every tile.
        let config = {};
        try {
            config = loadConfig();
        } catch {
            /* ok — fall back to row.group_name */
        }
        const configGroups = new Map((config.groups || []).map((g) => [String(g.id), g]));
        const files = result.files.map((row) => {
            const typeFolder =
                row.file_type === 'photo'
                    ? 'images'
                    : row.file_type === 'video'
                      ? 'videos'
                      : row.file_type === 'audio'
                        ? 'audio'
                        : row.file_type === 'sticker'
                          ? 'stickers'
                          : 'documents';
            const stored = (row.file_path || '').replace(/\\/g, '/');
            const fallbackFolder = sanitizeName(
                configGroups.get(String(row.group_id))?.name ||
                    row.group_name ||
                    String(row.group_id),
            );
            const fullPath =
                stored && stored.includes('/')
                    ? stored
                    : `${fallbackFolder}/${typeFolder}/${row.file_name}`;
            return {
                id: row.id,
                name: row.file_name,
                path: row.file_path,
                fullPath,
                size: row.file_size,
                sizeFormatted: formatBytes(row.file_size),
                type: typeFolder,
                extension: path.extname(row.file_name || ''),
                modified: row.created_at,
                groupId: row.group_id,
                groupName: configGroups.get(String(row.group_id))?.name || row.group_name || null,
                pendingUntil: row.pending_until || null,
                rescuedAt: row.rescued_at || null,
                pinned: !!row.pinned,
            };
        });

        res.json({ files, total: result.total, page, totalPages: Math.ceil(result.total / limit) });
    } catch (e) {
        console.error('GET /api/downloads/all:', e);
        res.status(500).json({ error: 'Internal error' });
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
        const config = loadConfig();
        const configGroup = (config.groups || []).find((g) => String(g.id) === String(groupId));
        const dbRow = getDb()
            .prepare(
                'SELECT group_name FROM downloads WHERE group_id = ? AND group_name IS NOT NULL LIMIT 1',
            )
            .get(String(groupId));
        const groupFolder = sanitizeName(configGroup?.name || dbRow?.group_name || 'unknown');

        const pinnedOnly = req.query.pinned === '1' || req.query.pinned === 'true';
        const pinnedFirst = req.query.pinnedFirst === '1' || req.query.pinnedFirst === 'true';
        const result = getDownloads(groupId, limit, offset, type, { pinnedOnly, pinnedFirst });

        // DB `file_path` stores the path RELATIVE to data/downloads (set
        // by downloader.js via path.relative(DOWNLOADS_DIR, …)). USE that
        // as the source of truth — re-deriving from sanitize(group.name)
        // breaks every file that was downloaded under a different folder
        // name (e.g. "Unknown" before the group was named, or a renamed
        // group whose old folder still has the old files).
        const files = result.files.map((row) => {
            // Map DB file_type to folder name (used only as a hint when
            // file_path is missing or invalid).
            const typeFolder =
                row.file_type === 'photo'
                    ? 'images'
                    : row.file_type === 'video'
                      ? 'videos'
                      : row.file_type === 'audio'
                        ? 'audio'
                        : row.file_type === 'sticker'
                          ? 'stickers'
                          : 'documents';

            // Prefer the stored relative path. Normalise Windows-style
            // backslashes into forward slashes for the URL.
            const stored = (row.file_path || '').replace(/\\/g, '/');
            const fullPath =
                stored && stored.includes('/')
                    ? stored
                    : `${groupFolder}/${typeFolder}/${row.file_name}`;

            return {
                id: row.id,
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
                pinned: !!row.pinned,
            };
        });

        res.json({
            files,
            total: result.total,
            page,
            totalPages: Math.ceil(result.total / limit),
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
    if (typeof userPath !== 'string' || userPath.length === 0)
        return { ok: false, reason: 'forbidden' };
    if (userPath.includes('\0')) return { ok: false, reason: 'forbidden' };
    let normalized = path.normalize(userPath);
    // Tolerate the legacy `data/downloads/` prefix that was sneaking
    // into queue-history entries + some DB rows because downloader's
    // `buildPath()` defaulted to `'./data/downloads'` (relative form
    // was being stored verbatim instead of always-stripped). Without
    // this fix, the second `path.join(DOWNLOADS_DIR, …)` below would
    // double the prefix → `<root>/data/downloads/data/downloads/<…>`
    // → 404 for every cached preview link the SPA rendered.
    const dataDownloadsPrefix = 'data' + path.sep + 'downloads' + path.sep;
    while (normalized.startsWith(dataDownloadsPrefix)) {
        normalized = normalized.slice(dataDownloadsPrefix.length);
    }
    // Defensive: also strip the POSIX form when running on Windows
    // (path.normalize keeps forward slashes if they're already there
    // because that's what came over the URL).
    while (normalized.startsWith('data/downloads/')) {
        normalized = normalized.slice('data/downloads/'.length);
    }
    if (path.isAbsolute(normalized)) return { ok: false, reason: 'forbidden' };
    if (normalized.split(path.sep).includes('..')) return { ok: false, reason: 'forbidden' };
    const candidate = path.join(DOWNLOADS_DIR, normalized);
    const rootReal = await fs.realpath(DOWNLOADS_DIR).catch(() => path.resolve(DOWNLOADS_DIR));
    let real;
    try {
        real = await fs.realpath(candidate);
    } catch (e) {
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

        const config = loadConfig();
        const groupFolderById = new Map();
        for (const g of config.groups || [])
            groupFolderById.set(String(g.id), sanitizeName(g.name));

        const files = r.files.map((row) => {
            const folder =
                groupFolderById.get(String(row.group_id)) ||
                sanitizeName(row.group_name || 'unknown');
            const typeFolder =
                row.file_type === 'photo'
                    ? 'images'
                    : row.file_type === 'video'
                      ? 'videos'
                      : row.file_type === 'audio'
                        ? 'audio'
                        : row.file_type === 'sticker'
                          ? 'stickers'
                          : 'documents';
            // Use the stored relative path when present (matches the actual
            // on-disk location even if the group has since been renamed).
            const stored = (row.file_path || '').replace(/\\/g, '/');
            const fullPath =
                stored && stored.includes('/')
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
// Bulk-delete by id and/or path — used by the gallery selection bar.
// At N=5000 the unlink loop runs minutes; converted to fire-and-forget
// so a Cloudflare timeout can't kill the request mid-stream. Shares the
// `dedupDelete` tracker with the duplicate finder + gallery selection
// (semantically same op, single-flight is the right behaviour).
app.post('/api/downloads/bulk-delete', async (req, res) => {
    const { ids, paths } = req.body || {};
    const idList = Array.isArray(ids) ? ids.map(Number).filter(Number.isFinite) : [];
    const pathList = Array.isArray(paths) ? paths : [];
    if (!idList.length && !pathList.length) {
        return res.status(400).json({ error: 'ids or paths required' });
    }
    const tracker = _jobTrackers.dedupDelete;
    const r = tracker.tryStart(async ({ onProgress }) => {
        const total = idList.length + pathList.length;
        let processed = 0;
        let unlinked = 0;
        onProgress({ processed: 0, total, stage: 'deleting_files' });
        for (const p of pathList) {
            const sr = await safeResolveDownload(p);
            if (sr.ok) {
                try {
                    await fs.unlink(sr.real);
                    unlinked++;
                } catch (e) {
                    if (e.code !== 'ENOENT') throw e;
                }
            }
            processed += 1;
            if (processed % 50 === 0 || processed === total) {
                onProgress({ processed, total, stage: 'deleting_files' });
            }
        }
        if (idList.length) {
            const db = getDb();
            const rows = db
                .prepare(
                    `SELECT id, group_id, group_name, file_name, file_type FROM downloads WHERE id IN (${idList.map(() => '?').join(',')})`,
                )
                .all(...idList);
            const config = loadConfig();
            const folderById = new Map();
            for (const g of config.groups || []) folderById.set(String(g.id), sanitizeName(g.name));
            for (const row of rows) {
                const folder =
                    folderById.get(String(row.group_id)) ||
                    sanitizeName(row.group_name || 'unknown');
                const typeFolder =
                    row.file_type === 'photo'
                        ? 'images'
                        : row.file_type === 'video'
                          ? 'videos'
                          : row.file_type === 'audio'
                            ? 'audio'
                            : row.file_type === 'sticker'
                              ? 'stickers'
                              : 'documents';
                const candidate = `${folder}/${typeFolder}/${row.file_name}`;
                const sr = await safeResolveDownload(candidate);
                if (sr.ok) {
                    try {
                        await fs.unlink(sr.real);
                        unlinked++;
                    } catch (e) {
                        if (e.code !== 'ENOENT') throw e;
                    }
                }
                processed += 1;
                if (processed % 50 === 0 || processed === total) {
                    onProgress({ processed, total, stage: 'deleting_files' });
                }
            }
        }
        const dbDeleted = deleteDownloadsBy({ ids: idList, filePaths: pathList });
        onProgress({ processed: total, total, stage: 'purging_thumbs' });
        for (const id of idList) {
            try {
                await purgeThumbsForDownload(id);
            } catch {}
        }
        broadcast({ type: 'bulk_delete', unlinked, dbDeleted });
        return { unlinked, dbDeleted, requested: total };
    });
    if (!r.started) {
        return res
            .status(409)
            .json({ error: 'A bulk delete is already running', code: 'ALREADY_RUNNING' });
    }
    res.json({ success: true, started: true, queued: idList.length + pathList.length });
});

// Toggle the `pinned` flag on a single download row. Pinned rows survive
// auto-rotation and (optionally) sort to the top of the gallery. Body is
// `{ pinned: true | false }` — explicit boolean so a missing key is a 400
// rather than a silent no-op.
app.post('/api/downloads/:id/pin', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });
    const { pinned } = req.body || {};
    if (typeof pinned !== 'boolean') {
        return res.status(400).json({ error: 'Body must include `pinned` (boolean)' });
    }
    const row = getDownloadById(id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const ok = setDownloadPinned(id, pinned);
    if (!ok) return res.status(500).json({ error: 'Update failed' });
    broadcast({ type: 'download_pinned', id, pinned });
    res.json({ success: true, id, pinned });
});

// Streaming bulk download as a ZIP. Body: `{ ids: [1,2,3] }`. Server walks
// each id, resolves its on-disk file via the same safe-resolver every other
// route uses, and pipes a STORE-mode (no compression) ZIP to the response.
// Filename: `tgdl-<groupNameOr"library">-<count>files-<timestamp>.zip`.
//
// Cross-platform: pure JS, no native deps, no archiver package. Streams
// each file from disk so a 5 GB selection doesn't OOM the server.
app.post('/api/downloads/bulk-zip', async (req, res) => {
    try {
        const { ids } = req.body || {};
        const idList = Array.isArray(ids) ? ids.map(Number).filter(Number.isFinite) : [];
        if (idList.length === 0) return res.status(400).json({ error: 'ids required' });

        // Lazy-load to keep the cold start cheap when the bulk-zip endpoint
        // is never called.
        const { ZipStream, ZIP_MAX_BYTES, ZIP_MAX_ENTRIES, safeArchiveName } = await import(
            '../core/zip-stream.js'
        );

        if (idList.length > ZIP_MAX_ENTRIES) {
            return res.status(413).json({
                error: `Too many files in one ZIP (cap ${ZIP_MAX_ENTRIES}). Split into smaller batches.`,
            });
        }

        // Resolve everything up-front so we can size-check + stream sensibly.
        const db = getDb();
        const placeholders = idList.map(() => '?').join(',');
        const rows = db
            .prepare(
                `SELECT id, group_id, group_name, file_name, file_size, file_type, file_path FROM downloads WHERE id IN (${placeholders})`,
            )
            .all(...idList);

        if (rows.length === 0) return res.status(404).json({ error: 'No matching files' });

        let configGroups = new Map();
        try {
            const cfg = loadConfig();
            for (const g of cfg.groups || []) configGroups.set(String(g.id), g);
        } catch {
            /* fall back to row.group_name */
        }

        // Build resolved entries. Each entry knows its abs path, the
        // archive-relative name we want to store it under, and the size.
        const entries = [];
        let totalBytes = 0;
        const seenNames = new Set();
        for (const row of rows) {
            const folder = sanitizeName(
                configGroups.get(String(row.group_id))?.name ||
                    row.group_name ||
                    String(row.group_id || 'group'),
            );
            const typeFolder =
                row.file_type === 'photo'
                    ? 'images'
                    : row.file_type === 'video'
                      ? 'videos'
                      : row.file_type === 'audio'
                        ? 'audio'
                        : row.file_type === 'sticker'
                          ? 'stickers'
                          : 'documents';
            const stored = (row.file_path || '').replace(/\\/g, '/');
            const candidate =
                stored && stored.includes('/')
                    ? stored
                    : `${folder}/${typeFolder}/${row.file_name}`;
            const sr = await safeResolveDownload(candidate);
            if (!sr.ok) continue;

            const baseName = safeArchiveName(row.file_name || `file-${row.id}`);
            // Name collisions get a numeric suffix so two photos with the
            // same Telegram filename land as `foo.jpg` and `foo (1).jpg`.
            let archiveName = `${folder}/${baseName}`;
            let n = 1;
            while (seenNames.has(archiveName)) {
                const ext = path.extname(baseName);
                const stem = baseName.slice(0, baseName.length - ext.length);
                archiveName = `${folder}/${stem} (${n})${ext}`;
                n++;
            }
            seenNames.add(archiveName);
            entries.push({ absPath: sr.real, archiveName, size: row.file_size || 0 });
            totalBytes += row.file_size || 0;
        }

        if (entries.length === 0) {
            return res.status(404).json({ error: 'No accessible files in selection' });
        }
        if (totalBytes > ZIP_MAX_BYTES) {
            return res.status(413).json({
                error: `Selection exceeds 4 GiB ZIP cap (${formatBytes(totalBytes)}). Split into smaller batches.`,
            });
        }

        // Pretty filename for the download. Use the first entry's group
        // folder when every file is from the same group, otherwise fall
        // back to "library".
        const firstGroup = entries[0].archiveName.split('/')[0];
        const allSameGroup = entries.every((e) => e.archiveName.startsWith(firstGroup + '/'));
        const labelGroup = allSameGroup ? firstGroup : 'library';
        const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
        const archiveBase = `tgdl-${safeArchiveName(labelGroup)}-${entries.length}files-${ts}.zip`;

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${archiveBase}"`);
        // Streaming archive — no Content-Length, must disable any
        // intermediate buffering. Cache-Control no-store so a CDN doesn't
        // try to cache a multi-GB blob keyed on the POST body.
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Transfer-Encoding', 'chunked');

        const zip = new ZipStream();
        zip.pipe(res);
        try {
            for (const e of entries) {
                if (res.destroyed || res.writableEnded) break;
                await zip.addFile(e.absPath, e.archiveName);
            }
            await zip.finalize();
        } catch (err) {
            if (!res.headersSent) res.status(500).json({ error: err.message });
            else res.destroy(err);
        }
    } catch (err) {
        console.error('POST /api/downloads/bulk-zip:', err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
        else res.destroy(err);
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
            return res
                .status(status)
                .json({ error: r.reason === 'missing' ? 'File not found' : 'Access denied' });
        }

        await fs.unlink(r.real);
        console.log(`🗑️ Deleted: ${filePath}`);

        // Remove from DB (by basename — the DB stores filenames, not paths).
        // Capture matching ids first so we can wipe their cached thumbnails;
        // a stale thumb pointing at a deleted file would otherwise serve
        // bytes from cache until the next "Rebuild thumbnails".
        const db = getDb();
        const fileName = path.basename(r.real);
        const matchingIds = db
            .prepare('SELECT id FROM downloads WHERE file_name = ?')
            .all(fileName)
            .map((row) => row.id);
        db.prepare('DELETE FROM downloads WHERE file_name = ?').run(fileName);
        for (const id of matchingIds) {
            try {
                await purgeThumbsForDownload(id);
            } catch {}
        }

        broadcast({ type: 'file_deleted', path: filePath });
        res.json({ success: true });
    } catch (error) {
        if (error.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
        console.error('DELETE /api/file:', error);
        res.status(500).json({ error: 'Internal error' });
    }
});

// 6b. Purge Group (Files + DB + Config + Photo — No Trace)
//
// Fire-and-forget — a chat with 10k files takes minutes of disk I/O to
// rm. POST returns immediately; per-group tracker key (`group_purge_*`)
// allows multi-flight across distinct groups while preventing a
// double-click on the same row from firing twice. Status endpoint:
// `GET /api/groups/:id/purge/status`.
app.delete('/api/groups/:id/purge', async (req, res) => {
    const groupId = req.params.id;
    const tracker = _groupPurgeTracker(groupId);
    const r = tracker.tryStart(async ({ onProgress }) => {
        const config = loadConfig();
        const configGroup = (config.groups || []).find((g) => String(g.id) === String(groupId));
        const dbRow = getDb()
            .prepare(
                'SELECT group_name FROM downloads WHERE group_id = ? AND group_name IS NOT NULL LIMIT 1',
            )
            .get(String(groupId));
        const groupName = configGroup?.name || dbRow?.group_name || 'unknown';
        const folderName = sanitizeName(groupName);
        onProgress({ stage: 'counting', groupId });

        // 1. Delete files on disk — count first so the UI can render a
        // determinate bar.
        const folderPath = path.join(DOWNLOADS_DIR, folderName);
        let filesDeleted = 0;
        if (existsSync(folderPath)) {
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
            onProgress({ stage: 'deleting_files', groupId, total: filesDeleted, processed: 0 });
            await fs.rm(folderPath, { recursive: true, force: true });
            onProgress({
                stage: 'deleting_files',
                groupId,
                total: filesDeleted,
                processed: filesDeleted,
            });
        }

        // 2. Delete DB records
        onProgress({ stage: 'deleting_rows', groupId });
        const dbResult = deleteGroupDownloads(groupId);

        // 3. Remove from config
        config.groups = (config.groups || []).filter((g) => String(g.id) !== String(groupId));
        await writeConfigAtomic(config);

        // 4. Delete profile photo
        const photoPath = path.join(PHOTOS_DIR, `${groupId}.jpg`);
        if (existsSync(photoPath)) await fs.unlink(photoPath);

        console.log(
            `PURGED: ${groupName} — ${filesDeleted} files, ${dbResult.deletedDownloads} DB records`,
        );
        broadcast({ type: 'group_purged', groupId });
        return {
            groupId,
            deleted: {
                files: filesDeleted,
                dbRecords: dbResult.deletedDownloads,
                queueRecords: dbResult.deletedQueue,
                group: groupName,
            },
        };
    });
    if (!r.started) {
        return res.status(409).json({
            error: 'A purge for this group is already running',
            code: 'ALREADY_RUNNING',
            snapshot: r.snapshot,
        });
    }
    res.json({ success: true, started: true, groupId });
});

app.get('/api/groups/:id/purge/status', async (req, res) => {
    const groupId = req.params.id;
    const tracker = _groupPurgeTracker(groupId);
    res.json(tracker.getStatus());
});

// 6c. Purge ALL (Everything — Factory Reset)
//
// Fire-and-forget — a full library wipe is the slowest, most destructive
// admin action we have. Returns 200 immediately; final counts via
// `purge_all_done`. Single-flight via the shared tracker.
app.delete('/api/purge/all', async (req, res) => {
    const tracker = _jobTrackers.purgeAll;
    const r = tracker.tryStart(async ({ onProgress }) => {
        let totalFiles = 0;
        const dirs = existsSync(DOWNLOADS_DIR)
            ? fsSync.readdirSync(DOWNLOADS_DIR, { withFileTypes: true })
            : [];
        const groupDirs = dirs.filter((d) => d.isDirectory());
        const totalGroups = groupDirs.length;
        let processed = 0;
        onProgress({ processed: 0, total: totalGroups, stage: 'deleting_files' });
        for (const dir of groupDirs) {
            const dirPath = path.join(DOWNLOADS_DIR, dir.name);
            try {
                totalFiles += fsSync.readdirSync(dirPath, { recursive: true }).length;
            } catch {}
            await fs.rm(dirPath, { recursive: true, force: true });
            processed += 1;
            onProgress({ processed, total: totalGroups, stage: 'deleting_files' });
        }

        onProgress({ stage: 'deleting_rows' });
        const dbResult = deleteAllDownloads();

        const config = loadConfig();
        config.groups = [];
        await writeConfigAtomic(config);

        if (existsSync(PHOTOS_DIR)) {
            const photos = fsSync.readdirSync(PHOTOS_DIR);
            for (const photo of photos) {
                await fs.unlink(path.join(PHOTOS_DIR, photo)).catch(() => {});
            }
        }

        console.log(`PURGE ALL: ${totalFiles} files, ${dbResult.deletedDownloads} DB records`);
        broadcast({ type: 'purge_all' });
        return {
            deleted: {
                files: totalFiles,
                dbRecords: dbResult.deletedDownloads,
                queueRecords: dbResult.deletedQueue,
            },
        };
    });
    if (!r.started) {
        return res
            .status(409)
            .json({ error: 'A factory reset is already running', code: 'ALREADY_RUNNING' });
    }
    res.json({ success: true, started: true });
});

app.get('/api/purge/all/status', async (req, res) => {
    res.json(_jobTrackers.purgeAll.getStatus());
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
//
// Fire-and-forget — with many accounts × big dialog lists this is multi-
// second. Progress streams via `resync_dialogs_progress`, final result via
// `resync_dialogs_done`. Pre-flight account check stays sync so the caller
// gets an immediate explanation when no Telegram accounts exist.
app.post('/api/maintenance/resync-dialogs', async (req, res) => {
    let am;
    try {
        am = await getAccountManager();
    } catch (e) {
        const { status, body } = tgAuthErrorBody(e);
        return res
            .status(status === 400 ? 500 : status)
            .json(body.error ? body : { error: e.message });
    }
    if (am.count === 0) return res.status(409).json({ error: 'No Telegram accounts loaded' });
    const tracker = _jobTrackers.resyncDialogs;
    const r = tracker.tryStart(async ({ onProgress }) => {
        try {
            entityCache.clear();
        } catch {}
        const config = loadConfig();
        const ids = new Set((config.groups || []).map((g) => String(g.id)));
        try {
            const rows = getDb().prepare('SELECT DISTINCT group_id FROM downloads').all();
            for (const rr of rows) ids.add(String(rr.group_id));
        } catch {}

        let updated = 0;
        let mutated = false;
        const total = ids.size;
        let processed = 0;
        const pendingDbUpdates = [];
        onProgress({ processed: 0, total, updated: 0, stage: 'resolving' });
        for (const id of ids) {
            const resolved = await resolveEntityAcrossAccounts(id);
            if (resolved) {
                const e = resolved.entity;
                const realName =
                    e?.title ||
                    (e?.firstName && e.firstName + (e.lastName ? ' ' + e.lastName : '')) ||
                    e?.username ||
                    null;
                if (realName) {
                    const cg = (config.groups || []).find((g) => String(g.id) === id);
                    if (
                        cg &&
                        (!cg.name ||
                            cg.name === 'Unknown' ||
                            cg.name === id ||
                            cg.name.startsWith('Group '))
                    ) {
                        cg.name = realName;
                        mutated = true;
                    }
                    pendingDbUpdates.push([realName, id]);
                    updated++;
                }
                await downloadProfilePhoto(id).catch(() => {});
            }
            processed++;
            onProgress({ processed, total, updated, stage: 'resolving' });
        }
        if (pendingDbUpdates.length > 0) {
            try {
                const db = getDb();
                const stmt = db.prepare(
                    `UPDATE downloads SET group_name = ? WHERE group_id = ? AND (group_name IS NULL OR group_name = '' OR group_name = 'Unknown' OR group_name = ?)`,
                );
                const tx = db.transaction((rows) => {
                    for (const [name, gid] of rows) stmt.run(name, gid, gid);
                });
                tx(pendingDbUpdates);
            } catch (err) {
                console.warn('[resync-dialogs] batch update failed:', err.message);
            }
        }
        if (mutated) await writeConfigAtomic(config);
        _dialogsResponseCache = { at: 0, body: null };
        _dialogsNameCache = { at: 0, byId: new Map() };
        broadcast({ type: 'config_updated' });
        return { scanned: total, updated };
    });
    if (!r.started) {
        return res
            .status(409)
            .json({ error: 'Resync already in progress', code: 'ALREADY_RUNNING' });
    }
    res.json({ success: true, started: true });
});

app.get('/api/maintenance/resync-dialogs/status', async (req, res) => {
    res.json(_jobTrackers.resyncDialogs.getStatus());
});

// Restart the realtime monitor: stop → start. Useful after settings changes
// (proxy, accounts, rate limits) without needing to bounce the container.
// Fire-and-forget for consistency with the other Settings → Maintenance
// buttons; final status broadcast via `restart_monitor_done`.
app.post('/api/maintenance/restart-monitor', async (req, res) => {
    if (!_requireConfirm(req, res)) return;
    const t = _jobTrackers.restartMonitor;
    const r = t.tryStart(async () => {
        const wasRunning = runtime.state === 'running';
        if (runtime.state !== 'stopped') {
            try {
                await runtime.stop();
            } catch (e) {
                console.warn('restart-monitor stop:', e.message);
            }
        }
        if (!wasRunning) {
            return { restarted: false, note: 'Monitor was not running; nothing to restart.' };
        }
        const am = await getAccountManager();
        if (am.count === 0) {
            const err = new Error('No Telegram accounts loaded');
            err.code = 'NO_ACCOUNTS';
            throw err;
        }
        await runtime.start({ config: loadConfig(), accountManager: am });
        return { restarted: true, status: runtime.status() };
    });
    if (!r.started) {
        return res
            .status(409)
            .json({ error: 'Restart already in progress', code: 'ALREADY_RUNNING' });
    }
    res.json({ success: true, started: true });
});

app.get('/api/maintenance/restart-monitor/status', async (req, res) => {
    res.json(_jobTrackers.restartMonitor.getStatus());
});

// SQLite integrity check (PRAGMA integrity_check). Returns "ok" on a clean DB
// or a list of corruption messages. Read-only.
//
// Usually fast (~seconds) but on a corrupt DB can spin for a long time —
// converted to fire-and-forget for symmetry + Cloudflare safety.
app.post('/api/maintenance/db/integrity', async (req, res) => {
    const t = _jobTrackers.dbIntegrity;
    const r = t.tryStart(async () => {
        const db = getDb();
        const rows = db.prepare('PRAGMA integrity_check').all();
        const messages = rows.map((rr) => rr.integrity_check).filter(Boolean);
        const ok = messages.length === 1 && messages[0] === 'ok';
        return { ok, messages };
    });
    if (!r.started) {
        return res
            .status(409)
            .json({ error: 'An integrity check is already running', code: 'ALREADY_RUNNING' });
    }
    res.json({ success: true, started: true });
});

app.get('/api/maintenance/db/integrity/status', async (req, res) => {
    res.json(_jobTrackers.dbIntegrity.getStatus());
});

// Walk every download row, drop the ones whose file is missing or
// 0 bytes. Same logic as the periodic boot-time sweep, surfaced as a
// button so users can force-clean stale entries on demand.
//
// Fire-and-forget — a 50k-row library can take a minute, well past
// Cloudflare's 100 s tunnel timeout when the user has had the dashboard
// open for a while. POST returns 200 immediately; progress + result land
// over WS as `files_verify_progress` / `files_verify_done`. Page hydrates
// running state from `/files/verify/status` on mount.
app.post('/api/maintenance/files/verify', async (req, res) => {
    const t = _jobTrackers.filesVerify;
    const r = t.tryStart(async ({ onProgress }) => {
        return await integrity.sweep(onProgress);
    });
    if (!r.started) {
        return res
            .status(409)
            .json({ error: 'A verify is already running', code: 'ALREADY_RUNNING' });
    }
    res.json({ success: true, started: true });
});

app.get('/api/maintenance/files/verify/status', async (req, res) => {
    res.json(_jobTrackers.filesVerify.getStatus());
});

// Re-index from disk — the inverse of /files/verify. Walks
// data/downloads/ and inserts rows for files the catalogue doesn't
// know about. Idempotent (INSERT OR IGNORE on (group_id, message_id)).
// Used to recover a wiped DB (Purge all, fresh install over an existing
// downloads/ tree, restore from backups/ snapshot) without re-downloading
// from Telegram. Background-driven; progress broadcast via WS
// `reindex_progress` and final `reindex_done` so the page can render a
// determinate bar without polling.
let _reindexBgRunning = false;
app.post('/api/maintenance/reindex', async (req, res) => {
    if (_reindexBgRunning || integrity.isReindexRunning()) {
        return res.status(409).json({ error: 'already_running' });
    }
    _reindexBgRunning = true;
    res.json({ ok: true, started: true });
    // Fire-and-forget — the result lands over WS. Caller already got 200.
    (async () => {
        try {
            const cfg = await readConfigSafe();
            const groups = Array.isArray(cfg?.groups) ? cfg.groups : [];
            const result = await integrity.reindexFromDisk(groups, (p) => {
                try {
                    broadcast({ type: 'reindex_progress', ...p });
                } catch {}
            });
            try {
                broadcast({ type: 'reindex_done', ...result });
            } catch {}
        } catch (e) {
            try {
                broadcast({ type: 'reindex_done', error: e?.message || String(e) });
            } catch {}
        } finally {
            _reindexBgRunning = false;
        }
    })();
});

app.get('/api/maintenance/reindex/status', async (req, res) => {
    res.json({ running: _reindexBgRunning || integrity.isReindexRunning() });
});

// VACUUM the SQLite database. Reclaims space after lots of deletions.
// Locks the DB briefly — guard with confirm so the user can't trigger it by
// accident in the middle of a heavy backfill.
//
// Fire-and-forget: VACUUM blocks the process for the duration of the
// rebuild (multiple minutes on a multi-GB library), well past Cloudflare's
// edge timeout. POST returns 200 immediately; final reclaim numbers land
// via `db_vacuum_done` WS event.
app.post('/api/maintenance/db/vacuum', async (req, res) => {
    if (!_requireConfirm(req, res)) return;
    const t = _jobTrackers.dbVacuum;
    const r = t.tryStart(async () => {
        const db = getDb();
        const beforePages = db.pragma('page_count', { simple: true });
        const pageSize = db.pragma('page_size', { simple: true });
        db.exec('VACUUM');
        const afterPages = db.pragma('page_count', { simple: true });
        return {
            beforeBytes: Number(beforePages) * Number(pageSize),
            afterBytes: Number(afterPages) * Number(pageSize),
            reclaimedBytes: Math.max(
                0,
                (Number(beforePages) - Number(afterPages)) * Number(pageSize),
            ),
        };
    });
    if (!r.started) {
        return res
            .status(409)
            .json({ error: 'A vacuum is already running', code: 'ALREADY_RUNNING' });
    }
    res.json({ success: true, started: true });
});

app.get('/api/maintenance/db/vacuum/status', async (req, res) => {
    res.json(_jobTrackers.dbVacuum.getStatus());
});

// ====== Duplicate finder (checksum-based) ==================================
//
// One-shot scan that:
//   1. Computes SHA-256 for every download row missing a hash (the column
//      has been in the schema since v2 but never populated).
//   2. Groups by hash and returns sets where COUNT > 1.
//
// First scan is O(bytes-on-disk); subsequent scans are nearly free since
// only newly-downloaded files lack a hash. Progress is broadcast over WS
// (`dedup_progress`) so the UI can render a determinate bar.
//
// Two-step UX: scan returns the duplicate sets to the client, the user
// picks which copies to keep, and the explicit /delete call removes the
// rest. The endpoint never auto-deletes.
// Fire-and-forget pattern — same as thumbs/build-all and nsfw/scan.
// On a 50 GB library the SHA-256 sweep can take minutes; previously we
// awaited the result inside the POST handler, which Cloudflare's tunnel
// timeout (100 s default) would 524 long before the scan finished. The
// scan now runs in the background; clients learn about progress and the
// final duplicate sets via WS (`dedup_progress`, `dedup_done`) and can
// recover the in-flight state via GET `/dedup/status` after a tab close.
let _dedupRunning = false;
let _dedupState = {
    running: false,
    stage: 'idle',
    processed: 0,
    total: 0,
    hashed: 0,
    groups: 0,
    startedAt: 0,
    finishedAt: 0,
    result: null,
    error: null,
};
app.post('/api/maintenance/dedup/scan', async (req, res) => {
    if (_dedupRunning) {
        return res
            .status(409)
            .json({ error: 'A dedup scan is already running', code: 'ALREADY_RUNNING' });
    }
    _dedupRunning = true;
    _dedupState = {
        running: true,
        stage: 'starting',
        processed: 0,
        total: 0,
        hashed: 0,
        groups: 0,
        startedAt: Date.now(),
        finishedAt: 0,
        result: null,
        error: null,
    };
    res.json({ success: true, started: true });
    try {
        broadcast({ type: 'dedup_progress', ..._dedupState });
    } catch {}
    log({ source: 'dedup', level: 'info', msg: 'dedup scan starting' });
    (async () => {
        try {
            const result = await dedupFindDuplicates({
                onProgress: (p) => {
                    Object.assign(_dedupState, p, { running: true });
                    try {
                        broadcast({ type: 'dedup_progress', ...p, running: true });
                    } catch {}
                },
            });
            _dedupState = {
                ..._dedupState,
                ...result,
                running: false,
                stage: 'done',
                finishedAt: Date.now(),
                result,
            };
            try {
                broadcast({ type: 'dedup_done', ...result });
            } catch {}
            log({
                source: 'dedup',
                level: 'info',
                msg: `dedup scan done — groups=${result?.groups?.length ?? 0} duplicates=${result?.totalDuplicates ?? 0}`,
            });
        } catch (e) {
            _dedupState = {
                ..._dedupState,
                running: false,
                stage: 'error',
                error: e?.message || String(e),
                finishedAt: Date.now(),
            };
            try {
                broadcast({ type: 'dedup_done', error: e?.message || String(e) });
            } catch {}
            log({ source: 'dedup', level: 'error', msg: `dedup scan failed: ${e?.message || e}` });
        } finally {
            _dedupRunning = false;
        }
    })();
});

// Status endpoint — returns the latest scan state including the result
// payload from the most recent completed run, so a re-opened page can
// render the duplicate-sets table without re-running the scan.
app.get('/api/maintenance/dedup/status', async (req, res) => {
    res.json({ ..._dedupState, running: _dedupRunning });
});

// Bulk-delete N files. Used by both the duplicate finder ("delete the
// non-keep copies") and the gallery selection bar ("delete N tiles").
// At N=10k disk I/O can run for minutes — fire-and-forget so the request
// returns instantly and progress streams over WS.
//
// Validates synchronously; only the actual delete loop runs in the
// background. Status is per-shared-tracker, NOT per-call — concurrent
// gallery-selection deletes are serialised, the second caller gets 409.
app.post('/api/maintenance/dedup/delete', async (req, res) => {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ error: 'ids array required' });
    }
    const cleanIds = ids.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
    if (!cleanIds.length) {
        return res.status(400).json({ error: 'No valid ids supplied' });
    }
    const tracker = _jobTrackers.dedupDelete;
    const r = tracker.tryStart(async ({ onProgress }) => {
        const total = cleanIds.length;
        onProgress({ processed: 0, total, stage: 'deleting' });
        const result = dedupDeleteByIds(cleanIds);
        // Thumbnails purge is the slow part on a big delete (one fs walk
        // per id). Stream progress so the gallery-select UI can show a bar.
        let processed = 0;
        for (const id of cleanIds) {
            try {
                await purgeThumbsForDownload(id);
            } catch {}
            processed += 1;
            if (processed % 50 === 0 || processed === total) {
                onProgress({ processed, total, stage: 'purging_thumbs' });
            }
        }
        try {
            broadcast({ type: 'bulk_delete', ids: cleanIds });
        } catch {}
        return { ...result, requested: cleanIds.length, ids: cleanIds };
    });
    if (!r.started) {
        return res
            .status(409)
            .json({ error: 'A bulk delete is already running', code: 'ALREADY_RUNNING' });
    }
    res.json({ success: true, started: true, queued: cleanIds.length });
});

app.get('/api/maintenance/dedup/delete/status', async (req, res) => {
    res.json(_jobTrackers.dedupDelete.getStatus());
});

// ====== Thumbnails =========================================================
//
// `GET /api/thumbs/:id?w=240` returns a small WebP thumbnail for an
// image or video download row. Cache-first: hits stat in microseconds
// and stream from disk; misses fork sharp / ffmpeg once and the result
// lives in `data/thumbs/`. The frontend uses these for every gallery
// tile (replacing the previous full-resolution `/files/*?inline=1` for
// images and the `<video preload="none">` for desktop video tiles)
// — much smaller transfers, no decoder pressure on the client.
//
// Returns 404 when the source is not thumbnailable (audio/document) so
// the SPA's <img onerror> fallback can kick in and render an icon.
// Throttle log spam — a 1000-tile gallery scrolling past missing files
// would otherwise flood the buffer. Three layers of quieting:
//   1. WINDOW_MS — count is bucketed into 15-minute windows (was 1 min,
//      then 5 min — busy operators still saw it as flood)
//   2. FLOOR — a window only warns if the burst crossed 200 misses;
//      small bursts (a few audio rows scrolled past) stay silent
//   3. COOLDOWN_MS — after one warning fires, the next one is held off
//      for 30 minutes regardless of count, so a chatty afternoon emits
//      at most ~2 warnings instead of 4
// Operators who want it fully silent set `advanced.thumbs.warnMisses`
// to false in /api/config (validated server-side as boolean).
const THUMB_MISS_WINDOW_MS = 15 * 60_000;
const THUMB_MISS_FLOOR = 200;
const THUMB_MISS_COOLDOWN_MS = 30 * 60_000;
let _thumbMissBatch = { count: 0, resetAt: 0, lastWarnedAt: 0 };
app.get('/api/thumbs/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).type('text/plain').send('Bad id');
        }
        const thumb = await getOrCreateThumb(id, req.query.w);
        if (!thumb) {
            const now = Date.now();
            if (now - _thumbMissBatch.resetAt > THUMB_MISS_WINDOW_MS) {
                // Window rollover — emit a consolidated warning if (a) the
                // burst crossed the floor AND (b) we're past the cooldown
                // since the last emission. Both gates have to pass; either
                // alone leaves it quiet.
                let warnMisses = true;
                try {
                    const cfg = loadConfig();
                    warnMisses = cfg?.advanced?.thumbs?.warnMisses !== false;
                } catch {
                    /* no config yet → default on */
                }
                if (
                    warnMisses &&
                    _thumbMissBatch.count >= THUMB_MISS_FLOOR &&
                    now - _thumbMissBatch.lastWarnedAt >= THUMB_MISS_COOLDOWN_MS
                ) {
                    const mins = Math.round(THUMB_MISS_WINDOW_MS / 60_000);
                    log({
                        source: 'thumbs',
                        level: 'warn',
                        msg: `${_thumbMissBatch.count} thumb misses in the last ${mins} min (DB row missing, file off disk, or source not thumbnailable). Try Maintenance → Verify files / Re-index.`,
                    });
                    _thumbMissBatch.lastWarnedAt = now;
                }
                _thumbMissBatch.count = 1;
                _thumbMissBatch.resetAt = now;
            } else {
                _thumbMissBatch.count += 1;
            }
            return res.status(404).type('text/plain').send('No thumb');
        }

        res.setHeader('Content-Type', 'image/webp');
        // Aggressive cache — the URL embeds id+width which is content-
        // stable. If the source is replaced, purgeThumbsForDownload()
        // wipes the cache entry so the next request regenerates.
        res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
        // Mtime makes browser If-Modified-Since round trips cheap.
        const lastMod = new Date(thumb.mtime).toUTCString();
        res.setHeader('Last-Modified', lastMod);
        if (req.headers['if-modified-since'] === lastMod) {
            return res.status(304).end();
        }
        return res.sendFile(thumb.path, (err) => {
            if (err && !res.headersSent) res.status(500).end();
        });
    } catch (e) {
        console.error('thumb serve:', e);
        if (!res.headersSent) res.status(500).type('text/plain').send('Internal error');
    }
});

// Maintenance — wipe the entire thumbnail cache. Used by the
// "Rebuild thumbnails" UI to force regeneration (e.g. after a quality
// tweak or a corruption scare). On-demand generation refills the cache
// on the next gallery scroll, gated by the thumbs.js semaphores.
//
// Fire-and-forget: a 100k-thumb cache can take a noticeable amount of
// time to walk and unlink. POST returns immediately; final count lands
// via `thumbs_rebuild_done` WS event.
app.post('/api/maintenance/thumbs/rebuild', async (req, res) => {
    const tracker = _jobTrackers.thumbsRebuild;
    const r = tracker.tryStart(async () => {
        const removed = await purgeAllThumbs();
        return { removed };
    });
    if (!r.started) {
        return res
            .status(409)
            .json({ error: 'A thumbnail wipe is already running', code: 'ALREADY_RUNNING' });
    }
    res.json({ success: true, started: true });
});

app.get('/api/maintenance/thumbs/rebuild/status', async (req, res) => {
    res.json(_jobTrackers.thumbsRebuild.getStatus());
});

// Maintenance — generate thumbnails for every download row that doesn't
// already have one cached at the default width. Covers downloads that
// landed before pre-generation existed. Honours the per-kind concurrency
// caps in thumbs.js so the gallery stays responsive while the sweep runs.
//
// Fire-and-forget: returns 200 with `started: true` immediately. The
// actual build runs in the background, broadcasting `thumbs_progress`
// over WS and a final `thumbs_done`. A re-opened page can call
// `/api/maintenance/thumbs/build/status` to recover the in-flight state.
// Field names mirror what `buildAllThumbnails()` returns + emits via
// onProgress: `processed / total / built / skipped / errored / scanned`.
// Renamed from `done/errors` (the original placeholders) so the status
// JSON, the WS frames, and the log line all agree — previously the log
// printed `done=undefined errors=undefined`.
let _thumbBuildRunning = false;
let _thumbBuildState = {
    running: false,
    stage: 'idle',
    processed: 0,
    total: 0,
    built: 0,
    skipped: 0,
    errored: 0,
    scanned: 0,
    startedAt: 0,
    finishedAt: 0,
    error: null,
};
app.post('/api/maintenance/thumbs/build-all', async (req, res) => {
    if (_thumbBuildRunning) {
        return res.status(409).json({ error: 'A thumbnail build is already running' });
    }
    _thumbBuildRunning = true;
    _thumbBuildState = {
        running: true,
        stage: 'starting',
        processed: 0,
        total: 0,
        built: 0,
        skipped: 0,
        errored: 0,
        scanned: 0,
        startedAt: Date.now(),
        finishedAt: 0,
        error: null,
    };
    res.json({ success: true, started: true });
    log({ source: 'thumbs', level: 'info', msg: 'thumbs build-all starting' });
    (async () => {
        try {
            const r = await buildAllThumbnails({
                onProgress: (p) => {
                    // Server-side state stays the source of truth for the
                    // /build/status endpoint; broadcast forwards the same
                    // shape to WS subscribers.
                    Object.assign(_thumbBuildState, p, { running: true });
                    try {
                        broadcast({ type: 'thumbs_progress', ...p });
                    } catch {}
                },
            });
            _thumbBuildState = {
                ..._thumbBuildState,
                ...r,
                running: false,
                stage: 'done',
                finishedAt: Date.now(),
            };
            try {
                broadcast({ type: 'thumbs_done', ...r });
            } catch {}
            log({
                source: 'thumbs',
                level: 'info',
                msg: `thumbs build-all done — scanned=${r?.scanned ?? 0} built=${r?.built ?? 0} skipped=${r?.skipped ?? 0} errored=${r?.errored ?? 0}`,
            });
        } catch (e) {
            _thumbBuildState = {
                ..._thumbBuildState,
                running: false,
                stage: 'error',
                error: e?.message || String(e),
                finishedAt: Date.now(),
            };
            try {
                broadcast({ type: 'thumbs_done', error: e?.message || String(e) });
            } catch {}
            log({
                source: 'thumbs',
                level: 'error',
                msg: `thumbs build-all failed: ${e?.message || e}`,
            });
        } finally {
            _thumbBuildRunning = false;
        }
    })();
});

app.get('/api/maintenance/thumbs/build/status', async (req, res) => {
    res.json({ ..._thumbBuildState, running: _thumbBuildRunning });
});

// Probe which ffmpeg hardware-acceleration backends actually work on
// this host. Runs `ffmpeg -hide_banner -hwaccels` and returns the parsed
// list. Used by Settings → Advanced → Video thumb hardware acceleration
// → "Detect available" so the admin doesn't have to SSH in to find out
// whether VAAPI/QSV/CUDA/etc. are available on the host's ffmpeg build.
app.get('/api/maintenance/thumbs/hwaccel-probe', async (req, res) => {
    try {
        const { spawn } = await import('child_process');
        const thumbs = await import('../core/thumbs.js');
        const bin = thumbs.resolveFfmpegBin?.() || 'ffmpeg';
        const out = await new Promise((resolve, reject) => {
            const p = spawn(bin, ['-hide_banner', '-hwaccels'], { windowsHide: true });
            const chunks = [];
            p.stdout.on('data', (c) => chunks.push(c));
            p.stderr.on('data', () => {});
            p.on('error', reject);
            p.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
        }).catch(() => '');
        // Output shape (ffmpeg ≥4.x):
        //   Hardware acceleration methods:\nvaapi\nqsv\ncuda\nvideotoolbox\n
        const KNOWN = new Set([
            'vaapi',
            'qsv',
            'cuda',
            'videotoolbox',
            'd3d11va',
            'dxva2',
            'opencl',
            'vulkan',
            'drm',
        ]);
        const available = out
            .split(/\r?\n/)
            .map((s) => s.trim().toLowerCase())
            .filter((s) => KNOWN.has(s));
        res.json({
            available,
            ffmpegPath: bin,
            // The dropdown only exposes options we have UI rows for; the
            // others come back so docs / debugging surface them.
            recommended:
                available.find((b) =>
                    ['vaapi', 'qsv', 'cuda', 'videotoolbox', 'd3d11va'].includes(b),
                ) || null,
        });
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e), available: [] });
    }
});

// Maintenance — cache footprint (count + bytes) and capability check
// (whether ffmpeg is present). Drives the "Thumbnail cache" admin panel
// + grays out the video / audio-cover capabilities when ffmpeg is
// missing on this host.
app.get('/api/maintenance/thumbs/stats', async (req, res) => {
    try {
        const r = await getThumbsCacheStats();
        res.json({
            success: true,
            ffmpegAvailable: hasFfmpeg(),
            allowedWidths: THUMB_WIDTHS,
            ...r,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ====== Video faststart optimiser (v2.6.10) ==============================
//
// MP4s with their `moov` atom at the end of the file confuse the
// browser's HTML5 player — seek breaks, audio appears missing, the
// "loaded" range stalls until the entire `mdat` has streamed in.
// `_generateVideoThumb` was patched in v2.6.9 to handle the case where
// such files exist; this adds the fix at the source: rewrite each
// file with `+faststart` so the player gets `moov` immediately.
//
// Three endpoints, mirroring the thumbs build/rebuild pattern:
//   POST /api/maintenance/faststart/scan   — fire-and-forget sweep
//   GET  /api/maintenance/faststart/status — recover live state
//   GET  /api/maintenance/faststart/stats  — counts for the dashboard
//
// Auto-fixed inline by the downloader (see faststartInBackground in
// downloader.js); the sweep is for the existing library.
let _faststartRunning = false;
let _faststartState = {
    running: false,
    stage: 'idle',
    processed: 0,
    total: 0,
    optimized: 0,
    already: 0,
    skipped: 0,
    errored: 0,
    scanned: 0,
    startedAt: 0,
    finishedAt: 0,
    error: null,
};
app.post('/api/maintenance/faststart/scan', async (req, res) => {
    if (_faststartRunning) {
        return res
            .status(409)
            .json({ error: 'A faststart sweep is already running', code: 'ALREADY_RUNNING' });
    }
    _faststartRunning = true;
    _faststartState = {
        running: true,
        stage: 'starting',
        processed: 0,
        total: 0,
        optimized: 0,
        already: 0,
        skipped: 0,
        errored: 0,
        scanned: 0,
        startedAt: Date.now(),
        finishedAt: 0,
        error: null,
    };
    res.json({ success: true, started: true });
    log({ source: 'faststart', level: 'info', msg: 'faststart sweep starting' });
    (async () => {
        try {
            const { optimizeAll } = await import('../core/faststart.js');
            const r = await optimizeAll({
                onProgress: (p) => {
                    Object.assign(_faststartState, p, { running: true });
                    try {
                        broadcast({ type: 'faststart_progress', ...p });
                    } catch {}
                },
            });
            _faststartState = {
                ..._faststartState,
                ...r,
                running: false,
                stage: 'done',
                finishedAt: Date.now(),
            };
            try {
                broadcast({ type: 'faststart_done', ...r });
            } catch {}
            log({
                source: 'faststart',
                level: 'info',
                msg: `faststart sweep done — scanned=${r?.scanned ?? 0} optimized=${r?.optimized ?? 0} already=${r?.already ?? 0} skipped=${r?.skipped ?? 0} errored=${r?.errored ?? 0}`,
            });
        } catch (e) {
            _faststartState = {
                ..._faststartState,
                running: false,
                stage: 'error',
                error: e?.message || String(e),
                finishedAt: Date.now(),
            };
            try {
                broadcast({ type: 'faststart_done', error: e?.message || String(e) });
            } catch {}
            log({
                source: 'faststart',
                level: 'error',
                msg: `faststart sweep failed: ${e?.message || e}`,
            });
        } finally {
            _faststartRunning = false;
        }
    })();
});

app.get('/api/maintenance/faststart/status', async (req, res) => {
    res.json({ ..._faststartState, running: _faststartRunning });
});

app.get('/api/maintenance/faststart/stats', async (req, res) => {
    try {
        const { getStats } = await import('../core/faststart.js');
        const r = await getStats();
        res.json({ success: true, ffmpegAvailable: hasFfmpeg(), ...r });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ====== NSFW review tool (Phase 1: photos only) ===========================
//
// Curated 18+ libraries get noise from auto-download — non-18+ photos
// that snuck in. The classifier flags low-score rows (likely NOT 18+)
// for admin review + manual delete. High-score rows (the genuine 18+
// content) are kept untouched.
//
// All endpoints are admin-only via the v2.3.26 chokepoint. Status +
// candidate listing is read-only and cheap; scan + delete + whitelist
// guard against concurrent calls / missing config.

function _nsfwCfg() {
    try {
        const cfg = loadConfig().advanced?.nsfw || {};
        return {
            enabled: cfg.enabled === true,
            model: cfg.model || NSFW_DEFAULTS.model,
            threshold: Number.isFinite(cfg.threshold) ? cfg.threshold : NSFW_DEFAULTS.threshold,
            concurrency: Number.isFinite(cfg.concurrency)
                ? cfg.concurrency
                : NSFW_DEFAULTS.concurrency,
            batchSize: Number.isFinite(cfg.batchSize) ? cfg.batchSize : NSFW_DEFAULTS.batchSize,
            fileTypes:
                Array.isArray(cfg.fileTypes) && cfg.fileTypes.length
                    ? cfg.fileTypes
                    : NSFW_DEFAULTS.fileTypes,
            cacheDir: cfg.cacheDir || NSFW_DEFAULTS.cacheDir,
        };
    } catch {
        return { ...NSFW_DEFAULTS, enabled: false };
    }
}

app.get('/api/maintenance/nsfw/status', async (req, res) => {
    try {
        const cfg = _nsfwCfg();
        const state = nsfwGetScanState(cfg);
        res.json({
            enabled: cfg.enabled,
            running: state.running,
            scanned: state.scanned,
            total: state.total,
            candidates: state.candidates,
            keep: state.keep,
            whitelisted: state.whitelisted,
            totalEligible: state.totalEligible,
            lastCheckedAt: state.lastCheckedAt,
            startedAt: state.startedAt,
            finishedAt: state.finishedAt,
            error: state.error,
            model: cfg.model,
            threshold: cfg.threshold,
            fileTypes: cfg.fileTypes,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/maintenance/nsfw/scan', async (req, res) => {
    try {
        const cfg = _nsfwCfg();
        if (!cfg.enabled) {
            return res.status(503).json({
                error: 'NSFW review is disabled. Open Maintenance → NSFW review and toggle it on first.',
                code: 'NSFW_DISABLED',
            });
        }
        if (nsfwIsScanRunning()) {
            return res
                .status(409)
                .json({ error: 'A scan is already running', code: 'ALREADY_RUNNING' });
        }
        log({
            source: 'nsfw',
            level: 'info',
            msg: `scan starting — model=${cfg.model} threshold=${cfg.threshold} fileTypes=[${(cfg.fileTypes || []).join(',')}] concurrency=${cfg.concurrency}`,
        });
        let _lastLoggedScanned = 0;
        const r = await nsfwStartScan(
            cfg,
            (p) => {
                try {
                    broadcast({ type: 'nsfw_progress', ...p });
                } catch {}
                // Throttle log spam — emit at most every 25 rows so a 10 000
                // row library doesn't pump 10 000 lines into the web log.
                if (typeof p?.scanned === 'number' && p.scanned - _lastLoggedScanned >= 25) {
                    _lastLoggedScanned = p.scanned;
                    log({
                        source: 'nsfw',
                        level: 'info',
                        msg: `scan progress — ${p.scanned}/${p.total} (candidates=${p.candidates ?? 0}, keep=${p.keep ?? 0})`,
                    });
                }
            },
            (p) => {
                try {
                    broadcast({ type: 'nsfw_done', ...p });
                } catch {}
                if (p?.error) {
                    log({
                        source: 'nsfw',
                        level: 'error',
                        msg: `scan finished with error: ${p.error}`,
                    });
                } else {
                    log({
                        source: 'nsfw',
                        level: 'info',
                        msg: `scan done — scanned=${p?.scanned ?? 0} candidates=${p?.candidates ?? 0} keep=${p?.keep ?? 0} elapsed=${p?.finishedAt && p?.startedAt ? Math.round((p.finishedAt - p.startedAt) / 1000) + 's' : 'n/a'}`,
                    });
                }
            },
            (p) => {
                try {
                    broadcast({ type: 'nsfw_model_downloading', ...p });
                } catch {}
                log({
                    source: 'nsfw',
                    level: 'info',
                    msg: `model load — ${p?.status || 'progress'} ${p?.file || ''} ${p?.progress != null ? Math.round(p.progress) + '%' : ''}`,
                });
            },
            // onLog — internal nsfw.js events flow into the same realtime
            // log stream the v2 page subscribes to.
            (entry) => log(entry),
        );
        if (r?.alreadyRunning) {
            log({ source: 'nsfw', level: 'warn', msg: 'scan request rejected — already running' });
        }
        res.json({ success: true, ...r });
    } catch (e) {
        log({
            source: 'nsfw',
            level: 'error',
            msg: `scan failed to start: ${e?.message || e} (code=${e?.code || 'UNKNOWN'})`,
        });
        console.error('nsfw/scan:', e);
        const status = e.code === 'NSFW_LIB_MISSING' ? 503 : 500;
        res.status(status).json({ error: e.message, code: e.code || 'UNKNOWN' });
    }
});

app.post('/api/maintenance/nsfw/scan/cancel', async (req, res) => {
    const ok = nsfwCancelScan();
    res.json({ success: true, cancelled: ok });
});

// Pre-fetch the classifier weights without scanning a single file. Lets
// the operator warm the cache from the UI so the next scan starts
// instantly. Returns immediately; download progress flows over the
// existing `nsfw_model_downloading` WS event + realtime log channel.
app.post('/api/maintenance/nsfw/preload', async (req, res) => {
    try {
        const cfg = _nsfwCfg();
        const r = await nsfwPreloadClassifier(
            cfg,
            (p) => {
                try {
                    broadcast({ type: 'nsfw_model_downloading', ...p });
                } catch {}
            },
            (entry) => log(entry),
        );
        res.json({ success: true, ...r });
    } catch (e) {
        log({ source: 'nsfw', level: 'error', msg: `preload failed to start: ${e?.message || e}` });
        const status = e.code === 'NSFW_LIB_MISSING' ? 503 : 500;
        res.status(status).json({ error: e.message, code: e.code || 'UNKNOWN' });
    }
});

// Snapshot of the in-process classifier load state. Polled by the
// /maintenance/nsfw page so the model-status pill reflects reality
// even between WS messages.
app.get('/api/maintenance/nsfw/model-status', async (req, res) => {
    res.json({ success: true, ...nsfwClassifierReady() });
});

// Wipe the cached weights on disk. Confirm-gated in the UI; safe-by-
// design here (the cache dir is allow-listed via _resolveCacheDirAbs
// inside nsfw.js — there's no caller-supplied path).
app.delete('/api/maintenance/nsfw/cache', async (req, res) => {
    try {
        const cfg = _nsfwCfg();
        const r = await nsfwClearCache(cfg);
        log({
            source: 'nsfw',
            level: 'info',
            msg: `cleared model cache — removed ${r.files} file(s) / ${r.bytes} bytes`,
        });
        res.json({ success: true, ...r });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/maintenance/nsfw/results', async (req, res) => {
    try {
        const cfg = _nsfwCfg();
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
        const r = getNsfwDeleteCandidates({
            fileTypes: cfg.fileTypes,
            threshold: cfg.threshold,
            page,
            limit,
        });
        res.json({
            success: true,
            ...r,
            threshold: cfg.threshold,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Delete reviewed candidates. Reuses the dedup-delete pathway (which
// removes file from disk + DB row) and purges the corresponding
// thumbnail cache entries so a stale WebP doesn't keep serving.
app.post('/api/maintenance/nsfw/delete', async (req, res) => {
    try {
        const { ids } = req.body || {};
        if (!Array.isArray(ids) || !ids.length) {
            return res.status(400).json({ error: 'ids array required' });
        }
        const cleanIds = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
        if (!cleanIds.length) {
            return res.status(400).json({ error: 'No valid ids supplied' });
        }
        const r = dedupDeleteByIds(cleanIds);
        for (const id of cleanIds) {
            try {
                await purgeThumbsForDownload(id);
            } catch {}
        }
        try {
            broadcast({ type: 'bulk_delete', ids: cleanIds });
        } catch {}
        try {
            broadcast({ type: 'nsfw_progress', ..._nsfwStateLight() });
        } catch {}
        res.json({ success: true, ...r });
    } catch (e) {
        console.error('nsfw/delete:', e);
        res.status(500).json({ error: e.message });
    }
});

// Mark rows as admin-confirmed-18+ (keep, never re-flag). Use when the
// classifier produced a false negative — i.e. the photo IS 18+ but
// scored low. Future scans skip these rows entirely.
app.post('/api/maintenance/nsfw/whitelist', async (req, res) => {
    try {
        const { ids } = req.body || {};
        if (!Array.isArray(ids) || !ids.length) {
            return res.status(400).json({ error: 'ids array required' });
        }
        const cleanIds = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
        if (!cleanIds.length) {
            return res.status(400).json({ error: 'No valid ids supplied' });
        }
        const updated = whitelistNsfw(cleanIds);
        try {
            broadcast({ type: 'nsfw_progress', ..._nsfwStateLight() });
        } catch {}
        res.json({ success: true, updated });
    } catch (e) {
        console.error('nsfw/whitelist:', e);
        res.status(500).json({ error: e.message });
    }
});

function _nsfwStateLight() {
    try {
        const cfg = _nsfwCfg();
        const s = getNsfwStats(cfg.fileTypes, cfg.threshold);
        return { ...s, running: nsfwIsScanRunning() };
    } catch {
        return {};
    }
}

// ---- NSFW v2 (tier-aware review page) -------------------------------------
//
// The original endpoints (status / scan / results / delete / whitelist) are
// preserved so existing UI keeps working. The v2 endpoints power the
// dedicated /maintenance/nsfw page, which shows per-tier stats, a score
// histogram, paginated browse-by-tier, and bulk score-range actions.

// Expose the tier dictionary so the front-end doesn't have to hard-code
// the boundaries — change the bands in db.js and the UI follows.
app.get('/api/maintenance/nsfw/v2/tiers-meta', async (req, res) => {
    res.json({ tiers: NSFW_TIERS });
});

app.get('/api/maintenance/nsfw/v2/tiers', async (req, res) => {
    try {
        const cfg = _nsfwCfg();
        const counts = getNsfwTierCounts(cfg.fileTypes);
        log({
            source: 'nsfw',
            level: 'info',
            msg: `tier counts polled — scanned=${counts.scanned}/${counts.totalEligible}`,
        });
        res.json({ ...counts, threshold: cfg.threshold, tiers_meta: NSFW_TIERS });
    } catch (e) {
        log({ source: 'nsfw', level: 'error', msg: `nsfw/v2/tiers failed: ${e?.message || e}` });
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/maintenance/nsfw/v2/histogram', async (req, res) => {
    try {
        const cfg = _nsfwCfg();
        const bins = Number(req.query.bins) || 20;
        res.json(getNsfwHistogram(cfg.fileTypes, bins));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/maintenance/nsfw/v2/list', async (req, res) => {
    try {
        const cfg = _nsfwCfg();
        const list = getNsfwListByTier({
            tier: req.query.tier || null,
            fileTypes: cfg.fileTypes,
            groupId: req.query.group || null,
            includeWhitelisted: req.query.include_whitelisted === '1',
            page: Number(req.query.page) || 1,
            limit: Number(req.query.limit) || 50,
        });
        res.json(list);
    } catch (e) {
        log({ source: 'nsfw', level: 'error', msg: `nsfw/v2/list failed: ${e?.message || e}` });
        res.status(500).json({ error: e.message });
    }
});

// Resolve a bulk-action filter into an explicit id list, then run the
// requested action. Single funnel keeps the four bulk endpoints (delete /
// whitelist / unwhitelist / reclassify) consistent — they all accept the
// same `{ tier?, scoreMax?, scoreMin?, groupId?, fileTypes?, ids? }` body.
//
// One SQL statement covers the largest tiers; scoreMin/scoreMax are
// pushed into the WHERE clause so a narrow band doesn't pull the whole
// tier into memory.
function _resolveBulkIds(body) {
    if (Array.isArray(body?.ids) && body.ids.length) {
        return body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    }
    const cfg = _nsfwCfg();
    const fileTypes =
        Array.isArray(body?.fileTypes) && body.fileTypes.length ? body.fileTypes : cfg.fileTypes;
    return getNsfwIdsByTier({
        tier: body?.tier || null,
        fileTypes,
        groupId: body?.groupId || null,
        includeWhitelisted: body?.includeWhitelisted === true,
        scoreMin: Number.isFinite(body?.scoreMin) ? Number(body.scoreMin) : null,
        scoreMax: Number.isFinite(body?.scoreMax) ? Number(body.scoreMax) : null,
    });
}

// All four NSFW v2 bulk endpoints share a single `nsfwBulk` tracker so
// they're mutually exclusive — the operations all touch the same review
// queue and racing them would produce inconsistent counts. Each endpoint
// returns 200 with `{started:true}` immediately; the resolved id list +
// final result land via `nsfw_bulk_done` (with an `op` field so the UI
// can branch on which one finished).
//
// Cancellation is supported by the tracker but the actual DB operations
// run in a tight loop and complete fast enough that we don't honour the
// signal mid-batch — a click on Cancel just stops re-broadcasting
// progress; the in-flight DB tx finishes naturally.
app.post('/api/maintenance/nsfw/v2/bulk-delete', async (req, res) => {
    if (!_requireConfirm(req, res)) return;
    const body = req.body || {};
    const tracker = _jobTrackers.nsfwBulk;
    const r = tracker.tryStart(async ({ onProgress }) => {
        onProgress({ stage: 'resolving', op: 'delete' });
        const ids = await _resolveBulkIds(body);
        if (!ids.length) return { op: 'delete', deleted: 0, ids: [] };
        log({ source: 'nsfw', level: 'warn', msg: `bulk-delete starting: ${ids.length} rows` });
        const total = ids.length;
        onProgress({ stage: 'deleting', op: 'delete', processed: 0, total });
        const result = dedupDeleteByIds(ids);
        let processed = 0;
        for (const id of ids) {
            try {
                await purgeThumbsForDownload(id);
            } catch {}
            processed += 1;
            if (processed % 50 === 0 || processed === total) {
                onProgress({ stage: 'purging_thumbs', op: 'delete', processed, total });
            }
        }
        try {
            broadcast({ type: 'bulk_delete', ids });
        } catch {}
        try {
            broadcast({ type: 'nsfw_progress', ..._nsfwStateLight() });
        } catch {}
        log({
            source: 'nsfw',
            level: 'info',
            msg: `bulk-delete done: removed=${result?.deleted ?? result?.removed ?? ids.length}`,
        });
        return { op: 'delete', deleted: ids.length, ids, ...result };
    });
    if (!r.started) {
        return res
            .status(409)
            .json({ error: 'A bulk NSFW operation is already running', code: 'ALREADY_RUNNING' });
    }
    res.json({ success: true, started: true });
});

app.post('/api/maintenance/nsfw/v2/bulk-whitelist', async (req, res) => {
    const body = req.body || {};
    const tracker = _jobTrackers.nsfwBulk;
    const r = tracker.tryStart(async ({ onProgress }) => {
        onProgress({ stage: 'resolving', op: 'whitelist' });
        const ids = await _resolveBulkIds(body);
        if (!ids.length) return { op: 'whitelist', updated: 0, ids: [] };
        onProgress({ stage: 'updating', op: 'whitelist', total: ids.length });
        const updated = whitelistNsfw(ids);
        try {
            broadcast({ type: 'nsfw_progress', ..._nsfwStateLight() });
        } catch {}
        log({
            source: 'nsfw',
            level: 'info',
            msg: `bulk-whitelist: marked ${updated} rows as 18+`,
        });
        return { op: 'whitelist', updated, ids };
    });
    if (!r.started) {
        return res
            .status(409)
            .json({ error: 'A bulk NSFW operation is already running', code: 'ALREADY_RUNNING' });
    }
    res.json({ success: true, started: true });
});

// Unwhitelist accepts the same `{tier|ids|...}` body shape as the other
// three bulk endpoints — when a tier filter is supplied we force
// includeWhitelisted=true on the resolver because the whole point of the
// op is to act on whitelisted rows (which the default resolver hides).
app.post('/api/maintenance/nsfw/v2/unwhitelist', async (req, res) => {
    const body = req.body || {};
    const tracker = _jobTrackers.nsfwBulk;
    const r = tracker.tryStart(async ({ onProgress }) => {
        onProgress({ stage: 'resolving', op: 'unwhitelist' });
        const resolveBody =
            Array.isArray(body.ids) && body.ids.length
                ? body
                : { ...body, includeWhitelisted: true };
        const ids = _resolveBulkIds(resolveBody);
        if (!ids.length) return { op: 'unwhitelist', updated: 0, ids: [] };
        onProgress({ stage: 'updating', op: 'unwhitelist', total: ids.length });
        const updated = unwhitelistNsfw(ids);
        try {
            broadcast({ type: 'nsfw_progress', ..._nsfwStateLight() });
        } catch {}
        log({
            source: 'nsfw',
            level: 'info',
            msg: `unwhitelist: ${updated} rows back into review`,
        });
        return { op: 'unwhitelist', updated, ids };
    });
    if (!r.started) {
        return res
            .status(409)
            .json({ error: 'A bulk NSFW operation is already running', code: 'ALREADY_RUNNING' });
    }
    res.json({ success: true, started: true });
});

app.post('/api/maintenance/nsfw/v2/reclassify', async (req, res) => {
    const body = req.body || {};
    const tracker = _jobTrackers.nsfwBulk;
    const r = tracker.tryStart(async ({ onProgress }) => {
        onProgress({ stage: 'resolving', op: 'reclassify' });
        const ids = await _resolveBulkIds(body);
        if (!ids.length) return { op: 'reclassify', cleared: 0, ids: [] };
        onProgress({ stage: 'clearing', op: 'reclassify', total: ids.length });
        const cleared = reclassifyNsfw(ids);
        log({
            source: 'nsfw',
            level: 'info',
            msg: `reclassify: cleared ${cleared} rows for re-scan`,
        });
        return { op: 'reclassify', cleared, ids };
    });
    if (!r.started) {
        return res
            .status(409)
            .json({ error: 'A bulk NSFW operation is already running', code: 'ALREADY_RUNNING' });
    }
    res.json({ success: true, started: true });
});

app.get('/api/maintenance/nsfw/v2/bulk/status', async (req, res) => {
    res.json(_jobTrackers.nsfwBulk.getStatus());
});

// ====== Backup destinations ================================================
//
// Multi-provider mirror + snapshot system. Admin-only via the chokepoint
// (none of these paths live on the guest allowlist). The backup manager
// owns workers, snapshot crons, encryption keys; this layer is just the
// HTTP shim. Every state-changing endpoint also writes a structured log
// entry so the realtime Logs page surfaces operations without polling.

app.get('/api/backup/providers', async (_req, res) => {
    try {
        res.json({ success: true, providers: backup.listProviders() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/backup/destinations', async (_req, res) => {
    try {
        res.json({ success: true, destinations: backup.listDestinations() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/backup/destinations', async (req, res) => {
    try {
        const id = backup.addDestination(req.body || {});
        log({ source: 'backup', level: 'info', msg: `destination created (#${id})` });
        const dest = backup.listDestinations().find((d) => d.id === id);
        res.json({ success: true, id, destination: dest });
    } catch (e) {
        log({ source: 'backup', level: 'warn', msg: `destination create rejected: ${e.message}` });
        res.status(400).json({ error: e.message });
    }
});

app.put('/api/backup/destinations/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
    try {
        const updated = backup.updateDestination(id, req.body || {});
        log({ source: 'backup', level: 'info', msg: `destination updated (#${id})` });
        res.json({ success: true, destination: updated });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.delete('/api/backup/destinations/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
    try {
        const ok = backup.removeDestination(id);
        log({ source: 'backup', level: 'info', msg: `destination removed (#${id})` });
        res.json({ success: ok });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/backup/destinations/:id/test', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
    try {
        const r = await backup.testConnection(id);
        log({
            source: 'backup',
            level: r.ok ? 'info' : 'warn',
            msg: `test connection on #${id}: ${r.detail || (r.ok ? 'ok' : 'failed')}`,
        });
        res.json({ success: true, ...r });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// `/run` returns 200 immediately. The backup manager starts work in the
// background; the dashboard subscribes to WS events for progress.
// Without the early-return, a snapshot upload of a multi-GB tar.gz would
// hold the connection past Cloudflare's 100 s edge timeout.
app.post('/api/backup/destinations/:id/run', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
    try {
        backup.runBackup(id).catch((e) => {
            log({ source: 'backup', level: 'error', msg: `run failed for #${id}: ${e.message}` });
        });
        res.json({ success: true, started: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/backup/destinations/:id/pause', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
    try {
        backup.pause(id);
        log({ source: 'backup', level: 'info', msg: `paused #${id}` });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/backup/destinations/:id/resume', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
    try {
        backup.resume(id);
        log({ source: 'backup', level: 'info', msg: `resumed #${id}` });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/backup/destinations/:id/encryption', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
    try {
        const { enabled, passphrase } = req.body || {};
        const out = backup.setEncryption(id, { enabled: !!enabled, passphrase });
        res.json({ success: true, destination: out });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/backup/destinations/:id/unlock', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
    try {
        backup.unlockEncryption(id, req.body?.passphrase || '');
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.get('/api/backup/destinations/:id/status', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
    try {
        res.json({ success: true, ...backup.getDestinationStatus(id) });
    } catch (e) {
        res.status(404).json({ error: e.message });
    }
});

app.get('/api/backup/destinations/:id/jobs', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
    try {
        const status = req.query.status ? String(req.query.status) : null;
        const limit = Math.min(500, Number(req.query.limit) || 50);
        const offset = Math.max(0, Number(req.query.offset) || 0);
        const jobs = backup.listJobs({ destinationId: id, status, limit, offset });
        res.json({ success: true, jobs });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/backup/jobs/recent', async (req, res) => {
    try {
        const limit = Math.min(200, Number(req.query.limit) || 20);
        res.json({ success: true, jobs: backup.listRecent(limit) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/backup/jobs/:id/retry', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
    try {
        const ok = backup.retryJob(id);
        if (ok) log({ source: 'backup', level: 'info', msg: `manual retry on job #${id}` });
        res.json({ success: ok });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ====== AI subsystem (v2.6.0) =============================================
//
// Local-only image embeddings, face clustering, perceptual dedup, and auto-
// tagging. Default-OFF; every capability is opt-in via `config.advanced.ai`.
// All long-running scans go through the JobTracker pattern so they return
// 200 immediately and stream progress over WebSocket.
//
// Models live in `data/models/` (override via AI_MODELS_DIR env var) and
// downloads only happen when the operator enables a capability. The
// classifier path inherits the WASM execution provider trick from NSFW so
// it works identically on Windows / macOS / glibc / musl / Docker / ARM.
//
// Admin-only by virtue of the chokepoint (none of these paths live on the
// guest allowlist).

function _aiCfg() {
    try {
        const live = loadConfig();
        const cfg = live.advanced?.ai || {};
        return {
            enabled: cfg.enabled === true,
            embeddings: {
                enabled: cfg.embeddings?.enabled === true,
                model: cfg.embeddings?.model || ai.AI_DEFAULTS.embeddings.model,
            },
            faces: {
                enabled: cfg.faces?.enabled === true,
                model: cfg.faces?.model || ai.AI_DEFAULTS.faces.model,
                epsilon: Number.isFinite(cfg.faces?.epsilon)
                    ? cfg.faces.epsilon
                    : ai.AI_DEFAULTS.faces.epsilon,
                minPoints: Number.isFinite(cfg.faces?.minPoints)
                    ? cfg.faces.minPoints
                    : ai.AI_DEFAULTS.faces.minPoints,
            },
            tags: {
                enabled: cfg.tags?.enabled === true,
                model: cfg.tags?.model || ai.AI_DEFAULTS.tags.model,
                topK: Number.isFinite(cfg.tags?.topK) ? cfg.tags.topK : ai.AI_DEFAULTS.tags.topK,
            },
            phash: { enabled: cfg.phash?.enabled === true },
            indexConcurrency: Number.isFinite(cfg.indexConcurrency)
                ? cfg.indexConcurrency
                : ai.AI_DEFAULTS.indexConcurrency,
            batchSize: Number.isFinite(cfg.batchSize) ? cfg.batchSize : ai.AI_DEFAULTS.batchSize,
            fileTypes:
                Array.isArray(cfg.fileTypes) && cfg.fileTypes.length
                    ? cfg.fileTypes
                    : ai.AI_DEFAULTS.fileTypes,
        };
    } catch {
        return { ...ai.AI_DEFAULTS };
    }
}

// Probe sqlite-vec lazily on the first AI status hit. Result is cached so
// we don't re-probe on every poll.
let _aiVecProbed = false;
async function _maybeProbeVec() {
    if (_aiVecProbed) return;
    _aiVecProbed = true;
    try {
        await ai.loadVecExtension(getDb, log);
    } catch {}
}

// Wire Transformers.js progress callbacks into the WS bus so the model
// status panel can show live download bytes without polling. Idempotent —
// the hook is registered once at module evaluation; subsequent reloads
// (e.g. test re-imports) overwrite the same slot.
try {
    ai.setModelProgressHook?.(({ kind, modelId, progress }) => {
        try {
            broadcast({
                type: 'ai_model_progress',
                kind,
                modelId,
                progress: progress || null,
                ts: Date.now(),
            });
        } catch {
            /* swallow — never crash the loader */
        }
    });
} catch {
    /* setModelProgressHook is optional */
}

// Per-capability descriptors used by the model-status endpoint. Mirrors
// the names the dashboard already uses. The kind is the Transformers.js
// pipeline kind — needed because the same model id can be loaded under
// two kinds (CLIP image vs text).
const _MODEL_CAPS = [
    { cap: 'embeddings', cfgKey: 'embeddings', defaultKind: 'image-feature-extraction' },
    { cap: 'faces', cfgKey: 'faces', defaultKind: 'object-detection' },
    { cap: 'tags', cfgKey: 'tags', defaultKind: 'image-classification' },
];

// Probe a HuggingFace token. POST `{ token? }` — when `token` is present
// we use that value directly, otherwise we fall back to the saved
// `advanced.ai.hfToken` (lets the operator click "Test" before the
// autosave round-trip lands). Hits `/api/whoami-v2` which returns the
// user object on a valid token + 401 on a bad one. We never echo the
// token back, only `{ ok: true, name, type }` or `{ ok: false, status,
// message }`. Rate-limit caps it to once every 2 s per session via the
// shared `loginLimiter` family — the app loop is in JS so a single
// admin spamming the button can't choke the box.
app.post('/api/ai/hf/test', async (req, res) => {
    try {
        let token = req.body && typeof req.body.token === 'string' ? req.body.token.trim() : '';
        if (!token) {
            try {
                const cfg = loadConfig();
                token = String(cfg?.advanced?.ai?.hfToken || '').trim();
            } catch {
                /* config not ready */
            }
        }
        if (!token) {
            return res.status(400).json({
                ok: false,
                status: 0,
                message: 'No token to test. Paste one above first.',
            });
        }
        // 5-second timeout — HF whoami is fast and the operator is
        // staring at a button waiting.
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 5000);
        let r;
        try {
            r = await fetch('https://huggingface.co/api/whoami-v2', {
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
                signal: ac.signal,
            });
        } catch (e) {
            return res.json({
                ok: false,
                status: 0,
                message:
                    e?.name === 'AbortError'
                        ? 'Timed out talking to huggingface.co.'
                        : `Network error: ${e?.message || e}`,
            });
        } finally {
            clearTimeout(timer);
        }
        if (r.status === 401 || r.status === 403) {
            return res.json({
                ok: false,
                status: r.status,
                message: 'Token rejected by HuggingFace (401). Re-create the token with Read role.',
            });
        }
        if (!r.ok) {
            return res.json({
                ok: false,
                status: r.status,
                message: `HuggingFace returned HTTP ${r.status}.`,
            });
        }
        let body = null;
        try {
            body = await r.json();
        } catch {
            /* ignore */
        }
        const name = body?.name || body?.fullname || '(unknown)';
        const type = body?.type || 'user';
        return res.json({ ok: true, status: r.status, name, type });
    } catch (e) {
        res.status(500).json({ ok: false, status: 0, message: e.message });
    }
});

app.get('/api/ai/status', async (_req, res) => {
    try {
        await _maybeProbeVec();
        const cfg = _aiCfg();
        const counts = getAiCounts({ fileTypes: cfg.fileTypes });
        res.json({
            success: true,
            enabled: cfg.enabled,
            capabilities: {
                master: cfg.enabled,
                embeddings: cfg.embeddings.enabled,
                faces: cfg.faces.enabled,
                tags: cfg.tags.enabled,
                phash: cfg.phash.enabled,
            },
            models: {
                embeddings: cfg.embeddings.model,
                faces: cfg.faces.model,
                tags: cfg.tags.model,
            },
            counts,
            loadedPipelines: ai.loadedPipelines(),
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/ai/index/scan', async (_req, res) => {
    const cfg = _aiCfg();
    if (!cfg.enabled) {
        return res.status(503).json({
            error: 'AI subsystem disabled. Toggle "Enable AI subsystem" in Maintenance → AI search.',
            code: 'AI_DISABLED',
        });
    }
    const tracker = _jobTrackers.aiIndex;
    const r = tracker.tryStart(async ({ onProgress, signal }) => {
        return ai.runIndexScan(cfg, { onProgress, signal, onLog: log });
    });
    if (!r.started)
        return res
            .status(409)
            .json({ error: 'AI index scan already running', code: 'ALREADY_RUNNING' });
    res.json({ success: true, started: true });
});

app.get('/api/ai/index/scan/status', async (_req, res) => {
    res.json(_jobTrackers.aiIndex.getStatus());
});

app.post('/api/ai/index/cancel', async (_req, res) => {
    const ok = _jobTrackers.aiIndex.cancel();
    res.json({ success: true, cancelled: ok });
});

app.post('/api/ai/search', async (req, res) => {
    try {
        const { query, limit, fileTypes } = req.body || {};
        if (typeof query !== 'string' || !query.trim()) {
            return res.status(400).json({ error: 'query required' });
        }
        const cfg = _aiCfg();
        if (!cfg.enabled || !cfg.embeddings.enabled) {
            return res
                .status(503)
                .json({ error: 'AI embeddings are disabled', code: 'EMBEDDINGS_DISABLED' });
        }
        const r = await ai.searchByText(query.trim(), cfg, {
            limit: Number(limit) || 20,
            fileTypes: Array.isArray(fileTypes) && fileTypes.length ? fileTypes : null,
            onLog: log,
        });
        res.json({ success: true, ...r });
    } catch (e) {
        log({ source: 'ai', level: 'error', msg: `search failed: ${e?.message || e}` });
        res.status(500).json({ error: e.message, code: e.code || 'UNKNOWN' });
    }
});

app.post('/api/ai/people/scan', async (_req, res) => {
    const cfg = _aiCfg();
    if (!cfg.enabled || !cfg.faces.enabled) {
        return res
            .status(503)
            .json({ error: 'Face clustering is disabled', code: 'FACES_DISABLED' });
    }
    const tracker = _jobTrackers.aiPeople;
    const r = tracker.tryStart(async ({ onProgress, signal }) => {
        return ai.runFaceClustering(cfg, { onProgress, signal, onLog: log });
    });
    if (!r.started)
        return res
            .status(409)
            .json({ error: 'Face clustering already running', code: 'ALREADY_RUNNING' });
    res.json({ success: true, started: true });
});

app.get('/api/ai/people/scan/status', async (_req, res) => {
    res.json(_jobTrackers.aiPeople.getStatus());
});

app.get('/api/ai/people', async (req, res) => {
    try {
        const limit = Number(req.query.limit) || 200;
        const offset = Number(req.query.offset) || 0;
        res.json({ success: true, ...listPeople({ limit, offset }) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/ai/people/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
    try {
        const label = req.body?.label;
        const updated = renamePerson(id, label == null ? null : String(label).slice(0, 80));
        log({ source: 'ai', level: 'info', msg: `person #${id} renamed to "${label}"` });
        res.json({ success: true, updated });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/ai/people/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
    try {
        const deleted = deletePerson(id);
        log({ source: 'ai', level: 'info', msg: `person #${id} deleted (faces unclustered)` });
        res.json({ success: true, deleted });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/ai/people/:id/photos', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
    try {
        const limit = Number(req.query.limit) || 50;
        const offset = Number(req.query.offset) || 0;
        res.json({ success: true, ...listPhotosForPerson(id, { limit, offset }) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/ai/perceptual-dedup/scan', async (_req, res) => {
    const cfg = _aiCfg();
    if (!cfg.enabled || !cfg.phash.enabled) {
        return res
            .status(503)
            .json({ error: 'Perceptual dedup is disabled', code: 'PHASH_DISABLED' });
    }
    const tracker = _jobTrackers.aiPhash;
    const r = tracker.tryStart(async ({ onProgress, signal }) => {
        return ai.runPhashScan({ onProgress, signal, onLog: log, fileTypes: cfg.fileTypes });
    });
    if (!r.started)
        return res
            .status(409)
            .json({ error: 'phash scan already running', code: 'ALREADY_RUNNING' });
    res.json({ success: true, started: true });
});

app.get('/api/ai/perceptual-dedup/scan/status', async (_req, res) => {
    res.json(_jobTrackers.aiPhash.getStatus());
});

app.get('/api/ai/perceptual-dedup/groups', async (req, res) => {
    try {
        const threshold = Math.max(0, Math.min(20, Number(req.query.threshold) || 6));
        const cfg = _aiCfg();
        const r = ai.findPhashGroups({ threshold, fileTypes: cfg.fileTypes });
        res.json({ success: true, ...r });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/ai/tags/scan', async (_req, res) => {
    const cfg = _aiCfg();
    if (!cfg.enabled || !cfg.tags.enabled) {
        return res.status(503).json({ error: 'Auto-tagging is disabled', code: 'TAGS_DISABLED' });
    }
    const tracker = _jobTrackers.aiTags;
    // Reuse the full index scan with only tags enabled — keeps the backfill
    // logic centralised. Other capabilities are tri-state (cap.* missing
    // = skip) so this only computes tags for the rows it visits.
    const onlyTags = {
        ...cfg,
        embeddings: { ...cfg.embeddings, enabled: false },
        faces: { ...cfg.faces, enabled: false },
        phash: { enabled: false },
    };
    const r = tracker.tryStart(async ({ onProgress, signal }) => {
        return ai.runIndexScan(onlyTags, { onProgress, signal, onLog: log });
    });
    if (!r.started)
        return res
            .status(409)
            .json({ error: 'tags scan already running', code: 'ALREADY_RUNNING' });
    res.json({ success: true, started: true });
});

app.get('/api/ai/tags/scan/status', async (_req, res) => {
    res.json(_jobTrackers.aiTags.getStatus());
});

app.get('/api/ai/tags', async (req, res) => {
    try {
        const minCount = Math.max(1, Number(req.query.min_count) || 1);
        res.json({ success: true, tags: listAllTags({ minCount }) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/ai/tags/:tag/photos', async (req, res) => {
    try {
        const tag = String(req.params.tag || '').trim();
        if (!tag) return res.status(400).json({ error: 'tag required' });
        const limit = Number(req.query.limit) || 50;
        const offset = Number(req.query.offset) || 0;
        res.json({ success: true, ...listPhotosForTag(tag, { limit, offset }) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ---- Model status + swap (v2.6 - operator visibility) -------------------
//
// The dashboard's "Models" panel asks: which AI models are loaded, how
// big are their on-disk caches, and what's the most recent download
// progress event? Single endpoint per page render — live progress arrives
// via the `ai_model_progress` WS event wired above.
app.get('/api/ai/models/status', async (_req, res) => {
    try {
        const cfg = _aiCfg();
        const meta = ai.pipelineMetaSnapshot();
        const errors = ai.pipelineErrorsSnapshot();
        const metaByKey = new Map(meta.map((m) => [m.key, m]));
        const errsByKey = new Map(errors.map((e) => [e.key, e]));

        const out = {};
        for (const desc of _MODEL_CAPS) {
            const capCfg = cfg[desc.cfgKey] || {};
            const modelId = capCfg.model || ai.AI_MODEL_DEFAULTS[desc.cfgKey]?.modelId || '';
            const kind = ai.AI_MODEL_DEFAULTS[desc.cfgKey]?.kind || desc.defaultKind;
            const key = `${kind}::${modelId}`;
            const m = metaByKey.get(key);
            const err = errsByKey.get(key);
            const cache = await ai.inspectModelCache(modelId, cfg.cacheDir);
            out[desc.cap] = {
                modelId,
                kind,
                enabled: capCfg.enabled === true,
                loaded: !!(m && m.loadedAt),
                loading: !!(m && !m.loadedAt),
                lastLoadedAt: m?.loadedAt || null,
                startedAt: m?.startedAt || null,
                lastProgress: m?.lastProgress || null,
                error: err ? err.message : null,
                cacheBytes: cache.bytes,
                cacheFiles: cache.files,
                cacheDir: cache.dir,
            };
        }
        res.json({
            success: true,
            cacheRoot: ai.resolveCacheDir(cfg.cacheDir),
            models: out,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Wipe the cached weights for a single model id. The next scan / search
// will redownload from huggingface.co. Confirm-gated on the client.
app.delete('/api/ai/models/cache', async (req, res) => {
    try {
        const modelId = String(req.query.model || req.body?.model || '').trim();
        if (!modelId) return res.status(400).json({ error: 'model id required' });
        const cfg = _aiCfg();
        // Drop the in-process pipeline first so the on-disk wipe doesn't
        // leave a stale handle wired to deleted weights.
        try {
            await ai.clearPipelineForModel(modelId);
        } catch {
            /* ignore */
        }
        const r = await ai.deleteModelCache(modelId, cfg.cacheDir);
        log({
            source: 'ai',
            level: 'info',
            msg: `model cache wiped: ${modelId} (${r.bytes} bytes)`,
        });
        res.json({ success: true, ...r });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// "More like this" — top-K rows by cosine similarity against the source
// row's embedding. Reuses the in-memory vector cache from vector-store.js
// so a second similar-search after a text search is essentially free
// (same cache hit).
app.post('/api/ai/search/similar', async (req, res) => {
    try {
        const downloadId = Number(req.body?.downloadId);
        if (!Number.isInteger(downloadId) || downloadId <= 0) {
            return res.status(400).json({ error: 'downloadId required' });
        }
        const cfg = _aiCfg();
        if (!cfg.enabled || !cfg.embeddings.enabled) {
            return res
                .status(503)
                .json({ error: 'AI embeddings are disabled', code: 'EMBEDDINGS_DISABLED' });
        }
        const limit = Math.max(1, Math.min(200, Number(req.body?.limit) || 24));
        // Pull every embedding (cache-friendly via vector-store.topK
        // re-using the same listing) so we can grab the source row's
        // vector without a new SELECT path.
        const { listAllImageEmbeddings } = await import('../core/db.js');
        const rows = listAllImageEmbeddings({ fileTypes: cfg.fileTypes });
        const src = rows.find((r) => r.download_id === downloadId);
        if (!src || !src.embedding) {
            return res.status(404).json({ error: 'no embedding for that download' });
        }
        const { blobToVector } = await import('../core/ai/vector-store.js');
        const vec = blobToVector(src.embedding);
        if (!vec) return res.status(500).json({ error: 'embedding decode failed' });
        // Run topK; remove the source row itself from the result list.
        const { topK } = await import('../core/ai/vector-store.js');
        const top = topK(vec, { limit: limit + 1, fileTypes: cfg.fileTypes });
        const results = top
            .filter((r) => r.download_id !== downloadId)
            .slice(0, limit)
            .map((r) => ({
                download_id: r.download_id,
                score: r.score,
                file_name: r.row.file_name,
                file_path: r.row.file_path,
                file_type: r.row.file_type,
                file_size: r.row.file_size,
                group_id: r.row.group_id,
                group_name: r.row.group_name,
                created_at: r.row.created_at,
            }));
        res.json({
            success: true,
            source: {
                download_id: src.download_id,
                file_name: src.file_name,
                group_id: src.group_id,
                group_name: src.group_name,
            },
            results,
            total: results.length,
        });
    } catch (e) {
        log({ source: 'ai', level: 'error', msg: `similar search failed: ${e?.message || e}` });
        res.status(500).json({ error: e.message });
    }
});

// ====== Share-link admin API ===============================================
//
// Admin-only by virtue of the chokepoint (the path isn't on either
// guest allowlist). Each call returns the canonical URL the SPA shows in
// the Share sheet — built from the request's own host+protocol so it
// works behind reverse proxies (helmet trust-proxy is set elsewhere).
function _shareUrlFor(req, linkId, expSec) {
    const proto = req.protocol;
    const host = req.get('host');
    return `${proto}://${host}${buildShareUrlPath(linkId, expSec)}`;
}

function _shareLinkPayload(req, row) {
    const expSec = Math.floor(row.expires_at ?? row.expiresAt ?? 0);
    const linkId = row.id;
    return {
        id: linkId,
        downloadId: row.download_id ?? row.downloadId,
        createdAt: row.created_at ?? row.createdAt,
        expiresAt: expSec,
        revokedAt: row.revoked_at ?? null,
        label: row.label ?? null,
        accessCount: row.access_count ?? 0,
        lastAccessedAt: row.last_accessed_at ?? null,
        fileName: row.file_name,
        fileType: row.file_type,
        fileSize: row.file_size,
        groupId: row.group_id,
        groupName: row.group_name,
        url: _shareUrlFor(req, linkId, expSec),
    };
}

// Mint a new share link for a single download row. Body:
//   { downloadId, ttlSeconds?, label? }
// ttlSeconds is clamped to [60, 90 days]; default 7 days.
app.post('/api/share/links', async (req, res) => {
    try {
        const { downloadId, ttlSeconds, label } = req.body || {};
        const did = parseInt(downloadId, 10);
        if (!Number.isInteger(did) || did <= 0) {
            return res.status(400).json({ error: 'downloadId required' });
        }
        // Confirm the download row exists — otherwise the link would
        // perpetually 404, and we'd be storing useless rows.
        const exists = getDb().prepare('SELECT id FROM downloads WHERE id = ?').get(did);
        if (!exists) return res.status(404).json({ error: 'Download not found' });

        // Pass through whatever the caller sent (including null/undefined).
        // clampTtlSeconds resolves "missing" → the *current* configured
        // default — pulling it back out via getShareLimits() here would
        // race with config_updated. The clamp handles 0 (never expires)
        // and negative / NaN inputs internally.
        const ttl = clampTtlSeconds(ttlSeconds);
        // ttl === 0 = "never expires" sentinel — store expires_at = 0
        // (the verifier skips the time gate; revocation still works).
        const expSec = ttl === 0 ? 0 : Math.floor(Date.now() / 1000) + ttl;
        // Defensive label hygiene — keep labels short and free of control
        // chars so they render safely in the admin UI without escaping.
        const cleanLabel =
            typeof label === 'string'
                ? label
                      .replace(/[\r\n\t]/g, ' ')
                      .trim()
                      .slice(0, 80) || null
                : null;

        const { id } = createShareLink({ downloadId: did, expiresAt: expSec, label: cleanLabel });

        // Re-load with the joined download metadata so the response is the
        // same shape as the list endpoint (UI doesn't have to re-fetch).
        const list = listShareLinks({ downloadId: did, limit: 1000 });
        const row = list.find((r) => r.id === id);
        res.json({ success: true, link: row ? _shareLinkPayload(req, row) : null });
    } catch (e) {
        console.error('share/links create:', e);
        res.status(500).json({ error: e.message });
    }
});

// List share-links — `?downloadId=…` filters to one file (Share sheet);
// no filter returns ALL links across the library (Maintenance sheet).
app.get('/api/share/links', async (req, res) => {
    try {
        const downloadId = req.query.downloadId ? parseInt(req.query.downloadId, 10) : null;
        const includeRevoked = req.query.includeRevoked !== '0';
        const rows = listShareLinks({ downloadId, includeRevoked });
        res.json({
            success: true,
            links: rows.map((r) => _shareLinkPayload(req, r)),
        });
    } catch (e) {
        console.error('share/links list:', e);
        res.status(500).json({ error: e.message });
    }
});

// Revoke a single share-link by id. Idempotent — revoking an already-
// revoked link returns success: true with revoked: false.
app.delete('/api/share/links/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: 'Invalid id' });
        }
        const did = revokeShareLink(id);
        res.json({ success: true, revoked: did });
    } catch (e) {
        console.error('share/links revoke:', e);
        res.status(500).json({ error: e.message });
    }
});

// List logfiles under data/logs/ with size + mtime — used by the SPA to
// populate the "Download log" picker.
app.get('/api/maintenance/logs', async (req, res) => {
    try {
        if (!existsSync(LOGS_DIR)) return res.json({ files: [] });
        const names = fsSync.readdirSync(LOGS_DIR).filter((f) => f.endsWith('.log'));
        const files = names
            .map((name) => {
                try {
                    const st = fsSync.statSync(path.join(LOGS_DIR, name));
                    return { name, size: st.size, modified: st.mtime.toISOString() };
                } catch {
                    return null;
                }
            })
            .filter(Boolean);
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
        if (
            !name ||
            name.includes('/') ||
            name.includes('\\') ||
            name.includes('\0') ||
            !name.endsWith('.log')
        ) {
            return res.status(400).json({ error: 'Invalid log name' });
        }
        const lines = Math.max(10, Math.min(100000, parseInt(req.query.lines, 10) || 5000));
        const filePath = path.join(LOGS_DIR, name);
        if (!existsSync(filePath)) return res.status(404).json({ error: 'Log not found' });

        // Realpath check defends against symlink escapes that the basename
        // filter can't catch (e.g. logs/foo.log -> /etc/passwd). Resolve
        // both sides so a case-insensitive FS or a symlinked LOGS_DIR still
        // compares cleanly.
        try {
            const realFile = fsSync.realpathSync(filePath);
            const realLogs = fsSync.realpathSync(LOGS_DIR);
            if (realFile !== realLogs && !realFile.startsWith(realLogs + path.sep)) {
                return res.status(400).json({ error: 'Path escape detected' });
            }
        } catch {
            return res.status(400).json({ error: 'Invalid log name' });
        }

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
        if (
            accountId.includes('/') ||
            accountId.includes('\\') ||
            accountId.includes('..') ||
            accountId.includes('\0')
        ) {
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
        const config = loadConfig();
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
        const config = loadConfig();
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
            safe.accounts = safe.accounts.map((a) => ({
                id: a.id,
                name: a.name,
                username: a.username,
            }));
        }
        // Per-group account assignments are an internal mapping; surface only
        // a boolean so the SPA can show "(custom account)".
        if (Array.isArray(safe.groups)) {
            safe.groups = safe.groups.map((g) => {
                const out = { ...g };
                if (out.monitorAccount) {
                    out.hasMonitorAccount = true;
                    delete out.monitorAccount;
                }
                if (out.forwardAccount) {
                    out.hasForwardAccount = true;
                    delete out.forwardAccount;
                }
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

        // Defence-in-depth against prototype pollution. JSON.parse already
        // rejects __proto__ as a key on most engines, but a cooperating
        // client could still attempt `constructor.prototype` etc. Strip
        // those keys recursively before any spread/merge below.
        const sanitizePollutionKeys = (obj) => {
            if (!obj || typeof obj !== 'object') return obj;
            for (const k of ['__proto__', 'constructor', 'prototype']) {
                if (Object.prototype.hasOwnProperty.call(obj, k)) delete obj[k];
            }
            for (const v of Object.values(obj)) {
                if (v && typeof v === 'object') sanitizePollutionKeys(v);
            }
            return obj;
        };
        sanitizePollutionKeys(req.body);

        const currentConfig = loadConfig();
        const newConfig = { ...currentConfig, ...req.body };

        // Deep-merge sub-sections so a partial PATCH (e.g., only telegram.apiId)
        // doesn't blow away the rest of that section (e.g., telegram.apiHash).
        if (req.body.telegram)
            newConfig.telegram = { ...currentConfig.telegram, ...req.body.telegram };
        if (req.body.download)
            newConfig.download = { ...currentConfig.download, ...req.body.download };
        if (req.body.rateLimits)
            newConfig.rateLimits = { ...currentConfig.rateLimits, ...req.body.rateLimits };
        if (req.body.diskManagement)
            newConfig.diskManagement = {
                ...currentConfig.diskManagement,
                ...req.body.diskManagement,
            };
        if (req.body.rescue)
            newConfig.rescue = { ...(currentConfig.rescue || {}), ...req.body.rescue };
        if (req.body.proxy === null)
            newConfig.proxy = null; // explicit clear
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
                share: {
                    ...(cur.share || {}),
                    ...(inc.share || {}),
                },
                nsfw: {
                    ...(cur.nsfw || {}),
                    ...(inc.nsfw || {}),
                },
                thumbs: {
                    ...(cur.thumbs || {}),
                    ...(inc.thumbs || {}),
                },
                ai: (() => {
                    // Two-level deep-merge for the AI namespace so the
                    // model-swap UI can PATCH a single capability's model
                    // id without flattening the others. Per-capability
                    // sub-objects are spread individually for the same
                    // reason.
                    const c = cur.ai || {};
                    const i = inc.ai || {};
                    const merged = {
                        ...c,
                        ...i,
                        embeddings: { ...(c.embeddings || {}), ...(i.embeddings || {}) },
                        faces: { ...(c.faces || {}), ...(i.faces || {}) },
                        tags: { ...(c.tags || {}), ...(i.tags || {}) },
                        phash: { ...(c.phash || {}), ...(i.phash || {}) },
                    };
                    // HuggingFace access token — string only; trim + cap at
                    // 256 chars (real tokens are ~37 chars, anything longer
                    // is malformed input). Empty string clears the token.
                    if (typeof merged.hfToken === 'string') {
                        merged.hfToken = merged.hfToken.trim().slice(0, 256);
                    } else if (merged.hfToken != null) {
                        merged.hfToken = '';
                    }
                    return merged;
                })(),
            };
            // ffmpeg hwaccel — allow-list validation. An attacker who
            // got past the admin gate could otherwise pass arbitrary
            // text into the ffmpeg `-hwaccel <…>` arg. Allow-list keeps
            // the universe of accepted values explicit; anything off-list
            // falls back to '' (CPU). Documented in docs/DEPLOY.md.
            const HWACCEL_ALLOW = new Set([
                '',
                'vaapi',
                'qsv',
                'cuda',
                'videotoolbox',
                'd3d11va',
                'dxva2',
            ]);
            const hwIn = String(merged.thumbs?.hwaccel || '')
                .toLowerCase()
                .trim();
            merged.thumbs.hwaccel = HWACCEL_ALLOW.has(hwIn) ? hwIn : '';
            // warnMisses — boolean, default true. Coerce non-false to true
            // so a hand-edited string ("yes", 1) doesn't quietly disable
            // the helpful warning.
            merged.thumbs.warnMisses = merged.thumbs.warnMisses !== false;
            // Clamp every numeric so a typo can't ban the user from logging
            // in (sessionTtlDays=0) or hose the downloader (minConcurrency=0).
            const d = merged.downloader;
            d.minConcurrency = clampInt(d.minConcurrency, 1, 100, 3);
            d.maxConcurrency = clampInt(d.maxConcurrency, 1, 100, 20);
            if (d.maxConcurrency < d.minConcurrency) d.maxConcurrency = d.minConcurrency;
            d.scalerIntervalSec = clampInt(d.scalerIntervalSec, 1, 600, 5);
            d.idleSleepMs = clampInt(d.idleSleepMs, 50, 10000, 200);
            d.spilloverThreshold = clampInt(d.spilloverThreshold, 100, 100000, 2000);

            const h = merged.history;
            h.backpressureCap = clampInt(h.backpressureCap, 10, 100000, 500);
            h.backpressureMaxWaitMs = clampInt(h.backpressureMaxWaitMs, 5000, 3600000, 900000);
            h.shortBreakEveryN = clampInt(h.shortBreakEveryN, 0, 100000, 100);
            h.longBreakEveryN = clampInt(h.longBreakEveryN, 0, 1000000, 1000);
            // Recent-backfills retention. Anything older than this gets
            // pruned at next read of `data/history-jobs.json`. 1-3650 days.
            h.retentionDays = clampInt(h.retentionDays, 1, 3650, 30);
            // v2.3.34 — auto-backfill knobs
            h.autoFirstBackfill = h.autoFirstBackfill !== false; // default ON
            h.autoFirstLimit = clampInt(h.autoFirstLimit, 0, 10000, 100);
            h.autoCatchUp = h.autoCatchUp !== false; // default ON
            h.autoCatchUpThreshold = clampInt(h.autoCatchUpThreshold, 1, 100000, 5);
            h.batchInsertSize = clampInt(h.batchInsertSize, 1, 500, 50);
            h.batchInsertMaxAgeMs = clampInt(h.batchInsertMaxAgeMs, 100, 60000, 1000);

            const sh = merged.share;
            // 1 second floor / 10 years ceiling. Defaults match the spec
            // values share.js uses pre-config (60 / 90d / 7d).
            sh.ttlMinSec = clampInt(sh.ttlMinSec, 1, 315360000, 60);
            sh.ttlMaxSec = clampInt(sh.ttlMaxSec, sh.ttlMinSec, 315360000, 7776000);
            // ttlDefault must lie inside [min, max] — clamped here so the
            // SPA can't ship an out-of-range default that fails the picker.
            sh.ttlDefaultSec = clampInt(sh.ttlDefaultSec, sh.ttlMinSec, sh.ttlMaxSec, 604800);
            sh.rateLimitWindowMs = clampInt(sh.rateLimitWindowMs, 1000, 3600000, 60000);
            sh.rateLimitMax = clampInt(sh.rateLimitMax, 1, 100000, 60);

            // NSFW review tool. All values are config-driven — no hardcoded
            // model id, threshold, or concurrency in code.
            const ns = merged.nsfw;
            ns.enabled = ns.enabled === true; // explicit opt-in only
            // Threshold is on a 0-1 score axis; clamped via integer math by
            // multiplying through so the same clampInt helper works.
            const tInt = Math.round((Number(ns.threshold) || NSFW_DEFAULTS.threshold) * 1000);
            ns.threshold = clampInt(tInt, 100, 990, 600) / 1000;
            ns.concurrency = clampInt(ns.concurrency, 1, 4, NSFW_DEFAULTS.concurrency);
            ns.batchSize = clampInt(ns.batchSize, 10, 500, NSFW_DEFAULTS.batchSize);
            // Model id + cache dir + fileTypes are strings/arrays — light
            // validation only (string coerce, allowlist-strip).
            ns.model =
                typeof ns.model === 'string' && ns.model.trim()
                    ? ns.model.trim()
                    : NSFW_DEFAULTS.model;
            // dtype controls which ONNX variant is fetched from HuggingFace.
            // Allow-list keeps a typo from sending arbitrary text to the
            // transformers.js loader and helps the UI fall back to the
            // documented default when the operator clears the field.
            const NSFW_DTYPES = new Set(['q8', 'fp16', 'fp32', 'q4']);
            const dIn = String(ns.dtype || '')
                .toLowerCase()
                .trim();
            ns.dtype = NSFW_DTYPES.has(dIn) ? dIn : NSFW_DEFAULTS.dtype;
            ns.cacheDir =
                typeof ns.cacheDir === 'string' && ns.cacheDir.trim()
                    ? ns.cacheDir.trim()
                    : NSFW_DEFAULTS.cacheDir;
            const ALLOWED_TYPES = ['photo', 'video', 'sticker', 'document'];
            ns.fileTypes = (Array.isArray(ns.fileTypes) ? ns.fileTypes : NSFW_DEFAULTS.fileTypes)
                .map((s) => String(s).toLowerCase())
                .filter((s) => ALLOWED_TYPES.includes(s));
            if (!ns.fileTypes.length) ns.fileTypes = NSFW_DEFAULTS.fileTypes.slice();

            const r = merged.diskRotator;
            r.sweepBatch = clampInt(r.sweepBatch, 1, 1000, 50);
            r.maxDeletesPerSweep = clampInt(r.maxDeletesPerSweep, 1, 100000, 5000);

            const it = merged.integrity;
            it.intervalMin = clampInt(it.intervalMin, 1, 10080, 60);
            it.batchSize = clampInt(it.batchSize, 1, 1024, 64);

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
        // Re-apply runtime knobs that depend on advanced.share / advanced.history
        // so a save takes effect immediately without a process restart.
        try {
            applyShareLimits(newConfig.advanced?.share || {});
            _invalidateShareConfigCache();
        } catch {}

        // Reset the lazy AccountManager singleton if Telegram credentials
        // changed — a stale instance would still be wired to the old apiId.
        if (req.body.telegram && _accountManager) {
            try {
                await _accountManager.disconnectAll();
            } catch {}
            _accountManager = null;
        }

        // Refresh the cached rate-limit config so the toggle / RPM change
        // takes effect immediately instead of waiting for the 30s sweep.
        if (req.body.web?.rateLimit) refreshRateLimitConfig();

        // Drop cached AI pipelines for any capability whose model id
        // changed. Without this, a save through the model-swap UI would
        // not take effect until the process restarted because the old
        // pipeline handle is still cached under the old id.
        if (req.body.advanced?.ai) {
            try {
                const oldAi = currentConfig.advanced?.ai || {};
                const newAi = newConfig.advanced?.ai || {};
                const _drop = async (oldId) => {
                    if (oldId) await ai.clearPipelineForModel(oldId);
                };
                for (const cap of ['embeddings', 'faces', 'tags']) {
                    const o = oldAi[cap]?.model || '';
                    const n = newAi[cap]?.model || '';
                    if (o && o !== n) _drop(o).catch(() => {});
                }
            } catch (e) {
                console.warn('[ai] pipeline reset failed:', e.message);
            }
        }

        // Restart the disk rotator if the user changed any diskManagement
        // field — picks up the new cap / enabled / interval on the very next
        // sweep instead of waiting for whatever was already scheduled.
        if (req.body.diskManagement || req.body.advanced?.diskRotator) {
            try {
                getDiskRotator()?.restart();
            } catch (e) {
                console.warn('[disk-rotator] restart failed:', e.message);
            }
        }
        // Same story for the rescue sweeper — sweep cadence (and the global
        // enabled flag, since per-group 'auto' follows it) needs to take
        // effect immediately, not on the next scheduled tick.
        if (req.body.rescue) {
            try {
                getRescueSweeper()?.restart();
            } catch (e) {
                console.warn('[rescue] restart failed:', e.message);
            }
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
                    batchSize: Number(ai.batchSize) > 0 ? Number(ai.batchSize) : 64,
                });
            } catch (e) {
                console.warn('[integrity] restart failed:', e.message);
            }
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
        const config = loadConfig();
        const groupId = req.params.id;
        let groupIndex = config.groups.findIndex((g) => String(g.id) === groupId);

        if (groupIndex === -1) {
            // Create new — resolve a real name from any loaded account.
            let groupName = req.body.name;
            if (
                !groupName ||
                groupName === 'Unknown' ||
                groupName === groupId ||
                groupName.startsWith('Group ')
            ) {
                const r = await resolveEntityAcrossAccounts(groupId);
                if (r?.entity) {
                    const e = r.entity;
                    groupName =
                        e.title ||
                        (e.firstName && e.firstName + (e.lastName ? ' ' + e.lastName : '')) ||
                        e.username ||
                        groupName;
                }
            }
            const newGroup = {
                id: groupId.startsWith('-') ? parseInt(groupId) : groupId,
                name: groupName || `Unknown`,
                enabled: req.body.enabled ?? false,
                filters: {
                    photos: true,
                    videos: true,
                    files: true,
                    links: true,
                    voice: false,
                    gifs: false,
                    stickers: false,
                },
                autoForward: { enabled: false, destination: null, deleteAfterForward: false },
                trackUsers: { enabled: false, users: [] },
                topics: { enabled: false, ids: [] },
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
            else
                group.topics = {
                    enabled: !!req.body.topics.enabled,
                    ids: Array.isArray(req.body.topics.ids)
                        ? req.body.topics.ids.map(Number).filter(Number.isFinite)
                        : [],
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

        // Auto-backfill on first add (v2.3.34) — when a group transitions
        // from "never seen / disabled" → "enabled" AND has zero rows in
        // downloads yet, kick off a background backfill of the last N
        // messages so the user gets immediate gallery content without
        // having to navigate to the Backfill page. Bounded by config so
        // operators who don't want this behavior can disable it.
        try {
            if (req.body.enabled === true && !_activeBackfillsByGroup.has(String(group.id))) {
                const histCfg = config.advanced?.history || {};
                const autoOn = histCfg.autoFirstBackfill !== false; // default ON
                const autoLim = Number(histCfg.autoFirstLimit ?? 100); // default 100
                if (autoOn && autoLim > 0) {
                    const { count } = (await import('../core/db.js')).getMessageIdRange(
                        String(group.id),
                    );
                    if (count === 0) {
                        // Fire-and-forget — POST /api/history would be the
                        // ideal way but we'd need to invoke it as an
                        // internal call. Calling our handler logic directly
                        // keeps everything in one process without an HTTP
                        // hop. Failures are non-fatal: the user can always
                        // trigger backfill manually from the Backfill page.
                        _spawnInternalBackfill({
                            groupId: String(group.id),
                            limit: Math.max(1, Math.min(10000, autoLim)),
                            mode: 'pull-older',
                            reason: 'auto-first',
                        }).catch((e) =>
                            console.warn('[auto-backfill] first-add failed:', e?.message || e),
                        );
                    }
                }
            }
        } catch (e) {
            // Non-fatal — group save still succeeded.
            console.warn('[auto-backfill] hook error:', e?.message || e);
        }

        res.json({ success: true, group: config.groups[groupIndex] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Internal helper — spawn a backfill job exactly as POST /api/history
 * would, without going through the HTTP layer. Used by:
 *   - Auto-backfill on first group add (PUT /api/groups/:id new+enabled)
 *   - Catch-up backfill after monitor restart (monitor.js boot hook)
 *
 * Resolves once the job is *registered* (not when the actual download
 * finishes) so callers don't block. Returns the new jobId.
 */
async function _spawnInternalBackfill({
    groupId,
    limit,
    mode = 'pull-older',
    reason = 'internal',
}) {
    const groupKey = String(groupId);
    if (_activeBackfillsByGroup.has(groupKey)) return null;
    const am = await getAccountManager();
    if (am.count === 0) throw new Error('No Telegram accounts loaded');
    const config = loadConfig();
    const group = (config.groups || []).find((g) => String(g.id) === groupKey);
    if (!group) throw new Error('Group not configured');

    const { HistoryDownloader } = await import('../core/history.js');
    const { DownloadManager } = await import('../core/downloader.js');
    const { RateLimiter } = await import('../core/security.js');
    const standalone = !runtime._downloader;
    const downloader =
        runtime._downloader ||
        new DownloadManager(am.getDefaultClient(), config, new RateLimiter(config.rateLimits));
    if (standalone) {
        await downloader.init();
        downloader.start();
    }
    const history = new HistoryDownloader(am.getDefaultClient(), downloader, config, am);

    const jobId = crypto.randomBytes(6).toString('hex');
    const lim =
        limit === null || limit === 0 ? null : Math.max(1, Math.min(50000, Number(limit) || 100));
    const job = {
        id: jobId,
        state: 'running',
        processed: 0,
        downloaded: 0,
        error: null,
        group: group.name,
        groupId: groupKey,
        limit: lim,
        startedAt: Date.now(),
        finishedAt: null,
        cancelled: false,
        mode,
        reason,
        _runner: history,
    };
    _historyJobs.set(jobId, job);
    _activeBackfillsByGroup.set(groupKey, jobId);
    history.on('progress', (s) => {
        job.processed = s.processed;
        job.downloaded = s.downloaded;
        broadcast({
            type: 'history_progress',
            jobId,
            ...s,
            group: group.name,
            groupId: groupKey,
            limit: job.limit,
            startedAt: job.startedAt,
            mode: job.mode,
        });
    });
    history.on('start', (s) => {
        if (s?.mode) job.mode = s.mode;
    });
    history
        .downloadHistory(groupKey, { limit: lim ?? undefined, mode })
        .then(() => {
            job.state = job.cancelled ? 'cancelled' : 'done';
            job.finishedAt = Date.now();
            delete job._runner;
            const evt = job.cancelled ? 'history_cancelled' : 'history_done';
            broadcast({ type: evt, jobId, group: group.name, ...job });
            if (standalone) downloader.stop().catch(() => {});
            saveHistoryJobsToDisk().catch(() => {});
            if (_activeBackfillsByGroup.get(groupKey) === jobId)
                _activeBackfillsByGroup.delete(groupKey);
            setTimeout(() => _historyJobs.delete(jobId), 5 * 60 * 1000);
        })
        .catch((err) => {
            job.state = 'error';
            job.error = err?.message || String(err);
            job.finishedAt = Date.now();
            delete job._runner;
            broadcast({
                type: 'history_error',
                jobId,
                error: job.error,
                group: group.name,
                groupId: groupKey,
            });
            // Same hint flow as the user-triggered branch above so auto-
            // backfills (first-add bootstrap, post-restart catch-up) get
            // a readable diagnostic when they fail.
            const hint = /no available account/i.test(job.error)
                ? ' (no logged-in account can read this group — check Settings → Telegram Accounts)'
                : '';
            log({
                source: 'backfill',
                level: 'error',
                msg: `auto-backfill failed for "${group.name}" (${groupKey}): ${job.error}${hint}`,
            });
            if (standalone) downloader.stop().catch(() => {});
            saveHistoryJobsToDisk().catch(() => {});
            if (_activeBackfillsByGroup.get(groupKey) === jobId)
                _activeBackfillsByGroup.delete(groupKey);
        });
    return jobId;
}

// 9. Profile Photos
app.get('/api/groups/:id/photo', async (req, res) => {
    const id = req.params.id;
    // Telegram entity IDs are signed integers — anything else is suspicious
    // (path-traversal attempts, control chars, NUL, etc.). Reject hard
    // before we touch the filesystem.
    if (!/^-?\d+$/.test(id)) return res.status(400).send('Invalid id');
    const photoPath = path.join(PHOTOS_DIR, `${id}.jpg`);

    // Realpath check defends against the case where PHOTOS_DIR or one of
    // its descendants is a symlink that points outside the data dir.
    const send = () => {
        try {
            const real = fsSync.realpathSync(photoPath);
            const realRoot = fsSync.realpathSync(PHOTOS_DIR);
            if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
                return res.status(400).send('Path escape detected');
            }
            // Override the global /api/* `no-store` policy — avatar bytes
            // are content-addressed by group ID and the file is rewritten
            // in place when the group's photo changes, so a 1-day private
            // cache is safe AND eliminates the per-render avatar flicker
            // (every renderGroupsList re-paint was triggering a fresh
            // round trip thanks to no-store).
            res.setHeader('Cache-Control', 'private, max-age=86400, stale-while-revalidate=604800');
            return res.sendFile(real);
        } catch {
            return res.status(404).send('Not found');
        }
    };

    if (existsSync(photoPath)) return send();

    // Try download if not exists
    const url = await downloadProfilePhoto(id);
    if (url && existsSync(photoPath)) return send();

    res.status(404).send('Not found');
});

// Walks every group (config-defined and DB-only) and tries to resolve a
// human-readable name + cached profile photo. Used by the SPA when it
// detects a row whose name is "Unknown" or just the numeric id.
//
// Fire-and-forget — with 100 groups × Telegram rate limits this can take
// 30+ s. POST returns instantly; per-id progress streams via
// `groups_refresh_info_progress`, the final `updates` array via
// `groups_refresh_info_done`. The legacy `groups_refreshed` broadcast is
// preserved for clients that already subscribe to it.
app.post('/api/groups/refresh-info', async (req, res) => {
    const tracker = _jobTrackers.groupsRefreshInfo;
    const r = tracker.tryStart(async ({ onProgress }) => {
        const config = loadConfig();
        const ids = new Set((config.groups || []).map((g) => String(g.id)));
        try {
            const rows = getDb()
                .prepare('SELECT DISTINCT group_id, group_name FROM downloads')
                .all();
            for (const rr of rows) ids.add(String(rr.group_id));
        } catch {}

        let updated = 0;
        let mutatedConfig = false;
        const updates = [];
        const total = ids.size;
        let processed = 0;
        onProgress({ processed: 0, total, updated: 0, stage: 'resolving' });
        for (const id of ids) {
            const resolved = await resolveEntityAcrossAccounts(id);
            if (resolved) {
                const { entity } = resolved;
                const realName =
                    entity?.title ||
                    (entity?.firstName &&
                        entity.firstName + (entity.lastName ? ' ' + entity.lastName : '')) ||
                    entity?.username ||
                    null;
                if (realName) {
                    const cg = (config.groups || []).find((g) => String(g.id) === id);
                    if (
                        cg &&
                        (!cg.name ||
                            cg.name === 'Unknown' ||
                            cg.name === id ||
                            cg.name.startsWith('Group '))
                    ) {
                        cg.name = realName;
                        mutatedConfig = true;
                    }
                    try {
                        const stmt = getDb().prepare(
                            `UPDATE downloads SET group_name = ? WHERE group_id = ? AND (group_name IS NULL OR group_name = '' OR group_name = 'Unknown' OR group_name = ?)`,
                        );
                        stmt.run(realName, id, id);
                    } catch {}
                    updates.push({ id, name: realName });
                    updated++;
                }
                await downloadProfilePhoto(id).catch(() => {});
            }
            processed += 1;
            onProgress({ processed, total, updated, stage: 'resolving' });
        }
        if (mutatedConfig) await writeConfigAtomic(config);
        if (updates.length) {
            try {
                broadcast({ type: 'groups_refreshed', updates });
            } catch {}
        }
        return { updated, scanned: total, updates };
    });
    if (!r.started) {
        // Hydrate the snapshot so the front-end keeps the button disabled
        // and doesn't show a misleading "failed" toast.
        return res.status(409).json({
            error: 'Group refresh already in progress',
            code: 'ALREADY_RUNNING',
            snapshot: r.snapshot,
        });
    }
    res.json({ success: true, started: true });
});

app.get('/api/groups/refresh-info/status', async (req, res) => {
    res.json(_jobTrackers.groupsRefreshInfo.getStatus());
});

app.post('/api/groups/refresh-photos', async (req, res) => {
    const tracker = _jobTrackers.groupsRefreshPhotos;
    const r = tracker.tryStart(async ({ onProgress }) => {
        const config = loadConfig();
        const groups = config.groups || [];
        const total = groups.length;
        let processed = 0;
        const results = [];
        onProgress({ processed: 0, total, stage: 'downloading' });
        for (const group of groups) {
            const url = await downloadProfilePhoto(group.id).catch(() => null);
            results.push({ id: group.id, url });
            processed += 1;
            onProgress({ processed, total, stage: 'downloading' });
        }
        return { results };
    });
    if (!r.started) {
        return res
            .status(409)
            .json({ error: 'Photo refresh already in progress', code: 'ALREADY_RUNNING' });
    }
    res.json({ success: true, started: true });
});

app.get('/api/groups/refresh-photos/status', async (req, res) => {
    res.json(_jobTrackers.groupsRefreshPhotos.getStatus());
});

// ============ FILE SERVING ============
// Serve files from data/downloads. Uses safeResolveDownload to reject path
// traversal, NUL bytes, and symlink escapes. Adds Content-Disposition so a
// rogue HTML file can't be rendered inline (the browser still inlines images
// and videos via the explicit ?inline=1 query parameter the SPA passes).
app.use('/files', async (req, res, next) => {
    try {
        let reqPath;
        try {
            reqPath = decodeURIComponent(req.path).replace(/^\//, '');
        } catch {
            return res.status(400).send('Bad request');
        }
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
                        const result = db
                            .prepare(`DELETE FROM downloads WHERE file_path = ? OR file_path = ?`)
                            .run(fwd, bwd);
                        if (result.changes > 0) {
                            broadcast({ type: 'file_deleted', path: fwd, autoPruned: true });
                        }
                    } catch {
                        /* never let a stray request crash the server */
                    }
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
            `${dispKind}; filename*=UTF-8''${encodeURIComponent(baseName)}`,
        );

        // HEIC / HEIF inline view — browsers don't render the format
        // natively (Safari excepted, and even there only on iOS / macOS).
        // For inline requests we transcode on the fly to JPEG via sharp's
        // built-in libheif (compiled into the prebuilt sharp binary), and
        // cache the result so the second open is a static stream. Disk
        // download (`?inline=1` absent) keeps the original .heic bytes.
        const heicExt = path.extname(r.real).toLowerCase();
        if (inline && (heicExt === '.heic' || heicExt === '.heif')) {
            try {
                const cachePath = await _heicInlineCache(r.real);
                res.setHeader('Content-Type', 'image/jpeg');
                res.setHeader('Cache-Control', 'private, max-age=86400');
                return res.sendFile(cachePath);
            } catch (e) {
                console.warn('[heic] inline transcode failed:', baseName, e?.message || e);
                // Fall through to raw .heic — Safari users still get the file.
            }
        }
        res.sendFile(r.real);
    } catch (e) {
        next();
    }
});

// HEIC inline cache — a single transcoded JPEG per source file. Keyed by
// (path, mtime) so an edited / replaced .heic re-renders. Cache directory
// is the same one thumbs.js owns, namespaced under heic-cache/ so the
// thumb purge button doesn't sweep these mid-view.
const _HEIC_CACHE_DIR = path.join(DATA_DIR, 'thumbs', 'heic-cache');
async function _heicInlineCache(srcAbs) {
    await fs.mkdir(_HEIC_CACHE_DIR, { recursive: true });
    const st = await fs.stat(srcAbs);
    const key = crypto.createHash('sha1').update(`${srcAbs}\0${st.mtimeMs}`).digest('hex');
    const dst = path.join(_HEIC_CACHE_DIR, `${key}.jpg`);
    if (existsSync(dst)) return dst;
    // Rotate honors EXIF orientation; quality 85 / progressive trades a
    // little CPU for visibly nicer rendering vs the default 80.
    const sharp = (await import('sharp')).default;
    await sharp(srcAbs, { failOn: 'none' })
        .rotate()
        .jpeg({ quality: 85, progressive: true })
        .toFile(dst);
    return dst;
}

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

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function broadcast(data) {
    const message = JSON.stringify(data);
    clients.forEach((client) => {
        if (client.readyState === 1) client.send(message);
    });
}

// ---- In-memory log ring + WS stream ---------------------------------------
//
// Keeps the last LOG_BUFFER_SIZE structured log entries so the
// /maintenance/logs page can render history on first paint instead of
// waiting for live events. Each entry is also broadcast over WS as a
// `log` message — admin clients hold an open socket and tail in real time.
//
// Each entry: { ts:number(ms), source:string, level:'info'|'warn'|'error', msg:string }
//
// The buffer is bounded so a chatty failure mode (e.g. an integrity sweep
// looping on a missing file) can't grow it without limit.
const LOG_BUFFER_SIZE = 1000;
const _logBuffer = [];

function log({ source = 'app', level = 'info', msg = '' }) {
    const entry = { ts: Date.now(), source, level, msg: String(msg).slice(0, 4000) };
    _logBuffer.push(entry);
    if (_logBuffer.length > LOG_BUFFER_SIZE) _logBuffer.shift();
    try {
        broadcast({ type: 'log', ...entry });
    } catch {}
    // Mirror to stdout/stderr so the docker logs / journald path keeps
    // working — the web view is additive, not a replacement.
    const line = `[${new Date(entry.ts).toISOString()}] [${source}] [${level}] ${entry.msg}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
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
    nsfwBulk: createJobTracker({ kind: 'nsfwBulk', broadcast, log, eventPrefix: 'nsfw_bulk' }),
    thumbsRebuild: createJobTracker({
        kind: 'thumbsRebuild',
        broadcast,
        log,
        eventPrefix: 'thumbs_rebuild',
    }),
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
    // AI subsystem (v2.6.0) — one tracker per long-running scan kind.
    aiIndex: createJobTracker({ kind: 'aiIndex', broadcast, log, eventPrefix: 'ai_index' }),
    aiPeople: createJobTracker({ kind: 'aiPeople', broadcast, log, eventPrefix: 'ai_people' }),
    aiPhash: createJobTracker({ kind: 'aiPhash', broadcast, log, eventPrefix: 'ai_phash' }),
    aiTags: createJobTracker({ kind: 'aiTags', broadcast, log, eventPrefix: 'ai_tags' }),
};
// One tracker per group id for `/api/groups/:id/purge`. Lazily created
// because we don't know the group ids in advance, and a group that's
// finished its purge can be GC'd from this map. Keep last 32 to bound.
const _groupPurgeTrackers = new Map();
function _groupPurgeTracker(groupId) {
    const k = `groupPurge:${groupId}`;
    if (!_groupPurgeTrackers.has(k)) {
        if (_groupPurgeTrackers.size >= 32) {
            // Evict the oldest non-running tracker.
            for (const [oldKey, t] of _groupPurgeTrackers) {
                if (!t.isRunning()) {
                    _groupPurgeTrackers.delete(oldKey);
                    break;
                }
            }
        }
        _groupPurgeTrackers.set(
            k,
            createJobTracker({
                kind: k,
                broadcast,
                log,
                eventPrefix: 'group_purge',
            }),
        );
    }
    return _groupPurgeTrackers.get(k);
}

// Snapshot for GET /api/maintenance/logs/recent — newest first, capped.
app.get('/api/maintenance/logs/recent', async (req, res) => {
    const limit = Math.max(1, Math.min(LOG_BUFFER_SIZE, Number(req.query.limit) || 200));
    const sources = req.query.source ? String(req.query.source).split(',') : null;
    const minLevel = req.query.level || null; // 'info'|'warn'|'error'
    const levelOrder = { info: 0, warn: 1, error: 2 };
    const minLvl = minLevel ? (levelOrder[minLevel] ?? 0) : 0;
    const filtered = _logBuffer.filter((e) => {
        if (sources && !sources.includes(e.source)) return false;
        if ((levelOrder[e.level] ?? 0) < minLvl) return false;
        return true;
    });
    res.json({ logs: filtered.slice(-limit) });
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
        const ai = cfg?.advanced?.integrity || {};
        integrity.start({
            broadcast,
            intervalMin: Number(ai.intervalMin) > 0 ? Number(ai.intervalMin) : 60,
            batchSize: Number(ai.batchSize) > 0 ? Number(ai.batchSize) : 64,
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
        const cfg = _nsfwCfg();
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
            config = loadConfig();
        } catch {
            config = { groups: [] };
        }
        const configUnknowns = (config.groups || []).filter(
            (g) => !g.name || g.name.startsWith('Group '),
        );

        // Also check DB
        const db = getDb();
        const dbUnknowns = db
            .prepare(
                `SELECT DISTINCT group_id FROM downloads WHERE group_name IS NULL OR group_name LIKE 'Group %'`,
            )
            .all();

        if (dbUnknowns.length === 0 && configUnknowns.length === 0) return;

        // Collect all unique IDs that need resolution
        const needIds = new Set();
        configUnknowns.forEach((g) => needIds.add(String(g.id)));
        dbUnknowns.forEach((r) => needIds.add(r.group_id));

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
            const candidates = [Number(rawId), BigInt(rawId)];
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
                } catch {
                    /* try next format */
                }
            }
        }

        // Apply fixes to DB
        let dbResolved = 0;
        const stmt = db.prepare(
            `UPDATE downloads SET group_name = ? WHERE group_id = ? AND (group_name IS NULL OR group_name LIKE 'Group %')`,
        );
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
        if (total > 0)
            console.log(
                `✅ Resolved ${total} group names (${dbResolved} DB, ${configResolved} config)`,
            );
        if (failed > 0)
            console.log(`⚠️  ${failed} groups could not be resolved (may have left the group)`);
    } catch (e) {
        console.log('⚠️ Could not resolve group names:', e.message);
    }
}

export { broadcast };
