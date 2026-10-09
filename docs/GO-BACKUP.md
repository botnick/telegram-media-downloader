# Native backup migration

The Go application now implements destination management and local, S3, SFTP and
FTP/FTPS mirror/snapshot transports. **Backup migration is incomplete.**
Google Drive and Dropbox still need native implementations. TGDB v1 encrypted
uploads, offline decryption and snapshot restore now run in Go. Existing configuration forms and stored credentials remain
readable. Unsupported transports report unavailable; their queued uploads and
locked encrypted jobs remain pending with an explicit destination error.
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
host fingerprint for SFTP, plus passive-mode and private-CA settings for FTP.
The presence of a form does not establish that all
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

## Native FTP/FTPS transport

The provider uses Go TCP/TLS directly, with no additional FTP dependency or
runtime. It reuses a healthy control connection and requires RFC 3659 MLST/MLSD
support. Directory facts are parsed strictly; malformed or duplicate entries
fail the operation. A directory is limited to 100,000 entries, 64 MiB of listing
data and 8 KiB per line; a recursive listing also stops at 100,000 entries.
Reported symbolic links cannot become upload targets or path components.
A 550 response remains an error, since it cannot distinguish a missing object
from denied access. Absence is established only by a successful parent listing.

The `secure` setting follows the existing form labels:

| Value | Mode | Default port |
| --- | --- | --- |
| `false` | Plain FTP | 21 |
| `control` | Explicit FTPS, AUTH TLS before credentials | 21 |
| `true` | Implicit FTPS, TLS before greeting | 990 |

Boolean `true`/`false` settings are also accepted. This corrects an old mismatch:
the released basic-ftp call treated `true` as explicit TLS despite the form's
implicit label. A saved `true` destination previously using explicit TLS must
select `control`; the provider never infers TLS mode from the port or retries
with weaker encryption. TLS requires version 1.2 or later, validates the host
and certificate, and protects both control and data connections using PROT P.
An optional PEM `tlsCA` replaces the system trust roots for this destination;
hostname verification remains enabled. Plain FTP does not encrypt credentials
or files unless payload encryption is separately enabled.

`passiveMode=auto` chooses PASV for IPv4 and EPSV for IPv6. The explicit `pasv`
and `epsv` values select one command; a rejected command is an error, not a
trigger to try another transport. Data connections always use the actual
control peer IP, ignoring the IP advertised by PASV. Control commands have a
whole-command deadline, including slow replies. Data reads/writes have network
deadlines; local rate-limiter waits do not consume them. Cancellation closes
the sockets, and provider shutdown joins active work and cleanup.

Uploads hash the source before connecting. Equal-size destinations are read
back and SHA-256 compared before a skip. Because STOR cannot exclusively create
a file, a random directory is reserved with MKD before writing its fixed
`payload` member. Durable ownership is recorded before MKD. Streaming hashing
detects source mutation, and the staged file is read back and checked before
RNFR/RNTO publishes it. The provider never deletes the old target to make rename
succeed; the server must support replacement by rename on the same filesystem.
Normal completion removes the empty staging directory and confirms absence.
Failures and restart cleanup use the original endpoint and remove only the
owned directory's expected regular payload. Unexpected members retain an error
and journal record rather than being recursively deleted.

FTP cannot prove server-side atomic rename, disk synchronization, or path
containment against a hostile server or concurrent path swaps. Some servers
report a symbolic link's target as a regular file in MLSD; only reported links
can be rejected. Use a trusted server/account and an appropriate server-side
chroot. If an MKD reply is lost, the remote server might create the empty
reservation after cleanup has observed absence. No payload is sent before that
reply, but this narrow empty-directory cleanup boundary remains open. Real
NAS deployment and every server's TLS-session-reuse policy remain unverified.

## Durable remote transfer cleanup

`native_backup_transfers` records ownership before S3 part data, SFTP temporary
files, or FTP staging reservations are written. Failure to persist ownership stops the transfer. Active and
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
S3 objects. This journal covers native S3/SFTP/FTP transfers; local mirror temporary
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
not silently treated as key rotation.

## TGDB v1 encrypted uploads and offline recovery

