// Coverage checker for the contract suite. Starts no server.
//
//  1. tests/contract/inventory.json matches the live sources
//     (npm run contract:inventory regenerates it);
//  2. tests/contract/fixtures/schema.sql matches what src/core/db.js creates
//     (npm run contract:schema);
//  3. every route / WS event in the inventory is exercised by at least one
//     golden snapshot entry, or carries a `skip` reason — and no entry is
//     both (a stale skip hides nothing but misleads the reader);
//  4. snapshots only reference routes and events the inventory knows.

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, STATIC_ROUTES } from './lib/inventory.js';
import { loadAllSnapshots, UPDATE } from './lib/snapshot.js';

const INV_PATH = path.join(import.meta.dirname, 'inventory.json');
const inventory = JSON.parse(fs.readFileSync(INV_PATH, 'utf8'));
const HAVE_NODE_SOURCES = fs.existsSync(path.join(REPO_ROOT, 'src', 'web', 'server.js'));

function coverage() {
    const routes = new Map();
    const events = new Map();
    const clusterSent = new Set(); // types we pushed INTO /ws/cluster
    const clusterReceived = new Set(); // types our fake peer received
    const unknownRoutes = [];
    for (const { file, data } of loadAllSnapshots()) {
        for (const [label, e] of Object.entries(data.entries || {})) {
            if (e.route) {
                if (!routes.has(e.route)) routes.set(e.route, []);
                routes.get(e.route).push(`${file} › ${label}`);
            }
            if (e.ws === 'cluster') {
                for (const t of e.sent || []) clusterSent.add(t);
                for (const ev of e.received || []) if (ev?.type) clusterReceived.add(ev.type);
            }
            for (const ev of e.events || []) {
                if (!ev?.type) continue;
                if (!events.has(ev.type)) events.set(ev.type, []);
                events.get(ev.type).push(`${file} › ${label}`);
            }
        }
    }
    const known = new Set(inventory.routes.map((r) => r.key));
    for (const k of routes.keys()) if (!known.has(k)) unknownRoutes.push(k);
    return { routes, events, clusterSent, clusterReceived, unknownRoutes };
}

describe('contract inventory', () => {
    it.skipIf(!HAVE_NODE_SOURCES)(
        'inventory.json matches src/ (npm run contract:inventory)',
        async () => {
            const { mergedInventory, serialize } = await import(
                pathToFileURL(path.join(REPO_ROOT, 'scripts', 'contract-inventory.mjs')).href
            );
            const fresh = mergedInventory();
            expect(fresh.unresolved, 'dynamic broadcast sites the parser cannot resolve').toEqual(
                [],
            );
            const keys = (inv) => ({
                routes: inv.routes.map((r) => r.key),
                ws: inv.wsEvents.map((e) => e.type),
                cluster: inv.clusterWs.events.map((e) => e.key),
            });
            expect(keys(inventory)).toEqual(keys(fresh));
            expect(fs.readFileSync(INV_PATH, 'utf8').replace(/\r\n/g, '\n')).toBe(serialize(fresh));
        },
    );

    it.skipIf(!HAVE_NODE_SOURCES)(
        'fixtures/schema.sql matches src/core/db.js (npm run contract:schema)',
        async () => {
            const { dumpNodeSchema } = await import(
                pathToFileURL(path.join(REPO_ROOT, 'scripts', 'contract-schema.mjs')).href
            );
            const frozen = fs
                .readFileSync(path.join(import.meta.dirname, 'fixtures', 'schema.sql'), 'utf8')
                .replace(/\r\n/g, '\n');
            expect(frozen).toBe(dumpNodeSchema());
        },
        60_000,
    );

    it.skipIf(!HAVE_NODE_SOURCES)('static SPA entry points still exist', () => {
        for (const r of STATIC_ROUTES) {
            if (!r.path.endsWith('.html')) continue;
            expect(fs.existsSync(path.join(REPO_ROOT, 'src', 'web', 'public', r.path))).toBe(true);
        }
    });

    it('every skip carries a reason', () => {
        const bad = [
            ...inventory.routes.filter((r) => 'skip' in r && !(String(r.skip).length >= 10)),
            ...inventory.wsEvents.filter((r) => 'skip' in r && !(String(r.skip).length >= 10)),
            ...inventory.clusterWs.events.filter(
                (r) => 'skip' in r && !(String(r.skip).length >= 10),
            ),
        ];
        expect(bad).toEqual([]);
    });
});

describe.skipIf(UPDATE)('contract coverage', () => {
    const cov = coverage();

    it('snapshots only reference inventoried routes', () => {
        expect(cov.unknownRoutes).toEqual([]);
    });

    it('every route is covered or skipped with a reason', () => {
        const uncovered = inventory.routes.filter((r) => !cov.routes.has(r.key) && !r.skip);
        const staleSkips = inventory.routes.filter((r) => cov.routes.has(r.key) && r.skip);
        expect(
            uncovered.map((r) => r.key),
            'routes with no golden exchange and no skip',
        ).toEqual([]);
        expect(
            staleSkips.map((r) => r.key),
            'skipped routes that ARE covered — drop the skip',
        ).toEqual([]);
    });

    it('every WS event type is covered or skipped with a reason', () => {
        const types = new Set(inventory.wsEvents.map((e) => e.type));
        const uncovered = inventory.wsEvents.filter((e) => !cov.events.has(e.type) && !e.skip);
        const staleSkips = inventory.wsEvents.filter((e) => cov.events.has(e.type) && e.skip);
        const unknown = [...cov.events.keys()].filter((t) => !types.has(t));
        expect(
            uncovered.map((e) => e.type),
            'WS types never recorded and not skipped',
        ).toEqual([]);
        expect(
            staleSkips.map((e) => e.type),
            'skipped WS types that ARE recorded',
        ).toEqual([]);
        expect(unknown, 'recorded WS types the inventory does not know (parser gap)').toEqual([]);
    });

    it('every /ws/cluster message type is covered or skipped with a reason', () => {
        const isCovered = (e) =>
            e.direction === 'accept'
                ? cov.clusterSent.has(e.type)
                : cov.clusterReceived.has(e.type);
        const uncovered = inventory.clusterWs.events.filter((e) => !isCovered(e) && !e.skip);
        const staleSkips = inventory.clusterWs.events.filter((e) => isCovered(e) && e.skip);
        expect(uncovered.map((e) => e.key)).toEqual([]);
        expect(staleSkips.map((e) => e.key)).toEqual([]);
    });

    it('summary', () => {
        const r = inventory.routes;
        const w = inventory.wsEvents;
        const c = inventory.clusterWs.events;
        const covered = (list, pred) => list.filter(pred).length;
        const summary = {
            routes: {
                total: r.length,
                covered: covered(r, (x) => cov.routes.has(x.key)),
                skipped: covered(r, (x) => x.skip),
            },
            wsEvents: {
                total: w.length,
                covered: covered(w, (x) => cov.events.has(x.type)),
                skipped: covered(w, (x) => x.skip),
            },
            clusterWs: {
                total: c.length,
                covered: covered(c, (x) =>
                    x.direction === 'accept'
                        ? cov.clusterSent.has(x.type)
                        : cov.clusterReceived.has(x.type),
                ),
                skipped: covered(c, (x) => x.skip),
            },
        };
        console.log(`[contract coverage] ${JSON.stringify(summary)}`);
        expect(summary.routes.total).toBeGreaterThan(0);
    });
});
