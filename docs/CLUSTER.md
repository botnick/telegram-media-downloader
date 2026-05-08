# Cluster mode

> **v2.10** — per-peer tokens, real-time WS push, LAN auto-discovery,
> relay-through-peer, backup-peer failover, live config sync,
> cross-peer file delete, cluster-wide search. See
> [MIGRATION-v2.9-to-v2.10.md](MIGRATION-v2.9-to-v2.10.md) for re-pair
> instructions if you're upgrading.


Run multiple instances of the dashboard and federate them into a single
library. Each peer keeps its own download capacity and SQLite database;
the dashboard merges every paired peer's catalog into one gallery, with
a small peer-source badge on each row.

Use cluster mode when you want to:

- Spread a library across two or more machines (home NAS + VPS, etc.).
- Have one operator dashboard that controls every machine.
- Avoid downloading the same Telegram message twice when several peers
  watch the same group.
- Stream a file owned by peer B in your browser while you're sitting on
  peer A's URL — no SSH tunnels, no second login.

Cluster mode is **off by default**. Pairing is manual: you paste a URL
and a shared cluster token between any two peers. There is no public
discovery service.

## Concepts

| Term | Meaning |
|---|---|
| **peer** | A complete instance of this app — full dashboard, downloader, DB, downloads folder. |
| **peer_id** | UUIDv4 generated once on first boot. Persisted in `kv['peer_id']`. Never changes. |
| **cluster token** | 32-byte hex secret. Every peer in the cluster holds the **same** value (it's the HMAC key for cross-peer requests). Treat it like a password. |
| **paired peer** | A remote peer this instance has shaken hands with. Stored in the `peers` table. |
| **owner peer** | Optional per-group setting. Only the peer matching `groups[i].ownerPeerId` downloads the group's messages. Other peers see its catalog via sync but stay quiet on Telegram. |
| **bridge** | When you open a file owned by peer B from peer A's dashboard, A streams it through itself (proxy) or 302-redirects you to B (direct). Per-peer setting. |
| **stream mode** | `proxy` (default — A fetches and pipes to your browser; works behind any NAT) or `direct` (A redirects you to B; faster but needs B browser-reachable). |

## Setup

The first install in your cluster is the **founder**. Subsequent peers
**join** by adopting the founder's cluster token.

### 1. On the founder

Open `Maintenance → Cluster`. Click **Show token**, copy the value.

That value is your cluster's shared secret. Save it somewhere safe — a
password manager, sealed envelope, etc. You'll paste it into every other
peer.

### 2. On every other peer

Open `Maintenance → Cluster`. Click **Use cluster's token**, paste the
founder's token. The peer now signs cross-peer requests with the same
key as the founder.

### 3. Pair peers

On any peer, click **Add peer**. Paste the URL of the peer you want to
pair with (e.g. `https://b.example.com`) plus the cluster token. The
two peers complete a handshake and record each other.

Pair every peer with at least one other in the cluster — there's no
star/mesh enforcement, but unreachable peers can't sync.

### 4. (Optional) Assign group ownership

If you want a specific peer to be the only one downloading a given
group, edit the group and pick **Owner peer**. The other peers stop
watching that group on Telegram; they still see its files via the
cluster catalog + bridge.

If `Owner peer` is left blank, every peer that has the group enabled
will download it (with cross-peer dedup catching duplicates by hash).

The Group Settings modal → **Accounts** tab exposes both
`ownerPeerId` and `backupPeerId` as dropdowns whenever at least one
peer is paired. Pick a backup peer to enable automatic failover —
the backup takes over downloading if the owner stays silent past
`cluster.failover_grace_minutes` (default 5).

### 5. (Optional) Tune federation in Settings → Federation

Settings → Federation surfaces three cluster-wide knobs:

- **Replication policy** — segmented control per config key (`groups`,
  `accounts`, `web`, `download`, `rescue`). Picking **Cluster** mirrors
  every edit of that key to every paired peer (last-writer-wins).
  **Cluster (exclusive)** mirrors but lets receivers override locally.
  **Local** keeps the key on this peer only (default).
- **Failover grace window** — slider for `cluster.failover_grace_minutes`.
- **This peer summary** — read-only view of own peer ID + display name,
  with a deep-link to **Maintenance → Cluster** for token / pairing
  management (Settings is for cluster-wide config; the cluster page
  owns peer/identity actions).

Replication writes to `config.cluster.replicate.<key>`; the existing
`src/core/cluster/config-sync.js` already reads this map and broadcasts
`config_changed` events to peers, so toggling the segmented control
takes effect immediately without a restart.

## Federated gallery (Layer 1, v2.12+)

The main dashboard gallery is **opt-in federated**. By default each peer's
"All Media" / per-group view / search shows only that peer's files. A
small **scope chip** in the gallery header (admin-only, hidden when no
peers are paired) flips it to:

- **This peer** — local-only (default).
- **All peers** — UNIONs every paired peer's `peer_downloads`.
- **Per-peer** — narrows to a single peer's files.

State persists in `localStorage['tgdl-gallery-scope']`. Federated tiles
carry a "from {peer}" badge in grid mode (and a subtitle suffix in list
mode). The sidebar Downloaded Groups list also merges peer-owned groups
with the same badge; clicking a foreign group switches the scope to that
peer and opens the per-group view filtered to its files.

### Peer media routing

Peer-owned tiles route through the existing cluster bridge:

- **Thumbnails** → `/api/cluster/thumbs/:peerId/:remoteId?w=<N>` (cookie-
  authed browser proxy) → server signs an HMAC request to the peer's
  `/api/cluster/peer-thumbs/:remoteId` endpoint and streams the response.
  Offline peers return a 1×1 placeholder PNG with a 60 s cache so the
  console isn't spammed with 404s.
- **Full media** → `/files/<peerSidePath>?inline=1&peer=<peerId>`. The
  same `streamFromPeer` proxy + `requestSignedShareUrl` direct-mode fork
  the existing `_clusterref/` ghost rows already use.

### Backward compatibility

Every existing endpoint stays byte-identical for the local-only default —
the federation params (`?include=peers|all` and `?peer=<id>`) are opt-in.
Guest sessions are forced back to `local` server-side; federation is
admin-only on every surface.

## How it actually works

### Catalog sync

Every 30 seconds, each peer polls every other peer at `GET
/api/cluster/downloads/since?sinceId=<n>` and writes the rows it gets
back into its local `peer_downloads` table. The merged gallery view
unions own `downloads` with every peer's `peer_downloads`.

A peer that goes offline keeps its rows visible in the cache (greyed
out); they refresh when it comes back online.

### Streaming bridge

When you click a file in the gallery and the row is owned by another
peer, the local `/files/<path>` middleware:

1. Resolves the row → finds it lives on peer B.
2. **Proxy mode** (default): signs `GET https://b.example.com/api/cluster/files/<path>`,
   forwards your browser's `Range` header, pipes the response back.
3. **Direct mode**: asks B to mint a short-lived signed share URL, then
   302-redirects your browser there. B serves the bytes directly.

Stream mode is per-peer; toggle it from the peer's edit sheet on the
Cluster page. Default is proxy because it works in every network
topology.

### Dedup (3 layers)

1. **Owner-peer routing.** If a group has `ownerPeerId = B`, peers other
   than B don't watch it on Telegram → no duplicate downloads.
2. **Pre-download cluster check.** Before the downloader writes a file
   to disk, it sha256s the bytes and looks the hash up in
   `peer_downloads`. If a peer already has the file, the local copy is
   unlinked and a synthetic row is inserted with file_path
   `_clusterref/<peerId>/<remoteId>`. The bridge resolves it transparently.
3. **Post-download sweep.** A nightly (or on-demand) sweep finds files
   sharing `(file_hash, file_size)` across peers and surfaces them as
   conflicts in the Cluster page. The operator picks which copy to keep
   — every other copy is unlinked locally (or queued for deletion on
   the remote peer).

## Token rotation

If you suspect token leakage:

1. On any peer, click **Rotate token**. Every paired peer is now
   un-pair'd in practice (their stored token doesn't match any more).
