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
