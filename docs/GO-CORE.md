# Go core (`tgdl-core`)

telegram-media-downloader is moving its heavy lifting from Node.js to a Go
companion process, `tgdl-core` (source: [`core-service/`](../core-service/README.md)),
one feature at a time. Each step ships behind a flag, runs in shadow mode
first, and can be switched off without changing anything else.

## Rules every feature follows

1. **Node is the single DB writer.** tgdl-core never opens `db.sqlite`.
   It computes and returns results; Node decides what to store.
2. **Every feature has a Node fallback.** Binary missing, download
   failed, platform unsupported, crash, timeout, wrong answer shape, open
   circuit breaker: the Node implementation runs, and callers see the
   same results and the same errors as before.
3. **Every feature has parity checks.** New features start in `shadow`:
   Node's result is used and Go computes the same thing on a sample in
   the background; mismatches are counted
   (`tgdl_gocore_parity_mismatch_total{feature}`). A feature is only
   defaulted to Go after shadow runs clean.
4. **No contract changes for users.** Same data dir, DB schema, config,
   env vars, HTTP/WS API, Docker entrypoint, ports and healthcheck.
   Additions only.
5. **tgdl-core can't outlive the app.** It exits when its stdin pipe
   closes, is bound to `127.0.0.1`, and needs a per-spawn token for
   everything but `/health`.
6. **tgdl-core only reads where the app keeps media.** The app passes its
   download folders as `TGDL_CORE_ALLOW_ROOTS`; a path outside them (as
   written or after resolving symlinks) is refused with `EOUTSIDE`, and
   Node handles that file as it always did. No roots = nothing is read.

## Modes

| Mode | What runs | Fallback |
|---|---|---|
| `off` | Node only; tgdl-core isn't even started when every feature is off. | — |
| `shadow` *(default in this release)* | Node's result is used. ~1 in 20 calls (files ≤ 256 MB for hashing) are repeated in Go afterwards and compared. | n/a — Go never decides anything |
| `on` | Go first. | Node on any error. |
| `auto` | Like `on`; ~1 in 20 Go answers are re-checked by Node in the background. One mismatch demotes the feature to `shadow` until restart. | Node on any error. |

Set it with, first match wins:

1. `TGDL_GO_FEATURES="hash=on"` — per feature, env
2. `TGDL_GO_CORE=off|shadow|on|auto` — all features, env
3. `config.advanced.goCore.features` — per feature, e.g. `{ "hash": "on" }`
4. `config.advanced.goCore.mode`
5. the default (`shadow`)

`POST /api/config` with `{"advanced":{"goCore":{"mode":"off"}}}` applies
at once (tgdl-core stops or starts); `null` removes the block.

## Watching it

- `GET /api/system/health` → `goCore`: mode and its source, process state
  (`running`, `binary_missing`, `downloading`, `unsupported`, `exited`,
  `disabled`, …), version, binary path and source, restarts, and per
  feature the effective route (`node` / `shadow` / `go`), breaker state and
  counters (Go answers, Node answers, fallbacks, parity checks,
  mismatches, skipped comparisons).
- `/metrics`: `tgdl_gocore_calls_total{feature,result}` (`ok`,
  `file_error`, `outside`, `timeout`, `error`), `tgdl_gocore_parity_checks_total{feature}`,
  `tgdl_gocore_parity_mismatch_total{feature}`.
- Logs: `[go-core] …` lines (start, restarts, breaker trips, mismatches).

