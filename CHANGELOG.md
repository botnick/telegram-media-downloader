# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.22.2] — 2026-05-23

Explicit sidecar mode controls — test before switching, switch back with one click.

### Changed
- **Use External / Use Local buttons** — entering a sidecar URL no longer auto-switches on blur. Test the connection first, then click "Use External" to apply. "Use Local" button appears when external is active for easy rollback.

### Service worker
- `VERSION = 'v2222'`

## [2.22.1] — 2026-05-23

External sidecar performance fix — eliminates wasted round-trips on cross-machine deployments.

### Fixed
- **Faces/NSFW b64 fast-path** — after the first `path_not_allowed` rejection, all subsequent files go directly to b64 upload instead of trying path mode first. Cuts per-file latency in half on external sidecar setups (Cloudflare Tunnel, cross-machine).
- **Batch detection skip** — `detectFacesBatch` and `classifyBatch` skip the batch path request entirely when path mode is already known to fail.
- **Log spam** — "path mode rejected" logged once per session instead of per file.

### Removed
- **Seekbar external config** — removed `seekbar.sidecarUrl` / `apiToken` from config defaults, settings UI collect/populate, and `/api/maintenance/seekbar/sidecar-test` endpoint. Go binary requires shared filesystem; Docker env `SEEKBAR_SIDECAR_URL` still works for compose setups with shared volumes.

### Service worker
- `VERSION = 'v2221'`

## [2.22.0] — 2026-05-23

Web-configured external sidecar overrides Docker env + mode indicator.

### Added
- **Sidecar mode badge** — AI page badge now shows 🌐 External / 🐳 Docker / 💻 Local so operators know exactly which sidecar path is active.
- **`/api/ai/status` mode field** — faces model payload includes `mode` from `getSidecarStatus()`.

### Changed
- **Web sidecar URL overrides Docker env** — `config.advanced.ai.faces.sidecarUrl` (set from dashboard) now takes priority over `FACES_SERVICE_URL` env var, so operators can switch to an external GPU sidecar without touching Docker config.

### Removed
- **Seekbar external sidecar UI** — Go binary requires shared filesystem (path-based, no upload/b64 fallback). Seekbar still works via Docker volume, NFS mount, or local auto-spawn.

### Service worker
- `VERSION = 'v2220'`

## [2.21.1] — 2026-05-23

Sidecar reliability fixes for external GPU deployments.

### Fixed
- **Faces sidecar Windows crash** — monkey-patch insightface `print()` calls that throw `WinError 1` when stdout is redirected (covers both `download()` and `download_onnx()`).
- **Seekbar corrupt video retry loop** — permanently-failed videos (no stream, invalid NAL, moov not found) now get a `format='failed'` marker row in `seekbar_sprites` so bulk scans skip them instead of retrying endlessly.
- **Seekbar failed row completeness** — all 15 fields populated in the permanent-fail upsert.

### Service worker
- `VERSION = 'v2211'`

## [2.21.0] — 2026-05-23

Seekbar sidecar web config, categorized sidebar, queue NSFW badge, dedup perf.

### Added
- **Seekbar sidecar URL** configurable from dashboard (Maintenance > Seekbar) with API token support and Test button.
- **Categorized sidebar** — groups list organized by type (Channels / Groups / DMs / Bots / Folders) with monitored-first sort and collapsible sections.
- **Queue "NSFW Blocked" badge** — files auto-deleted by the NSFW hash blocklist now show a distinct red badge instead of the generic "Duplicate" label.
- **Queue filter chip** "NSFW Blocked" for filtering blocklist deletions.

### Changed
- **Dedup scan 4× faster** — hash page size 50→200, progress fires every 10 files, grouping stage shows determinate progress bar.
- **`_refreshSummary()` O(1)** — uses Set instead of Array.includes for selected-file byte counting.
- **Set building** yields every 25 instead of 50 for quicker feedback.

### Fixed
- **Seekbar API token** now passed in health-test connection probe.
- **Seekbar ffmpeg retries** — permanent errors (no video stream, invalid NAL, moov not found) skip retry immediately.
- **Tab bar chip spacing** — `:first-of-type` CSS selector replaced with adjacent-sibling rule that actually matches toggle chips.
- **Avatar 404s** — non-numeric group IDs (folders, `unknown:*`) skip photo fetch, show gradient initials directly.
- **Sidebar search + collapsed sections** — search finds groups inside collapsed sections; separators hide per-section instead of globally.
- **Removed sidebar search-input** — cleaned up `#search-input`, its listeners, and the focus_search shortcut.

### Service worker
- `VERSION = 'v2210'`

## [2.20.0] — 2026-05-23

External AI sidecar — offload face detection and NSFW classification to a remote GPU server.

### Added
- **External sidecar URLs** configurable from the web dashboard — face detection (Maintenance > AI > System Health) and NSFW classification (Maintenance > NSFW settings).
- **NSFW HTTP client** (`src/core/nsfw-client.js`) — mirrors the faces-client pattern with retry, b64 fallback, cached health probe.
- **NSFW sidecar routing** in `nsfw.js` — when `sidecarUrl` is set, classification routes to the external service; falls back to local WASM when empty.
- **Standalone NSFW sidecar** (`nsfw-service/`) — FastAPI + transformers + torch with GPU auto-detect. Dockerfile included.
- **Health-test proxy endpoints** — `POST /api/ai/faces/health-test` and `POST /api/maintenance/nsfw/sidecar-test` for CORS-safe connection testing from the browser.
- **Env var** `TGDL_NSFW_SIDECAR_URL` — mirrors the faces-service pattern for Docker/k8s deployments.

### Fixed
- **SSRF protection** on health-test endpoints — rejects non-http(s) URL schemes.
- **NSFW background classifier** respects `cfg.enabled=false` even when a remote sidecar URL is configured.

### Service worker
- `VERSION = 'v2200'`

## [2.19.6] — 2026-05-15

Deferred file deletion + unified cleanup across all 15 delete paths.

### Added
- **Deferred file deletion** (`src/core/deferred-delete.js`) — `deferDelete()` renames media files to `downloads/.deleted/<uuid>` instantly (same-filesystem atomic move), then `startDrain()` walks the directory async in the background. Boot recovery picks up leftovers.

### Fixed
- **Unified all 15 delete paths** to the same pattern: deferDelete → DB delete → purge thumbs → purge seekbar → purgeOrphanPeople → drain. Previously only 3 paths had full cleanup.
- **5 missing `purgeOrphanPeople` calls** added (gallery bulk delete, disk rotator, rescue sweep, cluster dedup, cluster cross-delete).
- **WS frame overflow on large deletes** — `bulk_delete` broadcast sends `count` instead of full ids array; dedup done payload strips duplicateSets via non-enumerable property.
- **JSON body limit** raised from 256 KB to 2 MB so bulk deletes of 50K+ ids don't fail.
- **CLI purge-all** photo delete crash (bare `unlinkSync` without try/catch).
- **`.deleted` directory** excluded from reindexFromDisk + boot `.part` cleanup scans.

### Service worker
- `VERSION = 'v2196'`

## [2.19.5] — 2026-05-15

Cancel responsiveness + dedup unlimited sets.

### Fixed
- **Seekbar cancel hangs** — bulk scan now uses async sidecar mode so cancel takes effect immediately instead of waiting for the current ffmpeg sprite to finish (could block minutes on large videos).
- **Faces scan cancel hangs** — abort signal forwarded through `detectFacesBatch` and `detectFacesInVideo` HTTP calls so in-flight sidecar requests are aborted on cancel.
- **Seekbar signal chain** — abort signal propagated from JobTracker through scan-runner → generator → client → fetch, with pre-flight `signal.aborted` check before ffprobe.

### Changed
- **Dedup scan no longer capped at 500 sets** — returns all duplicate sets found, sorted by reclaimable space.

### Service worker
- `VERSION = 'v2195'`

## [2.19.4] — 2026-05-15

People card cleanup, GitHub-style changelog viewer.

### Changed
- **People card** — replaced 3 separate corner badges (face count, video icon, quality) with a single bottom-center info pill (`34 · 🎬 · MQ`). Cleaner, easier to read at a glance.
- **Changelog viewer** — full GitHub-style markdown rendering: nested lists, tables, fenced code blocks, horizontal rules, styled headings. 58 previously-hidden indented items now render correctly.

### Service worker
- `VERSION = 'v2194'`

## [2.19.3] — 2026-05-15

DB performance, sidecar GPU optimization, boot cleanup, dedup hardening.

### Added
- **DB composite indexes** — `idx_gallery_group_date` and `idx_gallery_pinned_date` cover all gallery ORDER BY patterns; EXPLAIN shows SEARCH instead of SCAN.
- **DB pragmas** — `cache_size = -64000` (64 MB page cache) + `temp_store = MEMORY` (RAM temp tables) per better-sqlite3 best practices.
- **Dedup "Delete all extras"** — one-click bulk delete keeping oldest or newest per set, with confirm + progress bar.
- **Filename+size dedup layer** — `fileAlreadyStored()` fallback in `registerDownload()` catches re-posts when first row has no hash.
- **Boot `.part` cleanup** — purge orphaned `.part` files from crashed downloads on startup; monitor catch-up re-downloads automatically.
- **5 new DB tests** — pinned NULL backfill, pinnedOnly, pinnedFirst, getOldestDownloads skip-pinned, getStats shape.

### Fixed
- **`datetime(created_at)` wrapper** removed — ISO-8601 text is lexicographically sortable; SQLite now uses `idx_created_at` directly.
- **`COALESCE(pinned, 0)`** removed (6 spots) — one-time NULL→0 backfill on boot; queries use `pinned` directly with index support.
- **`getStats()` 2 queries → 1** — COUNT + SUM in single statement; called every ~2s.
- **Reindex 0/0 groups** — backend now emits `processed`/`total` fields.
- **NSFW bulk whitelist/unwhitelist/reclassify** — batched 500 items with progress.
- **Integrity size-fixing** — batched 500-row transactions with progress.
- **Reindex picks up `.part` files** — filtered out in both scan paths.

### Changed
- **Seekbar sidecar v0.3.2** — GPU scale filters (`scale_vaapi`, `scale_cuda`) replace `hwdownload` + software scale; ~45x less PCIe transfer per frame. Thread cap `NumCPU / concurrency` prevents oversubscription.
- **Faces sidecar v0.3.2** — batch endpoint processes files in parallel via `ThreadPoolExecutor` instead of sequential loop; ~2-4x throughput on GPU.
- **Faces scan runner** — sends parallel chunk requests instead of one sequential batch.

### Service worker
- `VERSION = 'v2193'`

## [2.19.2] — 2026-05-15

Dedup scan non-blocking, filename dedup, bulk-delete all, progress feedback audit.

### Added
- **Dedup "Delete all extras"** — one-click bulk delete keeping oldest or newest copy per set, with confirm dialog and live progress bar.
- **Filename+size dedup layer** — `fileAlreadyStored(group, name, size)` fallback in `registerDownload()` catches re-posts when the first row has no hash yet.

### Fixed
- **Dedup GROUP BY blocks event loop 3-15s on 1M rows** — replaced single GROUP BY with paginated scan (5 000 hashes/page, yield between pages). Dashboard stays responsive throughout.
- **Reindex shows 0 / 0 groups** — backend emitted `scanned`/`groups` but frontend read `processed`/`total`; added the missing fields.
- **NSFW bulk-whitelist/unwhitelist/reclassify no progress** — split into 500-item batches with `processed`/`total` progress events.
- **Integrity sweep size-fixing blocks without progress** — split single transaction into 500-row batches with progress between each.

### Service worker
- `VERSION = 'v2192'`

## [2.19.1] — 2026-05-15

Monitor state resume on restart + dedup scan responsiveness fix.

### Added
- **Monitor auto-resume** — start/stop now persists `monitor.autoStart` to config so the monitor resumes its last state on restart. Graceful shutdown preserves the flag.

### Fixed
- **Dedup scan freezes dashboard** — the grouping phase (GROUP BY + 500 set-building queries) blocked the event loop without yielding; added `setImmediate` yields before/after the heavy query and every 50 sets so WS progress events flush to the browser.

### Changed
- **Vitest config** — added `vitest.config.js` to exclude `.claude/worktrees` from test discovery (stale worktree copies caused port conflicts on cluster e2e tests).

### Service worker
- `VERSION = 'v2191'`

## [2.19.0] — 2026-05-14

Video duration badges, pin icon refresh, monitor auto-start default change.

### Added
- **Video duration on gallery tiles** — YouTube-style `1:23` badge on video thumbnails. Duration sourced from `seekbar_sprites` via LEFT JOIN; available on all three gallery endpoints (all / group / search).

### Changed
- **Pin icon** reverted to `ri-pushpin-2-fill` / `ri-pushpin-2-line` (was `ri-map-pin-*`).
- **Monitor auto-start** now defaults to off — operators must click Start or set `monitor.autoStart: true` in config.

### Service worker
- `VERSION = 'v2190'`

## [2.18.13] — 2026-05-14

Dedup scan/delete performance fix for large libraries + comprehensive related-data cleanup on all delete paths.

### Fixed
- **Dedup scan hangs on 100k+ files** — added `idx_file_hash` and `idx_unhashed` partial indexes on `downloads`; the grouping query now uses an index-only scan instead of a full table scan (~100× faster on large libraries).
- **Dedup delete hangs on Docker** — `deleteByIds` called `resolveStoredPath` twice per file (6 stat calls each on bind mounts); merged into a single pass (3 stat calls), halving I/O.
- **Seekbar sprite files orphaned on every delete path** — FK CASCADE deleted the `seekbar_sprites` DB row before `purgeSeekbarForDownload` could read the file paths; all 10 delete paths now pre-fetch paths before the CASCADE fires.
- **Orphan `people` rows after dedup/NSFW/integrity deletes** — `purgeOrphanPeople()` was only called from `deleteDownloadsBy`; now runs after every bulk-delete path that bypasses it.
- **Missing thumb/seekbar cleanup** on single-file delete, integrity sweep, cluster cross-delete, cluster sweep, auto-prune on 404, and recovery group purge.

### Service worker
- `VERSION = 'v21813'`

## [2.18.12] — 2026-05-13

Docker build fix — missing CHANGELOG.md whitelist.

### Fixed
- **Docker build failure** — `CHANGELOG.md` was excluded by the `*.md` glob in `.dockerignore`; added the negation so the COPY directive finds the file.

### Service worker
- `VERSION = 'v21812'`

## [2.18.11] — 2026-05-13

NSFW settings persistence fixes — three fields silently ignored by the save path.

### Fixed
- **NSFW blocklist toggle** not saved from the Maintenance → NSFW page (autosave payload was missing `blocklistEnabled`).
- **NSFW preload-on-boot** never fired — `_nsfwCfg()` didn't return `preload`, so the startup check always saw `undefined`.
- **NSFW video tiles** setting ignored — `_nsfwCfg()` didn't return `videoMaxTiles`; scans always used the default 48.
- Added server-side validation for `preload` (boolean coerce) and `videoMaxTiles` (`clampInt 3–200`).

### Service worker
- `VERSION = 'v21811'`

## [2.18.9] — 2026-05-13

File-access bearer tokens, iOS Safari fullscreen, viewer light-mode contrast, and pin icon refresh.

### Added
- **`GET /api/files/token`** — mints a short-lived HMAC-signed bearer token for `/files/` paths. Append `?token=<exp>.<sig>` to any file URL to authenticate without a session cookie — enables Cloudflare redirect-to-DDNS workflows. 1-hour TTL, auto-refreshed by the SPA.
- **PWA install feedback** — tapping the install button now shows a toast with platform-specific guidance when the browser doesn't support programmatic install (iOS: "Tap Share → Add to Home Screen").

### Changed
- **Pin icon** — switched from pushpin (`ri-pushpin-2-*`) to map-pin (`ri-map-pin-*`). Outline when unpinned, filled when pinned; icon class toggled in JS instead of CSS `content` override.
- **Pin chip hidden for guests** — gallery tiles no longer render the pin button for guest sessions.

### Fixed
- **Video fullscreen on iOS Safari** — falls back to `video.webkitEnterFullscreen()` when the standard Fullscreen API is unavailable. Both the in-player and modal-level fullscreen buttons handle the webkit path, and `webkitbeginfullscreen` / `webkitendfullscreen` events keep the icon in sync.
- **Video controls legibility in light mode** — added `text-shadow` / `drop-shadow` on control buttons and icons; light-mode gradient darkened to 92% opacity floor.

### Service worker
- `VERSION = 'v2189'`

## [2.17.0] — 2026-05-12

Seekbar timeline previews — Netflix/YouTube-style hover thumbnails for the in-app video player, generated by a standalone Go sidecar. Plus the v2.16 AI installer follow-ups and a cluster of busy-DB / config-merge fixes that surfaced on real installs.

### Added
- **Seekbar preview subsystem** — `src/core/seekbar/` Node module plus a standalone Go service (`seekbar-service/`) that generates WebP sprite-sheet timeline previews for every video. Spawned automatically on first use (PyInstaller-style binary released as `tgdl-seekbar-<platform>-<arch>`), or pulled as `ghcr.io/botnick/tgdl-seekbar` via the `docker compose --profile seekbar` profile. Off by default.
- **Maintenance → Seekbar previews** page — master toggle, auto-on-download toggle, KPI strip (indexed videos / disk usage / last scan / ffmpeg status), settings (interval / tile width / columns / quality / format / max tiles / concurrency), hardware acceleration sub-card with provider probe. JobTracker-driven Scan now + Cancel + Wipe cache, mirrors `/maintenance/thumbs` UX.
- **Netflix-style hover preview in the viewer** — `#video-sprite-preview` element with rounded tile, centered time pill, and shimmer overlay for `pending` state (video pre-generation still in flight). `data-state` machine: `ready` / `pending` / `disabled` (feature off or peer-owned row); polling backoff (4s/8s/16s/32s/60s); live refresh via `seekbar_sprite_ready` WebSocket events.
- **Seekbar HTTP API** — `GET /api/seekbar/sprite/:id` + `GET /api/seekbar/meta/:id` for the player, plus 12 admin routes under `/api/maintenance/seekbar/*` (build/cancel/status, rebuild, regen single, list, stats, health, hwaccel-probe, sidecar restart). Full reference in `docs/API.md`.
- **`tgdl-faces-install` auto-detect installer** — `python -m tgdl_faces.install` probes the host (OS, arch, `nvidia-smi`, `/dev/dri`) and `pip install`s the matching onnxruntime EP automatically. Idempotent; flags `--dry-run`, `--force {cpu,gpu,directml,openvino}`, `--no-uninstall`. Wired into the Node spawn fallback so first run on a fresh host pulls the right wheel without operator action.
- **`POST /api/ai/faces/install-deps`** — admin endpoint that streams installer stdout over `ai_faces_install_progress` / `ai_faces_install_done` WebSocket events. Maintenance → AI exposes it via the "Install GPU acceleration" card.

