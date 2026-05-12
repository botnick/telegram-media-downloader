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
        // Seekbar thumbnail preview subsystem (v2.17). Generates a WebP
        // sprite sheet + JSON sidecar per video so the player can paint
        // a hover-preview thumbnail above the scrub line. The subsystem
        // is always-on (the Go sidecar auto-downloads on first boot,
        // matching the AI Face clustering UX) — these knobs are
        // implementation tuning, not user-facing toggles.
        seekbar: {
            enabled: true,
            autoOnDownload: true,
            // Target seconds between sample frames. 4 s is the sweet
            // spot for hover scrubbing — denser than the 5 s industry
            // baseline (JW Player / Plyr) without bloating the sprite
            // for clips under ~15 min. The generator nudges this so the
            // last sample lands on the clip's final second.
            intervalSec: 4,
            // Sprite tile width in pixels (-2 keeps aspect ratio).
            // 160 px = JW Player / Plyr default; readable on desktop,
            // crisp on retina without doubling the sprite size.
            tileWidth: 160,
            // Sprite layout: N columns × ceil(frames/N) rows.
            columns: 10,
            // Hard cap on tile count per clip. 240 = 16 min at 4 s.
            // Beyond this the interval stretches automatically so the
            // sprite stays bounded on hour-long clips.
            maxTiles: 240,
            // 'webp' (default, ~30 % smaller) or 'jpeg' (fallback for
            // ffmpeg builds without libwebp).
            format: 'webp',
            // 1..100 — libwebp / libjpeg quality knob. 75 trades ~5 %
            // bytes vs 70 for visibly sharper text / faces in tiles,
            // matching the quality preset most reference players ship.
            quality: 75,
            // Generator concurrency. 4 fits modern 4-8-core hosts
            // without starving the realtime download path; the Go
            // sidecar's worker pool scales linearly up to this value.
            concurrency: 4,
            // Per-clip retry count on transient ffmpeg failures (locked
            // moov, broken container, …). Persistent failures land in
            // the scan-runner errored counter.
            maxRetries: 3,
            // Override `advanced.thumbs.hwaccel` for seekbar specifically.
            // null = inherit. Allowed values: same as thumbs.hwaccel
            // ('', 'vaapi', 'qsv', 'cuda', 'videotoolbox', 'd3d11va', 'dxva2').
            hwaccel: null,
        },
        // AI subsystem (semantic search + auto-tag + face clustering).
        // Master switch defaults OFF so existing installs are unaffected.
        // Search (embeddings) + Auto-tag were removed in this release;
        // `faceClustering` is the only remaining capability flag. The
        // old `semanticSearch` / `autoTags` keys are tolerated by the
        // schema-merge code (loadConfig drops unknown keys silently)
        // so an upgrade from v2.15 doesn't fail boot.
        //
        // Faces-specific tunables now live under `.advanced.ai.faces.*` —
        // see the `faces` block below. Old flat keys (`facesServiceUrl`,
        // `facesModel`, `facesEpsilon`, `facesMinPoints`, `facesDetector`,
        // `facesLabelMatchEps`, `federateFaces`) are migrated in-place on
        // first read and kept as read-only aliases so existing operator
        // configs continue to work without surprise resets.
        ai: {
            enabled: false,
            faceClustering: true,
            imageTagging: true,
            // Face detector backend override (HF model id). Default empty
            // → bundled `@vladmandic/face-api` weights are used. Sticking
            // with the bundle is the recommended path; the override exists
            // only for operators experimenting with a custom face model.
            facesModel: '',
            // HTTP URL of the Python face sidecar. Empty string = use the
            // auto-spawned local sidecar (Track C handles spawn). Docker
            // compose installs override this with FACES_SERVICE_URL env so
            // they talk to the bundled tgdl-faces container directly.
            facesServiceUrl: '',
            // Per-batch tuning. `batchSize` caps the rows pulled per scan
            // tick. Higher = fewer WS broadcasts, lower = smoother UI.
            batchSize: 16,
            indexConcurrency: 1,
            fileTypes: ['photo'],
            // Face clustering. eps=0.5 matches face-api's "definitely the
            // same person" guidance for FaceNet 128-dim. minPts=3 keeps
            // single-shot strangers out of the People grid.
            // ArcFace 512-dim L2-normalised embeddings cluster at L2 ≈
            // 0.3-1.0 for same-person, 1.0-1.4 for different-person.
            // Calibrated against a real 926-photo / 689-face sample
            // (scripts/calibrate-faces-eps.js --all):
            //   ε=0.90 → 64 clusters (top 53,35,28,26,25) — tight
            //   ε=1.00 → 78 clusters (top 60,40,33,27,25) — solid
            //   ε=1.05 → 80 clusters (top 60,42,35,32,27) — PEAK
            //   ε=1.10 → 79 clusters (top 89 — starting to merge)
            //   ε=1.15 → 45 clusters (top 449 — mega-merge starts ⚠)
            //   ε=1.20 → 7 clusters (top 641 — collapsed)
            // ε=1.05 is the production sweet spot: maximum distinct
            // people surfaced with minimal false-merge risk.
            facesEpsilon: 1.05,
            facesMinPoints: 2,
            // Face detector backend (within face-api). Default 'tiny' is
            // ~190 KB and very fast but misses small/angled faces.
            // 'ssd' is SSD MobileNet V1 — ~5.4 MB, slower per image, but
            // catches faces 'tiny' would miss (small heads, profile
            // views, partial occlusion). Switch the moment you see
            // missed-face complaints.
            facesDetector: 'tiny',
            // Legacy zero-shot label set. Search/Tags were removed; the
            // list is kept as a frozen constant so older code paths that
            // happen to `loadConfig().advanced.ai.tagLabels?.length` don't
            // crash. Nothing reads it for inference any more.
            tagLabels: [
                // People + relationships (8)
                'portrait',
                'selfie',
                'group_photo',
                'family',
                'friends',
                'wedding',
                'baby',
                'children',

                // Scenes — indoor (8)
                'indoor',
                'home',
                'kitchen',
                'bedroom',
                'living_room',
                'office',
                'restaurant',
                'cafe',

                // Scenes — outdoor (16)
                'outdoor',
                'nature',
                'beach',
                'ocean',
                'mountain',
                'forest',
                'desert',
                'park',
                'city',
                'street',
                'countryside',
                'garden',
                'lake',
                'river',
                'waterfall',
                'cave',

                // Weather + sky (10)
                'sunny',
                'cloudy',
                'rainy',
                'snowy',
                'foggy',
                'sunset',
                'sunrise',
                'night',
                'storm',
                'rainbow',

                // Time of day (4)
                'daytime',
                'evening',
                'golden_hour',
                'blue_hour',

                // Seasons (4)
                'spring',
                'summer',
                'autumn',
                'winter',

                // Activities (16)
                'hiking',
                'camping',
                'swimming',
                'surfing',
                'skiing',
                'cycling',
                'running',
                'yoga',
                'cooking',
                'eating',
                'dancing',
                'reading',
                'shopping',
                'concert',
                'travel',
                'party',

                // Sports (8)
                'sports',
                'football',
                'basketball',
                'tennis',
                'golf',
                'baseball',
                'volleyball',
                'fitness',

                // Animals (14)
                'animal',
                'pet',
                'dog',
                'cat',
                'bird',
                'horse',
                'fish',
                'wildlife',
                'farm_animal',
                'reptile',
                'insect',
                'butterfly',
                'aquatic_animal',
                'mammal',

                // Plants + food (16)
                'flower',
                'tree',
                'plant',
                'leaves',
                'food',
                'drink',
                'fruit',
                'vegetable',
                'dessert',
                'breakfast',
                'lunch',
                'dinner',
                'coffee',
                'wine',
                'beer',
                'cocktail',

                // Vehicles + transport (10)
                'vehicle',
                'car',
                'motorcycle',
                'bicycle',
                'truck',
                'bus',
                'boat',
                'airplane',
                'train',
                'helicopter',

                // Buildings + architecture (10)
                'building',
                'house',
                'apartment',
                'skyscraper',
                'church',
                'temple',
                'castle',
                'monument',
                'bridge',
                'ruins',

                // Documents + screens (10)
                'document',
                'screenshot',
                'receipt',
                'ticket',
                'business_card',
                'invoice',
                'menu',
                'chart',
                'graph',
                'whiteboard',

                // Art + creative (10)
                'art',
                'painting',
                'drawing',
                'sketch',
                'sculpture',
                'graffiti',
                'tattoo',
                'craft',
                'design',
                'photography',

                // Objects (16)
                'logo',
                'text',
                'sign',
                'product_shot',
                'closeup',
                'toy',
                'electronics',
                'phone',
                'computer',
                'camera',
                'book',
                'clothing',
                'shoes',
                'accessories',
                'jewelry',
                'tools',

                // Vibes / aesthetic (12)
                'vintage',
                'minimalist',
                'colorful',
                'monochrome',
                'aerial',
                'macro',
                'panorama',
                'silhouette',
                'reflection',
                'bokeh',
                'fireworks',
                'underwater',

                // Memes + misc (8)
                'meme',
                'cute',
                'funny',
                'aesthetic',
                'abstract',
                'pattern',
                'event',
                'celebration',
            ],
            // hfToken removed with Search/Tags. Kept as empty string so
            // older clients that pre-fill the field don't crash on save.
            hfToken: '',
            // Cross-peer face label propagation. When
            // enabled, renaming a cluster on this peer pushes the
            // averaged centroid (not raw embeddings) to paired peers
            // so they can match + auto-label the same person locally.
            // Opt-in only — face centroids are biometric data.
            federateFaces: false,
            // Background auto-scan — drip-feeds un-indexed photos into
            // the AI queue so a library built before AI was enabled
            // gets covered automatically. Three-state machine:
            //   'idle'    — off (default; nothing happens)
            //   'running' — drip ~10 photos every ~60 s into the
            //               backfill queue; pauses internally when
            //               realtime queue is busy so live downloads
            //               always win
            //   'paused'  — drip suspended; resumes from the same
            //               un-indexed cursor when flipped back to
            //               'running' (no progress lost)
            //
            // Per-batch tunables: drip cadence + size below.
            autoScan: 'idle',
            autoScanIntervalMs: 60_000, // drip cadence (1 minute default)
            autoScanBatchSize: 10, // photos per drip tick
            autoScanQueueCeiling: 50, // pause-internally when backfill queue ≥ this
            // Faces sidecar configuration — separated from the master `ai`
            // flags so operators can tune the sidecar without touching the
            // capability flags. Every value here mirrors a constant that
            // used to be hardcoded in `faces-spawn.js` / `faces-client.js`
            // / `insight.py`; defaults exactly reproduce today's behaviour
            // so an upgrade is bit-identical. Each knob also has a
            // matching `TGDL_FACES_<UPPER_SNAKE>` env override (see
            // docs/AI.md) so Docker / systemd deployments don't need to
            // mount a config file.
            faces: {
                // ===== Backend selection =====
                // 'sidecar' = HTTP to the Python sidecar (default).
                // 'disabled' = skip the whole spawn path; faces stay off
                //   regardless of `faceClustering`. Useful for embedded
                //   deployments that can't afford the 700 MB image / 80 MB
                //   PyInstaller binary footprint.
                backend: 'sidecar',
                // Operator override for the sidecar URL. Empty string
                // falls back to compose env (`FACES_SERVICE_URL`) or local
                // auto-spawn — alias of the legacy `facesServiceUrl` key.
                sidecarUrl: '',
                // When false, the spawn module refuses to auto-download
                // the PyInstaller binary; operators must drop the binary
                // at `data/faces-service/bin/` themselves. Required for
                // air-gapped / corporate-proxy installs.
                autoDownload: true,

                // ===== Detection thresholds (forwarded to sidecar) =====
                // Detector score floor (0..1). Lower = more recall, more
                // false positives.
                minDetectionScore: 0.5,
                // Reject boxes whose smaller edge is below this many pixels.
                minFaceSizePx: 80,
                // Aspect-ratio window for valid face boxes.
                arRange: [0.5, 2.0],
                // Sidecar input size — bigger = better recall on small
                // faces, slower per image. 480 is the Pi 4 sweet spot.
                detSize: 640,
                // buffalo_l native embedding dim. Informational only — the
                // sidecar enforces this on its end.
                embedDim: 512,

                // ===== Detector model =====
                // Future-proof — currently only buffalo_l is shipped by
                // the sidecar. Reserved so a future release can ship
                // buffalo_s / antelopev2 / etc. without a config break.
                detectorModel: 'buffalo_l',
                // ONNX Runtime provider selection. 'auto' lets the sidecar
                // pick the fastest available (CUDA → CoreML → DirectML →
                // OpenVINO → CPU). Explicit options: 'cpu', 'cuda',
                // 'coreml', 'directml'.
                providers: 'auto',

                // ===== Clustering (Node-side, calibrated for ArcFace) =====
                // Calibrated against 926-photo / 689-face real data:
                //   ε=1.00 → 78 clusters   (top 60,40,33,27,25)
                //   ε=1.05 → 80 clusters   ← PEAK, default
                //   ε=1.10 → 79 (top 89 starting to merge)
                //   ε=1.15 → 45 (top 449 — mega-merge danger ⚠)
                //   ε=1.20 → 7  (top 641 — collapsed)
                epsilon: 1.05,
                // Smallest cluster surfaced as a person. minPts=2 keeps
                // even rarely-seen people visible; bump to 3+ if the
                // grid feels noisy on a large library.
                minPoints: 2,
                // Label preservation across re-cluster. `null` derives a
                // sensible default from `epsilon` (eps * 0.9 clamped to
                // [0.2, 0.6]). Set explicitly to override.
                labelMatchEps: null,
                // Legacy detector hint (face-api remnant). Kept so old
                // configs don't lose values silently; sidecar ignores it.
                detector: 'tiny',

                // ===== Scan-runner =====
                // Rows per phase-A batch.
                batchSize: 16,
                // Which `downloads.file_type` rows the scan considers.
                fileTypes: ['photo'],

                // ===== Performance =====
                // Node-side gate on inflight detect calls. 0 = unlimited
                // (only the sidecar's own concurrency caps it). Set to 2
                // on Pi 4 / shared NAS to avoid swap thrash.
                sidecarMaxConcurrency: 0,
                // /health probe response cache (ms). The AI maintenance
                // page polls this aggressively; caching avoids hammering
                // the sidecar during a busy scan.
                healthCacheTtlMs: 5000,
                // Per-request hard timeout (ms). Bumps for slow CPUs /
                // first-call model load on Pi.
                requestTimeoutMs: 15000,
                // POST retry count on 5xx / network errors.
                maxRetries: 3,
                // Linear backoff between retry attempts (ms).
                retryBackoffMs: [300, 600, 1200],

                // ===== Spawn lifecycle =====
                // Random localhost port range. Pick something outside the
                // common dev-server range (3000..9999) so a busy dev box
                // doesn't collide.
                portRange: [41000, 49999],
                // How many random picks before giving up on free-port
                // discovery.
                portProbeAttempts: 10,
                // /health probe ceiling on cold boot (ms). buffalo_l takes
                // 5-10 s to load on a Pi.
                firstBootHealthTimeoutMs: 60000,
                // /health probe ceiling on respawn (ms). Model is already
                // cached on disk so cold-start cost is smaller.
                respawnHealthTimeoutMs: 30000,
                // Background health check cadence (ms).
                healthMonitorIntervalMs: 60000,
                // Consecutive failed health probes before the spawn module
                // kills + respawns the child.
                healthFailuresBeforeRelaunch: 3,
                // Redirect cap during binary download. GitHub bounces to a
                // CDN; some corporate proxies bounce twice more.
                downloadRedirectCap: 5,
                // Alternative tarball URLs the operator can list (corporate
                // proxy, internal mirror). First match wins; falls through
                // to the canonical GitHub release URL.
                downloadMirrors: [],

                // ===== Federation =====
                // Cross-peer face label propagation. When enabled, renaming
                // a cluster on this peer pushes the averaged centroid (not
                // raw embeddings) to paired peers. Opt-in — face centroids
                // are biometric data. Alias of the legacy `federateFaces`
                // flat key.
                federate: false,
            },
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
            // Spread `ai` so the operator's saved tagLabels, hfToken, etc.
            // win over the defaults but missing keys (added in a later
            // release) still pick up their default value.
            ai: _mergeAi(userAdvanced.ai),
        },
        // Heal Groups: Ensure every group has latest filter keys, and drop
        // duplicate entries that share the same Telegram id. Dupes can sneak
        // in when a group is renamed in Telegram and re-added through a
        // different code path (CLI add + dashboard add, or sanitised vs raw
        // name); the second copy used to silently shadow the first and
        // double every monitor pass.
        groups: dedupeGroups(userConfig.groups || []).map((group) => ({
            ...group,
            filters: { ...DEFAULT_FILTERS, ...(group.filters || {}) },
        })),
    };
}

