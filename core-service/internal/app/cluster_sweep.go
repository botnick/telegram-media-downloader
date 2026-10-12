package app

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/cluster"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

const (
	clusterSweepKind    = "cluster_sweep"
	clusterSweepLimit   = 500
	clusterSweepMinSize = 1024
	// One unreachable peer must not consume the whole resolve request.
	clusterRemoteDeleteTimeout = 5 * time.Second
)

// clusterSweepState is the single-flight slot of the dedup sweep. Status keeps
// the 2.x JobTracker snapshot shape served by GET /api/cluster/sweep/status.
type clusterSweepState struct {
	mu        sync.Mutex
	status    map[string]any
	cancel    context.CancelFunc
	resolveMu sync.Mutex
}

func (s *clusterSweepState) snapshot() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.status == nil {
		return maintenanceIdleStatus(clusterSweepKind)
	}
	return cloneConfigValue(s.status).(map[string]any)
}

func (a *App) handleClusterSweepRun(w http.ResponseWriter, r *http.Request) {
	body, ok := readAuthBody(w, r)
	if !ok {
		return
	}
	minSize := int64(number(body["minSize"], clusterSweepMinSize))
	if minSize <= 0 {
		minSize = clusterSweepMinSize
	}
	s := &a.clusterSweep
	s.mu.Lock()
	if s.status != nil && s.status["running"] == true {
		snap := cloneConfigValue(s.status)
		s.mu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]any{"started": false, "code": "ALREADY_RUNNING", "snapshot": snap})
		return
	}
	prev := s.status
	if prev == nil {
		prev = maintenanceIdleStatus(clusterSweepKind)
	}
	attempts, _ := prev["attempts"].(int)
	status := maintenanceIdleStatus(clusterSweepKind)
	status["successes"], status["failures"] = prev["successes"], prev["failures"]
	started := time.Now()
	status["attempts"], status["running"], status["stage"], status["startedAt"] = attempts+1, true, "starting", started.UnixMilli()
	ctx, cancel := context.WithCancel(a.ctx)
	s.status, s.cancel = status, cancel
	snap := cloneConfigValue(status).(map[string]any)
	s.mu.Unlock()
	// Announce the start before the worker can emit its first progress tick.
	a.hub.Broadcast(ws.Event{Type: clusterSweepKind + "_progress", Flat: true, Payload: snap})
	if !a.launchMaintenance(func() { a.runClusterSweep(ctx, cancel, minSize, started) }) {
		cancel()
		s.mu.Lock()
		s.status, s.cancel = prev, nil
		s.mu.Unlock()
		writeJSONError(w, http.StatusServiceUnavailable, "server is stopping")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"started": true})
}

// runClusterSweep emits the 2.x event sequence: one cluster_sweep_progress per
// conflict, the sweep's own cluster_sweep_done and then the tracker's
// cluster_sweep_done carrying the full stats.
func (a *App) runClusterSweep(ctx context.Context, cancel context.CancelFunc, minSize int64, started time.Time) {
	defer cancel()
	stats, err := a.sweepClusterDuplicates(ctx, minSize, started)
	finished := time.Now()
	s := &a.clusterSweep
	s.mu.Lock()
	// Clear the slot under the same lock that marks the run finished so a
	// cancel can never reach the next run.
	s.cancel = nil
	status := s.status
	status["running"], status["finishedAt"], status["durationMs"] = false, finished.UnixMilli(), finished.Sub(started).Milliseconds()
	payload := map[string]any{"kind": clusterSweepKind, "durationMs": finished.Sub(started).Milliseconds()}
	if err != nil {
		failures, _ := status["failures"].(int)
		status["stage"], status["error"], status["failures"] = "error", err.Error(), failures+1
		payload["error"] = err.Error()
	} else {
		successes, _ := status["successes"].(int)
		result := sweepStatsJSON(stats)
		status["stage"], status["error"], status["successes"], status["result"] = "done", nil, successes+1, result
		for k, v := range result {
			payload[k] = v
		}
		payload["durationMs"] = finished.Sub(started).Milliseconds()
	}
	s.mu.Unlock()
	a.hub.Broadcast(ws.Event{Type: clusterSweepKind + "_done", Flat: true, Payload: payload})
}

