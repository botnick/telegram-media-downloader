// Faces unit tests. Covers the math (euclidean, centroid), DBSCAN
// correctness on synthetic clusters, and the cluster-sorting contract.
// `detectFaces` is integration-tested via scan-runner because it needs
// the Python sidecar (faces-service) reachable.

import { describe, it, expect } from 'vitest';
import * as faces from '../../src/core/ai/faces.js';

const F = (...arr) => new Float32Array(arr);

describe('euclidean', () => {
    it('returns 0 for identical vectors', () => {
        expect(faces.euclidean(F(1, 2, 3), F(1, 2, 3))).toBe(0);
    });
    it('returns sqrt of sum of squared diffs', () => {
        // (3,4) -> 5
        expect(faces.euclidean(F(0, 0), F(3, 4))).toBeCloseTo(5, 5);
    });
    it('returns Infinity for shape mismatch', () => {
        expect(faces.euclidean(F(1, 2), F(1, 2, 3))).toBe(Infinity);
        expect(faces.euclidean(null, F(1))).toBe(Infinity);
    });
});

describe('centroid', () => {
    it('returns null for empty input', () => {
        expect(faces.centroid([])).toBeNull();
        expect(faces.centroid(null)).toBeNull();
    });
    it('returns the arithmetic mean', () => {
        const c = faces.centroid([F(0, 0), F(2, 4), F(4, 8)]);
        expect(c[0]).toBeCloseTo(2, 5);
        expect(c[1]).toBeCloseTo(4, 5);
    });
    it('skips mismatched-dim entries gracefully', () => {
        const c = faces.centroid([F(0, 0), F(1, 1), F(99)]);
        expect(c.length).toBe(2);
        // 3rd entry skipped — divisor is 2 (valid entries only)
        expect(c[0]).toBeCloseTo((0 + 1) / 2, 5);
    });
});

describe('dbscan', () => {
    it('groups two clear clusters and rejects outliers', () => {
        // Cluster A around origin (5 points within 0.1)
        // Cluster B around (10, 10) (5 points within 0.1)
        // Plus 2 outliers far from both
        const pts = [
            F(0, 0),
            F(0.05, 0.05),
            F(0.1, 0),
            F(0, 0.1),
            F(0.05, -0.05),
            F(10, 10),
            F(10.05, 10.05),
            F(10.1, 10),
            F(10, 10.1),
            F(10.05, 9.95),
            F(50, 50), // outlier
            F(-50, -50), // outlier
        ];
        const labels = faces.dbscan(pts, { eps: 0.5, minPts: 3 });
        // First 5 -> same cluster
        const a = labels[0];
        for (let i = 1; i < 5; i++) expect(labels[i]).toBe(a);
        // Next 5 -> same cluster (different from first)
        const b = labels[5];
        for (let i = 6; i < 10; i++) expect(labels[i]).toBe(b);
        expect(a).not.toBe(b);
        // Outliers -> -1
        expect(labels[10]).toBe(-1);
        expect(labels[11]).toBe(-1);
    });

    it('returns all-noise when minPts is too high', () => {
        const pts = [F(0, 0), F(0.1, 0.1), F(0.2, 0.2)];
        const labels = faces.dbscan(pts, { eps: 0.5, minPts: 10 });
        for (const l of labels) expect(l).toBe(-1);
    });

    it('handles empty input', () => {
        expect(faces.dbscan([])).toEqual([]);
        expect(faces.dbscan(null)).toEqual([]);
    });

    it('uses defaults when opts omitted', () => {
        // 3 close points with default eps=0.5, minPts=3 -> one cluster
        const pts = [
            F(0, 0, ...new Array(126).fill(0)),
            F(0.1, 0.1, ...new Array(126).fill(0)),
            F(0.2, 0.2, ...new Array(126).fill(0)),
        ];
        const labels = faces.dbscan(pts);
        expect(new Set(labels).size).toBe(1);
        expect(labels[0]).toBe(0);
    });
});

