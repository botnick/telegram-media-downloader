// AI / faces contract — People grid reads, face overlays, face crops and
// the manual cluster repairs (rename, merge, split, reassign, delete).
//
// Seed: people 1 Alice (faces 1,2), 2 Bob (faces 3,4), 3 unlabelled
// (face 5); face 6 unassigned (row 4); face 7 on the Alpha video (row 6,
// frame 1.0 s). Face crops are derived images → recorded as
// format/width/height only (the encoder may differ in Go).

import { describe, it } from 'vitest';
import { useContract } from './harness.js';

const h = useContract(import.meta.url);

// Face crops are re-encoded JPEGs: recorded as format + dimensions (the
// harness drops Content-Length for derived images). JSON error answers
// are recorded as usual.
async function crop(t, label, urlPath) {
    const res = await t.request('GET', urlPath);
    const isImage = String(res.headers['content-type'] || '').startsWith('image/');
    return t.record(
        label,
        { method: 'GET', path: urlPath, as: 'admin' },
        res,
        isImage ? { bodyMode: 'image' } : {},
    );
}

describe('people and faces (reads)', () => {
    it('lists people with every sort / paging variant', async () => {
        const t = h.t;
        await t.exchange('people default', 'GET', '/api/ai/people');
        await t.exchange('people sort=name asc', 'GET', '/api/ai/people?sort=name&dir=asc');
        await t.exchange('people sort=name desc', 'GET', '/api/ai/people?sort=name&dir=desc');
        await t.exchange('people sort=avg_quality', 'GET', '/api/ai/people?sort=avg_quality');
        await t.exchange(
            'people unknown sort falls back',
            'GET',
            '/api/ai/people?sort=bogus&dir=sideways',
        );
        await t.exchange('people limit=1 offset=1', 'GET', '/api/ai/people?limit=1&offset=1');
        await t.exchange(
            'people limit clamps (0 → default)',
            'GET',
            '/api/ai/people?limit=0&offset=-5',
        );
        await t.exchange(
            'people scope=federated (peers unreachable)',
            'GET',
            '/api/ai/people?scope=federated',
        );
    });

    it('people are admin-only', async () => {
        const t = h.t;
        await t.exchange('people as guest → 403', 'GET', '/api/ai/people', { as: 'guest' });
        await t.exchange('people as anon → 401', 'GET', '/api/ai/people', { as: 'anon' });
        await t.exchange('person photos as guest → 403', 'GET', '/api/ai/people/1/photos', {
            as: 'guest',
        });
    });

    it('faces per download', async () => {
        const t = h.t;
        await t.exchange('faces of row 1', 'GET', '/api/ai/faces/by-download/1');
        await t.exchange('faces of row 4 (unassigned face)', 'GET', '/api/ai/faces/by-download/4');
        await t.exchange('faces of row 10 (none)', 'GET', '/api/ai/faces/by-download/10');
        await t.exchange('faces of unknown row', 'GET', '/api/ai/faces/by-download/9999');
        await t.exchange('faces by-download bad id → 400', 'GET', '/api/ai/faces/by-download/abc');
        await t.exchange('faces by-download id 0 → 400', 'GET', '/api/ai/faces/by-download/0');
    });

    it('group-by-person', async () => {
        const t = h.t;
        await t.exchange('group-by-person', 'GET', '/api/ai/group-by-person');
        await t.exchange('group-by-person limit=1', 'GET', '/api/ai/group-by-person?limit=1');
    });

    it('photos of a person', async () => {
        const t = h.t;
        await t.exchange('photos of person 1', 'GET', '/api/ai/people/1/photos');
        await t.exchange(
            'photos of person 2 limit=1 offset=1',
            'GET',
            '/api/ai/people/2/photos?limit=1&offset=1',
        );
        await t.exchange('photos of unknown person', 'GET', '/api/ai/people/999/photos');
        await t.exchange('photos of bad person id → 400', 'GET', '/api/ai/people/abc/photos');
    });

    it('person avatar crops', async () => {
        const t = h.t;
        await crop(t, 'person 1 face crop (default 160)', '/api/ai/person/1/face');
        await crop(t, 'person 2 face crop w=64', '/api/ai/person/2/face?w=64');
        await crop(t, 'person 3 face crop w=9999 clamps to 512', '/api/ai/person/3/face?w=9999');
        await t.exchange('person crop unknown person → 404', 'GET', '/api/ai/person/999/face');
        await t.exchange('person crop bad id → 400', 'GET', '/api/ai/person/abc/face');
    });

    it('single face crops', async () => {
        const t = h.t;
        await crop(t, 'face 1 crop (default 128)', '/api/ai/faces/1/crop');
        await crop(t, 'face 3 crop w=200 (png source)', '/api/ai/faces/3/crop?w=200');
        await crop(t, 'face 6 crop w=10 clamps to 64', '/api/ai/faces/6/crop?w=10');
        await crop(t, 'face 7 crop (video frame at 1.0 s)', '/api/ai/faces/7/crop');
        await crop(t, 'face 1 crop again (served from the crop cache)', '/api/ai/faces/1/crop');
        await t.exchange('face crop unknown face → 404', 'GET', '/api/ai/faces/999/crop');
        await t.exchange('face crop bad id → 400', 'GET', '/api/ai/faces/x/crop');
    });
});

