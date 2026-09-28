/**
 * tgdl-core lifecycle — find (or download) the Go binary, spawn it on
 * 127.0.0.1, health-check it, restart it, stop it.
 *
 * Everything here is best-effort: any failure leaves the client without
 * an endpoint, and every feature keeps running on its Node
 * implementation. Nothing in this module blocks server startup — the
 * server calls `startGoCore()` from its listen callback without awaiting.
 *
 * Binary lookup, first hit wins:
 *
 *   1. TGDL_CORE_BIN                      explicit path (only this one is
 *                                         tried when set)
 *   2. /app/bin/tgdl-core                 Docker image (Linux)
 *   3. core-service/bin/tgdl-core-<slug>  `npm run build:core`
 *   4. data/core-service/bin/tgdl-core-<slug>
 *                                         downloaded from the GitHub release
 *                                         `core-v${CORE_VERSION}`, checked
 *                                         against its SHA256SUMS asset
 *
 * The child gets a minimal environment (token, port 0, pool size, the
 * directories it may read, the few OS variables a Go binary needs) —
 * never the app's own secrets — and a stdin pipe that stays open: when
 * this process dies, tgdl-core reads EOF and exits, so it can't linger as
 * an orphan (Windows doesn't reap children with their parent).
 */

import { execFile, spawn } from 'child_process';
import crypto from 'crypto';
import { createWriteStream, readFileSync, statSync, promises as fsp } from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import readline from 'readline';

import { getDataDir, getDownloadsDir, getRepoRoot, resolveConfigDownloadPath } from '../paths.js';
import * as client from './client.js';
import {
    anyFeatureEnabled,
    invalidateConfig,
    resolveGlobalMode,
    setConfigReader,
} from './flags.js';
import { getHashStats } from './hash.js';

/**
 * Pinned tgdl-core release. The GitHub Release `core-v<VER>` must carry
 * `tgdl-core-<slug>.tar.gz` for every slug below plus `SHA256SUMS`.
 * Bumping it makes existing installs download the new binary on boot.
 */
export const CORE_VERSION = '0.1.0';
export const SUPPORTED_SLUGS = Object.freeze([
    'win-x64',
    'win-arm64',
    'linux-x64',
    'linux-arm64',
    'linux-x86',
    'mac-arm64',
]);
export const DOCKER_BIN = '/app/bin/tgdl-core';

const RELEASES = 'https://github.com/botnick/telegram-media-downloader/releases/download';
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
const DOWNLOAD_REDIRECT_LIMIT = 5;
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
const LISTEN_TIMEOUT_MS = 10_000;
const HEALTH_INTERVAL_MS = 30_000;
const HEALTH_FAILURES_BEFORE_RESTART = 3;
const RESTART_BASE_MS = 2_000;
const RESTART_MAX_MS = 5 * 60_000;
const STABLE_RUN_MS = 2 * 60_000;

let _state = {
    state: 'idle',
    error: null,
    pid: null,
    version: null,
    binary: null,
    allowRoots: null,
    since: Date.now(),
};
let _child = null;
let _childStartedAt = 0;
let _startingPromise = null;
let _stopped = false;
let _restarts = 0;
let _restartTimer = null;
let _healthTimer = null;
let _healthFailures = 0;
let _unwatchConfig = null;
let _readConfig = null;
let _lastConfigKeys = null;
let _exitHookInstalled = false;

function _log(level, msg) {
    const line = `[go-core] ${msg}`;
    if (level === 'warn') console.warn(line);
    else console.log(line);
}

function _setState(partial) {
    const next = { ..._state, ...partial };
    if (partial.state && partial.state !== _state.state) next.since = Date.now();
    _state = next;
}

// ---- Binary lookup ---------------------------------------------------------

/** Release slug for this host, or null when no binary is built for it. */
export function platformSlug(platform = process.platform, arch = process.arch) {
    const os = { win32: 'win', linux: 'linux', darwin: 'mac' }[platform];
    if (!os) return null;
    let a = null;
    if (arch === 'x64') a = 'x64';
    else if (arch === 'arm64') a = 'arm64';
    else if (arch === 'ia32' && platform === 'linux') a = 'x86';
    if (!a) return null;
    const slug = `${os}-${a}`;
    return SUPPORTED_SLUGS.includes(slug) ? slug : null;
}

