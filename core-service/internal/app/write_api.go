package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

func registerConfigWriteRoutes(mux *http.ServeMux, a *App) {
	mux.Handle("GET /api/config", a.requireSession(http.HandlerFunc(a.handleAPIConfigGet)))
	mux.Handle("GET /api/maintenance/config/raw", a.requireAdmin(http.HandlerFunc(a.handleAPIRawConfig)))
	mux.Handle("POST /api/config", a.requireAdmin(http.HandlerFunc(a.handleAPIConfigSave)))
	mux.Handle("PUT /api/groups/{id}", a.requireAdmin(http.HandlerFunc(a.handleAPIGroupSave)))
	mux.Handle("POST /api/downloads/bulk-delete", a.requireAdmin(http.HandlerFunc(a.handleAPIBulkDelete)))
	mux.Handle("DELETE /api/file", a.requireAdmin(http.HandlerFunc(a.handleAPIFileDelete)))
	mux.Handle("DELETE /api/groups/{id}/purge", a.requireAdmin(http.HandlerFunc(a.handleAPIPurgeGroup)))
	mux.Handle("POST /api/groups/{id}/delete-files", a.requireAdmin(http.HandlerFunc(a.handleAPIPurgeGroup)))
	mux.Handle("DELETE /api/purge/all", a.requireAdmin(http.HandlerFunc(a.handleAPIPurgeAll)))
}

func (a *App) handleAPIConfigGet(w http.ResponseWriter, r *http.Request) {
	raw, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "config read failed")
		return
	}
	writeJSON(w, http.StatusOK, redactConfig(effectiveConfig(raw)))
}

func (a *App) handleAPIRawConfig(w http.ResponseWriter, r *http.Request) {
	raw, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "config read failed")
		return
	}
	writeJSON(w, http.StatusOK, rawRedactedConfig(effectiveConfig(raw)))
}

func (a *App) handleAPIConfigSave(w http.ResponseWriter, r *http.Request) {
	var patch map[string]any
	if err := decodeConfigPatch(w, r, &patch); err != nil {
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
	if raw, ok := patch["download"].(map[string]any); ok {
		if value, present := raw["concurrent"]; present {
			n := number(value, -1)
			if n < 1 || n > 50 {
				writeJSONError(w, http.StatusBadRequest, "download.concurrent must be 1-50")
				return
			}
		}
		if value, present := raw["retries"]; present {
			n := number(value, -1)
			if n < 0 || n > 50 {
				writeJSONError(w, http.StatusBadRequest, "download.retries must be 0-50")
				return
			}
		}
	}
	if value, present := patch["pollingInterval"]; present && number(value, 0) < 1 {
		writeJSONError(w, http.StatusBadRequest, "pollingInterval must be >= 1 (seconds)")
		return
	}
	a.configMu.Lock()
	defer a.configMu.Unlock()
	rawConfig, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "config read failed")
		return
	}
	config := effectiveConfig(rawConfig)
	mergeConfig(config, patch)
	if advanced, ok := config["advanced"].(map[string]any); ok && patch["advanced"] != nil {
		sanitizeAdvancedConfig(advanced)
		delete(advanced, "goCore")
	}
	stripPresenceFlags(config)
	if err := a.config.Save(r.Context(), config); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "config write failed")
		return
	}
	if advancedPatch, ok := patch["advanced"].(map[string]any); ok {
		if _, changed := advancedPatch["ai"]; changed {
			a.hub.Broadcast(ws.Event{Type: "ai_config_changed", Flat: true})
		}
		if _, changed := advancedPatch["seekbar"]; changed {
			a.hub.Broadcast(ws.Event{Type: "seekbar_config_changed", Flat: true})
			if advanced, ok := config["advanced"].(map[string]any); ok {
				if seekbar, ok := advanced["seekbar"].(map[string]any); ok {
					url := stringOr(seekbar["sidecarUrl"], "")
					if url != "" {
						a.hub.Broadcast(ws.Event{Type: "seekbar_sidecar_status", Flat: true, Payload: map[string]any{
							"checkedAt": time.Now().UnixMilli(), "error": "fetch failed", "mode": "remote", "ok": false, "pid": nil,
							"sources": map[string]any{"pathMap": nil, "token": "config", "url": "config"}, "url": url,
						}})
					}
				}
			}
		}
	}
	a.hub.Broadcast(ws.Event{Type: "config_updated"})
	a.broadcastStatsUpdate(r.Context())
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
	if patch == nil {
		writeJSONError(w, http.StatusBadRequest, "group object is required")
		return
	}
	groups, _ := config["groups"].([]any)
	var saved map[string]any
	for i, raw := range groups {
		group, ok := raw.(map[string]any)
		if !ok || strings.TrimSpace(toString(group["id"])) != id {
			continue
		}
		if patch["enabled"] == true && group["suspended"] == true {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "Cannot re-enable a suspended group — the channel/group was deleted or banned on Telegram", "code": "GROUP_SUSPENDED"})
			return
		}
		for key, value := range patch {
			switch key {
			case "filters":
				incoming, ok := value.(map[string]any)
				if ok {
					merged := normalizedGroupFilters(group["filters"])
					for k, v := range incoming {
						merged[k] = v
					}
					group[key] = merged
				} else {
					delete(group, key)
				}
			case "topics":
				if value == nil {
					delete(group, key)
					continue
				}
				group[key] = normalizedTopics(value)
			case "rescueMode":
				if mode, ok := value.(string); ok && (mode == "on" || mode == "off") {
					group[key] = mode
				} else {
					delete(group, "rescueMode")
					delete(group, "rescueRetentionHours")
				}
			case "rescueRetentionHours":
				if n := number(value, 0); n > 0 {
					if n > 720 {
						n = 720
					}
					group[key] = n
				} else {
					delete(group, key)
				}
			default:
				if text, ok := value.(string); ok && text == "" {
					delete(group, key)
				} else {
					group[key] = value
				}
			}
		}
		group["filters"] = normalizedGroupFilters(group["filters"])
		groups[i] = group
		saved = group
	}
	if saved == nil {
		groupID := any(id)
		if strings.HasPrefix(id, "-") {
			if parsed, parseErr := strconv.ParseInt(id, 10, 64); parseErr == nil {
				groupID = parsed
			}
		}
		saved = map[string]any{"id": groupID, "name": "Unknown", "enabled": false, "filters": newGroupFilters(), "autoForward": map[string]any{"enabled": false, "destination": nil, "deleteAfterForward": false}, "trackUsers": map[string]any{"enabled": false, "users": []any{}}, "topics": map[string]any{"enabled": false, "ids": []any{}}}
		for key, value := range patch {
			switch key {
			case "filters":
				if incoming, ok := value.(map[string]any); ok {
					merged := normalizedGroupFilters(nil)
					for k, v := range incoming {
						merged[k] = v
					}
					saved[key] = merged
				}
			case "topics":
				saved[key] = normalizedTopics(value)
			default:
				saved[key] = value
			}
		}
		groups = append(groups, saved)
	}
	if _, ok := saved["id"]; !ok {
		saved["id"] = id
	}
	config["groups"] = groups
	if err := a.config.Save(r.Context(), config); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "config write failed")
		return
	}
	a.hub.Broadcast(ws.Event{Type: "config_updated"})
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "group": saved})
}

