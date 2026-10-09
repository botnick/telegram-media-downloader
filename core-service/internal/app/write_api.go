package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

func registerConfigWriteRoutes(mux *http.ServeMux, a *App) {
	mux.Handle("GET /api/config", a.requireSession(http.HandlerFunc(a.handleAPIConfigGet)))
	mux.Handle("GET /api/csp", a.requireAdmin(http.HandlerFunc(a.handleCSPMetadata)))
	mux.Handle("GET /api/maintenance/config/raw", a.requireAdmin(http.HandlerFunc(a.handleAPIRawConfig)))
	mux.Handle("POST /api/config", a.requireAdmin(http.HandlerFunc(a.handleAPIConfigSave)))
	mux.Handle("PUT /api/groups/{id}", a.requireAdmin(http.HandlerFunc(a.handleAPIGroupSave)))
	mux.Handle("POST /api/downloads/bulk-delete", a.requireAdmin(http.HandlerFunc(a.handleAPIBulkDelete)))
	mux.Handle("DELETE /api/file", a.requireAdmin(http.HandlerFunc(a.handleAPIFileDelete)))
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
		if raw, present := web["csp"]; present && raw != nil {
			normalized, err := normalizeCSP(raw)
			if err != nil {
				writeJSONError(w, 400, err.Error())
				return
			}
			web["csp"] = normalized
		}
		for _, key := range []string{"password", "passwordHash", "guestPasswordHash"} {
			if _, present := web[key]; present {
				writeJSONError(w, 400, "Use /api/auth/setup or /api/auth/change-password to manage dashboard auth.")
				return
			}
		}
	}
	if raw, ok := patch["download"].(map[string]any); ok {
		if value, present := raw["maxSpeed"]; present && value != nil {
			n := number(value, -1)
			if n < 0 || n > 1<<53-1 || n != math.Trunc(n) {
				writeJSONError(w, http.StatusBadRequest, "download.maxSpeed must be a non-negative integer in bytes/second, or null")
				return
			}
		}
		if value, present := raw["concurrent"]; present {
			n := number(value, -1)
			if n < 1 || n > 50 || n != math.Trunc(n) {
				writeJSONError(w, http.StatusBadRequest, "download.concurrent must be an integer from 1 to 50")
				return
			}
		}
		if value, present := raw["retries"]; present {
			n := number(value, -1)
			if n < 1 || n > 20 || n != math.Trunc(n) {
				writeJSONError(w, http.StatusBadRequest, "download.retries must be an integer from 1 to 20")
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
	if !a.currentAdmin(w, r) {
		return
	}
	rawConfig, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "config read failed")
		return
	}
	config := effectiveConfig(rawConfig)
	mergeConfig(config, patch)
	if web, ok := patch["web"].(map[string]any); ok {
		if csp, present := web["csp"]; present {
			// CSP is one policy document: an omitted directive restores its
			// shipped default, while null resets the entire custom policy.
			if csp == nil {
				delete(ensureMap(config, "web"), "csp")
			} else {
				ensureMap(config, "web")["csp"] = cloneConfigValue(csp)
			}
		}
	}
	if advanced, ok := config["advanced"].(map[string]any); ok && patch["advanced"] != nil {
		sanitizeAdvancedConfig(advanced)
		delete(advanced, "goCore")
	}
	stripPresenceFlags(config)
	role := ""
	web, _ := config["web"].(map[string]any)
	if !webBoolValue(web, "enabled", true) {
		role = "all"
	} else if !webBoolValue(web, "guestEnabled", true) {
		role = "guest"
	}
	if err := a.saveAuthConfig(r.Context(), config, role); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "config write failed")
		return
	}
	a.applyDownloadSpeed(config)
	if _, changed := patch["rescue"]; changed && a.rescueWake != nil {
		select {
		case a.rescueWake <- struct{}{}:
		default:
		}
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
	return map[string]any{"photos": true, "videos": true, "files": true, "links": true, "voice": false, "gifs": false, "stickers": false}
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
	var raw map[string]any
	if err := decodeBody(w, r, &raw); err != nil {
		return
	}
	var idValues []any
	if rawIDs, present := raw["ids"]; present {
		var ok bool
		idValues, ok = rawIDs.([]any)
		if !ok {
			idValues = nil
		}
	}
	var paths []string
	if rawPaths, present := raw["paths"]; present {
		values, ok := rawPaths.([]any)
		if !ok {
			writeJSONError(w, http.StatusBadRequest, "ids or paths required")
			return
		}
		for _, value := range values {
			if text, ok := value.(string); ok {
				paths = append(paths, text)
			}
		}
	}
	idList := make([]int64, 0, len(idValues))
	for _, value := range idValues {
		switch v := value.(type) {
		case float64:
			if v == float64(int64(v)) {
				idList = append(idList, int64(v))
			}
		case string:
			if id, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil {
				idList = append(idList, id)
			}
		case nil:
			idList = append(idList, 0)
		}
	}
	if len(idList) == 0 && len(paths) == 0 {
		writeJSONError(w, http.StatusBadRequest, "ids or paths required")
		return
	}
	if len(idList)+len(paths) > 2000 {
		writeJSONError(w, http.StatusRequestEntityTooLarge, "delete batch exceeds 2000 items")
		return
	}
	if !a.startBulkDelete(idList, paths) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "A bulk delete is already running", "code": "ALREADY_RUNNING"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"queued": len(idList) + len(paths), "started": true, "success": true})
}