export function binaryFileName(slug, platform = process.platform) {
    return `tgdl-core-${slug}${platform === 'win32' ? '.exe' : ''}`;
}

function _downloadDir() {
    return path.join(getDataDir(), 'core-service', 'bin');
}

function _isUsable(p) {
    try {
        const st = statSync(p);
        if (!st.isFile() || st.size === 0) return false;
        if (process.platform !== 'win32' && (st.mode & 0o111) === 0) return false;
        return true;
    } catch {
        return false;
    }
}

function _readVersionMarker(binPath) {
    try {
        return readFileSync(`${binPath}.version`, 'utf8').trim();
    } catch {
        return null;
    }
}

/**
 * Where the binary is. Returns `{ path, source, stale? }`, or
 * `{ path, source: 'env', missing: true }` for a TGDL_CORE_BIN that
 * doesn't exist, or null.
 */
export function resolveBinary() {
    const explicit = String(process.env.TGDL_CORE_BIN || '').trim();
    if (explicit) {
        const p = path.resolve(explicit);
        return _isUsable(p)
            ? { path: p, source: 'env' }
            : { path: p, source: 'env', missing: true };
    }
    if (process.platform === 'linux' && _isUsable(DOCKER_BIN)) {
        return { path: DOCKER_BIN, source: 'docker' };
    }
    const slug = platformSlug();
    if (!slug) return null;
    const name = binaryFileName(slug);
    const dev = path.join(getRepoRoot(), 'core-service', 'bin', name);
    if (_isUsable(dev)) return { path: dev, source: 'dev' };
    const downloaded = path.join(_downloadDir(), name);
    if (_isUsable(downloaded)) {
        return {
            path: downloaded,
            source: 'download',
            stale: _readVersionMarker(downloaded) !== CORE_VERSION,
        };
    }
    return null;
}

// ---- Download --------------------------------------------------------------

function _releaseBase() {
    const override = String(process.env.TGDL_CORE_RELEASE_URL || '').trim();
    if (override) return override.replace(/\/+$/, '');
    return `${RELEASES}/core-v${CORE_VERSION}`;
}

/** Parse `sha256sum` output: "<hex>  <name>" (or "<hex> *<name>") per line. */
export function parseSha256Sums(text) {
    const out = {};
    for (const line of String(text || '').split(/\r?\n/)) {
        const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
        if (m) out[m[2]] = m[1].toLowerCase();
    }
    return out;
}

/**
 * GET `url`, following redirects. Streams the body into `destPath` (and
 * returns its SHA-256) or, with no destPath, returns it as a string.
 */
function _get(url, { destPath = null, maxBytes, redirectsLeft = DOWNLOAD_REDIRECT_LIMIT } = {}) {
    return new Promise((resolve, reject) => {
        let parsed;
        try {
            parsed = new URL(url);
        } catch {
            reject(new Error(`bad url: ${url}`));
            return;
        }
        const lib = parsed.protocol === 'http:' ? http : https;
        const req = lib.get(
            url,
            {
                headers: { 'user-agent': 'tgdl-core-spawn', accept: 'application/octet-stream' },
                timeout: DOWNLOAD_IDLE_TIMEOUT_MS,
            },
            (res) => {
                if (
                    res.statusCode >= 300 &&
                    res.statusCode < 400 &&
                    res.headers.location &&
                    redirectsLeft > 0
                ) {
                    res.resume();
                    const next = new URL(res.headers.location, url).toString();
                    _get(next, { destPath, maxBytes, redirectsLeft: redirectsLeft - 1 }).then(
                        resolve,
                        reject,
                    );
                    return;
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new Error(`http ${res.statusCode} from ${url}`));
                    return;
                }
                const hash = crypto.createHash('sha256');
                const chunks = [];
                let size = 0;
                const ws = destPath ? createWriteStream(destPath) : null;
                const fail = (e) => {
                    ws?.destroy();
                    res.destroy();
                    reject(e);
                };
                res.on('data', (c) => {
                    size += c.length;
                    if (size > maxBytes) {
                        fail(new Error(`download larger than ${maxBytes} bytes: ${url}`));
                        return;
                    }
                    hash.update(c);
                    if (ws) {
                        if (!ws.write(c)) {
                            res.pause();
                            ws.once('drain', () => res.resume());
                        }
                    } else {
                        chunks.push(c);
                    }
                });
                res.on('error', fail);
                res.on('end', () => {
                    if (!ws) {
                        resolve(Buffer.concat(chunks).toString('utf8'));
                        return;
                    }
                    ws.end(() => resolve(hash.digest('hex')));
                });
                ws?.on('error', fail);
            },
        );
        req.on('timeout', () => req.destroy(new Error(`download stalled: ${url}`)));
        req.on('error', reject);
    });
}

