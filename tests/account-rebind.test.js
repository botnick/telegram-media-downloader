// Self-healing group→account binding across delete + re-add of the "same"
// Telegram account.
//
// The bug: a group pins an account via `group.monitorAccount`. That id is NOT
// stable across delete + re-add (legacy phone-keyed id vs numeric userId), so
// the pin goes stale and resolution either returns the wrong client or throws
// NO_ACCESS. These specs prove the resolver ignores a dead pin, picks the
// account that actually has access, and re-pins the group to it.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-rebind-'));

let manager;
let dbApi;
let db;
let RealtimeMonitor;
let HistoryDownloader;
let AccountManager;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    // Import db.js first so its singleton binds to the temp dir, then the
    // manager (which imports kvGet/kvSet from db.js) and the engine classes.
    dbApi = await import('../src/core/db.js');
    db = dbApi.getDb();
    manager = await import('../src/config/manager.js');
    ({ RealtimeMonitor } = await import('../src/core/monitor.js'));
    ({ HistoryDownloader } = await import('../src/core/history.js'));
    ({ AccountManager } = await import('../src/core/accounts.js'));
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
    // Clean config row + drain bus listeners so each case starts from defaults
    // and a previous test's watchConfig subscriber can't fire.
    dbApi.kvDelete('config');
    manager._resetConfigBus();
});

// Minimal AccountManager stand-in: just the surface the resolver touches
// (clients map + getClient + getIdForClient). Avoids real Telegram clients.
function fakeAccountManager(entries) {
    const clients = new Map(entries); // [accountId, client]
    return {
        clients,
        metadata: new Map(),
        getClient(id) {
            if (!id) return clients.values().next().value || null;
            return clients.get(id) || clients.values().next().value || null;
        },
        getIdForClient(client) {
            for (const [id, c] of clients) if (c === client) return id;
            return null;
        },
    };
}

// A fake Telegram client that grants access only to a fixed set of group ids.
function fakeClient(accessibleIds) {
    const set = new Set(accessibleIds.map(String));
    return {
        connected: true,
        async getMessages(groupId) {
            if (set.has(String(groupId))) return [{ id: 42 }];
            throw new Error('CHANNEL_INVALID');
        },
    };
}

describe('getClientForGroup — dead pin', () => {
    it('skips a pin whose account is gone and falls through to the cache', () => {
        const liveClient = fakeClient(['-100777']);
        const am = fakeAccountManager([['123456', liveClient]]);
        const mon = new RealtimeMonitor(null, null, manager.loadConfig(), am);
        mon.groupClientCache = new Map([['-100777', liveClient]]);

        // Group pinned to a DEAD account id (the old phone-keyed one).
        const group = { id: '-100777', monitorAccount: '+66853892399' };
        // Must NOT return the AccountManager default via the dead pin; it
        // should fall through to the auto-discovered cache entry.
        expect(mon.getClientForGroup(group)).toBe(liveClient);
    });

    it('honours a live pin when the account is still connected', () => {
        const a = fakeClient(['-100777']);
        const b = fakeClient(['-100777']);
        const am = fakeAccountManager([
            ['acctA', a],
            ['acctB', b],
        ]);
        const mon = new RealtimeMonitor(null, null, manager.loadConfig(), am);
        mon.groupClientCache = new Map();
        const group = { id: '-100777', monitorAccount: 'acctB' };
        expect(mon.getClientForGroup(group)).toBe(b);
    });
});

