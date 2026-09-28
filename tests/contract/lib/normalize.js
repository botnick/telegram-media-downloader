// Normalisation of recorded HTTP exchanges and WS messages.
//
// Every mask below replaces a value that legitimately differs between two
// runs of the SAME server (clock, random ids, temp paths, ports, host
// metrics) with a stable placeholder. None of them may be used to paper
// over a behavioural difference — tests/contract/README.md lists each one
// with the reason it is safe. A placeholder always keeps the JSON type
// (`<time:ms>` replaces a number, never a null), so "field went missing /
// changed type" is still caught.
//
// Stable numbering: random values (uuids, tokens, signatures) become
// `<uuid:1>`, `<uuid:2>` … in order of first appearance within one test
// file, so "the jobId returned by POST is the one GET reports" survives
// masking.

import crypto from 'crypto';
import os from 'os';

// Clock window: anything the server stamps with "now" falls between these.
// The seed deliberately uses dates in 2024 and ≥ 2099 for its fixed
// timestamps, so seeded values are never masked.
const MS_LO = Date.UTC(2025, 0, 1);
const MS_HI = Date.UTC(2098, 0, 1);
const S_LO = MS_LO / 1000;
const S_HI = MS_HI / 1000;

// Keys whose numeric value is an epoch-seconds timestamp when it lies in
// the clock window. (Epoch-milliseconds are masked regardless of key: no
// size/count in this app reaches 1.7e12.)
const SECONDS_KEY =
    /(^|_)(at|ts|exp|time|date|since|until|deadline|expires|expiry)$|(At|Ts|Time|Date|Since|Until|Exp|Expires|Expiry)$/;

// Keys whose value measures elapsed wall-clock time or host resources —
// they differ run to run on the same code. Numbers only.
export const VOLATILE_NUMBER_KEYS = new Map([
    ['uptime', 'process uptime'],
    ['uptimeSec', 'process uptime'],
    ['uptimeMs', 'process uptime'],
    ['uptimeSeconds', 'process uptime'],
    ['durationMs', 'wall-clock duration of a job/request'],
    ['elapsedMs', 'wall-clock duration'],
    ['tookMs', 'wall-clock duration'],
    ['latencyMs', 'round-trip time'],
    ['rttMs', 'round-trip time'],
    ['ms', 'wall-clock duration'],
    ['pid', 'OS process id'],
    ['ppid', 'OS process id'],
    ['rss', 'process memory'],
    ['heapUsed', 'process memory'],
    ['heapTotal', 'process memory'],
    ['external', 'process memory'],
    ['arrayBuffers', 'process memory'],
    ['freemem', 'host memory'],
    ['totalmem', 'host memory'],
]);

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const ISO_RE = /\b(20\d\d)-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(\.\d+)?(Z|[+-]\d\d:?\d\d)?\b/g;
const SQL_TS_RE = /\b(20\d\d)-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\b/g;
const HTTP_DATE_RE =
    /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d\d (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) \d\d:\d\d:\d\d GMT\b/g;
const HEX_TOKEN_RE = /\b[0-9a-f]{32,}\b/gi;
const B64URL_SIG_RE = /([?&](?:s|sig)=)([A-Za-z0-9_-]{40,}|[A-Za-z0-9%_-]{40,})/g;
const FILE_TOKEN_RE = /\b(\d{10})\.([A-Za-z0-9_-]{43})\b/g;

function inWindowYear(y) {
    const n = Number(y);
    return n >= 2025 && n < 2098;
}

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {object} ctx
 * @param {string} [ctx.dataDir]    temp TGDL_DATA_DIR of the target
 * @param {string} [ctx.repoRoot]
 * @param {number} [ctx.port]
 * @param {Set<string>} [ctx.stable] values that must never be masked (seeded
 *                                   hashes, tokens, ids)
 */