### Changed
- **`POST /api/config` deep-merge** now covers `advanced.seekbar` and `advanced.ai.faces` as first-class namespaces — a partial PATCH preserves sibling keys instead of silently wiping them. Caught when seekbar toggle saves were being dropped because the `merged.advanced` reducer didn't list the new namespace.
- **Maintenance → AI page UI refresh** — header now carries just Cancel + Scan now + a `⋯` overflow menu (Re-cluster · Reindex from scratch · **Manage GPU support**). The install card auto-shows when the sidecar is unhealthy and is reachable on demand from the overflow. Mirrors the Build thumbnails layout for muscle-memory consistency.
- **insightface `estimate_norm` monkey-patched to use `SimilarityTransform.from_estimate`** — replaces the deprecated `SimilarityTransform.estimate` call that emitted a FutureWarning on every detect. Future-proofs against scikit-image 2.2 removing the old API.
- **`/detect` and `/health` access lines no longer flood the dashboard log feed** — `faces-spawn.js` now classifies the sidecar's uvicorn access lines and drops successful 200s; errors and non-2xx still surface verbatim.

### Fixed
- **better-sqlite3 cursor lock during seekbar scan no longer freezes downloads** — `scan-runner.js` paged via `.iterate()` held the connection's exclusive lock across `await` boundaries, blocking the realtime downloader's `kv['queue_history']` writer for minutes. Rewritten as keyset paging (`pageMissingSeekbarVideos` / `pageSeekbarSprites` open-and-close per batch) so the connection is free between rows.
- **Seekbar config changes now reach the running Go sidecar** — `POST /api/config` calls `refreshSeekbarSidecar()` and broadcasts `seekbar_config_changed`, so port / hwaccel / concurrency tweaks take effect without a manual dashboard restart. The viewer also subscribes to invalidate its `enabled` cache.
- **`pregenerateAi` no longer crashes the process on `SQLITE_BUSY`** — the post-download face indexer's `setAiIndexedAt` / `insertFace` writes now run through a busy-aware retry helper (4× with 50 ms backoff). A long-running cluster sweep / dedup `.iterate()` on the same connection used to collide with the UPDATE and surface as `Unhandled rejection: TypeError: This database connection is busy executing a query`. If retries are exhausted the row stays `ai_indexed_at = NULL` and gets re-picked by the next scan.
- **Seekbar settings inputs persisted reliably** — `_gatherScopedPayload('maintenance-seekbar')` now collects every numeric / select input on the page, and `loadAdvanced(config)` hydrates them on mount so reloading the page doesn't show placeholders over saved values.

### Database
- Additive — `seekbar_sprites` table (one row per indexed video; `download_id PRIMARY KEY REFERENCES downloads(id) ON DELETE CASCADE`, sprite + meta paths, duration, frames, cols/rows, tile size, format, bytes, source size/mtime, `generated_at`) + `idx_seekbar_generated_at`. Created lazily on first boot of v2.17.

### Service worker
- `VERSION = 'v2196'` — invalidates shell + asset caches so browsers pick up the new viewer / settings / maintenance modules without a hard refresh.

## [2.16.0] — 2026-05-11

AI subsystem rewrite — face clustering moves to a Python sidecar with multi-platform GPU acceleration. Semantic search and auto-tag were removed (Track J / K cleanup of the v2.15 surface).

### Added
- **Python face-clustering sidecar** (`faces-service/`) — FastAPI + insightface buffalo_l (512-dim ArcFace embeddings). Auto-spawn via prebuilt PyInstaller binary download OR `python -m tgdl_faces` fallback when the host has Python ≥3.10 + deps. Operator opt-out via `TGDL_FACES_AUTO_DOWNLOAD=false`.
- **Multi-platform GPU acceleration** — `pyproject.toml` extras (`[gpu]`, `[directml]`, `[openvino]`) install the matching onnxruntime variant. Docker profiles `faces-cuda` and `faces-openvino` ship pre-built images. Auto-probe + UI dropdown picks the right backend; CPU fallback works everywhere.
- **Hardware probe** — `GET /api/ai/faces/provider-probe` runs a tiny onnxruntime session against every candidate provider; the UI dropdown disables options that don't verify and tags the recommended one with ★.
- **Detector model dropdown** — switch between insightface presets (`buffalo_l` / `antelopev2` / `buffalo_m` / `buffalo_s`) from Maintenance → AI. Change triggers automatic sidecar restart.
- **Reindex from scratch** button — wipes every face detection + cluster and re-scans every photo (gated behind a confirm sheet). Use after swapping the detector model or to clear bad clusters.
- **27 face-config knobs** all overridable via `TGDL_FACES_*` env vars (epsilon, minPoints, detSize, batchSize, providers, timeouts, port range, mirror URLs, etc). Full reference in `docs/AI.md`.

### Changed
- **Master toggle is no longer a hard gate** — clicking "Scan now" or "Re-cluster" auto-enables `advanced.ai.enabled` instead of toasting "Turn on AI subsystem first."
- **People clusters KPI** now reads `peopleCount` (rows in the `people` table) instead of `withFaces` (distinct downloads-with-detection), so the header tile and the People grid below report the same number.
- **Slider saves persist** — `_mergeAi` precedence in `manager.js` previously made flat-key saves silently revert; the slider now writes BOTH the flat alias and the nested `faces.*` canonical path, and `/api/config` deep-merges `advanced.ai.faces` so partial PATCHes preserve sibling fields.

### Removed
- `@vladmandic/face-api` and `@tensorflow/tfjs-node` are no longer optional dependencies — the npm install no longer touches `napi-v8` wheels that broke on Windows + Node 22.
- Search + Auto-tag pipelines (`image_embeddings`, `image_tags`, `Xenova/clip-vit-base-patch32`, sqlite-vec, HF token plumbing) — all the v2.15 endpoints under that surface now 410 Gone.

### Database
- Additive — extends `faces` with `quality_score` + `landmarks_json` (nullable, populated by sidecar). Embedding dim migrated 128→512 on first sidecar boot; the dim-mismatch guard purges stale rows in a single transaction and broadcasts `ai_faces_dim_change` so the UI shows a "model upgraded — re-cluster recommended" banner.

### Docs
- `docs/AI.md` rewritten — architecture diagram, platform support matrix, install command per host, GPU variant tables for both pip extras and docker-compose profiles.
- `faces-service/README.md` — per-variant install commands + smoke-test instructions.

## [2.15.0] — 2026-05-11

AI subsystem — semantic search, auto-tag, and face clustering. All three run locally with public open-source models, opt-in via `config.advanced.ai.enabled`.

### Added
- **Maintenance → AI** page with 3 tabs (Search / Tags / People). Master switch + per-capability toggles + scan controls + result grids in one place.
- **Semantic search** powered by `Xenova/clip-vit-base-patch32` (MIT, public). Embeddings persisted in a new `image_embeddings` table; cosine top-K via streamed iterator.
- **Zero-shot auto-tag** against a configurable label list (30 defaults — portrait, landscape, screenshot, etc).
- **Face clustering** via `@vladmandic/face-api` (MIT, weights bundled in the npm package — no HF dep) + DBSCAN. UI supports rename + delete.
- **`pregenerateAi(downloadId)`** post-download hook auto-indexes new photos in the background when AI is enabled.
- **12 `/api/ai/*` endpoints** + three JobTrackers (`aiIndex` / `aiTags` / `aiPeople`) with `ai_index_*` / `ai_tags_*` / `ai_people_*` WS event prefixes.
- **`sqlite-vec` lazy probe** lights up an accelerated badge in the AI page when the optional dep is installed; in-memory cosine fallback otherwise.
- **Docker model pre-warm** (`scripts/pre-download-models.js` + Dockerfile RUN) so first-scan latency is milliseconds. Tolerates offline CI via `|| true`.

### Configuration
- New `config.advanced.ai` namespace (`enabled` defaults `false`). Tunable: model, dtype, batch size, label list, tag confidence floor, face DBSCAN eps + minPoints, optional `hfToken`.
- New optional deps: `@vladmandic/face-api ^1.7.15`, `sqlite-vec ^0.1.9`.

### Database
- Additive only — new tables `image_embeddings`, `image_tags`, `people`, `faces` + `downloads.ai_indexed_at` column + partial index. The v2.13 idempotent DROP block is removed so existing installs upgrade in place.

### Guard rails
- New tables registered in `scripts/check-oom-patterns.sh`. Scan loop yields via `setImmediate()` after each batch + bounded LRU on label embeddings — same anti-OOM posture as NSFW.

## [2.14.0] — 2026-05-11

Recovery cleanup tooling — closes the "no account has access" log spam loop and adds the per-group data + 1-click monitor toggle the operator has been asking for.

### Added
- **Maintenance → Recovery cleanup** page. Surfaces every group whose id is `unknown:<folder>` (residue from `npm run recover` against a downloads table from a different Telegram account) or whose previous resolution failed. Bulk operations: re-resolve, disable, delete, pin to a specific account. Hub tile shows a red badge with the count and auto-hides when there's nothing to clean up.
- **Sidebar 1-click monitor toggle** (▶/⏸ icon next to the cog on every config-defined group row). Optimistic UI — flips immediately, rolls back on failure.
- **Group modal "Data" tab** — stats card (file count / size / type breakdown / last download) + paginated recent-files strip + per-group `Delete files only` (keep config) + `Wipe all data` (purge config + DB + folder). Lazy-loads on tab click so opening the modal stays fast.
- **`/api/groups/:id/stats`** and **`/api/groups/:id/files`** endpoints (paginated). New **`POST /api/groups/:id/delete-files`** drops downloads + files but keeps the group monitored.
- **`/api/maintenance/recovery/{list,resolve,disable,delete,reassign}`** endpoints with a shared `recoveryBulk` JobTracker.

