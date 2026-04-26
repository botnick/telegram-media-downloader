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

### Environment variables

| Var | Default | Notes |
|---|---|---|
| `PORT`        | `3000`    | HTTP port. |
| `NODE_ENV`    | unset     | Set to `production` to enable `Secure` cookies (requires HTTPS). |
| `TZ`          | `UTC`     | Container timezone. |
| `TGDL_RUN`    | `monitor` | Watchdog subcommand for `runner.js` / `runner.sh` / `watchdog.ps1`. |
| `TGDL_DEBUG`  | unset     | Set to any truthy value to surface gramJS reconnect noise on stderr. |
| `TRUST_PROXY` | unset     | `1`, `loopback`, or any value Express's `trust proxy` understands; needed for accurate IPs behind a reverse proxy. |

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

## Watchdogs

For long-running headless monitor:

- **Linux/macOS:** `TGDL_RUN=monitor ./runner.sh`
- **Windows:** `pwsh ./watchdog.ps1` (defaults to `monitor`)
- **Docker:** the included compose file restarts the container on crash; the in-process runtime keeps the engine alive within it.
