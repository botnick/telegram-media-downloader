package app

import (
	"database/sql"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

func registerGalleryRoutes(mux *http.ServeMux, a *App) {
	guard := a.requireSession
	mux.Handle("GET /api/stats", guard(http.HandlerFunc(a.handleAPIStats)))
	mux.Handle("GET /api/system/health", a.requireAdmin(http.HandlerFunc(a.handleAPISystemHealth)))
	mux.Handle("GET /api/monitor/status", guard(http.HandlerFunc(a.handleAPIMonitorStatus)))
	mux.Handle("GET /api/queue/snapshot", guard(http.HandlerFunc(a.handleAPIQueueSnapshot)))
	mux.Handle("GET /api/downloads", guard(http.HandlerFunc(a.handleAPIDownloads)))
	mux.Handle("GET /api/downloads/all", guard(http.HandlerFunc(a.handleAPIDownloadsAll)))
	mux.Handle("GET /api/downloads/search", guard(http.HandlerFunc(a.handleAPIDownloadsSearch)))
	mux.Handle("GET /api/downloads/{id}", guard(http.HandlerFunc(a.handleAPIDownloadsGroup)))
	mux.Handle("GET /api/groups", guard(http.HandlerFunc(a.handleAPIGroups)))
	mux.Handle("GET /api/groups/{id}/stats", guard(http.HandlerFunc(a.handleAPIGroupStats)))
	mux.Handle("GET /api/groups/{id}/files", guard(http.HandlerFunc(a.handleAPIGroupFiles)))
}

func (a *App) handleAPISystemHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "process": map[string]any{"goVersion": runtime.Version(), "os": runtime.GOOS, "arch": runtime.GOARCH}, "server": "tgdl-server", "websocketClients": 0})
}

func (a *App) handleAPIMonitorStatus(w http.ResponseWriter, r *http.Request) {
	config, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, 500, "config read failed")
		return
	}
	entries, err := os.ReadDir(filepath.Join(a.dataDir, "sessions"))
	if err != nil && !os.IsNotExist(err) {
		writeJSONError(w, 500, "account directory read failed")
		return
	}
	accounts := 0
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".enc") {
			accounts++
		}
	}
	telegram, _ := config["telegram"].(map[string]any)
	var hint any
	switch {
	case number(telegram["apiId"], 0) <= 0 || toString(telegram["apiHash"]) == "":
		hint = "configure-api"
	case accounts == 0:
		hint = "add-account"
	default:
		hint = "enable-group"
		for _, group := range configuredGroups(config) {
			if group["enabled"] == true {
				hint = nil
				break
			}
		}
	}
	// No account runner is started by App yet; expose the actual idle state.
	writeJSON(w, http.StatusOK, map[string]any{"state": "stopped", "error": nil, "startedAt": nil, "uptimeMs": 0, "stats": nil, "queue": 0, "active": 0, "workers": 0, "accounts": accounts, "hint": hint})
}

func (a *App) handleAPIQueueSnapshot(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"items": []any{}, "active": 0, "pending": 0, "completed": 0, "failed": 0})
}

func (a *App) handleAPIStats(w http.ResponseWriter, r *http.Request) {
	var totalFiles, totalSize int64
	if err := a.db.Reader.QueryRowContext(r.Context(), `SELECT COUNT(*), COALESCE(SUM(file_size), 0) FROM downloads`).Scan(&totalFiles, &totalSize); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "database stats query failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"totalFiles": totalFiles, "totalSize": totalSize, "diskUsage": totalSize})
}

