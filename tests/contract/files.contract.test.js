// File delivery contract: /files/* (downloads, Content-Disposition, Range,
// conditional GETs, traversal guards, 404 auto-prune, bearer file tokens,
// federated ?peer= / _clusterref paths), /api/files/token,
// /api/thumbs/:id (derived WebP — recorded as format + dimensions),
// /api/files/archive-list and the streaming /api/downloads/bulk-zip.
//
// Per-exchange header masks used here (each noted on the entry):
//   - thumbs ETag `"thumb-<id>-<w>-<mtime ms>"`: the thumb is generated at
//     request time, its mtime is the wall clock.
//   - bulk-zip Content-Disposition `…-<YYYY-MM-DD-HH-MM>.zip`: the archive
//     name carries the current UTC minute.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { SEED, useContract } from './harness.js';

const GHOST_GROUP = '-1001000000009';
const h = useContract(import.meta.url, {
    // A row whose whole folder is gone (unmounted disk / renamed folder):
    // /files must 404 without pruning it.
    afterDb(db) {
        db.prepare(`
            INSERT INTO downloads (group_id, group_name, message_id, file_name, file_size, file_type,
                file_path, status, created_at, file_hash, pinned)
            VALUES (?, 'Ghost Folder', 901, 'ghost.jpg', 10, 'photo', 'Ghost Folder/images/ghost.jpg',
                'completed', '2024-06-01 10:00:00', NULL, 0)
        `).run(GHOST_GROUP);
    },
});

const ALPHA_IMG = 'Alpha Photos/images/IMG_0001.jpg';
const ALPHA_VID = 'Alpha Photos/videos/VID_0006.mp4';
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const fileUrl = (p, qs = '') => `/files/${enc(p)}${qs}`;
const b64url = (buf) => buf.toString('base64url');
const fileTokenFor = (exp, role) =>
    `${exp}.${b64url(
        crypto
            .createHmac('sha256', Buffer.from(SEED.shareSecret, 'hex'))
            .update(role ? `filetoken:${role}|${exp}` : `filetoken|${exp}`)
            .digest(),
    )}`;
const FAR_EXP = 4102444800; // 2100-01-01 — a token the test can mint itself

