/**
 * Seekbar sidecar — lifecycle for the Go HTTP service.
 *
 * Matches the `faces-spawn.js` UX: on boot, the module decides between
 * three install modes (in priority order):
 *
 *   1. **Operator / compose override** — `SEEKBAR_SIDECAR_URL` env or
 *      `config.advanced.seekbar.sidecarUrl`. We record the URL and
 *      probe `/health`; if green, callers can immediately submit jobs.
 *   2. **Auto-spawn local binary** — when no URL is set, we look for
 *      `seekbar-service/bin/seekbar-server(.exe)` relative to the
 *      project root. If found, we spawn it on a free localhost port
 *      with every knob from `loadConfig().advanced.seekbar.*` forwarded
 *      as env vars (so the Maintenance → Seekbar page is the single
 *      source of truth — no one edits `seekbar-service/` directly).
 *   3. **Disabled** — status flips to `{ok:false, error:'binary_missing'}`
 *      and the maintenance page renders a clear "Build the sidecar with
 *      `npm run build:seekbar`" message. The feature stays dormant
 *      until the binary exists or a URL is set.
 *
 * Every state transition emits a `seekbar_sidecar_status` WS broadcast
 * so the maintenance page's status pill updates in real time.
 */

import { spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import { createWriteStream, existsSync, promises as fsp, statSync } from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig } from '../../config/manager.js';
import { resolveFfmpegBin, resolveFfprobeBin } from '../thumbs.js';
import { health, setSidecarUrl } from './client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const DATA_DIR = process.env.TGDL_DATA_DIR
    ? path.resolve(process.env.TGDL_DATA_DIR)
    : path.join(PROJECT_ROOT, 'data');

/**
 * Pinned sidecar release. Bumping this triggers a fresh binary download
 * on next boot — the matching GitHub Release `seekbar-v<VER>` must exist
 * with `tgdl-seekbar-<platform>-<arch>.tar.gz` assets attached.
 */
export const SIDECAR_VERSION = '0.3.1';
const GH_RELEASE_BASE = `https://github.com/botnick/telegram-media-downloader/releases/download/seekbar-v${SIDECAR_VERSION}`;
const DOWNLOAD_CONNECT_TIMEOUT_MS = 30_000;
const DOWNLOAD_REDIRECT_LIMIT = 5;

let _state = { ok: false, url: '', mode: 'idle', error: null, pid: null, checkedAt: 0 };
let _child = null;
let _broadcast = null;
let _startingPromise = null;
// Set true by stopSidecar() so the exit handler knows not to auto-restart.
let _stopped = false;

export function setBroadcast(fn) {
    _broadcast = typeof fn === 'function' ? fn : null;
}

export function getSidecarStatus() {
    return { ..._state };
}

function _emit() {
    if (!_broadcast) return;
    try {
        _broadcast({ type: 'seekbar_sidecar_status', ..._state });
    } catch {}
}

function _setState(partial) {
    _state = { ..._state, ...partial, checkedAt: Date.now() };
    _emit();
}

function _platformSlug() {
    const platformMap = { win32: 'win', linux: 'linux', darwin: 'mac' };
    const platform = platformMap[process.platform];
    if (!platform) return null;
    // ia32 (32-bit x86) is only built for Linux (Synology DSM and legacy NAS).
    let arch;
    if (process.arch === 'x64') arch = 'x64';
    else if (process.arch === 'arm64') arch = 'arm64';
    else if (process.arch === 'ia32' && process.platform === 'linux') arch = 'x86';
    else return null;
    return `tgdl-seekbar-${platform}-${arch}`;
}

function _resolveBinary() {
    if (process.env.SEEKBAR_BIN && existsSync(process.env.SEEKBAR_BIN)) {
        return process.env.SEEKBAR_BIN;
    }
    const isWin = process.platform === 'win32';
    const slug = _platformSlug();
    const slugExe = slug ? `${slug}${isWin ? '.exe' : ''}` : null;
    // Preferred: slugged developer-built binary under seekbar-service/bin/
    // (the canonical naming convention across all platforms).
    const localBinDir = path.join(PROJECT_ROOT, 'seekbar-service', 'bin');
    if (slugExe) {
        const localSlug = path.join(localBinDir, slugExe);
        if (_isBinaryUsable(localSlug)) return localSlug;
    }
    // Generic name kept for hand-built dev binaries that pre-date the
    // slugged convention.
    const genericName = isWin ? 'seekbar-server.exe' : 'seekbar-server';
    const localGeneric = path.join(localBinDir, genericName);
    if (_isBinaryUsable(localGeneric)) return localGeneric;
    // Auto-downloaded binary lives in data/seekbar-service/bin/
    const autoDir = path.join(DATA_DIR, 'seekbar-service', 'bin');
    if (slugExe) {
        const autoSlug = path.join(autoDir, slugExe);
        if (_isBinaryUsable(autoSlug)) return autoSlug;
    }
    const autoGeneric = path.join(autoDir, genericName);
    if (_isBinaryUsable(autoGeneric)) return autoGeneric;
    return null;
}

