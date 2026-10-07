// Snapshot backups keep SQLite consistency and provider orchestration in
// Node, but the CPU-heavy tar.gz walk/compression runs in tgdl-core.

import fs from 'fs';
import crypto from 'crypto';
import { gunzipSync } from 'zlib';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { requireCoreBin } from './helpers/gocore-raw.js';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-gocore-backup-'));
const REMOTE = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-gocore-backup-remote-'));
const SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const previousDataDir = process.env.TGDL_DATA_DIR;

let spawnMod;
let dbMod;
let dedup;
let manager;
let gocoreClient;
let destinationId;

function tarNames(archive) {
    const bytes = gunzipSync(fs.readFileSync(archive));
    const names = [];
    let offset = 0;
    while (offset + 512 <= bytes.length) {
        const name = bytes
            .subarray(offset, offset + 100)
            .toString('utf8')
            .replace(/\0.*$/, '');
        if (!name) break;
        names.push(name);
        const sizeText = bytes
            .subarray(offset + 124, offset + 136)
            .toString('ascii')
            .replace(/\0.*$/, '')
            .trim();
        const size = Number.parseInt(sizeText || '0', 8) || 0;
        offset += 512 + Math.ceil(size / 512) * 512;
    }
    return names;
}

async function waitFor(predicate, timeoutMs = 15_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        const value = predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return predicate();
}

beforeAll(async () => {
    requireCoreBin();
    process.env.TGDL_DATA_DIR = DATA;
    fs.mkdirSync(path.join(DATA, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(DATA, 'sessions', 'one.session'), 'session-data');
    spawnMod = await import('../src/core/gocore/spawn.js');
    dbMod = await import('../src/core/db.js');
    dedup = await import('../src/core/dedup.js');
    manager = await import('../src/core/backup/manager.js');
    gocoreClient = await import('../src/core/gocore/client.js');
    if (!(await spawnMod.startGoCore())) {
        throw new Error(`tgdl-core did not start: ${JSON.stringify(spawnMod.getGoCoreStatus())}`);
    }
}, 120_000);

afterAll(async () => {
    try {
        if (destinationId != null) manager?.removeDestination(destinationId);
    } catch {}
    spawnMod?.stopGoCore();
    try {
        dbMod?.getDb().close();
    } catch {}
    if (previousDataDir === undefined) delete process.env.TGDL_DATA_DIR;
    else process.env.TGDL_DATA_DIR = previousDataDir;
    fs.rmSync(DATA, { recursive: true, force: true });
    fs.rmSync(REMOTE, { recursive: true, force: true });
});

describe('snapshot backups through tgdl-core', () => {
    it('archives the staged DB and sessions without Node gzip work', async () => {
        const events = [];
        manager.init({
            getShareSecret: () => SECRET,
            broadcast: (event) => events.push(event),
            log: () => {},
        });
        destinationId = manager.addDestination({
            name: 'go-archive',
            provider: 'local',
            mode: 'snapshot',
            cron: '0 0 * * *',
            config: { rootPath: REMOTE },
        });
        await manager.runBackup(destinationId);
        const done = await waitFor(() => events.find((e) => e.type === 'backup_done'));
        expect(done).toMatchObject({ type: 'backup_done', destinationId });

        const snapshots = fs.readdirSync(path.join(REMOTE, 'snapshots'));
        expect(snapshots).toHaveLength(1);
        const names = tarNames(path.join(REMOTE, 'snapshots', snapshots[0]));
        expect(names).toEqual(
            expect.arrayContaining(['db.sqlite', 'sessions/', 'sessions/one.session']),
        );
    }, 60_000);

    it('removes a group tree in Go while preserving shared physical files', async () => {
        const groupDir = path.join(DATA, 'downloads', 'G1', 'images');
        fs.mkdirSync(groupDir, { recursive: true });
        const shared = path.join(groupDir, 'shared.jpg');
        const drop = path.join(groupDir, 'drop.jpg');
        fs.writeFileSync(shared, 'shared');
        fs.writeFileSync(drop, 'drop');
        dbMod.insertDownload({
            groupId: '1',
            groupName: 'G1',
            messageId: 1001,
            fileName: 'shared.jpg',
            fileSize: 6,
            fileType: 'photo',
            filePath: 'G1/images/shared.jpg',
        });
        dbMod.insertDownload({
            groupId: '1',
            groupName: 'G1',
            messageId: 1002,
            fileName: 'drop.jpg',
            fileSize: 4,
            fileType: 'photo',
            filePath: 'G1/images/drop.jpg',
        });
        dbMod.insertDownload({
            groupId: '2',
            groupName: 'G2',
            messageId: 1003,
            fileName: 'shared.jpg',
            fileSize: 6,
            fileType: 'photo',
            filePath: 'G1/images/shared.jpg',
        });

        await expect(
            dedup.removeGroupFolder('1', path.join(DATA, 'downloads', 'G1'), { details: true }),
        ).resolves.toEqual({ kept: 1, removed: 1 });
        expect(fs.existsSync(shared)).toBe(true);
        expect(fs.existsSync(drop)).toBe(false);
    }, 60_000);

    it('reads the thumbnail catalog through the real Go DB projection', async () => {
        const cache = path.join(DATA, 'thumbs');
        fs.mkdirSync(cache, { recursive: true });
        const result = dbMod.insertDownload({
            groupId: '3',
            groupName: 'G3',
            messageId: 1004,
            fileName: 'cached.jpg',
            fileSize: 6,
            fileType: 'photo',
            filePath: 'G3/images/cached.jpg',
        });
        const id = Number(result.lastInsertRowid);
        const digest = crypto.createHash('sha256').update(`${id}:320`).digest('hex').slice(0, 32);
        fs.writeFileSync(path.join(cache, `${digest}.webp`), 'thumb');
        dbMod.upsertSeekbarSprite({
            downloadId: id,
            spritePath: path.join(DATA, 'seekbar', `${id}.webp`),
            metaPath: path.join(DATA, 'seekbar', `${id}.json`),
            durationSec: 12.5,
            frames: 8,
            cols: 4,
            rows: 2,
            format: 'webp',
            bytes: 789,
            generatedAt: 1_717_286_400_000,
        });
        await expect(
            gocoreClient.thumbsList({
                limit: 1,
                kind: 'image',
                cacheRoot: cache,
            }),
        ).resolves.toMatchObject({
            total: 4,
            rows: [expect.objectContaining({ id, cached: true })],
            hasMore: true,
        });
        await expect(gocoreClient.seekbarList({ limit: 1 })).resolves.toMatchObject({
            total: 1,
            rows: [expect.objectContaining({ id, duration_sec: 12.5, file_name: 'cached.jpg' })],
            hasMore: false,
        });
    }, 60_000);
});