func (a *App) handleAPIDownloads(w http.ResponseWriter, r *http.Request) {
	rows, err := a.groupAggregates(r)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "database group query failed")
		return
	}
	out := make([]map[string]any, 0, len(rows))
	config, _ := a.config.Load(r.Context())
	configured := configuredGroups(config)
	for _, row := range rows {
		item := map[string]any{"id": row.id, "name": row.name, "totalFiles": row.count, "sizeFormatted": formatBytes(row.size), "enabled": false, "type": nil, "photoUrl": nil}
		if group := configured[row.id]; group != nil {
			for _, key := range []string{"enabled", "type"} {
				if value, ok := group[key]; ok {
					item[key] = value
				}
			}
		}
		if st, err := os.Stat(filepath.Join(a.dataDir, "photos", row.id+".jpg")); err == nil && !st.IsDir() {
			item["photoUrl"] = "/photos/" + row.id + ".jpg"
		}
		out = append(out, item)
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *App) handleAPIGroups(w http.ResponseWriter, r *http.Request) {
	rows, err := a.groupAggregates(r)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "database group query failed")
		return
	}
	config, _ := a.config.Load(r.Context())
	configured := map[string]map[string]any{}
	if groups, ok := config["groups"].([]any); ok {
		for _, raw := range groups {
			if group, ok := raw.(map[string]any); ok {
				id := strings.TrimSpace(toString(group["id"]))
				if id != "" {
					configured[id] = group
				}
			}
		}
	}
	out := make([]map[string]any, 0, len(rows)+len(configured))
	seen := map[string]bool{}
	for _, row := range rows {
		item := map[string]any{"id": row.id, "name": row.name, "type": "group", "enabled": false, "peerId": nil, "peerName": nil, "photoUrl": nil}
		if group := configured[row.id]; group != nil {
			for key, value := range group {
				item[key] = value
			}
			if _, ok := item["name"]; !ok || strings.TrimSpace(toString(item["name"])) == "" {
				item["name"] = row.name
			}
		}
		out = append(out, item)
		seen[row.id] = true
	}
	for id, group := range configured {
		if seen[id] {
			continue
		}
		item := map[string]any{"id": id, "name": id, "type": "group", "enabled": false, "peerId": nil, "peerName": nil, "photoUrl": nil}
		for key, value := range group {
			item[key] = value
		}
		out = append(out, item)
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *App) handleAPIDownloadsAll(w http.ResponseWriter, r *http.Request) {
	page, limit := pageLimit(r.URL.Query(), 500)
	files, total, err := a.queryFiles(r, "", page, limit)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "database downloads query failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"files": files, "total": total, "page": page, "totalPages": pages(total, limit)})
}

func (a *App) handleAPIDownloadsGroup(w http.ResponseWriter, r *http.Request) {
	groupID := strings.TrimSpace(r.PathValue("id"))
	if groupID == "" || groupID == "all" || groupID == "search" {
		http.NotFound(w, r)
		return
	}
	page, limit := pageLimit(r.URL.Query(), 500)
	files, total, err := a.queryFiles(r, groupID, page, limit)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "database downloads query failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"files": files, "total": total, "page": page, "totalPages": pages(total, limit)})
}

func (a *App) handleAPIDownloadsSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	page, limit := pageLimit(r.URL.Query(), 200)
	if q == "" {
		writeJSON(w, http.StatusOK, map[string]any{"files": []any{}, "total": 0, "page": page, "totalPages": 0, "q": q})
		return
	}
	offset := (page - 1) * limit
	pattern := "%" + q + "%"
	var total int64
	if err := a.db.Reader.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM downloads WHERE COALESCE(file_name,'') LIKE ? OR COALESCE(group_name,'') LIKE ?`, pattern, pattern).Scan(&total); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "database search count failed")
		return
	}
	rows, err := a.db.Reader.QueryContext(r.Context(), `SELECT id, CAST(group_id AS TEXT), group_name, file_name, file_path, file_size, file_type, CAST(created_at AS TEXT), pending_until, rescued_at, pinned FROM downloads WHERE COALESCE(file_name,'') LIKE ? OR COALESCE(group_name,'') LIKE ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, pattern, pattern, limit, offset)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "database search query failed")
		return
	}
	files, err := scanFiles(rows)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "database search read failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"files": files, "total": total, "page": page, "totalPages": pages(total, limit), "q": q})
}

