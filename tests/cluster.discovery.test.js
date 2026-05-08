// LAN discovery — beacon round-trip via the test seam (no real UDP).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-cluster-disc-'));

let db;
let identity;
let discovery;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    db = await import('../src/core/db.js');
    db.getDb();
    identity = await import('../src/core/cluster/identity.js');
    discovery = await import('../src/core/cluster/discovery.js');
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
    db.getDb().exec('DELETE FROM peer_discoveries;');
});

describe('beacon round-trip', () => {
    it('packs + ingests a beacon', () => {
        // Trick: we can't easily simulate two peers in-process because
        // the identity module is a singleton. Instead we craft a beacon
        // by pretending the OTHER peer has the same cluster token (which
        // is correct for a real LAN), then simulate it pointing at a
        // different peer_id by hand.
        const buf = discovery._packBeaconForTests('http://this-peer-test:3000');
        const j = JSON.parse(buf.toString('utf8'));
        // Forge a different peer_id so the ingest doesn't reject as self.
        j.peer_id = '99999999-aaaa-bbbb-cccc-dddddddddddd';
        j.url = 'http://other-peer:3001';
        const forged = Buffer.from(JSON.stringify(j));
        const ok = discovery._ingestBeaconForTests(forged);
        expect(ok).toBe(true);
        const list = db.listDiscoveredPeers({});
        expect(list).toHaveLength(1);
        expect(list[0].peer_id).toBe('99999999-aaaa-bbbb-cccc-dddddddddddd');
        expect(list[0].url).toBe('http://other-peer:3001');
    });

    it('rejects beacons with the wrong magic / no secret', () => {
        const garbage = Buffer.from(JSON.stringify({ magic: 'WRONG' }));
        expect(discovery._ingestBeaconForTests(garbage)).toBe(false);
    });

    it('skips own beacons (cannot pair with self)', () => {
        const buf = discovery._packBeaconForTests('http://self:3000');
        // _packBeacon stamps our own peer_id — ingest should reject.
        expect(discovery._ingestBeaconForTests(buf)).toBe(false);
    });
});
