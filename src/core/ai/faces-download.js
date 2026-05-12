import { createHash } from 'crypto';
import { createReadStream, createWriteStream, existsSync, statSync } from 'fs';
import { promises as fs } from 'fs';
import https from 'https';
import http from 'http';
import path from 'path';
import { spawn as _spawn, spawnSync } from 'child_process';

export const SIDECAR_VERSION = '0.1.0';
export const GH_RELEASE_BASE = `https://github.com/botnick/telegram-media-downloader/releases/download/faces-v${SIDECAR_VERSION}`;

const DOWNLOAD_CONNECT_TIMEOUT_MS = 30_000;
const DOWNLOAD_REDIRECT_LIMIT_DEFAULT = 5;

// Tar typeflag byte codes (kept as numeric constants — comparing against
// numbers dodges any source-file NUL-handling issues that crop up when
// you embed `'\0'` literals in JS).
const TAR_TYPE_REGULAR_MODERN = 0x30; /* '0' */
const TAR_TYPE_REGULAR_LEGACY = 0x00; /* NUL (ustar) */
const TAR_TYPE_REGULAR_SPACE = 0x20; /* ' ' (some old tools) */
const TAR_TYPE_DIRECTORY = 0x35; /* '5' */

// ---- URL utilities --------------------------------------------------------

export function normaliseUrl(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim().replace(/\/+$/, '');
    if (!trimmed) return null;
    return trimmed;
}

function _parseUrl(raw) {
    try {
        return new URL(raw);
    } catch {
        return null;
    }
}

function _resolveLocation(base, loc) {
    try {
        return new URL(loc, base).toString();
    } catch {
        return loc;
    }
}

// ---- Binary target resolution -------------------------------------------

/**
 * Pure version of binary target resolution — no side effects, no process
 * inspection. Takes explicit opts so tests can pin platform/arch/dataDir
 * without monkey-patching globals.
 *
 * @param {object} opts
 * @param {string} opts.platform  `process.platform` value
 * @param {string} opts.arch      `process.arch` value
 * @param {string} opts.dataDir   absolute path to the data dir
 * @param {string|null} [opts.envBinUrl]  resolved env URL override
 * @param {string[]} [opts.cfgMirrors]   operator-supplied mirror URLs
 * @returns {object|null}  target descriptor or null on unsupported platform
 */
export function computeBinaryTarget({
    platform: nodePlatform,
    arch: nodeArch,
    dataDir,
    envBinUrl,
    cfgMirrors,
}) {
    const platformMap = { win32: 'win', linux: 'linux', darwin: 'mac' };
    const archMap = { x64: 'x64', arm64: 'arm64' };
    const platform = platformMap[nodePlatform];
    const arch = archMap[nodeArch];
    if (!platform || !arch) return null;

    const slug = `tgdl-faces-${platform}-${arch}`;
    const exe = nodePlatform === 'win32' ? '.exe' : '';
    const binDir = path.join(dataDir, 'faces-service', 'bin');
    const modelsDir = path.join(dataDir, 'faces-service', 'models');
    const binPath = path.join(binDir, `${slug}${exe}`);

    // Build the ordered candidate URL list.
    const candidates = [];
    if (envBinUrl) candidates.push(envBinUrl);
    if (Array.isArray(cfgMirrors)) {
        for (const m of cfgMirrors) {
            const url = normaliseUrl(m);
            if (!url) continue;
            // The mirror may be a full URL to a specific tarball or a base
            // URL the caller wants templated. We accept both: if the URL
            // already ends with `.tar.gz` it's taken verbatim; otherwise we
            // append `/<slug>.tar.gz`.
            if (url.endsWith('.tar.gz')) candidates.push(url);
            else candidates.push(`${url.replace(/\/+$/, '')}/${slug}.tar.gz`);
        }
    }
    candidates.push(`${GH_RELEASE_BASE}/${slug}.tar.gz`);

    // `tarUrl` stays for backward compat with existing callers; new code
    // walks `tarUrls` in order.
    return {
        platform,
        arch,
        slug,
        exe,
        binDir,
        modelsDir,
        binPath,
        tarUrl: candidates[0],
        tarUrls: candidates,
    };
}

