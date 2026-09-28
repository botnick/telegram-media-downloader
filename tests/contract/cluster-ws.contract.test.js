// /ws/cluster peer channel contract.
//
// Inbound: this test connects AS peer alpha (connect-time query
//   ?peer=<id>&ts=<ms>&sig=hex(HMAC(pair-secret, "connect|<ts>"))
// and sends signed messages
//   { type, payload, ts, sig: hex(HMAC(pair-secret, "<type>|<ts>|sha256(JSON(payload))")) }
// then records the dashboard WS events they cause.
//
// Outbound: alpha's URL points at a fake peer in this process. Once the
// node's cluster engines are started it dials the fake peer's /ws/cluster
// and pushes signed events (download_deleted, config_changed,
// failover_completed) that the fake peer records.
//
// The engines (and the dashboard relay of inbound events) only start when
// a request reaches the lazy `app.use('/api/cluster', …)` starter, which
// today only POST /api/cluster/failover/run (or an unknown /api/cluster
// path) does — so the first scenario records the channel BEFORE that.
//
// Recorded as { ws: 'cluster', sent, received, events } (see
// inventory.contract.test.js): `sent` = types pushed into /ws/cluster,
// `received` = what the fake peer got from the node, `events` = resulting
// dashboard events.

import crypto from 'crypto';
import http from 'http';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { SEED, sleep, until, useContract } from './harness.js';

const ALPHA = SEED.peers.alpha;
const BETA = SEED.peers.beta;
const G = SEED.groups;

// ---- fake peer (alpha's URL) -------------------------------------------------

const outbound = { connections: [], messages: [] };
const fakeHttp = http.createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"fake peer"}');
});
const fakeWss = new WebSocketServer({ noServer: true });
fakeHttp.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, 'http://x');
    const ts = u.searchParams.get('ts');
    const want = crypto
        .createHmac('sha256', ALPHA.sharedSecret)
        .update(`connect|${ts}`)
        .digest('hex');
    outbound.connections.push({
        path: u.pathname,
        peer: u.searchParams.get('peer'),
        connectSigValid: u.searchParams.get('sig') === want,
    });
    fakeWss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('message', (raw) => {
            try {
                outbound.messages.push(JSON.parse(raw.toString('utf8')));
            } catch {
                outbound.messages.push({ raw: raw.toString('utf8') });
            }
        });
    });
});
await new Promise((r) => fakeHttp.listen(0, '127.0.0.1', r));
const FAKE_URL = `http://127.0.0.1:${fakeHttp.address().port}`;

// ---- target -------------------------------------------------------------------

const h = useContract(import.meta.url, {
    configPatch: (cfg) => {
        // pollingInterval replicates to peers; Gamma Docs is owned by beta
        // with this node as its backup (failover candidate once beta has a
        // last-seen time older than the grace period).
        cfg.cluster = { failover_grace_minutes: 5, replicate: { pollingInterval: 'cluster' } };
        const g = cfg.groups.find((x) => x.id === G.gamma.id);
        g.ownerPeerId = BETA.peerId;
        g.backupPeerId = SEED.selfPeerId;
    },
    afterDb: (db) => {
        // Pair secrets are stored as the UTF-8 bytes of the hex string.
        db.prepare('UPDATE peers SET shared_secret = ?, url = ? WHERE peer_id = ?').run(
            Buffer.from(ALPHA.sharedSecret, 'utf8'),
            FAKE_URL,
            ALPHA.peerId,
        );
    },
});

// ---- signing helpers ------------------------------------------------------------

let lastTs = 0;
const nextTs = () => {
    lastTs = Math.max(Date.now(), lastTs + 1);
    return lastTs;
};

function connectPath({ peer = ALPHA.peerId, key = ALPHA.sharedSecret, ts = nextTs(), sig } = {}) {
    const s = sig ?? crypto.createHmac('sha256', key).update(`connect|${ts}`).digest('hex');
    return `/ws/cluster?peer=${encodeURIComponent(peer)}&ts=${ts}&sig=${s}`;
}

