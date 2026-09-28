/**
 * gzip / deflate / br for the dashboard's text responses (HTML / JS / CSS /
 * JSON / SVG) — the SPA bundle and the big JSON lists (gallery pages,
 * queue snapshot) shrink 5-10× on the phone links most operators use.
 * WebSocket frames never pass through here (upgrades bypass Express).
 */
import compression from 'compression';

// Raw file bytes — downloads, share links, avatars, the peer file bridge.
// Served with Range support (the video player issues many 206 requests);
// compressing them would break byte ranges and burn CPU for nothing.
const NO_COMPRESS_PREFIXES = ['/files/', '/share/', '/photos/', '/api/cluster/files/'];

/**
 * @param {import('http').IncomingMessage & { originalUrl?: string }} req
 * @param {import('http').ServerResponse} res
 * @returns {boolean}
 */
export function shouldCompress(req, res) {
    if (req.headers['x-no-compression']) return false;
    if (req.headers.range) return false;
    // originalUrl, not path: mounted handlers (`app.use('/files', …)`)
    // strip the mount prefix from req.url while they run.
    const url = req.originalUrl || req.url || '';
    if (NO_COMPRESS_PREFIXES.some((p) => url.startsWith(p))) return false;
    // Already-compressed media — gzipping a JPEG or MP4 burns CPU for a
    // fraction of a percent of size win.
    const ct = String(res.getHeader('Content-Type') || '');
    if (/^(image|video|audio)\//i.test(ct)) return false;
    return compression.filter(req, res);
}

/**
 * Parse `COMPRESSION_LEVEL` (0-9; default 6, the package default). 0 means
 * "off" — the caller skips mounting the middleware.
 */
export function compressionLevelFromEnv(raw) {
    const lvl = parseInt(raw, 10);
    return Number.isFinite(lvl) && lvl >= 0 && lvl <= 9 ? lvl : 6;
}

/** Express middleware, or null when `level` is 0 (disabled). */
export function createCompression(level) {
    if (!(level > 0)) return null;
    return compression({ level, filter: shouldCompress });
}