describe('RealtimeMonitor.discoverClientForGroup — self-heal + re-pin', () => {
    it('probes all clients past a dead pin and re-pins monitorAccount', async () => {
        // Persist a group pinned to a dead account id.
        const cfg = manager.loadConfig();
        cfg.groups = [{ id: '-100777', name: 'g', enabled: true, monitorAccount: 'dead-old-id' }];
        manager.saveConfig(cfg);

        const winner = fakeClient(['-100777']); // the re-added account, new id
        const am = fakeAccountManager([['new-numeric-id', winner]]);
        const mon = new RealtimeMonitor(null, null, manager.loadConfig(), am);
        mon.groupClientCache = new Map();

        const group = mon.config.groups[0];
        const got = await mon.discoverClientForGroup(group);

        expect(got).toBe(winner);
        // In-memory pin updated…
        expect(group.monitorAccount).toBe('new-numeric-id');
        // …and persisted back to config so it survives the next restart.
        const reloaded = manager.loadConfig();
        expect(reloaded.groups[0].monitorAccount).toBe('new-numeric-id');
    });

    it('does not re-save config when the winning account already matches', async () => {
        const cfg = manager.loadConfig();
        cfg.groups = [{ id: '-100888', name: 'g', enabled: true, monitorAccount: 'already' }];
        manager.saveConfig(cfg);

        const client = fakeClient(['-100888']);
        const am = fakeAccountManager([['already', client]]);
        const mon = new RealtimeMonitor(null, null, manager.loadConfig(), am);
        mon.groupClientCache = new Map();

        const group = mon.config.groups[0];
        let saves = 0;
        const unsub = manager.watchConfig(() => saves++);
        await mon.discoverClientForGroup(group);
        unsub();

        expect(group.monitorAccount).toBe('already');
        expect(saves).toBe(0); // no churn when nothing changed
    });
});

describe('HistoryDownloader.discoverClientForGroup — backfill candidates', () => {
    it('builds candidates from ALL connected clients despite a dead pin, and re-pins', async () => {
        const cfg = manager.loadConfig();
        cfg.groups = [{ id: '-100999', name: 'g', enabled: true, monitorAccount: 'phone-old' }];
        manager.saveConfig(cfg);

        const noAccess = fakeClient([]); // re-added but wrong chat
        const winner = fakeClient(['-100999']);
        const am = fakeAccountManager([
            ['acct-no', noAccess],
            ['acct-win', winner],
        ]);

        const hist = new HistoryDownloader(null, null, manager.loadConfig(), am);
        const got = await hist.discoverClientForGroup('-100999');

        expect(got).toBe(winner);
        // Re-pinned to the account that actually had access.
        expect(manager.loadConfig().groups[0].monitorAccount).toBe('acct-win');
    });

    it('returns null only when truly no client can access', async () => {
        const cfg = manager.loadConfig();
        cfg.groups = [{ id: '-100000', name: 'g', enabled: true }];
        manager.saveConfig(cfg);
        const am = fakeAccountManager([['a', fakeClient([])]]);
        const hist = new HistoryDownloader(null, null, manager.loadConfig(), am);
        expect(await hist.discoverClientForGroup('-100000')).toBeNull();
    });
});

describe('AccountManager.clearGroupPins', () => {
    it('clears pins for the removed account only, leaving valid pins intact', () => {
        const cfg = manager.loadConfig();
        cfg.groups = [
            { id: 'g1', monitorAccount: 'gone' },
            { id: 'g2', monitorAccount: 'still-here' },
            { id: 'g3' },
        ];
        manager.saveConfig(cfg);

        const config = manager.loadConfig();
        const am = new AccountManager({ ...config, telegram: { apiId: '1', apiHash: 'x' } });
        const cleared = am.clearGroupPins('gone');

        expect(cleared).toBe(1);
        const reloaded = manager.loadConfig();
        expect(reloaded.groups.find((g) => g.id === 'g1').monitorAccount).toBeUndefined();
        expect(reloaded.groups.find((g) => g.id === 'g2').monitorAccount).toBe('still-here');
    });

    it('is a no-op (no save) when nothing is pinned to the removed account', () => {
        const cfg = manager.loadConfig();
        cfg.groups = [{ id: 'g1', monitorAccount: 'other' }];
        manager.saveConfig(cfg);
        const config = manager.loadConfig();
        const am = new AccountManager({ ...config, telegram: { apiId: '1', apiHash: 'x' } });

        let saves = 0;
        const unsub = manager.watchConfig(() => saves++);
        const cleared = am.clearGroupPins('gone');
        unsub();

        expect(cleared).toBe(0);
        expect(saves).toBe(0);
    });
});