### Fixed
- **Resolver auto-disables on first miss + logs ONE summary line** instead of N "Skipping … — no account has access" warnings. Subsequent restarts are silent because the failed groups carry `enabled:false` + `_resolveFailedAt` in `kv['config']`.
- **Per-group diagnostic reasons** replace the generic skip line: `index_miss` (folder not in any loaded account's dialogs), `banned:CHANNEL_PRIVATE`, `probe_failed:<code>`, `empty_folder`. Surfaced in the Recovery cleanup page so the operator knows what to fix.
- **`reloadConfig` re-runs the resolver** for newly-added `unknown:` groups so adding via the dashboard doesn't require a monitor restart.
- **`recover_groups.js`** prints a clear warning when restored rows carry synthetic ids and forces them to `enabled:false` even with `--enable` so the very first monitor start doesn't log-spam.

### Internal
- SW bumped `v2138` → `v2140`.
- `_describeLoadedAccounts()` helper renders the active account label in the resolver summary.
- 19 new i18n keys per locale (en + th lockstep).

## [2.13.3] — 2026-05-10

### Fixed
- **Recovery `unknown:foo` resolver actually works for accounts with > 500 joined chats.** v2.13.1's resolver fetched `getDialogs({limit: 500})` per `unknown:` group; users with hundreds of channels saw less-active chats fall outside the top-500 and the resolver still logged `Skipping … — no account has access` even though they're members. Rewritten to build a single dialogs index (`_buildDialogsIndex`) once per `start()` with `limit: 3000` for active + `limit: 500` for archived across every loaded client, then resolve every `unknown:` group via O(1) Map lookup. Also added a `getEntity(folderName)` fallback so a folder name that's a public Telegram username — but never appeared in the user's dialog list — still resolves.
- The resolver also indexes by `entity.username`, not just by sanitized title, so `unknown:bbbbbn5`-style folders pulled from CLI archives match without falling back to the slower probe.

### Internal
- SW bumped `v2137` → `v2138`.

## [2.13.2] — 2026-05-10

Final OOM-safety pass — closes the one remaining stack-overflow risk in cluster sync and adds a CI-style regression guard so v2.13.1's streaming patterns can't silently come back.

### Fixed
- **Cluster sync `sinceId` advance no longer spreads a row array into `Math.max`.** `Math.max(sinceId, ...rows.map(…))` in `src/core/cluster/sync.js` would throw `RangeError: Maximum call stack size exceeded` if a future page bump or a malicious peer pushed > ~65 535 rows in one frame. Replaced with a bounded for-loop accumulator (also marginally faster). Same family fix applied to `Math.max(1, ...counts)` in the NSFW histogram render.

### Added
- **`scripts/check-oom-patterns.sh`** — POSIX shell guard that exits non-zero on (a) any `.prepare(…)…all()` over a high-cardinality table without an explicit `LIMIT` or natural `WHERE id = ?` bound, and (b) any `Math.max/min(...spread)` outside comments. Wired into `npm run check`, which lefthook already runs on pre-commit. Comments describing the antipattern don't trip the guard.

### Internal
- SW bumped `v2136` → `v2137`.
- Audit log: every category audited in v2.13.1 is now confirmed safe (paginated HTTP, capped caches, streamed SQL sweeps, sliding-window DOM, debounced localStorage). The plan file documents the full coverage matrix.

## [2.13.1] — 2026-05-10

OOM-safety sweep across every SQL / HTTP / render path that handles "lots of data". Triggered by a `FATAL ERROR: Reached heap limit Allocation failed` inside `Statement::JS_all` on a 1M-row library. Every affected surface now streams or paginates; CLAUDE.md documents the rule for future feature work.

### Fixed
- **`monitor.js` resolves synthetic `unknown:foo` group ids before probing.** Recovery groups (created by `reindexFromDisk` when files exist on disk but the DB was empty) were getting "Skipping … — no account has access" on every config reload because `getMessages('unknown:…')` always throws. The resolver now walks each loaded client's dialogs, matches `sanitizeName(title) === folderName`, rewrites `group.id` to the canonical numeric id in memory + kv['config'] + downloads.group_id, and probes with the real id.
- **Share-links sheet paginates.** `GET /api/share/links` accepts `?limit=500&offset=N&q=substring` and returns `{links, total, limit, offset, hasMore}`. The maintenance modal does server-side search + a "Load more" affordance instead of fetching everything.
- **Backend big-table sweeps stream.** `kvList`, `getNsfwIdsByTier` use `.iterate()` instead of `.all()`; `listSessions`, `listPeers`, `listDestinations`, `/api/resync-dialogs`, `/api/groups/refresh-info`, `peer_groups` lookup all carry a defence-in-depth `LIMIT`.
- **Backend caches LRU-capped.** `_failedJobMeta` (5 000 entries), `_dialogsNameCache.byId` (50 000), `state.groupNameCache` (1 000 in the SPA).
- **`scanDiskDeep` yields to the event loop every 100 entries** so a 1M-file tree walk doesn't starve WS broadcasts.
- **Queue page sliding window.** DOM caps at 500 rendered rows; older rows fall off the top as the bottom appends.
- **Maintenance logs view** caps at 500 lines on mobile (was 1 000) for old-phone smoothness.
- **Notification bell `localStorage` writes are debounced** (100 ms coalesce window) so a 100-event/sec error burst doesn't burn main-thread time on `JSON.stringify`.

### Added
- `src/core/util/streaming.js` — `streamRows` (the canonical iterator-batched-drain helper), `lruCap`, `paginate`. Mirrored in `src/web/public/js/utils.js` (`lruSet`, `lruCap`).
- `CLAUDE.md → "Big-data patterns"` section — four invariants every new feature must respect (LIMIT/iterate, yield-every-N, capped caches, virtualised lists). Code review enforces them; CI does not.

### Internal
- SW bumped `v2135` → `v2136`.
- 1 141 specs passing. New behaviour covered by existing share-links + group-name tests; updated test fixtures to use `Map` for `groupNameCache`.

## [2.13.0] — 2026-05-10

### Removed
- **AI Search & Smart Organisation subsystem.** Semantic text→image search, face clustering (People view), perceptual near-duplicate dedup, and ImageNet auto-tagging are gone. `Maintenance → AI search` page, `/api/ai/*` routes, `src/core/ai/`, and the four `aiIndex / aiPeople / aiPhash / aiTags` JobTrackers all removed.
- DB tables `image_embeddings`, `image_tags`, `faces`, `people` and columns `downloads.phash` / `downloads.ai_indexed_at` / `peer_downloads.phash` are dropped on first boot via an idempotent migration. **Back up `data/db.sqlite` before upgrading** if you want to preserve the AI-derived data.
- `sqlite-vec` optional dependency, `AI_MODELS_DIR` / `AI_INDEX_CONCURRENCY` env vars, and 141 `maintenance.ai.*` / `maintenance.hub.ai.*` / `nav.maintenance.ai` i18n keys (en + th lockstep).

### Unchanged
- **NSFW classifier stays.** Separate page (`Maintenance → NSFW`), separate module (`src/core/nsfw.js`), separate config namespace (`config.advanced.nsfw`). `nsfw_score` column and the `@huggingface/transformers` + `sharp` dependencies remain.

### Internal
- SW bumped `v2122` → `v2130`.
- `state-migration.js` now strips the dead `advanced.ai` config namespace from `kv['config']` on first boot.
- ~5,600 LOC removed across backend, frontend, tests, and docs. `docs/AI.md` deleted.

## [2.12.2] — 2026-05-08

Multi-peer audit pass on the federated gallery surfaces shipped in v2.12.0. Four real bugs that affected operators with more than one paired peer; one UX cleanup on the footer.

### Fixed
- **First-load race lost the saved scope.** `state.galleryScope` was initialised to `'local'` in store.js, then overwritten by `initGalleryScope()` reading `localStorage` later in the boot sequence. The very first `/api/downloads/all` call therefore went out as `?include=local` even when the operator had previously selected "All peers". Fixed by reading `localStorage['tgdl-gallery-scope']` at module-load time, before the first gallery fetch.
- **Foreign-group click leaked into All Media.** Clicking a peer-owned group in the sidebar overwrote `state.galleryScope = peerId`. Navigating back to All Media after that kept the per-peer narrowing — the merged "All peers" view became silently broken until the user manually toggled the chip back. Fixed by introducing `state.viewerPeerScope` (per-view binding) that consumes the foreign-peer narrow without touching the chip's persistent state. Cleared on `showAllMedia()` and on chip change.
- **Pagination dropped the peer filter mid-scroll.** A previous one-shot scope binding cleared after the first page request, so page 2+ of a peer-narrowed per-group view re-broadened to the chip's scope and silently mixed in extra peers. The new `viewerPeerScope` persists across pagination and only clears on view exit.
- **Footer file count never reflected the scope.** v2.12.0 added `peerStats` to `/api/stats` but the SPA footer still rendered local `totalFiles` only. With scope = all, the footer now reads `{local} + {peers} peers` and tooltips per-peer breakdown; with scope = a specific peer, the footer reads that peer's count; scope = local renders unchanged.

### Internal
- Footer reload on chip change so per-scope totals stay in sync.
- New i18n key `footer.files.merged` (en + th lockstep).
- SW bumped `v2121` → `v2122`.
- 1238 specs passing.

## [2.12.1] — 2026-05-08

### Fixed
- **`GET /api/ai/health` could hang the request and silently kill the container.** The four AI Doctor probes ran via `Promise.all` with no per-check timeout; a hung native call (sharp/libvips, onnxruntime-node, sqlite-vec dlopen) would dangle the request past the dashboard's 15 s client timeout and, on memory-limited Docker hosts, OOM-kill the process with no app-level logs. The Doctor card showed the generic "/api/ai/health endpoint failed" error and the operator had no diagnostic to act on.

### Changed
- **Per-probe timeout** — every check inside `health.summary()` is now wrapped in a 6 s `withTimeout()` race; a stuck probe returns a structured `{ok:false, timedOut:true}` payload with platform-aware remediation text instead of blocking the whole summary.
- **`checkSharp()` no longer invokes libvips** — it reads `sharp.versions.vips` only. A broken libvips binding would SIGSEGV from native code on `.toBuffer()`, bypassing every JS catch and producing a no-log container exit. Version metadata is enough to confirm the binding loaded.
- **`checkSqliteVec()` is cached per process** — `mod.load(db)` is only called once; repeat health hits return the cached structured payload instead of re-dlopen'ing the extension.
- **Route-level safety net** — `GET /api/ai/health` sets a 20 s `req/res.setTimeout`, dedupes concurrent in-flight summaries, and serves a 30 s in-process cache so a panicked operator clicking Refresh can't compound load on the underlying probes.
- **Verbose `ai-health` structured logs** — every probe emits start/done/timeout lines (with elapsed ms and request id) to the dashboard log + docker stdout, so a future incident has a paper trail of which probe was running last.

### Internal
- New `health._resetSqliteVecCacheForTests()` test hook + 6 new specs covering timeout fallback, log emission, cache hit, and "no DB" no-cache path. Suite at 1238 passing.
- SW bumped `v2120` → `v2121`.

## [2.12.0] — 2026-05-08

Layer 1 of the federated-gallery rollout. The main gallery surfaces (All Media / per-group view / search) now optionally include files from every paired peer; the sidebar Downloaded Groups list merges peer-owned groups with a "from {peer}" badge; peer-owned tiles route their thumbnails + media bytes through the existing cluster bridge. Default behaviour is unchanged — federation is opt-in via a new gallery scope chip, hidden entirely on non-cluster installs.

### Added — Federated gallery surfaces
- **Gallery scope chip** in the media-tabs row (admin-only, hidden when 0 peers paired). Options: This peer / All peers / per-peer entries with online status. State persists in `localStorage['tgdl-gallery-scope']`.
- **Per-tile peer badge** — federated tiles render a "from {peer}" pill in grid mode and an inline subtitle suffix in list mode so the source dashboard is always visible at a glance.
- **Sidebar Downloaded Groups merge** — peer-owned groups appear with the same "from {peer}" badge. Clicking a foreign group switches the gallery scope to that peer and opens the per-group view filtered to its files. Foreign groups are read-only (no settings cog).
- **Live refresh** — `peer_catalog_update` and `peer_groups_update` WS events trigger gallery + sidebar reloads when scope ≠ local, so peer changes appear without manual refresh.

### Added — Server endpoints
- **`?include=local|peers|all`** on `/api/downloads/all`, `/api/downloads/:groupId`, `/api/downloads/search`. Default is `local` (backward-compatible). Guest sessions are forced back to `local` server-side; federation stays admin-only on every surface.
- **`?peerId=<id>`** further narrows federated queries to a single peer.
- **`/api/cluster/peer-thumbs/:remoteId`** — HMAC-only peer-to-peer thumbnail handler.
- **`/api/cluster/thumbs/:peerId/:remoteId`** — cookie-authed browser proxy that signs a request to the peer's `peer-thumbs` route, streams the response, and falls back to a 1×1 placeholder PNG when the peer is offline (60 s cache to prevent the gallery from spamming the console with 404s).
- **`/files/<path>?peer=<id>`** — extends the existing local file route with peer routing. When `?peer` is present, the request is served via `streamFromPeer()` (proxy) or `requestSignedShareUrl()` (direct stream mode). Guest sessions are 403'd.
- **`/api/groups`** now appends every paired peer's groups (deduplicated by id; locally-owned groups gain a `mirroredOn: [peerId, ...]` field so a future "+N peers" badge can render without a server change). Guest sessions skip the merge.
- **`/api/stats`** gains a `peerStats` array (`peerId`, `peerName`, `online`, `totalFiles`, `totalSize`, `totalSizeFormatted`). Empty on non-cluster installs and for guest sessions.

### Internal
- New `src/web/public/js/media-url.js` — central URL builder (`getThumbUrl`, `getMediaUrl`, `getDownloadUrl`, `isPeerRow`). Replaces inline `/api/thumbs/${id}` / `/files/${path}` constructions in `app.js`, `viewer.js`, `gallery-context.js`. Federation routing lives in one file.
- New `src/core/db.js` helpers: `getAllDownloadsFederated`, `getDownloadsForGroupFederated`, `searchDownloadsFederated`, `getStatsFederated`. UNION ALL of `downloads` + `peer_downloads` with a normalised `sort_ts` column so `created_at` sorts correctly across the schema-mismatched columns (DATETIME string vs INTEGER unix-ms).
- 13 new federated-gallery tests in `tests/db-federated-gallery.test.js` (1232 specs total now passing).
- `POST /api/config` was already deep-merging the cluster namespace (v2.11.2 hardening).
- 6 new i18n keys (`gallery.scope.*` / `gallery.peer_badge` / `sidebar.group.peer_badge`) — en + th lockstep, drift checker clean (1217 keys).
- New CSS: `.tile-peer-badge`, `.gallery-scope-option[data-active]`, `#gallery-scope-menu` positioning.
- SW bumped `v2112` → `v2120`.
- **Cluster contract preservation** — every `$('cluster-…')` id intact; 5 `ws.on('peer_*' / 'cluster_*')` listeners preserved + 2 new ones added (`peer_catalog_update`, `peer_groups_update`); existing endpoints unchanged in their default behaviour.

## [2.11.2] — 2026-05-08

### Fixed
- **`POST /api/config` now deep-merges the `cluster` namespace** with the same convention used for `telegram`, `download`, `web`, `advanced`, etc. Previously the server's shallow merge meant a future caller that PATCHed only `cluster.replicate` (without first reading + cloning the rest of the cluster object) would silently erase `cluster.failover_grace_minutes`. The Settings → Federation panel was already safe (read-modify-write), but the server contract is now defensive — and `cluster.replicate` is merged one level deeper so a single-key policy toggle can never overwrite the rest of the policy map.

### Internal
- SW bumped `v2111` → `v2112`.
- Independent post-release audit confirmed: cluster element-IDs, WS event listeners, config key paths, and i18n keys are all intact across v2.10.0 → v2.11.2. Media-display path (gallery / lightbox / viewer / SW cache-bypass) untouched by the recent UI work.

## [2.11.1] — 2026-05-08

### Fixed
- **Group save would erase `ownerPeerId` / `backupPeerId` when no peers were paired.** v2.11.0 always included these fields in the `PUT /api/groups/:id` payload; if the cluster routing wrapper was hidden (no peers paired), both dropdowns held the empty default value, which the server's `if (req.body.ownerPeerId !== undefined)` guard treated as "delete". Operators with a previously-set owner peer would lose the assignment the first time they saved an unrelated group setting after a peer revocation. Fixed by tracking the wrapper's hidden state at save time — cluster routing fields are now omitted from the payload entirely when the wrapper is hidden, leaving any existing config untouched.

### Internal
- SW bumped `v2110` → `v2111`.

## [2.11.0] — 2026-05-08

Cluster federation gets a real operator UI. Settings → Federation now exposes the replication-policy editor (which config keys mirror across paired peers) and the failover grace tunable; the Group settings modal grows owner-peer / backup-peer dropdowns so per-group routing is finally editable from the dashboard. Every Maintenance subpage was passed through the standard layout template — NSFW / Logs / Backup / Updates now match Duplicates / Thumbs / Video / Cluster — and the long-standing CSS bug that hid the maintenance tab strip on the Cluster + Updates routes is fixed.

### Added — Settings → Federation
- **New chip + section** between Accounts and Download. Hidden for guest sessions and for non-cluster installs (the empty-hint banner shows when no peer is paired so the section is discoverable but inert).
- **Replication policy editor** — segmented control (Local / Cluster / Cluster-excl) per curated config key (`groups`, `accounts`, `web`, `download`, `rescue`). Writes to `config.cluster.replicate.<key>`, which `src/core/cluster/config-sync.js` already reads — no new server endpoint, mirroring kicks in immediately on the next save.
- **Failover grace slider** — `cluster.failover_grace_minutes` (1–60). `src/core/cluster/failover.js` reads the value at every 60-second tick.
- **This-peer summary card** — read-only peer name + ID with a deep-link to `/maintenance/cluster` for token / pairing / peer management. Avoids duplicating the cluster page's actions in two places.

### Added — Group settings modal cluster routing
- **Owner peer / Backup peer dropdowns** in the Accounts tab (auto-hidden when no peers paired). Saves to `groups[i].ownerPeerId` / `groups[i].backupPeerId`, which `src/core/cluster/router.js` and `failover.js` already read for download routing and automatic owner takeover.
- **Server-side**: `PUT /api/groups/:id` now accepts the two new fields with the same convention as `monitorAccount` (empty string → delete the key, falsy → leave existing).

### Changed — Maintenance subpages standardised
- **NSFW** restructured to the header + actions + 4-up stats grid template. Stats: Scanned / Whitelisted / **Borderline** (sum of the three middle classifier tiers) / Last scan. Every `nsfw-*` element id preserved.
- **Logs** wrapped in a header card with action buttons (Auto-scroll toggle, Pause, Clear, Download .log) on the right; filter chips moved into their own sub-card so the header stays scannable.
- **Backup** gained a 4-up stats strip (Destinations / Synced / Queued / Last mirror) populated from existing destination-status rows.
- **Updates** gained a 3-up stats strip (Current version / Last attempt / Pending) populated from `/api/version` + the existing update-history rows.

### Fixed
- **Maintenance tab strip hidden on Cluster + Updates pages** — `body[data-page="maintenance-cluster"]` and `maintenance-updates` were missing from the CSS selector at `main.css:2349`. Both selectors added; tabs now render across every per-feature maintenance subpage.

### Internal
- 8 new `settings.federation.*` i18n keys + `group.cluster.*` (9 keys) + `maintenance.{nsfw,backup}.stat_*` + `update.stats.*`. `en.json` and `th.json` lockstep; drift checker clean (1211 keys, all present in both).
- New `_initFederation()` in `src/web/public/js/settings.js` — reads `/api/cluster/identity` + `/api/cluster/peers` independently so non-cluster installs render the empty hint instead of failing. Idempotent (`_federationWired` flag).
- New `.federation-policy-btn[data-active="1"]` CSS rule for the segmented control. Brand colour active state, subtle hover.
- SW bumped `v2101` → `v2110`.
- **Cluster contract preservation** — every `$('cluster-…')` id in `maintenance-cluster.js` cross-checked against `index.html`; every server `broadcast({type: 'peer_*' / 'cluster_*'})` cross-checked against `ws.on(...)` listeners. No drift.

## [2.10.1] — 2026-05-08

Maintenance hub UI polish — the Cluster page now follows the same layout standard as Duplicates / Thumbnails, the sidebar reads as one tight column instead of an oversized stack, and the standalone account-pairing screen finally matches the dashboard theme.

### Fixed
- **Maintenance tab strip hidden on Cluster + Updates pages.** `body[data-page="maintenance-cluster"]` and `maintenance-updates` were missing from the CSS selector that displays `#maintenance-tabs`, so the strip silently disappeared on those two routes. Both selectors added; tabs now render across every per-feature maintenance subpage.

### Changed — Cluster page
- Header restructured to the standard maintenance pattern: title + subtitle on the left, primary actions (`Run sweep`, `Add peer`) on the right, **stats grid** below (Peers / Online / Conflicts / Last sweep) populated from `_peers` + `/api/cluster/conflicts`.
- **Identity card redesigned** as a profile block — avatar + display name + "This peer" pill, inline edit (pencil → editor row → Save / Cancel), dedicated Peer ID block with Copy, dedicated Cluster token block with Show / Copy / Pairing code / Use cluster's token / Rotate. Every existing element ID preserved so the existing JS wiring keeps working unchanged.

### Changed — Sidebar
- Nav rows compacted (`px-3 py-1.5` + `text-base` icons + `text-sm` labels, was `p-3` + `text-xl`); the column reads tighter without losing tap targets.
- "All Media" tile shrunk to a 9×9 avatar + `text-sm` / `text-[11px]` lines so it sits in proportion with the new nav rows.
- Internal dividers softened (`border-tg-border` → `border-tg-border/40`); the bordered chrome no longer competes with content.
- Footer disk + files line tightened (`text-[11px]` + `tabular-nums`); Sign-out button switched from solid red to a quiet red text on hover-only red bg.

### Changed — add-account.html
- Replaced the generic `bg-gray-800` / `border-gray-600` Tailwind utilities with the same `--tg-*` token system + `tailwind.config.tg` palette `login.html` already uses. Adds the radial-glow background, brand mark, IBM Plex Sans typography, theme-aware light/dark variants, and a numbered step indicator with active / done states. Pairing flow logic untouched.

### Internal
- New i18n keys: `cluster.stats.{peers,online,conflicts,last_sweep}`, `cluster.sweep.never`, `cluster.identity.{this_peer,subtitle,name.placeholder,name.edit,id.copied}`, plus the previously-missing `common.copy`. Both `en.json` and `th.json` updated; drift checker clean.
- SW bumped `v210` → `v2101` so the new shell + asset caches roll over on first load after the update.

## [2.10.0] — 2026-05-08

A foundation release. The headline is **cluster mode** — federate two or more dashboard instances into a single library with real-time sync, automatic failover, and LAN auto-discovery — but the v2.10 ship list also covers an auto-update overhaul, an AI subsystem that survives broken native deps, a re-auth modal so session expiry no longer kicks you out of the SPA, and a maintenance hub polish across every fire-and-forget tool.

### Added — Cluster mode (the headline)
- **Per-peer tokens.** Each pairing exchanges a fresh per-pair secret during handshake. Revoking one peer no longer invalidates the rest of the cluster.
- **Pairing codes.** Short 8-character single-use codes (5-min TTL) replace the v2.9 "paste the cluster token in both peers" wizard.
- **Real-time WS sync** over a persistent `/ws/cluster` channel. Catalog updates propagate in <1 second; the 5-minute polling fallback only kicks in if the link drops.
- **LAN auto-discovery** via UDP broadcast on port 28910. The Cluster page shows discovered peers and one-click pairs them with a fresh code.
- **Owner-peer routing** — `groups[i].ownerPeerId` designates a single peer as the downloader for that group; other peers see the catalog but stay silent on Telegram.
- **Backup peer + automatic failover** — `groups[i].backupPeerId` + `cluster.failover_grace_minutes` (default 5). When the owner is silent past the grace window, the backup atomically takes over and broadcasts `failover_completed`.
- **Relay-through-peer** — if peer A can't reach peer C but peer B can reach both, A's signed calls forward through B end-to-end (B never sees the inner payload).
- **Live config replication** — mark settings as `cluster.replicate.<key> = "cluster"` (or `"cluster_excl"`); changes propagate to every peer with last-writer-wins (timestamp + peer-id tiebreak).
- **Cross-peer file delete** with persistent retry queue — sweep's "keep this copy" decision actually deletes the losers on remote peers (was queue-only in v2.9).
- **Cluster-wide search** — `/api/cluster/search` fans out to every online peer, merges, dedups by `file_hash`.
- **Cluster stats** — disk-usage / dedup / egress aggregated per peer.
- **35 new `/api/cluster/*` endpoints** (admin-cookie + HMAC-signed peer-to-peer). **WebSocket events** for `peer_status`, `peer_catalog_update`, `peer_groups_update`, `cluster_config_changed`, `cluster_failover`, `cluster_sweep_progress` / `_done`, `peer_added` / `_removed`, `download_added` / `_deleted` / `group_changed`, `config_changed`. **10 new tables** (`peers`, `peer_downloads`, `peer_groups`, `peer_accounts`, `peer_history`, `peer_failover_log`, `peer_delete_jobs`, `peer_discoveries`, `cluster_egress_log`, `cluster_audit`).
- See [`docs/CLUSTER.md`](docs/CLUSTER.md). v2.9 → v2.10 re-pair instructions in [`docs/MIGRATION-v2.9-to-v2.10.md`](docs/MIGRATION-v2.9-to-v2.10.md).

### Added — Auto-update overhaul
- **`update_history` audit table** — every `/api/update` click writes one row (`triggered` → `success` / `failed` / `stalled`); the dashboard's new **Updates** page (`/maintenance/updates`) renders the trail with version transitions, durations, error codes, backup paths.
- **Pre-flight integrity gate** — watchtower reachability ping (5 s HEAD), live `PRAGMA quick_check`, snapshot write + verify-by-reopen, **then** trigger watchtower. Bad snapshots are deleted so a torn backup can't masquerade as a recovery point.
- **Boot instance ID** rotated on every container start; the new container's finaliser stamps the `triggered` row to `success` even when the image's semver is rebuilt under the same `:latest` tag (instance_id always differs).
- **Structured `error_code`** on every failure path (`WATCHTOWER_UNREACHABLE` / `DB_CORRUPT` / `BACKUP_FAILED` / `BACKUP_VERIFY_FAILED` / `TRIGGER_FAILED`); the SPA looks up an i18n message keyed on the code rather than relaying raw strings.
- **Server-configurable overlay stall timeout** — broadcast at boot via `UPDATE_OVERLAY_STALL_MS`; the SPA respects the value without redeployment.
- **Backup pruning** — keep `UPDATE_BACKUP_KEEP` (default 5) most-recent snapshots in `data/backups/`.

### Added — AI subsystem hardening
- **AI Doctor card** (`/api/ai/health`) — single payload covering sharp (libvips), `@huggingface/transformers` (ONNX/WASM runtime), `sqlite-vec` (optional vector ext), models cache directory. Each check returns platform-aware remediation text (musl vs glibc, sharp rebuild after Node upgrade, libvips install on Linux, etc.).
- **Graceful module loading** (`src/core/ai/safe-load.js`) — a missing libvips / wrong libc / stale Node ABI no longer crashes the AI subsystem at boot. Capabilities fail cleanly and independently; the rest keep working.
- **Lazy sharp** in `faces.js` + `phash.js` — `import sharp` deferred to first scan call, so the server boots even when sharp can't be required.
- **`maintenance-ai.js` rewrite** — federated architecture across 12 sub-modules in `src/web/public/js/ai/*` (capabilities, doctor, models, hf_token, people, tags, phash, search, stale-embeddings, etc.); each sub-module owns one card on the AI page.
- **AI router extracted** to `src/web/routes/ai.js` (factory pattern, deps injected) + every handler wrapped in `src/web/lib/safe-route.js` so a buggy AI endpoint can't trigger a process-level uncaught exception.
- Every `/api/ai/*` response carries both `ok: true` and `success: true` so legacy SPA caches and the new envelope co-exist.

### Added — Re-auth modal
- **In-SPA session re-auth** — when an admin endpoint returns 401, a password modal opens instead of a hard redirect to `/login.html`. The retried request resumes when the user signs in successfully.
- **Single-flight queueing** — three admin endpoints firing on page mount produce one prompt + three retries.
- **Graceful fallback** — if the modal fails or the user cancels, falls back to the legacy redirect so the operator always has an escape hatch.
- Fires `tgdl:reauth-success` so `app.js` can re-fetch `/api/auth_check` and update `body[data-role]` without a page reload.

### Added — Maintenance hub polish
- **Find duplicates page** — top stats panel (Total / Hashed / Awaiting hash / Last scan) hydrates from `GET /api/maintenance/dedup/stats` and persists across server restart via `kv['dedup_last_scan']`.
- **Verify files button** surfaced on the duplicates page (was buried in Settings).
- **Stage-specific progress labels** ("Hashing X / Y", "Grouping by hash…") with bigger spinner, h-2 bar, and right-aligned percentage.
- **Persisted last-run summaries** for thumbs build, faststart, reindex, files-verify — a fresh dashboard visit answers "did this even run before?" without re-running.
- **`/api/maintenance/<feature>/stats` endpoints** — verify, reindex, thumbs/build, dedup get new `/stats` endpoints; the existing `/faststart/stats` is extended with `lastRun`.
- **Stats panel + last-run cards** on thumbs and video pages mirroring the duplicates pattern.
- **`scripts/check_i18n_drift.js`** — zero-dep CI script that walks `data-i18n` attributes + `i18nT(…)` calls and diffs the union against `en.json` + `th.json`. Missing keys exit non-zero with a list.

### Added — Infrastructure
- **`autoheal` Docker sidecar** in the bundled `docker-compose.yml` — restarts containers whose healthcheck fails (catches event-loop hangs that `restart: unless-stopped` misses).
- **Memory ceilings** — `TGDL_MEM_LIMIT` (default `2g`) on the dashboard service so a runaway embeddings cache can't OOM the host.
- **Log rotation** baked into the compose file (10 MB × 5 files / container).
- **PM2 ecosystem.config.cjs** retargeted from `src/index.js` to `src/web/server.js`; `max_memory_restart: 1500M` + `listen_timeout: 30_000` for boot grace.
- **Settings → Advanced** is now a collapsible `<details>` element with a styled disclosure marker.

### Fixed
- **Race condition** in `thumbs/build-all`, `faststart/scan`, `dedup/scan`, `reindex` — the catch block broadcast `${prefix}_done` before the `finally` reset the running flag, so a retry after error got a spurious 409 ALREADY_RUNNING. All four routes migrated to `JobTracker`; the running-flag reset and broadcast happen atomically inside one tracker boundary.
- **Dual-state `/api/maintenance/reindex/status`** — used to OR `_reindexBgRunning` with `integrity.isReindexRunning()`, masking which subsystem actually owned the job. Single source of truth now.
- **`btn.textContent = …` wipes icons** — every action button on the thumbs / video / nsfw / duplicates pages migrated to the icon + `<span data-i18n>` pattern; JS swaps only the label span.
- **Chunked SQL `IN (?,…)`** in `dedup.deleteByIds` — `SQL_IN_CHUNK = 500` keeps each prepared statement well under SQLite's `SQLITE_MAX_VARIABLE_NUMBER` (32766 modern, 999 old). Bulk dedup-delete on libraries with thousands of duplicate sets works correctly on every SQLite build.
- **Filled 26 missing i18n keys** uncovered by the new drift script: `reauth.*` modal, `nsfw.bulk.*` / `nsfw.row.*` / `nsfw.empty.*`, `settings.maintenance_link.*`, `common.saved`, `maintenance.tabs.back`, `maintenance.ai.hf_token.save_failed`. Both en + th.

### Accessibility
- `aria-live="polite"` + `role="status"` on every maintenance progress region.
- `role="log"` + `aria-live="polite"` on the realtime log stream so screen readers announce new entries.
- `data-i18n-title` tooltips on every maintenance action button.

### Internal
- **40+ new DB helpers** (`upsertPeer`, `listOwnDownloadsSince`, `findClusterByHash`, `findCrossClusterDuplicates`, `recordFailover`, `enqueuePeerDeleteJob`, `claimNextPeerDeleteJob`, `upsertPeerDiscovery`, `recordEgress`, `aggregateEgress`, etc.) and a `from_instance_id` column on `update_history`.
- **Cluster WS upgrade handler** with HMAC auth at the upgrade handshake; cluster broadcast is wired via `global.__tgdlBroadcast` so download events propagate to paired peers without import cycles.
- **Cluster-aware monitor** — `setupRealtimeSync()` and `poll()` import `isLocalGroup` from `cluster/router.js` and skip groups owned by another peer (no duplicate Telegram traffic in a federated setup).
- **Cluster-aware downloader** — when a freshly hashed file matches a peer's hash, the local copy is replaced by a synthetic `_clusterref/<peerId>/<remoteId>` path; the bridge resolves it on read. Zero duplicate bytes across the cluster.
- **Express middleware** — new `src/web/lib/safe-route.js` wraps every AI handler (sync + async throws caught + JSON-enveloped); guards a buggy handler from triggering `process.on('uncaughtException')`.
- **Frontend label-span swap pattern** documented inline in `maintenance-duplicates.js` as the reference for other maintenance modules.
- **Tests added** — 14 cluster (`tests/cluster.*.test.js` covers identity, hmac, handshake, peers, sync, dedup, sweep, config-sync, discovery, failover, proxy, relay, tokens, e2e), 4 AI (`tests/ai.health.test.js`, `tests/ai.lazy-sharp.test.js`, `tests/ai.routes.test.js`, `tests/ai.safe-route.test.js`), 3 update (`tests/updater.test.js`, `tests/update-history.test.js`, `tests/update-routes.test.js`), 1 reauth-modal, 2 maintenance race + persistence (`tests/maintenance.race.test.js`, `tests/maintenance.dedup-jobtracker.test.js`). 1219 specs passing across 154 files (1 file + 2 specs skipped intentionally).
- **Route registration debug aid** — `router.js` logs unmatched paths to the console (devtools-only) and replaces them with `/viewer` so a typo doesn't sit in history.
- **SW VERSION** bumped `v281` → `v210` so installed dashboards pick up the new shell + asset caches on next visit.

### Migration notes
- v2.9 cluster pairings keep working until you re-pair (legacy global cluster_token is still accepted as an HMAC fallback during the v2.10 cycle). The Cluster page flags v2.9-paired peers `migrationRequired: true` — re-pair via the new Issue pairing code workflow to upgrade. Full instructions in [`docs/MIGRATION-v2.9-to-v2.10.md`](docs/MIGRATION-v2.9-to-v2.10.md).
- v2.11 will remove the legacy global-token fallback. Plan re-pairs before that release.
- **No config / DB migrations are required for non-cluster operators** — every cluster table + column is additive.

## [2.8.1] — 2026-05-08

### Added
- **`npm run recover`** (`scripts/recover_groups.js`) — rebuild `kv['config'].groups` after a botched JSON→SQLite migration without re-adding chats through the dialogs picker (which risks `Group A` / `Group A (2)` folder splits when Telegram returns a slightly different display name than the existing folder was sanitised against). Tries `data/config.json.migrated` first (preserves filters / auto-forward / monitor-account assignments / forum-topic whitelists), falls back to `SELECT DISTINCT group_id, group_name FROM downloads`. Dry-run by default; `--apply` writes via `saveConfig()`; `--enable` flips `enabled=true` on every restored group. Skips ids already in `kv['config']` — safe to re-run. Documented in `docs/TROUBLESHOOTING.md` ("Settings → Groups is empty after an upgrade").

### Internal
- SW bumped `v280` → `v281`.

## [2.8.0] — 2026-05-08

### Added — Auto-update reliability overhaul
- **Pre-flight ping** (5 s HEAD against `/v1/update`) before snapshotting — surfaces a misconfigured `WATCHTOWER_URL` or down sidecar instantly instead of after a wasted DB copy.
- **Live-DB `PRAGMA quick_check`** before snapshot — refuses to back up a corrupt DB.
- **Snapshot verification** — opens the freshly-written file read-only, confirms schema + clean `quick_check`. Bad snapshots are deleted so a torn backup can't sit in `data/backups/` masquerading as a recovery point.
- **Structured error codes** on `/api/update` failures: `WATCHTOWER_UNREACHABLE` / `DB_CORRUPT` / `BACKUP_FAILED` / `BACKUP_VERIFY_FAILED` / `TRIGGER_FAILED`.
- **Audit trail** — new `update_history` table; `GET /api/update/history` returns the last N attempts. The new container's boot path observes the version delta and stamps each `triggered` row to `success` (with `to_version`) or `stalled` (10-min timeout). Pre-flight failures are recorded too.
- **Front-end stall guard** — overlay swaps to "Update appears stalled" with **Retry connect** / **Dismiss** buttons after 120 s instead of spinning forever.
- **Bundled `sqlite-vec`** as an optional dep — fast vector search now installs by default; the in-memory fallback is reserved for `--no-optional` builds and >50k libraries.

### Fixed — JSON-state migration completeness
- **`POST /api/config` now writes to `kv['config']`** — the legacy file path was still being used by the settings endpoint, so saves silently drifted from the live row and got archived to `*.migrated` on next boot. (Symptom: "settings won't save on Docker.")
- **`advanced.thumbs.hwaccel`** now sources from `loadConfig()` instead of reading the dead `data/config.json` file. Dashboard-set GPU acceleration was a no-op on every install since v2.7.0.
- **Disk-usage cache** writes via `kvSet('disk_usage', …)` instead of the renamed `data/disk_usage.json`.
- **`history-jobs.json` → `kv['history_jobs']`**, **`queue-history.json` → `kv['queue_history']`**, **`data/logs/queue_backlog.jsonl` → new `queue_backlog` SQLite table** (FIFO pops in one transaction — can't double-deliver after a crash mid-rehydrate). Legacy files are auto-imported on first boot and archived to `*.migrated`.

### Fixed — Maintenance UI
- **Log viewer:** SOURCES filter list synced with what the server actually emits (added `ai`, `backfill`, `backup`, `faststart`, `http`; dropped 5 never-emitted names). Fail-open for unknown sources so future server-side log channels can't silently drop.
- **Find duplicate files:** `createdAt` sort comparator no longer string-subtracts (always returned `NaN`); "Keep oldest / newest" was riding on V8 stable-sort luck.
- **Hardware probe** (`/api/maintenance/thumbs/hwaccel-probe`) dedupes the compile-in list and runs `ffmpeg -init_hw_device <name>=hw` against each candidate — only backends that actually init successfully end up in `available`. Compile-in list returned as `compiledIn` for debugging.
- **Rescue Mode** sweeper now broadcasts `file_deleted` per row (existing gallery + stats listeners drop the tile / refresh footer for free) and a `rescue_sweep_done` aggregate (toast on the SPA, count > 0).
- **Auto-update failure** now surfaces an error toast — pre-v2.8.0 the click silently fell through when `runAutoUpdate()` threw before the WS-disconnect handover.

### Internal
- Removed dead `CONFIG_PATH` constants + vestigial `configPath` constructor argument across `runtime.js` / `monitor.js` / `index.js`. Clean-up after the JSON→SQLite migration.
- SW bumped `v279` → `v280`.

## [2.7.4] — 2026-05-07

### Added
- **PM2 ecosystem.config.cjs** for bare-metal Node deploys (Synology NAS, shared hosts, anywhere systemd isn't available or you'd rather not edit `/etc/systemd`). Caps restarts at 10 with a 2 s backoff so a bad config surfaces as a stopped process instead of pinning the CPU; tags log lines with timestamps; writes both streams to `data/logs/pm2-{out,err}.log` so existing backup/rotation paths cover them; ships `prod` (PORT=3000) and `staging` (PORT=3010) env profiles. Documented in `docs/DEPLOY.md`.

### Fixed
- **`Resilience.handleError` no longer rethrows after exit on `AUTH_KEY_UNREGISTERED`.** The auth-fail branch called `process.exit(1)` without a `return`, so when `exit` was stubbed (test runners, hosted environments where the harness intercepts exits) the function fell through to `throw error` and turned a controlled shutdown into an unhandled rejection.

### Tests
- `tests/resilience.test.js` (13), `tests/runtime.test.js` (13), `tests/forwarder.test.js` (15) — `guard()` / `handleFatal()` classification + recovery branches, runtime lifecycle + state-machine emissions + status() shape, auto-forwarder early-exit gates + destination resolution chain (alias → InputEntity → Entity → manual `InputPeerChannel` for `-100…` IDs).

### Internal
- `src/core/constants.js` centralises `BACKFILL_MAX_LIMIT`, `DIALOG_CACHE_TTL_MS`, `HISTORY_JOB_TTL_MS`, `BACKPRESSURE_CAP_DEFAULT` — previously duplicated across `server.js` (3-4 sites each), `history.js`, and `config/manager.js`. Pure extraction; values unchanged.
- `NATIVE_LOAD_FAIL` regex moved to `core/logger.js` as a single named export — was duplicated in `server.js`, `index.js`, and a narrower copy in the doctor check that has been widened to match.

## [2.7.3] — 2026-05-07

### Added — Multilingual AI search
- **Default semantic-search model is now `Xenova/siglip-base-patch16-256-multilingual` (~370 MB, 768-dim, 50+ languages).** The previous default (`Xenova/clip-vit-base-patch32`, 90 MB / English-only) returned poor results for non-English queries — typing "แมว" or "หาดทราย" against a Thai-first archive ranked random photos at the top because CLIP doesn't know Thai. SigLIP's text encoder shares a vector space across the languages it was trained on, so the same query box now serves both English and Thai queries from one index. **First boot after upgrade auto-wipes existing 512-dim CLIP embeddings and re-indexes** — state-migration detects the model mismatch in `image_embeddings`, DELETEs the stale rows, and resets `downloads.ai_indexed_at = NULL` so the regular scan loop rebuilds them with SigLIP. Operators see a one-time `[state-migration] reembed sweep: dropping N stale row(s)` line in the boot transcript.
- **Models panel preset chips.** New "English-only · CLIP" and "Multilingual · SigLIP" chips on `/maintenance/ai`. Click an inactive chip → confirmation sheet discloses download size + how many photos will need re-indexing → PATCH config + POST `/api/ai/index/reembed` in one round trip.
- **`POST /api/ai/index/reembed`** endpoint — wipes embeddings whose `model` differs from the active id, then kicks `runIndexScan`. Atomic via the existing JobTracker (returns 409 ALREADY_RUNNING if a scan is already live).
- **Defence-in-depth filters in vector-store.** `blobToVector` now rejects mismatched-dim blobs (a 512-dim CLIP row can't be silently treated as 768-dim SigLIP), and `topK()` filters cached rows by current model id so a runtime swap can't pollute results before the wipe completes.

### Performance
- **Gallery deep-scroll now holds 60 fps on 5000-tile archives.** The previous behaviour relied on `content-visibility: auto` to skip layout for off-screen tiles, but every tile still held a decoded thumbnail bitmap in memory — at 5000 tiles that was ~150 MB resident even when only ~20 were on screen, and main-thread time managing that working set dragged scroll down to ~20 fps past the 2000-row mark. A new tile-window `IntersectionObserver` (1500 px buffer either side of viewport) detaches `.tile-thumb` children into a per-tile `WeakMap`-stashed `DocumentFragment` when they leave the buffer and reattaches the fragment on re-entry. The browser image cache still answers from a 304 the second time around so there's no flicker. Selection state and click delegation are unaffected because they key off the outer `.media-item[data-path]` node — never evicted.
- **Tile placeholder sizing tuned per mode/breakpoint.** The previous `contain-intrinsic-size: auto 200px` was 25-50 % off the real rendered tile height (120-180 px in grid mode depending on the column-width breakpoint), which made the scrollbar drift every time a tile crossed `content-visibility`'s reveal threshold. Set explicit values per `.view-compact`, `.view-list`, and the desktop breakpoint so the placeholder matches the real geometry.
- **Dropped 10 000+ inline `onload` / `onerror` closures** from a typical 5000-tile gallery — replaced with two capture-phase delegated listeners on the grid root. Same visual outcome (fade-in on success, hide on failure), zero per-tile parser/GC cost.

### Fixed
- **AI tag/face scans no longer fail with HuggingFace 401s.** Operators who installed before the public-default model swap still had `Xenova/mobilenet_v2` and `Xenova/yolov5n-face` saved in `kv['config'].advanced.ai`, both of which now require gated access; every scan would log `Unauthorized access to file: …/config.json` for those rows. Boot-time state-migration now sweeps known-gated ids out of saved config (rewriting them to the matching public default — `Xenova/vit-base-patch16-224` for tags, `Xenova/yolos-tiny` for faces). The `/api/ai/status` endpoint also returns a `gatedWarnings` array so the dashboard can show a one-click "Apply public default" banner when an operator pastes a gated id at runtime. Idempotent — clean configs are untouched.

### Internal
- SW bumped `v278` → `v279`.
- `biome check --write .` swept 9 pre-existing format errors out of the tree (multi-line ternaries / chained `.status().json()` calls Biome wants on one line). Pure whitespace; no logic touched.

## [2.7.2] — 2026-05-07

### Fixed
- **`GET /api/config` and 23 other endpoints failed with `ENOENT: config.json`** after the v2.7.0 SQLite migration archived the file. Writes were already routed through `saveConfig()` (kv-backed), but every per-request reader still pulled the tree via `fs.readFile(CONFIG_PATH)` — fine while the file existed alongside the new kv row, but ENOENT'd the moment migration renamed it to `config.json.migrated` on first boot. Most user-visible symptom: the SPA's "Downloaded Groups" sidebar rendered empty even though SQLite had the full group list. The Queue / Settings / Backfill panels silently degraded the same way. Replaced every stale read with `loadConfig()` (kv-backed since v2.7.0, self-heals when the merged shape diverges).
- **`GET /api/ai/perceptual-dedup/groups` no longer returns 500 with "Do not know how to serialize a BigInt"** — the BigInt `phash` field is stripped from response rows. The field was unused by the UI; the in-memory grouper still uses it internally.
- **Front-end API client aborts requests after 60 s** (`AbortController`) instead of hanging indefinitely when the backend stalls. Errors carry `timedOut === true` so callers can show a specific toast.

### Tests
- `tests/api-resilience.test.js` (5) — Express error-middleware shape, `api.js` fetch-timeout abort path, `findPhashGroups` response is JSON-safe.

### Internal
- SW bumped `v277` → `v278`.

## [2.7.1] — 2026-05-06

### Changed — NSFW review tool redesign
- Grid view (3 / 4 / 6 cols by breakpoint) replaces the one-row-per-file list; click a tile to open the full media viewer with score / tier overlay.
- Lightbox shortcuts: `w` whitelist (or restore) · `r` re-classify · `d` delete. Actions auto-advance so the operator never has to click "next".
- Page shortcuts (modal closed): `[` / `]` page · `1`-`5` pick tier · `0` clear tier.
- Tier + page + show-whitelisted live in `#/maintenance/nsfw?tier=...&page=...&whitelisted=...` so refresh / back-button restore filter context. Bare URL defaults to the `uncertain` tier.
- "Show whitelisted" toggle + per-row Restore + bulk "Restore all" recover from accidental whitelists. `/v2/unwhitelist` now accepts the same `{tier|...}` body shape as the other bulk endpoints.
- Histogram: `h-32`, tier-band shading behind bars, vertical threshold marker (`τ` label), x-axis ticks at 0 / 25 / 50 / 75 / 100%.
- Settings card collapses into a native `<details>` / `<summary>` so the review surface lives above the fold.

### Performance
- `getNsfwHistogram` is one `GROUP BY bin` SQL pass (was: load every score into Node and bin in JS).
- `getNsfwTierCounts` is one `CASE-SUM` (was: 5 separate `COUNT(*)`).
- `getNsfwIdsByTier` is one `SELECT id` (was: paginated walker, 75+ queries on a 15k-row tier). `scoreMin` / `scoreMax` filters pushed into SQL.
- New partial index `idx_nsfw_tier (file_type, nsfw_whitelist, nsfw_score) WHERE nsfw_score IS NOT NULL` covers the hot path for tier counts, list pagination, and bulk-id resolution.
- Page init parallelises 5 independent fetches via `Promise.all`.

### Fixed — NSFW review
- Cache-clear confirm dialog now styles the destructive button correctly (`confirmDanger` was an unrecognized field; uses the documented `danger` flag).
- Bulk-action buttons recover automatically when a `nsfw_bulk_done` event drops in flight: 60 s watchdog re-polls `/v2/bulk/status`, and `ws.on('open')` reconciles on reconnect.
- `nsfw_bulk_progress` payload's `processed` / `total` now drives a live "Processing N / M…" hint instead of being discarded.
- Duplicate "Keep" per-row button removed (was a wrapper around `/v2/reclassify`).

### Fixed — HTTP resilience (no more 502 bursts on transient errors)
- HTTP server drains in-flight requests on uncaught exceptions instead of calling `process.exit(1)` immediately. Concurrent clients hitting the box during the watchdog restart window used to all see `502 Bad Gateway`; the 5-second drain lets them complete (or get a clean 5xx) first.
- Express error middleware converts a thrown route handler or `next(err)` call into a JSON 500 instead of leaving the response open until the reverse proxy times out (which surfaces as 502 to the client).
- Node socket timeouts aligned with reverse-proxy windows — `keepAliveTimeout` 65 s, `headersTimeout` 70 s, `requestTimeout` 120 s. The Node default of 5 s let nginx / Cloudflare reuse a keep-alive socket the origin had already closed, producing spurious 502s.

### Tests
- `tests/db-nsfw.test.js` (11) — tier-counts shape, histogram density + bin clamp, ids resolver edge cases, `EXPLAIN QUERY PLAN` index selection.

## [2.7.0] — 2026-05-06

### Changed — Runtime state moves into SQLite
- **`data/config.json` → `kv['config']` row** in `data/db.sqlite`. `loadConfig()` / `saveConfig()` keep their existing signatures; only the storage backend changes. Atomic writes ride on SQLite transactions instead of tmp+rename.
- **`data/web-sessions.json` → `web_sessions` table.** Indexed `expires_at` makes the GC sweep an O(log n) delete instead of a whole-file rewrite on every login/logout.
- **`data/disk_usage.json` → `kv['disk_usage']` row.** Same 10-second debounce window, no more JSON file on disk.
- **`fs.watch` → in-process `EventEmitter`.** `saveConfig()` emits `change` synchronously after the row commits; `monitor.js` subscribes via `watchConfig()` and reloads without a filesystem signal. Removes the 100 ms debounce and dodges the cross-platform inconsistency of `fs.watch`.

### Added
- Generic kv accessors in `src/core/db.js`: `kvGet`, `kvSet`, `kvDelete`, `kvList`.
- Session accessors: `insertSession`, `findSession`, `deleteSession`, `deleteAllSessions`, `deleteSessionsByRole`, `deleteExpiredSessions`, `listSessions`.
- `src/core/state-migration.js` — one-shot importer that runs inside `getDb()` on first boot. Reads any leftover `config.json` / `disk_usage.json` / `web-sessions.json`, writes them into the new tables, then renames the sources to `<file>.migrated` as a reversible backup. Idempotent on re-run.

### Migration
Existing installs upgrade in place — first boot moves your settings, sessions, and disk-usage cache into `data/db.sqlite` and renames the JSON files to `*.migrated`. To roll back, stop the dashboard, rename the `.migrated` files back to `.json`, and downgrade.

### Tests
- `tests/kv.test.js` (8) — round-trip, UPSERT, updated_at, delete, list, corrupt-row tolerance.
- `tests/web-sessions.test.js` (8) — insert / find / role check / by-role / GC / self-clean of expired tokens.
- `tests/state-migration.test.js` (5) — full fixture: 3 JSON files in, 3 rows out + `.migrated` renames + expired-token drop.
- `tests/config-manager.test.js` (7) — kv-backed seed, deep-merge, self-heal write-back, addGroup upsert, EventEmitter delivery + unsubscribe.

## [2.6.17] — 2026-05-06

### Added
- **Queue page batch actions + Retry All.** The Queue only had per-row controls and three "all queued" shortcuts (pause/resume/cancel); long failure runs after a network hiccup or session re-auth meant clicking Retry on every failed row, and there was no way to act on a chosen subset. This release adds: per-row checkboxes + a header tri-state checkbox; click toggles, Shift+click does range, Ctrl/Cmd+click toggles a single row, Ctrl/Cmd+A selects all visible, Esc clears; a floating action bar that appears at the bottom when ≥1 row is selected and mirrors the per-row vocabulary (Pause / Resume / Retry / Dismiss / Cancel) — the bar respects the queue page's visibility so it doesn't leak across navigation; and a new "Retry All" toolbar button that's disabled when there are no failed rows. Backed by two new endpoints — `POST /api/queue/retry-all` walks every cached failed job, and `POST /api/queue/batch` accepts `{ keys, action }` so one user gesture is one round trip regardless of selection size. Selection survives WS churn (jobs are pinned by key, not row ref); rows that disappear via cancel/dismiss are pruned out of the selection automatically.

### Internal
- SW bumped `v276` → `v277`.

## [2.6.16] — 2026-05-06

### Fixed
- **Docker image shipped ffmpeg with VA-API compiled in but no userland drivers**, so `-hwaccel vaapi` silently fell back to CPU decode inside the container even when the host passed `/dev/dri` through. The Settings → Advanced → Thumbnails dropdown listed `vaapi` as available (because `ffmpeg -hwaccels` advertises it from compile-time support, regardless of runtime), but selecting it produced no actual acceleration. Adds `intel-media-va-driver` (iHD, Gen8+ + Quick Sync runtime), `i965-va-driver` (Gen4-Gen7), and `vainfo` (operators can now `docker exec <ctr> vainfo` to confirm the driver loaded inside the container without baking their own debug image). All three packages live in Debian bookworm `main` so no non-free repo enablement is required. AMD users go through Mesa's `radeonsi` (`mesa-va-drivers`) — left out to keep the image lean; can be added in a follow-up if reported.

### Internal
- SW bumped `v275` → `v276`.

## [2.6.15] — 2026-05-06

### Fixed
- **Auto-download silently routed every job through the default Telegram client**, even when the chat was only reachable via a 2nd/3rd account. Monitor's poll/handler paths and history's backfill now pin the working client into each job, and `DownloadManager` prefers `job.client` over its constructor-injected default for both `downloadMedia` and the `FILE_REFERENCE_EXPIRED` refresh path. Symptoms: groups visible only to a non-default account would surface in the Monitor stats but their files never landed on disk (or pulled from the wrong session).
- **`/api/download/url` mutated `downloader.client` per request** as a hack to switch sessions for a paste-link job — a latent race where any concurrent download suddenly tried to fetch bytes through the URL-resolver's session. Replaced with a per-job `client` field. Stories download + retry-from-Queue retain the same client too, so a job that originally ran on account #2 doesn't fall back to the default on retry.

### Added
- **Queue page now shows which Telegram account pulled each job**, as a small chip next to the filename. New `AccountManager.getIdForClient()` reverse-lookup powers the attribution; snapshot + WS payloads (`download_start`, `download_progress`, `download_complete`, `download_error`) carry `accountId` + `accountName`. Legacy rows without account info skip the chip cleanly. Tooltip i18n keys: `queue.account.tooltip` (en + th).

### Internal
- SW bumped `v274` → `v275`.

## [2.6.14] — 2026-05-06

### Internal
- **Toolchain swap: Biome 2 + Lefthook replaces eslint, prettier, husky, and lint-staged.** Single binary now does lint + format + autofix; pre-commit hook runs `biome check --write` only on staged files (via `{staged_files}` in `lefthook.yml`). Lint config tuned to match the prior eslint.config.js intent (project predates a linter — focus on real bugs, not style; rules that would force source-code rewrites are off and can be enabled in follow-up PRs). 128 files reformatted on first pass — pure whitespace + quote churn from switching formatters; no behavior changes. README, CONTRIBUTING, and AUDIT.md updated to reflect the new toolchain. Five CodeQL alerts on the merge ref were dismissed (`won't fix`) because they were re-detections of pre-existing patterns at line numbers that shifted under reformat — the underlying logic was untouched. (PR #28)
- Removed `apps/` and `packages/` directories — leftover artifacts (~10 MB) from a never-shipped monorepo experiment, unrelated to the runtime.
- README's `npm run web` reference was a long-standing dead link (no such script). Replaced with `npm start` (dashboard) and `npm run menu` (interactive CLI menu).
- SW bumped `v273` → `v274`.

## [2.6.13] — 2026-05-06

### Fixed
- **Manage Groups only showed chats from one account** when 2+ Telegram accounts were linked. `/api/dialogs` was calling `getDialogs()` on the AccountManager's *default* client only, so any chat exclusive to a second/third account silently disappeared from the picker (the sidebar's `/api/groups` view was already correct because it goes through `getDialogsNameCache()`, which fans out across all clients). The endpoint now fans out across every connected client in parallel, dedupes by chat id (first sighting wins; active beats archived), and also returns an `accounts: [{id, name, phone, username}]` directory + `accountIds: []` per dialog so the SPA can attribute each chat back to the account(s) it lives in.
- **Manage Groups now shows account chips** under each chat title (only when 2+ accounts are linked — single-account installs see no change). Each account gets a stable color hashed from its id so the same chip is recognisable across rows + reloads. The chip label prefers `@username`, falls back to phone, then display name. Hovering shows a richer title (name · phone · @username). A chat shared by both accounts gets two chips. Added on `.chat-row .row-account-chips` + `.chat-row .account-chip` with dark/light theme variants.
- **i18n: 8 referenced keys were never added to the locale files** so they showed their inline fallback text in both English and Thai instead of the translation: `maintenance.dedup.set_header_v2`, `maintenance.dedup.set_reclaim`, `maintenance.dedup.loading_remaining`, `maintenance.dedup.stat.{sets,copies,files,reclaim}`, and `maintenance.ai.toggle.failed`. Added all 8 to `en.json` + `th.json` (en/th now have full key parity at 1335 each).
- **`tests/shortcut-overrides.test.js` was failing 5/6 in `vitest run`** because the polyfill installed at module top-level only ran when `globalThis.localStorage` was strictly `undefined`; some other test in the suite leaked a stub Storage object (no `setItem`) onto the global, so the polyfill never installed and `localStorage.setItem(...)` from inside test bodies threw. Switched to always-assigning the polyfill and re-installing in `beforeEach` so each test sees a fresh writable store regardless of suite ordering.

### Internal
- SW bumped `v272` → `v273`.

## [2.6.12] — 2026-05-06

### Fixed
- **Maintenance tab strip was hidden on the Video page** added in v2.6.10. The CSS `display: flex` rule that toggles the `#maintenance-tabs` strip on per-feature pages enumerates each page slug explicitly (`body[data-page="maintenance-thumbs"] #maintenance-tabs, …`); `maintenance-video` was missing from that list, so navigating into `/#/maintenance/video` hid the strip + back link entirely. Adds the missing selector. (PR #25)

### Internal
- SW bumped `v271` → `v272`.

## [2.6.11] — 2026-05-06

### Fixed
- **Mobile gallery video viewer flashing "Error 4: playback failed"** on roughly a quarter of opens, with the Retry button always succeeding. Cause: mobile Safari (and occasionally Chrome on Android) fires a spurious `MEDIA_ERR_SRC_NOT_SUPPORTED` event right after the first `src=` assignment when an in-flight HTTP fetch from a previous unload is still aborting. The user-visible Retry was doing the same thing the new auto-retry does — re-assign the same URL and call `load()` — so the file itself was never broken. Fix: `_showError()` silently retries once when the error code is 4 on a first attempt (bounded via `_errorRetries`, reset every `.load()`), and `unload()` now nulls out `video.onerror` *before* `removeAttribute('src') + load()` so the abort no longer fires a stray event into a stale handler. Genuine unsupported-codec failures still surface the overlay after the single retry. (PR #23)

### Internal
- SW bumped `v270` → `v271`.

## [2.6.10] — 2026-05-06

### Added
- **Maintenance → Optimise videos for streaming** (`#/maintenance/video`). MP4 / M4V / MOV / 3GP files whose `moov` index atom lives at the end of the file (the encoder default for many sources, including the clips this app downloads from Telegram) break the HTML5 `<video>` element in subtle ways: the player has to fetch every byte of `mdat` before it can paint a frame, decode audio, or honour a seek — so the gallery viewer looked like the video had no audio and the seek bar was dead. The new sweep walks every catalogued video, peeks the first 64 bytes to find the second atom, and rewrites any file whose `moov` is not at the head with `ffmpeg -movflags +faststart -c copy -map 0`. Stream-copy means no re-encode and no quality loss; the operation is I/O bound and finishes in seconds per file. Atomic publish via `<file>.faststart.tmp` + rename, sanity-checked tmp size (within 5–110 % of source) so a half-written file never overwrites the original. Concurrency capped at 2 by default (env `FASTSTART_CONCURRENCY`); WS progress + done events drive a determinate progress bar; `/api/maintenance/faststart/status` recovers in-flight state on tab reopen. The dashboard surfaces total / optimised / pending / skipped counts. Scan is admin-only and gated by `_faststartRunning` single-flight.
- **Auto-faststart on every new download.** The downloader fires `optimizeDownloadInBackground(id)` after the post-insert thumb pre-generation, so MP4s land in faststart-optimised form for the gallery's first view. No-op for non-video / non-MP4 / already-optimised rows. Same fire-and-forget shape as the thumb pre-gen — failures are warned once to console and silently retried by the maintenance sweep next time.

### Migration
Existing libraries: open `Maintenance → Optimise videos for streaming` once, click `Optimise all`, wait. The sweep runs in the background; you can leave the page or close the tab. New downloads after the upgrade are fixed inline.

### Internal
- SW bumped `v269` → `v270`.

## [2.6.9] — 2026-05-06

### Fixed
- **Video thumbnails were missing on Debian-based Docker hosts** (every `/api/thumbs/<id>` for a video row returned `404 "No thumb"` while images worked fine, and `Maintenance → Build all` reported `built=0` with `errored=0` because failures were silently coerced to "skipped"). Root cause: `_generateVideoThumb` writes a `<sha>.webp.tmp` file for atomic-rename-on-success, but the system `/usr/bin/ffmpeg` from `apt-get install ffmpeg` (Debian 12 / bookworm) refuses to infer the output muxer from a `.tmp` extension and exits non-zero with `Unable to find a suitable output format`. The bundled `@ffmpeg-installer/ffmpeg` build used on macOS / Windows happens to fall back to the codec hint, which is why localhost worked while production did not. Fix: pass `-f webp` explicitly in the single-pass libwebp branch so the muxer is named regardless of the destination filename. The JPEG → sharp fallback path was not affected (its tmp file already ends in `.jpg`).

### Internal
- SW bumped `v268` → `v269`.

## [2.6.8] — 2026-05-05

### Fixed
- **Gallery tile thumbnails were stuck at `opacity: 0`** so every photo and video tile rendered as a black box even though the WebP thumb file was generated, the HTTP response was 200, and the `<img>` element loaded successfully. CSS keeps `.media-item img` invisible until a `.loaded` class is added — that class used to be wired up by the lazy-load IntersectionObserver, but the tile template had moved to native `loading="lazy"` and no longer carried `data-src`, so the observer never fired. The tile now adds `.loaded` from inline `onload` / `onerror` handlers, which works for both successful loads and 404 fallbacks. (PR #19)

### Changed
- **Node baseline raised to 22 LTS** (was `>=20.0.0`). Node 20 reaches EOL April 2026; 22 has been LTS since October 2024. The Docker runtime image moves to `node:24.15.0-bookworm-slim` (current Active LTS, supported through April 2027). `src/index.js`'s doctor check is updated to match. (PR #20)
- **CI matrix** now tests against Node `22` and `24` instead of `20` and `22`. (PR #20)
- **Production deps bumped** by dependabot's grouped PR: `@aws-sdk/client-s3` 3.1041.0 → 3.1042.0, `@aws-sdk/lib-storage` 3.1041.0 → 3.1042.0, `better-sqlite3` 12.6.2 → 12.9.0, `ws` 8.19.0 → 8.20.0. (PR #21)
- **GitHub Actions bumped** by dependabot's grouped PR: `actions/checkout` v4 → v6, `actions/setup-node` v4 → v6, `github/codeql-action` v3 → v4, `docker/setup-buildx-action` v3 → v4, `docker/build-push-action` v6 → v7, `docker/login-action` v3 → v4, `docker/metadata-action` v5 → v6 (8 actions total). `release-drafter/release-drafter` is intentionally pinned at v6 — v7 currently fails on `pull_request` triggers with `Validation Failed: target_commitish` because it tries to update the in-progress draft against `refs/pull/<n>/merge`, which the GitHub Releases API rejects. Revisit once upstream cuts a v7 patch. (PR #16)

### CI
- **Docker smoke test fixed** — was flaking on every PR with `FAIL: no node process running as node user`. The healthcheck-then-`ps` approach grepped column 2 (`COMMAND`, where `comm` is truncated) with a fragile `awk` pattern that silently failed even when `ps -ef` could see the node process. Switched to grepping column 1 (`UNAME`) of `ps -ef` directly, wrapped in a 10× / 1 s retry loop purely for boot timing. The retry never had to fire on the verifying run; the column choice was the actual bug. (PR #20)

### Internal
- SW bumped `v267` → `v268`.

## [2.6.7] — 2026-05-05

### Fixed
- **Default AI face + tag models swapped** to publicly-accessible alternatives. `Xenova/yolov5n-face` and `Xenova/mobilenet_v2` are gated/restricted on HuggingFace (return 401 even with a valid `Read` token, while `Xenova/clip-vit-base-patch32` and other Xenova models work fine). New defaults:
    - faces: `Xenova/yolos-tiny` (general detector, "person" class drives the clustering pipeline; ~31 MB)
    - tags: `Xenova/vit-base-patch16-224` (ImageNet-1k head, drop-in replacement for the tag cloud)

### Migration
Existing configs still pointing at `Xenova/yolov5n-face` / `Xenova/mobilenet_v2` need to be flipped manually: open `/maintenance/ai` → Models panel → paste the new id into the Apply field, click Apply, then preload.

### Internal
- SW bumped `v266` → `v267`.

## [2.6.6] — 2026-05-05

### Fixed
- **AI master Start/Stop toggle now lives in static HTML** at the top of `/maintenance/ai`. Was rendered dynamically inside the Capabilities grid, which meant a stale-cache JS bundle (or any render-path failure) hid it entirely — operators saw "Start scan" buttons but no way to actually start the subsystem. Static markup keeps the control visible regardless of what the grid does. State pill (`On` / `Off`) syncs live with the toggle.

### Internal
- SW bumped `v265` → `v266`.

## [2.6.5] — 2026-05-05

### Added
- **HuggingFace token "Test" button** on `/maintenance/ai`. Pings `huggingface.co/api/whoami-v2` with the typed (or saved) token. Shows green "signed in as <name>" on success, red "Token rejected by HuggingFace" on 401 — so the operator knows the token works before kicking off a model preload.
- **Show/hide eye toggle** on the token field so operators can verify they pasted the right value without re-typing.
- **"Get a token →" link + collapsible How-to** (sign in → Settings → Access Tokens → Read role → paste). Removes the "where do I find this?" friction.

### Internal
- New endpoint `POST /api/ai/hf/test { token? }` → `{ ok, status, name?, message? }`. Falls back to the saved `advanced.ai.hfToken` when the body's `token` field is empty so a save-then-test flow works too. 5-second timeout, 401/network errors surface verbatim.
- SW bumped `v264` → `v265`.

## [2.6.4] — 2026-05-05

### Fixed
- **Share v2 URLs returning "Invalid share link"** — route handler still expected the legacy `?exp=&sig=` shape; URL builder generates `?s=<sig>` (v2). Handler now accepts both, looks up the row first, and verifies the sig against the stored `expires_at`. Filename slug routes (`/share/<id>/<filename>?s=…`) also work.
- **Stale CSS in production** — `<link href="/css/main.css?v=2.6.0">` was hard-coded. Newer releases shipped CSS classes (`.share-maint-toolbar`, `.log-src-chip`, `.ai-hero`) that the SW kept serving from the v2.6.0 cache. The cache-bust rewriter now covers `/css/` paths too, and the `<link>` no longer carries a stale literal version.

### Added
- **HuggingFace access token field** on `/maintenance/ai`. Set it from the web instead of needing `HF_TOKEN` in env. Stored in `config.advanced.ai.hfToken`; both NSFW and AI capability loaders read it.

### Internal
- SW bumped `v263` → `v264`.

## [2.6.3] — 2026-05-05

### Fixed
- **pHash write crash** — "The bound string, buffer, or bigint is too big". `setPhash` now bit-casts the unsigned 64-bit hash into the signed 64-bit range SQLite can store, and `listAllPhashes` reads in `safeIntegers(true)` mode so values outside JS Number's 2^53 envelope round-trip cleanly. Hamming distance still works at the bit level (the helper masks back to 64 bits before XOR).
- **AI model loads behind 401 / rate limits** — every transformers.js fetch now sends an `Authorization: Bearer …` header when `HF_TOKEN` (or `HUGGINGFACE_TOKEN` / `HUGGINGFACEHUB_API_TOKEN`) is set in env. Lets operators pull gated repos + dodge anonymous rate-limit walls.
- **Docker smoke test exit 127** — bookworm-slim runtime image was missing `procps`, so the CI smoke test's `docker exec smoke ps -o user=,comm=` returned 127. `procps` is now installed in the runtime stage (~500 KB).

### Internal
- SW bumped `v262` → `v263`.

## [2.6.2] — 2026-05-05

### Fixed
- **NSFW default model swapped** to `AdamCodd/vit-base-nsfw-detector`. The previous default `Falconsai/nsfw_image_detection` is PyTorch-only — its `onnx/` directory 404s, so transformers.js can't load any of the dtype variants (q8/fp16/fp32/q4 all fail). AdamCodd ships full ONNX coverage and is the de-facto transformers.js NSFW classifier.
- Operators on a fresh install no longer hit "Could not locate file" preload errors out of the box.

### Internal
- SW bumped `v261` → `v262`.

## [2.6.1] — 2026-05-05

### Fixed
- NSFW model load — default `dtype: 'q8'` (quantized) + auto-fallback through fp16/fp32/q4 when the chosen variant isn't on the HF CDN.
- Queue rows missed the duplicate flag — `runtime._serializeJob` now propagates `deduped`; rows render a "Duplicate" tag + a Duplicate filter chip.
- `confirmSheet` accepts both `{message,confirmLabel,danger}` and `{body,confirmText,destructive}` (half the call sites silently dropped options before).
- Service Worker `/js/` strategy flipped to network-first so stale `.js` can't outlive a deploy. Bumped `v260` → `v261`.
- Trimmed verbose Maintenance-card help text.

### Added
- NSFW: model-id input + precision picker + Preload-now button + Preload-on-start toggle + Wipe cached weights. Endpoints: `POST /api/maintenance/nsfw/preload`, `GET /api/maintenance/nsfw/model-status`, `DELETE /api/maintenance/nsfw/cache`.
- AI master switch + per-capability toggles on `/maintenance/ai`.
- Settings chip-nav — 10 chips per top-level card with IntersectionObserver-driven active state.
- Active share links modal — stats grid + sticky toolbar + filter chips + Cleanup-expired bulk action + polished row design (state pill, Open/Copy/Revoke 28×28).
- Logs filter chips — branded toggle pills with per-source coloured dot + live count badge + All/None.
- Duplicates page — bulk "Keep oldest / Keep newest / Clear" toolbar.
- Install-update button disables + relabels to "Up to date" when on the latest release.
- Verify-files done event also lands in the bell notification list.

### Changed
- Per-tool settings moved to per-tool maintenance pages (no duplicate in Settings → Advanced).
- Backfill page patches active rows in place on WS progress (was full innerHTML rewrite per tick).
- AI hero search drops purple accent — uses Telegram blue, label-above-chip layout, disabled mic removed.
- Thumb-miss warning: 15-min window + 200-miss floor + 30-min cooldown + opt-out toggle (~2/h instead of ~60/h).
- `notify-clear-btn` icon-only.

### Internal
- New config keys: `advanced.nsfw.dtype`, `advanced.nsfw.preload`, `advanced.thumbs.warnMisses` (allow-list-validated).
- New WS events: `nsfw_model_downloading`, `ai_model_progress`.
- `setupAutoSave` binds at `<body>` so per-tool settings cards autosave through the same pipeline.

## [2.6.0] — 2026-05-04

### Added — Single-row Maintenance hub
- **Sidebar collapsed from 6 maintenance entries to 1.** A new `#/maintenance` hub page renders every tool as a card grid (1 / 2 / 3 columns by viewport) with live status pills wired to the WS progress channel. Per-feature deep links (`/maintenance/duplicates`, `/maintenance/nsfw`, etc.) still resolve directly so power users keep their muscle memory.
- New `src/web/public/js/maintenance-hub.js` (~120 LOC) — coalesced WS dispatcher + status hydration on (re-)entry.
- Mobile + desktop both benefit; the previous 5+ rows dominated the sidebar at every viewport.

### Added — Local AI search & smart organisation (opt-in)
- **Semantic search** — CLIP image+text embeddings (`Xenova/clip-vit-base-patch32`, ~90 MB, WASM). `POST /api/ai/search { query }` returns top-K rows ranked by cosine similarity.
- **Face clustering ("People")** — YOLOv5n-face detector + CLIP-on-crop embeddings + DBSCAN. Admin can rename clusters and browse photos per person.
- **Auto-tag** — ImageNet classifier (`Xenova/mobilenet_v2`, ~14 MB) writes top-K labels per photo into `image_tags`. Powers the tag cloud + #tag filter on the new page.
- **Perceptual dedup (pHash)** — DCT-based 64-bit hash, no model required. Groups near-duplicates by Hamming distance; reuses the existing dedup-delete pathway.
- New page `#/maintenance/ai` with toggles, scan progress, search, tag cloud, people grid, and near-duplicate groups. Default-OFF; every capability is gated by `config.advanced.ai.<cap>.enabled`.
- 12 endpoints under `/api/ai/*`, all admin-only and JobTracker-driven (returns 200 immediately, WS progress).
- Models lazy-loaded into `data/models/` (override with `AI_MODELS_DIR`); fresh installs pull zero AI weights.
- Optional `sqlite-vec` fast-path auto-detected at boot; in-memory cosine fallback covers libraries up to ~50k photos.
- Documentation: `docs/AI.md` (architecture, models, troubleshooting); `docs/DEPLOY.md` env-var table updated; README "Why people use it" bullet added.
- 17 new tests under `tests/ai/`: pHash determinism + Hamming distance, vector-store BLOB round-trip + cosine + top-K ordering, DBSCAN cluster isolation.

### Added — Gallery + viewer polish
- Right-click context menu on gallery tiles (Open / Download / Copy link / Share / Pin / Forward / Delete); `ContextMenu` key fires the same menu on the focused tile.
- Pin / unpin per file (star icon on every tile) + a "Pinned" filter chip in the gallery type strip + opt-in "Surface pinned at the top" library setting.
- Drag-drop a `t.me/...` URL anywhere on the dashboard → auto-queue download with a dashed-border drop overlay.
- Bulk **Download ZIP** button on the selection bar — streams a STORE-mode archive (multi-GB safe, no archive ever lives in RAM).
- Mini-player — sticky bottom-right preview that keeps a video clip playing after the viewer modal is closed; click to expand back. Opt-in via `viewer-shrink-on-close` localStorage flag.
- In-app changelog viewer — overlay sheet that fetches `/CHANGELOG.md` and renders a markdown-parsed timeline, triggered by clicking the version chip in the status bar.
- Locales: new `gallery.context.*`, `favorites.*`, `viewer.pip.*`, `viewer.selection.*`, `dragdrop.*`, `prefs.*`, `tour.*`, `changelog.viewer.*`, `groups.accent_color`/`groups.description`/`groups.rename_inline`, `storage.breakdown.*` keys in `en` + `th`.

### Added — Power-user / accessibility
- Screen Wake Lock during downloads — feature-detected via `navigator.wakeLock`; auto-acquires when a job is in flight, releases when the queue drains, re-acquires on tab visibility-change.
- System notifications on download complete + click-to-focus dashboard. New `notifyGeneric(title, body)` helper for one-shot finished events.
- Keyboard shortcut customisation — `localStorage['tgdl-shortcut-overrides']` lets users rebind every shortcut; new exports `loadShortcutOverrides`, `setShortcutOverride`, `effectiveShortcuts`, `resetShortcutOverrides` from `shortcuts.js`.
- High-contrast mode — `@media (prefers-contrast: more)` block in `main.css` plus a manual `html[data-contrast="more"]` toggle.

### Added — Server endpoints
- `POST /api/downloads/:id/pin { pinned: bool }` — toggle the `pinned` column. Broadcasts `download_pinned` over WS.
- `POST /api/downloads/bulk-zip { ids: [...] }` — streams a ZIP attachment of every requested file. Cap: ~4 GiB total + 65 535 entries (no ZIP64). Filename: `tgdl-<group>-<count>files-<ts>.zip`.
- `GET /api/downloads/all?pinned=1&pinnedFirst=1` and `GET /api/downloads/:groupId?pinned=1&pinnedFirst=1` — opt-in pinned filter / sort.
- `GET /CHANGELOG.md` — read-once Markdown serve for the in-app viewer (admin + guest), 1-hour `must-revalidate` cache.

### Added — DB
- `setDownloadPinned(id, pinned)` and `getDownloadById(id)` in `src/core/db.js`.
- `getAllDownloads` / `getDownloads` accept `{ pinnedOnly, pinnedFirst }` opts; existing callers behave identically.

### Performance
- **Hash worker pool** — new `src/core/hash-worker.js`. SHA-256 streaming on a `worker_threads` pool (default `min(8, ⌊cpus/2⌋)`, `HASH_WORKER_POOL_SIZE` overrides). Wired into `core/downloader.js` and `core/dedup.js` so multi-GB hashing no longer blocks the main event loop.
- **HTTP compression** — optional `compression` middleware enabled via `createRequire` (gracefully no-ops if the package isn't installed). Skips already-compressed media (`image/*` / `video/*` / `audio/*`). `COMPRESSION_LEVEL` env var (default 6).
- **Static asset caching** — `/icons/*` joins `/css/*` and `/js/*` in the 1-year `immutable` Cache-Control bucket when the request carries the `?v=`. `/locales/*` gets `must-revalidate` for translation freshness.
- **`<link rel="modulepreload">`** for the SPA's hot-path import graph (`app.js`, `api.js`, `ws.js`, `router.js`, `i18n.js`, `store.js`, `utils.js`).
- **Streaming bulk ZIP** — pure-JS PKZIP writer (`src/core/zip-stream.js`) with backpressure-aware piping so a 5 GB selection writes through to the response sink without buffering.

### Tests
- `tests/perf-headers.test.js` (8) — Cache-Control assertions for `/css/`, `/js/`, `/icons/`, `/api/*`, `/sw.js`, `/locales/*`, `/files/*`.
- `tests/hash-worker.test.js` (5) — known SHA-256 round-trip across the pool, in-process streamer, concurrent requests, missing-file rejection, `HASH_WORKER_DISABLE=1` fallback.
- `tests/zip-bulk.test.js` (3) — EOCD parse, STORE-mode round-trip across multiple files, `safeArchiveName` invariants.
- `tests/shortcut-overrides.test.js` (6) — defaults, override persistence, replacement, reset, malformed JSON tolerance, defensive type filtering.

### Docs
- `docs/DEPLOY.md` — env var rows for `HASH_WORKER_POOL_SIZE`, `HASH_WORKER_DISABLE`, `COMPRESSION_LEVEL`.
- `README.md` — two new bullets under "Why people use it" (gallery polish + perf passes).

## [2.5.0] — 2026-05-04

### Added — Universal background-job pattern
- **`src/core/job-tracker.js`** — single-flight orchestration primitive every long-running admin endpoint now wraps. Exposes `tryStart(runFn)` (returns `{started:true}` or 409 `ALREADY_RUNNING`), `cancel()` via AbortController, `getStatus()` snapshot, automatic WS broadcast of `<kind>_progress` + `<kind>_done`, plus `log()` integration. **Cloudflare-safe by construction**: every wrapped POST returns ≤500 ms.
- **13 endpoints converted** to fire-and-forget — previously any of these could time out behind a 100 s reverse-proxy: `files/verify`, `db/vacuum`, `db/integrity`, `restart-monitor`, `resync-dialogs`, `dedup/delete`, NSFW v2 bulk-{delete,whitelist,unwhitelist,reclassify} (shared tracker), `thumbs/rebuild`, `auto-update`, `groups/refresh-info`, `groups/refresh-photos`, `groups/:id/purge` (multi-flight per id), `purge-all`. Each gets a `/status` companion, a WS event prefix, and a frontend that hydrates state on init.
- **`src/web/public/js/job-buttons.js`** — frontend helper. `wireJobButton({ btn, statusUrl, eventPrefix, runUrl })` — one binding, six call sites in Settings. Hydrates from `/status` on mount, listens to WS, handles 409 by re-hydrating instead of erroring.
- **Multi-client coordination**. Start a `Build all thumbnails` on a phone → desktop's button immediately disables. Cancel from desktop → both clients re-enable. State lives on the server, every client is a renderer.
- **Cancel + abort threading**. Long jobs accept an `AbortSignal`; clicking Cancel stops the worker within seconds.
- 14 new tests (`tests/job-tracker.test.js` + `tests/job-tracker-multi-client.test.js`) — single-flight, 409 path, abort propagation, two virtual WS clients receive the same payload.

### Added — Backup destinations (NAS-style multi-provider mirror + snapshot)
- **`#/maintenance/backup`** — full-page admin surface for off-host backups. Cards-grid layout with per-destination Run / Pause / Test / Edit / Remove buttons + recent-jobs strip + WS-driven live state.
- **Three first-class providers**: S3-compatible (covers AWS / Cloudflare R2 / Backblaze B2 / MinIO / Wasabi from one driver via `@aws-sdk/client-s3`), local filesystem / NAS mount, SFTP (`ssh2-sftp-client`).
- **Three modes per destination**: `mirror` (every `download_complete` enqueues a job), `snapshot` (cron-scheduled tar.gz of `db.sqlite` + `config.json` + `sessions/`, retains last N copies on the remote), `manual` (only fires on `POST /run`).
- **Persistent retry queue** — DB-backed (`backup_jobs`), exponential backoff (capped 30 min), max-attempts giveup, boot-time recovery of stuck `uploading` rows.
- **Optional client-side encryption** — AES-256-GCM with a per-destination salt + PBKDF2-SHA256 (200k) key derivation. Passphrase lives in process memory only; restart re-prompts via the dashboard's Unlock action. File format: `magic 'TGDB' | version | iv | ciphertext | tag`.
- **Credentials encrypted at rest** — provider configs in `backup_destinations.config_blob` are AES-256-GCM-encrypted under a KEK derived from `config.web.shareSecret`.
- **Endpoints**: `GET/POST /api/backup/destinations`, `PUT/DELETE /:id`, `POST /:id/test|run|pause|resume|encryption|unlock`, `GET /:id/status|jobs`, `GET /api/backup/jobs/recent`, `POST /api/backup/jobs/:id/retry`, `GET /api/backup/providers`.
- **WS events**: `backup_destination_added/updated/removed`, `backup_progress`, `backup_done`, `backup_error`, `backup_queue_drained`.
- **Stub providers** for FTP / Google Drive / Dropbox — wizard pickers list them as "coming soon"; their dependencies are `optionalDependencies` so default installs stay slim.
- **`BACKUP_WORKERS_PER_DEST`** env var (default 3) caps per-destination concurrency.
- 20 new tests (encryption round-trip, credentials encrypt/decrypt with rotation, queue retry timing, local-provider full I/O); 2 S3 tests skipped without `MINIO_TEST_ENDPOINT`.

### Changed — Share-link URL format (v2.5)
- **`/share/<linkId>?exp=<sec>&sig=<43chars>`** → **`/share/<linkId>/<filename>?s=<43chars>`**. The expiry is now read from the DB row (single source of truth), the URL drops `?exp=` entirely, and a sanitised filename segment makes downloads land with a sensible name. The HMAC still binds `(linkId | exp_at_issue)`, so URLs minted before this release continue to verify cleanly — backwards compatible.
- **Telegram-themed error page** (`src/web/public/share-error.html`) — friends who hit an expired / revoked / bad-sig / not-found / file-missing link now get a branded card with icon, friendly title, and explanation instead of the raw `{"error":"Share link is not valid","code":"expired"}` JSON. Browsers get the HTML; `Accept: application/json` callers keep the JSON for backwards compat. Status code stays `401` so external scanners can't enumerate which link ids are valid.

### SW
- VERSION bumped `'v240'` → `'v250'` (semver-aligned for v2.5.x line). Service worker shell pre-cache picks up the new `share-error.html` automatically.

### Docs
- New `docs/BACKUP.md` — full provider walkthroughs, encryption / passphrase management, restore procedure, cost notes per provider.
- `docs/DEPLOY.md` — `BACKUP_WORKERS_PER_DEST` env var documented; share-link URL format note.
- `README.md` — backup bullet under "Why people use it", updated keywords.

## [2.4.0] — 2026-05-04

### Added — Maintenance pages (4 admin-only surfaces)
- **`#/maintenance/duplicates`** — full-page Find Duplicates: scan, group-by-hash review table, per-row keep/delete, bulk "keep oldest / newest", inline Re-index button. Replaces the in-Settings sheet.
- **`#/maintenance/thumbs`** — full-page Build Thumbnails: cache stats, fire-and-forget build with WS progress (`thumbs_progress`/`thumbs_done`), wipe-cache action, ffmpeg capability badge.
- **`#/maintenance/nsfw`** — full-page NSFW review with **5-tier dynamic logic** (def_not / maybe_not / uncertain / maybe / def, boundaries 0.3 / 0.5 / 0.7 / 0.9). Stats cards, score histogram (vanilla SVG), per-tier paginated list, per-row Keep / Delete / Whitelist / Re-classify, bulk-action toolbar, scan controls. Replaces the binary above/below threshold review.
- **`#/maintenance/logs`** — realtime server log viewer (admin). Subscribes to the new WS `log` channel + backfills the in-memory ring buffer via `GET /api/maintenance/logs/recent`. Filter by source / level, search, pause, autoscroll, download `.log`. Stops you from needing `docker logs` for routine debugging.
- All four pages enforce admin via `ADMIN_ROUTE_PREFIXES` (`router.js`) + `data-admin-only` (CSS gate) + the existing server-side `guestGate` middleware.

### Added — Re-index from disk
- **`POST /api/maintenance/reindex`** + companion `/status` — walks `data/downloads/` and `INSERT OR IGNORE`s catalogue rows for files the DB doesn't know about (idempotent on `(group_id, message_id)`). Recovers from a wiped DB without re-downloading from Telegram. Fire-and-forget, broadcasts `reindex_progress` + `reindex_done`. Surfaced from `/maintenance/duplicates`.

### Added — Realtime log channel
- **`log({ source, level, msg })`** helper in `src/web/server.js` writes into a 1000-entry ring buffer and broadcasts a `log` WS message. Mirrors to stdout/stderr so the docker-logs path keeps working. Used by NSFW scan progress, thumbs build, dedup, reindex, and a thumb-miss tally.
- **Notification bell** in the content-header — surfaces warn / error events from the WS `log` stream. Badge count, persisted last-50 in `localStorage`, browser tab title flash on important events while the tab is hidden, "Clear all" action.

### Added — HEIC display + sharp 0.34
- **HEIC / HEIF inline transcode** — `/files/<path>?inline=1` for `.heic` / `.heif` returns a JPEG via sharp + libvips libheif (built into sharp 0.34). Cached at `data/thumbs/heic-cache/<sha-of-path-and-mtime>.jpg`; raw bytes still serve when `?inline=1` is absent. iPhone uploads now preview in the gallery instead of falling into the "documents" bucket.
- `core/downloader.js` recognises `.heic` / `.heif` / `.gif` as `photo`, `.webm` as `video`, `.opus` / `.flac` as `audio`.

### Added — `npm run doctor` (diagnostics CLI)
- One-shot runtime check: Node version + ABI, config load, `better-sqlite3` open + row count (with `npm rebuild` hint on `NODE_MODULE_VERSION` mismatch), `data/` writability, port availability (honours `PORT`), `ffmpeg` on `PATH`. Cross-platform, non-interactive — safe for CI / Docker. Exits `1` on any blocking failure.

### Added — Auto-save Settings (debounced)
- Every Setting input now writes to `/api/config` 800 ms after the last edit, no scroll-to-Save round trip required. Inline status indicator: idle → "Editing…" → "Saving…" → "Saved at HH:MM:SS" with an ARIA-live region for screen readers. Tab-hide and field-blur flush early so unsaved edits don't vanish on tab close. The manual Save button stays as an early-flush escape hatch.

### Added — Mobile content-header overhaul
- Header restructured for narrow viewports: paste-link / stories / view-mode / refresh collapse into a `⋮` overflow menu at <640 px. Subtitle hidden, avatar/title shrunk, engine pill icon-only at <380 px. Always-visible cluster: menu / avatar / title / engine pill / 🔔 bell / select-mode.
- Per-page header icon (settings → ⚙️, queue → ✅, maintenance pages → relevant icons) — replaces the bug where a previously-selected group's photo bled across pages.

### Added — Force HTTPS hardening
- Confirm sheet on enable (defends against accidental clicks that lock the operator out of a fresh dashboard with no TLS cert behind it).
- `Strict-Transport-Security: max-age=31536000; includeSubDomains` on every secure response when Force HTTPS is on.
- New TLS-lockdown section in `docs/DEPLOY.md` with pre-flight checklist.

### Changed — Architecture
- **CSS extracted from `index.html`** — the inline `<style>` block (1525 lines) is now `src/web/public/css/main.css`, served via `<link rel="stylesheet" href="/css/main.css?v=2.4.0">`. Service worker preloads it via `SHELL_URLS`. `index.html` shrunk from 3847 → 2325 lines (-1522). Easier to edit, browser + SW cache the stylesheet independently of HTML changes. Future split into per-concern files (theme / layout / gallery / components) is queued for v2.4.1.
- **Docker base image: `node:20.20.2-alpine` → `node:20.20.2-bookworm-slim`.** `onnxruntime-node` ships glibc-only prebuilt binaries — alpine's musl libc could not load them, so containers died at boot with `Error loading shared library ld-linux-x86-64.so.2`. Bookworm-slim has glibc out of the box. `apk` swapped for `apt-get`, `su-exec` for `gosu` (drop-in equivalent), entrypoint path `/sbin/tini` → `/usr/bin/tini`. Image grows ~40 MB but actually runs.
- **`docker-compose.yml` defaults `TRUST_PROXY=1`** — most Docker deployments are behind a reverse proxy, and without this the rate-limiter floods stderr with `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` validation warnings on every request.
- **Background-job pattern** — `thumbs/build-all`, `dedup/scan`, `nsfw/scan`, `reindex` all return 200 immediately and stream progress via WS. Companion `/status` endpoints (`/dedup/status`, `/thumbs/build/status`, `/reindex/status`, `/nsfw/status`) let a re-opened page recover the live state without polling. Closing the tab no longer kills work in flight.
- **Lint cleanup** — dead code removed across core / web / scripts / tests (`directoryCache`, `normalizeName()`, `hasMissingKeys`, debug `RAW EVENT` block + `peerId` derivation, unused imports `Api` / `closeTopSheet` / `api` / `escapeHtml` / `getFileIcon` / `insertDownload`, unused `chatId` / `lastCrashTime` / `DB_PATH`, destructured `id` → `_id`). Net `-19` warnings, no behaviour change.

### Fixed
- **`navigateTo is not defined` race on first click** — the inline `onclick="navigateTo('…')"` handlers on sidebar nav-items would throw whenever `loadGroups()` / `loadStats()` rejected before app.js's `init()` finished, because the `window.navigateTo = …` assignments lived after the await chain. Hoisted the entire `window.*` exposure block to right after the synchronous bootstrap so the bindings are live the moment the module finishes parsing — independent of any later network failure.
- **Backfill flashing "Done" milliseconds after Start** — `core/history.js` swallowed errors via `catch + emit('error')` then unconditionally `emit('complete')` in `finally`, so the Promise returned by `downloadHistory` resolved cleanly no matter what failed. The most common surface was "no available account can read this group" — operators saw a green "Done" pill with zero downloads. The catch now re-throws after emitting so server.js's `.then() / .catch()` actually routes failures to `history_error`. Added log channel emission with a hint for the most common cause (no account in group).
- **Backfill failures invisible on the realtime log channel** — both the user-triggered (`POST /api/history`) and the auto-spawn (first-add bootstrap, post-restart catch-up) paths now emit a structured `log` event with the group name, group id, and a friendly hint when the message points at account access.
- **Sidebar `chat-row` overlapping the sticky search input on scroll** — the sidebar groups header was at `z-10` and the avatar's type-badge inside `chat-row` was also `z-10`. Source-order made the chat-rows win on scroll-up. Bumped the sticky header to `z-20`.
- **Downloaded Groups all showing the megaphone icon regardless of type** — `/api/groups` and `/api/downloads` didn't carry `type`, so the avatar fell back to an id-prefix heuristic (every `-100…` id ⇒ channel) which conflated supergroups with channels. Both endpoints now enrich rows with `type` from the dialogs cache (channel / group / user / bot), matching what Manage Groups already shows.
- **`opacity: 0` on cached thumbnails leaving tiles permanently invisible** — the lazy-loader was setting `el.src = el.dataset.src` BEFORE attaching `onload`, which meant cached images fired their `load` event synchronously before the handler attached, so the `.loaded` class was never added and CSS kept the tile at `opacity: 0`. Handler now attaches first; we also add `el.complete` recovery for the same-tick race and an `onerror` fallback so broken thumbs don't stay invisible either.
- **Disk-usage footer reading stale "930 KB" after Purge all** — when the DB sum is zero (catalogue empty / freshly purged) `/api/stats` now walks `data/downloads/` recursively for the real on-disk size and refreshes `disk_usage.json` instead of trusting the legacy snapshot.
- **`tests/db.test.js` no longer touches the user's real `data/db.sqlite`** — the test now points the DB module at an `os.tmpdir()` mkdtemp via the new `TGDL_DATA_DIR` env override and removes the directory in `afterAll`.
- **Header avatar bleed** — clicking a group in the sidebar then navigating to Settings used to leave that group's photo in the header. Reset on every page change + per-page icon mapping.
- **Engine pill queue-count badge invisible on small phones** — the `<380 px` icon-only collapse zeroed `font-size` for the whole pill including the inline queue-count digit. Restored `font-size: 10px` on the badge inside the same media query.
- **Maintenance Thumbs page auto-completing the build before it finished** — `POST /thumbs/build-all` is fire-and-forget but the page treated the immediate 200 as completion (rendering "Built undefined / undefined" toasts), then failed any subsequent click with a 409. Now the page kicks off the build, waits for `thumbs_done` over WS, and recovers in-flight state via `GET /thumbs/build/status` on re-mount so closing the tab + coming back resumes the progress bar.
- **Maintenance Logs viewport overflow on landscape mobile** — `height: calc(100vh - 320px) min-height: 320px` evaluated negative on a 360 px-tall viewport and the min-height fallback then cropped the bottom rows under the bottom nav. Switched to `clamp(240px, calc(100vh - 320px), 70vh)`.
- **Maintenance Logs search jank** — full re-render of the 1 000-line buffer fired on every keystroke. Debounced 150 ms.
- **Empty gallery left with no actionable hint** — the "ทำไมบางกลุ่มไม่เจอ media" pattern. The empty state now shows a contextual title + body + admin action buttons (Run Backfill / Group Settings / Re-index from disk for per-group, Add account / Manage groups for all-media), so the operator knows where to go next.
- **Cloudflare 524 timeout on `/api/maintenance/dedup/scan`** — the SHA-256 sweep was awaited inside the POST handler, so on a 50 GB library the request could outlast Cloudflare's 100 s tunnel timeout long before completing. Converted to the same fire-and-forget pattern as thumbs / nsfw / reindex: 200 immediately, progress + final result via WS (`dedup_progress` / `dedup_done`), recovery via `GET /dedup/status`. Closing the tab no longer cancels the scan; opening the page from another device shows the live progress.
- **`onnxruntime-node` glibc crash defended at the process level** — even with the Dockerfile on bookworm-slim and the dep moved to `optionalDependencies` (see below), an existing install with the broken module on disk could still emit `Error loading shared library ld-linux-x86-64.so.2` and bring the process down via unhandledRejection. Added an explicit guard in `src/web/server.js` (and `src/index.js` for the CLI) that recognises native-load failure messages and logs once-and-survives instead of crashing.
- **`ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` validation warning storm** — express-rate-limit v7's self-help diagnostic ran on every request when `trust proxy` was at the default `false`. We now default `trust proxy` to `'loopback'` (overridable via `TRUST_PROXY` env), and we explicitly disable the `xForwardedForHeader` + `trustProxy` validators on the rate-limiter since we configure trust proxy correctly ourselves. Other validators stay enabled.

### Changed — Cross-platform support
- **`@huggingface/transformers` → `optionalDependencies`.** It transitively pulls in `onnxruntime-node`, whose Linux prebuilds are glibc-only and crash on musl images (alpine) at module load. Moving it out of `dependencies` means `npm install` on any platform is safe by default; the NSFW review feature is now an opt-in install (`npm install @huggingface/transformers`). `npm run doctor` reports availability so operators know whether the feature is wired up.

### Changed — Build thumbnails state shape
- Field names in `_thumbBuildState` and the `thumbs_progress` / `thumbs_done` WS payloads aligned with what `buildAllThumbnails()` returns: `processed / total / built / skipped / errored / scanned`. Replaces the placeholder `done / errors` keys, which made the maintenance log line read `done=undefined errors=undefined`.

### Changed — Multi-client coordination
- Maintenance pages (Find duplicates, Build thumbnails, NSFW scan, Re-index) now hydrate from `GET /<feature>/status` on (re-)entry. Starting a long-running job on a phone now disables the corresponding button on the desktop client too — and vice versa — because state lives on the server and the front-end is a renderer.
- **Express `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` warning spam** — silenced by the `TRUST_PROXY=1` default in `docker-compose.yml`.

### Changed — DB
- **`src/core/db.js` honours `TGDL_DATA_DIR`** — set the env var to relocate the data root (used by the test isolation above; also lets Docker / multi-instance deploys override the path without symlinks). Default behaviour unchanged.
- New tier-aware NSFW APIs: `getNsfwTierCounts`, `getNsfwHistogram`, `getNsfwListByTier`, `reclassifyNsfw`, `unwhitelistNsfw`. Tier dictionary exported as `NSFW_TIERS`.

### Changed — Dependencies
- **`sharp ^0.33.5` → `^0.34.5`** to dedupe with the nested copy `@huggingface/transformers` already pulls in. node_modules sheds the duplicate libvips and platform binaries. Bonus: HEIC / HEIF input + output now available out of the box.

### SW
- VERSION bumped `'v48'` → `'v240'` (semver-aligned for the v2.4.x line). `/css/main.css` added to `SHELL_URLS` so the new stylesheet preloads on install.

### Docs
- `docs/DEPLOY.md` — new "Force HTTPS (TLS lockdown)" section with pre-flight checklist.
- `docs/DEPLOY.md` — `TGDL_DATA_DIR` documented in the env vars table.
- `docs/TROUBLESHOOTING.md` — `npm run doctor` documented as the first stop.
- `README.md`, `CONTRIBUTING.md` — `npm run doctor` in the CLI cheatsheet + contributor onboarding.

## [2.3.48] — 2026-05-02

### Added
- **`npm run doctor`** — runtime diagnostics in one command. Reports Node version + ABI, config load, `better-sqlite3` open + row count (with rebuild hint on `NODE_MODULE_VERSION` mismatch), `data/` writability, port availability (honours `PORT`), and `ffmpeg` on `PATH`. Cross-platform (Windows / macOS / Linux), non-interactive — safe for CI / Docker. Exits 1 on any blocking failure.

### Fixed
- **Disk-usage footer no longer reads stale "930 KB" after Purge all** — when the DB sum is zero (catalogue empty / freshly purged) `/api/stats` now walks `data/downloads/` recursively for the real on-disk size and refreshes `disk_usage.json` instead of trusting the legacy snapshot. The old cache was written sparingly by earlier downloader versions and never invalidated on purge, so a wiped dashboard could keep footer-reporting a multi-week-old size.

### Changed
- **`tests/db.test.js` no longer touches the user's real `data/db.sqlite`** — the test now points the DB module at an `os.tmpdir()` mkdtemp via the new `TGDL_DATA_DIR` env override and removes the directory in `afterAll`. Previously a local `npm test` would create + delete the production DB file under `data/`.
- **`src/core/db.js` honours `TGDL_DATA_DIR`** — set the env var to relocate the data root (used by the test isolation above; also lets Docker / multi-instance deploys override the path without symlinks). Default behaviour unchanged.
- **`sharp ^0.33.5` → `^0.34.5`** to dedupe with the nested copy `@huggingface/transformers` already pulls in. Same `rotate()` / `resize()` / `webp()` patterns we use are stable across the bump; node_modules sheds the duplicate libvips and platform binaries.
- Lint cleanup: dead code removed across core / web / scripts / tests (`directoryCache`, `normalizeName()`, `hasMissingKeys`, debug `RAW EVENT` block + `peerId` derivation, unused imports `Api` / `closeTopSheet` / `api` / `escapeHtml` / `getFileIcon` / `insertDownload`, unused `chatId` / `lastCrashTime` / `DB_PATH`, destructured `id` → `_id` in accounts/history/monitor). Net `-19` warnings, no behaviour change.

### SW
- VERSION bumped `'v47'` → `'v48'`.

## [2.3.47] — 2026-05-02

### Fixed — Guest scope (strict viewer)
- **Guest is a strict read-only viewer** — browse downloaded media, adjust their own appearance / video-player preferences (browser-side), sign out. Operational surfaces (Groups picker, Backfill, Queue, Engine, Maintenance, Advanced, Accounts, Rate Limits, Size Limits, Privacy/DM, Proxy, web-auth Security) are admin-only on both the front and the back.
- **Guest GET 403 on every read endpoint** — `app.use('/api', guestGate)` strips the `/api` prefix from `req.path`, so the allowlist (written with full paths) missed every entry. Now reads `req.baseUrl + req.path` and matches. Without this fix even the legitimate guest reads (downloads, groups list, stats, thumbs) returned 403.
- **`/settings` root reachable for guest** so they can use the Look & Feel chip; `/settings/<section>` deep-links honour the existing `GUEST_SETTINGS_SECTIONS` allow set (`appearance`, `video-player`).
- Settings chip-nav: System / Accounts / Downloads / Privacy & Net chips and their sections gain `data-admin-only` — guest sees only the Look & Feel chip + section.
- `#status-bar` (desktop bottom status bar) gains `data-admin-only` — its content (engine state, queue counters, WS link) is admin-info only; guest's disk/file count is in the sidebar footer.
- Admin-only init paths gated for guest in `app.js` and `settings.js` — `initStatusBar`, `initOnboarding`, `initQueue`, `initEngine`, `refreshRescueStats`, `POST /api/groups/refresh-info` all skip for guest sessions so the console stays clean.
- **Onboarding banner suppressed for guest** — JS guard in `initOnboarding` plus `body[data-role="guest"] #onboarding-banner { display: none }` belt-and-suspenders.

### Fixed — Other
- **`Cannot access '_configCache' before initialization`** crash on boot — the share-secret bootstrap IIFE awaited `readConfigSafe()` before the `let _configCache` declaration. Variable hoisted above the IIFE.
- **"Failed to load dialogs"** when no Telegram account is configured replaced with a friendly empty-state + "Add account" CTA. Server now returns `error: 'no_account'` (vs. `not_connected`) so the SPA can branch on intent.
- Settings page `<h2>` section labels removed — they duplicated the chip-nav identity. Cleaner, denser layout.

### Changed — UI polish
- **`login.html` restyled to match the dashboard theme** — brand mark on a Telegram-blue gradient disc, full `--tg-*` token swap, IBM Plex font, remixicon, soft radial glow, complete light/dark theme parity.
- **Settings tab strip: sticky-but-integrated.** `var(--tg-bg)` background sits inside the page column (no full-bleed banner), stays reachable while scrolling, doesn't read as a foreign component.
- **Sidebar gains a full-width red Sign out button** at the bottom (below the Disk/Files stats). Routes through `confirmSheet` so an accidental tap can't kick the operator out. The deeper Settings → Privacy & Net → Security → Sign out path stays for the dedicated flow.
- **Media search bar dropped from the Viewer page.** The standalone `<input id="media-search">` toolbar at the top of the gallery was rarely used — the sidebar's Downloaded Groups filter narrows by chat, the URL link picker handles "this exact message", and removing the bar gives the grid a full row of vertical real estate. The `/` keyboard shortcut to focus it is gone with it. The `Select` button moved into the page header next to Refresh, and only shows on the Viewer page (`body[data-page="viewer"]` gate).

### SW
- VERSION bumped `'v46'` → `'v47'`.

## [2.3.46] — 2026-05-02

### Changed — Settings tab strip: drop sticky + integrate with page flow
- Settings nav no longer sticky — sits flush with the page in the normal scroll flow, same pattern as the Groups page tabs (`#groups-tab-*`) and the Viewer media tabs. The sticky version floated as a foreign banner; the new version reads as part of the page header.
- Margin breakout (`-12px / -16px`) removed; the underline now lives within the page's content column instead of spanning the whole content area like a separator.
- Active indicator moved from `::after` pseudo to the chip's own `border-bottom` so the underline overlaps the nav's `border-bottom` cleanly (the standard tab-into-content pattern).
- Inactive icons drop to `opacity: 0.75` and snap to full opacity on hover/active — gives the row a calmer rest state.
- Font weight bumped to 500, padding tightened to `10px 14px` to read as proper tabs rather than buttons.

### SW
- VERSION bumped `'v45'` → `'v46'`.

## [2.3.45] — 2026-05-02

### Changed — Settings tab-strip redesign
- Settings section nav redesigned from solid pill-chips to flat underlined tabs. The pill chips fought the muted cards below them; the tab-strip sits flat against the page and matches the existing `.tab-item` pattern used by Viewer media tabs and the Group settings modal.
- Active state is `var(--tg-blue)` text + 2 px underline (no heavy fill). Sticky bar carries a single bottom border that doubles as the inactive baseline. Mask-image edge fade dropped — overflow-scroll is silent on phones, and the row fits flush on tablet+.
- HTML markup unchanged; CSS-only redesign on `.settings-chip-nav` + `.settings-chip`.

### Changed — Sidebar groups header breathing room
- Toggle button padding tweaked to `pt-3 pb-1.5` (was `py-2`) so the "Downloaded Groups" heading sits with proper top breathing room and connects more snugly to the search row below.
- Search row padding upgraded `px-2 pb-2` → `px-3 pt-1 pb-3` so it aligns horizontally with the toggle and gets honest bottom space before the chat list begins.
- Search input grew `py-1.5` → `py-2` for a more comfortable tap target.
- Sticky header now carries a soft `border-tg-border/40` bottom edge so it visibly separates from the scrolling list once the user scrolls.

### SW
- VERSION bumped `'v44'` → `'v45'`.

## [2.3.44] — 2026-05-02

### Fixed — Light/dark theme contrast pass
- **`--tg-*` CSS variables are now actually defined.** Every `var(--tg-…)` consumer (`.engine-status-pill`, `.media-item`, `.sheet-card`, `.chat-row`, `.role-pill`, `.bottom-nav`, …) silently fell back to the dark hex on a light page. Fixed via a `:root` block plus `html.theme-light` re-definition; one source of truth, both themes paint right.
- **Brand status colours darkened in light theme** to clear WCAG AA on white surfaces — `tg-blue` `#2AABEE` → `#0E78C2` (2.84:1 → 4.93:1), `tg-green` → `#008A6E`, `tg-red` → `#B91C1C`, `tg-orange` → `#B8860B`. Affects primary buttons, FAB, settings-chip active, nav-badge, links, status pills, role pills, engine pill states.
- **`:focus-visible` keyboard ring restored** — global `button:focus, input:focus, …{ outline: none }` was eclipsing it, leaving every form element + button with no visible keyboard focus. Suppression now scoped to `:not(:focus-visible)` so mouse-clicks lose the ring but keyboards keep it.
- **Sidebar `.nav-item.active` actually renders.** App was toggling `.active` in JS but no CSS rule existed, so the active page was invisible in the sidebar. Now shows a 3 px blue accent bar + tinted background.
- **Engine pill pulse halo** uses higher alpha + theme-correct green in light mode (was `rgba(79,174,78,0.20)` — invisible on a near-white header).
- **Disabled buttons** (`.tg-btn:disabled`, `.tg-btn-secondary:disabled`) now visibly distinct: `opacity: 0.5 + saturate(0.55) + cursor: not-allowed`.
- **Selection-bar Select-all / Clear** gained an underline-on-hover affordance — the buttons read as buttons, not body copy.

### Fixed — Missing light-theme overrides
- Yellow alert family (`text-yellow-400`, `bg-yellow-500/10`, `border-yellow-500/20`).
- Red alpha variants `bg-red-500/{5,15,25,30}`, `bg-red-600`, `hover:bg-red-700`, `border-red-400/60`, `hover:text-red-400`.
- Brand-blue alphas beyond `/10`+`/20`: `bg-tg-blue/{15,25}`, `border-tg-blue/30`, `hover:bg-tg-blue/{20,25}`, `hover:bg-tg-{green,orange}/20`, `border-tg-{green,orange}/30`.
- `.tab-item` (Viewer + Settings tab strips), `.skeleton` shimmer (was a navy stripe on white), `.media-item .select-badge` (was white-on-white), `.unread-pill.muted`, `.bg-gray-500` status dots, `.hover:bg-white/10` patches inside themed surfaces.
- Status pills in chat rows recoloured per theme: green/orange/grey hard-coded for dark were illegible on light surfaces.

### Added
- `.tg-input::placeholder` colour rule covers BOTH themes — dark previously fell back to a UA default that was barely legible on the panel bg.

### SW
- VERSION bumped `'v43'` → `'v44'`.

## [2.3.43] — 2026-05-02

### Added — Sidebar groups: collapse + filter
- "Downloaded Groups" header is now a button — tap to collapse/expand the list. State persists in `localStorage` (`tgdl.sidebar.groups.collapsed`).
- New filter input below the header, sticky at the top of the sidebar scroll area so it stays reachable on long lists. DOM-only filter (`filterSidebarGroups`) — no re-render, doesn't fight the existing `_lastHtml` cache, and survives WS-driven re-renders via `_reapplySidebarFilter`.
- Footer stats compacted into one row (Disk + Files share a line with leading icons), giving the list more vertical real estate.

### Fixed — Video thumbnails on stripped ffmpeg builds
- `_generateVideoThumb` now picks its codec path at boot via `_ffmpegHasLibwebp()` (cached). When libwebp is present (default Docker image) it stays on the fast single-pass `-c:v libwebp` flow. When missing (stripped Alpine/musl ffmpeg, Windows static builds) it falls back to a JPEG → sharp WebP pipeline so video thumbs still generate. The retry-at-1s-then-0s pattern is preserved on both paths; tmp JPEG is always cleaned up.

### SW
- VERSION bumped `'v42'` → `'v43'`.

## [2.3.42] — 2026-05-02

### Fixed — Settings chip-nav: no-reload section routing
- Tapping a chip from inside the Settings page no longer re-runs `loadSettings()` + `initEngine()`. The `/settings/:section` route now bypasses the full `renderPage()` when `state.currentPage === 'settings'` and just smooth-scrolls to the target wrapper. Removes the visible flicker / "reload feel" introduced in v2.3.40 and stops the IntersectionObserver from landing on the wrong card mid-rebuild.
- Deep-link resolution now prefers `#settings-<anchor>` (unique by construction on the chip-nav wrappers) over `[data-settings-section]` (legacy attribute that also lived on inner cards).
- Active chip is set immediately on click — no waiting for the IntersectionObserver to catch up after smooth-scroll completes.
- Removed a duplicate `data-settings-section="appearance"` attribute from the Appearance card; the section wrapper is now the single source of truth for that anchor.

### SW
- VERSION bumped `'v41'` → `'v42'`.

## [2.3.41] — 2026-05-02

### Added
- **Forwarder destination resolution: 3-stage fallback.** `getInputEntity` → `getEntity` (dialog-cache rescan) → hand-rolled `Api.InputPeerChannel` / `InputPeerChat` from the canonical `-100…` layout. The last-resort branch logs a yellow warning so operators can spot it, and recommends opening the channel once on the configured account if sends still fail.
- **`destination: 'saved'`** now aliases `'me'` (Saved Messages), matching common Telegram-bot phrasing.
- **TG message-id in forward log** — successful auto-forward writes `(msg #<id>)` after the destination so the destination copy is traceable from the dashboard.
- **Backfill quick presets**: "Last 5" and "Last 10" added to the per-chat history modal alongside the existing 100 / 1k / 10k / All buttons. Grid is now `grid-cols-3 sm:grid-cols-6` so the row stays one-line on tablet+.
- **Groups: "Unmonitored" tab** — third tab next to "All" / "Monitored Only", filters dialogs to chats not in the monitored set (`!d.inConfig && !d.enabled`).
- **Viewer "Select all" button** in the floating selection bar — exposes the existing `Ctrl/⌘+A` shortcut as a tap target so mobile users get the same affordance. Single source of truth: shortcut + button both call `selectAllVisible()` from `gallery-select.js`.
- **`TGDL_PORT` env override** — `docker-compose.yml` now uses `${TGDL_PORT:-3000}:3000` so a port collision on the host doesn't require a `docker-compose.yml` edit. Documented in `.env.example`.

### Refactor
- `switchGroupsTab` collapsed from a per-button toggle ladder to a `tabs.forEach` loop — adding a future tab is now a one-line array push.
- `_autoEnableSelectMode` lifted from `setupGallerySelect`'s closure to module scope so the new exported `selectAllVisible()` can reuse it.

### SW
- VERSION bumped `'v40'` → `'v41'`.

## [2.3.40] — 2026-05-02

### Changed — Mobile UI polish + Settings restructure
- Bottom-nav 6 → 5 tabs. Engine tab replaced by a header `engine-status-pill` (taps to `#/settings/engine`; running/error/reconnecting via animated dot; queue+active badge preserved).
- Settings page reorganised from a flat 15-card stack into 5 sticky-chip-nav sections: System / Accounts / Downloads / Look & Feel / Privacy & Net. Active chip mirrors the section in view via IntersectionObserver. `#/settings/<section>` deep-links unchanged.
- Per-page accent — `#content-header` now carries a 2 px underline that swaps per top-level page (Library blue / Chats green / Backfill orange / Queue cyan / Settings blue), driven by `body[data-page]`.

### Responsive + a11y
- Sidebar clamps to `min(85vw, 18rem)` so a 320 px phone always leaves a tap-out gap.
- Engine status grid `grid-cols-2 sm:grid-cols-4` (single row on tablet+, 2×2 on phone).
- View-mode menu clamps to viewport (`max-width: min(240px, calc(100vw - 24px))`).
- Header gains `pt-safe` + `@supports` height bump for notched displays.
- Bottom-nav badge offset `right: calc(50% - 1ch)` — tracks the icon regardless of font-size tier.
- Chip-nav is `role="tablist"`, sections are `role="tabpanel" aria-labelledby`. Engine pill `aria-label` reflects state via `header.engine_state`.

### Performance
- `.media-item` gains `aspect-ratio: 1 / 1`, `content-visibility: auto`, `contain-intrinsic-size: auto 200px`, panel-coloured skeleton — kills load-time layout shift and skips offscreen tiles natively.
- Image fade trimmed `0.3s → 0.18s`. Sheet transition `220ms → 180ms`; `will-change: transform` only while open.

### i18n
- 7 new keys in en.json + th.json: `settings.section.{system,accounts,downloads,appearance,network}`, `header.engine`, `header.engine_state`.

### SW
- VERSION bumped `'v39'` → `'v40'`.

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
