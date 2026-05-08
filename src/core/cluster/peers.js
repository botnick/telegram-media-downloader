/**
 * Higher-level peer registry — wraps the thin db.js accessors with
 * normalisation, validation, and convenience methods used by the cluster
 * subsystem (handshake, sync, proxy, sweep) + the API routes.
 *
 * Persistence lives in the `peers` table; this module is the only writer.
 */

import {
    listPeers as dbListPeers,
    getPeerByPeerId as dbGetPeerByPeerId,
    getPeerById as dbGetPeerById,
    upsertPeer as dbUpsertPeer,
    updatePeer as dbUpdatePeer,
    deletePeer as dbDeletePeer,
    markPeerSeen as dbMarkPeerSeen,
    setPeerSharedSecret as dbSetPeerSharedSecret,
    getPeerSharedSecret as dbGetPeerSharedSecret,
} from '../db.js';
import { getSelfPeerId, fingerprintFor } from './identity.js';
import crypto from 'crypto';

const URL_RE = /^https?:\/\/[^\s]+$/i;
const PEER_ID_RE = /^[0-9a-f-]{32,}$/i;

function normaliseUrl(url) {
    const s = String(url || '').trim();
    if (!URL_RE.test(s)) {
        throw new Error('peer URL must be http:// or https://');
    }
    return s.replace(/\/+$/, '');
}

function assertPeerId(peerId) {
    if (!PEER_ID_RE.test(String(peerId || ''))) {
        throw new Error('peer_id must be a UUID-like hex string');
    }
}

/**
 * List every paired remote peer. Self is NOT included — the caller can
 * splice in identity if it wants a "this+others" view.
 */
export function listPeers() {
    return dbListPeers().map(toPublic);
}

export function getPeer(peerId) {
    const r = dbGetPeerByPeerId(peerId);
    return r ? toPublic(r) : null;
}

export function getPeerByRowId(id) {
    const r = dbGetPeerById(id);
    return r ? toPublic(r) : null;
}

/**
 * Insert or update a peer record. Refuses to register self (would deadlock
 * sync + proxy resolvers). Caller must have already verified the
 * handshake signature against the cluster token.
 */
export function upsertPeer({
    peerId,
    name,
    url,
    fingerprint = null,
    version = null,
    streamMode = 'proxy',
    status = 'online',
    notes = null,
}) {
    assertPeerId(peerId);
    if (!name || !String(name).trim()) throw new Error('peer name required');
    const cleanUrl = normaliseUrl(url);
    if (peerId === getSelfPeerId()) {
        throw new Error('cannot pair with self');
    }
    const fp = fingerprint || fingerprintFor(peerId);
    return toPublic(
        dbUpsertPeer({
            peerId: String(peerId),
            name: String(name).trim().slice(0, 64),
            url: cleanUrl,
            fingerprint: String(fp),
            version,
            streamMode: streamMode === 'direct' ? 'direct' : 'proxy',
            status,
            notes,
        }),
    );
}

export function updatePeer(peerId, patch) {
    assertPeerId(peerId);
    if (patch.url !== undefined) patch.url = normaliseUrl(patch.url);
    if (patch.name !== undefined) {
        const n = String(patch.name).trim();
        if (!n) throw new Error('peer name must be non-empty');
        patch.name = n.slice(0, 64);
    }
    if (
        patch.streamMode !== undefined &&
        patch.streamMode !== 'proxy' &&
        patch.streamMode !== 'direct'
    ) {
        throw new Error('streamMode must be proxy or direct');
    }
    const r = dbUpdatePeer(peerId, patch);
    return r ? toPublic(r) : null;
}

export function removePeer(peerId) {
    assertPeerId(peerId);
    return dbDeletePeer(peerId);
}

export function markOnline(peerId) {
    return dbMarkPeerSeen(peerId, 'online');
}

export function markOffline(peerId) {
    return dbMarkPeerSeen(peerId, 'offline');
}

/**
 * Generate a fresh per-pair shared secret (32 bytes hex). Caller is
 * responsible for sending it to the other side over the (already-
 * authenticated) handshake response.
 */
export function generateSharedSecret() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * Persist a per-pair shared secret on the local peer row. Called after
 * a successful handshake by both sides — they each store the SAME
 * value as the secret keyed by the OTHER peer's id.
 */
export function setSharedSecret(peerId, secret) {
    assertPeerId(peerId);
    if (!secret || !/^[0-9a-f]{32,}$/i.test(secret)) {
        throw new Error('shared secret must be 32+ hex chars');
    }
    return dbSetPeerSharedSecret(peerId, secret);
}

export function getSharedSecret(peerId) {
    if (!peerId) return null;
    const buf = dbGetPeerSharedSecret(peerId);
    if (!buf) return null;
    return Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
}

/**
 * Map the raw DB row to the shape API consumers expect (camelCase, no
 * leaked column names). Keeps the table schema free to evolve.
 */
function toPublic(row) {
    if (!row) return null;
    return {
        id: row.id,
        peerId: row.peer_id,
        name: row.name,
        url: row.url,
        status: row.status,
        streamMode: row.stream_mode,
        lastSeenAt: row.last_seen_at,
        wsLastSeen: row.ws_last_seen ?? null,
        pairedAt: row.paired_at,
        fingerprint: row.fingerprint,
        version: row.version,
        notes: row.notes,
        role: row.role || 'admin',
        // shared_secret intentionally not surfaced — never echo to API
        migrationRequired: row.shared_secret == null,
    };
}
