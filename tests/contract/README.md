# Historical HTTP/WebSocket contract evidence

These JSON snapshots, route inventory, schema and media fixtures record the
previous release. They remain useful references for reviewing data and API
compatibility. They are not executable tests or evidence that every optional
feature exists in the Go server.

The old recorder, seed helpers and Node/Vitest harness were removed with the
obsolete backend. Their complete source remains in Git at commit `aa83eed`.
Do not recreate that runtime to operate or test the native application.

Current verification runs in Go:

```sh
make test
make check
```

HTTP, WebSocket, authentication, accounts, raw Telegram update ingestion,
download-time dedup, queue/recovery, history/URL and filesystem regression tests
live in `core-service/internal/`. Browser assets are embedded from
`core-service/internal/webassets/public/`. See
[verified scope and outstanding work](../../docs/GO-MIGRATION-STATUS.md).

Snapshots contain normalized timestamps, random token placeholders, platform
masks and some known legacy defects. An intentional native security fix must be
tested as a behavior/invariant, not reverted to reproduce a historical defect.
Historical 246/324 results refer to the last run before harness removal; they
are not a current executable gate and have not been relabeled as all passing.
