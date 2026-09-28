// Faststart against the real ffmpeg: a MOV with a timecode data track —
// like iPhone recordings with `mebx` metadata tracks — can't be stream-copied
// into MP4 as is ("Could not find tag for codec"). Skipped without ffmpeg.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-faststart-ff-'));
process.env.TGDL_DATA_DIR = DATA_DIR;
const { hasFfmpeg, resolveFfmpegBin } = await import('../src/core/thumbs.js');

let dbApi;
let faststart;

beforeAll(async () => {
    dbApi = await import('../src/core/db.js');
    dbApi.getDb();
    faststart = await import('../src/core/faststart.js');
});

afterAll(() => {
    try {
        dbApi.getDb().close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe.skipIf(!hasFfmpeg())('faststart with ffmpeg', () => {
    it('optimises a video that carries a data track', async () => {
        const abs = path.join(DATA_DIR, 'downloads', 'g', 'videos', 'timecode.mov');
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const made = spawnSync(
            resolveFfmpegBin(),
            [
                '-hide_banner',
                '-loglevel',
                'error',
                '-f',
                'lavfi',
                '-i',
                'testsrc=d=1:s=64x64',
                '-timecode',
                '00:00:00:00',
                '-c:v',
                'mpeg4',
                '-y',
                abs,
            ],
            { windowsHide: true },
        );
        expect(made.status).toBe(0);
        const r = dbApi.insertDownload({
            groupId: '-100654',
            groupName: 'g',
            messageId: 1,
            fileName: 'timecode.mov',
            fileSize: fs.statSync(abs).size,
            fileType: 'video',
            filePath: 'g/videos/timecode.mov',
        });

        const out = await faststart.optimizeDownload(Number(r.lastInsertRowid));
        expect(out.status).toBe('optimized');
        expect(fs.existsSync(`${abs}.faststart.tmp`)).toBe(false);
        // moov now follows ftyp.
        const head = fs.readFileSync(abs).subarray(0, 64);
        const ftypSize = head.readUInt32BE(0);
        expect(head.subarray(ftypSize + 4, ftypSize + 8).toString('ascii')).toBe('moov');
    });
});
