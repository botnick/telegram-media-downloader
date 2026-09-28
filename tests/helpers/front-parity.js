// Front-server parity: one list of requests, run against the app, compared
// with the responses Node gave before the Go front server existed.
//
// tests/fixtures/front-parity.json holds those responses (status, headers,
// body SHA-256). It was captured from v2.28 (Node answering on PORT itself)
// with `node scripts/front-parity.js capture`, against a data directory
// seeded by front-parity-seed.js. tests/front-parity.e2e.test.js replays the
// same list through the Go front server and compares.
//
// What is normalised (see normalize()):
//   - `Date`, the `Expires=` of a Set-Cookie, and header-name case (HTTP
//     header names are case-insensitive; Go writes canonical case);
//   - per case, `volatile` headers / bodies whose value depends on the
//     clock or on files outside the seed (a thumbnail generated during the
//     run, the SPA bundle, the package version).
// Everything else — status, every other header value, body bytes — must
// be identical.

import crypto from 'crypto';
import http from 'http';
import net from 'net';

// ---- seed ------------------------------------------------------------------

export const PARITY_MTIME_MS = Date.UTC(2024, 4, 6, 7, 8, 9, 123);
export const PARITY_PASSWORD = 'parity-password-123';
export const PARITY_SHARE_SECRET =
    'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

export const PARITY_JPEG = Buffer.from(
    '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAMABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCQAIqQ/9k=',
    'base64',
);

function pattern(n, mul = 31, mod = 251) {
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = (i * mul + (i >> 8)) % mod;
    return b;
}

export const UNICODE_NAME = 'ünï 名 photo.jpg';
export const CLIP_SIZE = 262_144;

/** Files written by the seed: `dir` is relative to the data dir. */
export const PARITY_FILES = [
    { dir: 'downloads', rel: 'G1/videos/clip.mp4', bytes: () => pattern(CLIP_SIZE) },
    { dir: 'downloads', rel: 'G1/videos/movie.mkv', bytes: () => pattern(4096, 7) },
    { dir: 'downloads', rel: 'G1/videos/v.webm', bytes: () => pattern(1000, 13) },
    { dir: 'downloads', rel: 'G1/images/pic.jpg', bytes: () => PARITY_JPEG },
    { dir: 'downloads', rel: `G1/images/${UNICODE_NAME}`, bytes: () => PARITY_JPEG },
    {
        dir: 'downloads',
        rel: 'G1/images/photo.heic',
        bytes: () => Buffer.from('not really heic\n'),
    },
    { dir: 'downloads', rel: 'G1/audio/voice.opus', bytes: () => pattern(777, 3) },
    {
        dir: 'downloads',
        rel: 'G1/docs/page.html',
        bytes: () => Buffer.from('<!doctype html><title>x</title><script>alert(1)</script>\n'),
    },
    { dir: 'downloads', rel: 'G1/docs/.hidden.txt', bytes: () => Buffer.from('dotfile\n') },
    { dir: 'downloads', rel: 'G1/docs/empty.bin', bytes: () => Buffer.alloc(0) },
    { dir: 'downloads', rel: 'G1/docs/notes.txt', bytes: () => Buffer.from('plain text\n') },
    { dir: 'photos', rel: '-100123.jpg', bytes: () => PARITY_JPEG },
    { dir: 'photos', rel: '42.jpg', bytes: () => PARITY_JPEG },
];

/** downloads rows; ids are asserted by the seed. */
export const PARITY_ROWS = [
    { id: 1, groupId: '1', filePath: 'G1/videos/clip.mp4', fileType: 'video', size: CLIP_SIZE },
    { id: 2, groupId: '1', filePath: 'G1/images/pic.jpg', fileType: 'photo', size: 269 },
    { id: 3, groupId: '1', filePath: 'G1/docs/page.html', fileType: 'document', size: 57 },
    { id: 4, groupId: '1', filePath: 'G1/images/gone.jpg', fileType: 'photo', size: 10 },
];

export const PARITY_THUMB_BYTES = Buffer.concat([
    Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1'),
    pattern(600, 17),
]);

