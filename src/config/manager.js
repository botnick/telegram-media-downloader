import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '../../data/config.json');

const DEFAULT_CONFIG = {
    telegram: {
        apiId: '',
        apiHash: ''
    },
    accounts: [],
    pollingInterval: 10,
    groups: [],
    download: {
        path: './data/downloads',
        concurrent: 10,
        retries: 5,
        maxSpeed: 0 // 0 = unlimited
    },
    rateLimits: {
        requestsPerMinute: 60,
        delayMs: { min: 100, max: 300 }
    },
    diskManagement: {
        maxTotalSize: '50GB',
        autoCleanup: false,
        // Auto-rotate: when enabled and total on-disk size exceeds maxTotalSize,
        // the disk-rotator sweeps the oldest unpinned downloads off until the
        // cap is satisfied. Sweep cadence in minutes.
        enabled: false,
        sweepIntervalMin: 10
    },
    // Rescue Mode: per-group "keep only what gets deleted from source" mode.
    // When enabled (globally or per-group), every monitored download is
    // recorded with a pending_until timestamp; if Telegram fires a delete
    // event for the source message inside the window, the file is rescued
    // (kept forever). Otherwise the rescue sweeper auto-deletes the local
    // copy after retentionHours — no point keeping a copy when Telegram
    // still has the original.
    rescue: {
        enabled: false,
        retentionHours: 48,
        sweepIntervalMin: 10
    },
    // Advanced runtime tuning. Every value here mirrors a previously-hardcoded
    // constant in the hot path; consumers MUST read with the inline literal
    // as fallback (config.advanced?.x?.y ?? <existing-default>) so a fresh
    // install — or a config.json that pre-dates this block — behaves
    // bit-identically to the old hardcoded version. Only surface what most
    // operators will plausibly want to tune; do NOT expose security/protocol
    // primitives (scrypt params, spam-guard limits, etc) here.
    advanced: {
        downloader: {
            // Lower bound on worker count. Auto-scaler never goes below this,
            // and FloodWait throttling snaps back to it.
            minConcurrency: 3,
            // Hard ceiling for the auto-scaler. Bigger numbers risk
            // FLOOD_WAIT bans from Telegram.
            maxConcurrency: 20,
            // Auto-scaler tick. Every N seconds it inspects queue depth +
            // active count and adds/removes workers.
            scalerIntervalSec: 5,
            // Idle worker sleep when no job is available. Lower = snappier
            // pickup of new jobs at the cost of a bit more CPU.
            idleSleepMs: 200,
            // History (priority 2) queue length above which new jobs spill
            // to disk instead of growing RAM. Realtime never spills.
            spilloverThreshold: 2000
        },
        history: {
            // Backfill pauses iteration when the downloader queue is above
            // this size — bounds RAM during a 100k-message backfill.
            backpressureCap: 500,
            // If backpressure can't drain inside this window, the backfill
            // aborts so a stuck downloader doesn't hang the command forever.
            backpressureMaxWaitMs: 5 * 60 * 1000,
            // Insert a 2-5s "scrolling pause" every N processed messages.
            // Set to 0 to disable.
            shortBreakEveryN: 100,
            // Insert a 60-120s "coffee break" every N processed messages.
            // Set to 0 to disable. Helps avoid Telegram anti-flood bans.
            longBreakEveryN: 1000
        },
        diskRotator: {
            // Rows fetched per pass when the rotator needs to delete old
            // files to fit the cap.
            sweepBatch: 50,
            // Hard ceiling on deletes per sweep — defends against a
            // misconfigured cap nuking everything in one tick.
            maxDeletesPerSweep: 5000
        },
        integrity: {
            // How often to walk every DB row and prune entries whose file
            // is missing or zero-bytes. Min effective floor: 60.
            intervalMin: 60,
            // stat() concurrency per batch. Bigger = faster on SSDs, more
            // FD pressure on busy systems.
            batchSize: 64
        },
        web: {
            // Dashboard cookie lifetime in days. Existing tokens keep their
            // original expiry; only newly-issued sessions use this value.
            sessionTtlDays: 7
        }
    }
};

