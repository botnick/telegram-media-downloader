// Single source of truth for /api/monitor/status.
//
// v2.3.24: switched from poll-with-WS-events to **WS-push only**.
// The server broadcasts `monitor_status_push` every 3 s with the full
// snapshot (server-side `_pushMonitorStatus()` in src/web/server.js).
// We do exactly one HTTP fetch on first subscribe to avoid a 3 s
// blank window before the first push arrives, then ride the WS for
// the rest of the session. On a WS reconnect we re-fetch to catch
// up on anything that happened during the disconnect.

import { api } from './api.js';
import { ws } from './ws.js';

let inFlight = false;
let latest = null;
const subscribers = new Set();

function notify() {
    for (const fn of subscribers) {
        try { fn(latest); } catch (e) { console.error('monitor-status subscriber', e); }
    }
}

async function refresh() {
    if (inFlight) return;
    inFlight = true;
    try {
        latest = await api.get('/api/monitor/status');
        notify();
    } catch {
        // Keep last snapshot — bootstrapping or transient network blip.
    } finally {
        inFlight = false;
    }
}

// Server pushes the snapshot every 3 s — apply it directly.
ws.on('monitor_status_push', (msg) => {
    if (!msg?.payload) return;
    latest = msg.payload;
    notify();
});
// On WS reconnect, fetch once to fill the gap between disconnect
// and the first new push.
ws.on('__ws_open', () => { if (subscribers.size > 0) refresh(); });

/**
 * Subscribe to monitor status updates. Returns an unsubscribe function.
 * The callback is invoked on every push; if a snapshot is already
 * cached, the callback fires synchronously with that snapshot before
 * returning.
 */
export function subscribe(fn) {
    subscribers.add(fn);
    if (latest) {
        try { fn(latest); } catch (e) { console.error('monitor-status subscriber', e); }
    } else {
        // First subscriber — fetch once so consumers aren't blank
        // until the next 3-second push arrives.
        refresh();
    }
    return () => { subscribers.delete(fn); };
}

/** Force an immediate refresh — used by handlers that mutate state. */
export function refreshNow() { refresh(); }

/** Latest cached snapshot, or null if none yet. */
export function getLatest() { return latest; }
