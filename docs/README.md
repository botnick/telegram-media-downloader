---
title: "Documentation"
description: "Documentation for Telegram Media Downloader 3.0, a self-hosted Telegram channel and group media downloader: one Go binary or Docker image with a web dashboard."
nav_order: 1
permalink: /docs/
---

# Documentation

Telegram Media Downloader is a self-hosted web app that downloads and backs up
media from Telegram channels, groups and private chats using your own account.
Version 3.0 is a single Go program, `tgdl-server`, with the dashboard built in.
Run it with Docker or as a native binary on Linux, Windows or macOS.

## Get started

| Page | Read it when you want to |
|---|---|
| [Install and deploy](DEPLOY.md) | Install with Docker Compose, a release binary or a git checkout; set the first password; add a reverse proxy; update |
| [Upgrading from 2.x](UPGRADING.md) | Move an existing 2.x install to 3.0, see what changed, roll back |
| [Configuration](CONFIGURATION.md) | Look up dashboard settings, environment variables and the data folder layout |
| [Troubleshooting](TROUBLESHOOTING.md) | Fix a problem with start-up, sign-in, Telegram accounts, downloads or updates |

## Features

| Page | Covers |
|---|---|
| [Features](FEATURES.md) | Everything 3.0 does, and what is not in 3.0 yet |
| [Backup](BACKUP.md) | Local, S3, SFTP and FTP/FTPS backups, encryption, offline restore |
| [Cluster mode](CLUSTER.md) | Pair several instances into one library |
| [AI: faces, NSFW and previews](AI.md) | What remains of the AI tools in 3.0 |
| [API reference](API.md) | HTTP and WebSocket endpoints |

## Under the hood

| Page | Covers |
|---|---|
| [Architecture](ARCHITECTURE.md) | How the Go server, queue, storage and dashboard fit together |
| [Developer notes](DEVELOPER-NOTES.md) | Engineering notes from the Go migration and older audits |
| [Contributing](https://github.com/botnick/telegram-media-downloader/blob/main/CONTRIBUTING.md) | Build, test and send a pull request |
| [Security policy](https://github.com/botnick/telegram-media-downloader/blob/main/SECURITY.md) | Report a vulnerability |
| [Changelog](https://github.com/botnick/telegram-media-downloader/blob/main/CHANGELOG.md) | Release notes |

AI assistants can use [`llms.txt`](https://botnick.github.io/telegram-media-downloader/llms.txt), a short curated index of these
pages.
