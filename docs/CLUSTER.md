---
title: "Cluster mode"
description: "Pair two or more Telegram Media Downloader 3.0 servers to browse, search and stream each other's files from one dashboard over signed requests."
parent: Features
nav_order: 2
---

# Cluster mode

Cluster mode links several installs of Telegram Media Downloader (each one is
a **peer**) so that an admin on any of them can see, search and play the files
the others downloaded. Every peer stays a complete, independent install: its
own Telegram accounts, downloads folder, SQLite database and dashboard. Nothing
is moved or copied between disks; a peer only keeps a cached list (catalog) of
what the others have and fetches the bytes on demand when you open a file.

Typical uses:

- A home NAS and a VPS each downloading different chats, browsed from one
  dashboard.
- Watching a video stored on peer B while logged in to peer A, without a second
  login or an SSH tunnel.
- Making sure only one machine downloads a given chat.

Cluster mode does nothing until you pair a peer. There is no public directory
and no automatic discovery: every pairing is started by an admin with a URL
and a pairing code.

## What 3.0 does and does not do

3.0 is a rewrite of the cluster in Go. It keeps the 2.x wire format for signed
requests but implements a smaller feature set than late 2.x releases.

| Works in 3.0 | Not available in 3.0 |
|---|---|
| Pairing with a one-time code (or the remote peer's cluster token) | LAN auto-discovery (the UDP beacon is gone) |
| Per-pair secrets, signed requests, replay protection, revocation | Relay through a third peer |
| Automatic catalog sync of added, edited and deleted files | Backup peer / automatic failover |
| *All peers* gallery view and search over the synced catalog | Replicating settings between peers (Settings → Federation) |
| Streaming peer files through your peer, with seeking (HTTP ranges) | *Direct* stream mode (browser fetches from the owner) |
| *Owner peer* per chat (only that peer downloads it) | Peer thumbnails in the gallery |
| Peer status, manual *Ping*, manual sync, audit log | Cross-peer duplicate sweep, conflicts and remote delete |

Some 2.x controls are still visible in the dashboard but have no effect on the
3.0 server: the **Backup peer** dropdown, **Settings → Federation**
(replication policy and failover grace), the **Cross-peer dedup** card with
*Run sweep*, and the *Browser fetches direct* stream mode. They are described
under [Limitations](#limitations). The engineering status is tracked in
[GO-CLUSTER.md](GO-CLUSTER.md#remaining-cluster-work).

## Requirements

### Versions

Run the same major version on every peer. Pairing between 3.0 peers is the
supported setup; see [Upgrading peers](#upgrading-peers) for 2.x peers.

### Network

Both peers must be able to open HTTP(S) connections **to each other**, not
just from your browser:

- The peer you pair *from* calls the other peer once to pair.
- Afterwards each side calls the other: catalog sync pulls from the remote
  peer, file playback streams from the peer that owns the file, and each side
  keeps a WebSocket (`/ws/cluster`) open to the other for change hints.

Any route works: same LAN, VPN (Tailscale, WireGuard), or public HTTPS. A few
rules the peer client enforces:

- The peer URL must be `http://` or `https://` with a host name, and without
  user/password, query string or `#fragment`. A trailing `/` is dropped.
- Redirects are **not followed**. Use the final URL (for example `https://…`
  directly, not an `http://` address that redirects to it).
- HTTPS certificates are verified normally; self-signed certificates fail.
- System proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`) are **not** used for
  peer traffic.
- Plain `http://` is accepted. Requests are signed, so they cannot be forged
  or altered, but the content (file lists, media) is readable on the wire. Use
  HTTPS or an encrypted network across the internet.

### Clocks

Every signed request carries a timestamp and is rejected if it differs from
the receiver's clock by more than **60 seconds**. Keep NTP (`chrony`,
`systemd-timesyncd`, Windows Time) running on every peer.

### The address this peer gives out (`PUBLIC_URL`)

When you pair, your peer tells the other one the URL at which it can call you
back. The other peer stores that URL and uses it for every later sync,
WebSocket and file request. It is chosen like this:

1. If the environment variable `PUBLIC_URL` is set on the peer you are pairing
   **from**, that value is sent (for example
   `PUBLIC_URL=https://nas.example.com`).
2. Otherwise it is built from the address in your browser's address bar (the
   request's `Host`) plus `https` when the request reached the server over TLS
   or through a trusted reverse proxy that sent `X-Forwarded-Proto: https`
   (see `TRUST_PROXY` in [Configuration](CONFIGURATION.md); its default trusts
   proxies on loopback). Anything else gives `http`.

`PUBLIC_URL` is only read at pairing time and only for this purpose; it does
not change the listen address, cookies or links elsewhere in the app. Set it
when the address you use in the browser is not one the other peer can reach,
for example:

- you open the dashboard as `http://localhost:3000` or through an SSH tunnel;
- the reverse proxy is on another host and does not send
  `X-Forwarded-Proto`, so the server would announce `http://` for an HTTPS
  site;
- the browser uses a LAN name but the other peer is on the internet.

Docker example (`docker-compose.yml` → `environment:` or `.env`):

```env
PUBLIC_URL=https://tgdl-nas.example.com
```

If a peer was stored with a wrong URL, set `PUBLIC_URL` (or open the dashboard
at a reachable address) and pair again with a new code; pairing again updates
the stored URL.

### Reverse proxy

Follow [DEPLOY.md → Reverse proxy](DEPLOY.md#reverse-proxy-and-https), and also:

- Forward `/api/cluster/` and `/ws/cluster` unchanged, including the
  `X-Peer-Id`, `X-Peer-Ts` and `X-Peer-Signature` headers and the WebSocket
  `Upgrade` / `Connection` headers.
- Do not put an extra login (basic auth, SSO, Cloudflare Access) in front of
  those paths: peers authenticate with their own signatures and cannot answer
  a login page.
- Do not rewrite the path or query string; the signature covers them.
- Allow long responses for `/api/cluster/files/` (video streaming).

## Pair two peers

Pairing is done by an **admin** in the dashboard. The page is
**Settings → Tools → Cluster**. Call the peers *A* (where you start) and *B*
(the one you add).

1. **Optional: name both peers.** In the *This peer* card, click **Edit** next
   to the display name (default: the host name) and **Save**. Other peers see
   this name on file badges and in the peer list.
2. **On B, issue a code.** Click **Issue pairing code**. An 8-character code
   appears. It is valid for **5 minutes** and works **once**. (At most 32
   unused codes can be outstanding.)
3. **On A, pair.** In *Pair a new peer*, enter B's URL as A should reach it
   (for example `https://b.example.com` or `http://192.168.1.20:3000`) and the
   code, then click **Connect**.
4. A's server contacts B, both sides generate and store a fresh **per-pair
   secret**, and the dialog shows *Successfully paired!*. B appears under
   *Connected peers* on A, and A appears on B.
5. Click **Ping** on the peer card to confirm that A can reach B with the new
   secret. Ping from B as well to confirm the way back.

Within about 30 seconds A and B start syncing their catalogs. Repeat for every
pair of peers that should see each other: pairings are point-to-point, so in a
cluster of three, pair A–B, A–C and B–C if all three should see everything.

**Pairing with a token instead of a code.** The second field also accepts the
remote peer's **cluster token** (64 hex characters; *Show* / *Copy* in B's
*This peer* card). The token only authorises the pairing handshake; after
that the per-pair secret is used, exactly as with a code. Prefer codes: they
expire and cannot be reused, while the token stays valid until you rotate it.
**Use cluster's token** (setting a token by hand) is only needed if you want a
peer to accept a token you already know.

If pairing fails, the dialog shows the reason; see
[Troubleshooting](#troubleshooting).

## Using a cluster

### See peers' files in the gallery

Once a peer is paired, admins get a scope selector in the gallery header:

- **This peer** — only local files (default).
- **All peers** — local files plus the cached catalogs of every paired peer,
  newest first, each peer file marked with its peer's name.
- A single peer — only that peer's files, in per-chat views.

The choice is remembered in the browser. Guest sessions always see local files
only, and the scope selector is hidden when no peer is paired.

Peer files show no thumbnail preview in 3.0; open them to view or play.

### Open and play a peer's file

Opening a peer file sends the request to *your* peer, which signs a request to
the owning peer and streams the bytes back through itself. Seeking works
(`Range` requests are forwarded). Browser cookies and authorisation headers
are never forwarded to the other peer. If the owning peer cannot be reached,
the request fails with *Peer stream unavailable* (`storage_offline`).

Each peer's **Edit** sheet has a *Stream mode*. Keep **Proxy through this
peer**: the *Browser fetches direct* option is not implemented in 3.0 and
makes the file request fail with `unsupported_stream_mode` (HTTP 501).

### Search

With the gallery scope set to **All peers**, the search box matches file name
and chat name across your own files and the cached catalogs of every peer.
Peers are not contacted while you type, so results reflect the last sync, and
an offline peer's files are still found (they just cannot be opened until it
is back).

### Choose which peer downloads a chat (owner peer)

When at least one peer is paired, a chat's details page (**Chats** → the chat,
or the ⚙ in its gallery) shows an **Owner peer** dropdown under *Accounts*.
If a chat's owner is set to another peer, this peer does not download that
chat at all: live monitoring, history backfill, Stories and pasted message
links for that chat are all skipped here.

Chat settings are not shared between peers, so set this on **every peer except
the owner**. On the owner itself leave it empty (its own name is not in its
own list). An empty owner means "this peer downloads it as usual"; two peers
that both monitor a chat with no owner set will both download it, and 3.0 does
not de-duplicate files across peers.

The **Backup peer** dropdown next to it is saved but not acted on in 3.0;
there is no automatic failover.

## What syncs between peers

| Data | Synced? | How |
|---|---|---|
| Catalog of downloaded files (name, path, size, type, SHA-256, chat id/name, message id, date, status, NSFW score) | Yes, one way per pair (each side pulls the other) | Durable change feed, see below |
| Added, edited and deleted file records | Yes | Deletions are sent as tombstones and remove the cached row |
| Media files | No | Streamed on demand when opened; never copied |
| Thumbnails | No | Not proxied in 3.0 |
| Chat settings, accounts, Telegram sessions, dashboard settings | No | Each peer is configured separately |
| Dashboard passwords, share links | No | Each peer has its own |

**How catalog sync runs.** Each peer pulls the other's changes from
`GET /api/cluster/catalog/changes`, 500 records per page and up to 5,000 per
peer per pass, with up to four peers in parallel. A pass runs every
**30 seconds**, immediately after a change hint arrives over the `/ws/cluster`
WebSocket (so new downloads usually appear within a second or two), and when
you trigger it manually. Progress is stored as a revision cursor, so restarts
resume where they left off and an interrupted page is simply fetched again.
If the remote catalog was restored from a backup (its catalog *epoch*
changes), the local cache of that peer is cleared and rebuilt automatically.

The gallery refreshes on its own when a sync changes something.

## Peer status and maintenance

- **Status pill.** *Online* means the peer was heard from recently (a
  successful sync, ping, WebSocket heartbeat or incoming request). A failed
  sync marks it *Offline*; its cached files stay listed. *Stale* / *Offline*
  are also shown when the last contact gets old.
- **Ping** (`POST /api/cluster/peers/{peerId}/test`) sends one signed health
  request and records the result.
- **Manual sync.** `POST /api/cluster/sync/run` runs a pass now (it answers
  `409` if one is already running). `GET /api/cluster/sync/state` shows each
  peer's cursor and last error.
- **Recent cluster events** on the Cluster page lists pairings, pings, sync
  failures, rejected requests and token changes.
- **Edit** changes the local display name of a peer, its stream mode and a
  free-text note.
- **Remove** deletes the peer from *this* side: the pairing, its secret, its
  cached catalog and its sync cursor go together, and further requests from
  it are rejected. Remove it on the other peer too; otherwise that side keeps
  trying and logs `no_secret` failures. A stream that is already playing is
  not cut off.

## Security

- **Admin only.** All dashboard cluster pages and `/api/cluster/*` management
  routes require an admin session. Guests cannot switch the gallery scope or
  open peer files.
- **Per-pair secrets.** Every pairing creates a new random 32-byte secret that
  only those two peers know. Removing one peer does not affect other pairings.
- **Signed requests.** Every peer-to-peer request carries `X-Peer-Id`,
  `X-Peer-Ts` (milliseconds) and `X-Peer-Signature`, an HMAC-SHA256 over the
  method, path with query, timestamp and SHA-256 of the body. The WebSocket
  link and each of its messages are signed the same way. The receiver checks
  the signature in constant time, rejects timestamps more than 60 seconds off,
  and remembers accepted signatures for 120 seconds in the database so a
  captured request cannot be replayed, even across a restart.
- **The cluster token only opens the door for pairing.** It cannot be used to
  sign normal peer requests. Rotating it (**Rotate**) invalidates unused
  pairing codes and the old token for future pairings, but existing pairings
  keep working. Rotate it if it may have leaked; remove a peer to cut it off.
- **What a peer can read from you:** your file catalog (the fields listed
  above), file contents inside your downloads folder (path-confined; no other
  files), a list of your chats' settings and a list of account labels, phone
  numbers and enabled state. Session data, API credentials and any setting
  whose name contains *secret*, *password*, *token* or *session* are never
  sent. Pair only with servers you trust with that information.
- **Limits.** Peer request and JSON response bodies are capped at 1 MiB,
  WebSocket frames at 1 MiB; peer requests time out after 10 seconds (file
  streams after 30 seconds of inactivity).

## Upgrading peers

### From 2.x to 3.0

Upgrade as described in [DEPLOY.md](DEPLOY.md#updating). The peer keeps its
peer ID, name, cluster token and paired peers, because they live in the same
database.

Whether a pairing needs to be redone depends on how it was made:

- **Paired on 2.10 or later** (with a pairing code, or with a token on a
  version that installs per-pair secrets): it keeps working on 3.0 with no
  action, because 3.0 uses the same signature format and the stored per-pair
  secret.
- **Paired on 2.9 or earlier** (shared cluster token only, no per-pair
  secret): the peer is listed with `migrationRequired` and every request to
  or from it fails with `migration_required`. 3.0 no longer accepts the old
  shared-token fallback. Remove the peer on both sides and pair again with a
  code. [MIGRATION-v2.9-to-v2.10.md](MIGRATION-v2.9-to-v2.10.md) describes the
  2.10 change; its notes on discovery, failover, relay and config sync do not
  apply to 3.0.

### Mixed 2.x and 3.0 peers

Upgrade every peer to 3.0. A mixed cluster only partly works:

- A 3.0 peer syncs only through `/api/cluster/catalog/changes`, which 2.x does
  not have. It **cannot list a 2.x peer's files**; sync to that peer fails
  with `HTTP 404`.
- A 2.x peer can still pull the catalog of a 3.0 peer
  (`/api/cluster/downloads/since` is served) and stream its files through the
  proxy. 2.x features that call 3.0 for direct streaming, thumbnails, relay,
  remote delete, failover or config sync get errors or are refused.
- Pairing a 2.x peer with a 3.0 peer uses the same handshake, but this
  combination is not tested. If you must, pair *from* 2.30 or later; versions
  up to 2.29.1 refuse every pairing-code handshake.

## Troubleshooting

Errors appear in the pairing dialog, in the *Ping* result and in
**Recent cluster events**.

| Message / code | Meaning | Fix |
|---|---|---|
| `bad_url` | Peer URL is not a plain `http(s)://host[:port]` | Remove credentials, `?query`, `#fragment` and spaces |
| `bad_self_url` | This peer could not work out its own reachable URL | Set `PUBLIC_URL` on this peer |
| `unreachable` | This server could not connect to the other one | Check URL, firewall, DNS and TLS certificate from the server, not the browser (for example `curl` from inside the container) |
| `token_invalid` (pairing) | The other peer rejected the code or token | Code expired (5 min), was already used, was issued by a different peer, or the token was rotated; issue a new code |
| `remote_error` | The other peer answered with a non-200 status | Often a reverse proxy login page or redirect in front of `/api/cluster/`; also check its logs |
| `self` | The URL points back to this same install | Use the other peer's address |
| `clock_skew` | Clocks differ by more than 60 s | Enable NTP on both peers |
| `migration_required` | Pairing from 2.9 or earlier without a per-pair secret | Remove on both sides and pair again with a code |
| `no_secret` | The caller is not (or no longer) paired here | The other side was removed here; remove it there too, or pair again |
| `bad_signature` | Secret mismatch, or a proxy changed the path, query or body | Check the proxy passes requests unchanged; pair again |
| `replay` | The same signed request was received twice | Usually a retrying proxy; disable retries for `/api/cluster/` |
| Ping works from A but B shows A *Offline* | A announced an address B cannot reach (for example `localhost`) | Set `PUBLIC_URL` on A, then pair again |
| Sync shows `HTTP 404` | The peer is still on 2.x | Upgrade it to 3.0 |
| Peer file opens with `storage_offline` | The owning peer is down or unreachable from this peer | Bring it back; Ping to confirm |
| Peer file fails with `unsupported_stream_mode` | Stream mode is set to *direct* | Edit the peer → *Proxy through this peer* |
| New peer files take ~30 s to appear | The WebSocket link is blocked, so only the 30 s timer runs | Allow WebSocket upgrades for `/ws/cluster` on the proxy |
| *Run sweep* or *Conflicts* shows an error | Cross-peer dedup is not in 3.0 | Ignore the card |

For general server problems see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Limitations

- No LAN discovery, relay through a third peer, automatic failover, settings
  replication, direct (browser-to-owner) streaming, peer thumbnails, or
  cross-peer duplicate detection, sweep and remote delete. The dashboard still
  shows some of these controls from 2.x; they do nothing on a 3.0 server.
- No NAT traversal. Peers that cannot reach each other directly need a VPN
  such as Tailscale or WireGuard.
- Removing a peer does not stop a file stream that is already playing.
- Deleted-file tombstones and cluster audit entries are kept indefinitely.
- Pairing is not one transaction across two machines. If the connection drops
  at the wrong moment, one side may list the pairing and the other not; pair
  again with a new code.
- Media files are not part of backups of the database; each peer backs up its
  own downloads. See [BACKUP.md](BACKUP.md).

## API reference

Admin routes (dashboard session, admin role):

| Route | Purpose |
|---|---|
| `GET /api/cluster/identity` | This peer's ID and name |
| `PUT /api/cluster/identity` | Rename this peer: `{"name": "…"}` |
| `GET /api/cluster/identity/token` | Show the cluster token |
| `POST /api/cluster/identity/set-token` | Set the token: `{"token": "<32+ hex>"}` |
| `POST /api/cluster/identity/rotate-token` | Generate a new token |
| `POST /api/cluster/identity/pairing-code` (alias `POST /api/cluster/pairing-code`) | Issue a 5-minute single-use code: `{"code", "expiresAt"}` |
| `GET /api/cluster/peers` | Paired peers (status, URL, stream mode, version, `migrationRequired`) |
| `POST /api/cluster/peers` | Pair: `{"url", "pairingCode"}` or `{"url", "token"}` |
| `PUT /api/cluster/peers/{peerId}` | Edit `name`, `url`, `streamMode`, `notes` |
| `DELETE /api/cluster/peers/{peerId}` | Remove the peer and its cached data |
| `POST /api/cluster/peers/{peerId}/test` | Ping |
| `GET /api/cluster/audit?peerId=&kind=&limit=` | Audit log (default 200, max 2000) |
| `GET /api/cluster/sync/state` | Per-peer sync cursor and status |
| `POST /api/cluster/sync/run` | Run a sync pass now |

Gallery and media routes that read peer data (admin only):
`GET /api/downloads/all?include=peers`,
`GET /api/downloads/search?q=…&include=peers`, per-chat
`GET /api/downloads/{groupId}?include=peers&peerId=…`,
`GET /files/<path>?peer=<peerId>` and
`GET /files/_clusterref/<peerId>/<remoteId>`.

Peer-to-peer routes (signed with the per-pair secret; the handshake is signed
with the code- or token-derived key):

| Route | Purpose |
|---|---|
| `POST /api/cluster/handshake` | Pairing |
| `GET /api/cluster/health` | Identity, version, liveness |
| `GET /api/cluster/catalog/changes?after=&epoch=&limit=` | Catalog change feed (used by 3.0) |
| `GET /api/cluster/downloads/since?sinceId=&limit=` | Catalog by row ID (kept for 2.x peers) |
| `GET /api/cluster/search/peer?q=&limit=` | File/chat name search (kept for 2.x peers) |
| `GET /api/cluster/groups/snapshot` | Chat settings without credentials |
| `GET /api/cluster/accounts/snapshot` | Account ID, label, phone, disabled |
| `GET`, `HEAD /api/cluster/files/<path>` | File bytes with HTTP ranges |
| `GET /ws/cluster` | Signed WebSocket for change hints and heartbeats |

The signing format is documented in
[GO-CLUSTER.md](GO-CLUSTER.md#signed-http-protocol). For the rest of the API
see [API.md](API.md); for how the server is built see
[ARCHITECTURE.md](ARCHITECTURE.md).
