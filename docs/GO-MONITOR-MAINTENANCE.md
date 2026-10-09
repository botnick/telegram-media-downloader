---
title: "Monitor maintenance"
description: "Engineering note on dialog resync, monitor restart and group info/photo refresh in the Go server."
parent: "Developer notes"
nav_order: 10
---

# Native monitor maintenance

Go now owns dialog resync, monitor maintenance restart, group information
refresh and group photo refresh. They share the authenticated account pool
and retain the released HTTP/status/WebSocket shapes. No second server or
runtime is invoked.

## Public operations

| Operation | Behavior |
| --- | --- |
| `POST /api/maintenance/resync-dialogs` | Enumerates all active and archived dialogs for every account, then refreshes known config/catalog groups and cached avatars. Missing credentials return 503; missing accounts return 409. |
| `POST /api/maintenance/restart-monitor` | Requires `{"confirm":true}`; cancels and joins a running monitor before starting fresh accounts with current config. A stopped monitor produces the released no-op result. |
| `POST /api/groups/refresh-info` | Refreshes names and avatars for the union of configured groups and catalog group IDs. |
| `POST /api/groups/refresh-photos` | Refreshes avatars for configured groups only. |

Each path has a `/status` GET. Mutations and maintenance status are admin-only;
the existing group refresh status routes allow authenticated sessions. Per-kind
single-flight guards return 409 for a duplicate active request. Progress and
terminal events retain their flat fields. Attempts/successes/failures accumulate
across reruns; the last successful result remains available if a later run fails.
Workers register before launch, cancel and join during shutdown. These small job
snapshots are in memory; interrupted cache refreshes can be rerun.

The released group refresh buttons still expose cached data when credentials or
accounts are absent: information refresh reports zero updates and photo refresh
reports existing cache URLs. Other errors are reported. With accounts configured,
both buttons perform Telegram reads. A failed Telegram request never switches to
another account or reports a successful cache-only refresh.

## Account and data boundaries

Enumeration holds a lease on one account run. A jobs-only run keeps live
monitoring disabled and closes after leases and accepted manual work drain.
Starting the monitor promotes the same pool. Each folder must finish successfully
before any metadata batch is applied; partial RPC results cannot masquerade as a
complete index. The complete index has a ten-minute context tied to its account
run; individual Telegram page/photo/username calls have 30-second deadlines.

Configured account pins select the photo's account-bound peer and access hash.
An unpinned group uses the first matching account in stable order. Ambiguous
historical unsigned IDs are rejected. A configured username lookup must still
resolve to the same group ID. Suspended/foreign-owned groups and known blocked
chat states are skipped. Legacy access flags apply when there is no authoritative
chat-access row. Complete enumeration does not auto-add unrelated dialogs.

Information refresh fills empty/`Unknown`/ID-based names; config names beginning
with `Group ` are also treated as placeholders. Explicit user names and existing
catalog labels survive. The `updated` counter means resolved named targets,
matching the released API; it is not a count of changed text values. Each batch
rereads config under its lock, preserving concurrent name/filter edits and
skipping removed groups, changed ownership, suspension or a conflicting pin.

Names commit with config in one SQLite transaction per batch. Batches contain
at most 64 groups and 8 MiB of encoded photo payload; the next pending photo can
temporarily add up to 2 MiB before a previous batch flushes. Config is decoded and
saved once per batch instead of once per group. The full target/index/result
lists and decoded JPEG memory are additional to this payload bound.

Avatars use Telegram's small `inputPeerPhotoFileLocation`, exact 64-bit photo ID
and matching data center through the existing Go media transport. Missing photo
metadata is an error; an explicit no-photo result removes stale cached bytes.
Encoded photos are capped at 2 MiB, dimensions at 4096 per side, and must fully
decode as JPEG. Publication writes/syncs a random temporary file and renames it
under confined directory handles. Outside symlinks are rejected. A purge epoch
plus media locks prevents late results recreating a purged cache/config group.

SQLite and avatar files are not one transaction. A failed photo write can leave
that batch's names committed and earlier avatars updated; the job reports an
error and is safe to rerun. Earlier completed batches also remain committed.

Maintenance restart preserves auto-start intent and durable accepted queue
rows. It joins the old byte transfer before replacement accounts start. When
live monitoring is off, the no-op does not interrupt a jobs-only download.
Restarting an active monitor is a hard account restart: an in-progress manual
history enumeration is cancelled by the existing account-run lifecycle; it is
not transparently continued by this endpoint. Already accepted media work
remains durable. Application shutdown/reopen still uses history checkpoints.

## Verification

Native tests cover fresh name/JPEG transport, chosen-name preservation, DB-only
groups, remote photo removal, pinned accounts, concurrent edits, legacy access
and registry precedence, complete-index failure, duplicate requests, shutdown
join, SQL rollback, late results after purge, symlink confinement, oversized
photos, and actual queued byte transfer across monitor restart. The photo adapter
tests channel/group/user peers, exact IDs above 2^53, data centers, absent versus
unknown metadata and cancellation. Telegram transport is injected in these tests.

- Full Go race suite passes; final legacy-access changes also pass the focused
  resync/restart/photo race suite. `go vet ./...` and Linux build pass.
- Windows amd64 and macOS arm64 CGO-disabled cross-builds pass. The binaries have
  not been run on those operating systems.
- The unchanged full frozen HTTP/WebSocket suite passes **217/324** tests in
  **23/36** files; **107 cases in 13 files still fail**. Monitor is **8/8**,
  chats **9/9**, groups **13/13**. Snapshots were not rewritten to obtain this.
- No live Telegram, browser or production-data migration E2E claim follows from
  these fixtures. See [remaining release work](GO-MIGRATION-STATUS.md).

`BenchmarkResync1000Groups` uses 1,000 configured/catalog groups, injected dialog
metadata and no-photo responses. Database creation, account setup and resetting
placeholder names are outside the measured region. On Linux amd64, Core Ultra 7
270K Plus, three runs of three iterations measured:

| Run | ns/op | B/op | allocs/op |
| --- | ---: | ---: | ---: |
| 1 | 86,579,733 | 23,820,557 | 334,945 |
| 2 | 88,867,650 | 23,652,538 | 334,641 |
| 3 | 96,212,803 | 23,790,050 | 334,901 |

An exploratory single iteration of the initial per-group config/SQL version
measured 3,268,238,672 ns/op, 981,881,304 B/op and 16,194,707 allocs/op. This points
to the benefit of batching; it is not a statistical comparison against Node,
an RSS measurement, or a Telegram network throughput result. Reproduce from
`core-service`:

```sh
go test ./internal/app -run '^$' -bench '^BenchmarkResync1000Groups$' -benchtime=3x -count=3 -benchmem
```

## Protocol references

- [Telegram peer photo file location](https://core.telegram.org/constructor/inputPeerPhotoFileLocation)
- [Chat photo ID and data center](https://core.telegram.org/constructor/chatPhoto)
- [User profile photo](https://core.telegram.org/constructor/userProfilePhoto)
- [Dialog pagination](GO-DIALOGS.md) and [account-bound recovery](GO-RECOVERY.md)
- [Directory-confined Go operations](https://pkg.go.dev/os#Root)
