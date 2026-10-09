package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

func registerRecoveryRoutes(mux *http.ServeMux, a *App) {
	mux.Handle("GET /api/maintenance/recovery/list", a.requireAdmin(http.HandlerFunc(a.handleRecoveryList)))
	mux.Handle("GET /api/maintenance/recovery/status", a.requireAdmin(http.HandlerFunc(a.handleRecoveryStatus)))
	for _, op := range []string{"resolve", "disable", "ignore", "unignore", "reassign", "delete"} {
		mux.Handle("POST /api/maintenance/recovery/"+op, a.requireAdmin(http.HandlerFunc(a.handleRecoveryOperation)))
	}
}

func (a *App) handleRecoveryList(w http.ResponseWriter, r *http.Request) {
	a.mediaMu.RLock()
	defer a.mediaMu.RUnlock()
	cfg, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	type stats struct {
		count int
		last  sql.NullString
	}
	counts := map[string]stats{}
	rows, err := a.db.Reader.QueryContext(r.Context(), `SELECT group_id,COUNT(*),MAX(created_at) FROM downloads GROUP BY group_id`)
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	for rows.Next() {
		var id string
		var s stats
		if err = rows.Scan(&id, &s.count, &s.last); err != nil {
			break
		}
		counts[id] = s
	}
	err = errors.Join(err, rows.Err())
	rows.Close()
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	access, err := a.readDialogAccess(r.Context())
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	items := []map[string]any{}
	for _, g := range configuredGroupList(cfg) {
		id := toString(g["id"])
		synthetic := strings.HasPrefix(id, "unknown:")
		var blocked any
		state := access[id]
		if !synthetic && blockingChatState(toString(state["state"])) {
			blocked = state
		}
		if !synthetic && !jsTruthy(g["_resolveFailedAt"]) && blocked == nil {
			continue
		}
		if g["_recoveryIgnored"] == true && r.URL.Query().Get("showIgnored") != "1" {
			continue
		}
		var reason, failedAt, pin any
		if jsTruthy(g["_resolveFailedReason"]) {
			reason = g["_resolveFailedReason"]
		} else if synthetic {
			reason = "index_miss"
		}
		if jsTruthy(g["_resolveFailedAt"]) {
			failedAt = g["_resolveFailedAt"]
		}
		if blocked != nil {
			reason = "access:" + toString(state["state"]) + ":" + toString(state["code"])
			if jsTruthy(state["firstSeenAt"]) {
				failedAt = state["firstSeenAt"]
			}
		}
		if jsTruthy(g["monitorAccount"]) {
			pin = g["monitorAccount"]
		}
		s := counts[id]
		items = append(items, map[string]any{"id": id, "name": firstNonEmpty(toString(g["name"]), id), "enabled": g["enabled"] == true, "isSynthetic": synthetic, "resolveFailedAt": failedAt, "resolveFailedReason": reason, "access": blocked, "monitorAccount": pin, "fileCount": s.count, "lastSeenAt": dialogNullableString(s.last), "recoveryIgnored": g["_recoveryIgnored"] == true})
	}
	body := map[string]any{"success": true, "total": len(items)}
	if r.URL.Query().Get("countOnly") != "1" {
		body["items"] = items
	}
	writeJSON(w, 200, body)
}

func (a *App) handleRecoveryStatus(w http.ResponseWriter, _ *http.Request) {
	a.recoveryMu.Lock()
	status := a.recoveryStatus
	if status == nil {
		status = dedupIdleStatus("recoveryBulk")
	}
	status = cloneConfigValue(status).(map[string]any)
	a.recoveryMu.Unlock()
	writeJSON(w, 200, status)
}

