# Native Stories and proxy probe

The Go server now implements `/api/stories/user`, `/api/stories/all`,
`/api/stories/download` and `/api/proxy/test`. All four are admin POST routes.
They use the existing authenticated accounts, durable queue, media transport
and library. They do not invoke a second downloader or runtime.

## Story reads and downloads

User listing resolves the selected peer and calls `stories.getPeerStories`.
All-stories listing follows `stories.getAllStories` state tokens to completion
for the selected default account, merges overlapping peer/story entries, and
keeps users and channels with the same raw ID distinct internally. A failed
page, missing/repeated continuation token or unexpected not-modified response
fails the request rather than returning a partial successful list. Bounds are
1,000 pages, 10,000 peers and 100,000 collected stories. Each RPC has a 30-second
deadline inside a two-minute HTTP operation tied to application shutdown.

The public JSON retains the released peer, story, media, group and count shapes.
Access hashes and file references stay private. Story IDs in list responses
and download requests remain the original positive signed 32-bit Telegram IDs.
Download accepts at most 100 IDs, rejects fractional/out-of-range values and
deduplicates repeated IDs; `requested` counts the original input entries.

Selected downloads fetch full current objects through `stories.getStoriesByID`.
Deleted, skipped or media-less objects do not enter the queue. Unexpected IDs,
duplicates, incomplete objects and protected stories that disallow saving fail
the request. Fresh document/photo identities and file references feed the same
deduplication path used by messages. Existing verified bytes are reused; missing
bytes can be repaired through another explicit request.

An explicit story download bypasses subscription/media/topic/user selections,
while suspension, account pins and library ownership remain enforced. A known
blocked target is rejected before connection. Pins also apply when username
resolution reveals a configured numeric group. An RPC/access failure never
silently selects another account. Unpinned requests use the stable first
account; all-stories reads that account's visible active set, not a union of
every account or the user's hidden/archive set.

The jobs-only account pool does not enable live monitoring. A lease protects
the account while the HTTP operation runs, and the shared drainer keeps accepted
work alive until it finishes. The entire requested batch and any disabled group
registration commit in one SQLite transaction before acknowledgement. A later
insert failure rolls back earlier inserts in that batch. `queued` means accepted
durable work, not completed file transfers. Purge epochs and media/config locks
reject late results after deletion. Shutdown joins requests; accepted work is
recovered after reopening the application.

Stories refresh stale references using the story RPC, never a message RPC with
the same number. Complete user access hashes now persist by account and signed-in
user, alongside the existing channel cache. Minimal hashes are excluded; numeric
user resolution can use this cache after reopening. Removing an account removes
its cached user hashes. Reassignment still forces a fresh read through the new
account rather than borrowing the previous account's credentials.

## Identifier and data compatibility

Stories and ordinary messages have independent Telegram ID spaces. The former
runtime used `(group_id, story_id)` directly in a catalog whose unique key is
`(group_id, message_id)`, so a story could collide with an ordinary message.
Native story work/catalog/generation keys use `4294967296 + story_id`. This is
outside the positive int32 message range and remains exactly representable by
JavaScript numbers. The encoded MTProto message-shaped payload retains the real
story ID; the synthetic catalog key is never sent to Telegram.

The queue origin and catalog media type are `stories`. Queue/complete-event keys
and catalog `message_id` expose the namespaced key; list/request IDs stay native.
Consumers needing the story ID can subtract 4294967296 from that catalog key for
a `stories` row. Group history bounds exclude stories, including old rows, so
catch-up never mistakes a story for the newest message. Physical media identity
is unchanged, allowing a story and message to retain separate catalog references
to one verified file.

On database open, positively identified old `file_type='stories'` rows with IDs
in 1..2147483647 move to this key range. Row IDs, file paths, hashes, labels and
other metadata remain intact. The update is idempotent and rejects a key
collision without overwriting either row. Ambiguous old rows labelled as another
media type cannot be identified by this migration. It cannot recover data already
lost to an old collision; broader legacy queue-history import remains release
work.

