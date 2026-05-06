# Project Audit — Telegram Media Downloader

> **Last updated:** 2026-04-26 (audit frozen at the v1.x → v2.0 cut)
> **Scope:** entire repo (CLI + core engine + web server + SPA + tooling)
> **Method:** three parallel audit passes (CLI/core, web/SPA, OSS readiness) cross-checked by manual file reads.
> **Status:** every Critical / High in the table below is **resolved in v2.0**. The findings list is preserved as a historical record so future audits can verify the regressions don't return.

---

## Executive summary

**166 findings** across three layers.

| Layer | Critical | High | Medium | Low | Total |
|---|---:|---:|---:|---:|---:|
| CLI + core engine | 13 | 10 | 17 | 20 | 60 |
| Web server + SPA frontend | 7 | 10 | 10 | 9 | 36 |
| OSS release readiness | 6 | 24 | 27 | 11 | 68 (counted) / 70 (incl. derived) |
| **Total** | **26** | **44** | **54** | **40** | **~164** |

**OSS readiness score (rough): 20 / 100.** Functional core, but missing LICENSE file, tests, CI, code-style tooling, security disclosure policy, Docker hardening, and standard contribution scaffolding.

**Most urgent (must-fix before any public deploy):**

1. Web dashboard is **open by default** if no password is set (`src/web/server.js:75`) — anyone on the LAN gets full read+write access.
2. Web cookie *is* the password, plain-string compared (`src/web/server.js:82, 109, 111`) — timing attack + plaintext credential leak in cookie store.
3. WebSocket has **no auth** at all (`src/web/server.js:739–742`) — broadcasts file paths, group names, and download events to any connecting client.
4. `console.error` is globally overridden to silently drop error messages matching `TIMEOUT|Not connected|Connection closed|Reconnect|CHANNEL_INVALID` (`src/index.js:36–46` + `src/core/accounts.js:30–55`) — real failures vanish from logs.
5. `runner.js` and `watchdog.ps1` both hardcode the command `history`, so the production "watchdog" runs once and exits — there is **no monitor supervision in production**.
6. Repo has **no LICENSE file** despite `package.json` claiming MIT.

A 1.5-day **M0 milestone** can land all 6 above; full hardening + feature parity + OSS launch is ~18 working days across M0–M5.

---

## Findings — CLI + core engine (60)

### Critical

| # | File:Line | Finding |
|---|---|---|
| C1 | `src/index.js:36–46` | Global `console.error` filter silently drops anything matching `TIMEOUT`, `Not connected`, `Connection closed`, `Reconnect`, `Closing current connection`, `CHANNEL_INVALID`. Real failures invisible to ops + logging stack. |
| C2 | `src/core/accounts.js:30–55` | Per-account `createLogger()` does the same drop on `Disconnecting`, `Reconnect`, `Not connected`, `TIMEOUT`, `WebSocket connection failed`, `Connection closed`, `disconnect`. |
| C3 | `src/core/security.js:57` | AES-256-GCM key derivation uses hardcoded scrypt salt `'tg-dl-salt-v1'`. Same salt across every install and shared with web layer (`src/web/server.js:647`). |
| C4 | `src/web/server.js:647` | Same hardcoded salt as above; rainbow-tabling viable if key file is exfiltrated. |
| C5 | `src/config/manager.js:110–123` | `fs.watch()` listener never cleaned up — leaks process handles, fires on every saved config change forever. |
| C6 | `src/core/monitor.js:84–88` | Config watcher debounce timer never cleared on `stop()`; zombie timers accumulate per restart. |
| C7 | `src/core/downloader.js:223 / 184` | `_scalerInterval` started in `start()` cleared in `stop()` only if the field happens to be set; multiple start/stop cycles leak intervals. |
| C8 | `runner.js:16` | Hardcoded `APP_ARGS = ['history']`. `npm run prod` therefore runs `history` once and exits — no production monitor supervision. |
| C9 | `watchdog.ps1:13` | Same bug, Windows variant. |
| C10 | `src/index.js:115` | `config.telegram.apiId` printed to console in plaintext on first-run prompt. Sensitive credential leak in logs. |
| C11 | `src/core/downloader.js:249–250` | Priority queue inverted: realtime jobs `unshift`-ed to front, history `push`-ed to back, but worker `pop`s from back → realtime jobs starve under any history load. |
| C12 | `src/core/accounts.js:318` | Synchronous `fs.unlinkSync` on session file path with no normalization — guard against malformed `accountId` containing `..` or `/`. |
| C13 | `src/web/server.js:362–365 / 622–625` | Path checks use `path.resolve(path.join(DIR, userInput))` then `.startsWith()`. Correct against `..`, but follows symlinks — symlink inside `data/downloads/` can escape. No NUL-byte rejection. No `realpath` resolve. |

