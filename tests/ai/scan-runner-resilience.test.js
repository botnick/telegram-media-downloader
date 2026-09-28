// Scan-runner behaviour when the sidecar is down, restarting, or keeps
// falling over on one file — plus the Phase B people swap. Real tmpdir DB,
// mocked faces-client (no sidecar process), same setup as
// scan-runner-video.test.js.
//
// The invariant under test: a row is stamped `ai_indexed_at` only once
// the sidecar actually answered for it. An outage must never be recorded
// as "no faces in this photo".

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../src/core/ai/faces-client.js', async (importOriginal) => {
    const orig = await importOriginal();
    return {
        ...orig,
        detectFacesBatch: vi.fn(),
        detectFacesInVideo: vi.fn().mockResolvedValue([]),
        waitForSidecarReady: vi.fn().mockResolvedValue(true),
    };
});

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-scan-resilience-'));
const DOWNLOADS = path.join(DATA_DIR, 'downloads');
let db;
let dbApi;
let scanner;
let client;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    fs.mkdirSync(DOWNLOADS, { recursive: true });
    dbApi = await import('../../src/core/db.js');
    db = dbApi.getDb();
    scanner = await import('../../src/core/ai/scan-runner.js');
    client = await import('../../src/core/ai/faces-client.js');
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
    vi.clearAllMocks();
    client.waitForSidecarReady.mockResolvedValue(true);
    scanner._resetForTests();
    db.prepare('DELETE FROM faces').run();
    db.prepare('DELETE FROM people').run();
    db.prepare('DELETE FROM downloads').run();
});

let _msg = 0;
function addPhoto(name) {
    fs.writeFileSync(path.join(DOWNLOADS, name), 'not-really-a-jpeg');
    dbApi.insertDownload({
        groupId: '-100555',
        groupName: 'Resilience',
        messageId: ++_msg,
        fileName: name,
        fileSize: 17,
        fileType: 'photo',
        filePath: name,
    });
    return db.prepare('SELECT id FROM downloads ORDER BY id DESC LIMIT 1').get().id;
}

const stamped = (id) =>
    db.prepare('SELECT ai_indexed_at FROM downloads WHERE id = ?').get(id).ai_indexed_at !== null;

async function runScan(cfg = {}) {
    const done = new Promise((resolve) => {
        scanner.startFacesScan(
            { faces: { fileTypes: ['photo'], cpuThrottleRatio: 0, ...cfg } },
            null,
            resolve,
            null,
        );
    });
    return done;
}

const unavailable = () => new client.SidecarUnavailableError('connect ECONNREFUSED');

describe('sidecar outage handling', () => {
    it('never-ready sidecar: scan fails, nothing is stamped, nothing is sent', async () => {
        const ids = [addPhoto('a.jpg'), addPhoto('b.jpg')];
        client.waitForSidecarReady.mockResolvedValue(false);
        const final = await runScan();
        expect(final.error).toMatch(/face sidecar unavailable/);
        expect(client.detectFacesBatch).not.toHaveBeenCalled();
        for (const id of ids) expect(stamped(id)).toBe(false);
    });

    it('transient outage: rows stay queued, get scanned once the sidecar is back', async () => {
        const ids = [addPhoto('c.jpg'), addPhoto('d.jpg'), addPhoto('e.jpg')];
        let calls = 0;
        client.detectFacesBatch.mockImplementation(async (paths) => {
            calls++;
            if (calls === 1) {
                // Nothing must be stamped while the sidecar is away.
                throw unavailable();
            }
            return paths.map(() => []);
        });
        const final = await runScan();
        expect(final.error).toBeNull();
        // start gate + one wait after the outage
        expect(client.waitForSidecarReady).toHaveBeenCalledTimes(2);
        for (const id of ids) expect(stamped(id)).toBe(true);
        expect(final.scanned).toBe(3);
    });

    it('outage that outlasts the wait: scan stops, unscanned rows stay queued', async () => {
        const ids = [addPhoto('f.jpg'), addPhoto('g.jpg')];
        client.detectFacesBatch.mockRejectedValue(unavailable());
        client.waitForSidecarReady
            .mockResolvedValueOnce(true) // scan start
            .mockResolvedValueOnce(false); // after the failed batch
        const final = await runScan();
        expect(final.error).toMatch(/face sidecar unavailable/);
        for (const id of ids) expect(stamped(id)).toBe(false);
    });

    it('a file that keeps knocking the sidecar over is isolated and skipped, never stamped', async () => {
        // 8 rows → chunks of 2, so the poison file first fails together
        // with an innocent neighbour.
        const good = ['h', 'i', 'j'].map((n) => addPhoto(`${n}.jpg`));
        const poison = addPhoto('poison.jpg');
        const good2 = ['n', 'o', 'p', 'q'].map((n) => addPhoto(`${n}.jpg`));
        const poisonCalls = [];
        client.detectFacesBatch.mockImplementation(async (paths) => {
            if (paths.some((p) => p.endsWith('poison.jpg'))) {
                poisonCalls.push(paths.length);
                throw unavailable();
            }
            return paths.map(() => []);
        });
        const final = await runScan();
        expect(final.error).toBeNull();
        for (const id of [...good, ...good2]) expect(stamped(id)).toBe(true);
        // Skipped for this run only — a failed call is never recorded as
        // "scanned", so the next scan tries it again.
        expect(stamped(poison)).toBe(false);
        // After the first failure the poison file only ever went alone.
        expect(poisonCalls).toEqual([2, 1, 1]);
    });

    it('a single file that hits the request deadline is skipped at once, not retried', async () => {
        // 5 rows → chunks of 2: the slow file first times out alongside a
        // neighbour (that one gets retried), then alone (skipped).
        const slow = addPhoto('slow.jpg');
        const oks = ['ok1', 'ok2', 'ok3', 'ok4'].map((n) => addPhoto(`${n}.jpg`));
        const calls = [];
        client.detectFacesBatch.mockImplementation(async (paths) => {
            calls.push(paths.map((p) => path.basename(p)));
            if (paths.some((p) => p.endsWith('slow.jpg'))) {
                throw new client.SidecarUnavailableError('timed out after 120000 ms', null, {
                    timedOut: true,
                });
            }
            return paths.map(() => []);
        });
        const final = await runScan();
        expect(final.error).toBeNull();
        for (const id of oks) expect(stamped(id)).toBe(true);
        expect(stamped(slow)).toBe(false);
        // once in the parallel batch, once alone — then skipped
        expect(calls.filter((c) => c.includes('slow.jpg'))).toEqual([
            ['slow.jpg', 'ok1.jpg'],
            ['slow.jpg'],
        ]);
    });

    it('a rejected API token stops the scan at once, nothing stamped', async () => {
        const ids = ['r1', 'r2', 'r3'].map((n) => addPhoto(`${n}.jpg`));
        client.detectFacesBatch.mockRejectedValue(
            new client.SidecarUnavailableError('sidecar rejected the API token (401)', null, {
                fatal: true,
            }),
        );
        const final = await runScan();
        expect(final.error).toMatch(/401/);
        for (const id of ids) expect(stamped(id)).toBe(false);
        expect(client.waitForSidecarReady).toHaveBeenCalledTimes(1); // no outage wait loop
    });

    it('per-file answers (no faces / decode_failed → []) are stamped as before', async () => {
        const id = addPhoto('k.jpg');
        client.detectFacesBatch.mockImplementation(async (paths) => paths.map(() => []));
        await runScan();
        expect(stamped(id)).toBe(true);
    });

    it('persists the EXIF-orientation mark reported by newer sidecars', async () => {
        const id = addPhoto('l.jpg');
        const emb = Float32Array.from({ length: 8 }, (_, i) => (i === 0 ? 1 : 0));
        client.detectFacesBatch.mockImplementation(async (paths) =>
            paths.map(() => [
                {
                    x: 1,
                    y: 2,
                    w: 90,
                    h: 90,
                    score: 0.9,
                    qualityScore: 0.7,
                    embedding: emb,
                    exifOriented: true,
                },
            ]),
        );
        await runScan();
        const row = db
            .prepare('SELECT exif_oriented, quality_score FROM faces WHERE download_id = ?')
            .get(id);
        expect(row.exif_oriented).toBe(1);
        expect(row.quality_score).toBeCloseTo(0.7, 5);
    });
});

