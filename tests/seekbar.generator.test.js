// Seekbar generator ↔ sidecar. A fake HTTP server speaks the seekbar-service
// v0.3.3 API (POST /v1/sprite, GET /v1/jobs/:id, POST /v1/jobs/:id/cancel);
// ffprobe and the local ffmpeg are stubbed so no binaries are needed.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';

const mock = vi.hoisted(() => ({
    duration: 600,
    localRuns: [],
    // Called for every GET /v1/jobs/:id — returns [httpStatus, body].
    poll: null,
    submits: [],
    cancels: [],
}));

vi.mock('child_process', async (importOriginal) => {
    const { EventEmitter } = await import('events');
    return {
        ...(await importOriginal()),
        // Only ffprobe is spawned directly by the generator.
        spawn: () => {
            const p = new EventEmitter();
            p.stdout = new EventEmitter();
            p.stderr = new EventEmitter();
            setImmediate(() => {
                p.stdout.emit('data', Buffer.from(`${mock.duration}\n`));
                p.emit('close', 0);
            });
            return p;
        },
    };
});

vi.mock('../src/core/thumbs.js', async () => {
    const nodeFs = await import('fs');
    return {
        hasFfmpeg: () => true,
        ffmpegHasLibwebp: () => true,
        hwaccelUploadPipeline: () => ({ inputArgs: [], scaleVf: null }),
        resolveFfprobeBin: () => 'ffprobe',
        runFfmpegArgs: async (args, opts) => {
            mock.localRuns.push({ args, opts });
            nodeFs.writeFileSync(args.at(-1), Buffer.alloc(64, 1));
        },
    };
});

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-seekbar-'));
const CFG = {
    enabled: true,
    intervalSec: 4,
    tileWidth: 160,
    columns: 10,
    maxTiles: 240,
    format: 'webp',
    quality: 75,
    concurrency: 2,
    maxRetries: 1,
};

let dbApi;
let client;
let generator;
let server;
let sidecarUrl;
let _msg = 0;

function addVideo() {
    _msg += 1;
    const name = `v${_msg}.mp4`;
    const abs = path.join(DATA_DIR, 'downloads', 'g', 'videos', name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.alloc(1024, 3));
    const r = dbApi.insertDownload({
        groupId: '-100888',
        groupName: 'g',
        messageId: _msg,
        fileName: name,
        fileSize: 1024,
        fileType: 'video',
        filePath: `g/videos/${name}`,
    });
    return { id: Number(r.lastInsertRowid), file_path: `g/videos/${name}`, file_type: 'video' };
}

// A job that is done, with the sprite written where the sidecar writes it.
function doneJob(job) {
    const sprite = path.join(DATA_DIR, 'seekbar', `${job.video_id}.webp`);
    fs.mkdirSync(path.dirname(sprite), { recursive: true });
    fs.writeFileSync(sprite, Buffer.alloc(128, 2));
    return { ...job, status: 'done', sprite_path: sprite, frames: 100, cols: 10, rows: 10 };
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    dbApi.getDb();
    client = await import('../src/core/seekbar/client.js');
    generator = await import('../src/core/seekbar/generator.js');

    const jobs = new Map();
    server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => {
            body += c;
        });
        req.on('end', () => {
            const send = (code, obj) => {
                res.writeHead(code, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(obj));
            };
            if (req.method === 'POST' && req.url === '/v1/sprite') {
                const b = JSON.parse(body);
                mock.submits.push(b);
                const job = { id: `job-${mock.submits.length}`, video_id: b.video_id };
                jobs.set(job.id, job);
                // v0.3.3 sync mode gives up after 60 s with status "timeout".
                if (!b.async) return send(202, { job_id: job.id, status: 'timeout' });
                return send(202, { ...job, status: 'pending' });
            }
            const m = /^\/v1\/jobs\/([^/]+)(\/cancel)?$/.exec(req.url);
            if (m && req.method === 'POST' && m[2]) {
                mock.cancels.push(m[1]);
                return send(200, { id: m[1], status: 'cancelled' });
            }
            if (m && req.method === 'GET') {
                const [code, obj] = mock.poll(jobs.get(m[1]));
                if (code === 404) {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    return res.end('404 page not found\n');
                }
                return send(code, obj);
            }
            send(404, { error: 'no route' });
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    sidecarUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
    mock.localRuns.length = 0;
    mock.submits.length = 0;
    mock.cancels.length = 0;
    mock.duration = 600;
    client.setSidecarUrl(sidecarUrl);
});

