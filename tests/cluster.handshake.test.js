// Handshake — inbound + outbound. Outbound uses an injected fake fetcher
// so we don't need a real network. Inbound is exercised by calling
// acceptHandshake directly (the express wiring is tested via smoke run).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-cluster-handshake-'));

let identity;
let peers;
let handshake;
let hmac;
let db;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    db = await import('../src/core/db.js');
    db.getDb();
    identity = await import('../src/core/cluster/identity.js');
    peers = await import('../src/core/cluster/peers.js');
    hmac = await import('../src/core/cluster/hmac.js');
    handshake = await import('../src/core/cluster/handshake.js');
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

beforeEach(() => {
    db.getDb().exec('DELETE FROM peers; DELETE FROM cluster_audit;');
});

describe('initiateHandshake — input validation', () => {
    it('rejects bad URL', async () => {
        const r = await handshake.initiateHandshake({
            url: 'ftp://x',
            token: 'a'.repeat(64),
            fetcher: async () => ({ ok: true, json: async () => ({}) }),
        });
        expect(r.ok).toBe(false);
        expect(r.code).toBe('bad_url');
    });

    it('rejects bad token', async () => {
        const r = await handshake.initiateHandshake({
            url: 'http://b.example.com',
            token: 'short',
            fetcher: async () => ({ ok: true, json: async () => ({}) }),
        });
        expect(r.ok).toBe(false);
        expect(r.code).toBe('bad_token');
    });
});

describe('initiateHandshake — happy path', () => {
    it('signs the request, parses the reply, persists the peer row', async () => {
        const remoteToken = 'c'.repeat(64);
        const remotePeerId = '99999999-aaaa-bbbb-cccc-dddddddddddd';

        let captured;
        const fetcher = async (url, init) => {
            captured = { url, init };
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    peer_id: remotePeerId,
                    name: 'Remote Bee',
                    version: '2.9.0',
                    fingerprint: 'whatever',
                    paired_at: Date.now(),
                }),
            };
        };
        const r = await handshake.initiateHandshake({
            url: 'http://b.example.com:3001',
            token: remoteToken,
            fetcher,
        });
        expect(r.ok).toBe(true);
        expect(r.peer.peerId).toBe(remotePeerId);
        expect(r.peer.name).toBe('Remote Bee');

        // Outbound signature was computed against the remote token, NOT our
        // own getClusterToken — the local token should not match.
        const headers = captured.init.headers;
        expect(headers['X-Peer-Id']).toBe(identity.getSelfPeerId());
        expect(headers['X-Peer-Signature']).toMatch(/^[0-9a-f]{64}$/);

        // The peer is in our local DB.
        expect(peers.getPeer(remotePeerId)).toBeTruthy();
    });

    it('maps remote 401 to code: token_invalid', async () => {
        const r = await handshake.initiateHandshake({
            url: 'http://b.example.com',
            token: 'd'.repeat(64),
            fetcher: async () => ({
                ok: false,
                status: 401,
                json: async () => ({ error: 'cluster auth failed' }),
            }),
        });
        expect(r.ok).toBe(false);
        expect(r.code).toBe('token_invalid');
    });

    it('rejects pair-with-self', async () => {
        const selfId = identity.getSelfPeerId();
        const r = await handshake.initiateHandshake({
            url: 'http://b.example.com',
            token: 'e'.repeat(64),
            fetcher: async () => ({
                ok: true,
                status: 200,
                json: async () => ({ peer_id: selfId, name: 'Me' }),
            }),
        });
        expect(r.ok).toBe(false);
        expect(r.code).toBe('self');
    });

    it('reports unreachable on fetch throw', async () => {
        const r = await handshake.initiateHandshake({
            url: 'http://b.example.com',
            token: 'f'.repeat(64),
            fetcher: async () => {
                throw new Error('connect ECONNREFUSED');
            },
        });
        expect(r.ok).toBe(false);
        expect(r.code).toBe('unreachable');
        expect(r.message).toMatch(/ECONNREFUSED/);
    });
});

describe('acceptHandshake', () => {
    it('persists the inbound peer + returns own identity', () => {
        const reply = handshake.acceptHandshake({
            peerId: '88888888-7777-6666-5555-444444444444',
            name: 'Inbound A',
            url: 'http://a.example.com',
            version: '2.9.0',
        });
        expect(reply.peer_id).toBe(identity.getSelfPeerId());
        expect(reply.name).toBe(identity.getSelfPeerName());
        expect(peers.getPeer('88888888-7777-6666-5555-444444444444')).toBeTruthy();
    });

    it('throws on missing fields', () => {
        expect(() => handshake.acceptHandshake({})).toThrow();
    });

    it('rejects self peer_id', () => {
        const selfId = identity.getSelfPeerId();
        expect(() =>
            handshake.acceptHandshake({
                peerId: selfId,
                name: 'X',
                url: 'http://x',
            }),
        ).toThrow();
    });
});
