# telegram-media-downloader Go server

`cmd/tgdl-server` is the production backend. It serves the embedded SPA,
owns the HTTP and WebSocket surfaces, opens the WAL SQLite database, and
manages sessions, read projections, writes, jobs, Telegram adapters and
backups in one process. Production does not start Node, proxy to Node, or
select another implementation when a feature fails.

The browser JavaScript under `web/public` is client code and runs in the
user's browser. ffmpeg and explicitly configured AI services are external
workers with clear errors; they are not server fallbacks.

## Run

```sh
TGDL_DATA_DIR=/var/lib/telegram-media-downloader PORT=3000 \
  ./tgdl-server
```

`TGDL_DATA_DIR` is required. The server creates `db.sqlite` and applies the
same idempotent schema used by existing installations. `PORT` defaults to
`3000`; `TGDL_SESSION_TTL_DAYS` defaults to 30. The existing session cookie
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
- `GET /ws` upgrades an authenticated session and sends `ws_ready`; events
  are bounded and role-filtered so a slow browser cannot block workers.
- `/v1/db/*` exposes the read projections used by the gallery, maintenance,
  AI, NSFW, integrity, dedup and cluster surfaces. They run directly against
  a query-only pool and require a valid session.
- Pin mutations, job status/cancellation, SQLite backup and cluster pairing
  are owned by Go and commit before broadcasting their event.

## Data safety

SQLite uses WAL, `synchronous=NORMAL`, `busy_timeout=5000` and foreign keys.
Schema creation is embedded and idempotent. Media downloads reserve the
Telegram identity before network I/O, write beside the destination as a
`.part` file, fsync, and atomically rename. A cancelled or failed transfer
removes the partial file and releases the reservation.

Backups use SQLite `VACUUM INTO` and publish a timestamped file only after the
snapshot is complete; each result includes byte count and SHA-256.

## Telegram engine boundary

`internal/telegram` contains the gotd adapter and the live identity index.
`internal/download` accepts a fakeable client interface for deterministic
unit tests and uses the same atomic handoff in production. The adapter does
not dial while being constructed; network activity starts only from its
context-cancellable `Run` method.

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
