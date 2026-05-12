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
    BACKFILL_MAX_LIMIT,
    DIALOG_CACHE_TTL_MS,
    BACKPRESSURE_CAP_DEFAULT,
} from '../core/constants.js';
import {
    getDb,
    getAllDownloadsFederated,
    getDownloadsForGroupFederated,
    searchDownloadsFederated,
    getStatsFederated,
    getStats as getDbStats,
    deleteGroupDownloads,
    deleteAllDownloads,
    getGroupStats,
    listGroupFiles,
    backfillGroupNames,
    deleteDownloadsBy,
    createShareLink,
    getShareLinkForServe,
    bumpShareLinkAccess,
    revokeShareLink,
    listShareLinks,
    countShareLinks,
    getNsfwTierCounts,
    getNsfwHistogram,
    getNsfwListByTier,
    getNsfwIdsByTier,
    reclassifyNsfw,
    unwhitelistNsfw,
    NSFW_TIERS,
    setDownloadPinned,
    getDownloadById,
    kvGet,
    kvSet,
    recordUpdateAttempt,
    recordUpdateFailure,
    listUpdateHistory,
    getUnindexedAiBatch,
} from '../core/db.js';
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
    purgeNonStandardThumbs,
    getThumbsCacheStats,
    buildAllThumbnails,
    hasFfmpeg,
    ALLOWED_WIDTHS as THUMB_WIDTHS,
    DEFAULT_WIDTH as THUMB_DEFAULT_WIDTH,
    thumbKindTypes,
    hasCachedThumb,
} from '../core/thumbs.js';
import {
    buildAllSeekbar,
    getMetaForDownload as getSeekbarMetaForDownload,
    getSeekbarCacheStats,
    getSpritePath as getSeekbarSpritePath,
    generateForDownload as generateSeekbarForDownload,
    purgeAllSeekbar,
} from '../core/seekbar/index.js';
import {
    getSidecarStatus as getSeekbarSidecarStatus,
    refreshSidecar as refreshSeekbarSidecar,
    setBroadcast as setSeekbarBroadcast,
    SIDECAR_VERSION as SEEKBAR_SIDECAR_VERSION,
    startSidecar as startSeekbarSidecar,
} from '../core/seekbar/spawn.js';
import { probeHwaccel as probeSeekbarHwaccel } from '../core/seekbar/client.js';
import { getSeekbarSprite } from '../core/db.js';
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
import {
    startFacesScan as aiStartFacesScan,
    startTagsScan as aiStartTagsScan,
    cancelScan as aiCancelScan,
    isScanRunning as aiIsScanRunning,
    getScanState as aiGetScanState,
    _bgQueueDepths as aiBgQueueDepths,
} from '../core/ai/index.js';
// Search + Auto-tag + vector index were removed in this release. Stubs
// below keep the existing route handlers compiling until the bigger
// "drop endpoints" cleanup lands. Each stub responds 410 Gone so the SPA
// can render a friendly "feature removed" message instead of crashing.
// Search + Auto-tag were removed in this release; only Face clustering
// survives. The stub constants that used to live here (aiStartEmbedScan,
// aiStartTagsScan, aiEmbedText, aiTopK, aiLoadVecOnce, AI_EMBED_DEFAULTS,
// …) were deleted along with the routes that called them.
import { runAutoUpdate, autoUpdateStatus } from '../core/updater.js';
import { getRescueSweeper } from '../core/rescue.js';
import { getRescueStats } from '../core/db.js';
import {
    getAiCounts,
    listPeople,
    listPhotosForPerson,
    renamePerson,
    deletePerson,
    resetAllAiData,
    getDb as aiGetDb,
} from '../core/db.js';
import * as backup from '../core/backup/index.js';
import { parseTelegramUrl, parseUrlList, UrlParseError } from '../core/url-resolver.js';
import { metrics } from '../core/metrics.js';
import {
    loginVerify,
    isAuthConfigured,
    validateSession,
    revokeAllSessions,
    startSessionGc,
} from '../core/web-auth.js';
import { suppressNoise, wrapConsoleMethod, NATIVE_LOAD_FAIL } from '../core/logger.js';
import { createJobTracker } from '../core/job-tracker.js';
import {
    getSelfPeerId,
    getSelfPeerName,
    setSelfPeerName,
    getClusterToken,
    rotateClusterToken,
    setClusterToken,
    getSelfIdentity,
    issuePairingCode,
} from '../core/cluster/identity.js';
import { verifyRequest as verifyPeerHmac } from '../core/cluster/hmac.js';
import {
    listPeers,
    getPeer,
    updatePeer,
    removePeer,
    markOnline,
    markOffline,
} from '../core/cluster/peers.js';
import { initiateHandshake, acceptHandshake, testPeerHealth } from '../core/cluster/handshake.js';
import { startSyncEngine, syncAllOnce, getSyncState } from '../core/cluster/sync.js';
import { parseClusterRefPath } from '../core/cluster/dedup.js';
import {
    tryStartSweep,
    abortSweep,
    getSweepStatus,
    listConflicts,
    resolveConflict,
} from '../core/cluster/sweep.js';
import { streamFromPeer, requestSignedShareUrl } from '../core/cluster/proxy.js';
import * as clusterWs from '../core/cluster/ws-channel.js';
import * as clusterDiscovery from '../core/cluster/discovery.js';
import { startFailoverWatcher, runFailoverPass } from '../core/cluster/failover.js';
import { listDiscoveredPeers } from '../core/db.js';
import WebSocketLib from 'ws';
import { recordClusterAudit, listClusterAudit, listOwnDownloadsSince } from '../core/db.js';
import { formatBytes, bestGroupName, nameLooksUnresolved } from './lib/format.js';
import { readConfigSafe, invalidateConfigCache } from './lib/config-cache.js';
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
import { tgAuthErrorBody } from './lib/tg-error.js';
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
import { createGroupsRouter } from './routes/groups.js';
import {
    historyJobs as _historyJobs,
    activeBackfillsByGroup as _activeBackfillsByGroup,
    loadHistoryJobsFromStore,
    saveHistoryJobsToStore,
    scheduleHistoryJobCleanup,
    HISTORY_JOBS_KV,
} from './lib/history-state.js';
import {
    cookieParser,
    checkAuth,
    guestGate,
    isLocalRequest,
    isPublicPath,
    PUBLIC_API_PATHS,
    CLUSTER_PREFIX_HMAC_ONLY,
} from './middleware/auth.js';

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

