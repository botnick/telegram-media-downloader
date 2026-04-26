# Telegram Media Downloader

[![CI](https://github.com/botnick/telegram-media-downloader/actions/workflows/ci.yml/badge.svg)](https://github.com/botnick/telegram-media-downloader/actions/workflows/ci.yml)
[![CodeQL](https://github.com/botnick/telegram-media-downloader/actions/workflows/codeql.yml/badge.svg)](https://github.com/botnick/telegram-media-downloader/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?logo=docker&logoColor=white)](https://github.com/botnick/telegram-media-downloader/pkgs/container/telegram-media-downloader)

**Self-hosted Telegram media downloader. CLI + dashboard. MIT, no quotas.**

A complete replacement for the commercial "Ultra"-tier Telegram downloaders, but free and self-hosted. Bulk-download from channels and groups, paste a `t.me/` link to grab a single message, capture self-destructing media before it expires, archive Stories from any user, and forward downloads to another chat — all from a browser, with a CLI for headless servers.

Built with [GramJS](https://github.com/gram-js/gramjs) (Telegram MTProto User API — not a bot), Express + WebSocket, SQLite, and a vanilla-ES-modules SPA (no bundler, no build step).

> **First time here?** [Quick start](#quick-start) → [Architecture](docs/ARCHITECTURE.md) → [API reference](docs/API.md) → [Deploy](docs/DEPLOY.md) → [Troubleshooting](docs/TROUBLESHOOTING.md) → [Audit](docs/AUDIT.md)

---

## Table of Contents

- [Why Telegram Media Downloader](#why-telegram-media-downloader)
- [Key Features](#key-features)
- [Architecture Overview](#architecture-overview)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
  - [Docker (Recommended)](#option-a-docker-recommended)
  - [Manual Installation (Node.js)](#option-b-manual-installation-nodejs)
- [CLI Command Reference](#cli-command-reference)
- [Web Dashboard](#web-dashboard)
- [Configuration Reference](#configuration-reference)
  - [Global Settings](#global-settings)
  - [Group Configuration](#group-configuration)
  - [Auto-Forward](#auto-forward)
  - [Media Filters](#media-filters)
- [REST API Reference](#rest-api-reference)
- [WebSocket Events](#websocket-events)
- [Download File Structure](#download-file-structure)
- [Data Management and Purge](#data-management-and-purge)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Contributing](#contributing)
- [License](#license)
- [Disclaimer](#disclaimer)

---

## Why this exists

Telegram channels and groups often contain valuable media that you'd like a permanent local copy of. The commercial alternatives charge per file or per account; this is the same feature set, free, and entirely on your hardware.

- **Monitor channels in real-time** and download new media as it appears.
- **Smart multi-account routing** — add as many accounts as you like; the engine discovers which one can read each group automatically.
- **Bulk-backfill history** with date / count filters.
- **Auto-forward** downloaded media to another channel or your Saved Messages.
- **Self-host everything**, including a polished web dashboard. No data leaves your machine.

Because we use the **User API**, we can read any chat your account can read — public channels, private groups, supergroups, forum topics, even DMs (opt-in).

## Feature matrix vs. the paid alternatives

| Capability                                          | This project | Xinomo "Ultra" tier | vinodkr494 (open-source) |
| --- | :---: | :---: | :---: |
| Bulk download from channels / groups                | ✅           | ✅                 | ✅ |
| Download by `t.me/` link (single message)           | ✅           | ✅                 | ❌ |
| Story download (by username + contacts)             | ✅           | ✅                 | ❌ |
| Private DM download (opt-in)                        | ✅           | ✅                 | ❌ |
| Self-destructing / TTL message capture              | ✅           | ✅                 | ❌ |
| Forum-topic filter                                  | ✅           | ❌ (no granular)   | ✅ |
| SOCKS / MTProxy support                             | ✅           | ❌                 | ✅ |
| Multi-account                                       | ✅ unlimited | ✅ Ultra: unlimited | ✅ |
| Web-based account login (phone → OTP → 2FA)         | ✅           | ✅                 | ❌ (Qt desktop) |
| Light / dark / auto theme                           | ✅           | ✅                 | ✅ |
| Live engine status, queue, multi-select, search     | ✅           | ✅                 | ✅ (desktop) |
| Self-hosted, full data ownership                    | ✅           | ❌                 | ✅ |
| Quota                                               | None         | 300 / 1.8k / ∞ /mo | None |
| Price                                               | $0           | $$                 | $0 |

---

## Key Features

### 🚀 Advanced Multi-Account System
- **Unlimited Login Sessions:** Authenticate as many Telegram accounts/phone numbers as you need.
- **Smart Auto-Discovery:** When monitoring starts, the engine tests all available accounts against your target groups. It automatically maps the correct account to each group without manual configuration.
- **Per-Group Accounts:** Dedicate specific accounts for downloading from high-volume groups, and a completely different account for auto-forwarding files to avoid rate limits.
- **Encrypted Storage:** All sessions are securely encrypted via AES-256 before being saved to disk.

### Download Engine
- **Real-time Monitoring** -- Watches configured channels and groups for new media and downloads automatically.
- **History Download** -- Batch download past messages with date range and message count filters.
- **Resumable Downloads** -- Tracks every download in SQLite to prevent duplicates and save bandwidth.
- **Concurrent Workers** -- Configurable parallel download workers (1-20) with auto-scaling for optimal speed.
- **Rate Limit Handling** -- Automatically pauses and retries when Telegram sends FloodWait errors.
- **Auto-Reconnect** -- Resilient connection management with automatic reconnection on network loss.
- **Speed Limiting** -- Optional bandwidth throttling to avoid overloading your connection.
- **Disk Management** -- Set maximum total disk usage, per-video size limits, and per-image size limits.

### Supported Media Types
- **Photos** -- JPEG, PNG, WebP, and other image formats.
- **Videos** -- MP4, MKV, AVI, MOV, and other video formats including large files.
- **Documents** -- PDFs, ZIPs, archives, spreadsheets, and any file type shared in channels.
- **Voice Messages and Audio** -- OGG, MP3, M4A, WAV, and other audio formats.
- **GIFs** -- Animated GIFs and MP4 animations.
- **Stickers** -- WebP sticker files from sticker packs (opt-in per group).
- **Links** -- URL extraction and metadata collection.

### Web Dashboard
- **Modern Responsive UI** -- Telegram-themed interface built with ES Modules and Tailwind CSS.
- **Media Gallery** -- Grid view with lazy loading, infinite scroll, supporting thousands of files.
- **Built-in Video Player** -- Watch videos directly in the browser with resume position memory.
- **Group Management** -- Toggle monitoring, configure filters, and manage settings per group.
- **Auto-Forward** -- Forward downloaded media to another channel, group, or Saved Messages.
- **Real-time Stats** -- Live download statistics, disk usage, and file counts via WebSocket.
- **Settings Panel** -- Full system configuration through the browser.
- **Data Management** -- Per-group and full-system purge for cleanup (Danger Zone).
- **Password Protection** -- Optional authentication for the web interface.

### CLI Interface
- **Interactive Menus** -- Arrow-key navigation with visual feedback for all configurations.
- **History Download** -- Batch download past messages with date range and message limit filters.
- **Group Configuration** -- Enable/disable groups, set media filters, and configure auto-forward.
- **System Settings** -- Adjust download speed, concurrency, rate limits, and disk management.
- **Statistics Viewer** -- View per-group download counts, total sizes, and file breakdowns.
- **Purge Command** -- Delete group data or factory reset from the command line.

---

## Architecture Overview

```
telegram-media-downloader/
|
|-- src/index.js              # CLI entry point and command router
|-- src/core/
|   |-- monitor.js            # Real-time message listener (MTProto events + polling)
|   |-- downloader.js         # Download engine with concurrency, retry, and progress
|   |-- history.js            # History batch download manager
|   |-- db.js                 # SQLite database (downloads, queue, group_name tracking)
|   |-- forwarder.js          # Auto-forward engine
|   |-- connection.js         # Telegram connection manager with auto-reconnect
|   |-- resilience.js         # Error handling and retry logic
|   |-- security.js           # Authentication, rate limiting, session encryption
|   |-- secret.js             # Encryption key generation
|   |-- accounts.js           # Multi-account support
|   |-- bot.js                # Bot integration
|   `-- logger.js             # Structured logging
|
|-- src/web/
|   |-- server.js             # Express + WebSocket server with REST API
|   `-- public/               # Frontend assets (SPA)
|       |-- index.html         # Single-page application shell
|       `-- js/
|           |-- app.js         # Main application logic and UI rendering
|           |-- viewer.js      # Media viewer with zoom, pan, and video player
|           |-- settings.js    # Settings management
|           |-- store.js       # Centralized state management
|           |-- api.js         # HTTP/REST client wrapper
|           `-- utils.js       # Shared utility functions
|
|-- data/
|   |-- config.json           # All application settings
|   |-- db.sqlite             # SQLite database (downloads, queue)
|   |-- secret.key            # Encryption key (auto-generated)
|   |-- downloads/            # Downloaded media organized by group and type
|   `-- photos/               # Cached Telegram profile photos
|
|-- Dockerfile                # Container build configuration
|-- docker-compose.yml        # Container orchestration
|-- runner.js                 # Production process manager with watchdog
`-- package.json              # Dependencies and npm scripts
```

---

## Requirements

| Requirement | Version | Notes |
|:---|:---|:---|
| Node.js | >= 18.0.0 | Required for ES Module support and native fetch |
| npm | >= 8.0.0 | Comes with Node.js |
| Telegram API Credentials | -- | Get from https://my.telegram.org (free) |
| Docker (optional) | >= 20.0.0 | For containerized deployment |
| Docker Compose (optional) | >= 2.0.0 | For container orchestration |

---

## Quick Start

### Option A: Docker (Recommended)

The easiest way to deploy. Handles all dependencies automatically.

**1. Clone the repository:**
```bash
git clone https://github.com/botnick/telegram-media-downloader.git
cd telegram-media-downloader
```

**2. Start the application:**
```bash
docker-compose up -d
```

**3. First Run -- Telegram Login:**

Attach to the container to complete the interactive login:
```bash
docker-compose run telegram-downloader npm start
```
Follow the prompts to enter your API ID, API Hash, and phone number. Once authenticated, exit the temporary container.

**4. Access the Dashboard:**

Open `http://localhost:3000` in your browser.

### Option B: Manual Installation (Node.js)

**1. Clone and install:**
```bash
git clone https://github.com/botnick/telegram-media-downloader.git
cd telegram-media-downloader
npm install
```

**2. Initial setup and Telegram login:**
```bash
npm start
```
Follow the interactive prompts to enter your API credentials and authenticate with your phone number.

**3. Start the Web Dashboard:**
```bash
node src/index.js web
```
Access at `http://localhost:3000`.

**4. Start headless monitoring (for servers):**
```bash
npm run monitor
```

**5. Production mode with auto-restart watchdog:**
```bash
npm run prod
```

---

## CLI Command Reference

All commands are run via `node src/index.js [command]` or the corresponding npm scripts.

| Command | npm Script | Description |
|:---|:---|:---|
| `(none)` | `npm start` | Interactive main menu with access to all features. |
| `monitor` | `npm run monitor` | Start headless real-time monitoring. Ideal for servers and background processes. |
| `history` | `npm run history` | Download past messages from a group with date range and message count filters. |
| `dialogs` | `npm run dialogs` | List all available groups, channels, and their Telegram IDs. |
| `config` | -- | Interactive group configuration: enable/disable monitoring, set filters, configure auto-forward. |
| `settings` | -- | System settings: download speed, concurrency, rate limits, disk management. |
| `viewer` | -- | View download statistics by group: file counts, total sizes, breakdown by type. |
| `auth` | `npm run auth` | Enable or disable password protection for the Web Dashboard. |
| `web` | `npm run web` | Start the Web GUI server on port 3000. |
| `purge` | -- | Delete data for a specific group or factory reset all data. |
| `migrate` | `npm run migrate` | Import legacy JSON download logs into the SQLite database. |

### CLI Usage Examples

**Download history from a channel:**
```bash
npm run history
# Select group -> Select media types -> Choose "Last 1000 messages" or "Custom Date"
```

**Configure download speed limit:**
```bash
node src/index.js settings
# Select "Max Download Speed" -> Choose "5 MB/s" or enter custom value
```

**Secure the Web Dashboard:**
```bash
npm run auth
# Choose "Enable Security" -> Set a password
```

**List all Telegram groups and channels:**
```bash
npm run dialogs
# Displays group name, type, member count, and Telegram ID
```

**Delete a group or all data:**
```bash
node src/index.js purge
# Select a group to delete, or "DELETE ALL DATA" for factory reset
```

---

## Web Dashboard

The Web Dashboard provides a full-featured interface for managing downloads, browsing media, and configuring every aspect of the downloader.

### Pages

| Page | Description |
|:---|:---|
| Viewer | Browse downloaded media with grid layout, infinite scroll, and filtering by type (photos, videos, documents, audio). Click any item to open the full-screen viewer. |
| Groups | Configure group monitoring, media type filters, user tracking, topic filters, and auto-forward settings. Add new groups by Telegram ID. |
| Settings | Adjust all system settings: download speed, concurrency, disk limits, quick presets, and the Danger Zone for data purge. |

### Dashboard Features

- **Media Viewer** -- Click any image or video to open the full-screen viewer with zoom, pan, and keyboard navigation.
- **Video Resume** -- The player remembers where you stopped watching and resumes from that position.
- **Type Filtering** -- Filter the gallery by All, Photos, Videos, Files, or Audio.
- **Group Sidebar** -- Shows all downloaded groups with file counts, total size, and profile photos. Hover to reveal delete button.
- **Real-time Updates** -- WebSocket connection provides live progress updates during downloads.
- **Danger Zone** -- Purge individual groups or all data from the Settings page with confirmation dialogs.

---

## Configuration Reference

All settings are stored in `data/config.json`. You can modify them through:
1. **Web Dashboard** -- Settings page in the browser.
2. **CLI** -- Interactive menus via `node src/index.js settings` or `node src/index.js config`.
3. **Manual Editing** -- Edit `data/config.json` directly (restart required).

### Global Settings

| Section | Key | Type | Default | Description |
|:---|:---|:---|:---|:---|
| `telegram` | `apiId` | string | -- | Telegram API ID from https://my.telegram.org |
| `telegram` | `apiHash` | string | -- | Telegram API Hash from https://my.telegram.org |
| `telegram` | `phoneNumber` | string | -- | Phone number with country code (e.g., +66812345678) |
| `download` | `concurrent` | number | `3` | Number of simultaneous download workers (1-20) |
| `download` | `retries` | number | `5` | Maximum retry attempts per failed download |
| `download` | `maxSpeed` | number | `0` | Bandwidth limit in bytes/sec. `0` means unlimited |
| `download` | `path` | string | `./data/downloads` | Base directory for downloaded files |
| `rateLimits` | `requestsPerMinute` | number | `15` | API request rate limit. Keep below 20 to avoid FloodWait |
| `pollingInterval` | -- | number | `10` | Seconds between polling cycles for new messages |
| `diskManagement` | `maxTotalSize` | string | `null` | Maximum total disk usage (e.g., "50GB", "1TB"). `null` means unlimited |
| `diskManagement` | `maxVideoSize` | string | `null` | Maximum size per video file (e.g., "1GB"). Files exceeding this are skipped |
| `diskManagement` | `maxImageSize` | string | `null` | Maximum size per image file (e.g., "100MB") |

### Group Configuration

Each group in `config.groups` supports the following structure:

```json
{
  "id": "-1001234567890",
  "name": "Channel Name",
  "enabled": true,
  "filters": {
    "photos": true,
    "videos": true,
    "files": true,
    "links": true,
    "voice": false,
    "gifs": false,
    "stickers": false
  },
  "autoForward": {
    "enabled": false,
    "destination": null,
    "deleteAfterForward": false
  }
}
```

### Auto-Forward

The auto-forward feature automatically forwards downloaded media to another Telegram channel, group, or your Saved Messages.

| Field | Type | Description |
|:---|:---|:---|
| `enabled` | boolean | Enable or disable auto-forwarding for this group |
| `destination` | string or null | Target: `"me"` for Saved Messages, channel ID as string, or `null` for the configured storage channel |
| `deleteAfterForward` | boolean | Delete the local file after successful forward |

### Media Filters

Each group supports independent media type filters:

| Filter Key | Media Type | Default | Description |
|:---|:---|:---|:---|
| `photos` | JPEG, PNG, WebP | `true` | Download photo messages |
| `videos` | MP4, MKV, AVI | `true` | Download video messages |
| `files` | PDF, ZIP, documents | `true` | Download file and document messages |
| `links` | URLs | `true` | Extract and save URLs from text messages |
| `voice` | OGG, MP3 | `false` | Download voice messages and audio |
| `gifs` | GIF, MP4 animations | `false` | Download animated GIFs |
| `stickers` | WebP | `false` | Download sticker files |

---

## REST API Reference

The Web Dashboard communicates with the server through a REST API served at `http://localhost:3000`.

### Authentication Endpoints

| Method | Endpoint | Request Body | Description |
|:---|:---|:---|:---|
| POST | `/api/login` | `{ "password": "..." }` | Authenticate with password |
| POST | `/api/logout` | -- | End the current session |

### Group Endpoints

| Method | Endpoint | Description |
|:---|:---|:---|
| GET | `/api/groups` | List all configured groups with filters, auto-forward settings, and enabled state |
| PUT | `/api/groups/:id` | Update group configuration (filters, auto-forward, enabled state) |
| DELETE | `/api/groups/:id/purge` | Permanently delete all data for a group: files on disk, database records, config entry, and profile photo |

### Download Endpoints

| Method | Endpoint | Query Parameters | Description |
|:---|:---|:---|:---|
| GET | `/api/downloads` | -- | Aggregate download statistics by group (file count, total size, group name) |
| GET | `/api/downloads/:groupId` | `page`, `limit`, `type` | List downloaded files with pagination and optional type filter |
| DELETE | `/api/file` | `path` | Delete a single downloaded file from disk |

### System Endpoints

| Method | Endpoint | Description |
|:---|:---|:---|
| GET | `/api/config` | Read system configuration (sensitive fields like API Hash are stripped) |
| POST | `/api/config` | Update system configuration |
| GET | `/api/stats` | Get system statistics: total files, total size, disk usage |
| GET | `/api/dialogs` | List all Telegram groups and channels visible to the authenticated user |
| DELETE | `/api/purge/all` | Factory reset: delete all files, database records, group configurations, and profile photos |

### Static File Endpoints

| Method | Endpoint | Description |
|:---|:---|:---|
| GET | `/files/:path` | Serve a downloaded file (images, videos, documents) |
| GET | `/photos/:id.jpg` | Serve a cached group or channel profile photo |

---

## WebSocket Events

Connect to `ws://localhost:3000` for real-time event streaming.

| Event Type | Payload | Description |
|:---|:---|:---|
| `download_progress` | `{ groupId, fileName, progress }` | File download progress percentage update |
| `download_complete` | `{ groupId, fileName, fileSize }` | File download completed successfully |
| `file_deleted` | `{ path }` | A file was deleted from disk |
| `group_purged` | `{ groupId }` | All data for a group was purged |
| `purge_all` | `{}` | All application data was purged (factory reset) |

---

## Download File Structure

Downloaded files are organized automatically by group name and media type:

```
data/downloads/
|-- channel-name/
|   |-- images/
|   |   |-- 2026-01-15T10-30-00_12345.jpg
|   |   `-- 2026-01-15T10-31-00_12346.png
|   |-- videos/
|   |   `-- 2026-01-15T10-32-00_12347.mp4
|   |-- documents/
|   |   `-- 2026-01-15T10-33-00_12348.pdf
|   |-- audio/
|   |   `-- 2026-01-15T10-34-00_12349.ogg
|   `-- stickers/
|       `-- 2026-01-15T10-35-00_12350.webp
|
`-- another-channel/
    |-- images/
    `-- videos/
```

File naming convention: `{ISO-timestamp}_{telegram-message-id}.{extension}`

---

## Data Management and Purge

The downloader includes a purge system for cleaning up downloaded data. Purge operations are available from both the Web Dashboard and the CLI.

### Per-Group Purge

Deletes all data associated with a specific group:
- Downloaded files on disk (the entire group folder)
- Database records (downloads and queue tables)
- Group configuration entry
- Cached profile photo

**Web Dashboard:** Hover over a group in the sidebar and click the delete button, or use `DELETE /api/groups/:id/purge`.

**CLI:** Run `node src/index.js purge` and select the group to delete.

### Factory Reset (Purge All)

Deletes all application data:
- All download folders and files
- All database records
- All group configurations
- All cached profile photos

**Web Dashboard:** Go to Settings, scroll to the Danger Zone section, and click "Purge All Data".

**CLI:** Run `node src/index.js purge` and select "DELETE ALL DATA".

---

## Security

### Session Encryption
- A unique `data/secret.key` is generated automatically on first launch.
- The Telegram session is encrypted with AES-256-CBC using this key.
- Back up `secret.key` if you move your installation. Without it, the session cannot be decrypted and you will need to re-authenticate.

### Web Dashboard Authentication
- Password protection is optional and can be enabled via `npm run auth` or the CLI.
- Passwords are hashed with SHA-256 before storage.
- Session cookies are used for browser authentication.
- Sensitive fields (API Hash, passwords) are stripped from all API responses.

### Production Best Practices
- Do not expose port 3000 to the public internet without authentication enabled.
- Use a reverse proxy (nginx, Caddy, Traefik) with HTTPS/TLS for production deployments.
- Keep `data/secret.key` and `data/config.json` out of version control.
- Consider running behind a firewall and whitelisting only trusted IPs.

---

## Troubleshooting

### Session Expired (403 or 401 Errors)

**Cause:** Your Telegram session has expired or become invalid.

**Solution:** Re-authenticate by running `npm start`. For Docker deployments:
```bash
docker-compose run telegram-downloader npm start
```

### FloodWait Errors

**Cause:** Telegram is rate-limiting your requests because too many API calls were made in a short period.

**Solution:** The application handles FloodWait automatically by pausing for the required duration. Do not restart the application repeatedly. If FloodWait occurs frequently, lower your `concurrent` and `requestsPerMinute` settings.

### Docker Permission Issues

**Cause:** The container cannot write to the mounted `data/` directory.

**Solution:** Ensure the directory is owned by the correct user:
```bash
chown -R 1000:1000 data
```

### Database Locked

**Cause:** Multiple instances are trying to access the SQLite database simultaneously.

**Solution:** Ensure only one instance (CLI or Web) is running at a time. For production, use `runner.js` which manages a single process with automatic restart.

### Downloads Not Starting

**Cause:** The group is not configured or monitoring is disabled for that group.

**Solution:**
1. Run `node src/index.js config` and verify the group is enabled.
2. Check that the media type filters allow the file types you expect to download.
3. Check the console output for error messages or FloodWait warnings.

### Web Dashboard Shows 0 Files

**Cause:** Browser cache or outdated client-side JavaScript.

**Solution:** Hard refresh the browser with Ctrl+Shift+R (Windows/Linux) or Cmd+Shift+R (macOS) to reload the latest JavaScript.

### Group Name Shows as ID Number

**Cause:** The group was downloaded before the group name tracking feature was added.

**Solution:** Restart the web server or CLI. On startup, the application automatically backfills group names from your configuration into existing database records.

---

## FAQ

**Q: How do I get Telegram API credentials?**

A: Visit https://my.telegram.org, sign in with your phone number, go to "API development tools", and create a new application. You will receive an API ID (number) and API Hash (string). Both are free.

**Q: Is this a Telegram Bot?**

A: No. This tool uses the Telegram User API (MTProto protocol) via GramJS. It authenticates as your user account, not as a bot. No bot token is required.

**Q: Can I monitor private channels and groups?**

A: Yes, as long as your Telegram account is a member of the channel or group.

**Q: How much disk space does it use?**

A: It depends on the channels you monitor and the media types you download. Use the `diskManagement.maxTotalSize` setting to set a hard limit (e.g., "50GB" or "1TB"). The dashboard shows real-time disk usage.

**Q: Can I run this on a VPS or cloud server?**

A: Yes. Use Docker Compose or the `npm run prod` command with the built-in watchdog for automatic restarts. Consider running behind a reverse proxy (nginx, Caddy) with HTTPS for secure remote access.

**Q: Does it download old messages or only new ones?**

A: The `monitor` command watches for new messages in real-time. To download past messages, use the `history` command which supports date ranges, message count limits, and per-group media type filters.

**Q: Can I forward downloaded media to another channel automatically?**

A: Yes. Configure Auto-Forward in the group settings through the Web Dashboard or CLI. You can forward to Saved Messages (`"me"`), a specific channel or group (by ID), or a configured storage channel.

**Q: Can I delete all data and start fresh?**

A: Yes. Use the purge feature from the Web Dashboard (Settings > Danger Zone) or the CLI (`node src/index.js purge`). Per-group deletion and full factory reset are both supported.

**Q: Will my Telegram account get banned?**

A: The tool includes built-in rate limiting, FloodWait handling, and human-like delays to minimize risk. However, using any unofficial Telegram client carries some risk. Follow the recommended rate limit settings and avoid downloading from too many groups simultaneously.

---

## Contributing

Contributions are welcome. Please follow these guidelines:

1. Fork the repository and create a feature branch.
2. Follow the existing code style: ES Modules, functional patterns, camelCase naming.
3. Test your changes thoroughly before submitting.
4. Submit a pull request with a clear description of what your changes do and why.

---

## License

This project is licensed under the [MIT License](https://opensource.org/licenses/MIT).

---

## Disclaimer

This tool is intended for personal use, archival purposes, and educational reference only. Users are solely responsible for complying with Telegram's Terms of Service and all applicable copyright and data protection laws in their jurisdiction. The authors and contributors are not responsible for any misuse of this software.
