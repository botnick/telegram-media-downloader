/**
 * Faces sidecar — binary acquisition + child-process lifecycle.
 *
 * The face-clustering subsystem talks HTTP to a Python sidecar
 * (`faces-service/`). Three install modes share this module:
 *
 *   1. Docker compose      — `FACES_SERVICE_URL` env injects the in-network
 *                            URL of the `tgdl-faces` container. We just
 *                            forward the URL to the client and skip spawn.
 *   2. Operator override   — `config.advanced.ai.facesServiceUrl` lets an
 *                            operator point at any URL (offline mirror,
 *                            remote sidecar, etc).
 *   3. Local auto-spawn    — when neither is set and face clustering is on,
 *                            we resolve / download a PyInstaller binary
 *                            under `<DATA_DIR>/faces-service/bin/`, spawn
 *                            it on a random localhost port, and probe
 *                            `/health` until it returns `{ok:true}`.
 *
 * Bumping `SIDECAR_VERSION` triggers a fresh download on next boot — the
 * old binary stays on disk but the new one is fetched and used.
 */

import { existsSync, promises as fs, readdirSync, statSync } from 'fs';
import { createWriteStream } from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import net from 'net';
import { spawn, spawnSync } from 'child_process';

import { setSidecarUrl, getSidecarUrl, applyFacesCfg } from './faces-client.js';
import { resolveAllFaces } from './faces-config.js';
import { getDataDir, getDownloadsDir, getRepoRoot } from '../paths.js';

const DATA_DIR = getDataDir();
const PROJECT_ROOT = getRepoRoot();

// Resolve CUDA 12.x + cuDNN bin directories on Windows so onnxruntime CUDA EP
// can find cuBLAS / cuDNN DLLs without a system PATH change or reboot.
// Scans three sources in order: CUDA Toolkit env vars, CUDA Toolkit filesystem,
// and pip-installed nvidia-* packages (nvidia-cudnn-cu12, etc.).
// pyBin — path to the Python executable being spawned; used to locate
//         <site-packages>/nvidia/*/bin for pip-installed CUDA DLLs.
function _resolveCudaBinDirs(pyBin) {
    if (process.platform !== 'win32') return [];
    const seen = new Set();
    const dirs = [];
    const addBin = (base) => {
        if (!base) return;
        const bin = path.join(String(base), 'bin');
        if (!seen.has(bin) && existsSync(bin)) {
            seen.add(bin);
            dirs.push(bin);
        }
    };

    // 1. CUDA Toolkit env vars (set by installer — no reboot needed if process restarts).
    addBin(process.env.CUDA_PATH);
    for (const [k, v] of Object.entries(process.env)) {
        if (/^CUDA_PATH_V12_\d+$/i.test(k)) addBin(v);
    }

    // 2. Filesystem scan for CUDA Toolkit v12.x (handles installer PATH gap).
    const cudaBase = 'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA';
    if (existsSync(cudaBase)) {
        try {
            readdirSync(cudaBase)
                .filter((d) => /^v12\.\d+$/i.test(d))
                .sort((a, b) => Number(b.replace('v12.', '')) - Number(a.replace('v12.', '')))
                .forEach((d) => addBin(path.join(cudaBase, d)));
        } catch {
            /* non-fatal */
        }
    }

    // 3. pip-installed nvidia-* packages (nvidia-cudnn-cu12, nvidia-cublas-cu12, …).
    //    Standard CPython on Windows: <pyHome>\Lib\site-packages\nvidia\<pkg>\bin
    //    pyBin may be a bare command name ('python') rather than an absolute path.
    //    path.dirname('python') === '' which makes the site-packages probe miss.
    //    Resolve to absolute path via `where.exe` before computing the home dir.
    if (pyBin) {
        // path.dirname('python') === '.' — not a useful home dir.
        // Resolve bare command names to absolute paths via where.exe.
        let pyHome = path.isAbsolute(pyBin) ? path.dirname(pyBin) : null;
        if (!pyHome) {
            try {
                const r = spawnSync('where', [pyBin], {
                    stdio: ['ignore', 'pipe', 'ignore'],
                    timeout: 3000,
                    windowsHide: true,
                });
                if (!r.error && r.status === 0) {
                    const first = String(r.stdout)
                        .split(/\r?\n/)
                        .find((l) => /\.exe$/i.test(l.trim()));
                    if (first) pyHome = path.dirname(first.trim());
                }
            } catch {
                /* non-fatal */
            }
        }
        if (pyHome) {
            const sitePackages = path.join(pyHome, 'Lib', 'site-packages');
            const nvidiaDir = path.join(sitePackages, 'nvidia');
            if (existsSync(nvidiaDir)) {
                try {
                    readdirSync(nvidiaDir).forEach((pkg) => addBin(path.join(nvidiaDir, pkg)));
                } catch {
                    /* non-fatal */
                }
            }
        }
    }

    return dirs;
}

/**
 * Pinned sidecar release. Bumping this triggers a fresh binary download
 * on next boot — release `faces-v<X>` on the GitHub repo must exist with
 * the matching `tgdl-faces-<platform>-<arch>.tar.gz` assets attached.
 */
export const SIDECAR_VERSION = '0.4.0';

const GH_RELEASE_BASE = `https://github.com/botnick/telegram-media-downloader/releases/download/faces-v${SIDECAR_VERSION}`;

// Lifecycle defaults. Used when the operator hasn't set `advanced.ai.faces.*`
// AND hasn't set a `TGDL_FACES_*` env override — i.e. an untouched install.
// All of these are surface-tunable via `config.advanced.ai.faces.*` (see
// `manager.js`) and `TGDL_FACES_*` env (see `faces-config.js`). Health probe
// gets a longer timeout on the very first boot because the sidecar loads
// the buffalo_l model lazily.
const HEALTH_TIMEOUT_FIRST_BOOT_MS_DEFAULT = 60_000;
const HEALTH_TIMEOUT_RESPAWN_MS_DEFAULT = 30_000;
const HEALTH_POLL_INTERVAL_MS = 500;
const HEALTH_MONITOR_INTERVAL_MS_DEFAULT = 60_000;
const HEALTH_MONITOR_FAIL_THRESHOLD_DEFAULT = 3;
const SPAWN_RETRY_BACKOFF_MS = 5000;
const SPAWN_MAX_RETRIES = 3;
const KILL_GRACE_MS = 5000;
const PORT_RANGE_MIN_DEFAULT = 41000;
const PORT_RANGE_MAX_DEFAULT = 49999;
const PORT_BIND_MAX_ATTEMPTS_DEFAULT = 10;
const DOWNLOAD_REDIRECT_LIMIT_DEFAULT = 5;
const DOWNLOAD_CONNECT_TIMEOUT_MS = 30_000;

// Resolved faces config for the current process boot — populated by
// `_doStart()` after reading `loadConfig()` + env. All spawn-path helpers
// consult this snapshot instead of the const defaults so an operator's
// `portRange`, `firstBootHealthTimeoutMs`, etc., actually take effect.
let _resolvedCfg = null;

function _cfg() {
    return _resolvedCfg || {};
}
function _portRange() {
    const r = _cfg().portRange;
    if (Array.isArray(r) && r.length >= 2 && Number.isFinite(r[0]) && Number.isFinite(r[1])) {
        const lo = Math.min(r[0], r[1]);
        const hi = Math.max(r[0], r[1]);
        return [Math.max(1, lo | 0), Math.min(65535, hi | 0)];
    }
    return [PORT_RANGE_MIN_DEFAULT, PORT_RANGE_MAX_DEFAULT];
}
function _portProbeAttempts() {
    const n = _cfg().portProbeAttempts;
    return Number.isFinite(n) && n > 0 ? n | 0 : PORT_BIND_MAX_ATTEMPTS_DEFAULT;
}
function _firstBootHealthTimeoutMs() {
    const n = _cfg().firstBootHealthTimeoutMs;
    return Number.isFinite(n) && n > 0 ? n | 0 : HEALTH_TIMEOUT_FIRST_BOOT_MS_DEFAULT;
}
function _respawnHealthTimeoutMs() {
    const n = _cfg().respawnHealthTimeoutMs;
    return Number.isFinite(n) && n > 0 ? n | 0 : HEALTH_TIMEOUT_RESPAWN_MS_DEFAULT;
}
function _healthMonitorIntervalMs() {
    const n = _cfg().healthMonitorIntervalMs;
    return Number.isFinite(n) && n > 0 ? n | 0 : HEALTH_MONITOR_INTERVAL_MS_DEFAULT;
}
function _healthFailureThreshold() {
    const n = _cfg().healthFailuresBeforeRelaunch;
    return Number.isFinite(n) && n > 0 ? n | 0 : HEALTH_MONITOR_FAIL_THRESHOLD_DEFAULT;
}
function _downloadRedirectLimit() {
    const n = _cfg().downloadRedirectCap;
    return Number.isFinite(n) && n > 0 ? n | 0 : DOWNLOAD_REDIRECT_LIMIT_DEFAULT;
}

