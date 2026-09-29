// "Re-index from disk" and the disk-usage scan now walk the tree in
// tgdl-core. The result must be exactly what the Node walk produced:
// same files, same order (INSERT OR IGNORE keeps the first of two files
// with the same message id), same handling of links, hidden files, .part
// files, deeper folders, `.deleted`, empty files and unreadable folders.
//
// Checked two ways: live against the old Node code (tests/helpers/
// node-fs-oracle.js, verbatim) on this OS, and against a frozen fixture
// (tests/fixtures/gocore/reindex-tree.json) produced by that code. Set
// UPDATE_GOCORE_FIXTURES=1 to rewrite the fixture from the Node oracle.

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { requireCoreBin } from './helpers/gocore-raw.js';
import { oracleDiskUsage, oracleReindex } from './helpers/node-fs-oracle.js';

const WIN = process.platform === 'win32';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-walk-parity-'));
const DL = path.join(DATA_DIR, 'downloads');
const OUTSIDE = path.join(DATA_DIR, 'elsewhere');
const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'gocore', 'reindex-tree.json');
const CONFIG_GROUPS = [
    { id: '-1001234', name: 'Main' },
    { id: '-1009', name: 'My Channel' },
];

// rel path → size (bytes of 'x'); folders are implied.
const FILES = {
    '-1001234/images/2024-01-02T03_04_05_101.jpg': 10,
    '-1001234/images/2024-01-02T03_04_05_102.jpg': 0, // empty → skipped
    '-1001234/images/Photo_Upper.JPG': 21, // no message id → synthetic
    '-1001234/images/_underscore_7.png': 7,
    '-1001234/images/a.jpg.part': 5, // in-progress download → skipped
    '-1001234/images/.hidden_55.jpg': 55, // hidden files are indexed
    '-1001234/images/nested/deep_999.jpg': 9, // deeper than type folder → ignored
    '-1001234/videos/clip_101.mp4': 11, // same message id as images/…_101 → ignored
    '-1001234/videos/ไทย_202.mp4': 202,
    '-1001234/loose_303.bin': 33, // file at the group's top level
    '-1001234/loose.part': 3,
    'My Channel/documents/report_404.pdf': 44,
    'My Channel/weird-folder/x_505.txt': 55,
    'My Channel/stickers/s_606.webp': 66,
    'Unknown Group/gifs/g_707.mp4': 77,
    'Unknown Group/Zeta/z_1.jpg': 1,
    'Unknown Group/alpha/a_2.jpg': 2,
    '.deleted/images/trash_808.jpg': 88, // never indexed
    '.hidden-group/images/h_909.jpg': 99,
    'empty-group/.keep': 0,
    'top-file_1.jpg': 111, // files at the downloads root are not groups
};

let dbApi;
let integrity;
let gofs;
let db;
const cleanups = [];

function link(target, at) {
    try {
        fs.symlinkSync(target, at, WIN ? 'junction' : 'dir');
        return true;
    } catch {
        return false;
    }
}

beforeAll(async () => {
    requireCoreBin();
    for (const [rel, size] of Object.entries(FILES)) {
        const p = path.join(DL, ...rel.split('/'));
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, 'x'.repeat(size));
    }
    fs.mkdirSync(path.join(DL, 'empty-group', 'images'), { recursive: true });
    fs.mkdirSync(path.join(OUTSIDE, 'lg', 'images'), { recursive: true });
    fs.writeFileSync(path.join(OUTSIDE, 'lg', 'images', 'l_111.jpg'), 'x'.repeat(1111));
    // A group folder that is a link (not a directory entry → not indexed,
    // not counted), and a link inside a type folder.
    link(path.join(OUTSIDE, 'lg'), path.join(DL, 'linked-group'));
    link(path.join(OUTSIDE, 'lg', 'images'), path.join(DL, '-1001234', 'images', 'linked-dir'));

    process.env.TGDL_DATA_DIR = DATA_DIR;
    delete process.env.TGDL_DOWNLOADS_DIR;
    dbApi = await import('../src/core/db.js');
    db = dbApi.getDb();
    expect(
        path.resolve(db.name).startsWith(path.resolve(DATA_DIR)),
        `db.name ${db.name} escaped the temp dir`,
    ).toBe(true);
    integrity = await import('../src/core/integrity.js');
    gofs = await import('../src/core/gocore/fs.js');
}, 60_000);