export function thumbCacheName(id, width = 320) {
    return `${crypto.createHash('sha256').update(`${id}:${width}`).digest('hex').slice(0, 32)}.webp`;
}

const tok = (c) => c.repeat(64);
/**
 * web_sessions rows. `renew*` are inside the last quarter of their TTL, so
 * the first authenticated request extends them (Set-Cookie); each is used
 * by exactly one case.
 */
export const PARITY_SESSIONS = [
    { name: 'admin', token: tok('a'), role: 'admin', ageDays: 1, ttlDays: 30 },
    { name: 'guest', token: tok('b'), role: 'guest', ageDays: 1, ttlDays: 30 },
    { name: 'renewFiles', token: tok('c'), role: 'admin', ageDays: 29, ttlDays: 30 },
    { name: 'renewPhotos', token: tok('d'), role: 'guest', ageDays: 29, ttlDays: 30 },
    { name: 'renewThumbs', token: tok('e'), role: 'admin', ageDays: 29, ttlDays: 30 },
    { name: 'expired', token: tok('f'), role: 'admin', ageDays: 31, ttlDays: 30 },
];
const S = Object.fromEntries(PARITY_SESSIONS.map((s) => [s.name, s.token]));
const cookie = (name) => ({ Cookie: `tg_dl_session=${S[name]}` });

// Validators the seed produces (send's stat ETag and the thumbs route's own).
const CLIP_ETAG = `W/"${CLIP_SIZE.toString(16)}-${PARITY_MTIME_MS.toString(16)}"`;
const PHOTO_ETAG = `W/"${PARITY_JPEG.length.toString(16)}-${PARITY_MTIME_MS.toString(16)}"`;
const LAST_MOD = new Date(PARITY_MTIME_MS).toUTCString();
const THUMB_ETAG = `"thumb-1-320-${PARITY_MTIME_MS}"`;

const clip = '/files/G1/videos/clip.mp4';
const admin = cookie('admin');
const guest = cookie('guest');

// ---- cases -----------------------------------------------------------------
//
// { name, method?, path, headers?, volatile?: string[] (header names, or
//   'body'), ws?: true }. `headers` may be a function of ctx (file tokens
// are minted at run time). Order matters: renewals and the auto-prune
// change state.

const SPA = ['etag', 'content-length', 'last-modified', 'body'];

