# Go migration status

This branch is still under development. Its packaging runs `tgdl-server`,
but the Go application is not yet a complete replacement for the released
downloader. Passing package tests does not establish end-to-end Telegram
functionality. Do not deploy this branch over a working library yet.

## Verified in the current application

- Authentication, first-time setup, password changes/reset, guest access,
  session expiry/renewal, cross-origin guards and browser WebSocket transport.
- Signed share creation/listing/revocation, expiry/signature rejection,
  partial transfers, access counters and configurable request limiting.
- The four existing black-box contract files `auth`, `auth-password`,
  `auth-setup` and `share` pass against the Go executable: **30 tests**.
- Focused Go regressions exercise secret redaction, partial config saves,
  config notifications without credentials, shared-file reference retention,
  directory traversal/symlink containment, explicit purge confirmation and
  retrying persisted file cleanup after restart.
- Native Telegram session storage uses authenticated encryption and atomic
  replacement. Tests cover reopening, wrong secrets, tampering, cancellation,
  private permissions, import preservation and corrupt-state rejection. This
  verifies the adapter/storage layer; it is not a live Telegram E2E run.
- The download handoff exclusively claims each queued identity before network
  I/O, checks the declared media size, honors cancellation, and publishes with
  an OS-level exclusive rename. Race regressions cover competing workers and
  a destination created during the download. Creation and publication remain
  bound to directory handles even when an ancestor is renamed during transfer.
- The application ingestion boundary extracts exact Telegram document/photo
  identities from MTProto messages, including progressive photo sizes, without
  converting 64-bit IDs through floating point. Existing catalog references
  persist dedup across restart. Only active coordination lives in memory.
- Ingestion hashes bytes during transfer and merges identical content across
  different Telegram IDs. Reuse checks file identity, size, modification time,
  OS change token and previous verified SHA; missing or changed candidates are
  rejected. Message edits serialize and invalidate obsolete analysis and cached
  thumbnails/seekbar files through a durable cleanup queue.
- A publication journal recovers a completed file when catalog registration
  failed. Message generations prevent an older journal entry from reverting a
  newer edit. This is process-interruption recovery; unfinished transfer retries
  still require the pending account/queue engine.
- A Go integration test exercises raw MTProto metadata through application
  ingestion, WebSocket notification, authenticated HTTP range serving, deletion
  of one shared-file reference and restart. Its Telegram byte transport is a
  fixture. The native gotd media transport compiles but has not been exercised
  against Telegram's network.

The contract runner still uses development-time JavaScript dependencies to
compare the Go server with frozen responses. It does not launch a Node server
for these Go-target tests. Removing this test tooling remains part of the
migration; the current source tree is not yet free of Node dependencies.

## Required before release

- Wire actual account/session ownership, Telegram login and updates, downloads,
  history, queue cancellation/recovery and monitor lifecycle into the app.
  The current monitor endpoint reports stopped; the adapter alone does not
  start a downloader.
- Connect the application ingestion boundary to durable queue ownership, live
  account updates and history jobs; add cancellation/retry and cross-account E2E.
  The new boundary is not yet called by a running monitor.
- Complete gallery/media/config/group/delete/purge contracts, maintenance jobs,
  archives, AI/NSFW services, backups and cluster management. A low-level Go
  projection or helper is not a replacement for the public workflow.
- Finish the native test runner, remove the old server sources and launchers,
  and run the full HTTP/WebSocket/browser/data-migration E2E and performance
  checks. Live Telegram E2E still requires an authorized test account.

Existing WebSockets can remain open after their HTTP session is revoked,
matching the frozen contract. Closing those connections promptly remains
security debt to address deliberately with updated compatibility coverage.

## Implementation references

Media opens and cleanup use directory-relative `os.Root` operations so a
symlink or path rename cannot escape the library. Cleanup paths are persisted
in SQLite in the deletion transaction; cleanup rechecks retained references
under the writer lock. Failures remain queued and are reported, then retried
on restart or the next deletion. SQLite and filesystem operations are not a
single atomic transaction. The durable queue makes interrupted cleanup
recoverable. See the [Go traversal-resistant file APIs](https://go.dev/blog/osroot)
and [os.Root reference](https://pkg.go.dev/os#Root).

The module requires Go 1.25 or newer and selects Go 1.26.8. Docker and the main
Go CI workflows use the same toolchain. Other API references:
[net/http](https://pkg.go.dev/net/http),
[SQLite driver](https://pkg.go.dev/modernc.org/sqlite),
[gotd](https://gotd.dev/docs/intro/),
[Telegram API](https://core.telegram.org/api).

Exclusive media publication uses Linux `renameat2(RENAME_NOREPLACE)`, macOS
`renameatx_np(RENAME_EXCL)` and Windows `NtSetInformationFile` with
`FileRenameInformation`, `ReplaceIfExists=false` and a directory handle.
An OS/filesystem refusal is returned to the caller. See
[Go syscall wrappers](https://pkg.go.dev/golang.org/x/sys/unix#Renameat2) and
[Windows FILE_RENAME_INFORMATION](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information).
Linux regression tests pass; Windows amd64 and macOS arm64 test binaries were
cross-compiled, not executed natively.

## Focused ingestion measurement

`go test -run '^$' -bench BenchmarkLibraryForwardedMedia -benchtime=100x ./internal/download`
measured **1.08 ms/op with one existing reference** and **2.39 ms/op with 1,000
references** on this Linux amd64 development machine (Core Ultra 7 270K Plus).
The fixture is a verified 1 MiB file; every timed operation runs without a
network transport and must reuse the existing file. This measures catalog
registration and verified-cache lookup, not Telegram network throughput or the
complete application. The benchmark source is included for repeatable comparison.
