import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { runStateMigration } from './state-migration.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// `TGDL_DATA_DIR` overrides the on-disk data root. Used by the test suite to
// point at an isolated tmpdir so vitest never touches the user's real
// db.sqlite. Docker / multi-instance deploys can also override the location
// without symlinks. Default stays the in-repo `data/` so first-run UX is
// unchanged.
const DATA_DIR = process.env.TGDL_DATA_DIR
    ? path.resolve(process.env.TGDL_DATA_DIR)
    : path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'db.sqlite');

// Singleton connection
let db;
// Run the JSON→SQLite state migration exactly once per process. Cheap to
// re-check (idempotent), but we'd still rather skip the fs.existsSync calls
// on every getDb() once we've done it.
let _stateMigrationRan = false;

export function getDb() {
    if (db) return db;

    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    db = new Database(DB_PATH);

    // Performance tuning
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    // Without busy_timeout, a long write (sweeper bulk delete) makes
    // concurrent readers fail INSTANTLY with SQLITE_BUSY instead of
    // waiting. 5 s gives us plenty of headroom for the longest write
    // we currently issue (rescue sweeper batches 5000 rows).
    db.pragma('busy_timeout = 5000');
    // Tame WAL growth on sustained writes — checkpoint every ~1000 pages.
    db.pragma('wal_autocheckpoint = 1000');
    // Per-connection FK enforcement — required for ON DELETE CASCADE on
    // share_links (and any future FK we add). Set BEFORE initSchema so the
    // first row insert / migration honors it.
    db.pragma('foreign_keys = ON');

    initSchema();

    // Import any legacy JSON state files (config.json / disk_usage.json /
    // web-sessions.json) into the kv + web_sessions tables. Runs once per
    // process, synchronously before we hand the connection back, so the
    // very first kvGet() call sees the migrated rows.
    if (!_stateMigrationRan) {
        _stateMigrationRan = true;
        try {
            runStateMigration({
                db,
                kvGet,
                kvSet,
                insertSession,
                listSessions,
                pushQueueBacklog,
            });
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[state-migration] failed:', e.message);
        }

        // Boot instance ID rotation. A per-process UUIDv4 stamped into
        // kv['boot_instance_id'] on every getDb() bootstrap and snapshotted
        // into update_history rows at click time. Lets the finaliser detect
        // a successful watchtower swap even when the new image carries the
        // same semver as the old one (rebuilt `:latest`, hash-pinned tag) —
        // the instance_id is guaranteed to differ across container recreates.
        try {
            _rotateBootInstanceId();
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[boot-instance-id] rotation failed:', e?.message || e);
        }

        // Auto-update audit finalisation. Walks every `triggered` row and
        // either promotes it to `success` (the running container reports a
        // different version OR a different boot_instance_id than the row's
        // from_* fields → swap landed) or marks it `stalled` (still on the
        // same version + same instance_id, row older than the stall window
        // → watchtower acked but never recreated us). Idempotent; runs
        // once per process boot AND lazily on every status/history GET.
        try {
            const cur = _readPackageVersion();
            const inst = getBootInstanceId();
            const r = finalisePendingUpdates(cur, inst);
            if (r.promoted > 0 || r.stalled > 0) {
                // eslint-disable-next-line no-console
                console.log(
                    `[update-history] finalised ${r.promoted} → success, ${r.stalled} → stalled`,
                );
            }
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[update-history] finalisation failed:', e?.message || e);
        }
    }

    return db;
}

// Resolve the running package version without pulling server.js (would be
// a circular import). Mirrors `_readCurrentVersion` in server.js.
function _readPackageVersion() {
    if (process.env.npm_package_version) return process.env.npm_package_version;
    try {
        const pkgPath = path.join(__dirname, '..', '..', 'package.json');
        return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || null;
    } catch {
        return null;
    }
}

function initSchema() {
    // Downloads Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS downloads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL,
            group_name TEXT,
            message_id INTEGER NOT NULL,
            file_name TEXT,
            file_size INTEGER,
            file_type TEXT, -- photo, video, document
            file_path TEXT,
            status TEXT DEFAULT 'completed',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(group_id, message_id)
        );
        CREATE INDEX IF NOT EXISTS idx_group_id ON downloads(group_id);
        CREATE INDEX IF NOT EXISTS idx_created_at ON downloads(created_at);
    `);

    // Forward-compatible column migrations. Each ALTER is wrapped in its own
    // try/catch so adding column N+1 doesn't get blocked by column N already
    // existing.
    const migrations = [
        'ALTER TABLE downloads ADD COLUMN group_name TEXT',
        'ALTER TABLE downloads ADD COLUMN ttl_seconds INTEGER',
        'ALTER TABLE downloads ADD COLUMN file_hash TEXT',
        // pinned: rows with pinned=1 are protected from auto-rotation sweeps.
        'ALTER TABLE downloads ADD COLUMN pinned INTEGER DEFAULT 0',
        // Rescue Mode: rows with a non-null pending_until are auto-pruned by
        // the rescue sweeper after that timestamp UNLESS the source message
        // was deleted on Telegram first (in which case rescued_at gets set
        // and pending_until is cleared, keeping the file forever).
        'ALTER TABLE downloads ADD COLUMN pending_until INTEGER',
        'ALTER TABLE downloads ADD COLUMN rescued_at INTEGER',
        // NSFW review (Phase 1: photos only).
        //   nsfw_score        — REAL 0..1 from the classifier (NULL = never scanned).
        //   nsfw_checked_at   — unix-ms of the last successful classification;
        //                       set even when score is NULL (e.g. file missing on
        //                       disk) so we don't keep retrying forever.
        //   nsfw_whitelist    — admin clicked "Mark as not 18+"; persistent so
        //                       re-scans skip the row and the review sheet
        //                       hides it.
        'ALTER TABLE downloads ADD COLUMN nsfw_score REAL',
        'ALTER TABLE downloads ADD COLUMN nsfw_checked_at INTEGER',
        'ALTER TABLE downloads ADD COLUMN nsfw_whitelist INTEGER DEFAULT 0',
    ];
    for (const sql of migrations) {
        try {
            db.exec(sql);
        } catch {
            /* column already exists */
        }
    }
    try {
        db.exec(
            'CREATE INDEX IF NOT EXISTS idx_filename_size ON downloads(group_id, file_name, file_size)',
        );
    } catch {}
    // Speeds up the rescue sweeper's expired-pending scan and the per-message
    // markRescued lookup. Both are cheap CREATE-IF-NOT-EXISTS calls.
    try {
        db.exec(
            'CREATE INDEX IF NOT EXISTS idx_pending_until ON downloads(pending_until) WHERE pending_until IS NOT NULL',
        );
    } catch {}
    try {
        db.exec('CREATE INDEX IF NOT EXISTS idx_group_message ON downloads(group_id, message_id)');
    } catch {}
    // Indexes that drive the NSFW review sheet's hot queries:
    //   - "what's left to scan" (file_type='photo' AND nsfw_checked_at IS NULL)
    //   - "show flagged sorted by score desc" (whitelist=0 AND score >= threshold)
    try {
        db.exec(
            'CREATE INDEX IF NOT EXISTS idx_nsfw_unscanned ON downloads(file_type, nsfw_checked_at) WHERE nsfw_checked_at IS NULL',
        );
    } catch {}
    try {
        db.exec(
            'CREATE INDEX IF NOT EXISTS idx_nsfw_review ON downloads(nsfw_score, nsfw_whitelist) WHERE nsfw_score IS NOT NULL',
        );
    } catch {}
    // Tier-aware review path — covers the "rows of {file_type} not whitelisted
    // ordered/filtered by nsfw_score" pattern that drives tier counts, the
    // tier-list pagination, and bulk-id resolution. The leftmost column is
    // file_type so the IN-list filter binds an index range, then whitelist=0
    // narrows further, then nsfw_score sorts/ranges. The partial WHERE keeps
    // the index small (rows that have never been scored aren't indexed).
    try {
        db.exec(
            'CREATE INDEX IF NOT EXISTS idx_nsfw_tier ON downloads(file_type, nsfw_whitelist, nsfw_score) WHERE nsfw_score IS NOT NULL',
        );
    } catch {}
    // NSFW hash blocklist — stores SHA-256 fingerprints of files deleted via
    // NSFW review so re-downloads can be auto-deleted without rescanning.
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS nsfw_hash_blocklist (
                file_hash  TEXT    PRIMARY KEY,
                file_name  TEXT,
                deleted_at INTEGER NOT NULL,
                source     TEXT    DEFAULT 'manual'
            )
        `);
    } catch {}
    // v2.15 — AI subsystem re-add (semantic search + auto-tags + face
    // clustering). Tables are opt-in; rows only land here once the operator
    // turns a capability on in `config.advanced.ai` and runs a scan. Every
    // statement is idempotent so a fresh boot, a v2.13/2.14 → v2.15 upgrade,
    // and an already-migrated DB all converge on the same shape.
    db.exec(`
        CREATE TABLE IF NOT EXISTS image_embeddings (
            download_id INTEGER PRIMARY KEY,
            embedding   BLOB    NOT NULL,
            model       TEXT    NOT NULL,
            indexed_at  INTEGER NOT NULL,
            FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS image_tags (
            download_id INTEGER NOT NULL,
            tag         TEXT    NOT NULL,
            score       REAL    NOT NULL,
            PRIMARY KEY (download_id, tag),
            FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_tags_tag_score ON image_tags(tag, score DESC);
        CREATE TABLE IF NOT EXISTS people (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            label              TEXT,
            embedding_centroid BLOB    NOT NULL,
            face_count         INTEGER NOT NULL DEFAULT 0,
            created_at         INTEGER NOT NULL,
            updated_at         INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS faces (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            download_id INTEGER NOT NULL,
            x           REAL    NOT NULL,
            y           REAL    NOT NULL,
            w           REAL    NOT NULL,
            h           REAL    NOT NULL,
            embedding   BLOB    NOT NULL,
            person_id   INTEGER,
            FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE,
            FOREIGN KEY (person_id)   REFERENCES people(id)    ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_faces_download ON faces(download_id);
        CREATE INDEX IF NOT EXISTS idx_faces_person   ON faces(person_id);
    `);
    try {
        db.exec('ALTER TABLE downloads ADD COLUMN ai_indexed_at INTEGER');
    } catch {
        /* column already present (re-run after v2.13 column drop) */
    }
    try {
        db.exec(
            'CREATE INDEX IF NOT EXISTS idx_ai_unindexed ON downloads(file_type, ai_indexed_at) WHERE ai_indexed_at IS NULL',
        );
    } catch {
        /* index already present */
    }
    // v2.16 — faces.quality_score (Phase 2). Quality filter persists the
    // raw detection score so the UI can show "low confidence" warnings
    // and the operator can sort/filter by face quality if a cluster
    // looks wrong.
    try {
        db.exec('ALTER TABLE faces ADD COLUMN quality_score REAL');
    } catch {
        /* column already present */
    }
    // v2.16 Phase 4 — peer_face_centroids. Stores the
    // average-of-cluster face vectors that paired peers push to us.
    // The label sync flow uses this to match an incoming "Bob" centroid
    // against local clusters within `eps` and propagate the label.
    // Opt-in via `config.advanced.ai.federateFaces`; table is created
    // unconditionally so a future toggle-on doesn't need a migration.
    db.exec(`
        CREATE TABLE IF NOT EXISTS peer_face_centroids (
            peer_id          TEXT    NOT NULL,
            remote_person_id INTEGER NOT NULL,
            centroid         BLOB    NOT NULL,
            label            TEXT,
            face_count       INTEGER NOT NULL DEFAULT 0,
            updated_at       INTEGER NOT NULL,
            PRIMARY KEY (peer_id, remote_person_id)
        );
        CREATE INDEX IF NOT EXISTS idx_peer_face_centroids_label
            ON peer_face_centroids(label) WHERE label IS NOT NULL;
    `);

    // Seekbar sprite cache (v2.17). One row per indexed video; sprite +
    // JSON metadata live on disk under data/seekbar/. Opt-in via
    // config.advanced.seekbar.enabled; rows only appear once the
    // operator turns the feature on and either downloads a new video
    // (auto-pregenerate hook) or runs "Scan now" from the maintenance
    // page. ON DELETE CASCADE so purging a download row removes its
    // sprite metadata in lockstep.
    db.exec(`
        CREATE TABLE IF NOT EXISTS seekbar_sprites (
            download_id   INTEGER PRIMARY KEY,
            sprite_path   TEXT NOT NULL,
            meta_path     TEXT NOT NULL,
            duration_sec  REAL,
            frames        INTEGER,
            cols          INTEGER,
            rows          INTEGER,
            tile_w        INTEGER,
            tile_h        INTEGER,
            interval_sec  REAL,
            format        TEXT,
            bytes         INTEGER,
            source_size   INTEGER,
            source_mtime  INTEGER,
            generated_at  INTEGER NOT NULL,
            FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_seekbar_generated_at ON seekbar_sprites(generated_at);
    `);

    // Smoke-test every column the rest of the code path depends on. The
    // ALTER TABLE migrations above swallow "column already exists" so they
    // also swallow real failures (out-of-disk, locked DB, corrupt schema).
    // A failed migration was previously discovered at query time —
    // halfway through a download — as a generic "no such column" runtime
    // error. Forcing the SELECT here makes us fail at boot instead.
    try {
        db.prepare(
            'SELECT pinned, pending_until, rescued_at, ttl_seconds, file_hash, nsfw_score, nsfw_checked_at, nsfw_whitelist, ai_indexed_at FROM downloads LIMIT 0',
        ).all();
    } catch (e) {
        throw new Error(
            `DB schema migration incomplete — column missing after ALTER TABLE: ${e.message}. Inspect data/db.sqlite or restore from backup.`,
        );
    }

    // Queue/Pending Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL,
            message_id INTEGER NOT NULL,
            meta TEXT, -- JSON payload
            priority INTEGER DEFAULT 0,
            status TEXT DEFAULT 'pending', -- pending, processing, failed
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Share Links — admin-issued tokens that let a non-user (e.g. friend
    // with the URL) stream/download a single download without logging in.
    // The HMAC-signed URL is the cryptographic gate; this table is what
    // makes per-link revocation + audit possible (the row is the source
    // of truth for revoked_at, and the access counters surface usage in
    // the admin "Active share links" sheet).
    //
    // ON DELETE CASCADE on download_id means deleting/purging a file
    // automatically kills every outstanding share link for that file —
    // critical so a revoked file doesn't keep streaming bytes from disk.
    db.exec(`
        CREATE TABLE IF NOT EXISTS share_links (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            download_id      INTEGER NOT NULL,
            created_at       INTEGER NOT NULL,
            expires_at       INTEGER NOT NULL,
            revoked_at       INTEGER,
            label            TEXT,
            last_accessed_at INTEGER,
            access_count     INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_share_links_download ON share_links(download_id);
        CREATE INDEX IF NOT EXISTS idx_share_links_expiry ON share_links(expires_at);
    `);

    // Backup destinations + per-destination job queue. The destination row
    // owns provider config (encrypted at rest by core/backup/credentials.js
    // — config_blob is opaque ciphertext, never plaintext on disk) and the
    // optional encryption salt for client-side AES-256-GCM uploads. Jobs
    // are append-only rows the per-destination worker drains; status flips
    // pending → uploading → done|failed|skipped.
    db.exec(`
        CREATE TABLE IF NOT EXISTS backup_destinations (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            name            TEXT    NOT NULL,
            provider        TEXT    NOT NULL,
            config_blob     BLOB    NOT NULL,
            enabled         INTEGER NOT NULL DEFAULT 1,
            encryption      INTEGER NOT NULL DEFAULT 0,
            encryption_salt BLOB,
            mode            TEXT    NOT NULL DEFAULT 'mirror',
            cron            TEXT,
            retain_count    INTEGER DEFAULT 7,
            last_success_at INTEGER,
            last_failure_at INTEGER,
            last_error      TEXT,
            total_bytes     INTEGER NOT NULL DEFAULT 0,
            total_files     INTEGER NOT NULL DEFAULT 0,
            throttle_bps    INTEGER,
            created_at      INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS backup_jobs (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            destination_id  INTEGER NOT NULL,
            download_id     INTEGER,
            snapshot_path   TEXT,
            status          TEXT    NOT NULL DEFAULT 'pending',
            attempts        INTEGER NOT NULL DEFAULT 0,
            max_attempts    INTEGER NOT NULL DEFAULT 5,
            next_retry_at   INTEGER,
            started_at      INTEGER,
            finished_at     INTEGER,
            bytes_uploaded  INTEGER NOT NULL DEFAULT 0,
            error           TEXT,
            remote_path     TEXT,
            FOREIGN KEY (destination_id) REFERENCES backup_destinations(id) ON DELETE CASCADE,
            FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_backup_jobs_pending ON backup_jobs(destination_id, status, next_retry_at);
        CREATE INDEX IF NOT EXISTS idx_backup_jobs_download ON backup_jobs(download_id);
    `);
    // throttle_bps was added after the initial backup release — wrap the
    // ALTER in try/catch so the column is present on upgrades and the
    // CREATE-IF-NOT-EXISTS path on fresh DBs is unaffected.
    try {
        db.exec('ALTER TABLE backup_destinations ADD COLUMN throttle_bps INTEGER');
    } catch {}

    // Generic KV blob store. Holds runtime state that used to live in
    // standalone JSON files (config.json, disk_usage.json) — single source
    // of truth, atomic writes via SQLite transactions, no fs.watch needed.
    // Keys are arbitrary strings; values are JSON-encoded text.
    db.exec(`
        CREATE TABLE IF NOT EXISTS kv (
            key        TEXT    PRIMARY KEY,
            value      TEXT    NOT NULL,
            updated_at INTEGER NOT NULL
        );
    `);

    // Dashboard session tokens. Replaces data/web-sessions.json so the GC
    // sweep can use an indexed expires_at scan instead of rewriting the
    // whole file every login/logout. Role is constrained — anything other
    // than 'admin' / 'guest' is a programming error and should fail loud.
    db.exec(`
        CREATE TABLE IF NOT EXISTS web_sessions (
            token      TEXT    PRIMARY KEY,
            role       TEXT    NOT NULL CHECK(role IN ('admin','guest')),
            issued_at  INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            last_seen  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_web_sessions_expires ON web_sessions(expires_at);
        CREATE INDEX IF NOT EXISTS idx_web_sessions_role    ON web_sessions(role);
    `);

    // Spilled-queue rows. Replaces data/logs/queue_backlog.jsonl so a hard
    // crash mid-spill can't tear a JSON line, and rehydrate is an indexed
    // SELECT + DELETE instead of a full-file rewrite. Worker pulls FIFO via
    // `ORDER BY id ASC LIMIT N`, deletes the popped rows in the same tx.
    db.exec(`
        CREATE TABLE IF NOT EXISTS queue_backlog (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            job        TEXT    NOT NULL,
            created_at INTEGER NOT NULL
        );
    `);

    // Auto-update audit log. One row per /api/update click. The row is
    // INSERTed when the route hands off to watchtower (status='triggered')
    // and finalised by the new container's boot path once the swap lands
    // — `to_version` is whatever the new container reports as its package
    // version, so the row records the actual transition observed, not
    // just what was requested. Pre-flight failures land directly as
    // status='failed' with the structured error code.
    db.exec(`
        CREATE TABLE IF NOT EXISTS update_history (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            from_version TEXT,
            to_version   TEXT,
            started_at   INTEGER NOT NULL,
            finished_at  INTEGER,
            status       TEXT    NOT NULL DEFAULT 'pending',
            error_code   TEXT,
            error_msg    TEXT,
            backup_path  TEXT,
            backup_bytes INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_update_history_status ON update_history(status, started_at);
    `);
    // Forward-compatible column added in v2.9: per-row snapshot of the
    // boot_instance_id at click time. Lets the boot-time finaliser detect
    // a successful swap even when the new image carries the same semver
    // (rebuilt `:latest` tag), since the instance_id always differs across
    // container recreates.
    try {
        db.exec('ALTER TABLE update_history ADD COLUMN from_instance_id TEXT');
    } catch {
        /* column already exists */
    }

    // Cluster mode (v2.9): peer registry + cached catalogs from remote peers
    // + audit log for cross-peer signed requests. Identity (peer_id,
    // cluster_token, peer_name) lives in `kv` and is bootstrapped on first
    // boot by core/cluster/identity.js.
    //
    // peers — one row per *remote* peer this instance has paired with. The
    //   self peer is NOT in this table (its identity is in `kv`).
    //   `peer_id` is a UUIDv4 generated by the remote peer; `fingerprint`
    //   is hex(sha256(cluster_token + remote_peer_id)) and lets the UI
    //   detect token-mismatch on revisit. `stream_mode` selects how the
    //   bridge serves remote files (proxy-through-self vs 302-direct).
    //
    // peer_downloads — cached mirror of a remote peer's downloads table.
    //   Drives the merged gallery + cross-peer dedup hash lookup. The
    //   sync engine refills it incrementally; cached_at gates staleness.
    //
    // peer_groups / peer_accounts / peer_history — opaque JSON blobs of
    //   the remote peer's tables. We don't query columns inside them, so a
    //   single payload column keeps the schema generic across version
    //   skews between paired peers.
    //
    // cluster_audit — one row per signed request (inbound or outbound)
    //   plus handshake / sweep / dedup-hit lifecycle events. Used by the
    //   Cluster tab to surface auth failures + drift.
    db.exec(`
        CREATE TABLE IF NOT EXISTS peers (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            peer_id      TEXT    NOT NULL UNIQUE,
            name         TEXT    NOT NULL,
            url          TEXT    NOT NULL,
            status       TEXT    NOT NULL DEFAULT 'offline',
            stream_mode  TEXT    NOT NULL DEFAULT 'proxy',
            last_seen_at INTEGER,
            paired_at    INTEGER NOT NULL,
            fingerprint  TEXT    NOT NULL,
            version      TEXT,
            notes        TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_peers_status ON peers(status);

        CREATE TABLE IF NOT EXISTS peer_downloads (
            peer_id     TEXT    NOT NULL,
            remote_id   INTEGER NOT NULL,
            file_path   TEXT    NOT NULL,
            file_name   TEXT,
            file_size   INTEGER,
            file_type   TEXT,
            file_hash   TEXT,
            group_id    TEXT,
            group_name  TEXT,
            message_id  INTEGER,
            created_at  INTEGER,
            status      TEXT,
            nsfw_score  REAL,
            cached_at   INTEGER NOT NULL,
            PRIMARY KEY (peer_id, remote_id)
        );
        CREATE INDEX IF NOT EXISTS idx_peer_downloads_hash    ON peer_downloads(file_hash, file_size);
        CREATE INDEX IF NOT EXISTS idx_peer_downloads_group   ON peer_downloads(group_id);
        CREATE INDEX IF NOT EXISTS idx_peer_downloads_created ON peer_downloads(created_at DESC);

        CREATE TABLE IF NOT EXISTS peer_groups (
            peer_id    TEXT    PRIMARY KEY,
            payload    TEXT    NOT NULL,
            cached_at  INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS peer_accounts (
            peer_id    TEXT    PRIMARY KEY,
            payload    TEXT    NOT NULL,
            cached_at  INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS peer_history (
            peer_id    TEXT    PRIMARY KEY,
            payload    TEXT    NOT NULL,
            cached_at  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS cluster_audit (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            ts      INTEGER NOT NULL,
            peer_id TEXT,
            kind    TEXT    NOT NULL,
            detail  TEXT,
            ok      INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_cluster_audit_ts ON cluster_audit(ts DESC);
    `);
    // Reserved owner column on downloads — null = self peer.
    try {
        db.exec('ALTER TABLE downloads ADD COLUMN owner_peer_id TEXT');
    } catch {}

    // v2.10 cluster columns + tables — per-peer tokens, failover audit,
    // cross-peer-delete jobs, LAN-discovery cache, egress accounting.
    const clusterV210Migrations = [
        'ALTER TABLE peers ADD COLUMN shared_secret BLOB',
        "ALTER TABLE peers ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'",
        'ALTER TABLE peers ADD COLUMN ws_last_seen INTEGER',
    ];
    for (const sql of clusterV210Migrations) {
        try {
            db.exec(sql);
        } catch {
            /* column already present */
        }
    }
    db.exec(`
        CREATE TABLE IF NOT EXISTS peer_failover_log (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id     TEXT    NOT NULL,
            from_peer_id TEXT    NOT NULL,
            to_peer_id   TEXT    NOT NULL,
            reason       TEXT,
            ts           INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_failover_ts ON peer_failover_log(ts DESC);

        CREATE TABLE IF NOT EXISTS peer_delete_jobs (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            peer_id      TEXT    NOT NULL,
            remote_id    INTEGER NOT NULL,
            reason       TEXT,
            status       TEXT    NOT NULL DEFAULT 'pending',
            attempts     INTEGER NOT NULL DEFAULT 0,
            created_at   INTEGER NOT NULL,
            finished_at  INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_pdj_pending ON peer_delete_jobs(status, peer_id);

        CREATE TABLE IF NOT EXISTS peer_discoveries (
            peer_id    TEXT    PRIMARY KEY,
            url        TEXT    NOT NULL,
            name       TEXT,
            version    TEXT,
            source     TEXT    NOT NULL DEFAULT 'broadcast',
            seen_at    INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS cluster_egress_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            peer_id     TEXT,
            bytes       INTEGER NOT NULL,
            served_at   INTEGER NOT NULL,
            from_cache  INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_cluster_egress_time ON cluster_egress_log(served_at);
    `);

    // Smoke-test the new tables the same way we do for downloads: force a
    // SELECT against every column the rest of the code path depends on so
    // a failed CREATE TABLE surfaces at boot, not mid-request.
    try {
        db.prepare('SELECT key, value, updated_at FROM kv LIMIT 0').all();
        db.prepare(
            'SELECT token, role, issued_at, expires_at, last_seen FROM web_sessions LIMIT 0',
        ).all();
        db.prepare('SELECT id, job, created_at FROM queue_backlog LIMIT 0').all();
        db.prepare(
            'SELECT id, from_version, to_version, started_at, finished_at, status, error_code, error_msg, backup_path, backup_bytes FROM update_history LIMIT 0',
        ).all();
        db.prepare(
            'SELECT id, peer_id, name, url, status, stream_mode, last_seen_at, paired_at, fingerprint, version, notes, shared_secret, role, ws_last_seen FROM peers LIMIT 0',
        ).all();
        db.prepare(
            'SELECT id, group_id, from_peer_id, to_peer_id, reason, ts FROM peer_failover_log LIMIT 0',
        ).all();
        db.prepare(
            'SELECT id, peer_id, remote_id, reason, status, attempts, created_at, finished_at FROM peer_delete_jobs LIMIT 0',
        ).all();
        db.prepare(
            'SELECT peer_id, url, name, version, source, seen_at FROM peer_discoveries LIMIT 0',
        ).all();
        db.prepare(
            'SELECT id, peer_id, bytes, served_at, from_cache FROM cluster_egress_log LIMIT 0',
        ).all();
        db.prepare(
            'SELECT peer_id, remote_id, file_path, file_name, file_size, file_type, file_hash, group_id, group_name, message_id, created_at, status, nsfw_score, cached_at FROM peer_downloads LIMIT 0',
        ).all();
        db.prepare('SELECT peer_id, payload, cached_at FROM peer_groups LIMIT 0').all();
        db.prepare('SELECT id, ts, peer_id, kind, detail, ok FROM cluster_audit LIMIT 0').all();
        db.prepare('SELECT owner_peer_id FROM downloads LIMIT 0').all();
    } catch (e) {
        throw new Error(
            `DB schema migration incomplete — kv / web_sessions / queue_backlog / update_history / cluster tables not ready: ${e.message}`,
        );
    }

    // FK enforcement is per-connection in SQLite — flip it on once we know
    // the table exists. Without this, ON DELETE CASCADE silently no-ops.
    try {
        db.pragma('foreign_keys = ON');
    } catch {}
}