The released payload format is preserved:
`TGDB | version=1 | nonce[12] | AES-256-GCM ciphertext | tag[16]`, without AAD.
The key uses the exact UTF-8 passphrase and the destination salt with
PBKDF2-HMAC-SHA256, 200,000 iterations. Each encryption generates a new random
96-bit nonce. This format limits one plaintext file to **64 GiB minus 32 bytes**;
larger inputs are rejected. This is the GCM limit, not a memory limit.

The project owns a narrow streaming GCM adapter using Go AES/CTR and the pinned
`ericlagergren/polyval` package for polynomial multiplication. GHASH conversion
follows RFC 8452 Appendix A; counter, padding and length/tag handling follow
NIST SP 800-38D. This is project-owned cryptographic composition, not Go's
high-level AEAD implementation. Neither this adapter nor the dependency has an
independent security audit. Differential tests, known vectors and fuzzing are
correctness evidence, not an audit or a proof of side-channel resistance.

A reusable 64 KiB buffer encrypts to a private ciphertext staging file before
provider upload. This gives checksum/seek/retry code stable bytes and prevents
reusing a nonce against a source that changes on a second read. It needs free
local disk for one ciphertext copy per active destination; snapshots also need
their archive/database staging space. Remote filenames remain unchanged. Upload
progress and byte totals include the 33-byte TGDB overhead. Fresh nonces mean
identical plaintext is not skipped by comparing ciphertext from an earlier run.

`native_backup_staging` records ownership before creating ciphertext files.
Normal completion/error removes them. Startup removes only recorded names in
batches of 256, preserving unrelated files; failed cleanup retains ownership.
There is no general directory sweep. Local mirror and snapshot-construction
staging have separate outstanding cleanup work. Unlock keys remain in memory;
after restart an encrypted destination waits without spending attempts until an
administrator unlocks it. It never uploads plaintext to bypass a missing key.

**Save recovery parameters before deleting a destination or losing its database.**
TGDB v1 contains no salt. The administrator endpoint
`GET /api/backup/destinations/{id}/recovery` returns a JSON object containing
`recovery` with format, version, KDF, iterations and `saltHex`. It contains no
passphrase or derived key. It remains available after disabling encryption.
Save that response separately from the backup and retain the exact passphrase.
Existing databases retain the original salt in `backup_destinations.encryption_salt`.

The server executable also runs offline commands; no server configuration or
other runtime is needed. Passphrase files are read as exact bytes: a trailing
newline is part of the password. Use a private file prepared without adding an
unintended newline. The output parent must already exist; the output itself
must not exist.

```sh
# Decrypt an individual mirrored file or a snapshot archive.
tgdl-server backup-decrypt --input saved-backup --output new-file \
  --passphrase-file private-passphrase --recovery-info saved-recovery.json

# Authenticate, validate and extract a snapshot into a new inactive directory.
tgdl-server backup-restore --input saved-snapshot --output restored-data \
  --passphrase-file private-passphrase --recovery-info saved-recovery.json

# An unencrypted archive requires an explicit flag.
tgdl-server backup-restore --input snapshot.tar.gz --output restored-data --plaintext
```

`--salt-hex` may replace `--recovery-info`; the command rejects ambiguous or
unsupported recovery parameters. Restore defaults to 16 GiB extracted bytes and
100,000 entries, adjustable using `--max-bytes` and `--max-files`. These limits
bound extraction; encrypted archive staging can still reach the TGDB file-size
limit. Verify adequate disk capacity before restoring large archives.

Decryption stages plaintext with private permissions and authenticates the
entire payload before publishing it or giving it to the archive parser. A bad
key, tag, length or version fails without a final output. Snapshot restore
allows only the database, config, secret and sessions; rejects traversal,
links, special files and duplicate files; verifies gzip checksums, JSON shape
and SQLite integrity/schema; and requires a session key for native sessions.
Before publication, native restore rotates an existing cluster catalog epoch in
the staged database. Other instances therefore replace their cached catalog even
when restored history advances beyond their old cursor. Ordinary server restarts
retain that epoch. Relative and absolute restore destinations are covered.
It publishes the completed directory using the same OS-level exclusive rename
as file downloads. An existing destination, including an empty directory,
cannot be replaced. A forced process kill can leave a private restore staging
file/directory; offline restore has no persistent cleanup service. After such
an interruption, remove only the abandoned `.tgdb-restore-*` or
`.tgdb-restore-dir-*` entry from that command's output parent after confirming
no restore process still owns it. It has not been authenticated or published.

