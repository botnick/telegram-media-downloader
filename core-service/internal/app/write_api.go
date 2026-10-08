package app

import (
	"net/http"
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
	if raw, present := patch["web"]; present {
		web, valid := raw.(map[string]any)
		if !valid {
			writeJSONError(w, 400, "web must be an object")
			return
		}
		for _, key := range []string{"password", "passwordHash", "guestPasswordHash"} {
			if _, present := web[key]; present {
				writeJSONError(w, 400, "Use /api/auth/setup or /api/auth/change-password to manage dashboard auth.")
				return
			}
		}
	}
	a.configMu.Lock()
	defer a.configMu.Unlock()
	config, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "config read failed")
		return
	}
	mergeConfig(config, patch)
	stripPresenceFlags(config)
	if err := a.config.Save(r.Context(), config); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "config write failed")
		return
	}
	a.hub.Broadcast(ws.Event{Type: "config_updated"})
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
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
	a.configMu.Lock()
	defer a.configMu.Unlock()
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
	saved["id"] = id
	config["groups"] = groups
	if err := a.config.Save(r.Context(), config); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "config write failed")
		return
	}
	a.hub.Broadcast(ws.Event{Type: "config_updated"})
	writeJSON(w, http.StatusOK, saved)
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
	deleted, err := a.deleteByWhere(r, `group_id = ?`, id)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "purge failed")
		return
	}
	a.hub.Broadcast(ws.Event{Type: "group_purged", Payload: map[string]any{"groupId": id, "deleted": deleted}})
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "deleted": deleted, "groupId": id})
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
	deleted, err := a.deleteByWhere(r, `1 = 1`)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "purge failed")
		return
	}
	a.hub.Broadcast(ws.Event{Type: "purge_all", Payload: map[string]any{"deleted": deleted}})
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "deleted": deleted})
}
