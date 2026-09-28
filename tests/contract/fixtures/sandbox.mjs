// Network sandbox for the Node target (loaded with `node --import`).
//
// Test-harness seam only — the app is not modified. It makes the machine
// look offline except for loopback, so runs are identical on a dev box, a
// CI runner and an air-gapped host:
//   - DNS: every name other than localhost fails with ENOTFOUND at once
//     (GitHub update check, sidecar/model downloads, fake backup hosts,
//     *.invalid peer URLs).
//   - TCP: connects to a non-loopback IP literal fail with ECONNREFUSED.
//   - UDP: cluster LAN discovery binds loopback and its broadcasts are
//     dropped, so parallel test servers (and real instances on the LAN)
//     never see each other.
// A Go target needs the equivalent from its environment (network
// namespace with only `lo`, or HTTP(S)_PROXY to a dead port) — see
// docs/GO-MIGRATION.md.

import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';

const isLoopbackName = (h) => {
    const s = String(h || '')
        .toLowerCase()
        .replace(/^\[|\]$/g, '');
    return s === 'localhost' || s === '::1' || s.startsWith('127.') || s === '0.0.0.0';
};

function notFound(host) {
    const e = new Error(`getaddrinfo ENOTFOUND ${host}`);
    e.code = 'ENOTFOUND';
    e.errno = -3008;
    e.syscall = 'getaddrinfo';
    e.hostname = host;
    return e;
}

const origLookup = dns.lookup;
dns.lookup = function sandboxLookup(host, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    if (!isLoopbackName(host) && !net.isIP(String(host || ''))) {
        process.nextTick(cb, notFound(host));
        return {};
    }
    return origLookup.call(this, host, options, callback);
};
const origPromisesLookup = dns.promises.lookup;
dns.promises.lookup = async function sandboxLookupP(host, options) {
    if (!isLoopbackName(host) && !net.isIP(String(host || ''))) throw notFound(host);
    return origPromisesLookup.call(this, host, options);
};
for (const fn of ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveSrv', 'resolveTxt']) {
    if (typeof dns[fn] === 'function') {
        dns[fn] = (host, ...rest) => {
            const cb = rest.pop();
            process.nextTick(cb, notFound(host));
        };
    }
    if (typeof dns.promises[fn] === 'function') {
        dns.promises[fn] = async (host) => {
            throw notFound(host);
        };
    }
}

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function sandboxConnect(...args) {
    const opts = args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : null;
    const host = opts ? opts.host : typeof args[1] === 'string' ? args[1] : null;
    if (host && net.isIP(host) && !isLoopbackName(host) && !opts?.path) {
        const e = new Error(`connect ECONNREFUSED ${host}`);
        e.code = 'ECONNREFUSED';
        e.errno = -4078;
        e.syscall = 'connect';
        e.address = host;
        process.nextTick(() => this.destroy(e));
        return this;
    }
    return origConnect.apply(this, args);
};

const origBind = dgram.Socket.prototype.bind;
dgram.Socket.prototype.bind = function sandboxBind(...args) {
    // bind() / bind(port, cb) / bind(port, address, cb) / bind(options, cb)
    if (args.length === 0 || typeof args[0] === 'function') {
        args.unshift(0, '127.0.0.1');
    } else if (args[0] && typeof args[0] === 'object') {
        args[0] = { ...args[0], address: '127.0.0.1' };
    } else if (typeof args[1] === 'string') {
        args[1] = '127.0.0.1';
    } else {
        args.splice(1, 0, '127.0.0.1');
    }
    return origBind.apply(this, args);
};
dgram.Socket.prototype.setBroadcast = function sandboxSetBroadcast() {};
const origSend = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function sandboxSend(...args) {
    const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
    const address = args.find((a, i) => i > 0 && typeof a === 'string');
    if (!isLoopbackName(address)) {
        if (cb) process.nextTick(cb, null, 0);
        return;
    }
    return origSend.apply(this, args);
};
