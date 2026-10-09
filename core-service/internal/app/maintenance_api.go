package app

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

var reMessageID = regexp.MustCompile(`_(\d+)\.[^.]+$`)

func registerMaintenanceRoutes(mux *http.ServeMux, a *App) {
	admin := func(h http.HandlerFunc) http.Handler { return a.requireAdmin(http.HandlerFunc(h)) }
	mux.Handle("POST /api/maintenance/db/integrity", admin(a.handleDBIntegrity))
	mux.Handle("GET /api/maintenance/db/integrity/status", admin(a.handleDBIntegrityStatus))
	mux.Handle("POST /api/maintenance/files/verify", admin(a.handleFilesVerify))
	mux.Handle("GET /api/maintenance/files/verify/status", admin(a.handleFilesVerifyStatus))
	mux.Handle("GET /api/maintenance/files/verify/stats", admin(a.handleFilesVerifyStats))
	mux.Handle("POST /api/maintenance/reindex", admin(a.handleReindex))
	mux.Handle("GET /api/maintenance/reindex/status", admin(a.handleReindexStatus))
	mux.Handle("GET /api/maintenance/reindex/stats", admin(a.handleReindexStats))
	mux.Handle("POST /api/maintenance/db/vacuum", admin(a.handleDBVacuum))
	mux.Handle("GET /api/maintenance/db/vacuum/status", admin(a.handleDBVacuumStatus))
}

func maintenanceIdleStatus(kind string) map[string]any {
	return map[string]any{"attempts": 0, "durationMs": 0, "error": nil, "failures": 0, "finishedAt": 0, "kind": kind, "progress": map[string]any{}, "result": nil, "running": false, "stage": "idle", "startedAt": 0, "successes": 0}
}

func (a *App) handleDBIntegrityStatus(w http.ResponseWriter, _ *http.Request) {
	a.maintenanceMu.Lock()
	v := cloneConfigValue(a.dbIntegrityStatus)
	a.maintenanceMu.Unlock()
	writeJSON(w, http.StatusOK, v)
}

func (a *App) handleDBIntegrity(w http.ResponseWriter, r *http.Request) {
	a.maintenanceMu.Lock()
	if a.dbIntegrityStatus["running"] == true {
		a.maintenanceMu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]any{"error": "An integrity check is already running", "code": "ALREADY_RUNNING"})
		return
	}
	attempts, _ := a.dbIntegrityStatus["attempts"].(int)
	successes, _ := a.dbIntegrityStatus["successes"].(int)
	status := maintenanceIdleStatus("dbIntegrity")
	started := time.Now()
	status["attempts"], status["running"], status["stage"], status["startedAt"] = attempts+1, true, "checking", started.UnixMilli()
	a.dbIntegrityStatus = cloneConfigValue(status).(map[string]any)
	a.maintenanceMu.Unlock()
	if !a.launchMaintenance(func() { a.runDBIntegrity(a.ctx, status, started, successes) }) {
		writeJSONError(w, http.StatusServiceUnavailable, "server is stopping")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"started": true, "success": true})
}

func (a *App) runDBIntegrity(_ context.Context, status map[string]any, started time.Time, previousSuccesses int) {
	a.hub.Broadcast(ws.Event{Type: "db_integrity_progress", Flat: true, Payload: map[string]any{"stage": "checking"}})
	messages := []string{}
	rows, err := a.db.Reader.Query("PRAGMA integrity_check")
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var msg string
			if rows.Scan(&msg) == nil && msg != "" {
				messages = append(messages, msg)
			}
		}
		err = rows.Err()
	}
	if len(messages) == 0 && err == nil {
		messages = []string{"ok"}
	}
	ok := err == nil && len(messages) == 1 && messages[0] == "ok"
	finished := time.Now()
	result := map[string]any{"messages": messages, "ok": ok}
	status["running"], status["stage"], status["finishedAt"], status["durationMs"], status["successes"], status["result"] = false, "done", finished.UnixMilli(), finished.Sub(started).Milliseconds(), previousSuccesses+1, result
	if err != nil {
		status["error"] = err.Error()
		status["failures"] = 1
	}
	a.maintenanceMu.Lock()
	a.dbIntegrityStatus = cloneConfigValue(status).(map[string]any)
	a.maintenanceMu.Unlock()
	a.hub.Broadcast(ws.Event{Type: "db_integrity_done", Flat: true, Payload: map[string]any{"durationMs": finished.Sub(started).Milliseconds(), "kind": "dbIntegrity", "messages": messages, "ok": ok}})
}