function _execFile(cmd, args, opts) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, opts, (err, stdout, stderr) => {
            if (err) {
                err.stderr = String(stderr || '');
                reject(err);
            } else resolve({ stdout, stderr });
        });
    });
}

/**
 * Extract a .tar.gz into destDir. tar runs inside destDir with a relative
 * archive path: GNU tar (Git for Windows puts it first on PATH) reads an
 * absolute `C:\…` as `host:path` and fails, relative paths work with GNU
 * tar and bsdtar alike. No tar at all → the streaming Node extractor the
 * faces sidecar uses.
 */
async function _extract(tarPath, destDir) {
    const rel = path.relative(destDir, tarPath);
    const archiveArg = path.isAbsolute(rel) ? tarPath : rel;
    try {
        await _execFile('tar', ['-xzf', archiveArg], {
            cwd: destDir,
            timeout: 120_000,
            windowsHide: true,
        });
        return;
    } catch (e) {
        _log('warn', `system tar failed (${e.code || e.message}); using the Node extractor`);
    }
    const { _extractTarballNodeFallback } = await import('../ai/faces-spawn.js');
    await _extractTarballNodeFallback(tarPath, destDir);
}

async function _download(slug) {
    const dir = _downloadDir();
    await fsp.mkdir(dir, { recursive: true });
    const base = _releaseBase();
    const tarName = `tgdl-core-${slug}.tar.gz`;
    _setState({ state: 'downloading', error: null });
    _log('info', `downloading ${tarName} (core-v${CORE_VERSION})`);

    const sums = parseSha256Sums(await _get(`${base}/SHA256SUMS`, { maxBytes: 64 * 1024 }));
    const expected = sums[tarName];
    if (!expected) throw new Error(`SHA256SUMS has no entry for ${tarName}`);

    const staging = await fsp.mkdtemp(path.join(dir, '.staging-'));
    try {
        const tarPath = path.join(staging, tarName);
        const actual = await _get(`${base}/${tarName}`, {
            destPath: tarPath,
            maxBytes: MAX_TARBALL_BYTES,
        });
        if (actual !== expected) {
            throw new Error(`checksum mismatch for ${tarName} (got ${actual}, want ${expected})`);
        }
        await _extract(tarPath, staging);
        const inner = path.join(
            staging,
            process.platform === 'win32' ? 'tgdl-core.exe' : 'tgdl-core',
        );
        const st = await fsp.stat(inner).catch(() => null);
        if (!st?.isFile() || st.size === 0) throw new Error(`${tarName} has no tgdl-core binary`);
        if (process.platform !== 'win32') await fsp.chmod(inner, 0o755);
        const final = path.join(dir, binaryFileName(slug));
        await fsp.rename(inner, final);
        await fsp.writeFile(`${final}.version`, `${CORE_VERSION}\n`);
        return final;
    } finally {
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
}

// ---- Spawn -----------------------------------------------------------------

// Only what a Go binary needs to run. The app's own env (session secrets,
// tokens for other services, proxies) never reaches the child.
const PASSTHROUGH_ENV = [
    'PATH',
    'SystemRoot', // Winsock refuses to initialise without it
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
    'HASH_WORKER_POOL_SIZE',
    'TGDL_CORE_LOG_LEVEL',
];

function _safeConfig() {
    try {
        return _readConfig?.() ?? null;
    } catch {
        return null;
    }
}

/**
 * Directories tgdl-core may read files from (TGDL_CORE_ALLOW_ROOTS) —
 * everywhere the app hashes from:
 *   - getDownloadsDir(): the downloader's default target, dedup's base;
 *   - <data dir>/downloads: nsfw.js resolves relative rows there, even
 *     when TGDL_DOWNLOADS_DIR points elsewhere;
 *   - config.download.path when it is custom (resolved like the
 *     downloader does, relative to the working directory);
 *   - extra roots from this process's own TGDL_CORE_ALLOW_ROOTS.
 * Hashing happens on final paths only (after the .part rename), so no
 * temp directory is needed. A file anywhere else gets EOUTSIDE from
 * tgdl-core and is hashed by Node, exactly as before.
 */
export function allowRoots(config = _safeConfig()) {
    const out = [];
    const seen = new Set();
    const add = (p) => {
        if (typeof p !== 'string' || !p.trim()) return;
        const abs = path.resolve(p.trim());
        const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
        if (seen.has(key)) return;
        seen.add(key);
        out.push(abs);
    };
    add(getDownloadsDir());
    add(path.join(getDataDir(), 'downloads'));
    const custom = config?.download?.path;
    if (typeof custom === 'string' && custom.trim()) add(resolveConfigDownloadPath(custom));
    for (const p of String(process.env.TGDL_CORE_ALLOW_ROOTS || '').split(path.delimiter)) add(p);
    return out;
}

/** PATH-style list; Go's filepath.SplitList honours quotes on Windows. */
function _joinRoots(roots) {
    return roots
        .map((r) => (process.platform === 'win32' && r.includes(';') ? `"${r}"` : r))
        .join(path.delimiter);
}

export function childEnv(token, roots = allowRoots()) {
    const env = {
        TGDL_CORE_TOKEN: token,
        TGDL_CORE_PORT: '0',
        TGDL_CORE_WATCH_STDIN: '1',
        TGDL_CORE_ALLOW_ROOTS: _joinRoots(roots),
    };
    for (const k of PASSTHROUGH_ENV) {
        const v = process.env[k];
        if (v !== undefined && v !== '') env[k] = v;
    }
    return env;
}

function _waitForListening(child) {
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
        rl.on('close', () => finish(reject, new Error('stdout closed before listening')));
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
                } catch {}
            }
            _log('info', s);
        });
    });
}

