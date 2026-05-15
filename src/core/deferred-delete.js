/**
 * Deferred file deletion — rename to `.deleted/` instantly, drain in background.
 *
 * `deferDelete(absPath)` renames the file into `<downloadsDir>/.deleted/<uuid><ext>`
 * which is an atomic same-filesystem move (instant, non-blocking). The original
 * directory looks clean immediately.
 *
 * `startDrain()` launches a background async loop that walks `.deleted/` and
 * `fs.unlink`s each file with setImmediate yields so the event loop stays free.
 * Called on boot (picks up leftovers from a crash) and after every bulk delete.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { getDownloadsDir } from './paths.js';

const DELETED_DIR = path.join(getDownloadsDir(), '.deleted');
let _draining = false;
let _drainQueued = false;

function _ensureDir() {
    if (!fs.existsSync(DELETED_DIR)) {
        fs.mkdirSync(DELETED_DIR, { recursive: true });
    }
}

/**
 * Move a file to `.deleted/` instantly. Returns true if renamed, false if
 * the file was already gone (ENOENT). Throws on permission errors.
 */
export function deferDelete(absPath) {
    if (!absPath) return false;
    _ensureDir();
    const ext = path.extname(absPath);
    const dest = path.join(DELETED_DIR, randomUUID() + ext);
    try {
        fs.renameSync(absPath, dest);
        return true;
    } catch (e) {
        if (e?.code === 'ENOENT') return false;
        throw e;
    }
}

/**
 * Drain `.deleted/` in the background. Non-blocking — yields every 20 files.
 * Safe to call multiple times; concurrent calls are coalesced.
 */
export async function startDrain() {
    if (_draining) {
        _drainQueued = true;
        return;
    }
    _draining = true;
    try {
        await _drain();
        while (_drainQueued) {
            _drainQueued = false;
            await _drain();
        }
    } finally {
        _draining = false;
    }
}

async function _drain() {
    if (!fs.existsSync(DELETED_DIR)) return;
    let files;
    try {
        files = await fsp.readdir(DELETED_DIR);
    } catch {
        return;
    }
    let count = 0;
    for (const f of files) {
        try {
            await fsp.unlink(path.join(DELETED_DIR, f));
            count++;
        } catch {}
        if (count % 20 === 0) {
            await new Promise((r) => setImmediate(r));
        }
    }
    if (count > 0) {
        console.log(`[deferred-delete] drained ${count} file(s) from .deleted/`);
    }
}

/**
 * Check if `.deleted/` has leftover files (for boot-time detection).
 */
export function hasLeftovers() {
    try {
        if (!fs.existsSync(DELETED_DIR)) return false;
        const entries = fs.readdirSync(DELETED_DIR);
        return entries.length > 0;
    } catch {
        return false;
    }
}