func (a *App) handleFilesVerifyStatus(w http.ResponseWriter, _ *http.Request) {
	a.maintenanceMu.Lock()
	v := cloneConfigValue(a.filesVerifyStatus)
	a.maintenanceMu.Unlock()
	writeJSON(w, http.StatusOK, v)
}

func (a *App) handleFilesVerifyStats(w http.ResponseWriter, _ *http.Request) {
	a.maintenanceMu.Lock()
	var last any
	if a.filesVerifyLastRun != nil {
		last = cloneConfigValue(a.filesVerifyLastRun)
	}
	a.maintenanceMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"lastRun": last})
}

type verifyRow struct {
	id   int64
	path string
	size sql.NullInt64
}

func (a *App) handleFilesVerify(w http.ResponseWriter, r *http.Request) {
	a.maintenanceMu.Lock()
	if a.filesVerifyStatus["running"] == true {
		a.maintenanceMu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]any{"error": "A file verification is already running", "code": "ALREADY_RUNNING"})
		return
	}
	attempts, _ := a.filesVerifyStatus["attempts"].(int)
	successes, _ := a.filesVerifyStatus["successes"].(int)
	status := maintenanceIdleStatus("filesVerify")
	started := time.Now()
	status["attempts"], status["running"], status["stage"], status["startedAt"] = attempts+1, true, "scanning", started.UnixMilli()
	a.filesVerifyStatus = cloneConfigValue(status).(map[string]any)
	a.maintenanceMu.Unlock()
	if !a.launchMaintenance(func() { a.runFilesVerify(status, started, successes) }) {
		writeJSONError(w, http.StatusServiceUnavailable, "server is stopping")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"started": true, "success": true})
}

func (a *App) runFilesVerify(status map[string]any, started time.Time, previousSuccesses int) {
	rows, err := a.db.Reader.Query(`SELECT id,file_path,file_size FROM downloads WHERE file_path IS NOT NULL ORDER BY id`)
	all := []verifyRow{}
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var row verifyRow
			if rows.Scan(&row.id, &row.path, &row.size) == nil {
				all = append(all, row)
			}
		}
		err = rows.Err()
	}
	total, pruned, fixed := len(all), 0, 0
	a.hub.Broadcast(ws.Event{Type: "files_verify_progress", Flat: true, Payload: map[string]any{"processed": 0, "total": total, "stage": "scanning"}})
	if err == nil {
		for i, row := range all {
			path := filepath.Join(a.dataDir, "downloads", filepath.FromSlash(strings.TrimPrefix(row.path, "data/downloads/")))
			st, statErr := os.Stat(path)
			if statErr != nil || !st.Mode().IsRegular() || st.Size() <= 0 {
				if _, e := a.db.Writer.Exec(`DELETE FROM downloads WHERE id = ?`, row.id); e == nil {
					pruned++
				}
			} else if !row.size.Valid || row.size.Int64 != st.Size() {
				if _, e := a.db.Writer.Exec(`UPDATE downloads SET file_size = ? WHERE id = ?`, st.Size(), row.id); e == nil {
					fixed++
				}
			}
			status["progress"] = map[string]any{"processed": i + 1, "pruned": pruned, "scanned": total, "sizeFixed": fixed, "stage": "scanning", "total": total}
		}
	}
	a.hub.Broadcast(ws.Event{Type: "integrity_swept", Flat: true, Payload: map[string]any{"pruned": pruned, "scanned": total}})
	result := map[string]any{"pruned": pruned, "scanned": total, "sizeFixed": fixed}
	finished := time.Now()
	status["running"], status["stage"], status["finishedAt"], status["durationMs"], status["successes"] = false, "done", finished.UnixMilli(), finished.Sub(started).Milliseconds(), previousSuccesses+1
	status["progress"] = map[string]any{"processed": total, "pruned": pruned, "scanned": total, "sizeFixed": fixed, "stage": "done", "total": total}
	status["result"] = result
	if err != nil {
		status["error"] = err.Error()
		status["failures"] = 1
	}
	a.maintenanceMu.Lock()
	a.filesVerifyStatus = cloneConfigValue(status).(map[string]any)
	// The old dashboard summary intentionally reports removed from its
	// persisted result, while the live status exposes pruned.
	a.filesVerifyLastRun = map[string]any{"finishedAt": finished.UnixMilli(), "removed": 0, "scanned": total}
	a.maintenanceMu.Unlock()
	a.hub.Broadcast(ws.Event{Type: "files_verify_progress", Flat: true, Payload: status["progress"]})
	a.hub.Broadcast(ws.Event{Type: "files_verify_done", Flat: true, Payload: map[string]any{"durationMs": finished.Sub(started).Milliseconds(), "kind": "filesVerify", "pruned": pruned, "scanned": total, "sizeFixed": fixed}})
}