func (a *App) handleRecoveryOperation(w http.ResponseWriter, r *http.Request) {
	body, ok := readAuthBody(w, r)
	if !ok {
		return
	}
	rawIDs, _ := body["ids"].([]any)
	if len(rawIDs) == 0 {
		writeJSONError(w, 400, "ids[] required")
		return
	}
	if len(rawIDs) > 10000 {
		writeJSONError(w, 400, "at most 10000 ids per operation")
		return
	}
	ids := []string{}
	seen := map[string]bool{}
	for _, raw := range rawIDs {
		id := jsString(raw)
		if !seen[id] {
			ids = append(ids, id)
			seen[id] = true
		}
	}
	op := strings.TrimPrefix(r.URL.Path, "/api/maintenance/recovery/")
	if op == "reassign" && !jsTruthy(body["monitorAccount"]) {
		writeJSONError(w, 400, "monitorAccount required")
		return
	}
	if op == "resolve" {
		a.beginRecoveryResolve(w, ids)
		return
	}
	done, ok := a.beginMaintenance()
	if !ok {
		writeJSONError(w, 503, "server is stopping")
		return
	}
	defer done()
	ctx, cancel := context.WithCancel(r.Context())
	stop := context.AfterFunc(a.ctx, cancel)
	defer stop()
	defer cancel()
	a.monitorOp.Lock()
	defer a.monitorOp.Unlock()
	var retryIDs []string
	if op == "delete" && jsTruthy(body["purgeDownloads"]) {
		retryIDs = ids
	}
	if err := a.beginRecoveryWrite(retryIDs...); err != nil {
		writeJSONError(w, 409, err.Error())
		return
	}
	defer a.endRecoveryWrite()
	needsStop := op == "disable" || op == "reassign" || op == "delete"
	resume := false
	if needsStop {
		var err error
		resume, err = a.stopForRecovery(ctx)
		if err != nil {
			writeJSONError(w, 500, err.Error())
			return
		}
	}
	var result map[string]any
	var err error
	if op == "delete" && jsTruthy(body["purgeDownloads"]) {
		result, err = a.recoveryDeleteFiles(ctx, ids, resume)
	} else {
		a.mediaMu.Lock()
		result, err = a.recoveryEdit(ctx, op, ids, body["monitorAccount"])
		a.mediaMu.Unlock()
	}
	a.endRecoveryWrite()
	if resume && !a.purgePending() && a.ctx.Err() == nil {
		err = errors.Join(err, a.resumeAfterRecovery())
	}
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, result)
}

func (a *App) beginRecoveryWrite(retryIDs ...string) error {
	a.purgeMu.Lock()
	defer a.purgeMu.Unlock()
	if a.purgeClosed || a.ctx.Err() != nil {
		return errors.New("server is stopping")
	}
	if a.recoveryWriting {
		return errors.New("a recovery edit is already running")
	}
	for _, p := range a.purges {
		if p.Phase != "done" {
			if !p.All && !p.FilesOnly && p.Status["running"] != true && contains(retryIDs, p.GroupID) {
				continue
			}
			return errPurgePending
		}
	}
	a.recoveryWriting = true
	return nil
}
func (a *App) endRecoveryWrite() { a.purgeMu.Lock(); a.recoveryWriting = false; a.purgeMu.Unlock() }

func (a *App) stopForRecovery(ctx context.Context) (bool, error) {
	state, err := a.monitor.Status(ctx)
	if err != nil {
		return false, err
	}
	resume := state["state"] == "running" || state["state"] == "starting"
	if !resume {
		cfg, err := a.config.Load(ctx)
		if err != nil {
			return false, err
		}
		monitor, _ := cfg["monitor"].(map[string]any)
		if monitor["autoStart"] == true {
			a.purgeMu.Lock()
			for _, p := range a.purges {
				if p.Phase != "done" && p.RestartMonitor {
					resume = true
					break
				}
			}
			a.purgeMu.Unlock()
		}
	}
	if err := a.monitor.Stop(ctx); err != nil {
		return false, err
	}
	return resume, nil
}

func (a *App) resumeAfterRecovery() error {
	// No deadline: starting can repair missed history for a long time.
	return a.startMonitor(a.ctx)
}

func saveRecoveryConfig(ctx context.Context, tx *sql.Tx, cfg map[string]any) error {
	raw, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO kv(key,value,updated_at) VALUES('config',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, string(raw), time.Now().UnixMilli())
	return err
}

