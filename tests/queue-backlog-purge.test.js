// The removed download-queue spillover stored JSON-serialised jobs that
// included the live gramJS client (API hash + MTProto auth key). Upgrading
// must drop that table and delete the pre-v2.7 JSONL log (and its archived
// copy) instead of keeping the credentials around.

import { describe, it, expect, afterAll, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-backlog-purge-'));
const LOG_DIR = path.join(DATA_DIR, 'logs');
let db;

afterAll(() => {
    db?.close();
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('queue_backlog purge on upgrade', () => {
    it('drops the table and deletes the legacy JSONL files', async () => {
        // An "old install": backlog table with a credential-bearing row.
        const old = new Database(path.join(DATA_DIR, 'db.sqlite'));
        old.exec(
            'CREATE TABLE queue_backlog (id INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT NOT NULL, created_at INTEGER NOT NULL)',
        );
        old.prepare('INSERT INTO queue_backlog (job, created_at) VALUES (?, ?)').run(
            JSON.stringify({ client: { apiHash: 'SECRET-API-HASH-0123456789' } }),
            Date.now(),
        );
        old.close();
        fs.mkdirSync(LOG_DIR, { recursive: true });
        fs.writeFileSync(path.join(LOG_DIR, 'queue_backlog.jsonl'), '{"client":{}}\n');
        fs.writeFileSync(path.join(LOG_DIR, 'queue_backlog.jsonl.migrated'), '{"client":{}}\n');

        process.env.TGDL_DATA_DIR = DATA_DIR;
        vi.resetModules();
        const { getDb } = await import('../src/core/db.js');
        db = getDb();

        const table = db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'queue_backlog'",
            )
            .get();
        expect(table).toBeUndefined();
        // The dropped rows must not survive in free pages of the file.
        db.pragma('wal_checkpoint(TRUNCATE)');
        const raw = fs.readFileSync(path.join(DATA_DIR, 'db.sqlite'));
        expect(raw.includes('SECRET-API-HASH-0123456789')).toBe(false);
        expect(fs.existsSync(path.join(LOG_DIR, 'queue_backlog.jsonl'))).toBe(false);
        expect(fs.existsSync(path.join(LOG_DIR, 'queue_backlog.jsonl.migrated'))).toBe(false);
    });
});
