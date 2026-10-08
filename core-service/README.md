# telegram-media-downloader Go server

`cmd/tgdl-server` is the Go backend under development. It serves the embedded
SPA and implemented HTTP/WebSocket routes directly. Packaging selects it,
but account/download lifecycle and public API parity remain incomplete.
See [verified coverage and remaining release work](../docs/GO-MIGRATION-STATUS.md).
The executable does not start or proxy to a Node server.

The browser JavaScript under `internal/webassets/public` is client code and runs in the
user's browser. ffmpeg and explicitly configured AI services are external
workers with clear errors; they are not server fallbacks.

## Run

```sh
TGDL_DATA_DIR=/var/lib/telegram-media-downloader PORT=3000 \
  ./tgdl-server
```

`TGDL_DATA_DIR` is required. The server creates `db.sqlite` and applies the
same idempotent schema used by existing installations. `PORT` defaults to
`3000`; `TGDL_SESSION_TTL_DAYS` defaults to 7. The existing session cookie
name is preserved as `tg_dl_session`.

Useful commands:

```sh
./tgdl-server version
./tgdl-server help
```

## HTTP and WebSocket surface

- `GET /health` reports readiness without authentication.
- `POST /api/auth/setup`, `POST /api/login`, `POST /api/logout`, and
  `GET /api/auth_check` manage the compatible scrypt/session flow.
- `GET /` and asset paths serve the embedded SPA.
- `GET /` or `GET /ws` upgrades an authenticated session; events
  are bounded and role-filtered so a slow browser cannot block workers.
- `/v1/db/*` exposes the read projections used by the gallery, maintenance,
  AI, NSFW, integrity, dedup and cluster surfaces. They run directly against
  a query-only pool and require a valid session.
- Pin mutations, job status/cancellation, SQLite backup and cluster pairing
  are owned by Go and commit before broadcasting their event.

## Data safety

SQLite uses WAL, `synchronous=NORMAL`, `busy_timeout=5000` and foreign keys.
Schema creation is embedded and idempotent. Application ingestion looks up
Telegram identities in the existing catalog before network I/O, retaining a
separate message reference for each forward. Verified hashes include OS file
identity/change metadata; active coordination is bounded by the worker limit.
Transfers write a sibling `.part` file, sync it, then publish through directory
handles with an exclusive rename. A durable journal recovers completed files
when registration fails, and message generations prevent stale recovery from
reverting edits. Cancelled transfers remove their partial files.

Backups use SQLite `VACUUM INTO` and publish a timestamped file only after the
snapshot is complete; each result includes byte count and SHA-256.

## Telegram engine boundary

`internal/telegram` extracts photo/document metadata directly from MTProto
messages and provides an account-bound gotd media transport. `App.IngestTelegram`
connects that metadata to the durable library, existing gallery files and
WebSocket events. Integration tests use a fixture byte transport. The adapter
does not dial during construction; network activity starts from `Run`.

Account ownership, login, update recovery, durable work queues and monitor
lifecycle still need to call this boundary. The server does not yet start a
working Telegram monitor. See the [migration status](../docs/GO-MIGRATION-STATUS.md)
for the remaining release gates and reproducible ingestion benchmark.

References:

- [gotd introduction](https://gotd.dev/docs/intro/)
- [gotd first client](https://gotd.dev/docs/getting-started/first-client/)
- [Telegram API](https://core.telegram.org/api)
- [Go net/http](https://pkg.go.dev/net/http)
- [modernc SQLite](https://pkg.go.dev/modernc.org/sqlite)

## Development checks

```sh
/usr/local/go/bin/go test ./...
/usr/local/go/bin/go test -race ./...
/usr/local/go/bin/go vet ./...
/usr/local/go/bin/go build ./cmd/tgdl-server
```

The recorded Node contract fixtures remain a development oracle while the
remaining domain handlers are ported. They are never copied into the
production image, and the production process tree contains only
`tgdl-server` plus explicitly configured sidecars.