// Tar typeflag byte codes (kept as numeric constants — comparing against
// numbers dodges any source-file NUL-handling issues that crop up when
// you embed `'\0'` literals in JS).
const TAR_TYPE_REGULAR_MODERN = 0x30; /* '0' */
const TAR_TYPE_REGULAR_LEGACY = 0x00; /* NUL (ustar) */
const TAR_TYPE_REGULAR_SPACE = 0x20; /* ' ' (some old tools) */
const TAR_TYPE_DIRECTORY = 0x35; /* '5' */

// Module-level state. The state machine is intentionally simple — the
// spawn module is owned by exactly one process and one boot path; the
// `_starting` promise gates concurrent `startSidecar()` calls.
let _starting = null;
let _child = null;
let _childUrl = null;
let _state = 'idle'; // idle | downloading | spawning | healthy | failed
let _sidecarMode = null; // external | docker | override | local | null
let _error = null;
let _healthMonitorTimer = null;
let _healthMonitorFailCount = 0;
let _firstBoot = true;
let _shutdownHooksWired = false;
// Guards repeated auto-install loops within one process. `_autoInstallTried`
// is set the first time `_tryPythonFallback` invokes the installer; the
// `/api/ai/faces/install-deps` endpoint resets it before re-running so an
// operator can manually retry after a fix without restarting Node.
let _autoInstallTried = false;
let _installerRunning = false;

/**
 * Public synchronous status accessor for the AI status endpoint /
 * Maintenance card. Returns a snapshot — callers should not retain the
 * reference (the object is recreated on each call).
 */
export function getSidecarStatus() {
    return {
        state: _state,
        url: _childUrl || getSidecarUrl() || null,
        mode: _sidecarMode || null,
        error: _error,
        pid: _child?.pid || null,
        version: SIDECAR_VERSION,
    };
}

/**
 * Stop the spawned sidecar (no-op when Docker / operator-override paths
 * delivered the URL). Safe to call multiple times.
 */
export function stopSidecar() {
    if (_healthMonitorTimer) {
        clearInterval(_healthMonitorTimer);
        _healthMonitorTimer = null;
    }
    _killChild();
    _starting = null;
    _state = 'idle';
    _error = null;
}

/**
 * Idempotent entry point. Resolves to the final status (does not throw —
 * lifecycle errors are surfaced via `getSidecarStatus()` and the
 * `ai_faces_status` WS broadcast).
 */
export async function startSidecar() {
    if (_starting) return _starting;
    _starting = _doStart().catch((e) => {
        _state = 'failed';
        _error = e?.message || String(e);
        _broadcast({ type: 'ai_faces_status', ok: false, error: _error });
        _log('error', `start failed: ${_error}`);
        return getSidecarStatus();
    });
    return _starting;
}

