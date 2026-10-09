package cluster

import (
	"context"
	"crypto/hmac"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

type SyncState struct {
	SinceID       *int64  `json:"sinceId,omitempty"`
	LastSuccessAt *int64  `json:"lastSuccessAt,omitempty"`
	LastError     *string `json:"lastError"`
}

var ErrPeerChanged = errors.New("peer changed during request")

func syncState(ctx context.Context, db querier) (map[string]SyncState, error) {
	out := map[string]SyncState{}
	err := kvRead(ctx, db, "cluster_sync_state", &out)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	if out == nil {
		out = map[string]SyncState{}
	}
	return out, err
}
func (s Store) SyncState(ctx context.Context) (map[string]SyncState, error) {
	return syncState(ctx, s.Reader)
}
func checkPeer(ctx context.Context, tx *sql.Tx, p Peer) error {
	var url, status string
	var secret []byte
	err := tx.QueryRowContext(ctx, `SELECT url,status,shared_secret FROM peers WHERE peer_id=?`, p.PeerID).Scan(&url, &status, &secret)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrPeerChanged
	}
	if err != nil {
		return err
	}
	if url != p.URL || status == "revoked" || !hmac.Equal(secret, p.Secret) {
		return ErrPeerChanged
	}
	return nil
}
func createdMillis(value *string) any {
	if value == nil {
		return nil
	}
	if n, err := strconv.ParseInt(*value, 10, 64); err == nil {
		return n
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05"} {
		if t, err := time.Parse(layout, *value); err == nil {
			return t.UnixMilli()
		}
	}
	return int64(0)
}
func (s Store) SaveDelta(ctx context.Context, p Peer, since int64, rows []CatalogRow) (int64, error) {
	if len(rows) > 500 {
		return since, errors.New("peer sent too many catalog rows")
	}
	next := since
	for _, r := range rows {
		if r.ID <= next || r.FilePath == nil || *r.FilePath == "" || strings.ContainsRune(*r.FilePath, 0) {
			return since, errors.New("invalid or nonadvancing peer catalog")
		}
		if r.FileSize != nil && *r.FileSize < 0 {
			return since, errors.New("invalid peer file size")
		}
		next = r.ID
	}
	tx, err := s.transaction(ctx)
	if err != nil {
		return since, err
	}
	defer tx.Rollback()
	if err = checkPeer(ctx, tx, p); err != nil {
		return since, err
	}
	state, err := syncState(ctx, tx)
	if err != nil {
		return since, err
	}
	ps := state[p.PeerID]
	current := int64(0)
	if ps.SinceID != nil {
		current = *ps.SinceID
	}
	if current != since {
		return since, errors.New("catalog cursor changed while syncing")
	}
	now := time.Now().UnixMilli()
	for _, r := range rows {
		_, err = tx.ExecContext(ctx, `INSERT INTO peer_downloads(peer_id,remote_id,file_path,file_name,file_size,file_type,file_hash,group_id,group_name,message_id,created_at,status,nsfw_score,cached_at)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(peer_id,remote_id) DO UPDATE SET file_path=excluded.file_path,file_name=excluded.file_name,file_size=excluded.file_size,file_type=excluded.file_type,file_hash=excluded.file_hash,group_id=excluded.group_id,group_name=excluded.group_name,message_id=excluded.message_id,created_at=excluded.created_at,status=excluded.status,nsfw_score=excluded.nsfw_score,cached_at=excluded.cached_at`, p.PeerID, r.ID, r.FilePath, r.FileName, r.FileSize, r.FileType, r.FileHash, r.GroupID, r.GroupName, r.MessageID, createdMillis(r.CreatedAt), r.Status, r.NSFWScore, now)
		if err != nil {
			return since, err
		}
	}
	ps.SinceID = &next
	ps.LastSuccessAt = &now
	ps.LastError = nil
	state[p.PeerID] = ps
	if err = kvWrite(ctx, tx, "cluster_sync_state", state); err != nil {
		return since, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE peers SET status='online',last_seen_at=? WHERE peer_id=?`, now, p.PeerID); err != nil {
		return since, err
	}
	if len(rows) > 0 {
		if err = audit(ctx, tx, p.PeerID, "sync", fmt.Sprintf("%d rows, sinceId=%d→%d", len(rows), since, next), true); err != nil {
			return since, err
		}
	}
	return next, tx.Commit()
}
func (s Store) SaveSyncFailure(ctx context.Context, p Peer, reason string) error {
	tx, err := s.transaction(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = checkPeer(ctx, tx, p); err != nil {
		return err
	}
	state, err := syncState(ctx, tx)
	if err != nil {
		return err
	}
	ps := state[p.PeerID]
	detail := "sync " + p.PeerID + ": " + reason
	ps.LastError = &detail
	state[p.PeerID] = ps
	if err = kvWrite(ctx, tx, "cluster_sync_state", state); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE peers SET status='offline' WHERE peer_id=?`, p.PeerID); err != nil {
		return err
	}
	if err = audit(ctx, tx, p.PeerID, "sync", detail, false); err != nil {
		return err
	}
	return tx.Commit()
}
func (c *Client) syncFailure(ctx context.Context, p Peer, reason string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	err := c.Store.SaveSyncFailure(ctx, p, reason)
	if errors.Is(err, ErrPeerChanged) {
		return err
	}
	// Persisting a failure is not a successful sync. Keep it visible to the
	// manual endpoint and background loop even when the status write succeeds.
	return errors.Join(fmt.Errorf("peer %s: %s", p.PeerID, reason), err)
}
func (c *Client) SyncPeer(ctx context.Context, p Peer) (int, error) {
	state, err := c.Store.SyncState(ctx)
	if err != nil {
		return 0, err
	}
	since := int64(0)
	if state[p.PeerID].SinceID != nil {
		since = *state[p.PeerID].SinceID
	}
	total := 0
	for range 10 { // Fairness: at most 5,000 rows per peer per pass.
		res, err := c.Request(ctx, p, "GET", fmt.Sprintf("/api/cluster/downloads/since?sinceId=%d&limit=500", since), nil)
		if err != nil {
			if ctx.Err() != nil {
				return total, ctx.Err()
			}
			reason := "unreachable"
			var authErr AuthError
			if errors.As(err, &authErr) {
				reason = string(authErr)
			}
			return total, c.syncFailure(ctx, p, reason)
		}
		if res.StatusCode != 200 {
			res.Body.Close()
			return total, c.syncFailure(ctx, p, fmt.Sprintf("HTTP %d", res.StatusCode))
		}
		var payload struct {
			Rows   []CatalogRow `json:"rows"`
			PeerID string       `json:"peerId"`
		}
		if err = ReadJSON(res, &payload); err != nil || payload.PeerID != p.PeerID || payload.Rows == nil {
			return total, c.syncFailure(ctx, p, "invalid catalog response")
		}
		next, err := c.Store.SaveDelta(ctx, p, since, payload.Rows)
		if err != nil {
			if errors.Is(err, ErrPeerChanged) || ctx.Err() != nil {
				return total, err
			}
			return total, errors.Join(err, c.Store.SaveSyncFailure(ctx, p, "catalog page could not be committed"))
		}
		since = next
		total += len(payload.Rows)
		if len(payload.Rows) < 500 {
			return total, nil
		}
	}
	return total, nil
}
