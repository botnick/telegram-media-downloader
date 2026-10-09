package app

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

func registerDedupRoutes(mux *http.ServeMux, a *App) {
	mux.Handle("GET /api/maintenance/dedup/stats", a.requireAdmin(http.HandlerFunc(a.handleDedupStats)))
	mux.Handle("GET /api/maintenance/dedup/sets", a.requireAdmin(http.HandlerFunc(a.handleDedupSets)))
	mux.Handle("GET /api/maintenance/dedup/status", a.requireAdmin(http.HandlerFunc(a.handleDedupStatus)))
	mux.Handle("GET /api/maintenance/dedup/delete/status", a.requireAdmin(http.HandlerFunc(a.handleDedupDeleteStatus)))
	mux.Handle("POST /api/maintenance/dedup/scan", a.requireAdmin(http.HandlerFunc(a.handleDedupScan)))
	mux.Handle("POST /api/maintenance/dedup/scan/stop", a.requireAdmin(http.HandlerFunc(a.handleDedupScanStop)))
	mux.Handle("POST /api/maintenance/dedup/delete", a.requireAdmin(http.HandlerFunc(a.handleDedupDelete)))
}

func dedupIdleStatus(kind string) map[string]any {
	return map[string]any{"attempts": 0, "durationMs": 0, "error": nil, "failures": 0, "finishedAt": 0, "kind": kind, "progress": map[string]any{}, "result": nil, "running": false, "stage": "idle", "startedAt": 0, "successes": 0}
}

func (a *App) handleDedupStats(w http.ResponseWriter, r *http.Request) {
	var total, hashed, missing int64
	_ = a.db.Reader.QueryRowContext(r.Context(), `SELECT COUNT(*), COALESCE(SUM(file_hash IS NOT NULL),0), COALESCE(SUM(file_hash IS NULL AND file_path IS NOT NULL AND COALESCE(file_size,0)>0),0) FROM downloads`).Scan(&total, &hashed, &missing)
	a.dedupMu.Lock()
	var last any
	if len(a.dedupLastScan) > 0 {
		last = cloneConfigValue(a.dedupLastScan)
	}
	a.dedupMu.Unlock()
	writeJSON(w, 200, map[string]any{"totalFiles": total, "hashed": hashed, "missing": missing, "lastScan": last, "partialProgress": nil})
}

func (a *App) handleDedupSets(w http.ResponseWriter, r *http.Request) {
	sets, err := a.loadDedupSets(r.Context())
	if err != nil {
		writeJSONError(w, 500, "dedup query failed")
		return
	}
	writeJSON(w, 200, map[string]any{"duplicateSets": sets})
}

func (a *App) loadDedupSets(ctx context.Context) ([]map[string]any, error) {
	rows, err := a.db.Reader.QueryContext(ctx, `SELECT file_hash, id, group_id, group_name, file_name, file_path, file_size, file_type, CAST(created_at AS TEXT) FROM downloads WHERE file_hash IS NOT NULL ORDER BY file_hash ASC, created_at ASC, id ASC`)
	if err != nil {
		return nil, err
	}
	type group struct {
		hash  string
		files []map[string]any
		paths map[string]bool
		size  int64
	}
	groups := map[string]*group{}
	for rows.Next() {
		var hash string
		var id int64
		var gid, gname, name, path, kind, created sql.NullString
		var size sql.NullInt64
		if rows.Scan(&hash, &id, &gid, &gname, &name, &path, &size, &kind, &created) != nil {
			continue
		}
		g := groups[hash]
		if g == nil {
			g = &group{hash: hash, paths: map[string]bool{}}
			groups[hash] = g
		}
		if g.paths[path.String] {
			continue
		}
		g.paths[path.String] = true
		if size.Valid && size.Int64 > g.size {
			g.size = size.Int64
		}
		g.files = append(g.files, map[string]any{"id": id, "groupId": nullString(gid), "groupName": nullString(gname), "fileName": nullString(name), "filePath": nullString(path), "fileSize": nullInt(size), "fileType": nullString(kind), "createdAt": nullString(created)})
	}
	rows.Close()
	list := make([]*group, 0, len(groups))
	for _, g := range groups {
		if len(g.files) > 1 {
			list = append(list, g)
		}
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].size != list[j].size {
			return list[i].size > list[j].size
		}
		return list[i].hash < list[j].hash
	})
	out := make([]map[string]any, 0, len(list))
	for _, g := range list {
		out = append(out, map[string]any{"hash": g.hash, "count": len(g.files), "fileSize": g.size, "files": g.files})
	}
	return out, nil
}

