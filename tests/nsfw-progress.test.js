import { describe, expect, it } from 'vitest';

import { _mergeScanState } from '../src/core/nsfw.js';

describe('NSFW scan progress state', () => {
    const stats = {
        totalEligible: 399549,
        scanned: 399549,
        candidates: 120,
        keep: 399429,
        whitelisted: 4,
        lastCheckedAt: 123,
    };

    it('uses the library snapshot before any scan has started', () => {
        const state = _mergeScanState(
            {
                running: false,
                scanned: 0,
                total: 0,
                candidates: 0,
                keep: 0,
                startedAt: null,
            },
            stats,
        );
        expect(state).toMatchObject({
            scanned: 399549,
            total: 0,
            candidates: 120,
            keep: 399429,
        });
    });

    it('keeps the run denominator after it finishes and live counters while running', () => {
        const state = _mergeScanState(
            {
                running: false,
                scanned: 14747,
                total: 14747,
                candidates: 61,
                keep: 14686,
                startedAt: 100,
                finishedAt: 200,
            },
            stats,
        );
        expect(state).toMatchObject({
            scanned: 14747,
            total: 14747,
            candidates: 120,
            keep: 399429,
            totalEligible: 399549,
        });
        expect(state.scanned).toBeLessThanOrEqual(state.total);

        const live = _mergeScanState(
            { ...state, running: true, scanned: 320, candidates: 12, keep: 308 },
            stats,
        );
        expect(live).toMatchObject({ scanned: 320, total: 14747, candidates: 12, keep: 308 });
    });
});
