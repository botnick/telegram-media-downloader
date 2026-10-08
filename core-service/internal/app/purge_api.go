package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

// The plan and row deletion commit together. Cleanup is repeatable: a process
// exit cannot lose the requested operation or its original row/file counts.
type purgeRecord struct {
	Key            string         `json:"key"`
	GroupID        string         `json:"groupId"`
	GroupName      string         `json:"groupName"`
	All            bool           `json:"all"`
	FilesOnly      bool           `json:"filesOnly"`
	Phase          string         `json:"phase"`
	Paths          []string       `json:"paths"`
	ResetEntries   []string       `json:"resetEntries"`
	ResetFiles     int            `json:"resetFiles"`
	DeletedRows    int64          `json:"deletedRows"`
	DeletedQueue   int64          `json:"deletedQueue"`
	AccessIDs      []string       `json:"accessIds"`
	RestartMonitor bool           `json:"restartMonitor"`
	Status         map[string]any `json:"status"`
}

var purgePhotoUnsafe = regexp.MustCompile(`[^A-Za-z0-9_.-]`)
var errPurgePending = errors.New("a pending purge must finish before media can be created")

func (a *App) mediaWritable(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if a.purgePending() {
		return errPurgePending
	}
	return nil
}

func purgeTimestamp(v any) int64 {
	if n, ok := v.(int64); ok {
		return n
	}
	return int64(number(v, 0))
}

func purgeKey(id string, all bool) string {
	if all {
		return "all"
	}
	return "group:" + id
}
func purgeKind(id string, all bool) string {
	if all {
		return "purgeAll"
	}
	return "groupPurge:" + id
}
func (p purgeRecord) prefix() string {
	if p.All {
		return "purge_all"
	}
	return "group_purge"
}
func clonePurge(p purgeRecord) purgeRecord {
	copy := p
	copy.Paths = append([]string(nil), p.Paths...)
	copy.ResetEntries = append([]string(nil), p.ResetEntries...)
	copy.AccessIDs = append([]string(nil), p.AccessIDs...)
	if p.Status != nil {
		copy.Status = cloneConfigValue(p.Status).(map[string]any)
	}
	return copy
}

func registerPurgeRoutes(mux *http.ServeMux, a *App) {
	mux.Handle("DELETE /api/groups/{id}/purge", a.requireAdmin(http.HandlerFunc(a.handleAPIPurgeGroup)))
	mux.Handle("POST /api/groups/{id}/delete-files", a.requireAdmin(http.HandlerFunc(a.handleAPIPurgeGroup)))
	mux.Handle("GET /api/groups/{id}/purge/status", a.requireSession(http.HandlerFunc(a.handlePurgeStatus)))
	mux.Handle("DELETE /api/purge/all", a.requireAdmin(http.HandlerFunc(a.handleAPIPurgeAll)))
	mux.Handle("GET /api/purge/all/status", a.requireAdmin(http.HandlerFunc(a.handlePurgeStatus)))
}

func (a *App) handlePurgeStatus(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	all := r.URL.Path == "/api/purge/all/status"
	a.purgeMu.Lock()
	p, ok := a.purges[purgeKey(id, all)]
	status := dedupIdleStatus(purgeKind(id, all))
	if ok {
		status = cloneConfigValue(p.Status).(map[string]any)
	}
	a.purgeMu.Unlock()
	writeJSON(w, 200, status)
}

func (a *App) handleAPIPurgeGroup(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeJSONError(w, 400, "group id required")
		return
	}
	if a.acceptPurge(w, r, id, false, r.Method == http.MethodPost) {
		writeJSON(w, 200, map[string]any{"success": true, "started": true, "groupId": id})
	}
}