export const PARITY_CASES = [
    // ---- /files ---------------------------------------------------------
    { name: 'files inline', path: `${clip}?inline=1`, headers: admin },
    { name: 'files attachment', path: clip, headers: admin },
    { name: 'files HEAD', method: 'HEAD', path: `${clip}?inline=1`, headers: admin },
    { name: 'files range 0-1023', path: clip, headers: { ...admin, Range: 'bytes=0-1023' } },
    { name: 'files range suffix', path: clip, headers: { ...admin, Range: 'bytes=-500' } },
    { name: 'files range open', path: clip, headers: { ...admin, Range: 'bytes=1000-' } },
    { name: 'files range 0-0', path: clip, headers: { ...admin, Range: 'bytes=0-0' } },
    { name: 'files range multi', path: clip, headers: { ...admin, Range: 'bytes=0-1,5-9' } },
    {
        name: 'files range adjacent (combined)',
        path: clip,
        headers: { ...admin, Range: 'bytes=0-99,100-199' },
    },
    {
        name: 'files range unsatisfiable',
        path: clip,
        headers: { ...admin, Range: 'bytes=999999-' },
    },
    { name: 'files range malformed', path: clip, headers: { ...admin, Range: 'bytes=abc' } },
    { name: 'files range other unit', path: clip, headers: { ...admin, Range: 'items=0-5' } },
    {
        name: 'files range lenient parseInt',
        path: clip,
        headers: { ...admin, Range: 'bytes= 10-20x' },
    },
    {
        name: 'files If-Range etag fresh',
        path: clip,
        headers: { ...admin, Range: 'bytes=0-99', 'If-Range': CLIP_ETAG },
    },
    {
        name: 'files If-Range etag stale',
        path: clip,
        headers: { ...admin, Range: 'bytes=0-99', 'If-Range': '"stale"' },
    },
    {
        name: 'files If-Range date',
        path: clip,
        headers: { ...admin, Range: 'bytes=0-99', 'If-Range': LAST_MOD },
    },
    {
        name: 'files If-None-Match',
        path: `${clip}?inline=1`,
        headers: { ...admin, 'If-None-Match': CLIP_ETAG },
    },
    {
        name: 'files If-None-Match list',
        path: `${clip}?inline=1`,
        headers: { ...admin, 'If-None-Match': `"x", ${CLIP_ETAG}` },
    },
    {
        name: 'files If-Modified-Since',
        path: `${clip}?inline=1`,
        headers: { ...admin, 'If-Modified-Since': LAST_MOD },
    },
    {
        name: 'files If-None-Match other',
        path: `${clip}?inline=1`,
        headers: { ...admin, 'If-None-Match': '"other"' },
    },
    {
        name: 'files If-None-Match + no-cache',
        path: `${clip}?inline=1`,
        headers: { ...admin, 'If-None-Match': CLIP_ETAG, 'Cache-Control': 'no-cache' },
    },
    { name: 'files If-Match fail', path: clip, headers: { ...admin, 'If-Match': '"nope"' } },
    {
        name: 'files If-Unmodified-Since fail',
        path: clip,
        headers: { ...admin, 'If-Unmodified-Since': 'Mon, 01 Jan 2001 00:00:00 GMT' },
    },
    {
        name: 'files HEAD range',
        method: 'HEAD',
        path: clip,
        headers: { ...admin, Range: 'bytes=0-9' },
    },
    { name: 'files no auth', path: `${clip}?inline=1` },
    {
        name: 'files token admin',
        path: (c) => `${clip}?inline=1&token=${encodeURIComponent(c.fileTokenAdmin)}`,
    },
    {
        name: 'files token guest',
        path: (c) => `${clip}?token=${encodeURIComponent(c.fileTokenGuest)}`,
    },
    { name: 'files token garbage', path: `${clip}?token=123.abc` },
    {
        name: 'files token twice (array)',
        path: (c) => `${clip}?token=${encodeURIComponent(c.fileTokenAdmin)}&token=x`,
    },
    { name: 'files guest', path: `${clip}?inline=1`, headers: guest },
    { name: 'files renewal', path: `${clip}?inline=1`, headers: cookie('renewFiles') },
    { name: 'files expired session', path: `${clip}?inline=1`, headers: cookie('expired') },
    {
        name: 'files duplicate cookie (last wins)',
        path: `${clip}?inline=1`,
        headers: { Cookie: `tg_dl_session=${S.guest}; tg_dl_session=${S.admin}` },
    },
    {
        name: 'files bad cookie encoding',
        path: `${clip}?inline=1`,
        headers: { Cookie: 'tg_dl_session=%E0%A4%A' },
    },
    {
        name: 'files unicode name',
        path: `/files/G1/images/${encodeURIComponent(UNICODE_NAME)}?inline=1`,
        headers: admin,
    },
    { name: 'files mkv', path: '/files/G1/videos/movie.mkv?inline=1', headers: admin },
    { name: 'files webm', path: '/files/G1/videos/v.webm?inline=1', headers: admin },
    { name: 'files heic inline', path: '/files/G1/images/photo.heic?inline=1', headers: admin },
    { name: 'files heic download', path: '/files/G1/images/photo.heic', headers: admin },
    { name: 'files opus', path: '/files/G1/audio/voice.opus?inline=1', headers: admin },
    { name: 'files html inline', path: '/files/G1/docs/page.html?inline=1', headers: admin },
    { name: 'files html attachment', path: '/files/G1/docs/page.html', headers: admin },
    { name: 'files txt', path: '/files/G1/docs/notes.txt?inline=1', headers: admin },
    { name: 'files empty', path: '/files/G1/docs/empty.bin', headers: admin },
    {
        name: 'files empty range',
        path: '/files/G1/docs/empty.bin',
        headers: { ...admin, Range: 'bytes=0-' },
    },
    { name: 'files dotfile', path: '/files/G1/docs/.hidden.txt', headers: admin },
    { name: 'files missing (prune)', path: '/files/G1/images/gone.jpg', headers: admin },
    { name: 'files missing folder', path: '/files/G9/images/x.jpg', headers: admin },
    { name: 'files traversal', path: '/files/..%2F..%2Fdb.sqlite', headers: admin },
    { name: 'files directory', path: '/files/G1', headers: admin },
    { name: 'files root', path: '/files/', headers: admin },
    { name: 'files bad encoding', path: '/files/%E0%A4%A', headers: admin },
    { name: 'files peer admin', path: `${clip}?peer=nope`, headers: admin },
    { name: 'files peer guest', path: `${clip}?peer=nope`, headers: guest },
    { name: 'files clusterref', path: '/files/_clusterref/peerx/5', headers: admin },
    { name: 'files POST', method: 'POST', path: `${clip}?inline=1`, headers: admin },
    { name: 'files upper-case prefix', path: '/FILES/G1/videos/clip.mp4', headers: admin },
    { name: 'files double slash', path: '/files//G1/videos/clip.mp4', headers: admin },
    {
        name: 'files legacy prefix',
        path: '/files/data/downloads/G1/videos/clip.mp4?inline=1',
        headers: admin,
    },
    {
        name: 'files spoofed forwarding headers',
        path: `${clip}?inline=1`,
        headers: {
            ...admin,
            'X-Forwarded-For': '203.0.113.7',
            'X-Forwarded-Proto': 'https',
            'X-Forwarded-Host': 'evil.example',
        },
    },

    // ---- /photos --------------------------------------------------------
    { name: 'photos', path: '/photos/-100123.jpg', headers: admin },
    { name: 'photos HEAD', method: 'HEAD', path: '/photos/-100123.jpg', headers: admin },
    { name: 'photos no auth', path: '/photos/-100123.jpg' },
    { name: 'photos guest', path: '/photos/42.jpg', headers: guest },
    {
        name: 'photos If-None-Match',
        path: '/photos/42.jpg',
        headers: { ...admin, 'If-None-Match': PHOTO_ETAG },
    },
    {
        name: 'photos range',
        path: '/photos/42.jpg',
        headers: { ...admin, Range: 'bytes=0-9' },
    },
    { name: 'photos missing', path: '/photos/nope.jpg', headers: admin },
    { name: 'photos renewal', path: '/photos/42.jpg', headers: cookie('renewPhotos') },
    { name: 'photos dir', path: '/photos/', headers: admin },
    { name: 'photos dotfile', path: '/photos/.hidden', headers: admin },
    { name: 'photos POST', method: 'POST', path: '/photos/42.jpg', headers: admin },

    // ---- /api/thumbs ----------------------------------------------------
    { name: 'thumb hit', path: '/api/thumbs/1', headers: admin },
    { name: 'thumb hit ?w', path: '/api/thumbs/1?w=240', headers: admin },
    {
        name: 'thumb If-None-Match exact',
        path: '/api/thumbs/1',
        headers: { ...admin, 'If-None-Match': THUMB_ETAG },
    },
    {
        name: 'thumb If-Modified-Since exact',
        path: '/api/thumbs/1',
        headers: { ...admin, 'If-Modified-Since': LAST_MOD },
    },
    {
        name: 'thumb If-None-Match weak',
        path: '/api/thumbs/1',
        headers: { ...admin, 'If-None-Match': `W/${THUMB_ETAG}` },
    },
    {
        name: 'thumb range',
        path: '/api/thumbs/1',
        headers: { ...admin, Range: 'bytes=0-9' },
    },
    { name: 'thumb HEAD', method: 'HEAD', path: '/api/thumbs/1', headers: admin },
    { name: 'thumb guest', path: '/api/thumbs/1', headers: guest },
    { name: 'thumb no auth', path: '/api/thumbs/1' },
    {
        name: 'thumb file token only',
        path: (c) => `/api/thumbs/1?token=${encodeURIComponent(c.fileTokenAdmin)}`,
    },
    { name: 'thumb bad id', path: '/api/thumbs/abc', headers: admin },
    { name: 'thumb id 0', path: '/api/thumbs/0', headers: admin },
    { name: 'thumb leading zeros', path: '/api/thumbs/0001', headers: admin },
    { name: 'thumb trailing slash', path: '/api/thumbs/1/', headers: admin },
    { name: 'thumb not thumbnailable', path: '/api/thumbs/3', headers: admin },
    {
        name: 'thumb miss (generated)',
        path: '/api/thumbs/2',
        headers: admin,
        volatile: ['etag', 'last-modified', 'content-length', 'body'],
    },
    { name: 'thumb renewal', path: '/api/thumbs/1', headers: cookie('renewThumbs') },
    { name: 'thumb POST', method: 'POST', path: '/api/thumbs/1', headers: admin },

    // ---- proxied: pages, static, API ------------------------------------
    { name: 'root no auth', path: '/' },
    { name: 'root admin', path: '/', headers: admin, volatile: SPA },
    { name: 'login page', path: '/login.html', volatile: SPA },
    { name: 'js module', path: '/js/app.js?v=1', volatile: SPA },
    { name: 'js module bare', path: '/js/app.js', volatile: SPA },
    {
        name: 'css gzip',
        path: '/css/main.css',
        headers: { 'Accept-Encoding': 'gzip' },
        volatile: SPA,
    },
    {
        name: 'js br',
        path: '/js/app.js?v=1',
        headers: { 'Accept-Encoding': 'gzip, deflate, br' },
        volatile: SPA,
    },
    { name: 'service worker', path: '/sw.js', volatile: SPA },
    { name: 'manifest', path: '/manifest.webmanifest', volatile: SPA },
    { name: 'icon', path: '/icons/icon-192.png', volatile: SPA },
    { name: 'auth_check anon', path: '/api/auth_check' },
    { name: 'auth_check admin', path: '/api/auth_check', headers: admin },
    { name: 'auth_check guest', path: '/api/auth_check', headers: guest },
    {
        name: 'auth_check gzip',
        path: '/api/auth_check',
        headers: { 'Accept-Encoding': 'gzip' },
    },
    { name: 'auth_check HEAD', method: 'HEAD', path: '/api/auth_check' },
    { name: 'version', path: '/api/version', volatile: ['etag', 'content-length', 'body'] },
    { name: 'api 404', path: '/api/definitely-not-here', headers: admin },
    { name: 'api guest forbidden', path: '/api/config', headers: guest },
    { name: 'page 404', path: '/definitely-not-here', headers: admin },
    {
        name: 'login bad password',
        method: 'POST',
        path: '/api/login',
        headers: { 'Content-Type': 'application/json' },
        body: '{"password":"wrong"}',
        volatile: ['ratelimit'],
    },
    {
        name: 'csrf blocked',
        method: 'POST',
        path: '/api/logout',
        headers: { ...admin, Origin: 'https://evil.example' },
    },
    {
        name: 'json body error',
        method: 'POST',
        path: '/api/logout',
        headers: { ...admin, 'Content-Type': 'application/json' },
        body: '{nope',
    },
    { name: 'OPTIONS', method: 'OPTIONS', path: '/api/auth_check' },

    // ---- WebSocket upgrades (raw response head) -------------------------
    { name: 'ws no cookie', ws: true, path: '/ws' },
    { name: 'ws admin', ws: true, path: '/ws', headers: admin },
    { name: 'ws cluster unsigned', ws: true, path: '/ws/cluster' },
];

