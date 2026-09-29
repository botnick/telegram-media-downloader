#!/usr/bin/env node
/**
 * Front-server parity harness (cases: tests/helpers/front-parity.js).
 *
 *   node scripts/front-parity.js capture [--out tests/fixtures/front-parity.json]
 *       Seed a temp data dir, start src/web/server.js on a free port, send
 *       every parity case and write the normalised responses of Node
 *       answering PORT itself (no tgdl-core). This is how the frozen Node
 *       fixture was made (v2.28, before the Go front server existed);
 *       re-running it on a later tree records that tree (not any more for
 *       media: Node alone answers those with 503 now).
 *
 *   node scripts/front-parity.js diff
 *       Start the app twice on two seeded dirs — as it runs by default
 *       (tgdl-core in front) and with Node answering on PORT itself (no
 *       tgdl-core binary) — and print every difference (media routes differ
 *       by design: Node alone answers 503 TGDL_CORE_UNAVAILABLE).
 *
 * Extra environment for the server passes through (TRUST_PROXY,
 * COMPRESSION_LEVEL, TGDL_CORE_BIN, …).
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { PARITY_CASES, caseDiffs, diff, normalize } from '../tests/helpers/front-parity.js';
import { NO_CORE_BIN, REPO, runParityOnce } from '../tests/helpers/front-server.js';

function arg(name, def) {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : def;
}

function gitDescribe() {
    const r = spawnSync('git', ['describe', '--always', '--dirty'], {
        cwd: REPO,
        encoding: 'utf8',
    });
    return (r.stdout || '').trim() || 'unknown';
}

// Node answering PORT itself: no tgdl-core binary.
const NODE_ALONE = { TGDL_CORE_BIN: NO_CORE_BIN, TGDL_FRONT_REQUIRED: '' };

async function capture() {
    const out = arg('--out', path.join(REPO, 'tests', 'fixtures', 'front-parity.json'));
    const raw = await runParityOnce(NODE_ALONE);
    const cases = {};
    for (const c of PARITY_CASES) {
        const r = raw[c.name];
        cases[c.name] = {
            ...normalize(r, c),
            headerNames: r.headers.map(([n]) => n),
            ...(r.statusLine ? { statusLine: r.statusLine } : {}),
        };
    }
    const doc = {
        capturedFrom: gitDescribe(),
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        note: 'Responses of the Node-only server. See tests/helpers/front-parity.js.',
        cases,
    };
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`wrote ${Object.keys(cases).length} cases to ${path.relative(REPO, out)}`);
}

async function diffLive() {
    const front = await runParityOnce();
    const direct = await runParityOnce(NODE_ALONE);
    let bad = 0;
    for (const c of PARITY_CASES) {
        const d = diff(normalize(direct[c.name], c), normalize(front[c.name], c));
        const k = caseDiffs(direct[c.name], front[c.name]);
        if (d.length) {
            bad++;
            console.log(`✗ ${c.name}\n    ${d.join('\n    ')}`);
        } else if (k.length) {
            console.log(`~ ${c.name} (header-name case only: ${k.join(', ')})`);
        }
    }
    console.log(bad ? `${bad} case(s) differ` : 'all cases identical');
    process.exitCode = bad ? 1 : 0;
}

const cmd = process.argv[2];
if (cmd === 'capture') await capture();
else if (cmd === 'diff') await diffLive();
else {
    console.error('usage: node scripts/front-parity.js capture|diff [--out file]');
    process.exit(2);
}
