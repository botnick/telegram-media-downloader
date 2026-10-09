# Native backup migration

The Go application now implements destination management and local filesystem
mirror/snapshot jobs. **Backup migration is incomplete.** S3, SFTP, FTP/FTPS,
Google Drive and Dropbox transports, and TGDB payload encryption/restore, still
need native implementations. Their existing configuration forms and stored
credentials remain readable. A remote provider test reports unavailable; queued
remote/encrypted uploads remain pending with an explicit destination error.
They do not consume retry attempts, send plaintext, or invoke another runtime.
The frozen backup contracts do not exercise successful remote or encrypted
uploads, so their passing result must not be treated as that coverage.

## Implemented behavior

All `/api/backup/*` routes require an administrator session. They cover provider
metadata, destination create/update/delete, redacted config, connection tests,
status, jobs/recent activity, retry, pause/resume, manual runs, and encryption
key management. Backup WebSocket events and logs are flat and administrator-only.
Provider metadata is a static copy of the released form schema, not a claim
that all six transports are ready.

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

Local uploads operate through `os.Root`, stream in 64 KiB buffers to exclusively
created private temporary files, sync, close and rename only complete files.
Equal size is only a candidate: both source and destination are SHA-256 hashed
before skipping, including zero-byte files. Path escapes and outside-root
symlinks are rejected. Connection probes use unique names and cannot overwrite
an existing probe file. File sync/rename and SQLite WAL provide process-restart
recovery; this is not a guarantee against every filesystem/power-loss scenario.

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

The old Node contract runner is still development tooling; its removal remains
part of the overall migration. No frozen expectations were edited. The backup file passes 17/17. The full run
passes 239/324, leaving 85 failed cases in 12 files. One newly exposed failure
is the maintenance contract assuming VACUUM can never increase the logical
page count. A quiescent native database with the sole writer reserved reproduced
129 → 130 pages (4096 bytes each), so the application preserves those actual
measurements. VACUUM now holds that connection across both measurements and
reports database errors instead of silently counting them as successes. This
adds a documented frozen expectation difference; it is not a waived pass. See
[the current migration totals and release gates](GO-MIGRATION-STATUS.md).

Further work includes all five remote transports, encrypted upload and restore
compatibility, bounded concurrency tuning, cleanup of interrupted pre-publication
staging files, rebasing completed jobs after changing a destination's root/bucket,
and real browser/Telegram/provider/migration E2E.

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

## References

- [Go traversal-resistant file APIs](https://go.dev/blog/osroot): directory handles
  prevent ordinary path/symlink traversal during file operations.
- [SQLite VACUUM INTO](https://www.sqlite.org/lang_vacuum.html): produces a consistent
  database copy while retaining the existing database.
- [SQLite CREATE TRIGGER](https://www.sqlite.org/lang_createtrigger.html): download
  publication and mirror enqueue are implemented in database transactions.
- [Go cipher AEAD](https://pkg.go.dev/crypto/cipher#AEAD): used for the bounded TGDC
  configuration blobs, not a whole-file streaming substitute.
- Released format definitions: `src/core/backup/credentials.js`, `encryption.js`,
  and the unchanged frozen backup HTTP/WebSocket contracts.
