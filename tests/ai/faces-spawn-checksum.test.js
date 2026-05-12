import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import http from 'http';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import {
    _parseChecksumFile,
    _hashFile,
    _verifyChecksum,
} from '../../src/core/ai/faces-download.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256hex(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

let server;
let baseUrl;
let serveContent = '';
let serveStatus = 200;

beforeAll(
    () =>
        new Promise((resolve) => {
            server = http.createServer((_req, res) => {
                res.writeHead(serveStatus, { 'content-type': 'text/plain' });
                res.end(serveStatus === 200 ? serveContent : '');
            });
            server.listen(0, '127.0.0.1', () => {
                const { port } = server.address();
                baseUrl = `http://127.0.0.1:${port}`;
                resolve();
            });
        }),
);

afterAll(() => new Promise((resolve) => server.close(resolve)));

// ---------------------------------------------------------------------------
// _parseChecksumFile
// ---------------------------------------------------------------------------

describe('_parseChecksumFile', () => {
    it('parses bare hex', async () => {
        const hex = 'a'.repeat(64);
        await expect(_parseChecksumFile(hex)).resolves.toBe(hex);
    });

    it('parses sha256sum format with filename', async () => {
        const hex = 'b'.repeat(64);
        await expect(_parseChecksumFile(`${hex}  tgdl-faces-linux-x64.tar.gz`)).resolves.toBe(hex);
    });

    it('normalises uppercase hex to lowercase', async () => {
        const upper = 'A'.repeat(64);
        await expect(_parseChecksumFile(upper)).resolves.toBe('a'.repeat(64));
    });

    it('rejects non-hex content', async () => {
        await expect(_parseChecksumFile('not-a-hash')).rejects.toThrow('invalid checksum');
    });

    it('rejects hex that is too short', async () => {
        await expect(_parseChecksumFile('abc123')).rejects.toThrow('invalid checksum');
    });
});

// ---------------------------------------------------------------------------
// _hashFile
// ---------------------------------------------------------------------------

describe('_hashFile', () => {
    it('returns SHA-256 hex of a known file', async () => {
        const content = Buffer.from('hello faces\n');
        const tmp = path.join(os.tmpdir(), `tgdl-test-hash-${Date.now()}.bin`);
        await fs.writeFile(tmp, content);
        try {
            const actual = await _hashFile(tmp);
            expect(actual).toBe(sha256hex(content));
        } finally {
            await fs.unlink(tmp).catch(() => {});
        }
    });

    it('rejects when file does not exist', async () => {
        await expect(_hashFile('/nonexistent/path/file.bin')).rejects.toThrow();
    });
});

// ---------------------------------------------------------------------------
// _verifyChecksum
// ---------------------------------------------------------------------------

describe('_verifyChecksum', () => {
    it('resolves when checksum matches', async () => {
        const content = Buffer.from('binary payload');
        const tmp = path.join(os.tmpdir(), `tgdl-test-verify-${Date.now()}.bin`);
        await fs.writeFile(tmp, content);
        serveStatus = 200;
        serveContent = sha256hex(content);
        try {
            await expect(_verifyChecksum(tmp, `${baseUrl}/file.tar.gz`)).resolves.toBeUndefined();
        } finally {
            await fs.unlink(tmp).catch(() => {});
        }
    });

    it('rejects when checksum does not match', async () => {
        const content = Buffer.from('binary payload');
        const tmp = path.join(os.tmpdir(), `tgdl-test-verify-${Date.now()}.bin`);
        await fs.writeFile(tmp, content);
        serveStatus = 200;
        serveContent = 'f'.repeat(64); // wrong hash
        try {
            await expect(_verifyChecksum(tmp, `${baseUrl}/file.tar.gz`)).rejects.toThrow(
                'checksum mismatch',
            );
        } finally {
            await fs.unlink(tmp).catch(() => {});
        }
    });

    it('rejects when checksum file returns 404', async () => {
        const content = Buffer.from('binary payload');
        const tmp = path.join(os.tmpdir(), `tgdl-test-verify-${Date.now()}.bin`);
        await fs.writeFile(tmp, content);
        serveStatus = 404;
        try {
            await expect(_verifyChecksum(tmp, `${baseUrl}/file.tar.gz`)).rejects.toThrow();
        } finally {
            await fs.unlink(tmp).catch(() => {});
        }
    });
});
