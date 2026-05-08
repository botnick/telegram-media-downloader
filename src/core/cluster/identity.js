/**
 * Cluster identity bootstrap.
 *
 * Each running instance owns three identity blobs in the kv store:
 *
 *   peer_id       — UUIDv4, generated once on first boot, never changes.
 *                   Identifies this instance across pairings; remote peers
 *                   record it in their `peers.peer_id` column.
 *
 *   peer_name     — Operator-editable display label (defaults to the
 *                   machine's hostname). Shown in peer-switcher dropdowns
 *                   + maintenance UI. Not security-relevant.
 *
 *   cluster_token — 32-byte hex secret. Both sides of a pairing must hold
 *                   the same value (it's the HMAC key for every signed
 *                   request). Generated lazily on first reveal/rotate.
 *
 * Token rotation invalidates every paired peer until they re-pair against
 * the new value. Callers should warn the operator before triggering it.
 */

import crypto from 'crypto';
import os from 'os';
import { kvGet, kvSet } from '../db.js';

const KV_PEER_ID = 'peer_id';
const KV_PEER_NAME = 'peer_name';
const KV_CLUSTER_TOKEN = 'cluster_token';

/**
 * Return this instance's UUID, generating + persisting one on first call.
 * Idempotent: subsequent calls return the same value.
 */
export function getSelfPeerId() {
    let id = kvGet(KV_PEER_ID);
    if (typeof id === 'string' && /^[0-9a-f-]{32,}$/i.test(id)) return id;
    id = crypto.randomUUID();
    kvSet(KV_PEER_ID, id);
    return id;
}

export function getSelfPeerName() {
    const v = kvGet(KV_PEER_NAME);
    if (typeof v === 'string' && v.trim()) return v.trim();
    // Hostname is a sensible default — operator can rename anytime.
    let host;
    try {
        host = os.hostname() || 'tgdl-peer';
    } catch {
        host = 'tgdl-peer';
    }
    return host.slice(0, 64);
}

export function setSelfPeerName(name) {
    const clean = String(name || '')
        .trim()
        .slice(0, 64);
    if (!clean) throw new Error('peer name must be non-empty');
    kvSet(KV_PEER_NAME, clean);
    return clean;
}

/**
 * Returns the cluster-shared HMAC token. Lazily generates one on first
 * read so a fresh install has identity ready before the operator opens
 * Settings → Cluster.
 */
export function getClusterToken() {
    let t = kvGet(KV_CLUSTER_TOKEN);
    if (typeof t === 'string' && /^[0-9a-f]{32,}$/i.test(t)) return t;
    t = crypto.randomBytes(32).toString('hex');
    kvSet(KV_CLUSTER_TOKEN, t);
    return t;
}

/**
 * Generate a new token and replace the stored one. Returns the new value.
 * Caller is responsible for warning the operator that all paired peers
 * must re-pair against the rotated token.
 */
export function rotateClusterToken() {
    const t = crypto.randomBytes(32).toString('hex');
    kvSet(KV_CLUSTER_TOKEN, t);
    return t;
}

/**
 * Replace the cluster token with an externally-supplied value — used when
 * an operator joins this peer to an existing cluster (paste the token
 * from any peer already in the cluster). Validates 32+ hex chars.
 *
 * Same blast radius as rotation: every peer paired against the OLD token
 * must re-pair after the swap.
 */
export function setClusterToken(token) {
    const clean = String(token || '')
        .trim()
        .toLowerCase();
    if (!/^[0-9a-f]{32,}$/.test(clean)) {
        throw new Error('cluster token must be 32+ hex chars');
    }
    kvSet(KV_CLUSTER_TOKEN, clean);
    return clean;
}

/**
 * Stable per-pair fingerprint — hex(sha256(token + peerId)). Used as a
 * sanity check by the UI: if a re-pair attempt produces a different
 * fingerprint than last time, either the remote peer was reinstalled
 * (different peer_id) or the token was rotated on one side.
 */
export function fingerprintFor(peerId, token = null) {
    const tok = token || getClusterToken();
    return crypto
        .createHash('sha256')
        .update(tok + ':' + String(peerId))
        .digest('hex');
}

