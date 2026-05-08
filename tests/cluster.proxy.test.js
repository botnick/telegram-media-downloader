// Streaming bridge — Range header forwarding + signed request to peer
// + reference-count guard. The actual fetch is mocked.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { Readable } from 'stream';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-cluster-proxy-'));

let db;
let peers;
let proxy;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    db = await import('../src/core/db.js');
    db.getDb();
    peers = await import('../src/core/cluster/peers.js');
    proxy = await import('../src/core/cluster/proxy.js');
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
    db.getDb().exec('DELETE FROM peers;');
});

const PEER = {
    peerId: '11111111-2222-3333-4444-555555555555',
    name: 'Bee',
    url: 'http://b.example.com',
};

function _webStream(buf) {
    // ReadableStream from a Buffer (browser-style; what undici returns).
    return new ReadableStream({
        start(ctrl) {
            ctrl.enqueue(buf);
            ctrl.close();
        },
    });
}

function _fakeRes() {
    const headers = new Map();
    return {
        status(code) {
            this.statusCode = code;
            return this;
        },
        setHeader(k, v) {
            headers.set(k.toLowerCase(), v);
        },
        write(buf) {
            this.body = Buffer.concat([this.body || Buffer.alloc(0), Buffer.from(buf)]);
            return true;
        },
        end() {
            this.ended = true;
        },
        on() {
            /* unused */
        },
        destroy() {
            this.ended = true;
        },
        json(obj) {
            this.jsonBody = obj;
            return this;
        },
        get _headers() {
            return headers;
        },
    };
}

describe('openPeerStream', () => {
    it('signs the request, forwards Range header', async () => {
        peers.upsertPeer({ ...PEER, status: 'online' });
        let captured;
        const fetcher = async (url, init) => {
            captured = { url, init };
            return {
                ok: true,
                status: 206,
                headers: new Map([
                    ['content-range', 'bytes 0-1023/2048'],
                    ['content-length', '1024'],
                ]),
                body: _webStream(Buffer.alloc(1024)),
            };
        };
        const r = await proxy.openPeerStream(PEER.peerId, 'group/a.jpg', {
            range: 'bytes=0-1023',
            fetcher,
        });
        expect(r.peer.peerId).toBe(PEER.peerId);
        expect(r.res.status).toBe(206);
        expect(captured.url).toBe('http://b.example.com/api/cluster/files/group%2Fa.jpg');
        expect(captured.init.headers['X-Peer-Id']).toBeTruthy();
        expect(captured.init.headers['X-Peer-Signature']).toMatch(/^[0-9a-f]{64}$/);
        expect(captured.init.headers.Range).toBe('bytes=0-1023');
    });

    it('throws on unknown peer', async () => {
        await expect(
            proxy.openPeerStream('unknown', 'x', { fetcher: async () => ({ ok: true }) }),
        ).rejects.toThrow(/not paired/);
    });

    it('throws on revoked peer', async () => {
        peers.upsertPeer({ ...PEER, status: 'online' });
        peers.updatePeer(PEER.peerId, { status: 'revoked' });
        await expect(
            proxy.openPeerStream(PEER.peerId, 'x', { fetcher: async () => ({ ok: true }) }),
        ).rejects.toThrow(/revoked/);
    });
});

describe('streamFromPeer', () => {
    it('pipes the response body to the local res', async () => {
        peers.upsertPeer({ ...PEER, status: 'online' });
        const req = { headers: { range: 'bytes=0-9' }, on: () => {} };
        const res = _fakeRes();
        const expected = Buffer.from('0123456789');
        const fetcher = async () => ({
            ok: true,
            status: 206,
            headers: new Map([
                ['content-range', 'bytes 0-9/100'],
                ['content-length', '10'],
                ['content-type', 'image/jpeg'],
            ]),
            body: _webStream(expected),
        });
        await proxy.streamFromPeer(req, res, PEER.peerId, 'group/a.jpg', { fetcher });
        expect(res.statusCode).toBe(206);
        expect(res.body).toEqual(expected);
        expect(res._headers.get('content-range')).toBe('bytes 0-9/100');
        expect(res._headers.get('content-length')).toBe('10');
        expect(res._headers.get('content-type')).toBe('image/jpeg');
        expect(res._headers.get('cache-control')).toBe('private, no-store');
    });

    it('returns 502 on remote error', async () => {
        peers.upsertPeer({ ...PEER, status: 'online' });
        const req = { headers: {}, on: () => {} };
        const res = _fakeRes();
        const fetcher = async () => {
            throw new Error('ECONNREFUSED');
        };
        await proxy.streamFromPeer(req, res, PEER.peerId, 'g/a.jpg', { fetcher });
        expect(res.statusCode).toBe(502);
        expect(res.jsonBody?.error).toBe('storage_offline');
    });
});

describe('reference-count guard', () => {
    it('acquire / release / isLocked round-trip', () => {
        const k = 'p1:g/a.jpg';
        expect(proxy.isStreamLocked(k)).toBe(false);
        proxy.acquireStreamLock(k);
        proxy.acquireStreamLock(k);
        expect(proxy.isStreamLocked(k)).toBe(true);
        proxy.releaseStreamLock(k);
        expect(proxy.isStreamLocked(k)).toBe(true);
        proxy.releaseStreamLock(k);
        expect(proxy.isStreamLocked(k)).toBe(false);
    });
});