function writeDiskUsageCache(size) {
    // The legacy `data/disk_usage.json` file was the cache before the
    // JSON→SQLite migration; after first boot it's renamed to
    // `disk_usage.json.migrated`, so writing to the old path silently
    // dropped the cache. The downloader hot path already uses
    // `kvSet('disk_usage', …)` (core/downloader.js); align this
    // fallback writer with the same canonical store.
    try {
        kvSet('disk_usage', { size, lastScan: Date.now() });
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

// ====== Proxy test =========================================================
//
// Briefly opens a TCP connection to host:port to confirm the proxy is
// reachable. We don't speak SOCKS/MTProto here — that's the job of gramJS at
// the next monitor start — but a TCP open is enough to catch typos and DNS
// misconfiguration without needing a full Telegram round-trip.

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
//
// HTTP endpoint AND WebSocket push (`stats_update`). The footer/statusbar
// hits the HTTP path once on first paint, then switches to WS — every
// trigger event (download_complete, bulk_delete, file_deleted, purge_all,
// group_purged, config_updated) calls `broadcastStatsSoon()` which
// debounces a recompute + push within 400ms. Cache TTL keeps repeat
// hits to /api/stats cheap when the page reloads mid-burst.

const STATS_CACHE_TTL_MS = 2000;
let _statsCache = { role: null, at: 0, body: null };

async function _computeStatsPayload(role) {
    const dbStats = getDbStats();
    const config = loadConfig();
    let diskUsage = Number(dbStats.totalSize) || 0;
    if (diskUsage <= 0) {
        diskUsage = await scanDirectorySize(DOWNLOADS_DIR);
        writeDiskUsageCache(diskUsage);
    }
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
        } catch {}
    }
    let peerStats = [];
    if (role !== 'guest') {
        try {
            const fed = getStatsFederated();
            const peerNameMap = new Map();
            try {
                for (const p of listPeers()) {
                    peerNameMap.set(String(p.peerId), {
                        name: p.name || p.peerId,
                        online: p.status === 'online',
                    });
                }
            } catch {}
            peerStats = (fed.peerStats || []).map((row) => ({
                peerId: row.peerId,
                peerName: peerNameMap.get(String(row.peerId))?.name || row.peerId,
                online: !!peerNameMap.get(String(row.peerId))?.online,
                totalFiles: row.totalFiles,
                totalSize: row.totalSize,
                totalSizeFormatted: formatBytes(row.totalSize),
            }));
        } catch {}
    }
    return {
        totalFiles: dbStats.totalFiles,
        totalSize: dbStats.totalSize,
        diskUsage,
        diskUsageFormatted: formatBytes(diskUsage),
        maxDiskSize: config.diskManagement?.maxTotalSize || '0',
        totalGroups: config.groups?.length || 0,
        enabledGroups: config.groups?.filter((g) => g.enabled).length || 0,
        accounts: accountCount,
        apiConfigured: !!(config.telegram?.apiId && config.telegram?.apiHash),
        telegramConnected: isConnected || runtime.state === 'running',
        peerStats,
    };
}

// Debounced WS push. Trigger events fire in bursts (50-row bulk delete
// emits one event per row); we coalesce to a single recompute + broadcast
// per ~400ms window so the WS channel doesn't get spammed.
let _statsBroadcastTimer = null;
function broadcastStatsSoon() {
    if (_statsBroadcastTimer) return;
    _statsBroadcastTimer = setTimeout(async () => {
        _statsBroadcastTimer = null;
        try {
            // Admin payload — guests just refetch via HTTP on reconnect.
            const body = await _computeStatsPayload('admin');
            _statsCache = { role: 'admin', at: Date.now(), body };
            broadcast({ type: 'stats_update', stats: body });
        } catch (e) {
            console.warn('[stats] broadcast failed:', e.message);
        }
    }, 400);
}