func (a *App) handleAPIPurgeAll(w http.ResponseWriter, r *http.Request) {
	body, ok := readAuthBody(w, r)
	if !ok {
		return
	}
	if body["confirm"] != "DELETE ALL" {
		writeJSON(w, 400, map[string]any{"error": "Factory reset not confirmed: send {\"confirm\": \"DELETE ALL\"} in the request body. If you used the dashboard, reload the page and try again.", "code": "CONFIRM_REQUIRED"})
		return
	}
	if a.acceptPurge(w, r, "", true, false) {
		writeJSON(w, 200, map[string]any{"success": true, "started": true})
	}
}

func (a *App) acceptPurge(w http.ResponseWriter, r *http.Request, id string, all, filesOnly bool) bool {
	a.purgeMu.Lock()
	defer a.purgeMu.Unlock()
	if a.purgeClosed || a.ctx.Err() != nil {
		writeJSONError(w, 503, "server is stopping")
		return false
	}
	key := purgeKey(id, all)
	for otherKey, other := range a.purges {
		if other.Phase != "done" && (other.Status["running"] == true || otherKey != key) && (all || other.All || otherKey == key) {
			writeJSON(w, 409, map[string]any{"error": "A purge is already running", "code": "ALREADY_RUNNING"})
			return false
		}
	}
	p, exists := a.purges[key]
	if !exists || p.Phase == "done" {
		status := dedupIdleStatus(purgeKind(id, all))
		if exists {
			status = cloneConfigValue(p.Status).(map[string]any)
		}
		p = purgeRecord{Key: key, GroupID: id, All: all, FilesOnly: filesOnly, Phase: "queued", Status: status}
	} else {
		p = clonePurge(p)
		if p.FilesOnly != filesOnly {
			writeJSON(w, 409, map[string]any{"error": "Finish the pending purge before changing its scope", "code": "ALREADY_RUNNING"})
			return false
		}
	}
	p.Status["running"], p.Status["stage"], p.Status["error"] = true, "starting", nil
	p.Status["attempts"] = jobCount(p.Status["attempts"]) + 1
	p.Status["startedAt"], p.Status["finishedAt"], p.Status["durationMs"] = time.Now().UnixMilli(), 0, 0
	p.Status["progress"] = map[string]any{}
	if err := savePurge(r.Context(), a.db.Writer, p); err != nil {
		writeJSONError(w, 500, "could not persist purge request")
		return false
	}
	if a.purges == nil {
		a.purges = map[string]purgeRecord{}
	}
	a.purges[key] = clonePurge(p)
	a.purgeWG.Add(1)
	a.hub.Broadcast(ws.Event{Type: p.prefix() + "_progress", Flat: true, Payload: cloneConfigValue(p.Status)})
	go func() {
		defer a.purgeWG.Done()
		_ = a.runPurge(a.ctx, p, false)
	}()
	return true
}

type purgeExecutor interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func savePurge(ctx context.Context, db purgeExecutor, p purgeRecord) error {
	raw, err := json.Marshal(p)
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, `INSERT INTO tgdl_purge_jobs(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`, p.Key, string(raw))
	return err
}

func (a *App) publishPurge(p purgeRecord) {
	a.purgeMu.Lock()
	if a.purges == nil {
		a.purges = map[string]purgeRecord{}
	}
	a.purges[p.Key] = clonePurge(p)
	a.purgeMu.Unlock()
}

func (a *App) purgePending() bool {
	a.purgeMu.Lock()
	defer a.purgeMu.Unlock()
	for _, p := range a.purges {
		if p.Phase != "done" {
			return true
		}
	}
	return false
}

