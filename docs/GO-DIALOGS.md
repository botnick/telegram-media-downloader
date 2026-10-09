---
title: "Dialog pagination"
description: "Engineering note on how the Go server pages Telegram dialogs so no chat is skipped."
parent: "Developer notes"
nav_order: 7
---

# Native dialog pagination

The Go dialog endpoint previously sent one large `messages.getDialogs` request.
A sliced response could omit later groups even when the requested limit had not
been reached. The active-folder request also omitted the presence flag for
`folder_id=0`, and the controller could reuse accounts after their monitor stopped.

The native implementation now:

- Requests at most 100 entries per RPC and continues sliced responses until a
  full/empty response or the requested total limit. Short slices still continue.
- Selects active and archived folders explicitly. The zero folder value has its
  optional-field flag set, so active browsing does not implicitly query both.
- Uses the last unpinned dialog's peer, top-message ID and matching message date
  as the next offset. Message IDs alone do not identify a channel's message.
  A first page containing only pinned dialogs is followed by an unpinned request
  with an empty offset. Repeated dialogs are emitted once.
- Rejects missing cursor data, unusable access hashes, repeated/cyclic offsets,
  unexpected responses and failed pages. Any failed account or folder makes the
  HTTP request fail; previously successful partial results are not published.
- Bounds each RPC to 30 seconds and the multi-account list to two minutes.
  Account shutdown cancels an active list, and stopped accounts cannot be queried.
- Saves complete channel access hashes in one SQLite transaction per page,
  scoped to the account and authenticated user. Minimal entities cannot overwrite
  reusable hashes. This cache operation never advances message/update cursors;
  cancelling a browser request does not latch an ingestion failure.

The HTTP projection and its authentication requirements remain the same. The UI
still requests 500 entries per folder/account. That cap is intentional for this
existing route and must not be used as proof that an unknown group is absent
from Telegram. The [native recovery workflow](GO-RECOVERY.md) now uses its own
complete enumeration and readability probe before changing IDs or account
assignments. It uses the same pager without the UI cap; exceeding 100,000 dialogs
per folder/account or the operation deadline is an error, never a partial success.

## Verification

Native tests cover 201 dialogs across three pages, pinned-only and short first
pages, overlap, peer-scoped offsets, total limits, missing/minimal hashes, cyclic
pagination, RPC/observer failures, cancellation, account-scoped persistence,
unchanged update cursors and HTTP rejection of partial/stopped results.

`go test -race -timeout 120s ./...`, `go vet ./...` and the Linux server build
pass. These use injected Telegram RPC/account fixtures; live Telegram and
browser E2E remain release requirements. The latest full frozen contract result
is 210/324 after the recovery increment, whose frozen suite passes 8/9. The
remaining recovery difference deliberately fixes the old file-cleanup bug.

## References

- [Telegram messages.getDialogs](https://core.telegram.org/method/messages.getDialogs)
  specifies folder, pinned exclusion and offset fields.
- [Telegram pagination](https://core.telegram.org/api/offsets) describes request
  limits and offset navigation.
- [Telegram minimal entities](https://core.telegram.org/api/min) explains why
  their hashes require context instead of unrestricted reuse.
- [gotd v0.115.0 dialog iterator](https://github.com/gotd/td/blob/v0.115.0/telegram/query/dialogs/iter.go)
  provides the pinned dependency's peer/date/ID pagination implementation.
