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
import sharp from 'sharp';

import { getOrGenerateSecret } from '../core/secret.js';
import { getDataDir, getDownloadsDir } from '../core/paths.js';
import {
    BACKFILL_MAX_LIMIT,
    DIALOG_CACHE_TTL_MS,
    HISTORY_JOB_TTL_MS,
    BACKPRESSURE_CAP_DEFAULT,
} from '../core/constants.js';
import {
    getDb,
    getDownloads,
    getAllDownloads,
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
    searchDownloads,
    deleteDownloadsBy,
    purgeOrphanPeople,
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
    addNsfwBlocklistBatch,
    getNsfwBlocklistCount,
    clearNsfwBlocklist,
    getDownloadHashesForIds,
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
    verifyFileToken,
    mintFileToken,
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
    getSeekbarQueueDepths,
    getSpritePath as getSeekbarSpritePath,
    generateForDownload as generateSeekbarForDownload,
    purgeAllSeekbar,
    purgeSeekbarForDownload,
    collectSeekbarPaths,
} from '../core/seekbar/index.js';
import {
    getSidecarStatus as getSeekbarSidecarStatus,
    refreshSidecar as refreshSeekbarSidecar,
    setBroadcast as setSeekbarBroadcast,
    SIDECAR_VERSION as SEEKBAR_SIDECAR_VERSION,
    startSidecar as startSeekbarSidecar,
} from '../core/seekbar/spawn.js';
import {
    health as seekbarClientHealth,
    probeHwaccel as probeSeekbarHwaccel,
} from '../core/seekbar/client.js';
import { countSeekbarSprites, countVideoDownloads, getSeekbarSprite } from '../core/db.js';
import {
    startScan as nsfwStartScan,
    cancelScan as nsfwCancelScan,
    isScanRunning as nsfwIsScanRunning,
    getScanState as nsfwGetScanState,
    preloadClassifier as nsfwPreloadClassifier,
    clearClassifierCache as nsfwClearCache,
    classifierReady as nsfwClassifierReady,
    setBlocklistDeleteCallback as nsfwSetBlocklistDeleteCallback,
    initNsfwSidecar,
    NSFW_DEFAULTS,
    getNsfwStats,
    getNsfwDeleteCandidates,
    whitelistNsfw,
} from '../core/nsfw.js';
import {
    startFacesScan as aiStartFacesScan,
    cancelScan as aiCancelScan,
    isScanRunning as aiIsScanRunning,
    getScanState as aiGetScanState,
    _bgQueueDepths as aiBgQueueDepths,
    detectFaces as aiDetectFaces,
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
    setFaceQualityScore,
    getDb as aiGetDb,
} from '../core/db.js';
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
    renewSession,
    revokeSession,
    revokeAllSessions,
    revokeAllGuestSessions,
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
    upsertPeer,
    updatePeer,
    removePeer,
    markOnline,
    markOffline,
} from '../core/cluster/peers.js';
import { initiateHandshake, acceptHandshake, testPeerHealth } from '../core/cluster/handshake.js';
import {
    startSyncEngine,
    stopSyncEngine,
    syncAllOnce,
    getSyncState,
} from '../core/cluster/sync.js';
import { findHashAcrossCluster, parseClusterRefPath } from '../core/cluster/dedup.js';
import {
    tryStartSweep,
    abortSweep,
    getSweepStatus,
    listConflicts,
    resolveConflict,
} from '../core/cluster/sweep.js';
import { streamFromPeer, openPeerStream, requestSignedShareUrl } from '../core/cluster/proxy.js';
import * as clusterWs from '../core/cluster/ws-channel.js';
import * as clusterDiscovery from '../core/cluster/discovery.js';
import { startFailoverWatcher, runFailoverPass } from '../core/cluster/failover.js';
import { publishConfigChange } from '../core/cluster/config-sync.js';
import { listDiscoveredPeers } from '../core/db.js';
import WebSocketLib from 'ws';
import { getOwnerPeerForGroup, isLocalGroup } from '../core/cluster/router.js';
import {
    recordClusterAudit,
    listClusterAudit,
    listOwnDownloadsSince,
    listPeerDownloads,
    setPeerCatalogBlob,
    getPeerCatalogBlob,
} from '../core/db.js';

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
const DATA_DIR = getDataDir();
const DOWNLOADS_DIR = getDownloadsDir();
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
    if (!config.web?.forceHttps) {
        // Clear HSTS so browsers that previously cached the 1-year policy
        // stop forcing HTTPS after the operator disables forceHttps.
        res.setHeader('Strict-Transport-Security', 'max-age=0');
        return next();
    }
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
        // HSTS managed by the forceHttps middleware above — helmet must not
        // override the max-age=0 clear header when the operator disables HTTPS.
        hsts: false,
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
                'upgrade-insecure-requests': null,
            },
        },
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'same-origin' },
    }),
);

// Dynamic CSP: re-inject upgrade-insecure-requests only when forceHttps is
// active and the response is already on a secure channel. Helmet's static
// middleware can't vary per-request, so we patch the header after it runs.
app.use(async (req, res, next) => {
    const config = await readConfigSafe();
    if (config.web?.forceHttps && req.secure) {
        const orig = res.getHeader('Content-Security-Policy');
        if (orig && !String(orig).includes('upgrade-insecure-requests')) {
            res.setHeader('Content-Security-Policy', `${orig};upgrade-insecure-requests`);
        }
    }
    next();
});

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
        limit: '2mb',
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

// v2.10 — bring up the WS cluster channel. `broadcast` is defined later
// in this file; `__tgdlBroadcast` is wired below the cluster routes
// section. Defer the actual init to the first cluster route hit so all
// dependencies are in scope.
let _clusterWsInitialised = false;
function _ensureClusterWsInit() {
    if (_clusterWsInitialised) return;
    _clusterWsInitialised = true;
    try {
        clusterWs.initClusterWs({
            broadcast: (m) => {
                try {
                    if (typeof global.__tgdlBroadcast === 'function') {
                        global.__tgdlBroadcast(m);
                    }
                } catch {
                    /* nothing */
                }
            },
            WebSocket: WebSocketLib,
        });
    } catch (e) {
        console.warn('[cluster] ws init deferred:', e?.message || e);
    }
}

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
    // Diff against the previous snapshot so we only push *changed*
    // top-level keys to peers instead of replicating the whole config.
    let prev = null;
    try {
        prev = _configCache?.value || loadConfig();
    } catch {
        prev = null;
    }
    // Async-retry against `SQLITE_BUSY` — better-sqlite3 throws this
    // when another long-running `.iterate()` (Phase B clustering,
    // dedup sweep, integrity walk) holds the single connection. The
    // retry runs with real `await`-able backoff so the event loop can
    // service the in-flight iterator (which yields via setImmediate
    // between batches) and free the connection. Exponential backoff
    // 50/100/200/400/800ms, capped at ~3 s total — covers every
    // observed iter window without blocking the operator on a stuck
    // save more than a couple of redraws.
    let lastErr = null;
    const backoffsMs = [50, 100, 200, 400, 800, 800, 800];
    for (let attempt = 0; attempt < backoffsMs.length; attempt++) {
        try {
            saveConfig(config);
            lastErr = null;
            break;
        } catch (e) {
            const msg = String(e?.message || e);
            const busy =
                msg.includes('database connection is busy') ||
                msg.includes('SQLITE_BUSY') ||
                e?.code === 'SQLITE_BUSY';
            if (!busy) throw e;
            lastErr = e;
            await new Promise((r) => setTimeout(r, backoffsMs[attempt]));
        }
    }
    if (lastErr) throw lastErr;
    invalidateConfigCache();
    // v2.10: replicate per top-level key. publishConfigChange itself
    // checks the per-key cluster.replicate.<key> policy and skips the
    // 'local' default — wrap in try so a peer-WS hiccup never blocks
    // the local save.
    try {
        const keys = new Set([...Object.keys(config || {}), ...Object.keys(prev || {})]);
        for (const k of keys) {
            if (k === 'cluster') continue; // cluster.replicate map is meta — never propagate
            const before = JSON.stringify(prev?.[k] ?? null);
            const after = JSON.stringify(config?.[k] ?? null);
            if (before !== after) {
                publishConfigChange(k, config[k]);
            }
        }
    } catch {
        /* nothing */
    }
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
    // Cluster peer-to-peer endpoints. These are NOT cookie-authed — they
    // verify a HMAC signature inside the handler against the cluster
    // token. Adding them here just bypasses the dashboard session check;
    // the handler still rejects unsigned / mis-signed / replayed requests
    // with 401 + an audit row.
    '/api/cluster/handshake',
    '/api/cluster/health',
    // Phase 2 P2P sync — paged delta + full snapshots, HMAC-only.
    '/api/cluster/downloads/since',
    '/api/cluster/groups/snapshot',
    '/api/cluster/accounts/snapshot',
    // Phase 4 — short-lived signed URL minting for direct stream mode.
    '/api/cluster/sign-url',
    // Phase D (v2.10) — relay-through-peer envelope delivery.
    '/api/cluster/relay/proxy',
    // Phase G (v2.10) — cross-peer file delete.
    '/api/cluster/files/delete',
    // Phase I (v2.10) — federated search.
    '/api/cluster/search/peer',
]);
// Cluster file-bridge prefix — /api/cluster/files/<encoded path> is variable
// so it has to live in PUBLIC_PATH_PREFIXES (exact-string set above won't
// prefix-match). The handler still verifies HMAC.
//
// `peer-thumbs` is a separate prefix from `thumbs/<peerId>/<remoteId>`
// (which is cookie-authed for the browser proxy). Using distinct
// segments keeps the prefix-match here from accidentally exempting the
// admin route.
const CLUSTER_PREFIX_HMAC_ONLY = ['/api/cluster/files/', '/api/cluster/peer-thumbs/'];