### High

| # | File:Line | Finding |
|---|---|---|
| H1 | `src/index.js_fragment_setupWebAuth` | Orphan source fragment file (~2.2 KB) committed to repo. Either dead code or stale duplicate of the real `setupWebAuth` in `src/index.js`. Confusing for contributors. |
| H2 | `src/core/resilience.js:48–54` | `handleFatal` returns silently on network errors but does not trigger any actual reconnect — process stays alive but in zombie state. Caller never re-checks. |
| H3 | `src/core/monitor.js:264, 266` | `clearInterval()` / `clearTimeout()` called twice in rapid stop sequences without guards; `TypeError: Cannot read properties of undefined`. |
| H4 | `src/core/accounts.js:185` | `connectionRetries: 100` with no backoff strategy — hammers Telegram on outage. |
| H5 | `src/core/monitor.js:283–287` | Event handler removal in `stop()` doesn't tolerate already-disconnected clients; throws and leaks remaining handlers. |
| H6 | `src/core/history.js:139` | Backpressure `while (queue.length > 500) sleep(1000)` has no max-wait; a stuck downloader hangs history forever. |
| H7 | `src/index.js:299–312` | Number-key handling in `selectOption()` compares string keys `'1'..'9'` and bounds-checks against array length only on `'0'`; off-by-one paths possible. |
| H8 | `src/index.js:240–242` | `process.stdin.setRawMode(true)` not wrapped in try/finally — error before cleanup leaves terminal in raw mode (user can't type). |
| H9 | `src/index.js:50–60` | `question()` creates+closes a fresh `readline` interface per prompt; rapid prompts can corrupt terminal state. |
| H10 | `src/core/connection.js:21` | Health-check interval has no `stop()` method; runs forever after monitor stops, prevents process exit. |

### Medium

| # | File:Line | Finding |
|---|---|---|
| M1 | `src/core/db.js:84–122` | `getDownloads()` count query reuses `params[1]` by index. Verified correct today, but fragile to future param-order changes. |
| M2 | `src/core/db.js` | `audio` and `voice` filter keys both exist in defaults; `getDownloads` only maps one. Silent filter mismatch. |
| M3 | `src/core/downloader.js:495–560` | Disk usage cache flushed on a debounced timeout; `stop()` doesn't await flush — last bytes not persisted. |
| M4 | `src/core/downloader.js:335–370` | File-type detection assumes `message.document.mimeType` is a string; null/undefined access can throw. |
| M5 | `src/core/downloader.js:110` | mkdir errors swallowed by `.catch(() => {})`. |
| M6 | `src/core/accounts.js:322` | `syncToConfig()` errors swallowed silently. |
| M7 | `src/core/monitor.js:149–152` | Custom `console.error` override never restored on monitor `stop()`. |
| M8 | `src/index.js:1671` | Recursive `setupWebAuth()` call on the "back" menu path; no depth limit. Theoretical stack overflow after many toggles. |
| M9 | `src/config/manager.js:75–86` | Self-heal uses `JSON.stringify` equality to detect changes; key-order-sensitive — false positives cause unnecessary disk writes. |
| M10 | `src/core/history.js:151–154` | Progress emitted every 10 messages; batches < 10 never emit progress. |
| M11 | `src/index.js:852, 1312` | `process.stdout.write` without explicit `\r` or readline clear — subsequent `console.log` overlaps progress lines. |
| M12 | `src/cli/colors.js` | No TTY check before emitting ANSI codes — pipes/log files get raw `\x1b[…m` sequences. |
| M13 | `src/index.js:89–92` | `auth` command short-circuits before config validation; `setupWebAuth()` runs even on empty/corrupt config. |
| M14 | `src/web/server.js:127` | `/api/auth_check` returns 200 unconditionally; SPA can't tell if auth is required. |
| M15 | `src/core/monitor.js:163–165` | `lastIds` initialized from `getMessages({limit:1})[0].id` without verifying message ordering — assumes API returns most-recent first. |
| M16 | `runner.js:47` | `stdio: 'inherit'` — no separate logs file; crash messages mixed with app output. |
| M17 | `src/core/forwarder.js:104–107` | `BigInt(destination)` parsing without validation throws on non-numeric input. |

### Low

| # | File:Line | Finding |
|---|---|---|
| L1 | `src/core/monitor.js:32` | `SpamGuard` class instantiated but never defined or used. Dead code path. |
| L2 | `src/setup.js` | File exists but is never imported. Verify whether dead or planned. |
| L3 | `src/core/bot.js` | Bot control class exists but no clear integration point in main flow. |
| L4 | `src/core/logger.js` | Tiny stub; no level filtering, no file sink, no JSON mode. |
| L5 | `src/config/manager.js:84` | Commented-out `console.log`. Use logger or remove. |
| L6 | `package.json:36` | `"author": ""` empty. |
| L7 | `package.json` | No `bin`, no `files`, no `homepage`, no `bugs`, no `devDependencies`. |
| L8 | `package.json` | No `npm test` / `npm run lint` scripts. |
| L9 | `Dockerfile:1` | Floating `node:18-alpine` tag — drifts over time. |
| L10 | `Dockerfile` | Runs as root (no `USER` directive). |
| L11 | `Dockerfile:6–10` | `COPY . .` defeats layer cache after package install. |
| L12 | `Dockerfile` | No `HEALTHCHECK`. |
| L13 | repo root | No `.dockerignore` — `.git`, host `node_modules`, `data/` may be copied into image. |
| L14 | `docker-compose.yml:14` | Hardcoded `Asia/Bangkok` TZ — should be `${TZ:-UTC}`. |
| L15 | `.gitignore:44` | Malformed line `data/d a t a /  ` (with embedded spaces). Likely accidental. |
| L16 | `src/web/server.js:744` | `process.env.PORT \|\| 3000` undocumented in README. |
| L17 | `src/core/db.js` | No `VACUUM`/`OPTIMIZE` after large purges; SQLite file doesn't shrink. |
| L18 | `src/core/security.js:47, src/core/history.js:273, src/core/downloader.js:635` | `sleep()` re-implemented three times instead of one shared util. |
| L19 | `src/index.js` | 280+ `console.log/error` calls; no structured logging. |
| L20 | platform-bias | `run_safe.bat`, `watchdog.ps1` are Windows-only; no shell equivalent for Linux/macOS. |

---

## Findings — Web server + SPA frontend (36)

### Critical

| # | File:Line | Finding |
|---|---|---|
| WC1 | `src/web/server.js:82, 109` | `sessionCookie === password` and `password === target` — direct string compare, vulnerable to timing attack. Use `crypto.timingSafeEqual`. |
| WC2 | `src/web/server.js:111` | Cookie value **is** the password (`res.cookie('tg_dl_session', password, …)`); no `Secure`, no `SameSite`. XSS or HTTP downgrade leaks the credential itself. |
| WC3 | `src/web/server.js:75` | **Default-open**: if `config.web.password` is unset, middleware skips entirely → unauthenticated full access to API + UI. |
| WC4 | `src/web/server.js:739–742` | WebSocket accepts every connection with no auth; broadcast pushes file paths, group names, purge events to any client. |
| WC5 | `src/web/server.js:362–365` | `DELETE /api/file?path=…` — `path.resolve(path.join(DOWNLOADS_DIR, filePath))` then `.startsWith` check. Symlinks escape; no NUL-byte rejection; no `realpath`. |
| WC6 | `src/web/server.js:615–625` | `/files/:path` mirror of WC5; same symlink + URL-decode pitfalls. No `Content-Disposition`. |
| WC7 | `src/web/public/js/app.js:424–434` | `makeLabel(a)` interpolates `a.name` / `a.username` / `a.id` into a string later assigned via `innerHTML` — stored XSS if account metadata can be poisoned. |

### High

| # | File:Line | Finding |
|---|---|---|
| WH1 | `src/web/server.js:111–114` | Cookie missing `secure` and `sameSite`; 30-day `maxAge` excessive. |
| WH2 | `src/web/server.js:387, 442, 501, 521` | `POST/PUT/DELETE /api/{config,groups/:id,groups/:id/purge,purge/all}` accept cross-site requests with no CSRF token, no Referer check, no `SameSite=strict`. |
| WH3 | `src/web/server.js:99–125` | `/api/login` has no rate limit. Password brute-force unrestricted. |
| WH4 | `src/web/server.js:488–498` | `GET /api/config` strips `password` only; `monitorAccount` / `forwardAccount` per-group survive — leaks account-to-group mapping. |
| WH5 | `src/web/server.js:123, 175, 210 (and many)` | `res.status(500).json({ error: e.message })` leaks internal error messages, occasionally including file paths. |
| WH6 | `src/web/public/js/api.js` | Fetch wrapper has no 401 handler. Expired cookie → SPA shows generic toast forever, no redirect. |
| WH7 | `src/web/server.js:586, 590, 630` | File serving sets no `Content-Type` (relies on Express default) and no `Content-Disposition: attachment`. Browsers inline videos/images by default. |
| WH8 | `src/web/server.js:45` | `express.json()` with no `limit` — default 100KB but worth pinning explicitly; better, lower to 256KB. |
| WH9 | `src/web/server.js:36, 659–680` | Web spawns its own `TelegramClient` against the same session while CLI may be running → SQLite single-writer rule violated; observed `database is locked` errors. |
| WH10 | `src/web/public/js/viewer.js:75–96` | Video resume position stored in `localStorage` indefinitely, no expiry, no namespace per-user — privacy leak across browser users. |

### Medium

| # | File:Line | Finding |
|---|---|---|
| WM1 | `src/web/server.js:91–92` | Auth-skip check uses `!req.path.startsWith('/css')` etc. — `/css.html` would match the negation. Tighten with `^/css/` regex. |
| WM2 | `src/web/public/js/utils.js:72–74` | Inline `onerror="this.style.display='none'; …"` — minor XSS surface if an attacker injects extra attributes; better as event listener. |
| WM3 | `src/web/public/js/api.js` | No 401 redirect (duplicated WH6 from a different angle). |
| WM4 | `src/web/public/js/app.js:652–658` | Infinite-scroll uses `state.loading` but multiple intersection events can race past the flag → duplicate page loads. |
| WM5 | `src/web/public/js/store.js` | No version counter / no broadcast invalidation; multi-tab updates show stale data after purge. |
| WM6 | `src/web/public/js/settings.js:51–77` + `src/web/server.js:501–518` | No client-side validation for ranges (`concurrent`, `pollingInterval`); no atomic write on server. |
| WM7 | `src/web/public/js/viewer.js:57–67` | Image zoom only handles `wheel`; no pinch/touch — unusable on mobile. |
| WM8 | `src/web/public/index.html:366–508` | Group settings modal: no `role="dialog"`, no focus trap, no Escape handler. |
| WM9 | `src/web/public/index.html:2` | `<html lang="th">` but UI is 100% English — screen-reader bug. |
| WM10 | `src/web/public/js/viewer.js:34–36` | Video autoplay does not respect `navigator.connection.saveData` — burns mobile data. |

### Low

| # | File:Line | Finding |
|---|---|---|
| WL1 | `src/web/server.js` (multiple) | Emoji in server logs — irritates structured-log pipelines. |
| WL2 | `src/web/public/js/app.js:135–149` | Group names not enforced unique → duplicates render identically. |
| WL3 | `src/web/public/index.html:820–840` | Video speed buttons have no keyboard shortcuts (`<` / `>` standard in players). |
| WL4 | `src/web/public/js/app.js:476–480` | Modal close has three independent paths (X button, ESC from viewer.js, overlay click); no unified handler. |
| WL5 | `src/web/public/js/app.js:228, 560–566` | Loading spinner on some flows but not others (e.g., All-Files load). |
| WL6 | `src/web/public/js/utils.js:72` | `loading="lazy"` on first-render avatars hurts initial paint impressions. |
| WL7 | `src/web/public/js/app.js:675–700` | `purgeAll` requires two confirms, `purgeGroup` requires one. Inconsistent. |
| WL8 | `src/web/server.js` | No `helmet` middleware; missing standard security headers (CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy). |
| WL9 | `src/web/public/index.html` | Tailwind loaded from CDN — offline / restricted networks may break the UI. |

---

## Findings — OSS release readiness (68)

### Critical (legal / blocker)

| # | File / Path | Finding |
|---|---|---|
| OC1 | repo root | **No `LICENSE` file.** `package.json` says MIT; legally weaker without the file + copyright notice. |
| OC2 | `package.json:36` | `"author": ""` — no maintainer contact. |
| OC3 | `src/web/server.js:82` | Plaintext password compare (already covered above; flagged here as OSS legal risk: shipping known-broken auth). |
| OC4 | repo root | **No `SECURITY.md`** — vuln reporters have no private channel. |
| OC5 | `README.md:632–634` | Disclaimer present but unofficial-Telegram-client status not prominent enough; users in regulated jurisdictions need clearer ToS warning. |
| OC6 | `package.json` | No `files` whitelist / no `.npmignore` — a hypothetical `npm publish` would ship `data/`, `node_modules/`, etc. |

### High (will hurt adoption)

| # | File / Path | Finding |
|---|---|---|
| OH1 | repo root | No `CHANGELOG.md`. |
| OH2 | git refs | No git tags (no `v1.0.0`). |
| OH3 | GitHub | No releases (no artifact attached, no release notes). |
| OH4 | repo root | No `CONTRIBUTING.md`. |
| OH5 | repo root | No `CODE_OF_CONDUCT.md`. |
| OH6 | `.github/` | No PR template. |
| OH7 | `.github/ISSUE_TEMPLATE/` | No issue templates. |
| OH8 | `.github/workflows/` | No CI/CD at all. |
| OH9 | `tests/` | Zero tests; `npm test` would fail. |
| OH10 | repo-wide | No TypeScript, no JSDoc-types — `src/index.js` is 1679 lines pure JS. |
| OH11 | `.eslintrc*`, `.prettierrc*` | No lint, no formatter, no pre-commit hooks (no husky/lint-staged). _(Resolved: Biome 2 + Lefthook landed in v2.6.14.)_ |
| OH12 | `Dockerfile:1` | Floating `node:18-alpine` tag, drifts. |
| OH13 | registry | No published Docker image (Docker Hub / GHCR). |
| OH14 | `package.json:10` | `"main": "src/index.js"` is a CLI, not a library; missing `"bin"`. |
| OH15 | `package.json` | No `"bin"` — can't `npm i -g …`. |
| OH16 | `package.json:38–45` | Zero devDependencies. |
| OH17 | `.editorconfig`, `.nvmrc` | Missing — IDE / Node version hints absent. |

### Medium (polish & standards) — abridged

| # | Finding |
|---|---|
| OM1 | `package-lock.json` lockfileVersion 3 fine, but no commit-time docs. |
| OM2 | No `SUPPORT.md`. |
| OM3 | No `ROADMAP.md`. |
| OM4 | No `NOTICE` (third-party license attribution). |
| OM5 | No `AUTHORS` / `MAINTAINERS`. |
| OM6 | README badges generic / unverified. |
| OM7 | No logo / branding assets. |
| OM8 | No screenshot in README. |
| OM9 | No demo video / GIF. |
| OM10 | No OpenAPI / Swagger schema for the REST API. |
| OM11 | WebSocket events documented but no example payloads. |
| OM12 | CLI commands listed but no example outputs. |
| OM13 | No `--version`, `--help` output reproduced in README. |
| OM14 | `config.example.json` minimal — doesn't show all options. |
| OM15 | Troubleshooting covers ~4 cases, many gaps. |
| OM16 | Hardcoded `Asia/Bangkok` TZ in `docker-compose.yml`. |
| OM17 | Dockerfile copy-strategy defeats layer cache. |
| OM18 | Dockerfile runs as root. |
| OM19 | No `.dockerignore`. |
| OM20 | `docker-compose.yml` exposes `:3000` without strong warning. |
| OM21 | `src/web/server.js:81` comment says "in prod, use real sessions/JWT" — still using cookie-as-password. |
| OM22 | `data/` not initialised in repo (no `.gitkeep`); first-run experience may surprise. |
| OM23 | Watchdogs Windows-only; no shell equivalent. |
| OM24 | No `dependabot.yml`. |
| OM25 | No CodeQL / no security scanning workflow. |
| OM26 | npm caret versions `^…` in `package.json`. |
| OM27 | No Node-version self-check at startup. |

### Low — abridged

| # | Finding |
|---|---|
| OL1 | No GitHub project board. |
| OL2 | No Discord / community chat. |
| OL3 | No analytics / opt-in feedback (a deliberate choice — keep it that way). |
| OL4 | README is 634 lines; consider quick-reference card. |
| OL5 | No architecture diagram (text only). |
| OL6 | No multi-stage `Dockerfile.prod`. |
| OL7 | No `npm run dev` / dev-watch script. |
| OL8 | No husky pre-commit example in docs. _(Obsolete: husky was replaced by Lefthook in v2.6.14; `lefthook.yml` in the repo root is the current example.)_ |
| OL9 | No CI / coverage / security badges. |
| OL10 | No `FUNDING.yml`. |
| OL11 | No published `npm` package even though setup supports it. |

---

## Resolution status (v2.0)

| Milestone | Goal | Status |
|---|---|---|
| **M0** | Security hotfixes (auth, helmet, path safety, WS, salt rotation) + audit doc | ✅ shipped |
| **M1** | Core engine bugs + resource-leak cleanup | ✅ shipped |
| **M2** | Web server hardening + new control endpoints | ✅ shipped |
| **M3** | SPA bug fixes + a11y baseline | ✅ shipped |
| **M4** | Web feature additions (theme, search, multi-select, proxy, stories, URL paste, TTL, topics) | ✅ shipped |
| **M5** | OSS launch readiness (CI, tests, Docker, lint/format tooling, docs) | ✅ shipped — toolchain migrated to Biome + Lefthook in v2.6.14 |

**All Critical and High findings are resolved.** A handful of Medium/Low entries are still open as warnings (see `npm run lint`); they are tracked as warnings rather than errors so contributors can land changes without chasing pre-existing style debt.

For the per-feature surface that landed in v2.0, see [`CHANGELOG.md`](../CHANGELOG.md).
