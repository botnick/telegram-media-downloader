---
title: "Backup"
description: "Back up your Telegram library to S3, SFTP, FTP/FTPS or a local disk, with encrypted archives and offline restore."
parent: Features
nav_order: 1
---

# Backup

Copy your downloaded library and the server's state to storage on another
disk or host, so a failed drive, a deleted Docker volume or a lost machine
does not take the archive with it. Backups run inside the `tgdl-server`
process: there is nothing extra to install.

**In 3.0 you can back up to:**

- **S3-compatible storage**: AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO and other S3 gateways.
- **SFTP**: any SSH server, with a password or a private key.
- **FTP / FTPS**: plain FTP, explicit FTPS (AUTH TLS) or implicit FTPS.
- **Local folder**: a second disk, USB drive or NAS share mounted on the host.

**Google Drive and Dropbox are not available in 3.0.** See
[Limits and what's not in 3.0](#limits-and-whats-not-in-30).

Every destination can encrypt on this host before anything is uploaded, and
encrypted backups can be decrypted and restored offline with the server
binary alone.

## What gets backed up

Each destination runs in one of three modes.

| Mode | What it uploads | When |
|---|---|---|
| **Continuous mirror** | Each downloaded media file, one object per file, using the same relative path as in your downloads folder | As soon as a download is saved. Click **Run now** once to also queue files that were downloaded before the destination existed. |
| **Scheduled snapshot** | One archive, `snapshots/snapshot-YYYYMMDD-HHMMSS.tar.gz` | On a cron schedule. Older snapshots are pruned to the number you keep. |
| **Manual** | The same snapshot archive | Only when you click **Run now**. Manual archives are never pruned. |

A **snapshot** contains the server's state, not your media:

- `db.sqlite`: a consistent copy of the database (catalog, chats, settings, accounts, backup destinations, dashboard sessions).
- `config.json`, if present.
- `secret.key`: needed to reopen the encrypted Telegram logins.
- `sessions/`: Telegram account sessions.

Because a snapshot holds working Telegram logins and the key that unlocks
them, treat an **unencrypted** snapshot like a password.

To protect everything, use two destinations: a **mirror** for the media and a
**snapshot** destination for the state. They can point at the same bucket or
server.

A few details about mirror mode:

- It only adds and updates objects. Deleting a file from your library does
  not delete its backup copy.
- If a file is changed or moved (for example by video faststart), it is
  uploaded again under its current path.
- If you set `TGDL_DOWNLOADS_DIR` (media on another disk), the mirror reads
  from there. See [Configuration](CONFIGURATION.md).

## Providers

The dashboard offers these forms. `GET /api/backup/providers` returns the same
list, and it still includes Google Drive and Dropbox even though they can't
upload in 3.0.

| Provider | ID | Required fields | Optional fields |
|---|---|---|---|
| Local filesystem / NAS mount | `local` | Root path (`rootPath`) | none |
| S3-compatible (AWS / R2 / B2 / MinIO / Wasabi) | `s3` | Region, Bucket, Access key ID, Secret access key | Endpoint URL, Prefix, Force path-style |
| SFTP (SSH file transfer) | `sftp` | Host, Username, Remote root, plus a Password **or** a Private key | Port (22), Key passphrase, SSH host key fingerprint |
| FTP / FTPS | `ftp` | Host, Remote root | Port, Username, Password, TLS mode, Passive mode, Custom TLS CA |
| Google Drive | `gdrive` | (not available in 3.0) | |
| Dropbox | `dropbox` | (not available in 3.0) | |

How uploads are checked:

- An upload is first written under a temporary name and only appears under
  its real name once it is complete. If an object with the same size already
  exists, both copies are compared by SHA-256 before the upload is skipped.
  Matching size alone is never treated as proof.
- After a crash or restart, unfinished uploads are put back in the queue. Any
  leftovers this server created (S3 multipart uploads, SFTP temporary files,
  FTP staging folders) are cleaned up from the original destination. Files the
  server did not create are never touched.
- Each destination has one upload worker. Different destinations upload in
  parallel.

### S3-compatible (AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO)

| Field | AWS S3 | Cloudflare R2 | Backblaze B2 | MinIO (self-hosted) |
|---|---|---|---|---|
| Endpoint URL | leave blank | `https://<account>.r2.cloudflarestorage.com` | `https://s3.<region>.backblazeb2.com` | e.g. `http://minio.lan:9000` |
| Region | e.g. `us-east-1` | `auto` | the region in the endpoint | `us-east-1` |
| Bucket | your bucket | your bucket | your bucket | your bucket |
| Access key ID / Secret | IAM access key | R2 API token keys | Application key ID / Application key | access key / secret key |
| Prefix | e.g. `tgdl/` | e.g. `tgdl/` | e.g. `tgdl/` | e.g. `tgdl/` |
| Force path-style | Auto | Auto | Auto | Auto or On |

For Wasabi and other gateways, enter the provider's S3 endpoint URL and
region.

- **Region is required**, even when the provider ignores it.
- **Endpoint** must be an `http://` or `https://` URL with no credentials,
  query string or fragment. Use HTTPS for anything that isn't on your local
  network. The server does not follow redirects.
- **Force path-style, Auto**: path-style is used when the endpoint host is
  `localhost`, an IP address, or contains `minio`. Otherwise
  virtual-hosted style is used. Choose **On** for other self-hosted
  gateways that need path-style.
- **Credentials** come only from this form. Environment variables, instance
  metadata and `~/.aws` are not read.
- **Permissions** the key needs on the bucket:
  - Test connection: `HeadBucket`.
  - Uploads: put, get and list objects.
  - Snapshot pruning: delete objects.
  - Cleaning up interrupted large uploads: abort multipart uploads and list multipart parts.
- **Large files**: files up to 8 MiB are uploaded in a single request. Larger
  files are uploaded in parts of at least 8 MiB, four at a time.
- **Bucket types**: general-purpose buckets and compatible gateways are
  supported. S3 directory buckets are not.
- **Abandoned uploads**: a crash at exactly the wrong moment can leave an
  empty multipart upload that the server never learned about. A bucket
  lifecycle rule that aborts incomplete multipart uploads after a few days
  clears these.

### SFTP

- **Port** defaults to 22.
- **Remote root** must be a clean absolute path, such as
  `/home/user/tgdl-backup`. Missing folders are created automatically.
- **Authentication**: give a password or a private key. If you give both, the
  key is used. An encrypted key needs its **Key passphrase**. The server never
  uses your SSH agent or `~/.ssh/config`.

  ```sh
  ssh-keygen -t ed25519 -f tgdl-backup -N ''
  ssh-copy-id -i tgdl-backup.pub user@nas.lan
  # Paste the contents of the private file `tgdl-backup` into "Private key (PEM)".
  ```
- **SSH host key fingerprint** (optional, recommended): accepts the
  `SHA256:...` format.
  - **Blank**: the first key the server presents is trusted and remembered.
    This is "trust on first use", so the very first connection is not
    verified.
  - **Changed key**: from then on, if the server's key changes, the
    connection is refused before any password or key is sent.
  - **New server key**: if the server's key changes on purpose, enter its
    new verified fingerprint to accept it.
  - **Checking the key**: **Test** shows the fingerprint it saw. You can
    compare it with `ssh-keygen -lf <host-key>.pub` run on the server.
- **Server requirements**: the server must support
  `posix-rename@openssh.com` (OpenSSH does) to overwrite an existing backup.
  Without it, new files still upload but an update fails with an explicit
  error. If the server supports `fsync`, uploads are synced to disk on the
  server.
- **Trust**: symbolic links inside the remote root are rejected. SFTP can't
  fully guard against a hostile server, so use an account you trust,
  ideally restricted to its folder (chroot).

### FTP / FTPS

**TLS mode** decides how the connection is protected:

| TLS mode | Stored value | Default port |
|---|---|---|
| Plain FTP (no TLS) | `false` | 21 |
| Explicit FTPS, AUTH TLS before login | `control` | 21 |
| Implicit FTPS, TLS from the first byte | `true` | 990 |

- **TLS mode is never guessed.** It is not inferred from the port, and the
  server never falls back to a weaker mode. FTPS needs TLS 1.2 or later and
  checks the hostname and certificate. Both the control and data connections
  are encrypted.
- **Plain FTP** sends your password and files in the clear. Turn on
  [encryption](#encryption) if you must use it.
- **Custom TLS CA (PEM)** is for a private FTPS server with its own
  certificate authority. That CA replaces the system trust store for this
  destination, and hostname checking stays on. There is no "accept any
  certificate" switch. The 2.x `NODE_TLS_REJECT_UNAUTHORIZED` workaround no
  longer applies.
- **Passive mode**: **Auto** uses PASV for IPv4 and EPSV for IPv6. **PASV**
  and **EPSV** force a single command, and a refusal is reported as an error.
  Data connections always go to the control server's IP address.
- **Username**: if you leave it blank, `anonymous` is used.
- **Remote root**: an absolute path, such as `/tgdl-backup`. It is created
  automatically.
- **Server requirements**:
  - **Machine-readable listings**: RFC 3659 `MLST`/`MLSD` support. Most
    modern servers have it.
  - **Folder creation**: permission to create folders. Each upload is staged
    in a temporary folder.
  - **Rename over an existing file**: the server must allow a rename to
    replace an existing file, so updates can be published. The old file is
    never deleted to make room.
- **Trust**: FTP can't prove that a rename is atomic or that data reached
  the disk, so use a server and account you trust.

{: .warning }
**Upgrading a 2.x FTP destination saved as "Implicit FTPS".** In 2.x that
option actually connected with explicit TLS. 3.0 does what the label says. If
such a destination now fails to connect, edit it and pick **Explicit FTPS**.

### Local filesystem / NAS mount

- **Root path**: an absolute path, such as `/mnt/nas/tgdl-backup`,
  `/Volumes/NAS/tgdl-backup` or `D:\tgdl-backup`. It is created
  automatically (mode 0700). The server needs read and write access, and
  **Test** writes a temporary probe file to check.
- **Docker**: mount the target as its own volume, outside `/app/data`. The
  server runs as uid 1000 (`node`) inside the container, so that user must
  be able to write to the folder.

  ```yaml
  services:
    telegram-downloader:
      volumes:
        - ./data:/app/data
        - /mnt/nas/tgdl-backup:/mnt/backup
  ```

  Then set **Root path** to `/mnt/backup`.

## Set up a destination in the dashboard

Backups are admin-only. Open **Settings → Tools → Backup & sync → Backup**
(`#/settings/tools/sync/backup`) and click **Add destination**.

1. Enter a **name** and pick a **provider**, then fill in its form.
2. Choose a **mode**. For **Scheduled snapshot**, enter a cron expression
   (default `0 3 * * *`, every day at 03:00) and how many copies to keep.
3. Optionally tick **Encrypt uploads (AES-256-GCM)** and enter the passphrase
   twice.
4. Click **Test connection**. For a new destination this saves a disabled
   copy, runs the test and deletes the copy again.
5. Click **Save**.

Each destination card shows:

- **Status and totals**: files, size, last success, queued uploads, and the
  last error.
- **Buttons**: **Run now**, **Pause**/**Resume**, **Test**, **Edit**,
  **Remove**, and **Unlock** for an encrypted destination after a restart.

Failed jobs appear in the recent-activity list with a **Retry** button.

- **Run now** on a mirror queues every downloaded file that has no backup
  job for this destination yet. On a snapshot or manual destination it builds and uploads a
  new archive.
- **Pause** stops the active upload and survives restarts. While a
  destination is paused, its scheduled snapshots are skipped.
- **Editing secrets**: in **Edit**, a secret field left blank keeps the
  saved value.
- **Stored credentials** are encrypted in the database. If the server's
  share-link secret changes, they can no longer be decrypted and the card
  shows `credentials no longer decryptable, please re-enter`.

The same actions are available through the HTTP API (admin session
required). These are the routes under `/api/backup/`:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/backup/providers` | Provider list and form fields |
| GET, POST | `/api/backup/destinations` | List destinations, or create one |
| PUT, DELETE | `/api/backup/destinations/{id}` | Edit or remove a destination |
| GET | `/api/backup/destinations/{id}/config` | Saved settings, with secrets left out |
| GET | `/api/backup/destinations/{id}/status` | Queue counts, paused/running state |
| GET | `/api/backup/destinations/{id}/jobs` | Jobs (`status`, `limit`, `offset` query parameters) |
| GET | `/api/backup/destinations/{id}/recovery` | Encryption recovery parameters (see below) |
| POST | `/api/backup/destinations/{id}/test` | Test the connection |
| POST | `/api/backup/destinations/{id}/run` | Run now |
| POST | `/api/backup/destinations/{id}/pause`, `.../resume` | Pause or resume |
| POST | `/api/backup/destinations/{id}/encryption` | Turn encryption on or off: `{"enabled":true,"passphrase":"…"}` |
| POST | `/api/backup/destinations/{id}/unlock` | Unlock after a restart: `{"passphrase":"…"}` |
| GET | `/api/backup/jobs/recent` | Recent jobs on all destinations |
| POST | `/api/backup/jobs/{id}/retry` | Retry a failed job |
| GET | `/api/backup/cleanup` | Interrupted-upload cleanup records (`limit` ≤ 200, `offset`) |

Example: create a mirror destination on Cloudflare R2.

```sh
curl -b 'tg_dl_session=…' -X POST http://localhost:3000/api/backup/destinations \
  -H 'Content-Type: application/json' \
  -d '{"name":"R2 off-site","provider":"s3","mode":"mirror",
       "config":{"endpoint":"https://<account>.r2.cloudflarestorage.com",
                 "region":"auto","bucket":"tgdl",
                 "accessKeyId":"…","secretAccessKey":"…","prefix":"tgdl/"}}'
```

For a snapshot destination, add `"mode":"snapshot","cron":"0 3 * * *","retainCount":7`.
To encrypt from the start, add `"encryption":true,"passphrase":"…"`. See
[API](API.md) for how to sign in.

## Encryption

Encryption is **off by default**. When it is on:

- **Encrypted before upload**: each file or snapshot is encrypted on this
  host, so the destination only stores ciphertext.
- **Same names**: object names don't change. An encrypted snapshot is still
  called `snapshot-….tar.gz`, but it starts with the bytes `TGDB`.
- **The cipher**: AES-256-GCM, with a key derived from your passphrase by
  PBKDF2-HMAC-SHA256 (200,000 iterations). Each destination has its own
  random salt. This is the same `TGDB` v1 format as 2.x.
- **Passphrase storage**: the passphrase is **never stored**. The key is
  only kept in memory. The server saves a check value so that a wrong
  passphrase is rejected (`incorrect backup passphrase`).
- **Size limit**: one file can be at most 64 GiB minus 32 bytes when
  encrypted.
- **Disk space**: each encrypted upload is first written as a private
  ciphertext copy on the local disk. You need free space for one such copy
  per active destination, plus room in `data/backups/` for snapshot archives.
- **Re-uploads**: every encryption uses a fresh random nonce, so the same
  file is never byte-identical to an earlier encrypted upload of it.

**After a restart**, an encrypted destination is locked. Its uploads wait
(without using up retry attempts) until you click **Unlock** on its card and
enter the passphrase again. Nothing is ever uploaded unencrypted in the
meantime.

**Changing settings:**

- **Turn on for an existing destination**: use **Edit**.
- **Turn off**: files uploaded from then on are not encrypted. The salt is
  kept so older encrypted objects can still be recovered.
- **Change the passphrase**: not supported. Once a passphrase is set, a
  different one is rejected. To use a new passphrase, create a new
  destination.
- **Destinations carried over from 2.x**: the server has no check value for
  them yet, so it can't verify the first passphrase you enter. Make sure it
  is the right one.

### Save your recovery parameters

The salt is **not** stored in the encrypted files. Without the passphrase
**and** the salt, the backup can't be decrypted. The salt also lives in the
database, which is itself inside the encrypted snapshot. Save it separately
as soon as you turn encryption on.

Find the destination's ID (it's in `GET /api/backup/destinations`, and in log
lines such as `destination added — s3/R2 off-site (#3)`). Then save its
recovery parameters, either by opening the URL in a browser where you're
signed in as admin or with curl:

```sh
curl -b 'tg_dl_session=…' http://localhost:3000/api/backup/destinations/3/recovery > recovery-dest-3.json
```

The response looks like this:

```json
{"success":true,"recovery":{"format":"TGDB","version":1,"kdf":"PBKDF2-HMAC-SHA256","iterations":200000,"saltHex":"…","destinationId":3}}
```

It contains no passphrase or key. Keep it, together with the exact
passphrase, somewhere other than the backup itself. It stays available after
you turn encryption off.

If the database still exists, you can also read the salt directly and pass it
as `--salt-hex`:

```sh
sqlite3 data/db.sqlite "SELECT hex(encryption_salt) FROM backup_destinations WHERE id = 3"
```

## Schedules and retention

- **Cron format**: five fields (minute, hour, day of month, month, weekday).
  Supported: `*`, numbers, ranges (`1-5`), lists (`1,15`) and steps (`*/6`).
  Weekdays are `0`–`6`, with Sunday as `0`. Names such as `MON` are not
  accepted. If both day-of-month and weekday are restricted, the job runs
  when either one matches, as in standard cron.
- **Timezone**: schedules use the server's local time, so set `TZ` in
  Docker.
- **When it runs**: a schedule fires at most once per minute, even across
  restarts. Runs missed while the server was stopped are **not** made up
  afterwards.
- **Retention**: applies to **snapshot** mode only. After each successful
  upload, the server keeps the newest *N* archives (1–365, default 7) and
  deletes the rest. It only looks at files named
  `snapshot-YYYYMMDD-HHMMSS.tar.gz` directly under `snapshots/`, so
  anything else in the bucket or folder is left alone. Manual-mode archives
  are never pruned.
- **Local copy**: the archive is built in `data/backups/` and removed there
  after it has been uploaded.
- **Retries**:
  - **Network errors**: a failed upload is retried up to 5 times, waiting 2,
    4, 8 then 16 seconds between attempts.
  - **Missing file**: a file that no longer exists on disk fails
    immediately (`local file missing: …`).
  - **After the last attempt**: the job shows as failed and can be retried
    from the dashboard.

## Restore

The dashboard has no restore button. You restore offline with the
`tgdl-server` binary, which works without a running server or any server
configuration. It is the same binary as the server: it is on the `PATH` in
the Docker image, and it is included in each release archive.

### 1. Download the backup

Use any client for your storage, such as the S3 console, `aws s3 cp`,
`rclone`, `sftp`, an FTP client or a file manager. Snapshots are under
`snapshots/` inside the prefix or root folder. Mirrored media keeps the same
folder layout as your downloads folder.

### 2. Restore a snapshot into a new folder

`backup-restore` decrypts and checks the whole archive before writing
anything. It verifies:

- the encryption tag and gzip checksums;
- that only the expected entries are present: `db.sqlite`, `config.json`,
  `secret.key` and `sessions/`;
- that there are no path tricks, links or special files;
- that `config.json` is valid JSON;
- that the SQLite database passes an integrity check;
- that `secret.key` is present when the archive contains native sessions.

Only then is the result moved into place, as a brand-new folder.

```sh
# Encrypted snapshot
tgdl-server backup-restore --input snapshot-20261009-030000.tar.gz \
  --output restored-data \
  --passphrase-file passphrase.txt --recovery-info recovery-dest-3.json

# Same, with the salt instead of the recovery file
tgdl-server backup-restore --input snapshot-20261009-030000.tar.gz \
  --output restored-data \
  --passphrase-file passphrase.txt --salt-hex 0123456789abcdef0123456789abcdef

# Unencrypted snapshot: --plaintext, and no passphrase or salt flags
tgdl-server backup-restore --input snapshot-20261009-030000.tar.gz \
  --output restored-data --plaintext
```

On success it prints `Snapshot validated and restored: N files, N bytes.`

**Flags:**

- `--input FILE`: the downloaded snapshot. Required.
- `--output NEW_PATH`: the folder to create. Its parent must exist, and the
  folder itself must **not** exist; even an empty folder is refused.
- `--passphrase-file FILE`: the passphrase, read **byte for byte**. A
  trailing newline counts as part of the passphrase. Create the file without
  one, for example:

  ```sh
  read -rs P && printf '%s' "$P" > passphrase.txt && unset P
  ```
- `--recovery-info JSON` or `--salt-hex HEX`: give exactly one. The recovery
  file can be the whole API response or just its `recovery` object.
- `--plaintext`: for unencrypted snapshots only. It can't be combined with
  the three flags above.
- `--max-bytes N`: maximum extracted size. Default 17179869184 (16 GiB).
- `--max-files N`: maximum number of entries. Default 100000.

Raise the limits for a very large database, and check you have enough free
disk space first. Run `tgdl-server backup-restore --help` to see the
built-in usage.

### 3. Swap the restored state in

1. **Stop the server.** Never run the original and the restored copy at the
   same time: both would use the same Telegram sessions.
2. **Move aside the current state.** In the data folder, move `db.sqlite`,
   `db.sqlite-wal` and `db.sqlite-shm` (if present), plus `secret.key`,
   `config.json` and `sessions/`.
3. **Copy in the restored files.** Copy the contents of `restored-data/`
   into the data folder.
4. **Fix ownership if needed.** In Docker, the entrypoint fixes ownership
   on start. On bare metal, make sure the service user owns the files.
5. **Start the server and check it.** Confirm that your Telegram accounts
   connect.

A successful restore proves the archive is intact. It doesn't prove the
Telegram logins are still valid on Telegram's side.

In Docker, put the snapshot inside `./data` (mounted at `/app/data`) and run
the command in a one-off container while the main one is stopped:

```sh
docker compose stop telegram-downloader
docker compose run --rm --no-deps telegram-downloader \
  tgdl-server backup-restore --input /app/data/restore/snapshot-20261009-030000.tar.gz \
  --output /app/data/restore/restored-data \
  --passphrase-file /app/data/restore/passphrase.txt \
  --recovery-info /app/data/restore/recovery-dest-3.json
```

Then swap the files in `./data` as described above, delete the passphrase
file, and run `docker compose up -d`.

If you use [cluster mode](CLUSTER.md), the restore marks the catalog as
new, so paired peers reload it in full instead of trusting their cached
copy.

### 4. Restore media from a mirror

Snapshots don't contain media. Copy the mirrored files back into the
downloads folder (`data/downloads/`, or your `TGDL_DOWNLOADS_DIR`), keeping
the same folder layout.

If the mirror was encrypted, decrypt each file first with `backup-decrypt`.
It takes the same `--input`, `--output`, `--passphrase-file` and
`--recovery-info`/`--salt-hex` flags. Each output file must not exist yet,
and its parent folder must exist.

```sh
tgdl-server backup-decrypt --input mirror/Chat/photo.jpg --output restored/Chat/photo.jpg \
  --passphrase-file passphrase.txt --recovery-info recovery-dest-3.json

# A whole downloaded mirror folder:
find mirror -type f | while IFS= read -r f; do
  out="restored/${f#mirror/}"; mkdir -p "$(dirname "$out")"
  tgdl-server backup-decrypt --input "$f" --output "$out" \
    --passphrase-file passphrase.txt --recovery-info recovery-dest-3.json
done
```

`backup-decrypt` also works on a single encrypted snapshot, if you want the
plain `.tar.gz`. Then, to add catalog entries for files the restored
database doesn't know about, open **Settings → Tools → Library → Duplicates**
and click **Re-index from disk**.

If the restore process is killed, it can leave a private
`.tgdb-restore-*` or `.tgdb-restore-dir-*` entry next to the output. It was
never completed. Once you're sure no restore is still running, delete it.

## Troubleshooting

| Message or symptom | What to do |
|---|---|
| `native backup provider "gdrive" is not available yet` (or `"dropbox"`) | Google Drive and Dropbox can't upload in 3.0. Add an S3, SFTP, FTP or local destination instead. |
| `backup encryption is locked; unlock this destination` | The server restarted. Click **Unlock** and enter the passphrase. Queued uploads then continue. |
| `incorrect backup passphrase` | This isn't the passphrase that was set for this destination. Passphrases can't be changed; create a new destination to use a different one. |
| `credentials no longer decryptable, please re-enter` | Edit the destination and enter its password, keys or secret again. |
| `local file missing: …` | The file was deleted or moved after it was queued, so the job fails without retrying. Put the file back and click **Retry**, or ignore it if the deletion was intended. |
| Mirror shows 0 files although the library is full | New destinations only pick up new downloads. Click **Run now** once to queue the existing library. |
| S3 `region required`, or `HeadBucket` fails | Region is always required (`auto` for R2). Check the endpoint, bucket name and keys. For MinIO or a self-hosted gateway, set **Force path-style** to **On**. |
| Interrupted S3 uploads leave cleanup errors | The key also needs permission to abort multipart uploads and list parts. Pending cleanups are listed at `GET /api/backup/cleanup`. |
| `SSH host key changed; verify the server …` or `does not match the configured fingerprint` | Confirm the change with the server's administrator, then enter the new `SHA256:` fingerprint in the destination. |
| `SFTP server must support posix-rename@openssh.com …` | The SSH server can't overwrite files safely. Use OpenSSH's SFTP server, or one that supports this extension. |
| `FTP backup requires RFC 3659 MLST/MLSD support` | Enable MLSD on the FTP server, or use SFTP. |
| FTPS certificate error | Use the server's real hostname. For a private CA, paste it into **Custom TLS CA (PEM)**. |
| A 2.x "Implicit FTPS" destination stopped connecting | Switch it to **Explicit FTPS**. See the [FTP / FTPS](#ftp--ftps) section. |
| `snapshot mode requires a cron expression`, `cron requires five fields` | Enter a five-field schedule, such as `0 3 * * *`. |
| `rootPath must be an absolute path` | Use a full path, such as `/mnt/backup`. In Docker, use a path inside the container. |
| `backup-restore` prints the usage line | Give `--input` and `--output`, plus either `--passphrase-file` with exactly one of `--recovery-info`/`--salt-hex`, or `--plaintext` alone. |
| `backup restore failed: file already exists` (or `backup decryption failed: file already exists`) | The `--output` path already exists. Choose a new name. |
| `snapshot extraction limit exceeded or invalid entry`, `snapshot contains too many entries` | Raise `--max-bytes` or `--max-files`. |

For other problems, see [Troubleshooting](TROUBLESHOOTING.md).

## Limits and what's not in 3.0

- **Google Drive and Dropbox are not available.** They still appear in the
  provider list, and destinations created in 2.x are kept with their saved
  settings, but nothing uploads. Their queued jobs wait with an error
  instead of failing or using up retries. Support may return in a later
  release, with no date announced. The 2.x OAuth helpers
  (`scripts/setup-gdrive.js`, `scripts/setup-dropbox.js`) and the
  `npm install googleapis` / `dropbox` / `basic-ftp` steps are no longer
  part of the setup.
- **Restore is offline only.** It uses `tgdl-server backup-restore` and
  `backup-decrypt`, with no in-dashboard restore.
- **One upload at a time per destination.** The 2.x
  `BACKUP_WORKERS_PER_DEST` and `BACKUP_DROPBOX_CHUNK_BYTES` variables are
  ignored.
- **Passphrases can't be rotated**, and turning encryption on doesn't
  re-encrypt files that were already uploaded.
- **Mirror never deletes remote files**, and changing a destination's
  bucket, prefix or root doesn't upload already-finished files again.
- **Tested against protocol test servers, not live accounts.** S3, SFTP and
  FTP support was tested against protocol-level test servers. It has not
  been tested against every commercial provider or NAS. Test a destination,
  then try a restore, before relying on it.

For the implementation details behind this page (transfer journals, cleanup,
crypto construction and test coverage), see the developer note
[Native backup migration](GO-BACKUP.md). For moving from 2.x, see
[Upgrading from 2.x](UPGRADING.md).