function _isBinaryUsable(binPath) {
    try {
        const st = statSync(binPath);
        if (!st.isFile() || st.size === 0) return false;
        if (process.platform !== 'win32' && (st.mode & 0o111) === 0) return false;
        return true;
    } catch {
        return false;
    }
}

async function _autoDownloadBinary() {
    const slug = _platformSlug();
    if (!slug) {
        throw new Error(`unsupported platform/arch: ${process.platform}/${process.arch}`);
    }
    const isWin = process.platform === 'win32';
    const binDir = path.join(DATA_DIR, 'seekbar-service', 'bin');
    await fsp.mkdir(binDir, { recursive: true });
    const url = `${GH_RELEASE_BASE}/${slug}.tar.gz`;
    const tmpTarball = path.join(
        binDir,
        `${slug}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.tar.gz`,
    );
    _setState({ ok: false, mode: 'downloading', error: null, pid: null, url: '' });
    try {
        await _streamDownload(url, tmpTarball);
        await _extractTarball(tmpTarball, binDir);
    } finally {
        try {
            await fsp.unlink(tmpTarball);
        } catch {}
    }
    // The release tarball ships a generic name (seekbar-server / .exe);
    // rename to the slugged name so multiple platforms / versions can
    // coexist under the same bin dir on future upgrades.
    const generic = path.join(binDir, isWin ? 'seekbar-server.exe' : 'seekbar-server');
    const slugged = path.join(binDir, `${slug}${isWin ? '.exe' : ''}`);
    if (existsSync(generic)) {
        try {
            await fsp.rename(generic, slugged);
        } catch {
            /* leave under generic name */
        }
    }
    const final = existsSync(slugged) ? slugged : generic;
    if (!existsSync(final)) {
        throw new Error(`expected binary after extraction: ${slugged}`);
    }
    if (!isWin) {
        try {
            await fsp.chmod(final, 0o755);
        } catch {}
    }
    return final;
}

function _streamDownload(url, destPath, redirectsLeft = DOWNLOAD_REDIRECT_LIMIT) {
    return new Promise((resolve, reject) => {
        let parsed;
        try {
            parsed = new URL(url);
        } catch {
            return reject(new Error(`bad url: ${url}`));
        }
        const lib = parsed.protocol === 'http:' ? http : https;
        const req = lib.get(
            url,
            {
                headers: {
                    'user-agent': 'tgdl-seekbar-spawn',
                    accept: 'application/octet-stream',
                },
                timeout: DOWNLOAD_CONNECT_TIMEOUT_MS,
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
                    _streamDownload(next, destPath, redirectsLeft - 1).then(resolve, reject);
                    return;
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new Error(`http ${res.statusCode} from ${url}`));
                    return;
                }
                const total = Number(res.headers['content-length']) || 0;
                let loaded = 0;
                let lastBroadcast = 0;
                const ws = createWriteStream(destPath);
                res.on('data', (chunk) => {
                    loaded += chunk.length;
                    const now = Date.now();
                    if (now - lastBroadcast >= 200 || (total > 0 && loaded === total)) {
                        lastBroadcast = now;
                        const pct = total > 0 ? Math.min(100, (loaded * 100) / total) : 0;
                        if (_broadcast) {
                            try {
                                _broadcast({
                                    type: 'seekbar_download_progress',
                                    loaded,
                                    total,
                                    pct,
                                });
                            } catch {}
                        }
                    }
                });
                res.on('error', (e) => {
                    ws.destroy();
                    reject(e);
                });
                ws.on('error', (e) => reject(e));
                ws.on('finish', () => resolve());
                res.pipe(ws);
            },
        );
        req.on('timeout', () => req.destroy(new Error('download connect timeout')));
        req.on('error', reject);
    });
}

