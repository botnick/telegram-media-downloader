/**
 * Faces config resolver — merges three sources, in this precedence:
 *
 *   1. `TGDL_FACES_<UPPER_SNAKE>` env vars (deployment-time override —
 *      Docker compose, systemd, k8s).
 *   2. `config.advanced.ai.faces.*` (operator-set runtime config).
 *   3. The legacy flat aliases on `config.advanced.ai.*` (so code paths
 *      that pre-date Track I keep working without a coordinated rewrite).
 *   4. The hardcoded default baked into `manager.js` `DEFAULT_CONFIG`.
 *
 * Every knob from the `faces` block under `advanced.ai` is reachable here
 * with a single import. Consumers MUST go through this module — direct
 * reads of `cfg.faces.*` skip the env override and break the
 * "ยืดหยุ่นใช้งานได้จริง" promise the operator made.
 *
 * Why a separate module instead of inlining in `manager.js`? Three reasons:
 *
 *   - `manager.js` is read by far more code than the faces subsystem. A
 *     hot path that calls `loadConfig()` 100×/sec shouldn't pay env-var
 *     parsing cost on every invocation.
 *   - The env layer is the only one that needs to be re-read per process
 *     boot — runtime `saveConfig` does NOT change env. Keeping resolver
 *     state out of `manager.js` avoids surprising cache-invalidation
 *     interactions with `watchConfig()`.
 *   - Tests can mock `process.env` and re-import this module without
 *     also throwing away the kv-backed config layer.
 *
 * Env-var names follow the strict `TGDL_FACES_<KEY>` convention with
 * `<KEY>` derived from the camelCase config key by UPPER_SNAKE_CASE. The
 * mapping is explicit (not regex-driven) so refactoring a config key
 * never silently breaks an operator's env. See `docs/AI.md` for the
 * canonical table.
 */

const NUMBER_KEYS = new Set([
    'minDetectionScore',
    'minFaceSizePx',
    'detSize',
    'embedDim',
    'epsilon',
    'minPoints',
    'labelMatchEps',
    'batchSize',
    'sidecarMaxConcurrency',
    'healthCacheTtlMs',
    'requestTimeoutMs',
    'maxRetries',
    'portProbeAttempts',
    'firstBootHealthTimeoutMs',
    'respawnHealthTimeoutMs',
    'healthMonitorIntervalMs',
    'healthFailuresBeforeRelaunch',
    'downloadRedirectCap',
]);

const BOOL_KEYS = new Set(['autoDownload', 'federate', 'qualityWeightedCentroid']);

const STRING_KEYS = new Set(['backend', 'sidecarUrl', 'detectorModel', 'providers', 'detector']);

// Keys whose value is an array of numbers parsed from comma- or
// colon-separated env strings.
const NUMBER_ARRAY_KEYS = new Set(['arRange', 'retryBackoffMs', 'portRange']);

// Keys whose value is an array of strings.
const STRING_ARRAY_KEYS = new Set(['fileTypes', 'downloadMirrors', 'excludeExtensions']);