func (a *App) recoveryEdit(ctx context.Context, op string, ids []string, pin any) (map[string]any, error) {
	a.configMu.Lock()
	defer a.configMu.Unlock()
	cfg, err := a.config.Load(ctx)
	if err != nil {
		return nil, err
	}
	tx, err := a.db.Writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	n := 0
	matched := map[string]bool{}
	kept := []any{}
	accessIDs := []string{}
	for _, g := range configuredGroupList(cfg) {
		id := toString(g["id"])
		if !contains(ids, id) {
			kept = append(kept, g)
			continue
		}
		n++
		matched[id] = true
		switch op {
		case "disable":
			g["enabled"] = false
		case "ignore":
			g["_recoveryIgnored"] = true
		case "unignore":
			delete(g, "_recoveryIgnored")
		case "reassign":
			g["monitorAccount"] = jsString(pin)
			delete(g, "_resolveFailedAt")
			delete(g, "_resolveFailedReason")
			if err := reassignRecoveryWork(ctx, tx, id, jsString(pin)); err != nil {
				return nil, err
			}
		}
		if op != "delete" {
			kept = append(kept, g)
		}
	}
	for _, id := range ids {
		if op == "disable" && !matched[id] {
			continue
		}
		if op == "disable" || op == "delete" {
			if _, err := tx.ExecContext(ctx, `UPDATE tgdl_work SET status='skipped',body=X'',claim_generation=NULL,error='group disabled or removed',updated_at=? WHERE group_id=? AND status IN ('pending','processing','failed')`, time.Now().UnixMilli(), id); err != nil {
				return nil, err
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM queue WHERE group_id=?`, id); err != nil {
				return nil, err
			}
		}
		if op == "delete" {
			res, err := tx.ExecContext(ctx, `DELETE FROM chat_access WHERE chat_id=?`, id)
			if err != nil {
				return nil, err
			}
			count, err := res.RowsAffected()
			if err != nil {
				return nil, err
			}
			if count > 0 {
				accessIDs = append(accessIDs, id)
			}
		}
	}
	cfg["groups"] = kept
	if n > 0 {
		if err := saveRecoveryConfig(ctx, tx, cfg); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	if len(accessIDs) > 0 {
		a.hub.Broadcast(ws.Event{Type: "chat_access_changed", Flat: true, Payload: map[string]any{"ids": accessIDs}})
	}
	field := map[string]string{"disable": "disabled", "ignore": "ignored", "unignore": "unignored", "reassign": "reassigned", "delete": "removed"}[op]
	result := map[string]any{"success": true, field: n}
	if op == "reassign" {
		result["monitorAccount"] = pin
	}
	if op == "delete" {
		result["purgeDownloads"], result["totalRows"], result["totalFiles"] = false, 0, 0
	}
	return result, nil
}

func reassignRecoveryWork(ctx context.Context, tx *sql.Tx, id, pin string) error {
	// Old file references are account-bound. The next claim MUST refresh using
	// the selected account before the sink can touch Telegram media bytes.
	return engine.ReassignGroup(ctx, tx, id, pin)
}

func (a *App) recoveryDeleteFiles(ctx context.Context, ids []string, resume bool) (map[string]any, error) {
	cfg, err := a.config.Load(ctx)
	if err != nil {
		return nil, err
	}
	removed := 0
	for _, g := range configuredGroupList(cfg) {
		if contains(ids, toString(g["id"])) {
			removed++
		}
	}
	var totalRows int64
	totalFiles := 0
	for _, id := range ids {
		status := dedupIdleStatus(purgeKind(id, false))
		status["running"], status["stage"], status["attempts"], status["startedAt"] = true, "starting", 1, time.Now().UnixMilli()
		p := purgeRecord{Key: purgeKey(id, false), GroupID: id, Phase: "queued", Status: status, RestartMonitor: resume}
		a.purgeMu.Lock()
		if old, found := a.purges[p.Key]; found && old.Phase != "done" {
			p = clonePurge(old)
			p.Status["running"], p.Status["stage"], p.Status["error"], p.Status["startedAt"], p.Status["finishedAt"] = true, "starting", nil, time.Now().UnixMilli(), 0
			p.Status["attempts"] = jobCount(p.Status["attempts"]) + 1
		}
		err := savePurge(ctx, a.db.Writer, p)
		if err == nil {
			if a.purges == nil {
				a.purges = map[string]purgeRecord{}
			}
			a.purges[p.Key] = clonePurge(p)
		}
		a.purgeMu.Unlock()
		if err != nil {
			return nil, err
		}
		// The caller owns monitorOp and has already joined the active monitor.
		// Suppress per-group restarts; the entire request resumes it once.
		if err := a.runPurgeLocked(ctx, p, true); err != nil {
			return nil, err
		}
		a.purgeMu.Lock()
		completed := clonePurge(a.purges[p.Key])
		a.purgeMu.Unlock()
		totalRows += completed.DeletedRows
		result, _ := completed.Status["result"].(map[string]any)
		deleted, _ := result["deleted"].(map[string]any)
		totalFiles += jobCount(deleted["files"])
	}
	return map[string]any{"success": true, "removed": removed, "purgeDownloads": true, "totalRows": totalRows, "totalFiles": totalFiles}, nil
}

func (a *App) publishRecovery(status map[string]any) {
	a.recoveryMu.Lock()
	a.recoveryStatus = cloneConfigValue(status).(map[string]any)
	a.recoveryMu.Unlock()
}
func (a *App) recoveryProgress(status map[string]any, processed, total int) {
	status["stage"] = "working"
	status["progress"] = map[string]any{"op": "resolve", "processed": processed, "total": total}
	a.publishRecovery(status)
	a.hub.Broadcast(ws.Event{Type: "recovery_bulk_progress", Flat: true, Payload: map[string]any{"kind": "recoveryBulk", "op": "resolve", "processed": processed, "total": total}})
}

func (a *App) beginRecoveryResolve(w http.ResponseWriter, ids []string) {
	a.recoveryMu.Lock()
	defer a.recoveryMu.Unlock()
	if a.recoveryStatus != nil && a.recoveryStatus["running"] == true {
		writeJSON(w, 409, map[string]any{"error": "A recovery bulk operation is already running", "code": "ALREADY_RUNNING"})
		return
	}
	status := dedupIdleStatus("recoveryBulk")
	if a.recoveryStatus != nil {
		status = cloneConfigValue(a.recoveryStatus).(map[string]any)
	}
	status["running"], status["stage"], status["error"], status["result"], status["progress"] = true, "starting", nil, nil, map[string]any{}
	status["attempts"] = jobCount(status["attempts"]) + 1
	status["startedAt"] = time.Now().UnixMilli()
	status["finishedAt"], status["durationMs"] = 0, 0
	a.recoveryStatus = cloneConfigValue(status).(map[string]any)
	if !a.launchMaintenance(func() { a.runRecoveryResolve(status, ids) }) {
		status["running"] = false
		a.recoveryStatus = status
		writeJSONError(w, 503, "server is stopping")
		return
	}
	a.hub.Broadcast(ws.Event{Type: "recovery_bulk_progress", Flat: true, Payload: map[string]any{"kind": "recoveryBulk"}})
	writeJSON(w, 200, map[string]any{"success": true, "started": true})
}

func (a *App) runRecoveryResolve(status map[string]any, ids []string) {
	result, err := a.resolveRecovery(a.ctx, status, ids)
	status["running"], status["stage"], status["finishedAt"], status["result"] = false, "done", time.Now().UnixMilli(), result
	status["durationMs"] = time.Now().UnixMilli() - purgeTimestamp(status["startedAt"])
	payload := map[string]any{"kind": "recoveryBulk", "durationMs": status["durationMs"]}
	if err != nil {
		status["stage"], status["error"] = "error", err.Error()
		status["failures"] = jobCount(status["failures"]) + 1
		payload["error"] = err.Error()
	} else {
		status["successes"] = jobCount(status["successes"]) + 1
		for k, v := range result {
			payload[k] = v
		}
	}
	a.publishRecovery(status)
	a.hub.Broadcast(ws.Event{Type: "recovery_bulk_done", Flat: true, Payload: payload})
}
