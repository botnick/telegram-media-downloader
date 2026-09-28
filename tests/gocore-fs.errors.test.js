// SAFETY-CRITICAL. src/core/integrity.js deletes library rows when fs.stat
// fails with ENOENT or ENOTDIR — and fs.stat is now answered by tgdl-core.
// A wrong error code here deletes (or fails to clean up) people's library.
// So: for every situation we can set up on this OS, tgdl-core's answer
// must be exactly what Node's own fs.stat says, live, on this machine.
//
// The only allowed difference is EOUTSIDE (tgdl-core refusing a path that
// is not inside the directories it may read: a link out of the root, an
// NTFS alternate data stream, a reserved device name); the app answers
// those with fs.stat itself — the `statMany` half of this file checks
// that the end result is then identical for every case too.

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { requireCoreBin, startRawCore } from './helpers/gocore-raw.js';

const WIN = process.platform === 'win32';
const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR']); // integrity.js
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-fs-errors-'));
const ROOT = path.join(BASE, 'root');
const OUTSIDE = path.join(BASE, 'outside');
const J = (...p) => path.join(ROOT, ...p);

/** name → { path, outsideOk?: true } */
const cases = {};
const cleanups = [];
let core;
let sysCore;
let lockHolder = null;

function add(name, p, opts = {}) {
    cases[name] = { path: p, ...opts };
}

function tryLink(target, at, type) {
    try {
        fs.symlinkSync(target, at, type);
        return true;
    } catch {
        return false;
    }
}

async function nodeStat(p) {
    try {
        const st = await fs.promises.stat(p);
        return {
            ok: true,
            size: st.size,
            mtimeMs: st.mtimeMs,
            isFile: st.isFile(),
            isDir: st.isDirectory(),
        };
    } catch (e) {
        return { code: e.code };
    }
}

function icacls(...args) {
    return spawnSync('icacls', args, { encoding: 'utf8', windowsHide: true }).status === 0;
}

