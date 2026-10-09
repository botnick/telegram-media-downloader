package app

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/front"
)

func registerShareRoutes(mux *http.ServeMux, a *App) {
	mux.Handle("POST /api/share/links", a.requireAdmin(http.HandlerFunc(a.handleShareCreate)))
	mux.Handle("GET /api/share/links", a.requireAdmin(http.HandlerFunc(a.handleShareList)))
	mux.Handle("DELETE /api/share/links/{id}", a.requireAdmin(http.HandlerFunc(a.handleShareRevoke)))
	limiter := newRateLimiter(60, time.Minute)
	limiter.message = "Too many requests — slow down."
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		config, err := a.config.Load(r.Context())
		if err != nil {
			writeJSONError(w, 500, "config read failed")
			return
		}
		advanced, _ := config["advanced"].(map[string]any)
		share, _ := advanced["share"].(map[string]any)
		limiter.configure(int(number(share["rateLimitMax"], 60)), time.Duration(number(share["rateLimitWindowMs"], 60000))*time.Millisecond)
		limiter.middleware(http.HandlerFunc(a.handleShareServe)).ServeHTTP(w, r)
	})
	mux.Handle("GET /share/{id}", handler)
	mux.Handle("GET /share/{id}/{name}", handler)
}

func (a *App) shareSecret(ctx context.Context) ([]byte, error) {
	a.configMu.Lock()
	defer a.configMu.Unlock()
	config, err := a.config.Load(ctx)
	if err != nil {
		return nil, err
	}
	web := ensureMap(config, "web")
	encoded, _ := web["shareSecret"].(string)
	if key, err := hex.DecodeString(encoded); err == nil && len(key) == 32 {
		return key, nil
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	web["shareSecret"] = hex.EncodeToString(key)
	if err := a.config.Save(ctx, config); err != nil {
		return nil, err
	}
	return key, nil
}
func shareSignature(key []byte, id, expires int64) string {
	mac := hmac.New(sha256.New, key)
	fmt.Fprintf(mac, "%d|%d", id, expires)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
func number(value any, defaultValue float64) float64 {
	switch v := value.(type) {
	case float64:
		if !math.IsNaN(v) && !math.IsInf(v, 0) {
			return v
		}
	case string:
		n, err := strconv.ParseFloat(v, 64)
		if err == nil && !math.IsNaN(n) && !math.IsInf(n, 0) {
			return n
		}
	}
	return defaultValue
}
func shareTTL(config map[string]any, value any) int64 {
	advanced, _ := config["advanced"].(map[string]any)
	limits, _ := advanced["share"].(map[string]any)
	minimum := number(limits["ttlMinSec"], 60)
	if minimum < 1 {
		minimum = 60
	}
	maximum := number(limits["ttlMaxSec"], 90*24*3600)
	if maximum < minimum {
		maximum = 90 * 24 * 3600
	}
	maximum = math.Min(maximum, 10*365*24*3600)
	standard := number(limits["ttlDefaultSec"], 7*24*3600)
	standard = math.Max(minimum, math.Min(maximum, standard))
	ttl := number(value, standard)
	if ttl < 0 {
		ttl = standard
	}
	if ttl == 0 {
		return 0
	}
	return int64(math.Max(minimum, math.Min(maximum, ttl)))
}

func (a *App) handleShareCreate(w http.ResponseWriter, r *http.Request) {
	body, ok := readAuthBody(w, r)
	if !ok {
		return
	}
	id := int64(number(body["downloadId"], 0))
	if id <= 0 {
		writeJSONError(w, 400, "downloadId required")
		return
	}
	var found int64
	if err := a.db.Reader.QueryRowContext(r.Context(), `SELECT id FROM downloads WHERE id=?`, id).Scan(&found); errors.Is(err, sql.ErrNoRows) {
		writeJSONError(w, 404, "Download not found")
		return
	} else if err != nil {
		writeJSONError(w, 500, "Database read failed")
		return
	}
	config, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, 500, "config read failed")
		return
	}
	key, err := a.shareSecret(r.Context())
	if err != nil {
		writeJSONError(w, 500, "Share secret unavailable")
		return
	}
	ttl := shareTTL(config, body["ttlSeconds"])
	expires := int64(0)
	if ttl > 0 {
		expires = time.Now().Unix() + ttl
	}
	label, _ := body["label"].(string)
	label = strings.TrimSpace(strings.NewReplacer("\r", " ", "\n", " ", "\t", " ").Replace(label))
	chars := []rune(label)
	if len(chars) > 80 {
		label = string(chars[:80])
	}
	var storedLabel any
	if label != "" {
		storedLabel = label
	}
	result, err := a.db.Writer.ExecContext(r.Context(), `INSERT INTO share_links(download_id,created_at,expires_at,label) VALUES(?,?,?,?)`, id, time.Now().UnixMilli(), expires, storedLabel)
	if err != nil {
		writeJSONError(w, 500, "Share creation failed")
		return
	}
	linkID, err := result.LastInsertId()
	if err != nil {
		writeJSONError(w, 500, "Share creation failed")
		return
	}
	links, err := a.queryShareLinks(r, key, "s.id=?", []any{linkID}, 1, 0)
	if err != nil || len(links) != 1 {
		writeJSONError(w, 500, "Share read failed")
		return
	}
	writeJSON(w, 200, map[string]any{"success": true, "link": links[0]})
}