/**
 * Merge user-supplied `advanced.ai` over the defaults, with two extra concerns
 * compared to the other sub-block merges:
 *
 *  1. The `faces` sub-block needs its own spread so missing keys (added in
 *     later releases) pick up their defaults without erasing operator-set
 *     values.
 *
 *  2. Legacy flat keys (`facesServiceUrl`, `facesEpsilon`, `facesMinPoints`,
 *     `facesDetector`, `facesLabelMatchEps`, `federateFaces`, `batchSize`,
 *     `fileTypes`) are migrated into `faces.*` on read. The flat keys are
 *     preserved as read-only aliases for backwards compatibility — code that
 *     still reads `cfg.facesEpsilon` continues to work, but the canonical
 *     location going forward is `cfg.faces.epsilon`. Operator-set `faces.*`
 *     values always win over the flat aliases (so an explicit override
 *     through the new path is never clobbered by a stale legacy value).
 */
function _mergeAi(userAi) {
    const user = userAi || {};
    const defaults = DEFAULT_CONFIG.advanced.ai;
    const userFaces = user.faces || {};

    // Build the faces sub-block. Precedence: explicit `faces.*` value > legacy
    // flat alias > default.
    const mergedFaces = {
        ...defaults.faces,
        ...userFaces,
    };

    // Migrate legacy flat keys ONLY when the operator hasn't explicitly set
    // the new path. Probing `userFaces` (not `mergedFaces`) so a previously-
    // migrated value doesn't shadow a later operator override.
    if (!('sidecarUrl' in userFaces) && typeof user.facesServiceUrl === 'string') {
        mergedFaces.sidecarUrl = user.facesServiceUrl;
    }
    if (!('epsilon' in userFaces) && Number.isFinite(user.facesEpsilon)) {
        mergedFaces.epsilon = user.facesEpsilon;
    }
    if (!('minPoints' in userFaces) && Number.isFinite(user.facesMinPoints)) {
        mergedFaces.minPoints = user.facesMinPoints;
    }
    if (!('detector' in userFaces) && typeof user.facesDetector === 'string') {
        mergedFaces.detector = user.facesDetector;
    }
    if (!('detectorModel' in userFaces) && typeof user.facesDetectorModel === 'string') {
        mergedFaces.detectorModel = user.facesDetectorModel;
    }
    if (!('labelMatchEps' in userFaces) && user.facesLabelMatchEps !== undefined) {
        mergedFaces.labelMatchEps = user.facesLabelMatchEps;
    }
    if (!('federate' in userFaces) && typeof user.federateFaces === 'boolean') {
        mergedFaces.federate = user.federateFaces;
    }
    if (!('batchSize' in userFaces) && Number.isFinite(user.batchSize)) {
        mergedFaces.batchSize = user.batchSize;
    }
    if (!('fileTypes' in userFaces) && Array.isArray(user.fileTypes)) {
        mergedFaces.fileTypes = user.fileTypes.slice();
    }

    // Keep the legacy flat keys in sync with the resolved faces.* values so
    // existing readers (server.js, scan-runner, faces.js, downloader.js)
    // continue to work without a coordinated rewrite. New code should read
    // from `faces.*` and treat the flat keys as deprecated aliases.
    const merged = {
        ...defaults,
        ...user,
        faces: mergedFaces,
        facesServiceUrl: mergedFaces.sidecarUrl,
        facesEpsilon: mergedFaces.epsilon,
        facesMinPoints: mergedFaces.minPoints,
        facesDetector: mergedFaces.detector,
        facesDetectorModel: mergedFaces.detectorModel,
        facesLabelMatchEps: mergedFaces.labelMatchEps,
        federateFaces: mergedFaces.federate,
    };
    // `batchSize` / `fileTypes` already lived at the flat-`ai` layer, so the
    // user spread above keeps them; only sync from faces.* if the operator
    // explicitly set the new path AND not the old one (avoids a surprise
    // change for installs upgrading from v2.15).
    if ('batchSize' in userFaces && !('batchSize' in user)) {
        merged.batchSize = mergedFaces.batchSize;
    }
    if ('fileTypes' in userFaces && !('fileTypes' in user)) {
        merged.fileTypes = mergedFaces.fileTypes;
    }
    return merged;
}

function dedupeGroups(groups) {
    const seen = new Map();
    for (const g of groups) {
        const key = String(g?.id ?? '');
        if (!key) continue;
        // Last-writer-wins on id collision: a fresh entry overrides an old
        // one with the same id. Preserves order of first appearance so the
        // sidebar layout stays stable across reloads.
        const prev = seen.get(key);
        if (prev) seen.set(key, { ...prev, ...g });
        else seen.set(key, g);
    }
    return Array.from(seen.values());
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

/**
 * Read-only snapshot of DEFAULT_CONFIG. Returned as a deep clone so a
 * caller can't accidentally mutate the module-internal source of truth.
 * Used by `/api/ai/presets` to pull the canonical tag-label baseline
 * even when the operator has edited their persisted list.
 */
export function getDefaultConfig() {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}
