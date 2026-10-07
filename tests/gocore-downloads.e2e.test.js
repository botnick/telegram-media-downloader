import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { startRawCore } from './helpers/gocore-raw.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-catalog-'));
const previousDataDir = process.env.TGDL_DATA_DIR;
let core, db, client, readers, expected, groupIds;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = dataDir;
    ({ getDb: db } = await import('../src/core/db.js'));
    db = db();
    const insert = db.prepare(`INSERT INTO downloads
        (group_id, message_id, file_name, file_size, file_type, file_path)
        VALUES (?, ?, ?, ?, ?, ?)`);
    db.transaction(() => {
        for (let i = 1; i <= 1105; i++) {
            insert.run('-1', i, `ภาพ ${i}.jpg`, i, 'photo', `G/images/ภาพ ${i}.jpg`);
        }
        insert.run('-2', 1, null, null, null, null);
    })();
    const insertFace = db.prepare(`INSERT INTO faces
        (download_id, x, y, w, h, embedding, quality_score)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
    insertFace.run(1, 0.1, 0.2, 0.3, 0.4, Buffer.from([1, 2, 3, 4]), null);
    insertFace.run(2, 0.2, 0.3, 0.4, 0.5, Buffer.from([5, 6, 7, 8]), 0.75);
    for (let i = 0; i < 501; i++) {
        insertFace.run(3 + (i % 1103), 0.3, 0.4, 0.5, 0.6, Buffer.from([9, 10, 11, 12]), i / 100);
    }
    expected = db.prepare(`SELECT id, group_id, group_name, file_name, file_size, file_type, file_path
        FROM downloads ORDER BY id`).all();
    groupIds = expected.filter((row) => row.group_id === '-1').map((row) => row.id);
    core = await startRawCore([dataDir], { TGDL_CORE_DB: path.join(dataDir, 'db.sqlite') });
    client = await import('../src/core/gocore/client.js');
    client.setEndpoint(`http://${core.addr}`, 'raw-test-token', ['db']);
    client.markHealthy((await core.request('GET', '/health')).json);
    readers = await import('../src/core/gocore/downloads.js');
});

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
    client?.clearEndpoint();
    core?.stop();
    if (core?.child.exitCode === null && core.child.signalCode === null) {
        await new Promise((resolve) => core.child.once('exit', resolve));
    }
    db?.close();
    if (previousDataDir === undefined) delete process.env.TGDL_DATA_DIR;
    else process.env.TGDL_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
});

it('reads 1,106 shuffled IDs and nullable fields in SQLite order using only Go', async () => {
    const ids = expected.map((row) => row.id).reverse();
    ids.push(ids[0], ids[600], 0, -1, 0.5, 999999);
    // Green parity must prove the Go path, not a silent local fallback.
    vi.spyOn(db, 'prepare').mockImplementation(() => { throw new Error('unexpected Node query'); });
    const calls = vi.spyOn(client, 'downloadsByIds');
    expect(await readers.readDownloadRowsByIds(ids)).toEqual(expected);
    expect(calls).toHaveBeenCalledTimes(3);
    for (const [{ ids: batch }] of calls.mock.calls) expect(batch.length).toBeLessThanOrEqual(500);
});

it('pages the entire group using only Go without including another group', async () => {
    vi.spyOn(db, 'prepare').mockImplementation(() => { throw new Error('unexpected Node query'); });
    expect(await readers.readGroupDownloadIds('-1')).toEqual(groupIds);
    expect(await readers.readGroupDownloadIds('missing')).toEqual([]);
});

it('continues bulk reads locally after a middle-page failure without repeats or omissions', async () => {
    const original = client.downloadsByIds;
    let calls = 0;
    vi.spyOn(client, 'downloadsByIds').mockImplementation((...args) => {
        if (++calls > 1) return Promise.reject(new Error('core stopped'));
        return original(...args);
    });
    expect(await readers.readDownloadRowsByIds(expected.map((row) => row.id).reverse())).toEqual(expected);
    expect(calls).toBe(2);
});

it('continues group cleanup at the same cursor when Go stops after the first page', async () => {
    const original = client.groupDownloadIds;
    let calls = 0;
    vi.spyOn(client, 'groupDownloadIds').mockImplementation((...args) => {
        if (++calls > 1) return Promise.reject(new Error('core stopped'));
        return original(...args);
    });
    expect(await readers.readGroupDownloadIds('-1')).toEqual(groupIds);
    expect(calls).toBe(2);
});

it('yields between bounded local pages with an old core', async () => {
    vi.spyOn(client, 'isAvailable').mockReturnValue(false);
    let yielded = false;
    setImmediate(() => { yielded = true; });
    expect(await readers.readDownloadRowsByIds(expected.map((row) => row.id))).toEqual(expected);
    expect(yielded).toBe(true);
    expect(await readers.readGroupDownloadIds('-1')).toEqual(groupIds);
});

it('cancels a group read between pages without a fallback query', async () => {
    const controller = new AbortController();
    const original = client.groupDownloadIds;
    vi.spyOn(db, 'prepare').mockImplementation(() => { throw new Error('unexpected Node query'); });
    const calls = vi.spyOn(client, 'groupDownloadIds').mockImplementation(async (...args) => {
        const result = await original(...args);
        controller.abort();
        return result;
    });
    await expect(readers.readGroupDownloadIds('-1', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveBeenCalledTimes(1);
});

it('rejects an oversized raw batch instead of returning a silently truncated selection', async () => {
    const result = await core.post('/v1/db/downloads/by-ids', { ids: groupIds.slice(0, 501) });
    expect(result.status).toBe(400);
    expect(result.json.error.code).toBe('EINVAL');
});

it('reads the bounded disk-rotator projection from the real Go core', async () => {
    vi.spyOn(db, 'prepare').mockImplementation(() => { throw new Error('unexpected Node query'); });
    const result = await core.post('/v1/db/disk-rotator-candidates', { limit: 2 });
    expect(result.status).toBe(200);
    expect(result.json.rows).toEqual([
        { id: expected[0].id, file_size: 1, file_path: 'G/images/ภาพ 1.jpg' },
        { id: expected[1].id, file_size: 2, file_path: 'G/images/ภาพ 2.jpg' },
    ]);
});

it('reads keyset face embeddings from the real Go core without a Node query', async () => {
    vi.spyOn(db, 'prepare').mockImplementation(() => { throw new Error('unexpected Node query'); });
    const first = await core.post('/v1/db/face-embeddings', { afterId: 0, limit: 1 });
    expect(first.status).toBe(200);
    expect(first.json.total).toBe(503);
    expect(first.json.rows).toEqual([{ id: 1, embedding: 'AQIDBA==', quality_score: null }]);
    expect(first.json.nextId).toBe(1);
    const second = await core.post('/v1/db/face-embeddings', { afterId: 1, limit: 1 });
    expect(second.status).toBe(200);
    expect(second.json.total).toBeNull();
    expect(second.json.rows).toEqual([{ id: 2, embedding: 'BQYHCA==', quality_score: 0.75 }]);
    expect(second.json.nextId).toBe(2);
    const tail = await core.post('/v1/db/face-embeddings', { afterId: 500, limit: 10 });
    expect(tail.status).toBe(200);
    expect(tail.json.rows).toHaveLength(3);
    expect(tail.json.rows[0].id).toBe(501);
    expect(tail.json.rows[2].id).toBe(503);
});