2. Open every other peer's Cluster page → **Use cluster's token** →
   paste the new value.
3. Re-pair the peers (Add peer on either side).

Rotation is destructive: old paired-peer rows fail HMAC verification
until you complete step 2 + 3 on every peer.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `cluster_auth_failed` 401 in audit log | Token mismatch between peers | Use **Use cluster's token** on the lagging peer to copy the founder's value |
| Peer status stuck on `offline` | Network or wrong URL | Click **Test** on the peer card; check the audit log for the failure reason |
| Storage offline toast on a video | Owner peer is unreachable | Wait for it to come back, or revoke + re-pair if the URL changed |
| `clock_skew` 401 in audit log | Peer clocks differ by > 60 seconds | `chronyd` / `w32time` — sync the system clock |
| Duplicate files keep appearing in the gallery | Owner-peer routing not configured + sync hasn't caught up yet | Wait one sync cycle (30 s) or run **Sync now** from the Cluster page |

## API

Every cluster route is admin-only by virtue of the `/api` chokepoint
default-deny — peer-to-peer routes additionally require an HMAC signature
that matches the local cluster token.

| Route | Auth | Purpose |
|---|---|---|
| `GET  /api/cluster/identity` | admin cookie | own peer_id + name |
| `GET  /api/cluster/identity/token` | admin cookie | reveal token |
| `POST /api/cluster/identity/rotate-token` | admin cookie | generate fresh token |
| `POST /api/cluster/identity/set-token` | admin cookie | adopt an existing cluster's token |
| `GET  /api/cluster/peers` | admin cookie | list paired peers |
| `POST /api/cluster/peers` | admin cookie | add peer (initiates handshake) |
| `PUT  /api/cluster/peers/:peerId` | admin cookie | rename / set stream_mode / notes |
| `DELETE /api/cluster/peers/:peerId` | admin cookie | revoke + cascade-purge cache |
| `POST /api/cluster/peers/:peerId/test` | admin cookie | signed health probe |
| `GET  /api/cluster/audit` | admin cookie | audit log |
| `GET  /api/cluster/downloads` | admin cookie | merged catalog (own + peers) |
| `POST /api/cluster/sync/run` | admin cookie | force a sync cycle now |
| `GET  /api/cluster/sync/state` | admin cookie | per-peer sync cursor |
| `POST /api/cluster/sweep/run` | admin cookie | start dedup sweep |
| `GET  /api/cluster/sweep/status` | admin cookie | sweep status + stats |
| `GET  /api/cluster/conflicts` | admin cookie | list duplicate-file conflicts |
| `POST /api/cluster/conflicts/:id/resolve` | admin cookie | pick keeper, unlink rest |
| `POST /api/cluster/handshake` | HMAC | inbound pairing |
| `GET  /api/cluster/health` | HMAC | heartbeat |
| `GET  /api/cluster/downloads/since` | HMAC | delta sync |
| `GET  /api/cluster/groups/snapshot` | HMAC | groups blob |
| `GET  /api/cluster/accounts/snapshot` | HMAC | accounts (session redacted) |
| `GET  /api/cluster/files/<path>` | HMAC | proxy stream of own files |
| `POST /api/cluster/sign-url` | HMAC | mint short-lived share URL for direct mode |