async function _doStart() {
    _wireShutdownHooks();

    // Load runtime config + env overrides up front so every downstream
    // helper consults the resolved snapshot instead of the bare defaults.
    let aiCfg = {};
    let facesCfg = {};
    try {
        const { loadConfig } = await import('../../config/manager.js');
        const live = loadConfig();
        aiCfg = live?.advanced?.ai || {};
        facesCfg = aiCfg.faces || {};
    } catch (e) {
        _log('warn', `config load failed: ${e?.message || e}`);
    }
    _resolvedCfg = resolveAllFaces(facesCfg);
    // Push the resolved knobs into the client so HTTP timeouts / retry
    // backoffs / health-cache TTL respect operator config + env.
    try {
        applyFacesCfg(_resolvedCfg);
    } catch {
        /* client may not be fully loaded in some test setups */
    }

    // Backend kill-switch — operator can fully disable the spawn path via
    // env (Docker / k8s / Pi Zero deployments that don't want the sidecar
    // burden) without touching the kv-backed config.
    if (_resolvedCfg.backend === 'disabled') {
        _state = 'idle';
        _log('info', 'faces backend=disabled — sidecar will not be spawned');
        _broadcast({ type: 'ai_faces_status', ok: false, state: 'disabled' });
        return getSidecarStatus();
    }

    // Mode 1 — web-configured external sidecar URL (highest priority).
    // Operator sets this from Maintenance > AI > System Health > External
    // sidecar URL. When set, it wins over Docker env + local spawn so
    // the dashboard is the single source of truth.
    const webUrl = _normaliseUrl(_resolvedCfg.sidecarUrl);
    if (webUrl) {
        setSidecarUrl(webUrl);
        _childUrl = webUrl;
        _state = 'healthy';
        _error = null;
        _sidecarMode = 'external';
        _log('info', `using external sidecar at ${webUrl}`);
        await _maybeMigrateDim(webUrl);
        _broadcast({ type: 'ai_faces_status', ok: true, url: webUrl, mode: 'external' });
        return getSidecarStatus();
    }

    // Mode 2 — Docker compose sets `FACES_SERVICE_URL` to the sidecar's
    // in-network URL. No spawn needed; just hand the URL to the client.
    const envUrl = _normaliseUrl(process.env.FACES_SERVICE_URL);
    if (envUrl) {
        setSidecarUrl(envUrl);
        _childUrl = envUrl;
        _state = 'healthy';
        _error = null;
        _sidecarMode = 'docker';
        _log('info', `using docker sidecar at ${envUrl}`);
        await _maybeMigrateDim(envUrl);
        _broadcast({ type: 'ai_faces_status', ok: true, url: envUrl, mode: 'docker' });
        return getSidecarStatus();
    }

    // Mode 3 — legacy operator override via env / flat config alias.
    const legacyUrl = _normaliseUrl(aiCfg.facesServiceUrl);
    if (legacyUrl) {
        setSidecarUrl(legacyUrl);
        _childUrl = legacyUrl;
        _state = 'healthy';
        _error = null;
        _sidecarMode = 'override';
        _log('info', `using legacy override sidecar at ${legacyUrl}`);
        await _maybeMigrateDim(legacyUrl);
        _broadcast({ type: 'ai_faces_status', ok: true, url: legacyUrl, mode: 'override' });
        return getSidecarStatus();
    }

    // Mode 2.5 — auto-discover an externally-running sidecar on
    // common localhost ports. This is the survival path when:
    //   - operator started `py -m tgdl_faces` in a separate terminal
    //     (the documented `pip install -e faces-service/` workflow);
    //   - a previous Node run's auto-spawn child is still alive but
    //     its random high port was lost on a `--watch` restart;
    //   - the `tgdl-faces` compose service is bound to the default
    //     8011 on the host network instead of the compose bridge.
    // Probing a handful of well-known ports adds < 1 s to cold-start
    // when nothing's listening, and turns a 5-minute "fix the spawn"
    // grovel into a single discovered URL when one IS listening.
    const wellKnownPorts = [8011, 8012, 8013, 41000, 41234];
    for (const port of wellKnownPorts) {
        const url = `http://127.0.0.1:${port}`;
        try {
            if (await _probeHealth(url)) {
                setSidecarUrl(url);
                _childUrl = url;
                _state = 'healthy';
                _error = null;
                _log('info', `discovered externally-running sidecar at ${url}`);
                await _maybeMigrateDim(url);
                _broadcast({
                    type: 'ai_faces_status',
                    ok: true,
                    url,
                    mode: 'discovered',
                });
                return getSidecarStatus();
            }
        } catch {
            /* port not listening — keep probing */
        }
    }

    // Mode 3 — local auto-spawn (only when face clustering is enabled).
    if (aiCfg.faceClustering !== true) {
        _state = 'idle';
        _log('info', 'face clustering disabled; not spawning sidecar');
        return getSidecarStatus();
    }

    const target = _resolveBinaryTarget(_resolvedCfg);
    if (!target) {
        _state = 'failed';
        _error = `unsupported platform/arch: ${process.platform}/${process.arch}`;
        _log('warn', `${_error} — face clustering disabled`);
        _broadcast({ type: 'ai_faces_status', ok: false, error: _error });
        return getSidecarStatus();
    }

    // Ensure the binary is on disk + executable. When the download fails
    // (typically 404 — Track D's CI workflow exists but no faces-v<X> tag
    // is published yet) we fall through to the Python fallback below so
    // operators with `pip install -e faces-service/` already done don't
    // get blocked on a missing GitHub Release.
    let binaryReady = _isBinaryUsable(target.binPath);
    let downloadError = null;
    if (!binaryReady) {
        // Air-gapped / corporate-proxy installs flip autoDownload off and
        // pre-stage the binary themselves; bail out before any HTTPS attempt
        // so the install never leaks "I tried to phone home" log lines.
        if (_resolvedCfg.autoDownload === false) {
            // Skip the network entirely but still try the Python fallback
            // below — an operator who pre-staged the Python service is
            // exactly the audience this branch needs to keep functional.
            downloadError = 'autoDownload=false and binary missing';
            _log('info', `${downloadError} — skipping download, will try Python fallback`);
        } else {
            // Preflight: verify the release asset is actually published before
            // showing a "downloading…" spinner. On dev builds (and before a
            // GitHub Release tag is cut) the URL returns 404 — skip straight
            // to the Python fallback rather than flooding the log with failed
            // download attempts.
            const primaryUrl =
                Array.isArray(target.tarUrls) && target.tarUrls.length
                    ? target.tarUrls[0]
                    : target.tarUrl;
            const published = await _releaseAvailable(primaryUrl);
            if (!published) {
                downloadError = `release faces-v${SIDECAR_VERSION} not published at ${primaryUrl} — skipping download`;
                _log('info', `${downloadError} — will try Python fallback`);
            } else {
                _state = 'downloading';
                _broadcast({ type: 'ai_faces_status', ok: false, state: 'downloading' });
                try {
                    await _downloadAndExtract(target);
                    binaryReady = _isBinaryUsable(target.binPath);
                } catch (e) {
                    downloadError = `binary download failed: ${e?.message || e}`;
                    _log('warn', `${downloadError} — will try Python fallback`);
                }
            }
        }
    }

    // Verify the binary at least responds to `--help` — catches AV
    // quarantine, half-extracted tarballs, and so on. One retry: if it
    // fails, nuke and re-download once. A failure here still leaves the
    // Python fallback as a usable last resort.
    if (binaryReady && !_verifyBinary(target.binPath)) {
        _log('warn', `binary at ${target.binPath} failed verification — re-downloading`);
        _killChild();
        if (process.platform === 'win32') {
            const binName = path.basename(target.binPath);
            try {
                spawnSync('taskkill', ['/F', '/IM', binName], { stdio: 'ignore', timeout: 5000 });
            } catch {}
        }
        await new Promise((r) => setTimeout(r, 2000));
        let unlocked = false;
        try {
            await fs.unlink(target.binPath);
            unlocked = true;
        } catch {
            try {
                await fs.rename(target.binPath, target.binPath + '.old');
                unlocked = true;
            } catch (renameErr) {
                _log(
                    'warn',
                    `cannot remove locked binary (${renameErr.code || renameErr.message}) — skipping re-download`,
                );
            }
        }
        if (unlocked && _resolvedCfg.autoDownload !== false) {
            try {
                await _downloadAndExtract(target);
            } catch (e) {
                downloadError = `binary re-download failed: ${e?.message || e}`;
                _log('warn', `${downloadError} — will try Python fallback`);
                binaryReady = false;
            }
        } else {
            binaryReady = false;
        }
        if (binaryReady && !_verifyBinary(target.binPath)) {
            downloadError = 'binary verification failed after re-download';
            _log('warn', `${downloadError} — will try Python fallback`);
            binaryReady = false;
        }
    }

    // Prefer the prebuilt binary when present + verified. The Python
    // fallback only fires when the binary is unavailable AND a host
    // Python install is reachable.
    _state = 'spawning';
    if (binaryReady) {
        _log('info', `starting prebuilt binary at ${target.binPath}`);
        const ok = await _spawnWithRetry(() => _spawnAndProbe(target.binPath), target.binPath);
        if (ok) return getSidecarStatus();
    }

    // Python fallback. Tries to bring up `python -m tgdl_faces` from the
    // co-located `faces-service/` source tree. Respects
    // `TGDL_FACES_AUTO_DOWNLOAD=false` — an operator who explicitly opted
    // out of any auto-acquisition gets a single clear error instead of a
    // surprise Python spawn.
    const autoOptOut = process.env.TGDL_FACES_AUTO_DOWNLOAD === 'false';
    if (!autoOptOut) {
        const port = await _pickAvailablePort().catch(() => null);
        if (port) {
            const downloadsDir = getDownloadsDir();
            const modelsDir = path.resolve(DATA_DIR, 'faces-service', 'models');
            try {
                await fs.mkdir(downloadsDir, { recursive: true });
                await fs.mkdir(modelsDir, { recursive: true });
            } catch {}
            const fallback = await _tryPythonFallback({
                host: '127.0.0.1',
                port,
                allowRoots: downloadsDir,
                modelsDir,
            });
            if (fallback.ok) {
                _log(
                    'info',
                    `starting via python fallback (no prebuilt binary): ${fallback.pyBin}`,
                );
                const pyChild = fallback.child;
                _child = pyChild;
                _wirePipeLogging(pyChild.stdout, 'info');
                // Python's `logging.basicConfig(stream=sys.stderr)` is the
                // standard config; uvicorn likewise writes INFO/access to
                // stderr. Default unparseable lines to 'info' (not 'error')
                // so a clean boot doesn't paint the log feed red.
                // `_inferPyLevel` still upgrades any line containing
                // ERROR / CRITICAL / WARNING to the matching level.
                _wirePipeLogging(pyChild.stderr, 'info');
                let exited = false;
                let exitInfo = null;
                // `pyHealthy` is true only after the initial health probe succeeds.
                // The exit handler uses it to distinguish a crash-during-startup
                // (let _doStart's cleanup run) from a crash-while-running
                // (trigger auto-restart).
                let pyHealthy = false;
                pyChild.on('exit', (code, signal) => {
                    exited = true;
                    exitInfo = { code, signal };
                    // _killChild() clears _child before sending the signal, so
                    // _child !== pyChild means we initiated the shutdown — log
                    // at info. Unexpected exits (crash, OOM) keep _child intact
                    // and warrant a warn.
                    const unexpected = pyHealthy && _child === pyChild;
                    _log(
                        unexpected ? 'warn' : 'info',
                        `python fallback exited code=${code} signal=${signal}`,
                    );
                    // Auto-restart: only when sidecar was confirmed healthy AND
                    // is still the current child (guard against stale events after
                    // a manual restart or stopSidecar()).
                    if (unexpected) {
                        _child = null;
                        _childUrl = null;
                        _state = 'spawning';
                        _broadcast({ type: 'ai_faces_status', ok: false, state: 'relaunching' });
                        setTimeout(() => {
                            if (!_starting) startSidecar().catch(() => {});
                        }, 5000);
                    }
                });
                pyChild.on('error', (e) => {
                    exited = true;
                    exitInfo = { error: e };
                    _log('error', `python fallback error: ${e?.message || e}`);
                });
                const url = `http://127.0.0.1:${port}`;
                const timeoutMs = _firstBoot
                    ? _firstBootHealthTimeoutMs()
                    : _respawnHealthTimeoutMs();
                const deadline = Date.now() + timeoutMs;
                while (Date.now() < deadline) {
                    if (exited) break;
                    if (await _probeHealth(url)) {
                        _childUrl = url;
                        _state = 'healthy';
                        _error = null;
                        _healthMonitorFailCount = 0;
                        setSidecarUrl(url);
                        _log('info', `sidecar healthy at ${url} (pid=${_child?.pid}, mode=python)`);
                        _firstBoot = false;
                        pyHealthy = true; // Enable auto-restart for future unexpected exits.
                        await _maybeMigrateDim(url);
                        _broadcast({
                            type: 'ai_faces_status',
                            ok: true,
                            url,
                            mode: 'python',
                            pid: _child?.pid || null,
                        });
                        return getSidecarStatus();
                    }
                    await _sleep(HEALTH_POLL_INTERVAL_MS);
                }
                _killChild();
                if (exited) {
                    _log(
                        'warn',
                        `python fallback exited before health: ${JSON.stringify(exitInfo)}`,
                    );
                } else {
                    _log('warn', `python fallback health probe timed out after ${timeoutMs} ms`);
                }
            } else {
                _log('info', `python fallback unavailable: ${fallback.reason || 'unknown'}`);
            }
        }
    }

    // Both binary AND fallback failed (or were skipped). Surface a single
    // operator-facing message that names both recovery paths.
    _state = 'failed';
    const setupHint =
        'Sidecar not running — first-run setup needed. ' +
        'Either `docker compose --profile faces up` ' +
        'or `pip install -e faces-service/` from the repo root, then restart.';
    if (downloadError) {
        _error = `${downloadError}. ${setupHint}`;
    } else {
        _error = setupHint;
    }
    _log('error', _error);
    _broadcast({ type: 'ai_faces_status', ok: false, error: _error });
    return getSidecarStatus();
}

