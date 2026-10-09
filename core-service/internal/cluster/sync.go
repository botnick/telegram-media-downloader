package cluster

import (
	"context"
	"crypto/hmac"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"time"
)

type SyncState struct {
	CatalogEpoch   string  `json:"catalogEpoch,omitempty"`
	ChangeRevision int64   `json:"changeRevision,omitempty"`
	SinceID        *int64  `json:"sinceId,omitempty"`
	LastSuccessAt  *int64  `json:"lastSuccessAt,omitempty"`
	LastError      *string `json:"lastError"`
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

type SyncResult struct {
	Rows    int
	Changed bool
	More    bool
}

func (c *Client) SyncPeer(ctx context.Context, p Peer) (SyncResult, error) {
	state, err := c.Store.SyncState(ctx)
	if err != nil {
		return SyncResult{}, err
	}
	cursor := state[p.PeerID]
	total := SyncResult{}
	for range 10 { // Fairness: at most 5,000 rows per peer per pass.
		res, err := c.Request(ctx, p, "GET", fmt.Sprintf("/api/cluster/catalog/changes?after=%d&epoch=%s&limit=500", cursor.ChangeRevision, url.QueryEscape(cursor.CatalogEpoch)), nil)
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
		var payload ChangePage
		if err = ReadJSON(res, &payload); err != nil || payload.PeerID != p.PeerID || payload.Changes == nil {
			return total, c.syncFailure(ctx, p, "invalid catalog response")
		}
		err = c.Store.SaveChanges(ctx, p, cursor, payload)
		if err != nil {
			if errors.Is(err, ErrPeerChanged) || ctx.Err() != nil {
				return total, err
			}
			return total, errors.Join(err, c.Store.SaveSyncFailure(ctx, p, "catalog page could not be committed"))
		}
		cursor.CatalogEpoch = payload.Epoch
		cursor.ChangeRevision = payload.Next
		total.Rows += len(payload.Changes)
		total.Changed = total.Changed || payload.Reset || len(payload.Changes) > 0
		total.More = payload.More
		if !payload.More {
			return total, nil
		}
	}
	return total, nil
}

func upsertCatalogRow(ctx context.Context, tx *sql.Tx, peer string, r CatalogRow, now int64) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO peer_downloads(peer_id,remote_id,file_path,file_name,file_size,file_type,file_hash,group_id,group_name,message_id,created_at,status,nsfw_score,cached_at)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(peer_id,remote_id) DO UPDATE SET file_path=excluded.file_path,file_name=excluded.file_name,file_size=excluded.file_size,file_type=excluded.file_type,file_hash=excluded.file_hash,group_id=excluded.group_id,group_name=excluded.group_name,message_id=excluded.message_id,created_at=excluded.created_at,status=excluded.status,nsfw_score=excluded.nsfw_score,cached_at=excluded.cached_at`, peer, r.ID, r.FilePath, r.FileName, r.FileSize, r.FileType, r.FileHash, r.GroupID, r.GroupName, r.MessageID, createdMillis(r.CreatedAt), r.Status, r.NSFWScore, now)
	return err
}