/**
 * Convenience snapshot for /api/cluster/identity. Exposes everything safe
 * to send to the dashboard EXCEPT the cluster token itself — that's
 * fetched separately via /api/cluster/identity/token (admin-only) so it
 * never lands in routine UI fetches / logs / browser caches.
 */
export function getSelfIdentity() {
    return {
        peerId: getSelfPeerId(),
        name: getSelfPeerName(),
    };
}

// ---- Pairing codes (v2.10) -----------------------------------------------
//
// Replaces the v2.9 "paste cluster token in both peers" flow. The
// receiving peer issues a short, human-typable code that's valid for
// PAIRING_TTL_MS; the initiator pastes URL + code, and the handshake
// derives a per-pair secret from it. Codes are single-use — they're
// cleared as soon as a handshake consumes one.
//
// Codes are HMAC-derived from the cluster token + a fresh nonce so they
// can't be brute-forced offline. Persisted in kv['pairing_codes'] as a
// map keyed by the code itself; sweep on every issue/consume to drop
// expired entries.

const PAIRING_TTL_MS = 5 * 60 * 1000;
const KV_PAIRING_CODES = 'pairing_codes';
const CODE_ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // base32-ish, no I/O

function _readCodes() {
    return kvGet(KV_PAIRING_CODES) || {};
}
function _writeCodes(map) {
    kvSet(KV_PAIRING_CODES, map || {});
}
function _sweepCodes(map) {
    const now = Date.now();
    let dirty = false;
    for (const k of Object.keys(map)) {
        if (!map[k]?.expiresAt || map[k].expiresAt < now) {
            delete map[k];
            dirty = true;
        }
    }
    return dirty;
}

function _generateCode() {
    let s = '';
    const buf = crypto.randomBytes(8);
    for (const b of buf) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
    return s;
}

/**
 * Issue a fresh pairing code on this (receiving) peer. The returned
 * code is shown to the operator to dictate to whoever is on the other
 * peer. The pre-shared `secret` is derived deterministically from the
 * code + cluster token so the initiator can sign the handshake without
 * the receiver having to remember the secret separately.
 *
 * Returns: { code, expiresAt, secret }. Caller must NOT persist the
 * secret outside the kv (it lives in pairing_codes until consumed).
 */
export function issuePairingCode() {
    const code = _generateCode();
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    // Derive a 32-byte hex secret from cluster_token + code so the same
    // (token, code) pair always derives the same secret — this lets the
    // initiator sign the handshake with their copy of the code BEFORE
    // we ever exchange a "real" shared_secret.
    const secret = crypto
        .createHmac('sha256', getClusterToken())
        .update('pairing:' + code)
        .digest('hex');
    const map = _readCodes();
    _sweepCodes(map);
    map[code] = { expiresAt, secret };
    _writeCodes(map);
    return { code, expiresAt, secret };
}

/**
 * Verify + consume a pairing code at the receiving peer. Used by the
 * inbound handshake handler.
 *
 * Returns the matching `{secret}` on success, null if expired/missing.
 * The code is removed from kv on success (single-use).
 */
export function consumePairingCode(code) {
    if (!code || typeof code !== 'string') return null;
    const map = _readCodes();
    _sweepCodes(map);
    const entry = map[code.toUpperCase()];
    if (!entry) {
        if (_sweepCodes(map)) _writeCodes(map);
        return null;
    }
    if (entry.expiresAt < Date.now()) {
        delete map[code.toUpperCase()];
        _writeCodes(map);
        return null;
    }
    delete map[code.toUpperCase()];
    _writeCodes(map);
    return { secret: entry.secret };
}

/**
 * Initiator-side: derive the same secret the receiver will derive from
 * a given code + the SHARED cluster token. Until per-peer tokens are
 * universal, both peers must hold the same `cluster_token`. The
 * pairing-code path simply reuses whatever the operator currently has;
 * fresh installs auto-generate one and "Use cluster's token" lets them
 * sync to an existing cluster.
 */
export function deriveSecretFromPairingCode(code) {
    return crypto
        .createHmac('sha256', getClusterToken())
        .update('pairing:' + String(code).toUpperCase())
        .digest('hex');
}
