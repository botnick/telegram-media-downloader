# Backup destinations

Mirror your downloaded library to off-host storage so a wiped disk, a
deleted Docker volume, or a lost USB drive doesn't take the archive
with it. Six providers are supported out of the box:

- **S3-compatible** — AWS S3, Cloudflare R2, Backblaze B2, MinIO,
  Wasabi, DigitalOcean Spaces.
- **Local filesystem / NAS mount** — any writable absolute path.
- **SFTP** — SSH-based, password or private-key auth.
- **FTP / FTPS** — plain, explicit (AUTH TLS), or implicit FTPS.
- **Google Drive** — OAuth refresh-token auth, scoped to a backup
  folder.
- **Dropbox** — OAuth refresh-token auth, app-folder scoped by default.

## Modes

Each destination runs in one of three modes:

- **Continuous mirror.** Every newly-downloaded file is queued for
  upload as soon as the downloader emits `download_complete`. The queue
  is persistent — restarting the server does not lose pending uploads.
- **Scheduled snapshot.** A cron expression (`0 3 * * *` for nightly
  3am, etc.) triggers a full archive of `db.sqlite` (which now also
  carries runtime config + web sessions) + `sessions/` packed into a
  single `.tar.gz`, uploaded to a
  `snapshots/` prefix on the destination. Older archives are pruned to
  keep at most `retain_count` copies (default 7).
- **Manual.** No automatic uploads. The destination only fires on
  `POST /api/backup/destinations/:id/run`.

## Adding a destination

Open **Maintenance → Backup → Add destination** in the dashboard. The
wizard walks through:

1. Display name + provider.
2. Provider-specific connection form.
3. Mode (mirror / snapshot / manual) + cron / retention.
4. Optional client-side encryption (AES-256-GCM, see below).
5. Test connection + Save.

Or via API:

```bash
curl -b cookie -X POST http://localhost:3000/api/backup/destinations \
     -H 'Content-Type: application/json' \
     -d '{"name":"R2 off-site","provider":"s3","mode":"mirror",
          "config":{"endpoint":"https://acct.r2.cloudflarestorage.com",
                    "region":"auto","bucket":"tgdl",
                    "accessKeyId":"…","secretAccessKey":"…","prefix":"tgdl/"}}'
```

## Provider walkthroughs

### S3 / R2 / Backblaze B2 / MinIO / Wasabi

The single S3 driver covers every S3-compatible service. Field-by-field:

| Field             | AWS S3                   | Cloudflare R2                                | Backblaze B2                          | MinIO (self-host)              |
|-------------------|--------------------------|----------------------------------------------|---------------------------------------|--------------------------------|
| Endpoint URL      | leave blank              | `https://<acct>.r2.cloudflarestorage.com`    | `https://s3.<region>.backblazeb2.com` | `http://localhost:9000`        |
| Region            | `us-east-1` / etc.       | `auto`                                       | matches the endpoint subdomain        | `us-east-1` (placeholder)      |
| Bucket            | the bucket name          | the bucket name                              | the bucket name                       | the bucket name                |
| Access key ID     | IAM user / access key    | API token's "Access key ID"                  | Application key ID                    | root user / IAM user           |
| Secret access key | IAM user / secret access | API token's "Secret access key"              | Application key                       | root user / IAM user           |
| Prefix            | `tgdl/` (recommended)    | `tgdl/`                                      | `tgdl/`                               | `tgdl/`                        |
| Force path-style  | Off (auto)               | Off (auto)                                   | Off (auto)                            | On                             |

Notes:

- Multipart uploads use 8 MB parts × 4 in flight. Fits inside R2's
  5 MB-min / 5 GB-max part rules and B2's quota; AWS doesn't care.
- AWS S3 charges for `LIST` calls — keep `retain_count` modest on
  snapshot mode if you're cost-sensitive.
- R2 has no egress fees, making it the cheapest mirror target for a
  large library. We default the part size + concurrency to be R2-safe.