async function _probe(attempts = 20) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
        try {
            const h = await client.health();
            await client.stats(); // token-gated: proves the token works
            return h;
        } catch (e) {
            lastErr = e;
            await new Promise((r) => setTimeout(r, 250));
        }
    }
    throw lastErr || new Error('health probe failed');
}

function _installExitHook() {
    if (_exitHookInstalled) return;
    _exitHookInstalled = true;
    process.once('exit', () => {
        try {
            _child?.kill();
        } catch {}
    });
}

async function _spawn(bin) {
    const token = crypto.randomBytes(24).toString('hex');
    const roots = allowRoots();
    _setState({
        state: 'starting',
        error: null,
        binary: { path: bin.path, source: bin.source },
        allowRoots: roots,
    });
    const child = spawn(bin.path, ['serve'], {
        env: childEnv(token, roots),
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: path.dirname(bin.path),
        windowsHide: true,
    });
    _installExitHook();
    _child = child;
    _childStartedAt = Date.now();
    child.stdin.on('error', () => {});
    child.on('error', (e) => {
        // ENOENT / EACCES at spawn time; 'exit' may not follow.
        if (_child !== child) return;
        _child = null;
        client.clearEndpoint();
        _setState({ state: 'exited', error: `spawn failed: ${e.message}`, pid: null });
    });
    const errRl = readline.createInterface({ input: child.stderr });
    errRl.on('line', (line) => {
        const s = line.trim();
        if (s) _log(/level=(WARN|ERROR)/.test(s) ? 'warn' : 'info', s);
    });
    child.on('exit', (code, sig) => _onExit(child, code, sig));

    const ev = await _waitForListening(child);
    if (_child !== child) return false;
    client.setEndpoint(`http://${ev.addr}`, token, []);
    const h = await _probe();
    if (_child !== child) return false;
    client.markHealthy(h);
    _healthFailures = 0;
    _setState({
        state: 'running',
        error: null,
        pid: child.pid,
        version: h.version ?? ev.version ?? null,
    });
    if (h.version && h.version !== CORE_VERSION) {
        _log('warn', `running tgdl-core ${h.version}, this app expects ${CORE_VERSION}`);
    }
    _log('info', `tgdl-core ${h.version} running (pid ${child.pid}, ${bin.source} binary)`);
    _startHealthMonitor(child);
    return true;
}