## v2.10 features (resolved limitations)

- **Per-peer tokens** — each pairing exchanges a fresh secret;
  revocation is per-peer; no more "Use cluster's token" step. See
  the migration guide.
- **Pairing codes** — the receiving peer issues an 8-character code
  valid for 5 minutes; the initiator pastes URL + code; both sides
  exchange secrets in the handshake.
- **Real-time WS push** — every paired peer maintains a persistent
  `/ws/cluster` link with HMAC handshake; catalog deltas propagate in
  <1 s. Polling drops to a 5-min safety net.
- **LAN auto-discovery** — UDP broadcast on port 28910 surfaces
  reachable peers under "Discovered". One-click **Pair** with the
  pairing-code wizard pre-filled.
- **Relay-through-peer** — if A can't reach C but B can reach both,
  A's signed calls to C are forwarded through B end-to-end (B can't
  tamper or read encrypted bodies).
- **Backup peer + failover** — `groups[i].backupPeerId` config key.
  When the owner is silent > `cluster.failover_grace_minutes`
  (default 5), the backup atomically takes over and broadcasts a
  `failover_completed` event.
- **Live config sync** — `cluster.replicate.<key>` policy chooses
  per-key replication (`local` / `cluster` / `cluster_excl`); changes
  propagate over WS with last-writer-wins by ts + peer_id tiebreak.
- **Cross-peer file delete** — sweep's `resolveConflict` now actually
  deletes losers on remote peers via signed `POST /api/cluster/files/delete`,
  with a per-failure retry queue.
- **Cluster-wide search** — `/api/cluster/search` fans out to every
  online peer's `/api/cluster/search/peer`, merges + dedups by
  `file_hash`.
- **Cluster stats** — `/api/cluster/stats` aggregates disk + dedup +
  egress per peer for the Cluster Stats card.

## Remaining limitations

- **No STUN/TURN** — peers across NAT without a relay-capable peer
  paired by both should use Tailscale / a VPN. STUN/TURN deferred
  pending demand.
- **WebRTC browser-direct** — not implemented; proxy mode covers the
  practical use cases.
- **Auto-elect (Raft/Paxos)** — backup-peer rule is sufficient for
  the home/SOHO scale; auto-elect deferred to avoid split-brain risk.
- **Encrypted-destination plaintext caching** — opt-in only via
  `cache_plaintext_for_encrypted_dest=true`; default-off.
