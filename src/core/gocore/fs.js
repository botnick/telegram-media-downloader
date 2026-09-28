/**
 * File-system questions answered by tgdl-core, in the shapes the callers
 * used to get from fs:
 *
 *   statMany(paths)          fs.stat for each path (integrity sweep)
 *   walkTree(root, opts)     recursive fs.readdir(…, {withFileTypes}) + fs.stat
 *                            (re-index from disk)
 *   diskUsage(root)          what server.js scanDirectorySize summed up
 *
 * tgdl-core answers with the same error codes Node would (libuv's, see
 * core-service/internal/fsx). The one thing it refuses is a path outside
 * the directories the app allows it to read (EOUTSIDE: a folder linked in
 * from another disk, an alternate data stream, …); those few are stat'ed
 * here with plain fs.stat, exactly as before, so every answer is the one
 * fs would have given.
 */

import { promises as fsp } from 'fs';
import path from 'path';
import util from 'util';

import * as client from './client.js';
// Supervision + start-on-first-use hooks for the client.
import './spawn.js';

/**
 * Error shaped like the one fs throws for `code` (errno, syscall, path,
 * message); `p` undefined for errors fs reports without a path (read).
 */
export function uvError(code, syscall, p) {
    let errno;
    let desc = 'unknown error';
    for (const [n, [name, message]] of util.getSystemErrorMap()) {
        if (name === code) {
            errno = n;
            desc = message;
            break;
        }
    }
    const err = new Error(`${code}: ${desc}, ${syscall}${p === undefined ? '' : ` '${p}'`}`);
    err.errno = errno;
    err.code = code;
    err.syscall = syscall;
    if (p !== undefined) err.path = p;
    return err;
}

async function _nodeStat(p) {
    try {
        const st = await fsp.stat(p);
        return {
            ok: true,
            size: st.size,
            mtimeMs: st.mtimeMs,
            isFile: st.isFile(),
            isDir: st.isDirectory(),
        };
    } catch (e) {
        return { code: e?.code || 'UNKNOWN' };
    }
}

/**
 * fs.stat for every absolute path, in order: `{ ok: true, size, mtimeMs,
 * isFile, isDir }` or `{ code }` (ENOENT, EACCES, …). Throws a
 * GoCoreError when tgdl-core can't answer at all.
 */
export async function statMany(paths, { timeoutMs, readyWaitMs } = {}) {
    const out = new Array(paths.length);
    for (let i = 0; i < paths.length; i += client.STAT_BATCH_MAX) {
        const slice = paths.slice(i, i + client.STAT_BATCH_MAX);
        const res = await client.statBatch(slice, { timeoutMs, readyWaitMs });
        for (let j = 0; j < res.length; j++) out[i + j] = res[j];
    }
    for (let i = 0; i < out.length; i++) {
        if (out[i].code === 'EOUTSIDE') out[i] = await _nodeStat(paths[i]);
    }
    return out;
}

function _join(root, rel) {
    // The path fs callers built with path.join(dir, entry.name) per level.
    return path.join(root, ...rel.split('/'));
}

/**
 * Walk `root` and return every event in walk order (see
 * core-service/internal/fsx/handler.go): `{t:'d', p}` directories,
 * `{t:'f', p, k, ok?, size?, isFile?, code?}` everything else,
 * `{t:'e', p, code}` directories that could not be listed (p '' = root).
 *
 * @param {string} root  absolute
 * @param {{ maxDepth?: number, stat?: 'none'|'files'|'nondir', signal?: AbortSignal }} [opts]
 */
export async function walkTree(root, { maxDepth = 0, stat = 'none', signal, readyWaitMs } = {}) {
    const events = [];
    const summary = await client.walk(
        { root, maxDepth, stat },
        { onEvent: (ev) => events.push(ev), signal, readyWaitMs },
    );
    for (const ev of events) {
        if (ev.t === 'f' && ev.code === 'EOUTSIDE') {
            const st = await _nodeStat(_join(root, ev.p));
            delete ev.code;
            Object.assign(ev, st);
        }
    }
    return { events, summary };
}

/**
 * Total size of every file under `root`, the way scanDirectorySize added
 * it up: every directory is entered (links to directories are not), every
 * other entry is fs.stat'ed (following links) and counted when it is a
 * file; unreadable directories and vanished files are skipped.
 */
export async function diskUsage(root, { signal, readyWaitMs } = {}) {
    const summary = await client.walk(
        { root, maxDepth: 0, stat: 'nondir', entries: false },
        { signal, readyWaitMs },
    );
    let total = Number(summary.bytes) || 0;
    for (const rel of summary.outside || []) {
        const st = await _nodeStat(_join(root, rel));
        if (st.ok && st.isFile) total += st.size;
    }
    return total;
}
