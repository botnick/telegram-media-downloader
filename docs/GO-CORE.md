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
| 5 | Go front server for static files, `/files` and Range streaming, proxying the API to Node | planned |
| 6 | Engine (monitor / downloader orchestration) in Go | gated on spikes proving the earlier phases in production |

Each phase starts in `shadow` with parity checks and keeps its Node path
until the Go path has run clean in the field.

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