func (a *App) handleReindexStatus(w http.ResponseWriter, _ *http.Request) {
	a.maintenanceMu.Lock()
	v := cloneConfigValue(a.reindexStatus)
	a.maintenanceMu.Unlock()
	writeJSON(w, http.StatusOK, v)
}

func (a *App) handleReindexStats(w http.ResponseWriter, _ *http.Request) {
	a.maintenanceMu.Lock()
	var last any
	if a.reindexLastRun != nil {
		last = cloneConfigValue(a.reindexLastRun)
	}
	a.maintenanceMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"lastRun": last})
}

func (a *App) handleReindex(w http.ResponseWriter, r *http.Request) {
	if a.purgePending() {
		writeJSON(w, http.StatusConflict, map[string]any{"error": errPurgePending.Error(), "code": "PURGE_IN_PROGRESS"})
		return
	}
	a.maintenanceMu.Lock()
	if a.reindexStatus["running"] == true {
		a.maintenanceMu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]any{"error": "A re-index is already running", "code": "ALREADY_RUNNING"})
		return
	}
	attempts, _ := a.reindexStatus["attempts"].(int)
	successes, _ := a.reindexStatus["successes"].(int)
	status := maintenanceIdleStatus("reindex")
	started := time.Now()
	status["attempts"], status["running"], status["stage"], status["startedAt"] = attempts+1, true, "walking", started.UnixMilli()
	a.reindexStatus = cloneConfigValue(status).(map[string]any)
	a.maintenanceMu.Unlock()
	if !a.launchMaintenance(func() { a.runReindex(a.ctx, status, started, successes) }) {
		writeJSONError(w, http.StatusServiceUnavailable, "server is stopping")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "started": true})
}