- B2's "Application key" is what goes in the secret field, not the
  master "Application key ID".

### Local filesystem / NAS mount

For mounted volumes — SMB / NFS / external HDD on a known mount point.
Just configure the absolute path:

- Linux: `/mnt/nas/tgdl-backup`
- macOS: `/Volumes/NAS/tgdl-backup`
- Windows: `D:\tgdl-backup` or a UNC mounted as a drive letter

The dashboard process (or container) needs read+write on the path. The
provider creates it on init and writes a probe file to confirm before
declaring init successful.

When backing up to a Docker-host mount, expose the path into the
container as a separate volume (NOT under `/app/data`). Example
`docker-compose.yml` snippet:

```yaml
services:
  app:
    volumes:
      - ./data:/app/data
      - /mnt/nas/tgdl-backup:/mnt/backup
```

Then point the destination's `rootPath` at `/mnt/backup`.

### SFTP

Standard SSH file-transfer over port 22 (configurable). Auth with
either password OR a PEM private key — provide one, not both.

- Generate a deploy key: `ssh-keygen -t ed25519 -f tgdl-backup -N ''`
- `cat tgdl-backup` → paste into the dashboard's "Private key" field
- `ssh-copy-id -i tgdl-backup.pub user@nas.lan` to authorise it

The remote root must be an absolute path (`/home/user/tgdl-backup`) and
will be auto-created.

### FTP / FTPS

Wraps the optional `basic-ftp` package — install with:

```bash
npm install basic-ftp
```

Wizard fields:

| Field        | Purpose                                                           |
|--------------|-------------------------------------------------------------------|
| Host         | `ftp.example.com`                                                 |
| Port         | 21 (plain / explicit FTPS) / 990 (implicit FTPS) — auto if blank  |
| Username     | empty for anonymous FTP                                           |
| Password     | empty for anonymous FTP                                           |
| TLS mode     | Plain · Explicit FTPS (AUTH TLS) · Implicit FTPS                  |
| Remote root  | absolute path on the server, e.g. `/tgdl-backup` (auto-created)   |

Caveats vs. the SFTP provider:

- **No etag.** FTP has no equivalent to S3's content-hash header, so
  size-based dedup is the only check the manager runs against
  re-uploads.
- **MDTM is best-effort.** The provider falls back to `mtime: 0` when
  the server doesn't expose `MDTM` for a file.
- **Plain FTP transmits credentials in cleartext.** Use Explicit
  FTPS unless you're talking to a host on the same machine.
- **Self-signed FTPS certs.** Set `NODE_TLS_REJECT_UNAUTHORIZED=0` at
  the process level if your FTPS host has a self-signed cert (it's a
  blunt instrument — pin a CA where you can).

Cancellation aborts the underlying control connection. Long uploads
stop within a couple of seconds of clicking Pause / Cancel / Remove.

### Google Drive

Wraps the optional `googleapis` package — install with:

```bash
npm install googleapis
```

Auth model: clientId + clientSecret + refreshToken. The dashboard
does **not** host an embedded OAuth callback listener; you generate
the refresh token externally and paste it into the wizard.

#### Setup walkthrough

