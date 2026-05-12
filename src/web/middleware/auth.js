import { readConfigSafe } from '../lib/config-cache.js';
import { isAuthConfigured, validateSession } from '../../core/web-auth.js';

// Paths reachable without an authenticated session.
// PWA bits must be reachable pre-login — the browser fetches them before
// the user has a session cookie.
export const PUBLIC_PATH_PREFIXES = [
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
    // the handler, NOT the dashboard cookie.
    '/share/',
];

export const PUBLIC_API_PATHS = new Set([
    '/api/login',
    '/api/auth_check',
    '/api/version', // public so the status-bar chip can render pre-login
    '/api/version/check', // public update-check (GitHub releases poll, cached)
    '/api/auth/setup', // first-run only — guarded inside the handler
    '/api/auth/reset/request', // logs token to stdout — no body returned
    '/api/auth/reset/confirm', // requires the stdout token + new password
    // Cluster peer-to-peer endpoints — HMAC-authenticated inside the handler.
    '/api/cluster/handshake',
    '/api/cluster/health',
    '/api/cluster/downloads/since',
    '/api/cluster/groups/snapshot',
    '/api/cluster/accounts/snapshot',
    '/api/cluster/sign-url',
    '/api/cluster/relay/proxy',
    '/api/cluster/files/delete',
    '/api/cluster/search/peer',
]);

// Cluster file-bridge paths are variable so they need prefix-matching.
export const CLUSTER_PREFIX_HMAC_ONLY = ['/api/cluster/files/', '/api/cluster/peer-thumbs/'];

// Treat connections from the local machine as "trusted enough" to bootstrap
// the very first password without prior auth.
export function isLocalRequest(req) {
    const ip = req.ip || req.socket?.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

export function isPublicPath(p) {
    if (PUBLIC_API_PATHS.has(p)) return true;
    if (CLUSTER_PREFIX_HMAC_ONLY.some((pre) => p.startsWith(pre))) return true;
    return PUBLIC_PATH_PREFIXES.some((pre) => p === pre || p.startsWith(pre));
}

export async function checkAuth(req, res, next) {
    const config = await readConfigSafe();
    const enabled = config.web?.enabled !== false;

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

// Default-deny: guest sessions can ONLY hit the explicit allowlist below.
// Intentionally a chokepoint — a future dev who adds a new mutation route
// gets admin-gating for free without remembering to add requireAdmin().
const GUEST_GET_ALLOW = [
    '/api/auth_check',
    '/api/me',
    '/api/version',
    '/api/version/check',
    '/api/downloads',
    '/api/groups',
    '/api/stats',
    '/api/thumbs',
    '/api/seekbar/sprite',
    '/api/seekbar/meta',
];
const GUEST_OTHER_ALLOW = new Set(['POST /api/logout']);

function isGuestAllowed(req) {
    // The middleware is mounted at `/api`, so req.path is RELATIVE to the
    // mount point. Read the full path from req.baseUrl + req.path.
    const fullPath = (req.baseUrl || '') + req.path;
    if (req.method === 'GET') {
        return GUEST_GET_ALLOW.some((pre) => fullPath === pre || fullPath.startsWith(pre + '/'));
    }
    return GUEST_OTHER_ALLOW.has(`${req.method} ${fullPath}`);
}

export function guestGate(req, res, next) {
    if (req.role === 'admin') return next();
    if (req.role === 'guest' && isGuestAllowed(req)) return next();
    if (req.role === 'guest') {
        return res.status(403).json({ error: 'Admin only', adminRequired: true });
    }
    return next();
}

// Simple cookie parser middleware — populates req.cookies.
export function cookieParser(req, res, next) {
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
}