// Helper used by `_doStart` to wrap the prebuilt-binary spawn with the
// existing retry/backoff loop. Returns true on success (state already
// flipped to 'healthy'), false if every attempt failed.
async function _spawnWithRetry(spawnFn, binPath) {
    let lastErr = null;
    for (let attempt = 1; attempt <= SPAWN_MAX_RETRIES; attempt++) {
        try {
            const url = await spawnFn();
            _childUrl = url;
            _state = 'healthy';
            _error = null;
            _healthMonitorFailCount = 0;
            setSidecarUrl(url);
            _log('info', `sidecar healthy at ${url} (pid=${_child?.pid})`);
            _firstBoot = false;
            _scheduleHealthMonitor(binPath);
            await _maybeMigrateDim(url);
            _broadcast({
                type: 'ai_faces_status',
                ok: true,
                url,
                mode: 'spawn',
                pid: _child?.pid || null,
            });
            return true;
        } catch (e) {
            lastErr = e;
            _log(
                'warn',
                `spawn attempt ${attempt}/${SPAWN_MAX_RETRIES} failed: ${e?.message || e}`,
            );
            _killChild();
            if (attempt < SPAWN_MAX_RETRIES) {
                await _sleep(SPAWN_RETRY_BACKOFF_MS);
            }
        }
    }
    _log(
        'warn',
        `sidecar spawn failed after ${SPAWN_MAX_RETRIES} attempts: ${lastErr?.message || lastErr}`,
    );
    return false;
}

