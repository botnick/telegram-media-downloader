---
title: "Documentation"
description: "Documentation for Telegram Media Downloader: a self-hosted Telegram channel and group media downloader with a web dashboard, Docker images and an optional Go engine."
nav_order: 1
permalink: /docs/
---

# Documentation

The Go branch uses [DEPLOY.md](DEPLOY.md), [ARCHITECTURE.md](ARCHITECTURE.md)
and [GO-MIGRATION-STATUS.md](GO-MIGRATION-STATUS.md). Older feature guides describe
the released application; optional features are not all available in this branch.

Guides for [Telegram Media Downloader](https://github.com/botnick/telegram-media-downloader), a self-hosted tool that downloads and archives Telegram channel, group and DM media through a web dashboard. New here? Start with the [Docker quick start](https://github.com/botnick/telegram-media-downloader#quick-start) and [DEPLOY.md](DEPLOY.md).

| Guide | What it covers |
|---|---|
| [DEPLOY.md](DEPLOY.md) | Docker / bare-metal install, reverse proxies, split-disk setups, environment variables |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Common errors and how to fix them |
| [AI.md](AI.md) | Face clustering and NSFW review, the sidecars (local, Docker profile, external GPU host) |
| [BACKUP.md](BACKUP.md) | Backup destinations (S3, SFTP, FTP, Google Drive, Dropbox, local), mirror vs snapshot |
| [CLUSTER.md](CLUSTER.md) | Pairing several instances into a federated library |
| [API.md](API.md) | HTTP + WebSocket API reference |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the pieces fit together — for contributors |
| [GO-MIGRATION-STATUS.md](GO-MIGRATION-STATUS.md) | Current scope, verified native/browser behavior and remaining work |
| [GO-MIGRATION.md](GO-MIGRATION.md) | Historical design and data-compatibility considerations |
| [AUDIT.md](AUDIT.md) | Security / reliability audit notes |
| [MIGRATION-v2.9-to-v2.10.md](MIGRATION-v2.9-to-v2.10.md) | Upgrade notes for that release |

Release notes: [CHANGELOG.md](https://github.com/botnick/telegram-media-downloader/blob/main/CHANGELOG.md) (also shown in the dashboard — click the version in the status bar) and [GitHub Releases](https://github.com/botnick/telegram-media-downloader/releases).

## Components and releases

| Component | Tag | Artifacts |
|---|---|---|
| App (`tgdl-server`) | `vX.Y.Z` | Native archives + SHA-256 checksums; Docker image after candidate smoke checks |
| faces-service | `faces-vX.Y.Z` | binaries for Windows / Linux / macOS, `ghcr.io/botnick/tgdl-faces` |
| nsfw-service | `nsfw-vX.Y.Z` | `ghcr.io/botnick/tgdl-nsfw` (CPU and `gpu-` tags) |
| seekbar-service | `seekbar-vX.Y.Z` | binaries for Windows / Linux / macOS (downloaded by the app on first use) |

A sidecar release always ships before an app release that depends on it, so updating the app never points at a sidecar version that doesn't exist yet.
