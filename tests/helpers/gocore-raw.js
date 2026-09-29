// A tgdl-core process of its own, spoken to over raw HTTP — for suites that
// test the binary itself (exact answers, allow-roots) rather than the
// app's client. Uses the binary the global setup picked (TGDL_CORE_BIN).

import { spawn } from 'child_process';
import http from 'http';
import path from 'path';
import readline from 'readline';

import { testCoreBin } from './gocore-bin.js';

export function requireCoreBin() {
    const bin = testCoreBin();
    if (!bin) {
        throw new Error(
            'tgdl-core is required for this suite: install Go 1.22+ (the test run builds it) or run `npm run build:core`',
        );
    }
    return bin;
}

/**
 * Start `tgdl-core serve` allowed to read `roots`.
 * @returns {Promise<{ addr: string, request: Function, post: Function, stop: Function }>}
 */
export function startRawCore(roots, extraEnv = {}) {
    const bin = requireCoreBin();
    return new Promise((resolve, reject) => {
        const child = spawn(bin, ['serve'], {
            env: {
                ...process.env,
                TGDL_CORE_TOKEN: 'raw-test-token',
                TGDL_CORE_ALLOW_ROOTS: roots
                    .map((r) => (process.platform === 'win32' && r.includes(';') ? `"${r}"` : r))
                    .join(path.delimiter),
                TGDL_CORE_WATCH_STDIN: '1',
                TGDL_CORE_LOG_LEVEL: 'warn',
                ...extraEnv,
            },
            stdio: ['pipe', 'pipe', 'inherit'],
            windowsHide: true,
        });
        const rl = readline.createInterface({ input: child.stdout });
        const timer = setTimeout(() => reject(new Error('tgdl-core did not start')), 15_000);
        child.on('exit', (code) => reject(new Error(`tgdl-core exited (${code})`)));
        rl.on('line', (line) => {
            let ev;
            try {
                ev = JSON.parse(line);
            } catch {
                return;
            }
            if (ev?.event !== 'listening') return;
            clearTimeout(timer);
            const [host, port] = ev.addr.split(':');
            const agent = new http.Agent({ keepAlive: true });
            const request = (method, p, body, headers = {}) =>
                new Promise((res, rej) => {
                    const data =
                        body === undefined
                            ? null
                            : Buffer.isBuffer(body)
                              ? body
                              : Buffer.from(JSON.stringify(body));
                    const req = http.request(
                        {
                            host,
                            port,
                            method,
                            path: p,
                            agent,
                            headers: {
                                'x-api-token': 'raw-test-token',
                                ...(data
                                    ? {
                                          'content-type': Buffer.isBuffer(body)
                                              ? 'application/octet-stream'
                                              : 'application/json',
                                          'content-length': data.length,
                                      }
                                    : {}),
                                ...headers,
                            },
                        },
                        (r) => {
                            const chunks = [];
                            r.on('data', (c) => chunks.push(c));
                            r.on('end', () => {
                                const text = Buffer.concat(chunks).toString('utf8');
                                let json = null;
                                try {
                                    json = JSON.parse(text);
                                } catch {}
                                res({ status: r.statusCode, headers: r.headers, text, json });
                            });
                        },
                    );
                    req.on('error', rej);
                    req.end(data || undefined);
                });
            resolve({
                addr: ev.addr,
                child,
                request,
                post: (p, body) => request('POST', p, body),
                stop: () => {
                    agent.destroy();
                    child.removeAllListeners('exit');
                    try {
                        child.stdin.end();
                    } catch {}
                    try {
                        child.kill();
                    } catch {}
                },
            });
        });
    });
}

/** NDJSON body → array of objects. */
export function ndjson(text) {
    return text
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
}