// ---- Share links ----------------------------------------------------------

/**
 * Insert a new share-link row and return its id + creation timestamp.
 * The signed URL itself is built by `share.js` after this returns; this
 * table is purely the revocation/audit source of truth.
 */
export function createShareLink({ downloadId, expiresAt, label = null }) {
    const now = Date.now();
    const stmt = getDb().prepare(`
        INSERT INTO share_links (download_id, created_at, expires_at, label, access_count)
        VALUES (?, ?, ?, ?, 0)
    `);
    const r = stmt.run(Number(downloadId), now, Number(expiresAt), label || null);
    return { id: r.lastInsertRowid, createdAt: now };
}

/**
 * Lookup the row that backs a /share/<id> request. Returns null when the
 * row doesn't exist OR is revoked OR is expired — the verifier treats
 * "not found" as 401 across the board so an attacker can't tell the
 * three apart by timing/response shape.
 */
export function getShareLinkForServe(id, now = Date.now()) {
    const row = getDb()
        .prepare(`
        SELECT s.*, d.file_path, d.file_name, d.file_type, d.file_size
          FROM share_links s
          JOIN downloads d ON d.id = s.download_id
         WHERE s.id = ?
    `)
        .get(Number(id));
    if (!row) return null;
    if (row.revoked_at != null) return { row, reason: 'revoked' };
    // expires_at === 0 is the "never expires" sentinel — the admin opted
    // out of the time-based gate at mint time. Revocation still works.
    if (row.expires_at !== 0 && row.expires_at <= now) {
        return { row, reason: 'expired' };
    }
    return { row, reason: null };
}

/**
 * Bump the access counter + last_accessed_at after a successful serve.
 * Cheap single-row UPDATE; safe to call inside the request handler.
 */
export function bumpShareLinkAccess(id) {
    try {
        getDb()
            .prepare(`
            UPDATE share_links
               SET access_count = access_count + 1,
                   last_accessed_at = ?
             WHERE id = ?
        `)
            .run(Date.now(), Number(id));
    } catch {
        /* non-fatal — bytes already on the wire */
    }
}

export function revokeShareLink(id) {
    const r = getDb()
        .prepare(`
        UPDATE share_links
           SET revoked_at = ?
         WHERE id = ? AND revoked_at IS NULL
    `)
        .run(Date.now(), Number(id));
    return r.changes > 0;
}

/**
 * List share-links. Pass `{ downloadId }` to filter to one file (used by
 * the per-file Share sheet); omit it for the admin's "all shares" sheet.
 * Joins the underlying download so the UI can render the file name +
 * group context without a second round-trip.
 */
export function listShareLinks({
    downloadId = null,
    includeRevoked = true,
    limit = 500,
    offset = 0,
    search = null,
} = {}) {
    const where = [];
    const args = [];
    if (downloadId != null) {
        where.push('s.download_id = ?');
        args.push(Number(downloadId));
    }
    if (!includeRevoked) where.push('s.revoked_at IS NULL');
    if (typeof search === 'string' && search.trim()) {
        // Free-text filter — used by the Maintenance "Active share links"
        // sheet so a 50 k-row library can land on a specific file without
        // pulling everything across the wire. Match on file name, label,
        // group name (LIKE; case-insensitive via SQLite default collation
        // for ASCII; Thai / CJK still match substring).
        where.push('(s.label LIKE ? OR d.file_name LIKE ? OR d.group_name LIKE ?)');
        const q = `%${String(search).trim()}%`;
        args.push(q, q, q);
    }
    const lim = Math.max(1, Math.min(2000, Number(limit) || 500));
    const off = Math.max(0, Number(offset) || 0);
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const sql = `
        SELECT s.id, s.download_id, s.created_at, s.expires_at, s.revoked_at,
               s.label, s.last_accessed_at, s.access_count,
               d.file_name, d.file_type, d.file_size, d.group_id, d.group_name
          FROM share_links s
          JOIN downloads d ON d.id = s.download_id
         ${whereSql}
         ORDER BY s.created_at DESC
         LIMIT ? OFFSET ?
    `;
    return getDb()
        .prepare(sql)
        .all(...args, lim, off);
}

/**
 * Count share-links matching the same filter set as `listShareLinks`. Used
 * by the paginated `/api/share/links` endpoint to render a `total` /
 * `hasMore` envelope without a second round trip.
 */
export function countShareLinks({ downloadId = null, includeRevoked = true, search = null } = {}) {
    const where = [];
    const args = [];
    if (downloadId != null) {
        where.push('s.download_id = ?');
        args.push(Number(downloadId));
    }
    if (!includeRevoked) where.push('s.revoked_at IS NULL');
    if (typeof search === 'string' && search.trim()) {
        where.push('(s.label LIKE ? OR d.file_name LIKE ? OR d.group_name LIKE ?)');
        const q = `%${String(search).trim()}%`;
        args.push(q, q, q);
    }
    const sql = `
        SELECT COUNT(*) AS n FROM share_links s
          JOIN downloads d ON d.id = s.download_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    `;
    return (
        getDb()
            .prepare(sql)
            .get(...args).n || 0
    );
}

export function insertDownload(data) {
    const row = {
        groupId: data.groupId,
        groupName: data.groupName ?? null,
        messageId: data.messageId,
        fileName: data.fileName ?? null,
        fileSize: data.fileSize ?? null,
        fileType: data.fileType ?? null,
        filePath: data.filePath ?? null,
        ttlSeconds: data.ttlSeconds ?? null,
        fileHash: data.fileHash ?? null,
        // Rescue Mode: when set, the rescue sweeper auto-deletes this row
        // after the timestamp unless the source is deleted first.
        pendingUntil: data.pendingUntil ?? null,
    };
    const stmt = getDb().prepare(`
        INSERT OR IGNORE INTO downloads (
            group_id, group_name, message_id, file_name, file_size, file_type, file_path, ttl_seconds, file_hash, pending_until
        ) VALUES (
            @groupId, @groupName, @messageId, @fileName, @fileSize, @fileType, @filePath, @ttlSeconds, @fileHash, @pendingUntil
        )
    `);
    return stmt.run(row);
}

/**
 * Mark a row as rescued — the source message was deleted on Telegram, so
 * the local file gets to live forever. Clears pending_until so the rescue
 * sweeper skips it. Idempotent: a second call with the same id is a no-op.
 *
 * @param {string|number} groupId
 * @param {number} messageId
 * @returns {number} rows updated (0 or 1; >1 only if duplicate inserts exist)
 */
export function markRescued(groupId, messageId) {
    const now = Date.now();
    const r = getDb()
        .prepare(`
            UPDATE downloads
               SET rescued_at = ?, pending_until = NULL
             WHERE group_id = ? AND message_id = ?
               AND rescued_at IS NULL
        `)
        .run(now, String(groupId), Number(messageId));
    return r.changes;
}

/**
 * Rows whose pending window has elapsed without a source-delete event.
 * The rescue sweeper unlinks the file + drops the row for each one.
 */