function signedMsg(type, payload, { key = ALPHA.sharedSecret, ts = nextTs() } = {}) {
    const ph = crypto
        .createHash('sha256')
        .update(JSON.stringify(payload || {}), 'utf8')
        .digest('hex');
    const sig = crypto.createHmac('sha256', key).update(`${type}|${ts}|${ph}`).digest('hex');
    return { type, payload, ts, sig };
}

function verifyOutbound(msg) {
    const ph = crypto
        .createHash('sha256')
        .update(JSON.stringify(msg.payload || {}), 'utf8')
        .digest('hex');
    return (
        msg.sig ===
        crypto
            .createHmac('sha256', ALPHA.sharedSecret)
            .update(`${msg.type}|${msg.ts}|${ph}`)
            .digest('hex')
    );
}

function peerSignHeaders(method, urlPath, raw) {
    const ts = nextTs();
    const bh = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
    const sig = crypto
        .createHmac('sha256', ALPHA.sharedSecret)
        .update(`${method}\n${urlPath}\n${ts}\n${bh}`)
        .digest('hex');
    return {
        'x-peer-id': ALPHA.peerId,
        'x-peer-ts': String(ts),
        'x-peer-signature': sig,
        'content-type': 'application/json',
    };
}

// Only the channel's own dashboard events (peer_status, peer_* updates,
// cluster_*) — ambient timers and logs are dropped.
const relevant = (list) =>
    list.filter((m) => !['monitor_status_push', 'stats_push', 'log'].includes(m.type));

/** Open a dashboard socket, return it drained. */
async function dashboard(t) {
    const ws = t.ws({ as: 'admin' });
    await ws.opened;
    ws.drain();
    return ws;
}

/** Open an inbound /ws/cluster connection as alpha. */
async function inbound(t) {
    const ws = t.ws({ path: connectPath(), cookie: '' });
    const r = await ws.opened;
    expect(r.open).toBe(true);
    return ws;
}

/**
 * Send one signed message and wait until the dashboard shows `expect`
 * events (or `settleMs` passes when none are expected).
 */
async function push(peerWs, dash, msg, expectCount = 1) {
    const before = relevant(dash.messages).length;
    peerWs.socket.send(JSON.stringify(msg));
    if (expectCount > 0) {
        await until(() => relevant(dash.messages).length >= before + expectCount, {
            what: `${expectCount} dashboard event(s) after ${msg.type}`,
            timeoutMs: 5000,
        });
    } else {
        await sleep(300);
    }
}

const ROW = (id, name) => ({
    id,
    group_id: '-1009000000001',
    group_name: 'Remote Chat',
    message_id: id,
    file_name: name,
    file_size: 1000 + id,
    file_type: 'photo',
    file_path: `Remote Chat/images/${name}`,
    file_hash: null,
    status: 'completed',
    created_at: '2024-08-01 10:00:00',
    nsfw_score: null,
});

describe('/ws/cluster connect-time auth', () => {
    it('refuses missing, forged, stale and unpaired credentials', async () => {
        const t = h.t;
        const tries = {
            noParams: '/ws/cluster',
            badSig: connectPath({ sig: 'ab'.repeat(32) }),
            staleTs: connectPath({ ts: Date.now() - 120_000 }),
            wrongKey: connectPath({ key: 'cd'.repeat(32) }),
            peerWithoutSecret: connectPath({ peer: BETA.peerId, key: SEED.clusterToken }),
            unknownPeer: connectPath({ peer: '00000000-0000-4000-8000-00000000dead' }),
            clusterTokenInsteadOfPairSecret: connectPath({ key: SEED.clusterToken }),
        };
        const upgrade = {};
        for (const [k, p] of Object.entries(tries)) {
            const ws = t.ws({ path: p, cookie: '' });
            const r = await ws.opened;
            upgrade[k] = r.open ? 'open' : r.status;
            ws.close();
        }
        const ok = t.ws({ path: connectPath(), cookie: '' });
        upgrade.validPairSecret = (await ok.opened).open ? 'open' : 'refused';
        ok.close();
        await sleep(200);
        t.store.record('upgrade by credentials', { ws: 'cluster', upgrade });
    });
});