app.get('/api/stats', async (req, res) => {
    try {
        const now = Date.now();
        const role = req.role || 'admin';
        // Cache hit (within TTL + same role) — return immediately, no DB hit.
        if (
            _statsCache.body &&
            _statsCache.role === role &&
            now - _statsCache.at < STATS_CACHE_TTL_MS
        ) {
            return res.json(_statsCache.body);
        }
        const body = await _computeStatsPayload(role);
        _statsCache = { role, at: now, body };
        return res.json(body);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

// Legacy long-form handler removed in favour of the cached path above
// (`_computeStatsPayload` + 2s TTL + WS push). Trigger events are hooked
// further down where each `broadcast({ type: 'bulk_delete' / 'file_deleted'
// / 'group_purged' / 'purge_all' / 'config_updated' })` lives — each one
// is paired with `broadcastStatsSoon()` so the footer stays live without
// the SPA having to poll.
/* eslint-disable no-unused-vars */
async function _stats_legacy_block_removed(req, res) {
    try {
        const dbStats = getDbStats();
        const config = loadConfig();

        let diskUsage = Number(dbStats.totalSize) || 0;
        if (diskUsage <= 0) {
            diskUsage = await scanDirectorySize(DOWNLOADS_DIR);
            writeDiskUsageCache(diskUsage);
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

        // Federation totals — per-peer file count + total size from the
        // peer_downloads catalog cache. Stamps `peerName` from the live
        // peers table so the SPA footer can render "Files: 1234 + 5678
        // peers" with a tooltip listing each peer. Backward-compatible —
        // existing local-only callers ignore the new field.
        // Guest sessions get an empty array — federation visibility is
        // admin-only.
        let peerStats = [];
        if (req.role !== 'guest') {
            try {
                const fed = getStatsFederated();
                const peerNameMap = new Map();
                try {
                    for (const p of listPeers()) {
                        peerNameMap.set(String(p.peerId), {
                            name: p.name || p.peerId,
                            online: p.status === 'online',
                        });
                    }
                } catch {
                    /* listPeers can throw before cluster init — leave names blank */
                }
                peerStats = (fed.peerStats || []).map((row) => ({
                    peerId: row.peerId,
                    peerName: peerNameMap.get(String(row.peerId))?.name || row.peerId,
                    online: !!peerNameMap.get(String(row.peerId))?.online,
                    totalFiles: row.totalFiles,
                    totalSize: row.totalSize,
                    totalSizeFormatted: formatBytes(row.totalSize),
                }));
            } catch {
                /* federated stats failed — keep local-only response */
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

            // Federation surface — empty array on non-cluster installs.
            peerStats,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}
/* eslint-enable no-unused-vars */

// 1b. DB Stats — detailed table sizes, group breakdown, file types, AI indexing
app.get('/api/db/stats', async (req, res) => {
    try {
        const db = getDb();

        // Table sizes
        const tables = ['downloads', 'faces', 'people', 'image_embeddings', 'image_tags', 'queue'];
        const tableCounts = {};
        for (const t of tables) {
            try {
                const r = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get();
                tableCounts[t] = r?.n || 0;
            } catch {
                tableCounts[t] = 0;
            }
        }

        // Group breakdown, sorted by most recent activity
        const groups = db
            .prepare(`
            SELECT group_name, COUNT(*) AS n,
                   SUM(CASE WHEN file_type = 'photo' THEN 1 ELSE 0 END) AS photos,
                   SUM(CASE WHEN file_type = 'video' THEN 1 ELSE 0 END) AS videos,
                   SUM(file_size) AS bytes,
                   MAX(created_at) AS last_activity
              FROM downloads
             GROUP BY group_name
             ORDER BY last_activity DESC
        `)
            .all();

        // File type totals
        const totals = db
            .prepare(`
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN file_type = 'photo' THEN 1 ELSE 0 END) AS photos,
                   SUM(CASE WHEN file_type = 'video' THEN 1 ELSE 0 END) AS videos,
                   SUM(CASE WHEN file_type = 'audio' THEN 1 ELSE 0 END) AS audio,
                   SUM(CASE WHEN file_type = 'document' THEN 1 ELSE 0 END) AS documents,
                   SUM(CASE WHEN file_type = 'voice' THEN 1 ELSE 0 END) AS voice,
                   SUM(file_size) AS bytes
              FROM downloads
        `)
            .get();

        // Recent activity (last 30 min)
        const recent = db
            .prepare(`
            SELECT group_name, COUNT(*) AS n, SUM(file_size) AS bytes
              FROM downloads
             WHERE created_at >= datetime('now', '-30 minutes')
             GROUP BY group_name
             ORDER BY n DESC
        `)
            .all();

        // AI indexing
        const indexed =
            db.prepare(`SELECT COUNT(*) AS n FROM downloads WHERE ai_indexed_at IS NOT NULL`).get()
                ?.n || 0;
        const total = db.prepare(`SELECT COUNT(*) AS n FROM downloads`).get()?.n || 0;
        let aiFaces = 0,
            aiPeople = 0,
            aiTags = 0;
        try {
            aiFaces = db.prepare('SELECT COUNT(*) AS n FROM faces').get()?.n || 0;
        } catch {}
        try {
            aiPeople = db.prepare('SELECT COUNT(*) AS n FROM people').get()?.n || 0;
        } catch {}
        try {
            aiTags = db.prepare('SELECT COUNT(*) AS n FROM image_tags').get()?.n || 0;
        } catch {}

        res.json({
            success: true,
            tableCounts,
            groups,
            totals,
            recent,
            ai: {
                indexed,
                total,
                pct: total ? Math.round((indexed / total) * 100) : 0,
                faces: aiFaces,
                people: aiPeople,
                tags: aiTags,
            },
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
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
            Math.max(0, now - _dialogsResponseCache.at) < DIALOG_CACHE_TTL_MS
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
                        keepImages: false,
                        keepVideos: false,
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
        Math.max(0, now - _dialogsNameCache.at) < DIALOG_CACHE_TTL_MS &&
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
                    // Hard cap so a runaway upstream (multi-account user
                    // with 50 k+ joined dialogs) can't blow the heap. See
                    // CLAUDE.md → Big-data patterns rule 3.
                    if (byId.size > 50000) break;
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
                // Detect comment: groups and derive display info from the parent group.
                // Telegram creates separate comment groups for channel posts; these are
                // stored with a 'comment:' prefix in the group_id so we can distinguish
                // them and display them as "<Channel Name> (comments)" in the sidebar.
                const isCommentGroup =
                    typeof r.group_id === 'string' && r.group_id.startsWith('comment:');
                const parentGroupId = isCommentGroup ? r.group_id.slice(8) : null;

                const cfg = isCommentGroup
                    ? configGroups.find((g) => String(g.id) === parentGroupId)
                    : configGroups.find((g) => String(g.id) === r.group_id);

                // Best-available: live Telegram dialogs name → config → DB → placeholder.
                const name = isCommentGroup
                    ? bestGroupName(
                          parentGroupId,
                          cfg?.name,
                          r.best_name || r.any_name,
                          dialogsNames.get(String(parentGroupId)),
                      ) + ' (comments)'
                    : bestGroupName(
                          r.group_id,
                          cfg?.name,
                          r.best_name || r.any_name,
                          dialogsNames.get(String(r.group_id)),
                      );

                const hasPhoto = isCommentGroup
                    ? existsSync(path.join(PHOTOS_DIR, `${parentGroupId}.jpg`))
                    : existsSync(path.join(PHOTOS_DIR, `${r.group_id}.jpg`));

                return {
                    id: r.group_id,
                    name: name,
                    // Type drives the sidebar avatar's corner badge
                    // (channel = megaphone / group = group icon / user / bot).
                    // Prefer config (sticky), fall back to live-dialogs cache.
                    type: isCommentGroup
                        ? cfg?.type || dialogsTypeFor(parentGroupId)
                        : cfg?.type || dialogsTypeFor(r.group_id),
                    totalFiles: r.count,
                    sizeFormatted: formatBytes(r.size || 0),
                    photoUrl: hasPhoto
                        ? `/photos/${isCommentGroup ? parentGroupId : r.group_id}.jpg`
                        : null,
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
        // Federation scope (Layer 1, v2.12+):
        //   ?include=local  — own files only (default; backward-compatible)
        //   ?include=peers  — own + every paired peer
        //   ?include=all    — alias for peers (kept for symmetry with the
        //                     /api/cluster/downloads contract)
        // Optional ?peerId=<id> further filters to a single peer's files —
        // sidebar foreign-group click hands the peer's id along.
        // Guest sessions are forced back to `local`: federation is admin-
        // only on the management surface (/maintenance/cluster, Settings →
        // Federation), so gallery scope follows the same rule. Without
        // this guard a guest hitting /api/downloads/all?include=peers
        // would expose every paired peer's catalog.
        const reqInclude =
            req.query.include === 'peers' || req.query.include === 'all'
                ? req.query.include
                : 'local';
        const include = req.role === 'guest' ? 'local' : reqInclude;
        const peerIdFilter =
            req.role !== 'guest' && req.query.peerId ? String(req.query.peerId) : null;
        const result = getAllDownloadsFederated(limit, offset, type, {
            pinnedOnly,
            pinnedFirst,
            include,
            ...(peerIdFilter ? { peerId: peerIdFilter } : {}),
        });

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
        // Build a peer-id → name lookup so federated rows can render a
        // human-readable "from {peer}" label without an extra round-trip.
        const peerNameMap = new Map();
        if (include !== 'local') {
            try {
                for (const p of listPeers()) peerNameMap.set(String(p.peerId), p.name || p.peerId);
            } catch {
                /* listPeers can throw if cluster module hasn't initialised — fall through */
            }
        }
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
            const isPeerRow = row.peer_id && row.peer_id !== 'self';
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
                // Federation surface — peer_id is 'self' for own rows,
                // peer's id otherwise. peer_name is null for own; for
                // peer rows it carries the human-readable display name
                // (Cluster page → display name) so the SPA can render
                // a "from {peer}" badge without /api/cluster/peers.
                peer_id: row.peer_id || 'self',
                peer_name: isPeerRow ? peerNameMap.get(String(row.peer_id)) || null : null,
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
        // Federation scope — same contract as /api/downloads/all. Guest
        // sessions are forced back to `local` so cluster-only data stays
        // admin-gated.
        const reqInclude =
            req.query.include === 'peers' || req.query.include === 'all'
                ? req.query.include
                : 'local';
        const include = req.role === 'guest' ? 'local' : reqInclude;
        const peerIdFilter =
            req.role !== 'guest' && req.query.peerId ? String(req.query.peerId) : null;
        const result = getDownloadsForGroupFederated(groupId, limit, offset, type, {
            pinnedOnly,
            pinnedFirst,
            include,
            ...(peerIdFilter ? { peerId: peerIdFilter } : {}),
        });

        // Build a peer-id → name lookup so federated rows can render a
        // human-readable "from {peer}" label.
        const peerNameMap = new Map();
        if (include !== 'local') {
            try {
                for (const p of listPeers()) peerNameMap.set(String(p.peerId), p.name || p.peerId);
            } catch {
                /* cluster not initialised — peer name stays null */
            }
        }

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

            const isPeerRow = row.peer_id && row.peer_id !== 'self';
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
                peer_id: row.peer_id || 'self',
                peer_name: isPeerRow ? peerNameMap.get(String(row.peer_id)) || null : null,
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

// Search across all downloads (filename + group name). Federated when the
// caller passes ?include=peers — UNIONs filename / group_name LIKE matches
// from peer_downloads on top of the local rows. Default is local-only so
// non-cluster callers see no behaviour change.
app.get('/api/downloads/search', async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        if (!q) return res.json({ files: [], total: 0, page: 1, totalPages: 0 });
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
        const groupId = req.query.groupId ? String(req.query.groupId) : undefined;
        const reqInclude =
            req.query.include === 'peers' || req.query.include === 'all'
                ? req.query.include
                : 'local';
        // Guest sessions stay local-only — federation is admin-gated.
        const include = req.role === 'guest' ? 'local' : reqInclude;
        const r = searchDownloadsFederated(q, {
            limit,
            offset: (page - 1) * limit,
            groupId,
            include,
        });

        const config = loadConfig();
        const groupFolderById = new Map();
        for (const g of config.groups || [])
            groupFolderById.set(String(g.id), sanitizeName(g.name));

        // Peer name lookup for federated rows.
        const peerNameMap = new Map();
        if (include !== 'local') {
            try {
                for (const p of listPeers()) peerNameMap.set(String(p.peerId), p.name || p.peerId);
            } catch {
                /* cluster module not loaded — peer name stays null */
            }
        }

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
            const isPeerRow = row.peer_id && row.peer_id !== 'self';
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
                peer_id: row.peer_id || 'self',
                peer_name: isPeerRow ? peerNameMap.get(String(row.peer_id)) || null : null,
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
        // path → id resolution. Frontend sends forward-slash strings; the
        // downloader writes file_path with the OS-native separator (which
        // on Windows is `\`), so `DELETE WHERE file_path = ?` against the
        // raw frontend string never matches the row. Resolve to ids up
        // front via a slash-insensitive comparison, then merge into the
        // id-keyed delete path that already works everywhere. Files still
        // unlink off disk via the path because the OS treats `/` and `\`
        // identically on Windows path resolution.
        const resolvedIdsFromPaths = [];
        if (pathList.length) {
            const db = getDb();
            const stmt = db.prepare(
                "SELECT id FROM downloads WHERE REPLACE(file_path, '\\', '/') = ?",
            );
            for (const p of pathList) {
                const norm = String(p || '').replace(/\\/g, '/');
                if (!norm) continue;
                const row = stmt.get(norm);
                if (row?.id) resolvedIdsFromPaths.push(row.id);
            }
        }
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
            // SELECT `file_path` so we use the same on-disk path the
            // downloader / thumbs / bulk-zip rely on. The previous
            // implementation re-built `<group>/<typeFolder>/<file_name>`
            // from scratch — that path matched ONLY when group rename,
            // sanitizeName output, and original folder layout all aligned;
            // any drift (group renamed in UI, special chars sanitised
            // differently, custom file_path from the downloader) made
            // safeResolveDownload return ENOENT and the file survived
            // on disk while the DB row got dropped.
            const rows = db
                .prepare(
                    `SELECT id, group_id, group_name, file_name, file_type, file_path FROM downloads WHERE id IN (${idList.map(() => '?').join(',')})`,
                )
                .all(...idList);
            const config = loadConfig();
            const folderById = new Map();
            for (const g of config.groups || []) folderById.set(String(g.id), sanitizeName(g.name));
            for (const row of rows) {
                // Prefer the stored file_path — it's the authoritative
                // record of where the downloader wrote the file. Fall back
                // to the reconstructed candidate ONLY when file_path is
                // missing (legacy rows pre-v1.x that never had the column).
                const stored = (row.file_path || '').replace(/\\/g, '/');
                let candidate = stored;
                if (!candidate || !candidate.includes('/')) {
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
                    candidate = `${folder}/${typeFolder}/${row.file_name}`;
                }
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
        // Merge frontend ids + ids we just resolved from paths into a
        // single dedup set so we do not delete a row twice + so the
        // thumb purge loop hits every removed download.
        const allIds = Array.from(new Set([...idList, ...resolvedIdsFromPaths]));
        const dbDeleted = deleteDownloadsBy({ ids: allIds });
        onProgress({ processed: total, total, stage: 'purging_thumbs' });
        for (const id of allIds) {
            try {
                await purgeThumbsForDownload(id);
            } catch {}
        }
        broadcast({ type: 'bulk_delete', unlinked, dbDeleted, ids: allIds });
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
        // Node HTTP setHeader() rejects non-Latin1 characters in header
        // values — a Thai/CJK group name would throw ERR_INVALID_CHAR.
        // RFC 5987: send a sanitised ASCII fallback in `filename=` AND
        // the UTF-8 percent-encoded original in `filename*=`. Modern
        // browsers pick the latter; ancient ones fall back to the ASCII.
        const asciiArchive = archiveBase.replace(/[^\x20-\x7e]/g, '_');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="${asciiArchive}"; filename*=UTF-8''${encodeURIComponent(archiveBase)}`,
        );
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

// 6a. Archive listing — used by the in-app viewer to preview the
// contents of `.zip` / `.tar` / `.tar.gz` / `.tgz` / `.7z` / `.rar`
// downloads inline (a tree of names + sizes) instead of forcing the
// operator to download the whole archive first.
//
// Strategy: shell out to whichever extractor is available on the host
// (`unzip -l` for zip, `tar -tvf` for tarballs, `7z l` for 7z / rar).
// `execFile` with a fixed argv vector means the resolved disk path is
// passed as a single argument — no shell interpolation, so a filename
// that contains shell metacharacters is impossible to weaponise. The
// only path that ever reaches the binary is one safeResolveDownload
// has already cleared (no `..`, no symlink escape, anchored inside
// `data/downloads/`). 5 s timeout caps a hostile archive that prints
// 100k entries; output is hard-capped at 8 MB stdout / 256 KB stderr.
//
// Admin-only by virtue of the default-deny guest gate — this is a
// metadata read, but it spawns a process so we treat it as an admin
// surface for safety.
app.get('/api/files/archive-list', async (req, res) => {
    try {
        const filePath = req.query.path;
        if (typeof filePath !== 'string' || !filePath) {
            return res.status(400).json({ error: 'path required' });
        }
        const r = await safeResolveDownload(filePath);
        if (!r.ok) {
            const status = r.reason === 'missing' ? 404 : 403;
            return res
                .status(status)
                .json({ error: r.reason === 'missing' ? 'File not found' : 'Forbidden' });
        }

        const lower = r.real.toLowerCase();
        let cmd;
        let args;
        let parser;
        if (lower.endsWith('.zip')) {
            cmd = 'unzip';
            args = ['-l', '--', r.real];
            parser = _parseUnzipOutput;
        } else if (
            lower.endsWith('.tar') ||
            lower.endsWith('.tar.gz') ||
            lower.endsWith('.tgz') ||
            lower.endsWith('.tar.bz2') ||
            lower.endsWith('.tbz') ||
            lower.endsWith('.tbz2') ||
            lower.endsWith('.tar.xz') ||
            lower.endsWith('.txz')
        ) {
            cmd = 'tar';
            args = ['-tvf', r.real];
            parser = _parseTarOutput;
        } else if (lower.endsWith('.7z') || lower.endsWith('.rar')) {
            cmd = '7z';
            args = ['l', '-slt', '--', r.real];
            parser = _parse7zOutput;
        } else if (lower.endsWith('.gz') || lower.endsWith('.bz2') || lower.endsWith('.xz')) {
            // Single-stream compression (no archive index). We can't list
            // contents — surface a friendly placeholder so the client can
            // render "single-stream compression; download to expand".
            return res.json({
                entries: [],
                supported: false,
                reason: 'single_stream',
                name: path.basename(r.real),
            });
        } else {
            return res.json({
                entries: [],
                supported: false,
                reason: 'unknown_format',
                name: path.basename(r.real),
            });
        }

        const { execFile } = await import('node:child_process');
        const { stdout, stderr, code } = await new Promise((resolve) => {
            try {
                execFile(
                    cmd,
                    args,
                    { timeout: 5000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
                    (err, stdout, stderr) => {
                        resolve({
                            stdout: String(stdout || ''),
                            stderr: String(stderr || ''),
                            code: err ? err.code || 1 : 0,
                            spawnErr: err && err.code === 'ENOENT' ? err : null,
                        });
                    },
                );
            } catch (spawnErr) {
                resolve({ stdout: '', stderr: '', code: 1, spawnErr });
            }
        });

        if (code !== 0 && (!stdout || stdout.length === 0)) {
            // Tool is missing or the archive is malformed. Either way, give
            // the operator a graceful fallback instead of a stack trace.
            const missing = String(stderr).includes('ENOENT') || stderr.includes('not found');
            return res.json({
                entries: [],
                supported: false,
                reason: missing ? 'tool_missing' : 'list_failed',
                tool: cmd,
                name: path.basename(r.real),
            });
        }

        const entries = parser(stdout).slice(0, 5000); // cap rendered rows
        res.json({
            entries,
            supported: true,
            total: entries.length,
            name: path.basename(r.real),
            tool: cmd,
        });
    } catch (error) {
        console.error('GET /api/files/archive-list:', error);
        res.status(500).json({ error: error?.message || 'Internal error' });
    }
});

// Parse `unzip -l` output:
//     Archive:  foo.zip
//       Length      Date    Time    Name
//     ---------  ---------- -----   ----
//          1234  2024-04-01 12:00   path/to/file.txt
//             0  2024-04-01 12:00   path/to/
//     ---------                     -------
//          1234                     1 file
function _parseUnzipOutput(text) {
    const lines = String(text).split(/\r?\n/);
    const out = [];
    let inBody = false;
    for (const line of lines) {
        if (/^-+\s+-+/.test(line)) {
            inBody = !inBody;
            continue;
        }
        if (!inBody) continue;
        // `length date time name` — name may contain spaces.
        const m = line.match(/^\s*(\d+)\s+\S+\s+\S+\s+(.+?)\s*$/);
        if (!m) continue;
        const size = Number(m[1]);
        const name = m[2];
        if (!name) continue;
        out.push({ name, size: Number.isFinite(size) ? size : 0, isDir: name.endsWith('/') });
    }
    return out;
}

// Parse `tar -tvf` output, both BSD + GNU dialects:
//     -rw-r--r--  0 user  staff   1234 Apr 01 12:00 path/to/file.txt
//     drwxr-xr-x  0 user  staff      0 Apr 01 12:00 path/to/
function _parseTarOutput(text) {
    const lines = String(text).split(/\r?\n/);
    const out = [];
    for (const line of lines) {
        if (!line.trim()) continue;
        // Split on whitespace, last token (or trailing slash-token group) is the name.
        // tar's verbose format has the name as the LAST whitespace-delimited
        // field except when there's a link target (`-> dst`). Grab everything
        // after the size+date timestamp.
        //   <mode> <links> <owner> <size> <month> <day> <year-or-time> <name>
        const m = line.match(
            /^(\S)\S*\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+?)(\s+->\s+.+)?$/,
        );
        if (!m) continue;
        const isDir = m[1] === 'd' || m[3].endsWith('/');
        out.push({ name: m[3], size: Number(m[2]) || 0, isDir });
    }
    return out;
}

// Parse `7z l -slt` output (line-tagged form):
//     Path = path/to/file.txt
//     Size = 1234
//     ...
//     Attributes = A
function _parse7zOutput(text) {
    const lines = String(text).split(/\r?\n/);
    const out = [];
    let cur = null;
    let inBody = false;
    for (const line of lines) {
        if (/^---/.test(line)) {
            inBody = true;
            continue;
        }
        if (!inBody) continue;
        if (!line.trim()) {
            if (cur && cur.name) out.push(cur);
            cur = null;
            continue;
        }
        const m = line.match(/^(\w[\w ]*?)\s*=\s*(.*)$/);
        if (!m) continue;
        if (!cur) cur = { name: '', size: 0, isDir: false };
        const key = m[1];
        const val = m[2];
        if (key === 'Path') cur.name = val;
        else if (key === 'Size') cur.size = Number(val) || 0;
        else if (key === 'Attributes' && val.includes('D')) cur.isDir = true;
    }
    if (cur && cur.name) out.push(cur);
    return out;
}

// 6b. Purge Group (Files + DB + Config + Photo — No Trace)
//
// Fire-and-forget — a chat with 10k files takes minutes of disk I/O to
// rm. POST returns immediately; per-group tracker key (`group_purge_*`)
// allows multi-flight across distinct groups while preventing a
// double-click on the same row from firing twice. Status endpoint:
// `GET /api/groups/:id/purge/status`.

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

        // Cluster-ref path: a row whose file_path is `_clusterref/<peerId>/<remoteId>`.
        // Either the dedup layer (Phase 6) inserted it during download, or the
        // operator opened a peer-owned file from the merged gallery. Fork to the
        // streaming bridge before the local-disk resolver complains.
        const ref = parseClusterRefPath(reqPath);
        if (ref) {
            const ownerRow = getDb()
                .prepare('SELECT file_path FROM peer_downloads WHERE peer_id = ? AND remote_id = ?')
                .get(ref.peerId, Number(ref.remoteId));
            if (!ownerRow) {
                return res.status(404).send('Cluster file not found in catalog cache');
            }
            const peer = getPeer(ref.peerId);
            if (!peer) return res.status(410).send('Peer revoked');
            if (peer.streamMode === 'direct') {
                try {
                    const url = await requestSignedShareUrl(ref.peerId, ownerRow.file_path);
                    return res.redirect(302, url);
                } catch (e) {
                    return res
                        .status(502)
                        .json({ error: 'storage_offline', message: e?.message || String(e) });
                }
            }
            return streamFromPeer(req, res, ref.peerId, ownerRow.file_path);
        }

        // Federated gallery direct-peer path: SPA constructs
        //   `/files/${peerSidePath}?inline=1&peer=${peerId}`
        // for tiles whose source row lives in `peer_downloads`. There's no
        // `_clusterref/` ghost row to dispatch on — the SPA tells us which
        // peer to proxy to via the query param. Same direct vs proxy fork
        // as the _clusterref branch above. Defence: only honour ?peer when
        // the id matches a paired peer (revoked/unknown ids 410 / 502).
        // Guest sessions are NOT allowed to fetch peer files — federation
        // is admin-gated; without this guard a guest could exfiltrate any
        // peer's catalog by guessing peer ids + paths.
        if (req.query.peer) {
            if (req.role === 'guest') return res.status(403).send('Forbidden');
            const peerIdParam = String(req.query.peer);
            const peer = getPeer(peerIdParam);
            if (!peer) return res.status(410).send('Peer revoked');
            const peerSidePath = reqPath; // the SPA already encoded peer-side fullPath
            if (peer.streamMode === 'direct') {
                try {
                    const url = await requestSignedShareUrl(peerIdParam, peerSidePath);
                    return res.redirect(302, url);
                } catch (e) {
                    return res
                        .status(502)
                        .json({ error: 'storage_offline', message: e?.message || String(e) });
                }
            }
            return streamFromPeer(req, res, peerIdParam, peerSidePath);
        }

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
        // RFC 5987 — `filename*` for UTF-8, plus an ASCII fallback for legacy
        // clients. Some browsers / proxies still parse the basic `filename=`
        // first, so omitting it leaves the file with a generic name.
        const dispKind = inline ? 'inline' : 'attachment';
        const asciiName = baseName.replace(/[^\x20-\x7e]/g, '_');
        res.setHeader(
            'Content-Disposition',
            `${dispKind}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(baseName)}`,
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
    clients.forEach((client) => {
        if (client.readyState === 1) client.send(message);
    });
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
    // AI subsystem — three independent scans owned by the same page.
    // Event prefixes match the WS contract used by maintenance-ai.js:
    // ai_index_progress / ai_index_done, ai_tags_*, ai_people_*.
    aiIndex: createJobTracker({ kind: 'aiIndex', broadcast, log, eventPrefix: 'ai_index' }),
    aiTags: createJobTracker({ kind: 'aiTags', broadcast, log, eventPrefix: 'ai_tags' }),
    aiPeople: createJobTracker({ kind: 'aiPeople', broadcast, log, eventPrefix: 'ai_people' }),
};
// ---- Router mounts (registered here so _jobTrackers + broadcast are in scope)
app.use('/api', createVersionRouter({ broadcast, autoUpdateTracker: _jobTrackers.autoUpdate }));
app.use('/api', createStoriesRouter({ getAccountManager }));
app.use('/api', createQueueRouter({ broadcast }));
app.use('/', createAuthRouter({ broadcast }));
app.use('/api', createAccountsRouter({ getAccountManager }));
app.use(
    '/api',
    createMonitorRouter({ getAccountManager, buildSnapshot: _buildMonitorStatusSnapshot }),
);
app.use(
    '/api',
    createHistoryRouter({
        getAccountManager,
        broadcast,
        log,
        invalidateDialogsCache: () => {
            _dialogsResponseCache = { at: 0, body: null };
        },
    }),
);
app.use('/api', createAiRouter({ broadcast, log, jobTrackers: _jobTrackers }));
app.use(
    '/api',
    createMaintenanceRouter({ broadcast, log, jobTrackers: _jobTrackers, getAccountManager }),
);
app.use('/api', createClusterRouter({ broadcast, log }));
app.use('/api', createBackupRouter({ log }));
app.use('/api', createShareLinksRouter({ log }));
app.use(
    '/api',
    createConfigRouter({
        broadcast,
        invalidateDialogsCache: () => {
            _dialogsResponseCache = { at: 0, body: null };
        },
    }),
);
app.use(
    '/api',
    createGroupsRouter({
        broadcast,
        log,
        invalidateDialogsCache: () => {
            _dialogsResponseCache = { at: 0, body: null };
        },
        getDialogsNameCache,
        dialogsTypeFor,
    }),
);

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
