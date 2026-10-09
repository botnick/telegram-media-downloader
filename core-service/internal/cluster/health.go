package cluster

import (
	"context"
	"time"
)

// RecordHealth commits the status and its audit together only if this is still
// the same pairing and endpoint. Failed probes retain the last successful time.
func (s Store) RecordHealth(ctx context.Context, p Peer, online bool, kind, detail string) error {
	tx, err := s.transaction(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = checkPeer(ctx, tx, p); err != nil {
		return err
	}
	status := "offline"
	if online {
		status = "online"
	}
	if _, err = tx.ExecContext(ctx, `UPDATE peers SET status=?,last_seen_at=CASE WHEN ? THEN ? ELSE last_seen_at END WHERE peer_id=?`, status, online, time.Now().UnixMilli(), p.PeerID); err != nil {
		return err
	}
	if kind != "" {
		if err = audit(ctx, tx, p.PeerID, kind, detail, online); err != nil {
			return err
		}
	}
	return tx.Commit()
}
