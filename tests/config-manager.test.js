// Tests the kv-backed config manager: load/save round-trip, deep-merge,
// self-heal write-back, and the EventEmitter-based watchConfig.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-config-manager-'));

let manager;
let dbApi;
let db;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    // Import db.js first so its singleton picks up the temp dir, then the
    // manager — manager imports kvGet/kvSet from db.js.
    dbApi = await import('../src/core/db.js');
    db = dbApi.getDb();
    manager = await import('../src/config/manager.js');
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
    // Clear the kv['config'] row + drain any listeners between tests so each
    // case starts from a clean DEFAULT_CONFIG.
    dbApi.kvDelete('config');
    manager._resetConfigBus();
});

describe('config manager (kv-backed)', () => {
    it('seeds DEFAULT_CONFIG on first load', () => {
        const cfg = manager.loadConfig();
        expect(cfg.telegram.apiId).toBe('');
        expect(cfg.download.concurrent).toBe(10);
        // Row was written so subsequent reads skip the seed branch.
        expect(dbApi.kvGet('config')).toBeTruthy();
    });

    it('saveConfig + loadConfig round-trips a full tree', () => {
        const cfg = manager.loadConfig();
        cfg.telegram.apiId = '99999';
        cfg.download.concurrent = 5;
        manager.saveConfig(cfg);

        const reloaded = manager.loadConfig();
        expect(reloaded.telegram.apiId).toBe('99999');
        expect(reloaded.download.concurrent).toBe(5);
    });

    it('deep-merges new defaults onto a partial stored tree', () => {
        // Plant an old-style config that's missing the advanced.* block.
        dbApi.kvSet('config', { telegram: { apiId: 'x', apiHash: 'y' } });
        const cfg = manager.loadConfig();
        // Defaults filled in:
        expect(cfg.advanced).toBeTruthy();
        expect(cfg.advanced.downloader.maxConcurrency).toBe(20);
        expect(cfg.advanced.history.shortBreakEveryN).toBe(100);
        expect(cfg.rescue.retentionHours).toBe(48);
        // User values preserved:
        expect(cfg.telegram.apiId).toBe('x');
        expect(cfg.telegram.apiHash).toBe('y');
    });

    it('self-heals (writes back) when merge surfaced new keys', () => {
        dbApi.kvSet('config', { telegram: { apiId: 'x', apiHash: 'y' } });
        manager.loadConfig();
        const stored = dbApi.kvGet('config');
        // After load, the stored tree should be the merged shape.
        expect(stored.advanced).toBeTruthy();
        expect(stored.rescue).toBeTruthy();
    });

    it('addGroup upserts and persists', () => {
        const cfg = manager.loadConfig();
        manager.addGroup(cfg, { id: 1, name: 'first' });
        manager.addGroup(cfg, { id: 2, name: 'second' });
        manager.addGroup(cfg, { id: 1, name: 'first-renamed' });

        const reloaded = manager.loadConfig();
        expect(reloaded.groups).toHaveLength(2);
        expect(reloaded.groups.find((g) => g.id === 1).name).toBe('first-renamed');
    });

    it('watchConfig fires synchronously on saveConfig', () => {
        const fired = [];
        const unsub = manager.watchConfig((cfg) => fired.push(cfg.telegram.apiId));

        const cfg = manager.loadConfig();
        cfg.telegram.apiId = 'abc';
        manager.saveConfig(cfg);

        cfg.telegram.apiId = 'xyz';
        manager.saveConfig(cfg);

        expect(fired).toEqual(['abc', 'xyz']);
        unsub();
    });

    it('watchConfig unsubscriber stops further deliveries', () => {
        const fired = [];
        const unsub = manager.watchConfig((cfg) => fired.push(cfg.telegram.apiId));
        const cfg = manager.loadConfig();
        cfg.telegram.apiId = 'before';
        manager.saveConfig(cfg);
        unsub();
        cfg.telegram.apiId = 'after';
        manager.saveConfig(cfg);
        expect(fired).toEqual(['before']);
    });
});