export function getExpiredPending(now = Date.now()) {
    return getDb()
        .prepare(`
            SELECT id, group_id, group_name, file_name, file_size, file_type, file_path, pending_until
              FROM downloads
             WHERE pending_until IS NOT NULL
               AND pending_until < ?
               AND rescued_at IS NULL
             ORDER BY pending_until ASC
             LIMIT 5000
        `)
        .all(Number(now));
}

/**
 * Counters for the Rescue panel in the SPA. `lastSweepCleared` is updated
 * by the sweeper via setRescueLastSweep().
 */
let _rescueLastSwept = 0;
export function setRescueLastSweep(n) {
    _rescueLastSwept = Number(n) || 0;
}
export function getRescueStats() {
    const db = getDb();
    const pending = db
        .prepare(
            `SELECT COUNT(*) as c FROM downloads WHERE pending_until IS NOT NULL AND rescued_at IS NULL`,
        )
        .get().c;
    const rescued = db
        .prepare(`SELECT COUNT(*) as c FROM downloads WHERE rescued_at IS NOT NULL`)
        .get().c;
    return { pending, rescued, lastSweepCleared: _rescueLastSwept };
}

/**
 * Lightweight dedup that catches the same file re-uploaded under a new
 * message_id. Returns true if (group_id, file_name, file_size) already
 * exists. Cheap thanks to the (group_id, file_name, file_size) index.
 */
export function fileAlreadyStored(groupId, fileName, fileSize) {
    if (!fileName || !fileSize) return false;
    const r = _prep(
        'SELECT 1 FROM downloads WHERE group_id = ? AND file_name = ? AND file_size = ? LIMIT 1',
    ).get(String(groupId), String(fileName), Number(fileSize));
    return !!r;
}

// Hot-path prepared-statement cache. `isDownloaded()` is called per message
// in every monitor pass and per row by the dedup pre-check, so re-preparing
// the same SQL each call was a measurable parse cost. The cache is lazily
// populated on first DB access since `getDb()` is also lazy.
const _stmtCache = new Map();
function _prep(sql) {
    let s = _stmtCache.get(sql);
    if (!s) {
        s = getDb().prepare(sql);
        _stmtCache.set(sql, s);
    }
    return s;
}

export function isDownloaded(groupId, messageId) {
    return !!_prep('SELECT 1 FROM downloads WHERE group_id = ? AND message_id = ? LIMIT 1').get(
        String(groupId),
        Number(messageId),
    );
}

/**
 * Min + max message_id for one group in the downloads table.
 *
 * Powers the v2.3.34 smart-resume path in the history backfill: we tell
 * gramJS `iterMessages({ maxId: minMessageId - 1 })` so the iterator
 * skips every message we already have on disk and resumes from the
 * oldest hole. Same idea in reverse with `minId: maxMessageId + 1` for
 * the post-monitor-restart catch-up flow.
 *
 * Returns `{ minMessageId: null, maxMessageId: null, count: 0 }` for an
 * empty group so the caller can default to "first-time backfill" (no
 * range filter, iterate from newest).
 */
export function getMessageIdRange(groupId) {
    const r = getDb()
        .prepare(`
        SELECT MIN(message_id) AS min_id, MAX(message_id) AS max_id, COUNT(*) AS n
          FROM downloads
         WHERE group_id = ?
    `)
        .get(String(groupId));
    return {
        minMessageId: r?.min_id ?? null,
        maxMessageId: r?.max_id ?? null,
        count: r?.n ?? 0,
    };
}

/**
 * All-Media query — same shape as getDownloads() but spans every group, with
 * the per-row group_id + group_name preserved so the gallery can paint the
 * right tile and the viewer can route back to the source chat. Powers the
 * `/api/downloads/all` endpoint that the All-Media surface uses for true
 * infinite-scroll across the full library (previous All-Media path was
 * capped at 20 groups × 20 files = ~400 max — see v2.3.6 blocker).
 */
export function getAllDownloads(limit = 50, offset = 0, type = 'all', opts = {}) {
    const lim = Math.max(1, Math.min(500, parseInt(limit, 10) || 50));
    const off = Math.max(0, parseInt(offset, 10) || 0);
    const typeMap = { images: 'photo', videos: 'video', documents: 'document', audio: 'audio' };
    const clauses = [];
    const params = [];
    if (type !== 'all' && typeMap[type]) {
        clauses.push('file_type = ?');
        params.push(typeMap[type]);
    }
    if (opts.pinnedOnly) {
        clauses.push('COALESCE(pinned, 0) = 1');
    }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    // `pinnedFirst` surfaces pinned rows above the rest while keeping
    // chronological order within each group. The default sort is unchanged
    // so existing callers behave identically.
    const orderBy = opts.pinnedFirst
        ? 'COALESCE(pinned, 0) DESC, datetime(created_at) DESC, id DESC'
        : 'datetime(created_at) DESC, id DESC';
    const rows = getDb()
        .prepare(`SELECT * FROM downloads${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
        .all(...params, lim, off);
    const total = getDb()
        .prepare(`SELECT COUNT(*) AS c FROM downloads${where}`)
        .get(...params).c;
    return { files: rows, total };
}

export function getDownloads(groupId, limit = 50, offset = 0, type = 'all', opts = {}) {
    let query = 'SELECT * FROM downloads WHERE group_id = ?';
    const params = [groupId];

    if (type !== 'all') {
        const typeMap = {
            images: 'photo',
            videos: 'video',
            documents: 'document',
            audio: 'audio',
        };
        // Use LIKE for flexibility or map precisely
        if (typeMap[type]) {
            query += ' AND file_type = ?';
            params.push(typeMap[type]);
        }
    }

    if (opts.pinnedOnly) query += ' AND COALESCE(pinned, 0) = 1';

    query += opts.pinnedFirst
        ? ' ORDER BY COALESCE(pinned, 0) DESC, created_at DESC LIMIT ? OFFSET ?'
        : ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = getDb().prepare(query);
    const rows = stmt.all(...params);

    // Count total for pagination
    let countQuery = 'SELECT COUNT(*) as total FROM downloads WHERE group_id = ?';
    const countParams = [groupId];

    // We reuse the type filter logic for count but it's cleaner to separate or build dynamically
    // For simplicity here:
    if (params.length > 3) {
        // If type filter was added
        countQuery += ' AND file_type = ?';
        countParams.push(params[1]); // existing type param
    }

    const total = getDb()
        .prepare(countQuery)
        .get(...countParams).total;

    return { files: rows, total };
}

/**
 * Full-text-ish search over downloaded files. LIKE-based; cheap on the
 * sub-100k row counts we expect.
 *
 * @param {string} query  user input
 * @param {object} [opts]
 * @param {number} [opts.limit=50]
 * @param {number} [opts.offset=0]
 * @param {string} [opts.groupId]  optional restrict to one group
 */
export function searchDownloads(query, opts = {}) {
    const limit = Math.max(1, Math.min(500, parseInt(opts.limit, 10) || 50));
    const offset = Math.max(0, parseInt(opts.offset, 10) || 0);
    const q = `%${String(query || '').trim()}%`;
    const params = [q, q];
    let where = '(file_name LIKE ? OR group_name LIKE ?)';
    if (opts.groupId) {
        where += ' AND group_id = ?';
        params.push(String(opts.groupId));
    }
    const rows = getDb()
        .prepare(`SELECT * FROM downloads WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset);
    const total = getDb()
        .prepare(`SELECT COUNT(*) as c FROM downloads WHERE ${where}`)
        .get(...params).c;
    return { files: rows, total };
}

// ---------------------------------------------------------------------------
// Federated gallery helpers — same pagination + filter contract as the
// local-only versions above, but UNION ALL with `peer_downloads`. Each row
// carries a `peer_id` column (`'self'` for local, peer's id for federated)
// + a `peer_name` column (always NULL — server.js stamps it after the
// query by joining the in-memory peers map). Used by /api/downloads/all,
// /api/downloads/:groupId, /api/downloads/search when the caller passes
// ?include=peers or ?include=all. The local-only entry points still call
// the original helpers so non-cluster installs see no behaviour change.
//
// Column alignment notes:
//   - peer_downloads.remote_id is aliased to `id` so client-side row
//     handling can stay column-symmetric. Note: peer-side ids COLLIDE
//     with local ids (both autoincrement) — the SPA must check `peer_id`
//     before treating `id` as a local-row reference.
//   - peer_downloads has no `pinned` column → aliased to `0`. Federated
//     rows therefore never satisfy `pinnedOnly`, which is intentional —
//     peer files belong to the peer, this peer can't pin them locally.
//   - downloads.created_at is a DATETIME string ('YYYY-MM-DD HH:MM:SS');
//     peer_downloads.created_at is INTEGER unix-ms. Both are coerced to
//     unix-ms via a `sort_ts` column in the UNION so ORDER BY works
//     across both sides without parsing in JS.
// ---------------------------------------------------------------------------

const _FEDERATED_TYPE_MAP = {
    images: 'photo',
    videos: 'video',
    documents: 'document',
    audio: 'audio',
};

// Column lists shared by every federated SELECT. Kept in module scope so
// the four helpers below stay small and readable.
const _FED_COLS_LOCAL = `
    'self' AS peer_id,
    id, group_id, group_name, message_id, file_name, file_size, file_type,
    file_path, file_hash, status, created_at, nsfw_score,
    COALESCE(pinned, 0) AS pinned,
    CAST(strftime('%s', created_at) AS INTEGER) * 1000 AS sort_ts
`;
const _FED_COLS_PEER = `
    peer_id,
    remote_id AS id, group_id, group_name, message_id, file_name, file_size, file_type,
    file_path, file_hash, status, created_at, nsfw_score,
    0 AS pinned,
    CAST(created_at AS INTEGER) AS sort_ts
`;

function _stripSortTs(rows) {
    // Drop the sort_ts column we used only for the cross-side ORDER BY.
    // Mutates in place — callers already consume the row objects directly.
    for (const r of rows) delete r.sort_ts;
    return rows;
}

/**
 * Federated equivalent of getAllDownloads — All Media gallery, optionally
 * widened to include peer_downloads.
 *
 * @param {number} limit
 * @param {number} offset
 * @param {string} type   'all' | 'images' | 'videos' | 'documents' | 'audio'
 * @param {object} [opts]
 * @param {boolean} [opts.pinnedOnly]
 * @param {boolean} [opts.pinnedFirst]
 * @param {'local'|'peers'|'all'} [opts.include='local']  scope toggle
 * @returns {{ files: Array, total: number }}
 */
export function getAllDownloadsFederated(limit = 50, offset = 0, type = 'all', opts = {}) {
    const include = opts.include === 'peers' || opts.include === 'all' ? opts.include : 'local';
    if (include === 'local') {
        return getAllDownloads(limit, offset, type, opts);
    }
    const lim = Math.max(1, Math.min(500, parseInt(limit, 10) || 50));
    const off = Math.max(0, parseInt(offset, 10) || 0);
    const typeFilter =
        type !== 'all' && _FEDERATED_TYPE_MAP[type] ? _FEDERATED_TYPE_MAP[type] : null;

    // Build the WHERE clause for both sides. Pinned filter only applies
    // to the local side because peer rows are always pinned=0.
    const localWhereParts = [];
    const peerWhereParts = [];
    const localParams = [];
    const peerParams = [];
    if (typeFilter) {
        localWhereParts.push('file_type = ?');
        peerWhereParts.push('file_type = ?');
        localParams.push(typeFilter);
        peerParams.push(typeFilter);
    }
    if (opts.pinnedOnly) {
        localWhereParts.push('COALESCE(pinned, 0) = 1');
        // Peer side excluded entirely under pinnedOnly — peer files can't
        // be locally pinned. Drop a never-true predicate to short-circuit.
        peerWhereParts.push('0 = 1');
    }
    const localWhere = localWhereParts.length ? ' WHERE ' + localWhereParts.join(' AND ') : '';
    const peerWhere = peerWhereParts.length ? ' WHERE ' + peerWhereParts.join(' AND ') : '';

    // pinnedFirst: COALESCE on the local side, peer side always 0 — net
    // effect is that local pinned float to the top of the merged page.
    const orderBy = opts.pinnedFirst
        ? 'pinned DESC, sort_ts DESC, id DESC'
        : 'sort_ts DESC, id DESC';

    const sql = `
        SELECT * FROM (
            SELECT ${_FED_COLS_LOCAL} FROM downloads${localWhere}
            UNION ALL
            SELECT ${_FED_COLS_PEER} FROM peer_downloads${peerWhere}
        ) ORDER BY ${orderBy} LIMIT ? OFFSET ?
    `;
    const countSql = `
        SELECT
            (SELECT COUNT(*) FROM downloads${localWhere}) +
            (SELECT COUNT(*) FROM peer_downloads${peerWhere}) AS total
    `;
    const rows = getDb()
        .prepare(sql)
        .all(...localParams, ...peerParams, lim, off);
    const total = getDb()
        .prepare(countSql)
        .get(...localParams, ...peerParams).total;
    return { files: _stripSortTs(rows), total };
}

/**
 * Federated per-group view — same contract as getDownloads, plus include.
 */
export function getDownloadsForGroupFederated(
    groupId,
    limit = 50,
    offset = 0,
    type = 'all',
    opts = {},
) {
    const include = opts.include === 'peers' || opts.include === 'all' ? opts.include : 'local';
    if (include === 'local') {
        return getDownloads(groupId, limit, offset, type, opts);
    }
    const lim = Math.max(1, Math.min(500, parseInt(limit, 10) || 50));
    const off = Math.max(0, parseInt(offset, 10) || 0);
    const typeFilter =
        type !== 'all' && _FEDERATED_TYPE_MAP[type] ? _FEDERATED_TYPE_MAP[type] : null;
    const gid = String(groupId);

    const localWhereParts = ['group_id = ?'];
    const peerWhereParts = ['group_id = ?'];
    const localParams = [gid];
    const peerParams = [gid];
    if (typeFilter) {
        localWhereParts.push('file_type = ?');
        peerWhereParts.push('file_type = ?');
        localParams.push(typeFilter);
        peerParams.push(typeFilter);
    }
    if (opts.pinnedOnly) {
        localWhereParts.push('COALESCE(pinned, 0) = 1');
        peerWhereParts.push('0 = 1');
    }
    // Optional peerId filter — when caller wants only one peer's files for
    // the group (sidebar foreign-group click).
    if (opts.peerId) {
        peerWhereParts.push('peer_id = ?');
        peerParams.push(String(opts.peerId));
        // Also drop the local side entirely — caller wants only that peer.
        localWhereParts.push('0 = 1');
    }
    const localWhere = ' WHERE ' + localWhereParts.join(' AND ');
    const peerWhere = ' WHERE ' + peerWhereParts.join(' AND ');
    const orderBy = opts.pinnedFirst
        ? 'pinned DESC, sort_ts DESC, id DESC'
        : 'sort_ts DESC, id DESC';

    const sql = `
        SELECT * FROM (
            SELECT ${_FED_COLS_LOCAL} FROM downloads${localWhere}
            UNION ALL
            SELECT ${_FED_COLS_PEER} FROM peer_downloads${peerWhere}
        ) ORDER BY ${orderBy} LIMIT ? OFFSET ?
    `;
    const countSql = `
        SELECT
            (SELECT COUNT(*) FROM downloads${localWhere}) +
            (SELECT COUNT(*) FROM peer_downloads${peerWhere}) AS total
    `;
    const rows = getDb()
        .prepare(sql)
        .all(...localParams, ...peerParams, lim, off);
    const total = getDb()
        .prepare(countSql)
        .get(...localParams, ...peerParams).total;
    return { files: _stripSortTs(rows), total };
}

/**
 * Federated full-text-ish search — same LIKE pattern as searchDownloads,
 * UNIONed with peer_downloads.
 */
export function searchDownloadsFederated(query, opts = {}) {
    const include = opts.include === 'peers' || opts.include === 'all' ? opts.include : 'local';
    if (include === 'local') {
        return searchDownloads(query, opts);
    }
    const lim = Math.max(1, Math.min(500, parseInt(opts.limit, 10) || 50));
    const off = Math.max(0, parseInt(opts.offset, 10) || 0);
    const q = `%${String(query || '').trim()}%`;

    const localWhereParts = ['(file_name LIKE ? OR group_name LIKE ?)'];
    const peerWhereParts = ['(file_name LIKE ? OR group_name LIKE ?)'];
    const localParams = [q, q];
    const peerParams = [q, q];
    if (opts.groupId) {
        const gid = String(opts.groupId);
        localWhereParts.push('group_id = ?');
        peerWhereParts.push('group_id = ?');
        localParams.push(gid);
        peerParams.push(gid);
    }
    const localWhere = ' WHERE ' + localWhereParts.join(' AND ');
    const peerWhere = ' WHERE ' + peerWhereParts.join(' AND ');

    const sql = `
        SELECT * FROM (
            SELECT ${_FED_COLS_LOCAL} FROM downloads${localWhere}
            UNION ALL
            SELECT ${_FED_COLS_PEER} FROM peer_downloads${peerWhere}
        ) ORDER BY sort_ts DESC, id DESC LIMIT ? OFFSET ?
    `;
    const countSql = `
        SELECT
            (SELECT COUNT(*) FROM downloads${localWhere}) +
            (SELECT COUNT(*) FROM peer_downloads${peerWhere}) AS total
    `;
    const rows = getDb()
        .prepare(sql)
        .all(...localParams, ...peerParams, lim, off);
    const total = getDb()
        .prepare(countSql)
        .get(...localParams, ...peerParams).total;
    return { files: _stripSortTs(rows), total };
}

