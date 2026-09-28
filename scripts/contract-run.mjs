#!/usr/bin/env node
// Cross-platform runner for the contract suite (npm scripts run in cmd.exe
// on Windows, where `VAR=1 cmd` does not work).
//
//   node scripts/contract-run.mjs                 compare against the goldens
//   node scripts/contract-run.mjs --update        re-record the goldens (Node
//                                                 target), then run the checker
//   node scripts/contract-run.mjs --update auth   only files matching "auth"
//
// Extra arguments are passed to vitest as file filters.

import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const update = args.includes('--update');
const filters = args.filter((a) => a !== '--update');
const vitest = path.join(REPO, 'node_modules', 'vitest', 'vitest.mjs');
const config = path.join('tests', 'contract', 'vitest.config.js');

function run(extraEnv, fileArgs) {
    const r = spawnSync(process.execPath, [vitest, 'run', '--config', config, ...fileArgs], {
        cwd: REPO,
        stdio: 'inherit',
        env: { ...process.env, ...extraEnv },
    });
    return r.status ?? 1;
}

if (update) {
    if ((process.env.CONTRACT_TARGET || 'node') !== 'node') {
        console.error('goldens are recorded from the Node target only (unset CONTRACT_TARGET)');
        process.exit(1);
    }
    const rec = run(
        { CONTRACT_UPDATE: '1' },
        filters.length ? filters : ['--exclude', 'tests/contract/inventory.contract.test.js'],
    );
    if (rec !== 0) process.exit(rec);
    process.exit(run({}, ['tests/contract/inventory.contract.test.js']));
}
process.exit(run({}, filters));