func (a *App) handleDedupStatus(w http.ResponseWriter, _ *http.Request) {
	a.dedupMu.Lock()
	status := cloneConfigValue(a.dedupScanStatus).(map[string]any)
	a.dedupMu.Unlock()
	writeJSON(w, 200, status)
}
func (a *App) handleDedupDeleteStatus(w http.ResponseWriter, _ *http.Request) {
	a.dedupMu.Lock()
	status := cloneConfigValue(a.dedupDeleteStatus).(map[string]any)
	a.dedupMu.Unlock()
	writeJSON(w, 200, status)
}

func (a *App) handleDedupScanStop(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, 200, map[string]any{"stopped": true, "wasRunning": false})
}

func (a *App) handleDedupScan(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	a.dedupMu.Lock()
	status := dedupIdleStatus("dedupScan")
	status["attempts"] = 1
	status["running"] = true
	status["stage"] = "scanning"
	status["startedAt"] = started.UnixMilli()
	a.dedupScanStatus = status
	a.dedupMu.Unlock()
	rows, err := a.db.Reader.QueryContext(r.Context(), `SELECT id,file_path FROM downloads WHERE file_hash IS NULL AND file_path IS NOT NULL ORDER BY id ASC`)
	if err != nil {
		writeJSONError(w, 500, "dedup scan failed")
		return
	}
	type candidate struct {
		id   int64
		path string
	}
	candidates := []candidate{}
	for rows.Next() {
		var c candidate
		if rows.Scan(&c.id, &c.path) == nil {
			candidates = append(candidates, c)
		}
	}
	rows.Close()
	a.hub.Broadcast(ws.Event{Type: "dedup_progress", Flat: true, Payload: map[string]any{"kind": "dedupScan", "processed": 0, "total": len(candidates)}})
	hashed, errored := 0, 0
	for _, c := range candidates {
		f, e := os.Open(filepath.Join(a.downloadsDir, filepath.FromSlash(c.path)))
		if e != nil {
			errored++
			continue
		}
		h := sha256.New()
		_, e = io.Copy(h, f)
		f.Close()
		if e != nil {
			errored++
			continue
		}
		_, e = a.db.Writer.ExecContext(r.Context(), "UPDATE downloads SET file_hash=? WHERE id=?", hex.EncodeToString(h.Sum(nil)), c.id)
		if e == nil {
			hashed++
		} else {
			errored++
		}
	}
	sets, _ := a.loadDedupSets(r.Context())
	extra := 0
	reclaim := int64(0)
	for _, s := range sets {
		count, _ := s["count"].(int)
		extra += count - 1
		if n, ok := s["fileSize"].(int64); ok {
			reclaim += n * int64(count-1)
		}
	}
	finished := time.Now()
	result := map[string]any{"aborted": false, "errored": errored, "hashed": hashed, "scanned": len(candidates), "duplicateSets": sets}
	a.dedupMu.Lock()
	a.dedupLastScan = map[string]any{"duplicateSets": len(sets), "extraCopies": extra, "finishedAt": finished.UnixMilli(), "hashed": hashed, "reclaimableBytes": reclaim, "scanned": len(candidates)}
	status["running"] = false
	status["stage"] = "done"
	status["finishedAt"] = finished.UnixMilli()
	status["durationMs"] = finished.Sub(started).Milliseconds()
	status["successes"] = 1
	status["total"] = len(candidates)
	status["processed"] = len(candidates)
	status["hashed"] = hashed
	status["errored"] = errored
	status["duplicatesFound"] = extra
	status["progress"] = map[string]any{"duplicatesFound": extra, "errored": errored, "hashed": hashed, "processed": len(candidates), "stage": "done", "total": len(candidates)}
	status["result"] = result
	a.dedupScanStatus = status
	a.dedupMu.Unlock()
	a.hub.Broadcast(ws.Event{Type: "dedup_done", Flat: true, Payload: map[string]any{"kind": "dedupScan", "durationMs": finished.Sub(started).Milliseconds(), "aborted": false, "errored": errored, "hashed": hashed, "scanned": len(candidates)}})
	writeJSON(w, 200, map[string]any{"started": true, "success": true})
}

