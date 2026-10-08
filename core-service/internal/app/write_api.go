package app

import (
	"net/http"
	"path/filepath"
	"strings"

	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

func registerConfigWriteRoutes(mux *http.ServeMux, a *App) {
	mux.Handle("GET /api/config", a.requireSession(http.HandlerFunc(a.handleAPIConfigGet)))
	mux.Handle("POST /api/config", a.requireAdmin(http.HandlerFunc(a.handleAPIConfigSave)))
	mux.Handle("PUT /api/groups/{id}", a.requireAdmin(http.HandlerFunc(a.handleAPIGroupSave)))
	mux.Handle("POST /api/downloads/bulk-delete", a.requireAdmin(http.HandlerFunc(a.handleAPIBulkDelete)))
	mux.Handle("DELETE /api/file", a.requireAdmin(http.HandlerFunc(a.handleAPIFileDelete)))
	mux.Handle("DELETE /api/groups/{id}/purge", a.requireAdmin(http.HandlerFunc(a.handleAPIPurgeGroup)))
	mux.Handle("POST /api/groups/{id}/delete-files", a.requireAdmin(http.HandlerFunc(a.handleAPIPurgeGroup)))
	mux.Handle("DELETE /api/purge/all", a.requireAdmin(http.HandlerFunc(a.handleAPIPurgeAll)))
}

func (a *App) handleAPIConfigGet(w http.ResponseWriter, r *http.Request) {
	config, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "config read failed")
		return
	}
	writeJSON(w, http.StatusOK, redactConfig(config))
}

func (a *App) handleAPIConfigSave(w http.ResponseWriter, r *http.Request) {
	var patch map[string]any
	if err := decodeBody(w, r, &patch); err != nil {
		return
	}
	if patch == nil {
		writeJSONError(w, http.StatusBadRequest, "config object is required")
		return
	}
	config, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "config read failed")
		return
	}
	for key, value := range patch {
		config[key] = value
	}
	if err := a.config.Save(r.Context(), config); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "config write failed")
		return
	}
	a.hub.Broadcast(ws.Event{Type: "config_updated", Payload: redactConfig(config)})
	writeJSON(w, http.StatusOK, redactConfig(config))
}

func (a *App) handleAPIGroupSave(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeJSONError(w, http.StatusBadRequest, "group id is required")
		return
	}
	var patch map[string]any
	if err := decodeBody(w, r, &patch); err != nil {
		return
	}
	config, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "config read failed")
		return
	}
	groups, _ := config["groups"].([]any)
	var saved map[string]any
	for i, raw := range groups {
		group, ok := raw.(map[string]any)
		if !ok || strings.TrimSpace(toString(group["id"])) != id {
			continue
		}
		for key, value := range patch {
			group[key] = value
		}
		groups[i] = group
		saved = group
	}
	if saved == nil {
		saved = map[string]any{"id": id}
		for key, value := range patch {
			saved[key] = value
		}
		groups = append(groups, saved)
	}
	config["groups"] = groups
	if err := a.config.Save(r.Context(), config); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "config write failed")
		return
	}
	a.hub.Broadcast(ws.Event{Type: "config_updated", Payload: redactConfig(config)})
	writeJSON(w, http.StatusOK, saved)
}

func redactConfig(config map[string]any) map[string]any {
	copyConfig := make(map[string]any, len(config))
	for key, value := range config {
		copyConfig[key] = value
	}
	if web, ok := copyConfig["web"].(map[string]any); ok {
		copyWeb := make(map[string]any, len(web))
		for key, value := range web {
			copyWeb[key] = value
		}
		if _, ok := copyWeb["passwordHash"]; ok {
			copyWeb["passwordHash"] = "••••••• (redacted)"
		}
		if _, ok := copyWeb["guestPasswordHash"]; ok {
			copyWeb["guestPasswordHash"] = "••••••• (redacted)"
		}
		if _, ok := copyWeb["password"]; ok {
			copyWeb["password"] = "••••••• (redacted)"
		}
		copyConfig["web"] = copyWeb
	}
	return copyConfig
}

func (a *App) handleAPIBulkDelete(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IDs   []int64  `json:"ids"`
		Paths []string `json:"paths"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		return
	}
	if len(body.IDs) == 0 && len(body.Paths) == 0 {
		writeJSONError(w, http.StatusBadRequest, "ids or paths required")
		return
	}
	deleted, err := a.deleteRows(r, body.IDs, body.Paths)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "delete failed")
		return
	}
	a.hub.Broadcast(ws.Event{Type: "bulk_delete", Payload: map[string]any{"count": deleted}})
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "deleted": deleted, "requested": len(body.IDs) + len(body.Paths)})
}

func (a *App) handleAPIFileDelete(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID   int64  `json:"id"`
		Path string `json:"path"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		return
	}
	if body.ID <= 0 && strings.TrimSpace(body.Path) == "" {
		writeJSONError(w, http.StatusBadRequest, "id or path required")
		return
	}
	deleted, err := a.deleteRows(r, []int64{body.ID}, []string{body.Path})
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "delete failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "deleted": deleted})
}

func (a *App) handleAPIPurgeGroup(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeJSONError(w, http.StatusBadRequest, "group id is required")
		return
	}
	result, err := a.db.Writer.ExecContext(r.Context(), `DELETE FROM downloads WHERE group_id = ?`, id)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "purge failed")
		return
	}
	deleted, _ := result.RowsAffected()
	a.hub.Broadcast(ws.Event{Type: "group_purged", Payload: map[string]any{"groupId": id, "deleted": deleted}})
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "deleted": deleted, "groupId": id})
}

func (a *App) handleAPIPurgeAll(w http.ResponseWriter, r *http.Request) {
	result, err := a.db.Writer.ExecContext(r.Context(), `DELETE FROM downloads`)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "purge failed")
		return
	}
	deleted, _ := result.RowsAffected()
	a.hub.Broadcast(ws.Event{Type: "purge_all", Payload: map[string]any{"deleted": deleted}})
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "deleted": deleted})
}

func (a *App) deleteRows(r *http.Request, ids []int64, paths []string) (int64, error) {
	tx, err := a.db.Writer.BeginTx(r.Context(), nil)
	if err != nil {
		return 0, err
	}
	var deleted int64
	for _, id := range ids {
		if id <= 0 {
			continue
		}
		result, err := tx.ExecContext(r.Context(), `DELETE FROM downloads WHERE id = ?`, id)
		if err != nil {
			_ = tx.Rollback()
			return 0, err
		}
		count, _ := result.RowsAffected()
		deleted += count
	}
	for _, path := range paths {
		path = strings.TrimSpace(path)
		if path == "" {
			continue
		}
		result, err := tx.ExecContext(r.Context(), `DELETE FROM downloads WHERE file_path = ? OR REPLACE(file_path, '\\', '/') = ?`, path, strings.ReplaceAll(path, "\\", "/"))
		if err != nil {
			_ = tx.Rollback()
			return 0, err
		}
		count, _ := result.RowsAffected()
		deleted += count
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return deleted, nil
}

func safeDownloadPath(root, stored string) (string, bool) {
	stored = strings.ReplaceAll(stored, "\\", "/")
	if stored == "" || filepath.IsAbs(stored) || strings.ContainsRune(stored, '\x00') {
		return "", false
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return "", false
	}
	candidate, err := filepath.Abs(filepath.Join(root, stored))
	if err != nil {
		return "", false
	}
	rel, err := filepath.Rel(root, candidate)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	return candidate, true
}
