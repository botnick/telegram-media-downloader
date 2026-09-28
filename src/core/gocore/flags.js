/**
 * Go-core feature flags.
 *
 * Every Go-backed feature runs in one of four modes:
 *
 *   off     Node only; Go is never called for it.
 *   shadow  Node's result is always the one used. On a sample of calls Go
 *           computes the same thing in the background and the results are
 *           compared (mismatches are counted, never acted on).
 *   on      Go first; any error, timeout or unavailability falls back to
 *           Node.
 *   auto    Like `on`, and on a sample of calls Node re-checks Go's answer
 *           in the background; one mismatch sends the feature back to
 *           shadow for the rest of the process.
 *
 * Sources, first match wins ("env wins"):
 *
 *   1. TGDL_GO_FEATURES="hash=on"         per feature, env
 *   2. TGDL_GO_CORE=off|shadow|on|auto    global, env
 *   3. config.advanced.goCore.features    per feature, dashboard config
 *   4. config.advanced.goCore.mode        global, dashboard config
 *   5. DEFAULT_MODE                       'shadow' in this release
 *
 * The config is injected by the server (`setConfigReader`) so importing
 * this module — which checksum.js does on every hash — never opens the
 * database.
 */

export const FEATURES = Object.freeze(['hash']);
export const MODES = Object.freeze(['off', 'shadow', 'on', 'auto']);
export const DEFAULT_MODE = 'shadow';

const CONFIG_TTL_MS = 5_000;

let _configReader = null;
let _cfgCache = { at: 0, value: null };
const _warned = new Set();

/** Where `config.advanced.goCore` comes from (the server passes loadConfig). */
export function setConfigReader(fn) {
    _configReader = typeof fn === 'function' ? fn : null;
    _cfgCache = { at: 0, value: null };
}

/** Drop the cached config block (called when the config changes). */
export function invalidateConfig() {
    _cfgCache = { at: 0, value: null };
}

export function normalizeMode(v) {
    const s = String(v ?? '')
        .trim()
        .toLowerCase();
    return MODES.includes(s) ? s : null;
}

function _warnOnce(key, msg) {
    if (_warned.has(key)) return;
    _warned.add(key);
    console.warn(`[go-core] ${msg}`);
}

/**
 * Parse per-feature modes: "hash=on", "hash=on,other=off", "hash:shadow",
 * or an object `{ hash: 'on' }`. Unknown features / modes are dropped.
 *
 * @returns {Record<string, string>}
 */
export function parseFeatureModes(raw, source = 'TGDL_GO_FEATURES') {
    const out = {};
    const add = (name, mode) => {
        const f = String(name || '')
            .trim()
            .toLowerCase();
        if (!f) return;
        const m = normalizeMode(mode);
        if (!FEATURES.includes(f)) {
            _warnOnce(`${source}:f:${f}`, `${source}: unknown feature "${f}" ignored`);
            return;
        }
        if (!m) {
            _warnOnce(`${source}:m:${f}:${mode}`, `${source}: invalid mode "${mode}" for ${f}`);
            return;
        }
        out[f] = m;
    };
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw)) add(k, v);
        return out;
    }
    if (typeof raw !== 'string') return out;
    for (const part of raw.split(/[,;\s]+/)) {
        if (!part) continue;
        const idx = part.search(/[=:]/);
        if (idx <= 0) {
            _warnOnce(`${source}:p:${part}`, `${source}: expected feature=mode, got "${part}"`);
            continue;
        }
        add(part.slice(0, idx), part.slice(idx + 1));
    }
    return out;
}

function _config() {
    if (!_configReader) return null;
    const now = Date.now();
    if (_cfgCache.at && now - _cfgCache.at < CONFIG_TTL_MS) return _cfgCache.value;
    let value = null;
    try {
        const v = _configReader();
        value = v && typeof v === 'object' ? v : null;
    } catch {
        value = null;
    }
    _cfgCache = { at: now, value };
    return value;
}

function _envGlobal() {
    const raw = process.env.TGDL_GO_CORE;
    if (raw === undefined || String(raw).trim() === '') return null;
    const m = normalizeMode(raw);
    if (!m) {
        _warnOnce(`env:${raw}`, `TGDL_GO_CORE="${raw}" is not one of ${MODES.join('|')}; ignored`);
    }
    return m;
}

/** The global mode and where it came from. */
export function resolveGlobalMode() {
    const env = _envGlobal();
    if (env) return { mode: env, source: 'env' };
    const cfg = _config();
    const c = normalizeMode(cfg?.mode);
    if (c) return { mode: c, source: 'config' };
    return { mode: DEFAULT_MODE, source: 'default' };
}

/** The mode of one feature and where it came from. */
export function resolveFeatureMode(feature) {
    const envFeatures = parseFeatureModes(process.env.TGDL_GO_FEATURES || '');
    if (envFeatures[feature]) return { mode: envFeatures[feature], source: 'env' };
    const env = _envGlobal();
    if (env) return { mode: env, source: 'env' };
    const cfg = _config();
    const cfgFeatures = parseFeatureModes(cfg?.features, 'advanced.goCore.features');
    if (cfgFeatures[feature]) return { mode: cfgFeatures[feature], source: 'config' };
    const c = normalizeMode(cfg?.mode);
    if (c) return { mode: c, source: 'config' };
    return { mode: DEFAULT_MODE, source: 'default' };
}

/** True when at least one feature wants the Go process running. */
export function anyFeatureEnabled() {
    return FEATURES.some((f) => resolveFeatureMode(f).mode !== 'off');
}

/**
 * Validate a `config.advanced.goCore` patch from the dashboard API.
 * Returns the cleaned block, or null when nothing valid is left.
 */
export function sanitizeConfigBlock(block) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
    const out = {};
    const m = normalizeMode(block.mode);
    if (m) out.mode = m;
    if (block.features && typeof block.features === 'object') {
        const f = parseFeatureModes(block.features, 'advanced.goCore.features');
        if (Object.keys(f).length) out.features = f;
    }
    return Object.keys(out).length ? out : null;
}
