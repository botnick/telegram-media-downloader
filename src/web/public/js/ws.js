// Tiny WebSocket client with auto-reconnect.
//
// Subscribers register via on(type, handler); the handler receives the
// message payload. Handlers for the special type '*' get every message.
//
// The connection authenticates implicitly via the session cookie sent on
// the upgrade request — same gate as REST.

const handlers = new Map(); // type → Set<fn>
let socket = null;
let backoff = 1000;
let alive = false;
let attemptCount = 0;
const MAX_ATTEMPTS_BEFORE_PAUSE = 12;   // ~6 min of capped 30 s backoff = enough to notice

function dispatch(msg) {
    const set = handlers.get(msg.type);
    if (set) for (const fn of set) try { fn(msg); } catch (e) { console.error('ws handler', e); }
    const all = handlers.get('*');
    if (all) for (const fn of all) try { fn(msg); } catch {}
}

function open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}`;
    try {
        socket = new WebSocket(url);
    } catch (e) {
        scheduleReconnect();
        return;
    }
    socket.addEventListener('open', () => {
        alive = true;
        backoff = 1000;
        attemptCount = 0;
        dispatch({ type: '__ws_open' });
    });
    socket.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg && typeof msg === 'object' && msg.type) dispatch(msg);
    });
    socket.addEventListener('close', () => {
        alive = false;
        dispatch({ type: '__ws_close' });
        scheduleReconnect();
    });
    socket.addEventListener('error', () => {
        try { socket.close(); } catch {}
    });
}

function scheduleReconnect() {
    if (document.hidden) {
        // Don't churn while tab is in the background.
        document.addEventListener('visibilitychange', oneShot, { once: true });
        return;
    }
    attemptCount++;
    // After several failed attempts, pause auto-reconnect and surface a
    // pseudo-event the SPA can render as a "Connection lost — click to
    // retry" banner. Without this, a server-down outage logs the user
    // into an infinite quiet retry loop with no UI feedback.
    if (attemptCount >= MAX_ATTEMPTS_BEFORE_PAUSE) {
        dispatch({ type: '__ws_giveup', attempts: attemptCount });
        return;
    }
    setTimeout(open, backoff);
    backoff = Math.min(backoff * 2, 30000);
}
function oneShot() { open(); }

export const ws = {
    connect() { if (!socket || socket.readyState >= 2) open(); },
    /** Manual retry after we paused on too-many-attempts. */
    retry() {
        attemptCount = 0;
        backoff = 1000;
        open();
    },
    on(type, fn) {
        if (!handlers.has(type)) handlers.set(type, new Set());
        handlers.get(type).add(fn);
        return () => handlers.get(type)?.delete(fn);
    },
    off(type, fn) { handlers.get(type)?.delete(fn); },
    isConnected() { return alive; },
};
