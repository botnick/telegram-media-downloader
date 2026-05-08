// Verifies the race-condition fix in the v2.9 maintenance commit:
// migrating thumbs/build-all, faststart/scan, dedup/scan, and reindex
// from hand-rolled `let _xRunning = false` to JobTracker closes the
// double-click 409 window — previously the catch block broadcast
// `${prefix}_done` BEFORE the finally block reset the flag, so a retry
// after a failed run got a spurious 409 ALREADY_RUNNING.
//
// We don't spin up Express here — the migration is a thin adapter that
// calls JobTracker.tryStart, so re-asserting the JobTracker contract
// against a runFn shaped like the real ones (return value matching
// what dedup/thumbs/faststart/reindex actually return) covers the
// failure mode without the test-fixture cost.

import { describe, it, expect } from 'vitest';
import { createJobTracker } from '../src/core/job-tracker.js';

function flushAsync(times = 4) {
    let p = Promise.resolve();
    for (let i = 0; i < times; i++) p = p.then(() => undefined);
    return p;
}

describe('maintenance race-condition fix', () => {
    it('after a thrown runFn, the next tryStart succeeds (no stuck 409)', async () => {
        // Repro of the pre-migration bug: server broadcasts dedup_done
        // with {error} BEFORE resetting `_dedupRunning = false` in the
        // finally — the WS client retries, the second POST hits the
        // still-true flag and gets 409 even though the job is over.
        // JobTracker bundles the running-flag reset and the done-event
        // broadcast in the same finally, so this retry succeeds.
        const broadcasts = [];
        const t = createJobTracker({
            kind: 'dedupScan',
            broadcast: (m) => broadcasts.push(m),
            eventPrefix: 'dedup',
        });

        const first = t.tryStart(async () => {
            throw new Error('disk full');
        });
        expect(first.started).toBe(true);
        await flushAsync(20);

        // A `dedup_done` with the error is observed.
        const errDone = broadcasts.find((m) => m.type === 'dedup_done' && m.error);
        expect(errDone).toBeTruthy();
        expect(errDone.error).toBe('disk full');

        // Retry succeeds — the window where the flag stays true after a
        // broadcast is closed.
        const second = t.tryStart(async () => ({ duplicateSets: [], scanned: 0 }));
        expect(second.started).toBe(true);
        expect(second.code).toBeUndefined();
    });

    it('double-click during a long run returns 409 with ALREADY_RUNNING', async () => {
        // Single-flight contract — the second simultaneous start gets a
        // structured 409 the route handler can forward as JSON. The
        // prefix-aware snapshot lets the client repaint a running UI
        // mid-flight (e.g. "another tab is on it").
        const t = createJobTracker({
            kind: 'thumbsBuild',
            broadcast: () => {},
            eventPrefix: 'thumbs',
        });

        const first = t.tryStart(async () => {
            await new Promise((res) => setTimeout(res, 60));
            return { built: 1 };
        });
        expect(first.started).toBe(true);

        const second = t.tryStart(async () => ({ never: true }));
        expect(second.started).toBe(false);
        expect(second.code).toBe('ALREADY_RUNNING');
        expect(second.snapshot.running).toBe(true);

        await flushAsync(20);
        await new Promise((res) => setTimeout(res, 80));
        expect(t.isRunning()).toBe(false);
    });

    it('progress callback merges flat fields onto the broadcast for legacy WS subs', async () => {
        // The frontend reads `m.processed`, `m.total`, `m.stage` flat
        // off the WS message. Verify JobTracker spreads the merged
        // progress object into the broadcast so the duplicates page's
        // existing `dedup_progress` listener keeps working post-migration.
        const broadcasts = [];
        const t = createJobTracker({
            kind: 'reindex',
            broadcast: (m) => broadcasts.push(m),
            eventPrefix: 'reindex',
        });

        t.tryStart(async ({ onProgress }) => {
            onProgress({ stage: 'walking', processed: 12, total: 100 });
            return { added: 0, scanned: 100 };
        });
        await flushAsync(20);

        const progress = broadcasts.find(
            (m) => m.type === 'reindex_progress' && m.stage === 'walking',
        );
        expect(progress).toBeTruthy();
        expect(progress.processed).toBe(12);
        expect(progress.total).toBe(100);
    });
});