afterAll(async () => {
    for (const c of cleanups) {
        try {
            c();
        } catch {}
    }
    const { stopGoCore } = await import('../src/core/gocore/spawn.js');
    stopGoCore();
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const COLS = 'group_id, group_name, message_id, file_name, file_size, file_type, file_path';

async function oracleRows() {
    const seen = new Set();
    const rows = [];
    const counters = await oracleReindex(DL, CONFIG_GROUPS, (r) => {
        const key = `${r.groupId}|${r.messageId}`;
        if (seen.has(key)) return { changes: 0 };
        seen.add(key);
        rows.push({
            group_id: r.groupId,
            group_name: r.groupName,
            message_id: r.messageId,
            file_name: r.fileName,
            file_size: r.fileSize,
            file_type: r.fileType,
            file_path: r.filePath,
        });
        return { changes: 1 };
    });
    return { rows, counters };
}

const pick = (r) => ({
    scanned: r.scanned,
    added: r.added,
    skipped: r.skipped,
    errors: r.errors,
    groups: r.groups,
});

describe('re-index from disk walks like the Node code', () => {
    it('same rows in the same order, same counters', async () => {
        db.exec('DELETE FROM downloads');
        const res = await integrity.reindexFromDisk(CONFIG_GROUPS);
        const rows = db.prepare(`SELECT ${COLS} FROM downloads ORDER BY id`).all();
        const oracle = await oracleRows();
        expect(rows).toEqual(oracle.rows);
        expect(pick(res)).toEqual(oracle.counters);

        const usage = await gofs.diskUsage(DL);
        expect(usage).toBe(await oracleDiskUsage(DL));

        // Frozen expectations (order-independent: NTFS and strcmp order
        // differ for mixed-case names, the set and counters do not).
        const frozen = {
            counters: oracle.counters,
            rows: [...oracle.rows].sort((a, b) => (a.file_path < b.file_path ? -1 : 1)),
            diskUsage: await oracleDiskUsage(DL),
        };
        if (process.env.UPDATE_GOCORE_FIXTURES === '1') {
            fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
            fs.writeFileSync(FIXTURE, `${JSON.stringify(frozen, null, 2)}\n`);
        }
        const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
        expect(pick(res)).toEqual(fixture.counters);
        expect([...rows].sort((a, b) => (a.file_path < b.file_path ? -1 : 1))).toEqual(
            fixture.rows,
        );
        expect(usage).toBe(fixture.diskUsage);
    }, 60_000);

    it('a second run adds nothing (INSERT OR IGNORE), like before', async () => {
        const res = await integrity.reindexFromDisk(CONFIG_GROUPS);
        const oracle = await oracleReindex(DL, CONFIG_GROUPS, () => ({ changes: 0 }));
        expect(res.added).toBe(0);
        expect(pick(res)).toEqual(oracle);
    });

    it('a group folder that cannot be listed fails the run with the same error', async () => {
        const locked = path.join(DL, 'aa-locked');
        fs.mkdirSync(path.join(locked, 'images'), { recursive: true });
        fs.writeFileSync(path.join(locked, 'images', 'x_1.jpg'), 'x');
        let ok;
        if (WIN) {
            const user = process.env.USERNAME;
            ok = spawnSync('icacls', [locked, '/deny', `${user}:(RD)`]).status === 0;
            cleanups.push(() => spawnSync('icacls', [locked, '/remove:d', user]));
        } else {
            fs.chmodSync(locked, 0);
            cleanups.push(() => fs.chmodSync(locked, 0o755));
            ok = process.getuid?.() !== 0;
        }
        if (!ok) return; // can't make an unreadable folder here (root)
        let nodeErr = null;
        try {
            await oracleReindex(DL, CONFIG_GROUPS, () => ({ changes: 0 }));
        } catch (e) {
            nodeErr = e;
        }
        let goErr = null;
        try {
            await integrity.reindexFromDisk(CONFIG_GROUPS);
        } catch (e) {
            goErr = e;
        }
        expect(nodeErr).toBeTruthy();
        expect(goErr).toBeTruthy();
        expect({
            code: goErr.code,
            syscall: goErr.syscall,
            path: goErr.path,
            message: goErr.message,
            errno: goErr.errno,
        }).toEqual({
            code: nodeErr.code,
            syscall: nodeErr.syscall,
            path: nodeErr.path,
            message: nodeErr.message,
            errno: nodeErr.errno,
        });
        for (const c of cleanups.splice(0)) c();
        fs.rmSync(locked, { recursive: true, force: true });
    });

    it('no downloads folder: nothing to do, like before', async () => {
        const res = await integrity.reindexFromDisk(CONFIG_GROUPS);
        expect(res.groups).toBeGreaterThan(0);
        const missing = path.join(DATA_DIR, 'nope');
        const { summary } = await gofs.walkTree(DL, { maxDepth: 1 });
        expect(summary.errors).toBe(0);
        expect(await gofs.diskUsage(DL)).toBe(await oracleDiskUsage(DL));
        // A root that isn't there: Node's walk returned 0.
        expect(await oracleDiskUsage(missing)).toBe(0);
    });
});
