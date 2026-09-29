/**
 * tgdl-core front server — lifecycle.
 *
 * The Node server listens on 127.0.0.1:<random>; `tgdl-core front` owns
 * the public PORT. It serves /files, /photos and thumbnail cache hits
 * itself (never writing the database: Node is told afterwards, see
 * lib/front-bridge.js) and proxies everything else here (see core-service/internal/front
 * and docs/GO-CORE.md). This module spawns it, hands it what it needs
 * (environment at spawn; the share secret and the auth-relevant config
 * over the token-gated control channel, never argv/env), restarts it, and
 * gives up — so the server can bind PORT itself — when it can't be kept
 * running.
 *
 *   startFront(opts)      spawn and wait for it to bind PORT
 *   pushFrontState()      send the current state now (config changed)
 *   stopFront()           graceful shutdown
 *   getFrontStatus()      for GET /api/system/health
 *   frontToken()          the X-Tgdl-Front value Node accepts
 */

import { spawn } from 'child_process';
import crypto from 'crypto';
import http from 'http';
import path from 'path';
import readline from 'readline';

import { CORE_VERSION, resolveCurrentBinary } from './spawn.js';

const LISTEN_TIMEOUT_MS = 10_000;
const HEALTH_INTERVAL_MS = 10_000;
const HEALTH_FAILURES_BEFORE_RESTART = 3;
const STATE_CHECK_MS = 2_000;
// Restart right away, then back off a little; this many exits inside the
// window and the server takes PORT itself (see startFront's onGiveUp).
const RESTART_DELAYS_MS = [50, 250, 1000, 2000, 5000];
const GIVE_UP_EXITS = 5;
const GIVE_UP_WINDOW_MS = 60_000;

// What a Go binary needs to run; the app's own secrets never reach it.
const PASSTHROUGH_ENV = [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'LANG',
    'LC_ALL',
    'TZ',
    'GOMAXPROCS',
    'GOMEMLIMIT',
    'GOGC',
    'TGDL_CORE_LOG_LEVEL',
];

let _opts = null;
let _child = null;
let _ctl = null; // { host, port, token }
let _upstreamToken = crypto.randomBytes(32).toString('hex');
let _stopped = false;
let _gaveUp = false;
let _exits = [];
let _restartTimer = null;
let _healthTimer = null;
let _stateTimer = null;
let _healthFailures = 0;
let _stateVersion = 0;
let _lastStateJson = '';
let _pushing = null;
let _status = {
    state: 'idle',
    error: null,
    pid: null,
    version: null,
    listen: null,
    binary: null,
    restarts: 0,
    since: Date.now(),
};

function _log(level, msg) {
    const line = `[go-front] ${msg}`;
    if (level === 'warn') console.warn(line);
    else console.log(line);
}

function _set(partial) {
    if (partial.state && partial.state !== _status.state) partial.since = Date.now();
    _status = { ..._status, ...partial };
}

/** The X-Tgdl-Front value requests proxied by tgdl-core carry. */
export function frontToken() {
    return _upstreamToken;
}

/** True while tgdl-core owns PORT (Node listens on loopback only). */
export function frontActive() {
    return Boolean(_child) && _status.state === 'running';
}

export function getFrontStatus() {
    return { ..._status, gaveUp: _gaveUp };
}

function _env(ctlToken) {
    const o = _opts;
    const env = {
        TGDL_CORE_TOKEN: ctlToken,
        TGDL_CORE_PORT: '0',
        TGDL_CORE_WATCH_STDIN: '1',
        TGDL_FRONT_LISTEN: `:${o.port}`,
        TGDL_FRONT_UPSTREAM: `127.0.0.1:${o.upstreamPort}`,
        TGDL_FRONT_UPSTREAM_TOKEN: _upstreamToken,
        TGDL_FRONT_TRUST_PROXY: o.trustProxy,
        TGDL_FRONT_DB: o.dbPath,
        TGDL_FRONT_DOWNLOADS_DIR: o.downloadsDir,
        TGDL_FRONT_PHOTOS_DIR: o.photosDir,
        TGDL_FRONT_THUMBS_DIR: o.thumbsDir,
        TGDL_CORE_ALLOW_ROOTS: o.allowRoots
            .map((r) => (process.platform === 'win32' && r.includes(';') ? `"${r}"` : r))
            .join(path.delimiter),
    };
    for (const k of PASSTHROUGH_ENV) {
        const v = process.env[k];
        if (v !== undefined && v !== '') env[k] = v;
    }
    return env;
}

