# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
