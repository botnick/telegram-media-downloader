import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../..');
const core = path.join(root, 'core-service');
const binaries = new Set();
const children = new Set();

afterEach(() => {
    for (const child of children) child.kill('SIGTERM');
    children.clear();
    for (const file of binaries) fs.rmSync(file, { force: true });
    binaries.clear();
});

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

describe('Go target foundation smoke', () => {
    it('starts the Go binary and answers health from a fresh data directory', async () => {
        const binary = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-go-smoke-')), 'tgdl-server');
        binaries.add(binary);
        execFileSync(process.env.GO_BIN || '/usr/local/go/bin/go', ['build', '-o', binary, './cmd/tgdl-server'], { cwd: core });
        const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-go-data-'));
        const dataDir = path.join(dataRoot, 'nested', 'fresh-data');
        const port = await freePort();
        const child = spawn(binary, [], { cwd: root, env: { ...process.env, TGDL_DATA_DIR: dataDir, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
        children.add(child);
        const deadline = Date.now() + 5000;
        let response;
        while (Date.now() < deadline) {
            try {
                response = await fetch(`http://127.0.0.1:${port}/health`);
                if (response.ok) break;
            } catch {}
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(response?.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ ok: true, service: 'tgdl-server' });
    }, 15000);
});
