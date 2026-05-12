// Phase 2 integration tests — manual cluster operations + centroid-
// based label preservation. Locks in:
//   - mergeFacePerson: faces flow from B → A, B is deleted, A.count updates
//   - splitFacePerson: selected faces form a new cluster, sources rebalance
//   - reassignFace: single-face hop between clusters
//   - matchClusterToPersistedLabel: closest labelled centroid within eps

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-face-ops-'));
let db;
let api;

const f32Blob = (vec) => Buffer.from(new Float32Array(vec).buffer);

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    api = await import('../../src/core/db.js');
    db = api.getDb();
    // One download row for foreign keys on faces
    api.insertDownload({
        groupId: '-100777',
        groupName: 'Faces Fixture',
        messageId: 1,
        fileName: 'f1.jpg',
        fileSize: 1000,
        fileType: 'photo',
        filePath: 'Faces_Fixture/images/f1.jpg',
    });
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
    // Reset clusters + faces between tests
    db.prepare('DELETE FROM faces').run();
    db.prepare('DELETE FROM people').run();
});

const downloadId = () => db.prepare('SELECT id FROM downloads LIMIT 1').get().id;

describe('mergeFacePerson', () => {
    it('moves every face from other → target and deletes the empty cluster', () => {
        const did = downloadId();
        const aId = api.insertPerson({
            label: 'Bob',
            centroidBlob: f32Blob([1, 0, 0]),
            faceCount: 2,
        });
        const bId = api.insertPerson({
            label: 'Bob copy',
            centroidBlob: f32Blob([1, 0.05, 0]),
            faceCount: 1,
        });
        api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([1, 0, 0]),
            personId: aId,
        });
        api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([1, 0, 0]),
            personId: aId,
        });
        api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([1, 0.05, 0]),
            personId: bId,
        });

        const r = api.mergeFacePerson(aId, bId);
        expect(r.moved).toBe(1);
        expect(r.deleted).toBe(1);

        const stillExists = db.prepare('SELECT id FROM people WHERE id = ?').get(bId);
        expect(stillExists).toBeUndefined();
        const newCount = db.prepare('SELECT face_count FROM people WHERE id = ?').get(aId);
        expect(newCount.face_count).toBe(3);
    });

    it('no-ops when target === other or args invalid', () => {
        expect(api.mergeFacePerson(5, 5)).toEqual({ moved: 0, deleted: 0 });
        expect(api.mergeFacePerson(null, 5)).toEqual({ moved: 0, deleted: 0 });
    });
});

describe('splitFacePerson', () => {
    it('creates a new cluster from selected faces and rebalances sources', () => {
        const did = downloadId();
        const pid = api.insertPerson({
            label: 'A',
            centroidBlob: f32Blob([1, 0, 0, 0]),
            faceCount: 4,
        });
        const f1 = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([1, 0, 0, 0]),
            personId: pid,
        }).lastInsertRowid;
        const f2 = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([0.9, 0.1, 0, 0]),
            personId: pid,
        }).lastInsertRowid;
        const f3 = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([0, 1, 0, 0]),
            personId: pid,
        }).lastInsertRowid;
        const f4 = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([0, 0.9, 0.1, 0]),
            personId: pid,
        }).lastInsertRowid;

        // Pull f3 + f4 (the "wrong" half) into a new cluster
        const r = api.splitFacePerson([f3, f4], 'B');
        expect(r.moved).toBe(2);
        expect(r.personId).toBeGreaterThan(0);

        const old = db.prepare('SELECT face_count FROM people WHERE id = ?').get(pid);
        expect(old.face_count).toBe(2);
        const fresh = db
            .prepare('SELECT face_count, label FROM people WHERE id = ?')
            .get(r.personId);
        expect(fresh.face_count).toBe(2);
        expect(fresh.label).toBe('B');
    });

    it('deletes the source cluster when every face moves out', () => {
        const did = downloadId();
        const pid = api.insertPerson({ centroidBlob: f32Blob([1, 0]), faceCount: 2 });
        const f1 = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([1, 0]),
            personId: pid,
        }).lastInsertRowid;
        const f2 = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([1, 0.05]),
            personId: pid,
        }).lastInsertRowid;
        api.splitFacePerson([f1, f2], 'New');
        const remaining = db.prepare('SELECT id FROM people WHERE id = ?').get(pid);
        expect(remaining).toBeUndefined();
    });

    it('returns null personId for empty input', () => {
        expect(api.splitFacePerson([])).toEqual({ personId: null, moved: 0 });
        expect(api.splitFacePerson(null)).toEqual({ personId: null, moved: 0 });
    });
});