func (a *App) handleAPIGroupStats(w http.ResponseWriter, r *http.Request) {
	groupID := r.PathValue("id")
	var totalFiles, totalBytes int64
	var first, last sql.NullInt64
	var lastAt sql.NullString
	if err := a.db.Reader.QueryRowContext(r.Context(), `SELECT COUNT(*), COALESCE(SUM(COALESCE(file_size,0)),0), MIN(message_id), MAX(message_id), MAX(CAST(created_at AS TEXT)) FROM downloads WHERE group_id = ?`, groupID).Scan(&totalFiles, &totalBytes, &first, &last, &lastAt); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "database group stats query failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"totalFiles": totalFiles, "totalBytes": totalBytes, "byType": map[string]int64{}, "firstMessageId": nullableInt(first), "lastMessageId": nullableInt(last), "lastDownloadAt": nullableString(lastAt)})
}

func (a *App) handleAPIGroupFiles(w http.ResponseWriter, r *http.Request) {
	page, limit := pageLimit(r.URL.Query(), 500)
	groupID := r.PathValue("id")
	offset := (page - 1) * limit
	var total int64
	if err := a.db.Reader.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM downloads WHERE group_id = ?`, groupID).Scan(&total); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "database group files count failed")
		return
	}
	rows, err := a.db.Reader.QueryContext(r.Context(), `SELECT id, message_id, file_name, file_path, file_type, file_size, CAST(created_at AS TEXT), nsfw_score FROM downloads WHERE group_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, groupID, limit, offset)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "database group files query failed")
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0, limit)
	for rows.Next() {
		var id, messageID int64
		var name, filePath, kind, created sql.NullString
		var size sql.NullInt64
		var score sql.NullFloat64
		if err := rows.Scan(&id, &messageID, &name, &filePath, &kind, &size, &created, &score); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "database group files scan failed")
			return
		}
		out = append(out, map[string]any{"id": id, "message_id": messageID, "file_name": nullableString(name), "file_path": nullableString(filePath), "file_type": nullableString(kind), "file_size": nullableInt(size), "created_at": nullableString(created), "nsfw_score": nullableFloat(score)})
	}
	writeJSON(w, http.StatusOK, map[string]any{"files": out, "rows": out, "total": total, "limit": limit, "offset": offset, "hasMore": offset+len(out) < int(total)})
}

type groupAggregate struct {
	id    string
	name  string
	count int64
	size  int64
}