// ---- runner ----------------------------------------------------------------

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Send one case. Resolves `{ status, headers: [[name, value], …], bodyLength,
 * bodySha256 }` (raw header pairs, names as sent) or, for `ws`, the raw
 * response head.
 */
export function runCase(port, c, ctx, agent) {
    const p = typeof c.path === 'function' ? c.path(ctx) : c.path;
    const headers = { ...(typeof c.headers === 'function' ? c.headers(ctx) : c.headers || {}) };
    if (c.ws) return runUpgrade(port, p, headers);
    return new Promise((resolve, reject) => {
        const body = c.body ? Buffer.from(c.body) : null;
        if (body) headers['Content-Length'] = String(body.length);
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                method: c.method || 'GET',
                path: p,
                headers: { Host: `localhost:${port}`, ...headers },
                agent,
            },
            (res) => {
                const chunks = [];
                res.on('data', (d) => chunks.push(d));
                res.on('end', () => {
                    const buf = Buffer.concat(chunks);
                    const pairs = [];
                    for (let i = 0; i < res.rawHeaders.length; i += 2) {
                        pairs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
                    }
                    resolve({
                        status: res.statusCode,
                        headers: pairs,
                        bodyLength: buf.length,
                        bodySha256: sha256(buf),
                    });
                });
                res.on('error', reject);
            },
        );
        req.setTimeout(20_000, () => req.destroy(new Error(`timeout: ${c.name}`)));
        req.on('error', reject);
        req.end(body || undefined);
    });
}

