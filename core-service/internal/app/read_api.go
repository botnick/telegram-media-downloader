package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"github.com/botnick/telegram-media-downloader/core-service/internal/auth"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
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
	var journal string
	_ = a.db.Reader.QueryRow("PRAGMA journal_mode").Scan(&journal)
	var dbSize int64
	if st, err := os.Stat(filepath.Join(a.dataDir, "db.sqlite")); err == nil {
		dbSize = st.Size() / (1024 * 1024)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"connections": map[string]any{"wsClients": a.hub.Count()},
		"database":    map[string]any{"journalMode": strings.ToLower(journal), "sizeMB": dbSize, "walPages": 0},
		"disk":        nil,
		"goCore": map[string]any{
			"allowRoots": []string{a.downloadsDir, filepath.Join(a.dataDir, "thumbs"), filepath.Join(a.dataDir, "seekbar"), filepath.Join(a.dataDir, "backups")},
			"binary":     map[string]any{"path": os.Args[0], "source": "development"}, "error": nil,
			"expectedVersion": "0.4.0", "features": map[string]any{"dbscan": map[string]any{"available": true}, "hash": map[string]any{"available": true}, "stat": map[string]any{"available": true}, "walk": map[string]any{"available": true}},
			"pid": os.Getpid(), "platform": runtime.GOOS + "/" + runtime.GOARCH, "problem": nil, "restarts": 0, "since": time.Now().UnixMilli(), "state": "running", "version": "0.4.0",
		},
		"process": map[string]any{"memoryMB": map[string]any{"external": 0, "heapTotal": 0, "heapUsed": 0, "rss": 0}, "nodeVersion": runtime.Version(), "pid": os.Getpid(), "uptime": 0.0},
		"system":  map[string]any{"arch": runtime.GOARCH, "cpuCount": runtime.NumCPU(), "cpuModel": "", "freeMemMB": 0, "hostname": hostname(), "loadAvg": map[string]any{"1m": 0, "5m": 0, "15m": 0}, "platform": runtime.GOOS, "totalMemMB": 0, "usedMemPercent": 0},
	})
}

func hostname() string {
	h, _ := os.Hostname()
	return h
}

func (a *App) handleAPIMonitorStatus(w http.ResponseWriter, r *http.Request) {
	status, err := a.monitorStatusPayload(r.Context())
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, status)
}

func (a *App) monitorStatusPayload(ctx context.Context) (map[string]any, error) {
	config, err := a.config.Load(ctx)
	if err != nil {
		return nil, fmt.Errorf("config read failed: %w", err)
	}
	saved, err := telegram.SavedSessions(a.dataDir)
	if err != nil {
		return nil, fmt.Errorf("account directory read failed: %w", err)
	}
	accounts := len(saved)
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
	status, err := a.monitor.Status(ctx)
	if err != nil {
		return nil, err
	}
	status["hint"] = hint
	if status["accounts"] == 0 {
		status["accounts"] = accounts
	}
	return status, nil
}