// request + optional header fix-up + record
async function rec(label, method, urlPath, o = {}, fix) {
    const t = h.t;
    const res = await t.request(method, urlPath, o);
    if (fix) fix(res);
    // A live thumb ETag echoed back in If-None-Match carries the same
    // wall-clock mtime as the response header — mask it the same way.
    const recHeaders = o.headers
        ? Object.fromEntries(
              Object.entries(o.headers).map(([k, v]) => [
                  k,
                  k === 'if-none-match' ? String(v).replace(/-(\d+)"$/, '-<mtime-ms>"') : v,
              ]),
          )
        : undefined;
    const req = { method, path: urlPath, as: o.as ?? 'admin', body: o.body, headers: recHeaders };
    if (o.cookie !== undefined) req.as = o.as ?? 'custom-cookie';
    const { body: _requestBody, ...recordOpts } = o;
    await t.record(label, req, res, recordOpts);
    return res;
}

const THUMB_NOTE =
    'etag mtime part masked (thumb generated at request time); content-length dropped (derived WebP, encoder-dependent size)';
const fixThumbEtag = (res) => {
    if (res.headers.etag) res.headers.etag = res.headers.etag.replace(/-(\d+)"$/, '-<mtime-ms>"');
    delete res.headers['content-length'];
};

describe('/files downloads', () => {
    it('whole files, disposition and content types', async () => {
        const t = h.t;
        await t.exchange('photo as attachment', 'GET', fileUrl(ALPHA_IMG));
        await t.exchange('photo inline', 'GET', fileUrl(ALPHA_IMG, '?inline=1'));
        await t.exchange(
            'png inline',
            'GET',
            fileUrl('Alpha Photos/images/IMG_0003.png', '?inline=1'),
        );
        await t.exchange(
            'webp inline',
            'GET',
            fileUrl('Alpha Photos/images/IMG_0004.webp', '?inline=1'),
        );
        await t.exchange('video inline', 'GET', fileUrl(ALPHA_VID, '?inline=1'));
        await t.exchange(
            'pdf inline',
            'GET',
            fileUrl('Gamma Docs/documents/report.pdf', '?inline=1'),
        );
        await t.exchange('text file', 'GET', fileUrl('Gamma Docs/documents/notes.txt'), {
            bodyMode: 'sha256',
        });
        await t.exchange('gzip file', 'GET', fileUrl('Gamma Docs/documents/notes.txt.gz'));
        await t.exchange('zip file', 'GET', fileUrl('Gamma Docs/documents/bundle.zip'));
        await t.exchange('unicode file name', 'GET', fileUrl('Delta Mixed/images/ภาพทดสอบ รูป.jpg'));
        await t.exchange(
            'legacy data/downloads/ prefix',
            'GET',
            fileUrl(`data/downloads/${ALPHA_IMG}`),
        );
        await t.exchange('HEAD photo', 'HEAD', fileUrl(ALPHA_IMG));
        await t.exchange('guest GET photo', 'GET', fileUrl(ALPHA_IMG, '?inline=1'), {
            as: 'guest',
        });
        await t.exchange(
            'text file with accept-encoding gzip',
            'GET',
            fileUrl('Gamma Docs/documents/notes.txt'),
            {
                headers: { 'accept-encoding': 'gzip, deflate, br' },
                bodyMode: 'sha256',
            },
        );
        await t.exchange('POST to a file path', 'POST', fileUrl(ALPHA_IMG), { body: {} });
    });

    it('conditional requests', async () => {
        const t = h.t;
        const first = await t.request('GET', fileUrl(ALPHA_IMG));
        await t.exchange('If-None-Match matching → 304', 'GET', fileUrl(ALPHA_IMG), {
            headers: { 'if-none-match': first.headers.etag },
        });
        await t.exchange('If-None-Match stale → 200', 'GET', fileUrl(ALPHA_IMG), {
            headers: { 'if-none-match': 'W/"0-0"' },
        });
        await t.exchange('If-Modified-Since = Last-Modified → 304', 'GET', fileUrl(ALPHA_IMG), {
            headers: { 'if-modified-since': first.headers['last-modified'] },
        });
    });

    it('Range requests', async () => {
        const t = h.t;
        const r = (label, range, extra = {}, o = {}) =>
            t.exchange(label, 'GET', fileUrl(ALPHA_VID, '?inline=1'), {
                headers: { range, ...extra },
                ...o,
            });
        // An unsatisfiable or inverted range: 416 with Content-Range: bytes */<size>
        // (RFC 9110), a text body and none of the file's own headers.
        await r('range first 100 bytes', 'bytes=0-99');
        await r('range open-ended', 'bytes=2000-');
        await r('range suffix', 'bytes=-50');
        await r('range last byte', 'bytes=2413-2413');
        await r('range end past EOF is clamped', 'bytes=2400-9999');
        await r('range unsatisfiable → 416', 'bytes=5000-6000');
        await r('range multiple ranges', 'bytes=0-9,20-29');
        await r('range malformed unit', 'items=0-5');
        await r('range inverted → 416', 'bytes=50-10');
        const whole = await t.request('GET', fileUrl(ALPHA_VID, '?inline=1'));
        await r('If-Range matching etag honours range', 'bytes=0-9', {
            'if-range': whole.headers.etag,
        });
        await r('If-Range stale etag → full body', 'bytes=0-9', { 'if-range': 'W/"0-0"' });
        await t.exchange('HEAD with range', 'HEAD', fileUrl(ALPHA_VID), {
            headers: { range: 'bytes=0-9' },
        });
    });
});

describe('/files guards and missing files', () => {
    it('traversal and malformed paths', async () => {
        const t = h.t;
        await t.exchange('encoded ../ traversal → 403', 'GET', '/files/..%2F..%2Fdb.sqlite');
        await t.exchange('encoded dot-dot segment → 403', 'GET', '/files/%2e%2e%2fdb.sqlite');
        await t.exchange(
            'nested traversal → 403',
            'GET',
            `/files/${enc('Alpha Photos')}/..%2F..%2F..%2Fdb.sqlite`,
        );
        await t.exchange('encoded absolute path', 'GET', '/files/%2Fetc%2Fpasswd');
        await t.exchange('NUL byte → 400', 'GET', '/files/Alpha%20Photos%00.jpg');
        await t.exchange('bad percent-encoding → 400', 'GET', '/files/%E0%A4%A');
        await t.exchange('bare /files/ falls through', 'GET', '/files/');
        await t.exchange(
            'file not in DB, folder exists → 404',
            'GET',
            fileUrl('Alpha Photos/images/nope.jpg'),
        );
    });

    it('a missing file 404s and its row is auto-pruned', async () => {
        const t = h.t;
        const rel = 'Epsilon Archive/images/IMG_0018.png';
        fs.rmSync(path.join(t.dataDir, 'downloads', ...rel.split('/')));
        const ws = t.ws({ as: 'admin' });
        await ws.opened;
        ws.drain();
        await t.exchange('deleted-on-disk file → 404', 'GET', fileUrl(rel, '?inline=1'));
        await ws.waitFor((m) => m.type === 'file_deleted');
        ws.close();
        t.recordWs('ws events from the 404 auto-prune', ws.drain(), {
            ignore: ['monitor_status_push', 'stats_push', 'log', 'stats_update'],
        });
        await t.exchange('epsilon group after auto-prune', 'GET', '/api/downloads/-1001000000005');
    });

    it('a missing folder 404s and keeps its row', async () => {
        const t = h.t;
        await t.exchange(
            'file in a missing folder → 404',
            'GET',
            fileUrl('Ghost Folder/images/ghost.jpg'),
        );
        await t.exchange('ghost group row still listed', 'GET', `/api/downloads/${GHOST_GROUP}`);
    });
});

describe('file bearer tokens', () => {
    it('minting', async () => {
        const t = h.t;
        await t.exchange('files/token admin', 'GET', '/api/files/token');
        await t.exchange('files/token guest', 'GET', '/api/files/token', { as: 'guest' });
        await t.exchange('files/token anon → 401', 'GET', '/api/files/token', { as: 'anon' });
    });

    it('a token opens /files without a cookie', async () => {
        const t = h.t;
        const minted = (await t.request('GET', '/api/files/token')).json.token;
        await t.exchange(
            'anon with minted admin token',
            'GET',
            fileUrl(ALPHA_IMG, `?inline=1&token=${minted}`),
            {
                as: 'anon',
            },
        );
        await t.exchange(
            'anon with self-minted guest token',
            'GET',
            fileUrl(ALPHA_IMG, `?token=${fileTokenFor(FAR_EXP, 'guest')}`),
            {
                as: 'anon',
            },
        );
        await t.exchange(
            'anon with legacy role-less token',
            'GET',
            fileUrl(ALPHA_IMG, `?token=${fileTokenFor(FAR_EXP, null)}`),
            { as: 'anon' },
        );
        await t.exchange(
            'anon with expired token → login redirect',
            'GET',
            fileUrl(ALPHA_IMG, `?token=${fileTokenFor(1700000000, 'guest')}`),
            {
                as: 'anon',
            },
        );
        await t.exchange(
            'anon with forged token → login redirect',
            'GET',
            fileUrl(ALPHA_IMG, `?token=${FAR_EXP}.${'A'.repeat(43)}`),
            {
                as: 'anon',
            },
        );
        await t.exchange(
            'anon with malformed token → login redirect',
            'GET',
            fileUrl(ALPHA_IMG, '?token=garbage'),
            {
                as: 'anon',
            },
        );
        await t.exchange(
            'token does not open /api routes',
            'GET',
            `/api/downloads?token=${fileTokenFor(FAR_EXP, 'admin')}`,
            {
                as: 'anon',
            },
        );
        await t.exchange(
            'guest-role token cannot use ?peer=',
            'GET',
            fileUrl(
                ALPHA_IMG,
                `?peer=${SEED.peers.alpha.peerId}&token=${fileTokenFor(FAR_EXP, 'guest')}`,
            ),
            { as: 'anon' },
        );
        await t.exchange(
            'admin-role token reaches the ?peer= branch',
            'GET',
            fileUrl(ALPHA_IMG, `?peer=no-such-peer&token=${fileTokenFor(FAR_EXP, 'admin')}`),
            { as: 'anon' },
        );
    });
});

describe('federated file paths', () => {
    it('?peer= and _clusterref/', async () => {
        const t = h.t;
        const a = SEED.peers.alpha.peerId;
        const b = SEED.peers.beta.peerId;
        await t.exchange(
            '?peer= unknown → 410',
            'GET',
            fileUrl('Remote Chat/images/R_0501.jpg', '?peer=nope'),
        );
        await t.exchange(
            '?peer= guest → 403',
            'GET',
            fileUrl('Remote Chat/images/R_0501.jpg', `?peer=${a}`),
            {
                as: 'guest',
            },
        );
        await t.exchange(
            '?peer= proxy-mode peer unreachable → 502',
            'GET',
            fileUrl('Remote Chat/images/R_0501.jpg', `?peer=${a}`),
        );
        await t.exchange(
            '?peer= direct-mode peer unreachable → 502',
            'GET',
            fileUrl('Remote Chat/images/R_0501.jpg', `?peer=${b}`),
        );
        await t.exchange(
            '_clusterref cached row, peer unreachable → 502',
            'GET',
            `/files/_clusterref/${a}/501`,
        );
        await t.exchange(
            '_clusterref unknown remote id → 404',
            'GET',
            `/files/_clusterref/${a}/999`,
        );
        await t.exchange(
            '_clusterref unknown peer → 404',
            'GET',
            '/files/_clusterref/no-such-peer/501',
        );
    });
});

describe('thumbnails', () => {
    it('images and videos render to WebP', async () => {
        await rec(
            'thumb jpg',
            'GET',
            '/api/thumbs/1',
            { bodyMode: 'image', note: THUMB_NOTE },
            fixThumbEtag,
        );
        await rec(
            'thumb jpg cache hit',
            'GET',
            '/api/thumbs/1',
            { bodyMode: 'image', note: THUMB_NOTE },
            fixThumbEtag,
        );
        await rec(
            'thumb portrait jpg',
            'GET',
            '/api/thumbs/2',
            { bodyMode: 'image', note: THUMB_NOTE },
            fixThumbEtag,
        );
        await rec(
            'thumb png',
            'GET',
            '/api/thumbs/3',
            { bodyMode: 'image', note: THUMB_NOTE },
            fixThumbEtag,
        );
        await rec(
            'thumb webp',
            'GET',
            '/api/thumbs/4',
            { bodyMode: 'image', note: THUMB_NOTE },
            fixThumbEtag,
        );
        await rec(
            'thumb w=120 clamps to the one width',
            'GET',
            '/api/thumbs/1?w=120',
            {
                bodyMode: 'image',
                note: THUMB_NOTE,
            },
            fixThumbEtag,
        );
        await rec(
            'thumb video frame',
            'GET',
            '/api/thumbs/6',
            { bodyMode: 'image', note: THUMB_NOTE },
            fixThumbEtag,
        );
        await rec(
            'thumb guest',
            'GET',
            '/api/thumbs/9',
            { as: 'guest', bodyMode: 'image', note: THUMB_NOTE },
            fixThumbEtag,
        );
    });

    it('conditional GET and misses', async () => {
        const t = h.t;
        const first = await t.request('GET', '/api/thumbs/1');
        expect(first.status).toBe(200);
        await rec(
            'thumb If-None-Match → 304',
            'GET',
            '/api/thumbs/1',
            {
                headers: { 'if-none-match': first.headers.etag },
                note: `${THUMB_NOTE}; request etag is the live one`,
            },
            (res) => fixThumbEtag(res),
        );
        await rec(
            'thumb If-Modified-Since → 304',
            'GET',
            '/api/thumbs/1',
            {
                headers: { 'if-modified-since': first.headers['last-modified'] },
                note: THUMB_NOTE,
            },
            fixThumbEtag,
        );
        await t.exchange('thumb of a document → 404', 'GET', '/api/thumbs/10');
        await t.exchange('thumb unknown id → 404', 'GET', '/api/thumbs/9999');
        await t.exchange('thumb bad id → 400', 'GET', '/api/thumbs/abc');
        await t.exchange('thumb id 0 → 400', 'GET', '/api/thumbs/0');
        await t.exchange('thumb anon → 401', 'GET', '/api/thumbs/1', { as: 'anon' });
    });
});

describe('archive listing', () => {
    it('deterministic branches', async () => {
        const t = h.t;
        const q = (p) => `/api/files/archive-list?path=${encodeURIComponent(p)}`;
        await t.exchange('archive-list without path → 400', 'GET', '/api/files/archive-list');
        await t.exchange(
            'archive-list missing file → 404',
            'GET',
            q('Gamma Docs/documents/nope.zip'),
        );
        await t.exchange('archive-list traversal → 403', 'GET', q('../db.sqlite'));
        await t.exchange(
            'archive-list single-stream .gz',
            'GET',
            q('Gamma Docs/documents/notes.txt.gz'),
        );
        await t.exchange(
            'archive-list unknown format',
            'GET',
            q('Gamma Docs/documents/report.pdf'),
        );
        await t.exchange(
            'archive-list guest → 403',
            'GET',
            q('Gamma Docs/documents/notes.txt.gz'),
            {
                as: 'guest',
            },
        );
    });
});

describe('bulk ZIP', () => {
    const ZIP_NOTE =
        'content-disposition timestamp masked: archive name carries the current UTC minute';
    const fixZipName = (res) => {
        const cd = res.headers['content-disposition'];
        if (cd) {
            res.headers['content-disposition'] = cd.replace(
                /-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.zip/g,
                '-<YYYY-MM-DD-HH-MM>.zip',
            );
        }
    };

    it('validation', async () => {
        const t = h.t;
        await t.exchange('bulk-zip without ids → 400', 'POST', '/api/downloads/bulk-zip', {
            body: {},
        });
        await t.exchange('bulk-zip empty ids → 400', 'POST', '/api/downloads/bulk-zip', {
            body: { ids: [] },
        });
        await t.exchange('bulk-zip non-numeric ids → 404', 'POST', '/api/downloads/bulk-zip', {
            body: { ids: ['a', null] },
        });
        await t.exchange('bulk-zip unknown ids → 404', 'POST', '/api/downloads/bulk-zip', {
            body: { ids: [9999] },
        });
        await t.exchange(
            'bulk-zip only unreachable files → 404',
            'POST',
            '/api/downloads/bulk-zip',
            {
                body: { ids: [21] },
            },
        );
        await t.exchange('bulk-zip over the entry cap → 413', 'POST', '/api/downloads/bulk-zip', {
            body: { ids: Array.from({ length: 65535 }, (_, i) => i + 1) },
            note: 'request body is 65 535 ids 1..65535',
        });
        await t.exchange('bulk-zip guest → 403', 'POST', '/api/downloads/bulk-zip', {
            as: 'guest',
            body: { ids: [1] },
        });
    });

    it('streams a STORE-mode archive', async () => {
        await rec(
            'bulk-zip one group with a name collision',
            'POST',
            '/api/downloads/bulk-zip',
            {
                body: { ids: [14, 15, 16] },
                bodyMode: 'zip',
                note: ZIP_NOTE,
            },
            fixZipName,
        );
        await rec(
            'bulk-zip across groups (library)',
            'POST',
            '/api/downloads/bulk-zip',
            {
                body: { ids: [1, 6, 10, 9999, 21] },
                bodyMode: 'zip',
                note: ZIP_NOTE,
            },
            fixZipName,
        );
    });
});
