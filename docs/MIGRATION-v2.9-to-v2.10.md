# Migrating cluster pairings from v2.9 to v2.10

v2.10 replaces the global "shared cluster token" model with **per-peer
shared secrets** that are exchanged automatically during pairing. This
means:

- The "Use cluster's token" step is gone — every fresh pairing is
  one-shot via a 5-minute single-use **pairing code**.
- Revoking a peer no longer invalidates anyone else's secrets.
- Existing v2.9 pairings keep working until you re-pair (the legacy
  cluster_token is still accepted as a fallback during the migration
  window).

## When to migrate

You can migrate at your own pace. Each v2.9 pairing is flagged
`migrationRequired` in the Cluster page. The flag is informational —
the pair still works — but you should re-pair to switch to per-peer
secrets and unlock per-peer revocation.

## Re-pair workflow

For each peer pair:

1. Open `Maintenance → Cluster` on **either** peer.
2. Click **Issue pairing code**. A short 8-character code appears.
3. On the other peer, open `Maintenance → Cluster → Add peer`.
4. Paste the URL of the first peer + the pairing code.
5. Click **Pair**. Both sides install a fresh per-pair secret and the
   `migrationRequired` flag clears within seconds.

That's it. The old pair's `shared_secret` slot fills in; nothing else
needs to change.

## What if I rotate the global cluster_token?

After v2.10, rotating the global token only affects:

- New peers being onboarded via "Use cluster's token" (legacy fallback
  for v2.9 setup; deprecated).
- Pairing codes minted FROM the global token — they'll stop validating
  immediately.

It does NOT affect already-paired peers that hold per-pair secrets.

## Removing legacy support

The legacy global-token fallback in HMAC verification stays on for
the v2.10 release cycle. v2.11 will remove it; any peers still flagged
`migrationRequired` at that point will fail to authenticate cross-peer
calls and need to re-pair.

## Other v2.10 changes you'll see

- **Real-time WS push** — paired peers maintain a persistent
  `/ws/cluster` link so catalog updates appear in the gallery in
  under a second instead of waiting on the 30-second polling cycle.
- **LAN auto-discovery** — peers on the same network broadcast their
  presence on UDP port 28910. The Cluster page surfaces "Discovered"
  peers; click **Pair** to skip pasting the URL.
- **Backup peer + failover** — group editor gains a Backup peer
  dropdown. If the owner has been silent for 5 minutes, the backup
  takes over downloads automatically.
- **Cross-peer file delete** — sweep's "resolve conflict" now
  actually deletes the loser on the remote peer (was queue-only in
  v2.9).
- **Live config sync** — set `cluster.replicate.<key>` to `cluster`
  in advanced settings to mirror that setting across paired peers.
- **Cluster-wide search** — gallery search fans out to every paired
  peer and merges results.
- **Relay-through-peer** — if peer A can't reach C directly but B
  can, A's calls to C are forwarded through B with end-to-end
  signing (B can't tamper).