func (a *App) runBulkDelete(idList []int64, paths []string) (map[string]any, error) {
	r := contextRequest(a.ctx)
	ids := make([]int64, 0, len(idList))
	seen := map[int64]bool{}
	for _, id := range idList {
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	for _, path := range paths {
		rows, queryErr := a.db.Reader.QueryContext(r.Context(), `SELECT id FROM downloads WHERE REPLACE(file_path,char(92),'/') = ?`, strings.ReplaceAll(path, "\\", "/"))
		if queryErr != nil {
			return nil, queryErr
		}
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return nil, err
			}
			if !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
		}
		rowErr := rows.Err()
		rows.Close()
		if rowErr != nil {
			return nil, rowErr
		}
	}
	requested := len(idList) + len(paths)
	a.bulkDeleteProgress(map[string]any{"processed": 0, "total": requested, "stage": "deleting_files"})
	// Record existing physical files, then count only those actually removed by
	// the reference-aware cleanup. Unknown IDs still count as requested work.
	existing := map[string]bool{}
	processed := len(paths)
	for _, id := range ids {
		var path string
		if a.db.Reader.QueryRowContext(r.Context(), `SELECT file_path FROM downloads WHERE id=?`, id).Scan(&path) == nil {
			if f, err := openMedia(a.downloadsDir, path); err == nil {
				f.Close()
				existing[strings.ReplaceAll(path, "\\", "/")] = true
			}
			for _, input := range idList {
				if input == id {
					processed++
					break
				}
			}
		}
	}
	deleted, err := a.deleteRows(r, ids, nil)
	if err != nil {
		return nil, err
	}
	unlinked := 0
	for path := range existing {
		if f, err := openMedia(a.downloadsDir, path); os.IsNotExist(err) {
			unlinked++
		} else if err == nil {
			f.Close()
		}
	}
	if processed == requested && unlinked > 0 {
		a.bulkDeleteProgress(map[string]any{"processed": requested, "total": requested, "stage": "deleting_files"})
	}
	a.bulkDeleteProgress(map[string]any{"processed": requested, "total": requested, "stage": "purging_cache"})
	a.hub.Broadcast(ws.Event{Type: "bulk_delete", Flat: true, Payload: map[string]any{"count": len(ids), "dbDeleted": deleted, "unlinked": unlinked}})
	return map[string]any{"dbDeleted": deleted, "requested": requested, "unlinked": unlinked}, nil
}

func (a *App) handleAPIFileDelete(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if path == "" {
		writeJSONError(w, http.StatusBadRequest, "Path required")
		return
	}
	if _, err := mediaName(path); err != nil {
		writeJSONError(w, http.StatusForbidden, "Access denied")
		return
	}
	f, err := openMedia(a.downloadsDir, path)
	if err != nil {
		if os.IsNotExist(err) {
			writeJSONError(w, http.StatusNotFound, "File not found")
		} else {
			writeJSONError(w, http.StatusForbidden, "Access denied")
		}
		return
	}
	f.Close()
	var count int64
	if err := a.db.Reader.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM downloads WHERE REPLACE(file_path,char(92),'/') = ?`, strings.ReplaceAll(path, "\\", "/")).Scan(&count); err != nil || count == 0 {
		writeJSONError(w, http.StatusNotFound, "File not found")
		return
	}
	var id int64
	if raw := r.URL.Query().Get("id"); raw != "" {
		id, _ = strconv.ParseInt(raw, 10, 64)
		var matches int64
		_ = a.db.Reader.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM downloads WHERE id = ? AND REPLACE(file_path,char(92),'/') = ?`, id, strings.ReplaceAll(path, "\\", "/")).Scan(&matches)
		if matches == 0 {
			id = 0
		}
	}
	ids := []int64{}
	if id > 0 {
		ids = append(ids, id)
	}
	paths := []string{path}
	if id > 0 {
		paths = nil
	}
	deleted, err := a.deleteRows(r, ids, paths)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "delete failed")
		return
	}
	if deleted == 0 {
		writeJSONError(w, http.StatusNotFound, "File not found")
		return
	}
	payload := map[string]any{"path": strings.ReplaceAll(path, "\\", "/")}
	if remaining, err := openMedia(a.downloadsDir, path); err == nil && id > 0 {
		remaining.Close()
		payload = map[string]any{"id": id}
	} else if err == nil {
		remaining.Close()
	}
	a.hub.Broadcast(ws.Event{Type: "file_deleted", Flat: true, Payload: payload})
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}
