// Static inventory of the public surface the contract suite has to cover:
// every HTTP route registered in src/web/server.js and every WebSocket
// message type the backend can broadcast (dashboard socket + the
// /ws/cluster peer channel).
//
// Pure source parsing — nothing is imported from the app, so the same
// inventory keeps working while the backend moves to Go (the parser only
// needs the Node sources to exist; once they're gone the committed
// inventory.json is the frozen list).
//
// Used by scripts/contract-inventory.js (writes tests/contract/inventory.json)
// and by tests/contract/inventory.contract.test.js (checks the committed file
// against the live sources and against the recorded snapshots).

import fs from 'fs';
import path from 'path';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
export const SERVER_JS = path.join(REPO_ROOT, 'src', 'web', 'server.js');

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// `app.use('<path>', …)` mounts that are middleware only (they always call
// next()) — not endpoints of their own. A new mount not listed here is
// treated as an endpoint and has to be covered.
export const MIDDLEWARE_MOUNTS = {
    '/api': 'guest allow-list gate (guestGate) in front of every /api route',
    '/api/cluster': 'lazy start of the cluster sync / discovery / failover engines',
};

// Endpoints served by middleware without a path literal the parser could
// see: the cache-busting HTML/JS rewriter and express.static over
// src/web/public (which stays as it is through the Go migration). Derived
// from the public dir: `/` plus every top-level file, and `/<dir>/*` for
// every top-level directory. Files that also have an explicit app.get()
// route (sw.js, manifest.webmanifest) are listed once, as routes.
export const PUBLIC_DIR = path.join(REPO_ROOT, 'src', 'web', 'public');
const EXPLICIT_PUBLIC = new Set(['sw.js', 'manifest.webmanifest']);

export function staticRoutes(publicDir = PUBLIC_DIR) {
    const out = [{ method: 'GET', path: '/', note: 'index.html via the ?v= cache-bust rewriter' }];
    if (!fs.existsSync(publicDir)) return out;
    const entries = fs.readdirSync(publicDir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
        if (EXPLICIT_PUBLIC.has(e.name) || e.name.startsWith('.')) continue;
        out.push(
            e.isDirectory()
                ? { method: 'GET', path: `/${e.name}/*`, note: 'express.static(public)' }
                : { method: 'GET', path: `/${e.name}`, note: 'public file' },
        );
    }
    return out;
}
export const STATIC_ROUTES = staticRoutes();