Circuit breaker: 5 service failures (timeouts, dropped connections, 5xx,
401, malformed answers) within 60 s turn the feature off until the next
successful health probe (every 30 s). "This file can't be read" and
"outside the allowed roots" answers don't count. Three failed health probes in a row restart the process,
with exponential backoff (2 s … 5 min).

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Process lifecycle, flags, breaker, metrics, packaging; SHA-256 file hashing (download-time dedup, duplicate scan, NSFW blocklist) | **this release** (default `shadow`) |
| 2 | File-system sweeps (integrity walk, disk-usage scan, orphan detection) and face-clustering DBSCAN | next |
| 3 | MTProto byte plane — Go streams file bytes from Telegram to disk; Node keeps sessions, the queue and the DB | planned |
| 4 | Backup providers (S3, SFTP, FTP, Google Drive, Dropbox, local) as Go uploaders | planned |
| 5 | Go front server on `PORT`: `/files` and Range streaming, `/photos`, thumbnail cache hits; everything else proxied to Node | **this release** (always on — see [Front server](#front-server-tgdl-core-front)) |
| 6 | Engine (monitor / downloader orchestration) in Go | gated on spikes proving the earlier phases in production |

Each phase starts in `shadow` with parity checks and keeps its Node path
until the Go path has run clean in the field.

The end state — the whole backend in Go, no Node at runtime, gated by the
black-box API contract suite in `tests/contract/` — is planned in
[GO-MIGRATION.md](GO-MIGRATION.md).

## Measured (phase 1)

`scripts/bench-gocore-hash.js`, warm page cache, i9-13900K / Windows 11 /
Node 22, pool size 8 on both sides; all engines produced identical
digests:

| Set | Engine | 1 at a time | 8 in flight | Loop p99 | Loop utilisation (8 in flight) |
|---|---|---|---|---|---|
| 402 files, 2.2 GB | Node worker pool | 459–862 MB/s | 3.1–4.7 GB/s | 2.6–2.9 ms | 2–3 % |
| | Node main thread | 626–991 MB/s | ~2.0 GB/s | 1.2 ms | 99 % |
| | tgdl-core | ~1.75 GB/s | 6.6 GB/s | 2.7–3.0 ms | 18–23 % |
| 22 files, 3.8 GB | Node worker pool | 634 MB/s | 5.1 GB/s | 2.6 ms | 1 % |
| | tgdl-core | 1.83 GB/s | 7.6 GB/s | 2.5 ms | 4 % |

tgdl-core used 16–32 MB RSS. The extra loop time with many small files
is the HTTP round trip (~0.2 ms of main-thread work per file); it never
blocks the loop (p99 delay equals the worker pool's). On a disk-bound
NAS both engines are limited by the disk.

## Front server (`tgdl-core front`)

tgdl-core owns the app's `PORT`; the Node server listens on
`127.0.0.1:<random>` behind it. Nothing to configure: same port, same
Docker healthcheck, same responses (status, headers, body) as when Node
answered `PORT` itself.

**What it answers itself** — `GET`/`HEAD` of a local file under
`/files/…`, an avatar under `/photos/…` and a cached thumbnail
(`/api/thumbs/:id`), when it is certain Node would serve it: a valid file
token or a session cookie that doesn't need renewal, the dashboard's auth
set up, with Force HTTPS on only for a secure request, and (thumbnails)
with the `/api` rate limit off, so the limiter still counts every request.
Range (single and suffix ranges, `If-Range`), conditional requests,
`Content-Type`, `Content-Disposition` (RFC 5987) follow `send` / Express
exactly; the security and cache headers (HSTS, CSP and the rest of
helmet, `Cache-Control`, `Vary`) are the ones Node's own middlewares
produce, pushed to tgdl-core on every config change — tgdl-core
hardcodes none.

**Everything else goes to Node**, streamed without buffering (bodies of
unknown length flushed as they come, WebSocket upgrades tunnelled byte
for byte, the path and query passed exactly as sent). That includes every case
above tgdl-core isn't certain about — a session due for sliding renewal,
a missing file (Node prunes the row and answers 404), HEIC inline
transcoding, `_clusterref` / `?peer=` files, `If-Match`, an unsatisfiable
range. When Node's answer is a file (`/files`, HEIC cache, thumbnails,
`/photos`, `/share`), Node decides status and headers and hands the byte
range back (`X-Tgdl-Accel`), so file bytes never cross Node's event loop.

**Security model**

- Sessions are checked read-only in `web_sessions`
  (`modernc.org/sqlite`, `mode=ro`, `query_only`); renewals, expiry
  deletes and every refusal (401, redirect to the login page, 503 before
  setup) come from Node. File tokens are verified with the share secret,
  which Node sends over the token-gated control channel on `127.0.0.1` —
  never argv or env.
- Client address: tgdl-core passes the client's `X-Forwarded-*` headers
  through untouched and the connecting address in a private header that
  Node accepts only with the per-spawn token and removes before any route
  runs. Express then applies the app's own `trust proxy` (`TRUST_PROXY`,
  default loopback) to the real client, so `req.ip`, the localhost-only
  setup page, Force HTTPS and the rate limits behave exactly as before.
  `X-Tgdl-*` headers sent by a client are dropped.
- Files are served only inside the allowed roots (downloads, photos,
  thumbnail cache); a symlink or junction that leaves them goes to Node.
- Timeouts are Node's: 70 s for request headers, 65 s keep-alive, no
  write timeout (a video streams as long as it plays), 16 KiB of headers.

**When it can't run** — Node restarts it when it exits or fails three
health checks in a row (after 50 ms, then up to 5 s). If it can't be kept
running (binary missing, won't start, 5 exits in a minute) Node binds
`PORT` itself, logs why and shows a banner on every page, so the
dashboard and `/api/auth_check` (the healthcheck) keep working. A port
already in use is fatal with the same message as before.

**Watching it** — `GET /api/system/health?front=1` → `goCoreFront`:
state, pid, restarts, and counters (answered itself per kind, proxied,
accel, WebSockets, bytes, errors).

**Parity gates** — the API contract suite (`npm run test:contract`) runs
through the front server; `tests/front-parity.e2e.test.js` replays 115
frozen v2.28 responses (Range, 304 / 412 / 416, HEAD, tokens, guests,
renewals, HEIC, thumbnails, static assets with compression, WebSockets); `tests/front-security.e2e.test.js`
compares the security behaviour with Node alone (trust proxy variants,
`/api/auth/setup` local-only, forged private headers, forceHttps, rate
limits, file tokens); the Go unit tests check the ports of `range-parser`,
`fresh`, `send`'s MIME table, `trust proxy`, `qs` and the cookie parser
against answers recorded from the Node libraries
(`core-service/internal/front/testdata/conformance.json`).

### Measured (front server)

`node scripts/bench-front.js --size-mb 512 --requests 200`, i9-13900K /
Windows 11 / Node 22, warm page cache, one run. "Busy" = Node's event
loop blocked 450 ms out of every 500 ms (a CPU burn preloaded into the
server), requests sent open-loop every 25 ms.

| | Node on PORT (before) | tgdl-core front |
|---|---|---|
| Video, 4 MiB ranges, 1 client | 264 MB/s | 599 MB/s |
| Video, 4 MiB ranges, 4 clients | 696 MB/s | 1,883 MB/s |
| Video, 1 client, Node busy | 47 MB/s | 651 MB/s |
| TTFB `/files` 64 KiB range, p50 / p99 | 1.6 / 8.3 ms | 0.9 / 2.2 ms |
| TTFB thumbnail hit, p50 / p99 | 2.0 / 6.2 ms | 0.6 / 1.9 ms |
| TTFB `/files`, Node busy, p50 / p99 | 219 / 452 ms | 1.2 / 4.9 ms |
| TTFB thumbnail hit, Node busy, p50 / p99 | 210 / 455 ms | 1.1 / 2.3 ms |
| RSS idle | Node 119 MB | Node 119 MB + tgdl-core 11 MB |
| RSS after the throughput runs | Node 155 MB | Node 90 MB + tgdl-core 20 MB |
