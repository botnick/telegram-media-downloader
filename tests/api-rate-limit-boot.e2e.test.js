// End-to-end: an API rate limit saved in config (Settings → Dashboard
// security) applies from the first request after a restart. It used to be
// ignored for the first 30 s: the boot-time refresh read the config cache
// while it was still in its temporal dead zone and silently kept the
// "disabled" default until the next periodic refresh.

import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_PATH = path.join(REPO_ROOT, 'src', 'web', 'server.js');
const SKIP = process.env.TGDL_SKIP_E2E === '1';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-ratelimit-e2e-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child;
let base = '';

function freePort() {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });
}

beforeAll(async () => {
    if (SKIP) return;
    process.env.TGDL_DATA_DIR = DATA;
    vi.resetModules();
    const { loadConfig, saveConfig } = await import('../src/config/manager.js');
    const { hashPassword } = await import('../src/core/web-auth.js');
    const { getDb } = await import('../src/core/db.js');
    const cfg = loadConfig();
    cfg.web = {
        ...(cfg.web || {}),
        enabled: true,
        passwordHash: hashPassword('rate-limit-e2e-pass'),
        rateLimit: { enabled: true, perMinute: 10 },
    };
    saveConfig(cfg);
    getDb().close();
    delete process.env.TGDL_DATA_DIR;

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [SERVER_PATH], {
        env: {
            ...process.env,
            PORT: String(port),
            TGDL_DATA_DIR: DATA,
            NODE_ENV: 'test',
            TGDL_GO_CORE: 'off',
        },
        cwd: REPO_ROOT,
        stdio: ['ignore', 'ignore', 'ignore'],
    });
    for (let i = 0; i < 120; i++) {
        try {
            // Not under /api — the readiness probe must not use up the budget.
            const r = await fetch(`${base}/login.html`);
            if (r.ok) break;
        } catch {
            /* not listening yet */
        }
        await sleep(250);
    }
}, 60_000);

afterAll(async () => {
    try {
        child?.kill('SIGTERM');
    } catch {}
    await sleep(500);
    try {
        fs.rmSync(DATA, { recursive: true, force: true });
    } catch {
        /* file lock — non-fatal */
    }
}, 30_000);

describe.skipIf(SKIP)('configured API rate limit (e2e)', () => {
    it('is enforced right after boot', async () => {
        const statuses = [];
        for (let i = 0; i < 11; i++) {
            const r = await fetch(`${base}/api/version`);
            statuses.push(r.status);
        }
        expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
        expect(statuses[10]).toBe(429);
    });
});