1. **New project.** Open the [Google Cloud Console](https://console.cloud.google.com/),
   click the project picker → "New project". Any name works.
2. **Enable the Drive API.** APIs & Services → Library → search
   "Google Drive API" → click Enable.
3. **Create an OAuth client.** APIs & Services → Credentials → Create
   credentials → OAuth client ID. If prompted to configure the consent
   screen, pick "External", supply an app name + your email, and add
   the scope `https://www.googleapis.com/auth/drive.file` (you can
   leave the app in "Testing" mode — no public verification needed).
   Then create an OAuth client ID with application type **Desktop
   app**. Save the resulting client ID + client secret.
4. **Generate a refresh token.** Either run `node scripts/setup-gdrive.js`
   on the server (CLI helper that prints the refresh token), or use
   the [Google OAuth Playground](https://developers.google.com/oauthplayground/):
   click the gear icon → "Use your own OAuth credentials" → paste
   client ID + secret. In the left panel, scroll to "Drive API v3"
   and tick `https://www.googleapis.com/auth/drive.file`. Click
   Authorize APIs → sign in → Allow → "Exchange authorization code
   for tokens" → copy the `refresh_token` shown.

Paste clientId + clientSecret + refreshToken into the wizard. The
provider auto-creates a folder named `tgdl-backup` at My Drive root
on first use; supply a folderId in the wizard if you'd like uploads
to land elsewhere (find it in the Drive URL, after `folders/`).

Caveats:

- **750 GB/day egress quota** per account. If a sync stalls with
  `quotaExceeded`, the queue worker retries with backoff.
- **Drive folders are graph-shaped, not paths.** The provider keeps
  an in-memory `path → folderId` cache and only walks the chain
  once per upload. The cache resets on each `init()`.
- **Files are stamped** with `appProperties: { 'tgdl-backup': '1' }`
  so a future audit can list-and-prune only what we wrote.

### Dropbox

Wraps the optional `dropbox` package — install with:

```bash
npm install dropbox
```

Auth model: appKey + appSecret + refreshToken. Dropbox dropped
non-expiring access tokens in 2021 — the refresh-token flow is the
only durable option.

#### Setup walkthrough

1. **Create a scoped app.** Open the [Dropbox developer console](https://www.dropbox.com/developers/apps),
   click "Create app" → "Scoped access" → "App folder" (recommended;
   isolates uploads to a per-app sandbox at `Apps/<your-app-name>/`)
   or "Full Dropbox" if you want to mirror anywhere in the account →
   name your app.
2. **Pick permissions.** Go to the Permissions tab, enable
   `files.content.write`, `files.content.read`, `account_info.read`,
   then click Submit.
3. **Get a refresh token.** Settings tab — copy App key + App secret.
   Either run `node scripts/setup-dropbox.js` on the server (CLI
   helper that prints the refresh token), or follow Dropbox's
   [authorisation docs](https://www.dropbox.com/developers/documentation/http/documentation#authorization)
   manually — the key step is appending `&token_access_type=offline`
   to the authorisation URL so the response includes a
   `refresh_token`.

Paste appKey + appSecret + refreshToken + remote root (default
`/tgdl-backup`) into the wizard.

Caveats:

- **150 MB single-shot limit.** Files ≤ 150 MB use `filesUpload`,
  bigger files use the chunked session API (`filesUploadSessionStart`
  → `filesUploadSessionAppendV2` → `filesUploadSessionFinish`). Chunk
  size defaults to 8 MB; override with `BACKUP_DROPBOX_CHUNK_BYTES`
  in the environment.
- **App-folder scope**. If you picked "App folder" in step 1, the
  remote root is relative to `Apps/<your-app-name>/` from the
  account's perspective — the wizard's `/tgdl-backup` becomes
  `Apps/<your-app-name>/tgdl-backup` in the Dropbox UI.

## Encryption

Encryption is **off by default**. When enabled, files are encrypted on
this host before upload — the remote sees only ciphertext. The
passphrase derives the AES-256-GCM key via PBKDF2-SHA256 (200 000
iterations). A unique 16-byte salt per destination is stored alongside
the encrypted credentials.

**The passphrase is never persisted.** It lives in process memory only,
keyed by destination id. Restarting the dashboard prompts the operator
to re-enter the passphrase via **Maintenance → Backup → Unlock**
before the queue worker can resume.

### File format on the wire

Encrypted uploads carry a fixed header:

```
magic(4) = 'TGDB'   |   version(1) = 1   |   iv(12)   |   ciphertext   |   tag(16)
```

That makes a corrupted or wrong-bucket object identifiable on
inspection (`head -c5 file` shows `TGDB\x01`). The 33-byte overhead is
the price of authenticated encryption.

### Key rotation caveat

The `config.web.shareSecret` (used to encrypt provider credentials at
rest in `db.sqlite`) is independent of per-destination encryption
passphrases. Rotating the shareSecret invalidates every existing
destination's stored credentials — the dashboard surfaces this as
"credentials no longer decryptable, please re-enter" on the next
worker run. Rotate intentionally; back the relevant passphrases up
before doing so.

### Restore

Restore is currently a manual procedure (UI restore is on the
roadmap). For an encrypted snapshot:

1. Download the `snapshot-YYYYMMDD-HHMMSS.tar.gz` file from the
   destination (same access keys, no special permission needed).
2. Decrypt:

   ```js
   import fs from 'fs';
   import { decryptStream, deriveKey } from 'telegram-media-downloader/src/core/backup/encryption.js';
   const key = deriveKey('your-passphrase', Buffer.from('<salt-hex>', 'hex'));
   fs.createReadStream('snapshot.tar.gz.enc')
     .pipe(decryptStream(key))
     .pipe(fs.createWriteStream('snapshot.tar.gz'));
   ```

   The salt is stored in the destination row (`encryption_salt` column,
   visible via `sqlite3 data/db.sqlite "SELECT hex(encryption_salt)
   FROM backup_destinations WHERE id = N"`). Or if you've rotated DBs,
   you've kept the salt out of band — write it down at create-time.

3. Untar: `tar -xzf snapshot.tar.gz`.
4. Stop the dashboard, swap `data/db.sqlite` + `data/sessions/`,
   restart.

For a plaintext (un-encrypted) snapshot, skip step 2.

For mirror-mode files (individual photos / videos), files are
uploaded as-is and can be downloaded directly with any S3 client / NAS
file manager. Re-running **Maintenance → Re-index from disk** after
copying them back into `data/downloads/` rebuilds the catalogue.

## Quotas + failure modes + retry

- **Per-job retry** with exponential backoff: `2 ** attempts` seconds,
  capped at 30 minutes. Default `max_attempts = 5`. After giveup the
  job is marked `failed` and surfaces in the dashboard's recent strip
  with a one-click Retry button.
- **Connection probes** are cheap — `HeadBucket` for S3, write+unlink
  for Local, `stat()` for SFTP. Click "Test" on a destination card
  after editing config.
- **AbortSignal threading.** Pause / Cancel / Remove on a destination
  triggers an AbortController that propagates through every active
  upload. Workers honour the signal at every stream chunk; large
  uploads stop within a couple of seconds.
- **Per-destination concurrency** defaults to 3 parallel uploads.
  Override with `BACKUP_WORKERS_PER_DEST=N` in the environment.

## Cost considerations

Approximate ballpark for a 1 TB curated library, US-region pricing
2025, mirror mode (no egress to read it back):

| Provider               | Cost / month            | Notes                                                                  |
|------------------------|-------------------------|------------------------------------------------------------------------|
| Cloudflare R2          | ~$15 storage            | No egress fees, no API request charges over the free tier              |
| Backblaze B2           | ~$6 storage             | $0.01/GB egress (free up to 3× monthly storage)                        |
| AWS S3 (Standard)      | ~$23 storage            | Egress $0.09/GB after the first GB                                     |
| AWS S3 (Glacier IR)    | ~$4 storage             | Restore latency in minutes; 90-day minimum charge                      |
| Local NAS (one-time)   | $200 for a 4 TB drive   | No recurring fee; on-site = single-point-of-failure for fire / theft   |
| SFTP to a friend's NAS | beer money              | Requires their reliability + uptime                                    |

For a private 18+-curated library where the operator already runs a NAS
at home, the most resilient setup is **two destinations**: a Local
mirror to the NAS for fast restores + a Cloudflare R2 mirror for
off-site disaster recovery. Both run independently — losing one is not
losing the other.