beforeAll(async () => {
    requireCoreBin();
    fs.mkdirSync(path.join(ROOT, 'dir', 'sub'), { recursive: true });
    fs.mkdirSync(OUTSIDE, { recursive: true });
    fs.writeFileSync(J('dir', 'file.txt'), 'hello');
    fs.writeFileSync(J('empty.bin'), '');
    fs.writeFileSync(path.join(OUTSIDE, 'o.txt'), 'outside');
    fs.writeFileSync(J('dir', 'ไฟล์ 😀.txt'), 'unicode');
    const old = new Date(Date.UTC(1965, 3, 2, 1, 2, 3, 456));
    fs.writeFileSync(J('old.txt'), 'o');
    fs.utimesSync(J('old.txt'), old, old);
    const fut = new Date(Date.UTC(2100, 0, 1, 0, 0, 0, 789));
    fs.writeFileSync(J('future.txt'), 'f');
    fs.utimesSync(J('future.txt'), fut, fut);
    fs.writeFileSync(J('frac.txt'), 'f');
    fs.utimesSync(J('frac.txt'), 1700000000.1234567, 1700000000.1234567);
    let deep = ROOT;
    for (let i = 0; i < 12; i++) deep = path.join(deep, `long-${i}-${'x'.repeat(20)}`);
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'deep.bin'), 'abc');

    add('regular file', J('dir', 'file.txt'));
    add('directory', J('dir'));
    add('empty file', J('empty.bin'));
    add('unicode name', J('dir', 'ไฟล์ 😀.txt'));
    add('mtime before 1970', J('old.txt'));
    add('mtime after 2038', J('future.txt'));
    add('fractional mtime', J('frac.txt'));
    add('missing file', J('dir', 'missing.txt'));
    add('missing parent directory', J('no-such-dir', 'missing.txt'));
    add('file used as a directory', J('dir', 'file.txt', 'child'));
    add('file used as a directory (deeper)', J('dir', 'file.txt', 'a', 'b'));
    add('different case', J('DIR', 'FILE.TXT'));
    add('trailing dot', J('dir', 'file.txt.'));
    add('trailing space', J('dir', 'file.txt '));
    add('component of 255 chars (missing)', J('dir', 'n'.repeat(255)));
    add('component of 256 chars', J('dir', 'n'.repeat(256)));
    add('path over 260 chars (exists)', path.join(deep, 'deep.bin'));
    add('path over 260 chars (missing)', path.join(deep, 'nope.bin'));
    add(
        'path over 32767 chars',
        J(...Array.from({ length: 140 }, (_, i) => `c${i}${'y'.repeat(240)}`)),
    );
    add('outside the root', path.join(OUTSIDE, 'o.txt'), { outsideOk: true });

    // Links (junctions on Windows need no privilege; symlinks may).
    const dirLinkType = WIN ? 'junction' : 'dir';
    if (tryLink(J('dir'), J('link-in'), dirLinkType)) {
        add('directory link inside the root', J('link-in'));
        add('file through a directory link', J('link-in', 'file.txt'));
    }
    if (tryLink(OUTSIDE, J('link-out'), dirLinkType)) {
        add('directory link out of the root', J('link-out'), { outsideOk: true });
        add('file through a link out of the root', J('link-out', 'o.txt'), { outsideOk: true });
    }
    fs.mkdirSync(J('gone'));
    if (tryLink(J('gone'), J('link-dangling'), dirLinkType)) {
        add('dangling directory link', J('link-dangling'));
        add('child of a dangling link', J('link-dangling', 'x'));
    }
    fs.rmdirSync(J('gone'));
    if (tryLink(J('dir', 'file.txt'), J('sym-file'), 'file')) {
        add('file symlink', J('sym-file'));
        tryLink(J('nope.txt'), J('sym-dangling'), 'file') &&
            add('dangling file symlink', J('sym-dangling'));
        if (
            tryLink(J('loop-b'), J('loop-a'), 'file') &&
            tryLink(J('loop-a'), J('loop-b'), 'file')
        ) {
            add('symlink loop', J('loop-a'));
            add('child of a symlink loop', J('loop-a', 'x'));
        }
        tryLink(path.join(OUTSIDE, 'o.txt'), J('sym-out'), 'file') &&
            add('file symlink out of the root', J('sym-out'), { outsideOk: true });
    }

    if (WIN) {
        for (const c of ['?', '*', '<', '>', '|', '"']) add(`name with ${c}`, J('dir', `a${c}b`));
        add('alternate data stream (missing)', J('dir', 'file.txt:stream'), { outsideOk: true });
        add('alternate data stream ::$DATA', J('dir', 'file.txt::$DATA'), { outsideOk: true });
        add('reserved name NUL', J('dir', 'NUL'), { outsideOk: true });
        add('reserved name CON', J('dir', 'CON'), { outsideOk: true });
        add('reserved-looking COM1.txt', J('dir', 'COM1.txt'), { outsideOk: true });
        // ACLs: read-attributes denied, everything denied, a folder that
        // can't be listed or traversed.
        const user = process.env.USERNAME;
        fs.mkdirSync(J('acl'));
        fs.writeFileSync(J('acl', 'deny-ra.txt'), 'secret');
        fs.writeFileSync(J('acl', 'deny-all.txt'), 'secret');
        fs.mkdirSync(J('acl-dir'));
        fs.writeFileSync(J('acl-dir', 'inner.txt'), 'x');
        if (icacls(J('acl', 'deny-ra.txt'), '/deny', `${user}:(RA)`)) {
            add('ACL: read-attributes denied', J('acl', 'deny-ra.txt'));
            cleanups.push(() => icacls(J('acl', 'deny-ra.txt'), '/remove:d', user));
        }
        if (icacls(J('acl', 'deny-all.txt'), '/deny', `${user}:(F)`)) {
            add('ACL: all access denied', J('acl', 'deny-all.txt'));
            cleanups.push(() => icacls(J('acl', 'deny-all.txt'), '/remove:d', user));
        }
        if (icacls(J('acl-dir'), '/deny', `${user}:(RD,X,RA)`)) {
            add('ACL: folder not listable', J('acl-dir'));
            add('ACL: file in a folder not listable', J('acl-dir', 'inner.txt'));
            add('ACL: missing file in a folder not listable', J('acl-dir', 'nope.txt'));
            cleanups.push(() => icacls(J('acl-dir'), '/remove:d', user));
        }
        // Open with no sharing by another process (a sharing violation for
        // anything that reads data; stat only asks for attributes).
        fs.writeFileSync(J('locked.bin'), 'locked');
        lockHolder = spawn(
            'powershell',
            [
                '-NoProfile',
                '-Command',
                `$f=[System.IO.File]::Open('${J('locked.bin')}','Open','ReadWrite','None'); Write-Output locked; Start-Sleep -Seconds 60`,
            ],
            { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
        );
        await new Promise((resolve) => {
            const t = setTimeout(resolve, 15_000);
            lockHolder.stdout.on('data', (d) => {
                if (String(d).includes('locked')) {
                    clearTimeout(t);
                    resolve();
                }
            });
        });
        add('file open without sharing by another process', J('locked.bin'));
    } else {
        fs.mkdirSync(J('noexec'));
        fs.writeFileSync(J('noexec', 'inner.txt'), 'x');
        fs.chmodSync(J('noexec'), 0o600); // listable, not traversable
        cleanups.push(() => fs.chmodSync(J('noexec'), 0o755));
        add('file in a folder without search permission', J('noexec', 'inner.txt'));
        add('folder without search permission', J('noexec'));
        add('component of 300 chars', J('dir', 'z'.repeat(300)));
        add('path with a NUL-free long component chain', J('dir', ...Array(80).fill('q')));
        if (spawnSync('mkfifo', [J('fifo')]).status === 0) add('named pipe (FIFO)', J('fifo'));
        add('/dev/null-like device (inside root via link)', J('devnull'));
        tryLink('/dev/null', J('devnull'), 'file');
    }

    core = await startRawCore([ROOT]);
}, 60_000);