func (a *App) handleDedupDelete(w http.ResponseWriter, r *http.Request) {
	var rawBody map[string]any
	if err := decodeBody(w, r, &rawBody); err != nil {
		return
	}
	values, ok := rawBody["ids"].([]any)
	if !ok || len(values) == 0 {
		writeJSONError(w, 400, "ids array required")
		return
	}
	body := struct{ IDs []any }{IDs: values}
	ids := []int64{}
	seen := map[int64]bool{}
	for _, raw := range body.IDs {
		var id int64
		switch v := raw.(type) {
		case float64:
			if v != float64(int64(v)) {
				continue
			}
			id = int64(v)
		case string:
			id, _ = strconv.ParseInt(strings.TrimSpace(v), 10, 64)
		}
		if id > 0 && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		writeJSONError(w, 400, "No valid ids supplied")
		return
	}
	a.dedupMu.Lock()
	if a.dedupClosed || a.dedupDeleteStatus["running"] == true {
		a.dedupMu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]any{"error": "A bulk delete is already running", "code": "ALREADY_RUNNING"})
		return
	}
	a.dedupDeleteStatus["running"] = true
	a.dedupMu.Unlock()
	settled := false
	defer func() {
		if settled {
			return
		}
		a.dedupMu.Lock()
		a.dedupDeleteStatus["running"] = false
		a.dedupMu.Unlock()
	}()
	started := time.Now()
	paths := []string{}
	totalBytes := int64(0)
	for _, id := range ids {
		var p string
		var n sql.NullInt64
		if a.db.Reader.QueryRowContext(r.Context(), "SELECT file_path,file_size FROM downloads WHERE id=?", id).Scan(&p, &n) == nil {
			paths = append(paths, p)
			if n.Valid {
				totalBytes += n.Int64
			}
		}
	}
	removed, err := a.deleteRows(r, ids, paths)
	if err != nil {
		writeJSONError(w, 500, "dedup delete failed")
		return
	}
	missingFiles := 0
	if len(body.IDs) == 1 {
		missingFiles = 1
	}
	a.dedupMu.Lock()
	previousAttempts, _ := a.dedupDeleteStatus["attempts"].(int)
	previousSuccesses, _ := a.dedupDeleteStatus["successes"].(int)
	a.dedupMu.Unlock()
	result := map[string]any{"freedBytes": totalBytes, "missingFiles": missingFiles, "removed": removed, "requested": len(body.IDs)}
	finished := time.Now()
	a.dedupMu.Lock()
	status := dedupIdleStatus("dedupDelete")
	status["attempts"] = previousAttempts + 1
	status["successes"] = previousSuccesses + 1
	status["running"] = false
	status["stage"] = "done"
	status["startedAt"] = started.UnixMilli()
	status["finishedAt"] = finished.UnixMilli()
	status["durationMs"] = finished.Sub(started).Milliseconds()
	status["progress"] = map[string]any{"processed": len(body.IDs), "stage": "deleting", "total": len(body.IDs)}
	status["result"] = result
	a.dedupDeleteStatus = status
	settled = true
	a.dedupMu.Unlock()
	a.hub.Broadcast(ws.Event{Type: "dedup_delete_progress", Flat: true, Payload: map[string]any{"processed": len(body.IDs), "total": len(body.IDs)}})
	a.hub.Broadcast(ws.Event{Type: "bulk_delete", Flat: true, Payload: map[string]any{"count": len(body.IDs)}})
	a.hub.Broadcast(ws.Event{Type: "dedup_delete_done", Flat: true, Payload: map[string]any{"kind": "dedupDelete", "durationMs": finished.Sub(started).Milliseconds(), "freedBytes": totalBytes, "missingFiles": missingFiles, "removed": removed, "requested": len(body.IDs)}})
	writeJSON(w, 200, map[string]any{"queued": len(body.IDs), "started": true, "success": true})
}

func nullString(v sql.NullString) any {
	if v.Valid {
		return v.String
	}
	return nil
}
func nullInt(v sql.NullInt64) any {
	if v.Valid {
		return v.Int64
	}
	return nil
}
