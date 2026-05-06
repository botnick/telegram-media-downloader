// Integration test for the kv blob store in src/core/db.js. Mirrors the
// isolation pattern used in tests/db.test.js — TGDL_DATA_DIR is pointed at
// an mkdtemp before db.js is imported so the singleton picks up the
// throwaway path.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-kv-test-'));

let db;
let api;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    api = await import('../src/core/db.js');
    db = api.getDb();
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('kv table', () => {
    it('returns null for a missing key', () => {
        expect(api.kvGet('nope')).toBeNull();
    });

    it('round-trips primitives + objects + arrays', () => {
        api.kvSet('num', 42);
        api.kvSet('str', 'hello');
        api.kvSet('obj', { a: 1, b: [2, 3] });
        api.kvSet('arr', [1, 'two', { three: 3 }]);
        expect(api.kvGet('num')).toBe(42);
        expect(api.kvGet('str')).toBe('hello');
        expect(api.kvGet('obj')).toEqual({ a: 1, b: [2, 3] });
        expect(api.kvGet('arr')).toEqual([1, 'two', { three: 3 }]);
    });

    it('overwrites on duplicate key (UPSERT)', () => {
        api.kvSet('overwrite', { v: 1 });
        api.kvSet('overwrite', { v: 2 });
        expect(api.kvGet('overwrite')).toEqual({ v: 2 });
    });

    it('updates updated_at on overwrite', () => {
        api.kvSet('ts', { first: true });
        const t1 = db.prepare('SELECT updated_at FROM kv WHERE key = ?').get('ts').updated_at;
        // Force a clock advance — Node's Date.now() resolution is 1 ms.
        const start = Date.now();
        while (Date.now() === start) {
            /* spin */
        }
        api.kvSet('ts', { first: false });
        const t2 = db.prepare('SELECT updated_at FROM kv WHERE key = ?').get('ts').updated_at;
        expect(t2).toBeGreaterThan(t1);
    });

    it('kvDelete removes the row and returns 1', () => {
        api.kvSet('delme', { x: 1 });
        expect(api.kvGet('delme')).toEqual({ x: 1 });
        const n = api.kvDelete('delme');
        expect(n).toBe(1);
        expect(api.kvGet('delme')).toBeNull();
    });

    it('kvDelete is a no-op for missing keys', () => {
        expect(api.kvDelete('never-existed')).toBe(0);
    });

    it('kvList returns every row keyed by name', () => {
        api.kvSet('list-a', 1);
        api.kvSet('list-b', { two: 2 });
        const all = api.kvList();
        expect(all['list-a']).toBe(1);
        expect(all['list-b']).toEqual({ two: 2 });
    });

    it('survives a corrupt JSON row by returning null', () => {
        // Bypass kvSet to plant a bad row; this mimics a hand-edited DB.
        db.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(
            'corrupt',
            '{not json',
            Date.now(),
        );
        expect(api.kvGet('corrupt')).toBeNull();
    });
});
