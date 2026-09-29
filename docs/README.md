# Documentation

| Guide | What it covers |
|---|---|
| [DEPLOY.md](DEPLOY.md) | Docker / bare-metal install, reverse proxies, split-disk setups, environment variables |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Common errors and how to fix them |
| [AI.md](AI.md) | Face clustering and NSFW review, the sidecars (local, Docker profile, external GPU host) |
| [BACKUP.md](BACKUP.md) | Backup destinations (S3, SFTP, FTP, Google Drive, Dropbox, local), mirror vs snapshot |
| [CLUSTER.md](CLUSTER.md) | Pairing several instances into a federated library |
| [API.md](API.md) | HTTP + WebSocket API reference |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the pieces fit together — for contributors |
| [GO-CORE.md](GO-CORE.md) | `tgdl-core`, the app's Go engine: what it does, how it is installed and supervised, how parity is proven, roadmap |
| [GO-MIGRATION.md](GO-MIGRATION.md) | The plan for a pure-Go backend: waves, the API contract gate, data-compatibility rules |
| [AUDIT.md](AUDIT.md) | Security / reliability audit notes |
| [MIGRATION-v2.9-to-v2.10.md](MIGRATION-v2.9-to-v2.10.md) | Upgrade notes for that release |

Release notes: [CHANGELOG.md](../CHANGELOG.md) (also shown in the dashboard — click the version in the status bar) and [GitHub Releases](https://github.com/botnick/telegram-media-downloader/releases).

## Components and releases

| Component | Tag | Artifacts |
|---|---|---|
| App (dashboard + downloader) | `vX.Y.Z` | `ghcr.io/botnick/telegram-media-downloader` |
| faces-service | `faces-vX.Y.Z` | binaries for Windows / Linux / macOS, `ghcr.io/botnick/tgdl-faces` |
| nsfw-service | `nsfw-vX.Y.Z` | `ghcr.io/botnick/tgdl-nsfw` (CPU and `gpu-` tags) |
| seekbar-service | `seekbar-vX.Y.Z` | binaries for Windows / Linux / macOS (downloaded by the app on first use) |
| core-service (`tgdl-core`) | `core-vX.Y.Z` | `tgdl-core-<slug>.tar.gz` for Windows / Linux (x64, arm64, ARMv7, x86) / macOS (arm64, x64) + `SHA256SUMS` (downloaded and verified by `npm install` and on startup; built into the Docker image) |

A sidecar release always ships before an app release that depends on it, so updating the app never points at a sidecar version that doesn't exist yet.
