# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.3.39] — 2026-04-30

### Fixed — iOS double-tap zoom
- `body { touch-action: manipulation }` disables the double-tap-to-zoom gesture across the whole app. The HTML viewport's `user-scalable=no` is intentionally ignored on iOS 10+, so `touch-action` is the only reliable way to silence it. Pinch-zoom is preserved; per-element overrides (`#image-container`, `.lasso-active`) keep their custom touch handling.

### SW
- VERSION bumped `'v38'` → `'v39'`.

## [2.3.38] — 2026-04-30

### Added — Gallery picker: mobile gestures
- **Touch long-press** → enter select-mode + toggle (with `navigator.vibrate(10)` haptic when supported).
- **Drag after long-press** → continue selecting (Android Material pattern). Each tile the finger crosses is added once.
- **Two-finger drag** → lasso (iOS Photos pattern). One-finger drag is reserved for page scroll.
- Pinch-to-zoom cancels the in-progress long-press cleanly so it never trips a select.
- Long-press logic consolidated into `gallery-select.js`; the duplicate handler in `setupGalleryGestures` is gone.

### Docs
- README updated with the new touch gesture matrix.

### SW
- VERSION bumped `'v37'` → `'v38'`.

## [2.3.37] — 2026-04-30

### Docs
- README, `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/DEPLOY.md`, `docs/TROUBLESHOOTING.md` brought current with the v2.3.x feature set: guest role, share-links, dedup, thumbnails, NSFW review tool, auto-update, smart-resume backfill, gallery gestures, view-mode picker.
- New WebSocket event matrix in `docs/API.md`.
- New SPA + backend module index in `docs/ARCHITECTURE.md`.
- New auto-update + ffmpeg + thumbnail concurrency env vars documented in `docs/DEPLOY.md`.

### SW
- VERSION bumped `'v36'` → `'v37'`.

## [2.3.36] — 2026-04-30

### Added — Gallery picker: desktop-grade gestures
- **Drag-to-select (lasso)** — rubber-band rectangle selects every overlapping tile.
- **Ctrl / Cmd + click** — toggle one tile, auto-enables select mode.
- **Shift + click** — range-select from the last anchor to here.
- **Ctrl / Cmd + A** — select all visible tiles.
- **Esc** — exit select mode + clear.
- **Delete / Backspace** — bulk-delete the current selection.
- All updates are in-place — toggling `.is-selected` on the matching tile, no full grid re-render. Lasso stays smooth on 1000-tile galleries.
- Long-press on touch (existing) still works.

### SW
- VERSION bumped `'v35'` → `'v36'`.

## [2.3.35] — 2026-04-30

### Changed — View modes: polished List + dropdown picker
- **List mode** redesigned — proper grid columns (thumb · name+group · size · date · open), hover row highlight, divider between rows, responsive (collapses to thumb+name+open on mobile).
- **Dropdown picker** replaces the cycle button — Grid / Compact / List shown together with active checkmark. No more clicking through to find the mode you want.
- Tile markup unified across modes; switching is pure CSS (instant, no re-render, no scroll drift).

### SW
- VERSION bumped `'v34'` → `'v35'`.

## [2.3.34] — 2026-04-30

### Changed — Backfill: smart resume + auto-spawn
- **Smart resume** — `iterMessages` now uses `maxId: minMessageId - 1` (or `minId: maxMessageId + 1` for catch-up) instead of walking every message from newest. Resuming a partially-completed backfill is ~80-90% faster.
- **Per-group lock** — second click on Backfill while one is running returns 409 with `code: 'ALREADY_RUNNING'` instead of spawning a duplicate iterator.
- **Auto-backfill on first add** — enabling a brand-new group with zero rows in `downloads` triggers a background backfill of the last N messages (default 100, configurable, 0 = disabled).
- **Auto catch-up after restart** — monitor's boot-time top-message check now spawns a `catch-up` backfill if the gap to the last stored row exceeds the configured threshold.
- **3 new history modes** surfaced in WS payloads + UI: `pull-older` / `catch-up` / `rescan`.

### Added — Auto-NSFW on download (if enabled)
- Every successful download fires `pregenerateNsfw(id)` alongside `pregenerateThumb(id)` — newly-arrived photos get classified in the background, no need to wait for the next batch scan. No-op when `advanced.nsfw.enabled` is false.

### Config (no hardcode)
- New `advanced.history.{ autoFirstBackfill, autoFirstLimit, autoCatchUp, autoCatchUpThreshold, batchInsertSize, batchInsertMaxAgeMs }`. All clamped server-side; defaults preserve current behavior.
- New Settings → Advanced rows for the auto-backfill knobs.

### SW
- VERSION bumped `'v33'` → `'v34'`.

## [2.3.33] — 2026-04-30

### Added — NSFW review tool (Phase 1: photos)
- Maintenance → "Scan images for NSFW (18+)" — classifies every photo locally via `@huggingface/transformers` (WASM, runs on Win / macOS / glibc-Linux / Alpine / ARM identically).
- Surfaces photos the classifier scored as **NOT 18+** (deletion candidates for a curated 18+ library) in a paginated review sheet — tick + bulk delete with confirm.
- Per-row "Mark as 18+" whitelists genuine 18+ false-negatives so future scans skip them.
- Background scan with WS progress + browser notification on completion. Cancel any time.
- Opt-in via Settings → Advanced → NSFW review tool. Threshold + concurrency + model id all config-driven (no hardcoded values). Model downloads once to `data/models/`.
- Config namespace: `advanced.nsfw.{ enabled, model, threshold, concurrency, batchSize, fileTypes, cacheDir }`.
- DB columns added (idempotent migration): `nsfw_score`, `nsfw_checked_at`, `nsfw_whitelist`. Indexes for unscanned-row scan and review-sort queries.

### SW
- VERSION bumped `'v32'` → `'v33'`.

## [2.3.32] — 2026-04-30

### Changed — Media gallery: smooth on big libraries
- Infinite-scroll page-2+ loads now append only the new tiles (`insertAdjacentHTML`) instead of re-rendering the whole grid. O(N_new) per scroll page, not O(N_total).
- WS `file_deleted` removes the single matching tile from the DOM in place — no full re-render.
- Click handling switched to event delegation; per-tile listeners gone.
- Search uses AbortController + sequence tag — fast typing cancels in-flight requests, no out-of-order race. Debounce 250 ms → 200 ms.

### SW
- VERSION bumped `'v31'` → `'v32'`.

## [2.3.31] — 2026-04-30

### Changed — Queue page: gradual load + in-place progress patches
- Append-only rendering: 50 rows on first paint, 50 more appended via IntersectionObserver as you scroll.
- Live progress events patch the matching row in place — no full re-render per WS tick.
- Search input debounced 120 ms; filter / sort / search reset scroll to top.
- Replaces the prior absolute-positioning virtualiser; smoother on large queues.

### Removed — Live downloads list from the Engine card
- The per-row live list duplicated the Queue page; replaced with a "View full queue" link.
- Engine card now focuses on monitor lifecycle + headline counters.

### SW
- VERSION bumped `'v30'` → `'v31'`.

## [2.3.30] — 2026-04-30

### Added — One-click in-dashboard auto-update (Docker)

A new **Install update** button in Settings → Maintenance (and on the status-bar update pill) pulls the latest container image and recreates the running container in place — same effect as `docker compose pull && docker compose up -d` but triggered from the UI. The data volume, config, and Telegram sessions are preserved verbatim; the SQLite database is snapshotted to `data/backups/` before the swap.

#### Security model — dashboard never touches `/var/run/docker.sock`

The web process intentionally does not get the Docker socket. Instead, the swap is performed by an opt-in `containrrr/watchtower:1.7.1` sidecar that:

- Has a **read-only** mount of `/var/run/docker.sock`.
- Runs with `WATCHTOWER_LABEL_ENABLE=true`, scoping operations to ONLY the container carrying the `com.centurylinklabs.watchtower.enable=true` label (added to `telegram-downloader` in `docker-compose.yml`). Even if compromised, watchtower cannot touch unrelated apps on the same host.
- Exposes its HTTP API behind a bearer token (`WATCHTOWER_HTTP_API_TOKEN`) that lives in `.env` and never enters `config.json`.

A hypothetical RCE in the dashboard cannot escalate to host root because the dashboard never sees the socket — it can only POST to watchtower's `/v1/update`, which is bounded to "pull and recreate the labeled container".

#### Data preservation