async function _extractTarball(tarballPath, destDir) {
    // System tar — Windows 10+, every Linux, macOS, Synology DSM all ship it.
    const res = spawnSync('tar', ['-xzf', tarballPath, '-C', destDir], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
    });
    if (res.error || res.status !== 0) {
        const msg = res.error?.message || res.stderr?.toString?.() || `status=${res.status}`;
        throw new Error(`tar extract failed: ${msg}`);
    }
}

function _findFreePort() {
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

function _cfg() {
    try {
        return loadConfig()?.advanced?.seekbar || {};
    } catch {
        return {};
    }
}

async function _probeHealth(url, token, attempts = 240, intervalMs = 250) {
    const headers = token ? { 'X-API-Token': token } : {};
    for (let i = 0; i < attempts; i++) {
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 3_000);
            try {
                const r = await fetch(`${url}/health`, { signal: ctrl.signal, headers });
                if (r.ok) return true;
            } finally {
                clearTimeout(t);
            }
        } catch {
            /* not up yet */
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
}

function _extraBinDirs() {
    // Collect directories containing bundled ffmpeg / ffprobe binaries so
    // the Go sidecar can find them even when the operator has no system
    // ffmpeg. De-duplicates in case both resolve to the same directory.
    const dirs = new Set();
    try {
        const b = resolveFfmpegBin();
        if (b && b !== 'ffmpeg') dirs.add(path.dirname(b));
    } catch {}
    try {
        const b = resolveFfprobeBin();
        if (b && b !== 'ffprobe' && b !== 'ffprobe.exe') dirs.add(path.dirname(b));
    } catch {}
    return [...dirs];
}

function _envFromConfig(cfg, port, token) {
    const extraDirs = _extraBinDirs();
    const envPath = extraDirs.length
        ? `${extraDirs.join(path.delimiter)}${path.delimiter}${process.env.PATH || ''}`
        : process.env.PATH || '';
    // Resolve explicit binary paths so the Go sidecar gets the exact binary
    // rather than relying on PATH ordering. Honour any operator-set
    // SEEKBAR_FFMPEG / SEEKBAR_FFPROBE first, then fall back to the Node
    // resolver (FFMPEG_PATH → system → bundled @ffmpeg-installer).
    const ffmpegBin = process.env.SEEKBAR_FFMPEG || resolveFfmpegBin();
    const ffprobeBin = process.env.SEEKBAR_FFPROBE || resolveFfprobeBin();
    return {
        ...process.env,
        PATH: envPath,
        SEEKBAR_HTTP_LISTEN: `127.0.0.1:${port}`,
        SEEKBAR_API_TOKEN: token,
        SEEKBAR_OUTPUT_DIR: path.join(DATA_DIR, 'seekbar'),
        SEEKBAR_TEMP_DIR: path.join(DATA_DIR, 'seekbar', 'tmp'),
        SEEKBAR_FFMPEG: ffmpegBin,
        SEEKBAR_FFPROBE: ffprobeBin,
        SEEKBAR_HWACCEL: cfg.hwaccel ?? 'none',
        SEEKBAR_CONCURRENCY: String(cfg.concurrency || 8),
        SEEKBAR_INTERVAL_SEC: String(cfg.intervalSec || 5),
        SEEKBAR_WIDTH: String(cfg.tileWidth || 160),
        SEEKBAR_COLUMNS: String(cfg.columns || 10),
        SEEKBAR_MAX_TILES: String(cfg.maxTiles || 200),
        SEEKBAR_FORMAT: String(cfg.format || 'webp'),
        SEEKBAR_QUALITY: String(cfg.quality || 70),
        SEEKBAR_MAX_RETRIES: String(cfg.maxRetries || 3),
        SEEKBAR_OVERWRITE: String(cfg.overwrite || 'if-changed'),
        SEEKBAR_LOG_LEVEL: cfg.logLevel || 'info',
        SEEKBAR_LOG_FORMAT: cfg.logFormat || 'text',
    };
}

async function _spawnLocal(cfg) {
    let bin = _resolveBinary();
    if (!bin) {
        // Auto-download mirrors the AI Face clustering UX — no manual
        // `npm run build:seekbar` step required. Falls back to the
        // disabled state only when the platform is unsupported or the
        // GitHub Release isn't published yet.
        try {
            bin = await _autoDownloadBinary();
        } catch (e) {
            _setState({
                ok: false,
                url: '',
                mode: 'binary_missing',
                error: `auto-download failed: ${String(e?.message || e).slice(0, 200)}`,
                pid: null,
            });
            return false;
        }
    }
    const port = await _findFreePort();
    const token = process.env.SEEKBAR_API_TOKEN || crypto.randomBytes(16).toString('hex');
    const env = _envFromConfig(cfg, port, token);
    const url = `http://127.0.0.1:${port}`;
    setSidecarUrl(url, token);

    const thisChild = spawn(bin, [], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: PROJECT_ROOT,
        windowsHide: true,
    });
    _child = thisChild;
    const _pipeLog = (level, chunk) => {
        const text = chunk.toString().trimEnd();
        process.stderr.write(`[seekbar-sidecar] ${text}\n`);
        if (!_broadcast) return;
        for (const line of text.split('\n')) {
            const l = line.trim();
            if (l)
                try {
                    _broadcast({ type: 'log', source: 'seekbar-sidecar', level, msg: l });
                } catch {}
        }
    };
    thisChild.stdout.on('data', (c) => _pipeLog('info', c));
    thisChild.stderr.on('data', (c) => _pipeLog('warn', c));
    thisChild.on('exit', (code, sig) => {
        // Guard: if _child already points to a newer child (from refreshSidecar),
        // this is a stale exit from the previously-killed process — ignore it.
        if (_child !== thisChild) return;
        _child = null;
        _setState({
            ok: false,
            mode: 'exited',
            error: `exit code=${code} signal=${sig || ''}`,
            pid: null,
        });
        // Auto-restart on unexpected exit (not when stopSidecar() was called).
        if (!_stopped) {
            setTimeout(() => {
                if (!_child && !_startingPromise) startSidecar().catch(() => {});
            }, 3000);
        }
    });

    _setState({ ok: false, url, mode: 'starting', error: null, pid: thisChild.pid });

    const healthy = await _probeHealth(url, token);
    // Guard: a concurrent refreshSidecar() may have replaced _child already.
    if (_child !== thisChild) return false;
    if (!healthy) {
        try {
            thisChild.kill('SIGTERM');
        } catch {}
        _child = null;
        _setState({ ok: false, url, mode: 'unhealthy', error: 'health probe failed', pid: null });
        return false;
    }
    _setState({ ok: true, url, mode: 'running', error: null });
    return true;
}