/**
 * Resolve the binary target for the running process. Reads process.platform,
 * process.arch, and env overrides.
 */
export function resolveBinaryTarget(resolvedCfg = {}, { dataDir } = {}) {
    return computeBinaryTarget({
        platform: process.platform,
        arch: process.arch,
        dataDir,
        envBinUrl:
            normaliseUrl(process.env.TGDL_FACES_SIDECAR_BIN_URL) ||
            normaliseUrl(process.env.FACES_SIDECAR_BIN_URL),
        cfgMirrors: Array.isArray(resolvedCfg?.downloadMirrors) ? resolvedCfg.downloadMirrors : [],
    });
}

export function isBinaryUsable(binPath) {
    try {
        const st = statSync(binPath);
        if (!st.isFile()) return false;
        if (process.platform !== 'win32') {
            // Exec bit check — readFile alone doesn't tell us whether the
            // file is runnable. On Windows the .exe extension is enough;
            // POSIX needs at least one exec bit set.
            if ((st.mode & 0o111) === 0) return false;
        }
        return st.size > 0;
    } catch {
        return false;
    }
}

export function verifyBinary(binPath) {
    try {
        const res = spawnSync(binPath, ['--help'], {
            stdio: 'ignore',
            timeout: 5000,
        });
        // Any clean exit (0 or non-zero) means the kernel could load it.
        // A spawn-time error (ENOENT, EACCES, code 'EAGAIN' on Windows
        // when AV is scanning) shows up as `res.error`.
        if (res?.error) return false;
        if (res?.status === null && res?.signal) return false;
        return true;
    } catch {
        return false;
    }
}

// ---- Checksum verification ----------------------------------------------

export async function _parseChecksumFile(text) {
    const hex = text.trim().split(/\s/)[0];
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`invalid checksum format: ${text.trim()}`);
    return hex.toLowerCase();
}

export function _hashFile(filePath) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

// Fetches a tiny text file (e.g. a .sha256 checksum). Not streaming — checksum
// files are always < 1 KB so buffering in memory is fine.
function _fetchText(url, redirectsLeft = DOWNLOAD_REDIRECT_LIMIT_DEFAULT) {
    return new Promise((resolve, reject) => {
        const parsed = _parseUrl(url);
        if (!parsed) return reject(new Error(`bad url: ${url}`));
        const lib = parsed.protocol === 'http:' ? http : https;
        const req = lib.get(
            url,
            { headers: { 'user-agent': 'tgdl-faces-spawn', accept: 'text/plain' } },
            (res) => {
                if (
                    res.statusCode >= 300 &&
                    res.statusCode < 400 &&
                    res.headers.location &&
                    redirectsLeft > 0
                ) {
                    res.resume();
                    _fetchText(_resolveLocation(url, res.headers.location), redirectsLeft - 1).then(
                        resolve,
                        reject,
                    );
                    return;
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`http ${res.statusCode} from ${url}`));
                }
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
                res.on('error', reject);
            },
        );
        req.on('error', reject);
    });
}

// Fetches <tarUrl>.sha256, hashes the local tarball, and throws on mismatch.
export async function _verifyChecksum(tarballPath, tarUrl) {
    const checksumUrl = `${tarUrl}.sha256`;
    const text = await _fetchText(checksumUrl);
    const expected = await _parseChecksumFile(text);
    const actual = await _hashFile(tarballPath);
    if (actual !== expected) {
        throw new Error(
            `checksum mismatch for ${path.basename(tarballPath)}: expected ${expected}, got ${actual}`,
        );
    }
}

// ---- Download + extract -------------------------------------------------

