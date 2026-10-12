package app

import (
	"context"
	"database/sql"
	"net/http"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

// The four v2 review actions share one tracker (2.x nsfwBulk) so they are
// mutually exclusive. Each POST returns {started:true}; the result arrives
// as nsfw_bulk_done with an `op` field.

const (
	nsfwUpdateChunk = 500
	nsfwDeleteChunk = 50
)

type nsfwBulkFilter struct {
	ids                []int64
	tier               string
	fileTypes          []string
	groupID            string
	includeWhitelisted bool
	scoreMin, scoreMax *float64
}

func parseNSFWBulkFilter(body map[string]any, cfg nsfwConfig) nsfwBulkFilter {
	f := nsfwBulkFilter{tier: toString(body["tier"]), groupID: toString(body["groupId"]), includeWhitelisted: body["includeWhitelisted"] == true}
	f.ids = cleanNSFWIDs(body["ids"])
	if list, ok := body["fileTypes"].([]any); ok {
		for _, v := range list {
			if s, ok := v.(string); ok && s != "" {
				f.fileTypes = append(f.fileTypes, s)
			}
		}
	}
	if len(f.fileTypes) == 0 {
		f.fileTypes = cfg.FileTypes
	}
	if v, ok := body["scoreMin"].(float64); ok {
		f.scoreMin = &v
	}
	if v, ok := body["scoreMax"].(float64); ok {
		f.scoreMax = &v
	}
	return f
}

func cleanNSFWIDs(value any) []int64 {
	list, _ := value.([]any)
	out := make([]int64, 0, len(list))
	seen := map[int64]bool{}
	for _, v := range list {
		n, ok := v.(float64)
		if !ok || n < 1 || n != float64(int64(n)) || seen[int64(n)] {
			continue
		}
		seen[int64(n)] = true
		out = append(out, int64(n))
	}
	return out
}

// resolve turns a tier/range filter into an id list (2.x getNsfwIdsByTier).
func (a *App) resolveNSFWBulk(ctx context.Context, f nsfwBulkFilter) ([]int64, error) {
	if len(f.ids) > 0 {
		return f.ids, nil
	}
	where := []string{"file_type IN (" + strings.TrimSuffix(strings.Repeat("?,", len(f.fileTypes)), ",") + ")", "nsfw_score IS NOT NULL"}
	args := make([]any, 0, len(f.fileTypes)+5)
	for _, t := range f.fileTypes {
		args = append(args, t)
	}
	for _, tier := range nsfwTierMeta {
		if tier["id"] == f.tier {
			where = append(where, "nsfw_score >= ?", "nsfw_score < ?")
			args = append(args, tier["min"], tier["max"])
		}
	}
	if f.scoreMin != nil {
		where, args = append(where, "nsfw_score >= ?"), append(args, *f.scoreMin)
	}
	if f.scoreMax != nil {
		where, args = append(where, "nsfw_score < ?"), append(args, *f.scoreMax)
	}
	if !f.includeWhitelisted {
		where = append(where, "nsfw_whitelist = 0")
	}
	if f.groupID != "" {
		where, args = append(where, "CAST(group_id AS TEXT) = ?"), append(args, f.groupID)
	}
	rows, err := a.db.Reader.QueryContext(ctx, `SELECT id FROM downloads WHERE `+strings.Join(where, " AND ")+` ORDER BY nsfw_score ASC, id ASC`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (a *App) handleNSFWBulk(op string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, ok := readAuthBody(w, r)
		if !ok {
			return
		}
		if op == "delete" && body["confirm"] != true {
			writeJSONError(w, http.StatusBadRequest, `Pass {"confirm": true} in the request body to proceed.`)
			return
		}
		cfg := a.nsfwSettings(r.Context())
		filter := parseNSFWBulkFilter(body, cfg)
		if op == "unwhitelist" && len(filter.ids) == 0 {
			// The whole point is to act on whitelisted rows.
			filter.includeWhitelisted = true
		}
		switch a.startNSFWBulk(op, func(ctx context.Context, progress func(map[string]any)) (map[string]any, error) {
			return a.runNSFWBulk(ctx, op, cfg, filter, progress)
		}) {
		case errNSFWScanRunning:
			writeJSON(w, http.StatusConflict, map[string]any{"error": "A bulk NSFW operation is already running", "code": "ALREADY_RUNNING"})
		case errNSFWStopping:
			writeJSONError(w, http.StatusServiceUnavailable, "server is stopping")
		default:
			writeJSON(w, http.StatusOK, map[string]any{"success": true, "started": true})
		}
	}
}

func (a *App) handleNSFWBulkStatus(w http.ResponseWriter, _ *http.Request) {
	a.nsfw.mu.Lock()
	status := cloneConfigValue(a.nsfw.bulk).(map[string]any)
	a.nsfw.mu.Unlock()
	writeJSON(w, http.StatusOK, status)
}

// startNSFWBulk follows the 2.x job-tracker contract: *_progress events
// carry the status plus flat progress fields, *_done carries the result.
func (a *App) startNSFWBulk(op string, run func(context.Context, func(map[string]any)) (map[string]any, error)) error {
	a.nsfw.mu.Lock()
	status := a.nsfw.bulk
	if status["running"] == true {
		a.nsfw.mu.Unlock()
		return errNSFWScanRunning
	}
	started := time.Now()
	status["attempts"] = jobCount(status["attempts"]) + 1
	status["running"], status["stage"], status["progress"] = true, "starting", map[string]any{}
	status["startedAt"], status["finishedAt"], status["durationMs"], status["error"] = started.UnixMilli(), 0, 0, nil
	a.nsfw.mu.Unlock()
	progress := func(p map[string]any) {
		a.nsfw.mu.Lock()
		s := a.nsfw.bulk
		merged, _ := s["progress"].(map[string]any)
		for k, v := range p {
			merged[k] = v
		}
		if stage, ok := p["stage"]; ok {
			s["stage"] = stage
		}
		payload := cloneConfigValue(s).(map[string]any)
		a.nsfw.mu.Unlock()
		for k, v := range p {
			payload[k] = v
		}
		a.hub.Broadcast(ws.Event{Type: "nsfw_bulk_progress", Flat: true, Payload: payload})
	}
	progress(map[string]any{"stage": "starting", "op": op})
	launched := a.launchMaintenance(func() {
		result, err := run(a.ctx, progress)
		finished := time.Now()
		done := map[string]any{"kind": "nsfwBulk", "durationMs": finished.Sub(started).Milliseconds()}
		a.nsfw.mu.Lock()
		s := a.nsfw.bulk
		s["running"], s["finishedAt"], s["durationMs"] = false, finished.UnixMilli(), done["durationMs"]
		if err != nil {
			s["stage"], s["error"], s["failures"] = "error", err.Error(), jobCount(s["failures"])+1
			done["error"] = err.Error()
		} else {
			s["stage"], s["result"], s["successes"] = "done", result, jobCount(s["successes"])+1
			for k, v := range result {
				done[k] = v
			}
		}
		a.nsfw.mu.Unlock()
		a.hub.Broadcast(ws.Event{Type: "nsfw_bulk_done", Flat: true, Payload: done})
	})
	if !launched {
		a.nsfw.mu.Lock()
		status["running"], status["stage"] = false, "idle"
		a.nsfw.mu.Unlock()
		return errNSFWStopping
	}
	return nil
}

func (a *App) runNSFWBulk(ctx context.Context, op string, cfg nsfwConfig, f nsfwBulkFilter, progress func(map[string]any)) (map[string]any, error) {
	progress(map[string]any{"stage": "resolving", "op": op})
	ids, err := a.resolveNSFWBulk(ctx, f)
	if err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		key := map[string]string{"delete": "deleted", "reclassify": "cleared"}[op]
		if key == "" {
			key = "updated"
		}
		return map[string]any{"op": op, key: 0, "ids": []int64{}}, nil
	}
	defer a.broadcastNSFWStats(context.WithoutCancel(ctx))
	if op == "delete" {
		return a.nsfwBulkDelete(ctx, cfg, ids, progress)
	}
	stage, sqlText, key := "updating", `UPDATE downloads SET nsfw_whitelist = 1 WHERE id IN (%s)`, "updated"
	switch op {
	case "unwhitelist":
		sqlText = `UPDATE downloads SET nsfw_whitelist = 0 WHERE id IN (%s)`
	case "reclassify":
		stage, sqlText, key = "clearing", `UPDATE downloads SET nsfw_checked_at = NULL, nsfw_score = NULL WHERE id IN (%s)`, "cleared"
	}
	var changed int64
	progress(map[string]any{"stage": stage, "op": op, "processed": 0, "total": len(ids)})
	for off := 0; off < len(ids); off += nsfwUpdateChunk {
		chunk := ids[off:min(off+nsfwUpdateChunk, len(ids))]
		n, err := execIDs(ctx, a.db.Writer, sqlText, chunk)
		if err != nil {
			return nil, err
		}
		changed += n
		progress(map[string]any{"stage": stage, "op": op, "processed": off + len(chunk), "total": len(ids)})
	}
	return map[string]any{"op": op, key: changed, "requested": len(ids)}, nil
}

// nsfwBulkDelete removes files and rows through the shared reference-aware
// cleanup, adding each file's hash to the blocklist first when enabled.
func (a *App) nsfwBulkDelete(ctx context.Context, cfg nsfwConfig, ids []int64, progress func(map[string]any)) (map[string]any, error) {
	if cfg.BlocklistEnabled {
		if err := a.nsfwBlocklistAdd(ctx, ids, "bulk"); err != nil {
			return nil, err
		}
	}
	var removed int64
	progress(map[string]any{"stage": "deleting", "op": "delete", "processed": 0, "total": len(ids)})
	for off := 0; off < len(ids); off += nsfwDeleteChunk {
		chunk := ids[off:min(off+nsfwDeleteChunk, len(ids))]
		n, err := a.deleteRows(contextRequest(ctx), chunk, nil)
		if err != nil {
			return nil, err
		}
		removed += n
		progress(map[string]any{"stage": "deleting", "op": "delete", "processed": off + len(chunk), "total": len(ids)})
	}
	a.hub.Broadcast(ws.Event{Type: "bulk_delete", Flat: true, Payload: map[string]any{"count": len(ids)}})
	return map[string]any{"op": "delete", "deleted": removed, "removed": removed, "requested": len(ids)}, nil
}

func (a *App) nsfwBlocklistAdd(ctx context.Context, ids []int64, source string) error {
	tx, err := a.db.Writer.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := time.Now().UnixMilli()
	for off := 0; off < len(ids); off += nsfwUpdateChunk {
		chunk := ids[off:min(off+nsfwUpdateChunk, len(ids))]
		args := []any{now, source}
		for _, id := range chunk {
			args = append(args, id)
		}
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO nsfw_hash_blocklist(file_hash, file_name, deleted_at, source)
			SELECT file_hash, file_name, ?, ? FROM downloads WHERE file_hash IS NOT NULL AND file_hash <> '' AND id IN (`+placeholders(len(chunk))+`)`, args...); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func execIDs(ctx context.Context, db *sql.DB, query string, ids []int64) (int64, error) {
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	res, err := db.ExecContext(ctx, strings.Replace(query, "%s", placeholders(len(ids)), 1), args...)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// Legacy 2.x endpoints (review sheet before the tier page): synchronous.

func (a *App) handleNSFWWhitelist(w http.ResponseWriter, r *http.Request) {
	body, ok := readAuthBody(w, r)
	if !ok {
		return
	}
	ids, problem := nsfwRequestIDs(body)
	if problem != "" {
		writeJSONError(w, http.StatusBadRequest, problem)
		return
	}
	var updated int64
	for off := 0; off < len(ids); off += nsfwUpdateChunk {
		n, err := execIDs(r.Context(), a.db.Writer, `UPDATE downloads SET nsfw_whitelist = 1 WHERE id IN (%s)`, ids[off:min(off+nsfwUpdateChunk, len(ids))])
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "nsfw whitelist failed")
			return
		}
		updated += n
	}
	a.broadcastNSFWStats(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "updated": updated})
}

func (a *App) handleNSFWDelete(w http.ResponseWriter, r *http.Request) {
	body, ok := readAuthBody(w, r)
	if !ok {
		return
	}
	ids, problem := nsfwRequestIDs(body)
	if problem != "" {
		writeJSONError(w, http.StatusBadRequest, problem)
		return
	}
	cfg := a.nsfwSettings(r.Context())
	if cfg.BlocklistEnabled {
		if err := a.nsfwBlocklistAdd(r.Context(), ids, "manual"); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "nsfw blocklist update failed")
			return
		}
	}
	var removed int64
	for off := 0; off < len(ids); off += nsfwDeleteChunk {
		n, err := a.deleteRows(r, ids[off:min(off+nsfwDeleteChunk, len(ids))], nil)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "nsfw delete failed")
			return
		}
		removed += n
	}
	a.hub.Broadcast(ws.Event{Type: "bulk_delete", Flat: true, Payload: map[string]any{"count": len(ids)}})
	a.broadcastNSFWStats(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "removed": removed})
}

func nsfwRequestIDs(body map[string]any) ([]int64, string) {
	if list, _ := body["ids"].([]any); len(list) == 0 {
		return nil, "ids array required"
	}
	ids := cleanNSFWIDs(body["ids"])
	if len(ids) == 0 {
		return nil, "No valid ids supplied"
	}
	return ids, ""
}
