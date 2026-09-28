// Back button (Android system Back, browser Back, iOS edge swipe in a PWA)
// closes the topmost overlay — media viewer, bottom sheet, Group Settings
// modal — instead of leaving the page underneath.
//
// Each open overlay pushes one history entry with the SAME URL and a
// `tgdlOverlayDepth` marker. Going Back pops that entry: the popstate
// handler closes every overlay deeper than the depth now current. Closing
// an overlay from the UI (✕, Esc, backdrop, swipe) pops its own entry with
// history.back() so the stack never accumulates dead entries. The router
// ignores popstate events that don't change the hash (see router.js).
//
// Failure mode is deliberately benign: if the entries ever get out of
// step (e.g. a hash navigation while an overlay was open), the worst case
// is one Back press that does nothing visible — never a trap.

const stack = []; // [{ token, close }]
let nextToken = 1;
let pendingBacks = 0; // history.back() calls whose popstate we must swallow
const deferred = []; // pushes requested while a back() was in flight
const idleCallbacks = []; // navigations waiting for a pending back() to land

function flushPending() {
    // Navigations first (they create the next entry), then overlay pushes.
    while (idleCallbacks.length) {
        try {
            idleCallbacks.shift()();
        } catch (e) {
            console.error('deferred navigation', e);
        }
    }
    while (deferred.length) doPush(deferred.shift());
}

function currentDepth() {
    const d = history.state?.tgdlOverlayDepth;
    return Number.isInteger(d) && d > 0 ? d : 0;
}

function doPush(entry) {
    try {
        const state = { ...(history.state || {}), tgdlOverlayDepth: stack.length + 1 };
        history.pushState(state, '', location.href);
        stack.push(entry);
    } catch {
        /* history unavailable (sandboxed iframe) — overlay still works, just no Back */
    }
}

/**
 * Register an open overlay. `close()` is called when the user navigates
 * Back past it. Returns a token for popOverlay().
 */
export function pushOverlay(close) {
    const entry = { token: nextToken++, close };
    // A pending back() hasn't landed yet — pushing now would put the new
    // entry where that back() is about to traverse from. Wait for it.
    if (pendingBacks > 0) deferred.push(entry);
    else doPush(entry);
    return entry.token;
}

/**
 * The overlay `token` closed from the UI. Drops it from the stack and,
 * if its history entry is the current one, steps back over it.
 */
export function popOverlay(token) {
    const d = deferred.findIndex((e) => e.token === token);
    if (d >= 0) {
        deferred.splice(d, 1);
        return;
    }
    const i = stack.findIndex((e) => e.token === token);
    if (i < 0) return; // already closed via Back
    const wasTop = i === stack.length - 1;
    const depthOfEntry = i + 1;
    stack.splice(i, 1);
    if (wasTop && currentDepth() === depthOfEntry) {
        pendingBacks++;
        history.back();
        // Safety net: if the traversal never reports back (page hidden,
        // browser quirk), stop swallowing popstate after a second.
        setTimeout(() => {
            if (pendingBacks > 0) {
                pendingBacks = 0;
                flushPending();
            }
        }, 1000);
    }
}

/**
 * Run `fn` once no history.back() issued by popOverlay() is in flight.
 * A navigation made while one is pending would be undone by it (back()
 * traverses from whatever entry is current when it runs), so callers that
 * close an overlay and then navigate go through here — router.navigate()
 * does it for every in-app navigation.
 */
export function whenHistoryIdle(fn) {
    if (pendingBacks === 0) {
        fn();
        return;
    }
    idleCallbacks.push(fn);
}

/** True while at least one overlay holds a history entry. */
export function hasOverlay() {
    return stack.length > 0 || deferred.length > 0;
}

function onPopState() {
    if (pendingBacks > 0) {
        pendingBacks--;
        if (pendingBacks === 0) flushPending();
        return;
    }
    // Close every overlay whose entry is no longer in the active history
    // position (normally just the top one).
    const depth = currentDepth();
    while (stack.length > depth) {
        const entry = stack.pop();
        try {
            entry.close();
        } catch (e) {
            console.error('overlay close', e);
        }
    }
}

// Guarded so the module can be imported outside a browser (unit tests load
// sheet.js / shortcuts.js with a stubbed window).
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('popstate', onPopState);
}
