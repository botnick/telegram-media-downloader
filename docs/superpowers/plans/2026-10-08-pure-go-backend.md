# Pure-Go Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship a single Go backend binary that preserves the current Telegram downloader behavior while removing Node.js and all runtime fallbacks.

**Architecture:** Extend `core-service` into a Go application server. Move domains in dependency order, preserving the existing HTTP/WS and data contracts, then embed the SPA and delete Node runtime files and dependencies from the release image.

**Tech Stack:** Go 1.24+, `net/http`, `github.com/gotd/td`, `modernc.org/sqlite`, `embed.FS`, existing ffmpeg and Python sidecars where their contracts remain explicit.

**Spec:** `docs/superpowers/specs/2026-10-08-pure-go-backend-design.md`

## Global Constraints

- Use the existing data directory, SQLite schema, session formats, signatures, and environment variable names.
- The final production process tree contains only the Go binary plus explicitly configured external sidecars; no Node subprocess or Node HTTP proxy.
- Do not add runtime fallbacks. Unsupported startup state is a clear error with a stable code.
- Keep Node only as a development-time contract oracle until the final deletion task.
- Every task uses botnick Git metadata and no AI/co-author attribution.
- Every task has a failing test before implementation and a focused regression run before commit.

## Review Focus

- A partially migrated data directory must fail with a useful startup error rather than silently dropping fields.
- Concurrent account start/download operations must not reuse one Telegram auth key at the same time.
- A slow or dead WebSocket client must not stall downloads or maintenance workers.
- A cancelled multi-gigabyte operation must release file descriptors, temp files, locks, and queue slots.
- Final packaging must not accidentally retain Node through a launcher, Docker layer, or generated artifact.

### Task 1: Go application foundation

**Files:**
- Create: `core-service/cmd/tgdl-server/main.go`
- Create: `core-service/internal/app/app.go`, `core-service/internal/app/app_test.go`
- Create: `core-service/internal/config/full.go`, tests
- Create: `core-service/internal/store/migrate.go`, tests
- Create: `core-service/internal/auth/*.go`, tests
- Create: `core-service/internal/ws/*.go`, tests
- Modify: `core-service/go.mod`, `core-service/README.md`
- Test: `tests/contract/fixtures/go-target-smoke.test.js`

**Interfaces:**
- Produces `app.New(ctx, app.Config) (*App, error)`, `App.Handler() http.Handler`, and `App.Close() error`.
- Produces a migration runner that accepts an existing data directory and returns a schema version without altering existing column meanings.

- [ ] Write failing tests for startup on a seeded data directory, auth cookie/session parity, migration idempotence, health readiness, and WebSocket ping/role gating.
- [ ] Run the focused tests and record the expected failures.
- [ ] Implement the Go entry point, strict config loading, SQLite writer/read pools, auth middleware, static embedded handler, and bounded WebSocket hub.
- [ ] Run Go unit tests, Go race tests for foundation packages, and the Go contract smoke target.
- [ ] Commit `feat: add pure-go application foundation`.

### Task 2: Go read API parity

**Files:**
- Modify: `core-service/internal/dbread/*`
- Create: `core-service/internal/httpapi/read_*.go`
- Modify: `core-service/internal/app/app.go`
- Test: `tests/contract/{groups,downloads,files,ai,nsfw,seekbar,thumbs,share,recovery,cluster}.contract.test.js`

**Interfaces:**
- All handlers use the store/repository interfaces from Task 1 and return the frozen response envelopes.
- No handler calls a local HTTP endpoint or an optional feature gate.

- [ ] Add failing Go-target contract coverage for every read route currently answered by the Node proxy.
- [ ] Implement paginated/keyset reads with the same ordering, null handling, filters, and role checks.
- [ ] Run the read contract group and real-core E2E with the Node DB connection unavailable.
- [ ] Commit `feat: move read api surface to go`.

### Task 3: Go write APIs and durable jobs