function _onExit(child, code, sig) {
    if (_child !== child) return;
    _child = null;
    _stopHealthMonitor();
    client.clearEndpoint();
    const ranMs = Date.now() - _childStartedAt;
    _setState({ state: 'exited', error: `exit code=${code} signal=${sig || ''}`, pid: null });
    if (_stopped) return;
    if (ranMs > STABLE_RUN_MS) _restarts = 0;
    _restarts++;
    const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** (_restarts - 1));
    _log('warn', `tgdl-core exited (code=${code} signal=${sig || ''}); restarting in ${delay} ms`);
    clearTimeout(_restartTimer);
    _restartTimer = setTimeout(() => {
        _restartTimer = null;
        if (!_stopped && !_child) startGoCore().catch(() => {});
    }, delay);
    _restartTimer.unref?.();
}

function _startHealthMonitor(child) {
    _stopHealthMonitor();
    _healthTimer = setInterval(async () => {
        if (_child !== child) return _stopHealthMonitor();
        try {
            const h = await client.health();
            _healthFailures = 0;
            client.markHealthy(h);
            if (_state.state !== 'running') _setState({ state: 'running', error: null });
        } catch (e) {
            _healthFailures++;
            _setState({ state: 'unhealthy', error: String(e?.message || e).slice(0, 200) });
            if (_healthFailures >= HEALTH_FAILURES_BEFORE_RESTART) {
                _log('warn', `${_healthFailures} failed health checks; restarting tgdl-core`);
                _healthFailures = 0;
                try {
                    child.kill();
                } catch {}
            }
        }
    }, HEALTH_INTERVAL_MS);
    _healthTimer.unref?.();
}

function _stopHealthMonitor() {
    if (_healthTimer) clearInterval(_healthTimer);
    _healthTimer = null;
}

function _killChild() {
    const child = _child;
    _child = null;
    _stopHealthMonitor();
    client.clearEndpoint();
    if (!child) return;
    try {
        child.stdin.end(); // tgdl-core exits on stdin EOF
    } catch {}
    try {
        child.kill();
    } catch {}
}

// ---- Public API ------------------------------------------------------------

function _configKeys() {
    const cfg = _safeConfig();
    return {
        flags: JSON.stringify(cfg?.advanced?.goCore ?? null),
        roots: JSON.stringify(allowRoots(cfg)),
    };
}

async function _start() {
    if (!anyFeatureEnabled()) {
        _setState({ state: 'disabled', error: null, pid: null });
        return false;
    }
    let bin = resolveBinary();
    if (bin?.missing) {
        _setState({
            state: 'binary_missing',
            error: `TGDL_CORE_BIN does not point at an executable file: ${bin.path}`,
            binary: { path: bin.path, source: bin.source },
        });
        return false;
    }
    const slug = platformSlug();
    if (!bin || bin.stale) {
        if (!slug) {
            _setState({
                state: 'unsupported',
                error: `no tgdl-core build for ${process.platform}/${process.arch}`,
            });
            return false;
        }
        try {
            bin = { path: await _download(slug), source: 'download' };
        } catch (e) {
            const msg = String(e?.message || e).slice(0, 300);
            if (bin?.stale) {
                _log(
                    'warn',
                    `update to core-v${CORE_VERSION} failed (${msg}); using the old binary`,
                );
            } else {
                _setState({ state: 'binary_missing', error: `download failed: ${msg}` });
                _log('warn', `tgdl-core unavailable, Node handles everything: ${msg}`);
                return false;
            }
        }
    }
    if (_stopped) return false;
    try {
        return await _spawn(bin);
    } catch (e) {
        const msg = String(e?.message || e).slice(0, 300);
        _log('warn', `tgdl-core failed to start: ${msg}`);
        const child = _child;
        _killChild();
        _setState({ state: 'unhealthy', error: msg, pid: null });
        // A child that died on its own already scheduled a restart via
        // _onExit; one we just killed did not (it is no longer _child).
        if (child && !_stopped && !_restartTimer) {
            _restarts++;
            const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** (_restarts - 1));
            _restartTimer = setTimeout(() => {
                _restartTimer = null;
                if (!_stopped && !_child) startGoCore().catch(() => {});
            }, delay);
            _restartTimer.unref?.();
        }
        return false;
    }
}

