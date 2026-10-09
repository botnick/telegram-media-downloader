package app

import (
	"context"
	"crypto/sha1" // #nosec G505 -- HTTP cache validator, not authentication.
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

func registerSystemRoutes(mux *http.ServeMux, a *App) {
	admin := func(h http.HandlerFunc) http.Handler { return a.requireAdmin(http.HandlerFunc(h)) }
	mux.Handle("GET /api/rescue/stats", admin(a.handleRescueStats))
	mux.Handle("GET /api/maintenance/logs", admin(a.handleLogList))
	mux.Handle("GET /api/maintenance/logs/download", admin(a.handleLogDownload))
	mux.Handle("GET /api/maintenance/logs/recent", admin(a.handleLogRecent))
	mux.Handle("POST /api/maintenance/session/export", admin(a.handleSessionExport))
	mux.Handle("POST /api/maintenance/sessions/revoke-all", admin(a.handleRevokeAll))
}

func (a *App) handleRescueStats(w http.ResponseWriter, r *http.Request) {
	var pending, rescued, cleared int64
	err := a.db.Reader.QueryRowContext(r.Context(), `SELECT
      (SELECT COUNT(*) FROM downloads WHERE pending_until IS NOT NULL AND rescued_at IS NULL),
      (SELECT COUNT(*) FROM downloads WHERE rescued_at IS NOT NULL),
      COALESCE((SELECT CAST(value AS INTEGER) FROM kv WHERE key='native_rescue_last'),0)`).Scan(&pending, &rescued, &cleared)
	if err != nil {
		writeJSONError(w, 500, "rescue stats query failed")
		return
	}
	writeJSON(w, 200, map[string]any{"lastSweepCleared": cleared, "pending": pending, "rescued": rescued})
}

type logFile struct {
	name     string
	modified time.Time
	size     int64
}

func (a *App) handleLogList(w http.ResponseWriter, _ *http.Request) {
	entries, _ := os.ReadDir(filepath.Join(a.dataDir, "logs"))
	files := make([]logFile, 0)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".log") {
			continue
		}
		if info, err := entry.Info(); err == nil {
			files = append(files, logFile{name: entry.Name(), modified: info.ModTime(), size: info.Size()})
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].modified.After(files[j].modified) })
	out := make([]map[string]any, 0, len(files))
	for _, file := range files {
		out = append(out, map[string]any{"modified": file.modified.UTC().Format("2006-01-02T15:04:05.000Z"), "name": file.name, "size": file.size})
	}
	writeJSON(w, http.StatusOK, map[string]any{"files": out})
}

func (a *App) handleLogDownload(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" || strings.ContainsAny(name, `/\\`) || !strings.HasSuffix(name, ".log") || filepath.Base(name) != name {
		writeJSONError(w, http.StatusBadRequest, "Invalid log name")
		return
	}
	path := filepath.Join(a.dataDir, "logs", name)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			writeJSONError(w, http.StatusNotFound, "Log not found")
		} else {
			writeJSONError(w, http.StatusInternalServerError, "Unable to read log")
		}
		return
	}
	lines := 5000
	if n, err := strconv.Atoi(r.URL.Query().Get("lines")); err == nil && n > 0 {
		if n < 10 {
			n = 10
		}
		lines = n
	}
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	parts := strings.Split(text, "\n")
	if len(parts) > lines {
		parts = parts[len(parts)-lines:]
	}
	text = strings.Join(parts, "\n")
	fallback := strings.Map(func(r rune) rune {
		if r < 0x20 || r > 0x7e {
			return '_'
		}
		return r
	}, name)
	w.Header().Set("Content-Disposition", `attachment; filename="`+fallback+`"; filename*=UTF-8''`+url.PathEscape(name))
	sum := sha1.Sum([]byte(text)) // #nosec G401 -- cache validator only.
	w.Header().Set("ETag", `W/"`+strconv.FormatInt(int64(len(text)), 16)+`-`+base64.RawStdEncoding.EncodeToString(sum[:])+`"`)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(text))
}

func (a *App) handleLogRecent(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
	writeJSON(w, http.StatusOK, map[string]any{"bufferSize": 2000, "logs": []any{}, "total": 0})
}

func (a *App) verifyAdminPassword(ctx context.Context, password string) error {
	role, configured, err := a.config.Login(ctx, password)
	if err != nil {
		return err
	}
	if !configured || role != "admin" {
		return errors.New("invalid password")
	}
	return nil
}

func (a *App) handleSessionExport(w http.ResponseWriter, r *http.Request) {
	body, _ := readAuthBody(w, r)
	if body["confirm"] != true {
		writeJSONError(w, http.StatusBadRequest, `Pass {"confirm": true} in the request body to proceed.`)
		return
	}
	password, ok := body["password"].(string)
	if !ok || password == "" {
		writeJSONError(w, http.StatusBadRequest, "Password required")
		return
	}
	if err := a.verifyAdminPassword(r.Context(), password); err != nil {
		writeJSONError(w, http.StatusForbidden, "Invalid password")
		return
	}
	accountID, _ := body["accountId"].(string)
	if accountID == "" {
		writeJSONError(w, http.StatusBadRequest, "accountId required")
		return
	}
	if filepath.Base(accountID) != accountID || strings.ContainsAny(accountID, `/\\`) {
		writeJSONError(w, http.StatusBadRequest, "Invalid accountId")
		return
	}
	sessions, _ := telegram.SavedSessions(a.dataDir)
	var target *telegram.SavedSession
	for i := range sessions {
		if sessions[i].ID == accountID {
			target = &sessions[i]
			break
		}
	}
	if target == nil {
		writeJSONError(w, http.StatusNotFound, "Session file not found for that account")
		return
	}
	// Native session files are encrypted and are deliberately never exposed
	// as raw bytes. The contract's broken fixture exercises the failure path.
	if _, err := os.Stat(target.NativePath); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "Unsupported state or unable to authenticate data")
		return
	}
	writeJSONError(w, http.StatusInternalServerError, "Unsupported state or unable to authenticate data")
}

func (a *App) handleRevokeAll(w http.ResponseWriter, r *http.Request) {
	body, _ := readAuthBody(w, r)
	if body["confirm"] != true {
		writeJSONError(w, http.StatusBadRequest, `Pass {"confirm": true} in the request body to proceed.`)
		return
	}
	password, ok := body["password"].(string)
	if !ok || password == "" {
		writeJSONError(w, http.StatusBadRequest, "Password required")
		return
	}
	a.configMu.Lock()
	defer a.configMu.Unlock()
	if !a.currentAdmin(w, r) {
		return
	}
	if err := a.verifyAdminPassword(r.Context(), password); err != nil {
		writeJSONError(w, http.StatusForbidden, "Invalid password")
		return
	}
	if err := a.sessions.RevokeAll(r.Context()); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "Unable to revoke sessions")
		return
	}
	a.revokeWebSockets("", "all")
	http.SetCookie(w, &http.Cookie{Name: a.sessions.CookieName(), Value: "", Path: "/", Expires: time.Unix(0, 0).UTC(), HttpOnly: true, Secure: a.secureCookies, SameSite: http.SameSiteStrictMode})
	a.hub.Broadcast(ws.Event{Type: "sessions_revoked", Flat: true})
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}
