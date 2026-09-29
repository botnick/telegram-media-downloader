// Face clustering (scan runner Phase B) now runs in tgdl-core. Its result
// must be the result of src/core/ai/dbscan.js exactly: the same clusters
// in the same order with the same members, byte-identical centroids and
// the same noise count — people's existing groups and the names carried
// over between runs depend on it.
//
// Checked live against dbscan.js on the tests/ai/dbscan.test.js fixtures
// and edge cases, and on a seeded 5000 × 512 set against a frozen digest
// of dbscan.js's output (tests/fixtures/gocore/dbscan-5000x512.json; set
// UPDATE_GOCORE_FIXTURES=1 to recompute it with dbscan.js).

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { requireCoreBin } from './helpers/gocore-raw.js';
import { packFaces, synthFaces } from './helpers/synth-faces.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'gocore', 'dbscan-5000x512.json');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-dbscan-parity-'));

let faces;
let dbscan;

beforeAll(async () => {
    requireCoreBin();
    process.env.TGDL_DATA_DIR = DATA_DIR;
    faces = await import('../src/core/ai/faces.js');
    dbscan = await import('../src/core/ai/dbscan.js');
});

afterAll(async () => {
    const { stopGoCore } = await import('../src/core/gocore/spawn.js');
    stopGoCore();
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

/** Node reference, in clusterFacesOffThread's result shape. */
function nodeCluster({ data, n, dim, weights }, opts) {
    const { clusters, noise } = dbscan.clusterFlat(data, n, dim, weights, opts);
    return { clusters, noiseCount: noise.length };
}

function digest(res) {
    const h = crypto.createHash('sha256');
    h.update(`${res.clusters.length}|${res.noiseCount}|`);
    for (const c of res.clusters) {
        h.update(Buffer.from(Int32Array.from(c.memberIdxs).buffer));
        h.update(Buffer.from(c.centroid.buffer, c.centroid.byteOffset, c.centroid.byteLength));
    }
    return h.digest('hex');
}

function expectIdentical(got, want) {
    expect(got.noiseCount).toBe(want.noiseCount);
    expect(got.clusters.length).toBe(want.clusters.length);
    got.clusters.forEach((c, i) => {
        const w = want.clusters[i];
        expect(Array.from(c.memberIdxs)).toEqual(Array.from(w.memberIdxs));
        expect(c.faceCount).toBe(w.faceCount);
        expect(
            Buffer.from(c.centroid.buffer, c.centroid.byteOffset, c.centroid.byteLength).equals(
                Buffer.from(w.centroid.buffer, w.centroid.byteOffset, w.centroid.byteLength),
            ),
        ).toBe(true);
    });
}

const CASES = [
    ['mixed identities', { n: 300, seed: 3 }, { eps: 1.05, minPts: 2 }],
    ['minPts 3 (border points)', { n: 300, seed: 5 }, { eps: 1.05, minPts: 3 }],
    ['straddling eps', { n: 250, seed: 7, noise: 0.16 }, { eps: 1.05, minPts: 2 }],
    ['tight eps', { n: 250, seed: 9 }, { eps: 0.6, minPts: 2 }],
    ['one dominant person', { n: 180, seed: 11, k: 1, strangers: 0.05 }, { eps: 1.05, minPts: 2 }],
    ['worker-sized input', { n: 400, seed: 19 }, { eps: 1.05, minPts: 2 }],
    [
        '1500 faces, 128-d, minPts 4',
        { n: 1500, seed: 31, dim: 128, k: 20 },
        { eps: 1.0, minPts: 4 },
    ],
    ['fractional minPts', { n: 300, seed: 37 }, { eps: 1.05, minPts: 2.5 }],
    ['eps 0', { n: 100, seed: 41 }, { eps: 0, minPts: 2 }],
    ['one face', { n: 1, seed: 43 }, { eps: 1.05, minPts: 2 }],
    ['no faces', { n: 0, seed: 43 }, { eps: 1.05, minPts: 2 }],
];

describe('tgdl-core DBSCAN equals dbscan.js', () => {
    for (const [name, gen, opts] of CASES) {
        it(name, async () => {
            const { n, ...rest } = gen;
            const packed = packFaces(synthFaces(n, rest));
            const want = nodeCluster(packed, opts);
            const got = await faces.clusterFacesOffThread(packed, opts);
            expectIdentical(got, want);
        }, 60_000);
    }

    it('a row of another dimension (NaN) and no weights', async () => {
        const f = synthFaces(60, { seed: 13 });
        f[5] = { ...f[5], embedding: f[5].embedding.slice(0, 32) };
        const { data, n, dim } = dbscan.packPoints(f.map((x) => x.embedding));
        const opts = { eps: 1.05, minPts: 2 };
        const want = nodeCluster({ data, n, dim, weights: null }, opts);
        const got = await faces.clusterFacesOffThread({ data, n, dim }, opts);
        expectIdentical(got, want);
    });

    it('5000 × 512, fixed seed: identical to the frozen dbscan.js result', async () => {
        const packed = packFaces(
            synthFaces(5000, { seed: 20260929, dim: 512, k: 60, noise: 0.045, strangers: 0.2 }),
        );
        const opts = { eps: 1.05, minPts: 2 };
        const progress = [];
        const got = await faces.clusterFacesOffThread(packed, {
            ...opts,
            onProgress: (done, total) => progress.push([done, total]),
        });
        if (process.env.UPDATE_GOCORE_FIXTURES === '1') {
            const want = nodeCluster(packed, opts);
            fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
            fs.writeFileSync(
                FIXTURE,
                `${JSON.stringify(
                    {
                        generator:
                            'synthFaces(5000, {seed: 20260929, dim: 512, k: 60, noise: 0.045, strangers: 0.2})',
                        opts,
                        clusters: want.clusters.length,
                        noiseCount: want.noiseCount,
                        largest: want.clusters[0]?.faceCount ?? 0,
                        sha256: digest(want),
                    },
                    null,
                    2,
                )}\n`,
            );
        }
        const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
        expect(got.clusters.length).toBe(fixture.clusters);
        expect(got.noiseCount).toBe(fixture.noiseCount);
        expect(digest(got)).toBe(fixture.sha256);
        expect(fixture.clusters).toBeGreaterThan(10); // a meaningful set
        expect(progress.at(-1)).toEqual([5000, 5000]);
    }, 300_000);

    it('progress is reported from 256 faces up, as before', async () => {
        const small = [];
        await faces.clusterFacesOffThread(packFaces(synthFaces(100, { seed: 3 })), {
            eps: 1.05,
            minPts: 2,
            onProgress: (d) => small.push(d),
        });
        expect(small).toEqual([]);
    });

    it('abort stops it with an AbortError; the next run works', async () => {
        const packed = packFaces(synthFaces(6000, { seed: 23, dim: 256 }));
        const ctrl = new AbortController();
        const p = faces.clusterFacesOffThread(packed, {
            eps: 1.05,
            minPts: 2,
            signal: ctrl.signal,
        });
        setTimeout(() => ctrl.abort(), 30);
        await expect(p).rejects.toMatchObject({ name: 'AbortError' });
        const small = packFaces(synthFaces(50, { seed: 29 }));
        const opts = { eps: 1.05, minPts: 2 };
        expectIdentical(await faces.clusterFacesOffThread(small, opts), nodeCluster(small, opts));
    }, 60_000);
});
