/**
 * Dashboard WebSocket fan-out with storm control.
 *
 * The engine emits some events far faster than any phone needs them:
 * `download_progress` per gramJS chunk (dozens per second per job),
 * `history_progress` per scanned message, `queue_length` +
 * `queue_changed{op:'enqueue'}` per enqueued job, and `file_deleted` per
 * row from the rescue sweeper / disk rotator. Previously each one was
 * JSON-encoded and written to every socket immediately, and a phone whose
 * TCP connection went half-open kept buffering megabytes until the kernel
 * gave up (~15 min).
 *
 *   - Coalescing: messages with a coalesce key are held for `windowMs`;
 *     a newer message with the same key replaces the pending one (latest
 *     wins — every progress event carries the full state). Message shapes
 *     are unchanged, so the SPA needs no changes.
 *   - Ordering: before an uncoalesced message goes out, the pending
 *     messages it depends on are flushed first (e.g. a job's last progress
 *     before its `download_complete`, everything before `monitor_state`).
 *   - Burst collapse: more than `threshold` `file_deleted` in one window
 *     collapse into one `bulk_delete`, which makes the SPA refresh the
 *     gallery + stats once instead of refetching per row.
 *   - Backpressure: a client with more than `maxBufferedBytes` queued is
 *     skipped; the heartbeat terminates it if it is still backed up on the
 *     next tick.
 *   - Heartbeat: every tick, clients that didn't answer the previous ping
 *     are terminated and the rest are pinged (browsers pong automatically).
 */

export const WS_MAX_BUFFERED_BYTES = 1024 * 1024;
export const WS_COALESCE_WINDOW_MS = 500; // ≤ 2 updates/s per key
export const WS_HEARTBEAT_MS = 30_000;

const OPEN = 1;

/** Latest-wins key for high-rate message types; null = send immediately. */
export function defaultCoalesceKey(msg) {
    switch (msg?.type) {
        case 'download_progress':
            return `download_progress:${msg.payload?.key ?? ''}`;
        case 'history_progress':
            return `history_progress:${msg.jobId ?? ''}`;
        case 'queue_length':
            return 'queue_length';
        case 'queue_changed':
            // The SPA only re-renders on enqueue (queued rows come from the
            // snapshot), so one per window is equivalent to one per job.
            return msg.payload?.op === 'enqueue' ? 'queue_changed:enqueue' : null;
        default:
            return null;
    }
}

/** Pending keys that must be delivered before `msg`; '*' means all. */
export function defaultFlushBefore(msg) {
    switch (msg?.type) {
        case 'download_start':
        case 'download_complete':
        case 'download_error': {
            const key = msg.payload?.key ?? msg.payload?.job?.key;
            return key != null ? [`download_progress:${key}`] : [];
        }
        case 'history_done':
        case 'history_error':
        case 'history_cancelled':
            return [`history_progress:${msg.jobId ?? ''}`];
        case 'queue_changed':
            return ['queue_changed:enqueue', 'queue_length'];
        case 'monitor_state':
            // Stopping drops active rows client-side; a late progress
            // frame would resurrect them.
            return ['*'];
        default:
            return [];
    }
}

export const DEFAULT_COLLAPSE = {
    file_deleted: {
        threshold: 25,
        into: (count) => ({ type: 'bulk_delete', count, coalesced: true }),
    },
};

/**
 * @param {object} opts
 * @param {() => Iterable<import('ws').WebSocket>} opts.getClients
 * @param {(ws: import('ws').WebSocket) => void} [opts.onTerminate]  drop from the client set
 */