/**
 * Federated stats — local totals plus per-peer file counts + total size.
 * Used by /api/stats so the footer can render "Files: 1234 + 5678 peers"
 * when the gallery scope chip is set to "All peers".
 *
 * @returns {{
 *   totalFiles: number,
 *   totalSize: number,
 *   peerStats: Array<{peerId: string, totalFiles: number, totalSize: number}>
 * }}
 */
export function getStatsFederated() {
    const local = getStats();
    const peerRows = getDb()
        .prepare(
            `SELECT peer_id, COUNT(*) AS total_files, COALESCE(SUM(file_size), 0) AS total_size
               FROM peer_downloads
              GROUP BY peer_id`,
        )
        .all();
    return {
        ...local,
        peerStats: peerRows.map((r) => ({
            peerId: r.peer_id,
            totalFiles: Number(r.total_files) || 0,
            totalSize: Number(r.total_size) || 0,
        })),
    };
}

/**
 * Toggle / set the `pinned` flag on a download row. Pinned rows are
 * protected from auto-rotation sweeps (see disk-rotator.js) AND surface
 * at the top of gallery views when the operator opts in via Settings →
 * Library → "Surface pinned at the top".
 *
 * @param {number} id        download row id
 * @param {boolean} pinned   new state (true → 1, false → 0)
 * @returns {boolean}        true if a row was updated
 */
export function setDownloadPinned(id, pinned) {
    const numId = Number(id);
    if (!Number.isFinite(numId) || numId <= 0) return false;
    const r = getDb()
        .prepare('UPDATE downloads SET pinned = ? WHERE id = ?')
        .run(pinned ? 1 : 0, numId);
    return r.changes > 0;
}

/**
 * Lookup helper for the bulk-zip endpoint and other id-based admin tools.
 * Returns the row or null. Cheap (PK lookup); safe to call N times in a row.
 */
export function getDownloadById(id) {
    const numId = Number(id);
    if (!Number.isFinite(numId) || numId <= 0) return null;
    return getDb().prepare('SELECT * FROM downloads WHERE id = ?').get(numId) || null;
}

/** Bulk-delete by ids (preferred) or file_paths. Returns the number removed. */
export function deleteDownloadsBy(opts) {
    const db = getDb();
    if (Array.isArray(opts?.ids) && opts.ids.length) {
        const stmt = db.prepare('DELETE FROM downloads WHERE id = ?');
        const tx = db.transaction(() => opts.ids.reduce((n, id) => n + stmt.run(id).changes, 0));
        return tx();
    }
    if (Array.isArray(opts?.filePaths) && opts.filePaths.length) {
        const stmt = db.prepare('DELETE FROM downloads WHERE file_path = ?');
        const tx = db.transaction(() =>
            opts.filePaths.reduce((n, p) => n + stmt.run(p).changes, 0),
        );
        return tx();
    }
    return 0;
}

export function getStats() {
    const db = getDb();
    const totalFiles = db.prepare('SELECT COUNT(*) as count FROM downloads').get().count;
    const totalSize = db.prepare('SELECT SUM(file_size) as size FROM downloads').get().size || 0;
    return { totalFiles, totalSize };
}

/**
 * Sum of file_size across all download rows (NULL sizes are treated as 0).
 * Used by the disk rotator to decide whether the cap is exceeded.
 */
export function getTotalSizeBytes() {
    const r = getDb().prepare('SELECT COALESCE(SUM(file_size), 0) as size FROM downloads').get();
    return Number(r?.size || 0);
}

/**
 * Returns the N oldest download rows (created_at ASC), skipping pinned ones.
 * The rotator pulls from this list and deletes file + row until the cap is
 * back under the limit.
 */
export function getOldestDownloads(count = 50) {
    const limit = Math.max(1, Math.min(10000, parseInt(count, 10) || 50));
    return getDb()
        .prepare(`
            SELECT id, group_id, group_name, file_name, file_size, file_type, file_path, created_at, pinned
            FROM downloads
            WHERE COALESCE(pinned, 0) = 0
            ORDER BY datetime(created_at) ASC, id ASC
            LIMIT ?
        `)
        .all(limit);
}

/**
 * Per-group stats card backing query — single index-only scan over
 * `idx_group_message`. Returns the totals the Group → Data tab renders
 * above its file strip. Cheap enough to call on every modal open.
 *
 * Shape:
 *   { totalFiles, totalBytes, byType: {photo, video, audio, document, sticker, voice},
 *     firstMessageId, lastMessageId, lastDownloadAt }
 */
export function getGroupStats(groupId) {
    const db = getDb();
    const totals =
        db
            .prepare(`
            SELECT COUNT(*) AS totalFiles,
                   COALESCE(SUM(COALESCE(file_size, 0)), 0) AS totalBytes,
                   MIN(message_id) AS firstMessageId,
                   MAX(message_id) AS lastMessageId,
                   MAX(created_at) AS lastDownloadAt
              FROM downloads
             WHERE group_id = ?
        `)
            .get(String(groupId)) || {};
    const rows = db
        .prepare(`
            SELECT file_type, COUNT(*) AS n
              FROM downloads
             WHERE group_id = ?
             GROUP BY file_type
        `)
        .all(String(groupId));
    const byType = {};
    for (const r of rows) byType[r.file_type || 'other'] = Number(r.n) || 0;
    return {
        totalFiles: Number(totals.totalFiles) || 0,
        totalBytes: Number(totals.totalBytes) || 0,
        byType,
        firstMessageId: totals.firstMessageId == null ? null : Number(totals.firstMessageId),
        lastMessageId: totals.lastMessageId == null ? null : Number(totals.lastMessageId),
        lastDownloadAt: totals.lastDownloadAt || null,
    };
}

/**
 * Paginated file list for the Group → Data tab. Uses `idx_group_message`
 * for the WHERE filter + the index's natural ordering for the LIMIT/OFFSET
 * scan, so a 100k-row group still opens the modal in <500 ms.
 */
export function listGroupFiles({ groupId, limit = 50, offset = 0, type = null } = {}) {
    const db = getDb();
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    const where = ['group_id = ?'];
    const args = [String(groupId)];
    if (type && typeof type === 'string') {
        where.push('file_type = ?');
        args.push(type);
    }
    const whereSql = where.join(' AND ');
    const total =
        db.prepare(`SELECT COUNT(*) AS n FROM downloads WHERE ${whereSql}`).get(...args).n || 0;
    const rows = db
        .prepare(`
            SELECT id, message_id, file_name, file_path, file_type, file_size, created_at, nsfw_score
              FROM downloads
             WHERE ${whereSql}
             ORDER BY created_at DESC, id DESC
             LIMIT ? OFFSET ?
        `)
        .all(...args, lim, off);
    return {
        rows,
        total,
        limit: lim,
        offset: off,
        hasMore: off + rows.length < total,
    };
}

/**
 * Delete all download records for a specific group
 * @param {string} groupId - Telegram group ID
 * @returns {{ deletedDownloads: number, deletedQueue: number }}
 */
export function deleteGroupDownloads(groupId) {
    const db = getDb();
    const del1 = db.prepare('DELETE FROM downloads WHERE group_id = ?').run(String(groupId));
    const del2 = db.prepare('DELETE FROM queue WHERE group_id = ?').run(String(groupId));
    return { deletedDownloads: del1.changes, deletedQueue: del2.changes };
}

/**
 * Delete ALL download and queue records
 * @returns {{ deletedDownloads: number, deletedQueue: number }}
 */
export function deleteAllDownloads() {
    const db = getDb();
    const del1 = db.prepare('DELETE FROM downloads').run();
    const del2 = db.prepare('DELETE FROM queue').run();
    return { deletedDownloads: del1.changes, deletedQueue: del2.changes };
}

/**
 * Backfill group_name for existing records using config groups.
 * Call once on startup after config is loaded.
 * @param {Array<{id: string|number, name: string}>} groups - Config groups
 * @returns {number} Number of records updated
 */
export function backfillGroupNames(groups) {
    if (!groups || groups.length === 0) return 0;
    const db = getDb();
    const stmt = db.prepare(
        'UPDATE downloads SET group_name = ? WHERE group_id = ? AND group_name IS NULL',
    );
    let updated = 0;
    const tx = db.transaction(() => {
        for (const g of groups) {
            if (g.name) {
                const result = stmt.run(g.name, String(g.id));
                updated += result.changes;
            }
        }
    });
    tx();
    return updated;
}

// ---- NSFW review (Phase 1: photos only) -----------------------------------
//
// IMPORTANT — semantic note on this whole subsystem:
//
// The library is a curated 18+ collection. The classifier's job is to find
// photos that are NOT 18+ (mistakes that snuck in via auto-download) so the
// admin can purge them. So:
//
//   nsfw_score                          = classifier's "is this 18+" score (0-1)
//   nsfw_score >= threshold             = KEEP (it really is 18+)
//   nsfw_score <  threshold             = DELETE CANDIDATE (likely not 18+)
//   nsfw_whitelist = 1                  = admin manually approved as "really IS 18+, do not surface again"
//
// Don't mix this up — the review sheet and `candidates` count surface
// the LOW-score rows, not the high ones.

/**
 * Headline counts for the Maintenance "Scan images for NSFW" status line.
 *
 * @param {string[]} fileTypes  Telegram file_type values to count over
 *                              (`['photo']` for Phase 1).
 * @param {number}   threshold  Score >= this is treated as 18+ (keep);
 *                              < this is treated as deletion-candidate.
 * @returns {{ totalEligible:number, scanned:number, candidates:number,
 *             keep:number, whitelisted:number, lastCheckedAt:number|null }}
 */
export function getNsfwStats(fileTypes, threshold) {
    const types = Array.isArray(fileTypes) && fileTypes.length ? fileTypes : ['photo'];
    const placeholders = types.map(() => '?').join(',');
    const db = getDb();
    const total = db
        .prepare(`SELECT COUNT(*) AS n FROM downloads WHERE file_type IN (${placeholders})`)
        .get(...types).n;
    const scanned = db
        .prepare(
            `SELECT COUNT(*) AS n FROM downloads WHERE file_type IN (${placeholders}) AND nsfw_checked_at IS NOT NULL`,
        )
        .get(...types).n;
    // candidates = LOW-score rows (likely not 18+) — what the admin reviews.
    const candidates = db
        .prepare(
            `SELECT COUNT(*) AS n FROM downloads
         WHERE file_type IN (${placeholders})
           AND nsfw_score IS NOT NULL
           AND nsfw_score < ?
           AND nsfw_whitelist = 0`,
        )
        .get(...types, Number(threshold)).n;
    // keep = HIGH-score rows (likely 18+) — the curated content stays put.
    const keep = db
        .prepare(
            `SELECT COUNT(*) AS n FROM downloads
         WHERE file_type IN (${placeholders})
           AND nsfw_score IS NOT NULL
           AND nsfw_score >= ?`,
        )
        .get(...types, Number(threshold)).n;
    const whitelisted = db
        .prepare(`SELECT COUNT(*) AS n FROM downloads WHERE nsfw_whitelist = 1`)
        .get().n;
    const lastCheckedAt = db
        .prepare(
            `SELECT MAX(nsfw_checked_at) AS t FROM downloads WHERE file_type IN (${placeholders})`,
        )
        .get(...types).t;
    return { totalEligible: total, scanned, candidates, keep, whitelisted, lastCheckedAt };
}

/**
 * Pull a batch of rows that haven't been classified yet. Whitelisted rows
 * are skipped — admin already approved them. Sorted oldest-first so the
 * resume-after-restart path picks up backlog rather than newly-arrived
 * downloads.
 */
export function getUnscannedNsfwBatch(fileTypes, limit = 50) {
    const types = Array.isArray(fileTypes) && fileTypes.length ? fileTypes : ['photo'];
    const placeholders = types.map(() => '?').join(',');
    return getDb()
        .prepare(`
        SELECT id, group_id, group_name, file_name, file_path, file_type, file_size, created_at
          FROM downloads
         WHERE file_type IN (${placeholders})
           AND nsfw_checked_at IS NULL
           AND nsfw_whitelist = 0
         ORDER BY created_at ASC
         LIMIT ?
    `)
        .all(...types, Math.max(1, Math.min(500, Number(limit) || 50)));
}

/**
 * Persist a classification result. `score` may be NULL when the file
 * couldn't be read (missing on disk, decode failure) — we still set
 * `nsfw_checked_at` so the scan loop doesn't keep retrying the same
 * unreadable row forever.
 */
export function setNsfwResult(id, score, now = Date.now()) {
    const s = score == null ? null : Math.max(0, Math.min(1, Number(score)));
    return getDb()
        .prepare(`
        UPDATE downloads
           SET nsfw_score = ?, nsfw_checked_at = ?
         WHERE id = ?
    `)
        .run(s, Math.floor(now), Number(id)).changes;
}

/**
 * Deletion-candidate rows for the review sheet. Returns photos with a
 * LOW NSFW score (i.e. classifier thinks they're NOT 18+), which is
 * exactly what the admin wants to purge from a curated 18+ library.
 *
 * Excludes whitelisted rows (admin already confirmed they really are
 * 18+ despite the low score — false negative override). Sorted by
 * score ASC so the "most clearly not 18+" rows surface first.
 *
 * @returns {{ rows: object[], total: number, page: number, totalPages: number }}
 */
export function getNsfwDeleteCandidates({ fileTypes, threshold, page = 1, limit = 50 }) {
    const types = Array.isArray(fileTypes) && fileTypes.length ? fileTypes : ['photo'];
    const placeholders = types.map(() => '?').join(',');
    const t = Number(threshold);
    const p = Math.max(1, Number(page) || 1);
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    const offset = (p - 1) * lim;
    const db = getDb();
    const totalRow = db
        .prepare(`
        SELECT COUNT(*) AS n FROM downloads
         WHERE file_type IN (${placeholders})
           AND nsfw_score IS NOT NULL
           AND nsfw_score < ?
           AND nsfw_whitelist = 0
    `)
        .get(...types, t);
    const rows = db
        .prepare(`
        SELECT id, group_id, group_name, file_name, file_path, file_type, file_size,
               created_at, nsfw_score, nsfw_checked_at
          FROM downloads
         WHERE file_type IN (${placeholders})
           AND nsfw_score IS NOT NULL
           AND nsfw_score < ?
           AND nsfw_whitelist = 0
         ORDER BY nsfw_score ASC, id ASC
         LIMIT ? OFFSET ?
    `)
        .all(...types, t, lim, offset);
    const total = totalRow.n;
    return { rows, total, page: p, totalPages: Math.max(1, Math.ceil(total / lim)) };
}

/**
 * Mark rows as admin-confirmed-18+. They're hidden from the review
 * sheet forever (until manually un-whitelisted). Use when the
 * classifier's score is misleadingly low for a genuinely 18+ image
 * — admin overrides the false negative.
 */
// Chunk size for `IN (?,?,…)` clauses. SQLite caps bound parameters at
// SQLITE_MAX_VARIABLE_NUMBER (32766 in modern builds, 999 in older ones);
// 500 stays well clear of both. Bulk NSFW ops can pass tens of thousands
// of ids when the operator selects a whole tier.
const _SQL_IN_CHUNK = 500;

function _runChunkedUpdate(sql, ids) {
    const db = getDb();
    let total = 0;
    const tx = db.transaction((all) => {
        for (let i = 0; i < all.length; i += _SQL_IN_CHUNK) {
            const slice = all.slice(i, i + _SQL_IN_CHUNK);
            const ph = slice.map(() => '?').join(',');
            total += db.prepare(sql.replace('${PH}', ph)).run(...slice).changes;
        }
    });
    tx(ids);
    return total;
}

export function whitelistNsfw(ids) {
    if (!Array.isArray(ids) || !ids.length) return 0;
    const cleanIds = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!cleanIds.length) return 0;
    return _runChunkedUpdate(
        'UPDATE downloads SET nsfw_whitelist = 1 WHERE id IN (${PH})',
        cleanIds,
    );
}

// Tier definitions — higher score = more likely 18+ (the convention the
// classifier uses internally). Five tiers give the operator more nuance
// than the original binary "above/below threshold" view, and let the
// review page surface bulk actions like "delete everything in not_18+
// tier" without having to scroll a list of 8000 rows.
//
// Boundaries are inclusive on the LEFT, exclusive on the RIGHT (except
// def_18 which is closed on both sides because 1.0 is the max possible
// score — a row stored at exactly 1.0 must land in def_18, not nowhere).
//
// Names favour readability in the UI over brevity:
//   def_not  — Definitely not 18+      [0.0, 0.3)
//   maybe_not — Probably not 18+       [0.3, 0.5)
//   uncertain — Borderline / review    [0.5, 0.7)
//   maybe    — Probably 18+            [0.7, 0.9)
//   def      — Definitely 18+          [0.9, 1.0]
export const NSFW_TIERS = [
    { id: 'def_not', min: 0.0, max: 0.3, label: 'Definitely not 18+' },
    { id: 'maybe_not', min: 0.3, max: 0.5, label: 'Probably not 18+' },
    { id: 'uncertain', min: 0.5, max: 0.7, label: 'Borderline / review' },
    { id: 'maybe', min: 0.7, max: 0.9, label: 'Probably 18+' },
    { id: 'def', min: 0.9, max: 1.01, label: 'Definitely 18+' },
];