func (a *App) queryShareLinks(r *http.Request, key []byte, where string, args []any, limit, offset int) ([]map[string]any, error) {
	rows, err := a.db.Reader.QueryContext(r.Context(), `SELECT s.id,s.download_id,s.created_at,s.expires_at,s.revoked_at,s.label,s.access_count,s.last_accessed_at,d.file_name,d.file_type,d.file_size,CAST(d.group_id AS TEXT),d.group_name FROM share_links s JOIN downloads d ON d.id=s.download_id WHERE `+where+` ORDER BY s.created_at DESC LIMIT ? OFFSET ?`, append(args, limit, offset)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	keys := []string{"id", "downloadId", "createdAt", "expiresAt", "revokedAt", "label", "accessCount", "lastAccessedAt", "fileName", "fileType", "fileSize", "groupId", "groupName"}
	out := make([]map[string]any, 0)
	for rows.Next() {
		values := make([]any, len(keys))
		dest := make([]any, len(keys))
		for i := range dest {
			dest[i] = &values[i]
		}
		if err := rows.Scan(dest...); err != nil {
			return nil, err
		}
		row := make(map[string]any, len(keys)+1)
		for i, key := range keys {
			row[key] = values[i]
		}
		id := values[0].(int64)
		expires := values[3].(int64)
		proto := requestScheme(r)
		row["url"] = fmt.Sprintf("%s://%s/share/%d?s=%s", proto, r.Host, id, shareSignature(key, id, expires))
		out = append(out, row)
	}
	return out, rows.Err()
}

func requestScheme(r *http.Request) string {
	if networkForRequest(r).secure {
		return "https"
	}
	return "http"
}

func (a *App) handleShareList(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := int(number(q.Get("limit"), 500))
	if limit == 0 {
		limit = 500
	}
	limit = max(1, min(limit, 2000))
	offset := max(0, int(number(q.Get("offset"), 0)))
	where := []string{"1=1"}
	args := []any{}
	if q.Get("downloadId") != "" {
		where = append(where, "s.download_id=?")
		args = append(args, int64(number(q.Get("downloadId"), 0)))
	}
	if q.Get("includeRevoked") == "0" {
		where = append(where, "s.revoked_at IS NULL")
	}
	if search := strings.TrimSpace(q.Get("q")); search != "" {
		where = append(where, "(s.label LIKE ? OR d.file_name LIKE ? OR d.group_name LIKE ?)")
		pattern := "%" + search + "%"
		args = append(args, pattern, pattern, pattern)
	}
	clause := strings.Join(where, " AND ")
	var total int64
	if err := a.db.Reader.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM share_links s JOIN downloads d ON d.id=s.download_id WHERE `+clause, args...).Scan(&total); err != nil {
		writeJSONError(w, 500, "Share read failed")
		return
	}
	key, err := a.shareSecret(r.Context())
	if err != nil {
		writeJSONError(w, 500, "Share secret unavailable")
		return
	}
	links, err := a.queryShareLinks(r, key, clause, args, limit, offset)
	if err != nil {
		writeJSONError(w, 500, "Share read failed")
		return
	}
	writeJSON(w, 200, map[string]any{"success": true, "links": links, "total": total, "limit": limit, "offset": offset, "hasMore": offset+len(links) < int(total)})
}

func (a *App) handleShareRevoke(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeJSONError(w, 400, "Invalid id")
		return
	}
	result, err := a.db.Writer.ExecContext(r.Context(), `UPDATE share_links SET revoked_at=? WHERE id=? AND revoked_at IS NULL`, time.Now().UnixMilli(), id)
	if err != nil {
		writeJSONError(w, 500, "Share revoke failed")
		return
	}
	changed, err := result.RowsAffected()
	if err != nil {
		writeJSONError(w, 500, "Share revoke failed")
		return
	}
	writeJSON(w, 200, map[string]any{"success": true, "revoked": changed > 0})
}

func (a *App) handleShareServe(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	sig := r.URL.Query().Get("s")
	legacy := false
	if sig == "" {
		sig = r.URL.Query().Get("sig")
		legacy = true
	}
	if err != nil || id <= 0 || sig == "" {
		writeText(w, r, 400, "Invalid share link")
		return
	}
	var expires int64
	var revoked sql.NullInt64
	var stored, name sql.NullString
	err = a.db.Reader.QueryRowContext(r.Context(), `SELECT s.expires_at,s.revoked_at,d.file_path,d.file_name FROM share_links s JOIN downloads d ON d.id=s.download_id WHERE s.id=?`, id).Scan(&expires, &revoked, &stored, &name)
	reason := ""
	switch {
	case errors.Is(err, sql.ErrNoRows):
		reason = "not_found"
	case err != nil:
		writeJSONError(w, 500, "Share read failed")
		return
	case revoked.Valid:
		reason = "revoked"
	case expires != 0 && expires <= time.Now().Unix():
		reason = "expired"
	}
	if reason != "" {
		writeJSON(w, 401, map[string]any{"error": "Share link is not valid", "code": reason})
		return
	}
	key, err := a.shareSecret(r.Context())
	if err != nil {
		writeJSONError(w, 500, "Share secret unavailable")
		return
	}
	valid := hmac.Equal([]byte(sig), []byte(shareSignature(key, id, expires)))
	if legacy {
		exp, err := strconv.ParseInt(r.URL.Query().Get("exp"), 10, 64)
		valid = valid && err == nil && exp > 0 && exp == expires
	}
	if !valid {
		writeJSON(w, 401, map[string]any{"error": "Share link is not valid", "code": "bad_sig"})
		return
	}
	f, err := openMedia(a.downloadsDir, stored.String)
	if err != nil {
		writeText(w, r, 404, "File not found")
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		writeText(w, r, 404, "File not found")
		return
	}
	disposition := "inline"
	if v := r.URL.Query().Get("download"); v == "1" || v == "true" {
		disposition = "attachment"
	}
	safeName := strings.NewReplacer("\r", "_", "\n", "_", "\"", "_").Replace(name.String)
	if safeName == "" {
		safeName = fmt.Sprintf("file-%d", id)
	}
	ascii := strings.Map(func(c rune) rune {
		if c < 32 || c > 126 {
			return '_'
		}
		return c
	}, safeName)
	w.Header().Set("Content-Disposition", disposition+`; filename="`+ascii+`"; filename*=UTF-8''`+url.PathEscape(safeName))
	w.Header().Set("Cache-Control", "private, no-store, no-cache, must-revalidate")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("X-Frame-Options", "DENY")
	// Capture the status without buffering media so partial/failed transfers
	// do not claim a successful library access.
	status, err := front.ServeContent(w, r, f, name.String)
	if err == nil && (status == 200 || status == 206) {
		_, _ = a.db.Writer.ExecContext(r.Context(), `UPDATE share_links SET access_count=access_count+1,last_accessed_at=? WHERE id=?`, time.Now().UnixMilli(), id)
	}
}

func writeText(w http.ResponseWriter, r *http.Request, status int, body string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("ETag", weakETag([]byte(body)))
	w.WriteHeader(status)
	if r.Method != "HEAD" {
		_, _ = w.Write([]byte(body))
	}
}
