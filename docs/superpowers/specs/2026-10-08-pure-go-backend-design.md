# Pure-Go Backend Design

## Goal

Replace the Node.js server runtime with one Go binary that owns the HTTP API, WebSocket transport, authentication, configuration, SQLite reads and writes, Telegram sessions, download queues, media maintenance, backup, and cluster features. The browser SPA remains JavaScript because it executes in the browser; Node.js is removed from the runtime image and production process tree.

## Non-negotiable behavior

- The existing `data/` directory remains readable and writable in place. SQLite schema, `kv` JSON shapes, session blobs, media paths, share signatures, file tokens, backup credentials, and cluster signatures remain compatible.
- The Go binary serves the current REST and WebSocket contracts. Existing contract snapshots remain the compatibility oracle; no snapshots are changed to hide a difference.
- Go is the only runtime implementation in the final image. There is no Node subprocess, Node HTTP proxy, Node database fallback, optional Go feature gate, or runtime fallback branch.
- Telegram operations use one Go client owner per account and never open the same session concurrently. Live media identity dedup happens before network download and content-hash dedup remains an invariant at registration.
- Every queue and long-running operation is bounded, cancellable, observable through the existing event names, and safe across restart.
- Writes use a single Go writer with explicit transactions; read pools are separate and use the same WAL, busy timeout, foreign-key, and synchronous pragmas.

## Architecture

`cmd/tgdl-server` is the production entry point. It composes packages for config/secrets, database migration and repositories, auth, HTTP handlers, WebSocket hub, Telegram accounts, download queues, media workers, maintenance jobs, backup, and cluster transport. `embed.FS` serves `src/web/public`; static asset version rewriting stays request-time compatible with the current SPA.

The existing `core-service/internal` packages become libraries or are folded into the server process. `tgdl-core serve` and `tgdl-core front` remain development migration tools only until the final packaging task removes them. No production handler calls another local HTTP service.

Telegram is implemented behind a small interface backed by `github.com/gotd/td`. A session adapter decrypts the current gramJS `SecureSession` envelope and supplies the DC/auth-key data to gotd without forcing users to log in again. A deterministic fake Telegram transport covers monitor, history, stories, download, delete, access errors, and FloodWait behavior in tests.

## Migration order

1. **Foundation:** Go module/server entry point, embedded SPA, migrations, config/secrets, auth/session middleware, request limits, WebSocket hub, health endpoint, and contract harness.
2. **Read surface:** groups, downloads, search, stats, people/faces, NSFW, seekbar, thumbnails, shares, recovery, update history, and cluster reads.
3. **Write surface:** config/groups, pins, deletes/purge, share links, maintenance jobs, AI/NSFW mutations, and event persistence.
4. **Telegram engine:** gotd session conversion, account wizard, monitor/catch-up, dialogs/access probes, history/stories, live download queue, forwarding, FloodWait and expired file-reference handling.
5. **Media and integrations:** thumbnail/face crops, ffmpeg/seekbar, backups, cluster pairing/sync, CLI commands, and restart-safe job recovery.
6. **Cutover:** Go contract and E2E are green, benchmark and race checks are recorded, Docker/bare-metal launch only the Go binary, Node dependencies/source/runtime shims are deleted, and docs describe the Go-only deployment.

Each step moves a complete domain, including its writes, caches, events, and tests. No final step may depend on a Node fallback.

## Data and failure model

- Startup fails closed with a structured error when the database, secret key, or required migration cannot be opened. It does not silently start a partial server.
- Telegram transient errors are classified into retryable, FloodWait-paused, access-paused, and permanent media errors. Retries use bounded exponential backoff and a queue-level deadline.
- A corrupted or missing media path is reported through the existing integrity/recovery events; destructive cleanup requires the same confirmation and role checks as today.
- WebSocket clients receive the same event names and payload shapes. The hub coalesces progress events, caps per-client buffers, terminates dead peers, and never blocks a download worker.
- All errors sent to clients are stable codes/messages; internal paths, tokens, and credentials stay in logs only.

## Verification and acceptance

- `CONTRACT_TARGET=go npm run test:contract` passes every scenario file and inventory check against a fresh seed.
- Go unit, integration, race, and real-core E2E suites pass. Telegram behavior is covered by the fake transport plus one opt-in live smoke test that never uses production credentials.
- `go vet ./...`, `go test -race ./...`, OOM-pattern checks, API inventory checks, and a full media/dedup benchmark pass.
- The release image contains no Node executable, package manager, `package.json`, gramJS, or better-sqlite3. A static scan finds no runtime fallback calls or Node proxy routes.
- Benchmarks compare p50/p95 API latency, ingest throughput, peak RSS, and event-loop absence against the final Node baseline recorded before cutover.

## References

- gotd Telegram MTProto client: https://gotd.dev/docs/intro/ and https://gotd.dev/docs/getting-started/first-client/
- Telegram API/MTProto reference: https://core.telegram.org/api
- Go HTTP server package: https://pkg.go.dev/net/http
- CGo-free SQLite driver: https://pkg.go.dev/modernc.org/sqlite
- Project contract and compatibility rules: `tests/contract/README.md`, `docs/GO-MIGRATION.md`, and `docs/GO-CORE.md`