const DEFAULT_FILTERS = {
    photos: true,
    videos: true,
    files: true,
    links: true,
    voice: false,
    audio: false,
    gifs: false,
    stickers: false, // Default false for stickers
    urls: true
};

export function loadConfig() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) {
            const dir = path.dirname(CONFIG_PATH);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 4));
            return DEFAULT_CONFIG;
        }
        
        const data = fs.readFileSync(CONFIG_PATH, 'utf8');
        const userConfig = JSON.parse(data);
        
        // Deep Merge to ensure new defaults are present in old configs
        const userAdvanced = userConfig.advanced || {};
        const config = {
            ...DEFAULT_CONFIG,
            ...userConfig, // User values overwrite defaults
            telegram: { ...DEFAULT_CONFIG.telegram, ...userConfig.telegram },
            download: { ...DEFAULT_CONFIG.download, ...userConfig.download },
            rateLimits: { ...DEFAULT_CONFIG.rateLimits, ...userConfig.rateLimits },
            diskManagement: { ...DEFAULT_CONFIG.diskManagement, ...userConfig.diskManagement },
            rescue: { ...DEFAULT_CONFIG.rescue, ...userConfig.rescue },
            // Two-level merge for `advanced`: each sub-namespace (downloader,
            // history, …) gets its own spread so users who only set a single
            // value (e.g. advanced.downloader.maxConcurrency) keep the rest
            // of the defaults instead of erasing them.
            advanced: {
                ...DEFAULT_CONFIG.advanced,
                ...userAdvanced,
                downloader: { ...DEFAULT_CONFIG.advanced.downloader, ...(userAdvanced.downloader || {}) },
                history: { ...DEFAULT_CONFIG.advanced.history, ...(userAdvanced.history || {}) },
                diskRotator: { ...DEFAULT_CONFIG.advanced.diskRotator, ...(userAdvanced.diskRotator || {}) },
                integrity: { ...DEFAULT_CONFIG.advanced.integrity, ...(userAdvanced.integrity || {}) },
                web: { ...DEFAULT_CONFIG.advanced.web, ...(userAdvanced.web || {}) }
            },
            // Heal Groups: Ensure every group has latest filter keys
            groups: (userConfig.groups || []).map(group => ({
                ...group,
                filters: { ...DEFAULT_FILTERS, ...(group.filters || {}) }
            }))
        };

        // Self-Healing: If structure changed (new keys added), save back to disk
        // We compare the keys or string length to decide if update is needed
        const hasMissingKeys = JSON.stringify(userConfig) !== JSON.stringify(config);
        // Better check: If stringified output is different, it means we added something
        // Note: Simple stringify comparison order check is risky, but for adding keys it works.
        // Or we just save it always? No, disk write spam.
        // Lets checks if keys count changed or important keys missing.
        
        // Robust check: Compare loaded 'userConfig' vs 'config' (merged)
        // If 'config' (merged) has keys that 'userConfig' didn't, we should save.
        if (JSON.stringify(config) !== JSON.stringify(userConfig)) {
             // console.log('🔄 Updating config file with new defaults...');
             fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4));
        }

        return config;
    } catch (error) {
        console.error('Config error:', error.message);
        return DEFAULT_CONFIG;
    }
}

export function saveConfig(config) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4));
}

export function addGroup(config, group) {
    const existingIndex = config.groups.findIndex(g => g.id === group.id);
    if (existingIndex >= 0) {
        config.groups[existingIndex] = group;
    } else {
        config.groups.push(group);
    }
    saveConfig(config);
    return config;
}

export function watchConfig(callback) {
    let debounceTimer = null;
    const watcher = fs.watch(CONFIG_PATH, (event, filename) => {
        if (filename && event === 'change') {
            if (debounceTimer) return;
            debounceTimer = setTimeout(() => {
                debounceTimer = null;
                console.log('\x1b[36m%s\x1b[0m', '🔄 Config change detected. Reloading...');
                const newConfig = loadConfig();
                callback(newConfig);
            }, 100);
        }
    });
    // Returns an unsubscriber so callers can release the watcher + pending
    // debounce timer cleanly on shutdown / reconfigure.
    return () => {
        if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
        try { watcher.close(); } catch { /* already closed */ }
    };
}