- The downloads volume (`./data:/app/data`) is bind-mounted; container recreation never touches it.
- `data/config.json`, `data/web-sessions.json`, `data/sessions/*.enc`, and `data/db.sqlite` all live under that mount.
- Before triggering watchtower the server runs `PRAGMA wal_checkpoint(TRUNCATE)` and copies the DB to `data/backups/db-pre-update-<utc-stamp>.sqlite` (most-recent 5 snapshots kept).
- Schema migrations (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN`) in `core/db.js` are idempotent and forward-compatible — older databases are upgraded transparently on first boot of the new image.

#### Setup (opt-in)

Existing installs continue to work unchanged. To enable the button:

1. Generate a token: `openssl rand -hex 32`.
2. Put it in `.env` next to `docker-compose.yml`:

   ```
   WATCHTOWER_HTTP_API_TOKEN=<hex>
   ```

3. Boot with the new profile:

   ```
   docker compose --profile auto-update up -d
   ```

Without the token (or without the profile) the dashboard renders an explanatory tooltip and falls back to linking the GitHub release page.

#### UI

- **Status-bar update pill** — clicking it now opens a chooser sheet with two actions: **Install vX.Y.Z** (one-click swap) and **View release notes** (GitHub).
- **Settings → Maintenance → Install update** — same chooser, plus a status line showing whether auto-update is ready, requires the profile, or is in standalone mode.
- **Full-screen "Updating…" overlay** appears the moment the swap is initiated, so the operator knows the imminent disconnect is intentional.
- **Auto-reconnect + auto-reload** — the SPA's existing WS reconnect logic re-establishes the connection once the new container's healthcheck passes; a version-change check then reloads the page so the new SPA bundle is live.

#### New endpoints

- `GET /api/update/status` — capability probe (`{ available, inDocker, watchtowerConfigured }`). Drives the disabled/help states in the UI.
- `POST /api/update` (admin-only) — snapshots the DB, calls watchtower, broadcasts `update_started` over WS, returns 200 with the snapshot path. Returns 503 with `code: 'AUTO_UPDATE_UNAVAILABLE'` and an actionable message when the sidecar isn't reachable.

#### Files

- `src/core/updater.js` — capability probe + DB snapshot + watchtower client.
- `docker-compose.yml` — opt-in `watchtower` service under the `auto-update` profile, with the label allowlist + HTTP API enabled.
- `.env.example` — new file documenting `WATCHTOWER_HTTP_API_TOKEN` (gitignored via existing `.env*` rule).

### SW
- VERSION bumped `'v29'` → `'v30'`.

## [2.3.29] — 2026-04-30

### Added — Server-side WebP thumbnails for the gallery

The gallery used to load full-size source files into every grid tile (or skip the preview entirely on mobile video). It now serves compact, server-generated WebP thumbnails — far smaller transfers, no decoder pressure on the client, and previews work consistently across image, video, and audio-with-cover-art on every viewport.

- **`src/core/thumbs.js`** — single helper exposing `getOrCreateThumb(id, w)`.
  - Image source → sharp resize → WebP (quality 70, effort 6). Honors EXIF orientation.
  - Video source → ffmpeg seeks 1 s in, scales + encodes to WebP in a **single pass** (no intermediate JPEG → sharp transcode), reading nothing past the first keyframe. ~10× faster than grab-then-resize.
  - Audio source → extracts the embedded cover-art (`attached_pic` stream) when present.
  - Cache lives at `data/thumbs/<sha-of-id+w>.webp`. Atomic publish via `.tmp → final` rename — a crash mid-write never produces a poisoned cache hit.
- **`GET /api/thumbs/:id?w=240`** (auth-gated, allowed for guest sessions) — cache-first, sends `Cache-Control: public, max-age=86400, immutable` + `Last-Modified` so the browser HTTP cache absorbs subsequent grid scrolls. Width snaps to `[120, 200, 240, 320, 480]` so a hostile caller can't fork a generation per pixel.
- **Concurrency**: image jobs run 8 in parallel (sharp is libvips C, RAM-bound); video jobs run 3 in parallel (ffmpeg pins a CPU core). Both env-overridable. In-flight de-duplication collapses 50 simultaneous requests for the same `(id, w)` into a single generation, so a fast scroll never spawns a job storm.
- **Auto-generation on download** — `pregenerateThumb(id)` fires from `registerDownload` after every successful insert (background, non-blocking, queues behind the same per-kind semaphores). The first gallery scroll already finds the WebP in cache.
- **Cache invalidation** — single-file delete, bulk-delete, and dedup-delete all call `purgeThumbsForDownload(id)` so a stale thumb never keeps serving bytes after the source file is gone.
- **Maintenance UI**:
  - **Build thumbnails for older files** — sweeps every download row that lacks a default-width thumb and queues generation. Honours the per-kind concurrency caps; broadcasts `thumbs_progress` over WS for a determinate progress bar. Single in-flight guard.
  - **Wipe cache** (refresh icon next to Build) — drops every cached WebP. Useful after a quality tweak or corruption scare; on-demand generation refills the cache on the next scroll.
  - Cache stat line ("N cached, X MB · ffmpeg unavailable — image-only" when applicable) sits under the row.

### Cross-platform install — no setup required

Out-of-the-box on every supported platform:

- **Standalone Win / macOS / glibc-Linux** — `npm install` pulls `sharp` (musl + glibc prebuilts) plus the optional `@ffmpeg-installer/ffmpeg` (bundles a static binary per platform). Zero manual setup.
- **Docker (alpine/musl)** — Dockerfile now `apk add --no-cache ffmpeg` so the system binary is on PATH. The npm `@ffmpeg-installer/ffmpeg` is moved to `optionalDependencies` so its glibc-only postinstall never fails the alpine `npm ci`.
- **Resolver order** — `process.env.FFMPEG_PATH` → `/usr/bin/ffmpeg` → `/usr/local/bin/ffmpeg` → `@ffmpeg-installer/ffmpeg` → bare `ffmpeg`. All exposed via `hasFfmpeg()` so the `/api/maintenance/thumbs/stats` payload tells the UI when video / audio-cover thumbs are unavailable on this host.

### Frontend

- Gallery tiles for images and videos render `<img loading="lazy" decoding="async" src="/api/thumbs/<id>?w=…">`. Mobile and desktop share the same code path — no more "blank black tile" on iOS Safari for video posters.
- Dedup-sheet preview thumbnails switched from `/files/<path>?inline=1` (full file) to `/api/thumbs/<id>?w=120` (~5-15 KB).
- SW bypass for `/api/thumbs/` so the SW cache doesn't balloon for libraries with thousands of tiles; the browser HTTP cache + `immutable` Cache-Control handles repeat fetches efficiently.

### CPU/GPU note

All generation is CPU-side (sharp via libvips, ffmpeg via libwebp). No GPU acceleration — keeps the deployment story zero-config across every host.

### SW
- VERSION bumped `'v28'` → `'v29'`.

## [2.3.28] — 2026-04-30

### Changed — Share-link limits and history retention are now config-driven
Removed the hardcoded TTL bounds, rate-limit thresholds, and history retention window introduced in earlier 2.3.x releases. Operators can now tune these via `config.advanced` without recompiling.

- **`advanced.share`** (new namespace) — `ttlMinSec`, `ttlMaxSec`, `ttlDefaultSec`, `rateLimitWindowMs`, `rateLimitMax`. Defaults preserve the previous behavior (60s / 90d / 7d / 60s / 60). Each field is clamped on save and applied immediately on `config_updated` (no restart). The share-link rate-limit middleware reads the current values per-request via function-form `windowMs` / `limit`.
- **`advanced.history.retentionDays`** (new) — was hardcoded to 30; now configurable, range 1-3650. Resolved at every read of the on-disk job list so a save takes effect on the next prune.
- `share.js` exports `applyShareLimits()` and `getShareLimits()`; the original `TTL_*_SEC` constants stay exported as `*_DEFAULT` aliases for callers (and the test suite) that want the spec values.

### Tests
6 new tests covering `applyShareLimits` / `getShareLimits` (default revert, range clamping, inverted-bounds rejection, 10-year ceiling cap, NEVER sentinel preserved). Full suite: 99 / 99 passing.

### SW
- VERSION bumped `'v27'` → `'v28'`.

## [2.3.27] — 2026-04-30

### Added — Token-based shareable media links
Admins can mint signed share-URLs that let a non-user (e.g. a friend) stream or download a single media file without logging into the dashboard.

- **HMAC-SHA256 signed URLs** — `/share/<linkId>?exp=<epoch>&sig=<43-char-base64url>`. The sig binds `linkId|exp` so flipping either invalidates it. Verified with `crypto.timingSafeEqual` (length-checked first to avoid early-return timing leaks).
- **Per-server secret** in `config.web.shareSecret` — 32 random bytes, lazy-generated on first boot, persisted via the existing atomic config writer. Rotating it invalidates every outstanding link.
- **`share_links` table** is the source of truth for revocation + audit (`access_count`, `last_accessed_at`, optional `label`). FK `ON DELETE CASCADE` on `download_id` so deleting/purging a file kills every outstanding link automatically. `PRAGMA foreign_keys = ON` set per-connection for the cascade to fire.
- **Public `GET /share/:linkId`** — registered BEFORE `checkAuth` and added to `PUBLIC_PATH_PREFIXES`. Three independent gates: rate limiter (60/min/IP), HMAC verify, then DB row check (revoked/expired). All failure modes return 401 with a body code (`bad_sig` / `revoked` / `expired`) so an external scanner can't enumerate which links exist. Hands off to `safeResolveDownload` + `res.sendFile` so **Range requests work** end-to-end (videos can be scrubbed). `Cache-Control: no-store` + `X-Frame-Options: DENY` + `Referrer-Policy: no-referrer`.
- **Admin API `/api/share/links*`** (admin-only via the chokepoint added in v2.3.26):
  - `POST /api/share/links` — body `{ downloadId, ttlSeconds?, label? }` → returns `{ url, expiresAt, id }`. TTL clamped to `[60s, 90 days]`. **`ttlSeconds: 0` = "never expires"** — sentinel honored end-to-end (DB stores `expires_at = 0`, verifier skips the time gate, frontend renders "Never expires").
  - `GET /api/share/links?downloadId=…` — list links for one file (Share sheet) or all (Maintenance sheet).
  - `DELETE /api/share/links/:id` — revoke. Idempotent.
- **UI: Share button in viewer modal** (next to Delete/Download, marked `data-admin-only`). Opens a sheet with TTL radio (1h / 24h / 7d / 30d / 90d / Never), optional label, "Create share link" button (auto-copies on success), and a list of existing links with per-row Copy / Revoke + access counter.
- **UI: Maintenance → Active share links** sheet — search across filename / group / label, "Active only" toggle, per-row Copy / Revoke. Single source of truth for the admin's outstanding link inventory.
- **Service Worker bypass** for `/share/*` — never cache, so a revoked link can't keep serving from the SW.

### Added — Download-time deduplication (no-duplicate writes)
The downloader now hashes every file the moment it lands on disk and folds duplicates into the existing copy.

- **`src/core/checksum.js`** — single canonical `sha256OfFile(absPath)` helper. Every code path that hashes media (the post-write check in `downloader.js`, the on-demand catch-up scan in `dedup.js`, any future verification flow) imports this one function. Same algorithm (SHA-256), same encoding (lowercase hex, 64 chars), same streaming read strategy. `dedup.js`'s previous local `hashFile` is now a thin alias.
- **Downloader** computes the SHA-256 right after the atomic `.part → final` rename, then queries the DB for an existing row with the same `file_hash` AND `file_size`. If one exists AND its file is still present on disk:
  - The new copy is `unlink`ed.
  - The new DB row is inserted with `file_path` pointing at the existing file (so the gallery shows the file in this group too without storing duplicate bytes).
  - `incrementDiskUsage(0)` — disk-rotator quota stays accurate.
  - `download_complete` event carries `deduped: true` for monitor logs.
- Hash failures (rare — race with sweepers) fall through and store the row normally; the existing on-demand `dedup` scan picks them up later.

### Tests
21 new tests in `tests/share.test.js`: secret bootstrap (generation / regeneration / fingerprint), sign / verify round-trip with tamper rejection (linkId, exp, sig), base64url shape, secret-rotation invalidates, TTL clamp (defaults / floor / ceiling / NEVER sentinel / null vs 0 distinction), URL builder, sig-masking helper. Full suite: 93 / 93 passing.

### SW
- VERSION bumped `'v26'` → `'v27'`.

## [2.3.26] — 2026-04-30

### Added — Guest role (read-only viewer alongside admin)
The dashboard now supports an opt-in **read-only "guest" role** alongside the admin password. Guests can browse media and watch videos but cannot delete files, change settings, or manage Telegram accounts. Their video player preferences (autoplay/volume/etc.) save to localStorage and are independent from admin's.

- **`config.web.guestPasswordHash` + `config.web.guestEnabled`** — new optional config keys. If unset the dashboard behaves exactly as before.
- **Sessions carry a role** — `data/web-sessions.json` records now include `role: 'admin' | 'guest'`. Legacy sessions (no role field) default to admin; no forced re-login on upgrade.
- **Default-deny `/api` chokepoint for guests** — a single middleware after `checkAuth` consults an explicit allowlist (`GET /api/downloads*`, `GET /api/stats`, `GET /api/groups` (read), `GET /api/queue/snapshot`, `GET /api/monitor/status`, `GET /api/history*`, `POST /api/logout`). Anything not on the list returns `403 {adminRequired:true}`. New mutation routes are admin-gated for free.
- **`POST /api/auth/guest-password`** (admin-only) — set/enable/disable/clear the guest password from Settings → Dashboard Security. Rejects equality with the admin password (would render the guest role unreachable). Disabling or clearing the password also revokes every active guest session immediately.
- **SPA: `body[data-role]` CSS gate.** Every admin-only DOM node carries `data-admin-only`; a single CSS rule hides them when `state.role === 'guest'`. Sidebar nav (Backfill/Stories/Account add), Settings sections (everything except Video Player + Appearance), gallery delete buttons, queue mutation buttons — all gone for guests in one pass.
- **SPA router** redirects guest sessions away from `#/groups`, `#/backfill`, `#/queue`, `#/engine`, `#/stories`, `#/account/add`, and any `#/settings/<section>` other than `video-player` / `appearance` to `#/viewer`.
- **Header role pill** ("Guest") so the user always knows which role is active.
- **`api.js` 403 interceptor** toasts `errors.admin_only` for the rare race where a stale guest tab fires an admin call.

### Added — Recent backfills: per-row delete + Clear all
The Recent backfills list (last 30 days) was display-only; long lists could not be tidied up.

- **`DELETE /api/history/:jobId`** — drops one finished entry from the in-memory map + on-disk `history-jobs.json`. Refuses to delete a running job (cancel first).
- **`DELETE /api/history`** — clear every finished entry in one call. Running jobs are preserved.
- **Per-row × button** + **Clear all** on Backfill → Recent. Cross-tab via WS `history_deleted` / `history_cleared` so other open tabs drop the row in real time.

### Added — Checksum-based duplicate finder (Maintenance)
The `downloads.file_hash` column has been in the schema since v2 but was never populated. Maintenance now exposes a one-shot scan that hashes every file, groups byte-identical copies, and lets the admin pick which to keep.

- **New `src/core/dedup.js`** — `findDuplicates()` walks every row missing `file_hash`, streams SHA-256 over the file, writes the digest back, then GROUPs BY hash for sets where COUNT > 1. First scan is O(bytes-on-disk); subsequent scans are nearly free.
- **`POST /api/maintenance/dedup/scan`** — runs the catch-up + grouping. Broadcasts `dedup_progress` over WS for a determinate progress bar. Single in-flight guard: a second concurrent scan returns 409.
- **`POST /api/maintenance/dedup/delete`** — body `{ ids: [...] }`. Deletes the selected files from disk AND drops their DB rows in one transactional sweep. Reports `{ removed, freedBytes, missingFiles }`.
- **Maintenance UI** — new **Find duplicate files** button. Scans, then opens a sheet with every duplicate set: thumbnails, filenames, group, date, file URL preview link. Default selection deletes all but the **oldest** copy in each set; per-set **Keep oldest / Keep newest** shortcuts; per-row checkbox flips. Bottom of the sheet shows live "N selected · X MB will be freed" totals + an explicit destructive confirm before deletion.

### Changed — Mobile gallery: smooth + working video previews

- **`FILES_PER_PAGE` is now viewport-aware** — desktop stays at 100; mobile (`max-width: 768px`) drops to 50, matching the lower tile-per-row count so DOM size scales with screen size.
- **Mobile video tiles use a poster-only render** — `<video preload="none">` is unreliable on mobile Safari (often paints a blank black tile) and high-memory across a 50-tile grid even when it works. Mobile now renders an icon + play badge inside a subtle gradient instead. Tap still opens the full viewer with the real `<video>`. Desktop keeps the existing lazy `<video>` for hover scrub.
- `<img>` tiles gained `loading="lazy"` to avoid an iOS over-eager prefetch when the user scrolls fast.

### Tests
- 8 new tests in `tests/web-auth.test.js` covering the role-aware `loginVerify`, `isGuestEnabled`, `issueSession({ role })`, and `revokeAllGuestSessions`.

### SW
- VERSION bumped `'v25'` → `'v26'`.

## [2.3.25] — 2026-04-28

### Changed — backpressure abort window 5 min → 15 min
The history-backfill backpressure was aborting jobs whose pending queue sat just barely above the cap (e.g. 513 vs 500), even when the downloader was healthy.

Why it fired: a single bad-luck job that hits FloodWait every retry can stall for `MAX_FLOOD_RETRIES × delay` = 8 × 60 s = **8 min** before the downloader gives up and emits an `error` event. The backfill abort at 5 min therefore guaranteed a kill in this scenario, even though the downloader was healthy and would have recovered.

- **Default `backpressureMaxWaitMs`** bumped 5 min → **15 min** in both `history.js` (inline fallback) + `settings.js` (Advanced default) + `server.js` (config validator default). Existing user configs that have an explicit value keep theirs unchanged.
- **New `stalled` event** emitted by the history runner at the half-way mark (7.5 min by default). Carries `{ pending, cap, stallSeconds }`. The runtime forwards it for the SPA to render a "stalled, still trying…" hint without dropping the job.

### SW
- VERSION bumped `'v24'` → `'v25'`.

## [2.3.24] — 2026-04-28

### Changed — gallery feels smooth
- **Pre-fetch the next page from 1200 px away.** The IntersectionObserver on `#load-more-sentinel` now uses `rootMargin: '1200px 0px 1200px 0px'`, so the next batch is requested while the user is still ~1200 px from the bottom of the current one. Combined with the bigger page size below, the visible scroll-stutter on a long gallery should be gone.
- **`FILES_PER_PAGE: 50 → 100`.** Half the round trips for the same scroll distance.

### Changed — `/api/monitor/status` and `/api/stats` now WS-push
The 30 s + 60 s safety polls in `monitor-status.js` and `statusbar.js` are replaced with WebSocket broadcasts:

- **Server**: `_pushMonitorStatus()` broadcasts `monitor_status_push` every 3 s with the full `/api/monitor/status` snapshot. `_pushStats()` broadcasts `stats_push` every 30 s with the full `/api/stats` payload. Both skip the build entirely when no WebSocket clients are connected, and coalesce overlapping async builds via an in-flight flag. The single GET endpoints stay on for the SPA's first paint + a manual refresh.
- **SPA `monitor-status.js`**: dropped the 30 s `setInterval`, the visibilitychange-driven catch-up, and the timer machinery. One HTTP fetch on the first subscriber so the bar isn't blank for 3 s, then rides the WS push for the rest of the session. Re-fetches once on every WS reconnect (`__ws_open`) to fill the gap a disconnect window left.
- **SPA `statusbar.js`**: dropped the 60 s stats poll. Listens for `stats_push` and applies the payload directly. Mutation events (`download_complete` / `file_deleted` / `bulk_delete` / `purge_all` / `group_purged`) still trigger an immediate refetch so the user sees their own delete / new download instantly, ahead of the next 30-second push.

Net effect: on an idle dashboard with WS connected, server-side load + client-side wakeups for these two endpoints drop from ~3 calls/min to **0**.

### SW
- VERSION bumped `'v23'` → `'v24'`.

## [2.3.23] — 2026-04-28

### Fixed — hotfix for v2.3.22 regression
- **Infinite recursion → "Maximum call stack size exceeded"** the moment the user clicked any sidebar nav. v2.3.22 added `navigateTo('viewer')` inside `showAllMedia()` to fix the "click does nothing on Settings page" bug. But `renderPage('viewer')` was *already* the caller of `showAllMedia()`, so the chain became: sidebar click → `showAllMedia` → `navigateTo` → `renderPage('viewer')` → `showAllMedia` → `navigateTo` → … → stack overflow → crash loop in the SPA. Guarded the navigation with `if (state.currentPage !== 'viewer') { navigateTo('viewer'); return; }` so renderPage re-enters the function exactly once with the page already visible, and never fires the loop.

### Changed
- **SW VERSION** bumped `'v22'` → `'v23'`.

## [2.3.22] — 2026-04-28

### Fixed
- **Clicking "All Media" did nothing visible** when the user was on Settings / Engine / Queue / Backfill. `showAllMedia()` reset state and started the fetch but never called `navigateTo('viewer')`, so the response loaded into a hidden DOM and the user saw no change. `openGroup()` already navigates correctly; brought `showAllMedia()` in line.
- **Header avatar lingered on the previous group's photo** after switching to All Media. `updateHeaderAvatar()` now treats `groupId == null` as "non-group view" and renders a generic gallery glyph instead of leaving the previous chat's avatar floating in the header. `showAllMedia()` calls `updateHeaderAvatar(null, null)` so the swap happens the moment you click.

### Changed
- **SW VERSION** bumped `'v21'` → `'v22'`.

## [2.3.21] — 2026-04-28

### Fixed
- **Queue page extremely laggy + 404 spam in console.** Two related causes:
  - Video rows rendered `<video preload="metadata" src="/files/…">` for every visible done item; Chromium pulls ~256 KB of MP4 header per row on every render, re-fired on every scroll → smoking-hot CPU + network and the "queue โครตหน่วง" report.
  - Image rows rendered `<img src="/files/…">` even for files that had been rotated / deleted / never fully written → 404 console spam.
  - **Fix**: dropped the per-row thumbnails entirely. Each row now shows a tinted icon placeholder coloured by media type (blue for image, white-on-black for video, orange for audio, grey for everything else). Click-to-view still opens the actual file in the in-app viewer when the row is `done`. Zero network round-trips, zero 404 risk.

### Added
- **Max Download Speed: free-form input.** The hard-coded 5-option dropdown (Unlimited / 1 / 5 / 10 / 20 MB/s) is now a numeric input + KB/s / MB/s / GB/s unit picker. Empty value = unlimited; any number resolves to bytes on save. The label above the input mirrors the current value live.

### Changed
- **Default Volume slider** — step `5` → `1` for fine control, label + value live on one balanced row above the bar (was label-above + value-below). Picks up the branded `.tg-range` thumb so it matches the player's volume slider.

### SW
- VERSION bumped `'v20'` → `'v21'`.

## [2.3.20] — 2026-04-28

### Fixed
- **Status-bar disk usage was still nonsense after v2.3.19** ("Disk: 1.03 MB" with 8 786 files) because the DB rows themselves carried `file_size = 0 / NULL` from older downloader versions that didn't always stat after rename. The integrity sweep now **backfills the correct on-disk size** every time it walks a row whose stored `file_size` doesn't match the actual `fs.stat().size`. Result: after one boot-sweep pass (≈30 s after start, then every `intervalMin` minutes), the status-bar disk number reflects reality. The sweep also now tolerates the legacy `data/downloads/` prefix in `file_path` (same fix v2.3.19 applied to `safeResolveDownload()`), so rows that were previously skipped as "outside downloads dir" will now stat + heal cleanly.
- **Manual `Verify files on disk`** in Settings → Maintenance now reports `sizeFixed` alongside `pruned`, so you can see how many DB rows had their byte-count repaired.

### Changed
- **SW VERSION** bumped `'v19'` → `'v20'`.

## [2.3.19] — 2026-04-28

### Fixed
- **Queue thumbnail / "click to view" 404'd for every finished item.** Root cause: `downloader.js`'s `buildPath()` defaults to `'./data/downloads'` (relative), so `writtenPath` (and the `complete` event payload's `filePath`) is a relative string like `data/downloads/<group>/images/<file>`. v2.3.6's stripper only handled the absolute form (`/app/data/downloads/<…>`); when the input was relative-with-prefix it slipped through unchanged → SPA built `/files/data/downloads/<…>` → `safeResolveDownload()` joined to `DOWNLOADS_DIR` a second time → 404. Two-part fix:
  - `pushQueueHistory()` now walks **three** forms (absolute under `DOWNLOADS_DIR` / relative `./data/downloads/` / relative `data/downloads/`) and strips whichever it sees, so new entries persist the canonical `<group>/<type>/<file>` form.
  - `safeResolveDownload()` is now **lenient on the legacy prefix** — it strips any leading `data/downloads/` (and `data\downloads\` on Windows) before joining to `DOWNLOADS_DIR`, so existing queue-history entries + DB rows from before this release also resolve correctly.
- **All Media: some tiles 404 / "click open viewer" failed for some files.** Same root cause — DB rows from before the path-stripping fix carried the legacy prefix. The `safeResolveDownload()` change above fixes those too without a DB rewrite.
- **Status-bar disk usage showed nonsensical values** (e.g. `930.54 KB` with 8 784 files). The endpoint was reading from `data/disk_usage.json` — a cache that older downloader versions wrote sparingly and never invalidated when the DB was purged + repopulated. Switched to the live `SUM(file_size)` from the DB (`getDbStats().totalSize`); falls back to the JSON cache only when the DB sum is zero.

### Changed
- **SW VERSION** bumped `'v18'` → `'v19'`.

## [2.3.18] — 2026-04-28

### Added — `?v=` cache-busting on JS / locale assets
- **HTML rewrite**: `<script src="/js/...">`, `<link href="/locales/...">`, etc., are post-processed before the SPA HTML is served, appending `?v=<APP_VERSION>` to every internal `js/` or `locales/` URL.
- **JS rewrite**: every relative `import './X.js'` (and `import('./X.js')`, `import './X.js'`) inside the served JS modules is rewritten to carry the same `?v=` so the child URL inherits the cache-bust and the browser HTTP cache can't stale-serve a single transitive module while the rest of the bundle is fresh.
- **Cache-Control upgrade**: any `/js/*.js` or `/locales/*.json` request that arrives with a `?v=` query string now returns `Cache-Control: public, max-age=31536000, immutable`. Bare requests (no `?v=`) keep the conservative 1 h fallback so a curl / direct fetch still revalidates.
- **In-memory rewrite cache** so the regex runs once per file per process lifetime; a server restart re-reads (which is exactly what we want after `docker compose pull`).

The combined effect: a fresh release flips every internal asset URL automatically (no manual filename hashing, no build step), the browser HTTP cache treats it as a different resource, and the SW cache-first path naturally fetches the new bytes too.

### Changed
- **SW VERSION** bumped `'v17'` → `'v18'`.

## [2.3.17] — 2026-04-28

### Removed
- **Help paragraph under the Font picker.** The text was stuck at "All ten options support Thai" since v2.3.14, never updated when v2.3.15 added the 10 Latin-only fonts (and would have grown stale again next time the registry expands). Removed entirely — the picker is self-explanatory because the `<optgroup>` labels already say "Thai-capable", "Latin (Thai falls back)", and "No webfont".
- Dropped i18n keys `settings.font_help` (en + th). 637 → **636 keys total** (parity preserved).

### Changed
- **SW VERSION** bumped `'v16'` → `'v17'`.

## [2.3.16] — 2026-04-28

### Fixed
- **Font picker `<select>` was rendering empty** for some users. Root cause: `app.js`'s init wired the picker through `await import('./fonts.js')` (dynamic import). When the service worker had a stale shell cached, the dynamic import either resolved to the wrong module instance or failed silently — either way `populateSelect()` never ran and the dropdown stayed empty (`<!-- Options populated by js/fonts.js… -->` comment visible only to anyone inspecting the DOM).
  - Switched to a **static `import * as Fonts from './fonts.js'`** at the top of `app.js` so the SW handles `fonts.js` like any other shell module.
  - Added a **defensive re-populate inside `loadSettings()`** so opening the Settings page always seeds the dropdown, even if init's first attempt failed. The change-listener gets wired exactly once per session via a module-level `_fontPickerWired` flag.
- **SW VERSION** bumped `'v15'` → `'v16'` so the static-import path actually reaches the browser instead of being served from the v2.3.15 cache.

## [2.3.15] — 2026-04-28

### Added — Latin font choices
- **10 Latin Google Fonts** added to the picker on top of v2.3.14's 10 Thai-capable fonts: **Roboto**, **Inter**, **Open Sans**, **Lato**, **Source Sans 3**, **Manrope**, **DM Sans**, **Work Sans**, **Plus Jakarta Sans**, **Outfit**. Thai characters fall back through the `--tgdl-font-family` chain to IBM Plex Sans Thai so a Latin-only pick (e.g. Roboto) still renders Thai cleanly.
- The `<select>` is now grouped by `<optgroup>`: **Thai-capable** (10), **Latin (Thai falls back)** (10), **No webfont** (1) = **21 total**.

### Fixed
- **Per-group view: media not complete after switching from a Photos / Videos tab.** When the user filtered All Media to Photos and then clicked a group in the sidebar, the previous `state.currentFilter` survived → `loadGroupFiles()` fetched `?type=images` only → user saw a partial library and the tab UI silently said "All". Both `openGroup()` and `showAllMedia()` now reset the filter to "all" and re-paint the tab strip to match.

### Changed
- **SW VERSION** bumped `'v14'` → `'v15'` so the new font registry + filter-reset reach the browser.

## [2.3.14] — 2026-04-28

### Added — user-selectable font
- **Settings → Appearance → Font** — pick from 11 options (10 Google Fonts that support Thai + a no-webfont "System default"). IBM Plex Sans is still the default. Switching applies live across the whole app via a `--tgdl-font-family` CSS variable; mono regions (time block, log viewer, queue size column) stay on IBM Plex Mono regardless of UI choice.
  - **IBM Plex Sans** (default, current pair: IBM Plex Sans + IBM Plex Sans Thai)
  - **Noto Sans Thai** (Google's own pan-script family)
  - **Sarabun** (very common Thai government / SaaS font)
  - **Prompt** (modern Thai display)
  - **Kanit** (popular UI face)
  - **Mitr** (rounded, friendly)
  - **K2D** (geometric, pairs well with Latin)
  - **Bai Jamjuree** (geometric)
  - **Athiti** (humanist sans)
  - **Niramit** (light / airy)
  - **System default** (no webfont — uses the OS's native Thai face; useful for air-gapped deployments)
- **Boot-time font preload** in `index.html` reads the saved choice from `localStorage` BEFORE first paint and injects the matching `<link>` so the SPA opens with the right font already in CSSOM (no flash of unstyled text on cold load).
- New module `js/fonts.js` houses the font registry + `applyFont()` + `populateSelect()`. The boot-time `<script>` mirrors the same registry inline (the script runs before the module graph evaluates).
- **i18n**: `settings.font`, `settings.font_help` (en + th lockstep, 637 keys total).

### Changed
- **SW VERSION** bumped `'v13'` → `'v14'` so the new `index.html` (with boot script + font select) reaches the browser instead of being served from the v2.3.13 cache.

## [2.3.13] — 2026-04-28

### Changed — locale tone + casing pass

- **`th.json` rewritten in formal-but-readable Thai** — the tone a Thai-language SaaS product (Notion Thai, Microsoft Thai) would ship. Removed casual particles, used polite constructions, replaced slangy translations ("เซฟ" → "บันทึก", "หน้าตา" → "รูปลักษณ์", "หลุดจาก server เลย" → "ขาดการเชื่อมต่อกับเซิร์ฟเวอร์"). No trailing periods on Thai sentences (Thai punctuation convention). Tech terms kept in English where Thai devs say them that way (`monitor`, `queue`, `session`, `proxy`, `gramJS`, `MTProxy`, `WebSocket`, `dashboard`, `container`, `Stories`, `release notes`, `PiP`, `fullscreen`, `Backfill`, `Rescue`).
- **`en.json` recapped to proper English casing**:
  - **Buttons / form labels / nav items / tab names** → Title Case (`Save Credentials`, `Add Account`, `Browse Chats`, `Run Again`, `Restart Monitor`, `Telegram API`).
  - **Help text / descriptions / toasts / confirmations** → sentence case with terminal periods.
  - **Acronyms** always ALL CAPS: PiP, HTTPS, JSON, SQLite, OTP, FloodWait, MTProxy, NTP, WAL, etc.
  - **Tech proper nouns** kept verbatim: Telegram, GitHub, Docker, Express, gramJS, IBM, GHCR.
- All 635 keys preserved (parity 635 / 635); every `{placeholder}` token, `_html` markup, code span, and URL untouched.
- **SW VERSION** bumped `'v12'` → `'v13'` so the recapped strings actually reach the browser instead of being served from the previous cache.

## [2.3.12] — 2026-04-28

### Added
- **Settings → Video Player** now covers every realistic playback preference. New options on top of v2.3.9's autoplay/start-muted/loop/auto-advance/resume/default-speed/default-volume:
  - **Show Picture-in-Picture button** (toggle) — hide if you never use PiP, frees toolbar space.
  - **Show speed button** (toggle) — same idea; default speed is still configurable below.
  - **Double-tap to fullscreen** (toggle) — defaults ON to match legacy behaviour.
  - **Skip step (s)** (number, 1–60, default 5) — controls how far ← / → arrow keys jump. Shift-arrow now jumps `step × 2` for power users.
  - **Hide controls after (s)** (number, 1–30, default 3) — auto-hide delay for the player toolbar.

### Changed
- **Sidebar "Viewer" entry removed** — was a third redundant entry-point to the same `#/viewer` page (the "All Media" card right below + the bottom-nav "Library" item already cover it). Cleaner sidebar; no functional change.
- **Update-check cache TTL: 1 h → 10 min** to shorten the window between a release going live and the dashboard showing the update pill. Cache is shared across all clients of one instance, so 6 upstream calls per hour total is comfortably under GitHub's 60-req-per-hour-per-IP unauthenticated rate limit.
- **Service-worker cache** bumped `'v11'` → `'v12'` to flush the older cached JS for users upgrading through this release.

### i18n
- 18 new keys (10 settings labels/help + 8 toast confirmations), en + th lockstep, 635 keys total.

## [2.3.11] — 2026-04-28

### Fixed
- **Service-worker cache was holding stale `settings.js` + `index.html` for users who pulled v2.3.5–v2.3.10.** SW `VERSION` was last bumped to `'v3'` in v2.3.4 and never since (despite the comment "Going forward, this string bumps with every meaningful release" — sorry). Result: a user pulled v2.3.7 → v2.3.10, the new HTML loaded fine (network-first for navigation), but `/js/settings.js` stayed cached (cache-first for static assets) so the new Video Player toggles rendered with no behaviour wired. Bumped to `'v11'`; the activate handler purges every non-matching cache key on first hit, so the upgrade is one reload.
- **Update-check cache was 6 hours.** That window meant a fresh release could be live for hours before the dashboard's update pill appeared. TTL lowered to **1 hour**; additionally the cache is **bypassed when the running container is at-or-newer than the cached `latest`** (means we just rolled forward and a release was probably published in the window — re-fetch instead of trusting the stale "no update" answer).

### Added
- **IBM Plex Sans + IBM Plex Mono + IBM Plex Sans Thai** as the primary UI / mono / Thai fonts. Thai users get a font that ships proper Thai letterforms instead of falling back to the system; mono digits in the time block / queue size column / log viewer become consistent across browsers. Roboto kept in the fallback stack so an offline session that already cached it still renders cleanly.

### Changed
- **Branded range-slider** styling now covers every range input (player volume, Settings → Video Player default volume, plus a `.tg-range` class for future inputs). 14 × 14 white thumb with brand-blue ring on a 4 px track in both Webkit + Firefox. Settings → Video Player volume slider now matches the player's exactly instead of rendering the UA default.

## [2.3.10] — 2026-04-28

### Fixed
- **Video player controls layout was jittery + the volume slider clashed with the time text.** The volume slider used a `w-0 → group-hover:w-20` collapse trick that pushed every control to its right (including the `00:00 / 00:00` time block) sideways every time the cursor crossed the mute button. Worse, hover-only meant touch users couldn't reach it at all.
  - Volume slider is now **always visible at 80 px on `sm:` and up** (hidden on phones — system volume buttons + the mute toggle cover that case better).
  - Each child of the controls row has a **fixed footprint** (play `40 × 40`, mute `36 × 36`, volume `80 × 4`, speed/PiP/FS `36 × 36` each); the time block is mono-font with `tabular-nums` so digits don't reflow as the clip plays.
  - Right cluster (speed / PiP / fullscreen) is pinned to the right via a `flex-1` spacer instead of `justify-between` on the parent — separates layout intent from the inner spacing so a future toolbar item can slot in cleanly.
  - **Polished volume thumb**: 12 × 12 white circle with brand-blue ring, custom track height 4 px on both Webkit and Firefox. Default UA thumb was comically large on Chromium and barely visible on Firefox.
  - Speed button reads `1×` (multiplication sign) instead of `1x` (lowercase x) — matches the dropdown labels in Settings → Video Player.

## [2.3.9] — 2026-04-28

### Added
- **Settings → Video Player** — dedicated section for every playback preference. All settings are browser-side (`localStorage`), no server round-trip; the viewer module reads the same keys on every clip `.load()` so changes take effect on the next open.
  - **Autoplay videos** — start playing automatically on open. Falls back to a muted start if the browser blocks autoplay-with-sound.
  - **Start muted** — toggles the saved mute state explicitly (also satisfies most browsers' autoplay policy).
  - **Loop video** — `<video loop>` flag, restarts the clip at the end.
  - **Auto-advance to next** — when a video ends and looping is off, opens the next file in the gallery automatically (60 ms debounce so the previous `onended` returns first).
  - **Remember position** — toggle to disable the existing per-clip resume behaviour. Defaults to ON to preserve legacy behaviour; the saved per-clip key is preserved when off so re-enabling restores everyone's history.
  - **Default playback speed** — bound directly to the existing `video-speed` localStorage key, so changing it propagates to every player open instantly.
  - **Default volume** — same pattern, bound to `video-volume` (0–100% slider with live label).
- **i18n**: 12 new keys for the settings labels + helper text + toast confirmations (en + th lockstep, 621 keys total).

## [2.3.8] — 2026-04-28

### Fixed
- **Backfill page "Recent backfills" was showing the same chat several times** when the user re-ran a job (e.g., a Failed run + a manual retry produced two visible rows). Recent list is now deduped by `(groupId, limit)` — the **newest attempt** is shown, with a small `× N attempts` badge surfacing how many earlier runs were folded in. Different limits for the same chat (`Last 100` vs `All`) stay as separate rows because they're genuinely different actions. Underlying `data/history-jobs.json` still records every attempt for audit; only the UI list collapses.
- **i18n**: `backfill.row.attempts`, `backfill.row.attempts_help` (en + th lockstep, 598 keys).

## [2.3.7] — 2026-04-28

### Fixed
- **History backpressure abort** ("History backpressure timed out (5min) — downloader appears stuck") now only fires when the downloader genuinely makes **zero forward progress** during the wait window. The previous logic counted from when the queue first hit the cap and aborted at +5 min regardless of how many downloads completed in that window — a slow large clip, a heavy FloodWait throttle, or any sustained-but-progressing run could trip it. The new check subscribes to the downloader's `complete` event AND watches `pendingCount` for a decrease; either resets the no-progress timer. The abort message now includes the actual pending count + cap so it's clear whether the cause is a stalled worker (FloodWait, network) or a misconfigured cap. Combined with the v2.3.6 FloodWait infinite-retry fix, the spurious 5-min abort should be gone in practice.

## [2.3.6] — 2026-04-28

A blocker fix in the gallery (libraries with thousands of files were capped at ~209 visible), plus the priority items from a third audit pass — silent FloodWait loops, Windows-reserved filenames, downloader/rotator races, queue UX overhaul, and the avatar flicker.

### Fixed — blocker
- **All Media was capped at ~400 files.** `loadAllFiles()` was hard-coded to fetch the first 20 groups × 20 files each, with no pagination and no infinite-scroll. A library with 2454 files would render only ~209 in the gallery (and Photos / Videos tabs ~30–50 each). New endpoint `GET /api/downloads/all?page&limit&type` orders by `created_at DESC` across every group, the SPA's existing `setupInfiniteScroll` sentinel pages it, and the per-tab type filter is now a server-side `?type=` query so the count under each tab is accurate. Also fixed an off-by-one where a perfectly-packed last page kept pagination armed forever.

### Fixed — critical
- **FloodWait retry was a tight infinite loop.** `downloader.js:717` called `return this.download(job, attempt)` *without* incrementing `attempt`, so a sustained throttle would re-enter forever. Now tracks FloodWait retries on a separate counter (`MAX_FLOOD_RETRIES = 8`); the normal retry budget stays untouched but a persistent flood gives up cleanly.
- **`sanitizeName()` produced filenames Windows refuses to open.** A chat literally named `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, or `LPT1`–`LPT9` (with or without an extension) would land in a folder Windows can't even `stat`. Reserved-name check now prefixes with `_`. Also switched the truncation from `slice(0, 80)` (UTF-16 char count → mid-codepoint cut on multibyte chars) to UTF-8 byte truncation that backs off to the last full codepoint.
- **Rename collision silently overwrote.** `fs.rename(.part, final)` is destructive on every major platform — two accounts that produced the same final filename would see one's content quietly replace the other's, with the earlier DB row pointing at the wrong bytes. Now suffixes ` (1)`, ` (2)` … on collision.
- **Disk-rotator could delete a file the downloader was mid-writing.** Caused intermittent `Downloaded file is empty (0 bytes)` failures in the wild because the rotator's sweep would unlink the `.part` out from under the active download. Downloader now publishes `_activeFilePaths: Set<string>`; the rotator's constructor takes a `getActiveFilePaths` accessor and skips any candidate whose absolute path is in the Set.
- **gramJS keep-alive kept hammering throttled DCs.** The `Api.PingDelayDisconnect` catch was logging FloodWait but pinging again 60 s later. Now serves a 10-minute backoff per offending account before the next ping; warn lines are still coalesced to one per 5 min.

### Fixed — UX
- **Avatar flicker on every sidebar re-render.** `/api/groups/:id/photo` was inheriting the global `/api/*` `Cache-Control: no-store` policy, so every `renderGroupsList()` paint forced a fresh round-trip and a brief flash. The endpoint now overrides with `private, max-age=86400, stale-while-revalidate=604800` — bytes are content-addressed by group ID and rewritten in place when the photo changes, so the long TTL is safe.
- **Queue page overhaul.**
  - Finished rows are clickable and open the matching media in the in-app viewer (image / video / audio).
  - Cancel + dismiss now go through the themed `confirmSheet` (was instant, easy to mis-tap).
  - Progress bar reads 100 % when status is `done` (was stuck at 0 %); shows blank for queued (was 0 %).
  - Size column shows `…` for queued items whose size hasn't been negotiated yet, `—` only when truly unknown.
  - Real thumbnail (image / video poster) for finished rows where we know the file path; the icon stays as fallback.
- **Forwarder delete-after-forward unlink failure** is now logged at WARN with the filename instead of swallowed inside the upload catch — the integrity sweep will eventually reap the orphan.

### Fixed — DB performance
- **`busy_timeout = 5000`** added at boot. A long write (rescue / disk-rotator bulk delete) used to fail concurrent reads instantly with `SQLITE_BUSY`; now waits up to 5 s.
- **`wal_autocheckpoint = 1000`** explicit. Tames `-wal` growth on sustained writes.
- **Hot-path prepared-statement cache.** `isDownloaded()` and `fileAlreadyStored()` were re-preparing the same SQL on every call (called per message in every monitor pass); module-level `_prep()` cache fixes that.

### Added — endpoint + i18n
- `GET /api/downloads/all` for the All Media surface.
- `queue.confirm.cancel_title`, `queue.confirm.cancel` in en + th lockstep (596 keys total).

## [2.3.5] — 2026-04-28

### Fixed
- **Telegram release notifier was sending raw Markdown.** `.github/workflows/telegram-notify.yml` was POSTing the release body to `sendMessage` with `parse_mode=HTML` after only HTML-escaping it — so `**bold**`, `### headers`, and `` `code` `` shipped as literal characters. Replaced the escape step with a tiny inline Python pass that converts the GitHub-Markdown subset we actually use (headers, bold, italic, inline code, fenced code, bullets, links, hrules) into the matching Telegram-HTML subset (`<b>`, `<i>`, `<code>`, `<pre>`, `<a>`, `•`) before sending. Code blocks and inline code stay HTML-safe; the link `[text](url)` form is preserved.

## [2.3.4] — 2026-04-28

Last items from the multi-pass audit. Closes the remaining "deferred" tasks: WS reconnect storm, sheet stacking edge case, log-read hang, stale service-worker cache.

### Fixed
- **WebSocket reconnect storm.** ws.js now caps automatic reconnects at 12 attempts (~6 minutes of capped backoff) and emits a `__ws_giveup` pseudo-event. The status bar paints the WS dot orange + shows a one-time toast and a click-to-retry handler, instead of leaving the user staring at a silent red dot with no way to recover other than refresh.
- **Sheet stacking backdrop click.** Backdrop click on a sheet that's no longer the topmost no-ops, so a stacked Sheet B's backdrop can't fall through and close the underlying Sheet A.
- **Log-read hang in Maintenance.** `fetch /api/maintenance/logs/download` now uses an AbortController with a 30 s ceiling, releases the in-flight server-side stream on abort, and surfaces a clear "log read timed out" message instead of leaving the View button disabled forever.
- **Service-worker cache stuck on `v1`.** The static `VERSION = 'v1'` meant deploys never invalidated the shell + asset caches automatically. Bumped to `v3`; the `activate` handler will purge the old `tgdl-shell-v1` / `tgdl-assets-v1` caches on first hit. (Going forward, this string bumps with every meaningful release.)
- **i18n keys.** `ws.giveup`, `ws.giveup_retry`, `maintenance.logs.timeout` in en + th lockstep (594 keys total).

## [2.3.3] — 2026-04-28

Second-pass audit plus four additional defects surfaced in production. Fixes a real entity-cache shape bug and a path-traversal hole in the profile-photo endpoint that the first audit missed.

### Fixed — security
- **Path traversal in `/api/groups/:id/photo`** — `req.params.id` was interpolated straight into a filesystem path with no validation. A request like `/api/groups/..%2F..%2Fetc%2Fpasswd/photo` could escape `PHOTOS_DIR`. Now requires `id` to match `/^-?\d+$/` (signed Telegram ID) and runs a `fs.realpathSync` check before `sendFile`.
- **CSRF defence-in-depth.** Added an Origin / Referer same-host check to every `POST` / `PUT` / `PATCH` / `DELETE`. Requests with neither header (CLI, native clients) pass through — the `sameSite=strict` cookie still gates them.
- **Prototype-pollution filter** on the `POST /api/config` body. Strips `__proto__`, `constructor`, `prototype` keys recursively before any `{ ...currentConfig, ...req.body }` spread.

### Fixed — backend correctness
- **`entityCache` shape bug.** First lookup returned `{ entity, client }`, but the cache stored only `entity`. Every subsequent cache hit returned a bare entity, so callers reading `r.entity` got `undefined` and silently fell through to "unknown chat" naming. Cache now stores `{ entity, client, at }`, has a 30-min TTL, and a 5000-entry hard cap so it can't grow without bound.
- **`saveConfig()` was not atomic.** `fs.writeFileSync(CONFIG_PATH, json)` could be observed mid-write by `fs.watch` consumers (monitor.js's `reloadConfig`), making `JSON.parse` throw on a half-written file. Switched to temp-file + `fs.renameSync()` (atomic on POSIX + NTFS).
- **Standalone-downloader IIFEs** in `/api/stories/download` and `/api/download/url` had no error boundary — a throw inside the drain loop became an unhandled rejection. Wrapped in `.catch()`.
- **`/api/dialogs` cache TTL** could become permanent if the system clock jumped backward (NTP correction). Wrapped the `now - cache.at` comparisons in `Math.max(0, …)`.
- **EADDRINUSE on `server.listen()`** failed silently — the container exited with no clue where to look. Added an `error` handler that prints a clear "Port X is already in use" message and `process.exit(1)`.

### Fixed — frontend
- **VideoPlayer seek bar + play/pause didn't reset between clips** — switching clips from the gallery left the progress bar mid-track and the play icon showing the previous clip's state, because a stale `ontimeupdate` from the OLD source could fire after `load()` reset the UI but before the new src had taken over. Now explicitly `pause()` + `currentTime = 0` + null `onloadedmetadata` BEFORE the UI reset.
- **Backfill `startElapsedTimer()` defensive guard** — clears any existing interval before re-arming so a router double-fire on `#/backfill` can't stack two tickers.

## [2.3.2] — 2026-04-28

Audit-driven defect sweep — fixes uncovered while reviewing v2.3.1 in detail. No new feature surface; everything below is correctness, leak-prevention, or UX polish.

### Fixed — frontend
- **VideoPlayer fullscreen listener leak.** Every viewer open used to attach a fresh `fullscreenchange` listener on `document` without removing the previous one. After 100 opens, 100 stale callbacks fired on every F11. Listener ref is now stored on the player instance and detached in `unload()` / `destroy()`.
- **VideoPlayer resume race.** `onloadedmetadata` from a previous clip could fire after a new clip had loaded and seek the new file to the wrong timestamp. The handler is now nulled in `unload()` so a stale resume can't bleed across clips.
- **Backfill page elapsed-time ticker leak.** `setInterval` fired every 1 s for the rest of the tab's life even after navigating away from `#/backfill`. Router now calls `stopBackfillPage()` on route change.
- **Status-bar double-bound on hot reload.** `initStatusBar()` had no idempotence guard, so a stray double call (recovery flow, dev hot-reload) bound every WS handler twice and fired each event 2×. Added `_booted` guard.
- **Update-pill dismiss double-fire.** Rapid clicks on the new update notifier's × could fire the dismiss handler twice before the badge hid. Added per-paint `dismissing` guard.
- **i18n early-bootstrap race.** Modules that translated during bootstrap (before `initI18n()` resolved) saw an empty dict. Added a `ready` promise consumers can `await`.
- **Gallery section headers were `position: sticky`** inside a CSS Grid, which clipped trailing tiles and stacked multiple "Today / Yesterday / …" headers at the top of the scrollport while scrolling. Reverted to inline static headers.
- **`setting-max-disk` dropdown was non-functional** — the `<input list>` datalist autocomplete didn't render a clickable arrow on most browsers / mobile. Replaced with a real numeric input + unit `<select>` (MB / GB / TB). Legacy free-form values like "500GB", "1.5 TB", "250 MB" still parse correctly on load.
- **Light-mode dim text** — labels like "Downloaded Groups" in the sidebar were rendered in `#65737E` on a `#F4F4F5` background, which barely passed contrast and needed hover to read. Bumped `.text-tg-textSecondary` to `#4B5563` (Tailwind gray-600) in light mode for headers and footer captions.
- **Borderless inputs in both themes** — `.tg-input` was declared `border: none` in dark mode and only `<input>` (not `<select>`) got a light-mode border, so dropdowns blended into their card background. Added a subtle 1 px border in dark mode (`#38444D`, hovers to `#4A5C6E`, focuses to the brand blue) and broadened the light-mode rule to cover both inputs and selects.
- **`.tg-btn-secondary` had no base CSS in dark mode** — the class was used on dozens of buttons (Save credentials, Export, Resync, Restart, log View/Copy/Download, Backfill presets, Remove account, …) but only had a light-mode override. Dark-mode buttons fell back to the browser default and looked broken. Added a proper base style (panel-grey background, subtle border, hover + active + disabled states) and tightened the light-mode override to match.

### Fixed — backend
- **Schema migrations now smoke-tested at boot.** The `ALTER TABLE ADD COLUMN` migrations were wrapped in `try/catch` to ignore "column already exists", which also swallowed real failures (out-of-disk, locked DB, corrupt schema). A `SELECT pinned, pending_until, rescued_at, ttl_seconds, file_hash FROM downloads LIMIT 0` after the migration block forces "no such column" failures to surface at boot instead of mid-download.
- **Graceful shutdown** on `SIGTERM` / `SIGINT`. Stops the integrity sweep, rescue sweeper, disk rotator, monitor, and keep-alive ping; closes every WebSocket with code 1001; drains the HTTP server. Hard-exit safety net at 5 s. Makes `docker compose restart` snappy and stops phantom WS reconnect attempts during the bounce.
- **`/api/maintenance/logs/download` realpath check.** Basename filter alone could be tricked by a symlinked log entry on case-insensitive FS; now both sides are resolved with `fs.realpathSync` and compared against `LOGS_DIR`.
- **`/api/maintenance/resync-dialogs` batched in a single transaction** instead of N `UPDATE` statements between every async `resolveEntityAcrossAccounts` call. Avoids WAL contention with concurrent gallery readers.
- **Keep-alive FloodWait surfaced.** The `Api.PingDelayDisconnect` catch was silent — a throttled DC kept getting pinged, digging the FloodWait deeper. Now logs once per account per 5-minute window when the failure is FloodWait, and clears the warn cache once a ping lands cleanly.
- **Monitor delete-event errors logged.** `handleDeleteEvent` failures (DB locked, FloodWait, missing row) used to vanish into a silent catch — the rescue panel never learned why a "rescued" badge didn't appear. Now warns to the console.

### Added — i18n
- **7 keys that the code referenced but were absent from the locale files** (rendered as raw key strings or fallback text in the UI): `backfill.row.cancel_title`, `purge.all.title`, `purge.all.title2`, `purge.group.title`, `settings.size.total_disk_help`, `viewer.bulk.title`, `viewer.delete.title`.
- **Thai locale fully humanized.** All 591 strings rewritten in natural conversational Thai instead of stiff machine-translation tone. Tech terms (`monitor`, `queue`, `download`, `session`, `proxy`, `worker`, `dashboard`, `cookie`, `Stories`, `Backfill`, `FloodWait`, `gramJS`, `Maintenance`, `Rescue`, `VACUUM`, …) kept in English where that's how Thai users actually say them. Confirmations made direct, help text rewritten in a friendly explanatory tone, possessive `ของคุณ` spam removed, every `{placeholder}` token preserved.

## [2.3.1] — 2026-04-28

### Added
- **In-dashboard update notifier.** New `GET /api/version/check` (public) polls `api.github.com/repos/.../releases/latest`, caches the result for 6 h server-side, and degrades fail-soft (last-known-good cache served on transient errors; cold-start unreachable returns `updateAvailable:false` rather than blanking the UI). The status-bar shows a clickable **"Update available → vX.Y.Z"** pill linking to the release page when the latest tag is newer than the running version (semver-numeric compare, pre-release suffix ignored). Per-version dismiss button writes to `localStorage` so the same release is never re-nagged; a per-session toast fires once so users notice on first load even if the chip is offscreen on a narrow viewport.
- **i18n keys.** `update.available`, `update.toast`, `update.click_for_release`, `update.dismiss` (en + th lockstep).

## [2.3.0] — 2026-04-28

A large quality-of-life release. Web dashboard learns to do every CLI op, the download pipeline self-heals, and four new top-level surfaces ship.

### Added — major features
- **Queue page** (`#/queue`) — IDM-style download manager. Sortable + filterable table of every job (Active / Queued / Paused / Failed / Done) with per-row pause / resume / cancel / retry, global pause-all / resume-all / clear-finished, throttle slider (max 50 MB/s), virtualised render handles 1000+ jobs without lag. WS-driven; survives a tab reload via `data/queue-history.json`.
- **Backfill page** (`#/backfill`) — promoted from a panel-buried-in-modal to a first-class surface. Three cards: active jobs (live progress + cancel), start-a-new-backfill (group picker + preset chips 100/1k/10k/All/custom), recent jobs (last 30 days). Deep-linkable per-group via `#/backfill/<groupId>`. Cancel actually aborts the in-flight gramJS download (mid-stream throw + .part cleanup), not just dequeues.
- **Rescue Mode** — per-group option that keeps only messages deleted from Telegram source within a retention window. New DB columns `pending_until` + `rescued_at`, monitor subscribes to `UpdateDeleteChannelMessages` + `UpdateDeleteMessages` across every connected account, sweeper auto-prunes anything still on Telegram after the window. Per-group override of the global default.
- **Maintenance panel** (Settings) — CLI-free ops surface: resync Telegram dialogs, restart monitor, DB integrity check + VACUUM, view + download log files in-browser, view raw `config.json` as a collapsible JSON tree, export a Telegram session string (password-gated, blurred until reveal, auto-clears in 60 s), sign-out-everywhere, force file-integrity verify. Web-only password reset flow (token printed to `docker logs` on a fresh container).
- **PWA support** — `manifest.webmanifest` + service worker + install prompt. Add-to-home-screen on mobile, Install button on desktop Chrome/Edge. SW caches the app shell + bypasses `/api/*`, `/files/*`, `/photos/*`, `/metrics`, `/ws`, and the auth pages.
- **Auto-rotate** — disk quota sweeper. When `diskManagement.maxTotalSize` is exceeded, deletes oldest unpinned downloads first. Runs every `sweepIntervalMin` (default 10 min). Toggle in Settings → Size Limits.
- **Settings → Advanced** — 14 hot-path constants surfaced as runtime-configurable settings (downloader concurrency limits, history backpressure cap + break intervals, disk-rotator batch size, integrity sweep interval, web session TTL, …). Defaults preserve existing behaviour.

### Added — operational
- **Status-bar version chip** ("v2.3.0 · sha7") at the bottom-right, links to the matching commit on GitHub. Auto-bumps on every CI push (`docker build --build-arg GIT_SHA=…`).
- **Self-healing downloads.** `downloader.js` re-stats the final file after `fs.rename` and retries on 0-byte / missing files (NFS quirks, mid-write crash). Boot-time + hourly integrity sweep walks every `downloads` row and drops the ones whose file is gone. `/files/*` 404s also background-prune the matching DB row by exact `file_path` match.
- **Monitor auto-start on container boot** when at least one account is loaded and at least one group is enabled. Opt out via `monitor.autoStart: false`.
- **Keep-alive ping** every 60 s (`Api.PingDelayDisconnect` with 90 s extension) to stop the per-DC reconnect cascade that used to fill `network.log` to multi-MB sizes.
- **`network.log` rotation** at 5 MB per file, 2 generations kept (10 MB cap total). No log lines ever skipped — only rotated.
- **`/api/version`** (public) — `{ version, commit, builtAt }` for the status-bar chip + bug reports.
- **`/api/queue/*`** — snapshot, per-job pause/resume/cancel/retry, global pause-all/resume-all/cancel-all/clear-finished, throttle save.
- **`/api/maintenance/*`** — resync-dialogs, restart-monitor, db/integrity, db/vacuum, files/verify, logs (list + download), config/raw, session/export (password-gated), sessions/revoke-all (password-gated).
- **`/api/rescue/stats`** — pending / rescued / cleared counters for the Settings panel.

### Added — UI/UX polish
- **Themed `confirmSheet` + `promptSheet`** primitives in `sheet.js` — every native `confirm()` / `alert()` / `window.prompt()` in the SPA replaced with focus-trapped, drag-dismissible, brand-styled dialogs.
- **Per-row settings cog** in the Downloaded Groups sidebar — one tap into Group Settings.
- **Header view-mode toggle** cycles grid → compact → list, persisted in localStorage.
- **Telegram-style chat avatar** in the page header, mirrors the sidebar's avatar+initial when entering a group.
- **Light-theme polish** across every newer panel (Queue, Backfill, Rescue, Maintenance, sheets, status bar).
- **Tg-toggle** bumped from 36×20 → 44×24 with a soft thumb shadow.
- **Total-Disk input** is a free-form text box with datalist suggestions (50GB → 10TB) instead of a 5-option dropdown.
- **In-browser log viewer** (`<pre>` with auto-scroll-to-bottom + Copy + Download fallback).
- **Collapsible JSON tree** for raw config.json with Expand/Collapse-all + Copy.
- **Session-export blur shield** — string is `blur-sm` until the user clicks Reveal; auto-clears in 60 s; manual Clear button; red-tinted warning card.

### Added — i18n
- **bilingual coverage** (English + Thai) brought from 65 keys at v2.1 → 580 keys at v2.3, every interactive surface routed through `i18nT()` / `i18nTf()` (interpolation helper). en/th key parity enforced in CI smoke + audit agents.

### Fixed — security
- **`_requirePassword` bypass**. `loginVerify` returns `{ok, upgrade?}`, NOT a bare boolean. The previous `!loginVerify(...)` check made any non-empty string a valid password on Export Session and Sign-out-everywhere — a full account-takeover vector for anyone with a session cookie. Now reads `result?.ok` like every other call site.
- **Password-gate** on Export Session + Sign-out-everywhere — even with a valid cookie, the user has to retype their dashboard password. Mitigates session-hijacker abuse.

### Fixed — correctness
- **"Unknown chat" leaking everywhere.** Server-side `bestGroupName(id, configName, dbName, dialogsName)` resolves in priority: live Telegram dialogs cache → config → DB → "Unknown chat (#id)" placeholder. SQL `MAX(group_name)` was returning the literal string "Unknown" because it sorts above most ASCII titles — CASE-filtered before MAX. Live `getDialogsNameCache()` shares the same source as the Browse-chats picker (5 min TTL, 5 min cache for full `/api/dialogs` body).
- **Filter → viewer wrong file**. Tile data-index pointed into the filtered list; viewer indexed `state.files[idx]` (unfiltered). Photos-filter + click photo #3 was opening a video. Now passes `originalIndex` + filter-aware prev/next.
- **Filtered-list-aware prev/next** in the viewer, double-tap-left/right to seek ±10 s on mobile.
- **Search-input dead handler** — was selecting `.group-item` (renamed to `.chat-row` long ago).
- **Bottom-nav Engine highlight** — tab lit up Settings instead of Engine; new `navKey` override on `renderPage`.
- **`/api/downloads/search` shadowed** by `/api/downloads/:groupId` — the catch-all route was matching first; now short-circuits on `groupId === 'search'`.
- **Browser notification dead handler** — runtime broadcast spreads inner type so the outer `monitor_event` envelope never reached subscribers; switched to `download_complete` directly.
- **Gallery ghost tiles** after auto-prune / disk-rotate / rescue-sweep — `file_deleted` WS handler now drops the matching tile + refreshes stats.
- **Atomic config writes** — every `fs.writeFile(CONFIG_PATH, …)` (9 callsites) routed through `writeConfigAtomic(config)`. Previously a crash mid-write left a corrupt config.

### Fixed — Docker / deployment
- **`Cannot find module '/app/src/web/server.js'`** at runtime — `chmod -R a+rX /app` between mkdir and chown in the Dockerfile (BuildKit on Windows hosts was laying down mode-0 layers).
- **Bind-mounted `/app/data` permissions** — entrypoint now runs as root, `chown -R node:node /app/data`, then `su-exec` drops to node before exec'ing the CMD.
- **Stale local images** — compose defaults to GHCR `:latest` with `pull_policy: always`; local dev can still build from source by uncommenting `build:`.
- **CI smoke test** verifies the built image actually runs (file perms, healthcheck within 30 s, app process running as `node` not root).

### Fixed — performance
- **Video playback lag** — `/files/*` cache bumped from 60 s → `private, max-age=2592000, immutable` (downloaded files are content-immutable). Browser stops revalidating every 64 KB range chunk through the auth + path-resolve pipeline.
- **Per-request config disk-read** — `readConfigSafe()` memoised for 2 s. During a video playback, force-https + checkAuth no longer disk-read on every range chunk.
- **Sidebar flicker** on WS bursts — cache `_lastHtml` and skip the `innerHTML` reassignment when nothing changed.
- **`/api/monitor/status` polling** consolidated behind one shared module (was duplicated 3× across modules); cadence dropped from 3 s → 30 s safety net (WS handlers cover the active updates).
- **`/api/stats`** throttled from 15 s → 60 s + WS-driven refresh on every `download_complete` / `file_deleted` / `bulk_delete` / `purge_*`.
- **Login + setup brute-force limiters** stay on regardless of the global rate-limit toggle.

### Changed
- **API rate limit toggle** — now opt-in (default off) for self-hosted private dashboards. Previous 600/min default was masking real load as 429s on chatty SPAs.
- **`force HTTPS`** is opt-in, default off.

### Removed
- Inline `confirm()` / `alert()` / `window.prompt()` calls in the SPA — every callsite now routes through the themed sheet primitive.

## [2.2.0] — 2026-04-27

### Added — observability
- **`GET /metrics`** — OpenMetrics / Prometheus 0.0.4 text format. Zero-dep collector in `src/core/metrics.js` fed by `src/core/runtime.js` events. Counters for downloads / failures / history jobs / URL + Stories pulls / login outcomes; gauges for queue depth, active downloads, workers, accounts, monitor state; histogram for download duration; standard `process_*` gauges. Endpoint registered before the auth middleware so a scrape job without a session cookie still reaches it. Optional `?token=…` gating via `TGDL_METRICS_TOKEN`.

### Fixed
- **Docker: `Cannot find module '/app/src/web/server.js'`** at runtime. Two compounding causes:
  1. **Mode-0 COPY layers.** BuildKit (Windows hosts and some gha-cache hits) was laying down `/app/src/*` and `/app/scripts/*` with mode `0` — `node` user owned the files but had no read permission, so Node returned ENOENT-shaped errors on EACCES traversal. Fixed by `chmod -R a+rX /app` between mkdir and chown in the Dockerfile.
  2. **Stale local images.** `docker compose up` reused locally-cached `telegram-media-downloader:latest` from a prior build instead of pulling fresh. The compose file now defaults to the prebuilt GHCR image (`ghcr.io/botnick/telegram-media-downloader:latest`) with `pull_policy: always` — `docker compose up -d` always grabs the current release. Local dev can still build from source by uncommenting `build:`.
- **`Telegram connection failed: ENOENT … data/config.json`** on every first boot. `connectTelegram()` blindly read `config.json` before the user had set anything up. It now returns silently when the file is missing or has no `apiId` / `apiHash`, and only logs a real error for non-ENOENT failures. The boot banner is also state-aware now: "First run? Open …" / "Open … and run `npm run auth` …" / "Sign in at …" depending on setup state. Banner reads the version from `package.json` directly so it shows the real version even when started with bare `node src/web/server.js`.

### Operational
- **CI smoke test for the Docker image.** `.github/workflows/docker.yml` now runs the freshly-built image, verifies file permissions are sane, and polls the in-container healthcheck for 30 s. A green build now means the image actually boots — not just that the Dockerfile parses.
- **Dockerfile cleanup.** Dropped `ENV TGDL_RUN=monitor` (only `runner.js` reads it; CMD runs `server.js`) and `COPY watchdog.ps1` (PowerShell script, unusable in Alpine).

## [2.1.0] — 2026-04-26

### Added — UI/UX overhaul (Telegram-grade desktop + mobile)
- **Hash router** with deep-linking (`#/viewer`, `#/groups/<id>`, `#/settings/<section>`, `#/stories`, `#/account/add`). Browser back/forward + URL share work everywhere.
- **Sheet primitive** — bottom-sheet on mobile (drag handle + swipe-to-dismiss), centered card on desktop. Drives shortcuts, destination picker, paste-link, stories, FAB action sheet. Focus trap + Esc-closes-topmost.
- **Mobile bottom navigation** (Library / Chats / Engine / Settings) replaces drawer-only switching at `< 768px`.
- **Floating action button** opens a Quick-Actions sheet (paste link, stories, add account, browse chats).
- Sidebar breakpoint moved from `lg` → `md` so 768–1023px ranges no longer get a cramped sidebar.
- **Telegram-style chat rows** for sidebar groups + dialog picker — avatar 48 px, bold name, last-activity subtitle, time-on-right, status pill, "selected chat" left bar.
- **Story-ring avatars** — animated conic-gradient ring around groups currently downloading; green status dot when monitoring; clears on `monitor_state=stopped`.
- **Gestures**: long-press in gallery enters select mode; pull-to-refresh on the viewer; swipe ←/→ between items in the modal viewer; vertical drag-down dismisses the viewer.
- **Time-grouped gallery** sections (Today / Yesterday / Earlier this week / Older) with sticky headers.
- **Skeletons** in the gallery and sidebar while data loads — no more empty/spinner pages.
- **i18n** with English + ไทย locales; Settings → Appearance → Language picker (Auto / English / ไทย); persisted in localStorage and applied without reload.
- A11y: real `aria-label` on every icon-only button (translatable), `min-h/w-[44px]` touch targets, `:focus-visible` Telegram-blue outline, `role="switch"` + Space/Enter on every `.tg-toggle`, `prefers-reduced-motion` respected for transitions and ring animation.
- Status bar hidden on mobile (where the bottom nav is the source of truth).

### Fixed
- Sidebar rows showing `Unknown · -1003666421064` with no avatar. PUT `/api/groups/:id` and `downloadProfilePhoto` now resolve via the multi-account `AccountManager` (with the legacy single-session client as a last-resort fallback). New endpoint `POST /api/groups/refresh-info` walks every config + DB-only group and back-fills the real name and cached profile photo. The SPA auto-fires it whenever it detects a placeholder name.
- CSP `script-src-attr 'none'` had been blocking the inline `onclick`/`oninput` handlers in `index.html` (toggles, range sliders, modal close). Added `script-src-attr 'unsafe-inline'` so the existing markup keeps working until the Phase 4 follow-up migrates handlers to `addEventListener`.

### Changed
- `npm start` (and the bare `node src/index.js`) now boots the dashboard directly instead of dropping into the interactive CLI menu. The legacy menu is reachable via `npm run menu` for headless / power-user workflows.
- `runner.js` / `watchdog.ps1` already default to `monitor`; this release also adds a POSIX `runner.sh` (Linux/macOS).

### Operational
- `.github/workflows/telegram-notify.yml` rewritten — fires on both `push` to `main` and `release.published`. Pre-releases get a 🧪 badge, release notes are HTML-escaped + length-trimmed for Telegram's parser.
- `release-drafter` + Conventional-Commits autolabeler land via `.github/workflows/release-drafter.yml` + `.github/release-drafter.yml`. The next release notes draft themselves from merged PRs.

## [2.0.0] — 2026-04-26

### Added — security
- Web dashboard auth refactor: scrypt-hashed passwords (per-password random salt), random session tokens persisted to `data/web-sessions.json`, `crypto.timingSafeEqual` everywhere.
- **Fail-closed by default**: a fresh install no longer falls through to "open access" if no password is set — every API call returns 503 and every page redirects to a setup wizard.
- WebSocket upgrade handshake validates the same session cookie as REST.
- `helmet`, `express.json({limit:'256kb'})`, `express-rate-limit` on `/api/login` (10 / 15-min / IP).
- Path safety on `/api/file` and `/files/*`: NUL-byte rejection, `path.normalize`, `fs.realpath` symlink check, default `Content-Disposition: attachment`.
- Per-blob random scrypt salt for AES session storage (wire format v=2, v=1 still decrypts).
- LICENSE, SECURITY.md, vulnerability disclosure policy.
- `docs/AUDIT.md` — full 166-finding audit with severity table.

### Added — web parity
- First-run password setup + change-password flow entirely from the browser; CLI is no longer required for security setup.
- 4-step web wizard for adding Telegram accounts (label → phone → OTP → 2FA).
- Account list / remove from Settings → Telegram Accounts.
- `/api/monitor/{status,start,stop}` + Settings → Engine card with live state, queue, active workers, uptime.
- History backfill from the Group settings modal (one-tap 100 / 1k / 10k).
- Dialogs picker covers archived chats and (opt-in) DMs.

### Added — features
- **Download by Link** (`POST /api/download/url`): paste any `t.me/.../<msg>`, `/c/<id>/<msg>`, `/c/<id>/<topic>/<msg>`, `tg://resolve`, or `tg://privatepost` URL and pull just that media.
- **Telegram Stories**: username + per-story selection, queued through the regular downloader.
- **TTL/self-destructing media**: monitor detects `media.ttlSeconds` and front-loads the queue so the file is captured before expiry.
- **Forum topics**: per-group filter list with whitelist mode.
- **Proxy** (SOCKS4/5 + MTProxy) wired into the GramJS client; Settings UI with TCP-reachability test.
- **Light / Dark / Auto theme** with OS-detected default, persisted in localStorage.
- **Browser notifications** opt-in for download-complete events.
- **Sticky status bar**: monitor state, queue, active workers, total files, disk usage, WS link.
- **Gallery search + multi-select + bulk delete**, including server-side `searchDownloads()`.

### Added — engine
- Dual-lane queue (`_high` realtime + `queue` history) — realtime no longer competes with backfill; spillover only displaces history.
- `core/runtime.js` singleton orchestrates monitor + downloader + forwarder in-process for the web server.
- WebSocket client (`ws.js`) with auto-reconnect and visibility-aware backoff.
- Connection manager `stop()` + monitor cleanup tracking; intervals are `unref`-ed so the process can exit cleanly.
- Backpressure max-wait in history (5 minutes) so a stuck downloader can't hang the command forever.

### Changed
- `runner.js` and `watchdog.ps1` now read `TGDL_RUN` env (default `monitor`) instead of hard-coding `history` — production supervision actually keeps a long-running process alive.
- gramJS internal noise (`TIMEOUT`, `Not connected`, `Reconnect`, etc.) is now classified instead of silently dropped: it logs to `data/logs/network.log` and only surfaces in stderr when `TGDL_DEBUG=1`.

### Fixed
- Terminal raw-mode is restored on `exit` / SIGINT / SIGTERM — no more dead shells on crash.
- Plaintext apiId no longer printed at CLI startup.
- `.gitignore` malformed line removed; `docs/` is now tracked.
- Orphan `src/index.js_fragment_setupWebAuth` deleted.

### Migration notes
- Old `config.web.password` (plaintext) is auto-rehashed to `config.web.passwordHash` on first successful web login.
- Old AES blob format (`v=1`) keeps decrypting; new writes are `v=2`.
- Existing `data/db.sqlite` is migrated forward automatically — `ttl_seconds` and `file_hash` columns are added on first start.

## [1.0.0]

Initial public version. See `git log v1.0.0` for the per-commit history.
