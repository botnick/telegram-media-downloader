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

import { existsSync, promises as fs } from 'fs';
import path from 'path';
import http from 'http';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import { setSidecarUrl, getSidecarUrl, applyFacesCfg } from './faces-client.js';
import { resolveAllFaces } from './faces-config.js';
import { inferPyLevel, isAccessNoise, wirePipeLogging } from './faces-log-filter.js';
import { pickAvailablePort } from './faces-port.js';
import {
    SIDECAR_VERSION,
    normaliseUrl as _normaliseUrl,
    resolveBinaryTarget,
    isBinaryUsable as _isBinaryUsable,
    verifyBinary as _verifyBinary,
    downloadAndExtract,
    _parseChecksumFile,
    _hashFile,
    _verifyChecksum,
    computeBinaryTarget as _computeBinaryTarget,
} from './faces-download.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const DATA_DIR = process.env.TGDL_DATA_DIR
    ? path.resolve(process.env.TGDL_DATA_DIR)
    : path.join(PROJECT_ROOT, 'data');

export { SIDECAR_VERSION };

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

// Module-level state. The state machine is intentionally simple — the
// spawn module is owned by exactly one process and one boot path; the
// `_starting` promise gates concurrent `startSidecar()` calls.
let _starting = null;
let _child = null;
let _childUrl = null;
let _state = 'idle'; // idle | downloading | spawning | healthy | failed
let _error = null;
// null = not yet checked; true = verified; false = file missing or mismatch
let _checksumVerified = null;
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
        error: _error,
        pid: _child?.pid || null,
        version: SIDECAR_VERSION,
        checksumVerified: _checksumVerified,
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

    // Mode 1 — Docker compose sets `FACES_SERVICE_URL` to the sidecar's
    // in-network URL. No spawn needed; just hand the URL to the client.
    const envUrl = _normaliseUrl(process.env.FACES_SERVICE_URL);
    if (envUrl) {
        setSidecarUrl(envUrl);
        _childUrl = envUrl;
        _state = 'healthy';
        _error = null;
        _log('info', `using docker sidecar at ${envUrl}`);
        await _maybeMigrateDim(envUrl);
        _broadcast({ type: 'ai_faces_status', ok: true, url: envUrl, mode: 'docker' });
        return getSidecarStatus();
    }

    // Mode 2 — operator override via config / env. Resolver merges both;
    // explicit env wins over runtime config.
    const overrideUrl =
        _normaliseUrl(_resolvedCfg.sidecarUrl) || _normaliseUrl(aiCfg.facesServiceUrl);
    if (overrideUrl) {
        setSidecarUrl(overrideUrl);
        _childUrl = overrideUrl;
        _state = 'healthy';
        _error = null;
        _log('info', `using operator-override sidecar at ${overrideUrl}`);
        await _maybeMigrateDim(overrideUrl);
        _broadcast({ type: 'ai_faces_status', ok: true, url: overrideUrl, mode: 'override' });
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

    const target = resolveBinaryTarget(_resolvedCfg, { dataDir: DATA_DIR });
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
            _state = 'downloading';
            _checksumVerified = null;
            _broadcast({ type: 'ai_faces_status', ok: false, state: 'downloading' });
            try {
                await downloadAndExtract(target, {
                    logFn: _log,
                    broadcastFn: _broadcast,
                    redirectLimit: _downloadRedirectLimit(),
                    onChecksumResult: (v) => {
                        _checksumVerified = v;
                    },
                });
                binaryReady = _isBinaryUsable(target.binPath);
            } catch (e) {
                downloadError = `binary download failed: ${e?.message || e}`;
                _log('warn', `${downloadError} — will try Python fallback`);
            }
        }
    }

    // Verify the binary at least responds to `--help` — catches AV
    // quarantine, half-extracted tarballs, and so on. One retry: if it
    // fails, nuke and re-download once. A failure here still leaves the
    // Python fallback as a usable last resort.
    if (binaryReady && !_verifyBinary(target.binPath)) {
        _log('warn', `binary at ${target.binPath} failed verification — re-downloading`);
        try {
            await fs.unlink(target.binPath);
        } catch {}
        if (_resolvedCfg.autoDownload !== false) {
            try {
                await downloadAndExtract(target, {
                    logFn: _log,
                    broadcastFn: _broadcast,
                    redirectLimit: _downloadRedirectLimit(),
                    onChecksumResult: (v) => {
                        _checksumVerified = v;
                    },
                });
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
        const port = await pickAvailablePort({
            portRange: _portRange(),
            probeAttempts: _portProbeAttempts(),
        }).catch(() => null);
        if (port) {
            const downloadsDir = path.resolve(DATA_DIR, 'downloads');
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
                _child = fallback.child;
                wirePipeLogging(fallback.child.stdout, 'info', _log);
                // Python's `logging.basicConfig(stream=sys.stderr)` is the
                // standard config; uvicorn likewise writes INFO/access to
                // stderr. Default unparseable lines to 'info' (not 'error')
                // so a clean boot doesn't paint the log feed red.
                // `inferPyLevel` still upgrades any line containing
                // ERROR / CRITICAL / WARNING to the matching level.
                wirePipeLogging(fallback.child.stderr, 'info', _log);
                let exited = false;
                let exitInfo = null;
                fallback.child.on('exit', (code, signal) => {
                    exited = true;
                    exitInfo = { code, signal };
                    _log('warn', `python fallback exited code=${code} signal=${signal}`);
                });
                fallback.child.on('error', (e) => {
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
                        // No health monitor for the Python fallback — the
                        // operator's Python install is the source of truth;
                        // we don't try to relaunch it from a separate binary
                        // path. The standard `_scheduleHealthMonitor` would
                        // try to re-spawn from `binPath` (which is missing).
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

    const env = {
        ...process.env,
        TGDL_FACES_HOST: host,
        TGDL_FACES_PORT: String(port),
        TGDL_FACES_ALLOW_ROOTS: allowRoots,
        TGDL_FACES_MODELS_DIR: modelsDir,
        // Forward the operator-selected insightface preset + EP hint
        // into the sidecar env so /restart actually picks up the new
        // dropdown value. Without these, the Python child re-uses its
        // default (buffalo_l + auto) regardless of what the UI saved.
        TGDL_FACES_DETECTOR_MODEL: String(_resolvedCfg.detectorModel || 'buffalo_l'),
        TGDL_FACES_PROVIDERS: String(_resolvedCfg.providers || 'auto'),
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
// ---- Spawn + health probe -----------------------------------------------

async function _spawnAndProbe(binPath) {
    const port = await pickAvailablePort({
        portRange: _portRange(),
        probeAttempts: _portProbeAttempts(),
    });
    const downloadsDir = path.resolve(DATA_DIR, 'downloads');
    const modelsDir = path.resolve(DATA_DIR, 'faces-service', 'models');
    await fs.mkdir(downloadsDir, { recursive: true });
    await fs.mkdir(modelsDir, { recursive: true });

    const env = {
        ...process.env,
        TGDL_FACES_HOST: '127.0.0.1',
        TGDL_FACES_PORT: String(port),
        TGDL_FACES_ALLOW_ROOTS: downloadsDir,
        TGDL_FACES_MODELS_DIR: modelsDir,
        // Same rationale as the python-fallback env above: forward the
        // operator-selected insightface preset + EP hint so the
        // prebuilt binary loads the dropdown's choice on /restart.
        TGDL_FACES_DETECTOR_MODEL: String(_resolvedCfg.detectorModel || 'buffalo_l'),
        TGDL_FACES_PROVIDERS: String(_resolvedCfg.providers || 'auto'),
        TGDL_FACES_DET_SIZE: String(_resolvedCfg.detSize || 640),
    };

    _log('info', `spawning ${binPath} on 127.0.0.1:${port}`);
    const child = spawn(binPath, [], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    _child = child;

    wirePipeLogging(child.stdout, 'info', _log);
    // Match the python-fallback rationale above: Python+uvicorn write
    // INFO to stderr by default, so 'info' is the right fallback level.
    wirePipeLogging(child.stderr, 'info', _log);

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

// ---- Log filtering and pipe wiring (extracted to faces-log-filter.js) ---
// inferPyLevel, isAccessNoise, wirePipeLogging are imported from there.

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

// ---- Port allocation (extracted to faces-port.js) -----------------------
// pickAvailablePort, isPortFree are imported from there.

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

// _normaliseUrl is imported from faces-download.js as _normaliseUrl.

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
