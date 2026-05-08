// Failover — when ownerPeerId is offline > grace and self is the
// configured backup, take over.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-cluster-failover-'));

let db;
let identity;
let peers;
let failover;
let configMgr;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    db = await import('../src/core/db.js');
    db.getDb();
    identity = await import('../src/core/cluster/identity.js');
    peers = await import('../src/core/cluster/peers.js');
    failover = await import('../src/core/cluster/failover.js');
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
    db.getDb().exec(
        "DELETE FROM peers; DELETE FROM peer_failover_log; DELETE FROM kv WHERE key='config';",
    );
});

const OTHER_PEER = '11111111-2222-3333-4444-555555555555';

describe('runFailoverPass', () => {
    it('reassigns owner when stale + self is configured backup', () => {
        const selfId = identity.getSelfPeerId();
        peers.upsertPeer({
            peerId: OTHER_PEER,
            name: 'Other',
            url: 'http://other',
            status: 'offline',
        });
        // Mark "last_seen_at" to 1 day ago so the watcher considers it stale.
        db.getDb()
            .prepare('UPDATE peers SET last_seen_at = ? WHERE peer_id = ?')
            .run(Date.now() - 24 * 3600 * 1000, OTHER_PEER);

        configMgr.saveConfig({
            groups: [
                {
                    id: 'group-x',
                    name: 'X',
                    enabled: true,
                    ownerPeerId: OTHER_PEER,
                    backupPeerId: selfId,
                },
            ],
            cluster: { failover_grace_minutes: 1 },
        });

        const applied = failover.runFailoverPass();
        expect(applied).toHaveLength(1);
        expect(applied[0].fromPeerId).toBe(OTHER_PEER);
        expect(applied[0].toPeerId).toBe(selfId);

        const fresh = configMgr.loadConfig();
        expect(fresh.groups[0].ownerPeerId).toBe(selfId);

        const log = db
            .getDb()
            .prepare('SELECT * FROM peer_failover_log ORDER BY ts DESC LIMIT 1')
            .get();
        expect(log.from_peer_id).toBe(OTHER_PEER);
        expect(log.to_peer_id).toBe(selfId);
    });

    it('does nothing when owner is fresh', () => {
        const selfId = identity.getSelfPeerId();
        peers.upsertPeer({
            peerId: OTHER_PEER,
            name: 'Other',
            url: 'http://other',
            status: 'online',
        });
        db.getDb()
            .prepare('UPDATE peers SET last_seen_at = ? WHERE peer_id = ?')
            .run(Date.now(), OTHER_PEER);

        configMgr.saveConfig({
            groups: [
                {
                    id: 'group-x',
                    name: 'X',
                    enabled: true,
                    ownerPeerId: OTHER_PEER,
                    backupPeerId: selfId,
                },
            ],
            cluster: { failover_grace_minutes: 1 },
        });
        const applied = failover.runFailoverPass();
        expect(applied).toHaveLength(0);
    });

    it('does nothing when self is not the backup', () => {
        peers.upsertPeer({
            peerId: OTHER_PEER,
            name: 'Other',
            url: 'http://other',
            status: 'offline',
        });
        db.getDb()
            .prepare('UPDATE peers SET last_seen_at = ? WHERE peer_id = ?')
            .run(Date.now() - 24 * 3600 * 1000, OTHER_PEER);
        configMgr.saveConfig({
            groups: [
                {
                    id: 'group-x',
                    name: 'X',
                    enabled: true,
                    ownerPeerId: OTHER_PEER,
                    backupPeerId: 'someone-else',
                },
            ],
            cluster: { failover_grace_minutes: 1 },
        });
        const applied = failover.runFailoverPass();
        expect(applied).toHaveLength(0);
    });
});