// ---- control channel ---------------------------------------------------

function _request(method, pathname, body, timeoutMs = 3000) {
    const ctl = _ctl;
    if (!ctl) return Promise.reject(new Error('tgdl-core front is not running'));
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const headers = { accept: 'application/json', 'x-api-token': ctl.token };
        if (data) {
            headers['content-type'] = 'application/json';
            headers['content-length'] = String(data.length);
        }
        const req = http.request(
            { host: ctl.host, port: ctl.port, method, path: pathname, headers, agent: false },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    let json = null;
                    try {
                        json = text ? JSON.parse(text) : null;
                    } catch {}
                    resolve({ status: res.statusCode, body: json });
                });
                res.on('error', reject);
            },
        );
        req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs} ms`)));
        req.on('error', reject);
        req.end(data || undefined);
    });
}

/** Stats of the running front server (GET /v1/front/stats), or null. */
export async function frontStats() {
    try {
        const r = await _request('GET', '/v1/front/stats');
        return r.status === 200 ? r.body : null;
    } catch {
        return null;
    }
}

/**
 * Push the current state if it changed (or `force`). The state comes from
 * opts.getState(): { authReady, forceHttps, rateLimit, shareSecret, headers }.
 */
export function pushFrontState({ force = false } = {}) {
    if (!_ctl || !_opts?.getState) return Promise.resolve(false);
    if (_pushing) return _pushing.then(() => pushFrontState({ force }));
    _pushing = (async () => {
        let st;
        try {
            st = await _opts.getState();
        } catch (e) {
            _log('warn', `state unavailable: ${e?.message || e}`);
            return false;
        }
        const json = JSON.stringify(st);
        if (!force && json === _lastStateJson) return true;
        const version = ++_stateVersion;
        try {
            const r = await _request('POST', '/v1/front/state', { ...st, version });
            if (r.status !== 204) throw new Error(`state push answered ${r.status}`);
            _lastStateJson = json;
            return true;
        } catch (e) {
            _log('warn', `state push failed: ${e?.message || e}`);
            _lastStateJson = '';
            return false;
        }
    })().finally(() => {
        _pushing = null;
    });
    return _pushing;
}

// ---- process -----------------------------------------------------------

function _waitForEvent(child) {
    return new Promise((resolve, reject) => {
        const rl = readline.createInterface({ input: child.stdout });
        let done = false;
        const finish = (fn, v) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            child.off('exit', onExit);
            child.off('error', onError);
            fn(v);
        };
        const onExit = (code, sig) =>
            finish(reject, new Error(`exited before listening (code=${code} signal=${sig || ''})`));
        const onError = (e) => finish(reject, new Error(`spawn failed: ${e?.message || e}`));
        const timer = setTimeout(
            () => finish(reject, new Error('no listening line within 10 s')),
            LISTEN_TIMEOUT_MS,
        );
        timer.unref?.();
        child.once('exit', onExit);
        child.once('error', onError);
        rl.on('line', (line) => {
            const s = line.trim();
            if (!s) return;
            if (!done && s.startsWith('{')) {
                try {
                    const ev = JSON.parse(s);
                    if (ev?.event === 'listening' && /^127\.0\.0\.1:\d+$/.test(ev.addr)) {
                        finish(resolve, ev);
                        return;
                    }
                    if (ev?.event === 'error') {
                        const err = new Error(ev.message || ev.code || 'listen failed');
                        err.code = ev.code || 'EUNKNOWN';
                        finish(reject, err);
                        return;
                    }
                } catch {}
            }
            _log('info', s);
        });
    });
}

async function _spawnOnce() {
    // The binary tgdl-core's own process uses (spawn.js): TGDL_CORE_BIN, the
    // Docker image's, a current `npm run build:core`, or the installed
    // release — a stale one of an older version has no front server.
    const bin = await resolveCurrentBinary({ log: _log });
    if (!bin || bin.missing || bin.stale) {
        const err = new Error(
            bin?.missing
                ? `TGDL_CORE_BIN does not point at an executable file: ${bin.path}`
                : bin?.stale
                  ? `the installed tgdl-core is older than ${CORE_VERSION} (reinstall, or restart once the app has downloaded it)`
                  : `no tgdl-core binary for ${process.platform}/${process.arch} (run \`npm install\` or \`npm run build:core\`)`,
        );
        err.code = 'ENOBINARY';
        throw err;
    }
    const ctlToken = crypto.randomBytes(24).toString('hex');
    _set({ state: 'starting', error: null, binary: { path: bin.path, source: bin.source } });
    const child = spawn(bin.path, ['front'], {
        env: _env(ctlToken),
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: path.dirname(bin.path),
        windowsHide: true,
    });
    child.stdin.on('error', () => {});
    const errRl = readline.createInterface({ input: child.stderr });
    errRl.on('line', (line) => {
        const s = line.trim();
        if (s) _log(/level=(WARN|ERROR)/.test(s) ? 'warn' : 'info', s);
    });
    let ev;
    try {
        ev = await _waitForEvent(child);
    } catch (e) {
        try {
            child.kill();
        } catch {}
        throw e;
    }
    _child = child;
    const [host, port] = ev.addr.split(':');
    _ctl = { host, port: Number(port), token: ctlToken };
    child.on('exit', (code, sig) => _onExit(child, code, sig));
    _set({
        state: 'running',
        error: null,
        pid: child.pid,
        version: ev.version || null,
        listen: ev.front || null,
    });
    _lastStateJson = '';
    await pushFrontState({ force: true });
    _startMonitors(child);
    return ev;
}

