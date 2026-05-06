// DBSCAN clustering unit test.
//
// Build 3 well-separated clusters of 5 points each in a 2-D unit-norm
// space, run dbscan() with parameters that should isolate them, and
// assert exactly 3 clusters with the expected sizes are returned.

import { describe, it, expect } from 'vitest';
import { dbscan } from '../../src/core/ai/faces.js';
import { l2Normalize } from '../../src/core/ai/vector-store.js';

function vec(x, y) {
    const v = new Float32Array([x, y]);
    l2Normalize(v);
    return v;
}

describe('dbscan()', () => {
    it('isolates 3 well-separated clusters', () => {
        const items = [];
        // Cluster A — pointing right (1, 0)
        for (let i = 0; i < 5; i++)
            items.push({ id: `a${i}`, vec: vec(1 + i * 0.01, 0.01 * (i % 2)) });
        // Cluster B — pointing up (0, 1)
        for (let i = 0; i < 5; i++)
            items.push({ id: `b${i}`, vec: vec(0.01 * (i % 2), 1 + i * 0.01) });
        // Cluster C — pointing diagonally negative
        for (let i = 0; i < 5; i++)
            items.push({ id: `c${i}`, vec: vec(-1 - i * 0.01, -1 - i * 0.01) });

        const clusters = dbscan(items, { epsilon: 0.4, minPoints: 3 });
        expect(clusters.length).toBe(3);
        // Each cluster should hold 5 members.
        const sizes = clusters.map((c) => c.size).sort((a, b) => a - b);
        expect(sizes).toEqual([5, 5, 5]);
    });

    it('returns no clusters when nothing satisfies minPoints', () => {
        const items = [
            { id: 1, vec: vec(1, 0) },
            { id: 2, vec: vec(-1, 0) }, // antipode — far in cosine distance
        ];
        const clusters = dbscan(items, { epsilon: 0.1, minPoints: 3 });
        expect(clusters.length).toBe(0);
    });

    it('handles an empty input gracefully', () => {
        expect(dbscan([], { epsilon: 0.4, minPoints: 3 })).toEqual([]);
    });
});