/**
 * Start tgdl-core if any feature wants it. Never throws; resolves true
 * when the process is up and healthy. Safe to call repeatedly.
 *
 * @param {object} [opts]
 * @param {() => object} [opts.readConfig]   returns the app config
 *        (advanced.goCore for the flags, download.path for the roots)
 * @param {(cb: Function) => Function} [opts.watchConfig]  config.watchConfig
 */
export async function startGoCore(opts = {}) {
    if (opts.readConfig) {
        _readConfig = opts.readConfig;
        setConfigReader(() => _readConfig?.()?.advanced?.goCore);
        _lastConfigKeys = _configKeys();
        if (opts.watchConfig && !_unwatchConfig) {
            try {
                _unwatchConfig = opts.watchConfig(() => {
                    const keys = _configKeys();
                    const prev = _lastConfigKeys;
                    _lastConfigKeys = keys;
                    const rootsChanged = keys.roots !== prev?.roots;
                    if (keys.flags === prev?.flags && !rootsChanged) return;
                    invalidateConfig();
                    // New download folder: restart so tgdl-core gets the
                    // new allow-list (until then Node hashes those files).
                    refreshGoCore({ restart: rootsChanged }).catch(() => {});
                });
            } catch {
                _unwatchConfig = null;
            }
        }
    }
    _stopped = false;
    if (_startingPromise) return _startingPromise;
    if (_child) return _state.state === 'running';
    _startingPromise = (async () => {
        try {
            return await _start();
        } catch (e) {
            _setState({ state: 'unhealthy', error: String(e?.message || e).slice(0, 300) });
            return false;
        } finally {
            _startingPromise = null;
        }
    })();
    return _startingPromise;
}

/**
 * Re-evaluate after a config change: start when a feature was switched
 * on, stop when all are off, restart when `restart` (new allow-roots).
 */
export async function refreshGoCore({ restart = false } = {}) {
    invalidateConfig();
    if (!anyFeatureEnabled()) {
        clearTimeout(_restartTimer);
        _restartTimer = null;
        _killChild();
        _setState({ state: 'disabled', error: null, pid: null });
        return false;
    }
    if (restart && _child) {
        _killChild();
        _setState({ state: 'exited', error: 'restarting for new allow-roots', pid: null });
    }
    return startGoCore();
}

/** Stop tgdl-core for good (graceful shutdown). Synchronous, idempotent. */
export function stopGoCore() {
    _stopped = true;
    clearTimeout(_restartTimer);
    _restartTimer = null;
    _unwatchConfig?.();
    _unwatchConfig = null;
    _killChild();
    _setState({ state: 'stopped', error: null, pid: null });
}

/** Status block for GET /api/system/health (`goCore`). */
export function getGoCoreStatus() {
    const g = resolveGlobalMode();
    return {
        mode: g.mode,
        modeSource: g.source,
        state: _state.state,
        since: _state.since,
        error: _state.error,
        pid: _state.pid,
        version: _state.version,
        expectedVersion: CORE_VERSION,
        binary: _state.binary,
        allowRoots: _state.allowRoots ?? null,
        restarts: _restarts,
        features: { hash: getHashStats() },
    };
}