describe('inbound events before the cluster engines start', () => {
    it('are applied to the DB but not relayed to the dashboard', async () => {
        const t = h.t;
        const dash = await dashboard(t);
        const peerWs = await inbound(t);
        await push(peerWs, dash, signedMsg('download_added', ROW(900, 'R_0900.jpg')), 0);
        await push(peerWs, dash, signedMsg('peer_status', { status: 'busy' }), 0);
        peerWs.close();
        await sleep(300);
        t.store.record('inbound before engine start', {
            ws: 'cluster',
            sent: ['download_added', 'peer_status'],
            received: [],
            events: relevant(dash.drain()).map((m) => t.norm.value(m)),
            note: 'the relay to dashboard clients is only wired by the lazy /api/cluster engine starter',
        });
        dash.close();
        await t.exchange(
            'peer catalog has the pushed row',
            'GET',
            `/api/cluster/downloads?peerId=${ALPHA.peerId}`,
        );
    });
});

describe('engines start; outbound connection to the paired peer', () => {
    it('failover/run starts them and the node dials alpha', async () => {
        const t = h.t;
        const dash = await dashboard(t);
        await t.exchange(
            'failover run (starts engines; beta never seen → nothing to take over)',
            'POST',
            '/api/cluster/failover/run',
        );
        await until(() => outbound.connections.length >= 1, { what: 'node dials the fake peer' });
        await until(() => relevant(dash.messages).some((m) => m.type === 'peer_status'), {
            what: 'peer_status online on the dashboard',
        });
        await sleep(200);
        t.store.record('outbound connect', {
            ws: 'cluster',
            sent: [],
            received: [],
            connections: outbound.connections,
            events: relevant(dash.drain()).map((m) => t.norm.value(m)),
        });
        dash.close();
    });
});

describe('inbound events once the engines run', () => {
    it('each accepted type and the dashboard events it causes', async () => {
        const t = h.t;
        const dash = await dashboard(t);
        const peerWs = await inbound(t);
        await until(() => relevant(dash.messages).length >= 1, {
            what: 'peer_status on inbound connect',
        });
        const connectEvents = relevant(dash.drain()).map((m) => t.norm.value(m));
        const steps = [];
        const step = async (label, msg, n) => {
            await push(peerWs, dash, msg, n);
            steps.push({
                step: label,
                sent: msg.type,
                events: relevant(dash.drain()).map((m) => t.norm.value(m)),
            });
        };
        await step('ping', signedMsg('ping', {}), 0);
        await step('download_added', signedMsg('download_added', ROW(901, 'R_0901.jpg')), 1);
        await step(
            'download_updated',
            signedMsg('download_updated', { ...ROW(901, 'R_0901b.jpg'), file_size: 4242 }),
            1,
        );
        await step('download_deleted', signedMsg('download_deleted', { remote_id: 901 }), 1);
        await step('download_deleted without remote_id', signedMsg('download_deleted', {}), 0);
        await step(
            'group_added',
            signedMsg('group_added', { groups: [{ id: '-1009000000001', name: 'Remote Chat' }] }),
            1,
        );
        await step('group_changed', signedMsg('group_changed', { groups: [] }), 1);
        await step('group_removed', signedMsg('group_removed', {}), 1);
        await step(
            'config_changed (local policy → skipped)',
            signedMsg('config_changed', {
                key: 'rescue',
                value: { enabled: true },
                ts: 1717200000000,
                peer_id: ALPHA.peerId,
            }),
            1,
        );
        await step(
            'config_changed (replicated key → applied)',
            signedMsg('config_changed', {
                key: 'pollingInterval',
                value: 42,
                ts: 1717200000000,
                peer_id: ALPHA.peerId,
            }),
            1,
        );
        await step(
            'config_changed (same ts again → skipped)',
            signedMsg('config_changed', {
                key: 'pollingInterval',
                value: 43,
                ts: 1717200000000,
                peer_id: ALPHA.peerId,
            }),
            1,
        );
        await step(
            'failover_requested',
            signedMsg('failover_requested', { group_id: G.beta.id }),
            1,
        );
        await step(
            'failover_completed',
            signedMsg('failover_completed', { group_id: G.beta.id }),
            1,
        );
        await step('peer_status', signedMsg('peer_status', { status: 'draining' }), 1);
        await step('unknown type → cluster_event', signedMsg('brand_new_event', { x: 1 }), 1);
        const replay = signedMsg('group_changed', { groups: [{ id: 'replayed' }] });
        await step('first delivery', replay, 1);
        await step('replayed signature → ignored', replay, 0);
        await step(
            'bad signature → ignored (audited)',
            { ...signedMsg('group_changed', { groups: [] }), sig: 'ab'.repeat(32) },
            0,
        );
        await step(
            'missing sig → ignored',
            { type: 'group_changed', payload: {}, ts: nextTs() },
            0,
        );
        peerWs.socket.send('not json');
        await sleep(200);
        peerWs.close();
        await until(() => relevant(dash.messages).some((m) => m.type === 'peer_status'), {
            what: 'peer_status offline on close',
        });
        const closeEvents = relevant(dash.drain()).map((m) => t.norm.value(m));
        t.store.record('inbound event relay', {
            ws: 'cluster',
            sent: [...new Set(steps.map((s) => s.sent))],
            received: [],
            connectEvents,
            steps,
            events: steps.flatMap((s) => s.events).concat(connectEvents, closeEvents),
            closeEvents,
        });
        dash.close();
        const cfg = await t.request('GET', '/api/config');
        t.store.record('config after replicated change (derived)', {
            derived: {
                pollingInterval: cfg.json.pollingInterval,
                rescueEnabled: cfg.json.rescue?.enabled,
            },
        });
        await t.exchange(
            'peer catalog after inbound events',
            'GET',
            `/api/cluster/downloads?peerId=${ALPHA.peerId}`,
        );
        await t.exchange('audit ws_event failures', 'GET', '/api/cluster/audit?kind=ws_event', {
            unordered: ['entries'],
        });
    });
});