function _startMonitors(child) {
    _stopMonitors();
    _healthFailures = 0;
    _healthTimer = setInterval(async () => {
        if (_child !== child) return;
        try {
            const r = await _request('GET', '/health', undefined, 3000);
            if (r.status !== 200 || r.body?.ok !== true) throw new Error(`health ${r.status}`);
            _healthFailures = 0;
            if (_status.state !== 'running') _set({ state: 'running', error: null });
            // A restarted process (or a lost push) has an older state.
            if ((r.body?.front?.stateVersion ?? 0) < _stateVersion || !_lastStateJson) {
                pushFrontState({ force: true });
            }
        } catch (e) {
            _healthFailures++;
            _set({ state: 'unhealthy', error: String(e?.message || e).slice(0, 200) });
            if (_healthFailures >= HEALTH_FAILURES_BEFORE_RESTART) {
                _log('warn', `${_healthFailures} failed health checks; restarting tgdl-core front`);
                _healthFailures = 0;
                try {
                    child.kill();
                } catch {}
            }
        }
    }, HEALTH_INTERVAL_MS);
    _healthTimer.unref?.();
    _stateTimer = setInterval(() => {
        if (_child === child) pushFrontState();
    }, STATE_CHECK_MS);
    _stateTimer.unref?.();
}

function _stopMonitors() {
    if (_healthTimer) clearInterval(_healthTimer);
    if (_stateTimer) clearInterval(_stateTimer);
    _healthTimer = null;
    _stateTimer = null;
}

function _onExit(child, code, sig) {
    if (_child !== child) return;
    _child = null;
    _ctl = null;
    _stopMonitors();
    const why = `exit code=${code} signal=${sig || ''}`;
    _set({ state: 'exited', error: why, pid: null });
    if (!_stopped) _scheduleRestart(why);
}