func (a *App) groupAggregates(r *http.Request) ([]groupAggregate, error) {
	rows, err := a.db.Reader.QueryContext(r.Context(), `SELECT CAST(group_id AS TEXT), COALESCE(MAX(NULLIF(group_name,'')), CAST(group_id AS TEXT)), COUNT(*), COALESCE(SUM(file_size),0) FROM downloads GROUP BY group_id ORDER BY group_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]groupAggregate, 0, 64)
	for rows.Next() {
		var item groupAggregate
		if err := rows.Scan(&item.id, &item.name, &item.count, &item.size); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (a *App) queryFiles(r *http.Request, groupID string, page, limit int) ([]map[string]any, int64, error) {
	query := `SELECT COUNT(*) FROM downloads`
	args := []any{}
	if groupID != "" {
		query += ` WHERE group_id = ?`
		args = append(args, groupID)
	}
	var total int64
	if err := a.db.Reader.QueryRowContext(r.Context(), query, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	query = `SELECT id, CAST(group_id AS TEXT), group_name, file_name, file_path, file_size, file_type, CAST(created_at AS TEXT), pending_until, rescued_at, pinned FROM downloads`
	if groupID != "" {
		query += ` WHERE group_id = ?`
	}
	query += ` ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
	args = append(args, limit, (page-1)*limit)
	rows, err := a.db.Reader.QueryContext(r.Context(), query, args...)
	if err != nil {
		return nil, 0, err
	}
	files, err := scanFiles(rows)
	return files, total, err
}

func scanFiles(rows *sql.Rows) ([]map[string]any, error) {
	defer rows.Close()
	out := make([]map[string]any, 0, 50)
	for rows.Next() {
		var id, pinned int64
		var groupID, groupName, name, filePath, kind, created sql.NullString
		var size, pending, rescued sql.NullInt64
		if err := rows.Scan(&id, &groupID, &groupName, &name, &filePath, &size, &kind, &created, &pending, &rescued, &pinned); err != nil {
			return nil, err
		}
		fileName := stringValue(name)
		fileType := stringValue(kind)
		folder := "documents"
		switch fileType {
		case "photo":
			folder = "images"
		case "video":
			folder = "videos"
		case "audio":
			folder = "audio"
		case "sticker":
			folder = "stickers"
		}
		stored := strings.ReplaceAll(stringValue(filePath), "\\", "/")
		fullPath := stored
		if fullPath == "" {
			fullPath = strings.TrimSpace(stringValue(groupName)) + "/" + folder + "/" + strings.TrimSpace(fileName)
		}
		out = append(out, map[string]any{
			"id": id, "groupId": nullableString(groupID), "groupName": nullableString(groupName),
			"name": fileName, "path": nullableString(filePath), "fullPath": fullPath,
			"size": nullableInt(size), "sizeFormatted": formatBytes(nullableInt64(size)),
			"type": folder, "extension": filepath.Ext(fileName), "modified": nullableString(created),
			"pendingUntil": nullableInt(pending), "rescuedAt": nullableInt(rescued), "pinned": pinned == 1,
		})
	}
	return out, rows.Err()
}

func pageLimit(values url.Values, cap int) (int, int) {
	page, _ := strconv.Atoi(values.Get("page"))
	if page < 1 {
		page = 1
	}
	limit, _ := strconv.Atoi(values.Get("limit"))
	if limit < 1 {
		limit = 50
	}
	if limit > cap {
		limit = cap
	}
	return page, limit
}

func pages(total int64, limit int) int {
	if total == 0 {
		return 0
	}
	return int((total + int64(limit) - 1) / int64(limit))
}

func formatBytes(value int64) string {
	if value < 1024 {
		return strconv.FormatInt(value, 10) + " B"
	}
	units := []string{"KB", "MB", "GB", "TB"}
	f := float64(value)
	for _, unit := range units {
		f /= 1024
		if f < 1024 || unit == "TB" {
			formatted := strconv.FormatFloat(f, 'f', 2, 64)
			formatted = strings.TrimRight(strings.TrimRight(formatted, "0"), ".")
			return formatted + " " + unit
		}
	}
	return strconv.FormatInt(value, 10) + " B"
}

func configuredGroups(config map[string]any) map[string]map[string]any {
	out := map[string]map[string]any{}
	groups, _ := config["groups"].([]any)
	for _, raw := range groups {
		group, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		id := strings.TrimSpace(toString(group["id"]))
		if id != "" {
			out[id] = group
		}
	}
	return out
}

func toString(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case float64:
		return strconv.FormatInt(int64(v), 10)
	default:
		return ""
	}
}

func nullableString(value sql.NullString) any {
	if !value.Valid {
		return nil
	}
	return value.String
}

func stringValue(value sql.NullString) string {
	if !value.Valid {
		return ""
	}
	return value.String
}

func nullableInt(value sql.NullInt64) any {
	if !value.Valid {
		return nil
	}
	return value.Int64
}

func nullableFloat(value sql.NullFloat64) any {
	if !value.Valid {
		return nil
	}
	return value.Float64
}

func nullableInt64(value sql.NullInt64) int64 {
	if !value.Valid {
		return 0
	}
	return value.Int64
}
