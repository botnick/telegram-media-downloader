# Native backup migration

The Go application now implements destination management and local, S3 and SFTP
mirror/snapshot transports. **Backup migration is incomplete.** FTP/FTPS,
Google Drive, Dropbox and TGDB payload encryption/restore still need native
implementations. Existing configuration forms and stored credentials remain
readable. Unsupported transports report unavailable; their queued uploads and
encrypted payload jobs remain pending with an explicit destination error.
Those blocked jobs do not consume retry attempts, send plaintext, or invoke
another runtime. Supported transports use the durable queue's actual retries.
The frozen backup contracts do not exercise successful remote or encrypted
uploads, so their passing result must not be treated as that coverage.

## Implemented behavior

All `/api/backup/*` routes require an administrator session. They cover provider
metadata, destination create/update/delete, redacted config, connection tests,
status, jobs/recent activity, retry, pause/resume, manual runs, and encryption
key management. `GET /api/backup/cleanup?limit=50&offset=0` lists transfer
cleanup records (at most 200 per page), including their state, error and next
retry time. It never returns credentials or multipart upload IDs. Backup
WebSocket events and logs are flat and administrator-only.
Provider metadata retains the released form fields and adds an optional SSH
host fingerprint for SFTP. The presence of a form does not establish that all
six transports are ready.

Provider credentials retain the existing TGDC v1 layout:
`TGDC | version=1 | IV[12] | AES-256-GCM ciphertext | tag[16]`.
The key is PBKDF2-HMAC-SHA256 with 200,000 iterations, decoded 32-byte share
secret and `tgdl-cred-v1` zero-padded to 16 bytes. Config reads expose only
schema-defined non-secret fields; empty secret edits preserve the old value.
A share-secret rotation invalidates old blobs and requires credential re-entry.

SQLite triggers enqueue live mirror work in the same transaction that publishes
a download row, including edits of existing rows. Rollback leaves no orphan job.
A persisted job revision prevents an old transfer from marking a newer edit
complete or failed. Workers wake after ingestion and poll persisted work every
second, so a missed notification or restart cannot lose an accepted file.
Manual catch-up inserts missing jobs in one set-based SQL statement, without
materializing the catalog in Go. Large catalogs can hold the SQLite writer for
that statement; batching with durable catch-up cursors is future performance
work. Existing finished/failed jobs are not duplicated by repeated catch-up.

There is one transfer worker per enabled destination, with different destinations
running concurrently. This serializes shared-path aliases and retention. The
legacy `BACKUP_WORKERS_PER_DEST` parallelism knob is not implemented. Pause is
persisted and cancels/joins the active transfer before returning. Controlled
shutdown returns that job to pending without spending an attempt; crash recovery
resets legacy/native `uploading` rows to pending while retaining their attempt
history. Transfer failures wake automatically for exponential retry; missing
sources fail explicitly. Configuration changes stop and join the old worker
before opening a new provider.

Each destination worker shares one token-bucket upload limit across files and
concurrent multipart requests. The burst is at most 32 KiB or one tenth of the
configured bytes/second, with a minimum of one byte. Only upload-body reads are
paced; source hashing, destination verification and request signing are not.
Retries consume bandwidth again without double-counting completed progress.
Cancellation interrupts pacing promptly. Network write deadlines apply while
writing; HTTP response headers and blocked body reads have separate deadlines.
SFTP tracks outstanding protocol requests and clears its read deadline when
none remain. Waiting for the next file or for the rate limiter does not count
as a silent remote; genuinely unanswered requests still time out.

Local uploads operate through `os.Root`, stream in 64 KiB buffers to exclusively
created private temporary files, sync, close and rename only complete files.
Equal size is only a candidate: both source and destination are SHA-256 hashed
before skipping, including zero-byte files. Path escapes and outside-root
symlinks are rejected. Connection probes use unique names and cannot overwrite
an existing probe file. File sync/rename and SQLite WAL provide process-restart
recovery; this is not a guarantee against every filesystem/power-loss scenario.

## Native S3 transport

The official AWS Go v2 S3 client signs requests with SigV4. Credentials are
explicitly supplied from the encrypted destination config; no environment,
instance metadata or default credential chain is used. The optional
`sessionToken` config value is secret and empty edits preserve it, although the
current form only exposes access key ID and secret. Use HTTPS for remote
endpoints; explicit HTTP supports local gateways. Redirects are refused rather
than forwarding signed requests to another host. The configured region, bucket,
prefix, endpoint and path-style addressing control all requests.