// Restart with a short backoff; too many failures in the window → give up.
function _scheduleRestart(why) {
    const now = Date.now();
    _exits = _exits.filter((t) => now - t < GIVE_UP_WINDOW_MS);
    _exits.push(now);
    if (_exits.length >= GIVE_UP_EXITS) {
        _giveUp(
            `tgdl-core front failed ${_exits.length} times within ${GIVE_UP_WINDOW_MS / 1000} s (last: ${why})`,
        );
        return;
    }
    const delay = RESTART_DELAYS_MS[Math.min(_exits.length - 1, RESTART_DELAYS_MS.length - 1)];
    _log('warn', `tgdl-core front stopped (${why}); restarting in ${delay} ms`);
    clearTimeout(_restartTimer);
    _restartTimer = setTimeout(() => {
        _restartTimer = null;
        _restart();
    }, delay);
    _restartTimer.unref?.();
}

async function _restart() {
    if (_stopped || _child || _gaveUp) return;
    _status.restarts++;
    try {
        await _spawnOnce();
        _log('info', `tgdl-core front back on ${_status.listen}`);
    } catch (e) {
        const why = String(e?.message || e).slice(0, 300);
        _set({ state: 'exited', error: why });
        if (e?.code === 'ENOBINARY') _giveUp(why);
        else if (!_stopped) _scheduleRestart(why);
    }
}

function _giveUp(reason) {
    if (_gaveUp) return;
    _gaveUp = true;
    _set({ state: 'gave_up', error: reason });
    _log('warn', `giving up on tgdl-core front: ${reason}`);
    try {
        _opts?.onGiveUp?.(reason);
    } catch (e) {
        _log('warn', `onGiveUp failed: ${e?.message || e}`);
    }
}

/**
 * Spawn `tgdl-core front` and wait until it has bound PORT.
 *
 * @param {object} opts
 * @param {number} opts.port            public port (the app's PORT)
 * @param {number} opts.upstreamPort    Node's loopback port
 * @param {string} opts.trustProxy      effective `trust proxy` ("" = none)
 * @param {string} opts.dbPath          db.sqlite
 * @param {string} opts.downloadsDir    /files root
 * @param {string} opts.photosDir       /photos root
 * @param {string} opts.thumbsDir       thumbnail cache
 * @param {string[]} opts.allowRoots    every directory tgdl-core may serve from
 * @param {() => object|Promise<object>} opts.getState
 * @param {(reason: string) => void} opts.onGiveUp  tgdl-core can't be kept up
 * @returns {Promise<{ ok: true, listen: string } | { ok: false, code: string, error: string }>}
 */
export async function startFront(opts) {
    _opts = opts;
    _stopped = false;
    _gaveUp = false;
    _exits = [];
    try {
        const ev = await _spawnOnce();
        _log('info', `tgdl-core front ${ev.version} on ${ev.front} (pid ${ev.pid})`);
        return { ok: true, listen: ev.front };
    } catch (e) {
        const msg = String(e?.message || e).slice(0, 300);
        _set({ state: e?.code === 'ENOBINARY' ? 'binary_missing' : 'failed', error: msg });
        return { ok: false, code: e?.code || 'EUNKNOWN', error: msg };
    }
}

/** Stop the front server (graceful shutdown). Synchronous, idempotent. */
export function stopFront() {
    _stopped = true;
    clearTimeout(_restartTimer);
    _restartTimer = null;
    _stopMonitors();
    const child = _child;
    _child = null;
    _ctl = null;
    if (!child) return;
    try {
        child.stdin.end(); // tgdl-core drains and exits on stdin EOF
    } catch {}
    const t = setTimeout(() => {
        try {
            child.kill();
        } catch {}
    }, 3000);
    t.unref?.();
    child.once('exit', () => clearTimeout(t));
    _set({ state: 'stopped', error: null, pid: null });
}

/** Test helper. */
export function _resetFrontForTests() {
    stopFront();
    _upstreamToken = crypto.randomBytes(32).toString('hex');
    _status = { ..._status, state: 'idle', restarts: 0 };
    _gaveUp = false;
    _exits = [];
}