func (a *App) runReindex(ctx context.Context, status map[string]any, started time.Time, previousSuccesses int) {
	a.mediaMu.RLock()
	defer a.mediaMu.RUnlock()
	if err := a.mediaWritable(ctx); err != nil {
		a.maintenanceMu.Lock()
		status["running"], status["stage"], status["error"] = false, "error", err.Error()
		status["finishedAt"], status["durationMs"] = time.Now().UnixMilli(), time.Since(started).Milliseconds()
		status["failures"] = jobCount(status["failures"]) + 1
		a.reindexStatus = cloneConfigValue(status).(map[string]any)
		a.maintenanceMu.Unlock()
		a.hub.Broadcast(ws.Event{Type: "reindex_done", Flat: true, Payload: map[string]any{"error": err.Error(), "kind": "reindex", "durationMs": time.Since(started).Milliseconds()}})
		return
	}
	config, _ := a.config.Load(ctx)
	groupNames := map[string]string{}
	groupIDs := map[string]string{}
	if groups, ok := config["groups"].([]any); ok {
		for _, raw := range groups {
			if g, ok := raw.(map[string]any); ok {
				id, name := strings.TrimSpace(toString(g["id"])), toString(g["name"])
				if id != "" && name != "" {
					groupNames[name], groupIDs[name] = name, id
				}
			}
		}
	}
	root := filepath.Join(a.dataDir, "downloads")
	entries, _ := os.ReadDir(root)
	groupDirs := make([]string, 0)
	for _, entry := range entries {
		if entry.IsDir() && entry.Name() != ".deleted" {
			groupDirs = append(groupDirs, entry.Name())
		}
	}
	sort.Strings(groupDirs)
	totalGroups := len(groupDirs)
	status["total"] = totalGroups
	a.hub.Broadcast(ws.Event{Type: "reindex_progress", Flat: true, Payload: map[string]any{"processed": 0, "total": totalGroups, "stage": "walking"}})
	scanned, added, skipped, errorsCount, processed := 0, 0, 0, 0, 0
	for _, folder := range groupDirs {
		groupID, groupName := groupIDs[folder], groupNames[folder]
		if groupID == "" {
			groupID, groupName = "unknown:"+folder, folder
		}
		groupRoot := filepath.Join(root, folder)
		typeEntries, _ := os.ReadDir(groupRoot)
		for _, typeEntry := range typeEntries {
			if !typeEntry.IsDir() {
				if typeEntry.Type().IsRegular() {
					a.ingestReindexFile(ctx, filepath.Join(groupRoot, typeEntry.Name()), filepath.Join(folder, typeEntry.Name()), folder, groupID, groupName, &scanned, &added, &skipped, &errorsCount)
				}
				continue
			}
			files, _ := os.ReadDir(filepath.Join(groupRoot, typeEntry.Name()))
			for _, file := range files {
				if !file.Type().IsRegular() || strings.HasSuffix(file.Name(), ".part") {
					continue
				}
				rel := filepath.Join(folder, typeEntry.Name(), file.Name())
				a.ingestReindexFile(ctx, filepath.Join(groupRoot, typeEntry.Name(), file.Name()), rel, folder, groupID, groupName, &scanned, &added, &skipped, &errorsCount)
			}
		}
		processed++
		status["currentGroup"] = groupName
		progress := map[string]any{"added": added, "currentGroup": groupName, "errors": errorsCount, "groups": totalGroups, "processed": processed, "scanned": scanned, "skipped": skipped, "startedAt": started.UnixMilli(), "stage": "walking", "total": totalGroups}
		status["progress"] = progress
		a.hub.Broadcast(ws.Event{Type: "reindex_progress", Flat: true, Payload: progress})
	}
	finished := time.Now()
	result := map[string]any{"added": added, "errors": errorsCount, "finishedAt": finished.UnixMilli(), "groups": totalGroups, "scanned": scanned, "skipped": skipped, "startedAt": started.UnixMilli()}
	status["added"], status["errors"], status["groups"], status["processed"], status["scanned"], status["skipped"], status["total"] = added, errorsCount, totalGroups, processed, scanned, skipped, totalGroups
	status["running"], status["stage"], status["finishedAt"], status["durationMs"], status["successes"], status["currentGroup"], status["result"] = false, "done", finished.UnixMilli(), finished.Sub(started).Milliseconds(), previousSuccesses+1, lastGroupName(status), result
	status["progress"] = map[string]any{"added": added, "currentGroup": lastGroupName(status), "errors": errorsCount, "groups": totalGroups, "processed": processed, "scanned": scanned, "skipped": skipped, "startedAt": started.UnixMilli(), "total": totalGroups}
	a.maintenanceMu.Lock()
	a.reindexStatus = cloneConfigValue(status).(map[string]any)
	a.reindexLastRun = map[string]any{"added": added, "finishedAt": finished.UnixMilli(), "scanned": scanned}
	a.maintenanceMu.Unlock()
	// The disk walker emits its historical event, then the tracker emits the
	// normalized event consumed by the dashboard.
	a.hub.Broadcast(ws.Event{Type: "reindex_done", Flat: true, Payload: result})
	a.hub.Broadcast(ws.Event{Type: "reindex_done", Flat: true, Payload: map[string]any{"added": added, "durationMs": finished.Sub(started).Milliseconds(), "errors": errorsCount, "finishedAt": finished.UnixMilli(), "groups": totalGroups, "kind": "reindex", "scanned": scanned, "skipped": skipped, "startedAt": started.UnixMilli()}})
}

func lastGroupName(status map[string]any) string {
	if v, ok := status["currentGroup"].(string); ok {
		return v
	}
	return ""
}

func (a *App) ingestReindexFile(ctx context.Context, abs, rel, _ string, groupID, groupName string, scanned, added, skipped, errorsCount *int) {
	*scanned++
	st, err := os.Stat(abs)
	if err != nil || !st.Mode().IsRegular() || st.Size() <= 0 {
		*skipped++
		return
	}
	name := filepath.Base(abs)
	messageID := reindexMessageID(rel, name)
	fileType := reindexFileType(filepath.ToSlash(rel))
	_, err = a.db.Writer.ExecContext(ctx, `INSERT OR IGNORE INTO downloads(group_id,group_name,message_id,file_name,file_size,file_type,file_path,status) VALUES(?,?,?,?,?,?,?,'completed')`, groupID, groupName, messageID, name, st.Size(), fileType, filepath.ToSlash(rel))
	if err != nil {
		*errorsCount++
		return
	}
	var changes int64
	_ = a.db.Writer.QueryRowContext(ctx, `SELECT changes()`).Scan(&changes)
	if changes > 0 {
		*added++
	} else {
		*skipped++
	}
}

func reindexMessageID(rel, name string) int64 {
	if match := reMessageID.FindStringSubmatch(name); len(match) == 2 {
		if n, err := strconv.ParseInt(match[1], 10, 64); err == nil {
			return n
		}
	}
	sum := sha256.Sum256([]byte(rel))
	n := int64(binary.BigEndian.Uint32(sum[:4]))
	if n == 0 {
		n = 1
	}
	return -n
}

