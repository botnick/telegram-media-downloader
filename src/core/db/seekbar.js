import { getDb } from '../db.js';

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
