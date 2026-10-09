---
title: "Developer notes"
description: "Engineering notes from the Telegram Media Downloader 3.0 Go migration: design, acceptance evidence, per-feature behaviour and historical audits."
nav_order: 8
has_children: true
---

# Developer notes

These pages were written while the backend moved from Node.js to Go. They
record design decisions, edge cases and test evidence for contributors. Some
describe intermediate states of the migration; for how 3.0 behaves today, start
with the user guides: [Install and deploy](DEPLOY.md),
[Configuration](CONFIGURATION.md), [Features](FEATURES.md) and
[Architecture](ARCHITECTURE.md).

| Note | Topic |
|---|---|
| [Go migration status](GO-MIGRATION-STATUS.md) | Scope, packaging checks and test evidence gathered before the 3.0 release |
| [Go migration plan](GO-MIGRATION.md) | Original cutover design and compatibility rules |
| [Core delivery verification](GO-CORE-ACCEPTANCE.md) | Acceptance table for downloads, dedup, queue and access control |
| [tgdl-core (2.x companion)](GO-CORE.md) | The 2.x Go helper binary that 3.0 replaced |
| [Backups](GO-BACKUP.md) | Transport details, TGDB archives, crash recovery |
| [Cluster](GO-CLUSTER.md) | Pairing, catalog sync and media proxy internals |
| [Dialogs](GO-DIALOGS.md) | Chat list pagination |
| [History jobs](GO-HISTORY.md) | Backfill semantics, bounds and resumption |
| [HTTP policy](GO-HTTP-SECURITY.md) | Proxy trust, HTTPS, CSP, quotas and compression |
| [Monitor maintenance](GO-MONITOR-MAINTENANCE.md) | Dialog resync, monitor restart, group refresh |
| [Proxies](GO-PROXIES.md) | Telegram proxy routing |
| [Purge](GO-PURGE.md) | Group purge, delete-files and factory reset |
| [Recovery](GO-RECOVERY.md) | Maintenance recovery page |
| [Rescue mode](GO-RESCUE.md) | Retention and source-deletion handling |
| [Stories](GO-STORIES.md) | Stories and the proxy probe |
| [Message links](GO-URL-DOWNLOADS.md) | `t.me` link downloads |
| [Sessions and WebSockets](GO-WEBSOCKET-SESSIONS.md) | Dashboard session revocation |
| [Audit (v2.0)](AUDIT.md) | Security and reliability audit frozen at v2.0 |
| [Cluster v2.9 → v2.10](MIGRATION-v2.9-to-v2.10.md) | Re-pairing peers after the 2.10 token change |