Files up to 8 MiB use PutObject. Larger files use at most four concurrent
UploadPart requests; part sizes grow to keep the total at or below 10,000.
ReaderAt/SectionReader and 64 KiB inspection buffers avoid retaining full parts
in memory. One inspection pass computes the full SHA-256 identity and per-part
Content-MD5 values. MD5 is a protocol integrity check, not a dedup identity or
authentication algorithm. A compliant server rejects changed bytes; completion
is checked against the returned ETag and object length. This targets general
purpose buckets and compatible gateways, not S3 directory buckets.

An existing equal-sized object is read and SHA-256 checked with an ETag condition
before skipping. Object metadata or a multipart ETag alone is never treated as
proof of identical content. Listing validates prefix ownership and continuation
tokens. Delete failures propagate. SDK requests allow at most three attempts;
progress callbacks are serialized and monotonic across retries. Progress counts
unique source bytes read by the final HTTP transport, not remotely acknowledged
durability. Signing/checksum passes do not advance upload progress.

Failed/canceled multipart uploads join all part requests, then attempt Abort
using a fresh 30-second context. Abort errors are reported together with the
transfer error. Before sending parts, the native manager durably records the
returned upload ID and original destination. Failed aborts and process death
are recovered by the cleanup workers described below. After an accepted Abort,
ListParts must confirm an empty or absent upload before the journal is removed;
late parts or verification errors retain ownership for another attempt. The
destination credentials therefore also need permission to list multipart parts.
There is still a remote
transaction boundary: CreateMultipartUpload may succeed before its upload ID
is received or committed locally. No part bytes have been sent at that point,
but an empty multipart reservation can remain. An abort lifecycle policy can
collect that metadata; the application does not guess ownership of unknown
upload IDs. No real AWS/R2/B2/MinIO account has been exercised in this migration;
current evidence is a wire-protocol fixture.

## Native SFTP transport

SFTP inspects the source before connecting, uses Go SSH directly, reuses one authenticated connection per destination,
and sends at most sixteen concurrent 32 KiB file requests. It does not invoke
an SSH executable, agent, or global SSH configuration. Password or private-key
authentication is explicit; when both are supplied, the key takes precedence.
Encrypted private keys accept the configured passphrase.

The optional **SSH host key fingerprint** field accepts `SHA256:...`. Verify it
through a trusted channel before entering it to authenticate the first
connection. If blank, the first observed key is persisted in
`native_backup_host_keys` by host/port (trust on first use). This does **not**
authenticate an unknown first server. Subsequent changed keys are rejected
before sending a password or authenticating a client key, including after
restart. Entering a separately verified new fingerprint authorizes rotation of
that host's stored key. Connection-test results show the observed fingerprint.

Uploads verify existing bytes with SHA-256, create exclusive random temporary
files, set private permissions before writing, check the source hash again
during transfer, and verify remote length. Servers advertising fsync are synced.
Replacing an existing file requires `posix-rename@openssh.com`; a server without
it can create a new file using standard SFTP rename but receives an explicit
error on replacement. The old file is never deleted to make space for a rename.

Cancellation closes the socket and joins the transfer. Temporary cleanup uses
a new connection to the same trusted endpoint with a separate 30-second limit;
failure is reported. Later operations reconnect with the same authentication
and host-key rules. The native manager records each temporary name before
creating it, so process death or a lost OpenFile reply can be cleaned on restart.
SSH diagnostic output is drained without retention or logging so it cannot
exhaust the shared channel window and block file responses.
Path components are checked with Lstat and symlinks rejected. SFTP v3 does not
provide directory-handle-relative opens, so this cannot prevent an untrusted
server/account from swapping paths between checks; use a trusted remote account
and, where appropriate, a server-side chroot. No real NAS deployment was tested.

## Durable remote transfer cleanup

`native_backup_transfers` records ownership before S3 part data or SFTP temporary
files are written. Failure to persist ownership stops the transfer. Active and
interrupted cleanup records become pending on startup. Four workers claim rows
atomically and retry failures with exponential backoff from five seconds up to
thirty minutes, with a 30-second limit per cleanup operation. Shutdown joins
workers and connection probes. Completed uploads and successful cleanup remove
their journal records; database failures remain recoverable.

Each record retains the original TGDC-encrypted configuration independently of
destination edits or deletion. Those encrypted credentials remain in SQLite
until cleanup succeeds, allowing removal from the original endpoint rather
than a replacement. Rotating the share secret can make these records
undecryptable; the error remains visible and the record is retained. SFTP uses
the same host-key checks as uploads. Cleanup validates the configured root or
prefix and removes only the recorded random temporary name or exact multipart
ID. It does not sweep unowned files, abort unrelated uploads or delete completed
S3 objects. This journal covers native S3/SFTP transfers; local mirror temporary
files and interrupted snapshot construction still need startup staging cleanup.

## Snapshots and restart recovery

