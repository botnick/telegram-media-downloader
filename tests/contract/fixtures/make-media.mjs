#!/usr/bin/env node
// One-off generator for the committed media under tests/contract/fixtures/media.
// The seed copies these exact bytes, so re-running this script changes every
// hash in the goldens — only do it on purpose, then re-record.
//
// Needs sharp (app dependency) and ffmpeg on PATH.
// Usage: node tests/contract/fixtures/make-media.mjs

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import zlib from 'zlib';

const OUT = path.join(import.meta.dirname, 'media');
fs.mkdirSync(OUT, { recursive: true });

function svg(w, h, a, b, label) {
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/>
<circle cx="${w * 0.3}" cy="${h * 0.4}" r="${Math.min(w, h) * 0.18}" fill="#ffffff" opacity="0.6"/>
<rect x="${w * 0.55}" y="${h * 0.5}" width="${w * 0.3}" height="${h * 0.3}" fill="#000000" opacity="0.35"/>
<text x="10" y="${h - 12}" font-size="18" fill="#fff">${label}</text></svg>`);
}

const stills = [
    ['photo-a.jpg', 480, 320, '#1e3c72', '#f8b195', 'A', (s) => s.jpeg({ quality: 70 })],
    ['photo-b.jpg', 320, 480, '#ff6a88', '#2b1d3a', 'B', (s) => s.jpeg({ quality: 70 })],
    ['photo-c.png', 200, 200, '#96e6a1', '#0b2e20', 'C', (s) => s.png({ compressionLevel: 9 })],
    ['photo-d.webp', 400, 300, '#fbc2eb', '#23264f', 'D', (s) => s.webp({ quality: 60 })],
    ['photo-e.jpg', 640, 360, '#f8b500', '#6a3b2f', 'E', (s) => s.jpeg({ quality: 70 })],
    ['photo-f.jpg', 360, 360, '#a1c4fd', '#48c6ef', 'F', (s) => s.jpeg({ quality: 70 })],
    ['sprite.webp', 320, 60, '#333333', '#999999', 'sprite', (s) => s.webp({ quality: 50 })],
];
for (const [name, w, h, a, b, label, enc] of stills) {
    await enc(sharp(svg(w, h, a, b, label))).toFile(path.join(OUT, name));
}

// Two short H.264 clips: one with the moov atom up front (faststart), one
// with it at the end (what the faststart scan looks for).
const still = path.join(OUT, '_still.png');
await sharp(svg(160, 120, '#0f2027', '#2c5364', 'V'))
    .png()
    .toFile(still);
const ff = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
ff([
    '-loop',
    '1',
    '-i',
    still,
    '-t',
    '2',
    '-r',
    '10',
    '-vf',
    'format=yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '35',
    '-movflags',
    '+faststart',
    '-fflags',
    '+bitexact',
    '-map_metadata',
    '-1',
    path.join(OUT, 'clip-a.mp4'),
]);
ff([
    '-loop',
    '1',
    '-i',
    still,
    '-t',
    '1',
    '-r',
    '10',
    '-vf',
    'format=yuv420p,hflip',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '35',
    '-fflags',
    '+bitexact',
    '-map_metadata',
    '-1',
    path.join(OUT, 'clip-b.mp4'),
]);
fs.rmSync(still);

// Minimal one-page PDF.
const pdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<<>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 12 Tf 20 50 Td (contract fixture) Tj ET
endstream endobj
trailer<</Root 1 0 R>>
%%EOF
`;
fs.writeFileSync(path.join(OUT, 'doc-a.pdf'), pdf);
fs.writeFileSync(path.join(OUT, 'notes.txt'), 'Contract fixture text file.\nLine two.\n');

// Single-stream gzip (archive-list "single_stream" branch).
fs.writeFileSync(
    path.join(OUT, 'notes.txt.gz'),
    zlib.gzipSync(fs.readFileSync(path.join(OUT, 'notes.txt'))),
);

// Tiny stored (uncompressed) ZIP with two entries and a fixed DOS date.
function crc32(buf) {
    let c;
    let crc = 0xffffffff;
    for (const b of buf) {
        c = (crc ^ b) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function storedZip(files) {
    const local = [];
    const central = [];
    let offset = 0;
    const dosTime = 0;
    const dosDate = ((2024 - 1980) << 9) | (1 << 5) | 1;
    for (const [name, data] of files) {
        const n = Buffer.from(name);
        const crc = crc32(data);
        const h = Buffer.alloc(30);
        h.writeUInt32LE(0x04034b50, 0);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(0, 6);
        h.writeUInt16LE(0, 8);
        h.writeUInt16LE(dosTime, 10);
        h.writeUInt16LE(dosDate, 12);
        h.writeUInt32LE(crc, 14);
        h.writeUInt32LE(data.length, 18);
        h.writeUInt32LE(data.length, 22);
        h.writeUInt16LE(n.length, 26);
        h.writeUInt16LE(0, 28);
        local.push(h, n, data);
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0);
        c.writeUInt16LE(20, 4);
        c.writeUInt16LE(20, 6);
        c.writeUInt16LE(0, 8);
        c.writeUInt16LE(0, 10);
        c.writeUInt16LE(dosTime, 12);
        c.writeUInt16LE(dosDate, 14);
        c.writeUInt32LE(crc, 16);
        c.writeUInt32LE(data.length, 20);
        c.writeUInt32LE(data.length, 24);
        c.writeUInt16LE(n.length, 28);
        c.writeUInt32LE(offset, 42);
        central.push(c, n);
        offset += 30 + n.length + data.length;
    }
    const cd = Buffer.concat(central);
    const e = Buffer.alloc(22);
    e.writeUInt32LE(0x06054b50, 0);
    e.writeUInt16LE(files.length, 8);
    e.writeUInt16LE(files.length, 10);
    e.writeUInt32LE(cd.length, 12);
    e.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, cd, e]);
}
fs.writeFileSync(
    path.join(OUT, 'bundle.zip'),
    storedZip([
        ['readme.txt', Buffer.from('inside the zip\n')],
        ['sub/data.txt', Buffer.from('nested entry\n')],
    ]),
);
console.log(
    fs
        .readdirSync(OUT)
        .map((f) => `${f} ${fs.statSync(path.join(OUT, f)).size}`)
        .join('\n'),
);
