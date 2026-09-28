#!/usr/bin/env node
// Build the contract suite's deterministic data dir into <dir> — for
// debugging a hand-started server with CONTRACT_TARGET=url:
//
//   node scripts/contract-seed.mjs /tmp/tgdl-seed
//   TGDL_DATA_DIR=/tmp/tgdl-seed PORT=3999 node src/web/server.js      (or the Go binary)
//   CONTRACT_TARGET=url CONTRACT_URL=http://127.0.0.1:3999 \
//     CONTRACT_DATA_DIR=/tmp/tgdl-seed npx vitest run --config tests/contract/vitest.config.js static
//
// Scenarios mutate state: re-seed (and restart the server) between files.

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.argv[2];
if (!dir) {
    console.error('usage: node scripts/contract-seed.mjs <empty dir>');
    process.exit(2);
}
const abs = path.resolve(dir);
if (fs.existsSync(abs) && fs.readdirSync(abs).length) {
    console.error(`${abs} is not empty`);
    process.exit(1);
}
const { buildSeed } = await import(
    pathToFileURL(path.join(REPO, 'tests', 'contract', 'fixtures', 'seed.js')).href
);
buildSeed(abs);
console.log(`seeded ${abs}`);
