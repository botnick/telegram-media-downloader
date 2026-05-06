import path from 'path';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';
import { kvGet, kvSet } from '../core/db.js';
import { BACKPRESSURE_CAP_DEFAULT } from '../core/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Legacy JSON path retained for the one-shot migration runner only. Once
// migrate_json_state.js renames it to .migrated, this file is never read
// again — kv['config'] is the single source of truth.
const LEGACY_CONFIG_PATH = path.join(__dirname, '../../data/config.json');
const KV_KEY = 'config';

const DEFAULT_CONFIG = {
    telegram: {
        apiId: '',
        apiHash: '',
    },
    accounts: [],
    pollingInterval: 10,
    groups: [],
    download: {
        path: './data/downloads',
        concurrent: 10,
        retries: 5,
        maxSpeed: 0, // 0 = unlimited
    },
    rateLimits: {
        requestsPerMinute: 60,
        delayMs: { min: 100, max: 300 },
    },
    diskManagement: {
        maxTotalSize: '50GB',
        autoCleanup: false,
        // Auto-rotate: when enabled and total on-disk size exceeds maxTotalSize,
        // the disk-rotator sweeps the oldest unpinned downloads off until the
        // cap is satisfied. Sweep cadence in minutes.
        enabled: false,
        sweepIntervalMin: 10,
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
        sweepIntervalMin: 10,
    },
    // Advanced runtime tuning. Every value here mirrors a previously-hardcoded
    // constant in the hot path; consumers MUST read with the inline literal
    // as fallback (config.advanced?.x?.y ?? <existing-default>) so a fresh
    // install — or a config that pre-dates this block — behaves bit-identically
    // to the old hardcoded version. Only surface what most operators will
    // plausibly want to tune; do NOT expose security/protocol primitives
    // (scrypt params, spam-guard limits, etc) here.
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
            spilloverThreshold: 2000,
        },
        history: {
            // Backfill pauses iteration when the downloader queue is above
            // this size — bounds RAM during a 100k-message backfill.
            backpressureCap: BACKPRESSURE_CAP_DEFAULT,
            // If backpressure can't drain inside this window, the backfill
            // aborts so a stuck downloader doesn't hang the command forever.
            backpressureMaxWaitMs: 5 * 60 * 1000,
            // Insert a 2-5s "scrolling pause" every N processed messages.
            // Set to 0 to disable.
            shortBreakEveryN: 100,
            // Insert a 60-120s "coffee break" every N processed messages.
            // Set to 0 to disable. Helps avoid Telegram anti-flood bans.
            longBreakEveryN: 1000,
        },
        diskRotator: {
            // Rows fetched per pass when the rotator needs to delete old
            // files to fit the cap.
            sweepBatch: 50,
            // Hard ceiling on deletes per sweep — defends against a
            // misconfigured cap nuking everything in one tick.
            maxDeletesPerSweep: 5000,
        },
        integrity: {
            // How often to walk every DB row and prune entries whose file
            // is missing or zero-bytes. Min effective floor: 60.
            intervalMin: 60,
            // stat() concurrency per batch. Bigger = faster on SSDs, more
            // FD pressure on busy systems.
            batchSize: 64,
        },
        web: {
            // Dashboard cookie lifetime in days. Existing tokens keep their
            // original expiry; only newly-issued sessions use this value.
            sessionTtlDays: 7,
        },
    },
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
    urls: true,
};

// In-process pub/sub. Replaces the fs.watch + 100ms debounce that the old
// JSON-file backend relied on. Every saveConfig() emits 'change' synchronously
// after the DB row is updated, so any module that subscribed via
// watchConfig(cb) gets the new tree without needing a filesystem signal.
const bus = new EventEmitter();
bus.setMaxListeners(50);

function mergeConfig(userConfig) {
    const userAdvanced = userConfig.advanced || {};
    return {
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
            downloader: {
                ...DEFAULT_CONFIG.advanced.downloader,
                ...(userAdvanced.downloader || {}),
            },
            history: { ...DEFAULT_CONFIG.advanced.history, ...(userAdvanced.history || {}) },
            diskRotator: {
                ...DEFAULT_CONFIG.advanced.diskRotator,
                ...(userAdvanced.diskRotator || {}),
            },
            integrity: {
                ...DEFAULT_CONFIG.advanced.integrity,
                ...(userAdvanced.integrity || {}),
            },
            web: { ...DEFAULT_CONFIG.advanced.web, ...(userAdvanced.web || {}) },
        },
        // Heal Groups: Ensure every group has latest filter keys
        groups: (userConfig.groups || []).map((group) => ({
            ...group,
            filters: { ...DEFAULT_FILTERS, ...(group.filters || {}) },
        })),
    };
}

export function loadConfig() {
    try {
        const stored = kvGet(KV_KEY);

        if (!stored) {
            // Fresh install — seed the row with defaults so subsequent reads
            // are stable and the operator can edit through the dashboard
            // without ever needing a config file on disk.
            kvSet(KV_KEY, DEFAULT_CONFIG);
            return DEFAULT_CONFIG;
        }

        const config = mergeConfig(stored);

        // Self-Healing: if merge surfaced new defaults (e.g. a release added
        // a new advanced.* sub-section), persist the merged tree so future
        // reads skip the merge cost and the dashboard sees the up-to-date
        // shape. JSON-string compare is good enough for this — only fires
        // when keys / values genuinely differ.
        if (JSON.stringify(config) !== JSON.stringify(stored)) {
            kvSet(KV_KEY, config);
        }

        return config;
    } catch (error) {
        console.error('Config error:', error.message);
        return DEFAULT_CONFIG;
    }
}

export function saveConfig(config) {
    // SQLite transactions give us the same atomicity the old tmp+rename
    // pattern provided: a writer crash mid-statement rolls back, no reader
    // ever sees a half-written row.
    kvSet(KV_KEY, config);
    // Notify in-process subscribers (monitor, runtime, etc). Errors in
    // listeners must not break the save itself.
    try {
        bus.emit('change', config);
    } catch (e) {
        console.error('config change listener error:', e.message);
    }
}

export function addGroup(config, group) {
    const existingIndex = config.groups.findIndex((g) => g.id === group.id);
    if (existingIndex >= 0) {
        config.groups[existingIndex] = group;
    } else {
        config.groups.push(group);
    }
    saveConfig(config);
    return config;
}

export function watchConfig(callback) {
    // EventEmitter-based watcher. Subscribers run inside the same process —
    // saveConfig() emits synchronously after the DB row is updated, so
    // callbacks see the freshly-merged tree without any debounce window.
    const handler = (newConfig) => {
        try {
            callback(newConfig);
        } catch (e) {
            console.error('watchConfig listener error:', e.message);
        }
    };
    bus.on('change', handler);
    return () => bus.off('change', handler);
}

// Test-only helper: lets tests reset the in-process bus between runs so
// listeners from a previous spec don't fire on the next.
export function _resetConfigBus() {
    bus.removeAllListeners();
}

// Exposed for the migration runner so it can detect whether the legacy
// JSON file is still around without duplicating the path constant.
export const _LEGACY_CONFIG_PATH = LEGACY_CONFIG_PATH;
export const _CONFIG_KV_KEY = KV_KEY;
