// Boot migration: seekbar "failed" markers written before the sidecar
// timeout fix are cleared once, so the next scan retries those videos.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-seekbar-reset-'));
let db;

beforeAll(async () => {
    // An existing install's DB: one real sprite, one failed marker.
    const old = new Database(path.join(DATA_DIR, 'db.sqlite'));
    old.exec(`
        CREATE TABLE seekbar_sprites (
            download_id INTEGER PRIMARY KEY, sprite_path TEXT NOT NULL, meta_path TEXT NOT NULL,
            duration_sec REAL, frames INTEGER, cols INTEGER, rows INTEGER, tile_w INTEGER,
            tile_h INTEGER, interval_sec REAL, format TEXT, bytes INTEGER, source_size INTEGER,
            source_mtime INTEGER, generated_at INTEGER NOT NULL
        );
        INSERT INTO seekbar_sprites (download_id, sprite_path, meta_path, frames, format, generated_at)
        VALUES (1, '/s/1.webp', '/s/1.json', 100, 'webp', 1), (2, '', '', 0, 'failed', 1),
               (3, '', '', 0, 'no_duration', 1);
    `);
    old.close();

    process.env.TGDL_DATA_DIR = DATA_DIR;
    db = (await import('../src/core/db.js')).getDb();
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('seekbar failed-marker reset', () => {
    it('clears failed markers once and keeps everything else', () => {
        const rows = db
            .prepare('SELECT download_id, format FROM seekbar_sprites ORDER BY download_id')
            .all();
        expect(rows).toEqual([
            { download_id: 1, format: 'webp' },
            { download_id: 3, format: 'no_duration' },
        ]);
        expect(
            db.prepare("SELECT 1 FROM kv WHERE key = 'seekbar_failed_reset'").get(),
        ).toBeTruthy();
    });
});
