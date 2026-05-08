// HMAC signing + verification round-trip + tamper detection + replay guard.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-cluster-hmac-'));

let signRequest;
let verifyRequest;
let _resetReplayCacheForTests;
let getClusterToken;
let REPLAY_WINDOW_MS;
let db;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    db = await import('../src/core/db.js');
    db.getDb();
    const id = await import('../src/core/cluster/identity.js');
    getClusterToken = id.getClusterToken;
    const m = await import('../src/core/cluster/hmac.js');
    signRequest = m.signRequest;
    verifyRequest = m.verifyRequest;
    _resetReplayCacheForTests = m._resetReplayCacheForTests;
    REPLAY_WINDOW_MS = m.REPLAY_WINDOW_MS;
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
    _resetReplayCacheForTests();
});

function asReq({ method = 'GET', path = '/api/cluster/health', headers = {}, body = '' } = {}) {
    // express lowercases header names — mirror that in the test req shape so
    // verifyRequest can read X-Peer-* via the canonical lowercase keys.
    const lowered = {};
    for (const k of Object.keys(headers)) lowered[k.toLowerCase()] = headers[k];
    return {
        method,
        originalUrl: path,
        url: path,
        headers: lowered,
        rawBody: typeof body === 'string' ? Buffer.from(body) : body,
    };
}

describe('signRequest / verifyRequest round-trip', () => {
    it('round-trips a GET (no body)', () => {
        const headers = signRequest({ method: 'GET', path: '/api/cluster/health', peerId: 'p1' });
        const v = verifyRequest(asReq({ headers }));
        expect(v.ok).toBe(true);
        expect(v.peerId).toBe('p1');
    });

    it('round-trips a POST with a JSON body', () => {
        const body = JSON.stringify({ peer_id: 'p2', name: 'B' });
        const ts = Date.now();
        const headers = signRequest({
            method: 'POST',
            path: '/api/cluster/handshake',
            body,
            peerId: 'p2',
            ts,
        });
        const v = verifyRequest(
            asReq({ method: 'POST', path: '/api/cluster/handshake', headers, body }),
        );
        expect(v.ok).toBe(true);
        expect(v.peerId).toBe('p2');
        expect(v.ts).toBe(ts);
    });
});

describe('verifyRequest rejects bad inputs', () => {
    it('missing headers', () => {
        const v = verifyRequest(asReq({}));
        expect(v.ok).toBe(false);
        expect(v.reason).toBe('missing_headers');
    });

    it('clock skew > REPLAY_WINDOW_MS', () => {
        const stale = Date.now() - REPLAY_WINDOW_MS - 5000;
        const headers = signRequest({
            method: 'GET',
            path: '/api/cluster/health',
            peerId: 'p3',
            ts: stale,
        });
        const v = verifyRequest(asReq({ headers }));
        expect(v.ok).toBe(false);
        expect(v.reason).toBe('clock_skew');
    });

    it('tampered body fails signature', () => {
        const body = JSON.stringify({ peer_id: 'p4', name: 'A' });
        const headers = signRequest({
            method: 'POST',
            path: '/api/cluster/handshake',
            body,
            peerId: 'p4',
        });
        const tampered = JSON.stringify({ peer_id: 'p4', name: 'evil' });
        const v = verifyRequest(
            asReq({ method: 'POST', path: '/api/cluster/handshake', headers, body: tampered }),
        );
        expect(v.ok).toBe(false);
        expect(v.reason).toBe('bad_signature');
    });

    it('wrong token fails signature', () => {
        const headers = signRequest({
            method: 'GET',
            path: '/api/cluster/health',
            peerId: 'p5',
            token: 'a'.repeat(64),
        });
        const v = verifyRequest(asReq({ headers }));
        expect(v.ok).toBe(false);
        expect(v.reason).toBe('bad_signature');
    });

    it('rejects replay of the same exact signature', () => {
        const headers = signRequest({ method: 'GET', path: '/api/cluster/health', peerId: 'p6' });
        const first = verifyRequest(asReq({ headers }));
        expect(first.ok).toBe(true);
        const second = verifyRequest(asReq({ headers }));
        expect(second.ok).toBe(false);
        expect(second.reason).toBe('replay');
    });
});

describe('verifyRequest with explicit token', () => {
    it('honours expectedToken even when getClusterToken differs', () => {
        const altToken = 'b'.repeat(64);
        const headers = signRequest({
            method: 'GET',
            path: '/api/cluster/handshake',
            peerId: 'p7',
            token: altToken,
        });
        const ok = verifyRequest(asReq({ path: '/api/cluster/handshake', headers }), {
            expectedToken: altToken,
        });
        expect(ok.ok).toBe(true);
        const fail = verifyRequest(asReq({ path: '/api/cluster/handshake', headers }));
        expect(fail.ok).toBe(false);
        expect(fail.reason).toBe('bad_signature');
    });
});
