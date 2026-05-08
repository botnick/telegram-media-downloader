// End-to-end cluster smoke — two real `node src/web/server.js` instances
// on different ports + data dirs, perform a full pair-then-call cycle
// over real HTTP. Verifies the route-wiring + body-capture + HMAC stack
// matches the unit-tested module behaviour.
//
// Strategy: pre-seed both data dirs with the same `cluster_token` (and
// distinct `peer_id`) BEFORE spawning the servers, so cross-peer signed
// requests verify on the first try. This mirrors the real operator flow
// where they paste one peer's token into the other via "Use cluster's
// token" before pairing.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import Database from 'better-sqlite3';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_PATH = path.join(REPO_ROOT, 'src', 'web', 'server.js');

// Skip on environments where spawning real servers is impractical.
const SKIP = process.env.TGDL_SKIP_E2E === '1';

const procs = [];
const dataDirs = [];

const SHARED_TOKEN = crypto.randomBytes(32).toString('hex');
const PEER_A_ID = crypto.randomUUID();
const PEER_B_ID = crypto.randomUUID();

async function _waitForBoot(port, timeoutMs = 30_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/api/version`);
            if (r.ok || r.status === 503) return true;
        } catch {
            /* not ready yet */
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    return false;
}

function _seedDataDir(dir, peerId) {
    // Initialise db.sqlite with the same schema migrations the server
    // runs at boot, then upsert peer_id + cluster_token. We don't need
    // every table — just `kv` is enough for the identity bootstrap to
    // skip its lazy generate.
    fs.mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, 'db.sqlite');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
        CREATE TABLE IF NOT EXISTS kv (
            key        TEXT    PRIMARY KEY,
            value      TEXT    NOT NULL,
            updated_at INTEGER NOT NULL
        );
    `);
    const stmt = db.prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    stmt.run('peer_id', JSON.stringify(peerId), Date.now());
    stmt.run('cluster_token', JSON.stringify(SHARED_TOKEN), Date.now());
    stmt.run('peer_name', JSON.stringify(`peer-${peerId.slice(0, 4)}`), Date.now());
    db.close();
}

