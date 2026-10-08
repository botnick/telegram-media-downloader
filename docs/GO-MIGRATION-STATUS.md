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

The contract runner still uses development-time JavaScript dependencies to
compare the Go server with frozen responses. It does not launch a Node server
for these Go-target tests. Removing this test tooling remains part of the
migration; the current source tree is not yet free of Node dependencies.

## Required before release

- Wire actual account/session ownership, Telegram login and updates, downloads,
  history, queue cancellation/recovery and monitor lifecycle into the app.
  The current monitor endpoint reports stopped; the adapter alone does not
  start a downloader.
- Persist Telegram media identities, exclusively claim queued work, validate
  downloaded size, and publish without overwriting another download.
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