/**
 * Stream an HTTPS URL to disk with redirect following and progress
 * broadcasting. Never buffers the whole payload — the file goes straight
 * onto disk so an 80 MB tarball doesn't spike the heap.
 */
function _streamDownload(
    url,
    destPath,
    { redirectsLeft = DOWNLOAD_REDIRECT_LIMIT_DEFAULT, broadcastFn = null } = {},
) {
    return new Promise((resolve, reject) => {
        const parsed = _parseUrl(url);
        if (!parsed) return reject(new Error(`bad url: ${url}`));

        const lib = parsed.protocol === 'http:' ? http : https;
        const req = lib.get(
            url,
            {
                headers: {
                    'user-agent': 'tgdl-faces-spawn',
                    accept: 'application/octet-stream',
                },
                timeout: DOWNLOAD_CONNECT_TIMEOUT_MS,
            },
            (res) => {
                // Follow up to 5 redirects (GitHub bounces to a CDN).
                if (
                    res.statusCode >= 300 &&
                    res.statusCode < 400 &&
                    res.headers.location &&
                    redirectsLeft > 0
                ) {
                    res.resume();
                    const next = _resolveLocation(url, res.headers.location);
                    _streamDownload(next, destPath, {
                        redirectsLeft: redirectsLeft - 1,
                        broadcastFn,
                    }).then(resolve, reject);
                    return;
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new Error(`http ${res.statusCode} from ${url}`));
                    return;
                }

                const total = Number(res.headers['content-length']) || 0;
                let loaded = 0;
                let lastBroadcast = 0;

                const ws = createWriteStream(destPath);
                res.on('data', (chunk) => {
                    loaded += chunk.length;
                    // Throttle WS events to ~10/s so a fast connection
                    // doesn't drown the WS bus with hundreds of progress
                    // payloads per second.
                    if (broadcastFn) {
                        const now = Date.now();
                        if (now - lastBroadcast >= 100 || (total > 0 && loaded === total)) {
                            lastBroadcast = now;
                            const pct = total > 0 ? Math.min(100, (loaded * 100) / total) : 0;
                            broadcastFn({
                                type: 'ai_faces_download_progress',
                                loaded,
                                total,
                                pct,
                            });
                        }
                    }
                });
                res.on('error', (e) => {
                    ws.destroy();
                    reject(e);
                });
                ws.on('error', (e) => reject(e));
                ws.on('finish', () => resolve());
                res.pipe(ws);
            },
        );
        req.on('timeout', () => {
            req.destroy(new Error('download connect timeout'));
        });
        req.on('error', (e) => reject(e));
    });
}

function _readNulTerminated(buf, offset, length) {
    let end = offset;
    const max = offset + length;
    while (end < max && buf[end] !== 0) end++;
    return buf.toString('utf8', offset, end);
}