function _tierBounds(tierId) {
    const t = NSFW_TIERS.find((x) => x.id === tierId);
    if (!t) return null;
    return { min: t.min, max: t.max };
}

/**
 * Per-tier counts. `whitelist` rows count toward `whitelistTotal` and are
 * NOT included in tier counts (they were admin-confirmed 18+ even when
 * the score might disagree). The UI uses this to render the stats cards.
 *
 * Single SQL pass — one CASE-SUM aggregation gives all five tier counts
 * plus scanned/totalEligible. The whitelist count is unfiltered by
 * file_type by design (it's a global "how many rows did the operator
 * mark as confirmed-18+", not a per-photo metric) so it stays separate.
 */
export function getNsfwTierCounts(fileTypes) {
    const types = Array.isArray(fileTypes) && fileTypes.length ? fileTypes : ['photo'];
    const placeholders = types.map(() => '?').join(',');
    const db = getDb();
    // Build the per-tier SUM(CASE...) clauses from NSFW_TIERS so the
    // bucket boundaries stay defined in one place.
    const tierSums = NSFW_TIERS.map(
        (t) =>
            `SUM(CASE WHEN nsfw_score IS NOT NULL AND nsfw_whitelist = 0 AND nsfw_score >= ${t.min} AND nsfw_score < ${t.max} THEN 1 ELSE 0 END) AS tier_${t.id}`,
    ).join(',\n               ');
    const row = db
        .prepare(`
            SELECT
               ${tierSums},
               SUM(CASE WHEN nsfw_checked_at IS NOT NULL THEN 1 ELSE 0 END) AS scanned,
               COUNT(*) AS total_eligible
              FROM downloads
             WHERE file_type IN (${placeholders})
        `)
        .get(...types);
    const tiers = {};
    for (const t of NSFW_TIERS) tiers[t.id] = row[`tier_${t.id}`] || 0;
    const whitelisted = db
        .prepare(`SELECT COUNT(*) AS n FROM downloads WHERE nsfw_whitelist = 1`)
        .get().n;
    const scanned = row.scanned || 0;
    const totalEligible = row.total_eligible || 0;
    return {
        tiers,
        scanned,
        unscanned: Math.max(0, totalEligible - scanned),
        whitelisted,
        totalEligible,
    };
}

/**
 * Score histogram — N bins across [0, 1]. Drives the small inline chart
 * on the review page so the operator can spot model bias / clustering at
 * a glance (e.g. classifier scoring everything in 0.4-0.6 = the model is
 * uncertain; consider a different model).
 *
 * SQL-side aggregation: GROUP BY a CAST(score*N AS INTEGER) bin index so
 * the database returns one row per non-empty bin (max 21 rows for the
 * default 20 bins, since the score=1.0 edge case lands in bin N-1). The
 * dense output array is built from the sparse result so callers see a
 * fixed-length counts[] like before.
 */
export function getNsfwHistogram(fileTypes, bins = 20) {
    const types = Array.isArray(fileTypes) && fileTypes.length ? fileTypes : ['photo'];
    const placeholders = types.map(() => '?').join(',');
    const n = Math.max(4, Math.min(50, Number(bins) || 20));
    const out = new Array(n).fill(0);
    // Cap at n-1 so a perfect 1.0 score lands in the last bin instead of
    // an out-of-range bucket. The CASE expression mirrors the JS
    // `Math.floor(score*n); if (idx>=n) idx=n-1` clamp.
    const rows = getDb()
        .prepare(`
            SELECT
               CASE WHEN CAST(nsfw_score * ? AS INTEGER) >= ?
                    THEN ? - 1
                    ELSE CAST(nsfw_score * ? AS INTEGER)
               END AS bin,
               COUNT(*) AS n
              FROM downloads
             WHERE file_type IN (${placeholders})
               AND nsfw_score IS NOT NULL
             GROUP BY bin
        `)
        .all(n, n, n, n, ...types);
    for (const r of rows) {
        const idx = Math.max(0, Math.min(n - 1, Number(r.bin) || 0));
        out[idx] = Number(r.n) || 0;
    }
    return { bins: n, counts: out };
}

/**
 * Paginated list filtered by tier (or score range), file type, and
 * group. The new review page uses this in place of the old
 * delete-candidates query so the operator can step through ANY tier,
 * not only the ones below the deletion threshold.
 */
export function getNsfwListByTier({
    tier = null,
    fileTypes,
    groupId = null,
    includeWhitelisted = false,
    page = 1,
    limit = 50,
}) {
    const types = Array.isArray(fileTypes) && fileTypes.length ? fileTypes : ['photo'];
    const placeholders = types.map(() => '?').join(',');
    const where = [`file_type IN (${placeholders})`, 'nsfw_score IS NOT NULL'];
    const params = [...types];
    if (tier) {
        const bounds = _tierBounds(tier);
        if (bounds) {
            where.push('nsfw_score >= ?');
            where.push('nsfw_score < ?');
            params.push(bounds.min, bounds.max);
        }
    }
    if (!includeWhitelisted) where.push('nsfw_whitelist = 0');
    if (groupId) {
        where.push('group_id = ?');
        params.push(String(groupId));
    }
    const p = Math.max(1, Number(page) || 1);
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    const offset = (p - 1) * lim;
    const whereSql = where.join(' AND ');
    const db = getDb();
    const totalRow = db
        .prepare(`SELECT COUNT(*) AS n FROM downloads WHERE ${whereSql}`)
        .get(...params);
    const rows = db
        .prepare(`
        SELECT id, group_id, group_name, file_name, file_path, file_type, file_size,
               created_at, nsfw_score, nsfw_checked_at, nsfw_whitelist
          FROM downloads
         WHERE ${whereSql}
         ORDER BY nsfw_score ASC, id ASC
         LIMIT ? OFFSET ?
    `)
        .all(...params, lim, offset);
    return {
        rows,
        total: totalRow.n,
        page: p,
        totalPages: Math.max(1, Math.ceil(totalRow.n / lim)),
    };
}

/**
 * Resolve a tier-or-range filter to a flat array of row ids in one SQL
 * statement. Replaces the old paginated walker that issued ~75 queries
 * to collect 15k ids on the def_not tier — now it's a single index scan
 * with no LIMIT/OFFSET dance.
 *
 * `scoreMin` / `scoreMax` are pushed into the WHERE clause too so a
 * narrow score band (e.g. 0.55..0.62 for spot-checking) doesn't pull
 * the whole tier into memory and filter post-query.
 */
export function getNsfwIdsByTier({
    tier = null,
    fileTypes,
    groupId = null,
    includeWhitelisted = false,
    scoreMin = null,
    scoreMax = null,
} = {}) {
    const types = Array.isArray(fileTypes) && fileTypes.length ? fileTypes : ['photo'];
    const placeholders = types.map(() => '?').join(',');
    const where = [`file_type IN (${placeholders})`, 'nsfw_score IS NOT NULL'];
    const params = [...types];
    if (tier) {
        const bounds = _tierBounds(tier);
        if (bounds) {
            where.push('nsfw_score >= ?');
            where.push('nsfw_score < ?');
            params.push(bounds.min, bounds.max);
        }
    }
    if (Number.isFinite(scoreMin)) {
        where.push('nsfw_score >= ?');
        params.push(Number(scoreMin));
    }
    if (Number.isFinite(scoreMax)) {
        where.push('nsfw_score < ?');
        params.push(Number(scoreMax));
    }
    if (!includeWhitelisted) where.push('nsfw_whitelist = 0');
    if (groupId) {
        where.push('group_id = ?');
        params.push(String(groupId));
    }
    // Stream — `.all()` over a tier with 100 k+ scored photos materialises
    // the entire id list in JS heap before the bulk-delete consumer touches
    // the first row. Iterator + push keeps the array bounded only by the
    // matched rows, not by a single `Statement::JS_all` allocation spike.
    const ids = [];
    const iter = getDb()
        .prepare(`
            SELECT id FROM downloads
             WHERE ${where.join(' AND ')}
             ORDER BY nsfw_score ASC, id ASC
        `)
        .iterate(...params);
    for (const r of iter) {
        const n = Number(r.id);
        if (Number.isInteger(n) && n > 0) ids.push(n);
    }
    return ids;
}

/**
 * Bulk reclassify — clear `nsfw_checked_at` so the next scan run picks
 * the rows up again. Useful after switching the model or threshold
 * without having to wipe the entire `nsfw_*` column trio.
 */
export function reclassifyNsfw(ids) {
    if (!Array.isArray(ids) || !ids.length) return 0;
    const cleanIds = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!cleanIds.length) return 0;
    return _runChunkedUpdate(
        'UPDATE downloads SET nsfw_checked_at = NULL, nsfw_score = NULL WHERE id IN (${PH})',
        cleanIds,
    );
}

/**
 * Un-whitelist — flip nsfw_whitelist back to 0 so the next scan / review
 * page sees the row again. Counterpart to `whitelistNsfw`.
 */
export function unwhitelistNsfw(ids) {
    if (!Array.isArray(ids) || !ids.length) return 0;
    const cleanIds = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!cleanIds.length) return 0;
    return _runChunkedUpdate(
        'UPDATE downloads SET nsfw_whitelist = 0 WHERE id IN (${PH})',
        cleanIds,
    );
}

// ---- AI subsystem (v2.15.0) ----------------------------------------------
//
// Helper queries for src/core/ai/*. Each capability persists into a
// different table but the read paths are concentrated here so the modules
// stay small. Mirrors the NSFW helper pattern: small, composable, every
// `.all()` over a high-cardinality table either has LIMIT/OFFSET or is
// streamed via `.iterate()` per `CLAUDE.md → Big-data patterns`.

/**
 * Rows that haven't been visited yet by the AI indexer. Photos only — videos
 * + documents are out of scope for the v2.15 subsystem (frame extraction
 * comes later). Sorted oldest-first so a resumed scan picks up backlog
 * before newly-arrived rows.
 */
export function getUnindexedAiBatch({ fileTypes = ['photo'], limit = 50 } = {}) {
    const types = Array.isArray(fileTypes) && fileTypes.length ? fileTypes : ['photo'];
    const placeholders = types.map(() => '?').join(',');
    return getDb()
        .prepare(`
        SELECT id, group_id, group_name, file_name, file_path, file_type, file_size, created_at
          FROM downloads
         WHERE file_type IN (${placeholders})
           AND ai_indexed_at IS NULL
         ORDER BY created_at ASC, id ASC
         LIMIT ?
    `)
        .all(...types, Math.max(1, Math.min(500, Number(limit) || 50)));
}

export function setAiIndexedAt(downloadId, now = Date.now()) {
    return getDb()
        .prepare('UPDATE downloads SET ai_indexed_at = ? WHERE id = ?')
        .run(Math.floor(now), Number(downloadId)).changes;
}

/**
 * Counters for the Maintenance → AI page header. One COUNT per capability
 * + a totalEligible/indexed roll-up so the UI can paint progress bars
 * without per-feature round-trips.
 */
export function getAiCounts({ fileTypes = ['photo'] } = {}) {
    const types = Array.isArray(fileTypes) && fileTypes.length ? fileTypes : ['photo'];
    const placeholders = types.map(() => '?').join(',');
    const db = getDb();
    const total = db
        .prepare(`SELECT COUNT(*) AS n FROM downloads WHERE file_type IN (${placeholders})`)
        .get(...types).n;
    const indexed = db
        .prepare(
            `SELECT COUNT(*) AS n FROM downloads WHERE file_type IN (${placeholders}) AND ai_indexed_at IS NOT NULL`,
        )
        .get(...types).n;
    const withEmbedding = db.prepare(`SELECT COUNT(*) AS n FROM image_embeddings`).get().n;
    const withFaces = db.prepare(`SELECT COUNT(DISTINCT download_id) AS n FROM faces`).get().n;
    const withTags = db.prepare(`SELECT COUNT(DISTINCT download_id) AS n FROM image_tags`).get().n;
    const peopleCount = db.prepare(`SELECT COUNT(*) AS n FROM people`).get().n;
    const totalFaces = db.prepare(`SELECT COUNT(*) AS n FROM faces`).get().n;
    const noiseFaces = db
        .prepare(`SELECT COUNT(*) AS n FROM faces WHERE person_id IS NULL OR person_id = -1`)
        .get().n;
    return {
        totalEligible: total,
        indexed,
        unindexed: Math.max(0, total - indexed),
        withEmbedding,
        withFaces,
        withTags,
        peopleCount,
        totalFaces,
        noiseFaces,
    };
}

// ---- Image embeddings -----------------------------------------------------

export function setImageEmbedding(downloadId, embeddingBlob, model, now = Date.now()) {
    return getDb()
        .prepare(`
        INSERT INTO image_embeddings (download_id, embedding, model, indexed_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(download_id) DO UPDATE SET
            embedding  = excluded.embedding,
            model      = excluded.model,
            indexed_at = excluded.indexed_at
    `)
        .run(Number(downloadId), embeddingBlob, String(model), Math.floor(now)).changes;
}

/**
 * Stream every embedding row for the in-memory cosine-sim path. JOINs
 * `downloads` so the search caller can return file metadata in one round
 * trip. Iterator-based — see `CLAUDE.md → Big-data patterns rule 1`. The
 * caller (vector-store.topK) materialises only the top-K results, so even
 * a 1M-row library scans linearly without holding everything in heap.
 */
export function iterateAllImageEmbeddings({ fileTypes = null } = {}) {
    let where = '';
    const params = [];
    if (Array.isArray(fileTypes) && fileTypes.length) {
        where = ` WHERE d.file_type IN (${fileTypes.map(() => '?').join(',')})`;
        params.push(...fileTypes);
    }
    return getDb()
        .prepare(`
        SELECT e.download_id, e.embedding, e.model, e.indexed_at,
               d.id, d.group_id, d.group_name, d.file_name, d.file_path,
               d.file_type, d.file_size, d.created_at
          FROM image_embeddings e
          JOIN downloads d ON d.id = e.download_id
          ${where}
    `)
        .iterate(...params);
}

/**
 * Distinct embedding-model values currently stored. Used by
 * `clearStaleEmbeddings` after a model swap.
 */
export function listEmbeddingModels() {
    return getDb()
        .prepare(`
        SELECT model, COUNT(*) AS count
          FROM image_embeddings
         GROUP BY model
    `)
        .all();
}

/**
 * Nuke every AI artefact and reset every download's `ai_indexed_at`
 * stamp so the next scan reprocesses the entire library from scratch.
 * Used by the "Re-index everything" button when the operator changes
 * model, dtype, or label list and wants a clean baseline. Returns
 * counts so the UI can show what was reset.
 */
export function resetAllAiData() {
    const db = getDb();
    const tx = db.transaction(() => {
        const embeddings = db.prepare('DELETE FROM image_embeddings').run().changes;
        const tags = db.prepare('DELETE FROM image_tags').run().changes;
        const faces = db.prepare('DELETE FROM faces').run().changes;
        const people = db.prepare('DELETE FROM people').run().changes;
        const requeued = db
            .prepare('UPDATE downloads SET ai_indexed_at = NULL WHERE ai_indexed_at IS NOT NULL')
            .run().changes;
        return { embeddings, tags, faces, people, requeued };
    });
    return tx();
}

/**
 * Drop every embedding row whose `model` differs from `currentModelId`,
 * then reset `downloads.ai_indexed_at = NULL` for the affected rows so
 * the next scan re-embeds them. Wrapped in one transaction so a partial
 * state can never linger.
 */
export function clearStaleEmbeddings(currentModelId) {
    const target = String(currentModelId || '').trim();
    if (!target) return { dropped: 0, requeued: 0 };
    const db = getDb();
    const tx = db.transaction((modelId) => {
        const dropped = db
            .prepare(`DELETE FROM image_embeddings WHERE model != ?`)
            .run(modelId).changes;
        const requeued = db
            .prepare(`
                UPDATE downloads
                   SET ai_indexed_at = NULL
                 WHERE id NOT IN (SELECT download_id FROM image_embeddings)
                   AND ai_indexed_at IS NOT NULL
            `)
            .run().changes;
        return { dropped, requeued };
    });
    return tx(target);
}

// ---- Faces & people -------------------------------------------------------

