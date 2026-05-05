// Tiny hash router so the dashboard supports deep-linking + browser back.
//
// Patterns:
//   #/viewer
//   #/viewer/<groupId>            ← open viewer scoped to one group
//   #/viewer/<groupId>/<fileId>   ← open the modal viewer at one file
//   #/groups                      ← Groups page
//   #/groups/<groupId>            ← Groups page + open settings sheet
//   #/engine
//   #/settings                    ← Settings page
//   #/settings/<section>          ← Settings page + scroll to a section
//   #/stories
//   #/account/add
//
// Patterns are registered with route(pattern, handler). Path segments
// prefixed with ":" become named params (e.g. "/viewer/:groupId/:fileId").
// The handler receives a single object: { params, hash, query, raw }.

const routes = []; // { regex, paramNames, handler }
let beforeNav = null;
let activeRoute = null;
let listening = false;

// Routes that require admin role. Guests browsing one of these get
// re-routed to /viewer instead of running the handler. The guest
// contract is intentionally narrow: browse downloaded media + adjust
// their own appearance/video-player prefs + sign out. Anything that
// surfaces operational state (Groups picker, Backfill jobs, Queue,
// Engine controls) is admin-only on both the front and the back.
const ADMIN_ROUTE_PREFIXES = [
    '/groups', '/backfill', '/queue', '/engine', '/stories', '/account/add',
    '/maintenance',
];
// Settings sub-routes guests CAN reach. Everything else under /settings
// (system, accounts, downloads, network) bounces.
const GUEST_SETTINGS_SECTIONS = new Set(['video-player', 'appearance']);

function isAdminRoute(path) {
    if (ADMIN_ROUTE_PREFIXES.some(p => path === p || path.startsWith(p + '/'))) return true;
    if (path.startsWith('/settings/')) {
        const section = path.slice('/settings/'.length).split('/')[0];
        return !GUEST_SETTINGS_SECTIONS.has(section);
    }
    // /settings root: allowed for guest (the chip-nav itself only shows
    // the sections they can use; the page renders fine without admin cards).
    return false;
}

function getCurrentRole() {
    // Lazy lookup so the router module doesn't need to import store.js
    // (which would create a cycle).
    try {
        return (typeof window !== 'undefined' && window.__tgdlRole) || null;
    } catch { return null; }
}

function compile(pattern) {
    const paramNames = [];
    const re = pattern
        .replace(/[\\^$.*+?()[\]{}|]/g, (m) => (m === '/' ? m : `\\${m}`))
        .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
            paramNames.push(name);
            return '([^/]+)';
        });
    return { regex: new RegExp(`^${re}$`), paramNames };
}

export function route(pattern, handler) {
    const { regex, paramNames } = compile(pattern);
    routes.push({ pattern, regex, paramNames, handler });
}

export function setBeforeNavigate(fn) { beforeNav = fn; }

function parseHash(raw) {
    let h = raw || window.location.hash || '';
    if (h.startsWith('#')) h = h.slice(1);
    const qIdx = h.indexOf('?');
    const path = qIdx >= 0 ? h.slice(0, qIdx) : h;
    const query = qIdx >= 0 ? Object.fromEntries(new URLSearchParams(h.slice(qIdx + 1))) : {};
    return { path: path || '/viewer', query };
}

function dispatch() {
    const { path, query } = parseHash();

    // Guest sessions are bounced from admin-only routes to the viewer.
    // Done here (before route lookup) so deep-links pasted into the URL
    // bar also redirect, not just nav clicks.
    if (getCurrentRole() === 'guest' && isAdminRoute(path)) {
        if (path !== '/viewer') return navigate('#/viewer', { replace: true });
    }

    for (const r of routes) {
        const m = r.regex.exec(path);
        if (!m) continue;
        const params = {};
        r.paramNames.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
        const next = { pattern: r.pattern, path, params, query };
        if (beforeNav && beforeNav(activeRoute, next) === false) return;
        activeRoute = next;
        try { r.handler(next); }
        catch (e) { console.error('router handler', e); }
        return;
    }
    // No match → fall back to /viewer
    if (path !== '/viewer') navigate('#/viewer');
}

export function navigate(hash, { replace = false } = {}) {
    const target = hash.startsWith('#') ? hash : `#${hash}`;
    if (window.location.hash === target) {
        // Force a re-dispatch even when the hash didn't change (e.g. clicking
        // the current section link) so the handler can re-render.
        dispatch();
        return;
    }
    if (replace) history.replaceState(null, '', target);
    else history.pushState(null, '', target);
    dispatch();
}

export function start() {
    if (listening) return;
    listening = true;
    window.addEventListener('hashchange', dispatch);
    window.addEventListener('popstate', dispatch);
    // Kick off the initial render once routes are registered.
    queueMicrotask(dispatch);
}

export function getActiveRoute() { return activeRoute; }
