// Integrity sweep: confirms the boot/periodic prune walks every row, deletes
// the ones whose file is missing on disk, and — most importantly — chunks
// the DELETE statement so a sweep with >999 dead rows doesn't blow up on
// SQLite's SQLITE_LIMIT_VARIABLE_NUMBER cap (default 999 on older builds).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-integrity-'));

let dbApi;
let integrity;
let db;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    db = dbApi.getDb();
    integrity = await import('../src/core/integrity.js');
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
    db.exec('DELETE FROM downloads');
});

function insertRow(i, { withFile } = {}) {
    // file_path is relative to data/downloads/. We don't actually create the
    // files for "missing" rows — that's the point of the sweep.
    const rel = `chunk-test/file_${i}.bin`;
    const stmt = db.prepare(
        `INSERT INTO downloads
         (group_id, group_name, message_id, file_name, file_size, file_type, file_path)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run('-1001', 'test-group', i, `file_${i}.bin`, withFile ? 4 : 0, 'document', rel);
}

describe('integrity.sweep', () => {
    it('chunks DELETE so >999 dead rows do not hit SQLITE_LIMIT_VARIABLE_NUMBER', async () => {
        // Insert 1500 rows whose files don't exist on disk. Pre-fix, the
        // sweep built a single `DELETE WHERE id IN (?,?,…)` with 1500
        // placeholders and threw "too many SQL variables" on builds where
        // the limit is 999. With chunking it runs to completion.
        for (let i = 0; i < 1500; i++) insertRow(i);

        const r = await integrity.sweep();
        expect(r.scanned).toBe(1500);
        expect(r.pruned).toBe(1500);

        const remaining = db.prepare('SELECT COUNT(*) AS n FROM downloads').get().n;
        expect(remaining).toBe(0);
    });

    it('reports counts when every file is missing', async () => {
        for (let i = 0; i < 5; i++) insertRow(i);
        const r = await integrity.sweep();
        expect(r.scanned).toBe(5);
        expect(r.pruned).toBe(5);
    });
});