Manual/snapshot runs persist their job before archive construction or HTTP
acknowledgement. A consistent `VACUUM INTO` database copy is archived by native
`archive/tar` and `compress/gzip`, along with `config.json` when present,
`sessions/**`, and **`secret.key`**, which is needed to reopen native encrypted
sessions. Session symlinks/non-regular files are rejected. The application config
mutex protects account/config replacement while assembling the archive; this is
not yet a live Telegram session-rotation/restore E2E test.

Archives use the existing `snapshot-YYYYMMDD-HHMMSS.tar.gz` name, with distinct
reserved names across simultaneous jobs. A crash during construction rebuilds
from the persisted reservation. Staging files and archive members use private
permissions. An unencrypted backup contains the full restore credentials and
must be stored at the administrator's chosen trusted destination.

Five-field cron supports wildcards, steps, comma lists and ranges. Invalid
expressions are rejected. Day-of-month/weekday use cron OR semantics when both
are restricted; scheduling uses the server's local timezone. The last accepted
minute and scheduled job commit together, preventing duplicate runs after
restart. Missed minutes while the application is stopped are not replayed.

After confirmed snapshot upload, retention lists only recognized files directly
under `snapshots/`, keeps the newest configured count, and never deletes unrelated
objects. Completed upload and cleanup intent commit in one transaction. A
persisted retention outbox retries remote pruning/local staging removal after
restart or failure. Manual archives have staging cleanup but no remote retention.
Totals count completed transfers for mirrors; snapshot totals reflect retained
remote snapshots.

Encryption controls derive keys with the existing PBKDF2 parameters, retain
keys in memory only, and persist a keyed verifier for future unlock attempts.
An incorrect passphrase is rejected once a verifier exists. An imported legacy
destination has no verifier: its first accepted passphrase cannot be independently
confirmed without decrypting an old payload. Disabling encryption preserves its
salt/verifier so older objects remain recoverable; changing that passphrase is
not silently treated as key rotation. **Payload streaming and a restore command
remain required release work.** Go's ordinary AEAD API is not a streaming file
API; no custom GCM primitive or whole-library RAM buffer was introduced.

## Validation and limits

Native tests cover an independent Python AESGCM/PBKDF2 TGDC vector, tampering,
wrong secrets, redaction/secret preservation, unlock after restart, automatic
mirror enqueue, transaction rollback, equal-size corruption, cancellation,
symlink escapes, transient retry timers, in-flight message edits, pause/restart,
shutdown/join, archive members and SQLite integrity after extraction, retention
ownership, persisted cleanup, and duplicate cron minutes after restart.
An application test exercises authenticated HTTP create, raw Telegram message
metadata through fixture bytes into an actual mirrored file, guest rejection,
and restart persistence. It does not contact Telegram or a real cloud provider.

Additional native tests run actual HTTP and SSH/SFTP servers over loopback.
The S3 fixture independently verifies SigV4, checks request bodies and transport
checksums, and exercises multipart parallelism/retries/abort, source mutation,
equal-size corruption, empty files, pagination, redirects, error redaction and
automatic mirror recovery after restart. SSH tests exercise real password and
encrypted-key authentication, host-key persistence/rotation before credentials,
connection reuse, cancellation/reconnect/cleanup, symlink rejection, missing
atomic-rename support and automatic queued mirror recovery. These are protocol
integration tests; they are not live provider or browser E2E results.

Process-death regressions kill a child test executable after the fixture stores
real S3 part bytes or an SFTP partial file, bypassing all graceful cleanup. A
new manager recovers the queued file and removes the old transfer. Additional
tests cover destination edits/deletion, failed cleanup retries, unrelated data
preservation, rejected journal writes, and invalid provider configuration being
corrected without crashing its worker. Accepted S3 aborts with remaining parts
or denied verification retain their cleanup journal; retries remove it only
after confirmation. A 4 MiB SSH diagnostic stream cannot block a connection
probe, and manager shutdown cancels and joins an in-flight probe.
Low-rate tests use shortened network
deadlines to distinguish local pacing from a stalled remote, including shared
limits across files/parts, fragmented SFTP replies and stalled HTTP bodies.
The full Go race suite and vet pass; Linux, Windows amd64 and macOS arm64
binaries build, but the foreign binaries have not been run on those platforms.

The old Node contract runner is still development tooling; its removal remains
part of the overall migration. No frozen expectations were edited. Backup
passes 16/17: the unchanged provider-metadata snapshot lacks the new optional
SFTP host-key field. The full run passes 239/324, leaving 85 failed cases in
12 files. Maintenance now passes 8/8 with the host-key table present. At the
previous checkpoint, its non-growth assertion failed because a quiescent native
database grew from 129 to 130 pages during VACUUM. That earlier evidence remains
valid: different schema packing does not make non-growth a general guarantee.
The application keeps actual measurements and database errors visible. Both
the added field and the earlier VACUUM finding are documented rather than
hidden by changing frozen expectations. See
[the current migration totals and release gates](GO-MIGRATION-STATUS.md).

