// Black-box contract harness.
//
// Starts the server under test on a fresh deterministic seed, talks to it
// over plain HTTP/WebSocket only, normalises what comes back and records
// or compares it against the golden snapshots.
//
//   CONTRACT_TARGET=node (default)  node src/web/server.js
//   CONTRACT_TARGET=go              $CONTRACT_GO_BIN (default
//                                   core-service/bin/tgdl-server[.exe])
//   CONTRACT_TARGET=url             attach to $CONTRACT_URL (optionally
//                                   $CONTRACT_DATA_DIR for path masking);
//                                   nothing is spawned or seeded
//
// Every spawned target gets a temp TGDL_DATA_DIR built by
// fixtures/seed.js, a free port, and the same minimal environment.

import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import zlib from 'zlib';
import { afterAll, beforeAll } from 'vitest';
import WebSocket from 'ws';
import { buildSeed, FIXED_MTIME_MS, SEED } from './fixtures/seed.js';
import { createRouteMatcher, parseRoutes, REPO_ROOT, SERVER_JS } from './lib/inventory.js';
import {
    createNormalizer,
    isTextType,
    normalizeHeaders,
    profileId,
    sha256,
    zipEntries,
} from './lib/normalize.js';
import { snapshotStore } from './lib/snapshot.js';

export { SEED };
export { DOWNLOAD_IDS, DOWNLOADS } from './fixtures/seed.js';

export const TARGET = process.env.CONTRACT_TARGET || 'node';
export const APP_VERSION = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
).version;
const SANDBOX = path.join(import.meta.dirname, 'fixtures', 'sandbox.mjs');

// Types the dashboard socket emits on timers, not in response to what a
// scenario does. Filtered from recorded sequences unless asked for.
export const AMBIENT_WS_TYPES = ['monitor_status_push', 'stats_push', 'log'];

let _matcher = null;
function routeOf(method, urlPath) {
    if (!_matcher) {
        let routes;
        if (fs.existsSync(SERVER_JS)) routes = parseRoutes();
        else {
            const inv = JSON.parse(
                fs.readFileSync(path.join(import.meta.dirname, 'inventory.json'), 'utf8'),
            );
            routes = inv.routes.map((r, i) => {
                const [m, ...p] = r.key.split(' ');
                return { method: m, path: p.join(' '), key: r.key, line: i };
            });
        }
        _matcher = createRouteMatcher(routes);
    }
    return _matcher(method, urlPath);
}

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Only what a process needs to run; nothing from the developer's shell
// (TGDL_*, FACES_*, SEEKBAR_*, FFMPEG_PATH …) leaks into the target.
const PASS_ENV = [
    'PATH',
    'Path',
    'SystemRoot',
    'SYSTEMROOT',
    'windir',
    'WINDIR',
    'ComSpec',
    'COMSPEC',
    'PATHEXT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'ProgramData',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'CommonProgramFiles',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    // CI: the app exits instead of answering PORT from Node when the
    // tgdl-core front server can't start, so a run is really through it.
    'TGDL_FRONT_REQUIRED',
];

function targetEnv({ port, dataDir, extra = {}, nodeEnv = 'test' }) {
    const env = {};
    for (const k of PASS_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
    return {
        ...env,
        PORT: String(port),
        TGDL_DATA_DIR: dataDir,
        NODE_ENV: nodeEnv,
        TZ: 'UTC',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        TGDL_GO_CORE: 'off',
        TGDL_DISABLE_AUTOSTART: '1',
        TGDL_FACES_AUTO_DOWNLOAD: 'false',
        TGDL_FACES_AUTO_INSTALL: 'false',
        // For targets that honour proxy env (Go's net/http does): no egress.
        HTTP_PROXY: 'http://127.0.0.1:9',
        HTTPS_PROXY: 'http://127.0.0.1:9',
        NO_PROXY: '127.0.0.1,localhost,::1',
        ...extra,
    };
}

function rmrf(dir) {
    for (let i = 0; i < 20; i++) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            return;
        } catch {
            /* Windows: handles closing */
        }
        const until = Date.now() + 150;
        while (Date.now() < until) {
            /* spin */
        }
    }
}

/**
 * Low-level HTTP. Never follows redirects; decodes gzip / deflate / br so
 * bodies compare by content (the Content-Encoding header is still recorded).
 * @returns {Promise<{status:number, headers:object, body:Buffer, json:any, text:string}>}
 */