func newGroupFilters() map[string]any {
	return map[string]any{"photos": true, "videos": true, "files": true, "links": false, "urls": true, "audio": false, "voice": false, "gifs": false, "stickers": false}
}

// decodeConfigPatch follows express.json's contract for this endpoint. The
// dashboard sends JSON; other content types are intentionally treated as an
// empty patch so a text/plain probe cannot overwrite settings.
func decodeConfigPatch(w http.ResponseWriter, r *http.Request, dst *map[string]any) error {
	contentType := strings.TrimSpace(strings.ToLower(r.Header.Get("Content-Type")))
	if contentType != "" && !strings.Contains(contentType, "application/json") {
		*dst = map[string]any{}
		return nil
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2<<20))
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "Request body too large")
		} else {
			writeJSONError(w, http.StatusBadRequest, "Malformed JSON body")
		}
		return err
	}
	if len(bytes.TrimSpace(body)) == 0 {
		writeJSONError(w, http.StatusBadRequest, "Malformed JSON body")
		return errors.New("empty config body")
	}
	var value any
	if err := json.Unmarshal(body, &value); err != nil || value == nil {
		writeJSONError(w, http.StatusBadRequest, "Malformed JSON body")
		return errors.New("malformed config body")
	}
	if object, ok := value.(map[string]any); ok {
		*dst = object
		return nil
	}
	if array, ok := value.([]any); ok {
		object := make(map[string]any, len(array))
		for i, item := range array {
			object[strconv.Itoa(i)] = item
		}
		*dst = object
		return nil
	}
	writeJSONError(w, http.StatusBadRequest, "Malformed JSON body")
	return errors.New("config body must be object or array")
}

func normalizedTopics(value any) map[string]any {
	input, _ := value.(map[string]any)
	out := map[string]any{"enabled": false, "ids": []any{}}
	if input == nil {
		return out
	}
	if enabled, ok := input["enabled"].(bool); ok {
		out["enabled"] = enabled
	}
	ids, _ := input["ids"].([]any)
	clean := make([]any, 0, len(ids))
	for _, raw := range ids {
		switch v := raw.(type) {
		case float64:
			if v == float64(int64(v)) {
				clean = append(clean, int64(v))
			}
		case string:
			if n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil {
				clean = append(clean, n)
			}
		}
	}
	out["ids"] = clean
	return out
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
	a.hub.Broadcast(ws.Event{Type: "bulk_delete", Flat: true, Payload: map[string]any{"count": deleted}})
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
	a.hub.Broadcast(ws.Event{Type: "group_purged", Flat: true, Payload: map[string]any{"groupId": id, "deleted": deleted}})
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
	a.hub.Broadcast(ws.Event{Type: "purge_all", Flat: true, Payload: map[string]any{"deleted": deleted}})
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "deleted": deleted})
}