// ---- Python fallback ----------------------------------------------------
//
// When the prebuilt binary is unavailable (e.g. the GitHub Release hasn't
// been tagged yet) and the operator has a local Python install with the
// `faces-service` deps already wheeled, we can still bring the sidecar
// up by spawning `python -m tgdl_faces`. The fallback respects
// `TGDL_FACES_AUTO_DOWNLOAD=false` — opt-out operators never see it run.
//
// The probe walks three gates in order:
//   1. `faces-service/` is bundled with the install (dev checkout or
//      production install — both keep the package next to the Node app).
//   2. A `python3` (or `python` on Windows) interpreter ≥ 3.10 is on PATH.
//   3. The deps required by the package (`fastapi`, `insightface`,
//      `onnxruntime`, `cv2`, `numpy`, `PIL`) are importable.
//
// All three gates are cheap enough to evaluate every boot; the
// alternative (caching a positive result across restarts) would lock the
// fallback to a stale Python path after the operator switched
// interpreters.
async function _tryPythonFallback({ host, port, allowRoots, modelsDir }) {
    const facesService = path.resolve(PROJECT_ROOT, 'faces-service');
    const entrypoint = path.join(facesService, 'tgdl_faces', '__main__.py');
    if (!existsSync(entrypoint)) {
        return {
            ok: false,
            reason: `faces-service/ folder not bundled with this install (looked for ${entrypoint})`,
        };
    }

    const pyBin = await _findPython3OrAbove();
    if (!pyBin) {
        return { ok: false, reason: 'no Python 3.10+ on PATH' };
    }

    const depsOk = await _checkPythonDeps(pyBin);
    if (!depsOk.ok) {
        // Auto-install path — run `python -m tgdl_faces.install` once per
        // process so the operator never has to copy-paste a pip command.
        // The installer auto-detects the host platform + GPU vendor and
        // picks the matching onnxruntime EP wheel (DirectML on Windows,
        // CUDA on Linux+NVIDIA, OpenVINO on Linux+Intel, CoreML/CPU
        // elsewhere). Honors `TGDL_FACES_AUTO_INSTALL=false` for
        // air-gapped / locked-down hosts.
        const autoInstallDisabled =
            process.env.TGDL_FACES_AUTO_INSTALL === 'false' ||
            _resolvedCfg?.autoInstallDeps === false;
        if (!autoInstallDisabled && !_autoInstallTried) {
            _autoInstallTried = true;
            _log('info', `Python deps missing (${depsOk.detail || '?'}) — running auto-installer`);
            const installed = await installPythonDeps({ pyBin });
            if (installed.ok) {
                const recheck = await _checkPythonDeps(pyBin);
                if (recheck.ok) {
                    _log('info', 'auto-install succeeded — proceeding with sidecar spawn');
                    // fall through to the spawn block below
                } else {
                    return {
                        ok: false,
                        reason:
                            'auto-install completed but deps still missing — ' +
                            (recheck.detail || 'see logs'),
                    };
                }
            } else {
                return {
                    ok: false,
                    reason: `auto-install failed: ${installed.reason || 'see logs'}`,
                };
            }
        } else {
            const installCmd =
                process.platform === 'win32'
                    ? 'python -m pip install -e faces-service/ && python -m tgdl_faces.install'
                    : 'python3 -m pip install -e faces-service/ && python3 -m tgdl_faces.install';
            return {
                ok: false,
                reason:
                    `Python deps missing — run \`${installCmd}\` from the repo root, then restart` +
                    (depsOk.detail ? ` (${depsOk.detail})` : ''),
            };
        }
    }

    const cudaBinDirs = _resolveCudaBinDirs(pyBin);
    const env = {
        ...process.env,
        PYTHONUTF8: '1',
        // Prepend CUDA 12.x bin dirs so onnxruntime CUDA EP finds cuBLAS DLLs
        // without requiring a system PATH change or reboot.
        ...(cudaBinDirs.length > 0 && {
            PATH: cudaBinDirs.join(path.delimiter) + path.delimiter + (process.env.PATH || ''),
        }),
        TGDL_FACES_HOST: host,
        TGDL_FACES_PORT: String(port),
        TGDL_FACES_ALLOW_ROOTS: allowRoots,
        TGDL_FACES_MODELS_DIR: modelsDir,
        // Forward the operator-selected insightface preset + EP hint
        // into the sidecar env so /restart actually picks up the new
        // dropdown value. Without these, the Python child re-uses its
        // default (buffalo_l + auto) regardless of what the UI saved.
        TGDL_FACES_DETECTOR_MODEL: String(_resolvedCfg.detectorModel || 'buffalo_l'),
        // On Windows, 'auto' selects DirectML which triggers STATUS_ACCESS_VIOLATION
        // (0xC0000005) on many machines due to ONNX/DML driver instability.
        // Default to CPU on Windows unless the operator explicitly chose a provider.
        TGDL_FACES_PROVIDERS: String(
            _resolvedCfg.providers || (process.platform === 'win32' ? 'cpu' : 'auto'),
        ),
        TGDL_FACES_DET_SIZE: String(_resolvedCfg.detSize || 640),
        // Disable Python's stdout buffering so log lines surface in the
        // dashboard's log feed in real time rather than batched at exit.
        PYTHONUNBUFFERED: '1',
    };

    let child;
    try {
        child = spawn(pyBin, ['-m', 'tgdl_faces'], {
            cwd: facesService,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
    } catch (e) {
        return { ok: false, reason: `python spawn failed: ${e?.message || e}` };
    }
    if (!child || !child.pid) {
        return { ok: false, reason: 'python spawn returned no pid' };
    }
    return { ok: true, child, mode: 'python', pyBin };
}

/**
 * Probe `python3` first (POSIX convention), then `python` (Windows
 * fallback). Returns the absolute interpreter name on success, null
 * when nothing on PATH is Python ≥ 3.10.
 */
async function _findPython3OrAbove() {
    const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
    for (const bin of candidates) {
        const ok = _checkPythonVersion(bin);
        if (ok) return bin;
    }
    return null;
}

function _checkPythonVersion(bin) {
    try {
        const res = spawnSync(bin, ['--version'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 5000,
            windowsHide: true,
        });
        if (res.error) return false;
        if (res.status !== 0 && res.status !== null) return false;
        const text = `${res.stdout || ''}${res.stderr || ''}`;
        const m = String(text).match(/Python\s+(\d+)\.(\d+)(?:\.(\d+))?/);
        if (!m) return false;
        const major = Number(m[1]);
        const minor = Number(m[2]);
        return major === 3 && minor >= 10;
    } catch {
        return false;
    }
}

function _checkPythonDeps(bin) {
    return new Promise((resolve) => {
        try {
            const res = spawnSync(
                bin,
                ['-c', 'import fastapi, insightface, onnxruntime, cv2, numpy, PIL'],
                {
                    stdio: ['ignore', 'pipe', 'pipe'],
                    timeout: 10000,
                    windowsHide: true,
                },
            );
            if (res.error) {
                resolve({ ok: false, detail: res.error.code || res.error.message });
                return;
            }
            if (res.status === 0) {
                resolve({ ok: true });
                return;
            }
            const stderr = String(res.stderr || '').trim();
            const m = stderr.match(/ModuleNotFoundError: No module named ['"]([^'"]+)['"]/);
            resolve({
                ok: false,
                detail: m ? `missing module: ${m[1]}` : stderr.split(/\r?\n/).pop() || '',
            });
        } catch (e) {
            resolve({ ok: false, detail: e?.message || String(e) });
        }
    });
}

/**
 * Run the auto-detect installer (`python -m tgdl_faces.install`) and stream
 * progress over the `ai_faces_install_progress` / `ai_faces_install_done`
 * WS events. Used in two places:
 *
 *   1. `_tryPythonFallback` invokes it once per process when deps are
 *      missing — the operator never has to copy-paste pip commands.
 *   2. `POST /api/ai/faces/install-deps` exposes it to the dashboard so
 *      operators can re-run it after a hardware change (e.g. plugged in
 *      a new GPU and want to pick up the matching EP).
 *
 * Single-flight via `_installerRunning` — concurrent invocations return
 * `{ok:false, reason:'already running'}` rather than spawning two pip
 * processes that fight each other.
 *
 * @param {object} opts
 * @param {string} [opts.pyBin]     Python interpreter to use (default: auto-detect)
 * @param {string} [opts.force]     Override platform detection: cpu|gpu|directml|openvino
 * @returns {Promise<{ok:boolean, code:number?, reason?:string, lines:string[]}>}
 */
export async function installPythonDeps({ pyBin: pyBinArg, force } = {}) {
    if (_installerRunning) {
        return { ok: false, reason: 'installer already running', lines: [] };
    }
    const pyBin = pyBinArg || (await _findPython3OrAbove());
    if (!pyBin) {
        return { ok: false, reason: 'no Python 3.10+ on PATH', lines: [] };
    }
    const facesService = path.resolve(PROJECT_ROOT, 'faces-service');
    const installerEntry = path.join(facesService, 'tgdl_faces', 'install.py');
    if (!existsSync(installerEntry)) {
        return {
            ok: false,
            reason: `installer missing at ${installerEntry}`,
            lines: [],
        };
    }
    _installerRunning = true;
    const lines = [];
    _broadcast({ type: 'ai_faces_install_progress', state: 'starting', line: '' });
    _log('info', `running auto-installer via ${pyBin}`);
    return await new Promise((resolve) => {
        const args = ['-m', 'tgdl_faces.install'];
        if (force) args.push('--force', force);
        let child;
        try {
            child = spawn(pyBin, args, {
                cwd: facesService,
                env: { ...process.env, PYTHONUNBUFFERED: '1' },
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
        } catch (e) {
            _installerRunning = false;
            const reason = `installer spawn failed: ${e?.message || e}`;
            _log('error', reason);
            _broadcast({ type: 'ai_faces_install_done', ok: false, reason });
            resolve({ ok: false, reason, lines });
            return;
        }
        const onLine = (chunk) => {
            for (const raw of String(chunk).split(/\r?\n/)) {
                const line = raw.trimEnd();
                if (!line) continue;
                lines.push(line);
                if (lines.length > 500) lines.shift();
                _log('info', `[installer] ${line}`);
                _broadcast({ type: 'ai_faces_install_progress', state: 'running', line });
            }
        };
        child.stdout.on('data', onLine);
        child.stderr.on('data', onLine);
        child.on('error', (e) => {
            _installerRunning = false;
            const reason = `installer error: ${e?.message || e}`;
            _log('error', reason);
            _broadcast({ type: 'ai_faces_install_done', ok: false, reason });
            resolve({ ok: false, reason, lines });
        });
        child.on('exit', (code) => {
            _installerRunning = false;
            const ok = code === 0;
            _log(ok ? 'info' : 'warn', `installer exited code=${code}`);
            _broadcast({
                type: 'ai_faces_install_done',
                ok,
                code,
                reason: ok ? null : `installer exited code=${code}`,
            });
            resolve({ ok, code, lines });
        });
    });
}

/**
 * Reset the auto-install guard so the next sidecar spawn re-attempts the
 * installer. Used by `POST /api/ai/faces/install-deps` after a manual
 * install run; without this the spawn flow's "already tried this boot"
 * gate would skip re-running it on the next restart-attempt.
 */
export function resetAutoInstallGuard() {
    _autoInstallTried = false;
}

// ---- Binary target resolution -------------------------------------------

/**
 * Resolve the local binary path + the candidate tarball URLs for the
 * current platform/arch. Returns `null` for unsupported combos so the
 * caller can disable gracefully rather than crash.
 *
 * Exported (via `_resolveBinaryTargetForTest`) so the platform-parity test
 * suite can pin `process.platform` / `process.arch` for each row of the
 * support matrix without monkey-patching the whole spawn module.
 *
 * Tarball-URL precedence:
 *   1. `TGDL_FACES_SIDECAR_BIN_URL` (legacy `FACES_SIDECAR_BIN_URL` also
 *      honoured for backward compat).
 *   2. `advanced.ai.faces.downloadMirrors[*]` (operator-listed alternatives,
 *      tried in order).
 *   3. The canonical GitHub Release URL.
 */
function _resolveBinaryTarget(resolvedCfg = _resolvedCfg) {
    return _computeBinaryTarget({
        platform: process.platform,
        arch: process.arch,
        dataDir: DATA_DIR,
        envBinUrl:
            _normaliseUrl(process.env.TGDL_FACES_SIDECAR_BIN_URL) ||
            _normaliseUrl(process.env.FACES_SIDECAR_BIN_URL),
        cfgMirrors: Array.isArray(resolvedCfg?.downloadMirrors) ? resolvedCfg.downloadMirrors : [],
    });
}

/**
 * Pure version of `_resolveBinaryTarget` — exported for unit tests so the
 * full support-matrix (win/linux/mac × x64/arm64) can be exercised without
 * mocking the entire spawn module. No side effects, no process inspection.
 *
 * @param {object} opts
 * @param {string} opts.platform  `process.platform` value
 * @param {string} opts.arch      `process.arch` value
 * @param {string} opts.dataDir   absolute path to the data dir
 * @param {string?} opts.envBinUrl  resolved env URL override (or null)
 * @param {string[]?} opts.cfgMirrors  operator-supplied mirror URLs
 * @returns {object|null}  target descriptor or null on unsupported platform
 */
export function _computeBinaryTarget(opts) {
    const { platform: nodePlatform, arch: nodeArch, dataDir, envBinUrl, cfgMirrors } = opts;
    const platformMap = { win32: 'win', linux: 'linux', darwin: 'mac' };
    const archMap = { x64: 'x64', arm64: 'arm64' };
    const platform = platformMap[nodePlatform];
    const arch = archMap[nodeArch];
    if (!platform || !arch) return null;

    const slug = `tgdl-faces-${platform}-${arch}`;
    const exe = nodePlatform === 'win32' ? '.exe' : '';
    const binDir = path.join(dataDir, 'faces-service', 'bin');
    const modelsDir = path.join(dataDir, 'faces-service', 'models');
    const binPath = path.join(binDir, `${slug}${exe}`);

    // Build the ordered candidate URL list.
    const candidates = [];
    if (envBinUrl) candidates.push(envBinUrl);
    if (Array.isArray(cfgMirrors)) {
        for (const m of cfgMirrors) {
            const url = _normaliseUrl(m);
            if (!url) continue;
            // The mirror may be a full URL to a specific tarball or a base
            // URL the caller wants templated. We accept both: if the URL
            // already ends with `.tar.gz` it's taken verbatim; otherwise we
            // append `/<slug>.tar.gz`.
            if (url.endsWith('.tar.gz')) candidates.push(url);
            else candidates.push(`${url.replace(/\/+$/, '')}/${slug}.tar.gz`);
        }
    }
    candidates.push(`${GH_RELEASE_BASE}/${slug}.tar.gz`);

    // `tarUrl` stays for backward compat with existing callers; new code
    // walks `tarUrls` in order.
    return {
        platform,
        arch,
        slug,
        exe,
        binDir,
        modelsDir,
        binPath,
        tarUrl: candidates[0],
        tarUrls: candidates,
    };
}

function _isBinaryUsable(binPath) {
    try {
        const st = statSync(binPath);
        if (!st.isFile()) return false;
        if (process.platform !== 'win32') {
            // Exec bit check — readFile alone doesn't tell us whether the
            // file is runnable. On Windows the .exe extension is enough;
            // POSIX needs at least one exec bit set.
            if ((st.mode & 0o111) === 0) return false;
        }
        return st.size > 0;
    } catch {
        return false;
    }
}

function _verifyBinary(binPath) {
    try {
        const res = spawnSync(binPath, ['--help'], {
            stdio: 'ignore',
            timeout: 5000,
        });
        // Any clean exit (0 or non-zero) means the kernel could load it.
        // A spawn-time error (ENOENT, EACCES, code 'EAGAIN' on Windows
        // when AV is scanning) shows up as `res.error`.
        if (res?.error) return false;
        if (res?.status === null && res?.signal) return false;
        return true;
    } catch {
        return false;
    }
}

// ---- Download + extract -------------------------------------------------

/**
 * Quick HEAD preflight — check whether the first candidate URL resolves to a
 * real asset before committing to the full download. Returns true when the
 * server responds with a 2xx or 3xx (GitHub CDN redirect); false on 404 or
 * any network/timeout error.
 *
 * This avoids showing a confusing "downloading…" spinner on dev builds where
 * the `faces-v<X>` GitHub Release tag hasn't been published yet.
 */
async function _releaseAvailable(url) {
    return new Promise((resolve) => {
        const proto = url.startsWith('https:') ? https : http;
        let settled = false;
        const done = (v) => {
            if (!settled) {
                settled = true;
                resolve(v);
            }
        };
        try {
            const req = proto.request(url, { method: 'HEAD' }, (res) => {
                res.resume();
                // 2xx or 3xx (GitHub CDN redirect) = asset exists; 404 = not published
                done(res.statusCode < 400);
            });
            req.on('error', () => done(false));
            req.setTimeout(5000, () => {
                req.destroy();
                done(false);
            });
            req.end();
        } catch {
            done(false);
        }
    });
}

async function _downloadAndExtract(target) {
    await fs.mkdir(target.binDir, { recursive: true });
    await fs.mkdir(target.modelsDir, { recursive: true });

    const tmpTarball = path.join(target.binDir, `${target.slug}-${Date.now()}.tar.gz`);
    const urls =
        Array.isArray(target.tarUrls) && target.tarUrls.length ? target.tarUrls : [target.tarUrl];
    let lastErr = null;
    let downloaded = false;
    for (const url of urls) {
        _log('info', `downloading ${url} -> ${tmpTarball}`);
        try {
            await _streamDownload(url, tmpTarball);
            downloaded = true;
            break;
        } catch (e) {
            lastErr = e;
            _log('warn', `download from ${url} failed: ${e?.message || e}`);
            // Clean partial file before trying the next mirror so the
            // extractor doesn't pick up a half-baked tarball.
            try {
                await fs.unlink(tmpTarball);
            } catch {}
        }
    }
    if (!downloaded) {
        throw lastErr || new Error('all download URLs failed');
    }
    try {
        _log('info', `extracting ${tmpTarball} into ${target.binDir}`);
        await _extractTarball(tmpTarball, target.binDir);
    } finally {
        // Always clean up the temp tarball, even if extraction failed —
        // leaving 80 MB of stale .tar.gz files behind on a retry loop
        // would eat the operator's disk fast.
        try {
            await fs.unlink(tmpTarball);
        } catch {}
    }

    if (!existsSync(target.binPath)) {
        throw new Error(`expected binary at ${target.binPath} after extraction`);
    }

    // chmod +x on Unix-likes. Windows has no exec bit so skip.
    if (process.platform !== 'win32') {
        try {
            await fs.chmod(target.binPath, 0o755);
        } catch (e) {
            _log('warn', `chmod failed: ${e?.message || e}`);
        }
    }
}

/**
 * Stream an HTTPS URL to disk with redirect following and progress
 * broadcasting. Never buffers the whole payload — the file goes straight
 * onto disk so an 80 MB tarball doesn't spike the heap.
 */
function _streamDownload(url, destPath, redirectsLeft = _downloadRedirectLimit()) {
    return new Promise((resolve, reject) => {
        const parsed = _parseUrl(url);
        if (!parsed) return reject(new Error(`bad url: ${url}`));

        const lib = parsed.protocol === 'http:' ? http : https;
        const req = lib.get(
            url,
            {
                headers: {
                    'user-agent': 'tgdl-faces-spawn',
                    accept: 'application/octet-stream',
                },
                timeout: DOWNLOAD_CONNECT_TIMEOUT_MS,
            },
            (res) => {
                // Follow up to 5 redirects (GitHub bounces to a CDN).
                if (
                    res.statusCode >= 300 &&
                    res.statusCode < 400 &&
                    res.headers.location &&
                    redirectsLeft > 0
                ) {
                    res.resume();
                    const next = _resolveLocation(url, res.headers.location);
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
                    // Throttle WS events to ~10/s so a fast connection
                    // doesn't drown the WS bus with hundreds of progress
                    // payloads per second.
                    const now = Date.now();
                    if (now - lastBroadcast >= 100 || (total > 0 && loaded === total)) {
                        lastBroadcast = now;
                        const pct = total > 0 ? Math.min(100, (loaded * 100) / total) : 0;
                        _broadcast({
                            type: 'ai_faces_download_progress',
                            loaded,
                            total,
                            pct,
                        });
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
        req.on('timeout', () => {
            req.destroy(new Error('download connect timeout'));
        });
        req.on('error', (e) => reject(e));
    });
}

/**
 * Extract a .tar.gz into `destDir`. Prefer the system `tar` binary —
 * Windows 10+ ships it, every supported Linux/macOS has it. Fall back
 * to a Node-level decode using zlib + a minimal tar parser when `tar`
 * isn't on PATH (rare, but possible on stripped-down container images).
 */
async function _extractTarball(tarballPath, destDir) {
    // Try system tar first.
    try {
        const res = spawnSync('tar', ['-xzf', tarballPath, '-C', destDir], {
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 120_000,
        });
        if (!res.error && res.status === 0) return;
        if (res.error) {
            _log('info', `system tar unavailable (${res.error.code || res.error.message})`);
        } else {
            _log(
                'warn',
                `system tar failed status=${res.status}: ${res.stderr?.toString?.() || ''}`,
            );
        }
    } catch (e) {
        _log('info', `system tar threw: ${e?.message || e}`);
    }

    // Fallback: Node-level decode. Streams to disk, never buffers the
    // whole tarball in memory.
    await _extractTarballNodeFallback(tarballPath, destDir);
}

/**
 * Streaming tar.gz extractor — gunzip the tarball, then walk 512-byte
 * tar blocks. Supports REGULAR files and DIRECTORIES (which is all the
 * sidecar release ships). Symlinks, long-name extensions, and PAX
 * headers are intentionally rejected — if a future sidecar release
 * needs them, the GitHub Actions build can re-pack without them.
 */
async function _extractTarballNodeFallback(tarballPath, destDir) {
    const { createGunzip } = await import('zlib');
    const { createReadStream } = await import('fs');
    const rs = createReadStream(tarballPath);
    const gz = createGunzip();

    let buf = Buffer.alloc(0);
    let pendingHeader = null;
    let pendingBytesRemaining = 0;
    let pendingPaddingBytes = 0;
    let pendingWriteStream = null;
    let pendingWritePromise = null;

    const ensureDir = async (p) => {
        await fs.mkdir(p, { recursive: true });
    };

    const finishPendingWrite = async () => {
        if (pendingWriteStream) {
            const ws = pendingWriteStream;
            const wp = pendingWritePromise;
            pendingWriteStream = null;
            pendingWritePromise = null;
            ws.end();
            await wp;
        }
    };

    return new Promise((resolve, reject) => {
        gz.on('error', reject);
        rs.on('error', reject);

        gz.on('data', async (chunk) => {
            try {
                buf = Buffer.concat([buf, chunk]);
                // Loop until we run out of complete records (headers /
                // file payloads) in the buffered slice.
                while (true) {
                    if (pendingHeader) {
                        // Consuming file payload.
                        if (pendingBytesRemaining > 0) {
                            const slice = buf.subarray(
                                0,
                                Math.min(pendingBytesRemaining, buf.length),
                            );
                            if (slice.length === 0) return;
                            if (pendingWriteStream) {
                                if (!pendingWriteStream.write(slice)) {
                                    gz.pause();
                                    pendingWriteStream.once('drain', () => gz.resume());
                                }
                            }
                            pendingBytesRemaining -= slice.length;
                            buf = buf.subarray(slice.length);
                            if (pendingBytesRemaining > 0) return;
                        }
                        if (pendingPaddingBytes > 0) {
                            if (buf.length < pendingPaddingBytes) return;
                            buf = buf.subarray(pendingPaddingBytes);
                            pendingPaddingBytes = 0;
                        }
                        await finishPendingWrite();
                        pendingHeader = null;
                        continue;
                    }
                    if (buf.length < 512) return;
                    const header = buf.subarray(0, 512);
                    buf = buf.subarray(512);
                    // All-zero block = end of archive.
                    if (header.every((b) => b === 0)) {
                        // Two zero blocks mark EOF; we treat the first one
                        // as terminator too — extra padding is harmless.
                        continue;
                    }
                    const name = _readNulTerminated(header, 0, 100);
                    const sizeOctal = _readNulTerminated(header, 124, 12).trim();
                    // Tar typeflag byte (numeric — avoids embedding a NUL
                    // literal in source).
                    const typeByte = header[156] || 0;
                    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
                    const padding = size % 512 === 0 ? 0 : 512 - (size % 512);

                    const target = path.join(destDir, name);
                    if (!target.startsWith(path.resolve(destDir))) {
                        throw new Error(`tar entry escapes destDir: ${name}`);
                    }

                    const isDir = typeByte === TAR_TYPE_DIRECTORY || name.endsWith('/');
                    const isRegular =
                        typeByte === TAR_TYPE_REGULAR_MODERN ||
                        typeByte === TAR_TYPE_REGULAR_LEGACY ||
                        typeByte === TAR_TYPE_REGULAR_SPACE;

                    if (isDir) {
                        await ensureDir(target);
                        pendingHeader = header;
                        pendingBytesRemaining = 0;
                        pendingPaddingBytes = padding;
                    } else if (isRegular) {
                        await ensureDir(path.dirname(target));
                        pendingHeader = header;
                        pendingBytesRemaining = size;
                        pendingPaddingBytes = padding;
                        try {
                            pendingWriteStream = createWriteStream(target);
                        } catch (wsErr) {
                            throw new Error(`cannot write ${name}: ${wsErr.message}`);
                        }
                        pendingWritePromise = new Promise((res, rej) => {
                            pendingWriteStream.on('finish', () => res());
                            pendingWriteStream.on('error', rej);
                        });
                        if (size === 0) {
                            // Empty file — flush immediately so the loop
                            // moves on.
                            await finishPendingWrite();
                            if (padding > 0) {
                                if (buf.length < padding) return;
                                buf = buf.subarray(padding);
                                pendingPaddingBytes = 0;
                            }
                            pendingHeader = null;
                        }
                    } else {
                        // Unsupported entry type — skip its payload + padding.
                        pendingHeader = header;
                        pendingBytesRemaining = size;
                        pendingPaddingBytes = padding;
                        pendingWriteStream = null;
                        pendingWritePromise = Promise.resolve();
                    }
                }
            } catch (e) {
                reject(e);
            }
        });

        gz.on('end', async () => {
            try {
                await finishPendingWrite();
                resolve();
            } catch (e) {
                reject(e);
            }
        });

        rs.pipe(gz);
    });
}

function _readNulTerminated(buf, offset, length) {
    let end = offset;
    const max = offset + length;
    while (end < max && buf[end] !== 0) end++;
    return buf.toString('utf8', offset, end);
}

// ---- Spawn + health probe -----------------------------------------------

async function _spawnAndProbe(binPath) {
    const port = await _pickAvailablePort();
    const downloadsDir = getDownloadsDir();
    const modelsDir = path.resolve(DATA_DIR, 'faces-service', 'models');
    await fs.mkdir(downloadsDir, { recursive: true });
    await fs.mkdir(modelsDir, { recursive: true });

    const env = {
        ...process.env,
        PYTHONUTF8: '1',
        TGDL_FACES_HOST: '127.0.0.1',
        TGDL_FACES_PORT: String(port),
        TGDL_FACES_ALLOW_ROOTS: downloadsDir,
        TGDL_FACES_MODELS_DIR: modelsDir,
        // Same rationale as the python-fallback env above: forward the
        // operator-selected insightface preset + EP hint so the
        // prebuilt binary loads the dropdown's choice on /restart.
        TGDL_FACES_DETECTOR_MODEL: String(_resolvedCfg.detectorModel || 'buffalo_l'),
        // Matching the python-fallback default: CPU on Windows to avoid
        // the DirectML STATUS_ACCESS_VIOLATION crash.
        TGDL_FACES_PROVIDERS: String(
            _resolvedCfg.providers || (process.platform === 'win32' ? 'cpu' : 'auto'),
        ),
        TGDL_FACES_DET_SIZE: String(_resolvedCfg.detSize || 640),
    };

    _log('info', `spawning ${binPath} on 127.0.0.1:${port}`);
    const child = spawn(binPath, [], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    _child = child;

    _wirePipeLogging(child.stdout, 'info');
    // Match the python-fallback rationale above: Python+uvicorn write
    // INFO to stderr by default, so 'info' is the right fallback level.
    _wirePipeLogging(child.stderr, 'info');

    let exited = false;
    let exitInfo = null;
    child.on('exit', (code, signal) => {
        exited = true;
        exitInfo = { code, signal };
        _log('warn', `child exited early code=${code} signal=${signal}`);
    });
    child.on('error', (e) => {
        exited = true;
        exitInfo = { error: e };
        _log('error', `child error: ${e?.message || e}`);
    });

    const url = `http://127.0.0.1:${port}`;
    const timeoutMs = _firstBoot ? _firstBootHealthTimeoutMs() : _respawnHealthTimeoutMs();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (exited) {
            throw new Error(
                `child exited before health: code=${exitInfo?.code} signal=${exitInfo?.signal}`,
            );
        }
        const ok = await _probeHealth(url);
        if (ok) return url;
        await _sleep(HEALTH_POLL_INTERVAL_MS);
    }
    throw new Error(`health probe timed out after ${timeoutMs} ms`);
}

// Python's `logging` + uvicorn write EVERYTHING to stderr (INFO included),
// so wiring stderr → `_log('error', ...)` blindly mis-tags every healthy
// startup line as a hard error. Parse the level prefix from common
// Python log formats so the dashboard log feed colours each line correctly.
const _PY_LEVEL_PATTERNS = [
    [/\bERROR\b/i, 'error'],
    [/\bCRITICAL\b/i, 'error'],
    [/\bWARN(ING)?\b/i, 'warn'],
    [/\bINFO\b/i, 'info'],
    [/\bDEBUG\b/i, 'info'],
];
function _inferPyLevel(line, fallback) {
    for (const [re, lvl] of _PY_LEVEL_PATTERNS) {
        if (re.test(line)) return lvl;
    }
    return fallback;
}
// Drop successful per-request access lines from the dashboard log feed.
// Uvicorn + the in-process logger each emit one line per inference hit
// (`POST /detect -> 200` and `"POST /detect HTTP/1.1" 200 OK`). At scan
// rates of ~1 req/s that floods the Maintenance → Logs panel with
// thousands of green noise entries, drowning real warnings. We keep any
// non-200 response so failures still surface. Health probes are
// filtered too since `/health` fires every few seconds from the health
// monitor.
const _ACCESS_NOISE_RE =
    /(?:"(?:GET|POST|PUT|DELETE|OPTIONS)\s+\/(?:detect|health|info|detect_b64)(?:\?\S*)?\s+HTTP\/[\d.]+"\s+200\b|(?:GET|POST|PUT|DELETE|OPTIONS)\s+\/(?:detect|health|info|detect_b64)\s+->\s+200\b)/;
function _isAccessNoise(line) {
    return _ACCESS_NOISE_RE.test(line);
}
function _wirePipeLogging(stream, level) {
    if (!stream) return;
    let leftover = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
        const text = leftover + chunk;
        const lines = text.split(/\r?\n/);
        leftover = lines.pop() || '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (_isAccessNoise(trimmed)) continue;
            _log(_inferPyLevel(trimmed, level), line);
        }
    });
    stream.on('end', () => {
        if (leftover.trim() && !_isAccessNoise(leftover)) {
            _log(_inferPyLevel(leftover, level), leftover);
        }
        leftover = '';
    });
    stream.on('error', () => {
        /* don't crash if the pipe goes away */
    });
}

function _probeHealth(url) {
    return new Promise((resolve) => {
        const req = http.get(`${url}/health`, { timeout: 2000 }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return resolve(false);
            }
            let buf = '';
            res.setEncoding('utf8');
            res.on('data', (c) => {
                buf += c;
                if (buf.length > 4096) {
                    req.destroy();
                    resolve(false);
                }
            });
            res.on('end', () => {
                try {
                    const body = JSON.parse(buf);
                    resolve(body?.ok === true);
                } catch {
                    resolve(false);
                }
            });
            res.on('error', () => resolve(false));
        });
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
        req.on('error', () => resolve(false));
    });
}

async function _pickAvailablePort() {
    const [lo, hi] = _portRange();
    const attempts = _portProbeAttempts();
    for (let attempt = 0; attempt < attempts; attempt++) {
        const port = _randInt(lo, hi);
        if (await _isPortFree(port)) return port;
    }
    throw new Error(
        `could not find a free localhost port in ${lo}-${hi} after ${attempts} attempts`,
    );
}

function _isPortFree(port) {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.once('error', () => resolve(false));
        srv.listen(port, '127.0.0.1', () => {
            srv.close(() => resolve(true));
        });
    });
}

function _randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ---- Background health monitor ------------------------------------------

function _scheduleHealthMonitor(binPath) {
    if (_healthMonitorTimer) clearInterval(_healthMonitorTimer);
    const intervalMs = _healthMonitorIntervalMs();
    const failThreshold = _healthFailureThreshold();
    _healthMonitorTimer = setInterval(async () => {
        if (!_childUrl) return;
        const ok = await _probeHealth(_childUrl);
        if (ok) {
            _healthMonitorFailCount = 0;
            return;
        }
        _healthMonitorFailCount++;
        _log('warn', `health probe failed (${_healthMonitorFailCount}/${failThreshold})`);
        if (_healthMonitorFailCount >= failThreshold) {
            _log('error', 'health monitor threshold hit — relaunching sidecar');
            clearInterval(_healthMonitorTimer);
            _healthMonitorTimer = null;
            _killChild();
            _state = 'spawning';
            _broadcast({ type: 'ai_faces_status', ok: false, state: 'relaunching' });
            try {
                const url = await _spawnAndProbe(binPath);
                _childUrl = url;
                _state = 'healthy';
                _error = null;
                _healthMonitorFailCount = 0;
                setSidecarUrl(url);
                _scheduleHealthMonitor(binPath);
                _broadcast({
                    type: 'ai_faces_status',
                    ok: true,
                    url,
                    mode: 'spawn',
                    relaunched: true,
                });
                _log('info', `relaunched sidecar at ${url}`);
            } catch (e) {
                _state = 'failed';
                _error = `relaunch failed: ${e?.message || e}`;
                _log('error', _error);
                _broadcast({ type: 'ai_faces_status', ok: false, error: _error });
            }
        }
    }, intervalMs);
    // Don't keep the event loop alive purely for the health monitor —
    // when nothing else holds the process open, the monitor shouldn't
    // either (mirrors the behaviour of other background sweeps).
    if (_healthMonitorTimer.unref) _healthMonitorTimer.unref();
}

// ---- Lifecycle ----------------------------------------------------------

function _killChild() {
    const c = _child;
    _child = null;
    _childUrl = null;
    if (!c || c.killed) return;
    try {
        c.kill('SIGTERM');
    } catch {}
    const t = setTimeout(() => {
        if (!c.killed) {
            try {
                c.kill('SIGKILL');
            } catch {}
        }
    }, KILL_GRACE_MS);
    if (t.unref) t.unref();
}

function _wireShutdownHooks() {
    if (_shutdownHooksWired) return;
    _shutdownHooksWired = true;
    const stop = () => stopSidecar();
    process.once('beforeExit', stop);
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
}

// ---- Dim-mismatch DB migration ------------------------------------------

async function _maybeMigrateDim(url) {
    try {
        const info = await _fetchInfo(url);
        const sidecarDim = Number(info?.dim);
        if (!Number.isFinite(sidecarDim) || sidecarDim <= 0) return;

        const db = await import('../db.js');
        if (typeof db.getAiCounts === 'function') {
            const counts = db.getAiCounts({ fileTypes: ['photo'] });
            if (!counts || counts.withFaces === 0) return;
        }

        if (typeof db.iterateAllFaces !== 'function') return;
        let firstRow;
        for (const row of db.iterateAllFaces()) {
            firstRow = row;
            break;
        }
        if (!firstRow || !firstRow.embedding) return;
        const blob = firstRow.embedding;
        const byteLength = blob.byteLength ?? blob.length ?? 0;
        const existingDim = byteLength / 4;
        if (existingDim === sidecarDim) return;

        _log(
            'info',
            `dim mismatch: existing ${existingDim} vs sidecar ${sidecarDim} — purging stale rows`,
        );

        const handle = typeof db.getDb === 'function' ? db.getDb() : null;
        if (!handle) return;
        const tx = handle.transaction(() => {
            handle.prepare('DELETE FROM faces').run();
            handle.prepare('DELETE FROM people').run();
        });
        tx();
        _broadcast({
            type: 'ai_faces_dim_change',
            oldDim: existingDim,
            newDim: sidecarDim,
        });
    } catch (e) {
        _log('warn', `dim migration check skipped: ${e?.message || e}`);
    }
}

function _fetchInfo(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(`${url}/info`, { timeout: 5000 }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`http ${res.statusCode}`));
            }
            let buf = '';
            res.setEncoding('utf8');
            res.on('data', (c) => {
                buf += c;
                if (buf.length > 16_384) {
                    req.destroy();
                    reject(new Error('info body too large'));
                }
            });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(buf));
                } catch (e) {
                    reject(e);
                }
            });
            res.on('error', reject);
        });
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('info timeout'));
        });
        req.on('error', reject);
    });
}

