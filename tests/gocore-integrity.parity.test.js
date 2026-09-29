// integrity.sweep now stats through tgdl-core. It must prune exactly the
// rows, and fix exactly the sizes, that the old Promise.all(fs.stat) block
// did (kept verbatim in tests/helpers/node-fs-oracle.js) — for every row
// shape the library can contain: present / resized / empty files, missing
// files and folders, a folder where a file should be, legacy prefixes,
// federated rows, absolute and ../ paths outside the downloads folder,
// links leading out of it, and (Windows) ACL-denied and reserved names.

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { requireCoreBin } from './helpers/gocore-raw.js';
import { oracleSweepChecks } from './helpers/node-fs-oracle.js';

const WIN = process.platform === 'win32';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-integrity-parity-'));
const DL = path.join(DATA_DIR, 'downloads');
const ELSEWHERE = path.join(DATA_DIR, 'elsewhere');
const cleanups = [];

let db;
let integrity;

function put(rel, size) {
    const p = path.join(DL, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x'.repeat(size));
}

beforeAll(async () => {
    requireCoreBin();
    put('g/images/ok_1.jpg', 100);
    put('g/images/resized_2.jpg', 120);
    put('g/images/nullsize_3.jpg', 30);
    put('g/images/empty_4.jpg', 0);
    put('g/videos/v_5.mp4', 55);
    fs.mkdirSync(path.join(DL, 'g', 'a-folder'), { recursive: true });
    fs.mkdirSync(ELSEWHERE, { recursive: true });
    fs.writeFileSync(path.join(ELSEWHERE, 'custom_6.jpg'), 'x'.repeat(66));
    try {
        fs.symlinkSync(ELSEWHERE, path.join(DL, 'linked'), WIN ? 'junction' : 'dir');
    } catch {}
    if (WIN) {
        put('g/acl/denied_7.jpg', 77);
        const user = process.env.USERNAME;
        if (
            spawnSync('icacls', [path.join(DL, 'g', 'acl', 'denied_7.jpg'), '/deny', `${user}:(F)`])
                .status === 0
        ) {
            cleanups.push(() =>
                spawnSync('icacls', [path.join(DL, 'g', 'acl', 'denied_7.jpg'), '/remove:d', user]),
            );
        }
    }

    process.env.TGDL_DATA_DIR = DATA_DIR;
    delete process.env.TGDL_DOWNLOADS_DIR;
    const dbApi = await import('../src/core/db.js');
    db = dbApi.getDb();
    expect(
        path.resolve(db.name).startsWith(path.resolve(DATA_DIR)),
        `db.name ${db.name} escaped the temp dir`,
    ).toBe(true);
    integrity = await import('../src/core/integrity.js');
});

afterAll(async () => {
    for (const c of cleanups) c();
    const { stopGoCore } = await import('../src/core/gocore/spawn.js');
    stopGoCore();
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    await new Promise((r) => setTimeout(r, 200));
    try {
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
    } catch {}
});

const ROWS = [
    ['g/images/ok_1.jpg', 100],
    ['g/images/resized_2.jpg', 99], // size fix
    ['g/images/nullsize_3.jpg', null], // size backfill
    ['g/images/empty_4.jpg', 0], // 0 bytes → prune
    ['data/downloads/g/videos/v_5.mp4', 55], // legacy prefix
    ['data/downloads/data/downloads/g/videos/v_5.mp4', 1], // doubled legacy prefix
    ['g/images/missing_8.jpg', 8], // ENOENT → prune
    ['g/no-such-folder/x_9.jpg', 9], // ENOENT → prune
    ['g/images/ok_1.jpg/child_10.jpg', 10], // a file as a folder → prune
    ['g/a-folder', 11], // a folder where a file should be
    ['_clusterref/peer/x_12.jpg', 12], // federated: never stat'ed
    ['', 13], // no path
    [path.join(ELSEWHERE, 'custom_6.jpg'), 1], // absolute, outside DOWNLOADS_DIR
    ['../elsewhere/custom_6.jpg', 66], // ../ outside
    ['../elsewhere/gone_14.jpg', 14], // ../ outside, missing → prune
    ['linked/custom_6.jpg', 2], // through a link out of the folder
    ['linked/gone_15.jpg', 15], // through a link, missing → prune
    ['g\\images\\ok_1.jpg', 100], // backslashes
    ...(WIN
        ? [
              ['g/acl/denied_7.jpg', 1],
              ['g/images/NUL', 16],
              ['g/images/ok_1.jpg:stream', 17],
              ['g/images/ok_1.jpg.', 18],
          ]
        : []),
];

describe('integrity.sweep decides like the fs.stat sweep', () => {
    it('same rows pruned, same sizes fixed', async () => {
        db.exec('DELETE FROM downloads');
        const ins = db.prepare(
            `INSERT INTO downloads (group_id, group_name, message_id, file_name, file_size, file_type, file_path)
             VALUES ('g', 'g', ?, ?, ?, 'photo', ?)`,
        );
        ROWS.forEach(([p, size], i) => ins.run(i + 1, path.basename(p || 'x'), size, p));
        const rows = db
            .prepare('SELECT id, file_path, file_size FROM downloads ORDER BY id DESC')
            .all();
        const oracle = await oracleSweepChecks(rows, DL);
        expect(oracle.deleteIds.length).toBeGreaterThan(4);
        expect(oracle.sizeFixes.length).toBeGreaterThan(2);

        const res = await integrity.sweep(null, { auto: false });
        expect(res.pruned).toBe(oracle.deleteIds.length);
        expect(res.sizeFixed).toBe(oracle.sizeFixes.length);
        const left = new Map(
            db
                .prepare('SELECT id, file_size FROM downloads')
                .all()
                .map((r) => [r.id, r.file_size]),
        );
        for (const id of oracle.deleteIds) expect(left.has(id), `row ${id} pruned`).toBe(false);
        for (const r of rows) {
            if (oracle.deleteIds.includes(r.id)) continue;
            const fix = oracle.sizeFixes.find((f) => f.id === r.id);
            expect(left.get(r.id), `row ${r.id} (${r.file_path})`).toBe(
                fix ? fix.size : r.file_size,
            );
        }
    });
});
