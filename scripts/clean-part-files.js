#!/usr/bin/env node
/**
 * Remove stale `.part` files from the downloads directory.
 *
 * These are incomplete downloads left behind when a download is interrupted
 * (e.g. process killed, session timeout, connection lost). The downloader
 * writes to `<file>.part` and renames to `<file>` on completion, so any
 * leftover `.part` file is safe to remove.
 *
 * Usage:
 *   node scripts/clean-part-files.js
 *   node scripts/clean-part-files.js --dry-run    # preview only
 *   node scripts/clean-part-files.js --dir ./data/downloads
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DOWNLOADS_DIR = path.join(PROJECT_ROOT, 'data', 'downloads');

const DRY_RUN = process.argv.includes('--dry-run');
const DIR_ARG = process.argv.find((a) => a.startsWith('--dir='));
const DOWNLOADS_DIR = DIR_ARG
    ? path.resolve(PROJECT_ROOT, DIR_ARG.split('=')[1])
    : DEFAULT_DOWNLOADS_DIR;

if (!fs.existsSync(DOWNLOADS_DIR)) {
    console.error(`Downloads directory not found: ${DOWNLOADS_DIR}`);
    process.exit(1);
}

let found = 0;
let removed = 0;
let totalBytes = 0;

function walk(dir) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.part')) {
            found++;
            const size = fs.statSync(full).size;
            totalBytes += size;
            const display = full.replace(PROJECT_ROOT, '.').replace(/^\.\//, '');
            if (DRY_RUN) {
                console.log(`[dry-run] would remove  ${display}  (${formatBytes(size)})`);
            } else {
                try {
                    fs.unlinkSync(full);
                    removed++;
                    console.log(`removed  ${display}  (${formatBytes(size)})`);
                } catch (e) {
                    console.error(`error    ${display}: ${e.message}`);
                }
            }
        }
    }
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

console.log(
    `Scanning ${DOWNLOADS_DIR.replace(PROJECT_ROOT, '.')} for .part files${DRY_RUN ? ' (dry-run)' : ''}...`,
);
console.log('');
walk(DOWNLOADS_DIR);

if (found === 0) {
    console.log('No .part files found.');
} else {
    console.log('');
    console.log(`Found:   ${found} .part files (${formatBytes(totalBytes)})`);
    if (DRY_RUN) {
        console.log(`Dry-run: run without --dry-run to remove them.`);
    } else {
        console.log(`Removed: ${removed} files`);
        if (removed < found) {
            console.log(`Failed:  ${found - removed} files (permission errors)`);
        }
    }
}