func sweepStatsJSON(stats cluster.SweepStats) map[string]any {
	if stats.LastRunAt == 0 {
		return map[string]any{}
	}
	return map[string]any{"lastRunAt": stats.LastRunAt, "durationMs": stats.DurationMs, "conflicts": stats.Conflicts, "duplicateRows": stats.DuplicateRows, "wastedBytes": stats.WastedBytes}
}

// sweepClusterDuplicates replaces the stored conflict list. A cancelled run
// keeps the previous list rather than persisting a partial one.
func (a *App) sweepClusterDuplicates(ctx context.Context, minSize int64, started time.Time) (cluster.SweepStats, error) {
	conflicts, err := a.cluster.FindDuplicates(ctx, minSize, clusterSweepLimit)
	if err != nil {
		return cluster.SweepStats{}, err
	}
	stats := cluster.SweepStats{LastRunAt: started.UnixMilli(), Conflicts: len(conflicts)}
	for i, c := range conflicts {
		if err = ctx.Err(); err != nil {
			return cluster.SweepStats{}, err
		}
		stats.DuplicateRows += c.Count - 1
		stats.WastedBytes += int64(c.Count-1) * c.FileSize
		a.hub.Broadcast(ws.Event{Type: clusterSweepKind + "_progress", Flat: true, Payload: map[string]any{"conflicts": i + 1}})
	}
	stats.DurationMs = time.Since(started).Milliseconds()
	if err = a.cluster.SaveSweep(ctx, conflicts, stats); err != nil {
		return cluster.SweepStats{}, err
	}
	a.hub.Broadcast(ws.Event{Type: clusterSweepKind + "_done", Flat: true, Payload: map[string]any{"conflicts": stats.Conflicts, "duplicateRows": stats.DuplicateRows, "wastedBytes": stats.WastedBytes, "durationMs": stats.DurationMs}})
	return stats, nil
}

func (a *App) handleClusterSweepStatus(w http.ResponseWriter, r *http.Request) {
	conflicts, stats, err := a.clusterConflictState(r.Context())
	if err != nil {
		writeJSONError(w, 500, "Cluster sweep state read failed")
		return
	}
	out := a.clusterSweep.snapshot()
	out["conflicts"], out["stats"] = conflicts, sweepStatsJSON(stats)
	writeJSON(w, 200, out)
}

func (a *App) handleClusterSweepCancel(w http.ResponseWriter, _ *http.Request) {
	s := &a.clusterSweep
	s.mu.Lock()
	running := s.cancel != nil
	if running {
		s.cancel()
	}
	s.mu.Unlock()
	writeJSON(w, 200, map[string]any{"ok": running})
}

func (a *App) clusterConflictState(ctx context.Context) ([]cluster.Conflict, cluster.SweepStats, error) {
	conflicts, err := a.cluster.Conflicts(ctx)
	if err != nil {
		return nil, cluster.SweepStats{}, err
	}
	stats, err := a.cluster.SweepStats(ctx)
	return conflicts, stats, err
}

func (a *App) handleClusterConflicts(w http.ResponseWriter, r *http.Request) {
	conflicts, stats, err := a.clusterConflictState(r.Context())
	if err != nil {
		writeJSONError(w, 500, "Cluster conflicts read failed")
		return
	}
	writeJSON(w, 200, map[string]any{"conflicts": conflicts, "stats": sweepStatsJSON(stats)})
}

type clusterResolveResult struct {
	Unlinked      int64 `json:"unlinked"`
	RemoteDeleted int   `json:"remoteDeleted"`
	Queued        int   `json:"queued"`
}

