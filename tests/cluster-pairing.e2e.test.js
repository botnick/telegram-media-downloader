// Two real servers (`node src/web/server.js`, own ports and data dirs, each
// with its OWN cluster token — two fresh installs) paired the way the
// dashboard does it, then used across the pair. Regression tests for the
// cluster bugs the API contract suite recorded as-is:
//   - a pairing-code handshake always failed (401 bad_signature);
//   - the sync / WS channel / discovery / failover engines only started
//     after an unrelated cluster request, so a new pair never connected;
//   - sign-url stored the expiry in ms but signed seconds, so a
//     direct-stream URL never verified;
//   - the peer-thumbs route sent a JSON object labelled image/webp.

import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_PATH = path.join(REPO_ROOT, 'src', 'web', 'server.js');
const PHOTO = path.join(REPO_ROOT, 'tests', 'contract', 'fixtures', 'media', 'photo-a.jpg');
const SKIP = process.env.TGDL_SKIP_E2E === '1';
const PASSWORD = 'pairing-e2e-pass';
const FILE_REL = 'G1/images/p.jpg';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const nodes = {};

function freePort() {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });
}

async function until(fn, what, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(200);
    }
}

// Data dir with an admin password; `withFile` adds one downloaded photo.
async function seed(dir, { withFile = false } = {}) {
    process.env.TGDL_DATA_DIR = dir;
    vi.resetModules();
    const { loadConfig, saveConfig } = await import('../src/config/manager.js');
    const { hashPassword } = await import('../src/core/web-auth.js');
    const db = await import('../src/core/db.js');
    const cfg = loadConfig();
    cfg.web = { ...(cfg.web || {}), enabled: true, passwordHash: hashPassword(PASSWORD) };
    saveConfig(cfg);
    let downloadId = null;
    if (withFile) {
        const abs = path.join(dir, 'downloads', FILE_REL);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.copyFileSync(PHOTO, abs);
        db.insertDownload({
            groupId: '1',
            groupName: 'G1',
            messageId: 1,
            fileName: 'p.jpg',
            fileSize: fs.statSync(abs).size,
            fileType: 'photo',
            filePath: FILE_REL,
        });
        downloadId = db.getDb().prepare('SELECT MAX(id) AS id FROM downloads').get().id;
    }
    db.getDb().close();
    delete process.env.TGDL_DATA_DIR;
    return downloadId;
}

async function start(name, opts) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tgdl-pair-e2e-${name}-`));
    const downloadId = await seed(dir, opts);
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, [SERVER_PATH], {
        env: { ...process.env, PORT: String(port), TGDL_DATA_DIR: dir, NODE_ENV: 'test' },
        cwd: REPO_ROOT,
        stdio: ['ignore', 'ignore', 'ignore'],
    });
    const node = { name, dir, base, child, downloadId, cookie: '' };
    nodes[name] = node;
    await until(
        async () => {
            try {
                return (await fetch(`${base}/api/auth_check`)).ok;
            } catch {
                return false;
            }
        },
        `${name} to boot`,
        60_000,
    );
    const login = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
    });
    node.cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    node.peerId = (await api(node, 'GET', '/api/cluster/identity')).json.peerId;
    return node;
}

async function api(node, method, url, body, { redirect = 'follow' } = {}) {
    const r = await fetch(node.base + url, {
        method,
        redirect,
        headers: { 'content-type': 'application/json', cookie: node.cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const buf = Buffer.from(await r.arrayBuffer());
    let json = null;
    try {
        json = JSON.parse(buf.toString('utf8'));
    } catch {
        /* not JSON */
    }
    return { status: r.status, headers: r.headers, buf, json };
}

const peerOn = async (node, peerId) =>
    (await api(node, 'GET', '/api/cluster/peers')).json.peers.find((p) => p.peerId === peerId);

beforeAll(async () => {
    if (SKIP) return;
    await start('a');
    await start('b', { withFile: true });
}, 120_000);

afterAll(async () => {
    for (const n of Object.values(nodes)) {
        try {
            n.child.kill('SIGTERM');
        } catch {}
    }
    await sleep(800);
    for (const n of Object.values(nodes)) {
        try {
            fs.rmSync(n.dir, { recursive: true, force: true });
        } catch {
            /* file lock — non-fatal */
        }
    }
}, 30_000);

describe.skipIf(SKIP)('cluster pairing and use (two servers, different cluster tokens)', () => {
    it('pairs with a pairing code', async () => {
        const { a, b } = nodes;
        const tokenA = (await api(a, 'GET', '/api/cluster/identity/token')).json.token;
        const tokenB = (await api(b, 'GET', '/api/cluster/identity/token')).json.token;
        expect(tokenA).not.toBe(tokenB);

        const code = (await api(b, 'POST', '/api/cluster/identity/pairing-code')).json.code;
        const paired = await api(a, 'POST', '/api/cluster/peers', {
            url: b.base,
            pairingCode: code,
        });
        expect(paired.status).toBe(200);
        expect(paired.json.peer.peerId).toBe(b.peerId);
        // Both sides hold the per-pair secret the handshake exchanged.
        expect((await peerOn(a, b.peerId)).migrationRequired).toBe(false);
        const aOnB = await peerOn(b, a.peerId);
        expect(aOnB.migrationRequired).toBe(false);
        expect(aOnB.url).toBe(a.base);

        // Single use.
        const again = await api(a, 'POST', '/api/cluster/peers', {
            url: b.base,
            pairingCode: code,
        });
        expect(again.status).toBe(400);
        expect(again.json.code).toBe('pairing_code_rejected');
    }, 30_000);

    it('the cluster engines start once paired: each side opens /ws/cluster to the other', async () => {
        const { a, b } = nodes;
        await until(async () => (await peerOn(b, a.peerId))?.wsLastSeen, 'A to connect to B');
        await until(async () => (await peerOn(a, b.peerId))?.wsLastSeen, 'B to connect to A');
    }, 30_000);

    it('a direct-stream URL minted by the peer verifies', async () => {
        const { a, b } = nodes;
        const set = await api(a, 'PUT', `/api/cluster/peers/${b.peerId}`, { streamMode: 'direct' });
        expect(set.status).toBe(200);
        const r = await api(a, 'GET', `/files/${FILE_REL}?inline=1&peer=${b.peerId}`, undefined, {
            redirect: 'manual',
        });
        expect(r.status).toBe(302);
        const location = r.headers.get('location');
        expect(location.startsWith(`${b.base}/share/`)).toBe(true);
        const file = await fetch(location);
        expect(file.status).toBe(200);
        const bytes = Buffer.from(await file.arrayBuffer());
        expect(bytes.equals(fs.readFileSync(PHOTO))).toBe(true);
    }, 30_000);

    it('a proxied peer thumbnail is the WebP image', async () => {
        const { a, b } = nodes;
        const r = await api(a, 'GET', `/api/cluster/thumbs/${b.peerId}/${b.downloadId}?w=240`);
        expect(r.status).toBe(200);
        expect(r.headers.get('content-type')).toBe('image/webp');
        expect(r.buf.toString('latin1', 0, 4)).toBe('RIFF');
        expect(r.buf.toString('latin1', 8, 12)).toBe('WEBP');
    }, 30_000);
});
