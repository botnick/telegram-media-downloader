# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm ci                # clean install — required before lint / test / start
npm start             # default — opens dashboard at http://localhost:3000
npm run dev           # same as start, but with node --watch for auto-restart on edits
npm run prod          # supervised by runner.js (production watchdog)
npm run monitor       # headless realtime monitor only, no dashboard
npm run history       # CLI bulk backfill
npm run auth          # set / change dashboard password from terminal
npm run doctor        # Node ABI / config / SQLite / port / ffmpeg diagnostics — run after Node upgrades
npm run menu          # full CLI subcommand list
npm run migrate       # one-shot JSON→SQLite state migration (also runs automatically inside getDb())
```

Quality + tests:

```bash
npm run lint          # biome lint . (no autofix)
npm run check         # biome check --write . (lint + format autofix repo-wide)
npm run format        # biome format --write . (format-only)
npm test              # vitest run (single pass)
npm run test:watch    # vitest interactive
npx vitest run path/to/file.test.js              # run one test file
npx vitest run -t "name pattern"                  # run tests matching a name
```

Lefthook installs a `pre-commit` hook (`npm run prepare`) that auto-runs `biome check --write` against staged files only — manual lint before commit is usually unnecessary. Use `npm run check` if you want to apply fixes repo-wide.

`SQLITE_ERROR: NODE_MODULE_VERSION` after a Node upgrade is fixed by `npm rebuild better-sqlite3`.

## Architecture

Two entry points share state via `data/db.sqlite` (WAL mode, single writer):

- **`src/index.js`** — interactive CLI (menu / monitor / history / auth / doctor subcommands).
- **`src/web/server.js`** — Express + WebSocket on `:3000`, serves the SPA from `src/web/public/`. ~8000 lines; one file by design (close to the routes), but uses helper modules for everything non-trivial.

The web server delegates engine work to **`src/core/runtime.js`** — a singleton orchestrator that owns one `RealtimeMonitor` + one `DownloadManager` + one `AutoForwarder`. The CLI's `monitor` subcommand wires the same trio standalone. **Never spawn a second engine instance** — both writers would race the SQLite WAL.

### Runtime config — kv-backed, never read JSON files

Every runtime surface lives in SQLite as of v2.8:

| kv key / table | Owner | Replaces (now archived as `*.migrated`) |
|---|---|---|
| `kv['config']` | `src/config/manager.js` (`loadConfig` / `saveConfig`) | `data/config.json` |
| `kv['disk_usage']` | `src/core/downloader.js` + `writeDiskUsageCache` in server.js | `data/disk_usage.json` |
| `kv['history_jobs']` | server.js (`loadHistoryJobsFromStore` / `saveHistoryJobsToStore`) | `data/history-jobs.json` |
| `kv['queue_history']` | server.js (`pushQueueHistory` / `flushQueueHistorySoon`) | `data/queue-history.json` |
| `web_sessions` table | `src/core/web-auth.js` + db.js accessors | `data/web-sessions.json` |
| `queue_backlog` table | db.js + downloader.js spillover | `data/logs/queue_backlog.jsonl` |
| `update_history` table | db.js (`recordUpdateAttempt` / `finalisePendingUpdates`) | (new in v2.8) |

**Always go through `loadConfig()` / `saveConfig()` / `kvGet` / `kvSet`.** Direct reads of `data/config.json` (or any of the other archived files) silently return stale data — the file is renamed to `*.migrated` on first boot. `saveConfig()` emits a `change` event on an in-process `EventEmitter`; `RealtimeMonitor.watchConfig()` subscribes — no filesystem watcher anywhere. State migration runs once per process inside `getDb()` and is idempotent.

### Dual-lane queue (downloader)

`DownloadManager` keeps `_high[]` (priority 1 realtime; priority 0 TTL/self-destruct unshifted to front) and `queue[]` (priority 2 history backfill). Workers always drain `_high` first, then `queue`, then rehydrate from the `queue_backlog` SQLite table. **Realtime never starves behind backfill.**

### Multi-account routing

`AccountManager` (`src/core/accounts.js`) holds `Map<accountId, TelegramClient>`. On `RealtimeMonitor.start()`, every enabled group is probed against each loaded client; the first one that succeeds is cached. A group can pin an explicit account via `group.monitorAccount`.

**Never assume `this.client` is the right client for a given group** — go through `getClientForGroup(group)`. Likewise for forwarder / history paths.

### JobTracker pattern (fire-and-forget admin endpoints)

Long-running admin actions (verify files, dedup scan, db vacuum, faststart sweep, NSFW scan, etc.) follow a single contract via `src/core/job-tracker.js`:

- `POST` returns 200 with `{started: true}` in <500 ms.
- Work runs in the background.
- Progress + result land via WS as `${prefix}_progress` and `${prefix}_done`.
- Sibling `GET .../status` lets a re-mounted page recover live state.
- `tryStart` returns `{started: false, code: 'ALREADY_RUNNING'}` for single-flight conflicts.

When adding a new long-running admin endpoint, **reuse this pattern** — don't invent a new lifecycle.

### WebSocket pub/sub

Server: `broadcast({type: '<event>', ...payload})` in `server.js`. Client: `ws.on('<event>', handler)` in `src/web/public/js/ws.js`.

The `JobTracker` auto-emits `${eventPrefix}_progress` and `${eventPrefix}_done` — the prefix is set when constructing the tracker. When wiring a new tracker, also wire a matching client listener; the WS audit script in this repo (and prior incidents) shows that drift between server emitters and client listeners silently breaks features (the v2.8 release fixed several of these).

### Auto-update (watchtower sidecar)

`src/core/updater.js` runs a 5-step pipeline: ping watchtower (5 s HEAD) → live-DB `PRAGMA quick_check` → snapshot `data/db.sqlite` to `data/backups/` → verify the snapshot is openable + clean (bad files are deleted) → POST watchtower's `/v1/update`. Each error has a stable `code` (`WATCHTOWER_UNREACHABLE`, `DB_CORRUPT`, `BACKUP_FAILED`, `BACKUP_VERIFY_FAILED`, `TRIGGER_FAILED`). Every attempt is audited to `update_history`; the new container's boot path stamps each `triggered` row to `success` (different version observed) or `stalled` (10-min timeout).

**The dashboard never touches `/var/run/docker.sock`** — RCE in the web layer must not equal host root. The watchtower sidecar gets the socket; the dashboard speaks to it via authenticated HTTP only. `WATCHTOWER_URL` and `WATCHTOWER_HTTP_API_TOKEN` come from `.env`, never written to kv['config'].

### Web auth & guest gating

Sessions are opaque random tokens (NOT the password) persisted to the `web_sessions` table; cookies are `httpOnly + sameSite=strict + secure`. The `/api` chokepoint is **default-deny for guests** — a small allowlist (`/api/downloads*`, `/api/stats`, `/api/groups` GET, `/api/thumbs/*`, `POST /api/logout`, etc.) covers read-only paths. Every mutation route is admin-only by construction; **adding a new mutation endpoint admin-gates it for free.**

### SPA

Vanilla ES Modules served over HTTP — **no bundler, no build step.** Asset URLs are cache-busted via `?v=<APP_VERSION>` (driven from `package.json`). Bump `VERSION` in `src/web/public/sw.js` on every meaningful release so the service worker evicts stale shell + asset caches.

i18n is `data-i18n` attributes with lockstep `en.json` / `th.json` — both files must change together; CI catches drift.

### Docker

Multi-stage `Dockerfile`, runs as non-root `node` user (uid 1000) under `tini`. The entrypoint runs as root, fixes `/app/data` ownership + permissions (handles host-side perms on bind mounts), then drops via `gosu`. Pre-creates every dir the app writes to: `data/{downloads,logs,sessions,backups}`. The `chmod -R a+rX /app` line in the Dockerfile is load-bearing — it works around a BuildKit mode-0 bug seen on Windows hosts. `FAST_BOOT=1` skips the chown walk for volumes with millions of files.

## Conventions specific to this codebase

- **ES Modules everywhere.** `"type": "module"` in package.json — no CommonJS.
- **Telegram IDs are strings** — large ints overflow `Number.MAX_SAFE_INTEGER`. Don't `Number(groupId)`.
- **Reuse existing helpers**: `sanitizeName`, `loadConfig`, `safeResolveDownload`, `SecureSession`, `escapeHtml`, `showToast`, `confirmSheet`. Don't reinvent.
- **Conventional Commits** for branch + PR work: `feat(web): …`, `fix(downloader): …`, `release: vX.Y.Z — …`.
- **No Claude attribution in git artifacts.** Commit messages, CHANGELOG entries, release notes, PR bodies, MD files — all in maintainer voice. Never reference "the user", quote chat, or attribute to forks/cherry-picks.
- **Release notes + CHANGELOG entries are short** — one screen, one-line bullets, no design-rationale sections, no "How it works" deep dives.
- **Release only for meaningful changes** — batch one-line tweaks / typos / lint fixes onto the next real release.
- **Update docs on every release** — README + `docs/*.md` MUST be synced in the same commit when a release adds/changes endpoints, env vars, config keys, modules, or behaviour.
- **`gh release create` heredocs use `<<'EOF'`** — never backslash-escape inside; renders as literal `\\\`...\\\`` in the release notes + Telegram relay.
- **Bump `src/web/public/sw.js` `VERSION`** on every meaningful release alongside `package.json`.

## Tests

`tests/` uses vitest. The suite spins up an isolated DB by setting `TGDL_DATA_DIR` to a tmpdir — never touches the real `data/db.sqlite`. When adding tests for code that calls `getDb()`, follow the existing pattern (set `TGDL_DATA_DIR` in `beforeEach`, point at `os.tmpdir()/<random>`).

131 test files, 1034 specs at v2.8.0. CI matrix: Node 22 & 24 × Ubuntu / Windows / macOS, plus a Docker smoke job that builds the image and verifies file perms + healthcheck + non-root execution.

## Pointers

- Architecture deep-dive: `docs/ARCHITECTURE.md`
- HTTP API + WS event reference: `docs/API.md`
- AI subsystem (semantic search, faces, tags, pHash): `docs/AI.md`
- Backup providers: `docs/BACKUP.md`
- Deployment recipes: `docs/DEPLOY.md`
- Common operator issues: `docs/TROUBLESHOOTING.md`
- Pre-v2.0 audit findings (kept for historical reference): `docs/AUDIT.md`