// handleClusterResolve keeps one copy of a conflict and removes every other:
// local rows are deleted (their file once nothing else references it), peer
// rows are deleted through the peer's signed endpoint or queued in
// peer_delete_jobs when the peer cannot acknowledge.
func (a *App) handleClusterResolve(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Keep *struct {
			PeerID   string          `json:"peerId"`
			RemoteID json.RawMessage `json:"remoteId"`
		} `json:"keep"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&in); err != nil && !errors.Is(err, io.EOF) {
		writeJSONError(w, 400, "Invalid JSON body")
		return
	}
	var keepID int64
	var err error
	if in.Keep != nil {
		keepID, err = strconv.ParseInt(strings.Trim(string(in.Keep.RemoteID), `"`), 10, 64)
	}
	if in.Keep == nil || in.Keep.PeerID == "" || err != nil {
		writeJSONError(w, 400, "keep.peerId + keep.remoteId required")
		return
	}
	id := r.PathValue("id")
	s := &a.clusterSweep
	s.resolveMu.Lock()
	defer s.resolveMu.Unlock()
	conflicts, err := a.cluster.Conflicts(r.Context())
	if err != nil {
		writeJSONError(w, 500, "Cluster conflicts read failed")
		return
	}
	var conflict *cluster.Conflict
	for i := range conflicts {
		if conflicts[i].ID == id {
			conflict = &conflicts[i]
			break
		}
	}
	if conflict == nil {
		writeJSONError(w, 404, "conflict not found (already resolved or expired)")
		return
	}
	self, err := a.cluster.Identity(r.Context())
	if err != nil {
		writeJSONError(w, 500, "Cluster identity read failed")
		return
	}
	local := func(peer string) bool { return peer == cluster.SelfPeerID || peer == self.PeerID }
	same := func(o cluster.ConflictOwner) bool {
		return o.RemoteID == keepID && (o.PeerID == in.Keep.PeerID || local(o.PeerID) && local(in.Keep.PeerID))
	}
	var losers []cluster.ConflictOwner
	kept := false
	for _, o := range conflict.Owners {
		if same(o) {
			kept = true
		} else {
			losers = append(losers, o)
		}
	}
	// 2.x accepted any keeper, which removed every copy when the keeper was
	// not part of the group. Refuse instead of deleting the last copy.
	if !kept {
		writeJSONError(w, 400, "keep must be one of the conflict's copies")
		return
	}
	res, err := a.resolveClusterConflict(r.Context(), *conflict, losers, local, fmt.Sprintf("cluster_dedup keeper=%s:%d", in.Keep.PeerID, keepID))
	if err != nil {
		writeJSONError(w, 500, "Conflict resolution failed: "+err.Error())
		return
	}
	if _, err = a.cluster.DropConflict(r.Context(), id); err != nil {
		writeJSONError(w, 500, "Conflict list write failed")
		return
	}
	_ = a.cluster.Audit(r.Context(), "", "sweep", fmt.Sprintf("resolve %s: kept=%s:%d unlinked=%d remote_deleted=%d queued=%d", id, in.Keep.PeerID, keepID, res.Unlinked, res.RemoteDeleted, res.Queued), true)
	writeJSON(w, 200, res)
}

func (a *App) resolveClusterConflict(ctx context.Context, c cluster.Conflict, losers []cluster.ConflictOwner, local func(string) bool, reason string) (clusterResolveResult, error) {
	var res clusterResolveResult
	var ids []string
	args := []any{}
	for _, o := range losers {
		if local(o.PeerID) {
			ids = append(ids, "?")
			args = append(args, o.RemoteID)
		}
	}
	if len(ids) > 0 {
		// Match the hash too so a stale conflict never deletes a row whose
		// content changed since the sweep.
		args = append(args, c.FileHash, c.FileSize)
		n, err := a.deleteByWhere(contextRequest(ctx), `id IN (`+strings.Join(ids, ",")+`) AND file_hash=? AND file_size=?`, args...)
		if err != nil && n == 0 {
			return res, err
		}
		res.Unlinked = n
	}
	for _, o := range losers {
		if local(o.PeerID) {
			continue
		}
		if a.deleteOnPeer(ctx, o) {
			res.RemoteDeleted++
			continue
		}
		if _, err := a.cluster.EnqueuePeerDelete(ctx, o.PeerID, o.RemoteID, reason); err != nil {
			return res, err
		}
		res.Queued++
	}
	if res.RemoteDeleted > 0 {
		a.wakeClusterSync()
	}
	return res, nil
}

func (a *App) deleteOnPeer(ctx context.Context, o cluster.ConflictOwner) bool {
	p, err := a.cluster.Peer(ctx, o.PeerID)
	if err != nil || p.Status == "revoked" {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, clusterRemoteDeleteTimeout)
	defer cancel()
	return a.clusterHTTP.DeleteRemoteFile(ctx, p, o.RemoteID, o.FilePath, "cluster_dedup") == nil
}

