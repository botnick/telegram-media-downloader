import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { runStateMigration } from './state-migration.js';
import {
    kvGet,
    kvSet,
    insertSession,
    listSessions,
    pushQueueBacklog,
    _rotateBootInstanceId,
    finalisePendingUpdates,
    getBootInstanceId,
} from './db/kv.js';

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
        CREATE TABLE IF NOT EXISTS image_text (
            download_id INTEGER NOT NULL,
            text        TEXT    NOT NULL,
            language    TEXT,
            confidence  REAL,
            scanned_at  INTEGER NOT NULL,
            PRIMARY KEY (download_id),
            FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS image_objects (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            download_id INTEGER NOT NULL,
            object      TEXT    NOT NULL,
            confidence  REAL    NOT NULL,
            x           REAL,
            y           REAL,
            w           REAL,
            h           REAL,
            detected_at INTEGER NOT NULL,
            FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_objects_download ON image_objects(download_id);
        CREATE INDEX IF NOT EXISTS idx_objects_object ON image_objects(object);
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

    // v2.18 — Smart Albums (rule-based saved collections).
    //
    // v1 supports one rule type: `tags_contains` with payload:
    //   { type:'tags_contains', tag:'cat', minScore:0.0..1.0 }.
    // `smart_album_items` is materialized so gallery reads are fast.
    db.exec(`
        CREATE TABLE IF NOT EXISTS smart_albums (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT    NOT NULL,
            rule_json  TEXT    NOT NULL,
            enabled    INTEGER NOT NULL DEFAULT 1,
            sort_key   TEXT    NOT NULL DEFAULT 'created_at_desc',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_smart_albums_updated ON smart_albums(updated_at DESC);
        CREATE TABLE IF NOT EXISTS smart_album_items (
            album_id    INTEGER NOT NULL,
            download_id INTEGER NOT NULL,
            matched_at  INTEGER NOT NULL,
            PRIMARY KEY (album_id, download_id),
            FOREIGN KEY (album_id) REFERENCES smart_albums(id) ON DELETE CASCADE,
            FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_smart_album_items_album ON smart_album_items(album_id, matched_at DESC);
        CREATE INDEX IF NOT EXISTS idx_smart_album_items_download ON smart_album_items(download_id);
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

// ---- Domain module barrel exports -----------------------------------------
//
// All business logic lives in the domain modules below. Importing from
// `core/db.js` continues to work for every existing caller — the barrel
// re-exports flatten the split into a single public surface.

export * from './db/downloads.js';
export * from './db/groups.js';
export * from './db/faces.js';
export * from './db/kv.js';
export * from './db/cluster.js';
export * from './db/seekbar.js';