async function _spawnInstance(port, peerId) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tgdl-e2e-peer-${port}-`));
    dataDirs.push(dir);
    _seedDataDir(dir, peerId);
    const env = {
        ...process.env,
        PORT: String(port),
        TGDL_DATA_DIR: dir,
        NODE_ENV: 'test',
        TGDL_DISABLE_AUTOSTART: '1',
    };
    const child = spawn(process.execPath, [SERVER_PATH], {
        env,
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    procs.push(child);
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    const ok = await _waitForBoot(port);
    if (!ok) {
        child.kill('SIGKILL');
        throw new Error(`peer on port ${port} did not boot within 30s`);
    }
    return { child, port, dir, peerId };
}

function _signHeaders(method, urlPath, ts, body, peerId) {
    const bodyStr = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const bodyHash = crypto.createHash('sha256').update(bodyStr, 'utf8').digest('hex');
    const base = `${method.toUpperCase()}\n${urlPath}\n${ts}\n${bodyHash}`;
    const sig = crypto.createHmac('sha256', SHARED_TOKEN).update(base).digest('hex');
    return {
        'X-Peer-Id': peerId,
        'X-Peer-Ts': String(ts),
        'X-Peer-Signature': sig,
    };
}

afterAll(async () => {
    for (const c of procs) {
        try {
            c.kill('SIGTERM');
        } catch {
            /* nothing */
        }
    }
    await new Promise((r) => setTimeout(r, 800));
    for (const d of dataDirs) {
        try {
            fs.rmSync(d, { recursive: true, force: true });
        } catch {
            /* file lock — non-fatal */
        }
    }
}, 30_000);

const PORT_A = 3210;
const PORT_B = 3211;

describe.skipIf(SKIP)('cluster e2e — two real instances', () => {
    let A;
    let B;

    it('boots both instances with shared cluster token', async () => {
        A = await _spawnInstance(PORT_A, PEER_A_ID);
        B = await _spawnInstance(PORT_B, PEER_B_ID);
        expect(A.child.exitCode).toBeNull();
        expect(B.child.exitCode).toBeNull();
    }, 60_000);

    it('rejects unsigned health probe with 401', async () => {
        const r = await fetch(`http://127.0.0.1:${PORT_B}/api/cluster/health`);
        expect(r.status).toBe(401);
    });

    it('rejects bad signature with 401', async () => {
        const ts = Date.now();
        const r = await fetch(`http://127.0.0.1:${PORT_B}/api/cluster/health`, {
            headers: {
                'X-Peer-Id': PEER_A_ID,
                'X-Peer-Ts': String(ts),
                'X-Peer-Signature': 'a'.repeat(64),
            },
        });
        expect(r.status).toBe(401);
    });

    it('signed health probe succeeds', async () => {
        const ts = Date.now();
        const headers = _signHeaders('GET', '/api/cluster/health', ts, '', PEER_A_ID);
        const r = await fetch(`http://127.0.0.1:${PORT_B}/api/cluster/health`, { headers });
        if (r.status !== 200) {
            const txt = await r.text();
            throw new Error(`health probe failed ${r.status}: ${txt}`);
        }
        const j = await r.json();
        expect(j.ok).toBe(true);
        expect(j.peer_id).toBe(PEER_B_ID);
    }, 30_000);

    it('signed handshake from A → B succeeds, both peers see each other', async () => {
        const ts = Date.now();
        const body = JSON.stringify({
            peer_id: PEER_A_ID,
            name: 'A',
            url: `http://127.0.0.1:${PORT_A}`,
            version: 'test',
            ts,
        });
        const headers = _signHeaders('POST', '/api/cluster/handshake', ts, body, PEER_A_ID);
        headers['Content-Type'] = 'application/json';
        const r = await fetch(`http://127.0.0.1:${PORT_B}/api/cluster/handshake`, {
            method: 'POST',
            headers,
            body,
        });
        if (r.status !== 200) {
            const txt = await r.text();
            throw new Error(`handshake failed ${r.status}: ${txt}`);
        }
        const reply = await r.json();
        expect(reply.peer_id).toBe(PEER_B_ID);
        expect(reply.name).toBeTruthy();

        // Verify B persisted A in its peers table.
        await new Promise((r) => setTimeout(r, 200));
        const dbB = new Database(path.join(B.dir, 'db.sqlite'), { readonly: true });
        const row = dbB
            .prepare('SELECT peer_id, name, url FROM peers WHERE peer_id = ?')
            .get(PEER_A_ID);
        dbB.close();
        expect(row).toBeTruthy();
        expect(row.peer_id).toBe(PEER_A_ID);
    }, 30_000);

    it('signed delta-sync request returns the rows the peer holds', async () => {
        // Add a fake download row to peer B so the delta has something to return.
        const dbB = new Database(path.join(B.dir, 'db.sqlite'));
        dbB.prepare(
            `INSERT INTO downloads (group_id, message_id, file_name, file_path, file_size, file_type, file_hash, status)
             VALUES ('g1', 1001, 'a.jpg', 'g1/a.jpg', 4096, 'photo', 'h-test', 'completed')`,
        ).run();
        dbB.close();

        const ts = Date.now();
        const headers = _signHeaders(
            'GET',
            '/api/cluster/downloads/since?sinceId=0&limit=10',
            ts,
            '',
            PEER_A_ID,
        );
        const r = await fetch(
            `http://127.0.0.1:${PORT_B}/api/cluster/downloads/since?sinceId=0&limit=10`,
            { headers },
        );
        expect(r.status).toBe(200);
        const j = await r.json();
        expect(Array.isArray(j.rows)).toBe(true);
        expect(j.rows.length).toBeGreaterThan(0);
        expect(j.rows[0].file_hash).toBe('h-test');
    }, 30_000);

    it('signed groups snapshot returns config.groups', async () => {
        const ts = Date.now();
        const headers = _signHeaders('GET', '/api/cluster/groups/snapshot', ts, '', PEER_A_ID);
        const r = await fetch(`http://127.0.0.1:${PORT_B}/api/cluster/groups/snapshot`, {
            headers,
        });
        expect(r.status).toBe(200);
        const j = await r.json();
        expect(Array.isArray(j.groups)).toBe(true);
    }, 30_000);

    it('replay of the same signed request is rejected', async () => {
        const ts = Date.now();
        const headers = _signHeaders('GET', '/api/cluster/health', ts, '', PEER_A_ID);
        const r1 = await fetch(`http://127.0.0.1:${PORT_B}/api/cluster/health`, { headers });
        expect(r1.status).toBe(200);
        const r2 = await fetch(`http://127.0.0.1:${PORT_B}/api/cluster/health`, { headers });
        expect(r2.status).toBe(401);
        const j2 = await r2.json();
        expect(j2.code).toBe('replay');
    }, 30_000);
});