describe('clusterFaces', () => {
    it('orders clusters DESC by face count', () => {
        const facesArr = [
            // Big cluster — 5 members near origin
            { embedding: F(0, 0) },
            { embedding: F(0.05, 0.05) },
            { embedding: F(0.1, 0) },
            { embedding: F(0, 0.1) },
            { embedding: F(0.05, -0.05) },
            // Smaller cluster — 3 members near (10,10)
            { embedding: F(10, 10) },
            { embedding: F(10.05, 10.05) },
            { embedding: F(10, 10.1) },
            // Outlier
            { embedding: F(50, 50) },
        ];
        const { clusters, noise } = faces.clusterFaces(facesArr, { eps: 0.5, minPts: 3 });
        expect(clusters).toHaveLength(2);
        expect(clusters[0].faceCount).toBe(5);
        expect(clusters[1].faceCount).toBe(3);
        expect(clusters[0].centroid).toBeInstanceOf(Float32Array);
        expect(noise).toEqual([8]);
    });

    it('returns empty clusters when none reach minPts', () => {
        const facesArr = [{ embedding: F(0, 0) }, { embedding: F(0.1, 0.1) }];
        const { clusters, noise } = faces.clusterFaces(facesArr, { eps: 0.5, minPts: 5 });
        expect(clusters).toEqual([]);
        expect(noise).toEqual([0, 1]);
    });
});

describe('module surface', () => {
    it('exports detectFaces as a function', () => {
        expect(typeof faces.detectFaces).toBe('function');
    });
    it('FACE_DEFAULTS is frozen', () => {
        expect(Object.isFrozen(faces.FACE_DEFAULTS)).toBe(true);
        // ArcFace 512-dim L2-normalised: ε=1.1 + minPts=2 is the
        // calibrated default (see scripts/calibrate-faces-eps.js).
        // Tested on a 50-photo Telegram-library sample: ε=1.1
        // surfaces 5+ distinct people; ε≥1.3 collapses everyone
        // into one mega-cluster.
        expect(faces.FACE_DEFAULTS.facesEpsilon).toBeCloseTo(1.05, 5);
        expect(faces.FACE_DEFAULTS.facesMinPoints).toBe(2);
    });
});

describe('qualityFilter', () => {
    const good = (extra = {}) => ({
        x: 0,
        y: 0,
        w: 120,
        h: 120,
        score: 0.85,
        embedding: new Float32Array(128),
        ...extra,
    });

    it('keeps good detections', () => {
        const out = faces.qualityFilter([good(), good()]);
        expect(out).toHaveLength(2);
    });
    it('drops below-threshold detection score (default 0.5)', () => {
        // Default `FACE_DEFAULTS.minDetectionScore` is 0.5. A face with
        // score 0.4 must be dropped; 0.85 must be kept.
        const out = faces.qualityFilter([good({ score: 0.4 }), good()]);
        expect(out).toHaveLength(1);
        expect(out[0].score).toBe(0.85);
    });
    it('drops too-small boxes (< 80 px min edge by default)', () => {
        const out = faces.qualityFilter([good({ w: 50, h: 50 }), good()]);
        expect(out).toHaveLength(1);
    });
    it('drops elongated boxes (aspect outside [0.5, 2.0])', () => {
        const wide = good({ w: 400, h: 80 }); // 5:1
        const tall = good({ w: 80, h: 400 }); // 1:5
        const out = faces.qualityFilter([wide, tall, good()]);
        expect(out).toHaveLength(1);
    });
    it('respects custom minDetectionScore', () => {
        // With minDetectionScore=0.6, a 0.55-score detection drops.
        const out = faces.qualityFilter([good({ score: 0.55 })], { minDetectionScore: 0.6 });
        expect(out).toHaveLength(0);
        // With default 0.5 it would be kept.
        const out2 = faces.qualityFilter([good({ score: 0.55 })]);
        expect(out2).toHaveLength(1);
    });
    it('respects custom minFaceSizePx', () => {
        const out = faces.qualityFilter([good({ w: 50, h: 50 })], { minFaceSizePx: 40 });
        expect(out).toHaveLength(1);
    });
    it('returns [] for non-array input', () => {
        expect(faces.qualityFilter(null)).toEqual([]);
        expect(faces.qualityFilter(undefined)).toEqual([]);
    });
});
