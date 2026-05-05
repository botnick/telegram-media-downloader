# Deployment

The dashboard listens on `:3000` by default. Don't expose it directly to the public internet — put it behind a reverse proxy with TLS.

## Docker (recommended)

`docker-compose.yml` ships a production-ready setup:

```bash
docker compose up -d
# open http://localhost:3000
# 1. set the dashboard password (only allowed from localhost on first run)
# 2. Settings → Telegram API → enter apiId / apiHash from my.telegram.org
# 3. Settings → Telegram Accounts → "Add account" → phone / OTP / 2FA
# 4. Settings → Engine → Start monitor
```

The image is published to GHCR on every release: `ghcr.io/botnick/telegram-media-downloader:<version>`.

### Verify a deployment

After `docker compose up -d` (or any host install), run the diagnostics:

```bash
docker compose exec app npm run doctor      # inside the container
# or, for host installs:
npm run doctor
```

Reports Node + ABI, config load, SQLite open, `data/` writability, port availability, and `ffmpeg`. Exits non-zero on any blocking failure — wire it into your provisioning script or CI smoke-step.

### Environment variables

| Var | Default | Notes |
|---|---|---|
| `PORT`                          | `3000`              | HTTP port. |
| `NODE_ENV`                      | unset               | Set to `production` to enable `Secure` cookies (requires HTTPS). |
| `TZ`                            | `UTC`               | Container timezone. |
| `TGDL_RUN`                      | `monitor`           | Watchdog subcommand for `runner.js` / `runner.sh` / `watchdog.ps1`. |
| `TGDL_DEBUG`                    | unset               | Set to any truthy value to surface gramJS reconnect noise on stderr. |
| `TGDL_DATA_DIR`                 | `<repo>/data`       | Override the on-disk data root (`config.json`, `db.sqlite`, `downloads/`, sessions). Used by the test suite to point at an isolated tmpdir; also useful for Docker / multi-instance deploys that want the data on a different mount without symlinks. |
| `TRUST_PROXY`                   | unset               | `1`, `loopback`, or any value Express's `trust proxy` understands; needed for accurate IPs behind a reverse proxy. |
| `FFMPEG_PATH`                   | auto-detect         | Override the resolved ffmpeg binary used by `core/thumbs.js`. Resolver order: this var → `/usr/bin/ffmpeg` → `/usr/local/bin/ffmpeg` → `@ffmpeg-installer/ffmpeg` → bare `ffmpeg`. |
| `THUMBS_IMG_CONCURRENCY`        | `8`                 | Parallel image-thumb jobs. |
| `THUMBS_VID_CONCURRENCY`        | `3`                 | Parallel video-thumb jobs (ffmpeg pins a CPU core). |
| `WATCHTOWER_HTTP_API_TOKEN`     | unset               | Bearer token shared between the dashboard and the optional watchtower sidecar. Setting this + booting with the `auto-update` compose profile lights up the **Install update** button. |
| `WATCHTOWER_URL`                | `http://watchtower:8080` | Internal address of the watchtower sidecar. |
| `BACKUP_WORKERS_PER_DEST`       | `3`                 | Per-destination concurrent uploads for the backup subsystem. Keep modest — backups share the host's outbound bandwidth with everything else (including the realtime monitor). |
| `AI_MODELS_DIR`                 | `<repo>/data/models`| Override the on-disk cache directory for AI model weights. Accepts an absolute path or a path relative to the repo root. Default lives inside `data/` so it survives a `docker compose down` and can be pre-seeded by copying the directory between hosts. |
| `AI_INDEX_CONCURRENCY`          | `1`                 | (Reserved) Per-process worker count for the AI scan loop. Higher values risk OOM on small hosts because each WASM heap occupies ~150 MB. Currently honoured via `config.advanced.ai.indexConcurrency`. |
| `HASH_WORKER_POOL_SIZE`         | `min(8, ⌊cpus/2⌋)`  | Worker-thread pool used for SHA-256 streaming over multi-GB files (post-write hash + dedup catch-up). Keeps the main event loop free for HTTP / WebSocket traffic. Set higher on a beefy host with many parallel downloads, lower on a Pi 4 / NAS. |
| `HASH_WORKER_DISABLE`           | unset               | Set to `1` to skip the worker pool entirely and hash on the main thread — useful for sandboxed runtimes that block `worker_threads`. |
| `COMPRESSION_LEVEL`             | `6`                 | gzip / brotli compression level (1-9) used by the optional `compression` middleware on text payloads. Lower the level on slow CPUs (Pi Zero, embedded NAS) so requests don't queue up behind compression; raise it on hosts with spare CPU + slow uplink. Set the env to `0` to disable explicitly even when the package is installed. |

