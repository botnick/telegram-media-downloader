---
title: "Purge internals"
description: "Engineering note on group purge, delete-files and factory reset: what is removed and how it survives restarts."
parent: "Developer notes"
nav_order: 12
---

# Native Go purge behavior

The group purge, delete-files and factory-reset routes run in Go. Requests are
persisted before returning `{success:true,started:true}`. Status remains
available after restart through the existing group/all status endpoints.

## What is removed

| Request | Downloads and queue | Config group | Shared physical file | Avatar |
| --- | --- | --- | --- | --- |
| `POST /api/groups/:id/delete-files` | Selected group's records | Kept | Kept if another group owns a reference | Kept |
| `DELETE /api/groups/:id/purge` | Selected group's records | Removed | Kept if another group owns a reference | Removed |
| `DELETE /api/purge/all` with `{"confirm":"DELETE ALL"}` | All local records | All removed | Removed with the local library | All removed |

Both the old queue table and the native work queue are cleaned. Queue-history
entries are removed for the selected scope. Analysis rows, share links and
derived caches follow the deleted downloads. Telegram credentials, web
credentials, sessions and remote peer catalogs are outside factory-reset scope.

## Recovery and concurrency

The purge plan, download/queue deletion, config changes and cleanup outboxes
commit in one SQLite transaction. Source-file and derived-cache cleanup are
repeatable. The original counts and remaining cleanup scope survive a crash
between catalog commit and unlink. Startup finishes outstanding purges before
starting Telegram monitoring. Failed cleanup retains its plan and reports an
error; it does not silently mark the operation complete.

The monitor is stopped and active transfers are joined before the purge takes
the media mutation lock. Independent group requests may queue, but destructive
work is serialized; full reset cannot overlap a group purge. The monitor resumes
after successful work when the operation had stopped it. A pending failed purge
blocks monitor startup, ingestion and reindexing so that files cannot acquire
new catalog owners halfway through cleanup.

Thumbnail generation, reindexing and file optimization share the media lock.
Background maintenance workers are registered before launch and joined before
SQLite closes. The group/file job claims are made before HTTP acknowledgement,
closing the double-click race. Status readers receive independent snapshots,
so polling cannot race the worker's progress-map updates.

Directory-relative filesystem operations confine cleanup to the data directory
and the media roots. Factory reset removes loose files at the downloads root as
well as group directories. Symlinks are unlinked without following their targets.
Stored cleanup plans and `io/fs` traversal paths use forward slashes on every OS.

## Intentional corrections to the frozen Node contract

The old purge snapshot is retained unchanged as evidence of the released
behavior. Two scenario cases now differ intentionally:

- A group whose actual directory differs from its sanitized display name is
  purged using the stored file paths. The old implementation removed its rows
  but left files behind. The seeded Gamma scenario now deletes four files and
  returns 404 for its former media URL, with corresponding progress counts.
- Factory reset counts non-directory entries, including symlinks removed without
  following them. The old count included directories: the seed reported 27
  while containing 19 physical media files. Reset also clears stale access
  records and broadcasts `chat_access_changed` when needed.

The old purge suite therefore currently reports **6 passing and 2 differing
cases**. It is not reported as fully passing. These changes are covered by the
native regression tests below and must be represented explicitly in the future
Go contract runner, rather than normalizing away the behavioral differences.

## Verification

[Native tests](../core-service/internal/app/purge_test.go) exercise authenticated
HTTP requests and the actual SQLite/filesystem boundary:

- renamed directories and shared-file owners;
- files-only versus group removal;
- loose files, symlink containment and retained authentication;
- committed catalog state reopened before cleanup;
- transaction rollback, retry counts and durable terminal state;
- overlapping requests, shutdown after acknowledgement and restart;
- cancellation/join of an active Telegram fixture transfer before queue removal;
- blocked reindex/ingestion while a committed purge is unfinished.
- concurrent reindex progress/status reads under the Go race detector.

The Telegram transport in these tests is a fixture; no live account is exercised.
The full Go race suite and vet pass. Windows amd64 and macOS arm64 server builds
cross-compile; these binaries were not executed on those operating systems.

`go test ./internal/app -run '^$' -bench '^BenchmarkPurgeGroup1000Files$' -benchtime=3x`
measured approximately **0.24 seconds per group purge**, **11.91 MB allocated per
operation** and **215,032 allocations** on Linux amd64, Core Ultra 7 270K Plus.
Each iteration removes 1,000 download rows and 999 files while retaining one
file owned by another group. It includes the application job, SQLite commits,
status persistence and cleanup; fixture construction is outside the timer.
This is a local storage measurement, not Telegram throughput or a comparison
against the old server.

Implementation: [purge jobs](../core-service/internal/app/purge_api.go),
[source-file outbox](../core-service/internal/app/file_cleanup.go),
[derived-cache outbox](../core-service/internal/download/derived.go),
[maintenance lifetime](../core-service/internal/app/maintenance_lifecycle.go).