async function _extractTarballNodeFallback(tarballPath, destDir, logFn) {
    const { createGunzip } = await import('zlib');
    const { createReadStream: crs } = await import('fs');
    const rs = crs(tarballPath);
    const gz = createGunzip();

    let buf = Buffer.alloc(0);
    let pendingHeader = null;
    let pendingBytesRemaining = 0;
    let pendingPaddingBytes = 0;
    let pendingWriteStream = null;
    let pendingWritePromise = null;

    const ensureDir = async (p) => {
        await fs.mkdir(p, { recursive: true });
    };

    const finishPendingWrite = async () => {
        if (pendingWriteStream) {
            const ws = pendingWriteStream;
            const wp = pendingWritePromise;
            pendingWriteStream = null;
            pendingWritePromise = null;
            ws.end();
            await wp;
        }
    };

    return new Promise((resolve, reject) => {
        gz.on('error', reject);
        rs.on('error', reject);

        gz.on('data', async (chunk) => {
            try {
                buf = Buffer.concat([buf, chunk]);
                // Loop until we run out of complete records (headers /
                // file payloads) in the buffered slice.
                while (true) {
                    if (pendingHeader) {
                        // Consuming file payload.
                        if (pendingBytesRemaining > 0) {
                            const slice = buf.subarray(
                                0,
                                Math.min(pendingBytesRemaining, buf.length),
                            );
                            if (slice.length === 0) return;
                            if (pendingWriteStream) {
                                if (!pendingWriteStream.write(slice)) {
                                    gz.pause();
                                    pendingWriteStream.once('drain', () => gz.resume());
                                }
                            }
                            pendingBytesRemaining -= slice.length;
                            buf = buf.subarray(slice.length);
                            if (pendingBytesRemaining > 0) return;
                        }
                        if (pendingPaddingBytes > 0) {
                            if (buf.length < pendingPaddingBytes) return;
                            buf = buf.subarray(pendingPaddingBytes);
                            pendingPaddingBytes = 0;
                        }
                        await finishPendingWrite();
                        pendingHeader = null;
                        continue;
                    }
                    if (buf.length < 512) return;
                    const header = buf.subarray(0, 512);
                    buf = buf.subarray(512);
                    // All-zero block = end of archive.
                    if (header.every((b) => b === 0)) {
                        // Two zero blocks mark EOF; we treat the first one
                        // as terminator too — extra padding is harmless.
                        continue;
                    }
                    const name = _readNulTerminated(header, 0, 100);
                    const sizeOctal = _readNulTerminated(header, 124, 12).trim();
                    // Tar typeflag byte (numeric — avoids embedding a NUL
                    // literal in source).
                    const typeByte = header[156] || 0;
                    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
                    const padding = size % 512 === 0 ? 0 : 512 - (size % 512);

                    const target = path.join(destDir, name);
                    if (!target.startsWith(path.resolve(destDir))) {
                        throw new Error(`tar entry escapes destDir: ${name}`);
                    }

                    const isDir = typeByte === TAR_TYPE_DIRECTORY || name.endsWith('/');
                    const isRegular =
                        typeByte === TAR_TYPE_REGULAR_MODERN ||
                        typeByte === TAR_TYPE_REGULAR_LEGACY ||
                        typeByte === TAR_TYPE_REGULAR_SPACE;

                    if (isDir) {
                        await ensureDir(target);
                        pendingHeader = header;
                        pendingBytesRemaining = 0;
                        pendingPaddingBytes = padding;
                    } else if (isRegular) {
                        await ensureDir(path.dirname(target));
                        pendingHeader = header;
                        pendingBytesRemaining = size;
                        pendingPaddingBytes = padding;
                        pendingWriteStream = createWriteStream(target);
                        pendingWritePromise = new Promise((res, rej) => {
                            pendingWriteStream.on('finish', () => res());
                            pendingWriteStream.on('error', rej);
                        });
                        if (size === 0) {
                            // Empty file — flush immediately so the loop
                            // moves on.
                            await finishPendingWrite();
                            if (padding > 0) {
                                if (buf.length < padding) return;
                                buf = buf.subarray(padding);
                                pendingPaddingBytes = 0;
                            }
                            pendingHeader = null;
                        }
                    } else {
                        // Unsupported entry type — skip its payload + padding.
                        pendingHeader = header;
                        pendingBytesRemaining = size;
                        pendingPaddingBytes = padding;
                        pendingWriteStream = null;
                        pendingWritePromise = Promise.resolve();
                    }
                }
            } catch (e) {
                reject(e);
            }
        });

        gz.on('end', async () => {
            try {
                await finishPendingWrite();
                resolve();
            } catch (e) {
                reject(e);
            }
        });

        rs.pipe(gz);
    });
}

/**
 * Extract a .tar.gz into `destDir`. Prefer the system `tar` binary —
 * Windows 10+ ships it, every supported Linux/macOS has it. Fall back
 * to a Node-level decode using zlib + a minimal tar parser when `tar`
 * isn't on PATH (rare, but possible on stripped-down container images).
 */
