// Faststart remux — retry without data tracks, give up on files that keep
// failing. ffmpeg is faked (child_process.spawn) so this runs without it;
// tests/faststart.ffmpeg.test.js covers the real binary.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const mock = vi.hoisted(() => ({ calls: [], onSpawn: () => ({ code: 0 }) }));

vi.mock('child_process', async (importOriginal) => {
    const { EventEmitter } = await import('events');
    const nodeFs = await import('fs');
    return {
        ...(await importOriginal()),
        spawn: (_bin, args) => {
            mock.calls.push(args);
            const p = new EventEmitter();
            p.stderr = new EventEmitter();
            setImmediate(() => {
                const r = mock.onSpawn(args);
                // Stand-in for the remux output: a byte copy of the input.
                if (r.write) nodeFs.copyFileSync(args[args.indexOf('-i') + 1], args.at(-1));
                if (r.stderr) p.stderr.emit('data', Buffer.from(r.stderr));
                p.emit('close', r.code);
            });
            return p;
        },
    };
});

vi.mock('../src/core/thumbs.js', () => ({
    resolveFfmpegBin: () => 'ffmpeg',
    hasFfmpeg: () => true,
    purgeThumbsForDownload: async () => 0,
}));

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-faststart-'));
const TAG_ERROR =
    '[mp4 @ 0x1] Could not find tag for codec none in stream #2, codec not currently supported in container\n';

let dbApi;
let faststart;
let _msg = 0;

// ftyp followed by mdat — what an un-optimised MP4 starts with.
function writeMp4(abs) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const ftyp = Buffer.concat([
        Buffer.from([0, 0, 0, 0x18]),
        Buffer.from('ftypisom'),
        Buffer.from([0, 0, 2, 0]),
        Buffer.from('isomiso2'),
    ]);
    const mdat = Buffer.concat([
        Buffer.from([0, 0, 0, 0x10]),
        Buffer.from('mdat'),
        Buffer.alloc(8, 7),
    ]);
    fs.writeFileSync(abs, Buffer.concat([ftyp, mdat]));
}

function addVideo(name) {
    const rel = `g/videos/${name}`;
    const abs = path.join(DATA_DIR, 'downloads', 'g', 'videos', name);
    writeMp4(abs);
    _msg += 1;
    const r = dbApi.insertDownload({
        groupId: '-100321',
        groupName: 'g',
        messageId: _msg,
        fileName: name,
        fileSize: fs.statSync(abs).size,
        fileType: 'video',
        filePath: rel,
    });
    return { id: Number(r.lastInsertRowid), abs };
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    dbApi.getDb();
    faststart = await import('../src/core/faststart.js');
});

beforeEach(() => {
    mock.calls.length = 0;
});

afterAll(() => {
    try {
        dbApi.getDb().close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('faststart remux', () => {
    it('retries once without data tracks when the muxer rejects one', async () => {
        mock.onSpawn = (args) =>
            args.includes('-0:d') ? { code: 0, write: true } : { code: 1, stderr: TAG_ERROR };
        const { id } = addVideo('iphone.mov');
        const r = await faststart.optimizeDownload(id);
        expect(r.status).toBe('optimized');
        expect(mock.calls).toHaveLength(2);
        const retry = mock.calls[1];
        expect(retry.slice(retry.indexOf('-map'), retry.indexOf('-map') + 4)).toEqual([
            '-map',
            '0',
            '-map',
            '-0:d',
        ]);
    });

    it('does not retry other failures and removes the partial output', async () => {
        mock.onSpawn = () => ({ code: 1, write: true, stderr: 'moov atom not found\n' });
        const { id, abs } = addVideo('broken.mp4');
        const r = await faststart.optimizeDownload(id);
        expect(r.status).toBe('errored');
        expect(r.error).toMatch(/moov atom not found/);
        expect(mock.calls).toHaveLength(1);
        expect(fs.existsSync(`${abs}.faststart.tmp`)).toBe(false);
    });

    it('gives up on a file after repeated failures until it changes', async () => {
        mock.onSpawn = () => ({ code: 1, stderr: 'Invalid data found when processing input\n' });
        const { id, abs } = addVideo('corrupt.mp4');
        for (let i = 0; i < 3; i++) {
            expect((await faststart.optimizeDownload(id)).status).toBe('errored');
        }
        expect(mock.calls).toHaveLength(3);

        const r = await faststart.optimizeDownload(id);
        expect(r).toEqual({ status: 'skipped', reason: 'failed before' });
        expect(mock.calls).toHaveLength(3);
        const stats = await faststart.getStats();
        expect(stats.unknown).toBeGreaterThanOrEqual(1);

        // A replaced file gets a fresh chance.
        fs.appendFileSync(abs, Buffer.alloc(16));
        mock.onSpawn = () => ({ code: 0, write: true });
        expect((await faststart.optimizeDownload(id)).status).toBe('optimized');
        expect(mock.calls).toHaveLength(4);
    });
});
