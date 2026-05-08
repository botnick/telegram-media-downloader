// Cluster identity bootstrap — peer_id is generated once and persisted,
// cluster_token is generated lazily, both survive restarts (re-imports).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-cluster-id-'));

let identity;
let db;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    // Import order matters — db.js must initialise before identity.js touches kv.
    db = await import('../src/core/db.js');
    db.getDb();
    identity = await import('../src/core/cluster/identity.js');
});

afterAll(() => {
    try {
        db.getDb().close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    try {
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
    } catch {
        /* Windows occasionally retains a brief file lock — non-fatal */
    }
});

describe('peer_id', () => {
    it('returns the same UUID across calls', () => {
        const a = identity.getSelfPeerId();
        const b = identity.getSelfPeerId();
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f-]{36}$/);
    });
});

describe('peer name', () => {
    it('defaults to a non-empty string (hostname-derived)', () => {
        const name = identity.getSelfPeerName();
        expect(typeof name).toBe('string');
        expect(name.length).toBeGreaterThan(0);
    });

    it('persists an operator-set name', () => {
        const next = identity.setSelfPeerName('Production peer');
        expect(next).toBe('Production peer');
        expect(identity.getSelfPeerName()).toBe('Production peer');
    });

    it('rejects empty names', () => {
        expect(() => identity.setSelfPeerName('   ')).toThrow();
    });

    it('clamps long names to 64 chars', () => {
        const long = 'x'.repeat(200);
        const stored = identity.setSelfPeerName(long);
        expect(stored.length).toBe(64);
    });
});

describe('cluster token', () => {
    it('returns the same hex token across calls', () => {
        const a = identity.getClusterToken();
        const b = identity.getClusterToken();
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f]+$/);
        expect(a.length).toBeGreaterThanOrEqual(64); // 32 bytes hex
    });

    it('rotateClusterToken returns a different value', () => {
        const before = identity.getClusterToken();
        const rotated = identity.rotateClusterToken();
        expect(rotated).not.toBe(before);
        expect(identity.getClusterToken()).toBe(rotated);
    });
});

describe('fingerprintFor', () => {
    it('is stable for the same (token, peerId) pair', () => {
        const t = identity.getClusterToken();
        const a = identity.fingerprintFor('abc-123', t);
        const b = identity.fingerprintFor('abc-123', t);
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f]{64}$/);
    });

    it('differs across peer ids', () => {
        const t = identity.getClusterToken();
        expect(identity.fingerprintFor('a', t)).not.toBe(identity.fingerprintFor('b', t));
    });

    it('differs after token rotation', () => {
        const before = identity.fingerprintFor('peer-x');
        identity.rotateClusterToken();
        expect(identity.fingerprintFor('peer-x')).not.toBe(before);
    });
});
