import { loadConfig } from '../../config/manager.js';

// In-process cache for the config tree. checkAuth + force-https +
// rate-limit middlewares all call readConfigSafe() on every request —
// during video playback the browser issues many 64 KB range GETs and
// each one would otherwise hit the kv table. The 2-second TTL is short
// enough that toggle changes feel instant while folding per-clip request
// bursts into a single read.
let _configCache = { at: 0, value: null };

export async function readConfigSafe() {
    const now = Date.now();
    if (_configCache.value && now - _configCache.at < 2000) return _configCache.value;
    try {
        const value = loadConfig();
        _configCache = { at: now, value };
        return value;
    } catch {
        _configCache = { at: now, value: {} };
        return {};
    }
}

export function invalidateConfigCache() {
    _configCache = { at: 0, value: null };
}
