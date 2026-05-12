import { getDb } from '../db.js';

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
    return {
        totalEligible: total,
        indexed,
        unindexed: Math.max(0, total - indexed),
        withEmbedding,
        withFaces,
        withTags,
        peopleCount,
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

/**
 * Find tag pairs that appear together frequently. Suggests which tags
 * might be redundant/similar and could be merged.
 *
 * Returns array of { tag1, tag2, cooccurrence_rate, images_together,
 * images_tag1, images_tag2 } sorted by cooccurrence_rate DESC.
 *
 * @param {number} minCooccurrenceRate - Include pairs above this rate (0-1, default 0.6)
 * @param {number} minImagesPerTag - Exclude tags appearing in fewer than N images (default 2)
 * @returns {Array} Suggested tag merges
 */
export function getTagCooccurrenceSuggestions({
    minCooccurrenceRate = 0.6,
    minImagesPerTag = 2,
} = {}) {
    const db = getDb();
    const minRate = Math.max(0, Math.min(1, Number(minCooccurrenceRate) || 0.6));
    const minImages = Math.max(1, Number(minImagesPerTag) || 2);

    // Get all tags with counts, filter by minImages
    const tags = db
        .prepare(`
        SELECT tag, COUNT(DISTINCT download_id) AS count
          FROM image_tags
         GROUP BY tag
        HAVING count >= ?
         ORDER BY count DESC
    `)
        .all(minImages);

    if (tags.length < 2) return [];

    // For each tag pair, calculate co-occurrence
    const suggestions = [];
    for (let i = 0; i < tags.length; i++) {
        for (let j = i + 1; j < tags.length; j++) {
            const t1 = tags[i].tag;
            const t2 = tags[j].tag;
            const count1 = tags[i].count;
            const count2 = tags[j].count;

            const together = db
                .prepare(`
                SELECT COUNT(DISTINCT t1.download_id) AS n
                  FROM image_tags t1
                  JOIN image_tags t2 ON t1.download_id = t2.download_id
                 WHERE t1.tag = ? AND t2.tag = ?
            `)
                .get(t1, t2).n;

            // Co-occurrence rate: how often they appear together vs apart
            const union = count1 + count2 - together;
            const rate = union > 0 ? together / union : 0;

            if (rate >= minRate && together >= minImages) {
                suggestions.push({
                    tag1: t1,
                    tag2: t2,
                    cooccurrence_rate: Math.round(rate * 100) / 100,
                    images_together: together,
                    images_tag1: count1,
                    images_tag2: count2,
                });
            }
        }
    }

    // Sort by cooccurrence rate DESC
    return suggestions.sort((a, b) => b.cooccurrence_rate - a.cooccurrence_rate);
}

// ---- Image Text (OCR) --------------------------------------------------

export function setImageText(downloadId, text, language = null, confidence = null) {
    if (!downloadId || !text) return 0;
    return getDb()
        .prepare(`
        INSERT INTO image_text (download_id, text, language, confidence, scanned_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(download_id) DO UPDATE SET text = excluded.text, language = excluded.language, confidence = excluded.confidence, scanned_at = excluded.scanned_at
    `)
        .run(
            Number(downloadId),
            String(text).slice(0, 50000),
            language,
            confidence,
            Math.floor(Date.now() / 1000),
        ).changes;
}

export function getImageText(downloadId) {
    return getDb()
        .prepare(
            `SELECT text, language, confidence, scanned_at FROM image_text WHERE download_id = ?`,
        )
        .get(Number(downloadId));
}

export function clearImageText(downloadId) {
    return getDb().prepare('DELETE FROM image_text WHERE download_id = ?').run(Number(downloadId))
        .changes;
}

export function getImagesWithText({ minLength = 10, limit = 50, offset = 0 } = {}) {
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    const minLen = Math.max(1, Number(minLength) || 10);

    const rows = getDb()
        .prepare(`
        SELECT d.*, t.text, t.language, t.confidence
          FROM image_text t
          JOIN downloads d ON d.id = t.download_id
         WHERE LENGTH(t.text) >= ?
         ORDER BY t.scanned_at DESC
         LIMIT ? OFFSET ?
    `)
        .all(minLen, lim, off);

    const total = getDb()
        .prepare('SELECT COUNT(*) AS n FROM image_text WHERE LENGTH(text) >= ?')
        .get(minLen).n;

    return { files: rows, total };
}

// ---- Image Objects (Detection) -----------------------------------------

export function addImageObjects(downloadId, objects) {
    if (!Array.isArray(objects) || !objects.length) return 0;
    const db = getDb();
    const ins = db.prepare(`
        INSERT INTO image_objects (download_id, object, confidence, x, y, w, h, detected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction(() => {
        let n = 0;
        for (const obj of objects) {
            if (!obj || !obj.object) continue;
            ins.run(
                Number(downloadId),
                String(obj.object).slice(0, 80),
                Number(obj.confidence) || 0,
                obj.x ?? null,
                obj.y ?? null,
                obj.w ?? null,
                obj.h ?? null,
                Math.floor(Date.now() / 1000),
            );
            n += 1;
        }
        return n;
    });
    return tx();
}

export function getImageObjects(downloadId) {
    return getDb()
        .prepare(`
        SELECT object, confidence, x, y, w, h
          FROM image_objects
         WHERE download_id = ?
         ORDER BY confidence DESC
    `)
        .all(Number(downloadId));
}

export function clearImageObjects(downloadId) {
    return getDb()
        .prepare('DELETE FROM image_objects WHERE download_id = ?')
        .run(Number(downloadId)).changes;
}

export function listDetectedObjects({ minConfidence = 0.5, limit = 50, offset = 0 } = {}) {
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    const minConf = Math.max(0, Math.min(1, Number(minConfidence) || 0.5));

    return getDb()
        .prepare(`
        SELECT object, COUNT(DISTINCT download_id) AS count, AVG(confidence) AS avg_confidence
          FROM image_objects
         WHERE confidence >= ?
         GROUP BY object
         ORDER BY count DESC
         LIMIT ?  OFFSET ?
    `)
        .all(minConf, lim, off);
}

export function getImagesWithObject(object, { limit = 50, offset = 0 } = {}) {
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);

    const rows = getDb()
        .prepare(`
        SELECT d.*, o.confidence
          FROM image_objects o
          JOIN downloads d ON d.id = o.download_id
         WHERE o.object = ?
         ORDER BY o.confidence DESC, d.created_at DESC
         LIMIT ? OFFSET ?
    `)
        .all(String(object), lim, off);

    const total = getDb()
        .prepare('SELECT COUNT(DISTINCT download_id) AS n FROM image_objects WHERE object = ?')
        .get(String(object)).n;

    return { files: rows, total };
}