describe('outbound events to the paired peer', () => {
    it('download_deleted, config_changed and failover_completed are pushed signed', async () => {
        const t = h.t;
        const dash = await dashboard(t);
        outbound.messages.length = 0;

        const raw = JSON.stringify({ remote_id: 12, reason: 'contract' });
        const del = await t.request('POST', '/api/cluster/files/delete', {
            as: 'anon',
            headers: peerSignHeaders('POST', '/api/cluster/files/delete', raw),
            body: raw,
        });
        expect(del.status).toBe(200);
        await until(() => outbound.messages.some((m) => m.type === 'download_deleted'), {
            what: 'download_deleted pushed to the peer',
        });

        await t.exchange('save a replicated config key', 'POST', '/api/config', {
            body: { pollingInterval: 11 },
        });
        await until(() => outbound.messages.some((m) => m.type === 'config_changed'), {
            what: 'config_changed pushed to the peer',
        });

        // Beta now has a last-seen time far in the past → Gamma Docs fails over.
        await t.exchange(
            'mark beta last seen long ago',
            'PUT',
            `/api/cluster/peers/${BETA.peerId}`,
            {
                body: { lastSeenAt: 1717200000000 },
            },
        );
        await t.exchange(
            'failover run (takes over Gamma Docs)',
            'POST',
            '/api/cluster/failover/run',
        );
        await until(() => outbound.messages.some((m) => m.type === 'failover_completed'), {
            what: 'failover_completed pushed to the peer',
        });
        await sleep(200);

        t.store.record('outbound event push', {
            ws: 'cluster',
            sent: [],
            received: outbound.messages.map((m) => ({
                ...t.norm.value(m),
                sigValid: verifyOutbound(m),
            })),
            events: relevant(dash.drain()).map((m) => t.norm.value(m)),
        });
        dash.close();
        await t.exchange('failover log after takeover', 'GET', '/api/cluster/failover-log');
        const cfg = await t.request('GET', '/api/config');
        const g = cfg.json.groups.find((x) => x.id === G.gamma.id);
        t.store.record('Gamma Docs ownership after failover (derived)', {
            derived: {
                ownerPeerId: g.ownerPeerId,
                backupPeerId: g.backupPeerId,
                failoverAtIsRecent: Math.abs(Date.now() - g.failoverAt) < 60_000,
            },
        });
    });
});
