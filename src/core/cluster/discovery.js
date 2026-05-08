/**
 * LAN auto-discovery — Phase C (v2.10).
 *
 * Each running peer binds a UDP socket on a fixed port and broadcasts
 * its identity every 30s. Other peers on the same LAN receive the
 * beacon and surface it in `peer_discoveries` (5-min TTL). The
 * dashboard's Cluster page lists discovered peers and offers one-click
 * **Pair** (which redirects to the existing pairing-code wizard with
 * the URL pre-filled).
 *
 * Drive-by spam is filtered with a 16-byte "discovery key" derived
 * from the cluster_token — any peer broadcasting must hold the same
 * cluster_token for the broadcast to be accepted. Until per-peer
 * tokens land everywhere this is good enough; adversaries on a
 * shared LAN already see the beacon URL anyway, so the privacy bar is
 * "no auto-pair from random hosts".
 *
 * No external deps — only Node's built-in `dgram`. The optional
 * `bonjour-service` add-on can be installed later for proper mDNS;
 * this module falls back gracefully if it's not present.
 */

import dgram from 'dgram';
import crypto from 'crypto';
import { getSelfPeerId, getSelfPeerName, getClusterToken } from './identity.js';
import { upsertPeerDiscovery, pruneDiscoveredPeers, recordClusterAudit } from '../db.js';

const MAGIC = 'TGDL-CLUSTER';
const DEFAULT_PORT = 28910;
const BROADCAST_INTERVAL_MS = 30_000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const PROTOCOL_VERSION = 1;

let _socket = null;
let _broadcastTimer = null;
let _sweepTimer = null;
let _selfUrl = null;
let _enabled = false;

function _hashSecret() {
    // 8-byte LAN-discovery key — first 8 bytes of HMAC(token, 'discovery').
    // Filters drive-by spam without needing a second secret.
    return crypto
        .createHmac('sha256', getClusterToken())
        .update('discovery')
        .digest('hex')
        .slice(0, 16);
}

function _packBeacon() {
    return Buffer.from(
        JSON.stringify({
            magic: MAGIC,
            version: PROTOCOL_VERSION,
            peer_id: getSelfPeerId(),
            name: getSelfPeerName(),
            url: _selfUrl,
            secret: _hashSecret(),
            ts: Date.now(),
        }),
    );
}

function _parseBeacon(buf) {
    try {
        const obj = JSON.parse(buf.toString('utf8'));
        if (obj?.magic !== MAGIC) return null;
        if (obj?.secret !== _hashSecret()) return null;
        if (typeof obj?.peer_id !== 'string' || typeof obj?.url !== 'string') return null;
        return obj;
    } catch {
        return null;
    }
}

/**
 * Start the discovery agent. `selfUrl` is "what URL should other peers
 * use to reach me" — server.js infers this from `PUBLIC_URL` env or
 * falls back to the bound port.
 */
export function startDiscovery({ selfUrl, port = DEFAULT_PORT } = {}) {
    if (_enabled) return;
    _enabled = true;
    _selfUrl = selfUrl || null;
    _socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    _socket.on('error', (e) => {
        recordClusterAudit({ kind: 'discovery', ok: false, detail: `socket error: ${e?.message}` });
    });
    _socket.on('message', (msg, rinfo) => {
        const beacon = _parseBeacon(msg);
        if (!beacon) return;
        if (beacon.peer_id === getSelfPeerId()) return; // ignore own beacons
        try {
            upsertPeerDiscovery({
                peerId: beacon.peer_id,
                url: beacon.url,
                name: beacon.name || null,
                version: beacon.version != null ? String(beacon.version) : null,
                source: 'broadcast',
            });
        } catch {
            /* nothing */
        }
    });
    try {
        _socket.bind(port, () => {
            try {
                _socket.setBroadcast(true);
            } catch {
                /* nothing */
            }
        });
    } catch (e) {
        recordClusterAudit({ kind: 'discovery', ok: false, detail: `bind: ${e?.message}` });
        return;
    }
    const fire = () => {
        if (!_enabled || !_socket) return;
        try {
            const buf = _packBeacon();
            _socket.send(buf, 0, buf.length, port, '255.255.255.255');
        } catch {
            /* nothing */
        }
    };
    fire();
    _broadcastTimer = setInterval(fire, BROADCAST_INTERVAL_MS);
    if (typeof _broadcastTimer.unref === 'function') _broadcastTimer.unref();
    _sweepTimer = setInterval(() => {
        try {
            pruneDiscoveredPeers();
        } catch {
            /* nothing */
        }
    }, SWEEP_INTERVAL_MS);
    if (typeof _sweepTimer.unref === 'function') _sweepTimer.unref();
}

export function stopDiscovery() {
    _enabled = false;
    if (_broadcastTimer) clearInterval(_broadcastTimer);
    if (_sweepTimer) clearInterval(_sweepTimer);
    _broadcastTimer = null;
    _sweepTimer = null;
    if (_socket) {
        try {
            _socket.close();
        } catch {
            /* nothing */
        }
        _socket = null;
    }
}

/**
 * Test seam — directly inject a beacon (bypasses dgram). Returns true
 * if the beacon was accepted and persisted.
 */
export function _ingestBeaconForTests(buf) {
    const beacon = _parseBeacon(buf);
    if (!beacon || beacon.peer_id === getSelfPeerId()) return false;
    upsertPeerDiscovery({
        peerId: beacon.peer_id,
        url: beacon.url,
        name: beacon.name || null,
        version: beacon.version != null ? String(beacon.version) : null,
        source: 'broadcast',
    });
    return true;
}

export function _packBeaconForTests(selfUrlOverride = null) {
    if (selfUrlOverride !== null) _selfUrl = selfUrlOverride;
    return _packBeacon();
}
