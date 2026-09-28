/**
 * Stale-while-revalidate holder for ONE slow async value — e.g. the
 * Telegram dialogs name map that /api/groups + /api/downloads enrich
 * their rows with.
 *
 *   - Fresh value            → returned as-is, no work.
 *   - Stale value            → returned immediately; one background
 *                              refresh is kicked off.
 *   - Cold (never loaded)    → `get({ waitMs })` waits at most `waitMs`
 *                              for the first load, then gives up and
 *                              returns `undefined` (the load keeps
 *                              running and lands for the next caller).
 *
 * Concurrent callers share one in-flight load (single-flight). A failed
 * load — a rejection, a timeout, or a result `isUsable()` rejects (e.g.
 * an empty map because every account errored) — keeps the last good
 * value and suppresses retries for `retryAfterFailureMs`, so a sick
 * upstream is asked at most once per window instead of once per request.
 * `loadTimeoutMs` bounds a hung load so it can't block refreshes forever.
 *
 *   const names = createSwrCache({ load: fetchNames, ttlMs: 5 * 60_000 });
 *   const value = await names.get({ waitMs: 2000 }); // may be undefined
 */
export function createSwrCache({
    load,
    ttlMs,
    retryAfterFailureMs = 30_000,
    loadTimeoutMs = 90_000,
    isUsable = (v) => v !== undefined && v !== null,
    now = Date.now,
}) {
    let value;
    let hasValue = false;
    // Wallclock ms; comparisons use Math.max(0, …) to survive NTP jumps.
    let fetchedAt = 0;
    let failedAt = 0;
    let inflight = null;

    function refresh() {
        if (inflight) return inflight;
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('load timed out')), loadTimeoutMs);
            timer.unref?.();
        });
        // `new Promise(… load())` starts the load synchronously and turns a
        // synchronous throw into a rejection.
        inflight = Promise.race([new Promise((resolve) => resolve(load())), timeout])
            .then(
                (v) => {
                    if (isUsable(v)) {
                        value = v;
                        hasValue = true;
                        fetchedAt = now();
                        failedAt = 0;
                    } else {
                        failedAt = now();
                    }
                    return hasValue ? value : undefined;
                },
                (e) => {
                    failedAt = now();
                    throw e;
                },
            )
            .finally(() => {
                clearTimeout(timer);
                inflight = null;
            });
        return inflight;
    }

    function needsRefresh() {
        if (inflight) return false;
        const t = now();
        if (failedAt && Math.max(0, t - failedAt) < retryAfterFailureMs) return false;
        return !hasValue || Math.max(0, t - fetchedAt) >= ttlMs;
    }

    /** Current value (undefined when cold); kicks a background refresh if stale. */
    function peek() {
        if (needsRefresh()) refresh().catch(() => {});
        return hasValue ? value : undefined;
    }

    return {
        peek,
        /** Like peek(), but a cold cache waits up to `waitMs` for the first load. */
        async get({ waitMs = 0 } = {}) {
            const v = peek();
            if (hasValue || !inflight || waitMs <= 0) return v;
            let timer;
            const giveUp = new Promise((resolve) => {
                timer = setTimeout(resolve, waitMs);
                timer.unref?.();
            });
            try {
                return await Promise.race([inflight.catch(() => undefined), giveUp]);
            } finally {
                clearTimeout(timer);
            }
        },
        /** Last good value without triggering a refresh. */
        current() {
            return hasValue ? value : undefined;
        },
        /** Seed from a caller that already fetched the same data. */
        set(v) {
            value = v;
            hasValue = true;
            fetchedAt = now();
            failedAt = 0;
        },
        /** Mark stale (and forget a failure) — the next read revalidates. */
        invalidate() {
            fetchedAt = 0;
            failedAt = 0;
        },
        refresh,
    };
}