afterAll(async () => {
    core?.stop();
    sysCore?.stop();
    try {
        lockHolder?.kill();
    } catch {}
    for (const c of cleanups) {
        try {
            c();
        } catch {}
    }
    await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(BASE, { recursive: true, force: true });
});

async function goStat(c, paths) {
    const r = await c.post('/v1/fs/stat-batch', { paths });
    expect(r.status).toBe(200);
    return r.json.results;
}

describe('stat-batch answers exactly like fs.stat', () => {
    it('every situation on this OS', async () => {
        const names = Object.keys(cases);
        const paths = names.map((n) => cases[n].path);
        const go = await goStat(core, paths);
        const rows = [];
        for (let i = 0; i < names.length; i++) {
            const node = await nodeStat(paths[i]);
            const g = go[i];
            const same = JSON.stringify(g) === JSON.stringify(node);
            const outside = g.code === 'EOUTSIDE' && cases[names[i]].outsideOk;
            rows.push({ name: names[i], node: node.code || 'ok', go: g.code || 'ok', same });
            if (!same && !outside) {
                throw new Error(
                    `${names[i]}: node=${JSON.stringify(node)} go=${JSON.stringify(g)}`,
                );
            }
            // Never prune what Node wouldn't, never miss what Node would
            // (an EOUTSIDE is answered by fs.stat in the app, below).
            if (!outside) expect(MISSING_CODES.has(g.code)).toBe(MISSING_CODES.has(node.code));
        }
        expect(rows.length).toBeGreaterThan(20);
    });

    it('the app-side statMany (EOUTSIDE answered by fs.stat) equals fs.stat for every case', async () => {
        process.env.TGDL_CORE_ALLOW_ROOTS = ROOT;
        const { statMany } = await import('../src/core/gocore/fs.js');
        const names = Object.keys(cases);
        const got = await statMany(names.map((n) => cases[n].path));
        for (let i = 0; i < names.length; i++) {
            expect({ name: names[i], r: got[i] }).toEqual({
                name: names[i],
                r: await nodeStat(cases[names[i]].path),
            });
        }
        const { stopGoCore } = await import('../src/core/gocore/spawn.js');
        stopGoCore();
    });

    it.runIf(WIN)(
        'Windows system files, drives and network paths',
        async () => {
            const sys = {
                'pagefile.sys (in use by the kernel)': 'C:\\pagefile.sys',
                'hiberfil.sys': 'C:\\hiberfil.sys',
                'swapfile.sys': 'C:\\swapfile.sys',
                'System Volume Information': 'C:\\System Volume Information',
                'inside System Volume Information': 'C:\\System Volume Information\\x',
                '$Recycle.Bin': 'C:\\$Recycle.Bin',
                'drive letter that does not exist': 'Q:\\nothing\\here.txt',
                'network share that does not exist': '\\\\localhost\\no-such-share-tgdl\\x.txt',
                'network host that does not exist': '\\\\no-such-host-tgdl.invalid\\share\\x.txt',
                'app execution alias (reparse point)': path.join(
                    process.env.LOCALAPPDATA || 'C:\\',
                    'Microsoft',
                    'WindowsApps',
                    'winget.exe',
                ),
            };
            sysCore = await startRawCore([
                'C:\\',
                'Q:\\',
                '\\\\localhost\\no-such-share-tgdl',
                '\\\\no-such-host-tgdl.invalid\\share',
                process.env.LOCALAPPDATA || 'C:\\',
            ]);
            const names = Object.keys(sys);
            const go = await goStat(sysCore, Object.values(sys));
            for (let i = 0; i < names.length; i++) {
                const node = await nodeStat(sys[names[i]]);
                expect({ name: names[i], r: go[i] }).toEqual({ name: names[i], r: node });
            }
            // The case that matters most: an offline share must never read as
            // "file missing" (Go's own os.Stat says it is; libuv says UNKNOWN).
            expect(go[names.indexOf('network share that does not exist')].code).toBe('UNKNOWN');
        },
        60_000,
    );
});
