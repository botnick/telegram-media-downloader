#!/usr/bin/env node
/**
 * Write core-service/internal/front/testdata/conformance.json: inputs and
 * the answers the real Node libraries give (range-parser, fresh, Express's
 * trust proxy + req.protocol, send's MIME lookup, qs, the app's cookie
 * middleware and verifyFileToken). The Go tests (conformance_test.go) run
 * the front server's ports over the same inputs and must agree wherever
 * they claim certainty.
 *
 *   node scripts/gen-front-conformance.js          write
 *   node scripts/gen-front-conformance.js --check  exit 1 when out of date
 */

import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const REPO = path.resolve(import.meta.dirname, '..');
const OUT = path.join(REPO, 'core-service', 'internal', 'front', 'testdata', 'conformance.json');

const expressRequire = createRequire(require.resolve('express'));
const rangeParser = expressRequire('range-parser');
const fresh = expressRequire('fresh');
const send = expressRequire('send');
const qs = expressRequire('qs');
const { compileTrust } = expressRequire('./lib/utils.js');
const expressRequest = expressRequire('./lib/request.js');

const SHARE_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

function ranges() {
    const headers = [
        'bytes=0-0',
        'bytes=0-99',
        'bytes=-500',
        'bytes=1000-',
        'bytes=0-1,5-9',
        'bytes=0-99,100-199',
        'bytes=5-10,0-6',
        'bytes=0-4,2-3',
        'bytes=999999-',
        'bytes=abc',
        'bytes= 10-20x',
        'bytes=-0',
        'bytes=-',
        'bytes=5-2',
        'bytes=0-99999999999999999999',
        'bytes=-99999',
        'bytes=5-10-20',
        'bytes=,0-5',
        'bytes=0-5,',
        'bytes=+5-10',
        'bytes=-5-',
        'bytes=0x10-20',
        'bytes=1e3-2000',
        'items=0-5',
    ];
    const out = [];
    for (const size of [0, 1, 100, 262144]) {
        for (const h of headers) {
            const r = rangeParser(size, h, { combine: true });
            out.push({
                size,
                header: h,
                result: typeof r === 'number' ? r : r.map(({ start, end }) => [start, end]),
            });
        }
    }
    return out;
}

function trust() {
    const settings = [
        'loopback',
        '',
        '1',
        '0',
        '2',
        '10.0.0.0/8',
        'uniquelocal',
        'linklocal, loopback',
        '192.168.1.0/255.255.255.0',
        '::1',
        '::ffff:127.0.0.1',
        'fe80::/10',
        '172.16.0.0/12,2001:db8::/32',
    ];
    const addrs = [
        '127.0.0.1',
        '::ffff:127.0.0.1',
        '::1',
        '10.1.2.3',
        '::ffff:10.1.2.3',
        '192.168.1.7',
        '::ffff:192.168.1.7',
        'fe80::1',
        '203.0.113.9',
        '::ffff:203.0.113.9',
        '2001:db8::1',
        '172.20.0.5',
    ];
    const protoGetter = Object.getOwnPropertyDescriptor(expressRequest, 'protocol').get;
    const out = [];
    for (const setting of settings) {
        // server.js: /^\d+$/ → number, '' → Express's default (false).
        const value = setting === '' ? false : /^\d+$/.test(setting) ? Number(setting) : setting;
        const fn = compileTrust(value);
        for (const addr of addrs) {
            const protocols = {};
            for (const xfp of ['', 'https', 'https, http', ' HTTPS ']) {
                const sock = { remoteAddress: addr, encrypted: false };
                const fake = {
                    connection: sock,
                    socket: sock,
                    app: { get: () => fn },
                    get: (n) => (n.toLowerCase() === 'x-forwarded-proto' ? xfp : undefined),
                };
                protocols[xfp] = protoGetter.call(fake);
            }
            out.push({ setting, addr, trusted: fn(addr, 0), protocols });
        }
    }
    return out;
}

function freshCases() {
    const etag = 'W/"40000-18f4cbb3823"';
    const lm = 'Mon, 06 May 2024 07:08:09 GMT';
    const req = [
        { 'if-none-match': etag },
        { 'if-none-match': '"40000-18f4cbb3823"' },
        { 'if-none-match': `"x", ${etag}` },
        { 'if-none-match': '"other"' },
        { 'if-none-match': '*' },
        { 'if-none-match': etag, 'cache-control': 'no-cache' },
        { 'if-none-match': etag, 'cache-control': 'max-age=0, no-cache' },
        { 'if-none-match': etag, 'cache-control': 'no-cache-x' },
        { 'if-modified-since': lm },
        { 'if-modified-since': 'Mon, 06 May 2024 07:08:08 GMT' },
        { 'if-modified-since': 'Mon, 06 May 2024 07:08:10 GMT' },
        { 'if-none-match': etag, 'if-modified-since': 'Mon, 06 May 2024 07:08:08 GMT' },
        { 'if-none-match': '"other"', 'if-modified-since': lm },
    ];
    return req.map((h) => ({
        req: h,
        res: { etag, 'last-modified': lm },
        fresh: fresh(h, { etag, 'last-modified': lm }),
    }));
}

