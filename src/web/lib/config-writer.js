import { loadConfig, saveConfig } from '../../config/manager.js';
import { invalidateConfigCache } from './config-cache.js';
import { publishConfigChange } from '../../core/cluster/config-sync.js';

// Saves config with SQLITE_BUSY retry backoff, invalidates the cache, and
// replicates per-key diffs to cluster peers.
export async function writeConfigAtomic(config) {
    let prev = null;
    try {
        prev = loadConfig();
    } catch {
        prev = null;
    }
    // Exponential backoff against SQLITE_BUSY — a long-running iterator
    // (.iterate in dedup sweep, integrity walk, clustering) may hold the
    // connection. Backoffs: 50/100/200/400/800ms × 3, capped at ~3 s.
    let lastErr = null;
    const backoffsMs = [50, 100, 200, 400, 800, 800, 800];
    for (let attempt = 0; attempt < backoffsMs.length; attempt++) {
        try {
            saveConfig(config);
            lastErr = null;
            break;
        } catch (e) {
            const msg = String(e?.message || e);
            const busy =
                msg.includes('database connection is busy') ||
                msg.includes('SQLITE_BUSY') ||
                e?.code === 'SQLITE_BUSY';
            if (!busy) throw e;
            lastErr = e;
            await new Promise((r) => setTimeout(r, backoffsMs[attempt]));
        }
    }
    if (lastErr) throw lastErr;
    invalidateConfigCache();
    // Replicate per top-level key. publishConfigChange checks the per-key
    // cluster.replicate.<key> policy and skips the 'local' default.
    // Wrapped in try so a peer-WS hiccup never blocks the local save.
    try {
        const keys = new Set([...Object.keys(config || {}), ...Object.keys(prev || {})]);
        for (const k of keys) {
            if (k === 'cluster') continue; // cluster.replicate map is meta — never propagate
            const before = JSON.stringify(prev?.[k] ?? null);
            const after = JSON.stringify(config?.[k] ?? null);
            if (before !== after) {
                publishConfigChange(k, config[k]);
            }
        }
    } catch {
        /* nothing */
    }
}