func (a *App) recoverPurges(ctx context.Context) error {
	rows, err := a.db.Reader.QueryContext(ctx, "SELECT payload FROM tgdl_purge_jobs ORDER BY id")
	if err != nil {
		return err
	}
	pending := []purgeRecord{}
	for rows.Next() {
		var raw string
		var p purgeRecord
		if err = rows.Scan(&raw); err == nil {
			err = json.Unmarshal([]byte(raw), &p)
		}
		if err != nil || p.Status == nil || p.Key != purgeKey(p.GroupID, p.All) || (p.Phase != "queued" && p.Phase != "committed" && p.Phase != "done") {
			rows.Close()
			return errors.Join(errors.New("invalid persisted purge"), err)
		}
		a.publishPurge(p)
		if p.Phase != "done" {
			pending = append(pending, p)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, p := range pending {
		if err := a.runPurge(ctx, p, true); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) purgeProgress(ctx context.Context, p *purgeRecord, fields map[string]any) error {
	progress, _ := p.Status["progress"].(map[string]any)
	if progress == nil {
		progress = map[string]any{}
	}
	for key, value := range fields {
		progress[key] = value
	}
	p.Status["progress"] = progress
	if stage, ok := fields["stage"]; ok {
		p.Status["stage"] = stage
	}
	if err := savePurge(ctx, a.db.Writer, *p); err != nil {
		return err
	}
	a.publishPurge(*p)
	payload := cloneConfigValue(p.Status).(map[string]any)
	for key, value := range fields {
		payload[key] = value
	}
	a.hub.Broadcast(ws.Event{Type: p.prefix() + "_progress", Flat: true, Payload: payload})
	return nil
}

func (a *App) runPurge(ctx context.Context, p purgeRecord, recovering bool) (runErr error) {
	if recovering {
		p.Status["running"], p.Status["error"], p.Status["finishedAt"] = true, nil, 0
	}
	a.monitorOp.Lock()
	defer a.monitorOp.Unlock()
	defer func() {
		if runErr == nil {
			return
		}
		p.Status["running"], p.Status["stage"], p.Status["error"] = false, "error", runErr.Error()
		p.Status["failures"] = jobCount(p.Status["failures"]) + 1
		p.Status["finishedAt"] = time.Now().UnixMilli()
		p.Status["durationMs"] = time.Now().UnixMilli() - purgeTimestamp(p.Status["startedAt"])
		saveCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if err := savePurge(saveCtx, a.db.Writer, p); err != nil {
			runErr = errors.Join(runErr, err)
		}
		a.publishPurge(p)
		a.hub.Broadcast(ws.Event{Type: p.prefix() + "_done", Flat: true, Payload: map[string]any{"kind": p.Status["kind"], "durationMs": p.Status["durationMs"], "error": runErr.Error()}})
	}()
	state, err := a.monitor.Status(ctx)
	if err != nil {
		return err
	}
	if state["state"] == "running" || state["state"] == "starting" {
		p.RestartMonitor = true
		a.purgeMu.Lock()
		a.purgeResume = true
		a.purgeMu.Unlock()
		if err := savePurge(ctx, a.db.Writer, p); err != nil {
			return err
		}
		if err := a.monitor.Stop(ctx); err != nil {
			return err
		}
	}
	a.mediaMu.Lock()
	locked := true
	defer func() {
		if locked {
			a.mediaMu.Unlock()
		}
	}()
	if p.Phase == "queued" {
		if !p.All {
			if err := a.purgeProgress(ctx, &p, map[string]any{"stage": "counting", "groupId": p.GroupID}); err != nil {
				return err
			}
		}
		if err := a.commitPurge(ctx, &p); err != nil {
			return err
		}
		a.publishPurge(p)
	}
	files, err := a.cleanPurge(ctx, &p)
	if err != nil {
		return err
	}
	result := map[string]any{}
	if p.All {
		result["deleted"] = map[string]any{"files": files, "dbRecords": p.DeletedRows, "queueRecords": p.DeletedQueue}
	} else if p.FilesOnly {
		result = map[string]any{"groupId": p.GroupID, "groupName": p.GroupName, "filesDeleted": files, "deletedDownloads": p.DeletedRows, "deletedQueue": p.DeletedQueue}
	} else {
		result = map[string]any{"groupId": p.GroupID, "deleted": map[string]any{"files": files, "dbRecords": p.DeletedRows, "queueRecords": p.DeletedQueue, "group": p.GroupName}}
	}
	p.Phase = "done"
	p.Status["running"], p.Status["stage"], p.Status["error"] = false, "done", nil
	p.Status["successes"] = jobCount(p.Status["successes"]) + 1
	p.Status["finishedAt"] = time.Now().UnixMilli()
	p.Status["durationMs"] = time.Now().UnixMilli() - purgeTimestamp(p.Status["startedAt"])
	p.Status["result"] = result
	if err := savePurge(ctx, a.db.Writer, p); err != nil {
		// Keep the committed cleanup plan resumable when final persistence fails.
		p.Phase = "committed"
		return err
	}
	a.publishPurge(p)
	if p.All {
		a.hub.Broadcast(ws.Event{Type: "purge_all", Flat: true})
	} else if p.FilesOnly {
		a.hub.Broadcast(ws.Event{Type: "group_files_deleted", Flat: true, Payload: result})
	} else {
		a.hub.Broadcast(ws.Event{Type: "group_purged", Flat: true, Payload: map[string]any{"groupId": p.GroupID}})
	}
	done := cloneConfigValue(result).(map[string]any)
	done["kind"], done["durationMs"] = p.Status["kind"], p.Status["durationMs"]
	a.hub.Broadcast(ws.Event{Type: p.prefix() + "_done", Flat: true, Payload: done})
	if len(p.AccessIDs) > 0 {
		a.hub.Broadcast(ws.Event{Type: "chat_access_changed", Flat: true, Payload: map[string]any{"ids": p.AccessIDs}})
	}
	a.mediaMu.Unlock()
	locked = false
	a.purgeMu.Lock()
	resume := a.purgeResume
	for _, other := range a.purges {
		if other.Phase != "done" {
			resume = false
		}
	}
	if resume {
		a.purgeResume = false
	}
	a.purgeMu.Unlock()
	if resume && !recovering && ctx.Err() == nil {
		if err := a.startMonitor(ctx); err != nil && a.output != nil {
			fmt.Fprintf(a.output, "Monitor restart after purge failed: %v\n", err)
		}
	}
	return nil
}

func purgeQueueHistory(ctx context.Context, tx *sql.Tx, groupID string, all bool) error {
	if all {
		_, err := tx.ExecContext(ctx, `DELETE FROM kv WHERE key='queue_history'`)
		return err
	}
	var raw string
	err := tx.QueryRowContext(ctx, `SELECT value FROM kv WHERE key='queue_history'`).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var entries []map[string]any
	if err := json.Unmarshal([]byte(raw), &entries); err != nil {
		return fmt.Errorf("read queue history for purge: %w", err)
	}
	kept := make([]map[string]any, 0, len(entries))
	for _, entry := range entries {
		if toString(entry["groupId"]) != groupID {
			kept = append(kept, entry)
		}
	}
	data, err := json.Marshal(kept)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE kv SET value=?,updated_at=? WHERE key='queue_history'`, string(data), time.Now().UnixMilli())
	return err
}

func (a *App) commitPurge(ctx context.Context, p *purgeRecord) error {
	a.configMu.Lock()
	defer a.configMu.Unlock()
	config, err := a.config.Load(ctx)
	if err != nil {
		return err
	}
	p.GroupName = "unknown"
	for _, group := range configuredGroupList(config) {
		if toString(group["id"]) == p.GroupID {
			p.GroupName = firstNonEmpty(toString(group["name"]), "unknown")
		}
	}
	where, args := "1=1", []any{}
	if !p.All {
		where, args = "group_id=?", []any{p.GroupID}
	}
	tx, err := a.db.Writer.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	p.DeletedRows, p.DeletedQueue, p.AccessIDs = 0, 0, nil
	if _, err := tx.ExecContext(ctx, "UPDATE tgdl_purge_jobs SET payload=payload WHERE 0"); err != nil {
		return err
	}
	if p.GroupName == "unknown" && !p.All {
		var name sql.NullString
		err = tx.QueryRowContext(ctx, `SELECT group_name FROM downloads WHERE group_id=? AND group_name IS NOT NULL LIMIT 1`, p.GroupID).Scan(&name)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if name.Valid && name.String != "" {
			p.GroupName = name.String
		}
	}
	rows, err := tx.QueryContext(ctx, `SELECT DISTINCT file_path FROM downloads WHERE file_path IS NOT NULL AND file_path<>'' AND (`+where+`)`, args...)
	if err != nil {
		return err
	}
	p.Paths = nil
	physical := map[string]bool{}
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			rows.Close()
			return err
		}
		if f, err := openMedia(filepath.Join(a.dataDir, "downloads"), path); err == nil {
			f.Close()
			key := filepath.Join(a.dataDir, "downloads", filepath.FromSlash(strings.ReplaceAll(path, "\\", "/")))
			if real, err := filepath.EvalSymlinks(key); err == nil {
				key = real
			}
			if !physical[key] {
				physical[key] = true
				p.Paths = append(p.Paths, path)
			}
		} else if !os.IsNotExist(err) {
			rows.Close()
			return err
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if p.All {
		if err := a.planReset(p); err != nil {
			return err
		}
	}
	if err := a.queueDeletedAssets(ctx, tx, where, args...); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO tgdl_file_cleanup(path) SELECT file_path FROM downloads WHERE file_path IS NOT NULL AND file_path<>'' AND (`+where+`)`, args...); err != nil {
		return err
	}
	res, err := tx.ExecContext(ctx, `DELETE FROM downloads WHERE `+where, args...)
	if err != nil {
		return err
	}
	p.DeletedRows, err = res.RowsAffected()
	if err != nil {
		return err
	}
	for _, table := range []string{"queue", "tgdl_work", "tgdl_message_generations"} {
		res, err := tx.ExecContext(ctx, `DELETE FROM `+table+` WHERE `+where, args...)
		if err != nil {
			return err
		}
		if table != "tgdl_message_generations" {
			n, err := res.RowsAffected()
			if err != nil {
				return err
			}
			p.DeletedQueue += n
		}
	}
	if err := purgeQueueHistory(ctx, tx, p.GroupID, p.All); err != nil {
		return err
	}
	journalWhere := "1=1"
	if !p.All {
		journalWhere = `json_extract(item,'$.GroupID')=?`
	}
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO tgdl_file_cleanup(path) SELECT path FROM tgdl_ingest_files WHERE `+journalWhere, args...); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM tgdl_ingest_files WHERE `+journalWhere, args...); err != nil {
		return err
	}
	if !p.FilesOnly {
		kept := []any{}
		for _, group := range configuredGroupList(config) {
			if !p.All && toString(group["id"]) != p.GroupID {
				kept = append(kept, group)
			}
		}
		config["groups"] = kept
		raw, err := json.Marshal(config)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO kv(key,value,updated_at) VALUES('config',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, string(raw), time.Now().UnixMilli()); err != nil {
			return err
		}
		accessWhere := "1=1"
		if !p.All {
			accessWhere = "chat_id=?"
		}
		rows, err := tx.QueryContext(ctx, `SELECT chat_id FROM chat_access WHERE `+accessWhere+` ORDER BY chat_id`, args...)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			p.AccessIDs = append(p.AccessIDs, id)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM chat_access WHERE `+accessWhere, args...); err != nil {
			return err
		}
	}
	p.Phase = "committed"
	if err := savePurge(ctx, tx, *p); err != nil {
		p.Phase = "queued"
		return err
	}
	if err := tx.Commit(); err != nil {
		p.Phase = "queued"
		return err
	}
	return nil
}

func (a *App) planReset(p *purgeRecord) error {
	root, err := os.OpenRoot(a.dataDir)
	if err != nil {
		return err
	}
	defer root.Close()
	p.ResetEntries, p.ResetFiles = nil, 0
	for _, area := range []string{"downloads", "thumbs", "seekbar", "photos"} {
		entries, err := fs.ReadDir(root.FS(), area)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		for _, entry := range entries {
			// io/fs and persisted cleanup plans use forward slashes on every OS.
			name := area + "/" + entry.Name()
			p.ResetEntries = append(p.ResetEntries, name)
			if area == "downloads" {
				if !entry.IsDir() {
					// WalkDir stats its starting path, which would follow a
					// top-level symlink. Count the entry without following it.
					p.ResetFiles++
					continue
				}
				if err := fs.WalkDir(root.FS(), name, func(_ string, d fs.DirEntry, err error) error {
					if err == nil && !d.IsDir() {
						p.ResetFiles++
					}
					return err
				}); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func (a *App) cleanPurge(ctx context.Context, p *purgeRecord) (int, error) {
	progress := func(fields map[string]any) error { return a.purgeProgress(ctx, p, fields) }
	if p.All {
		groups := 0
		for _, name := range p.ResetEntries {
			if strings.HasPrefix(name, "downloads/") {
				groups++
			}
		}
		if err := progress(map[string]any{"stage": "deleting_files", "processed": 0, "total": groups}); err != nil {
			return 0, err
		}
		root, err := os.OpenRoot(a.dataDir)
		if err != nil {
			return 0, err
		}
		defer root.Close()
		processed := 0
		for _, name := range p.ResetEntries {
			if err := ctx.Err(); err != nil {
				return 0, err
			}
			clean := filepath.Clean(filepath.FromSlash(name))
			parts := strings.Split(clean, string(filepath.Separator))
			if !filepath.IsLocal(clean) || len(parts) != 2 || !contains([]string{"downloads", "thumbs", "seekbar", "photos"}, parts[0]) {
				return 0, errors.New("invalid reset cleanup path")
			}
			if err := root.RemoveAll(clean); err != nil {
				return 0, err
			}
			if parts[0] == "downloads" {
				processed++
				if err := progress(map[string]any{"stage": "deleting_files", "processed": processed, "total": groups}); err != nil {
					return 0, err
				}
			}
		}
		if err := progress(map[string]any{"stage": "deleting_rows"}); err != nil {
			return 0, err
		}
		if err := a.drainFileCleanup(ctx); err != nil {
			return 0, err
		}
		if err := progress(map[string]any{"stage": "purging_cache"}); err != nil {
			return 0, err
		}
		return p.ResetFiles, a.library.CleanDerived(ctx)
	}
	if len(p.Paths) > 0 {
		if err := progress(map[string]any{"stage": "deleting_files", "groupId": p.GroupID, "total": len(p.Paths), "processed": 0}); err != nil {
			return 0, err
		}
	}
	if err := a.drainFileCleanup(ctx); err != nil {
		return 0, err
	}
	files := 0
	for _, path := range p.Paths {
		if f, err := openMedia(filepath.Join(a.dataDir, "downloads"), path); os.IsNotExist(err) {
			files++
		} else if err == nil {
			f.Close()
		} else {
			return 0, err
		}
	}
	if len(p.Paths) > 0 {
		if err := progress(map[string]any{"stage": "deleting_files", "groupId": p.GroupID, "total": files, "processed": files}); err != nil {
			return 0, err
		}
	}
	if err := progress(map[string]any{"stage": "deleting_rows", "groupId": p.GroupID}); err != nil {
		return 0, err
	}
	if err := a.library.CleanDerived(ctx); err != nil {
		return 0, err
	}
	if !p.FilesOnly {
		root, err := os.OpenRoot(a.dataDir)
		if err != nil {
			return 0, err
		}
		defer root.Close()
		err = root.Remove(filepath.Join("photos", purgePhotoUnsafe.ReplaceAllString(p.GroupID, "_")+".jpg"))
		if err != nil && !os.IsNotExist(err) {
			return 0, err
		}
	} else if err := progress(map[string]any{"stage": "done", "groupId": p.GroupID}); err != nil {
		return 0, err
	}
	return files, nil
}