// handlePeerFileDelete is the signed peer side of a dedup resolve: it deletes
// one catalogued download by id (or path) on behalf of a paired peer.
func (a *App) handlePeerFileDelete(w http.ResponseWriter, r *http.Request) {
	p, ok := r.Context().Value(clusterPeerKey{}).(cluster.Peer)
	if !ok {
		writeJSONError(w, 401, "cluster auth failed")
		return
	}
	var in struct {
		FilePath string `json:"file_path"`
		RemoteID *int64 `json:"remote_id"`
		Reason   string `json:"reason"`
	}
	if decodeBody(w, r, &in) != nil {
		return
	}
	query, arg := `SELECT id,file_path,COALESCE(file_size,0) FROM downloads WHERE file_path=? AND file_path<>'' LIMIT 1`, any(in.FilePath)
	if in.RemoteID != nil {
		query, arg = `SELECT id,file_path,COALESCE(file_size,0) FROM downloads WHERE id=? AND file_path IS NOT NULL AND file_path<>''`, *in.RemoteID
	} else if in.FilePath == "" {
		writeJSONError(w, 400, "remote_id or file_path required")
		return
	}
	var id, size int64
	var path string
	err := a.db.Reader.QueryRowContext(r.Context(), query, arg).Scan(&id, &path, &size)
	if errors.Is(err, sql.ErrNoRows) {
		writeJSONError(w, 404, "file not catalogued")
		return
	}
	if err != nil {
		writeJSONError(w, 500, "Catalog read failed")
		return
	}
	n, err := a.deleteByWhere(r, `id=?`, id)
	if err != nil && n == 0 {
		writeJSONError(w, 500, "Delete failed")
		return
	}
	var shared int
	freed := int64(0)
	if a.db.Reader.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM downloads WHERE REPLACE(file_path,char(92),'/')=REPLACE(?,char(92),'/')`, path).Scan(&shared) == nil && shared == 0 {
		freed = size
	}
	reason := in.Reason
	if reason == "" {
		reason = "-"
	}
	_ = a.cluster.Audit(r.Context(), p.PeerID, "cross_delete", fmt.Sprintf("%s (reason=%s)", path, reason), true)
	writeJSON(w, 200, map[string]any{"deleted": true, "freedBytes": freed})
}

// A 1x1 transparent PNG keeps gallery tiles stable while a peer is offline.
var peerThumbPlaceholder, _ = base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")

func writePeerThumbPlaceholder(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=60")
	_, _ = w.Write(peerThumbPlaceholder)
}

func thumbImageType(b []byte) string {
	switch {
	case len(b) >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP":
		return "image/webp"
	case len(b) >= 4 && b[0] == 0x89 && string(b[1:4]) == "PNG":
		return "image/png"
	case len(b) >= 3 && b[0] == 0xff && b[1] == 0xd8 && b[2] == 0xff:
		return "image/jpeg"
	}
	return ""
}

// handleClusterThumb proxies a federated gallery thumbnail from the peer's
// signed /api/cluster/peer-thumbs endpoint.
func (a *App) handleClusterThumb(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("remoteID"), 10, 64)
	if err != nil || id <= 0 {
		writeText(w, r, 400, "Bad id")
		return
	}
	p, err := a.cluster.Peer(r.Context(), r.PathValue("peerID"))
	if err != nil || p.Status == "revoked" {
		writePeerThumbPlaceholder(w)
		return
	}
	target := "/api/cluster/peer-thumbs/" + strconv.FormatInt(id, 10)
	if width := r.URL.Query().Get("w"); width != "" {
		target += "?w=" + url.QueryEscape(width)
	}
	res, err := a.clusterHTTP.Request(r.Context(), p, "GET", target, nil)
	if err != nil {
		writePeerThumbPlaceholder(w)
		return
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	kind := thumbImageType(body)
	if err != nil || res.StatusCode != 200 || kind == "" {
		writePeerThumbPlaceholder(w)
		return
	}
	w.Header().Set("Content-Type", kind)
	w.Header().Set("Cache-Control", "public, max-age=86400, immutable")
	_, _ = w.Write(body)
}