async function _connectRemote(url, token) {
    setSidecarUrl(url, token);
    try {
        const h = await health();
        if (h?.ok) {
            _setState({ ok: true, url, mode: 'remote', error: null, pid: null });
            return true;
        }
        _setState({ ok: false, url, mode: 'remote', error: 'unhealthy' });
        return false;
    } catch (e) {
        _setState({
            ok: false,
            url,
            mode: 'remote',
            error: String(e?.message || e).slice(0, 200),
        });
        return false;
    }
}

/**
 * Main entry — called from server.js at boot (always, regardless of
 * `enabled`: the status pill still renders when the feature is off so
 * operators can see the sidecar is ready to go). Safe to call multiple
 * times concurrently; returns the in-flight promise.
 */
export async function startSidecar() {
    if (_startingPromise) return _startingPromise;
    _startingPromise = (async () => {
        try {
            // Mode 1: operator-provided URL (Docker compose / remote sidecar).
            const envUrl = (process.env.SEEKBAR_SIDECAR_URL || '').trim();
            const envToken = (process.env.SEEKBAR_API_TOKEN || '').trim();
            if (envUrl) {
                return await _connectRemote(envUrl, envToken);
            }
            const cfg = _cfg();
            const cfgUrl = String(cfg.sidecarUrl || '').trim();
            if (cfgUrl) {
                return await _connectRemote(cfgUrl, String(cfg.apiToken || '').trim());
            }
            // Mode 2: auto-spawn the local Go binary.
            return await _spawnLocal(cfg);
        } finally {
            _startingPromise = null;
        }
    })();
    return _startingPromise;
}

/** Re-probe the sidecar. Called by the config-change handler. */
export async function refreshSidecar() {
    _stopped = false; // We want the sidecar running after refresh.
    _startingPromise = null; // Cancel any in-flight start so startSidecar() below runs fresh.
    if (_child) {
        try {
            _child.kill('SIGTERM');
        } catch {}
        _child = null; // Null before startSidecar() so the old exit event is treated as stale.
    }
    return startSidecar();
}

export function stopSidecar() {
    _stopped = true; // Tell the exit handler not to auto-restart.
    if (_child) {
        try {
            _child.kill('SIGTERM');
        } catch {}
        _child = null;
    }
    _setState({ ok: false, mode: 'stopped', error: null, pid: null });
}