// Map each faces.* key to its TGDL_FACES_<UPPER_SNAKE> env name. Explicit so
// renames are caught at code-review time, not at first 3am Pi reboot.
const ENV_MAP = Object.freeze({
    backend: 'TGDL_FACES_BACKEND',
    sidecarUrl: 'TGDL_FACES_SIDECAR_URL',
    autoDownload: 'TGDL_FACES_AUTO_DOWNLOAD',
    minDetectionScore: 'TGDL_FACES_MIN_DETECTION_SCORE',
    minFaceSizePx: 'TGDL_FACES_MIN_FACE_SIZE_PX',
    arRange: 'TGDL_FACES_AR_RANGE',
    detSize: 'TGDL_FACES_DET_SIZE',
    embedDim: 'TGDL_FACES_EMBED_DIM',
    detectorModel: 'TGDL_FACES_DETECTOR_MODEL',
    providers: 'TGDL_FACES_PROVIDERS',
    epsilon: 'TGDL_FACES_EPSILON',
    minPoints: 'TGDL_FACES_MIN_POINTS',
    labelMatchEps: 'TGDL_FACES_LABEL_MATCH_EPS',
    detector: 'TGDL_FACES_DETECTOR',
    batchSize: 'TGDL_FACES_BATCH_SIZE',
    fileTypes: 'TGDL_FACES_FILE_TYPES',
    excludeExtensions: 'TGDL_FACES_EXCLUDE_EXTENSIONS',
    sidecarMaxConcurrency: 'TGDL_FACES_MAX_CONCURRENCY',
    healthCacheTtlMs: 'TGDL_FACES_HEALTH_CACHE_TTL_MS',
    requestTimeoutMs: 'TGDL_FACES_REQUEST_TIMEOUT_MS',
    maxRetries: 'TGDL_FACES_MAX_RETRIES',
    retryBackoffMs: 'TGDL_FACES_RETRY_BACKOFF_MS',
    portRange: 'TGDL_FACES_PORT_RANGE',
    portProbeAttempts: 'TGDL_FACES_PORT_PROBE_ATTEMPTS',
    firstBootHealthTimeoutMs: 'TGDL_FACES_FIRST_BOOT_HEALTH_TIMEOUT_MS',
    respawnHealthTimeoutMs: 'TGDL_FACES_RESPAWN_HEALTH_TIMEOUT_MS',
    healthMonitorIntervalMs: 'TGDL_FACES_HEALTH_MONITOR_INTERVAL_MS',
    healthFailuresBeforeRelaunch: 'TGDL_FACES_HEALTH_FAILURES_BEFORE_RELAUNCH',
    downloadRedirectCap: 'TGDL_FACES_DOWNLOAD_REDIRECT_CAP',
    downloadMirrors: 'TGDL_FACES_DOWNLOAD_MIRRORS',
    federate: 'TGDL_FACES_FEDERATE',
    qualityWeightedCentroid: 'TGDL_FACES_QUALITY_WEIGHTED_CENTROID',
});

/**
 * Return the resolved value for a single faces.* key, applying env-var
 * overrides on top of the supplied `facesCfg` slice (which the caller
 * obtained from `loadConfig().advanced.ai.faces`).
 *
 * @param {string} key   one of the faces.* config keys
 * @param {object} facesCfg  the `config.advanced.ai.faces` block
 * @returns {any}  parsed/cleaned value
 */
export function resolveFacesValue(key, facesCfg = {}) {
    const fromCfg = facesCfg ? facesCfg[key] : undefined;
    const envName = ENV_MAP[key];
    if (!envName) return fromCfg;
    const raw = process.env[envName];
    if (raw === undefined || raw === null || raw === '') return fromCfg;
    return _parseEnv(key, raw, fromCfg);
}

/**
 * Resolve every faces.* key in one pass — used at module boot so the spawn
 * + client paths don't have to re-call `resolveFacesValue` per knob. The
 * returned object is a frozen snapshot; subsequent env mutation (rare,
 * mostly tests) requires a fresh call.
 */
export function resolveAllFaces(facesCfg = {}) {
    const out = { ...facesCfg };
    for (const key of Object.keys(ENV_MAP)) {
        out[key] = resolveFacesValue(key, facesCfg);
    }
    return Object.freeze(out);
}

function _parseEnv(key, raw, fallback) {
    const trimmed = String(raw).trim();
    if (!trimmed) return fallback;

    if (BOOL_KEYS.has(key)) {
        return _parseBool(trimmed, fallback);
    }
    if (NUMBER_KEYS.has(key)) {
        const n = Number(trimmed);
        return Number.isFinite(n) ? n : fallback;
    }
    if (NUMBER_ARRAY_KEYS.has(key)) {
        // Accept "lo,hi", "lo:hi", or "[lo,hi]".
        const parts = trimmed
            .replace(/^\[|\]$/g, '')
            .split(/[,:]/)
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isFinite(n));
        return parts.length ? parts : fallback;
    }
    if (STRING_ARRAY_KEYS.has(key)) {
        return trimmed
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
    }
    if (STRING_KEYS.has(key)) {
        return trimmed;
    }
    // Default: pass-through.
    return trimmed;
}

function _parseBool(raw, fallback) {
    const v = raw.toLowerCase();
    if (['1', 'true', 'yes', 'on', 'y'].includes(v)) return true;
    if (['0', 'false', 'no', 'off', 'n'].includes(v)) return false;
    return fallback;
}

/** Test-only: dump the env-name map so a test can assert the canonical list. */
export function _envMap() {
    return { ...ENV_MAP };
}