// ---- Util ---------------------------------------------------------------

function _broadcast(payload) {
    try {
        const fn = globalThis.__tgdlBroadcast;
        if (typeof fn === 'function') fn(payload);
    } catch {
        /* never crash spawn flow on a broadcast failure */
    }
}

function _log(level, msg) {
    // The web server registers a structured `log()` callback that fans
    // out to WS + stdout. We piggy-back on the same broadcast hook so
    // the dashboard's `/maintenance/logs` panel surfaces sidecar lines
    // alongside everything else. Mirror to stdout/stderr regardless,
    // matching the convention used by other core modules.
    try {
        _broadcast({
            type: 'log',
            ts: Date.now(),
            source: 'ai-faces-spawn',
            level,
            msg: String(msg),
        });
    } catch {}
    const line = `[ai-faces-spawn] [${level}] ${msg}`;
    try {
        if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
        else process.stdout.write(line + '\n');
    } catch {}
}

function _normaliseUrl(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim().replace(/\/+$/, '');
    if (!trimmed) return null;
    return trimmed;
}

function _parseUrl(raw) {
    try {
        return new URL(raw);
    } catch {
        return null;
    }
}

function _resolveLocation(base, loc) {
    try {
        return new URL(loc, base).toString();
    } catch {
        return loc;
    }
}

function _sleep(ms) {
    return new Promise((r) => {
        const t = setTimeout(r, ms);
        if (t.unref) t.unref();
    });
}

// Internal test hooks — reset module state between specs. Not exported in
// the public surface; tests reach in via `import * as mod`.
export function _resetForTests() {
    if (_healthMonitorTimer) {
        clearInterval(_healthMonitorTimer);
        _healthMonitorTimer = null;
    }
    _starting = null;
    _child = null;
    _childUrl = null;
    _state = 'idle';
    _error = null;
    _healthMonitorFailCount = 0;
    _firstBoot = true;
    _shutdownHooksWired = false;
    _resolvedCfg = null;
}