export function createWsBroadcaster({
    getClients,
    onTerminate = () => {},
    windowMs = WS_COALESCE_WINDOW_MS,
    maxBufferedBytes = WS_MAX_BUFFERED_BYTES,
    heartbeatMs = WS_HEARTBEAT_MS,
    coalesceKey = defaultCoalesceKey,
    flushBefore = defaultFlushBefore,
    collapse = DEFAULT_COLLAPSE,
}) {
    // key → message (or { __collapse: type, count }). Map keeps first-seen
    // order, so coalesced messages go out in the order they started.
    const pending = new Map();
    const collapseSeen = new Map(); // type → count this window
    let seq = 0;
    let timer = null;
    let heartbeatTimer = null;
    // Per-socket liveness without monkey-patching the ws objects.
    const liveness = new WeakMap(); // ws → { alive, stalledTicks }
    const counters = { sent: 0, skippedBackpressure: 0, terminated: 0, coalesced: 0 };

    function sendNow(msg) {
        const text = JSON.stringify(msg);
        for (const ws of Array.from(getClients())) {
            if (ws.readyState !== OPEN) continue;
            if (ws.bufferedAmount > maxBufferedBytes) {
                counters.skippedBackpressure += 1;
                continue;
            }
            try {
                ws.send(text);
                counters.sent += 1;
            } catch {
                /* socket died between the checks — close handler cleans up */
            }
        }
    }

    function emitPending(entry) {
        if (entry?.__collapse) {
            sendNow(collapse[entry.__collapse].into(entry.count));
        } else {
            sendNow(entry);
        }
    }

    function flush() {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        const entries = Array.from(pending.values());
        pending.clear();
        collapseSeen.clear();
        for (const entry of entries) emitPending(entry);
    }

    // Deliver the given pending keys now, in the order they were queued.
    function flushKeys(keys) {
        if (keys.includes('*')) return flush();
        const wanted = keys.filter((k) => pending.has(k));
        if (!wanted.length) return;
        const due = [];
        for (const [k, entry] of pending) if (wanted.includes(k)) due.push([k, entry]);
        for (const [k, entry] of due) {
            pending.delete(k);
            emitPending(entry);
        }
    }

    function schedule() {
        if (timer) return;
        timer = setTimeout(flush, windowMs);
        timer.unref?.();
    }

    function hold(msg) {
        const rule = collapse[msg.type];
        if (rule) {
            const n = (collapseSeen.get(msg.type) || 0) + 1;
            collapseSeen.set(msg.type, n);
            const bucket = `collapse:${msg.type}`;
            if (n > rule.threshold) {
                if (!pending.has(bucket)) {
                    // Crossed the threshold: fold the individually-held
                    // messages into one bucket at the first one's position.
                    const kept = [];
                    for (const [k, v] of pending) kept.push([k, v]);
                    pending.clear();
                    let placed = false;
                    for (const [k, v] of kept) {
                        if (v?.type === msg.type) {
                            if (!placed) {
                                pending.set(bucket, { __collapse: msg.type, count: 0 });
                                placed = true;
                            }
                            continue;
                        }
                        pending.set(k, v);
                    }
                    if (!placed) pending.set(bucket, { __collapse: msg.type, count: 0 });
                }
                pending.get(bucket).count = n;
            } else {
                seq += 1;
                pending.set(`${msg.type}#${seq}`, msg);
            }
            schedule();
            return true;
        }
        const key = coalesceKey(msg);
        if (key == null) return false;
        if (pending.has(key)) counters.coalesced += 1;
        pending.set(key, msg);
        schedule();
        return true;
    }

    function broadcast(msg) {
        if (!msg || typeof msg !== 'object') return;
        if (hold(msg)) return;
        if (pending.size) flushKeys(flushBefore(msg));
        sendNow(msg);
    }

    function attach(ws) {
        liveness.set(ws, { alive: true, stalledTicks: 0 });
        ws.on('pong', () => {
            const s = liveness.get(ws);
            if (s) s.alive = true;
        });
    }

    function terminate(ws) {
        counters.terminated += 1;
        try {
            ws.terminate();
        } catch {}
        onTerminate(ws);
    }

    function heartbeat() {
        for (const ws of Array.from(getClients())) {
            if (ws.readyState !== OPEN) continue;
            let s = liveness.get(ws);
            if (!s) {
                s = { alive: true, stalledTicks: 0 };
                liveness.set(ws, s);
            }
            // No pong since the last ping → half-open (phone went to sleep,
            // network switched). Kill it instead of buffering forever.
            if (!s.alive) {
                terminate(ws);
                continue;
            }
            if (ws.bufferedAmount > maxBufferedBytes) {
                // Backed up at two consecutive ticks — it's not draining.
                if (s.stalledTicks >= 1) {
                    terminate(ws);
                    continue;
                }
                s.stalledTicks += 1;
            } else {
                s.stalledTicks = 0;
            }
            s.alive = false;
            try {
                ws.ping();
            } catch {
                terminate(ws);
            }
        }
    }

    return {
        broadcast,
        flush,
        attach,
        heartbeat,
        startHeartbeat() {
            if (heartbeatTimer) return;
            heartbeatTimer = setInterval(heartbeat, heartbeatMs);
            heartbeatTimer.unref?.();
        },
        stop() {
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            heartbeatTimer = null;
            flush();
        },
        pendingCount: () => pending.size,
        stats: () => ({ ...counters }),
    };
}