afterAll(async () => {
    vi.useRealTimers();
    await new Promise((r) => server.close(r));
    client.setSidecarUrl('');
    try {
        dbApi.getDb().close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('seekbar generator with the sidecar', () => {
    it('submits async, polls until done, never runs local ffmpeg', async () => {
        let polls = 0;
        mock.poll = (job) => {
            polls += 1;
            return [200, polls < 2 ? { ...job, status: 'running' } : doneJob(job)];
        };
        const row = addVideo();
        const meta = await generator.generateForDownload(row, CFG);
        expect(mock.submits).toHaveLength(1);
        expect(mock.submits[0].async).toBe(true);
        expect(meta.frames).toBe(100);
        expect(mock.localRuns).toHaveLength(0);
        expect(dbApi.getSeekbarSprite(row.id)?.frames).toBe(100);
    });

    it('a job past its time budget fails retryably, without a local ffmpeg run', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            let polls = 0;
            mock.poll = (job) => {
                polls += 1;
                // Second poll: two hours later, still encoding.
                if (polls === 2) vi.setSystemTime(Date.now() + 2 * 3600_000);
                return [200, { ...job, status: 'running' }];
            };
            const row = addVideo();
            const err = await generator.generateForDownload(row, CFG).catch((e) => e);
            expect(err).toBeInstanceOf(Error);
            expect(err.message).toMatch(/still busy after 600 s — will retry/);
            expect(generator.isPermanentSeekbarError(err.message)).toBe(false);
            expect(mock.localRuns).toHaveLength(0);
        } finally {
            vi.useRealTimers();
        }
        // The still-queued-or-running job is cancelled (fire-and-forget).
        await vi.waitFor(() => expect(mock.cancels).toEqual(['job-1']));
    });

    it('a job the sidecar no longer knows (404) fails retryably', async () => {
        mock.poll = () => [404];
        const err = await generator.generateForDownload(addVideo(), CFG).catch((e) => e);
        expect(err.message).toMatch(/no longer tracks the job/);
        expect(generator.isPermanentSeekbarError(err.message)).toBe(false);
        expect(mock.localRuns).toHaveLength(0);
    });

    it('classifies sidecar failures: corrupt file is permanent, anything else retryable', async () => {
        mock.poll = (job) => [
            200,
            {
                ...job,
                status: 'failed',
                error: 'ffmpeg: ffmpeg: exit status 1 (stderr: Invalid data found when processing input)',
            },
        ];
        const bad = await generator.generateForDownload(addVideo(), CFG).catch((e) => e);
        expect(generator.isPermanentSeekbarError(bad.message)).toBe(true);

        mock.poll = (job) => [200, { ...job, status: 'failed', error: 'ffmpeg: signal: killed' }];
        const flaky = await generator.generateForDownload(addVideo(), CFG).catch((e) => e);
        expect(flaky.message).toMatch(/signal: killed/);
        expect(generator.isPermanentSeekbarError(flaky.message)).toBe(false);
        expect(mock.localRuns).toHaveLength(0);
    });

    it('falls back to local ffmpeg only when the submit itself fails', async () => {
        client.setSidecarUrl('http://127.0.0.1:1'); // nothing listens there
        mock.duration = 7200;
        const meta = await generator.generateForDownload(addVideo(), CFG);
        expect(meta.frames).toBeGreaterThan(0);
        expect(mock.localRuns).toHaveLength(1);
        // Long clip → long budget, and a timeout would be retried, not
        // marked as a broken file.
        const { opts } = mock.localRuns[0];
        expect(opts.timeoutMs).toBe(3600_000);
        expect(generator.isPermanentSeekbarError(opts.timeoutMessage)).toBe(false);
    });
});

describe('spriteBudgetMs', () => {
    it('is the clip duration clamped to 5–60 min', () => {
        expect(generator.spriteBudgetMs(30)).toBe(5 * 60_000);
        expect(generator.spriteBudgetMs(1200)).toBe(1200_000);
        expect(generator.spriteBudgetMs(10 * 3600)).toBe(60 * 60_000);
        expect(generator.spriteBudgetMs(null)).toBe(5 * 60_000);
    });
});