Snapshots contain state and sessions, **not downloaded media**. Restore media
from the corresponding mirror separately. Stop the original server before
starting its restored copy: account sessions and queued remote cleanup work
must not run simultaneously from two copies. Successful extraction does not
prove a live Telegram login or provider connection.


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

FTP fixtures exercise plain, explicit and implicit TLS with PASV/EPSV, Unicode
and empty files, equal-size corruption, source changes, readback mismatch,
rename failure, permission errors, connection reuse, cancellation, shutdown,
low upload rates, and malformed listings. Untrusted certificates and refused
TLS fail before credentials are sent. A child-process kill after a real partial
STOR verifies queued recovery and owned cleanup; rejected journal writes prevent
STOR. Cleanup after deleting the destination preserves unrelated files.
A 30-second, two-worker metadata/parser fuzz run completed 325,419 executions
without failure; it is bounded testing, not exhaustive verification.

An additional native executable check used independent pyftpdlib 2.2.0 FTP and
explicit-FTPS servers over loopback. Through the application's authenticated
HTTP API it created/probed destinations and enabled encryption, then verified
automatic mirrored bytes, equal-size source edits, an encrypted snapshot, and
offline recovery with SQLite integrity and restored values intact. This checks
the real API/queue/protocol/CLI path against a separate server implementation;
it does not contact Telegram, a cloud account or a production NAS.

Process-death regressions kill a child test executable after the fixture stores
real S3 part bytes or an SFTP/FTP partial file, bypassing all graceful cleanup. A
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
SFTP host-key and FTP passive-mode/CA fields. The final FTP executable's full
run passes 239/324, leaving 85 failed cases in 12 files (61.96 seconds).
The preceding encrypted-backup checkpoint passed 238/324: an additional
file-token failure changed only a normalized request token placeholder after
separate mint calls crossed a second; the response stayed 200 with identical
headers and file hash. Both implementations derive tokens from expiry seconds.
That timing-sensitive snapshot assumption remains unresolved even though this
run's 14 file cases pass. No expectations were changed or tests skipped.
Maintenance now passes 8/8 with the host-key table present. At the
previous checkpoint, its non-growth assertion failed because a quiescent native
database grew from 129 to 130 pages during VACUUM. That earlier evidence remains
valid: different schema packing does not make non-growth a general guarantee.
The application keeps actual measurements and database errors visible. Both
the added fields and the earlier VACUUM finding are documented rather than
hidden by changing frozen expectations. See
[the current migration totals and release gates](GO-MIGRATION-STATUS.md).

Further work includes the two remaining remote transports, independent crypto
review, bounded concurrency tuning, cleanup of interrupted
local/snapshot staging files, the empty S3/FTP reservation boundaries described above,
rebasing completed jobs after changing a destination's root/bucket, and real
browser/Telegram/provider/migration E2E.

## Local verification benchmark

`BenchmarkFTPVerifiedUpload1MiB`, Linux amd64, Go 1.26.8, Intel Core Ultra 7
270K Plus, three runs of ten iterations with other task checks stopped:
plain FTP takes 6.01–7.21 ms and explicit FTPS 17.62–21.28 ms per 1 MiB file.
Allocated bytes are 281,946–284,216 (793–797 objects) for plain FTP and
1,826,020–1,858,404 (7,419–7,428 objects) for FTPS. These allocations include
the Go fixture server in the same process; they are not client-only allocations
or RSS. Setup, input allocation and initial connection are excluded. Each
iteration uploads a new file, reads it back completely for verification and
publishes it: at least 2 MiB crosses loopback. Source-equivalent throughput is
145–174 MB/s plain and 49–60 MB/s TLS, not WAN/NAS performance or a comparison
with the released Node implementation.

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
the build at checkpoint `700db88` is 38,803,200 bytes, another 134,058 bytes. These are
binary sizes, not resident memory. The implementation uses the maintained AWS
S3 client and Go SSH/SFTP libraries; no deprecated S3 transfer-manager dependency
is retained.

