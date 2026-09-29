// Front-server parity: every request in tests/helpers/front-parity.js,
// sent to the app as it runs now (tgdl-core front server on PORT, Node
// behind it), must get the response the Node-only server gave before
// (tests/fixtures/front-parity.json, captured from v2.28): same status,
// same header values, same body bytes.
//
// Then the same list is sent to the app without tgdl-core (Node answering
// PORT itself, as it does when the binary is missing): everything that is
// not media must match the front run, and media answers 503
// TGDL_CORE_UNAVAILABLE — Node has no local file serving of its own.
//
// tgdl-core is required: the run uses the tree's build (the vitest global
// setup), and the front server must really answer.

import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import Database from 'better-sqlite3';

import { testCoreBin } from './helpers/gocore-bin.js';
import {
    PARITY_CASES,
    PARITY_SESSIONS,
    caseDiffs,
    diff,
    normalize,
    runAll,
} from './helpers/front-parity.js';
import {
    NO_CORE_BIN,
    freePort,
    makeDataDir,
    parityFileTokens,
    seedParity,
    startServer,
    stopServer,
} from './helpers/front-server.js';

const SKIP = process.env.TGDL_SKIP_E2E === '1';
const FIXTURE = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'front-parity.json'), 'utf8'),
);

// No accepted differences: every case must match exactly (header-name
// case aside, which HTTP ignores; those are listed in the output).

let srv;
let dataDir;
let results;
let direct;
let frontRunning = false;
let fastAnswers = null;

beforeAll(async () => {
    if (SKIP) return;
    const bin = testCoreBin(); // the tree's build (tests/setup/gocore.global.js)
    dataDir = makeDataDir('tgdl-front-parity-');
    seedParity(dataDir);
    const port = await freePort();
    srv = await startServer({
        dataDir,
        port,
        env: bin ? { TGDL_CORE_BIN: bin } : {},
    });
    results = await runAll(port, await parityFileTokens());
    const health = await fetch(`http://127.0.0.1:${port}/api/system/health?front=1`, {
        headers: { Cookie: `tg_dl_session=${'a'.repeat(64)}` },
    }).then((r) => r.json());
    frontRunning = health?.goCoreFront?.state === 'running';
    fastAnswers = health?.goCoreFront?.stats?.fast || null;

    // The same cases against Node alone, on a fresh copy of the seed.
    const dir2 = makeDataDir('tgdl-front-parity-node-');
    seedParity(dir2);
    const port2 = await freePort();
    const node = await startServer({
        dataDir: dir2,
        port: port2,
        env: { TGDL_CORE_BIN: NO_CORE_BIN, TGDL_FRONT_REQUIRED: '' },
    });
    try {
        direct = await runAll(port2, await parityFileTokens());
    } finally {
        await stopServer(node);
        fs.rmSync(dir2, { recursive: true, force: true, maxRetries: 5 });
    }
}, 180_000);

afterAll(async () => {
    await stopServer(srv);
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
});

describe.skipIf(SKIP)('front server parity with the Node-only server', () => {
    it('runs through tgdl-core when the suite asks for it', () => {
        expect(frontRunning).toBe(true);
        // tgdl-core answered each kind itself (with the headers Node
        // pushed), not just proxied everything.
        expect(fastAnswers.files).toBeGreaterThan(0);
        expect(fastAnswers.photos).toBeGreaterThan(0);
        expect(fastAnswers.thumbs).toBeGreaterThan(0);
    });

    it('sessions tgdl-core served in their renewal window are extended by Node afterwards', async () => {
        // tgdl-core answered without a Set-Cookie and told Node, which alone
        // writes the database (checked once the async notify has landed).
        const db = new Database(path.join(dataDir, 'db.sqlite'), { readonly: true });
        try {
            const row = db.prepare(
                'SELECT issued_at, expires_at FROM web_sessions WHERE token = ?',
            );
            for (const name of ['renewFiles', 'renewPhotos', 'renewThumbs']) {
                const token = PARITY_SESSIONS.find((x) => x.name === name).token;
                const until = Date.now() + 5_000;
                let left = 0;
                do {
                    const r = row.get(token);
                    left = r.expires_at - Date.now();
                    if (left > (r.expires_at - r.issued_at) * 0.25) break;
                    await new Promise((res) => setTimeout(res, 100));
                } while (Date.now() < until);
                expect(left, name).toBeGreaterThan(20 * 24 * 3600 * 1000);
            }
        } finally {
            db.close();
        }
    });

    it('every case matches the frozen Node responses', () => {
        const failures = [];
        const caseOnly = [];
        for (const c of PARITY_CASES) {
            const expected = FIXTURE.cases[c.name];
            expect(expected, `fixture has no case "${c.name}"`).toBeTruthy();
            const exp = { status: expected.status, headers: expected.headers, body: expected.body };
            const act = normalize(results[c.name], c);
            const d = diff(exp, act);
            if (!d.length) {
                const k = caseDiffs(
                    { headers: expected.headerNames.map((n) => [n, '']) },
                    results[c.name],
                );
                if (k.length) caseOnly.push(`${c.name}: ${k.join(', ')}`);
                continue;
            }
            failures.push(`${c.name}\n    ${d.join('\n    ')}`);
        }
        if (caseOnly.length) console.log(`header-name case only:\n  ${caseOnly.join('\n  ')}`);
        expect(failures, failures.join('\n')).toEqual([]);
    });

    it('without tgdl-core Node answers the rest the same, and media with 503', () => {
        const media = /^(files|photos|thumb)/;
        const failures = [];
        for (const c of PARITY_CASES) {
            const exp = normalize(direct[c.name], c);
            if (media.test(c.name)) {
                // Node has no local media to serve: authentication is still
                // its own (redirect / 401), the cluster bridge and ?peer=
                // fetches too; every other case is 503 TGDL_CORE_UNAVAILABLE.
                const ok = [302, 400, 401, 403, 404, 410, 500, 503].includes(exp.status);
                if (!ok) failures.push(`${c.name}: status ${exp.status} without tgdl-core`);
                continue;
            }
            const d = diff(exp, normalize(results[c.name], c));
            if (d.length) failures.push(`${c.name}\n    ${d.join('\n    ')}`);
        }
        expect(failures, failures.join('\n')).toEqual([]);
        expect(direct['files inline'].status).toBe(503);
        expect(direct['photos'].status).toBe(503);
    });
});