function runUpgrade(port, p, headers) {
    return new Promise((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1');
        let buf = Buffer.alloc(0);
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            sock.destroy();
            const text = buf.toString('latin1');
            const end = text.indexOf('\r\n\r\n');
            const head = end >= 0 ? text.slice(0, end) : text;
            const [statusLine, ...lines] = head.split('\r\n');
            const pairs = lines
                .filter(Boolean)
                .map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]);
            resolve({
                status: Number(statusLine.split(' ')[1]) || 0,
                statusLine,
                headers: pairs,
                bodyLength: 0,
                bodySha256: sha256(Buffer.alloc(0)),
            });
        };
        sock.setTimeout(10_000, () => {
            if (!done) reject(new Error(`ws timeout ${p}`));
            sock.destroy();
        });
        sock.on('error', (e) => (buf.length ? finish() : reject(e)));
        sock.on('close', finish);
        sock.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            if (buf.includes('\r\n\r\n')) finish();
        });
        sock.on('connect', () => {
            const lines = [
                `GET ${p} HTTP/1.1`,
                `Host: localhost:${port}`,
                'Upgrade: websocket',
                'Connection: Upgrade',
                'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
                'Sec-WebSocket-Version: 13',
                ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
            ];
            sock.write(`${lines.join('\r\n')}\r\n\r\n`);
        });
    });
}