func (a *App) handleAPIQueueSnapshot(w http.ResponseWriter, r *http.Request) {
	snapshot, err := a.monitor.Snapshot(r.Context())
	if err != nil {
		writeJSONError(w, 500, "queue read failed")
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (a *App) handleAPIStats(w http.ResponseWriter, r *http.Request) {
	stats, ok := a.statsPayload(r.Context())
	if !ok {
		writeJSONError(w, http.StatusInternalServerError, "database stats query failed")
		return
	}
	if sess, exists := auth.SessionFromContext(r.Context()); exists && sess.Role == "guest" {
		stats["peerStats"] = []map[string]any{}
	}
	writeJSON(w, http.StatusOK, stats)
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
	configured := configuredGroups(config)
	access := a.loadDialogAccess(r)
	guest := false
	if session, ok := auth.SessionFromContext(r.Context()); ok {
		guest = session.Role == "guest"
	}
	out := make([]map[string]any, 0, len(rows)+len(configured))
	seen := map[string]bool{}
	rowByID := map[string]groupAggregate{}
	for _, row := range rows {
		rowByID[row.id] = row
	}
	// Preserve the configured order so the web client sees the same stable
	// ordering as the Node implementation and the user's config file.
	for _, group := range configuredGroupList(config) {
		id := strings.TrimSpace(toString(group["id"]))
		if id == "" {
			continue
		}
		row := rowByID[id]
		name := toString(group["name"])
		if name == "" {
			name = row.name
		}
		if (name == "" || name == "Unknown" || strings.HasPrefix(name, "Group ")) && strings.HasPrefix(id, "-") {
			name = "Unknown chat (#" + id + ")"
		}
		item := map[string]any{"id": id, "name": name, "type": nil, "enabled": false, "peerId": nil, "peerName": nil, "photoUrl": nil}
		for key, value := range group {
			item[key] = value
		}
		item["name"] = name
		if _, ok := group["type"]; !ok {
			item["type"] = nil
		}
		item["filters"] = normalizedGroupFilters(group["filters"])
		if st, statErr := os.Stat(filepath.Join(a.dataDir, "photos", id+".jpg")); statErr == nil && !st.IsDir() {
			item["photoUrl"] = "/photos/" + id + ".jpg"
		} else {
			item["photoUrl"] = nil
		}
		if state := access[id]; state != nil {
			item["access"] = state
		} else {
			item["access"] = legacyDialogAccess(group)
		}
		if guest {
			if state, ok := item["access"].(map[string]any); ok {
				if _, exists := state["accounts"]; exists {
					state["accounts"] = []map[string]any{}
				}
			}
		}
		out = append(out, item)
		seen[id] = true
	}
	if !guest {
		out = a.appendPeerGroups(r, out, seen)
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *App) appendPeerGroups(r *http.Request, out []map[string]any, seen map[string]bool) []map[string]any {
	rows, err := a.db.Reader.QueryContext(r.Context(), `SELECT pg.peer_id, pg.payload, COALESCE(p.name, pg.peer_id) FROM peer_groups pg LEFT JOIN peers p ON p.peer_id = pg.peer_id LIMIT 5000`)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var peerID, payload, peerName string
		if rows.Scan(&peerID, &payload, &peerName) != nil {
			continue
		}
		var body map[string]any
		if json.Unmarshal([]byte(payload), &body) != nil {
			continue
		}
		groups, _ := body["groups"].([]any)
		for _, raw := range groups {
			group, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			id := toString(group["id"])
			if id == "" {
				continue
			}
			if seen[id] {
				for _, item := range out {
					if toString(item["id"]) == id {
						mirrors, _ := item["mirroredOn"].([]any)
						if !containsAny(mirrors, peerID) {
							item["mirroredOn"] = append(mirrors, peerID)
						}
						break
					}
				}
				continue
			}
			item := map[string]any{"id": group["id"], "name": group["name"], "enabled": group["enabled"], "peerId": peerID, "peerName": peerName, "photoUrl": nil, "type": nil}
			out = append(out, item)
			seen[id] = true
		}
	}
	return out
}

func containsAny(values []any, want string) bool {
	for _, value := range values {
		if toString(value) == want {
			return true
		}
	}
	return false
}

func normalizedGroupFilters(raw any) map[string]any {
	filters := map[string]any{"photos": true, "videos": true, "files": true, "links": true, "urls": true, "audio": false, "voice": false, "gifs": false, "stickers": false}
	if configured, ok := raw.(map[string]any); ok {
		for key, value := range configured {
			filters[key] = value
		}
	}
	return filters
}

func (a *App) handleAPIGroupStats(w http.ResponseWriter, r *http.Request) {
	groupID := r.PathValue("id")
	var totalFiles, totalBytes int64
	var first, last sql.NullInt64
	var lastAt sql.NullString
	if err := a.db.Reader.QueryRowContext(r.Context(), `SELECT COUNT(*), COALESCE(SUM(COALESCE(file_size,0)),0), MIN(CASE WHEN file_type IS NOT 'stories' THEN message_id END), MAX(CASE WHEN file_type IS NOT 'stories' THEN message_id END), MAX(CAST(created_at AS TEXT)) FROM downloads WHERE group_id = ?`, groupID).Scan(&totalFiles, &totalBytes, &first, &last, &lastAt); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "database group stats query failed")
		return
	}
	byType := map[string]int64{}
	rows, _ := a.db.Reader.QueryContext(r.Context(), `SELECT file_type, COUNT(*) FROM downloads WHERE group_id = ? GROUP BY file_type`, groupID)
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var kind string
			var count int64
			if rows.Scan(&kind, &count) == nil {
				byType[kind] = count
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "totalFiles": totalFiles, "totalBytes": totalBytes, "byType": byType, "firstMessageId": nullableInt(first), "lastMessageId": nullableInt(last), "lastDownloadAt": nullableString(lastAt)})
}

func (a *App) handleAPIGroupFiles(w http.ResponseWriter, r *http.Request) {
	page, limit := pageLimit(r.URL.Query(), 500)
	groupID := r.PathValue("id")
	offset := (page - 1) * limit
	if raw := r.URL.Query().Get("offset"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 0 {
			offset = parsed
		}
	}
	where := "group_id = ?"
	args := []any{groupID}
	switch r.URL.Query().Get("type") {
	case "photo", "video", "audio", "document":
		where += " AND file_type = ?"
		args = append(args, r.URL.Query().Get("type"))
	case "images":
		where += " AND file_type = 'photo'"
	case "videos":
		where += " AND file_type = 'video'"
	}
	var total int64
	if err := a.db.Reader.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM downloads WHERE `+where, args...).Scan(&total); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "database group files count failed")
		return
	}
	rows, err := a.db.Reader.QueryContext(r.Context(), `SELECT id, message_id, file_name, file_path, file_type, file_size, CAST(created_at AS TEXT), nsfw_score FROM downloads WHERE `+where+` ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, append(args, limit, offset)...)
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
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "rows": out, "total": total, "limit": limit, "offset": offset, "hasMore": offset+len(out) < int(total)})
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
	return int(math.Ceil(float64(total) / float64(limit)))
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
	case int:
		return strconv.Itoa(v)
	case int64:
		return strconv.FormatInt(v, 10)
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
