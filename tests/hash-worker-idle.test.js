// The hash worker pool must release its threads once idle and rebuild on
// the next hashFile() — each worker costs ~11.5 MB RSS.

import { describe, it, expect, afterAll, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-hash-idle-'));
const FILE = path.join(TMP_DIR, 'a.bin');
fs.writeFileSync(FILE, Buffer.from('idle pool'));
const EXPECTED = crypto.createHash('sha256').update('idle pool').digest('hex');

let mod;

afterAll(async () => {
    await mod?.shutdownHashPool();
    delete process.env.HASH_WORKER_IDLE_MS;
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('hash-worker idle shutdown', () => {
    it('terminates the pool after the idle window and rebuilds on demand', async () => {
        process.env.HASH_WORKER_IDLE_MS = '150';
        vi.resetModules();
        mod = await import('../src/core/hash-worker.js');

        expect(await mod.hashFile(FILE)).toBe(EXPECTED);
        expect(mod._poolSize()).toBeGreaterThan(0);

        await new Promise((r) => setTimeout(r, 500));
        expect(mod._poolSize()).toBe(0);

        expect(await mod.hashFile(FILE)).toBe(EXPECTED);
        expect(mod._poolSize()).toBeGreaterThan(0);
    });

    it('does not shut down while jobs keep arriving', async () => {
        for (let i = 0; i < 5; i++) {
            expect(await mod.hashFile(FILE)).toBe(EXPECTED);
            await new Promise((r) => setTimeout(r, 60));
            expect(mod._poolSize()).toBeGreaterThan(0);
        }
    });
});