/** Run every case in order; returns `{ [name]: result }`. */
export async function runAll(port, ctx, cases = PARITY_CASES) {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const out = {};
    try {
        for (const c of cases) out[c.name] = await runCase(port, c, ctx, agent);
    } finally {
        agent.destroy();
    }
    return out;
}

// ---- comparison ------------------------------------------------------------

/**
 * Canonical form of a result: lower-case header names, sorted, with the
 * clock-dependent parts and the case's volatile fields replaced.
 */
export function normalize(result, c = {}) {
    const vol = new Set((c.volatile || []).map((v) => v.toLowerCase()));
    const headers = [];
    for (const [name, value] of result.headers) {
        const k = name.toLowerCase();
        if (k === 'date') continue;
        let v = value;
        if (vol.has(k)) v = '<volatile>';
        else if (k === 'set-cookie') v = v.replace(/Expires=[^;]+/i, 'Expires=<date>');
        headers.push([k, v]);
    }
    headers.sort((a, b) => (a[0] === b[0] ? 0 : a[0] < b[0] ? -1 : 1));
    return {
        status: result.status,
        headers,
        body: vol.has('body') ? '<volatile>' : `${result.bodyLength}:${result.bodySha256}`,
    };
}

/** Header-name case differences (accepted: names are case-insensitive). */
export function caseDiffs(expected, actual) {
    const names = (r) => new Map(r.headers.map(([n]) => [n.toLowerCase(), n]));
    const e = names(expected);
    const out = [];
    for (const [k, n] of names(actual)) {
        if (e.has(k) && e.get(k) !== n) out.push(`${e.get(k)} → ${n}`);
    }
    return out;
}

/** Human-readable differences between two normalised results ([] = equal). */
export function diff(expected, actual) {
    const out = [];
    if (expected.status !== actual.status) out.push(`status ${expected.status} → ${actual.status}`);
    const fmt = (h) => h.map(([k, v]) => `${k}: ${v}`);
    const e = fmt(expected.headers);
    const a = fmt(actual.headers);
    for (const line of e) if (!a.includes(line)) out.push(`- ${line}`);
    for (const line of a) if (!e.includes(line)) out.push(`+ ${line}`);
    if (expected.body !== actual.body) out.push(`body ${expected.body} → ${actual.body}`);
    return out;
}
