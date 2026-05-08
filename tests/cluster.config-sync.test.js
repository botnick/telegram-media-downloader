// Live config sync — apply remote changes by replicate policy + ts tiebreak.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-cluster-csync-'));

let db;
let cs;
let configMgr;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    db = await import('../src/core/db.js');
    db.getDb();
    cs = await import('../src/core/cluster/config-sync.js');
    configMgr = await import('../src/config/manager.js');
});

afterAll(() => {
    try {
        db.getDb().close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    try {
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
    } catch {}
});

beforeEach(() => {
    db.getDb().exec("DELETE FROM kv WHERE key='config' OR key='cluster_config_last_ts';");
    cs._resetForTests();
});

describe('applyRemoteConfigChange', () => {
    it("skips when policy is 'local'", () => {
        configMgr.saveConfig({ cluster: { replicate: { advanced: 'local' } } });
        const r = cs.applyRemoteConfigChange({
            key: 'advanced',
            value: { newField: 1 },
            ts: Date.now(),
            peer_id: 'p1',
        });
        expect(r).toBe('skipped');
    });

    it("applies when policy is 'cluster'", () => {
        configMgr.saveConfig({ cluster: { replicate: { advanced: 'cluster' } } });
        const r = cs.applyRemoteConfigChange({
            key: 'advanced',
            value: { newField: 7 },
            ts: Date.now(),
            peer_id: 'p1',
        });
        expect(r).toBe('applied');
        const fresh = configMgr.loadConfig();
        expect(fresh.advanced.newField).toBe(7);
    });

    it('rejects older-than-last-applied ts (last-writer-wins)', () => {
        configMgr.saveConfig({ cluster: { replicate: { advanced: 'cluster' } } });
        const baseTs = Date.now();
        cs.applyRemoteConfigChange({
            key: 'advanced',
            value: { v: 1 },
            ts: baseTs,
            peer_id: 'p1',
        });
        const r = cs.applyRemoteConfigChange({
            key: 'advanced',
            value: { v: 0 },
            ts: baseTs - 1000,
            peer_id: 'p1',
        });
        expect(r).toBe('skipped');
    });
});