describe('phase B people swap', () => {
    const blob = (v) => Buffer.from(new Float32Array(v).buffer);

    it('replaces the previous generation, keeps labels, clears noise faces', async () => {
        const dl = addPhoto('m.jpg');
        dbApi.setAiIndexedAt(dl);
        // Two tight identities + one stranger (unit vectors in 4-d).
        const A = [1, 0, 0, 0];
        const B = [0, 1, 0, 0];
        const near = (v, i, d) => v.map((x, k) => (k === i ? x - d : k === (i + 1) % 4 ? d : x));
        const faceIds = [];
        const add = (v) => {
            dbApi.insertFace({
                downloadId: dl,
                x: 0,
                y: 0,
                w: 90,
                h: 90,
                embeddingBlob: blob(v),
                qualityScore: 0.8,
            });
            faceIds.push(db.prepare('SELECT MAX(id) AS id FROM faces').get().id);
        };
        add(A);
        add(near(A, 0, 0.05));
        add(B);
        add(near(B, 1, 0.05));
        add([0, 0, 0, 1]); // stranger
        // Previous generation: A was named "Alice"; the stranger was wrongly
        // grouped with a person that must disappear.
        const oldAlice = dbApi.insertPerson({
            label: 'Alice',
            centroidBlob: blob(A),
            faceCount: 2,
        });
        const oldGhost = dbApi.insertPerson({
            label: null,
            centroidBlob: blob([0, 0, 0, 1]),
            faceCount: 1,
        });
        db.prepare('UPDATE faces SET person_id = ? WHERE id IN (?, ?)').run(
            oldAlice,
            faceIds[0],
            faceIds[1],
        );
        db.prepare('UPDATE faces SET person_id = ? WHERE id = ?').run(oldGhost, faceIds[4]);

        const final = await runScan({ epsilon: 0.3, minPoints: 2 });
        expect(final.error).toBeNull();
        expect(final.peopleCount).toBe(2);
        expect(final.noiseFaces).toBe(1);

        const people = db.prepare('SELECT id, label, face_count FROM people ORDER BY id').all();
        expect(people.map((p) => p.id).every((id) => id > oldGhost)).toBe(true);
        expect(people.map((p) => p.label).sort()).toEqual(['Alice', null].sort());
        const personOf = (fid) =>
            db.prepare('SELECT person_id FROM faces WHERE id = ?').get(fid).person_id;
        expect(personOf(faceIds[0])).toBe(personOf(faceIds[1]));
        expect(personOf(faceIds[2])).toBe(personOf(faceIds[3]));
        expect(personOf(faceIds[0])).not.toBe(personOf(faceIds[2]));
        expect(personOf(faceIds[4])).toBeNull();
        const alice = people.find((p) => p.label === 'Alice');
        expect(personOf(faceIds[0])).toBe(alice.id);
    });
});