**Files:**
- Create: `core-service/internal/httpapi/write_*.go`
- Create: `core-service/internal/jobs/*.go`
- Modify: `core-service/internal/store/*.go`, `core-service/internal/ws/*.go`
- Test: `tests/contract/{config,delete,purge,maintenance,ai-jobs,nsfw,backup}.contract.test.js`

**Interfaces:**
- Mutations run through one writer transaction and publish the existing event names after commit.
- Job trackers expose status, cancellation, bounded progress, and restart recovery.

- [ ] Add failing tests for transactional writes, duplicate job rejection, cancellation, and event ordering.
- [ ] Implement config/groups/pins/delete/purge/share/maintenance/AI/NSFW/backup writes and jobs.
- [ ] Run the write contract group plus race tests for job trackers and WS hub.
- [ ] Commit `feat: move write and maintenance domains to go`.

### Task 4: gotd Telegram engine

**Files:**
- Create: `core-service/internal/telegram/*.go`
- Create: `core-service/internal/session/*.go`
- Create: `core-service/internal/download/*.go`
- Modify: `core-service/go.mod`
- Test: `core-service/internal/telegram/*_test.go`, `core-service/internal/session/*_test.go`, `tests/contract/{accounts,monitor,queue,telegram-actions}.contract.test.js`

**Interfaces:**
- `telegram.Client` covers auth, dialogs, entities, messages, updates, stories, media downloads, delete events, and session save.
- `download.Manager` accepts Telegram media identity before network I/O and emits the existing queue/download events.

- [ ] Build the fake Telegram transport and write red tests for session conversion, live identity dedup, FloodWait, expired file reference, access pause, and cancellation.
- [ ] Implement gotd account ownership, SecureSession conversion, monitor/catch-up, history/stories, resolver, forwarder, and bounded download lanes.
- [ ] Run fake-engine tests, contract Telegram group, dedup E2E, and a no-credential live smoke test.
- [ ] Commit `feat: move telegram engine to gotd`.

### Task 5: Media, backup, cluster, and CLI parity

**Files:**
- Modify: `core-service/internal/front`, `internal/thumbs`, `internal/seekbar`, `internal/zipstream`, `internal/tarstream`
- Create: `core-service/internal/backup/*.go`, `internal/cluster/*.go`, `core-service/cmd/tgdl-server/commands.go`
- Test: media, backup, cluster, CLI and security contract files plus benchmarks

- [ ] Add failing tests for Range/media parity, backup credential compatibility, cluster HMAC/pairing, and CLI command output.
- [ ] Implement the remaining integrations and restart-safe cleanup without Node-owned helpers.
- [ ] Run full Go contract, integration, race, benchmark, OOM, and security scans.
- [ ] Commit `feat: complete pure-go integrations`.

### Task 6: Remove Node runtime and cut over packaging

**Files:**
- Modify: `Dockerfile`, `docker-compose.yml`, `package.json`, `ecosystem.config.cjs`, launch scripts, docs
- Delete: `src/`, Node-only scripts and dependencies after the Go contract is green
- Modify: `tests/contract` target selection and inventory checks

- [ ] Add a failing packaging test that rejects Node, gramJS, better-sqlite3, proxy routes, and fallback symbols in the release image/source tree.
- [ ] Switch Docker, bare-metal launchers, healthcheck, and update flow to `tgdl-server` only; embed the SPA and docs.
- [ ] Run the full Go contract suite, Go race/vet/build, packaging scan, benchmark, and clean-room Docker smoke test.
- [ ] Commit `feat: remove node runtime from production`.

### Final verification

- [ ] Run `CONTRACT_TARGET=go npm run test:contract` on a fresh seed.
- [ ] Run `/usr/local/go/bin/go test -race ./...` and `/usr/local/go/bin/go vet ./...`.
- [ ] Run `npm run check:oom`, API inventory, packaging scan, and the media/dedup benchmark.
- [ ] Verify `./git-project -C source status --short --branch` is clean and all commits are authored by `botnick`.