func reindexFileType(rel string) string {
	parts := strings.Split(rel, "/")
	if len(parts) >= 2 {
		switch parts[len(parts)-2] {
		case "images", "stickers":
			return "photo"
		case "videos", "gifs":
			return "video"
		case "audio":
			return "audio"
		case "documents", "others":
			return "document"
		}
	}
	ext := strings.ToLower(filepath.Ext(rel))
	if strings.Contains(".jpg.jpeg.png.webp.heic.heif.gif", ext) {
		return "photo"
	}
	if strings.Contains(".mp4.mov.avi.mkv.webm", ext) {
		return "video"
	}
	if strings.Contains(".mp3.ogg.wav.m4a.opus.flac", ext) {
		return "audio"
	}
	return "document"
}

func (a *App) handleDBVacuumStatus(w http.ResponseWriter, _ *http.Request) {
	a.maintenanceMu.Lock()
	v := cloneConfigValue(a.vacuumStatus)
	a.maintenanceMu.Unlock()
	writeJSON(w, http.StatusOK, v)
}

func (a *App) handleDBVacuum(w http.ResponseWriter, r *http.Request) {
	body, _ := readAuthBody(w, r)
	if body["confirm"] != true {
		writeJSONError(w, http.StatusBadRequest, `Pass {"confirm": true} in the request body to proceed.`)
		return
	}
	a.maintenanceMu.Lock()
	if a.vacuumStatus["running"] == true {
		a.maintenanceMu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]any{"error": "A vacuum is already running", "code": "ALREADY_RUNNING"})
		return
	}
	attempts, _ := a.vacuumStatus["attempts"].(int)
	successes, _ := a.vacuumStatus["successes"].(int)
	status := maintenanceIdleStatus("dbVacuum")
	status["failures"] = a.vacuumStatus["failures"]
	started := time.Now()
	status["attempts"], status["running"], status["stage"], status["startedAt"] = attempts+1, true, "vacuuming", started.UnixMilli()
	a.vacuumStatus = cloneConfigValue(status).(map[string]any)
	a.maintenanceMu.Unlock()
	if !a.launchMaintenance(func() { a.runDBVacuum(status, started, successes) }) {
		writeJSONError(w, http.StatusServiceUnavailable, "server is stopping")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"started": true, "success": true})
}

func (a *App) runDBVacuum(status map[string]any, started time.Time, previousSuccesses int) {
	a.hub.Broadcast(ws.Event{Type: "db_vacuum_progress", Flat: true, Payload: map[string]any{"stage": "vacuuming"}})
	// Hold the sole writer connection across both measurements and VACUUM so
	// another application write cannot be included on only one side. SQLite
	// may still grow a small database while repacking its schema/B-trees.
	var beforePages, afterPages, pageSize int64
	conn, err := a.db.Writer.Conn(a.ctx)
	if err == nil {
		defer conn.Close()
		err = conn.QueryRowContext(a.ctx, "PRAGMA page_count").Scan(&beforePages)
		if err == nil {
			err = conn.QueryRowContext(a.ctx, "PRAGMA page_size").Scan(&pageSize)
		}
		if err == nil {
			_, err = conn.ExecContext(a.ctx, "VACUUM")
		}
		if err == nil {
			err = conn.QueryRowContext(a.ctx, "PRAGMA page_count").Scan(&afterPages)
		}
	}
	finished := time.Now()
	status["running"], status["finishedAt"], status["durationMs"] = false, finished.UnixMilli(), finished.Sub(started).Milliseconds()
	payload := map[string]any{"kind": "dbVacuum", "durationMs": finished.Sub(started).Milliseconds()}
	if err != nil {
		status["stage"], status["error"], status["result"], status["successes"] = "error", err.Error(), nil, previousSuccesses
		failures, _ := status["failures"].(int)
		status["failures"] = failures + 1
		payload["error"] = err.Error()
	} else {
		beforeBytes, afterBytes := beforePages*pageSize, afterPages*pageSize
		result := map[string]any{"beforeBytes": beforeBytes, "afterBytes": afterBytes, "reclaimedBytes": maxInt64(0, beforeBytes-afterBytes)}
		status["stage"], status["error"], status["successes"], status["result"] = "done", nil, previousSuccesses+1, result
		for k, v := range result {
			payload[k] = v
		}
	}
	a.maintenanceMu.Lock()
	a.vacuumStatus = cloneConfigValue(status).(map[string]any)
	a.maintenanceMu.Unlock()
	a.hub.Broadcast(ws.Event{Type: "db_vacuum_done", Flat: true, Payload: payload})
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
