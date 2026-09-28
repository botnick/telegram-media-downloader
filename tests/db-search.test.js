// searchDownloads / searchDownloadsFederated — the gallery search box
// narrows by the active type tab and pinned filter, can sort newest-first,
// and falls back to a substring match when the FTS prefix match finds
// nothing (words inside a file name, Thai chat names).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-search-'));

let db;
let api;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    api = await import('../src/core/db.js');
    db = api.getDb();
    const rows = [
        // id, group, groupName, file, type, created_at, pinned
        [1, 'g1', 'Travel Photos', 'sunset_beach.jpg', 'photo', '2026-01-01 10:00:00', 0],
        [2, 'g1', 'Travel Photos', 'sunset_city.mp4', 'video', '2026-01-02 10:00:00', 1],
        [3, 'g2', 'Design', 'sunset_poster.jpg', 'photo', '2026-01-03 10:00:00', 0],
        [4, 'g2', 'Design', 'logo_final.pdf', 'document', '2026-01-04 10:00:00', 0],
        [5, 'g3', 'ข่าวเทคโนโลยี', 'news_001.jpg', 'photo', '2026-01-05 10:00:00', 0],
        [6, 'g2', 'Design', '100%_done.png', 'photo', '2026-01-06 10:00:00', 0],
    ];
    const ins = db.prepare(`
        INSERT INTO downloads (id, group_id, group_name, message_id, file_name, file_size,
            file_type, file_path, status, created_at, pinned)
        VALUES (?, ?, ?, ?, ?, 100, ?, ?, 'completed', ?, ?)`);
    for (const [id, g, gn, f, t, c, p] of rows) ins.run(id, g, gn, id, f, t, `${gn}/${f}`, c, p);
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const ids = (r) => r.files.map((f) => f.id);

describe('searchDownloads narrowing', () => {
    it('matches file names by prefix across groups', () => {
        const r = api.searchDownloads('sunset', { order: 'newest' });
        expect(r.total).toBe(3);
        expect(ids(r)).toEqual([3, 2, 1]);
    });

    it('keeps the type tab', () => {
        const r = api.searchDownloads('sunset', { type: 'images', order: 'newest' });
        expect(ids(r)).toEqual([3, 1]);
        expect(r.total).toBe(2);
    });

    it('scopes to one group', () => {
        expect(ids(api.searchDownloads('sunset', { groupId: 'g1', order: 'newest' }))).toEqual([
            2, 1,
        ]);
    });

    it('supports pinned-only and pinned-first', () => {
        expect(ids(api.searchDownloads('sunset', { pinnedOnly: true }))).toEqual([2]);
        const first = api.searchDownloads('sunset', { pinnedFirst: true, order: 'newest' });
        expect(ids(first)).toEqual([2, 3, 1]);
    });

    it('matches chat names', () => {
        expect(ids(api.searchDownloads('design', { order: 'newest' }))).toEqual([6, 4, 3]);
    });

    it('falls back to a substring match when the prefix match finds nothing', () => {
        // "beach" is a word inside the file name; "เทคโน" is inside a Thai
        // chat name that FTS indexes as one token.
        expect(ids(api.searchDownloads('each'))).toEqual([1]);
        expect(ids(api.searchDownloads('เทคโน'))).toEqual([5]);
        expect(api.searchDownloads('each', { type: 'videos' }).total).toBe(0);
    });

    it('treats % and _ as literal characters in the substring fallback', () => {
        expect(ids(api.searchDownloads('0%_d'))).toEqual([6]);
        expect(api.searchDownloads('x%y').total).toBe(0);
    });

    it('applies the same narrowing on the federated path', () => {
        db.prepare(
            `INSERT INTO peer_downloads (peer_id, remote_id, group_id, group_name, message_id,
                file_name, file_size, file_type, file_path, status, created_at, cached_at)
             VALUES ('peer-a', 99, 'g1', 'Travel Photos', 99, 'sunset_peer.jpg', 1, 'photo',
                'Travel Photos/sunset_peer.jpg', 'completed', ?, 0)`,
        ).run(Date.parse('2026-02-01T00:00:00Z'));
        const all = api.searchDownloadsFederated('sunset', { include: 'peers', type: 'images' });
        expect(all.files.map((f) => f.file_name)).toEqual([
            'sunset_peer.jpg',
            'sunset_poster.jpg',
            'sunset_beach.jpg',
        ]);
        const pinned = api.searchDownloadsFederated('sunset', {
            include: 'peers',
            pinnedOnly: true,
        });
        expect(ids(pinned)).toEqual([2]);
        expect(pinned.total).toBe(1);
    });
});