describe('cluster repairs (mutations, in order)', () => {
    it('rename', async () => {
        const t = h.t;
        await t.exchange('rename person 3', 'PATCH', '/api/ai/people/3', {
            body: { label: '  Carol  ' },
        });
        await t.exchange(
            'rename person 2 to a 120-char label (truncated to 100)',
            'PATCH',
            '/api/ai/people/2',
            {
                body: { label: 'Z'.repeat(120) },
            },
        );
        await t.exchange('rename person 2 to empty (label cleared)', 'PATCH', '/api/ai/people/2', {
            body: { label: '   ' },
        });
        await t.exchange('rename person 2 back', 'PATCH', '/api/ai/people/2', {
            body: { label: 'Bob' },
        });
        await t.exchange('rename unknown person → 404', 'PATCH', '/api/ai/people/999', {
            body: { label: 'Nobody' },
        });
        await t.exchange('rename bad id → 400', 'PATCH', '/api/ai/people/abc', {
            body: { label: 'x' },
        });
        await t.exchange('rename as guest → 403', 'PATCH', '/api/ai/people/3', {
            as: 'guest',
            body: { label: 'Guest' },
        });
    });

    it('merge', async () => {
        const t = h.t;
        await t.exchange('merge without otherId → 400', 'POST', '/api/ai/people/1/merge', {
            body: {},
        });
        await t.exchange('merge into itself → 400', 'POST', '/api/ai/people/1/merge', {
            body: { otherId: 1 },
        });
        await t.exchange('merge Carol (3) into Alice (1)', 'POST', '/api/ai/people/1/merge', {
            body: { otherId: 3 },
        });
        await t.exchange('merge an already-merged person', 'POST', '/api/ai/people/1/merge', {
            body: { otherId: 3 },
        });
        await t.exchange('people after merge', 'GET', '/api/ai/people');
    });

    it('split', async () => {
        const t = h.t;
        await t.exchange('split without faceIds → 400', 'POST', '/api/ai/people/1/split', {
            body: {},
        });
        await t.exchange('split unknown faces → 404', 'POST', '/api/ai/people/1/split', {
            body: { faceIds: [999] },
        });
        await t.exchange('split face 5 out with newLabel', 'POST', '/api/ai/people/1/split', {
            body: { faceIds: [5], newLabel: 'Carol again' },
        });
        await t.exchange(
            'split face 2 out with legacy label field',
            'POST',
            '/api/ai/people/1/split',
            {
                body: { faceIds: [2], label: 'Alice twin' },
            },
        );
        await t.exchange('split without a label', 'POST', '/api/ai/people/2/split', {
            body: { faceIds: [4] },
        });
    });

    it('reassign', async () => {
        const t = h.t;
        await t.exchange('reassign face 6 to Bob', 'POST', '/api/ai/faces/6/reassign', {
            body: { personId: 2 },
        });
        await t.exchange('reassign face 6 to nobody (null)', 'POST', '/api/ai/faces/6/reassign', {
            body: { personId: null },
        });
        await t.exchange(
            'reassign face 7 with empty string (unassign)',
            'POST',
            '/api/ai/faces/7/reassign',
            {
                body: { personId: '' },
            },
        );
        await t.exchange('reassign bad personId → 400', 'POST', '/api/ai/faces/6/reassign', {
            body: { personId: 'abc' },
        });
        await t.exchange('reassign unknown face → 404', 'POST', '/api/ai/faces/999/reassign', {
            body: { personId: 1 },
        });
        await t.exchange('reassign bad face id → 400', 'POST', '/api/ai/faces/x/reassign', {
            body: { personId: 1 },
        });
        await t.exchange('faces of row 4 after reassign', 'GET', '/api/ai/faces/by-download/4');
    });

    it('delete a person', async () => {
        const t = h.t;
        await t.exchange('delete person 2', 'DELETE', '/api/ai/people/2');
        await t.exchange('delete person 2 again → 404', 'DELETE', '/api/ai/people/2');
        await t.exchange('delete bad id → 400', 'DELETE', '/api/ai/people/abc');
        await t.exchange('delete as guest → 403', 'DELETE', '/api/ai/people/1', { as: 'guest' });
        await t.exchange('people after repairs', 'GET', '/api/ai/people');
        await t.exchange('group-by-person after repairs', 'GET', '/api/ai/group-by-person');
        await t.exchange(
            'faces of row 3 after delete (person_id nulled)',
            'GET',
            '/api/ai/faces/by-download/3',
        );
    });

    it('repairs broadcast nothing on the dashboard socket', async () => {
        const t = h.t;
        const ws = t.ws();
        await ws.opened;
        ws.drain();
        await t.request('PATCH', '/api/ai/people/1', { body: { label: 'Alice' } });
        await t.request('POST', '/api/ai/faces/6/reassign', { body: { personId: 1 } });
        // A request that does broadcast, as an end marker.
        await t.request('POST', '/api/ai/faces/reindex', { body: {} });
        await ws.waitFor((m) => m.type === 'ai_faces_reindexed');
        ws.close();
        t.recordWs('ws events around rename + reassign (+ faces/reindex marker)', ws.drain());
    });
});
