// Front-server parity: every request in tests/helpers/front-parity.js,
// sent to the app as it runs now (tgdl-core front server on PORT, Node
// behind it), must get the response the Node-only server gave before
// (tests/fixtures/front-parity.json, captured from v2.28): same status,
// same header values, same body bytes.
//
// Then the same list is sent to the app without tgdl-core (Node answering
// PORT itself, as it does when the binary is missing) and both runs are
// compared: a change to Node's headers that tgdl-core doesn't follow fails
// here even after the fixture is re-captured.
//
// With TGDL_GO_CORE_TEST=1 (CI's "node + tgdl-core" jobs) the suite
// requires the front server to be running; without a binary the app
// serves PORT itself and the same comparison runs against Node alone.

import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GOCORE_TEST, findOrBuildGoCore } from './helpers/gocore-bin.js';
import { PARITY_CASES, caseDiffs, diff, normalize, runAll } from './helpers/front-parity.js';
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

// Differences between the Node-only server and the front server that are
// intended, with the reason. Everything else must match exactly.
export const ACCEPTED = {
    'files bad encoding': {
        why:
            "A request target with an invalid percent-escape (%E0%A4%A) is rejected by Go's HTTP " +
            'parser with a bare 400 before any handler runs; Node answered 400 "Bad request" with ' +
            'the app headers. Same status, different headers/body.',
        check: (a) => a.status === 400,
    },
    'thumb If-None-Match exact': {
        why:
            'Go never writes Content-Type on a 304 (RFC 9110 §15.4.5); the thumbnail route sent ' +
            'image/webp on it. Browsers merge a 304 into the cached response, which already has ' +
            'that type.',
        check: (a, e) => sameExcept(a, e, ['content-type']),
    },
    'thumb If-Modified-Since exact': {
        why: 'Same as "thumb If-None-Match exact".',
        check: (a, e) => sameExcept(a, e, ['content-type']),
    },
};

function sameExcept(actual, expected, names) {
    const strip = (r) => ({ ...r, headers: r.headers.filter(([k]) => !names.includes(k)) });
    return diff(strip(expected), strip(actual)).length === 0;
}

let srv;
let dataDir;
let results;
let direct;
let frontRunning = false;
let fastAnswers = null;

beforeAll(async () => {
    if (SKIP) return;
    const bin = await findOrBuildGoCore(); // null unless TGDL_GO_CORE_TEST=1
    dataDir = makeDataDir('tgdl-front-parity-');
    seedParity(dataDir);
    const port = await freePort();
    srv = await startServer({
        dataDir,
        port,
        env: bin ? { TGDL_CORE_BIN: bin } : {},
    });
    results = await runAll(port, await parityFileTokens());
    const health = await fetch(`http://127.0.0.1:${port}/api/system/health`, {
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
        if (GOCORE_TEST) {
            expect(frontRunning).toBe(true);
            // tgdl-core answered each kind itself (with the headers Node
            // pushed), not just proxied everything.
            expect(fastAnswers.files).toBeGreaterThan(0);
            expect(fastAnswers.photos).toBeGreaterThan(0);
            expect(fastAnswers.thumbs).toBeGreaterThan(0);
        }
    });

    it('every case matches the frozen Node responses', () => {
        const failures = [];
        const accepted = [];
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
            const acc = frontRunning ? ACCEPTED[c.name] : null;
            if (acc?.check(act, exp)) {
                accepted.push(`${c.name}: ${acc.why}`);
                continue;
            }
            failures.push(`${c.name}\n    ${d.join('\n    ')}`);
        }
        if (accepted.length) console.log(`accepted differences:\n  ${accepted.join('\n  ')}`);
        if (caseOnly.length) console.log(`header-name case only:\n  ${caseOnly.join('\n  ')}`);
        expect(failures, failures.join('\n')).toEqual([]);
    });

    it('every case matches Node answering the same request today', () => {
        const failures = [];
        for (const c of PARITY_CASES) {
            const exp = normalize(direct[c.name], c);
            const act = normalize(results[c.name], c);
            const d = diff(exp, act);
            if (!d.length) continue;
            if (frontRunning && ACCEPTED[c.name]?.check(act, exp)) continue;
            failures.push(`${c.name}\n    ${d.join('\n    ')}`);
        }
        expect(failures, failures.join('\n')).toEqual([]);
    });
});