## One-click in-dashboard auto-update (opt-in)

> **Maintenance status, late 2026.** Upstream `containrrr/watchtower` is in low-maintenance mode (the project banner reads "no longer actively maintained"). The integration here keeps working — the HTTP API and the docker socket contract have not changed in years — but if you want a more actively maintained sidecar the recommended drop-in is **[`whats-up-docker`](https://github.com/fmartinou/whats-up-docker)** (configures the same docker-compose label scoping; the dashboard's "Install update" button is feature-flagged via `WATCHTOWER_*` env vars but the protocol is just HTTP-trigger-then-docker-compose-up, so a thin shim works against any successor). The simplest path that doesn't depend on either sidecar is the manual upgrade documented below.

The bundled `docker-compose.yml` ships a `watchtower` service under the `auto-update` profile. The dashboard never touches `/var/run/docker.sock` itself — it sends an authenticated HTTP request to the sidecar, which has a read-only socket mount and is scoped to the labeled container.

```bash
# 1. Generate a strong random token
openssl rand -hex 32 > .token
# 2. Put it in .env next to docker-compose.yml
echo "WATCHTOWER_HTTP_API_TOKEN=$(cat .token)" >> .env
rm .token
# 3. Boot with the profile enabled
docker compose --profile auto-update up -d
```

Once enabled, **Settings → Maintenance → Install update** pulls the latest image and recreates the container. The `data/` volume + `config.json` + sessions survive the swap; the SQLite database is snapshotted to `data/backups/` first.

Without the token (or without the profile), the **Install update** button stays disabled and the dashboard falls back to linking the GitHub release page.

### Manual upgrade (always works, zero sidecar)

If you'd rather skip the watchtower / whats-up-docker wiring entirely:

```bash
docker compose pull && docker compose up -d
```

That's it — `pull_policy: always` in `docker-compose.yml` plus the published `:latest` tag mean a fresh image lands on every restart. Run from a cron / systemd timer / Synology Task Scheduler if you want it nightly.

## Hardware-accelerated video thumbnails (optional, advanced)

If the host has an **Intel iGPU** (Iris Xe / UHD / Arc) and you generate a lot of video thumbnails, `ffmpeg` can decode + scale via VAAPI on the GPU instead of the CPU — typically 5-10× faster on H.264/H.265 input.

Two pieces are required:

1. **Container access to the render device.** Add to `docker-compose.yml`:
   ```yaml
   devices:
     - /dev/dri:/dev/dri
   group_add:
     - "video"
     - "render"   # `getent group render | cut -d: -f3` on the host if numeric
   ```

2. **Intel media driver inside the image.** The default `node:24.15.0-bookworm-slim` Dockerfile doesn't ship it; either add `RUN apt-get install -y intel-media-va-driver-non-free` to a fork of the Dockerfile, or pass through the host's driver via `/usr/lib/x86_64-linux-gnu/dri:/usr/lib/x86_64-linux-gnu/dri:ro` if your host already has it.

There is **no code change** required — `core/thumbs.js` already shells out to `ffmpeg`. To opt the thumb generator into hardware decode, set `FFMPEG_HWACCEL=vaapi` in the container env and the bundled args become `-hwaccel vaapi -hwaccel_output_format vaapi`. Keep it unset (default) on hosts without an iGPU and the CPU path runs unchanged.

NVIDIA / AMD GPUs follow the same pattern with `FFMPEG_HWACCEL=cuda` or `=opencl` respectively, but require their own driver containers — out of scope for this doc.

## Reverse proxy

### Caddy (TLS automatic)

```caddyfile
tg.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000 {
        header_up X-Real-IP {remote}
    }
}
```

### nginx

```nginx
server {
    server_name tg.example.com;
    listen 443 ssl http2;
    # ssl_certificate / ssl_certificate_key …

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        # WebSocket upgrade
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;
    }
}
```

Behind a proxy, set `TRUST_PROXY=1` in the container env so the rate-limiter sees the real client IP.

### Force HTTPS (TLS lockdown)

Once the reverse proxy has a working TLS cert, lock the dashboard to HTTPS in **Settings → Privacy & Net → Dashboard security → Force HTTPS**. Effects:

- Every HTTP request 308-redirects to HTTPS (`localhost` excepted so the operator can always reach the dashboard from the host even if the proxy melts).
- A `Strict-Transport-Security: max-age=31536000; includeSubDomains` header attaches to every secure response — browsers cache the HTTPS-only verdict for a year.
- Non-GET / non-HEAD HTTP requests get a `403 HTTPS required` response instead of a redirect, so a misconfigured client can't silently retry a write on plain HTTP.

Pre-flight check before flipping the toggle:

1. **Cert reachable** — `curl -I https://tg.example.com/` returns 200 (or whatever HTTP code, just not a TLS error).
2. **`TRUST_PROXY=1`** is set in the dashboard container env so `req.secure` honours `X-Forwarded-Proto`. Without this, the dashboard sees every request as plain HTTP and 308-loops.
3. **Localhost recovery path** — keep SSH / docker exec access; you can flip the toggle back from the host even if the cert breaks (the localhost exemption keeps `127.0.0.1:3000` reachable from inside the container).

The setting persists in `data/config.json → web.forceHttps`. To roll back without the dashboard, edit the file and restart the container.

For HSTS preload (chrome global list), submit your domain at <https://hstspreload.org> after the header has been live for at least a few weeks. The dashboard does **not** add `preload` to the HSTS header automatically — preload is a one-way commitment that needs operator opt-in.

## systemd unit (bare-metal Node)

```ini
# /etc/systemd/system/telegram-downloader.service
[Unit]
Description=Telegram Media Downloader
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=tgdl
WorkingDirectory=/opt/telegram-media-downloader
Environment=NODE_ENV=production
Environment=PORT=3000
ExecStart=/usr/bin/node src/web/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/telegram-media-downloader/data
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-downloader
journalctl -u telegram-downloader -f
```

## Backups

Back up `data/secret.key` and `data/sessions/*.enc` together — losing `secret.key` means none of the sessions decrypt and every account has to re-login. `data/db.sqlite` and the downloads tree are easy to recreate from Telegram if needed.

Pre-update DB snapshots land at `data/backups/db-pre-update-<utc-stamp>.sqlite` automatically when an in-dashboard update runs (last 5 kept). They're plain `.sqlite` files — to roll back, stop the container, swap one of them in for `data/db.sqlite`, and restart.

Rotate `config.web.shareSecret` to invalidate every outstanding share link in one move (edit the value or delete it; a fresh 32-byte secret regenerates on next boot).

## Watchdogs

For long-running headless monitor:

- **Linux/macOS:** `TGDL_RUN=monitor ./runner.sh`
- **Windows:** `pwsh ./watchdog.ps1` (defaults to `monitor`)
- **Docker:** the included compose file restarts the container on crash; the in-process runtime keeps the engine alive within it.