describe('reassignFace', () => {
    it('moves a face between two clusters + updates face_count both ways', () => {
        const did = downloadId();
        const pA = api.insertPerson({ label: 'A', centroidBlob: f32Blob([1, 0]), faceCount: 2 });
        const pB = api.insertPerson({ label: 'B', centroidBlob: f32Blob([0, 1]), faceCount: 1 });
        api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([1, 0]),
            personId: pA,
        });
        const moveMe = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([0.5, 0.5]),
            personId: pA,
        }).lastInsertRowid;
        api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([0, 1]),
            personId: pB,
        });

        const r = api.reassignFace(moveMe, pB);
        expect(r.ok).toBe(true);
        expect(r.oldPersonId).toBe(pA);
        expect(r.newPersonId).toBe(pB);

        expect(db.prepare('SELECT face_count FROM people WHERE id = ?').get(pA).face_count).toBe(1);
        expect(db.prepare('SELECT face_count FROM people WHERE id = ?').get(pB).face_count).toBe(2);
    });

    it('deletes source cluster when its last face leaves', () => {
        const did = downloadId();
        const pA = api.insertPerson({ centroidBlob: f32Blob([1, 0]), faceCount: 1 });
        const pB = api.insertPerson({ centroidBlob: f32Blob([0, 1]), faceCount: 0 });
        const only = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([1, 0]),
            personId: pA,
        }).lastInsertRowid;
        api.reassignFace(only, pB);
        expect(db.prepare('SELECT id FROM people WHERE id = ?').get(pA)).toBeUndefined();
    });

    it('reassign to null = unassign', () => {
        const did = downloadId();
        const pA = api.insertPerson({ centroidBlob: f32Blob([1, 0]), faceCount: 1 });
        const fid = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([1, 0]),
            personId: pA,
        }).lastInsertRowid;
        const r = api.reassignFace(fid, null);
        expect(r.ok).toBe(true);
        const after = db.prepare('SELECT person_id FROM faces WHERE id = ?').get(fid);
        expect(after.person_id).toBeNull();
    });

    it('returns {ok:false} for unknown face id', () => {
        const r = api.reassignFace(99999, null);
        expect(r.ok).toBe(false);
    });
});

describe('matchClusterToPersistedLabel', () => {
    it('returns the closest labelled centroid within eps', () => {
        api.insertPerson({ label: 'Bob', centroidBlob: f32Blob([1, 0, 0]), faceCount: 5 });
        api.insertPerson({ label: 'Alice', centroidBlob: f32Blob([0, 1, 0]), faceCount: 3 });
        // Query very close to Bob's centroid
        const r = api.matchClusterToPersistedLabel(new Float32Array([0.95, 0.05, 0]), 0.4);
        expect(r).toBeTruthy();
        expect(r.label).toBe('Bob');
        expect(r.distance).toBeLessThan(0.4);
    });

    it('returns null when nothing is within eps', () => {
        api.insertPerson({ label: 'Bob', centroidBlob: f32Blob([1, 0, 0]), faceCount: 5 });
        const r = api.matchClusterToPersistedLabel(new Float32Array([-1, 0, 0]), 0.4);
        expect(r).toBeNull();
    });

    it('ignores unlabelled clusters', () => {
        api.insertPerson({ centroidBlob: f32Blob([1, 0, 0]), faceCount: 5 }); // no label
        const r = api.matchClusterToPersistedLabel(new Float32Array([1, 0, 0]), 0.4);
        expect(r).toBeNull();
    });

    it('returns null for non-Float32Array input', () => {
        expect(api.matchClusterToPersistedLabel(null, 0.4)).toBeNull();
        expect(api.matchClusterToPersistedLabel([1, 2, 3], 0.4)).toBeNull();
    });
});

describe('setFaceQualityScore', () => {
    it('persists quality_score on an existing face row', () => {
        const did = downloadId();
        const fid = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([1, 0]),
        }).lastInsertRowid;
        api.setFaceQualityScore(fid, 0.91);
        const row = db.prepare('SELECT quality_score FROM faces WHERE id = ?').get(fid);
        expect(row.quality_score).toBeCloseTo(0.91, 5);
    });
});

