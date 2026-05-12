/**
 * DB Status — quick overview of the database: table sizes, group breakdown,
 * file types, disk usage, and AI indexing stats.
 *
 * Usage:
 *   node scripts/db-status.js
 *   node scripts/db-status.js --watch    # poll every 10 seconds
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../src/core/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = Number(bytes);
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmt(n) {
    return Number(n).toLocaleString();
}

function hr(title) {
    console.log(`\n${'─'.repeat(4)} ${title}`);
}

async function show() {
    const db = getDb();

    // ── Table sizes ──
    hr('Table Sizes');
    const tables = ['downloads', 'faces', 'people', 'image_embeddings', 'image_tags', 'queue'];
    for (const t of tables) {
        try {
            const r = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get();
            console.log(`  ${t.padEnd(22)} ${fmt(r.n)}`);
        } catch {
            /* table may not exist */
        }
    }

    // ── Groups ──
    hr('Groups by volume');
    const groups = db
        .prepare(`
        SELECT group_name, COUNT(*) AS n,
               SUM(CASE WHEN file_type = 'photo' THEN 1 ELSE 0 END) AS photos,
               SUM(CASE WHEN file_type = 'video' THEN 1 ELSE 0 END) AS videos,
               SUM(file_size) AS bytes,
               MAX(created_at) AS last_activity
          FROM downloads
         GROUP BY group_name
         ORDER BY n DESC
    `)
        .all();
    console.log(
        `  ${'Group'.padEnd(30)} ${'Files'.padStart(7)} ${'Photos'.padStart(7)} ${'Videos'.padStart(7)} ${'Size'.padStart(10)}  Last activity`,
    );
    console.log(
        `  ${'─'.repeat(30)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(10)}  ${'─'.repeat(16)}`,
    );
    for (const g of groups) {
        const name =
            (g.group_name || '?').length > 28
                ? (g.group_name || '?').slice(0, 26) + '…'
                : g.group_name || '?';
        console.log(
            `  ${name.padEnd(30)} ${fmt(g.n).padStart(7)} ${fmt(g.photos).padStart(7)} ${fmt(g.videos).padStart(7)} ${formatBytes(g.bytes).padStart(10)}  ${g.last_activity || '—'}`,
        );
    }

    // ── Totals ──
    const totals = db
        .prepare(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN file_type = 'photo' THEN 1 ELSE 0 END) AS photos,
               SUM(CASE WHEN file_type = 'video' THEN 1 ELSE 0 END) AS videos,
               SUM(CASE WHEN file_type = 'audio' THEN 1 ELSE 0 END) AS audio,
               SUM(CASE WHEN file_type = 'document' THEN 1 ELSE 0 END) AS documents,
               SUM(CASE WHEN file_type = 'voice' THEN 1 ELSE 0 END) AS voice,
               SUM(file_size) AS bytes
          FROM downloads
    `)
        .get();
    hr('Totals by type');
    console.log(`  Photos:      ${fmt(totals.photos)}`);
    console.log(`  Videos:      ${fmt(totals.videos)}`);
    console.log(`  Audio:       ${fmt(totals.audio)}`);
    console.log(`  Documents:   ${fmt(totals.documents)}`);
    console.log(`  Voice:       ${fmt(totals.voice)}`);
    console.log(`  ${'─'.repeat(30)}`);
    console.log(`  Total:       ${fmt(totals.total)} files  (${formatBytes(totals.bytes)})`);

    // ── Recent activity (last 30 min) ──
    hr('Recent activity (last 30 min)');
    const recent = db
        .prepare(`
        SELECT group_name, COUNT(*) AS n, SUM(file_size) AS bytes
          FROM downloads
         WHERE created_at >= datetime('now', '-30 minutes')
         GROUP BY group_name
         ORDER BY n DESC
    `)
        .all();
    if (recent.length) {
        for (const r of recent) {
            console.log(
                `  ${(r.group_name || '?').padEnd(30)} ${fmt(r.n).padStart(5)} files  ${formatBytes(r.bytes).padStart(10)}`,
            );
        }
    } else {
        console.log('  (none)');
    }

    // ── AI stats ──
    hr('AI Indexing');
    const indexed =
        db.prepare(`SELECT COUNT(*) AS n FROM downloads WHERE ai_indexed_at IS NOT NULL`).get()
            ?.n || 0;
    const total = db.prepare(`SELECT COUNT(*) AS n FROM downloads`).get()?.n || 0;
    console.log(
        `  Indexed:      ${fmt(indexed)} / ${fmt(total)} (${total ? Math.round((indexed / total) * 100) : 0}%)`,
    );
    try {
        const faces = db.prepare(`SELECT COUNT(*) AS n FROM faces`).get()?.n || 0;
        const people = db.prepare(`SELECT COUNT(*) AS n FROM people`).get()?.n || 0;
        console.log(`  Faces:        ${fmt(faces)}`);
        console.log(`  People:       ${fmt(people)}`);
        const tags = db.prepare(`SELECT COUNT(*) AS n FROM image_tags`).get()?.n || 0;
        console.log(`  Image tags:   ${fmt(tags)}`);
    } catch {
        /* ai tables may not exist */
    }

    // ── Disk ──
    hr('Disk');
    try {
        const fs = await import('fs/promises');
        const dbPath = path.resolve(__dirname, '..', 'data', 'db.sqlite');
        const stat = await fs.stat(dbPath);
        console.log(`  DB file:      ${formatBytes(stat.size)}`);
        // Check data/downloads size
        const downloadsDir = path.resolve(__dirname, '..', 'data', 'downloads');
        let dirSize = 0;
        try {
            const entries = await fs.readdir(downloadsDir, {
                withFileTypes: true,
                recursive: true,
            });
            for (const e of entries) {
                if (e.isFile()) {
                    const st = await fs.stat(path.join(e.parentPath || downloadsDir, e.name));
                    dirSize += st.size;
                }
            }
        } catch {
            /* may not exist */
        }
        console.log(`  Downloads:    ${formatBytes(dirSize)}`);
    } catch {
        /* skip */
    }

    console.log();
}

const args = process.argv.slice(2);
if (args.includes('--watch') || args.includes('-w')) {
    await show();
    setInterval(show, 10000);
} else {
    await show();
}