export function insertFace({ downloadId, x, y, w, h, embeddingBlob, personId = null }) {
    return getDb()
        .prepare(`
        INSERT INTO faces (download_id, x, y, w, h, embedding, person_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
        .run(
            Number(downloadId),
            Number(x),
            Number(y),
            Number(w),
            Number(h),
            embeddingBlob,
            personId == null ? null : Number(personId),
        );
}

export function deleteFacesForDownload(downloadId) {
    return getDb().prepare('DELETE FROM faces WHERE download_id = ?').run(Number(downloadId))
        .changes;
}

/** Streamed iterator for the clustering pass — see Big-data rule 1. */
// Chunked face iterator. Reconciles two competing constraints:
//
//   1. better-sqlite3's `.iterate()` holds the DB connection open for
//      the lifetime of the JS-side loop. If the caller yields to the
//      event loop mid-iteration, an incoming POST /api/config writer
//      collides and gets "This database connection is busy" — visible
//      to operators as a "config save failed" toast.
//   2. Loading ALL rows via `.all()` is fine for a 50k-face library
//      but blows up at million-face scale (~2 GB Node heap).
//
// Solution: paginate via LIMIT/OFFSET in 1 000-row chunks. Each chunk's
// `.all()` releases the connection immediately, so any pending writer
// (config save, faststart stamp, faces.insert from Phase A's parallel
// detect) can run between chunks. The caller's `setImmediate` yields
// land in those windows naturally.
//
// 1 000-row chunk × 2 KB/row = 2 MB working set per pull, well within
// V8 heap limits at any library size. Total wall time is comparable to
// a single `.iterate()` walk; the only overhead is one extra SQL parse
// per chunk (~µs).
export function* iterateAllFaces({ chunkSize = 1000 } = {}) {
    const db = getDb();
    const stmt = db.prepare(
        `SELECT id, download_id, x, y, w, h, embedding, person_id FROM faces
         ORDER BY id LIMIT ? OFFSET ?`,
    );
    for (let offset = 0; ; offset += chunkSize) {
        const chunk = stmt.all(chunkSize, offset);
        if (!chunk.length) return;
        for (const row of chunk) yield row;
        if (chunk.length < chunkSize) return;
    }
}

/**
 * Update only the `quality_score` column on an existing face row. Used
 * by the v2.16 quality filter so the UI can show "low confidence"
 * warnings on borderline detections without re-running the scan.
 */
export function setFaceQualityScore(faceId, qualityScore) {
    return getDb()
        .prepare('UPDATE faces SET quality_score = ? WHERE id = ?')
        .run(Number(qualityScore), Number(faceId)).changes;
}

/**
 * Merge cluster `otherId` into `targetId`. Every face previously
 * assigned to `otherId` is reassigned to `targetId`; the empty
 * cluster row is deleted. Face counts are recalculated from the live
 * row count so they stay accurate across operations.
 *
 * Returns `{ moved, deleted }` so the UI can show a precise toast.
 */
export function mergeFacePerson(targetId, otherId) {
    const t = Number(targetId);
    const o = Number(otherId);
    if (!Number.isFinite(t) || !Number.isFinite(o) || t === o) {
        return { moved: 0, deleted: 0 };
    }
    const db = getDb();
    const tx = db.transaction(() => {
        const moved = db
            .prepare('UPDATE faces SET person_id = ? WHERE person_id = ?')
            .run(t, o).changes;
        const newCount = db.prepare('SELECT COUNT(*) AS n FROM faces WHERE person_id = ?').get(t).n;
        db.prepare('UPDATE people SET face_count = ?, updated_at = ? WHERE id = ?').run(
            newCount,
            Date.now(),
            t,
        );
        const deleted = db.prepare('DELETE FROM people WHERE id = ?').run(o).changes;
        return { moved, deleted };
    });
    return tx();
}

/**
 * Pull a set of face ids out of their current cluster(s) and create a
 * fresh cluster containing only those faces. The new cluster's
 * centroid is computed from the moved faces' embeddings. Useful when
 * DBSCAN over-grouped two similar-looking people.
 *
 * Returns `{ personId, moved }` where personId is the new cluster's id.
 */
export function splitFacePerson(faceIds, label = null) {
    const ids = (Array.isArray(faceIds) ? faceIds : [])
        .map((x) => Number(x))
        .filter((x) => Number.isFinite(x) && x > 0);
    if (!ids.length) return { personId: null, moved: 0 };
    const db = getDb();
    const tx = db.transaction(() => {
        const placeholders = ids.map(() => '?').join(',');
        const rows = db
            .prepare(`SELECT id, embedding, person_id FROM faces WHERE id IN (${placeholders})`)
            .all(...ids);
        if (!rows.length) return { personId: null, moved: 0 };
        // Compute centroid from the picked faces. Float32 sum then
        // divide — avoids the spread + Math.max pattern the OOM guard
        // rejects.
        const dim = rows[0].embedding.byteLength / 4;
        const acc = new Float32Array(dim);
        for (const r of rows) {
            const view = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, dim);
            for (let i = 0; i < dim; i++) acc[i] += view[i];
        }
        for (let i = 0; i < dim; i++) acc[i] /= rows.length;
        const centroidBlob = Buffer.from(acc.buffer);
        const now = Date.now();
        const r = db
            .prepare(`
                INSERT INTO people (label, embedding_centroid, face_count, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
            `)
            .run(label, centroidBlob, rows.length, now, now);
        const newPersonId = r.lastInsertRowid;
        const moved = db
            .prepare(`UPDATE faces SET person_id = ? WHERE id IN (${placeholders})`)
            .run(newPersonId, ...ids).changes;
        // Update each source cluster's face_count + drop those whose
        // count hit zero.
        const oldPersonIds = [...new Set(rows.map((r) => r.person_id).filter((x) => x))];
        for (const pid of oldPersonIds) {
            const n = db.prepare('SELECT COUNT(*) AS n FROM faces WHERE person_id = ?').get(pid).n;
            if (n === 0) {
                db.prepare('DELETE FROM people WHERE id = ?').run(pid);
            } else {
                db.prepare('UPDATE people SET face_count = ?, updated_at = ? WHERE id = ?').run(
                    n,
                    now,
                    pid,
                );
            }
        }
        return { personId: Number(newPersonId), moved };
    });
    return tx();
}

/**
 * Move a single face to a different cluster (or to no cluster if
 * `personId` is null). Updates both the source and destination
 * cluster's `face_count`. The source cluster is deleted if its count
 * hits zero.
 */
export function reassignFace(faceId, personId) {
    const fid = Number(faceId);
    const pid = personId == null ? null : Number(personId);
    if (!Number.isFinite(fid)) return { ok: false };
    const db = getDb();
    const tx = db.transaction(() => {
        const before = db.prepare('SELECT person_id FROM faces WHERE id = ?').get(fid);
        if (!before) return { ok: false };
        const oldPid = before.person_id;
        db.prepare('UPDATE faces SET person_id = ? WHERE id = ?').run(pid, fid);
        const now = Date.now();
        for (const p of [oldPid, pid]) {
            if (p == null) continue;
            const n = db.prepare('SELECT COUNT(*) AS n FROM faces WHERE person_id = ?').get(p).n;
            if (n === 0 && p === oldPid) {
                db.prepare('DELETE FROM people WHERE id = ?').run(p);
            } else {
                db.prepare('UPDATE people SET face_count = ?, updated_at = ? WHERE id = ?').run(
                    n,
                    now,
                    p,
                );
            }
        }
        return { ok: true, oldPersonId: oldPid, newPersonId: pid };
    });
    return tx();
}

/**
 * Find the closest persisted (labelled) cluster to a freshly computed
 * centroid. Used by the v2.16 re-cluster label-preservation flow: when
 * a new DBSCAN pass produces cluster X with centroid C, this returns
 * the existing labelled cluster within `eps` so its label can carry
 * over. Returns null when no match is within `eps`.
 *
 * Walks `people` once (small table — number of unique humans, typically
 * dozens). Streams with `.iterate()` defensively in case a power user
 * has tens of thousands of clusters.
 */
export function matchClusterToPersistedLabel(centroid, eps = 0.4) {
    if (!(centroid instanceof Float32Array)) return null;
    const dim = centroid.length;
    const stmt = getDb().prepare(
        'SELECT id, label, embedding_centroid FROM people WHERE label IS NOT NULL',
    );
    let bestId = null;
    let bestDist = Infinity;
    let bestLabel = null;
    for (const row of stmt.iterate()) {
        if (row.embedding_centroid.byteLength !== dim * 4) continue;
        const other = new Float32Array(
            row.embedding_centroid.buffer,
            row.embedding_centroid.byteOffset,
            dim,
        );
        let sum = 0;
        for (let i = 0; i < dim; i++) {
            const d = centroid[i] - other[i];
            sum += d * d;
        }
        const dist = Math.sqrt(sum);
        if (dist < bestDist && dist <= eps) {
            bestDist = dist;
            bestId = row.id;
            bestLabel = row.label;
        }
    }
    return bestId == null ? null : { id: bestId, label: bestLabel, distance: bestDist };
}

export function setFacePerson(faceId, personId) {
    return getDb()
        .prepare('UPDATE faces SET person_id = ? WHERE id = ?')
        .run(personId == null ? null : Number(personId), Number(faceId)).changes;
}

export function clearAllPeople() {
    const db = getDb();
    const tx = db.transaction(() => {
        db.prepare('UPDATE faces SET person_id = NULL').run();
        db.prepare('DELETE FROM people').run();
    });
    tx();
}

export function insertPerson({ label = null, centroidBlob, faceCount = 0 }) {
    const now = Date.now();
    const r = getDb()
        .prepare(`
        INSERT INTO people (label, embedding_centroid, face_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
    `)
        .run(label, centroidBlob, Math.max(0, Number(faceCount) || 0), now, now);
    return r.lastInsertRowid;
}

export function listPeople({ limit = 500, offset = 0 } = {}) {
    const lim = Math.max(1, Math.min(1000, Number(limit) || 500));
    const off = Math.max(0, Number(offset) || 0);
    const rows = getDb()
        .prepare(`
        SELECT p.id, p.label, p.face_count, p.created_at, p.updated_at,
               (SELECT f.download_id FROM faces f WHERE f.person_id = p.id LIMIT 1) AS cover_download_id
          FROM people p
         ORDER BY p.face_count DESC, p.id ASC
         LIMIT ? OFFSET ?
    `)
        .all(lim, off);
    const total = getDb().prepare('SELECT COUNT(*) AS n FROM people').get().n;
    return { people: rows, total };
}

export function renamePerson(id, label) {
    return getDb()
        .prepare(`UPDATE people SET label = ?, updated_at = ? WHERE id = ?`)
        .run(label == null ? null : String(label), Date.now(), Number(id)).changes;
}

export function deletePerson(id) {
    // ON DELETE SET NULL on faces.person_id keeps face rows around so a
    // re-cluster can re-assign them — we don't lose embeddings.
    return getDb().prepare('DELETE FROM people WHERE id = ?').run(Number(id)).changes;
}

export function listPhotosForPerson(personId, { limit = 50, offset = 0 } = {}) {
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    const rows = getDb()
        .prepare(`
        SELECT DISTINCT d.*
          FROM faces f
          JOIN downloads d ON d.id = f.download_id
         WHERE f.person_id = ?
         ORDER BY d.created_at DESC, d.id DESC
         LIMIT ? OFFSET ?
    `)
        .all(Number(personId), lim, off);
    const total = getDb()
        .prepare(`SELECT COUNT(DISTINCT download_id) AS n FROM faces WHERE person_id = ?`)
        .get(Number(personId)).n;
    return { files: rows, total };
}

// ---- Image tags -----------------------------------------------------------

export function setImageTags(downloadId, tags) {
    if (!Array.isArray(tags) || !tags.length) return 0;
    const db = getDb();
    const ins = db.prepare(`
        INSERT INTO image_tags (download_id, tag, score) VALUES (?, ?, ?)
        ON CONFLICT(download_id, tag) DO UPDATE SET score = excluded.score
    `);
    const tx = db.transaction(() => {
        let n = 0;
        for (const t of tags) {
            if (!t || !t.tag) continue;
            ins.run(Number(downloadId), String(t.tag).slice(0, 80), Number(t.score) || 0);
            n += 1;
        }
        return n;
    });
    return tx();
}

export function clearImageTagsForDownload(downloadId) {
    return getDb().prepare('DELETE FROM image_tags WHERE download_id = ?').run(Number(downloadId))
        .changes;
}

export function listAllTags({ minCount = 1 } = {}) {
    return getDb()
        .prepare(`
        SELECT tag, COUNT(*) AS count, AVG(score) AS avg_score
          FROM image_tags
         GROUP BY tag
        HAVING count >= ?
         ORDER BY count DESC, tag ASC
         LIMIT 1000
    `)
        .all(Math.max(1, Number(minCount) || 1));
}

export function listPhotosForTag(tag, { limit = 50, offset = 0 } = {}) {
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    const rows = getDb()
        .prepare(`
        SELECT d.*, t.score AS tag_score
          FROM image_tags t
          JOIN downloads d ON d.id = t.download_id
         WHERE t.tag = ?
         ORDER BY t.score DESC, d.created_at DESC
         LIMIT ? OFFSET ?
    `)
        .all(String(tag), lim, off);
    const total = getDb()
        .prepare('SELECT COUNT(*) AS n FROM image_tags WHERE tag = ?')
        .get(String(tag)).n;
    return { files: rows, total };
}

// ---- KV blob store --------------------------------------------------------
//
// Generic key/value persistence that replaces the old data/*.json files.
// Values are arbitrary JSON; everything is round-tripped through
// JSON.stringify / JSON.parse so callers see real objects, not strings.
// kvSet wraps the upsert in a transaction so a partial write can never
// land — same atomicity guarantee the previous tmp+rename pattern gave us.

export function kvGet(key) {
    const row = _prep('SELECT value FROM kv WHERE key = ?').get(String(key));
    if (!row) return null;
    try {
        return JSON.parse(row.value);
    } catch {
        // Corrupt row — surface as null so the caller falls back to defaults
        // rather than crashing the whole boot path.
        return null;
    }
}

export function kvSet(key, value) {
    const json = JSON.stringify(value);
    const now = Date.now();
    const stmt = _prep(`
        INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    // better-sqlite3 throws `This database connection is busy executing
    // a query` when a long-running `.iterate()` holds the connection
    // while `kvSet` writes. The root cause is upstream — see
    // `iterateAllFaces` (now using `.all()` instead). Keep a defensive
    // 4-attempt retry with a sync sleep here for the remaining iter
    // call-sites (integrity sweep, dedup sweep) that legitimately stream
    // through high-cardinality tables; without it those sweeps could
    // race a UI save and surface a confusing toast to the operator.
    const RETRIES = 4;
    const BACKOFF_MS = 50;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
        try {
            getDb().transaction(() => {
                stmt.run(String(key), json, now);
            })();
            return;
        } catch (e) {
            const msg = String(e?.message || e);
            const busy =
                msg.includes('database connection is busy') ||
                msg.includes('SQLITE_BUSY') ||
                e?.code === 'SQLITE_BUSY';
            if (!busy || attempt === RETRIES - 1) throw e;
            const buf = new SharedArrayBuffer(4);
            Atomics.wait(new Int32Array(buf), 0, 0, BACKOFF_MS);
        }
    }
}

export function kvDelete(key) {
    return _prep('DELETE FROM kv WHERE key = ?').run(String(key)).changes;
}

export function kvList() {
    // KV is small in practice (config + a handful of progress / cache rows)
    // but explicit LIMIT is defence-in-depth — see CLAUDE.md "Big-data
    // patterns". Iterator drains row-by-row so a future runaway writer
    // can't blow the JS heap in a single `.all()`.
    const out = {};
    const iter = _prep('SELECT key, value FROM kv LIMIT 10000').iterate();
    for (const r of iter) {
        try {
            out[r.key] = JSON.parse(r.value);
        } catch {
            /* skip corrupt row */
        }
    }
    return out;
}

// ---- Spilled-queue backlog ------------------------------------------------
//
// Replaces data/logs/queue_backlog.jsonl. The downloader spills queued jobs
// here when the in-memory lane size crosses `advanced.downloader.spilloverThreshold`,
// and rehydrates from here when worker capacity frees up. SQLite gives us
// atomic appends, indexed FIFO reads, and a clean DELETE-after-pop tx so a
// crash mid-rehydrate can't lose or double-deliver a job.

export function pushQueueBacklog(job) {
    const stmt = _prep(`
        INSERT INTO queue_backlog (job, created_at) VALUES (?, ?)
    `);
    stmt.run(JSON.stringify(job), Date.now());
}

/**
 * Pop up to `limit` jobs FIFO. Returns the parsed job objects in insertion
 * order. The SELECT + DELETE happen in one transaction so a concurrent
 * worker (rare; we only have one downloader) couldn't take the same row
 * twice.
 */
export function popQueueBacklog(limit = 1000) {
    const lim = Math.max(1, Math.min(10000, Number(limit) || 1000));
    const select = _prep('SELECT id, job FROM queue_backlog ORDER BY id ASC LIMIT ?');
    const del = _prep('DELETE FROM queue_backlog WHERE id = ?');
    const out = [];
    getDb().transaction(() => {
        const rows = select.all(lim);
        for (const r of rows) {
            try {
                out.push(JSON.parse(r.job));
            } catch {
                /* corrupt row — drop it */
            }
            del.run(r.id);
        }
    })();
    return out;
}

export function queueBacklogSize() {
    const r = _prep('SELECT COUNT(1) AS n FROM queue_backlog').get();
    return Number(r?.n) || 0;
}

export function clearQueueBacklog() {
    return _prep('DELETE FROM queue_backlog').run().changes;
}

// ---- Auto-update audit ---------------------------------------------------
//
// Every /api/update click writes one row. The audit row is INSERTed up
// front in status='triggered' BEFORE any work; pre-flight failures
// UPDATE it to 'failed' in place. The new container's boot path
// promotes 'triggered' rows to 'success' when it observes either a
// version change OR an instance_id change.

const UPDATE_STATUS_PENDING = 'pending'; // reserved — not used by the active flow
const UPDATE_STATUS_TRIGGERED = 'triggered';
const UPDATE_STATUS_SUCCESS = 'success';
const UPDATE_STATUS_FAILED = 'failed';
const UPDATE_STATUS_STALLED = 'stalled';

// `triggered` rows older than this without a matching version/instance_id
// change are considered stalled. Default 10 min covers every healthy
// watchtower pull + recreate cycle; tunable via UPDATE_STALL_AFTER_MS for
// operators on slow disks / thin links.
const UPDATE_STALL_AFTER_MS = (() => {
    const raw = Number(process.env.UPDATE_STALL_AFTER_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000;
})();

const BOOT_INSTANCE_ID_KEY = 'boot_instance_id';
let _bootInstanceId = null;

/**
 * Generate a fresh UUIDv4, persist it to kv['boot_instance_id'], and
 * cache it for in-process reads. Called exactly once per process during
 * getDb() bootstrap; subsequent reads come from the cached value.
 */
function _rotateBootInstanceId() {
    const id = randomUUID();
    kvSet(BOOT_INSTANCE_ID_KEY, id);
    _bootInstanceId = id;
    return id;
}

/**
 * Read the current process's boot instance ID. Lazy-loaded from kv on
 * the first call after bootstrap; should normally just return the
 * cached value populated by _rotateBootInstanceId().
 */
export function getBootInstanceId() {
    if (_bootInstanceId) return _bootInstanceId;
    try {
        const v = kvGet(BOOT_INSTANCE_ID_KEY);
        if (typeof v === 'string' && v.length > 0) {
            _bootInstanceId = v;
            return v;
        }
    } catch {
        /* db not ready yet — caller should retry post-getDb() */
    }
    return null;
}

/**
 * Record a fresh update attempt up front. INSERTs a 'triggered' row
 * with the click-time metadata and returns the row id; the caller
 * either finalises it via finaliseSuccessfulTrigger() (after watchtower
 * acks) or recordUpdateFailure() (on any pre-flight failure).
 */
export function recordUpdateAttempt({
    fromVersion,
    fromInstanceId = null,
    backupPath = null,
    backupBytes = null,
} = {}) {
    const r = _prep(`
        INSERT INTO update_history
          (from_version, from_instance_id, started_at, status, backup_path, backup_bytes)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        fromVersion ? String(fromVersion) : null,
        fromInstanceId ? String(fromInstanceId) : null,
        Date.now(),
        UPDATE_STATUS_TRIGGERED,
        backupPath,
        backupBytes,
    );
    return Number(r.lastInsertRowid);
}

/**
 * Stamp the snapshot metadata onto a previously-recorded 'triggered'
 * row once the watchtower handoff succeeds. Leaves status='triggered';
 * the boot finaliser will promote to 'success' on the next container
 * recreation.
 */
export function finaliseSuccessfulTrigger({ id, backupPath = null, backupBytes = null } = {}) {
    if (!id) return 0;
    return _prep(`
        UPDATE update_history
           SET backup_path = COALESCE(?, backup_path),
               backup_bytes = COALESCE(?, backup_bytes)
         WHERE id = ?
    `).run(backupPath, backupBytes, id).changes;
}

/**
 * Mark an attempt as failed. Used both for pre-flight failures
 * (watchtower unreachable, DB corrupt, snapshot torn) and post-snapshot
 * trigger failures. UPDATEs in place when an id is supplied; falls back
 * to inserting a fresh failed row when called without one (defensive
 * — should not happen with the up-front recordUpdateAttempt flow).
 *
 * Optional backupPath/backupBytes capture a snapshot that was taken
 * before the failure (e.g. snapshot succeeded but trigger 5xx'd) so
 * the operator can still find the recovery file.
 */
export function recordUpdateFailure({
    id,
    fromVersion,
    fromInstanceId = null,
    errorCode,
    errorMsg,
    backupPath = null,
    backupBytes = null,
} = {}) {
    if (id) {
        _prep(`
            UPDATE update_history
               SET status = ?, finished_at = ?, error_code = ?, error_msg = ?,
                   backup_path = COALESCE(?, backup_path),
                   backup_bytes = COALESCE(?, backup_bytes)
             WHERE id = ?
        `).run(
            UPDATE_STATUS_FAILED,
            Date.now(),
            errorCode || null,
            errorMsg || null,
            backupPath,
            backupBytes,
            id,
        );
        return id;
    }
    const now = Date.now();
    const r = _prep(`
        INSERT INTO update_history
          (from_version, from_instance_id, started_at, finished_at, status,
           error_code, error_msg, backup_path, backup_bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        fromVersion ? String(fromVersion) : null,
        fromInstanceId ? String(fromInstanceId) : null,
        now,
        now,
        UPDATE_STATUS_FAILED,
        errorCode || null,
        errorMsg || null,
        backupPath,
        backupBytes,
    );
    return Number(r.lastInsertRowid);
}

/**
 * Walks every `triggered` row and:
 *
 *   - Stamps it `success` with `to_version = currentVersion` if EITHER
 *     the current package version differs from the row's from_version
 *     OR the current boot_instance_id differs from the row's
 *     from_instance_id (= watchtower recreated us as expected, even on
 *     same-semver `:latest` rebuilds).
 *   - Stamps it `stalled` if neither has changed AND the row is older
 *     than UPDATE_STALL_AFTER_MS (= watchtower acked but never recreated
 *     us, OR we crash-restarted with the same image).
 *   - Leaves it alone otherwise (recently triggered, may still complete).
 *
 * Idempotent — safe to call repeatedly. Invoked once at boot and lazily
 * on every status/history GET so stalled rows surface even when the
 * container hasn't restarted.
 *
 * Returns `{ promoted, stalled }` for logging.
 */
export function finalisePendingUpdates(currentVersion, currentInstanceId = null) {
    const now = Date.now();
    const rows = _prep(
        `SELECT id, from_version, from_instance_id, started_at FROM update_history WHERE status = ?`,
    ).all(UPDATE_STATUS_TRIGGERED);
    let promoted = 0;
    let stalled = 0;
    const promoteStmt = _prep(`
        UPDATE update_history
           SET status = ?, finished_at = ?, to_version = ?
         WHERE id = ?
    `);
    const stallStmt = _prep(`
        UPDATE update_history
           SET status = ?, finished_at = ?, error_code = ?, error_msg = ?
         WHERE id = ?
    `);
    for (const r of rows) {
        const movedVersion =
            currentVersion && r.from_version && String(currentVersion) !== String(r.from_version);
        const movedInstance =
            currentInstanceId &&
            r.from_instance_id &&
            String(currentInstanceId) !== String(r.from_instance_id);
        if (movedVersion || movedInstance) {
            promoteStmt.run(
                UPDATE_STATUS_SUCCESS,
                now,
                currentVersion ? String(currentVersion) : null,
                r.id,
            );
            promoted += 1;
            continue;
        }
        if (now - Number(r.started_at) > UPDATE_STALL_AFTER_MS) {
            stallStmt.run(
                UPDATE_STATUS_STALLED,
                now,
                'STALL_TIMEOUT',
                `Container did not recreate within ${Math.round(UPDATE_STALL_AFTER_MS / 60000)} min; watchtower swap likely never completed.`,
                r.id,
            );
            stalled += 1;
        }
    }
    return { promoted, stalled };
}

/**
 * Read the most recent N update-history rows (newest first). Used by
 * /api/update/history.
 */
export function listUpdateHistory({ limit = 25 } = {}) {
    const lim = Math.max(1, Math.min(200, Number(limit) || 25));
    return _prep(`
        SELECT id, from_version, to_version, from_instance_id, started_at, finished_at,
               status, error_code, error_msg, backup_path, backup_bytes
          FROM update_history
         ORDER BY id DESC
         LIMIT ?
    `).all(lim);
}

// ---- Dashboard sessions ---------------------------------------------------
//
// Replaces the in-memory map + data/web-sessions.json file in core/web-auth.
// Each accessor maps 1:1 to the previous public method on web-auth so the
// caller surface stays unchanged.

export function insertSession({ token, role, expiresAt, issuedAt = Date.now() }) {
    if (role !== 'admin' && role !== 'guest') {
        throw new Error(`insertSession: invalid role ${role}`);
    }
    _prep(`
        INSERT INTO web_sessions (token, role, issued_at, expires_at, last_seen)
        VALUES (?, ?, ?, ?, ?)
    `).run(String(token), role, Number(issuedAt), Number(expiresAt), Number(issuedAt));
}

export function findSession(token) {
    const row = _prep(
        'SELECT token, role, issued_at, expires_at, last_seen FROM web_sessions WHERE token = ?',
    ).get(String(token));
    if (!row) return null;
    if (Number(row.expires_at) <= Date.now()) {
        // Self-clean expired tokens at lookup time so a stale row never
        // satisfies a request even if the GC hasn't run yet.
        deleteSession(token);
        return null;
    }
    return {
        token: row.token,
        role: row.role,
        issuedAt: Number(row.issued_at),
        expiresAt: Number(row.expires_at),
        lastSeen: Number(row.last_seen),
    };
}

export function touchSession(token) {
    _prep('UPDATE web_sessions SET last_seen = ? WHERE token = ?').run(Date.now(), String(token));
}

export function deleteSession(token) {
    return _prep('DELETE FROM web_sessions WHERE token = ?').run(String(token)).changes;
}

export function deleteAllSessions() {
    return _prep('DELETE FROM web_sessions').run().changes;
}

export function deleteSessionsByRole(role) {
    if (role !== 'admin' && role !== 'guest') {
        throw new Error(`deleteSessionsByRole: invalid role ${role}`);
    }
    return _prep('DELETE FROM web_sessions WHERE role = ?').run(role).changes;
}

export function deleteExpiredSessions(nowMs = Date.now()) {
    return _prep('DELETE FROM web_sessions WHERE expires_at <= ?').run(Number(nowMs)).changes;
}

export function listSessions() {
    return _prep(
        'SELECT token, role, issued_at, expires_at, last_seen FROM web_sessions ORDER BY issued_at DESC LIMIT 10000',
    ).all();
}

// ---- Cluster mode (v2.9) --------------------------------------------------
//
// Thin accessors over `peers`, `peer_downloads`, `peer_groups`,
// `peer_accounts`, `peer_history`, `cluster_audit`. Higher-level
// orchestration (handshake, sync, sweep) lives in src/core/cluster/*.

export function listPeers() {
    return _prep(
        'SELECT id, peer_id, name, url, status, stream_mode, last_seen_at, paired_at, fingerprint, version, notes, shared_secret, role, ws_last_seen FROM peers ORDER BY paired_at ASC LIMIT 1000',
    ).all();
}

export function getPeerByPeerId(peerId) {
    if (!peerId) return null;
    return (
        _prep(
            'SELECT id, peer_id, name, url, status, stream_mode, last_seen_at, paired_at, fingerprint, version, notes, shared_secret, role, ws_last_seen FROM peers WHERE peer_id = ?',
        ).get(String(peerId)) || null
    );
}

export function getPeerById(id) {
    return (
        _prep(
            'SELECT id, peer_id, name, url, status, stream_mode, last_seen_at, paired_at, fingerprint, version, notes, shared_secret, role, ws_last_seen FROM peers WHERE id = ?',
        ).get(Number(id)) || null
    );
}

export function upsertPeer({
    peerId,
    name,
    url,
    fingerprint,
    version = null,
    streamMode = 'proxy',
    status = 'online',
    notes = null,
}) {
    if (!peerId || !name || !url || !fingerprint) {
        throw new Error('upsertPeer: peerId, name, url, fingerprint are required');
    }
    const now = Date.now();
    const stmt = _prep(`
        INSERT INTO peers (peer_id, name, url, status, stream_mode, last_seen_at, paired_at, fingerprint, version, notes)
        VALUES (@peerId, @name, @url, @status, @streamMode, @now, @now, @fingerprint, @version, @notes)
        ON CONFLICT(peer_id) DO UPDATE SET
            name         = excluded.name,
            url          = excluded.url,
            status       = excluded.status,
            last_seen_at = excluded.last_seen_at,
            fingerprint  = excluded.fingerprint,
            version      = COALESCE(excluded.version, peers.version),
            notes        = COALESCE(excluded.notes, peers.notes)
    `);
    stmt.run({
        peerId: String(peerId),
        name: String(name),
        url: String(url).replace(/\/+$/, ''),
        status: String(status),
        streamMode: String(streamMode === 'direct' ? 'direct' : 'proxy'),
        now,
        fingerprint: String(fingerprint),
        version: version != null ? String(version) : null,
        notes,
    });
    return getPeerByPeerId(peerId);
}

export function updatePeer(peerId, patch) {
    const cur = getPeerByPeerId(peerId);
    if (!cur) return null;
    const fields = [];
    const args = [];
    if (patch.name !== undefined) {
        fields.push('name = ?');
        args.push(String(patch.name));
    }
    if (patch.url !== undefined) {
        fields.push('url = ?');
        args.push(String(patch.url).replace(/\/+$/, ''));
    }
    if (patch.streamMode !== undefined) {
        fields.push('stream_mode = ?');
        args.push(patch.streamMode === 'direct' ? 'direct' : 'proxy');
    }
    if (patch.status !== undefined) {
        fields.push('status = ?');
        args.push(String(patch.status));
    }
    if (patch.lastSeenAt !== undefined) {
        fields.push('last_seen_at = ?');
        args.push(Number(patch.lastSeenAt) || null);
    }
    if (patch.version !== undefined) {
        fields.push('version = ?');
        args.push(patch.version != null ? String(patch.version) : null);
    }
    if (patch.notes !== undefined) {
        fields.push('notes = ?');
        args.push(patch.notes != null ? String(patch.notes) : null);
    }
    if (!fields.length) return cur;
    args.push(String(peerId));
    getDb()
        .prepare(`UPDATE peers SET ${fields.join(', ')} WHERE peer_id = ?`)
        .run(...args);
    return getPeerByPeerId(peerId);
}

export function deletePeer(peerId) {
    const r = _prep('DELETE FROM peers WHERE peer_id = ?').run(String(peerId));
    if (r.changes > 0) {
        // Cascade-purge cached catalogs so the gallery doesn't keep showing
        // rows from a peer the operator just revoked.
        _prep('DELETE FROM peer_downloads WHERE peer_id = ?').run(String(peerId));
        _prep('DELETE FROM peer_groups WHERE peer_id = ?').run(String(peerId));
        _prep('DELETE FROM peer_accounts WHERE peer_id = ?').run(String(peerId));
        _prep('DELETE FROM peer_history WHERE peer_id = ?').run(String(peerId));
    }
    return r.changes > 0;
}

export function markPeerSeen(peerId, status = 'online') {
    return (
        _prep('UPDATE peers SET status = ?, last_seen_at = ? WHERE peer_id = ?').run(
            String(status),
            Date.now(),
            String(peerId),
        ).changes > 0
    );
}

export function recordClusterAudit({ peerId = null, kind, detail = null, ok = true }) {
    if (!kind) return;
    try {
        _prep(
            'INSERT INTO cluster_audit (ts, peer_id, kind, detail, ok) VALUES (?, ?, ?, ?, ?)',
        ).run(
            Date.now(),
            peerId ? String(peerId) : null,
            String(kind),
            detail ? String(detail).slice(0, 4096) : null,
            ok ? 1 : 0,
        );
    } catch {
        /* never fail a request because of audit write */
    }
}

export function listClusterAudit({ peerId = null, kind = null, limit = 200 } = {}) {
    const where = [];
    const args = [];
    if (peerId) {
        where.push('peer_id = ?');
        args.push(String(peerId));
    }
    if (kind) {
        where.push('kind = ?');
        args.push(String(kind));
    }
    args.push(Math.max(1, Math.min(2000, Number(limit) || 200)));
    return getDb()
        .prepare(
            `SELECT id, ts, peer_id, kind, detail, ok FROM cluster_audit ${
                where.length ? 'WHERE ' + where.join(' AND ') : ''
            } ORDER BY ts DESC LIMIT ?`,
        )
        .all(...args);
}

export function pruneClusterAudit(retainDays = 30) {
    const cutoff = Date.now() - Math.max(1, Number(retainDays)) * 24 * 60 * 60 * 1000;
    return _prep('DELETE FROM cluster_audit WHERE ts < ?').run(cutoff).changes;
}

// Cluster catalog — cached mirror of remote peers' downloads tables.
// The sync engine fills these via /api/cluster/downloads/since.

export function upsertPeerDownloadsBatch(peerId, rows = []) {
    if (!peerId || !rows.length) return 0;
    const now = Date.now();
    const stmt = _prep(`
        INSERT INTO peer_downloads (
            peer_id, remote_id, file_path, file_name, file_size, file_type, file_hash,
            group_id, group_name, message_id, created_at, status, nsfw_score, cached_at
        ) VALUES (
            @peerId, @remoteId, @filePath, @fileName, @fileSize, @fileType, @fileHash,
            @groupId, @groupName, @messageId, @createdAt, @status, @nsfwScore, @cachedAt
        )
        ON CONFLICT(peer_id, remote_id) DO UPDATE SET
            file_path  = excluded.file_path,
            file_name  = excluded.file_name,
            file_size  = excluded.file_size,
            file_type  = excluded.file_type,
            file_hash  = excluded.file_hash,
            group_id   = excluded.group_id,
            group_name = excluded.group_name,
            message_id = excluded.message_id,
            created_at = excluded.created_at,
            status     = excluded.status,
            nsfw_score = excluded.nsfw_score,
            cached_at  = excluded.cached_at
    `);
    let n = 0;
    getDb().transaction(() => {
        for (const r of rows) {
            try {
                stmt.run({
                    peerId: String(peerId),
                    remoteId: Number(r.remoteId ?? r.id),
                    filePath: r.file_path ?? r.filePath ?? null,
                    fileName: r.file_name ?? r.fileName ?? null,
                    fileSize: r.file_size ?? r.fileSize ?? null,
                    fileType: r.file_type ?? r.fileType ?? null,
                    fileHash: r.file_hash ?? r.fileHash ?? null,
                    groupId: r.group_id ?? r.groupId ?? null,
                    groupName: r.group_name ?? r.groupName ?? null,
                    messageId: r.message_id ?? r.messageId ?? null,
                    createdAt:
                        typeof r.created_at === 'string'
                            ? Date.parse(r.created_at) || null
                            : (r.created_at ?? r.createdAt ?? null),
                    status: r.status ?? null,
                    nsfwScore: r.nsfw_score ?? r.nsfwScore ?? null,
                    cachedAt: now,
                });
                n++;
            } catch {
                /* skip malformed row */
            }
        }
    })();
    return n;
}

export function deletePeerDownloadsByRemoteIds(peerId, remoteIds = []) {
    if (!peerId || !remoteIds.length) return 0;
    const stmt = _prep('DELETE FROM peer_downloads WHERE peer_id = ? AND remote_id = ?');
    let n = 0;
    getDb().transaction(() => {
        for (const id of remoteIds) {
            n += stmt.run(String(peerId), Number(id)).changes;
        }
    })();
    return n;
}

export function clearPeerDownloads(peerId) {
    if (!peerId) return 0;
    return _prep('DELETE FROM peer_downloads WHERE peer_id = ?').run(String(peerId)).changes;
}

export function listPeerDownloads(peerId, { limit = 500, offset = 0 } = {}) {
    if (!peerId) return [];
    return _prep(
        'SELECT * FROM peer_downloads WHERE peer_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ).all(String(peerId), Math.max(1, Math.min(2000, limit)), Math.max(0, offset));
}

export function setPeerCatalogBlob(table, peerId, payload) {
    const allowed = new Set(['peer_groups', 'peer_accounts', 'peer_history']);
    if (!allowed.has(table)) throw new Error(`unsupported peer-catalog table: ${table}`);
    const json = JSON.stringify(payload || []);
    const now = Date.now();
    getDb()
        .prepare(`
        INSERT INTO ${table} (peer_id, payload, cached_at) VALUES (?, ?, ?)
        ON CONFLICT(peer_id) DO UPDATE SET payload = excluded.payload, cached_at = excluded.cached_at
    `)
        .run(String(peerId), json, now);
}

export function getPeerCatalogBlob(table, peerId) {
    const allowed = new Set(['peer_groups', 'peer_accounts', 'peer_history']);
    if (!allowed.has(table)) throw new Error(`unsupported peer-catalog table: ${table}`);
    const row = getDb()
        .prepare(`SELECT payload, cached_at FROM ${table} WHERE peer_id = ?`)
        .get(String(peerId));
    if (!row) return null;
    try {
        return { payload: JSON.parse(row.payload), cachedAt: row.cached_at };
    } catch {
        return null;
    }
}

/**
 * Delta query — own downloads with id > sinceId (or created_at >= sinceTs).
 * Returns at most `limit` rows ordered ASCENDING by id so the puller can
 * resume cleanly from the highest id it just saw.
 */
export function listOwnDownloadsSince({ sinceId = 0, limit = 500 } = {}) {
    const lim = Math.max(1, Math.min(2000, Number(limit) || 500));
    const since = Math.max(0, Number(sinceId) || 0);
    return _prep(
        `SELECT id, group_id, group_name, message_id, file_name, file_size, file_type, file_path,
                file_hash, status, created_at, nsfw_score
           FROM downloads
          WHERE id > ?
          ORDER BY id ASC
          LIMIT ?`,
    ).all(since, lim);
}

/**
 * Find a row in the cluster catalog whose hash + size match. Used by the
 * pre-download dedup layer to decide whether to skip a write and ghost
 * the row instead.
 */
export function findClusterByHash(fileHash, fileSize = null) {
    if (!fileHash) return [];
    const args = [String(fileHash)];
    let where = 'file_hash = ?';
    if (fileSize != null) {
        where += ' AND file_size = ?';
        args.push(Number(fileSize));
    }
    return _prep(
        `SELECT peer_id, remote_id, file_path, file_size, file_hash FROM peer_downloads WHERE ${where} LIMIT 5`,
    ).all(...args);
}

/**
 * Cross-source duplicate set — rows that share (file_hash, file_size)
 * across either own downloads OR a peer's catalog. Used by the sweep job.
 * Returns groups with count > 1; each group lists every owner so the
 * sweeper can pick a keeper.
 */
export function findCrossClusterDuplicates({ minSize = 1, limit = 200 } = {}) {
    return _prep(
        `WITH all_rows AS (
            SELECT 'self' AS peer_id, id AS remote_id, file_hash, file_size, file_path, created_at
              FROM downloads
             WHERE file_hash IS NOT NULL AND file_size >= ?
             UNION ALL
            SELECT peer_id, remote_id, file_hash, file_size, file_path, created_at
              FROM peer_downloads
             WHERE file_hash IS NOT NULL AND file_size >= ?
         )
         SELECT file_hash, file_size, COUNT(*) AS n,
                GROUP_CONCAT(peer_id || ':' || remote_id || ':' || file_path, '|') AS owners
           FROM all_rows
          GROUP BY file_hash, file_size
         HAVING COUNT(*) > 1
          ORDER BY n DESC, file_size DESC
          LIMIT ?`,
    ).all(Number(minSize), Number(minSize), Math.max(1, Math.min(2000, limit)));
}

// ---- Cluster v2.10 accessors ---------------------------------------------

export function setPeerSharedSecret(peerId, secret) {
    if (!peerId) return false;
    if (secret == null) {
        return (
            _prep('UPDATE peers SET shared_secret = NULL WHERE peer_id = ?').run(String(peerId))
                .changes > 0
        );
    }
    const buf = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret), 'utf8');
    return (
        _prep('UPDATE peers SET shared_secret = ? WHERE peer_id = ?').run(buf, String(peerId))
            .changes > 0
    );
}

export function getPeerSharedSecret(peerId) {
    if (!peerId) return null;
    const row = _prep('SELECT shared_secret FROM peers WHERE peer_id = ?').get(String(peerId));
    return row?.shared_secret || null;
}

export function setPeerWsLastSeen(peerId, ts = Date.now()) {
    if (!peerId) return;
    _prep('UPDATE peers SET ws_last_seen = ? WHERE peer_id = ?').run(Number(ts), String(peerId));
}

export function recordFailover({ groupId, fromPeerId, toPeerId, reason = null }) {
    _prep(
        `INSERT INTO peer_failover_log (group_id, from_peer_id, to_peer_id, reason, ts)
         VALUES (?, ?, ?, ?, ?)`,
    ).run(String(groupId), String(fromPeerId), String(toPeerId), reason, Date.now());
}

export function listFailoverLog({ limit = 100 } = {}) {
    return _prep(
        'SELECT id, group_id, from_peer_id, to_peer_id, reason, ts FROM peer_failover_log ORDER BY ts DESC LIMIT ?',
    ).all(Math.max(1, Math.min(2000, Number(limit) || 100)));
}

export function enqueuePeerDeleteJob({ peerId, remoteId, reason = null }) {
    if (!peerId || remoteId == null) return null;
    const r = _prep(
        `INSERT INTO peer_delete_jobs (peer_id, remote_id, reason, created_at)
         VALUES (?, ?, ?, ?)`,
    ).run(String(peerId), Number(remoteId), reason, Date.now());
    return r.lastInsertRowid;
}

export function claimNextPeerDeleteJob(now = Date.now()) {
    const row = _prep(
        `SELECT id, peer_id, remote_id, attempts FROM peer_delete_jobs
          WHERE status = 'pending'
          ORDER BY id ASC
          LIMIT 1`,
    ).get();
    if (!row) return null;
    _prep(`UPDATE peer_delete_jobs SET status='running', attempts = attempts + 1 WHERE id = ?`).run(
        row.id,
    );
    return row;
}

export function markPeerDeleteJob(id, status, finished_at = Date.now()) {
    _prep(`UPDATE peer_delete_jobs SET status = ?, finished_at = ? WHERE id = ?`).run(
        String(status),
        Number(finished_at),
        Number(id),
    );
}

export function listPeerDeleteJobs({ status = null, limit = 100 } = {}) {
    const args = [];
    let where = '';
    if (status) {
        where = 'WHERE status = ?';
        args.push(String(status));
    }
    args.push(Math.max(1, Math.min(2000, Number(limit) || 100)));
    return getDb()
        .prepare(
            `SELECT id, peer_id, remote_id, reason, status, attempts, created_at, finished_at
               FROM peer_delete_jobs ${where} ORDER BY id DESC LIMIT ?`,
        )
        .all(...args);
}

export function upsertPeerDiscovery({
    peerId,
    url,
    name = null,
    version = null,
    source = 'broadcast',
}) {
    if (!peerId || !url) return;
    _prep(
        `INSERT INTO peer_discoveries (peer_id, url, name, version, source, seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(peer_id) DO UPDATE SET
            url = excluded.url,
            name = COALESCE(excluded.name, peer_discoveries.name),
            version = COALESCE(excluded.version, peer_discoveries.version),
            source = excluded.source,
            seen_at = excluded.seen_at`,
    ).run(String(peerId), String(url), name, version, String(source), Date.now());
}

export function listDiscoveredPeers({ ttlMs = 5 * 60 * 1000 } = {}) {
    const cutoff = Date.now() - ttlMs;
    return _prep(
        'SELECT peer_id, url, name, version, source, seen_at FROM peer_discoveries WHERE seen_at >= ? ORDER BY seen_at DESC',
    ).all(cutoff);
}

export function pruneDiscoveredPeers(ttlMs = 5 * 60 * 1000) {
    const cutoff = Date.now() - ttlMs;
    return _prep('DELETE FROM peer_discoveries WHERE seen_at < ?').run(cutoff).changes;
}

export function recordEgress({ peerId = null, bytes, fromCache = false }) {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    _prep(
        'INSERT INTO cluster_egress_log (peer_id, bytes, served_at, from_cache) VALUES (?, ?, ?, ?)',
    ).run(peerId ? String(peerId) : null, Number(bytes), Date.now(), fromCache ? 1 : 0);
}

export function pruneEgressLog(retainDays = 31) {
    const cutoff = Date.now() - Math.max(1, retainDays) * 24 * 3600 * 1000;
    return _prep('DELETE FROM cluster_egress_log WHERE served_at < ?').run(cutoff).changes;
}

export function aggregateEgress({ days = 30 } = {}) {
    const cutoff = Date.now() - Math.max(1, days) * 24 * 3600 * 1000;
    return _prep(
        `SELECT peer_id, SUM(bytes) AS total_bytes, COUNT(*) AS req_count, SUM(from_cache) AS cache_hits
           FROM cluster_egress_log
          WHERE served_at >= ?
          GROUP BY peer_id`,
    ).all(cutoff);
}

// ---- Seekbar sprite cache (v2.17) -----------------------------------------
//
// Storage for the WebP-sprite + JSON-metadata pairs that drive the video
// player's hover-preview timeline. One row per indexed video; the sprite
// + sidecar JSON live on disk under `data/seekbar/`. The on-disk filenames
// are derived from the download id (deterministic) so a row referencing
// a missing file is self-healing (the next pregenerate / scan regenerates
// against the new bytes).

export function upsertSeekbarSprite(row) {
    return getDb()
        .prepare(`
        INSERT INTO seekbar_sprites
            (download_id, sprite_path, meta_path, duration_sec, frames, cols, rows,
             tile_w, tile_h, interval_sec, format, bytes, source_size, source_mtime, generated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(download_id) DO UPDATE SET
            sprite_path  = excluded.sprite_path,
            meta_path    = excluded.meta_path,
            duration_sec = excluded.duration_sec,
            frames       = excluded.frames,
            cols         = excluded.cols,
            rows         = excluded.rows,
            tile_w       = excluded.tile_w,
            tile_h       = excluded.tile_h,
            interval_sec = excluded.interval_sec,
            format       = excluded.format,
            bytes        = excluded.bytes,
            source_size  = excluded.source_size,
            source_mtime = excluded.source_mtime,
            generated_at = excluded.generated_at
    `)
        .run(
            Number(row.downloadId),
            String(row.spritePath),
            String(row.metaPath),
            row.durationSec == null ? null : Number(row.durationSec),
            row.frames == null ? null : Number(row.frames),
            row.cols == null ? null : Number(row.cols),
            row.rows == null ? null : Number(row.rows),
            row.tileW == null ? null : Number(row.tileW),
            row.tileH == null ? null : Number(row.tileH),
            row.intervalSec == null ? null : Number(row.intervalSec),
            String(row.format || 'webp'),
            row.bytes == null ? null : Number(row.bytes),
            row.sourceSize == null ? null : Number(row.sourceSize),
            row.sourceMtime == null ? null : Number(row.sourceMtime),
            Math.floor(row.generatedAt || Date.now()),
        ).changes;
}

export function getSeekbarSprite(downloadId) {
    return getDb()
        .prepare('SELECT * FROM seekbar_sprites WHERE download_id = ?')
        .get(Number(downloadId));
}

export function deleteSeekbarSprite(downloadId) {
    return getDb()
        .prepare('DELETE FROM seekbar_sprites WHERE download_id = ?')
        .run(Number(downloadId)).changes;
}

export function deleteAllSeekbarSprites() {
    return getDb().prepare('DELETE FROM seekbar_sprites').run().changes;
}

/**
 * Page through videos that don't yet have a sprite. Keyset pagination
 * over `id` so each call completes synchronously and frees the
 * connection before the caller awaits anywhere. better-sqlite3 holds an
 * exclusive lock for the lifetime of an open `.iterate()` cursor — a
 * long-running scan that awaits between rows would block every other
 * writer, including the downloader itself. Caller passes `beforeId`
 * (use `Number.MAX_SAFE_INTEGER` for the first page) and walks DESC
 * until an empty page comes back.
 */
export function pageMissingSeekbarVideos({ beforeId, limit = 200 } = {}) {
    const before = Number.isFinite(Number(beforeId)) ? Number(beforeId) : Number.MAX_SAFE_INTEGER;
    const lim = Math.max(1, Math.min(2000, Number(limit) || 200));
    return getDb()
        .prepare(`
        SELECT d.id, d.file_path, d.file_type, d.file_size, d.file_name
          FROM downloads d
          LEFT JOIN seekbar_sprites s ON s.download_id = d.id
         WHERE d.file_type = 'video'
           AND d.file_path IS NOT NULL
           AND s.download_id IS NULL
           AND d.id < ?
         ORDER BY d.id DESC
         LIMIT ?
    `)
        .all(before, lim);
}

/**
 * Page through existing seekbar rows for the wipe sweep. Keyset over
 * `download_id` DESC — same connection-safety rationale as
 * `pageMissingSeekbarVideos`.
 */
export function pageSeekbarSprites({ beforeId, limit = 200 } = {}) {
    const before = Number.isFinite(Number(beforeId)) ? Number(beforeId) : Number.MAX_SAFE_INTEGER;
    const lim = Math.max(1, Math.min(2000, Number(limit) || 200));
    return getDb()
        .prepare(`
        SELECT download_id, sprite_path, meta_path, bytes
          FROM seekbar_sprites
         WHERE download_id < ?
         ORDER BY download_id DESC
         LIMIT ?
    `)
        .all(before, lim);
}

export function countSeekbarSprites() {
    return Number(getDb().prepare('SELECT COUNT(*) AS n FROM seekbar_sprites').get().n) || 0;
}

export function sumSeekbarBytes() {
    return (
        Number(
            getDb().prepare('SELECT COALESCE(SUM(bytes), 0) AS s FROM seekbar_sprites').get().s,
        ) || 0
    );
}

export function countVideoDownloads() {
    return (
        Number(
            getDb()
                .prepare(
                    "SELECT COUNT(*) AS n FROM downloads WHERE file_type = 'video' AND file_path IS NOT NULL",
                )
                .get().n,
        ) || 0
    );
}

// ── NSFW hash blocklist ─────────────────────────────────────────────────────

export function addNsfwBlocklistBatch(entries) {
    if (!entries?.length) return 0;
    const db = getDb();
    const stmt = db.prepare(
        'INSERT OR IGNORE INTO nsfw_hash_blocklist (file_hash, file_name, deleted_at, source) VALUES (?, ?, ?, ?)',
    );
    const now = Date.now();
    const tx = db.transaction(() => {
        let n = 0;
        for (const e of entries) {
            if (!e.fileHash) continue;
            stmt.run(e.fileHash, e.fileName || null, now, e.source || 'manual');
            n++;
        }
        return n;
    });
    return tx();
}

export function checkNsfwBlocklistHashes(hashes) {
    if (!hashes?.length) return new Set();
    const db = getDb();
    const ph = hashes.map(() => '?').join(',');
    const rows = db
        .prepare(`SELECT file_hash FROM nsfw_hash_blocklist WHERE file_hash IN (${ph})`)
        .all(...hashes);
    return new Set(rows.map((r) => r.file_hash));
}

export function getNsfwBlocklistCount() {
    return Number(getDb().prepare('SELECT COUNT(*) AS n FROM nsfw_hash_blocklist').get()?.n) || 0;
}

export function clearNsfwBlocklist() {
    return getDb().prepare('DELETE FROM nsfw_hash_blocklist').run().changes;
}

export function getDownloadHashesForIds(ids) {
    if (!ids?.length) return [];
    const db = getDb();
    const results = [];
    for (let i = 0; i < ids.length; i += 500) {
        const slice = ids.slice(i, i + 500);
        const ph = slice.map(() => '?').join(',');
        const rows = db
            .prepare(
                `SELECT id, file_hash, file_name FROM downloads WHERE id IN (${ph}) AND file_hash IS NOT NULL`,
            )
            .all(...slice);
        for (const r of rows) results.push(r);
    }
    return results;
}