Further work includes the three remaining remote transports, encrypted upload
and restore compatibility, bounded concurrency tuning, cleanup of interrupted
local/snapshot staging files, the empty S3 reservation boundary described above,
rebasing completed jobs after changing a destination's root/bucket, and real
browser/Telegram/provider/migration E2E.

## Local verification benchmark

`BenchmarkLocalMirrorVerify1MiB`, Linux amd64, Go 1.26.8, Intel Core Ultra 7
270K Plus, three runs of 1,000 iterations with other task checks stopped:
1,056,764 / 1,120,326 / 1,194,595 ns per operation, approximately 131,909–131,924
bytes and 15 allocations per operation. Each iteration hashes the 1 MiB source
and existing destination before declaring them identical; setup/publication is
excluded. The reported 878–992 MB/s is source-file equivalent verification
throughput with a warm local fixture, not upload speed, network/NAS performance,
process RSS, or a comparison against Node. Working buffers do not grow with
file size.

`BenchmarkS3SourceInspection` on the same CPU/toolchain, three runs of ten
iterations per size: inspecting 1 MiB takes 2.23–2.34 ms, about 65,961–65,963
allocated bytes and 12 allocations; 64 MiB takes 109–144 ms, about 67,923–67,924
bytes and 64 allocations. It computes SHA-256 plus the protocol's per-part MD5
values over preallocated warm memory; setup/input allocation is excluded.
This verifies bounded inspection buffers, not upload throughput, disk speed,
peak process RSS, or a comparison against the previous implementation.
The comparable unstripped Linux builds grew from 33,838,568 to 38,669,142 bytes
after adding the remote transports and dependencies at checkpoint `84e3637`
(about 4.61 MiB). With pacing, the cleanup journal and ListParts verification,
the current build is 38,803,200 bytes, another 134,058 bytes. These are
binary sizes, not resident memory. The implementation uses the maintained AWS
S3 client and Go SSH/SFTP libraries; no deprecated S3 transfer-manager dependency
is retained.

## References

- [Go traversal-resistant file APIs](https://go.dev/blog/osroot): directory handles
  prevent ordinary path/symlink traversal during file operations.
- [SQLite VACUUM INTO](https://www.sqlite.org/lang_vacuum.html): produces a consistent
  database copy while retaining the existing database.
- [SQLite CREATE TRIGGER](https://www.sqlite.org/lang_createtrigger.html): download
  publication and mirror enqueue are implemented in database transactions.
- [Go cipher AEAD](https://pkg.go.dev/crypto/cipher#AEAD): used for the bounded TGDC
  configuration blobs, not a whole-file streaming substitute.
- [AWS PutObject integrity](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html)
  and [UploadPart](https://docs.aws.amazon.com/AmazonS3/latest/API/API_UploadPart.html):
  request checksums and multipart upload semantics.
- [AWS AbortMultipartUpload](https://docs.aws.amazon.com/AmazonS3/latest/API/API_AbortMultipartUpload.html):
  late parts can require repeated aborts; ListParts confirms removal.
- [Cloudflare S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/):
  Content-MD5 support for PutObject/UploadPart informed the protocol choice;
  this reference is not a successful R2 deployment test.
- [Go SSH host-key callback](https://pkg.go.dev/golang.org/x/crypto/ssh#ClientConfig)
  and [SHA256 fingerprints](https://pkg.go.dev/golang.org/x/crypto/ssh#FingerprintSHA256).
- [SFTP PosixRename](https://pkg.go.dev/github.com/pkg/sftp#Client.PosixRename),
  concurrent file requests and advertised extensions.
- [Go rate limiter](https://pkg.go.dev/golang.org/x/time/rate#Limiter.WaitN):
  a shared, cancellable token bucket controls actual upload reads.
- [HTTP Transport](https://pkg.go.dev/net/http#Transport): response-header
  timeout starts after the request body has been written.
- [SSH OpenChannel](https://pkg.go.dev/golang.org/x/crypto/ssh#Client.OpenChannel)
  and [SFTP NewClientPipe](https://pkg.go.dev/github.com/pkg/sftp#NewClientPipe):
  request framing is observed for deadlines while pkg/sftp owns the protocol.
- Released format definitions: `src/core/backup/credentials.js`, `encryption.js`,
  and the unchanged frozen backup HTTP/WebSocket contracts.
