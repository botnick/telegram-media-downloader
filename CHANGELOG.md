# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.3.13] — 2026-04-28

### Changed — locale tone + casing pass
Per user request: "ทำภาษาไทยให้ดูเป็นทางการหน่อยครับ ตัวอักษรอังกฤษพิมพ์เล็กใหญ่ให้เหมาะสมหน่อย".

- **`th.json` rewritten in formal-but-readable Thai** — the tone a Thai-language SaaS product (Notion Thai, Microsoft Thai) would ship. Removed casual particles ("นะ" / "อะ" / "ดิ" / "ไอ้สัส"), used proper polite constructions ("โปรด…", "ใช่หรือไม่"), replaced slangy translations ("เซฟ" → "บันทึก", "หน้าตา" → "รูปลักษณ์", "หลุดจาก server เลย" → "ขาดการเชื่อมต่อกับเซิร์ฟเวอร์"). No trailing periods on Thai sentences (Thai punctuation convention). Tech terms still in English where Thai devs say them that way (`monitor`, `queue`, `session`, `proxy`, `gramJS`, `MTProxy`, `WebSocket`, `dashboard`, `container`, `Stories`, `release notes`, `PiP`, `fullscreen`, `Backfill`, `Rescue`).
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
- **Update-check cache TTL: 1 h → 10 min**, in response to "I'm on v2.3.7 with no update pill while v2.3.10 has been live for hours". Cache is shared across all clients of one instance, so 6 upstream calls per hour total is comfortably under GitHub's 60-req-per-hour-per-IP unauthenticated rate limit.
- **Service-worker cache** bumped `'v11'` → `'v12'` to flush the older cached JS for users upgrading through this release.

### i18n
- 18 new keys (10 settings labels/help + 8 toast confirmations), en + th lockstep, 635 keys total.

## [2.3.11] — 2026-04-28

### Fixed
- **Service-worker cache was holding stale `settings.js` + `index.html` for users who pulled v2.3.5–v2.3.10.** SW `VERSION` was last bumped to `'v3'` in v2.3.4 and never since (despite the comment "Going forward, this string bumps with every meaningful release" — sorry). Result: a user pulled v2.3.7 → v2.3.10, the new HTML loaded fine (network-first for navigation), but `/js/settings.js` stayed cached (cache-first for static assets) so the new Video Player toggles rendered with no behaviour wired. Bumped to `'v11'`; the activate handler purges every non-matching cache key on first hit, so the upgrade is one reload.
- **Update-check cache was 6 hours.** A user reported sitting on v2.3.7 with no update pill while v2.3.10 had been live for hours. TTL lowered to **1 hour**; additionally the cache is **bypassed when the running container is at-or-newer than the cached `latest`** (means we just rolled forward and a release was probably published in the window — re-fetch instead of trusting the stale "no update" answer).

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

A blocker fix the user spotted (gallery showing 209 of 2454 files), plus the priority items from a third audit pass — silent FloodWait loops, Windows-reserved filenames, downloader/rotator races, queue UX overhaul, and the avatar flicker.

### Fixed — blocker
- **All Media was capped at ~400 files.** `loadAllFiles()` was hard-coded to fetch the first 20 groups × 20 files each, with no pagination and no infinite-scroll. With 2454 files in the user's library, the gallery showed ~209 (and Photos / Videos tabs ~30–50 each). New endpoint `GET /api/downloads/all?page&limit&type` orders by `created_at DESC` across every group, the SPA's existing `setupInfiniteScroll` sentinel pages it, and the per-tab type filter is now a server-side `?type=` query so the count under each tab is accurate. Also fixed an off-by-one where a perfectly-packed last page kept pagination armed forever.

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

Second-pass audit + four more user-reported defects. Fixes a real entity-cache shape bug and a path-traversal hole in the profile-photo endpoint that the first audit missed.

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
- **Thai locale fully humanized.** All 591 strings rewritten in natural conversational Thai instead of stiff machine-translation tone. Tech terms (`monitor`, `queue`, `download`, `session`, `proxy`, `worker`, `dashboard`, `cookie`, `Stories`, `Backfill`, `FloodWait`, `gramJS`, `Maintenance`, `Rescue`, `VACUUM`, …) kept in English where that's how Thai users actually say them. Confirmations made direct ("แน่ใจนะ? กู้คืนไม่ได้นะ"), help text rewritten like a friend explaining what each setting does, possessive `ของคุณ` spam removed, every `{placeholder}` token preserved.

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