function mime() {
    const paths = [
        '/d/a.mp4',
        '/d/a.MKV',
        'C:\\d\\a.webm',
        '/d/a.heic',
        '/d/a.opus',
        '/d/a.txt',
        '/d/a.html',
        '/d/a.json',
        '/d/a.js',
        '/d/a.webp',
        '/d/a.jpg',
        '/d/a.jpeg',
        '/d/a.png',
        '/d/a.gif',
        '/d/a.mov',
        '/d/a.m4a',
        '/d/a.mp3',
        '/d/a.pdf',
        '/d/a.zip',
        '/d/noext',
        '/d/json',
        '/d/.hidden',
        '/d/a.tar.gz',
        '/d/a.unknownext',
        '/d/a.',
    ];
    return paths.map((p) => {
        const t = send.mime.lookup(p);
        const cs = send.mime.charsets.lookup(t);
        return { path: p, type: t + (cs ? `; charset=${cs}` : '') };
    });
}

function names() {
    return [
        'clip.mp4',
        'ünï 名 photo.jpg',
        'emoji 😀.png',
        'quote " and \\ back.txt',
        "it's (1) ~!*.jpg",
        'tab\tname.bin',
        'a+b=c&d.mp4',
        '100%.png',
    ].map((n) => ({
        name: n,
        ascii: n.replace(/[^\x20-\x7e]/g, '_'),
        encoded: encodeURIComponent(n),
    }));
}

function queries() {
    const list = [
        '',
        'inline=1',
        'inline=1&token=abc.def',
        'token=abc.def&token=x',
        'token=a&token[]=b',
        'token[]=a',
        'token=%61bc',
        'token=a+b',
        'inline=1&inline=1',
        'inline=%31',
        'peer=',
        'peer=x',
        'a=1;b=2',
        'a=%ZZ&token=x',
        'token',
        'token=',
        '=x&token=y',
        'token=a&&inline=1',
    ];
    return list.map((q) => {
        const v = qs.parse(q, { allowPrototypes: true });
        const str = (k) => (typeof v[k] === 'string' ? v[k] : null);
        return {
            query: q,
            token: str('token'),
            inline: str('inline'),
            peerTruthy: Boolean(v.peer),
        };
    });
}

// The cookie middleware in src/web/server.js, verbatim.
function cookieMiddleware(header) {
    const list = {};
    header.split(';').forEach((cookie) => {
        const parts = cookie.split('=');
        list[parts.shift().trim()] = decodeURI(parts.join('='));
    });
    return list;
}

function cookies() {
    const t = 'a'.repeat(64);
    const u = 'b'.repeat(64);
    const list = [
        `tg_dl_session=${t}`,
        `tg_dl_session=${t}; other=1`,
        `a=1; tg_dl_session=${t}`,
        ` tg_dl_session=${t} `,
        `tg_dl_session=${t}; tg_dl_session=${u}`,
        `tg_dl_session=${t}=x`,
        `tg_dl_session`,
        `other=%E0%A4%A; tg_dl_session=${t}`,
        `tg_dl_session=%61${t.slice(1)}`,
        `x=y`,
        ``,
        `tg_dl_session=;`,
    ];
    return list.map((h) => {
        let value = null;
        let error = false;
        try {
            const v = cookieMiddleware(h)['tg_dl_session'];
            value = typeof v === 'string' ? v : null;
        } catch {
            error = true;
        }
        return { header: h, value, error };
    });
}

async function fileTokens() {
    const share = await import('../src/core/share.js');
    share.ensureShareSecret({ web: { shareSecret: SHARE_SECRET } });
    const crypto = await import('crypto');
    const key = Buffer.from(SHARE_SECRET, 'hex');
    const sig = (p) => crypto.createHmac('sha256', key).update(p).digest('base64url');
    const exp = 4102444800; // 2100-01-01
    const past = 1000000000;
    const tokens = [
        `${exp}.${sig(`filetoken:admin|${exp}`)}`,
        `${exp}.${sig(`filetoken:guest|${exp}`)}`,
        `${exp}.${sig(`filetoken|${exp}`)}`,
        `${exp}.${sig(`filetoken:root|${exp}`)}`,
        `${past}.${sig(`filetoken:admin|${past}`)}`,
        `0${exp}.${sig(`filetoken:admin|${exp}`)}`,
        `${exp}.${sig(`filetoken:admin|${exp}`)}x`,
        `${exp}`,
        `.${sig(`filetoken:admin|${exp}`)}`,
        `${exp}.`,
        '',
    ];
    return {
        secret: SHARE_SECRET,
        cases: tokens.map((t) => ({ token: t, role: share.verifyFileToken(t) })),
    };
}

export async function render() {
    const doc = {
        note: 'Generated by scripts/gen-front-conformance.js from the Node libraries; do not edit.',
        ranges: ranges(),
        trust: trust(),
        fresh: freshCases(),
        mime: mime(),
        names: names(),
        queries: queries(),
        cookies: cookies(),
        fileTokens: await fileTokens(),
    };
    return `${JSON.stringify(doc, null, 1)}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
    const text = await render();
    if (process.argv.includes('--check')) {
        const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
        if (!cur || JSON.stringify(JSON.parse(cur)) !== JSON.stringify(JSON.parse(text))) {
            console.error(
                `${path.relative(REPO, OUT)} is out of date: run node scripts/gen-front-conformance.js`,
            );
            process.exit(1);
        }
        console.log('conformance table up to date');
    } else {
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.writeFileSync(OUT, text);
        console.log(`wrote ${path.relative(REPO, OUT)}`);
    }
}
