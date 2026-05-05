/**
 * Minimal streaming ZIP writer (PKZIP / .zip).
 *
 * Why hand-rolled:
 *   - ZIP is a public, ~30-line spec for the STORE method (no compression).
 *   - Media files are already compressed (JPEG / MP4 / WebP / Opus / ...),
 *     so STORE is the right choice — DEFLATE wastes CPU for sub-1% savings
 *     and breaks range-request semantics on very large archives.
 *   - Lets us stream multi-GB archives to the response with zero RAM
 *     pressure: we read each input file as a stream, emit local-header +
 *     bytes, accumulate central-directory metadata, then emit the central
 *     directory + EOCD record at the end. No archive ever lives in memory.
 *   - Adds zero new dependencies (the `archiver` package would be ~200 KB
 *     installed and pull in 6 transitive deps).
 *
 * What it does NOT do (intentionally — keep it simple):
 *   - DEFLATE / LZMA / BZIP2 compression. Use STORE only.
 *   - Encryption (use HTTPS for transport security).
 *   - ZIP64. Practical limit per archive is ~4 GiB total + 65535 entries.
 *     The bulk-zip caller checks both limits up front and refuses to
 *     start a job that would overflow.
 *
 * Reference: APPNOTE.TXT (PKWARE), sections 4.3.7, 4.3.12, 4.3.16.
 */

import { createReadStream } from 'fs';
import { stat } from 'fs/promises';

const SIG_LOCAL_FILE        = 0x04034b50;
const SIG_CENTRAL_FILE      = 0x02014b50;
const SIG_END_OF_CENTRAL    = 0x06054b50;
const STORE                 = 0;
const VERSION_MADE_BY       = 0x031E; // 3.0, UNIX
const VERSION_NEEDED        = 20;     // 2.0
const FLAG_UTF8             = 0x0800;

// Per-archive ceiling — we don't emit ZIP64 records, so anything that
// would push us past 4 GiB has to be rejected at the API layer.
export const ZIP_MAX_BYTES   = 0xFFFFFFFE;
export const ZIP_MAX_ENTRIES = 0xFFFE;

function toDosTime(d = new Date()) {
    const time = ((d.getHours() & 0x1F) << 11)
               | ((d.getMinutes() & 0x3F) << 5)
               | ((Math.floor(d.getSeconds() / 2)) & 0x1F);
    const date = (((d.getFullYear() - 1980) & 0x7F) << 9)
               | (((d.getMonth() + 1) & 0x0F) << 5)
               | (d.getDate() & 0x1F);
    return { time, date };
}

function utf8Buf(s) { return Buffer.from(String(s), 'utf8'); }

/**
 * Streaming ZIP writer.
 *
 *   const zip = new ZipStream();
 *   zip.pipe(res);
 *   await zip.addFile('/abs/path/to/a.mp4', 'a.mp4');
 *   await zip.addFile('/abs/path/to/b.jpg', 'sub/b.jpg');
 *   zip.finalize();
 *
 * `addFile` returns a promise that resolves once the file's bytes have
 * been pushed; the caller awaits each call sequentially so the ZIP is
 * single-stream by construction (parallelism would interleave bytes).
 */
export class ZipStream {
    constructor() {
        this._sink = null;        // Writable to pipe into
        this._offset = 0;         // bytes emitted so far
        this._central = [];       // central-directory records
        this._finalized = false;
    }

    pipe(writable) {
        this._sink = writable;
        return writable;
    }

    _write(buf) {
        if (!this._sink) throw new Error('ZipStream: pipe(target) before adding entries');
        this._offset += buf.length;
        return new Promise((resolve, reject) => {
            const ok = this._sink.write(buf, (err) => {
                if (err) reject(err);
                else if (ok) resolve();
            });
            if (!ok) {
                // honour backpressure
                this._sink.once('drain', resolve);
            }
        });
    }