Native encrypted-backup regressions additionally cover Local/S3/SFTP queue
uploads decoded by the standard Go AEAD, unlock/resume after restart, preserved
salt after disabling encryption, and encrypted/plaintext snapshots restored with
committed database values, config, sessions and secret intact. Offline command
tests use independently constructed AEAD fixtures and require no server data
directory. Wrong keys, corruption, traversal, archive links, duplicate entries,
extraction limits, missing native session keys and existing outputs are rejected.
A separate native-process smoke check decrypts and restores independent Python
AESGCM/PAX-tar fixtures, reopens the restored database, checks session bytes,
and rejects tampering and replacement without leftover staging.
Staging recovery tests inject durable ownership for more than one cleanup batch;
this is a restart fixture, not an encrypted-staging Process.Kill test.

`BenchmarkTGDBEncryption` on the same CPU/toolchain, three runs of 20
iterations, with other task checks stopped: 1 MiB takes 0.367–0.537 ms;
64 MiB takes 39.0–51.2 ms. Both sizes allocate 66,937–66,938 bytes and
12 objects per operation. The input is preallocated warm memory and output
is discarded; this excludes PBKDF2, disk staging and provider upload. It
shows size-independent crypto working allocations, not peak process RSS,
end-to-end speed or a comparison with the old implementation.

The encrypted-backup Linux executable is 38,980,630 bytes, 177,430 bytes
more than checkpoint `700db88`; this is unstripped file size, not RSS.
With native FTP/FTPS added, the comparable executable is 39,099,144 bytes,
another 118,514 bytes, with no new module dependencies.

The streaming profile matches Go's standard AEAD across empty, partial-block,
64 KiB boundary, fragmented and 1 MiB inputs; an independent Python vector;
and a fixed fixture produced by the released streaming encryptor. Both the
architecture assembly and `-tags=purego` paths pass. A 30-second, two-worker
fuzz run completed 284,211 executions without a mismatch, varying payload,
key, nonce and input fragmentation. This is a bounded test run, not exhaustive
verification.

## References

- [RFC 959](https://www.rfc-editor.org/rfc/rfc959.html): FTP commands, replies,
  data connections and rename sequence.
- [RFC 2428](https://www.rfc-editor.org/rfc/rfc2428.html): extended passive mode.
- [RFC 3659](https://www.rfc-editor.org/rfc/rfc3659.html): machine-readable
  directory facts and MLST/MLSD negotiation.
- [RFC 4217](https://www.rfc-editor.org/rfc/rfc4217.html): AUTH TLS, PBSZ and
  protection of data connections.
- [basic-ftp](https://github.com/patrickjuchli/basic-ftp): released dependency's
  explicit versus implicit TLS option semantics.
- [pyftpdlib server tutorial](https://pyftpdlib.readthedocs.io/en/latest/tutorial.html):
  independent FTP/FTPS server used for native process interoperability checks.

- [Go traversal-resistant file APIs](https://go.dev/blog/osroot): directory handles
  prevent ordinary path/symlink traversal during file operations.
- [SQLite VACUUM INTO](https://www.sqlite.org/lang_vacuum.html): produces a consistent
  database copy while retaining the existing database.
- [SQLite CREATE TRIGGER](https://www.sqlite.org/lang_createtrigger.html): download
  publication and mirror enqueue are implemented in database transactions.
- [NIST SP 800-38D](https://csrc.nist.gov/pubs/sp/800/38/d/final): GCM profile,
  authentication lengths and per-invocation plaintext limit.
- [RFC 8452 Appendix A](https://www.rfc-editor.org/rfc/rfc8452.html#appendix-A):
  relationship between GHASH and POLYVAL; the payload remains AES-GCM, not GCM-SIV.
- [POLYVAL package](https://pkg.go.dev/github.com/ericlagergren/polyval): pinned
  multiplication implementation with architecture assembly and generic Go paths.
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
