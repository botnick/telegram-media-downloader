#!/usr/bin/env node
/**
 * Recover the `groups[]` list in kv['config'] after a failed JSON→SQLite
 * migration (or any other reason kv['config'].groups went empty / wrong)
 * WITHOUT losing media on disk and WITHOUT introducing duplicate folders
 * like "Group A" + "Group A (2)".
 *
 * Two recovery sources, tried in order:
 *
 *   1. data/config.json.migrated — the failed migration's archive of
 *      the original config. If present and parseable, its groups[] are
 *      authoritative because they keep filter settings, auto-forward
 *      destinations, monitor / forward account assignments, and
 *      forum-topic whitelists exactly as they were.
 *
 *   2. SELECT DISTINCT group_id, group_name FROM downloads — every chat
 *      that ever produced a file. Used when the .migrated archive is
 *      missing, empty, or had no groups[] field. The reconstructed
 *      entries get DEFAULT filters; the operator can re-enter
 *      auto-forward etc. through Settings → Groups.
 *
 * Why this avoids the "Group A (2)" trap:
 *   downloads/<sanitised-name>/ folders are produced by sanitizeName(group.name)
 *   at download time — deterministic. We restore the *exact* group_id +
 *   group_name from the existing rows / archive, so the next download
 *   resolves to the same folder. If you instead re-added groups manually
 *   through the dialogs picker, Telegram might return a slightly
 *   different display name (e.g. emoji stripped, language tag changed)
 *   and the sanitised folder would collide with a "(2)" suffix.
 *
 * Default is DRY-RUN — prints the plan and exits without writing.
 * Re-run with `--apply` to commit. The script never deletes anything.
 *
 * Usage:
 *   node scripts/recover_groups.js              # dry-run preview
 *   node scripts/recover_groups.js --apply      # commit to kv['config']
 *   node scripts/recover_groups.js --enable     # also flip enabled=true on restored groups
 *
 * Inside Docker:
 *   docker exec <ctr> node scripts/recover_groups.js
 *   docker exec <ctr> node scripts/recover_groups.js --apply
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { getDb } from '../src/core/db.js';
import { loadConfig, saveConfig } from '../src/config/manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.TGDL_DATA_DIR
    ? path.resolve(process.env.TGDL_DATA_DIR)
    : path.join(PROJECT_ROOT, 'data');

// Mirrors src/config/manager.js DEFAULT_FILTERS — kept inline so this
// script stays runnable even on a checkout where someone changes the
// upstream default (recovery output should not silently drift with the
// active default-filter set).
const DEFAULT_FILTERS = {
    photos: true,
    videos: true,
    files: true,
    links: true,
    voice: false,
    audio: false,
    gifs: false,
    stickers: false,
    urls: true,
};

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const ENABLE = args.has('--enable');

function readJsonOrNull(p) {
    try {
        if (!fs.existsSync(p)) return null;
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
        console.warn(`[recover] could not parse ${p}: ${e.message}`);
        return null;
    }
}

function loadArchivedGroups() {
    // The state-migration step archives the legacy JSON either to
    // `<file>.migrated` (after a clean import) or leaves it untouched
    // (failure path). Try both names so a partial/aborted migration is
    // still recoverable.
    for (const candidate of ['config.json.migrated', 'config.json']) {
        const p = path.join(DATA_DIR, candidate);
        const parsed = readJsonOrNull(p);
        if (parsed && Array.isArray(parsed.groups) && parsed.groups.length > 0) {
            return { groups: parsed.groups, source: p };
        }
    }
    return null;
}

function loadGroupsFromDownloadsTable() {
    const db = getDb();
    const rows = db
        .prepare(`
            SELECT group_id,
                   group_name,
                   COUNT(*)        AS files,
                   MIN(created_at) AS first_seen,
                   MAX(created_at) AS last_seen
              FROM downloads
             WHERE group_id IS NOT NULL
               AND group_id <> ''
             GROUP BY group_id
             ORDER BY last_seen DESC
        `)
        .all();
    return rows.map((r) => ({
        id: String(r.group_id),
        name:
            r.group_name && String(r.group_name).trim()
                ? String(r.group_name).trim()
                : `(group ${r.group_id})`,
        files: r.files,
        first_seen: r.first_seen,
        last_seen: r.last_seen,
    }));
}

function summary(label, groups) {
    if (!groups.length) {
        console.log(`  ${label}: (none)`);
        return;
    }
    console.log(`  ${label}:`);
    for (const g of groups) {
        const idStr = String(g.id).padEnd(20);
        const nameStr = String(g.name || '')
            .slice(0, 50)
            .padEnd(50);
        const files = g._files ?? g.files;
        const lastSeen = g._last_seen ?? g.last_seen;
        const meta = files != null ? `${files} files · last ${lastSeen ?? '—'}` : '';
        console.log(`    ${idStr} ${nameStr} ${meta}`);
    }
}

(function main() {
    const cfg = loadConfig();
    const existing = Array.isArray(cfg.groups) ? cfg.groups : [];
    const existingIds = new Set(existing.map((g) => String(g.id)));

    console.log(`[recover] data dir: ${DATA_DIR}`);
    console.log(`[recover] kv['config'].groups currently: ${existing.length} entries`);

    // Try archived .migrated first
    const archived = loadArchivedGroups();
    const onDisk = loadGroupsFromDownloadsTable();
    console.log(`[recover] archived JSON groups: ${archived ? archived.groups.length : 0}`);
    console.log(`[recover] groups inferable from downloads table: ${onDisk.length}\n`);

    // Index downloads-table evidence by id so we can attach file counts
    // to anything we restore (helps the operator decide what to enable).
    const evidenceById = new Map();
    for (const e of onDisk) evidenceById.set(e.id, e);

    let restored = [];
    let source = '';

    if (archived) {
        // Authoritative path — use the archived group rows verbatim,
        // but only for ids the kv['config'] doesn't already cover.
        source = `archived ${path.basename(archived.source)}`;
        for (const g of archived.groups) {
            if (!g || !g.id) continue;
            const id = String(g.id);
            if (existingIds.has(id)) continue;
            const evidence = evidenceById.get(id);
            restored.push({
                ...g,
                id,
                name: g.name || (evidence?.name ?? `(group ${id})`),
                enabled: ENABLE ? g.enabled !== false : false,
                filters: { ...DEFAULT_FILTERS, ...(g.filters || {}) },
                _files: evidence?.files ?? 0,
                _last_seen: evidence?.last_seen ?? null,
            });
        }
    }

    if (!restored.length) {
        // Fallback — every group_id with downloaded rows that isn't
        // already in kv['config'].
        source = 'downloads table';
        for (const e of onDisk) {
            if (existingIds.has(e.id)) continue;
            restored.push({
                id: e.id,
                name: e.name,
                enabled: ENABLE,
                filters: { ...DEFAULT_FILTERS },
                _files: e.files,
                _last_seen: e.last_seen,
            });
        }
    }

    if (!restored.length) {
        console.log("Nothing to restore — every recoverable group is already in kv['config'].");
        process.exit(0);
    }

    console.log(`Plan — restore ${restored.length} group(s) from ${source}:\n`);
    summary('Will be added', restored);

    // Sanity-check: which restored groups have NO evidence on disk?
    // These came from the .migrated archive only — operator may want to
    // verify they still want to monitor them.
    const noEvidence = restored.filter((g) => !evidenceById.has(String(g.id)));
    if (noEvidence.length) {
        console.log(
            `\nNote: ${noEvidence.length} of these have no rows in the downloads table (archive-only).`,
        );
        console.log(
            'They had no media downloaded yet, or the table was wiped too. Review before enabling.',
        );
    }

    const enabledCount = restored.filter((g) => g.enabled).length;
    console.log(
        `\nDefault: enabled=${ENABLE ? 'true (per --enable)' : 'false (safe — flip on the dashboard)'}.`,
    );
    console.log(`Will write ${enabledCount}/${restored.length} as enabled.\n`);

    if (!APPLY) {
        console.log(
            'Dry-run only. Re-run with --apply to commit. Add --enable to flip enabled=true.',
        );
        process.exit(0);
    }

    // Strip the underscore-prefixed meta fields before writing — kv['config']
    // is the live config tree, not the recovery report.
    const clean = restored.map(({ _files, _last_seen, ...g }) => g);
    const merged = { ...cfg, groups: [...existing, ...clean] };
    saveConfig(merged);
    console.log(`Wrote ${clean.length} group(s) to kv['config'].`);
    console.log('Open Settings → Groups in the dashboard to verify, then start the monitor.');
    console.log(
        'The folder layout under data/downloads/ is unchanged — new files go to the same paths.',
    );
})();