    async addFile(absPath, archiveName) {
        if (this._finalized) throw new Error('ZipStream: already finalized');
        if (this._central.length >= ZIP_MAX_ENTRIES) {
            throw new Error(`ZipStream: too many entries (cap ${ZIP_MAX_ENTRIES})`);
        }
        const st = await stat(absPath);
        if (st.size > ZIP_MAX_BYTES) {
            throw new Error('ZipStream: file too large for non-zip64 archive');
        }
        const nameBuf = utf8Buf(archiveName.replace(/\\/g, '/'));
        const { time, date } = toDosTime(st.mtime || new Date());
        const localHeaderOffset = this._offset;

        // CRC32 + size aren't known yet — emit a local header with zeros
        // and the data-descriptor flag (bit 3) so the trailing 16 bytes
        // carry the real CRC + sizes. Avoids buffering the whole file.
        const flags = FLAG_UTF8 | 0x0008;
        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(SIG_LOCAL_FILE, 0);
        localHeader.writeUInt16LE(VERSION_NEEDED, 4);
        localHeader.writeUInt16LE(flags, 6);
        localHeader.writeUInt16LE(STORE, 8);
        localHeader.writeUInt16LE(time, 10);
        localHeader.writeUInt16LE(date, 12);
        localHeader.writeUInt32LE(0, 14);          // crc32 placeholder
        localHeader.writeUInt32LE(0, 18);          // compressed size placeholder
        localHeader.writeUInt32LE(0, 22);          // uncompressed size placeholder
        localHeader.writeUInt16LE(nameBuf.length, 26);
        localHeader.writeUInt16LE(0, 28);          // extra-field length
        await this._write(localHeader);
        await this._write(nameBuf);

        // Stream the file bytes, accumulate CRC32 + actual size. We
        // compute CRC32 in JS via the precomputed table at the bottom
        // of this file — sized in microseconds for our payloads, no
        // native binding needed.
        let crc = 0;
        let actualSize = 0;
        await new Promise((resolve, reject) => {
            const rs = createReadStream(absPath);
            rs.on('error', reject);
            rs.on('data', (chunk) => {
                actualSize += chunk.length;
                crc = _crc32Update(crc, chunk);
                // Same backpressure-aware write as _write but inline so
                // the file stream doesn't get ahead of the response sink.
                const ok = this._sink.write(chunk);
                this._offset += chunk.length;
                if (!ok) {
                    rs.pause();
                    this._sink.once('drain', () => rs.resume());
                }
            });
            rs.on('end', resolve);
        });

        // Data descriptor (we used flag 0x0008 in the header).
        const desc = Buffer.alloc(16);
        desc.writeUInt32LE(0x08074b50, 0);
        desc.writeUInt32LE(crc >>> 0, 4);
        desc.writeUInt32LE(actualSize, 8);
        desc.writeUInt32LE(actualSize, 12);
        await this._write(desc);

        this._central.push({
            nameBuf,
            crc: crc >>> 0,
            size: actualSize,
            time,
            date,
            localHeaderOffset,
            flags,
        });
    }

    async finalize() {
        if (this._finalized) return;
        this._finalized = true;
        const cdStart = this._offset;
        for (const e of this._central) {
            const buf = Buffer.alloc(46);
            buf.writeUInt32LE(SIG_CENTRAL_FILE, 0);
            buf.writeUInt16LE(VERSION_MADE_BY, 4);
            buf.writeUInt16LE(VERSION_NEEDED, 6);
            buf.writeUInt16LE(e.flags, 8);
            buf.writeUInt16LE(STORE, 10);
            buf.writeUInt16LE(e.time, 12);
            buf.writeUInt16LE(e.date, 14);
            buf.writeUInt32LE(e.crc, 16);
            buf.writeUInt32LE(e.size, 20);
            buf.writeUInt32LE(e.size, 24);
            buf.writeUInt16LE(e.nameBuf.length, 28);
            buf.writeUInt16LE(0, 30);    // extra
            buf.writeUInt16LE(0, 32);    // comment
            buf.writeUInt16LE(0, 34);    // disk
            buf.writeUInt16LE(0, 36);    // internal attrs
            buf.writeUInt32LE(0, 38);    // external attrs
            buf.writeUInt32LE(e.localHeaderOffset, 42);
            await this._write(buf);
            await this._write(e.nameBuf);
        }
        const cdEnd = this._offset;
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(SIG_END_OF_CENTRAL, 0);
        eocd.writeUInt16LE(0, 4);                    // disk number
        eocd.writeUInt16LE(0, 6);                    // disk where CD starts
        eocd.writeUInt16LE(this._central.length, 8);
        eocd.writeUInt16LE(this._central.length, 10);
        eocd.writeUInt32LE(cdEnd - cdStart, 12);
        eocd.writeUInt32LE(cdStart, 16);
        eocd.writeUInt16LE(0, 20);                   // archive comment length
        await this._write(eocd);
        if (this._sink && typeof this._sink.end === 'function') {
            this._sink.end();
        }
    }
}

// CRC-32 (IEEE 802.3 / PKZIP). We compute it on the fly because the
// Node `crypto` module doesn't expose CRC-32 directly across all
// supported versions.
const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        t[i] = c;
    }
    return t;
})();

function _crc32Update(prev, buf) {
    let c = (prev ^ 0xFFFFFFFF) | 0;
    for (let i = 0; i < buf.length; i++) {
        c = (CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)) | 0;
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Sanitise a string into a safe in-archive filename. Strips path
 * separators (the caller decides folder structure), control bytes, and
 * any leading dots ("..") so an extracted archive can never escape its
 * destination folder.
 */
export function safeArchiveName(s, fallback = 'file') {
    let n = String(s || fallback)
        .replace(/[\x00-\x1f]/g, '')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/^\.+/, '');
    if (!n) n = fallback;
    if (n.length > 200) n = n.slice(0, 200);
    return n;
}