function stripComments(src) {
    // Good enough for this file: drop // line comments and /* */ blocks
    // outside of strings. Keeps line numbers (newlines survive).
    let out = '';
    let i = 0;
    let quote = null;
    while (i < src.length) {
        const c = src[i];
        const n = src[i + 1];
        if (quote) {
            out += c;
            if (c === '\\') {
                out += n ?? '';
                i += 2;
                continue;
            }
            if (c === quote) quote = null;
            i++;
            continue;
        }
        if (c === "'" || c === '"' || c === '`') {
            quote = c;
            out += c;
            i++;
            continue;
        }
        if (c === '/' && n === '/') {
            while (i < src.length && src[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && n === '*') {
            i += 2;
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
                if (src[i] === '\n') out += '\n';
                i++;
            }
            i += 2;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

function lineOf(src, idx) {
    let n = 1;
    for (let i = 0; i < idx; i++) if (src.charCodeAt(i) === 10) n++;
    return n;
}

function parseStringList(text) {
    const out = [];
    const re = /(['"`])((?:\\.|(?!\1).)*)\1/g;
    let m;
    while ((m = re.exec(text))) out.push(m[2]);
    return out;
}

/**
 * Every route registered on the Express app, in registration order.
 * @returns {{ method: string, path: string, key: string, kind: string, line: number }[]}
 */
export function parseRoutes(src = fs.readFileSync(SERVER_JS, 'utf8')) {
    const code = stripComments(src);
    const routes = [];
    const re =
        /\bapp\.(get|post|put|patch|delete|all|use)\(\s*(\[[^\]]*\]|'[^']*'|"[^"]*"|`[^`]*`)/g;
    let m;
    while ((m = re.exec(code))) {
        const verb = m[1].toUpperCase();
        const paths = m[2].startsWith('[') ? parseStringList(m[2]) : parseStringList(m[2]);
        const line = lineOf(code, m.index);
        for (const p of paths) {
            if (verb === 'USE') {
                if (MIDDLEWARE_MOUNTS[p]) continue;
                routes.push({ method: 'GET', path: `${p}/*`, kind: 'mount', line });
            } else {
                routes.push({ method: verb, path: p, kind: 'route', line });
            }
        }
    }
    for (const s of staticRoutes()) routes.push({ ...s, kind: 'static', line: 0 });
    for (const r of routes) r.key = `${r.method} ${r.path}`;
    return routes;
}

/** Every `app.use('<path>', …)` mount — lets the checker spot new ones. */
export function parseMounts(src = fs.readFileSync(SERVER_JS, 'utf8')) {
    const code = stripComments(src);
    const out = [];
    const re = /\bapp\.use\(\s*(['"`])([^'"`]+)\1/g;
    let m;
    while ((m = re.exec(code))) out.push(m[2]);
    return out;
}

// Express 4 path → RegExp (the subset server.js uses: `:param`,
// `:param(regex)`, trailing `*`).
export function routeRegExp(routePath) {
    let re = '';
    let i = 0;
    while (i < routePath.length) {
        const c = routePath[i];
        if (c === ':') {
            const m = /^:([A-Za-z_$][\w$]*)(\(([^)]*)\))?/.exec(routePath.slice(i));
            const custom = m[3];
            re += custom ? `(${custom === '*' ? '.*' : custom})` : '([^/]+?)';
            i += m[0].length;
            continue;
        }
        if (c === '*') {
            re += '(.*)';
            i++;
            continue;
        }
        re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
        i++;
    }
    return new RegExp(`^${re}/?$`, 'i');
}

function specificity(r) {
    // Static segments beat params beat wildcards — mirrors what the
    // handlers do in practice (`/api/downloads/:groupId` calls next() for
    // `search`, so the more literal route is the one that answers).
    const p = r.path;
    const params = (p.match(/:/g) || []).length;
    const stars = (p.match(/\*/g) || []).length;
    const literal = p.replace(/:[\w$]+(\([^)]*\))?/g, '').replace(/\*/g, '').length;
    return stars * 1000 + params * 100 - literal;
}

/**
 * Map a concrete request (method + path, no query) to the inventory key of
 * the route that serves it. HEAD maps to GET, like Express.
 */
export function createRouteMatcher(routes) {
    const compiled = routes.map((r) => ({ ...r, re: routeRegExp(r.path) }));
    return (method, urlPath) => {
        const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
        const hits = compiled.filter(
            (r) => (r.method === m || r.method === 'ALL') && r.re.test(urlPath),
        );
        if (!hits.length) return null;
        hits.sort((a, b) => specificity(a) - specificity(b) || a.line - b.line);
        return hits[0].key;
    };
}

// ---------------------------------------------------------------------------
// WebSocket events
// ---------------------------------------------------------------------------

function listJsFiles(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (p.includes(path.join('src', 'web', 'public'))) continue;
            out.push(...listJsFiles(p));
        } else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}

function balancedArg(code, openIdx) {
    // `openIdx` points at '('. Returns the text between the parens.
    let depth = 0;
    let quote = null;
    for (let i = openIdx; i < code.length; i++) {
        const c = code[i];
        if (quote) {
            if (c === '\\') {
                i++;
                continue;
            }
            if (c === quote) quote = null;
            continue;
        }
        if (c === "'" || c === '"' || c === '`') {
            quote = c;
            continue;
        }
        if (c === '(' || c === '{' || c === '[') depth++;
        else if (c === ')' || c === '}' || c === ']') {
            depth--;
            if (depth === 0) return code.slice(openIdx + 1, i);
        }
    }
    return '';
}

// Top-level `type:` of an object literal argument.
function topLevelType(arg) {
    const t = arg.trim();
    if (!t.startsWith('{')) return { dynamic: true, expr: t.slice(0, 60) };
    let depth = 0;
    let quote = null;
    for (let i = 0; i < t.length; i++) {
        const c = t[i];
        if (quote) {
            if (c === '\\') {
                i++;
                continue;
            }
            if (c === quote) quote = null;
            continue;
        }
        if (c === "'" || c === '"' || c === '`') {
            quote = c;
            continue;
        }
        if (c === '{' || c === '(' || c === '[') depth++;
        else if (c === '}' || c === ')' || c === ']') depth--;
        else if (depth === 1 && /[\s,{]/.test(t[i - 1] || '{') && t.startsWith('type', i)) {
            const m = /^type\s*:\s*/.exec(t.slice(i));
            if (!m) continue;
            const rest = t.slice(i + m[0].length);
            const lit = /^(['"])([^'"]+)\1/.exec(rest);
            if (lit) return { type: lit[2] };
            const tpl = /^`([^`]*)`/.exec(rest);
            if (tpl) return { dynamic: true, template: tpl[1] };
            const id = /^([A-Za-z_$][\w$.]*)/.exec(rest);
            return { dynamic: true, ident: id ? id[1] : rest.slice(0, 40) };
        }
    }
    return { none: true };
}

const BROADCAST_CALL =
    /(?<![\w$])((?:this\.|global\.)?(?:_?broadcast|_broadcastLocal|_safeBroadcast|__tgdlBroadcast|_broadcastFn|broadcastFn|_wsBroadcaster\.broadcast))\s*\(/g;

// Resolutions for call sites whose `type` is not a literal. Keyed by
// `<relative file>|<expression>`; the checker fails on any dynamic site
// that isn't listed here, so a new one can't slip past the inventory.
export const DYNAMIC_SITES = {
    // server.js history backfill terminal event (`const evt = cancelled ? … : …`)
    'src/web/server.js|evt': ['history_cancelled', 'history_done'],
    // job-tracker: `${prefix}_progress` / `${prefix}_done`, expanded below
    'src/core/job-tracker.js|${_prefix}_progress': ['@jobTracker:progress'],
    'src/core/job-tracker.js|${_prefix}_done': ['@jobTracker:done'],
    // ws-broadcaster.js: the single writer — forwards whatever it is given
    'src/web/lib/ws-broadcaster.js|data': [],
    // server.js broadcast(data) → _wsBroadcaster.broadcast(data)
    'src/web/server.js|data': [],
    // server.js cluster ws bridge `(m) => global.__tgdlBroadcast(m)` / broadcast(m)
    'src/web/server.js|m': [],
    // server.js runtime relay: each engine event under its own type — the
    // runtime.js `emit('event', { type })` sites, parsed below
    'src/web/server.js|runtimeEventMessage(e)': [],
    // core modules re-emitting a prepared payload (pass-through wrappers)
    'src/core/job-tracker.js|payload': [],
    'src/core/cluster/sweep.js|m': [],
    'src/core/cluster/sweep.js|payload': [],
    'src/core/cluster/ws-channel.js|msg': [],
    'src/core/ai/faces-spawn.js|payload': [],
};

/** createJobTracker({ kind, eventPrefix }) prefixes in server.js. */
export function parseJobTrackerPrefixes(root = REPO_ROOT) {
    const out = new Set();
    for (const file of listJsFiles(path.join(root, 'src'))) {
        const code = stripComments(fs.readFileSync(file, 'utf8'));
        const re = /createJobTracker\(\s*\{/g;
        let m;
        while ((m = re.exec(code))) {
            const body = balancedArg(code, m.index + m[0].length - 2);
            const kind = /\bkind\s*:\s*(['"`])([^'"`]+)\1/.exec(body);
            const prefix = /\beventPrefix\s*:\s*(['"`])([^'"`]+)\1/.exec(body);
            const name = prefix ? prefix[2] : kind ? kind[2] : null;
            if (name) out.add(name);
        }
    }
    return [...out].sort();
}

function resolveIdent(code, callIdx, ident) {
    // Look back ~40 lines for `<ident> = <expr>;` and take its string literals.
    const start = Math.max(0, code.lastIndexOf('\n', callIdx - 1) - 3000);
    const window = code.slice(start, callIdx);
    const re = new RegExp(
        `(?:const|let|var)\\s+${ident.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}\\s*=([^;]+);`,
        'g',
    );
    let m;
    let last = null;
    while ((m = re.exec(window))) last = m[1];
    if (!last) return null;
    const lits = parseStringList(last);
    return lits.length ? lits : null;
}

/**
 * Every WS message type the backend can broadcast to dashboard clients.
 * @returns {{ events: Map<string, string[]>, unresolved: object[] }}
 *   events: type → source locations ("file:line")
 */
export function parseWsEvents(root = REPO_ROOT) {
    const events = new Map();
    const unresolved = [];
    const add = (type, loc) => {
        if (!events.has(type)) events.set(type, []);
        events.get(type).push(loc);
    };
    const files = listJsFiles(path.join(root, 'src'));
    const prefixes = parseJobTrackerPrefixes(root);
    for (const file of files) {
        const rel = path.relative(root, file).split(path.sep).join('/');
        const code = stripComments(fs.readFileSync(file, 'utf8'));
        // Local aliases of the global bridge: `const fn = globalThis.__tgdlBroadcast`.
        const aliases = [
            ...code.matchAll(
                /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:globalThis|global)\.__tgdlBroadcast\b/g,
            ),
        ].map((a) => a[1]);
        const callRe = aliases.length
            ? new RegExp(`(?<![\\w$.])(${aliases.join('|')})\\s*\\(|${BROADCAST_CALL.source}`, 'g')
            : BROADCAST_CALL;
        callRe.lastIndex = 0;
        let m;
        while ((m = callRe.exec(code))) {
            // Skip the definitions themselves (`function broadcast(data) {`).
            const before = code.slice(Math.max(0, m.index - 12), m.index);
            if (/function\s*$/.test(before)) continue;
            const open = m.index + m[0].length - 1;
            const arg = balancedArg(code, open);
            // Method definitions `broadcast(msg) {` / arrow params.
            const after = code.slice(open + arg.length + 2, open + arg.length + 8);
            if (/^\s*\{/.test(after) && !/[{:'"`]/.test(arg)) continue;
            const loc = `${rel}:${lineOf(code, m.index)}`;
            const r = topLevelType(arg);
            if (r.type) {
                add(r.type, loc);
                continue;
            }
            if (r.none) {
                // Object literal without a `type` — not a WS message.
                continue;
            }
            const expr = r.template ?? r.ident ?? r.expr;
            const key = `${rel}|${expr}`;
            let resolved = DYNAMIC_SITES[key];
            if (!resolved && r.ident) resolved = resolveIdent(code, m.index, r.ident);
            if (!resolved) {
                unresolved.push({ loc, expr });
                continue;
            }
            for (const t of resolved) {
                if (t === '@jobTracker:progress') {
                    for (const p of prefixes) add(`${p}_progress`, loc);
                } else if (t === '@jobTracker:done') {
                    for (const p of prefixes) add(`${p}_done`, loc);
                } else add(t, loc);
            }
        }
    }
    // Messages written straight to the dashboard sockets (bypassing
    // broadcast(), e.g. the per-role `stats_update` push).
    for (const file of files) {
        const rel = path.relative(root, file).split(path.sep).join('/');
        if (!rel.startsWith('src/web/')) continue;
        const code = stripComments(fs.readFileSync(file, 'utf8'));
        const re = /JSON\.stringify\(\s*\{\s*type\s*:\s*'([^']+)'/g;
        let m;
        while ((m = re.exec(code))) add(m[1], `${rel}:${lineOf(code, m.index)}`);
    }
    // Engine events relayed by `runtime.on('event', e =>
    // broadcast(runtimeEventMessage(e)))`: each runtime event goes out
    // under its own name.
    const runtimeFile = path.join(root, 'src', 'core', 'runtime.js');
    if (fs.existsSync(runtimeFile)) {
        const code = stripComments(fs.readFileSync(runtimeFile, 'utf8'));
        const rel = 'src/core/runtime.js';
        const reEmit = /emit\(\s*'event'\s*,\s*\{\s*type\s*:\s*'([^']+)'/g;
        let m;
        while ((m = reEmit.exec(code))) add(m[1], `${rel}:${lineOf(code, m.index)}`);
        const reFwd = /\bfwd\(\s*'([^']+)'\s*\)/g;
        while ((m = reFwd.exec(code))) add(m[1], `${rel}:${lineOf(code, m.index)}`);
    }
    return { events, unresolved };
}

/**
 * /ws/cluster peer channel: message types this node sends to peers
 * (`broadcastClusterEvent('x', …)`) and the ones it accepts from them
 * (`case 'x':` in ws-channel.js's dispatcher).
 */
export function parseClusterWsEvents(root = REPO_ROOT) {
    const sent = new Map();
    const accepted = new Set();
    for (const file of listJsFiles(path.join(root, 'src'))) {
        const rel = path.relative(root, file).split(path.sep).join('/');
        const code = stripComments(fs.readFileSync(file, 'utf8'));
        const re = /broadcastClusterEvent\(\s*'([^']+)'/g;
        let m;
        while ((m = re.exec(code))) {
            if (!sent.has(m[1])) sent.set(m[1], []);
            sent.get(m[1]).push(`${rel}:${lineOf(code, m.index)}`);
        }
    }
    const chan = path.join(root, 'src', 'core', 'cluster', 'ws-channel.js');
    if (fs.existsSync(chan)) {
        const code = stripComments(fs.readFileSync(chan, 'utf8'));
        const sw = code.indexOf('switch (type)');
        if (sw >= 0) {
            const body = balancedArg(code, code.indexOf('{', sw));
            const re = /case\s+'([^']+)'\s*:/g;
            let m;
            while ((m = re.exec(body))) accepted.add(m[1]);
        }
    }
    return { sent, accepted: [...accepted].sort() };
}

/** Build the inventory object (without the hand-maintained skip notes). */
export function buildInventory(root = REPO_ROOT) {
    const routes = parseRoutes(fs.readFileSync(path.join(root, 'src', 'web', 'server.js'), 'utf8'));
    const seen = new Set();
    const routeList = [];
    for (const r of routes) {
        if (seen.has(r.key)) continue;
        seen.add(r.key);
        routeList.push({ key: r.key, kind: r.kind });
    }
    const { events, unresolved } = parseWsEvents(root);
    const cluster = parseClusterWsEvents(root);
    return {
        routes: routeList,
        wsEvents: [...events.keys()].sort().map((type) => ({
            type,
            sources: [...new Set(events.get(type).map((l) => l.replace(/:\d+$/, '')))].sort(),
        })),
        clusterWs: {
            sent: [...cluster.sent.keys()].sort(),
            accepted: cluster.accepted,
        },
        unresolved,
    };
}