export function rawRequest(
    baseUrl,
    method,
    urlPath,
    { headers = {}, body, timeoutMs = 60_000 } = {},
) {
    const u = new URL(urlPath, baseUrl);
    let payload = null;
    const h = { 'accept-encoding': 'identity', ...headers };
    if (body !== undefined) {
        if (Buffer.isBuffer(body) || typeof body === 'string') payload = Buffer.from(body);
        else {
            payload = Buffer.from(JSON.stringify(body));
            if (!Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) {
                h['content-type'] = 'application/json';
            }
        }
        h['content-length'] = String(payload.length);
    }
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: u.hostname,
                port: u.port,
                method,
                path: u.pathname + u.search,
                headers: h,
                agent: false,
            },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const wire = Buffer.concat(chunks);
                    // Decode content-encoding so bodies compare by content;
                    // the encoding itself stays visible in the headers.
                    const enc = String(res.headers['content-encoding'] || '').toLowerCase();
                    let buf = wire;
                    try {
                        if (enc === 'gzip') buf = zlib.gunzipSync(wire);
                        else if (enc === 'deflate') buf = zlib.inflateSync(wire);
                        else if (enc === 'br') buf = zlib.brotliDecompressSync(wire);
                    } catch {
                        buf = wire;
                    }
                    const text = buf.toString('utf8');
                    let json;
                    try {
                        json = JSON.parse(text);
                    } catch {
                        json = undefined;
                    }
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body: buf,
                        wireBytes: wire.length,
                        json,
                        text,
                    });
                });
                res.on('error', reject);
            },
        );
        req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${method} ${urlPath}`)));
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

// Big request bodies (id lists past a cap …) are generated by the test
// itself; keep the snapshot readable by recording their digest.
function requestBodyRecord(body) {
    const text = JSON.stringify(body);
    if (text === undefined || text.length <= 2000) return body;
    return { '<large request body>': { sha256: sha256(Buffer.from(text)), chars: text.length } };
}

/**
 * Start a target on a fresh seed.
 * @param {object} [opts]
 * @param {(cfg:object)=>void} [opts.configPatch]  edit the seeded config before boot
 * @param {(db:import('better-sqlite3').Database)=>void} [opts.afterDb] extra seed SQL
 * @param {(dataDir:string)=>void} [opts.beforeStart] extra files in the data dir
 * @param {object} [opts.env]        extra env for the target
 * @param {string} [opts.nodeEnv]    NODE_ENV (default 'test')
 */
export async function startTarget(opts = {}) {
    let dataDir = null;
    let child = null;
    let baseUrl;
    let port;
    let stable = new Set();
    const logs = [];

    if (TARGET === 'url') {
        baseUrl = process.env.CONTRACT_URL;
        if (!baseUrl) throw new Error('CONTRACT_TARGET=url needs CONTRACT_URL');
        const custom = ['configPatch', 'afterDb', 'beforeStart', 'env', 'nodeEnv'].filter(
            (k) => opts[k] !== undefined,
        );
        if (custom.length || opts.extra) {
            throw new Error(
                `CONTRACT_TARGET=url attaches to one hand-started server; this scenario needs a server of its own (${custom.join(', ') || 'extra target'}) — run it with CONTRACT_TARGET=node|go`,
            );
        }
        port = Number(new URL(baseUrl).port) || 80;
        dataDir = process.env.CONTRACT_DATA_DIR || null;
        const ref = buildSeed(fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-contract-ref-')));
        stable = ref.stable;
        rmrf(ref.dataDir);
    } else {
        dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-contract-')));
        ({ stable } = buildSeed(dataDir, opts));
        opts.beforeStart?.(dataDir);
        port = await freePort();
        baseUrl = `http://127.0.0.1:${port}`;
        const env = targetEnv({ port, dataDir, extra: opts.env, nodeEnv: opts.nodeEnv });
        let cmd;
        let args;
        if (TARGET === 'node') {
            cmd = process.execPath;
            args = ['--import', pathToFileURL(SANDBOX).href, SERVER_JS];
        } else if (TARGET === 'go') {
            cmd =
                process.env.CONTRACT_GO_BIN ||
                path.join(
                    REPO_ROOT,
                    'core-service',
                    'bin',
                    process.platform === 'win32' ? 'tgdl-server.exe' : 'tgdl-server',
                );
            args = [];
        } else {
            throw new Error(`unknown CONTRACT_TARGET=${TARGET}`);
        }
        child = spawn(cmd, args, { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
        const onData = (c) => {
            for (const line of c.toString('utf8').split(/\r?\n/)) {
                if (line) logs.push(line);
            }
            if (logs.length > 2000) logs.splice(0, logs.length - 2000);
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        let exited = null;
        child.on('exit', (code, sig) => {
            exited = { code, sig };
        });
        const deadline = Date.now() + 90_000;
        for (;;) {
            if (exited) {
                throw new Error(
                    `target exited during startup (${JSON.stringify(exited)}):\n${logs.slice(-40).join('\n')}`,
                );
            }
            try {
                const r = await rawRequest(baseUrl, 'GET', '/api/auth_check', { timeoutMs: 2000 });
                if (r.status === 200) break;
            } catch {
                /* not listening yet */
            }
            if (Date.now() > deadline) {
                child.kill('SIGKILL');
                throw new Error(`target did not become ready:\n${logs.slice(-40).join('\n')}`);
            }
            await sleep(100);
        }
        // Let the boot-time background work (sidecar probes, one-shot
        // sweeps) get past its first tick before scenarios start.
        await sleep(opts.settleMs ?? 400);
    }

    const norm = createNormalizer({
        dataDir,
        repoRoot: REPO_ROOT,
        port,
        stable,
        appVersion: APP_VERSION,
    });
    const staticMtimes = new Set([FIXED_MTIME_MS, Math.floor(FIXED_MTIME_MS / 1000) * 1000]);

    const cookieFor = (as) =>
        as === 'admin'
            ? `tg_dl_session=${SEED.adminToken}`
            : as === 'guest'
              ? `tg_dl_session=${SEED.guestToken}`
              : null;

    async function request(method, urlPath, o = {}) {
        const headers = { host: `127.0.0.1:${port}`, ...(o.headers || {}) };
        const cookie = o.cookie ?? cookieFor(o.as ?? 'admin');
        if (cookie) headers.cookie = cookie;
        return rawRequest(baseUrl, method, urlPath, { headers, body: o.body });
    }

    async function normalizeBody(res, o) {
        const ct = String(res.headers['content-type'] || '');
        const mode = o.bodyMode;
        if (res.body.length === 0) return null;
        if (mode === 'none') return { bytes: res.body.length };
        if (mode === 'sha256') return { sha256: sha256(res.body), bytes: res.body.length };
        if (mode === 'image') {
            const { default: sharp } = await import('sharp');
            try {
                const m = await sharp(res.body).metadata();
                return { image: { format: m.format, width: m.width, height: m.height } };
            } catch (e) {
                return { image: { error: e.message } };
            }
        }
        if (mode === 'zip') return { zip: zipEntries(res.body) };
        if (res.json !== undefined && (ct.includes('json') || mode === 'json')) {
            return {
                json: norm.value(res.json, null, '', { mask: o.mask, unordered: o.unordered }),
            };
        }
        if (isTextType(ct) || mode === 'text') {
            const text = norm.str(res.text);
            if (mode === 'text-hash' || text.length > 4000) {
                return { textSha256: sha256(Buffer.from(text)), chars: text.length };
            }
            return { text };
        }
        return { sha256: sha256(res.body), bytes: res.body.length };
    }

    /**
     * Normalise and record one exchange.
     * @param {string} label  unique within the file
     * @param {object} req    { method, path, as, body, headers }
     * @param {object} res    rawRequest result
     * @param {object} [o]    { bodyMode, mask:{path:reason}, headerMask:{name:reason},
     *                          unordered:[paths], route, note,
     *                          bodyRecord (pre-computed body record, e.g. a derived fact) }
     */
    async function record(label, req, res, o = {}) {
        const urlPath = req.path.split('?')[0];
        const ct = String(res.headers['content-type'] || '');
        const textual = o.bodyMode
            ? ['json', 'text', 'text-hash'].includes(o.bodyMode) ||
              (o.bodyMode === 'none' && isTextType(ct))
            : isTextType(ct);
        const rawHeaders = { ...res.headers };
        // Derived images: byte size depends on the encoder build.
        if (o.bodyMode === 'image') delete rawHeaders['content-length'];
        for (const name of Object.keys(o.headerMask || {})) {
            if (rawHeaders[name] !== undefined) rawHeaders[name] = '<masked>';
        }
        const { headers, security } = normalizeHeaders(rawHeaders, res.body, norm, {
            bodyIsText: textual,
            staticMtimes,
        });
        const sec = profileId(security);
        const entry = {
            route: o.route ?? routeOf(req.method, urlPath),
            request: {
                method: req.method,
                path: norm.str(req.path),
                as: req.as ?? 'admin',
                ...(req.headers
                    ? { headers: norm.value(maskRequestEtags(req.headers, staticMtimes)) }
                    : {}),
                ...(req.body !== undefined
                    ? { body: requestBodyRecord(norm.value(req.body)) }
                    : {}),
            },
            status: res.status,
            headers,
            security: sec,
            body: o.bodyRecord !== undefined ? o.bodyRecord : await normalizeBody(res, o),
        };
        if (o.mask || o.headerMask) {
            entry.masked = {
                ...(o.mask || {}),
                ...Object.fromEntries(
                    Object.entries(o.headerMask || {}).map(([k, v]) => [`header:${k}`, v]),
                ),
            };
        }
        if (o.unordered) entry.unordered = o.unordered;
        if (o.note) entry.note = o.note;
        api.store.record(label, entry, { profiles: { [sec]: security } });
        return entry;
    }

    /** request + record; returns the raw response for follow-up use. */
    async function exchange(label, method, urlPath, o = {}) {
        const req = {
            method,
            path: urlPath,
            as: o.as ?? 'admin',
            body: o.body,
            headers: o.headers,
        };
        if (o.cookie !== undefined) req.as = o.as ?? 'custom-cookie';
        const res = await request(method, urlPath, o);
        await record(label, req, res, o);
        return res;
    }

    /** Dashboard (or cluster) WebSocket that buffers everything it receives. */
    function ws({ as = 'admin', path: wsPath = '/', headers = {}, cookie } = {}) {
        const h = { ...headers };
        const c = cookie ?? cookieFor(as);
        if (c) h.cookie = c;
        const sock = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`, { headers: h });
        const messages = [];
        const waiters = [];
        let upgradeStatus = null;
        sock.on('message', (data) => {
            let msg;
            try {
                msg = JSON.parse(data.toString('utf8'));
            } catch {
                msg = { raw: data.toString('utf8') };
            }
            messages.push(msg);
            for (const w of [...waiters]) {
                if (w.pred(msg)) {
                    waiters.splice(waiters.indexOf(w), 1);
                    w.resolve(msg);
                }
            }
        });
        const opened = new Promise((resolve) => {
            sock.on('open', () => resolve({ open: true }));
            sock.on('unexpected-response', (_req, res) => {
                upgradeStatus = res.statusCode;
                resolve({ open: false, status: res.statusCode });
            });
            sock.on('error', (e) => {
                const m = /Unexpected server response: (\d+)/.exec(e.message);
                if (m) upgradeStatus = Number(m[1]);
                resolve({ open: false, status: upgradeStatus, error: e.code || 'error' });
            });
            sock.on('close', () => resolve({ open: false, status: upgradeStatus, closed: true }));
        });
        return {
            socket: sock,
            opened,
            messages,
            /** Wait for the first (future or buffered) message matching pred. */
            waitFor(pred, timeoutMs = 15_000) {
                const hit = messages.find(pred);
                if (hit) return Promise.resolve(hit);
                return new Promise((resolve, reject) => {
                    const w = { pred, resolve };
                    waiters.push(w);
                    setTimeout(() => {
                        const i = waiters.indexOf(w);
                        if (i >= 0) {
                            waiters.splice(i, 1);
                            reject(
                                new Error(
                                    `ws: no matching message within ${timeoutMs} ms; got ${JSON.stringify(messages.map((m) => m.type))}`,
                                ),
                            );
                        }
                    }, timeoutMs);
                });
            },
            /** Remove and return everything received so far. */
            drain() {
                return messages.splice(0, messages.length);
            },
            close() {
                try {
                    sock.close();
                } catch {
                    /* already closed */
                }
            },
        };
    }

    /**
     * Record a WS message sequence. Ambient timer events are dropped unless
     * `keep` lists them; `collapse` merges consecutive messages of the listed
     * types (job progress ticks whose count depends on timing) into one
     * `{ type, collapsed: true }` marker.
     */
    function recordWs(label, messages, o = {}) {
        const ignore = new Set(
            [...(o.ignore ?? AMBIENT_WS_TYPES)].filter((t) => !o.keep?.includes(t)),
        );
        const collapse = new Set(o.collapse ?? []);
        const out = [];
        for (const m of messages) {
            if (ignore.has(m?.type)) continue;
            if (collapse.has(m?.type)) {
                const last = out[out.length - 1];
                if (last?.type === m.type && last.collapsed) continue;
                out.push({ type: m.type, collapsed: true });
                continue;
            }
            out.push(norm.value(m, null, '', { mask: o.mask, unordered: o.unordered }));
        }
        // Concurrent, independent events (two jobs finishing in parallel, a
        // timer-driven status push): their relative order is not a contract.
        if (o.unorderedEvents) {
            out.sort((a, b) => {
                const x = JSON.stringify(a);
                const y = JSON.stringify(b);
                return x < y ? -1 : x > y ? 1 : 0;
            });
        }
        const entry = { ws: o.channel ?? 'dashboard', events: out };
        if (o.mask) entry.masked = o.mask;
        if (o.collapse) entry.collapsed = o.collapse;
        if (o.unorderedEvents) entry.unorderedEvents = o.unorderedEvents;
        if (o.note) entry.note = o.note;
        api.store.record(label, entry);
        return entry;
    }

    async function stop() {
        if (child && child.exitCode === null) {
            const done = new Promise((r) => child.once('exit', r));
            child.kill('SIGTERM');
            const t = setTimeout(() => child.kill('SIGKILL'), 8000);
            await done;
            clearTimeout(t);
        }
        if (dataDir && TARGET !== 'url') rmrf(dataDir);
    }

    const api = {
        target: TARGET,
        baseUrl,
        port,
        dataDir,
        norm,
        store: null,
        logs: () => logs.slice(),
        request,
        record,
        exchange,
        ws,
        recordWs,
        stop,
        seed: SEED,
    };
    return api;
}

/**
 * Wire a scenario file: fresh target before the first test, golden check /
 * write after the last. Returns a handle whose `.t` is the live target.
 */
export function useContract(fileUrl, opts = {}) {
    const store = snapshotStore(fileUrl);
    const extras = [];
    const handle = {
        t: null,
        store,
        /**
         * A second (third …) target in the same file — for scenarios that
         * need a differently seeded or configured server. Recorded into the
         * same snapshot file; stopped after the last test.
         */
        async extra(extraOpts = {}) {
            const t = await startTarget({ ...extraOpts, extra: true });
            t.store = store;
            extras.push(t);
            return t;
        },
    };
    beforeAll(async () => {
        handle.t = await startTarget(opts);
        handle.t.store = store;
    }, 120_000);
    afterAll(async () => {
        await handle.t?.stop();
        for (const t of extras) await t.stop();
        store.finish();
    }, 60_000);
    return handle;
}

/** Poll `fn` until it returns a truthy value (or throw after timeoutMs). */
export async function until(fn, { timeoutMs = 20_000, intervalMs = 100, what = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(intervalMs);
    }
}

export { sleep };

// Conditional request headers echo an etag the server handed out earlier.
// A static SPA asset's etag carries its checkout mtime and on-disk size
// (line endings differ between Windows and Linux checkouts), so mask it
// the same way the response etag is masked; seeded files keep theirs.
function maskRequestEtags(headers, staticMtimes) {
    const out = { ...headers };
    for (const k of Object.keys(out)) {
        if (!['if-none-match', 'if-match', 'if-range'].includes(k.toLowerCase())) continue;
        const m = /^W\/"([0-9a-f]+)-([0-9a-f]+)"$/.exec(String(out[k]));
        if (m && !staticMtimes?.has(parseInt(m[2], 16))) out[k] = 'W/"<size-hex>-<mtime-hex>"';
        // Express body etag: a hash of the body, which can carry the app
        // version (e.g. /api/version) and so changes with every release.
        else if (/^W\/"[0-9a-f]+-[A-Za-z0-9+/=]{27}"$/.test(String(out[k]))) {
            out[k] = 'W/"<express-etag>"';
        }
    }
    return out;
}
