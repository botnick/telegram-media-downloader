// v2.10 — per-peer tokens & pairing codes.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-cluster-tokens-'));

let db;
let identity;
let peers;
let hmac;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    db = await import('../src/core/db.js');
    db.getDb();
    identity = await import('../src/core/cluster/identity.js');
    peers = await import('../src/core/cluster/peers.js');
    hmac = await import('../src/core/cluster/hmac.js');
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
    db.getDb().exec("DELETE FROM peers; DELETE FROM kv WHERE key='pairing_codes';");
    hmac._resetReplayCacheForTests();
});

describe('pairing codes', () => {
    it('issued code can be derived deterministically by initiator', () => {
        const { code, secret } = identity.issuePairingCode();
        expect(code).toMatch(/^[A-Z0-9]{8}$/);
        expect(secret).toMatch(/^[0-9a-f]{64}$/);
        const derived = identity.deriveSecretFromPairingCode(code);
        expect(derived).toBe(secret);
    });

    it('consume returns secret on first call, null on second', () => {
        const { code, secret } = identity.issuePairingCode();
        const a = identity.consumePairingCode(code);
        expect(a?.secret).toBe(secret);
        expect(identity.consumePairingCode(code)).toBeNull();
    });

    it('rejects unknown code', () => {
        expect(identity.consumePairingCode('NOTREAL1')).toBeNull();
    });
});

describe('per-peer shared secrets', () => {
    it('upsert + retrieve a per-pair secret', () => {
        peers.upsertPeer({
            peerId: '11111111-2222-3333-4444-555555555555',
            name: 'Bee',
            url: 'http://b.example.com',
        });
        const secret = peers.generateSharedSecret();
        peers.setSharedSecret('11111111-2222-3333-4444-555555555555', secret);
        expect(peers.getSharedSecret('11111111-2222-3333-4444-555555555555')).toBe(secret);
    });

    it('toPublic flags migration_required when no per-pair secret', () => {
        peers.upsertPeer({
            peerId: '11111111-2222-3333-4444-555555555555',
            name: 'Bee',
            url: 'http://b.example.com',
        });
        const p = peers.getPeer('11111111-2222-3333-4444-555555555555');
        expect(p.migrationRequired).toBe(true);
    });

    it('migration_required clears once secret installed', () => {
        peers.upsertPeer({
            peerId: '11111111-2222-3333-4444-555555555555',
            name: 'Bee',
            url: 'http://b.example.com',
        });
        peers.setSharedSecret('11111111-2222-3333-4444-555555555555', peers.generateSharedSecret());
        expect(peers.getPeer('11111111-2222-3333-4444-555555555555').migrationRequired).toBe(false);
    });
});

describe('hmac uses per-pair secret first', () => {
    it('signed with per-pair secret verifies on receiver lookup', () => {
        peers.upsertPeer({
            peerId: '11111111-2222-3333-4444-555555555555',
            name: 'Bee',
            url: 'http://b.example.com',
        });
        const secret = peers.generateSharedSecret();
        peers.setSharedSecret('11111111-2222-3333-4444-555555555555', secret);

        const headers = hmac.signRequest({
            method: 'GET',
            path: '/api/cluster/health',
            peerId: '11111111-2222-3333-4444-555555555555',
            token: secret,
        });
        const lowered = {};
        for (const k of Object.keys(headers)) lowered[k.toLowerCase()] = headers[k];
        const v = hmac.verifyRequest({
            method: 'GET',
            originalUrl: '/api/cluster/health',
            headers: lowered,
            rawBody: '',
        });
        expect(v.ok).toBe(true);
        expect(v.peerId).toBe('11111111-2222-3333-4444-555555555555');
    });

    it('legacy cluster_token still verifies for v2.9 peers without per-pair secret', () => {
        peers.upsertPeer({
            peerId: '11111111-2222-3333-4444-555555555555',
            name: 'Bee',
            url: 'http://b.example.com',
        });
        // No per-pair secret installed.
        const legacy = identity.getClusterToken();
        const headers = hmac.signRequest({
            method: 'GET',
            path: '/api/cluster/health',
            peerId: '11111111-2222-3333-4444-555555555555',
            token: legacy,
        });
        const lowered = {};
        for (const k of Object.keys(headers)) lowered[k.toLowerCase()] = headers[k];
        const v = hmac.verifyRequest({
            method: 'GET',
            originalUrl: '/api/cluster/health',
            headers: lowered,
            rawBody: '',
        });
        expect(v.ok).toBe(true);
    });
});