// Treat connections from the local machine as "trusted enough" to bootstrap
// the very first password without prior auth. Any other origin still has to
// go through the CLI to set the password.
function isLocalRequest(req) {
    const ip = req.ip || req.socket?.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function isPublicPath(p) {
    if (PUBLIC_API_PATHS.has(p)) return true;
    if (CLUSTER_PREFIX_HMAC_ONLY.some((pre) => p.startsWith(pre))) return true;
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

    // Bearer-token auth for /files/ — lets the URL work without a session
    // cookie (e.g. after a Cloudflare redirect to a direct DDNS host).
    if (req.path.startsWith('/files/') && req.query.token) {
        if (verifyFileToken(req.query.token)) {
            req.role = 'admin';
            return next();
        }
    }

    const token = req.cookies['tg_dl_session'];
    const session = validateSession(token);
    if (session) {
        req.role = session.role;
        // Sliding renewal: extend if less than 25% of the original TTL remains.
        const originalTtl = session.expiresAt - session.issuedAt;
        const remaining = session.expiresAt - Date.now();
        if (originalTtl > 0 && remaining < originalTtl * 0.25) {
            const newExpiry = Date.now() + originalTtl;
            renewSession(token, newExpiry);
            res.cookie('tg_dl_session', token, { ...SESSION_COOKIE_OPTS, maxAge: originalTtl });
        }
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
    '/api/seekbar/sprite', // GET /api/seekbar/sprite/:id — WebP sprite sheet
    '/api/seekbar/meta', // GET /api/seekbar/meta/:id — sprite JSON sidecar
    '/api/monitor/status', // engine state (running/stopped) — no config secrets
    '/api/files/token', // file-access bearer token (guests can view files)
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
    return 30 * 24 * 60 * 60 * 1000;
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
const RESET_TOKEN_MAX = 50;

function _gcResetTokens() {
    const now = Date.now();
    for (const [tok, exp] of _resetTokens) if (exp <= now) _resetTokens.delete(tok);
    // Hard cap — prevent memory growth from brute-force attempts.
    if (_resetTokens.size > RESET_TOKEN_MAX) {
        const excess = _resetTokens.size - RESET_TOKEN_MAX;
        const it = _resetTokens.keys();
        for (let i = 0; i < excess; i++) _resetTokens.delete(it.next().value);
    }
}
setInterval(_gcResetTokens, 5 * 60 * 1000).unref();

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
    const fromVersion = _readCurrentVersion();
    const r = tracker.tryStart(async () => {
        let result;
        try {
            result = await runAutoUpdate();
        } catch (e) {
            // Audit even pre-flight failures so the operator can see "we
            // tried at 14:02, watchtower was unreachable" in the history
            // panel rather than a silent dead-letter.
            try {
                recordUpdateFailure({
                    fromVersion,
                    errorCode: e?.code || 'UNKNOWN',
                    errorMsg: e?.message || String(e),
                });
            } catch {}
            throw e;
        }
        // Watchtower acknowledged. Stamp a `triggered` row — the new
        // container's boot path will promote it to `success` when it
        // observes a different version, or to `stalled` if the swap
        // never landed (10 min timeout).
        try {
            recordUpdateAttempt({
                fromVersion,
                backupPath: result.backup?.path || null,
                backupBytes: result.backup?.sizeBytes ?? null,
            });
        } catch {}
        // Heads-up to every open tab — fires BEFORE watchtower kills us
        // so the overlay shows up while the WS is still alive.
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

// Audit log of every /api/update click, newest first. Powers the
// "Recent updates" panel in the maintenance UI + lets operators spot
// repeat failures (e.g. watchtower mis-token on every retry).
app.get('/api/update/history', async (req, res) => {
    try {
        const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 25));
        res.json({ history: listUpdateHistory({ limit }) });
    } catch (e) {
        res.status(500).json({ error: e?.message || 'Failed to read update history' });
    }
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
// express-rate-limit v7 does not support function values for windowMs/limit,
// so we use static defaults and rebuild the limiter on config change.
const _shareRateCfg = { windowMs: 60_000, limit: 60 };
function _buildShareLimiter() {
    return rateLimit({
        windowMs: _shareRateCfg.windowMs,
        limit: _shareRateCfg.limit,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { error: 'Too many requests — slow down.' },
    });
}
let shareLimiter = _buildShareLimiter();

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
    const sh = _currentShareConfig();
    const ms = Number(sh.rateLimitWindowMs);
    const lim = Number(sh.rateLimitMax);
    _shareRateCfg.windowMs = Number.isFinite(ms) && ms > 0 ? ms : 60_000;
    _shareRateCfg.limit = Number.isFinite(lim) && lim > 0 ? lim : 60;
    shareLimiter = _buildShareLimiter();
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
        try {
            const cfg = loadConfig();
            if (!cfg.monitor) cfg.monitor = {};
            cfg.monitor.autoStart = true;
            saveConfig(cfg);
        } catch {}
        res.json({ success: true, status: runtime.status() });
    } catch (e) {
        const { status, body } = tgAuthErrorBody(e);
        res.status(status === 400 ? 500 : status).json(body.error ? body : { error: e.message });
    }
});

app.post('/api/monitor/stop', async (req, res) => {
    try {
        await runtime.stop();
        try {
            const cfg = loadConfig();
            if (!cfg.monitor) cfg.monitor = {};
            cfg.monitor.autoStart = false;
            saveConfig(cfg);
        } catch {}
        res.json({ success: true, status: runtime.status() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/monitor/restart', async (req, res) => {
    try {
        const am = await getAccountManager();
        if (am.count === 0) {
            return res.status(409).json({
                error: 'No Telegram accounts loaded. Add one in Settings → Accounts first.',
            });
        }
        await runtime.restart({ config: loadConfig(), accountManager: am });
        try {
            const cfg = loadConfig();
            if (!cfg.monitor) cfg.monitor = {};
            cfg.monitor.autoStart = true;
            saveConfig(cfg);
        } catch {}
        res.json({ success: true, status: runtime.status() });
    } catch (e) {
        const { status, body } = tgAuthErrorBody(e);
        res.status(status === 400 ? 500 : status).json(body.error ? body : { error: e.message });
    }
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

// History jobs persist to kv['history_jobs'] in SQLite — the JSON file
// at data/history-jobs.json was migrated alongside config / disk_usage
// in the v2.7 state migration. Legacy files on disk are still picked up
// once on first boot by state-migration.js, then archived.
const HISTORY_JOBS_KV = 'history_jobs';

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
// `_runner` is stripped before serialising (it's the live downloader).
const _historyJobs = new Map();

function loadHistoryJobsFromStore() {
    const stored = kvGet(HISTORY_JOBS_KV);
    if (!Array.isArray(stored)) return [];
    const cutoff = Date.now() - historyRetentionMs();
    return stored.filter((j) => j && (j.finishedAt || j.startedAt || 0) >= cutoff);
}

function saveHistoryJobsToStore() {
    // Snapshot finished jobs (state !== running) without the _runner ref.
    const finished = Array.from(_historyJobs.values())
        .filter((j) => j.state !== 'running')
        .map(({ _runner, ...rest }) => rest);
    // Merge with anything still in the store that isn't in memory
    // (older history older than process start).
    const onDisk = loadHistoryJobsFromStore();
    const byId = new Map();
    for (const j of onDisk) byId.set(j.id, j);
    for (const j of finished) byId.set(j.id, j);
    const cutoff = Date.now() - historyRetentionMs();
    const all = Array.from(byId.values())
        .filter((j) => (j.finishedAt || j.startedAt || 0) >= cutoff)
        .sort((a, b) => (b.finishedAt || b.startedAt || 0) - (a.finishedAt || a.startedAt || 0));
    try {
        kvSet(HISTORY_JOBS_KV, all);
    } catch (e) {
        console.error("kv['history_jobs'] write failed:", e?.message || e);
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
                : Math.max(1, Math.min(BACKFILL_MAX_LIMIT, Number.isFinite(limRaw) ? limRaw : 100));

        const am = await getAccountManager();
        if (am.count === 0) return res.status(409).json({ error: 'No Telegram accounts loaded' });

        const config = loadConfig();
        let group = (config.groups || []).find((g) => String(g.id) === String(groupId));
        // Sidebar surfaces "download-only" groups — rows that have files
        // in `downloads` but never made it into `config.groups` (e.g.
        // imported from a peer, restored from a backup, or seeded by an
        // older build that wrote the row before registering the group).
        // Clicking such a row deep-links to #/backfill/<id>; without
        // auto-registration the operator just sees "Group not configured"
        // and has no obvious next step. Auto-register here when we can
        // resolve the dialog from any connected account, then continue.
        if (!group) {
            let resolved = null;
            try {
                const probe = await import('../core/dialogs-resolver.js').catch(() => null);
                if (probe?.resolveDialogName) {
                    resolved = await probe.resolveDialogName(String(groupId)).catch(() => null);
                }
            } catch {}
            // Fall back to the DB's best-known name so the auto-added entry
            // isn't called "Unknown" forever.
            let dbName = null;
            try {
                const row = getDb()
                    .prepare(
                        "SELECT group_name FROM downloads WHERE group_id = ? AND group_name IS NOT NULL AND group_name != '' AND group_name != 'Unknown' LIMIT 1",
                    )
                    .get(String(groupId));
                if (row?.group_name) dbName = row.group_name;
            } catch {}
            const idForConfig =
                String(groupId).startsWith('-') &&
                Number.isSafeInteger(parseInt(String(groupId), 10))
                    ? parseInt(String(groupId), 10)
                    : groupId;
            group = {
                id: idForConfig,
                name: resolved || dbName || `Group ${groupId}`,
                enabled: false,
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
            config.groups = config.groups || [];
            config.groups.push(group);
            try {
                await writeConfigAtomic(config);
                _dialogsResponseCache = { at: 0, body: null };
                broadcast({ type: 'config_updated' });
                log({
                    source: 'history',
                    level: 'info',
                    msg: `auto-registered group ${groupId} ("${group.name}") before backfill — was present in downloads but missing from config`,
                });
            } catch (e) {
                console.warn('[history] auto-register failed:', e.message);
                return res.status(404).json({
                    error: 'Group not configured — add it from Manage Groups first',
                    code: 'GROUP_NOT_CONFIGURED',
                });
            }
        }

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

        const onProgress = (s) => {
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
        };
        // Mirror the chosen mode onto the job so the UI shows it ("pull
        // older" / "catch up" / "rescan") even after the worker exits.
        const onStart = (s) => {
            if (s?.mode) job.mode = s.mode;
        };
        history.on('progress', onProgress);
        history.on('start', onStart);

        const _cleanupListeners = () => {
            history.off('progress', onProgress);
            history.off('start', onStart);
        };

        history
            .downloadHistory(groupId, {
                limit: lim ?? undefined,
                offsetId: parseInt(offsetId, 10) || 0,
                mode: mode === 'catch-up' || mode === 'rescan' ? mode : 'pull-older',
            })
            .then(() => {
                _cleanupListeners();
                job.state = job.cancelled ? 'cancelled' : 'done';
                job.finishedAt = Date.now();
                delete job._runner;
                // Two distinct terminal events so the dashboard can flash
                // green for natural completions and amber for user cancels
                // without sniffing payload fields.
                const evt = job.cancelled ? 'history_cancelled' : 'history_done';
                broadcast({ type: evt, jobId, group: group.name, ...job });
                if (standalone) downloader.stop().catch(() => {});
                saveHistoryJobsToStore();
                // Release the per-group lock so a new backfill can spawn.
                if (_activeBackfillsByGroup.get(groupKey) === jobId) {
                    _activeBackfillsByGroup.delete(groupKey);
                }
                // Drop the in-memory entry after a grace window so the UI has
                // time to grab it via /api/history/jobs.
                setTimeout(() => _historyJobs.delete(jobId), HISTORY_JOB_TTL_MS);
            })
            .catch((err) => {
                _cleanupListeners();
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
                saveHistoryJobsToStore();
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
        const onDisk = loadHistoryJobsFromStore();
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

        // Drop from the kv store too. kvSet runs the upsert in a SQLite
        // transaction so a partial write can never land.
        const onDisk = loadHistoryJobsFromStore();
        const filtered = onDisk.filter((j) => j.id !== id);
        try {
            kvSet(HISTORY_JOBS_KV, filtered);
        } catch (e) {
            console.error("kv['history_jobs'] write failed:", e?.message || e);
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
        // Wipe the kv-backed store of finished jobs.
        try {
            kvSet(HISTORY_JOBS_KV, []);
        } catch (e) {
            console.error("kv['history_jobs'] wipe failed:", e?.message || e);
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

// Queue history persists to kv['queue_history']. Same migration story as
// history_jobs above — the legacy `data/queue-history.json` file is
// imported once on first boot and then archived.
const QUEUE_HISTORY_KV = 'queue_history';
const QUEUE_HISTORY_CAP = 100;
let _queueHistory = []; // newest first
let _queueHistoryDirty = false;
let _queueHistoryFlushTimer = null;
// Map<key, jobMeta> — keeps original job objects around so /retry can
// re-enqueue without the client having to round-trip the message ref.
// LRU-capped at 5 000 entries because a chronically-failing source
// (e.g. CHANNEL_INVALID storm during a Telegram outage) would otherwise
// grow this Map without bound until the user clicks `clear-finished`.
// See `CLAUDE.md → Big-data patterns` rule 3.
const _failedJobMeta = new Map();
const FAILED_JOB_META_CAP = 5000;

(function loadQueueHistory() {
    try {
        const stored = kvGet(QUEUE_HISTORY_KV);
        if (Array.isArray(stored)) _queueHistory = stored.slice(0, QUEUE_HISTORY_CAP);
    } catch {
        /* first-run, no row yet */
    }
})();

function flushQueueHistorySoon() {
    _queueHistoryDirty = true;
    if (_queueHistoryFlushTimer) return;
    // 1.5 s debounce keeps a chatty download stream from hammering the kv
    // upsert. Each kvSet is one short SQLite transaction; cheap, but the
    // batching still saves a few dozen writes/min on a busy queue.
    _queueHistoryFlushTimer = setTimeout(() => {
        _queueHistoryFlushTimer = null;
        if (!_queueHistoryDirty) return;
        _queueHistoryDirty = false;
        try {
            kvSet(QUEUE_HISTORY_KV, _queueHistory.slice(0, QUEUE_HISTORY_CAP));
        } catch (e) {
            const msg = String(e?.message || e);
            const busy =
                msg.includes('database connection is busy') ||
                msg.includes('SQLITE_BUSY') ||
                e?.code === 'SQLITE_BUSY';
            if (busy) {
                // A maintenance sweep (.iterate() + await) is holding the
                // connection. Re-arm the debounce so we retry after 500 ms
                // instead of losing the write entirely.
                _queueHistoryDirty = true;
                _queueHistoryFlushTimer = setTimeout(() => {
                    _queueHistoryFlushTimer = null;
                    if (!_queueHistoryDirty) return;
                    _queueHistoryDirty = false;
                    try {
                        kvSet(QUEUE_HISTORY_KV, _queueHistory.slice(0, QUEUE_HISTORY_CAP));
                    } catch (e2) {
                        console.error("kv['queue_history'] write failed:", e2?.message || e2);
                    }
                }, 500).unref?.();
            } else {
                console.error("kv['queue_history'] write failed:", e?.message || e);
            }
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
        if (!job?.key) return;
        // Re-set bumps insertion order to the back → oldest entries fall
        // off the front when we hit the cap. Real LRU on touch.
        if (_failedJobMeta.has(job.key)) _failedJobMeta.delete(job.key);
        _failedJobMeta.set(job.key, job);
        while (_failedJobMeta.size > FAILED_JOB_META_CAP) {
            const first = _failedJobMeta.keys().next().value;
            if (first === undefined) break;
            _failedJobMeta.delete(first);
        }
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

app.get('/api/system/health', async (req, res) => {
    try {
        const os = await import('os');
        const mem = process.memoryUsage();
        const cpus = os.cpus();
        const loadAvg = os.loadavg();
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const uptime = process.uptime();

        const diskUsage = await (async () => {
            try {
                const du = kvGet('disk_usage');
                return du ? JSON.parse(du) : null;
            } catch {
                return null;
            }
        })();

        res.json({
            process: {
                pid: process.pid,
                uptime: Math.floor(uptime),
                memoryMB: {
                    rss: Math.round(mem.rss / 1024 / 1024),
                    heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
                    heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
                    external: Math.round(mem.external / 1024 / 1024),
                },
                nodeVersion: process.version,
            },
            system: {
                platform: os.platform(),
                arch: os.arch(),
                hostname: os.hostname(),
                cpuCount: cpus.length,
                cpuModel: cpus[0]?.model || 'unknown',
                loadAvg: loadAvg.map((l) => Math.round(l * 100) / 100),
                totalMemMB: Math.round(totalMem / 1024 / 1024),
                freeMemMB: Math.round(freeMem / 1024 / 1024),
                usedMemPercent: Math.round(((totalMem - freeMem) / totalMem) * 100),
            },
            disk: diskUsage,
            database: (() => {
                try {
                    const db = getDb();
                    const pageSize = db.pragma('page_size', { simple: true });
                    const pageCount = db.pragma('page_count', { simple: true });
                    const walPages = db.pragma('wal_checkpoint(PASSIVE)');
                    return {
                        sizeMB: Math.round((pageSize * pageCount) / 1024 / 1024),
                        walPages: walPages?.[0]?.busy || 0,
                        journalMode: db.pragma('journal_mode', { simple: true }),
                    };
                } catch {
                    return null;
                }
            })(),
            connections: {
                wsClients: clients.size,
            },
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

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
                    suspended: configGroup?.suspended === true,
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
                    // Federation surface — own groups carry peerId: null
                    // so the sidebar can distinguish them from peer rows
                    // appended below.
                    peerId: null,
                    peerName: null,
                };
            }),
        );

        // Federation merge — append every paired peer's groups to the list,
        // deduplicated by id (own row wins; peer rows that share an id are
        // attached to the local row's `mirroredOn` array). Default off /
        // empty when no peers are paired so non-cluster operators see no
        // change. Each foreign group carries `peerId` + `peerName` so the
        // SPA can render a "from {peer}" badge and route per-group clicks
        // to /api/downloads/:id?include=peers&peerId=<id>.
        //
        // Guest sessions skip the merge — federation is admin-gated, so a
        // guest's sidebar stays local-only.
        if (req.role !== 'guest') {
            try {
                const ownIdSet = new Set(groupsWithPhotos.map((g) => String(g.id)));
                const peerGroupRows = getDb()
                    .prepare('SELECT peer_id, payload FROM peer_groups LIMIT 5000')
                    .all();
                const peerNameMap = new Map();
                try {
                    for (const p of listPeers())
                        peerNameMap.set(String(p.peerId), p.name || p.peerId);
                } catch {
                    /* cluster not initialised — peer name stays null */
                }
                for (const r of peerGroupRows) {
                    let payload = null;
                    try {
                        payload = JSON.parse(r.payload);
                    } catch {
                        continue;
                    }
                    const peerGroups = Array.isArray(payload?.groups) ? payload.groups : [];
                    const peerName = peerNameMap.get(String(r.peer_id)) || null;
                    for (const pg of peerGroups) {
                        const idStr = String(pg.id);
                        if (ownIdSet.has(idStr)) {
                            // Local row already has this group — attach the
                            // peer to its mirroredOn list so the SPA can show
                            // a "+N peers also have this" badge later.
                            const localRow = groupsWithPhotos.find((g) => String(g.id) === idStr);
                            if (localRow) {
                                localRow.mirroredOn = Array.isArray(localRow.mirroredOn)
                                    ? localRow.mirroredOn
                                    : [];
                                if (!localRow.mirroredOn.includes(r.peer_id)) {
                                    localRow.mirroredOn.push(r.peer_id);
                                }
                            }
                            continue;
                        }
                        // Truly foreign group — append. Photo URL stays null
                        // (no cross-peer photo proxy in M1); the SPA falls
                        // back to a default avatar for these rows.
                        groupsWithPhotos.push({
                            ...pg,
                            peerId: r.peer_id,
                            peerName,
                            type: pg.type || dialogsTypeFor(pg.id),
                            photoUrl: null,
                        });
                        // Mark in the local set so two peers sharing the same
                        // foreign group don't surface twice.
                        ownIdSet.add(idStr);
                    }
                }
            } catch (e) {
                // Federation merge is purely additive — log and continue if it
                // explodes, so a bad peer payload can't take down the sidebar.
                console.warn('GET /api/groups federation merge failed:', e?.message || e);
            }
        }

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
                duration: row.duration_sec ?? null,
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
                duration: row.duration_sec ?? null,
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
                duration: row.duration_sec ?? null,
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
                    const { deferDelete } = await import('../core/deferred-delete.js');
                    deferDelete(sr.real);
                    unlinked++;
                } catch {
                    try {
                        await fs.unlink(sr.real);
                        unlinked++;
                    } catch (e2) {
                        if (e2.code !== 'ENOENT') throw e2;
                    }
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
                        const { deferDelete } = await import('../core/deferred-delete.js');
                        deferDelete(sr.real);
                        unlinked++;
                    } catch {
                        try {
                            await fs.unlink(sr.real);
                            unlinked++;
                        } catch (e2) {
                            if (e2.code !== 'ENOENT') throw e2;
                        }
                    }
                }
                processed += 1;
                if (processed % 50 === 0 || processed === total) {
                    onProgress({ processed, total, stage: 'deleting_files' });
                }
            }
        }
        const allIds = Array.from(new Set([...idList, ...resolvedIdsFromPaths]));
        const seekbarMap = collectSeekbarPaths(allIds);
        const dbDeleted = deleteDownloadsBy({ ids: allIds });
        onProgress({ processed: total, total, stage: 'purging_cache' });
        for (const id of allIds) {
            try {
                await purgeThumbsForDownload(id);
            } catch {}
            try {
                await purgeSeekbarForDownload(id, seekbarMap.get(id));
            } catch {}
        }
        try {
            purgeOrphanPeople();
        } catch {}
        import('../core/deferred-delete.js').then((m) => m.startDrain()).catch(() => {});
        broadcast({ type: 'bulk_delete', unlinked, dbDeleted, count: allIds.length });
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

        try {
            const { deferDelete } = await import('../core/deferred-delete.js');
            deferDelete(r.real);
        } catch {
            await fs.unlink(r.real);
        }
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
        const seekbarMap = collectSeekbarPaths(matchingIds);
        db.prepare('DELETE FROM downloads WHERE file_name = ?').run(fileName);
        for (const id of matchingIds) {
            try {
                await purgeThumbsForDownload(id);
            } catch {}
            try {
                await purgeSeekbarForDownload(id, seekbarMap.get(id));
            } catch {}
        }
        try {
            purgeOrphanPeople();
        } catch {}
        import('../core/deferred-delete.js').then((m) => m.startDrain()).catch(() => {});

        broadcast({ type: 'file_deleted', path: filePath });
        res.json({ success: true });
    } catch (error) {
        if (error.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
        console.error('DELETE /api/file:', error);
        res.status(500).json({ error: 'Internal error' });
    }
});

// Mint a short-lived bearer token for /files/ paths. The token lets a URL
// work without the session cookie — useful when Cloudflare redirects the
// request to a direct DDNS host where the cookie doesn't follow.
app.get('/api/files/token', (_req, res) => {
    const { token, exp } = mintFileToken();
    res.json({ token, exp });
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

        // 2. Collect download IDs before wiping rows so we can purge per-file caches.
        const downloadIds = getDb()
            .prepare('SELECT id FROM downloads WHERE group_id = ?')
            .all(String(groupId))
            .map((r) => r.id);

        const seekbarMap = collectSeekbarPaths(downloadIds);

        // 3. Delete DB records
        onProgress({ stage: 'deleting_rows', groupId });
        const dbResult = deleteGroupDownloads(groupId);

        // 4. Remove from config
        config.groups = (config.groups || []).filter((g) => String(g.id) !== String(groupId));
        await writeConfigAtomic(config);

        // 5. Delete profile photo
        const safeGroupId = String(groupId).replace(/[^A-Za-z0-9_.-]/g, '_');
        const photoPath = path.join(PHOTOS_DIR, `${safeGroupId}.jpg`);
        if (existsSync(photoPath)) await fs.unlink(photoPath);

        // 6. Purge thumbnail + seekbar sprite cache for every deleted download.
        const CACHE_BATCH = 50;
        for (let i = 0; i < downloadIds.length; i += CACHE_BATCH) {
            for (const id of downloadIds.slice(i, i + CACHE_BATCH)) {
                try {
                    await purgeThumbsForDownload(id);
                } catch {}
                try {
                    await purgeSeekbarForDownload(id, seekbarMap.get(id));
                } catch {}
            }
            await new Promise((r) => setImmediate(r));
        }

        try {
            purgeOrphanPeople();
        } catch {}
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

// 6b-bis. Per-group data viewer endpoints — the Group modal's "Data" tab
// renders these. Stats is one index-only query (cheap); files is paginated.
app.get('/api/groups/:id/stats', async (req, res) => {
    try {
        const groupId = req.params.id;
        if (!groupId) return res.status(400).json({ error: 'group id required' });
        const stats = getGroupStats(groupId);
        res.json({ success: true, ...stats });
    } catch (e) {
        console.error('groups/:id/stats:', e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/groups/:id/files', async (req, res) => {
    try {
        const groupId = req.params.id;
        if (!groupId) return res.status(400).json({ error: 'group id required' });
        const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 50));
        const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
        const type = typeof req.query.type === 'string' ? req.query.type : null;
        const r = listGroupFiles({ groupId, limit, offset, type });
        res.json({ success: true, ...r });
    } catch (e) {
        console.error('groups/:id/files:', e);
        res.status(500).json({ error: e.message });
    }
});

// "Delete files only" — drops every download row + on-disk file for this
// group BUT keeps the config entry + monitor enabled. Operator picks this
// when they want to clear stale data and re-download fresh, instead of
// the destructive `/purge` (which also removes the group from config).
// Re-uses the per-group purge tracker so a parallel /purge can't race.
app.post('/api/groups/:id/delete-files', async (req, res) => {
    const groupId = req.params.id;
    if (!groupId) return res.status(400).json({ error: 'group id required' });
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
        // Collect IDs + seekbar paths before wiping rows so we can purge per-file caches.
        const downloadIds = getDb()
            .prepare('SELECT id FROM downloads WHERE group_id = ?')
            .all(String(groupId))
            .map((r) => r.id);
        const seekbarMap = collectSeekbarPaths(downloadIds);

        onProgress({ stage: 'deleting_rows', groupId });
        const dbResult = deleteGroupDownloads(groupId);

        // Purge thumbnail + seekbar sprite cache for every deleted download.
        const CACHE_BATCH = 50;
        for (let i = 0; i < downloadIds.length; i += CACHE_BATCH) {
            for (const id of downloadIds.slice(i, i + CACHE_BATCH)) {
                try {
                    await purgeThumbsForDownload(id);
                } catch {}
                try {
                    await purgeSeekbarForDownload(id, seekbarMap.get(id));
                } catch {}
            }
            await new Promise((r) => setImmediate(r));
        }

        try {
            purgeOrphanPeople();
        } catch {}
        onProgress({ stage: 'done', groupId });
        try {
            broadcast({
                type: 'group_files_deleted',
                groupId: String(groupId),
                groupName,
                ...dbResult,
                filesDeleted,
            });
        } catch {}
        return {
            groupId: String(groupId),
            groupName,
            filesDeleted,
            deletedDownloads: dbResult.deletedDownloads,
            deletedQueue: dbResult.deletedQueue,
        };
    });
    if (!r.started) {
        return res.status(409).json({
            error: 'A purge / delete is already running for this group',
            code: 'ALREADY_RUNNING',
        });
    }
    res.json({ success: true, started: true, groupId });
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

        onProgress({ stage: 'purging_cache' });
        await purgeAllThumbs();
        await purgeAllSeekbar();

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
            const rows = getDb()
                .prepare('SELECT DISTINCT group_id FROM downloads LIMIT 10000')
                .all();
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
        const result = await integrity.sweep(onProgress);
        // Persist a small summary for the duplicates page's "Last run"
        // chip — the JobTracker holds the running state in process
        // memory, so without this kv blob a server restart erases the
        // last-completed snapshot.
        try {
            kvSet('files_verify_last_run', {
                finishedAt: Date.now(),
                removed: result?.removed ?? result?.dropped ?? 0,
                scanned: result?.scanned ?? result?.total ?? 0,
            });
        } catch {}
        return result;
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

app.get('/api/maintenance/files/verify/stats', async (req, res) => {
    try {
        const lastRun = kvGet('files_verify_last_run') || null;
        res.json({ lastRun });
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
});

// Re-index from disk — the inverse of /files/verify. Walks
// data/downloads/ and inserts rows for files the catalogue doesn't
// know about. Idempotent (INSERT OR IGNORE on (group_id, message_id)).
// Used to recover a wiped DB (Purge all, fresh install over an existing
// downloads/ tree, restore from backups/ snapshot) without re-downloading
// from Telegram. Background-driven; progress broadcast via WS
// `reindex_progress` and final `reindex_done` so the page can render a
// determinate bar without polling.
// Migrated from a hand-rolled `_reindexBgRunning` flag that OR'd with
// `integrity.isReindexRunning()` to determine the running state. The
// dual-source-of-truth meant a status snapshot could report `running:
// true` while neither subsystem was actually progressing — masking
// which component owned the job. Now there's one tracker. Prefix
// 'reindex' is preserved so the duplicates page's listeners need no
// change.
app.post('/api/maintenance/reindex', async (req, res) => {
    const tracker = _jobTrackers.reindex;
    const r = tracker.tryStart(async ({ onProgress }) => {
        const cfg = await readConfigSafe();
        const groups = Array.isArray(cfg?.groups) ? cfg.groups : [];
        const result = await integrity.reindexFromDisk(groups, (p) => onProgress(p));
        try {
            kvSet('reindex_last_run', {
                finishedAt: Date.now(),
                added: result?.added ?? result?.indexed ?? 0,
                scanned: result?.scanned ?? result?.total ?? 0,
            });
        } catch {}
        return result;
    });
    if (!r.started) {
        return res
            .status(409)
            .json({ error: 'already_running', code: r.code || 'ALREADY_RUNNING' });
    }
    res.json({ ok: true, started: true });
});

app.get('/api/maintenance/reindex/status', async (req, res) => {
    const snap = _jobTrackers.reindex.getStatus();
    res.json({ ...snap, ...(snap.progress || {}) });
});

app.get('/api/maintenance/reindex/stats', async (req, res) => {
    try {
        const lastRun = kvGet('reindex_last_run') || null;
        res.json({ lastRun });
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
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
// Migrated from a hand-rolled `_dedupRunning` flag to the shared
// JobTracker for free single-flight, abort, attempt counters, and
// duration tracking. WS event prefix stays 'dedup' — the duplicates
// page's existing `dedup_progress` / `dedup_done` listeners are
// unaffected.
app.post('/api/maintenance/dedup/scan', async (req, res) => {
    const tracker = _jobTrackers.dedupScan;
    const r = tracker.tryStart(async ({ onProgress, signal }) => {
        const result = await dedupFindDuplicates({
            onProgress: (p) => onProgress({ ...p, running: true }),
            signal,
        });
        // Persist a small summary so a server restart still surfaces
        // "Last scan: 2 h ago — N duplicates" on the duplicates page
        // without having to recompute. The full duplicate-sets payload
        // stays in tracker memory — no point persisting megabytes of
        // file rows that the next scan rebuilds.
        try {
            const sets = Array.isArray(result?.duplicateSets) ? result.duplicateSets : [];
            const extras = sets.reduce((s, x) => s + Math.max(0, (x.count || 0) - 1), 0);
            const reclaim = sets.reduce(
                (s, x) => s + Number(x.fileSize || 0) * Math.max(0, (x.count || 0) - 1),
                0,
            );
            // When aborted mid-run the scan returns partial results
            // (signal.aborted set). Persist that state so the stats panel
            // can show "resume" affordance after a server restart.
            const wasAborted = signal?.aborted;
            if (wasAborted) {
                kvSet('dedup_scan_progress', {
                    stoppedAt: Date.now(),
                    scanned: result?.scanned || 0,
                    hashed: result?.hashed || 0,
                    partial: true,
                });
            } else {
                // Completed scan clears any lingering partial-progress entry.
                try {
                    kvSet('dedup_scan_progress', null);
                } catch {}
                kvSet('dedup_last_scan', {
                    finishedAt: Date.now(),
                    scanned: result?.scanned || 0,
                    hashed: result?.hashed || 0,
                    duplicateSets: sets.length,
                    extraCopies: extras,
                    reclaimableBytes: reclaim,
                });
            }
        } catch {}
        // The JobTracker spreads the entire result into the WS
        // `dedup_done` broadcast. With no set-count cap the full
        // duplicateSets array can be megabytes, blowing the WS frame.
        // Solution: stash the heavy array on a non-enumerable property
        // so JSON.stringify (used by broadcast) skips it, but the
        // GET /dedup/status handler can still read it via getStatus().
        const wsResult = {
            scanned: result?.scanned || 0,
            hashed: result?.hashed || 0,
            errored: result?.errored || 0,
            aborted: signal?.aborted || false,
        };
        const sets = Array.isArray(result?.duplicateSets) ? result.duplicateSets : [];
        Object.defineProperty(wsResult, 'duplicateSets', {
            value: sets,
            enumerable: false,
            configurable: true,
        });
        return wsResult;
    });
    if (!r.started) {
        return res
            .status(409)
            .json({ error: 'A dedup scan is already running', code: r.code || 'ALREADY_RUNNING' });
    }
    res.json({ success: true, started: true });
});

// Status endpoint — returns the latest scan state including the result
// payload from the most recent completed run, so a re-opened page can
// render the duplicate-sets table without re-running the scan. The
// tracker stores the last result on the snapshot's `.result` field, so
// the duplicates page reads `r.result.duplicateSets`.
// Stop a running dedup scan — signals the AbortController inside the
// JobTracker. The scan loop checks signal.aborted after each file and
// breaks cleanly, then dedup_done fires with whatever partial result was
// accumulated. Returns instantly; the caller doesn't need to wait for the
// scan to wind down (it's typically one-file-latency, i.e. milliseconds).
app.post('/api/maintenance/dedup/scan/stop', (req, res) => {
    const wasRunning = _jobTrackers.dedupScan.cancel();
    res.json({ stopped: true, wasRunning });
});

app.get('/api/maintenance/dedup/status', async (req, res) => {
    const snap = _jobTrackers.dedupScan.getStatus();
    // Re-attach the non-enumerable duplicateSets so the frontend can
    // pull the full result via this endpoint (the WS done event strips
    // it to avoid multi-MB frames).
    const out = { ...snap, ...(snap.progress || {}) };
    if (snap.result && !out.result?.duplicateSets && snap.result.duplicateSets) {
        out.result = { ...snap.result, duplicateSets: snap.result.duplicateSets };
    }
    res.json(out);
});

// Library hash-coverage stats — total rows, how many already have a SHA-256
// (cheap re-scans), how many are still awaiting a hash (the next scan's
// O(bytes) cost), plus the persisted summary of the last completed scan.
// The duplicates page uses this to render a "library status" panel above
// the buttons so the operator can answer "what will Scan even do here?"
// before clicking — and to show a "Last scan" line that survives a
// server restart.
app.get('/api/maintenance/dedup/stats', async (req, res) => {
    try {
        const db = getDb();
        const totalFiles = db.prepare('SELECT COUNT(*) AS n FROM downloads').get().n || 0;
        const hashed =
            db.prepare('SELECT COUNT(*) AS n FROM downloads WHERE file_hash IS NOT NULL').get().n ||
            0;
        // Same predicate the dedup scanner uses to decide what to hash —
        // mirrors src/core/dedup.js findDuplicates() so the "Awaiting hash"
        // count matches what a Scan will actually walk.
        const missing =
            db
                .prepare(`
                SELECT COUNT(*) AS n FROM downloads
                 WHERE file_hash IS NULL
                   AND file_path IS NOT NULL
                   AND COALESCE(file_size, 0) > 0
            `)
                .get().n || 0;
        let lastScan = null;
        try {
            const stored = kvGet('dedup_last_scan');
            if (stored && typeof stored === 'object') lastScan = stored;
        } catch {}
        let partialProgress = null;
        try {
            const stored = kvGet('dedup_scan_progress');
            if (stored && typeof stored === 'object' && stored.partial) partialProgress = stored;
        } catch {}
        res.json({ totalFiles, hashed, missing, lastScan, partialProgress });
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
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
        // Batch the work so a 10k-row delete doesn't block the event loop
        // for minutes (every fs.unlinkSync inside `dedupDeleteByIds` runs
        // on the main thread). Each batch is small enough that progress
        // events flush between iterations and the WS dashboard sees a
        // live bar instead of a frozen UI followed by a timeout.
        const total = cleanIds.length;
        const BATCH = 50;
        const aggregate = { removed: 0, freedBytes: 0, missingFiles: 0 };
        let processed = 0;
        onProgress({ processed: 0, total, stage: 'deleting' });
        for (let off = 0; off < cleanIds.length; off += BATCH) {
            const slice = cleanIds.slice(off, off + BATCH);
            const seekbarMap = collectSeekbarPaths(slice);
            const part = dedupDeleteByIds(slice);
            aggregate.removed += part.removed || 0;
            aggregate.freedBytes += part.freedBytes || 0;
            aggregate.missingFiles += part.missingFiles || 0;
            for (const id of slice) {
                try {
                    await purgeThumbsForDownload(id);
                } catch {}
                try {
                    await purgeSeekbarForDownload(id, seekbarMap.get(id));
                } catch {}
            }
            processed += slice.length;
            onProgress({ processed, total, stage: 'deleting' });
            await new Promise((r) => setImmediate(r));
        }
        try {
            purgeOrphanPeople();
        } catch {}
        try {
            broadcast({ type: 'bulk_delete', count: cleanIds.length });
        } catch {}
        // Drain deferred-deleted files in the background.
        import('../core/deferred-delete.js').then((m) => m.startDrain()).catch(() => {});
        return { ...aggregate, requested: cleanIds.length };
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
            // No-store on the miss path. Without this header the browser
            // remembers the 404 + text/plain body for the URL's default
            // heuristic window and keeps replaying it from cache after
            // the thumb finally lands on disk — operator sees "ภาพอื่น
            // โหลด ปกติ id X ไม่ขึ้น แม้ generated แล้ว". Forcing the
            // client to re-request next time fixes that.
            res.setHeader('Cache-Control', 'no-store');
            return res.status(404).type('text/plain').send('No thumb');
        }

        res.setHeader('Content-Type', 'image/webp');
        // Browser cache for an hour + must-revalidate so stale entries
        // (e.g. a 404 the client cached before this URL had a real thumb
        // on disk) get rechecked against Last-Modified instead of being
        // served forever from the local cache. `immutable` was the wrong
        // hint for this URL: the same id+width can legitimately serve
        // different bytes after a source replacement or a manual purge.
        res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
        // ETag derived from mtime + size so a regenerated thumb produces
        // a different validator and the browser can't reuse the old
        // body byte-for-byte under a 304.
        const stMtime = Math.floor(thumb.mtime);
        const etag = `"thumb-${id}-${thumb.width || 'd'}-${stMtime}"`;
        res.setHeader('ETag', etag);
        const lastMod = new Date(thumb.mtime).toUTCString();
        res.setHeader('Last-Modified', lastMod);
        if (req.headers['if-none-match'] === etag || req.headers['if-modified-since'] === lastMod) {
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
    // Optional body.kind scopes the wipe to one media class — e.g.
    // {"kind":"video"} only purges the cache rows whose downloads.file_type
    // matches the video bucket. Defaults to the full directory unlink.
    const kindRaw = String(req.body?.kind || 'all').toLowerCase();
    const kind = thumbKindTypes(kindRaw) ? kindRaw : 'all';
    const r = tracker.tryStart(async () => {
        const removed = await purgeAllThumbs({ kind });
        return { removed, kind };
    });
    if (!r.started) {
        return res
            .status(409)
            .json({ error: 'A thumbnail wipe is already running', code: 'ALREADY_RUNNING' });
    }
    res.json({ success: true, started: true, kind });
});

app.get('/api/maintenance/thumbs/rebuild/status', async (req, res) => {
    res.json(_jobTrackers.thumbsRebuild.getStatus());
});

// Rebuild one tile. Used by the gallery's per-tile retry action — purges
// the cached widths for that id; the next /api/thumbs/:id hit regenerates
// on demand. Cheap, idempotent, admin-only.
app.post('/api/maintenance/thumbs/rebuild-one/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: 'Bad id' });
        }
        const removed = await purgeThumbsForDownload(id);
        // Best-effort warm of the default width so the client's retry doesn't
        // stare at a 404 + skeleton. Failures here are non-fatal — the
        // on-demand path handles the next request.
        try {
            await getOrCreateThumb(id, THUMB_DEFAULT_WIDTH);
        } catch {}
        res.json({ success: true, removed, cached: hasCachedThumb(id) });
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
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
// Migrated from a hand-rolled `_thumbBuildRunning` flag. The previous
// implementation broadcast `thumbs_done` on caught errors BEFORE the
// `finally` block reset the flag — a double-click after a failed build
// landed in the race window and got a spurious 409 ALREADY_RUNNING.
// JobTracker resets `running` and broadcasts `_done` atomically, so the
// retry succeeds. Prefix 'thumbs' preserved.
app.post('/api/maintenance/thumbs/build-all', async (req, res) => {
    const tracker = _jobTrackers.thumbsBuild;
    // Optional body.kind scopes the build to one media class. Accepts
    // 'all' | 'image' | 'video' | 'audio'; unknown values fall back to 'all'
    // so the existing client (no body) still works untouched.
    const kindRaw = String(req.body?.kind || 'all').toLowerCase();
    const kind = thumbKindTypes(kindRaw) ? kindRaw : 'all';
    const r = tracker.tryStart(async ({ onProgress, signal }) => {
        try {
            kvSet('pending_job_thumbsBuild', { startedAt: Date.now(), kind });
        } catch {}
        const result = await buildAllThumbnails({
            kind,
            onProgress: (p) => onProgress({ ...p, kind }),
            signal,
        });
        try {
            kvSet('pending_job_thumbsBuild', null);
        } catch {}
        try {
            kvSet('thumbs_last_build', {
                finishedAt: Date.now(),
                kind,
                built: result?.built ?? 0,
                skipped: result?.skipped ?? 0,
                errored: result?.errored ?? 0,
                scanned: result?.scanned ?? 0,
            });
        } catch {}
        return { ...result, kind };
    });
    if (!r.started) {
        return res.status(409).json({
            error: 'A thumbnail build is already running',
            code: r.code || 'ALREADY_RUNNING',
        });
    }
    res.json({ success: true, started: true, kind });
});

// Cancel an in-flight build sweep. Idempotent — if nothing is running, the
// tracker just reports false and the client treats it as already-stopped.
// JobTracker emits a final `thumbs_done` with `cancelled:true`.
app.post('/api/maintenance/thumbs/build/cancel', async (req, res) => {
    const cancelled = _jobTrackers.thumbsBuild.cancel();
    res.json({ success: true, cancelled });
});

app.get('/api/maintenance/thumbs/build/status', async (req, res) => {
    const snap = _jobTrackers.thumbsBuild.getStatus();
    res.json({ ...snap, ...(snap.progress || {}) });
});

app.get('/api/maintenance/thumbs/build/stats', async (req, res) => {
    try {
        const lastRun = kvGet('thumbs_last_build') || null;
        res.json({ lastRun });
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
});

// Paginated thumbnail preview for the Build thumbnails page. Cursor-based
// (id DESC) so the operator's scrolling feels stable — new downloads land
// at the top, scrolling pulls older rows. Capped at 200 per page so the
// frontend's virtual window can drain a request in one paint.
//
// Kinds:
//   image  — file_type IN ('photo','image')
//   video  — file_type = 'video'
//   all    — both
//
// Big-data note: id is the PK index; the `WHERE id < ?` clause is a sargable
// range scan, no LIMIT/OFFSET on a 1M-row library.
app.get('/api/maintenance/thumbs/list', async (req, res) => {
    try {
        const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 60));
        const rawCursor = parseInt(req.query.cursor, 10);
        const cursor = Number.isFinite(rawCursor) && rawCursor > 0 ? rawCursor : null;
        const kindRaw = String(req.query.kind || 'all').toLowerCase();
        const types = thumbKindTypes(kindRaw) || thumbKindTypes('all');
        const placeholders = types.map(() => '?').join(',');
        const args = [...types];
        // `file_path IS NOT NULL` matches what `buildAllThumbnails` walks —
        // hides rows whose files were deleted but whose DB entries linger,
        // so the gallery doesn't paint tiles that will only ever 404.
        let where = `file_type IN (${placeholders}) AND file_path IS NOT NULL`;
        if (cursor !== null) {
            where += ' AND id < ?';
            args.push(cursor);
        }
        const db = getDb();
        const rows = db
            .prepare(
                // file_path is needed so the gallery's lightbox click can
                // build /files/<path>?inline=1 — without it the click
                // would have to round-trip to /api/downloads/:id just to
                // resolve the path, doubling the request rate of a fast
                // operator clicking through tiles.
                `SELECT id, file_name, file_type, file_size, file_path, created_at
                 FROM downloads
                 WHERE ${where}
                 ORDER BY id DESC
                 LIMIT ?`,
            )
            .all(...args, limit);
        // Decorate with `cached:true|false` — the gallery uses this to
        // surface "12 not built yet" without round-tripping per tile.
        const cachedOnly = req.query.cachedOnly === '1';
        const decorated = rows.map((r) => ({ ...r, cached: hasCachedThumb(r.id) }));
        const out = cachedOnly ? decorated.filter((r) => r.cached) : decorated;
        const nextCursor = rows.length === limit ? rows[rows.length - 1].id : null;
        // COUNT(*) is the expensive part on a 1M-row library (index scan,
        // not stat cache because of the WHERE). Send it only on the first
        // page; subsequent pages re-use the value the client already has.
        let total = null;
        if (cursor === null) {
            total =
                db
                    .prepare(
                        `SELECT COUNT(*) AS c FROM downloads
                     WHERE file_type IN (${placeholders}) AND file_path IS NOT NULL`,
                    )
                    .get(...types).c || 0;
        }
        res.json({ rows: out, nextCursor, hasMore: nextCursor !== null, total });
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
});

// Probe which ffmpeg hardware-acceleration backends actually work on
// this host. Runs `ffmpeg -hide_banner -hwaccels` and returns the parsed
// list. Used by Settings → Advanced → Video thumb hardware acceleration
// → "Detect available" so the admin doesn't have to SSH in to find out
// whether VAAPI/QSV/CUDA/etc. are available on the host's ffmpeg build.
app.get('/api/maintenance/thumbs/hwaccel-probe', async (req, res) => {
    try {
        const thumbs = await import('../core/thumbs.js');
        const { compiledIn, available, ffmpegPath } = await thumbs.probeHwaccel();
        // The dropdown only exposes options we have UI rows for; pick the
        // first verified backend in that subset so "Recommended" matches
        // something the user can actually select. Falls back to null when
        // nothing on this host passed the device-init test.
        const recommended =
            available.find((b) =>
                ['vaapi', 'qsv', 'cuda', 'videotoolbox', 'd3d11va'].includes(b),
            ) || null;
        res.json({ available, compiledIn, ffmpegPath, recommended });
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

// ====== Seekbar hover-preview sprites ====================================
//
// Sidecar-backed sprite-sheet generator (see seekbar-service/). All
// long-running operations follow the JobTracker pattern so the
// maintenance page can recover live state across reloads.

app.post('/api/maintenance/seekbar/build-all', async (req, res) => {
    const tracker = _jobTrackers.seekbarBuild;
    const r = tracker.tryStart(async ({ onProgress, signal }) => {
        try {
            kvSet('pending_job_seekbarBuild', { startedAt: Date.now() });
        } catch {}
        const result = await buildAllSeekbar({ onProgress, signal });
        try {
            kvSet('pending_job_seekbarBuild', null);
        } catch {}
        try {
            kvSet('seekbar_last_build', { finishedAt: Date.now(), ...result });
        } catch {}
        return result;
    });
    if (!r.started) return res.status(409).json(r);
    res.json({ started: true });
});

app.post('/api/maintenance/seekbar/build/cancel', async (req, res) => {
    _jobTrackers.seekbarBuild.cancel();
    res.json({ success: true });
});

app.get('/api/maintenance/seekbar/build/status', async (req, res) => {
    res.json(_jobTrackers.seekbarBuild.getStatus());
});

app.get('/api/maintenance/seekbar/build/stats', async (req, res) => {
    res.json({ lastBuild: kvGet('seekbar_last_build') || null });
});

app.post('/api/maintenance/seekbar/rebuild', async (req, res) => {
    const wipeOnly = req.body?.wipeOnly === true;
    const tracker = _jobTrackers.seekbarRebuild;
    const r = tracker.tryStart(async ({ onProgress, signal }) => {
        const wiped = await purgeAllSeekbar();
        onProgress({ phase: 'wiped', wiped });
        if (wipeOnly) return { wiped, regenerated: 0 };
        if (signal?.aborted) return { wiped, regenerated: 0 };
        const result = await buildAllSeekbar({ onProgress, signal });
        try {
            kvSet('seekbar_last_build', { finishedAt: Date.now(), ...result, wiped });
        } catch {}
        return { wiped, ...result };
    });
    if (!r.started) return res.status(409).json(r);
    res.json({ started: true });
});

app.get('/api/maintenance/seekbar/rebuild/status', async (req, res) => {
    res.json(_jobTrackers.seekbarRebuild.getStatus());
});

app.post('/api/maintenance/seekbar/regen/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: 'invalid id' });
        }
        const db = (await import('../core/db.js')).getDb();
        const row = db
            .prepare('SELECT id, file_path, file_type FROM downloads WHERE id = ?')
            .get(id);
        if (!row) return res.status(404).json({ error: 'not_found' });
        if (row.file_type !== 'video') {
            return res.status(400).json({ error: 'not a video' });
        }
        const r = await generateSeekbarForDownload(row, null, { overwrite: 'always' });
        res.json({ success: true, ...r });
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
});

app.get('/api/maintenance/seekbar/stats', async (req, res) => {
    try {
        const stats = getSeekbarCacheStats();
        const sidecar = getSeekbarSidecarStatus();
        const totalVideos = countVideoDownloads();
        res.json({ success: true, sidecar, ffmpegAvailable: hasFfmpeg(), totalVideos, ...stats });
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
});

app.get('/api/maintenance/seekbar/queue/stats', (req, res) => {
    try {
        const tracker = _jobTrackers.seekbarBuild;
        const status = tracker.getStatus();
        const p = status.progress || {};
        const depths = getSeekbarQueueDepths();
        const running = status.running || false;
        // When a scan is active: show live session counts.
        // When idle: completed = total sprites in DB so the card is meaningful
        // even when no scan has run in the current process lifetime.
        const completed = running ? p.generated || 0 : countSeekbarSprites();
        const scanRemaining = running ? Math.max(0, (p.total || 0) - (p.processed || 0)) : 0;
        res.json({
            success: true,
            queued: depths.queued + scanRemaining,
            processing: depths.processing,
            completed,
            failed: p.errored || 0,
            running,
        });
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
});

app.get('/api/maintenance/seekbar/list', async (req, res) => {
    try {
        const db = (await import('../core/db.js')).getDb();
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const rows = db
            .prepare(
                `SELECT s.download_id AS id, s.bytes, s.frames, s.cols, s.rows, s.duration_sec,
                        s.format, s.generated_at, d.file_name
                   FROM seekbar_sprites s
                   JOIN downloads d ON d.id = s.download_id
                  ORDER BY s.generated_at DESC
                  LIMIT ? OFFSET ?`,
            )
            .all(limit, offset);
        const total = db.prepare('SELECT COUNT(*) AS n FROM seekbar_sprites').get().n;
        res.json({ rows, total, limit, offset, hasMore: offset + rows.length < total });
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
});

app.get('/api/maintenance/seekbar/health', async (req, res) => {
    // Aggregate diagnostic surface — the maintenance page's System
    // health card reads this. Keeps the client to one round-trip on
    // mount and one snapshot every WS state change.
    try {
        const sidecar = getSeekbarSidecarStatus();
        let hwaccel = null;
        let richHealth = null;
        if (sidecar?.ok) {
            // Pull the rich health payload directly from the sidecar so the
            // UI can display version, platform, hwaccel_resolved, gpu_provider,
            // and stats without a second round-trip. Older sidecars may not
            // ship these fields — callers must handle null.
            try {
                const h = await seekbarClientHealth();
                if (h && h.ok) {
                    richHealth = {
                        ok: true,
                        version: h.version ?? null,
                        platform: h.platform ?? null,
                        hwaccel_resolved: h.hwaccel_resolved ?? null,
                        gpu_provider: h.gpu_provider ?? null,
                        stats: h.stats ?? null,
                    };
                }
            } catch {
                /* sidecar health probe is best-effort */
            }
            try {
                hwaccel = await probeSeekbarHwaccel();
            } catch (e) {
                hwaccel = { error: String(e?.message || e).slice(0, 200) };
            }
        }
        res.json({
            success: true,
            sidecar,
            richHealth,
            hwaccel,
            ffmpegAvailable: hasFfmpeg(),
            version: SEEKBAR_SIDECAR_VERSION,
            platform: `${process.platform}/${process.arch}`,
            node: process.version,
        });
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
});

app.get('/api/maintenance/seekbar/hwaccel-probe', async (req, res) => {
    try {
        if (!getSeekbarSidecarStatus()?.ok) {
            return res.json({
                available: [],
                compiled: [],
                ffmpeg_path: '',
                error: 'sidecar not running',
            });
        }
        const r = await probeSeekbarHwaccel();
        res.json(r);
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
});

app.post('/api/maintenance/seekbar/sidecar/restart', async (req, res) => {
    try {
        await refreshSeekbarSidecar();
        res.json({ success: true, sidecar: getSeekbarSidecarStatus() });
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
});

// Public sprite + meta — admin and guest both can fetch (sprites are
// derived assets that already gate behind the share-link / library ACL
// on the row itself).
app.get('/api/seekbar/sprite/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(404).end();
        const row = getSeekbarSprite(id);
        if (!row?.sprite_path) {
            res.set('Cache-Control', 'no-store');
            return res.status(404).end();
        }
        const spritePath = getSeekbarSpritePath(id, row.format || 'webp');
        const finalPath = (await import('fs')).existsSync(row.sprite_path)
            ? row.sprite_path
            : spritePath;
        const etag = `"sk-${id}-${row.generated_at || 0}"`;
        if (req.headers['if-none-match'] === etag) {
            res.set('ETag', etag);
            return res.status(304).end();
        }
        res.set('ETag', etag);
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
        res.set('Content-Type', row.format === 'jpeg' ? 'image/jpeg' : 'image/webp');
        res.sendFile(finalPath);
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
});

app.get('/api/seekbar/meta/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(404).end();
        const meta = await getSeekbarMetaForDownload(id);
        if (!meta) {
            res.set('Cache-Control', 'no-store');
            return res.status(404).end();
        }
        res.set('Cache-Control', 'public, max-age=300');
        res.json(meta);
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
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
// Migrated from a hand-rolled `_faststartRunning` flag with the same
// broadcast-before-flag-reset race as thumbs/build-all. JobTracker
// closes the window. Prefix 'faststart' preserved.
app.post('/api/maintenance/faststart/scan', async (req, res) => {
    const tracker = _jobTrackers.faststart;
    const r = tracker.tryStart(async ({ onProgress, signal }) => {
        const { optimizeAll } = await import('../core/faststart.js');
        const result = await optimizeAll({
            onProgress: (p) => onProgress(p),
            signal,
        });
        try {
            kvSet('faststart_last_run', {
                finishedAt: Date.now(),
                optimized: result?.optimized ?? 0,
                already: result?.already ?? 0,
                skipped: result?.skipped ?? 0,
                errored: result?.errored ?? 0,
                scanned: result?.scanned ?? 0,
            });
        } catch {}
        return result;
    });
    if (!r.started) {
        return res.status(409).json({
            error: 'A faststart sweep is already running',
            code: r.code || 'ALREADY_RUNNING',
        });
    }
    res.json({ success: true, started: true });
});

app.get('/api/maintenance/faststart/status', async (req, res) => {
    const snap = _jobTrackers.faststart.getStatus();
    res.json({ ...snap, ...(snap.progress || {}) });
});

app.get('/api/maintenance/faststart/stats', async (req, res) => {
    try {
        const { getStats } = await import('../core/faststart.js');
        const r = await getStats();
        // Merge in the persisted last-run summary alongside the live
        // library stats. The video page already reads {optimized,
        // pending, ...} from this endpoint; lastRun is additive.
        let lastRun = null;
        try {
            lastRun = kvGet('faststart_last_run') || null;
        } catch {}
        res.json({ success: true, ffmpegAvailable: hasFfmpeg(), ...r, lastRun });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Counters maintained by the post-download auto-optimise hook (see
// `optimizeDownloadInBackground` in `src/core/faststart.js`). Read-only
// snapshot of `kv['faststart_stats']` — the maintenance UI uses this to
// surface "auto-optimised since boot: N optimised / M total" without
// polling the heavier `/stats` endpoint that walks every video row.
app.get('/api/maintenance/faststart/auto-stats', async (req, res) => {
    try {
        const { getAutoStats } = await import('../core/faststart.js');
        res.json({ success: true, ...getAutoStats() });
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
            preload: cfg.preload === true,
            blocklistEnabled: cfg.blocklistEnabled === true,
            model: cfg.model || NSFW_DEFAULTS.model,
            threshold: Number.isFinite(cfg.threshold) ? cfg.threshold : NSFW_DEFAULTS.threshold,
            concurrency: Number.isFinite(cfg.concurrency)
                ? cfg.concurrency
                : NSFW_DEFAULTS.concurrency,
            batchSize: Number.isFinite(cfg.batchSize) ? cfg.batchSize : NSFW_DEFAULTS.batchSize,
            videoMaxTiles: Number.isFinite(cfg.videoMaxTiles)
                ? cfg.videoMaxTiles
                : NSFW_DEFAULTS.videoMaxTiles,
            fileTypes:
                Array.isArray(cfg.fileTypes) && cfg.fileTypes.length
                    ? cfg.fileTypes
                    : NSFW_DEFAULTS.fileTypes,
            cacheDir: cfg.cacheDir || NSFW_DEFAULTS.cacheDir,
        };
    } catch {
        return { ...NSFW_DEFAULTS, enabled: false, blocklistEnabled: false };
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
        try {
            kvSet('pending_job_nsfwScan', { startedAt: Date.now() });
        } catch {}
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
                    kvSet('pending_job_nsfwScan', null);
                } catch {}
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

// Server-side health probe for an arbitrary NSFW sidecar URL (CORS proxy).
app.post('/api/maintenance/nsfw/sidecar-test', async (req, res) => {
    const url = typeof req.body?.url === 'string' ? req.body.url.trim().replace(/\/+$/, '') : '';
    if (!url) return res.status(400).json({ ok: false, error: 'url_required' });
    if (!/^https?:\/\//i.test(url))
        return res.status(400).json({ ok: false, error: 'invalid_scheme' });
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        let r;
        try {
            r = await fetch(`${url}/health`, { method: 'GET', signal: ctrl.signal });
        } finally {
            clearTimeout(timer);
        }
        if (!r.ok) return res.json({ ok: false, error: `http_${r.status}` });
        const body = await r.json();
        res.json({
            ok: body?.ok === true,
            version: body?.version ?? null,
            model: body?.model ?? null,
            ready: body?.ready === true,
        });
    } catch (e) {
        const msg = e?.name === 'AbortError' ? 'timeout' : e?.message || String(e);
        res.json({ ok: false, error: msg });
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
        // Collect hashes before deleting rows so the blocklist can be updated.
        if (_nsfwCfg().blocklistEnabled) {
            try {
                const hashRows = getDownloadHashesForIds(cleanIds);
                if (hashRows.length) {
                    addNsfwBlocklistBatch(
                        hashRows.map((r) => ({
                            fileHash: r.file_hash,
                            fileName: r.file_name,
                            source: 'manual',
                        })),
                    );
                }
            } catch {}
        }
        const seekbarMap = collectSeekbarPaths(cleanIds);
        const r = dedupDeleteByIds(cleanIds);
        for (const id of cleanIds) {
            try {
                await purgeThumbsForDownload(id);
            } catch {}
            try {
                await purgeSeekbarForDownload(id, seekbarMap.get(id));
            } catch {}
        }
        try {
            purgeOrphanPeople();
        } catch {}
        import('../core/deferred-delete.js').then((m) => m.startDrain()).catch(() => {});
        try {
            broadcast({ type: 'bulk_delete', count: cleanIds.length });
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
            fileKind: req.query.kind || null,
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
        // Collect hashes before deleting rows so the blocklist is updated.
        if (_nsfwCfg().blocklistEnabled) {
            try {
                const hashRows = getDownloadHashesForIds(ids);
                if (hashRows.length) {
                    addNsfwBlocklistBatch(
                        hashRows.map((r) => ({
                            fileHash: r.file_hash,
                            fileName: r.file_name,
                            source: 'bulk',
                        })),
                    );
                }
            } catch {}
        }
        log({ source: 'nsfw', level: 'warn', msg: `bulk-delete starting: ${ids.length} rows` });
        const total = ids.length;
        const BATCH = 50;
        const aggregate = { removed: 0, freedBytes: 0, missingFiles: 0 };
        let processed = 0;
        onProgress({ stage: 'deleting', op: 'delete', processed: 0, total });
        for (let off = 0; off < ids.length; off += BATCH) {
            const slice = ids.slice(off, off + BATCH);
            const seekbarMap = collectSeekbarPaths(slice);
            const part = dedupDeleteByIds(slice);
            aggregate.removed += part.removed || 0;
            aggregate.freedBytes += part.freedBytes || 0;
            aggregate.missingFiles += part.missingFiles || 0;
            for (const id of slice) {
                try {
                    await purgeThumbsForDownload(id);
                } catch {}
                try {
                    await purgeSeekbarForDownload(id, seekbarMap.get(id));
                } catch {}
            }
            processed += slice.length;
            onProgress({ stage: 'deleting', op: 'delete', processed, total });
            await new Promise((r) => setImmediate(r));
        }
        try {
            purgeOrphanPeople();
        } catch {}
        try {
            broadcast({ type: 'bulk_delete', count: ids.length });
        } catch {}
        try {
            broadcast({ type: 'nsfw_progress', ..._nsfwStateLight() });
        } catch {}
        log({
            source: 'nsfw',
            level: 'info',
            msg: `bulk-delete done: removed=${aggregate.removed} of ${ids.length}`,
        });
        return { op: 'delete', deleted: aggregate.removed, requested: ids.length, ...aggregate };
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
        const total = ids.length;
        const BATCH = 500;
        let updated = 0;
        let processed = 0;
        onProgress({ stage: 'updating', op: 'whitelist', processed: 0, total });
        for (let off = 0; off < ids.length; off += BATCH) {
            const slice = ids.slice(off, off + BATCH);
            updated += whitelistNsfw(slice);
            processed += slice.length;
            onProgress({ stage: 'updating', op: 'whitelist', processed, total });
            await new Promise((r) => setImmediate(r));
        }
        try {
            broadcast({ type: 'nsfw_progress', ..._nsfwStateLight() });
        } catch {}
        log({
            source: 'nsfw',
            level: 'info',
            msg: `bulk-whitelist: marked ${updated} rows as 18+`,
        });
        return { op: 'whitelist', updated, requested: ids.length };
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
        const total = ids.length;
        const BATCH = 500;
        let updated = 0;
        let processed = 0;
        onProgress({ stage: 'updating', op: 'unwhitelist', processed: 0, total });
        for (let off = 0; off < ids.length; off += BATCH) {
            const slice = ids.slice(off, off + BATCH);
            updated += unwhitelistNsfw(slice);
            processed += slice.length;
            onProgress({ stage: 'updating', op: 'unwhitelist', processed, total });
            await new Promise((r) => setImmediate(r));
        }
        try {
            broadcast({ type: 'nsfw_progress', ..._nsfwStateLight() });
        } catch {}
        log({
            source: 'nsfw',
            level: 'info',
            msg: `unwhitelist: ${updated} rows back into review`,
        });
        return { op: 'unwhitelist', updated, requested: ids.length };
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
        const total = ids.length;
        const BATCH = 500;
        let cleared = 0;
        let processed = 0;
        onProgress({ stage: 'clearing', op: 'reclassify', processed: 0, total });
        for (let off = 0; off < ids.length; off += BATCH) {
            const slice = ids.slice(off, off + BATCH);
            cleared += reclassifyNsfw(slice);
            processed += slice.length;
            onProgress({ stage: 'clearing', op: 'reclassify', processed, total });
            await new Promise((r) => setImmediate(r));
        }
        log({
            source: 'nsfw',
            level: 'info',
            msg: `reclassify: cleared ${cleared} rows for re-scan`,
        });
        return { op: 'reclassify', cleared, requested: ids.length };
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

// ── NSFW hash blocklist management ──────────────────────────────────────────

app.get('/api/maintenance/nsfw/blocklist/stats', (req, res) => {
    try {
        res.json({ count: getNsfwBlocklistCount() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/maintenance/nsfw/blocklist', (req, res) => {
    if (!_requireConfirm(req, res)) return;
    try {
        const removed = clearNsfwBlocklist();
        res.json({ success: true, removed });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ====== AI subsystem (semantic search + auto-tag + face clustering) =========
//
// Three independent scans share one page (Maintenance → AI). Each is
// admin-only by virtue of the global mutation gate, opt-in via
// `config.advanced.ai.{enabled,semanticSearch,autoTags,faceClustering}`.
// Patterns mirror the NSFW route group:
//   - status returns the kv flags + scan states + counts in one round trip
//   - scan/start uses the same JobTracker `tryStart` contract
//   - search endpoints are reads against `image_embeddings` (in-memory cosine)
//   - tags + people endpoints are list/paginate against the persisted rows
//
// Bug-class avoidance:
//   - Every read goes through paginated DB helpers (LIMIT/OFFSET) so
//     CLAUDE.md → Big-data rule 1 stays honoured.
//   - All 503s carry `code` so the client can render targeted help.
function _aiCfg() {
    try {
        const live = loadConfig();
        return live?.advanced?.ai || {};
    } catch {
        return {};
    }
}

// ---- AI status -----------------------------------------------------------
//
// Faces-only build — the prior `/api/ai/status` payload exposed embed +
// tag pipeline state, vec extension probe, model preset metadata, etc.
// All of that's gone with the Search/Tags removal; this is the minimum
// the AI maintenance page actually reads now.

// 5 s in-memory cache for the live `/info` probe. The dashboard polls
// /api/ai/status every few seconds; without the cache we'd hit the
// sidecar each time + spike when many tabs are open.
const _SIDECAR_INFO_CACHE = { url: null, ts: 0, data: null };
const _SIDECAR_INFO_TTL_MS = 5000;
async function _fetchSidecarInfo(url) {
    const now = Date.now();
    if (
        _SIDECAR_INFO_CACHE.url === url &&
        now - _SIDECAR_INFO_CACHE.ts < _SIDECAR_INFO_TTL_MS &&
        _SIDECAR_INFO_CACHE.data
    ) {
        return _SIDECAR_INFO_CACHE.data;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
        const res = await fetch(`${url.replace(/\/+$/, '')}/info`, {
            signal: controller.signal,
        });
        if (!res.ok) return null;
        const data = await res.json();
        _SIDECAR_INFO_CACHE.url = url;
        _SIDECAR_INFO_CACHE.ts = now;
        _SIDECAR_INFO_CACHE.data = data;
        return data;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

app.get('/api/ai/status', async (_req, res) => {
    try {
        const cfg = _aiCfg();
        const facesBlock = cfg.faces && typeof cfg.faces === 'object' ? cfg.faces : {};
        const counts = (() => {
            try {
                const baseTypes = cfg.fileTypes || ['photo'];
                const fileTypes =
                    facesBlock.scanVideos === true && !baseTypes.includes('video')
                        ? [...baseTypes, 'video']
                        : baseTypes;
                return getAiCounts({ fileTypes });
            } catch {
                return { totalEligible: 0, indexed: 0, withFaces: 0 };
            }
        })();
        res.json({
            success: true,
            config: {
                enabled: cfg.enabled === true,
                faceClustering: cfg.faceClustering !== false,
                federateFaces: cfg.federateFaces === true,
                fileTypes: cfg.fileTypes || ['photo'],
                facesEpsilon: Number.isFinite(cfg.facesEpsilon) ? cfg.facesEpsilon : 1.05,
                facesMinPoints: Number.isFinite(cfg.facesMinPoints) ? cfg.facesMinPoints : 2,
                facesDetector: cfg.facesDetector || 'tiny',
                facesDetectorModel: String(
                    facesBlock.detectorModel || cfg.facesDetectorModel || 'buffalo_l',
                ),
                faces: {
                    providers: String(facesBlock.providers || 'auto').toLowerCase(),
                    detectorModel: String(
                        facesBlock.detectorModel || cfg.facesDetectorModel || 'buffalo_l',
                    ),
                    scanVideos: facesBlock.scanVideos === true,
                    sidecarUrl:
                        typeof facesBlock.sidecarUrl === 'string' ? facesBlock.sidecarUrl : '',
                },
            },
            counts,
            scans: { faces: aiGetScanState('faces') },
            models: {
                faces: await (async () => {
                    // Surface the operator-chosen insightface preset
                    // (buffalo_l / antelopev2 / buffalo_m / buffalo_s /
                    // buffalo_sc) in the human-readable id. The legacy
                    // `cfg.facesModel` free-text override still wins
                    // when set (advanced operator path); otherwise use
                    // the dropdown-saved `facesDetectorModel`.
                    const preset = String(
                        facesBlock.detectorModel || cfg.facesDetectorModel || 'buffalo_l',
                    );
                    const id =
                        (cfg.facesModel || '').trim() || `insightface ${preset} (Python sidecar)`;
                    // Live provider list — probe the running sidecar's
                    // `/info` so the dashboard's "GPU acceleration"
                    // chip reflects the actually-loaded EP, not the
                    // saved hint. The probe is best-effort: a 2 s
                    // timeout caps the worst case so a dead sidecar
                    // doesn't slow the status page down. Result is
                    // cached for 5 s so the page can poll without
                    // hammering the sidecar.
                    let providers = null;
                    let sidecarVersion = null;
                    try {
                        const facesSpawn = await import('../core/ai/faces-spawn.js');
                        sidecarVersion = facesSpawn.SIDECAR_VERSION;
                        const sidecarUrl = facesSpawn.getSidecarStatus()?.url;
                        if (sidecarUrl) {
                            const info = await _fetchSidecarInfo(sidecarUrl);
                            if (info?.providers) providers = info.providers;
                            if (info?.version) sidecarVersion = info.version;
                        }
                    } catch {
                        /* sidecar offline / fetch failed — fall through */
                    }
                    let sidecarMode = null;
                    try {
                        const facesSpawnStatus = (
                            await import('../core/ai/faces-spawn.js')
                        ).getSidecarStatus();
                        sidecarMode = facesSpawnStatus?.mode || null;
                    } catch {}
                    return {
                        id,
                        preset,
                        dim: 512,
                        dtype: 'fp32',
                        source: cfg.facesModel ? 'override' : 'bundled',
                        enabled: cfg.faceClustering !== false,
                        loaded: !cfg.facesModel,
                        bundled: !cfg.facesModel,
                        providers,
                        providersRequested: String(facesBlock.providers || 'auto'),
                        version: sidecarVersion,
                        mode: sidecarMode,
                    };
                })(),
            },
            bgQueue: (() => {
                try {
                    return aiBgQueueDepths();
                } catch {
                    return { realtime: 0, backfill: 0 };
                }
            })(),
            qualityBackfillPending: (() => {
                try {
                    return aiGetDb()
                        .prepare('SELECT COUNT(*) AS n FROM faces WHERE quality_score IS NULL')
                        .get().n;
                } catch {
                    return 0;
                }
            })(),
            trackers: {
                aiPeople: _jobTrackers.aiPeople.getStatus(),
                qualityBackfill: _jobTrackers.qualityBackfill.getStatus(),
            },
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ---- Scan controls -------------------------------------------------------
//
// Faces is the only feature left; the legacy `feature: 'embed' | 'tags'`
// branches have been removed. The handler still accepts a `feature`
// field so older clients fail with a clear `unknown feature` error
// rather than a silent no-op.
const AI_SCAN_FEATURES = new Set(['faces']);

function _aiTrackerFor(feature) {
    if (feature === 'faces') return _jobTrackers.aiPeople;
    return null;
}

function _aiStarterFor(feature) {
    if (feature === 'faces') return aiStartFacesScan;
    return null;
}

// JobTracker integration for AI scans:
//   The scan-runner module already owns the per-feature state machine
//   (running/scanned/total/abort) and broadcasts its own WS events; the
//   tracker is wired in via a one-shot tryStart so re-mounted pages can
//   recover via `_jobTrackers.aiX.getStatus()` and so the "ai_index_done"
//   WS event still fires through the tracker's standard finish hook. The
//   inner runFn returns a Promise that resolves on the scan-runner's
//   onDone callback so tracker.success/failure semantics line up with
//   the actual work.
function _aiTrackerEventPrefix(feature) {
    if (feature === 'embed') return 'ai_index';
    if (feature === 'tags') return 'ai_tags';
    if (feature === 'faces') return 'ai_people';
    return 'ai';
}

app.post('/api/ai/scan/start', async (req, res) => {
    try {
        const cfg = _aiCfg();
        if (cfg.enabled !== true) {
            return res.status(503).json({
                error: 'AI subsystem disabled — enable it in Maintenance → AI first.',
                code: 'AI_DISABLED',
            });
        }
        const feature = String(req.body?.feature || '').toLowerCase();
        if (!AI_SCAN_FEATURES.has(feature)) {
            return res.status(400).json({ error: 'feature must be embed|tags|faces' });
        }
        if (aiIsScanRunning(feature)) {
            return res.status(409).json({ error: 'Scan already running', code: 'ALREADY_RUNNING' });
        }
        const tracker = _aiTrackerFor(feature);
        const starter = _aiStarterFor(feature);
        const claim = tracker.tryStart(({ onProgress, signal }) => {
            try {
                kvSet(`pending_job_ai_${feature}`, { startedAt: Date.now() });
            } catch {}
            return new Promise((resolve, reject) => {
                if (signal && typeof signal.addEventListener === 'function') {
                    signal.addEventListener('abort', () => {
                        try {
                            aiCancelScan(feature);
                        } catch {}
                    });
                }
                starter(
                    cfg,
                    (p) => {
                        try {
                            onProgress(p);
                        } catch {}
                    },
                    (p) => {
                        try {
                            kvSet(`pending_job_ai_${feature}`, null);
                        } catch {}
                        if (p?.error) reject(new Error(p.error));
                        else resolve(p || {});
                    },
                    (entry) => log(entry),
                );
            });
        });
        if (!claim.started) {
            return res.status(409).json({ error: 'Tracker busy', code: claim.code });
        }
        log({ source: 'ai', level: 'info', msg: `${feature} scan starting` });
        res.json({ success: true, started: true });
    } catch (e) {
        log({ source: 'ai', level: 'error', msg: `scan/start failed: ${e?.message || e}` });
        const status = e.code === 'AI_LIB_MISSING' || e.code === 'FACES_LIB_MISSING' ? 503 : 500;
        res.status(status).json({ error: e.message, code: e.code || 'UNKNOWN' });
    }
});

app.post('/api/ai/scan/cancel', async (req, res) => {
    const feature = String(req.body?.feature || '').toLowerCase();
    if (!AI_SCAN_FEATURES.has(feature)) {
        return res.status(400).json({ error: 'feature must be embed|tags|faces' });
    }
    const ok = aiCancelScan(feature);
    res.json({ success: true, cancelled: ok });
});

app.get('/api/ai/scan/status', async (req, res) => {
    const feature = String(req.query?.feature || '').toLowerCase();
    if (!AI_SCAN_FEATURES.has(feature)) {
        return res.status(400).json({ error: 'feature must be embed|tags|faces' });
    }
    res.json({ success: true, state: aiGetScanState(feature) });
});

// ---- Provider probe (face sidecar onnxruntime backends) -----------------
//
// Mirrors the ffmpeg `hwaccel-probe` endpoint pattern used by the Build
// thumbnails page. Proxies to the Python sidecar's `/providers` route
// Server-side health probe for an arbitrary faces sidecar URL.
// The browser can't hit a Cloudflare-tunnelled endpoint directly (CORS),
// so we proxy the health check. Accepts { url } in the POST body.
app.post('/api/ai/faces/health-test', async (req, res) => {
    const url = typeof req.body?.url === 'string' ? req.body.url.trim().replace(/\/+$/, '') : '';
    if (!url) return res.status(400).json({ ok: false, error: 'url_required' });
    if (!/^https?:\/\//i.test(url))
        return res.status(400).json({ ok: false, error: 'invalid_scheme' });
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        let r;
        try {
            r = await fetch(`${url}/health`, { method: 'GET', signal: ctrl.signal });
        } finally {
            clearTimeout(timer);
        }
        if (!r.ok) return res.json({ ok: false, error: `http_${r.status}` });
        const body = await r.json();
        res.json({
            ok: body?.ok === true,
            version: body?.version ?? null,
            model: body?.model ?? null,
            ready: body?.ready === true,
            providers: body?.providers_resolved ?? null,
        });
    } catch (e) {
        const msg = e?.name === 'AbortError' ? 'timeout' : e?.message || String(e);
        res.json({ ok: false, error: msg });
    }
});

// which spins up a tiny onnxruntime session against each candidate
// provider — only backends that genuinely allocate a session end up in
// `available`. Surfaces a clear 503 when the sidecar isn't running.
app.get('/api/ai/faces/provider-probe', async (_req, res) => {
    try {
        const facesClient = await import('../core/ai/faces-client.js');
        const url = facesClient.getSidecarUrl();
        if (!url) {
            return res
                .status(503)
                .json({ error: 'Face sidecar not running', code: 'SIDECAR_OFFLINE' });
        }
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 10_000);
        let r;
        try {
            r = await globalThis.fetch(`${url}/providers`, { signal: ctrl.signal });
        } finally {
            clearTimeout(t);
        }
        if (!r.ok) {
            return res
                .status(r.status)
                .json({ error: `Sidecar returned HTTP ${r.status}`, code: 'SIDECAR_ERROR' });
        }
        const body = await r.json();
        res.json(body);
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
});

// Restart the sidecar so a config change (e.g. provider switch) takes
// effect without an app restart. The spawn module's stopSidecar() sends
// SIGTERM with a SIGKILL fallback after KILL_GRACE_MS; startSidecar()
// then re-reads `loadConfig()` + env so the new provider is picked up.
app.post('/api/ai/faces/restart', async (_req, res) => {
    try {
        const spawn = await import('../core/ai/faces-spawn.js');
        spawn.stopSidecar();
        // Fire-and-forget — startSidecar() is idempotent and never
        // throws (errors surface via `getSidecarStatus()` + WS).
        spawn.startSidecar().catch(() => {});
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
});

// Auto-detect-platform installer for the Python sidecar. Runs
// `python -m tgdl_faces.install`, which picks the right onnxruntime EP
// (DirectML on Windows, CUDA on Linux+NVIDIA, OpenVINO on Linux+Intel,
// CoreML/CPU elsewhere) and pip-installs it. Progress streams over WS
// as `ai_faces_install_progress` / `ai_faces_install_done`. Body accepts
// optional `{force: 'cpu'|'gpu'|'directml'|'openvino'}` for operators
// who want to override detection. Single-flight inside faces-spawn.
app.post('/api/ai/faces/install-deps', async (req, res) => {
    try {
        const spawnMod = await import('../core/ai/faces-spawn.js');
        const force = typeof req.body?.force === 'string' ? req.body.force : undefined;
        spawnMod.resetAutoInstallGuard();
        // Fire-and-forget — pip can take 1-5 min on first run while
        // downloading onnxruntime wheels. Progress flows over WS.
        spawnMod
            .installPythonDeps({ force })
            .then((r) => {
                if (r.ok) {
                    try {
                        spawnMod.stopSidecar();
                    } catch {}
                    try {
                        spawnMod.startSidecar().catch(() => {});
                    } catch {}
                }
            })
            .catch(() => {});
        res.json({ started: true });
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
});

// Full reindex — clears every face detection + every cluster, then
// flips every photo's `ai_indexed_at` back to NULL so the next scan
// re-detects from scratch. Use when:
//   - switching `facesDetectorModel` (embedding space changes)
//   - a previous run produced obviously-wrong clusters (bad threshold)
//   - the operator wants a clean slate
//
// This is DESTRUCTIVE — the People grid wipes immediately and the
// next scan re-builds it. Caller MUST gate this behind a confirm
// sheet UI-side. The Node side enforces a single-flight guard against
// any scan that's currently running.
// Phase B only — re-cluster existing face embeddings without
// re-detecting. Lets the operator tweak ε / minPoints and see the new
// People grid in seconds (vs minutes for a full re-scan). Implemented
// by triggering the standard faces scan-runner; Phase A is a no-op when
// every photo carries `ai_indexed_at IS NOT NULL`, so for fully-indexed
// libraries this lands in Phase B immediately. For partially-indexed
// libraries (a scan was cancelled mid-way), Phase A picks up where it
// left off — same as clicking "Scan now".
app.post('/api/ai/faces/recluster', async (_req, res) => {
    try {
        const cfg = _aiCfg();
        if (aiIsScanRunning('faces')) {
            return res.status(409).json({
                error: 'scan_running',
                message: 'A face scan is already in progress.',
            });
        }
        const tracker = _aiTrackerFor('faces');
        const claim = tracker.tryStart(({ onProgress, signal }) => {
            return new Promise((resolve, reject) => {
                if (signal?.addEventListener) {
                    signal.addEventListener('abort', () => {
                        try {
                            aiCancelScan('faces');
                        } catch {}
                    });
                }
                aiStartFacesScan(
                    cfg,
                    (p) => {
                        try {
                            onProgress(p);
                        } catch {}
                    },
                    (p) => {
                        if (p?.error) reject(new Error(p.error));
                        else resolve(p || {});
                    },
                    (entry) => log(entry),
                );
            });
        });
        if (!claim.started) {
            return res.status(409).json({ error: 'Tracker busy', code: claim.code });
        }
        res.json({ success: true, started: true });
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
});

app.post('/api/ai/faces/reindex', async (_req, res) => {
    try {
        if (aiIsScanRunning && aiIsScanRunning('faces')) {
            return res.status(409).json({
                error: 'scan_running',
                message: 'A face scan is already in progress. Cancel it before reindexing.',
            });
        }
        const cfg = _aiCfg();
        const facesBlock = cfg.faces && typeof cfg.faces === 'object' ? cfg.faces : {};
        const baseTypes = cfg.fileTypes || ['photo'];
        const types =
            facesBlock.scanVideos === true && !baseTypes.includes('video')
                ? [...baseTypes, 'video']
                : baseTypes;
        const placeholders = types.map(() => '?').join(',');
        const db = getDb();
        const tx = db.transaction(() => {
            db.prepare(`DELETE FROM faces`).run();
            db.prepare(`DELETE FROM people`).run();
            db.prepare(
                `UPDATE downloads SET ai_indexed_at = NULL WHERE file_type IN (${placeholders})`,
            ).run(...types);
        });
        tx();
        broadcast({ type: 'ai_faces_reindexed', ts: Date.now() });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
});

// ---- Detect-test (single-photo diagnostic) --------------------------------
//
// Lets the operator verify that the sidecar can process a specific photo
// without running a full scan. Takes a download ID, resolves the path, and
// calls detectFaces — returning the raw sidecar result plus quality-filter
// outcome. Useful for diagnosing 0-faces results: the operator can pick a
// photo they know has a face and see exactly what the sidecar returns.

app.post('/api/ai/detect-test', async (req, res) => {
    try {
        const id = Number(req.body?.downloadId);
        if (!Number.isFinite(id) || id < 1) {
            return res.status(400).json({ error: 'downloadId must be a positive integer' });
        }
        const db = getDb();
        const row = db
            .prepare(`SELECT id, file_path, file_type FROM downloads WHERE id = ?`)
            .get(id);
        if (!row) {
            return res.status(404).json({ error: 'download not found', code: 'NOT_FOUND' });
        }

        // Same path resolver as scan-runner.js / ai/index.js.
        // Uses the module-level DOWNLOADS_DIR so the root is consistent.
        function _resolveAbsLocal(storedPath) {
            if (!storedPath) return null;
            if (path.isAbsolute(storedPath) && existsSync(storedPath)) return storedPath;
            let s = String(storedPath).replace(/\\/g, '/');
            while (s.startsWith('data/downloads/')) s = s.slice('data/downloads/'.length);
            const candidate = path.join(DOWNLOADS_DIR, s);
            if (existsSync(candidate)) return candidate;
            if (existsSync(storedPath)) return storedPath;
            return null;
        }

        const abs = _resolveAbsLocal(row.file_path);
        if (!abs) {
            return res.json({
                success: true,
                downloadId: id,
                filePath: row.file_path,
                absPath: null,
                fileType: row.file_type,
                error: 'file_not_found_on_disk',
                raw: null,
                rawCount: null,
                warnings: [],
            });
        }

        const cfg = _aiCfg();
        const warnings = [];
        const logCollect = (entry) => {
            if (entry?.level === 'warn' || entry?.level === 'error') {
                warnings.push(`[${entry.level}] ${entry.msg}`);
            }
        };
        const detected = await aiDetectFaces(abs, cfg, logCollect);
        return res.json({
            success: true,
            downloadId: id,
            filePath: row.file_path,
            absPath: abs,
            fileType: row.file_type,
            error: null,
            raw:
                detected === null
                    ? null
                    : detected.map((f) => ({
                          x: f.x,
                          y: f.y,
                          w: f.w,
                          h: f.h,
                          score: f.score,
                          embeddingDim: f.embedding?.length ?? 0,
                      })),
            rawCount: detected === null ? null : detected.length,
            warnings,
        });
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
});

// ---- Model preload (proxy to sidecar) ------------------------------------

app.post('/api/ai/preload-model/:name', async (_req, res) => {
    const name = _req.params.name;
    try {
        const facesSpawn = await import('../core/ai/faces-spawn.js');
        const url = facesSpawn.getSidecarStatus()?.url;
        if (!url) return res.status(503).json({ error: 'sidecar not running' });
        const r = await fetch(`${url}/preload/${encodeURIComponent(name)}`, {
            method: 'POST',
            signal: AbortSignal.timeout(5000),
        });
        res.json(await r.json());
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

app.get('/api/ai/preload-model/:name/status', async (_req, res) => {
    const name = _req.params.name;
    try {
        const facesSpawn = await import('../core/ai/faces-spawn.js');
        const url = facesSpawn.getSidecarStatus()?.url;
        if (!url) return res.status(503).json({ error: 'sidecar not running' });
        const r = await fetch(`${url}/preload/${encodeURIComponent(name)}/status`, {
            signal: AbortSignal.timeout(3000),
        });
        res.json(await r.json());
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

// ---- People (face clusters) ---------------------------------------------

app.get('/api/ai/people', async (req, res) => {
    try {
        const limit = Math.max(1, Math.min(2000, Number(req.query?.limit) || 100));
        const offset = Math.max(0, Number(req.query?.offset) || 0);
        const scope = String(req.query?.scope || 'local').toLowerCase();
        const local = listPeople({ limit, offset });
        if (scope !== 'federated') {
            return res.json({ success: true, scope: 'local', ...local });
        }
        // Federated — list local clusters first, then peer summaries
        // tagged with the owning peer id. The UI's cover thumbnail is
        // resolved via the peer-aware /api/thumbs/* path.
        let peerErrors = 0;
        try {
            const { listPeers } = await import('../core/cluster/peers.js');
            const { relayTo } = await import('../core/cluster/relay.js');
            const peers = listPeers();
            const peerLists = await Promise.all(
                peers.map(async (p) => {
                    try {
                        const r = await relayTo({
                            targetPeerId: p.peerId,
                            method: 'GET',
                            path: `/api/ai/people?limit=${limit}`,
                        });
                        if (!r.ok) return [];
                        const json = await r.json();
                        const rows = Array.isArray(json?.people) ? json.people : [];
                        return rows.map((row) => ({
                            ...row,
                            _peerId: p.peerId,
                            _peerName: p.name || p.peerId,
                        }));
                    } catch {
                        peerErrors += 1;
                        return [];
                    }
                }),
            );
            const merged = [
                ...(local.people || []).map((row) => ({ ...row, _peerId: 'local' })),
                ...peerLists.flat(),
            ];
            return res.json({
                success: true,
                scope: 'federated',
                people: merged,
                total: merged.length,
                peerErrors,
            });
        } catch (e) {
            return res.json({ success: true, scope: 'local', ...local });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Faces detected on a single download — used by the viewer's overlay
// to draw face boxes over the image. Cheap (single indexed SELECT)
// + small payload (tens of rows max per photo).
app.get('/api/ai/faces/by-download/:id', async (req, res) => {
    try {
        const downloadId = Number(req.params.id);
        if (!Number.isFinite(downloadId) || downloadId <= 0) {
            return res.status(400).json({ error: 'invalid download id' });
        }
        const rows = aiGetDb()
            .prepare(`
                SELECT f.id, f.x, f.y, f.w, f.h, f.person_id, f.quality_score,
                       p.label AS person_label
                  FROM faces f
                  LEFT JOIN people p ON p.id = f.person_id
                 WHERE f.download_id = ?
                 ORDER BY f.id ASC
            `)
            .all(downloadId);
        res.json({ success: true, downloadId, faces: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/ai/group-by-person', async (req, res) => {
    try {
        const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 50));
        const rows = aiGetDb()
            .prepare(`
                SELECT p.id, p.label, p.face_count,
                       (SELECT f.download_id FROM faces f WHERE f.person_id = p.id LIMIT 1) AS cover_download_id
                  FROM people p
                 ORDER BY p.face_count DESC, p.id ASC
                 LIMIT ?
            `)
            .all(limit);
        res.json({ success: true, groups: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Extract a single frame from a video file as a raw image buffer using ffmpeg.
// Used by the face crop endpoints when the source is a video file.
async function _extractVideoFrame(videoPath) {
    const { execFile } = await import('child_process');
    const { resolveFfmpegBin } = await import('../core/thumbs.js');
    const ffmpeg = resolveFfmpegBin();
    return new Promise((resolve, reject) => {
        execFile(
            ffmpeg,
            ['-i', videoPath, '-vframes', '1', '-f', 'image2', '-vcodec', 'png', 'pipe:1'],
            { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024, timeout: 10000 },
            (err, stdout) => {
                if (err) return reject(err);
                resolve(stdout);
            },
        );
    });
}

// Crop a face from an image buffer (or file path) with padding.
async function _cropFace(source, row, size) {
    const pad = 0.4;
    const meta = await sharp(source, { failOn: 'none' }).metadata();
    const imgW = meta.width || 9999;
    const imgH = meta.height || 9999;
    const left = Math.max(0, Math.round(row.x - row.w * pad));
    const top = Math.max(0, Math.round(row.y - row.h * pad));
    const right = Math.min(imgW, Math.round(row.x + row.w + row.w * pad));
    const bottom = Math.min(imgH, Math.round(row.y + row.h + row.h * pad));
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    return sharp(source, { failOn: 'none' })
        .extract({ left, top, width, height })
        .resize(size, size, { fit: 'cover', position: 'centre' })
        .jpeg({ quality: 82, progressive: true })
        .toBuffer();
}

// Face crop for person avatar — best (highest-quality/largest) face for this person.
// Used by the People grid as the circle avatar. Sharp-crops with 40% padding so the
// face is framed, not cut tight. For video-sourced faces, extracts a frame via ffmpeg.
app.get('/api/ai/person/:id/face', async (req, res) => {
    try {
        const personId = Number(req.params.id);
        if (!Number.isFinite(personId) || personId <= 0)
            return res.status(400).json({ error: 'invalid person id' });
        const size = Math.max(64, Math.min(512, Number(req.query.w) || 160));

        const row = aiGetDb()
            .prepare(
                `SELECT f.x, f.y, f.w, f.h, d.file_path, d.file_type
                   FROM faces f
                   JOIN downloads d ON d.id = f.download_id
                  WHERE f.person_id = ?
                  ORDER BY CASE WHEN d.file_type = 'photo' THEN 0 ELSE 1 END,
                           COALESCE(f.quality_score, 0) DESC, f.w * f.h DESC
                  LIMIT 1`,
            )
            .get(personId);
        if (!row) return res.status(404).json({ error: 'no face found' });

        const resolved = await safeResolveDownload(row.file_path);
        if (!resolved.ok)
            return res
                .status(resolved.reason === 'missing' ? 404 : 403)
                .json({ error: resolved.reason });

        let buf;
        if (row.file_type === 'video') {
            const frameBuf = await _extractVideoFrame(resolved.real);
            try {
                buf = await _cropFace(frameBuf, row, size);
            } catch {
                buf = await sharp(frameBuf, { failOn: 'none' })
                    .resize(size, size, { fit: 'cover', position: 'attention' })
                    .jpeg({ quality: 82, progressive: true })
                    .toBuffer();
            }
        } else {
            buf = await _cropFace(resolved.real, row, size);
        }

        res.set('content-type', 'image/jpeg');
        res.set('cache-control', 'public, max-age=604800, immutable');
        res.send(buf);
    } catch (e) {
        log({
            source: 'ai',
            level: 'warn',
            msg: `face crop error for person ${req.params.id}: ${e.message}`,
        });
        res.status(404).json({ error: 'face crop failed' });
    }
});

// Face crop for an individual face (used in the per-person photo gallery).
// Crops the face bbox from the source image with the same 40% padding.
app.get('/api/ai/faces/:id/crop', async (req, res) => {
    try {
        const faceId = Number(req.params.id);
        if (!Number.isFinite(faceId) || faceId <= 0)
            return res.status(400).json({ error: 'invalid face id' });
        const size = Math.max(64, Math.min(512, Number(req.query.w) || 128));

        const row = aiGetDb()
            .prepare(
                `SELECT f.x, f.y, f.w, f.h, d.file_path
                   FROM faces f
                   JOIN downloads d ON d.id = f.download_id
                  WHERE f.id = ?`,
            )
            .get(faceId);
        if (!row) return res.status(404).json({ error: 'face not found' });

        const resolved = await safeResolveDownload(row.file_path);
        if (!resolved.ok)
            return res
                .status(resolved.reason === 'missing' ? 404 : 403)
                .json({ error: resolved.reason });

        const pad = 0.4;
        const meta = await sharp(resolved.real, { failOn: 'none' }).metadata();
        const imgW = meta.width || 9999;
        const imgH = meta.height || 9999;

        const left = Math.max(0, Math.round(row.x - row.w * pad));
        const top = Math.max(0, Math.round(row.y - row.h * pad));
        const right = Math.min(imgW, Math.round(row.x + row.w + row.w * pad));
        const bottom = Math.min(imgH, Math.round(row.y + row.h + row.h * pad));
        const width = Math.max(1, right - left);
        const height = Math.max(1, bottom - top);

        const buf = await sharp(resolved.real, { failOn: 'none' })
            .extract({ left, top, width, height })
            .resize(size, size, { fit: 'cover', position: 'centre' })
            .jpeg({ quality: 82, progressive: true })
            .toBuffer();

        res.set('content-type', 'image/jpeg');
        res.set('cache-control', 'public, max-age=604800, immutable');
        res.send(buf);
    } catch (e) {
        log({
            source: 'ai',
            level: 'warn',
            msg: `face crop error for face ${req.params.id}: ${e.message}`,
        });
        res.status(404).json({ error: 'face crop failed' });
    }
});

app.get('/api/ai/people/:id/photos', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) {
            return res.status(400).json({ error: 'invalid person id' });
        }
        const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 50));
        const offset = Math.max(0, Number(req.query?.offset) || 0);
        const result = listPhotosForPerson(id, { limit, offset });
        res.json({ success: true, personId: id, ...result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.patch('/api/ai/people/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) {
            return res.status(400).json({ error: 'invalid person id' });
        }
        const label = String(req.body?.label || '')
            .trim()
            .slice(0, 100);
        const changes = renamePerson(id, label || null);
        if (!changes) return res.status(404).json({ error: 'person not found' });
        res.json({ success: true, id, label });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Merge person `otherId` INTO `id`. Every face previously labelled
// `otherId` now belongs to `id`; the empty cluster is deleted. The
// preserved cluster keeps its label. Used by the UI when two clusters
// turn out to be the same person.
app.post('/api/ai/people/:id/merge', async (req, res) => {
    try {
        const id = Number(req.params.id);
        const otherId = Number(req.body?.otherId);
        if (!Number.isFinite(id) || !Number.isFinite(otherId) || id === otherId) {
            return res.status(400).json({ error: 'id + otherId required and must differ' });
        }
        const { mergeFacePerson } = await import('../core/db.js');
        const r = mergeFacePerson(id, otherId);
        log({
            source: 'ai',
            level: 'info',
            msg: `people/merge: target=${id} other=${otherId} moved=${r.moved} deleted=${r.deleted}`,
        });
        res.json({ success: true, target: id, other: otherId, ...r });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Pull selected faces out of their current cluster(s) and create a
// fresh cluster from them. Used when DBSCAN over-merged two similar
// people — operator picks the faces that look wrong, calls split,
// gets a new cluster they can rename.
app.post('/api/ai/people/:id/split', async (req, res) => {
    try {
        const faceIds = Array.isArray(req.body?.faceIds) ? req.body.faceIds : [];
        const label =
            String(req.body?.label || '')
                .trim()
                .slice(0, 100) || null;
        if (!faceIds.length) {
            return res.status(400).json({ error: 'faceIds required (non-empty array)' });
        }
        const { splitFacePerson } = await import('../core/db.js');
        const r = splitFacePerson(faceIds, label);
        if (!r.personId) {
            return res.status(404).json({ error: 'no faces matched the supplied ids' });
        }
        log({
            source: 'ai',
            level: 'info',
            msg: `people/split: new personId=${r.personId} moved=${r.moved} label=${label || '(unlabelled)'}`,
        });
        res.json({ success: true, ...r });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Move a single face to a different cluster (or to `null` = unassigned).
// Used for "this one face was put in the wrong cluster" repair.
app.post('/api/ai/faces/:id/reassign', async (req, res) => {
    try {
        const faceId = Number(req.params.id);
        if (!Number.isFinite(faceId) || faceId <= 0) {
            return res.status(400).json({ error: 'invalid face id' });
        }
        const target =
            req.body?.personId == null || req.body.personId === ''
                ? null
                : Number(req.body.personId);
        if (target != null && !Number.isFinite(target)) {
            return res.status(400).json({ error: 'invalid personId' });
        }
        const { reassignFace } = await import('../core/db.js');
        const r = reassignFace(faceId, target);
        if (!r.ok) return res.status(404).json({ error: 'face not found' });
        log({
            source: 'ai',
            level: 'info',
            msg: `faces/reassign: face=${faceId} from=${r.oldPersonId} to=${r.newPersonId}`,
        });
        res.json({ success: true, ...r });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/ai/people/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) {
            return res.status(400).json({ error: 'invalid person id' });
        }
        const changes = deletePerson(id);
        if (!changes) return res.status(404).json({ error: 'person not found' });
        res.json({ success: true, id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Quality backfill — walk faces with NULL quality_score, re-detect via
// the sidecar, match by IoU, and persist the composite quality score.
// Uses the standard JobTracker pattern so the UI shows progress.

app.post('/api/ai/backfill-quality', async (req, res) => {
    const tracker = _jobTrackers.qualityBackfill;
    const r = tracker.tryStart(async ({ onProgress, signal }) => {
        const db = aiGetDb();
        const { detectFacesBatch } = await import('../core/ai/faces-client.js');

        const downloadIds = db
            .prepare(
                'SELECT DISTINCT f.download_id FROM faces f WHERE f.quality_score IS NULL ORDER BY f.download_id',
            )
            .all();

        let processed = 0;
        let updated = 0;
        let errors = 0;
        const total = downloadIds.length;

        for (const { download_id } of downloadIds) {
            if (signal.aborted) break;

            const dl = db.prepare('SELECT file_path FROM downloads WHERE id = ?').get(download_id);
            if (!dl?.file_path) {
                processed++;
                continue;
            }

            const resolved = await safeResolveDownload(dl.file_path);
            if (!resolved?.ok) {
                processed++;
                errors++;
                continue;
            }

            let detected;
            try {
                const batch = await detectFacesBatch([resolved.real], {});
                detected = batch?.[0];
            } catch {
                detected = null;
            }

            if (Array.isArray(detected) && detected.length) {
                const storedFaces = db
                    .prepare(
                        'SELECT id, x, y, w, h FROM faces WHERE download_id = ? AND quality_score IS NULL',
                    )
                    .all(download_id);

                for (const sf of storedFaces) {
                    let bestIoU = 0;
                    let bestQ = null;
                    for (const d of detected) {
                        const ix1 = Math.max(sf.x, d.x);
                        const iy1 = Math.max(sf.y, d.y);
                        const ix2 = Math.min(sf.x + sf.w, d.x + d.w);
                        const iy2 = Math.min(sf.y + sf.h, d.y + d.h);
                        const iw = Math.max(0, ix2 - ix1);
                        const ih = Math.max(0, iy2 - iy1);
                        const inter = iw * ih;
                        const union = sf.w * sf.h + d.w * d.h - inter;
                        const iou = union > 0 ? inter / union : 0;
                        if (iou > bestIoU && iou > 0.3) {
                            bestIoU = iou;
                            bestQ = Number.isFinite(d.qualityScore)
                                ? d.qualityScore
                                : Number.isFinite(d.score)
                                  ? d.score
                                  : null;
                        }
                    }
                    if (bestQ != null) {
                        setFaceQualityScore(sf.id, bestQ);
                        updated++;
                    }
                }
            }

            processed++;
            if (processed % 20 === 0 || processed === total) {
                onProgress({ processed, total, updated, errors });
                await new Promise((r) => setImmediate(r));
            }
        }
        return { processed, total, updated, errors };
    });
    if (!r.started) return res.status(409).json(r);
    res.json(r);
});

app.get('/api/ai/backfill-quality/status', (req, res) => {
    res.json(_jobTrackers.qualityBackfill.getStatus());
});

// Re-index — full reset. Drops every AI artefact (embeddings, tags,
// faces, people) and clears `ai_indexed_at` on every download so the
// next scan starts from scratch. Use after changing model/dtype/label
// list when the partial-clear of `clearStaleEmbeddings` isn't enough
// (e.g. label list shrunk and the operator wants stale tags gone too).
//
// Aborts every in-flight scan first to avoid the race where the loop
// keeps re-stamping `ai_indexed_at` while we're trying to null it out.
app.post('/api/ai/reindex', async (req, res) => {
    try {
        // Cancel any in-flight scan before nuking the artefacts.
        let cancelled = 0;
        for (const f of ['embed', 'tags', 'faces']) {
            if (aiCancelScan(f)) cancelled += 1;
        }
        // Settle one tick so the scan loops see the abort signal.
        if (cancelled) await new Promise((r) => setTimeout(r, 100));
        const r = resetAllAiData();
        log({
            source: 'ai',
            level: 'info',
            msg: `re-index — wiped embeddings=${r.embeddings} tags=${r.tags} faces=${r.faces} people=${r.people}; re-queued=${r.requeued}; cancelled-scans=${cancelled}`,
        });
        try {
            broadcast({ type: 'ai_reindex', ...r });
        } catch {}
        res.json({ success: true, cancelled, ...r });
    } catch (e) {
        log({ source: 'ai', level: 'error', msg: `re-index failed: ${e?.message || e}` });
        res.status(500).json({ error: e.message });
    }
});

// AI auto-scan drip timer — wakes every `autoScanIntervalMs`, checks
// the live config + queue depth, then pushes up to `autoScanBatchSize`
// un-indexed photos onto the backfill queue. The existing
// `pregenerateAi` drain picks them up and runs them through the
// embed/tag/face pipelines using the operator's current model + dtype
// settings.
//
// Why drip + queue (not direct scan loop):
//   - Queue path is shared with realtime downloads, so live monitor
//     jobs always preempt drip work (realtime is `priority='realtime'`,
//     drip is `'backfill'`).
//   - Resume-safe: state lives in `cfg.autoScan`. A restart leaves the
//     state untouched, the timer rearms on boot, and we resume from
//     wherever `ai_indexed_at IS NULL` says we left off.
//   - Cancel-safe: switching to 'paused' / 'idle' just makes the next
//     tick a no-op. In-flight work in the existing queue finishes
//     gracefully (operator stops new work, not the row currently
//     being embedded).
let _aiAutoScanTimer = null;
let _aiAutoScanLastTickAt = 0;
let _aiAutoScanLastEnqueued = 0;

function _aiAutoScanTick() {
    try {
        const cfg = _aiCfg();
        if (cfg.enabled !== true) return;
        if (cfg.autoScan !== 'running') return;
        const ceiling = Math.max(1, Number(cfg.autoScanQueueCeiling) || 50);
        const batchSize = Math.max(1, Number(cfg.autoScanBatchSize) || 10);
        let depths;
        try {
            depths = aiBgQueueDepths();
        } catch {
            depths = { realtime: 0, backfill: 0 };
        }
        // Back off when the backfill queue is already saturated — the
        // drain reads from it FIFO, so dumping more in just grows the
        // in-memory list without speeding work up.
        if (depths.backfill >= ceiling) {
            _aiAutoScanLastTickAt = Date.now();
            _aiAutoScanLastEnqueued = 0;
            return;
        }
        // Realtime traffic gets priority — if there's live work
        // happening, skip the drip this tick so the user-visible path
        // finishes faster.
        if (depths.realtime > 0) {
            _aiAutoScanLastTickAt = Date.now();
            _aiAutoScanLastEnqueued = 0;
            return;
        }
        const facesBlk = cfg.faces && typeof cfg.faces === 'object' ? cfg.faces : {};
        const baseFileTypes = cfg.fileTypes || ['photo'];
        const fileTypes =
            facesBlk.scanVideos === true && !baseFileTypes.includes('video')
                ? [...baseFileTypes, 'video']
                : baseFileTypes;
        const batch = getUnindexedAiBatch({ fileTypes, limit: batchSize });
        if (!batch.length) {
            _aiAutoScanLastTickAt = Date.now();
            _aiAutoScanLastEnqueued = 0;
            return;
        }
        for (const row of batch) {
            try {
                aiPregenerateAi(row.id, { priority: 'backfill' });
            } catch {}
        }
        _aiAutoScanLastTickAt = Date.now();
        _aiAutoScanLastEnqueued = batch.length;
        log({
            source: 'ai-autoscan',
            level: 'info',
            msg: `tick: enqueued=${batch.length} backfillDepth=${depths.backfill} ceiling=${ceiling}`,
        });
    } catch (e) {
        log({
            source: 'ai-autoscan',
            level: 'warn',
            msg: `tick failed: ${e?.message || e}`,
        });
    }
}

function _aiAutoScanRearm() {
    try {
        if (_aiAutoScanTimer) {
            clearInterval(_aiAutoScanTimer);
            _aiAutoScanTimer = null;
        }
        const cfg = _aiCfg();
        if (cfg.enabled !== true) return;
        if (cfg.autoScan !== 'running') return;
        const ms = Math.max(5_000, Math.min(3_600_000, Number(cfg.autoScanIntervalMs) || 60_000));
        _aiAutoScanTimer = setInterval(_aiAutoScanTick, ms);
        _aiAutoScanTimer.unref?.();
        // Kick once right away so the operator sees a tick land before
        // the first full interval elapses.
        setImmediate(_aiAutoScanTick);
        log({
            source: 'ai-autoscan',
            level: 'info',
            msg: `armed: interval=${ms}ms batchSize=${cfg.autoScanBatchSize ?? 10}`,
        });
    } catch (e) {
        log({
            source: 'ai-autoscan',
            level: 'warn',
            msg: `rearm failed: ${e?.message || e}`,
        });
    }
}
// Arm on boot — picks up the persisted state automatically. The
// config-change subscriber below also rearms on every save.
setImmediate(_aiAutoScanRearm);
try {
    const { watchConfig } = await import('../config/manager.js');
    watchConfig(() => _aiAutoScanRearm());
} catch {}

// Start / Pause / Stop control — single endpoint, action enum so the
// state machine stays explicit. Resume is just `action='start'` from
// a paused state — the un-indexed cursor (ai_indexed_at IS NULL)
// keeps the picks identical so progress persists.
app.post('/api/ai/auto-scan', async (req, res) => {
    try {
        const action = String(req.body?.action || '').toLowerCase();
        const ACTIONS = { start: 'running', pause: 'paused', stop: 'idle' };
        const next = ACTIONS[action];
        if (!next) {
            return res.status(400).json({ error: 'action must be one of: start, pause, stop' });
        }
        const { loadConfig, saveConfig } = await import('../config/manager.js');
        const live = loadConfig();
        const merged = {
            ...live,
            advanced: {
                ...(live.advanced || {}),
                ai: { ...(live.advanced?.ai || {}), autoScan: next },
            },
        };
        await saveConfig(merged);
        _aiAutoScanRearm();
        log({
            source: 'ai-autoscan',
            level: 'info',
            msg: `state: ${live.advanced?.ai?.autoScan || 'idle'} → ${next} (action=${action})`,
        });
        res.json({ success: true, state: next });
    } catch (e) {
        log({
            source: 'ai-autoscan',
            level: 'error',
            msg: `state change failed: ${e?.message || e}`,
        });
        res.status(500).json({ error: e.message });
    }
});

// AI health check / doctor strip — surfaces the Python face sidecar's
// install + runtime surface (binary, interpreter, provider, model, index
// progress). UI renders the response as a list of ✓/⚠/✗ rows so the
// operator can spot a missing dep in one look. Each `check` has a stable
// `id` so the UI can color-code without parsing the label string.
//
// Hardening rules (carried over from the v2.12.1 hardening pass):
//   - Every probe wrapped in try/catch — one failing probe never
//     fails the request.
//   - Every setTimeout / spawn uses an integer literal — no NaN risk
//     that could surface as `TimeoutNaNWarning` in the docker logs.
//   - Every fetch / child spawn carries an AbortController or hard
//     timeout so a wedged dep can't hang the request.

// Doctor — sidecar-aligned probe set. Six rows that cover the actual
// install surface (Python sidecar + onnxruntime backends + buffalo_l):
//
//   1. Python face sidecar reachability (auto-spawn lifecycle state).
//   2. Host Python on PATH — informational, used by the fallback spawn
//      path when the prebuilt binary is unavailable.
//   3. Prebuilt sidecar binary on disk (auto-downloaded on first scan).
//   4. Inference provider resolved by onnxruntime inside the sidecar.
//   5. Model loaded (insightface buffalo_l).
//   6. Photos indexed (kept — drives the operator's progress sense).
//
// Each probe is wrapped in try/catch — one failing probe never fails the
// request. Every fetch / spawn carries a fixed-integer timeout so a
// black-holed dep can't hang the request.
app.get(['/api/ai/doctor', '/api/ai/health'], async (_req, res) => {
    const checks = [];

    // 1. Sidecar reachability — drives the headline OK/spawning/failed
    //    state. We surface the spawn module's lifecycle directly so the
    //    operator sees "downloading…" / "starting up…" instead of a bare
    //    fail row while the binary is being fetched in the background.
    try {
        const { getSidecarStatus, SIDECAR_VERSION: facesVer } = await import(
            '../core/ai/faces-spawn.js'
        );
        const st = getSidecarStatus();
        if (st.state === 'healthy') {
            checks.push({
                id: 'sidecar',
                label: 'Python face sidecar',
                status: 'ok',
                detail: `v${facesVer} · running at ${st.url}`,
            });
        } else if (st.state === 'downloading') {
            checks.push({
                id: 'sidecar',
                label: 'Python face sidecar',
                status: 'info',
                detail: 'downloading binary…',
            });
        } else if (st.state === 'spawning') {
            checks.push({
                id: 'sidecar',
                label: 'Python face sidecar',
                status: 'info',
                detail: 'starting up…',
            });
        } else if (st.state === 'failed') {
            checks.push({
                id: 'sidecar',
                label: 'Python face sidecar',
                status: 'fail',
                detail: st.error || 'failed to start',
            });
        } else {
            checks.push({
                id: 'sidecar',
                label: 'Python face sidecar',
                status: 'info',
                detail: 'disabled',
            });
        }
    } catch (e) {
        checks.push({
            id: 'sidecar',
            label: 'Python face sidecar',
            status: 'warn',
            detail: e?.message || 'probe failed',
        });
    }

    // 2. Host Python — informational. The auto-spawn flow prefers the
    //    PyInstaller binary; Python on the host is only consulted as a
    //    fallback when the prebuilt binary fails to launch. Never fails
    //    the card on absence — most installs run the prebuilt and never
    //    need a host interpreter.
    try {
        const { execFile } = await import('node:child_process');
        const bin = process.platform === 'win32' ? 'python' : 'python3';
        const out = await new Promise((resolve, reject) => {
            execFile(bin, ['--version'], { timeout: 2000 }, (err, stdout, stderr) => {
                if (err) reject(err);
                else resolve(String(stdout || stderr).trim());
            });
        });
        const m = out.match(/Python (\d+)\.(\d+)(?:\.(\d+))?/);
        const major = m ? Number(m[1]) : 0;
        const minor = m ? Number(m[2]) : 0;
        if (major >= 3 && minor >= 10) {
            checks.push({
                id: 'python',
                label: 'Host Python',
                status: 'ok',
                detail: `${out} (fallback path available)`,
            });
        } else if (major >= 3) {
            checks.push({
                id: 'python',
                label: 'Host Python',
                status: 'warn',
                detail: `${out} — sidecar prefers 3.10+`,
            });
        } else {
            checks.push({
                id: 'python',
                label: 'Host Python',
                status: 'info',
                detail: `${out} (using prebuilt binary)`,
            });
        }
    } catch {
        checks.push({
            id: 'python',
            label: 'Host Python',
            status: 'info',
            detail: 'no Python on PATH (using prebuilt binary)',
        });
    }

    // 3. Prebuilt sidecar binary on disk. Mirrors the path resolution
    //    used by faces-spawn.js so the doctor card reports the same
    //    location the spawn flow actually writes to (including
    //    TGDL_DATA_DIR overrides used in tests).
    try {
        const { promises: fs } = await import('node:fs');
        const dataDir = DATA_DIR;
        const plat =
            process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
        const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
        const ext = process.platform === 'win32' ? '.exe' : '';
        const binPath = path.join(
            dataDir,
            'faces-service',
            'bin',
            `tgdl-faces-${plat}-${arch}${ext}`,
        );
        const st = await fs.stat(binPath);
        const sizeMb = (st.size / (1024 * 1024)).toFixed(1);
        checks.push({
            id: 'binary',
            label: 'Prebuilt sidecar binary',
            status: 'ok',
            detail: `cached: ${sizeMb} MB`,
        });
    } catch {
        // First-run setup hint — until the GitHub Release lands the
        // download will 404, so the operator needs to know about the two
        // recovery paths (docker compose or `pip install -e faces-service/`).
        checks.push({
            id: 'binary',
            label: 'Prebuilt sidecar binary',
            status: 'info',
            detail:
                'not yet downloaded — `docker compose --profile faces up` or ' +
                '`pip install -e faces-service/` from the repo root, then restart',
        });
    }

    // 4 + 5. Provider + model — both pulled from the sidecar. `/health`
    //    carries the model + ready flag; the resolved onnxruntime
    //    providers list lives on `/info` (set after the model loads).
    //    Merging both keeps the doctor card aligned with the sidecar's
    //    wire format without forcing a Python-side change.
    let richFacesHealth = null;
    try {
        const facesClient = await import('../core/ai/faces-client.js');
        const url = facesClient.getSidecarUrl();
        const h = await facesClient.health();
        // Capture the full parsed health response so the top-level
        // `richHealth` field exposes version/platform/python/providers
        // to callers without forcing a separate request.
        if (h) {
            richFacesHealth = {
                ok: h.ok === true,
                version: h.version ?? null,
                model: h.model ?? null,
                dim: h.dim ?? null,
                ready: h.ready === true,
                providersResolved: h.providersResolved ?? null,
                providersRequested: h.providersRequested ?? null,
                detSize: h.detSize ?? null,
                platform: h.platform ?? null,
                python: h.python ?? null,
            };
        }
        if (h.ok) {
            let providers = [];
            if (url) {
                try {
                    const ctrl = new AbortController();
                    const t = setTimeout(() => ctrl.abort(), 2000);
                    try {
                        const r = await globalThis.fetch(`${url}/info`, { signal: ctrl.signal });
                        if (r.ok) {
                            const info = await r.json();
                            if (Array.isArray(info?.providers)) providers = info.providers;
                        }
                    } finally {
                        clearTimeout(t);
                    }
                } catch {
                    /* /info is best-effort — fall through to CPU default */
                }
            }
            const top = providers[0] || 'CPUExecutionProvider';
            const providerLabel =
                {
                    CUDAExecutionProvider: 'GPU acceleration: CUDA',
                    CoreMLExecutionProvider: 'GPU acceleration: Apple Silicon (CoreML)',
                    DmlExecutionProvider: 'GPU acceleration: DirectML',
                    CPUExecutionProvider: 'CPU-only (no GPU detected)',
                }[top] || top;
            checks.push({
                id: 'provider',
                label: 'Inference provider',
                status: 'ok',
                detail: providerLabel,
            });
            checks.push({
                id: 'model',
                label: 'Model loaded',
                status: h.ready ? 'ok' : 'warn',
                detail: h.ready
                    ? `${h.model || 'buffalo_l'} (${h.dim || 512}-dim)`
                    : 'not loaded yet (first scan will load)',
            });
        } else {
            checks.push({
                id: 'provider',
                label: 'Inference provider',
                status: 'warn',
                detail: 'unable to probe (sidecar offline)',
            });
            checks.push({
                id: 'model',
                label: 'Model loaded',
                status: 'warn',
                detail: 'unable to probe (sidecar offline)',
            });
        }
    } catch (e) {
        checks.push({
            id: 'provider',
            label: 'Inference provider',
            status: 'warn',
            detail: e?.message || 'probe failed',
        });
        checks.push({
            id: 'model',
            label: 'Model loaded',
            status: 'warn',
            detail: e?.message || 'probe failed',
        });
    }

    // 6. Files indexed — respects scanVideos flag so the progress
    //    number matches what the status page + scan show.
    try {
        const dcfg = _aiCfg();
        const dfb = dcfg.faces && typeof dcfg.faces === 'object' ? dcfg.faces : {};
        const dbt = dcfg.fileTypes || ['photo'];
        const dft = dfb.scanVideos === true && !dbt.includes('video') ? [...dbt, 'video'] : dbt;
        const c = getAiCounts({ fileTypes: dft });
        const pct = c.totalEligible ? Math.floor((c.indexed / c.totalEligible) * 100) : 0;
        const lbl = dfb.scanVideos ? 'Files indexed' : 'Photos indexed';
        checks.push({
            id: 'indexed',
            label: lbl,
            status: 'ok',
            detail: `${c.indexed}/${c.totalEligible} (${pct}%) · with faces ${c.withFaces || 0}`,
        });
    } catch (e) {
        checks.push({
            id: 'indexed',
            label: 'Photos indexed',
            status: 'warn',
            detail: e?.message || String(e),
        });
    }

    res.json({ success: true, checks, richHealth: richFacesHealth });
});

// ====== Recovery cleanup ====================================================
//
// Surfaces every group whose id starts with `unknown:` OR whose
// `_resolveFailedAt` is set — typically the residue of `npm run recover`
// against a downloads table that had folders from a different Telegram
// account. The Recovery cleanup page (Maintenance → Recovery cleanup)
// renders this list + bulk operations so the operator doesn't have to
// edit kv['config'] by hand.
function _classifyRecoveryGroup(g, dbStats) {
    const id = String(g.id);
    const isSynthetic = id.startsWith('unknown:');
    const failed = !!g._resolveFailedAt;
    if (!isSynthetic && !failed) return null;
    const stats = dbStats.get(id) || { files: 0, lastSeen: null };
    return {
        id,
        name: g.name || id,
        enabled: !!g.enabled,
        isSynthetic,
        resolveFailedAt: g._resolveFailedAt || null,
        resolveFailedReason: g._resolveFailedReason || (isSynthetic ? 'index_miss' : null),
        monitorAccount: g.monitorAccount || null,
        fileCount: stats.files || 0,
        lastSeenAt: stats.lastSeen || null,
        recoveryIgnored: !!g._recoveryIgnored,
    };
}

app.get('/api/maintenance/recovery/list', async (req, res) => {
    try {
        const config = loadConfig();
        const groups = Array.isArray(config.groups) ? config.groups : [];
        // Pre-fetch per-group file count + lastSeen with one query so the
        // list endpoint stays cheap even for large libraries.
        const dbStats = new Map();
        try {
            const rows = getDb()
                .prepare(`
                    SELECT group_id, COUNT(*) AS files, MAX(created_at) AS lastSeen
                      FROM downloads
                     GROUP BY group_id
                `)
                .all();
            for (const r of rows) {
                dbStats.set(String(r.group_id), {
                    files: Number(r.files) || 0,
                    lastSeen: r.lastSeen || null,
                });
            }
        } catch {
            /* fresh install — no rows */
        }
        const showIgnored = req.query.showIgnored === '1';
        const items = [];
        for (const g of groups) {
            const it = _classifyRecoveryGroup(g, dbStats);
            if (!it) continue;
            if (!showIgnored && it.recoveryIgnored) continue;
            items.push(it);
        }
        if (req.query.countOnly === '1') {
            return res.json({ success: true, total: items.length });
        }
        res.json({ success: true, items, total: items.length });
    } catch (e) {
        console.error('recovery/list:', e);
        res.status(500).json({ error: e.message });
    }
});

// Re-run the resolver against the supplied group ids. Useful after the
// operator adds a fresh Telegram account that might be a member of the
// recovery channels.
app.post('/api/maintenance/recovery/resolve', async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x) => String(x)) : [];
    if (!ids.length) return res.status(400).json({ error: 'ids[] required' });
    const tracker = _jobTrackers.recoveryBulk;
    const r = tracker.tryStart(async ({ onProgress }) => {
        const monitor = runtime._monitor;
        if (!monitor) {
            return { op: 'resolve', resolved: 0, results: [], note: 'monitor not running' };
        }
        const idx = await monitor._buildDialogsIndex();
        let resolved = 0;
        const results = [];
        const total = ids.length;
        let processed = 0;
        for (const id of ids) {
            const cfg = loadConfig();
            const g = (cfg.groups || []).find((x) => String(x.id) === id);
            if (!g) {
                results.push({ id, status: 'not_found' });
                processed += 1;
                onProgress({ op: 'resolve', processed, total });
                continue;
            }
            // Resolver only handles `unknown:` ids — everything else just
            // gets a probe attempt to clear the `_resolveFailedAt` flag.
            if (!String(g.id).startsWith('unknown:')) {
                // Try the probe loop directly.
                const client = await monitor.discoverClientForGroup(g, idx);
                if (client) {
                    // Clear the failure marker.
                    delete g._resolveFailedAt;
                    delete g._resolveFailedReason;
                    saveConfig(cfg);
                    results.push({ id, status: 'resolved', numericId: id });
                    resolved += 1;
                } else {
                    results.push({
                        id,
                        status: 'still_unknown',
                        reason: monitor._lastResolveReason?.get?.(id) || 'probe_failed',
                    });
                }
            } else {
                const r2 = await monitor._resolveUnknownGroup(g, idx).catch(() => null);
                if (r2) {
                    results.push({ id, status: 'resolved', numericId: r2.numericId });
                    resolved += 1;
                } else {
                    results.push({
                        id,
                        status: 'still_unknown',
                        reason: monitor._lastResolveReason?.get?.(id) || 'index_miss',
                    });
                }
            }
            processed += 1;
            onProgress({ op: 'resolve', processed, total });
            await new Promise((r3) => setImmediate(r3));
        }
        return { op: 'resolve', resolved, results, total };
    });
    if (!r.started) {
        return res.status(409).json({
            error: 'A recovery bulk operation is already running',
            code: 'ALREADY_RUNNING',
        });
    }
    res.json({ success: true, started: true });
});

// Auto-disable any subset (keeps config entry, just flips enabled:false).
app.post('/api/maintenance/recovery/disable', async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x) => String(x)) : [];
    if (!ids.length) return res.status(400).json({ error: 'ids[] required' });
    try {
        const cfg = loadConfig();
        let n = 0;
        for (const g of cfg.groups || []) {
            if (ids.includes(String(g.id))) {
                g.enabled = false;
                n += 1;
            }
        }
        if (n) saveConfig(cfg);
        res.json({ success: true, disabled: n });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Hard-delete from kv['config'].groups. Optionally also drops downloads
// rows + on-disk files via `?purgeDownloads=1`. The data wipe goes through
// the same `_groupPurgeTracker` per-group as the existing /purge endpoint.
app.post('/api/maintenance/recovery/delete', async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x) => String(x)) : [];
    if (!ids.length) return res.status(400).json({ error: 'ids[] required' });
    const purgeDownloads = !!req.body?.purgeDownloads;
    try {
        const cfg = loadConfig();
        const before = (cfg.groups || []).length;
        cfg.groups = (cfg.groups || []).filter((g) => !ids.includes(String(g.id)));
        const removed = before - (cfg.groups || []).length;
        if (removed) saveConfig(cfg);
        let purged = { totalRows: 0, totalFiles: 0 };
        if (purgeDownloads) {
            // Synchronous per-id wipe — the Recovery cleanup page already
            // shows a progress bar via the recoveryBulk tracker for the
            // /resolve path; this endpoint is a one-shot click and the
            // caller can poll /api/maintenance/recovery/list to confirm.
            for (const id of ids) {
                try {
                    const dlIds = getDb()
                        .prepare('SELECT id FROM downloads WHERE group_id = ?')
                        .all(String(id))
                        .map((r) => r.id);
                    const seekbarMap = collectSeekbarPaths(dlIds);
                    const r = deleteGroupDownloads(id);
                    purged.totalRows += r.deletedDownloads || 0;
                    for (const dlId of dlIds) {
                        try {
                            await purgeThumbsForDownload(dlId);
                        } catch {}
                        try {
                            await purgeSeekbarForDownload(dlId, seekbarMap.get(dlId));
                        } catch {}
                    }
                } catch {}
            }
            try {
                purgeOrphanPeople();
            } catch {}
        }
        res.json({ success: true, removed, purgeDownloads, ...purged });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Pin a group to a specific account + re-run the resolver. Lets the
// operator wire a freshly-added Telegram account to the recovery groups
// it actually owns.
app.post('/api/maintenance/recovery/reassign', async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x) => String(x)) : [];
    const monitorAccount = req.body?.monitorAccount;
    if (!ids.length) return res.status(400).json({ error: 'ids[] required' });
    if (!monitorAccount) return res.status(400).json({ error: 'monitorAccount required' });
    try {
        const cfg = loadConfig();
        let n = 0;
        for (const g of cfg.groups || []) {
            if (ids.includes(String(g.id))) {
                g.monitorAccount = String(monitorAccount);
                // Clear the failure marker so the resolver gives this
                // (account, group) pair a fresh shot.
                delete g._resolveFailedAt;
                delete g._resolveFailedReason;
                n += 1;
            }
        }
        if (n) saveConfig(cfg);
        res.json({ success: true, reassigned: n, monitorAccount });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/maintenance/recovery/status', async (req, res) => {
    res.json(_jobTrackers.recoveryBulk.getStatus());
});

// Suppress a group from the recovery list without deleting or disabling it.
// The group stays in kv['config'] and keeps receiving downloads if enabled;
// it just stops showing up on the Recovery cleanup page.
app.post('/api/maintenance/recovery/ignore', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x) => String(x)) : [];
    if (!ids.length) return res.status(400).json({ error: 'ids[] required' });
    try {
        const cfg = loadConfig();
        let n = 0;
        for (const g of cfg.groups || []) {
            if (ids.includes(String(g.id))) {
                g._recoveryIgnored = true;
                n += 1;
            }
        }
        if (n) saveConfig(cfg);
        res.json({ success: true, ignored: n });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Lift the suppression — group reappears on the Recovery cleanup page.
app.post('/api/maintenance/recovery/unignore', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x) => String(x)) : [];
    if (!ids.length) return res.status(400).json({ error: 'ids[] required' });
    try {
        const cfg = loadConfig();
        let n = 0;
        for (const g of cfg.groups || []) {
            if (ids.includes(String(g.id))) {
                delete g._recoveryIgnored;
                n += 1;
            }
        }
        if (n) saveConfig(cfg);
        res.json({ success: true, unignored: n });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
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

// ============ CLUSTER MODE (v2.9 — Phase 1) ===============================
//
// Multi-instance peer federation. See docs/CLUSTER.md and CLAUDE.md for the
// full mental model. Phase 1 covers identity bootstrap + manual pairing +
// audit log; later phases add catalog sync, streaming bridge, dedup, sweep.
//
// Two auth shapes:
//   - Admin routes (cookie-session, admin role): manage own identity, list
//     peers, add/edit/remove peers, rotate token, view audit log.
//   - Peer-to-peer routes (HMAC-signed, no cookie): handshake + health
//     probe. Allow-listed in PUBLIC_API_PATHS so the cookie middleware
//     lets them through; the handlers verify the HMAC themselves.
//
// Adding a new admin mutation route here gets admin-gating "for free" via
// the /api chokepoint default-deny pattern. Adding a new peer-to-peer
// route needs both an entry in PUBLIC_API_PATHS *and* a verifyPeerHmac
// call in the handler — never one without the other.

function _peerHmacGate(req, res) {
    const v = verifyPeerHmac(req);
    if (!v.ok) {
        recordClusterAudit({
            kind: 'request',
            ok: false,
            peerId: req.headers['x-peer-id'] || null,
            detail: `${req.method} ${req.originalUrl || req.url}: ${v.reason}`,
        });
        res.status(401).json({ error: 'cluster auth failed', code: v.reason });
        return null;
    }
    return v;
}

// --- Peer-to-peer (HMAC-signed) -----------------------------------------

app.post('/api/cluster/handshake', async (req, res) => {
    // The very first signed call from a new remote peer — no peer row
    // exists yet, so we verify against our local cluster token directly.
    const v = _peerHmacGate(req, res);
    if (!v) return;
    try {
        const body = req.body || {};
        // body.url is the initiator's own reachable URL (sent since v2.17).
        // Older peers send '' — store 'unknown' in that case and let the
        // operator correct it via Edit. The Host header is the target's
        // hostname (this server), NOT the caller's URL, so we never use it
        // as a fallback here to avoid recording the wrong address.
        const callerUrl = String(body.url || '').trim() || 'unknown';
        const peer = acceptHandshake({
            peerId: body.peer_id,
            name: body.name,
            url: callerUrl,
            version: body.version || null,
            sharedSecret: body.shared_secret || null,
            pairingCode: body.pairing_code || null,
        });
        // peer is the inbound caller's peer record on US (i.e. the data we
        // just stored about them). The response carries OUR identity for
        // the caller to record symmetrically.
        res.json(peer);
    } catch (e) {
        const status = e?.status || 500;
        res.status(status).json({ error: e?.message || String(e), code: e?.code || 'error' });
    }
});

app.get('/api/cluster/health', (req, res) => {
    const v = _peerHmacGate(req, res);
    if (!v) return;
    // Bump last_seen so the dashboard's status pill flips green on the
    // remote peer's next refresh.
    try {
        markOnline(v.peerId);
    } catch {
        /* peer might not be paired yet (handshake races health) */
    }
    res.json({
        peer_id: getSelfPeerId(),
        name: getSelfPeerName(),
        version: process.env.npm_package_version || null,
        ts: Date.now(),
        ok: true,
    });
});

// --- Admin (cookie-authed; admin role required by the chokepoint) -------

app.get('/api/cluster/identity', (_req, res) => {
    res.json(getSelfIdentity());
});

app.put('/api/cluster/identity', (req, res) => {
    const name = req.body?.name;
    if (!name) return res.status(400).json({ error: 'name required' });
    try {
        const clean = setSelfPeerName(name);
        res.json({ peerId: getSelfPeerId(), name: clean });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.get('/api/cluster/identity/token', (_req, res) => {
    // Sensitive: only admins reach here (chokepoint default-deny). Token
    // is returned in the response body and never logged.
    res.set('Cache-Control', 'no-store').json({ token: getClusterToken() });
});

app.post('/api/cluster/identity/rotate-token', (_req, res) => {
    const token = rotateClusterToken();
    recordClusterAudit({ kind: 'rotate_token', ok: true, detail: 'admin rotated cluster token' });
    res.set('Cache-Control', 'no-store').json({ token });
});

app.post('/api/cluster/identity/set-token', (req, res) => {
    const token = req.body?.token;
    if (!token) return res.status(400).json({ error: 'token required' });
    try {
        const clean = setClusterToken(token);
        recordClusterAudit({
            kind: 'set_token',
            ok: true,
            detail: 'admin set cluster token to externally-supplied value',
        });
        res.set('Cache-Control', 'no-store').json({ token: clean });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// v2.10 — pairing code workflow. Operator on the receiving peer clicks
// "Issue pairing code" → shows the 8-char code to dictate to whoever is
// pairing the other peer. Code is consumable once + expires in 5 min.
app.post('/api/cluster/identity/pairing-code', (_req, res) => {
    const { code, expiresAt } = issuePairingCode();
    recordClusterAudit({ kind: 'pairing_code', ok: true, detail: 'admin issued pairing code' });
    res.set('Cache-Control', 'no-store').json({ code, expiresAt });
});

app.get('/api/cluster/peers', (_req, res) => {
    res.json({ peers: listPeers() });
});

app.post('/api/cluster/peers', async (req, res) => {
    const { url, token = null, pairingCode = null } = req.body || {};
    if (!url || (!token && !pairingCode)) {
        return res.status(400).json({ error: 'url + (token or pairingCode) are required' });
    }
    try {
        // Derive this server's own reachable URL so the receiving peer can
        // store it as the callback URL. PUBLIC_URL is the authoritative
        // source; fall back to inferring from the incoming request headers.
        const selfUrl = (() => {
            if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
            try {
                const proto =
                    req.headers['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http');
                const host = req.headers['x-forwarded-host'] || req.headers.host;
                return host ? `${proto}://${host}` : '';
            } catch {
                return '';
            }
        })();
        const r = await initiateHandshake({ url, token, pairingCode, selfUrl });
        if (!r.ok) {
            return res.status(400).json({ error: r.message, code: r.code });
        }
        res.json({ peer: r.peer });
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
});

app.put('/api/cluster/peers/:peerId', (req, res) => {
    const { peerId } = req.params;
    try {
        const peer = updatePeer(peerId, req.body || {});
        if (!peer) return res.status(404).json({ error: 'peer not found' });
        res.json({ peer });
    } catch (e) {
        res.status(400).json({ error: e?.message || String(e) });
    }
});

app.delete('/api/cluster/peers/:peerId', (req, res) => {
    const { peerId } = req.params;
    const ok = removePeer(peerId);
    if (!ok) return res.status(404).json({ error: 'peer not found' });
    recordClusterAudit({ kind: 'revoke', peerId, ok: true });
    res.json({ success: true });
});

app.post('/api/cluster/peers/:peerId/test', async (req, res) => {
    const peer = getPeer(req.params.peerId);
    if (!peer) return res.status(404).json({ error: 'peer not found' });
    try {
        const r = await testPeerHealth(peer);
        if (r.ok) {
            markOnline(peer.peerId);
            recordClusterAudit({ kind: 'test', ok: true, peerId: peer.peerId });
        } else {
            markOffline(peer.peerId);
            recordClusterAudit({
                kind: 'test',
                ok: false,
                peerId: peer.peerId,
                detail: r.code || 'unreachable',
            });
        }
        res.json(r);
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
});

app.get('/api/cluster/discovered', (_req, res) => {
    res.json({ peers: listDiscoveredPeers({}) });
});

app.get('/api/cluster/audit', (req, res) => {
    const peerId = req.query.peerId || null;
    const kind = req.query.kind || null;
    const limit = Number(req.query.limit) || 200;
    res.json({ entries: listClusterAudit({ peerId, kind, limit }) });
});

// ---- Phase 2: catalog sync (P2P + admin) -------------------------------

// Delta-pull endpoint: P2P, HMAC-required. Caller passes the highest id
// it's already cached so we only return new rows.
app.get('/api/cluster/downloads/since', (req, res) => {
    const v = _peerHmacGate(req, res);
    if (!v) return;
    const sinceId = Number(req.query.sinceId) || 0;
    const limit = Number(req.query.limit) || 500;
    const rows = listOwnDownloadsSince({ sinceId, limit });
    res.json({ rows, peerId: getSelfPeerId(), now: Date.now() });
});

// Full snapshots — small, infrequent, no delta scheme.
app.get('/api/cluster/groups/snapshot', async (req, res) => {
    const v = _peerHmacGate(req, res);
    if (!v) return;
    try {
        const cfg = await readConfigSafe();
        // Strip any per-group secret-ish fields. Currently `groups` only
        // holds public metadata (name, monitorAccount, ttl, tags, etc.),
        // but defence-in-depth.
        const groups = (cfg.groups || []).map((g) => {
            const { ...clean } = g;
            return clean;
        });
        res.json({ groups, peerId: getSelfPeerId(), now: Date.now() });
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
});

app.get('/api/cluster/accounts/snapshot', async (req, res) => {
    const v = _peerHmacGate(req, res);
    if (!v) return;
    try {
        const cfg = await readConfigSafe();
        // Redact the StringSession blob — peers shouldn't impersonate
        // each other's Telegram clients.
        const accounts = (cfg.accounts || []).map((a) => ({
            id: a.id,
            label: a.label,
            phone: a.phone,
            disabled: !!a.disabled,
            // session: redacted
        }));
        res.json({ accounts, peerId: getSelfPeerId(), now: Date.now() });
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
});

// Admin — manual sync trigger (e.g. after pairing a new peer).
app.post('/api/cluster/sync/run', async (_req, res) => {
    try {
        const r = await syncAllOnce();
        res.json(r);
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
});

app.get('/api/cluster/sync/state', (_req, res) => {
    res.json(getSyncState());
});

// Admin — merged downloads view (self + every peer's catalog). Powers
// the unified gallery + downloads list. ?peerId=<self|<id>|all> filters.
app.get('/api/cluster/downloads', (req, res) => {
    try {
        const filter = req.query.peerId || 'all';
        const limit = Math.max(1, Math.min(2000, Number(req.query.limit) || 200));
        const offset = Math.max(0, Number(req.query.offset) || 0);
        const ownPid = getSelfPeerId();
        const rows = [];
        if (filter === 'all' || filter === 'self' || filter === ownPid) {
            const own = getDb()
                .prepare(
                    `SELECT id, group_id, group_name, message_id, file_name, file_size,
                            file_type, file_path, file_hash, status, created_at, nsfw_score
                       FROM downloads
                      ORDER BY id DESC LIMIT ? OFFSET ?`,
                )
                .all(limit, offset);
            for (const r of own) rows.push({ ...r, peer_id: ownPid, peer_name: getSelfPeerName() });
        }
        if (filter === 'all' || (filter !== 'self' && filter !== ownPid)) {
            const peerFilter = filter === 'all' ? null : String(filter);
            const peers = listPeers().filter((p) => !peerFilter || p.peerId === peerFilter);
            for (const p of peers) {
                const r = getDb()
                    .prepare(
                        `SELECT * FROM peer_downloads WHERE peer_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
                    )
                    .all(p.peerId, limit, offset);
                for (const row of r) rows.push({ ...row, peer_name: p.name });
            }
        }
        rows.sort((a, b) => {
            const ta =
                typeof a.created_at === 'string'
                    ? Date.parse(a.created_at)
                    : Number(a.created_at) || 0;
            const tb =
                typeof b.created_at === 'string'
                    ? Date.parse(b.created_at)
                    : Number(b.created_at) || 0;
            return tb - ta;
        });
        res.json({ rows, total: rows.length });
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
});

// ---- Phase 3: streaming bridge (P2P file proxy) ------------------------

// P2P bridge endpoint — when peer A's /files resolves a row that lives on
// peer B, A signs a GET to B at this path. We respond with the same
// bytes the local /files would serve.
app.get('/api/cluster/files/:path(*)', async (req, res, next) => {
    const v = _peerHmacGate(req, res);
    if (!v) return;
    let reqPath;
    try {
        reqPath = decodeURIComponent(req.params.path || '').replace(/^\/+/, '');
    } catch {
        return res.status(400).send('Bad request');
    }
    if (!reqPath || reqPath.includes('\0')) return res.status(400).send('Bad request');
    const r = await safeResolveDownload(reqPath);
    if (!r.ok) {
        const status = r.reason === 'missing' ? 404 : 403;
        return res.status(status).send(r.reason === 'missing' ? 'File not found' : 'Forbidden');
    }
    // Re-use Express's static-stream path so Range works identically to
    // the cookie-authed /files route. No HEIC inline transcode here —
    // the bridge serves raw bytes; the requesting peer decides framing.
    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(r.real);
});

// ---- Federated gallery thumbnails (Layer 1) ----------------------------
//
// Two endpoints, mirroring the /api/cluster/files split:
//
// 1. P2P HMAC-only (called by another peer when proxying a thumb to its
//    own browser): GET /api/cluster/thumbs/:remoteId?w=<N>
//    Re-resolves to the local /api/thumbs path via getOrCreateThumb so
//    every code path (resize, hwaccel, miss-tracking) stays in one place.
//
// 2. Cookie-auth proxy (called by THIS peer's browser when rendering a
//    federated tile): GET /api/cluster/thumbs/:peerId/:remoteId?w=<N>
//    Looks up the peer, HMAC-signs a fetch to its endpoint above, streams
//    the response back. On peer-offline / non-2xx, returns a 1×1
//    transparent PNG with a short Cache-Control so the gallery doesn't
//    spam the console with 404s while a peer is briefly unreachable.

// Peer-to-peer side. Sits under a different prefix (`peer-thumbs`) than
// the cookie-auth proxy (`thumbs`) so the public-path auth middleware
// can prefix-match the HMAC bucket without accidentally exempting the
// cookie route. See PUBLIC_PATH_PREFIXES wiring elsewhere.
app.get('/api/cluster/peer-thumbs/:remoteId', async (req, res) => {
    const v = _peerHmacGate(req, res);
    if (!v) return;
    try {
        const id = parseInt(req.params.remoteId, 10);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).type('text/plain').send('Bad id');
        }
        const thumb = await getOrCreateThumb(id, req.query.w);
        if (!thumb) {
            res.setHeader('Cache-Control', 'no-store');
            return res.status(404).type('text/plain').send('No thumb');
        }
        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('Cache-Control', 'private, no-store');
        if (Buffer.isBuffer(thumb)) return res.send(thumb);
        if (typeof thumb === 'string') return res.sendFile(thumb);
        return res.send(thumb);
    } catch (e) {
        recordClusterAudit({
            kind: 'thumb',
            ok: false,
            peerId: v.peerId || null,
            detail: `peer-thumb ${req.params.remoteId}: ${e?.message || String(e)}`,
        });
        res.status(500).type('text/plain').send('Internal error');
    }
});

// 1×1 transparent PNG — placeholder when a peer is offline / errored. The
// alternative would be a 502 which the SPA <img> would render as a broken
// glyph; this keeps the gallery layout stable and adds a short cache so
// we don't hammer the offline peer.
const _PEER_THUMB_PLACEHOLDER = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
);

function _sendPeerThumbPlaceholder(res) {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.send(_PEER_THUMB_PLACEHOLDER);
}

// Browser-side (cookie auth — admin only). Two-param form.
app.get('/api/cluster/thumbs/:peerId/:remoteId', async (req, res) => {
    try {
        const peer = getPeer(req.params.peerId);
        if (!peer) return _sendPeerThumbPlaceholder(res);
        const id = parseInt(req.params.remoteId, 10);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).type('text/plain').send('Bad id');
        }
        const w = req.query.w ? `?w=${encodeURIComponent(req.query.w)}` : '';
        const path0 = `/api/cluster/peer-thumbs/${id}${w}`;
        const headers = (await import('../core/cluster/hmac.js')).signRequest({
            method: 'GET',
            path: path0,
            targetPeerId: peer.peerId,
        });
        let upstream;
        try {
            upstream = await fetch(peer.url + path0, { method: 'GET', headers });
        } catch {
            return _sendPeerThumbPlaceholder(res);
        }
        if (!upstream.ok) {
            return _sendPeerThumbPlaceholder(res);
        }
        const ct = upstream.headers.get('content-type') || 'image/webp';
        res.setHeader('Content-Type', ct);
        // Browser HTTP cache only — content-addressed by (peer, remoteId, w),
        // so a stale cache hit is impossible during the URL's lifetime.
        res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
        const buf = Buffer.from(await upstream.arrayBuffer());
        res.send(buf);
    } catch (e) {
        recordClusterAudit({
            kind: 'thumb',
            ok: false,
            peerId: req.params.peerId,
            detail: `proxy ${req.params.remoteId}: ${e?.message || String(e)}`,
        });
        _sendPeerThumbPlaceholder(res);
    }
});

// ---- Phase 4: direct stream mode (sign-url minting) -------------------

app.post('/api/cluster/sign-url', async (req, res, next) => {
    const v = _peerHmacGate(req, res);
    if (!v) return;
    const { path: filePath, ttlSec = 60 } = req.body || {};
    if (!filePath) return res.status(400).json({ error: 'path required' });
    try {
        const row = getDb()
            .prepare('SELECT id FROM downloads WHERE file_path = ? LIMIT 1')
            .get(String(filePath));
        if (!row) return res.status(404).json({ error: 'file not catalogued' });
        // Mint an unauthenticated share-link (HMAC-signed url) — the
        // requesting peer's browser will fetch this directly. Reuse the
        // existing share infra so revocation + access counters stay one
        // unified source of truth.
        const expiresAt = Date.now() + Math.max(10, Math.min(3600, Number(ttlSec) || 60)) * 1000;
        const linkRow = createShareLink({
            downloadId: Number(row.id),
            expiresAt,
            label: `cluster:${v.peerId.slice(0, 8)}`,
        });
        const expSec = Math.floor(expiresAt / 1000);
        const baseUrl = (() => {
            const proto =
                req.headers['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http');
            const host = req.headers['x-forwarded-host'] || req.headers.host;
            return `${proto}://${host}`;
        })();
        res.set('Cache-Control', 'no-store').json({
            url: baseUrl + buildShareUrlPath(linkRow.id, expSec),
            expiresAt,
        });
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
});

// ---- Phase 7: dedup sweep --------------------------------------------

app.post('/api/cluster/sweep/run', (req, res) => {
    const minSize = Number(req.body?.minSize) || 1024;
    const r = tryStartSweep({ minSize });
    if (!r.started) {
        return res.status(409).json({
            started: false,
            code: 'ALREADY_RUNNING',
            snapshot: r.snapshot,
        });
    }
    res.json({ started: true });
});

app.get('/api/cluster/sweep/status', (_req, res) => {
    res.json(getSweepStatus());
});

app.post('/api/cluster/sweep/cancel', (_req, res) => {
    const ok = abortSweep();
    res.json({ ok });
});

app.get('/api/cluster/conflicts', (_req, res) => {
    res.json({ conflicts: listConflicts(), stats: getSweepStatus().stats });
});

app.post('/api/cluster/conflicts/:id/resolve', async (req, res) => {
    try {
        const id = req.params.id;
        const keep = req.body?.keep;
        const r = await resolveConflict(id, keep);
        res.json(r);
    } catch (e) {
        res.status(e?.status || 500).json({ error: e?.message || String(e) });
    }
});

// ---- Phase D (v2.10): relay-through-peer ------------------------------

app.post('/api/cluster/relay/proxy', async (req, res) => {
    const v = _peerHmacGate(req, res);
    if (!v) return;
    try {
        const { handleRelay } = await import('../core/cluster/relay.js');
        const upstream = await handleRelay({
            envelope: req.body || {},
            sourcePeerId: v.peerId,
        });
        // Pipe response status + body back. Headers we forward are limited
        // to the standard set — anything sensitive (Set-Cookie etc.) is
        // dropped at the relay boundary.
        res.status(upstream.status);
        for (const [k, val] of upstream.headers) {
            const lk = k.toLowerCase();
            if (
                lk === 'content-type' ||
                lk === 'content-length' ||
                lk === 'cache-control' ||
                lk === 'etag'
            ) {
                res.setHeader(k, val);
            }
        }
        const buf = Buffer.from(await upstream.arrayBuffer());
        res.end(buf);
    } catch (e) {
        res.status(e?.status || 500).json({ error: e?.message || String(e) });
    }
});

// ---- Phase G (v2.10): cross-peer file delete --------------------------

app.post('/api/cluster/files/delete', async (req, res) => {
    const v = _peerHmacGate(req, res);
    if (!v) return;
    const { file_path: filePath, remote_id: remoteId, reason = null } = req.body || {};
    try {
        let row;
        if (remoteId != null) {
            row = getDb()
                .prepare('SELECT id, file_path, file_size FROM downloads WHERE id = ?')
                .get(Number(remoteId));
        } else if (filePath) {
            row = getDb()
                .prepare(
                    'SELECT id, file_path, file_size FROM downloads WHERE file_path = ? LIMIT 1',
                )
                .get(String(filePath));
        }
        if (!row) {
            return res.status(404).json({ error: 'file not catalogued' });
        }
        const r = await safeResolveDownload(row.file_path);
        let freedBytes = 0;
        if (r.ok) {
            try {
                const { deferDelete } = await import('../core/deferred-delete.js');
                deferDelete(r.real);
                freedBytes = Number(row.file_size) || 0;
            } catch {
                try {
                    await fs.unlink(r.real);
                    freedBytes = Number(row.file_size) || 0;
                } catch {}
            }
        }
        const seekbarRow = getDb()
            .prepare('SELECT sprite_path, meta_path FROM seekbar_sprites WHERE download_id = ?')
            .get(Number(row.id));
        getDb().prepare('DELETE FROM downloads WHERE id = ?').run(Number(row.id));
        purgeThumbsForDownload(row.id).catch(() => {});
        purgeSeekbarForDownload(row.id, seekbarRow || undefined).catch(() => {});
        try {
            purgeOrphanPeople();
        } catch {}
        import('../core/deferred-delete.js').then((m) => m.startDrain()).catch(() => {});
        recordClusterAudit({
            kind: 'cross_delete',
            ok: true,
            peerId: v.peerId,
            detail: `${row.file_path} (reason=${reason || '-'})`,
        });
        // Tell paired peers the row is gone so their cache catches up.
        try {
            clusterWs.broadcastClusterEvent('download_deleted', { remote_id: row.id });
        } catch {
            /* nothing */
        }
        res.json({ deleted: true, freedBytes });
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
});

// ---- Phase I (v2.10): federated search ------------------------------

// HMAC peer-to-peer search. Returns matching local download rows.
app.get('/api/cluster/search/peer', (req, res) => {
    const v = _peerHmacGate(req, res);
    if (!v) return;
    const q = String(req.query.q || '').trim();
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    if (!q) return res.json({ rows: [] });
    try {
        const like = `%${q.replace(/[%_]/g, '\\$&')}%`;
        const rows = getDb()
            .prepare(
                `SELECT id, group_id, group_name, message_id, file_name, file_size, file_type,
                        file_path, file_hash, status, created_at, nsfw_score
                   FROM downloads
                  WHERE file_name LIKE ? ESCAPE '\\' OR group_name LIKE ? ESCAPE '\\'
                  ORDER BY created_at DESC
                  LIMIT ?`,
            )
            .all(like, like, limit);
        res.json({ rows, peerId: getSelfPeerId(), q });
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
});

// Admin cookie-authed cluster-wide search — fan-out, merge, dedup by hash.
app.get('/api/cluster/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    if (!q) return res.json({ rows: [] });
    try {
        const like = `%${q.replace(/[%_]/g, '\\$&')}%`;
        const ownPid = getSelfPeerId();
        const local = getDb()
            .prepare(
                `SELECT id, group_id, group_name, message_id, file_name, file_size, file_type,
                        file_path, file_hash, status, created_at, nsfw_score
                   FROM downloads
                  WHERE file_name LIKE ? ESCAPE '\\' OR group_name LIKE ? ESCAPE '\\'
                  ORDER BY created_at DESC LIMIT ?`,
            )
            .all(like, like, limit);
        const merged = local.map((r) => ({ ...r, peer_id: ownPid, peer_name: getSelfPeerName() }));

        // Fan-out to paired peers (online only).
        const peers = listPeers().filter((p) => p.status === 'online' && !!p.peerId);
        await Promise.allSettled(
            peers.map(async (p) => {
                try {
                    const path0 = `/api/cluster/search/peer?q=${encodeURIComponent(q)}&limit=${limit}`;
                    const headers = {
                        ...(await import('../core/cluster/hmac.js')).signRequest({
                            method: 'GET',
                            path: path0,
                            targetPeerId: p.peerId,
                        }),
                    };
                    const r = await fetch(p.url + path0, { method: 'GET', headers });
                    if (!r.ok) return;
                    const j = await r.json();
                    for (const row of j.rows || []) {
                        merged.push({ ...row, peer_id: p.peerId, peer_name: p.name });
                    }
                } catch {
                    /* peer offline / refused */
                }
            }),
        );
        // Dedup by file_hash (when present), keep first hit per hash.
        const seen = new Set();
        const dedup = [];
        for (const r of merged) {
            const k = r.file_hash || `${r.peer_id}:${r.id}`;
            if (seen.has(k)) continue;
            seen.add(k);
            dedup.push(r);
        }
        dedup.sort((a, b) => {
            const ta =
                typeof a.created_at === 'string' ? Date.parse(a.created_at) : Number(a.created_at);
            const tb =
                typeof b.created_at === 'string' ? Date.parse(b.created_at) : Number(b.created_at);
            return (tb || 0) - (ta || 0);
        });
        res.json({ rows: dedup, total: dedup.length });
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
});

// ---- Phase E (v2.10): failover audit + manual reassign ----------------

app.get('/api/cluster/failover-log', (req, res) => {
    try {
        const limit = Number(req.query.limit) || 100;
        const { listFailoverLog } = require('../core/db.js');
        res.json({ entries: listFailoverLog({ limit }) });
    } catch {
        try {
            // ESM dynamic import fallback
            import('../core/db.js').then((m) => {
                res.json({ entries: m.listFailoverLog({ limit: Number(req.query.limit) || 100 }) });
            });
        } catch (e) {
            res.status(500).json({ error: 'failover log unavailable' });
        }
    }
});

// ---- Phase K (v2.10): cluster stats ---------------------------------

app.get('/api/cluster/stats', async (_req, res) => {
    try {
        const { aggregateEgress } = await import('../core/db.js');
        const ownPid = getSelfPeerId();
        const peers = listPeers();
        const localBytes = (() => {
            try {
                return getDb()
                    .prepare('SELECT COALESCE(SUM(file_size),0) AS n FROM downloads')
                    .get().n;
            } catch {
                return 0;
            }
        })();
        const cachedBytes = peers.map((p) => {
            const n = getDb()
                .prepare(
                    'SELECT COALESCE(SUM(file_size),0) AS n FROM peer_downloads WHERE peer_id = ?',
                )
                .get(p.peerId).n;
            return { peerId: p.peerId, name: p.name, status: p.status, totalBytes: n };
        });
        const egress = aggregateEgress({ days: 30 });
        res.json({
            self: {
                peerId: ownPid,
                name: getSelfPeerName(),
                totalBytes: localBytes,
            },
            peers: cachedBytes,
            egress30d: egress,
        });
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
});

// Start the sync engine on first cluster route hit. It will poll every
// 30s; idempotent if already running.
let _clusterSyncStarted = false;
function _ensureSyncEngineStarted() {
    if (_clusterSyncStarted) return;
    _clusterSyncStarted = true;
    try {
        startSyncEngine({ intervalMs: 30_000 });
    } catch (e) {
        console.warn('[cluster] sync engine start failed:', e?.message || e);
    }
}
let _clusterDiscoveryStarted = false;
function _ensureClusterDiscoveryStarted() {
    if (_clusterDiscoveryStarted) return;
    _clusterDiscoveryStarted = true;
    try {
        const port = Number(process.env.PORT) || 3000;
        const proto = process.env.PUBLIC_PROTO || 'http';
        const host = process.env.PUBLIC_HOST || `localhost:${port}`;
        const selfUrl = process.env.PUBLIC_URL || `${proto}://${host}`;
        clusterDiscovery.startDiscovery({ selfUrl });
    } catch (e) {
        console.warn('[cluster] discovery start failed:', e?.message || e);
    }
}

let _clusterFailoverStarted = false;
function _ensureClusterFailoverStarted() {
    if (_clusterFailoverStarted) return;
    _clusterFailoverStarted = true;
    try {
        startFailoverWatcher();
    } catch (e) {
        console.warn('[cluster] failover watcher start failed:', e?.message || e);
    }
}

app.use('/api/cluster', (_req, _res, next) => {
    _ensureSyncEngineStarted();
    _ensureClusterWsInit();
    _ensureClusterDiscoveryStarted();
    _ensureClusterFailoverStarted();
    next();
});

// Manual failover sweep (admin) — useful when an operator wants to
// trigger reassignment immediately rather than wait for the 60s tick.
app.post('/api/cluster/failover/run', (_req, res) => {
    try {
        const applied = runFailoverPass();
        res.json({ applied });
    } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
    }
});

// Expose broadcast() globally for sweep.js (which can't import directly
// without creating a circular dep). One-line bridge.
global.__tgdlBroadcast =
    global.__tgdlBroadcast ||
    ((m) => {
        try {
            broadcast(m);
        } catch {
            /* nothing */
        }
    });

// ====== AI subsystem (v2.6+) ============================================
//
// Local-only image embeddings, face clustering, perceptual dedup, and auto-
// tagging. Default-OFF; every capability is opt-in via `config.advanced.ai`.
// All long-running scans go through the JobTracker pattern so they return
// 200 immediately and stream progress over WebSocket.
//
// Every route inside the router is wrapped in safe-route so an unhandled
// throw turns into a JSON error envelope instead of bringing down the
// dashboard via process.on('uncaughtException').

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

// List share-links. `?downloadId=…` filters to one file (Share sheet);
// no filter returns the most recent N links across the library
// (Maintenance sheet). Paginated via `?limit=500&offset=N&q=substring`
// so a library with 50 k+ active links doesn't blow the response body —
// the SPA renders one page at a time and the search filter runs server-
// side. See `CLAUDE.md → Big-data patterns` rule 1.
app.get('/api/share/links', async (req, res) => {
    try {
        const downloadId = req.query.downloadId ? parseInt(req.query.downloadId, 10) : null;
        const includeRevoked = req.query.includeRevoked !== '0';
        const limit = Math.max(1, Math.min(2000, parseInt(req.query.limit, 10) || 500));
        const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
        const search = typeof req.query.q === 'string' ? req.query.q : null;
        const rows = listShareLinks({ downloadId, includeRevoked, limit, offset, search });
        const total = countShareLinks({ downloadId, includeRevoked, search });
        res.json({
            success: true,
            links: rows.map((r) => _shareLinkPayload(req, r)),
            total,
            limit,
            offset,
            hasMore: offset + rows.length < total,
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
        // RFC 5987 — strip non-ASCII for the basic param, keep UTF-8 in filename*.
        const asciiLogName = String(name).replace(/[^\x20-\x7e]/g, '_');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="${asciiLogName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        );
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

        // Cluster namespace — match the deep-merge convention used for every
        // other top-level config section. Settings → Federation patches
        // `cluster.replicate.<key>` and `cluster.failover_grace_minutes`
        // independently; the panel currently reads full current cluster
        // before each save (client-side read-modify-write), but the server
        // contract should be defensive so a future caller that PATCHes just
        // one field doesn't accidentally erase the rest. Two-level merge:
        // top-level cluster keys are merged with current; `replicate` is
        // merged one level deeper so a single-key toggle preserves the rest
        // of the policy map.
        if (req.body.cluster && typeof req.body.cluster === 'object') {
            const curCluster = currentConfig.cluster || {};
            const incCluster = req.body.cluster;
            const merged = { ...curCluster, ...incCluster };
            if (incCluster.replicate && typeof incCluster.replicate === 'object') {
                merged.replicate = { ...(curCluster.replicate || {}), ...incCluster.replicate };
            }
            newConfig.cluster = merged;
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
                    const merged = { ...(cur.ai || {}), ...(inc.ai || {}) };
                    // Deep-merge the nested `faces` sub-block so a partial
                    // patch (e.g. `{faces:{epsilon:0.65}}` from the slider)
                    // doesn't wipe siblings like `providers`, `sidecarUrl`,
                    // `arRange`, etc. Without this, every slider tweak
                    // would reset the rest of the faces config to defaults
                    // on the next `_mergeAi` round.
                    if (inc.ai?.faces && typeof inc.ai.faces === 'object') {
                        merged.faces = {
                            ...((cur.ai || {}).faces || {}),
                            ...inc.ai.faces,
                        };
                    }
                    return merged;
                })(),
                // Seekbar subsystem — sprite-sheet generator for the video
                // hover preview. Mirrors the `nsfw`/`thumbs` shape: shallow
                // merge here, per-field clamp + allow-list below. Without
                // this branch, every POST /api/config that touches the
                // `advanced.*` block would silently drop `advanced.seekbar`
                // because `newConfig.advanced = merged` replaces the entire
                // namespace with whatever `merged` lists.
                seekbar: {
                    ...(cur.seekbar || {}),
                    ...(inc.seekbar || {}),
                },
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
            merged.thumbs.autoOnDownload = merged.thumbs.autoOnDownload !== false;
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
            h.backpressureCap = clampInt(h.backpressureCap, 10, 100000, BACKPRESSURE_CAP_DEFAULT);
            h.backpressureMaxWaitMs = clampInt(h.backpressureMaxWaitMs, 5000, 3600000, 900000);
            h.shortBreakEveryN = clampInt(h.shortBreakEveryN, 0, 100000, 100);
            h.longBreakEveryN = clampInt(h.longBreakEveryN, 0, 1000000, 1000);
            // Recent-backfills retention. Anything older than this gets
            // pruned at next read of kv['history_jobs']. 1-3650 days.
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
            ns.preload = ns.preload === true;
            ns.blocklistEnabled = ns.blocklistEnabled === true;
            // Threshold is on a 0-1 score axis; clamped via integer math by
            // multiplying through so the same clampInt helper works.
            const tInt = Math.round((Number(ns.threshold) || NSFW_DEFAULTS.threshold) * 1000);
            ns.threshold = clampInt(tInt, 100, 990, 600) / 1000;
            ns.concurrency = clampInt(ns.concurrency, 1, 4, NSFW_DEFAULTS.concurrency);
            ns.batchSize = clampInt(ns.batchSize, 10, 500, NSFW_DEFAULTS.batchSize);
            ns.videoMaxTiles = clampInt(ns.videoMaxTiles, 3, 200, NSFW_DEFAULTS.videoMaxTiles);
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

            // AI subsystem (semantic search + auto-tag + face clustering).
            // All values are config-driven — same posture as NSFW. Master
            // switch defaults OFF; sub-feature toggles default ON so once
            // an operator flips master to true they get all three out of
            // the box.
            const ai = merged.ai;
            ai.enabled = ai.enabled === true;
            ai.semanticSearch = ai.semanticSearch !== false;
            ai.autoTags = ai.autoTags !== false;
            ai.faceClustering = ai.faceClustering !== false;
            ai.model =
                typeof ai.model === 'string' && ai.model.trim()
                    ? ai.model.trim()
                    : 'Xenova/clip-vit-base-patch32';
            // Per-capability overrides — string only, empty = inherit
            // from the master `model`. Trimmed; never auto-filled so the
            // UI can render an empty field as "inherit".
            for (const k of ['searchModel', 'tagsModel', 'facesModel']) {
                ai[k] = typeof ai[k] === 'string' ? ai[k].trim() : '';
            }
            const AI_DTYPES = new Set(['q8', 'fp16', 'fp32', 'q4']);
            const aiDIn = String(ai.dtype || '')
                .toLowerCase()
                .trim();
            ai.dtype = AI_DTYPES.has(aiDIn) ? aiDIn : 'q8';
            ai.indexConcurrency = clampInt(ai.indexConcurrency, 1, 4, 1);
            ai.batchSize = clampInt(ai.batchSize, 1, 200, 16);
            ai.maxTagsPerImage = clampInt(ai.maxTagsPerImage, 1, 20, 5);
            // tagsMode allow-list — anything off-list snaps back to 'auto'.
            const TAGS_MODES = new Set(['auto', 'zero-shot', 'classifier']);
            ai.tagsMode = TAGS_MODES.has(String(ai.tagsMode || '').toLowerCase())
                ? String(ai.tagsMode).toLowerCase()
                : 'auto';
            // Float clamps via integer round-trip so the same helper applies.
            ai.minTagScore =
                clampInt(Math.round((Number(ai.minTagScore) || 0.2) * 1000), 0, 1000, 200) / 1000;
            ai.facesEpsilon =
                clampInt(Math.round((Number(ai.facesEpsilon) || 1.05) * 1000), 100, 1500, 1050) /
                1000;
            ai.facesMinPoints = clampInt(ai.facesMinPoints, 2, 50, 2);
            const AI_FILE_TYPES = ['photo'];
            ai.fileTypes = (Array.isArray(ai.fileTypes) ? ai.fileTypes : ['photo'])
                .map((s) => String(s).toLowerCase())
                .filter((s) => AI_FILE_TYPES.includes(s));
            if (!ai.fileTypes.length) ai.fileTypes = ['photo'];
            // Tag labels — strip non-strings + dedup. Cap at 200 so a
            // pasted thesaurus can't blow up tokenizer batch size.
            ai.tagLabels = (Array.isArray(ai.tagLabels) ? ai.tagLabels : [])
                .map((s) => String(s).trim())
                .filter(Boolean);
            ai.tagLabels = [...new Set(ai.tagLabels)].slice(0, 200);
            if (!ai.tagLabels.length) {
                // Fall back to the default list if the operator wiped it
                // — saving an empty list would otherwise silently disable
                // tagging until they edited config again.
                ai.tagLabels = [
                    'portrait',
                    'landscape',
                    'group_photo',
                    'selfie',
                    'food',
                    'document',
                    'screenshot',
                    'meme',
                    'logo',
                    'indoor',
                    'outdoor',
                    'animal',
                    'pet',
                    'vehicle',
                    'building',
                    'art',
                    'text',
                ];
            }
            // hfToken — string only; trim. Empty string = no token, which
            // is the recommended default (every model is public).
            ai.hfToken = typeof ai.hfToken === 'string' ? ai.hfToken.trim().slice(0, 200) : '';
            // federateFaces — explicit opt-in only (biometric data).
            ai.federateFaces = ai.federateFaces === true;
            // facesDetector allow-list — 'tiny' (default) or 'ssd'.
            const FACE_DETECTORS = new Set(['tiny', 'ssd']);
            ai.facesDetector = FACE_DETECTORS.has(String(ai.facesDetector || '').toLowerCase())
                ? String(ai.facesDetector).toLowerCase()
                : 'tiny';
            // autoScan state machine — allow-list keeps the timer logic
            // simple. Old boolean values get migrated:
            //   true  → 'running'
            //   false → 'idle'
            const AUTO_SCAN_STATES = new Set(['idle', 'running', 'paused']);
            const rawAutoScan =
                ai.autoScan === true
                    ? 'running'
                    : ai.autoScan === false
                      ? 'idle'
                      : String(ai.autoScan || 'idle').toLowerCase();
            ai.autoScan = AUTO_SCAN_STATES.has(rawAutoScan) ? rawAutoScan : 'idle';
            ai.autoScanIntervalMs = clampInt(ai.autoScanIntervalMs, 5_000, 3_600_000, 60_000);
            ai.autoScanBatchSize = clampInt(ai.autoScanBatchSize, 1, 200, 10);
            ai.autoScanQueueCeiling = clampInt(ai.autoScanQueueCeiling, 1, 200, 50);

            const r = merged.diskRotator;
            r.sweepBatch = clampInt(r.sweepBatch, 1, 1000, 50);
            r.maxDeletesPerSweep = clampInt(r.maxDeletesPerSweep, 1, 100000, 5000);

            const it = merged.integrity;
            it.intervalMin = clampInt(it.intervalMin, 1, 10080, 60);
            it.batchSize = clampInt(it.batchSize, 1, 1024, 64);

            const w = merged.web;
            w.sessionTtlDays = clampInt(w.sessionTtlDays, 1, 365, 30);

            // Seekbar sprite-sheet generator. Every knob clamps to a safe
            // range so a hand-edited config can't OOM the Go sidecar
            // (maxTiles=10000) or DoS ffmpeg (concurrency=64). format +
            // hwaccel are allow-lists; everything off-list snaps back to
            // the documented default. Empty string for hwaccel = inherit
            // from advanced.thumbs.hwaccel (resolved inside core/seekbar/
            // generator.js so the SPA doesn't need to know).
            const sk = merged.seekbar;
            // Master + auto switches — boolean coercion mirrors the AI /
            // NSFW pattern. Default ON because the feature ships dark by
            // default at the sidecar level (binary needs to download).
            sk.enabled = sk.enabled !== false;
            sk.autoOnDownload = sk.autoOnDownload !== false;
            sk.intervalSec = clampInt(sk.intervalSec, 1, 60, 4);
            sk.tileWidth = clampInt(sk.tileWidth, 64, 480, 160);
            sk.columns = clampInt(sk.columns, 2, 30, 10);
            sk.maxTiles = clampInt(sk.maxTiles, 12, 1000, 240);
            sk.quality = clampInt(sk.quality, 10, 100, 75);
            sk.concurrency = clampInt(sk.concurrency, 1, 16, 4);
            sk.maxRetries = clampInt(sk.maxRetries, 0, 10, 3);
            const SEEKBAR_FORMATS = new Set(['webp', 'jpeg']);
            const fmtIn = String(sk.format || '')
                .toLowerCase()
                .trim();
            sk.format = SEEKBAR_FORMATS.has(fmtIn) ? fmtIn : 'webp';
            const SEEKBAR_OVERWRITE = new Set(['never', 'if-changed', 'always']);
            const owIn = String(sk.overwrite || '')
                .toLowerCase()
                .trim();
            sk.overwrite = SEEKBAR_OVERWRITE.has(owIn) ? owIn : 'if-changed';
            // Same allow-list as `advanced.thumbs.hwaccel` plus the
            // platform-extra backends the Go sidecar supports. `''` means
            // "inherit from thumbs"; `'none'` is an explicit CPU-only
            // override that the generator forwards as no `-hwaccel` flag.
            const SEEKBAR_HWACCEL = new Set([
                '',
                'auto',
                'none',
                'cuda',
                'vaapi',
                'qsv',
                'd3d11va',
                'dxva2',
                'videotoolbox',
                'v4l2m2m',
            ]);
            const skHw = String(sk.hwaccel ?? '')
                .toLowerCase()
                .trim();
            sk.hwaccel = SEEKBAR_HWACCEL.has(skHw) ? skHw || null : null;
            // sidecarUrl / apiToken — string only, trimmed; empty = use
            // the auto-spawned local binary. We never leak the token
            // back in GET /api/config (`_sanitizeConfigForRead` redacts
            // it alongside the dashboard passwordHash).
            sk.sidecarUrl = typeof sk.sidecarUrl === 'string' ? sk.sidecarUrl.trim() : '';
            sk.apiToken = typeof sk.apiToken === 'string' ? sk.apiToken.trim().slice(0, 256) : '';

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

        // Persist to kv['config'] via the same writer every other endpoint
        // uses. The legacy file-write here pre-dates the JSON→SQLite migration
        // and bypassed loadConfig()'s storage backend, so saves silently drifted
        // from the live row and got archived to config.json.migrated on the
        // next boot's state-migration sweep — the symptom users reported as
        // "settings don't save on Docker".
        await writeConfigAtomic(newConfig);
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
                const cfg = newConfig?.advanced?.integrity || {};
                integrity.start({
                    broadcast,
                    intervalMin: Number(cfg.intervalMin) > 0 ? Number(cfg.intervalMin) : 60,
                    batchSize: Number(cfg.batchSize) > 0 ? Number(cfg.batchSize) : 64,
                });
            } catch (e) {
                console.warn('[integrity] restart failed:', e.message);
            }
        }

        // Seekbar sidecar — runtime knobs (concurrency, hwaccel, format,
        // tileWidth, etc.) are forwarded as env vars when the Go process
        // spawns. So when an operator tweaks those on the Maintenance →
        // Seekbar page, we need to relaunch the sidecar so the new values
        // take effect — otherwise the next sprite would be generated with
        // the *previous* boot's env. URL / token changes also need a fresh
        // connect because client.js caches them at module scope.
        // Fire-and-forget: the dashboard pill flips through `stopped` →
        // `starting` → `running` as the sidecar comes back up; the GET
        // /api/maintenance/seekbar/health endpoint surfaces the live mode
        // either way.
        if (req.body.advanced?.seekbar) {
            try {
                refreshSeekbarSidecar().catch((e) =>
                    console.warn(
                        '[seekbar-sidecar] config-change refresh failed:',
                        e?.message || e,
                    ),
                );
            } catch (e) {
                console.warn('[seekbar-sidecar] config-change refresh threw:', e?.message || e);
            }
            // Broadcast so any open `/maintenance/seekbar` page can
            // refresh its System Health card + KPI strip without waiting
            // for the operator to click Refresh.
            try {
                broadcast({ type: 'seekbar_config_changed' });
            } catch {}
        }

        // Faces sidecar — push config changes to the running sidecar immediately.
        // Soft-apply (timeouts, concurrency, quality thresholds) takes effect
        // without a restart. Hard-apply (model, provider, enable/disable) requires
        // a full sidecar restart because these are baked into the spawned process.
        if (req.body.advanced?.ai !== undefined) {
            try {
                const [facesSpawnMod, facesClientMod, facesConfigMod] = await Promise.all([
                    import('../core/ai/faces-spawn.js').catch(() => null),
                    import('../core/ai/faces-client.js').catch(() => null),
                    import('../core/ai/faces-config.js').catch(() => null),
                ]);
                if (facesClientMod && facesConfigMod) {
                    const freshCfg = loadConfig();
                    const freshFaces = freshCfg.advanced?.ai?.faces || {};
                    const resolved = facesConfigMod.resolveAllFaces(freshFaces);
                    // Soft-apply: push runtime knobs (timeouts, concurrency, etc.)
                    // to the live client without restarting the process.
                    try {
                        facesClientMod.applyFacesCfg(resolved);
                    } catch {}
                }
                // Hard-restart when the operator changes something that requires
                // a new process: model pack, inference provider, or the master
                // enable/disable toggle. We compare against the incoming body
                // rather than the merged config so a no-op save doesn't restart.
                const bodyAi = req.body.advanced.ai || {};
                const bodyFaces = bodyAi.faces || {};
                const needsRestart =
                    bodyFaces.detectorModel !== undefined ||
                    bodyFaces.providers !== undefined ||
                    bodyFaces.backend !== undefined ||
                    bodyAi.faceClustering !== undefined;
                if (needsRestart && facesSpawnMod) {
                    facesSpawnMod.stopSidecar();
                    facesSpawnMod
                        .startSidecar()
                        .catch((e) =>
                            console.warn(
                                '[faces-sidecar] config-change restart failed:',
                                e?.message || e,
                            ),
                        );
                }
                broadcast({ type: 'ai_config_changed' });
            } catch (e) {
                console.warn('[faces-sidecar] config-change apply threw:', e?.message || e);
            }
        }

        // Re-init NSFW sidecar when the URL changes.
        if (req.body.advanced?.nsfw?.sidecarUrl !== undefined) {
            try {
                initNsfwSidecar(loadConfig());
            } catch {}
        }

        // Invalidate the dialogs response cache so the next /api/dialogs hit
        // rebuilds `inConfig` from the freshly-saved config. Without this,
        // adding a group via POST /api/config keeps showing the dialog as
        // "not in config" (and absent from the Monitored Only tab) for up
        // to DIALOG_CACHE_TTL_MS — the operator sees their group on the
        // sidebar but not in the picker filter.
        _dialogsResponseCache = { at: 0, body: null };
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
        if (group.suspended === true && req.body.enabled === true) {
            return res.status(403).json({
                error: 'Cannot re-enable a suspended group — the channel/group was deleted or banned on Telegram',
                code: 'GROUP_SUSPENDED',
            });
        }
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

        // Cluster routing — per-group owner / backup peer. Read by
        // src/core/cluster/router.js + failover.js. Empty string clears.
        // Server doesn't validate that the peer exists; an unknown id
        // simply means failover.js logs "owner offline" forever, which
        // matches the existing behaviour for a peer that's been revoked.
        if (req.body.ownerPeerId !== undefined) {
            if (!req.body.ownerPeerId) delete group.ownerPeerId;
            else group.ownerPeerId = String(req.body.ownerPeerId);
        }
        if (req.body.backupPeerId !== undefined) {
            if (!req.body.backupPeerId) delete group.backupPeerId;
            else group.backupPeerId = String(req.body.backupPeerId);
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
        // Drop the dialogs response cache so the picker filter re-derives
        // `inConfig` for the just-added/updated group. Otherwise the
        // "Monitored Only" tab keeps the group hidden for up to
        // DIALOG_CACHE_TTL_MS even though it's now in config.
        _dialogsResponseCache = { at: 0, body: null };
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
        limit === null || limit === 0
            ? null
            : Math.max(1, Math.min(BACKFILL_MAX_LIMIT, Number(limit) || 100));
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
    const onProgress = (s) => {
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
    };
    const onStart = (s) => {
        if (s?.mode) job.mode = s.mode;
    };
    history.on('progress', onProgress);
    history.on('start', onStart);
    const _cleanupListeners = () => {
        history.off('progress', onProgress);
        history.off('start', onStart);
    };
    history
        .downloadHistory(groupKey, { limit: lim ?? undefined, mode })
        .then(() => {
            _cleanupListeners();
            job.state = job.cancelled ? 'cancelled' : 'done';
            job.finishedAt = Date.now();
            delete job._runner;
            const evt = job.cancelled ? 'history_cancelled' : 'history_done';
            broadcast({ type: evt, jobId, group: group.name, ...job });
            if (standalone) downloader.stop().catch(() => {});
            saveHistoryJobsToStore();
            if (_activeBackfillsByGroup.get(groupKey) === jobId)
                _activeBackfillsByGroup.delete(groupKey);
            setTimeout(() => _historyJobs.delete(jobId), HISTORY_JOB_TTL_MS);
        })
        .catch((err) => {
            _cleanupListeners();
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
            saveHistoryJobsToStore();
            if (_activeBackfillsByGroup.get(groupKey) === jobId)
                _activeBackfillsByGroup.delete(groupKey);
        });
    return jobId;
}

// 9. Profile Photos
app.get('/api/groups/:id/photo', async (req, res) => {
    let id = req.params.id;
    // Synthetic IDs from `reindexFromDisk` (`unknown:<sanitisedFolderName>`)
    // carry no Telegram entity directly. Resolve them to a numeric ID by
    // matching the folder name against the live dialogs cache (the user's
    // own joined chats) — `sanitizeName(entity.title) === folderName` is
    // the same transform the downloader uses when bucketing files into
    // <group_name>/ folders, so the round-trip works on every chat the
    // active accounts can see. The photo bytes for the real entity are
    // then served and ALSO copied to a safe filename keyed by the
    // synthetic id, so subsequent hits skip the resolve loop.
    if (typeof id === 'string' && id.startsWith('unknown:')) {
        const folderName = id.slice('unknown:'.length);
        const safeKey = id.replace(/[^A-Za-z0-9_.-]/g, '_');
        const synthPath = path.join(PHOTOS_DIR, `${safeKey}.jpg`);
        if (existsSync(synthPath)) {
            res.setHeader('Cache-Control', 'private, max-age=86400, stale-while-revalidate=604800');
            return res.sendFile(synthPath);
        }
        try {
            const byId = await getDialogsNameCache();
            let matchId = null;
            for (const [nid, name] of byId) {
                if (sanitizeName(name) === folderName) {
                    matchId = nid;
                    break;
                }
            }
            if (matchId) {
                const safeMatchId = String(matchId).replace(/[^A-Za-z0-9_.-]/g, '_');
                const numericPath = path.join(PHOTOS_DIR, `${safeMatchId}.jpg`);
                if (!existsSync(numericPath)) await downloadProfilePhoto(matchId);
                if (existsSync(numericPath)) {
                    try {
                        await fs.copyFile(numericPath, synthPath);
                    } catch {}
                    res.setHeader(
                        'Cache-Control',
                        'private, max-age=86400, stale-while-revalidate=604800',
                    );
                    return res.sendFile(numericPath);
                }
            }
        } catch {
            /* fall through to 404 */
        }
        return res.status(404).send('No photo for synthetic group id');
    }
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
                .prepare('SELECT DISTINCT group_id, group_name FROM downloads LIMIT 10000')
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
                        const matchIds = db
                            .prepare(
                                'SELECT id FROM downloads WHERE file_path = ? OR file_path = ?',
                            )
                            .all(fwd, bwd)
                            .map((r) => r.id);
                        if (!matchIds.length) return;
                        const seekbarMap = collectSeekbarPaths(matchIds);
                        const result = db
                            .prepare(`DELETE FROM downloads WHERE file_path = ? OR file_path = ?`)
                            .run(fwd, bwd);
                        if (result.changes > 0) {
                            for (const id of matchIds) {
                                purgeThumbsForDownload(id).catch(() => {});
                                purgeSeekbarForDownload(id, seekbarMap.get(id)).catch(() => {});
                            }
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

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

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
    for (const client of Array.from(clients)) {
        if (client.readyState === 1) client.send(message);
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
    // AI subsystem — three independent scans owned by the same page.
    // Event prefixes match the WS contract used by maintenance-ai.js:
    // ai_index_progress / ai_index_done, ai_tags_*, ai_people_*.
    aiIndex: createJobTracker({ kind: 'aiIndex', broadcast, log, eventPrefix: 'ai_index' }),
    aiTags: createJobTracker({ kind: 'aiTags', broadcast, log, eventPrefix: 'ai_tags' }),
    aiPeople: createJobTracker({ kind: 'aiPeople', broadcast, log, eventPrefix: 'ai_people' }),
    qualityBackfill: createJobTracker({
        kind: 'qualityBackfill',
        broadcast,
        log,
        eventPrefix: 'quality_backfill',
    }),
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

    // Register the blocklist auto-delete callback so background deletes are
    // visible in the realtime log and cause the downloads UI to remove the row.
    nsfwSetBlocklistDeleteCallback((id, seekbarRow, dlRow) => {
        try {
            broadcast({ type: 'bulk_delete', count: 1 });
            const jobKey =
                dlRow?.group_id && dlRow?.message_id
                    ? `${dlRow.group_id}:${dlRow.message_id}:${dlRow.media_type || 'photo'}`
                    : null;
            broadcast({ type: 'nsfw_blocklist_deleted', id, key: jobKey });
        } catch {}
        try {
            log({ source: 'nsfw', level: 'info', msg: `blocklist: auto-deleted id=${id}` });
        } catch {}
        purgeThumbsForDownload(id).catch(() => {});
        purgeSeekbarForDownload(id, seekbarRow || undefined).catch(() => {});
        try {
            purgeOrphanPeople();
        } catch {}
    });

    // Init NSFW sidecar URL from config + env before any scan/preload.
    try {
        initNsfwSidecar(loadConfig());
    } catch (e) {
        console.warn('[nsfw] initNsfwSidecar failed:', e.message);
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

    // Purge orphaned .part files left by crashed downloads. Runs before
    // monitor start so no active downloads can be in flight. The monitor
    // catch-up will re-discover and re-download the original messages.
    try {
        const dlDir = getDownloadsDir();
        let purged = 0;
        const groups = await fs.readdir(dlDir, { withFileTypes: true }).catch(() => []);
        for (const gd of groups) {
            if (!gd.isDirectory() || gd.name === '.deleted') continue;
            const groupPath = path.join(dlDir, gd.name);
            const subs = await fs.readdir(groupPath, { withFileTypes: true }).catch(() => []);
            for (const sub of subs) {
                if (sub.isDirectory()) {
                    const typePath = path.join(groupPath, sub.name);
                    const files = await fs.readdir(typePath).catch(() => []);
                    for (const f of files) {
                        if (f.endsWith('.part')) {
                            try {
                                await fs.unlink(path.join(typePath, f));
                                purged++;
                            } catch {}
                        }
                    }
                } else if (sub.name.endsWith('.part')) {
                    try {
                        await fs.unlink(path.join(groupPath, sub.name));
                        purged++;
                    } catch {}
                }
            }
        }
        if (purged) console.log(`[startup] purged ${purged} orphaned .part file(s)`);
    } catch (e) {
        console.warn('[startup] .part cleanup failed:', e.message);
    }

    // Drain leftover deferred-deleted files from a previous crash/restart.
    try {
        const { hasLeftovers, startDrain } = await import('../core/deferred-delete.js');
        if (hasLeftovers()) {
            console.log('[startup] draining leftover .deleted files');
            startDrain().catch(() => {});
        }
    } catch {}

    // Resume the realtime monitor if it was running before the last
    // shutdown. The start/stop endpoints persist monitor.autoStart to
    // config so the flag reflects the operator's last intent — graceful
    // shutdown does NOT clear it.
    try {
        const cfg = loadConfig();
        const autoStart = cfg.monitor?.autoStart === true;
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

    // Auto-resume interrupted scans. When a scan/build was running and
    // the server restarted (update, crash, manual restart), the kv flag
    // persists. Re-trigger the same job so it picks up where it left off.
    // Each scan is idempotent — already-processed rows are skipped.
    setTimeout(async () => {
        try {
            if (kvGet('pending_job_thumbsBuild')) {
                const kind = kvGet('pending_job_thumbsBuild')?.kind || 'all';
                console.log(`[auto-resume] resuming thumbs build (kind=${kind})`);
                _jobTrackers.thumbsBuild.tryStart(async ({ onProgress, signal }) => {
                    try {
                        kvSet('pending_job_thumbsBuild', { startedAt: Date.now(), kind });
                    } catch {}
                    const result = await buildAllThumbnails({
                        kind,
                        onProgress: (p) => onProgress({ ...p, kind }),
                        signal,
                    });
                    try {
                        kvSet('pending_job_thumbsBuild', null);
                    } catch {}
                    try {
                        kvSet('thumbs_last_build', { finishedAt: Date.now(), kind, ...result });
                    } catch {}
                    return { ...result, kind };
                });
            }
            if (kvGet('pending_job_seekbarBuild')) {
                console.log('[auto-resume] resuming seekbar build');
                _jobTrackers.seekbarBuild.tryStart(async ({ onProgress, signal }) => {
                    try {
                        kvSet('pending_job_seekbarBuild', { startedAt: Date.now() });
                    } catch {}
                    const result = await buildAllSeekbar({ onProgress, signal });
                    try {
                        kvSet('pending_job_seekbarBuild', null);
                    } catch {}
                    try {
                        kvSet('seekbar_last_build', { finishedAt: Date.now(), ...result });
                    } catch {}
                    return result;
                });
            }
            if (kvGet('pending_job_nsfwScan')) {
                const nsfwCfg = _nsfwCfg();
                if (nsfwCfg.enabled) {
                    console.log('[auto-resume] resuming NSFW scan');
                    nsfwStartScan(
                        nsfwCfg,
                        (p) => {
                            try {
                                broadcast({ type: 'nsfw_progress', ...p });
                            } catch {}
                        },
                        (p) => {
                            try {
                                kvSet('pending_job_nsfwScan', null);
                            } catch {}
                            try {
                                broadcast({ type: 'nsfw_done', ...p });
                            } catch {}
                        },
                        (entry) => log(entry),
                    ).catch(() => {});
                } else {
                    kvSet('pending_job_nsfwScan', null);
                }
            }
            if (kvGet('pending_job_ai_faces')) {
                const aiCfg = _aiCfg();
                if (aiCfg.enabled) {
                    console.log('[auto-resume] resuming AI faces scan');
                    const tracker = _aiTrackerFor('faces');
                    tracker.tryStart(({ onProgress, signal }) => {
                        try {
                            kvSet('pending_job_ai_faces', { startedAt: Date.now() });
                        } catch {}
                        return new Promise((resolve, reject) => {
                            if (signal?.addEventListener)
                                signal.addEventListener('abort', () => {
                                    try {
                                        aiCancelScan('faces');
                                    } catch {}
                                });
                            aiStartFacesScan(
                                aiCfg,
                                (p) => {
                                    try {
                                        onProgress(p);
                                    } catch {}
                                },
                                (p) => {
                                    try {
                                        kvSet('pending_job_ai_faces', null);
                                    } catch {}
                                    if (p?.error) reject(new Error(p.error));
                                    else resolve(p || {});
                                },
                                (entry) => log(entry),
                            );
                        });
                    });
                } else {
                    kvSet('pending_job_ai_faces', null);
                }
            }
        } catch (e) {
            console.warn('[auto-resume] error:', e.message);
        }
    }, 5000);
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
