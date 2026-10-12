package cluster

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"time"
)

// The dedup sweep groups own downloads and every peer's cached catalog by
// (file_hash, file_size). Each group with more than one owner is a conflict
// the operator resolves by choosing the copy to keep. The keys are shared with
// the 2.x release so a migrated database keeps its pending conflicts.
const (
	conflictsKey  = "cluster_sweep_conflicts"
	sweepStatsKey = "cluster_sweep_stats"
	// SelfPeerID marks an owner row from this instance's own downloads table.
	SelfPeerID = "self"
)

type ConflictOwner struct {
	PeerID   string `json:"peerId"`
	RemoteID int64  `json:"remoteId"`
	FilePath string `json:"filePath"`
}

type Conflict struct {
	ID       string          `json:"id"`
	FileHash string          `json:"fileHash"`
	FileSize int64           `json:"fileSize"`
	Count    int             `json:"count"`
	Owners   []ConflictOwner `json:"owners"`
}

type SweepStats struct {
	LastRunAt     int64 `json:"lastRunAt"`
	DurationMs    int64 `json:"durationMs"`
	Conflicts     int   `json:"conflicts"`
	DuplicateRows int   `json:"duplicateRows"`
	WastedBytes   int64 `json:"wastedBytes"`
}

// ConflictID is the stable identifier the dashboard posts back on resolve.
func ConflictID(hash string, size int64) string { return hash + "|" + strconv.FormatInt(size, 10) }

// FindDuplicates returns at most limit conflict groups, largest first. Local
// rows without a file are deletion tombstones and never count as a copy.
func (s Store) FindDuplicates(ctx context.Context, minSize int64, limit int) ([]Conflict, error) {
	limit = min(2000, max(1, limit))
	rows, err := s.Reader.QueryContext(ctx, `WITH all_rows AS (
 SELECT 'self' AS peer_id,id AS remote_id,file_hash,file_size,file_path FROM downloads
  WHERE file_hash IS NOT NULL AND file_hash<>'' AND file_size>=? AND file_path IS NOT NULL AND file_path<>''
 UNION ALL
 SELECT peer_id,remote_id,file_hash,file_size,file_path FROM peer_downloads
  WHERE file_hash IS NOT NULL AND file_hash<>'' AND file_size>=?)
SELECT file_hash,file_size,COUNT(*) AS n,json_group_array(json_object('peerId',peer_id,'remoteId',remote_id,'filePath',file_path))
 FROM all_rows GROUP BY file_hash,file_size HAVING COUNT(*)>1 ORDER BY n DESC,file_size DESC LIMIT ?`, minSize, minSize, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Conflict{}
	for rows.Next() {
		var c Conflict
		var owners string
		if err = rows.Scan(&c.FileHash, &c.FileSize, &c.Count, &owners); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(owners), &c.Owners); err != nil {
			return nil, fmt.Errorf("decode conflict owners: %w", err)
		}
		sort.Slice(c.Owners, func(i, j int) bool {
			a, b := c.Owners[i], c.Owners[j]
			if (a.PeerID == SelfPeerID) != (b.PeerID == SelfPeerID) {
				return a.PeerID == SelfPeerID
			}
			if a.PeerID != b.PeerID {
				return a.PeerID < b.PeerID
			}
			return a.RemoteID < b.RemoteID
		})
		c.ID = ConflictID(c.FileHash, c.FileSize)
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s Store) Conflicts(ctx context.Context) ([]Conflict, error) {
	out := []Conflict{}
	if err := kvRead(ctx, s.Reader, conflictsKey, &out); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if out == nil {
		out = []Conflict{}
	}
	return out, nil
}

func (s Store) SweepStats(ctx context.Context) (SweepStats, error) {
	var out SweepStats
	if err := kvRead(ctx, s.Reader, sweepStatsKey, &out); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return SweepStats{}, err
	}
	return out, nil
}

// SaveSweep replaces the conflict list and its stats in one transaction.
func (s Store) SaveSweep(ctx context.Context, conflicts []Conflict, stats SweepStats) error {
	tx, err := s.Writer.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = kvWrite(ctx, tx, conflictsKey, conflicts); err != nil {
		return err
	}
	if err = kvWrite(ctx, tx, sweepStatsKey, stats); err != nil {
		return err
	}
	detail := fmt.Sprintf("conflicts=%d duplicateRows=%d wastedBytes=%d", stats.Conflicts, stats.DuplicateRows, stats.WastedBytes)
	if err = audit(ctx, tx, "", "sweep", detail, true); err != nil {
		return err
	}
	return tx.Commit()
}

// DropConflict removes a resolved conflict. It reports false when another
// resolve or a newer sweep already removed it.
func (s Store) DropConflict(ctx context.Context, id string) (bool, error) {
	tx, err := s.transaction(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	list := []Conflict{}
	if err = kvRead(ctx, tx, conflictsKey, &list); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	kept := list[:0]
	for _, c := range list {
		if c.ID != id {
			kept = append(kept, c)
		}
	}
	if len(kept) == len(list) {
		return false, nil
	}
	if err = kvWrite(ctx, tx, conflictsKey, kept); err != nil {
		return false, err
	}
	return true, tx.Commit()
}

// EnqueuePeerDelete records a delete the peer could not acknowledge.
func (s Store) EnqueuePeerDelete(ctx context.Context, peerID string, remoteID int64, reason string) (int64, error) {
	res, err := s.Writer.ExecContext(ctx, `INSERT INTO peer_delete_jobs(peer_id,remote_id,reason,created_at) VALUES(?,?,NULLIF(?,''),?)`, peerID, remoteID, reason, time.Now().UnixMilli())
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// DeleteRemoteFile asks a paired peer to delete one of its catalogued
// downloads through the signed /api/cluster/files/delete endpoint.
func (c *Client) DeleteRemoteFile(ctx context.Context, p Peer, remoteID int64, filePath, reason string) error {
	body, err := json.Marshal(map[string]any{"remote_id": remoteID, "file_path": filePath, "reason": reason})
	if err != nil {
		return err
	}
	res, err := c.Request(ctx, p, "POST", "/api/cluster/files/delete", body)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return fmt.Errorf("peer refused delete: HTTP %d %s", res.StatusCode, bytes.TrimSpace(msg))
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<16))
	return nil
}