Explicit story-download reads serialize before queue acceptance. Because stories
do not carry message PTS, a durable per-work sequence orders accepted observations
inside the enqueue transaction. It is independent of wall-clock adjustments and
does not advance Telegram update cursors. A concurrent worker refresh still uses
the existing generation check, so it cannot overwrite a newer accepted edit.

## Proxy reachability

The probe validates host/port and applies a five-second total DNS/connect deadline.
It blocks local names, private/loopback/link-local/multicast/unspecified targets,
IPv4-mapped private IPv6, CGNAT and IPv4 zero/reserved high ranges. It validates
every DNS answer, then connects to one literal validated IP. The dial cannot
perform a second hostname lookup that changes the target. Success returns
`{ok:true,ms}` and closes the socket; resolver/socket failures return
`{ok:false,error}`. A blocked target returns 400.

This checks TCP reachability only. SOCKS/MTProxy negotiation, credentials and
actually routing all Telegram/login/media connections through configured proxies
remain separate implementation and release work. A successful probe does not
prove those operations.

## WebSocket handshake correction

The complete contract run exposed lost first events in groups/history. The
upgrader wrote HTTP 101 before the application subscribed the socket to the hub;
a browser could perform its first mutation in that interval. Subscription now
precedes the handshake response and is removed if upgrading fails. A native test
deliberately holds the upgrade call after writing 101, broadcasts in that interval
and checks delivery. The original ordering fails that test; the fix passes ten
race-enabled repetitions without changing contract timing or snapshots.

## Validation and references

Native HTTP/SQLite/filesystem tests cover shared story/message bytes without ID
collision, atomic batch rollback, missing-file repair, shutdown/reopen, stale
story-specific refresh, pins without alternate-account retry, late lookup after
purge, pagination and incomplete-page failure, input bounds and clock-independent
edit ordering. Protocol tests check account peers, exact 64-bit media IDs,
private-field exclusion, missing/protected/minimal items and continuation flags.
Migration and reopened account-cache tests cover data preservation and isolation.
Probe tests check private DNS results, literal-IP dialing, socket closure and
cancellation. These are injected Telegram/network fixtures, not live Telegram or
browser E2E evidence.

The full Go race suite passes. The final HTTP error/input adjustments also pass
focused Stories/history/probe/WebSocket race tests; vet and Linux build pass.
Windows amd64 and macOS arm64 builds pass with CGO disabled; those binaries were
not run natively. The final full HTTP/WebSocket contract run passes 223/324 tests
in 24/36 files, including all seven Telegram-action cases. Its other 101 failures
remain release work. No frozen snapshots or contract assertions were changed.

`BenchmarkStoriesBatch100` was measured in isolation on Linux amd64, Core Ultra 7
270K Plus, for three runs of ten iterations:

| Run | ns/op | B/op | allocs/op |
| --- | ---: | ---: | ---: |
| 1 | 18,071,611 | 616,037 | 11,280 |
| 2 | 16,829,234 | 620,706 | 11,443 |
| 3 | 16,884,264 | 616,275 | 11,383 |

Each iteration submits an authenticated HTTP batch with 100 injected fresh story
objects and commits them into a paused SQLite queue. Account/database setup and
clearing the queue between iterations are excluded. The measurement includes
response decoding in the fixture, but no Telegram network or file-byte transfer.
It is not a comparison against Node or an RSS measurement. Reproduce from
`core-service`:

```sh
go test ./internal/app -run '^$' -bench '^BenchmarkStoriesBatch100$' -benchtime=10x -count=3 -benchmem
```

See [migration status](GO-MIGRATION-STATUS.md) for current full-suite results and
remaining release requirements. Protocol and implementation references:

- [Get a peer's active stories](https://core.telegram.org/method/stories.getPeerStories)
- [Read full stories by ID](https://core.telegram.org/method/stories.getStoriesByID)
- [Paginated active story list](https://core.telegram.org/method/stories.getAllStories)
- [Story fields and save restrictions](https://core.telegram.org/constructor/storyItem)
- [Pinned gotd protocol implementation](https://github.com/gotd/td/tree/v0.115.0/tg)
- [Go IP address classification](https://pkg.go.dev/net/netip#Addr)
- [Go context-aware network dialing](https://pkg.go.dev/net#Dialer.DialContext)