export function createNormalizer(ctx = {}) {
    const stable = ctx.stable || new Set();
    const counters = new Map();
    const seen = new Map();
    const placeholder = (kind, raw) => {
        const k = `${kind}\u0000${raw}`;
        if (seen.has(k)) return seen.get(k);
        const n = (counters.get(kind) || 0) + 1;
        counters.set(kind, n);
        const p = `<${kind}:${n}>`;
        seen.set(k, p);
        return p;
    };

    // Longest first so the data dir wins over the temp root it lives in.
    const roots = [];
    const addRoot = (p, name) => {
        if (!p) return;
        const variants = new Set([p, p.replace(/\\/g, '/'), p.replace(/\//g, '\\')]);
        // JSON-escaped (\\) and URL-encoded forms show up in error strings.
        for (const v of [...variants]) {
            variants.add(v.replace(/\\/g, '\\\\'));
            variants.add(encodeURIComponent(v));
        }
        for (const v of variants) roots.push([v, name]);
    };
    addRoot(ctx.dataDir, '<DATA>');
    addRoot(ctx.repoRoot, '<REPO>');
    addRoot(process.execPath, '<NODE>');
    addRoot(os.tmpdir(), '<TMP>');
    addRoot(os.homedir(), '<HOME>');
    roots.sort((a, b) => b[0].length - a[0].length);
    const rootRes = roots.map(([v, name]) => [
        new RegExp(escapeRe(v), process.platform === 'win32' ? 'gi' : 'g'),
        name,
    ]);
    // The app version changes every release; it is checked once against
    // package.json (static.contract.test.js) and masked everywhere else so
    // a version bump doesn't invalidate every golden.
    const versionRe = ctx.appVersion
        ? new RegExp(`(?<![\\d.])${escapeRe(ctx.appVersion)}(?![\\d.])`, 'g')
        : null;
    const hostRe = ctx.port
        ? new RegExp(`(127\\.0\\.0\\.1|localhost|\\[::1\\]|0\\.0\\.0\\.0):${ctx.port}\\b`, 'g')
        : null;

    // Extra literal replacements a scenario registers (e.g. the loopback URL
    // of a fake sidecar it started on a random port).
    const extra = [];
    function addReplacement(from, to) {
        if (from) extra.push([from, to]);
        extra.sort((a, b) => b[0].length - a[0].length);
    }

    function str(s) {
        if (typeof s !== 'string' || s === '') return s;
        let out = s.replace(/\r\n/g, '\n');
        for (const [from, to] of extra) out = out.split(from).join(to);
        for (const [re, name] of rootRes) out = out.replace(re, name);
        if (hostRe) out = out.replace(hostRe, '<HOST>');
        if (versionRe) out = out.replace(versionRe, '<version>');
        // Path separators: Windows answers with `\`, Linux with `/`.
        if (out.includes('\\')) out = out.replace(/\\\\/g, '/').replace(/\\/g, '/');
        out = out.replace(UUID_RE, (m) =>
            stable.has(m.toLowerCase()) ? m : placeholder('uuid', m),
        );
        out = out.replace(FILE_TOKEN_RE, (m, exp) =>
            Number(exp) >= S_LO && Number(exp) < S_HI && !stable.has(m)
                ? placeholder('filetoken', m)
                : m,
        );
        out = out.replace(B64URL_SIG_RE, (m, pre, sig) =>
            stable.has(sig) ? m : `${pre}${placeholder('sig', sig)}`,
        );
        // Random hex (tokens, secrets, digests of generated files) — a run
        // of 32+ hex chars holding both a digit and a letter, so words like
        // "BBBB…" or long numbers are left alone.
        out = out.replace(HEX_TOKEN_RE, (m) =>
            stable.has(m.toLowerCase()) || !/\d/.test(m) || !/[a-f]/i.test(m)
                ? m
                : placeholder(`hex${m.length}`, m.toLowerCase()),
        );
        out = out.replace(ISO_RE, (m, y) => (inWindowYear(y) ? '<time:iso>' : m));
        out = out.replace(SQL_TS_RE, (m, y) => (inWindowYear(y) ? '<time:sql>' : m));
        out = out.replace(HTTP_DATE_RE, (m, _d, _mo, y) => (inWindowYear(y) ? '<time:http>' : m));
        return out;
    }

    function num(n, key) {
        if (!Number.isFinite(n)) return n;
        if (key && VOLATILE_NUMBER_KEYS.has(key)) return `<${key}:number>`;
        if (Number.isInteger(n) && n >= MS_LO && n < MS_HI) return '<time:ms>';
        if (n >= S_LO && n < S_HI && key && SECONDS_KEY.test(key)) return '<time:s>';
        if (key === 'port' && ctx.port && n === ctx.port) return '<PORT>';
        return n;
    }

    /**
     * Deep-normalise a JSON value. Object keys are sorted — JSON member
     * order is not part of the contract (clients parse, they don't diff
     * bytes). Array order IS kept unless the caller lists the path in
     * `opts.unordered`.
     */
    function value(v, key = null, pathStr = '', opts = {}) {
        if (v === null || v === undefined) return v ?? null;
        if (typeof v === 'string') {
            const s = str(v);
            if (key && SECONDS_KEY.test(key) && /^\d{10}$/.test(s)) {
                const n = Number(s);
                if (n >= S_LO && n < S_HI) return '<time:s>';
            }
            if (key && VOLATILE_NUMBER_KEYS.has(key) && /^\d+(\.\d+)?$/.test(s)) {
                return `<${key}:string>`;
            }
            return s;
        }
        if (typeof v === 'number') return num(v, key);
        if (typeof v === 'boolean') return v;
        if (Array.isArray(v)) {
            let arr = v.map((x, i) => value(x, key, `${pathStr}[]`, opts));
            if (opts.unordered?.includes(`${pathStr}[]`) || opts.unordered?.includes(pathStr)) {
                arr = [...arr].sort((a, b) =>
                    JSON.stringify(a) < JSON.stringify(b)
                        ? -1
                        : JSON.stringify(a) > JSON.stringify(b)
                          ? 1
                          : 0,
                );
            }
            return arr;
        }
        if (typeof v === 'object') {
            const out = {};
            for (const k of Object.keys(v).sort()) {
                const p = pathStr ? `${pathStr}.${k}` : k;
                if (opts.mask && Object.hasOwn(opts.mask, p)) {
                    const cur = v[k];
                    out[k] = cur === null || cur === undefined ? null : `<masked:${typeof cur}>`;
                    continue;
                }
                out[k] = value(v[k], k, p, opts);
            }
            return out;
        }
        return v;
    }

    return { str, num, value, placeholder, addReplacement };
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

// Never recorded: transport framing / per-connection values.
export const IGNORED_HEADERS = new Set(['date', 'connection', 'keep-alive', 'transfer-encoding']);

// Grouped into a hashed "security profile" per response so the snapshot
// stays readable; the profile's full content lives once per snapshot file.
export const SECURITY_HEADERS = new Set([
    'content-security-policy',
    'cross-origin-opener-policy',
    'cross-origin-resource-policy',
    'cross-origin-embedder-policy',
    'origin-agent-cluster',
    'referrer-policy',
    'strict-transport-security',
    'x-content-type-options',
    'x-dns-prefetch-control',
    'x-download-options',
    'x-frame-options',
    'x-permitted-cross-domain-policies',
    'x-xss-protection',
]);

/** Express/`etag` package weak ETag of a body: W/"<len hex>-<sha1 b64 27>". */
export function expressEtag(buf) {
    if (buf.length === 0) return 'W/"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"';
    const hash = crypto.createHash('sha1').update(buf).digest('base64').slice(0, 27);
    return `W/"${buf.length.toString(16)}-${hash}"`;
}

function parseSetCookie(line, norm) {
    const parts = line.split(';').map((p) => p.trim());
    const [nv, ...attrs] = parts;
    const eq = nv.indexOf('=');
    const name = nv.slice(0, eq);
    const val = nv.slice(eq + 1);
    const out = {
        name,
        value: val === '' ? '' : /^[0-9a-f]{64}$/i.test(val) ? '<session-token>' : norm.str(val),
    };
    const a = {};
    for (const attr of attrs) {
        const i = attr.indexOf('=');
        const k = (i < 0 ? attr : attr.slice(0, i)).toLowerCase();
        let v = i < 0 ? true : attr.slice(i + 1);
        if (k === 'expires') v = norm.str(v);
        a[k] = v;
    }
    out.attributes = Object.fromEntries(
        Object.keys(a)
            .sort()
            .map((k) => [k, a[k]]),
    );
    return out;
}

/**
 * @returns {{ headers: object, security: object }}
 */
export function normalizeHeaders(raw, body, norm, { bodyIsText, staticMtimes } = {}) {
    const headers = {};
    const security = {};
    for (const [name, value] of Object.entries(raw)) {
        const k = name.toLowerCase();
        if (IGNORED_HEADERS.has(k)) continue;
        if (SECURITY_HEADERS.has(k)) {
            security[k] = value;
            continue;
        }
        if (k === 'content-length') {
            // Framing detail for JSON/text (depends on member order); a real
            // property of binary/file responses (Range, downloads).
            if (!bodyIsText) headers[k] = value;
            continue;
        }
        if (k === 'set-cookie') {
            const lines = Array.isArray(value) ? value : [value];
            headers[k] = lines.map((l) => parseSetCookie(l, norm));
            continue;
        }
        if (k === 'etag') {
            // 1. Express' body etag: record THAT it is the body hash, not the
            //    hash itself (it depends on JSON member order).
            // 2. `send`/express.static file etag W/"<size hex>-<mtime hex>":
            //    kept for seeded files (fixed mtime); SPA assets carry their
            //    git-checkout mtime and change size with every SPA edit, so
            //    both parts become placeholders there (their content is
            //    checked against the file on disk instead).
            // 3. Body-less answers (304, HEAD) of Express' body etag can't be
            //    checked against a body → placeholder.
            const file = /^W\/"([0-9a-f]+)-([0-9a-f]+)"$/.exec(value);
            if (body?.length && value === expressEtag(body)) {
                headers[k] = 'W/"<express-etag-of-body>"';
            } else if (file) {
                const mtime = parseInt(file[2], 16);
                headers[k] = staticMtimes?.has(mtime) ? value : 'W/"<size-hex>-<mtime-hex>"';
            } else if (!body?.length && /^W\/"[0-9a-f]+-[A-Za-z0-9+/=]{27}"$/.test(value)) {
                headers[k] = 'W/"<express-etag>"';
            } else headers[k] = norm.str(value);
            continue;
        }
        if (k === 'last-modified') {
            const t = Date.parse(value);
            headers[k] = staticMtimes?.has(t) ? value : '<http-date>';
            continue;
        }
        if (k === 'ratelimit') {
            headers[k] = String(value).replace(/reset=\d+/, 'reset=<s>');
            continue;
        }
        if (k === 'retry-after') {
            headers[k] = /^\d+$/.test(String(value)) ? '<seconds>' : norm.str(String(value));
            continue;
        }
        headers[k] = Array.isArray(value) ? value.map((v) => norm.str(v)) : norm.str(String(value));
    }
    const sortedHeaders = Object.fromEntries(
        Object.keys(headers)
            .sort()
            .map((k) => [k, headers[k]]),
    );
    const sortedSecurity = Object.fromEntries(
        Object.keys(security)
            .sort()
            .map((k) => [k, security[k]]),
    );
    return { headers: sortedHeaders, security: sortedSecurity };
}

export function profileId(security) {
    return crypto.createHash('sha1').update(JSON.stringify(security)).digest('hex').slice(0, 10);
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

export function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

export function isTextType(ct) {
    const t = String(ct || '').toLowerCase();
    return (
        t.startsWith('text/') ||
        t.includes('json') ||
        t.includes('javascript') ||
        t.includes('xml') ||
        t.includes('markdown') ||
        t === ''
    );
}

/** Minimal ZIP central-directory reader: [{ name, size, crc32, method }]. */
export function zipEntries(buf) {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) return { error: 'no EOCD' };
    let count = buf.readUInt16LE(eocd + 10);
    let cdOffset = buf.readUInt32LE(eocd + 16);
    // ZIP64
    if (cdOffset === 0xffffffff || count === 0xffff) {
        const loc = eocd - 20;
        if (loc >= 0 && buf.readUInt32LE(loc) === 0x07064b50) {
            const z64 = Number(buf.readBigUInt64LE(loc + 8));
            count = Number(buf.readBigUInt64LE(z64 + 32));
            cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
        }
    }
    const out = [];
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(p) !== 0x02014b50)
            return { error: 'bad central directory', entries: out };
        const method = buf.readUInt16LE(p + 10);
        const crc = buf.readUInt32LE(p + 16);
        let size = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
        if (size === 0xffffffff) {
            // ZIP64 extra field
            let e = p + 46 + nameLen;
            const end = e + extraLen;
            while (e < end) {
                const id = buf.readUInt16LE(e);
                const len = buf.readUInt16LE(e + 2);
                if (id === 0x0001) {
                    size = Number(buf.readBigUInt64LE(e + 4));
                    break;
                }
                e += 4 + len;
            }
        }
        out.push({ name, size, crc32: crc.toString(16).padStart(8, '0'), method });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries: out };
}