async function _extractTarball(tarballPath, destDir, logFn) {
    // Try system tar first.
    try {
        const res = spawnSync('tar', ['-xzf', tarballPath, '-C', destDir], {
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 120_000,
        });
        if (!res.error && res.status === 0) return;
        if (res.error) {
            logFn('info', `system tar unavailable (${res.error.code || res.error.message})`);
        } else {
            logFn(
                'warn',
                `system tar failed status=${res.status}: ${res.stderr?.toString?.() || ''}`,
            );
        }
    } catch (e) {
        logFn('info', `system tar threw: ${e?.message || e}`);
    }

    // Fallback: Node-level decode. Streams to disk, never buffers the
    // whole tarball in memory.
    await _extractTarballNodeFallback(tarballPath, destDir, logFn);
}

/**
 * Download, verify checksum, and extract the sidecar binary.
 *
 * @param {object} target  descriptor from computeBinaryTarget / resolveBinaryTarget
 * @param {object} [opts]
 * @param {(level: string, msg: string) => void} [opts.logFn]
 * @param {(payload: object) => void} [opts.broadcastFn]
 * @param {number} [opts.redirectLimit]
 * @returns {{ checksumVerified: boolean }}
 */
export async function downloadAndExtract(
    target,
    {
        logFn = () => {},
        broadcastFn = null,
        redirectLimit = DOWNLOAD_REDIRECT_LIMIT_DEFAULT,
        onChecksumResult = null,
    } = {},
) {
    await fs.mkdir(target.binDir, { recursive: true });
    await fs.mkdir(target.modelsDir, { recursive: true });

    const tmpTarball = path.join(target.binDir, `${target.slug}-${Date.now()}.tar.gz`);
    const urls =
        Array.isArray(target.tarUrls) && target.tarUrls.length ? target.tarUrls : [target.tarUrl];
    let lastErr = null;
    let downloaded = false;
    let downloadedUrl = null;
    for (const url of urls) {
        logFn('info', `downloading ${url} -> ${tmpTarball}`);
        try {
            await _streamDownload(url, tmpTarball, { redirectsLeft: redirectLimit, broadcastFn });
            downloaded = true;
            downloadedUrl = url;
            break;
        } catch (e) {
            lastErr = e;
            logFn('warn', `download from ${url} failed: ${e?.message || e}`);
            // Clean partial file before trying the next mirror so the
            // extractor doesn't pick up a half-baked tarball.
            try {
                await fs.unlink(tmpTarball);
            } catch {}
        }
    }
    if (!downloaded) {
        throw lastErr || new Error('all download URLs failed');
    }

    let checksumVerified = false;
    try {
        await _verifyChecksum(tmpTarball, downloadedUrl);
        checksumVerified = true;
        if (onChecksumResult) onChecksumResult(true);
        logFn('info', `checksum verified for ${path.basename(downloadedUrl)}`);
    } catch (e) {
        if (onChecksumResult) onChecksumResult(false);
        logFn('warn', `checksum verification failed: ${e?.message || e} — aborting install`);
        try {
            await fs.unlink(tmpTarball);
        } catch {}
        throw e;
    }

    try {
        logFn('info', `extracting ${tmpTarball} into ${target.binDir}`);
        await _extractTarball(tmpTarball, target.binDir, logFn);
    } finally {
        // Always clean up the temp tarball, even if extraction failed —
        // leaving 80 MB of stale .tar.gz files behind on a retry loop
        // would eat the operator's disk fast.
        try {
            await fs.unlink(tmpTarball);
        } catch {}
    }

    if (!existsSync(target.binPath)) {
        throw new Error(`expected binary at ${target.binPath} after extraction`);
    }

    // chmod +x on Unix-likes. Windows has no exec bit so skip.
    if (process.platform !== 'win32') {
        try {
            await fs.chmod(target.binPath, 0o755);
        } catch (e) {
            logFn('warn', `chmod failed: ${e?.message || e}`);
        }
    }

    return { checksumVerified };
}
