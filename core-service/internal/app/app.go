// Package app composes the production Go HTTP application.
package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/auth"
	"github.com/botnick/telegram-media-downloader/core-service/internal/backup"
	"github.com/botnick/telegram-media-downloader/core-service/internal/cluster"
	"github.com/botnick/telegram-media-downloader/core-service/internal/dbread"
	"github.com/botnick/telegram-media-downloader/core-service/internal/jobs"
	"github.com/botnick/telegram-media-downloader/core-service/internal/store"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
	"github.com/gorilla/websocket"
)

type Config struct {
	DataDir    string
	Port       int
	Static     fs.FS
	CookieName string
	SessionTTL time.Duration
}
type App struct {
	db       *store.DB
	sessions *auth.SessionStore
	hub      *ws.Hub
	read     *dbread.Handler
	config   auth.ConfigStore
	jobs     *jobs.Tracker
	dataDir  string
	pairing  *cluster.PairingStore
	handler  http.Handler
}

var wsUpgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true
		}
		u, err := url.Parse(origin)
		return err == nil && u.Host == r.Host
	},
}

func New(ctx context.Context, cfg Config) (*App, error) {
	db, err := store.Open(ctx, cfg.DataDir)
	if err != nil {
		return nil, err
	}
	cookie := cfg.CookieName
	if cookie == "" {
		cookie = "tg_dl_session"
	}
	ttl := cfg.SessionTTL
	if ttl <= 0 {
		ttl = 30 * 24 * time.Hour
	}
	read := dbread.NewHandler(filepath.Join(cfg.DataDir, "db.sqlite"), nil)
	a := &App{db: db, sessions: auth.NewSessionStore(db.Writer, cookie, ttl), hub: ws.NewHub(64), read: read, config: auth.ConfigStore{DB: db.Writer}, jobs: jobs.NewTracker(), dataDir: cfg.DataDir, pairing: cluster.NewPairingStore(10 * time.Minute)}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "service": "tgdl-server"})
	})
	mux.HandleFunc("GET /api/auth_check", func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(cookie)
		if err != nil {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]any{"authenticated": false})
			return
		}
		s, err := a.sessions.Validate(r.Context(), c.Value)
		if err != nil {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]any{"authenticated": false})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"authenticated": true, "role": s.Role})
	})
	mux.HandleFunc("POST /api/login", a.handleLogin)
	mux.HandleFunc("POST /api/logout", a.handleLogout)
	mux.HandleFunc("POST /api/auth/setup", a.handleSetup)
	mux.Handle("POST /api/downloads/pin", a.requireAdmin(http.HandlerFunc(a.handleBatchPin)))
	mux.Handle("POST /api/downloads/{id}/pin", a.requireAdmin(http.HandlerFunc(a.handlePin)))
	mux.Handle("GET /api/jobs", a.requireSession(http.HandlerFunc(a.handleJobs)))
	mux.Handle("GET /api/jobs/{id}", a.requireSession(http.HandlerFunc(a.handleJob)))
	mux.Handle("POST /api/jobs/{id}/cancel", a.requireAdmin(http.HandlerFunc(a.handleJobCancel)))
	mux.Handle("POST /api/maintenance/db/backup", a.requireAdmin(http.HandlerFunc(a.handleBackup)))
	mux.Handle("POST /api/cluster/pairing-code", a.requireAdmin(http.HandlerFunc(a.handlePairingCode)))
	registerReadRoutes(mux, read, a.requireSession)
	mux.HandleFunc("GET /ws", a.handleWebSocket)
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if cfg.Static == nil {
			http.NotFound(w, r)
			return
		}
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name == "." || name == "" {
			name = "index.html"
		}
		data, err := fs.ReadFile(cfg.Static, name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		http.ServeContent(w, r, name, time.Time{}, strings.NewReader(string(data)))
	})
	a.handler = mux
	return a, nil
}

func (a *App) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(a.sessions.CookieName())
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	sess, err := a.sessions.Validate(r.Context(), cookie.Value)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	client := a.hub.Add(sess.Role)
	defer func() {
		a.hub.Remove(client)
		_ = conn.Close()
	}()
	conn.SetReadLimit(1 << 20)
	_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	})
	if err := conn.WriteJSON(map[string]any{"type": "ws_ready", "role": sess.Role}); err != nil {
		return
	}
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()
	for {
		select {
		case <-readDone:
			return
		case event, ok := <-client.Events():
			if !ok {
				return
			}
			if err := conn.WriteJSON(event); err != nil {
				return
			}
		}
	}
}

func (a *App) requireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(a.sessions.CookieName())
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		session, err := a.sessions.Validate(r.Context(), cookie.Value)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r.WithContext(auth.WithSession(r.Context(), session)))
	})
}

func (a *App) requireAdmin(next http.Handler) http.Handler {
	return a.requireSession(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		session, _ := auth.SessionFromContext(r.Context())
		if session.Role != "admin" {
			http.Error(w, "admin required", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	}))
}

func (a *App) handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
	}
	if err := decodeBody(w, r, &body); err != nil || body.Password == "" {
		if err == nil {
			writeJSONError(w, http.StatusBadRequest, "Password required")
		}
		return
	}
	role, configured, err := a.config.Login(r.Context(), body.Password)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "Internal error")
		return
	}
	if !configured {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "Web dashboard not initialised", "setupRequired": true})
		return
	}
	if role == "" {
		writeJSONError(w, http.StatusUnauthorized, "Invalid password")
		return
	}
	if !a.issueSession(w, r, role) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "role": role})
}

func (a *App) handleSetup(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
	}
	if err := decodeBody(w, r, &body); err != nil || len(body.Password) < 8 {
		if err == nil {
			writeJSONError(w, http.StatusBadRequest, "Password must be at least 8 characters")
		}
		return
	}
	if !isLocalRequest(r) {
		writeJSONError(w, http.StatusForbidden, "Initial setup must be done from the local machine")
		return
	}
	_, configured, err := a.config.Login(r.Context(), "")
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "Internal error")
		return
	}
	if configured {
		writeJSONError(w, http.StatusConflict, "Already configured")
		return
	}
	if err := a.config.SetAdminPassword(r.Context(), body.Password); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "Internal error")
		return
	}
	if !a.issueSession(w, r, "admin") {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (a *App) handleLogout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(a.sessions.CookieName()); err == nil {
		_ = a.sessions.Revoke(r.Context(), cookie.Value)
	}
	http.SetCookie(w, &http.Cookie{Name: a.sessions.CookieName(), Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode})
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (a *App) issueSession(w http.ResponseWriter, r *http.Request, role string) bool {
	token, err := a.sessions.Create(r.Context(), role)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "Internal error")
		return false
	}
	http.SetCookie(w, &http.Cookie{Name: a.sessions.CookieName(), Value: token, Path: "/", MaxAge: int((30 * 24 * time.Hour) / time.Second), HttpOnly: true, SameSite: http.SameSiteStrictMode})
	return true
}

func (a *App) handlePin(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeJSONError(w, http.StatusBadRequest, "Invalid id")
		return
	}
	var body struct {
		Pinned *bool `json:"pinned"`
	}
	if err := decodeBody(w, r, &body); err != nil || body.Pinned == nil {
		if err == nil {
			writeJSONError(w, http.StatusBadRequest, "Body must include `pinned` (boolean)")
		}
		return
	}
	result, err := a.db.Writer.ExecContext(r.Context(), `UPDATE downloads SET pinned = ? WHERE id = ?`, boolInt(*body.Pinned), id)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "Update failed")
		return
	}
	if count, _ := result.RowsAffected(); count == 0 {
		writeJSONError(w, http.StatusNotFound, "Not found")
		return
	}
	a.hub.Broadcast(ws.Event{Type: "download_pinned", Payload: map[string]any{"id": id, "pinned": *body.Pinned}})
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "id": id, "pinned": *body.Pinned})
}

func (a *App) handleBatchPin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IDs    []int64 `json:"ids"`
		Pinned *bool   `json:"pinned"`
	}
	if err := decodeBody(w, r, &body); err != nil || body.Pinned == nil || len(body.IDs) == 0 {
		if err == nil {
			writeJSONError(w, http.StatusBadRequest, "ids and pinned are required")
		}
		return
	}
	if len(body.IDs) > 5000 {
		writeJSONError(w, http.StatusRequestEntityTooLarge, "Too many ids in one request")
		return
	}
	tx, err := a.db.Writer.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "Update failed")
		return
	}
	updated := make([]int64, 0, len(body.IDs))
	for _, id := range body.IDs {
		if id <= 0 {
			continue
		}
		result, err := tx.ExecContext(r.Context(), `UPDATE downloads SET pinned = ? WHERE id = ?`, boolInt(*body.Pinned), id)
		if err != nil {
			_ = tx.Rollback()
			writeJSONError(w, http.StatusInternalServerError, "Update failed")
			return
		}
		if count, _ := result.RowsAffected(); count > 0 {
			updated = append(updated, id)
		}
	}
	if err := tx.Commit(); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "Update failed")
		return
	}
	a.hub.Broadcast(ws.Event{Type: "downloads_pinned", Payload: map[string]any{"ids": updated, "pinned": *body.Pinned}})
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "pinned": *body.Pinned, "ids": updated, "updated": len(updated)})
}

func (a *App) handleJobs(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"jobs": a.jobs.List()})
}

func (a *App) handleJob(w http.ResponseWriter, r *http.Request) {
	snapshot, ok := a.jobs.Get(r.PathValue("id"))
	if !ok {
		writeJSONError(w, http.StatusNotFound, "Job not found")
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (a *App) handleJobCancel(w http.ResponseWriter, r *http.Request) {
	if err := a.jobs.Cancel(r.PathValue("id")); err != nil {
		if errors.Is(err, jobs.ErrNotFound) {
			writeJSONError(w, http.StatusNotFound, "Job not found")
			return
		}
		writeJSONError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "cancelled": true})
}

func (a *App) handleBackup(w http.ResponseWriter, r *http.Request) {
	result, err := backup.Snapshot(r.Context(), a.db.Writer, filepath.Join(a.dataDir, "backups"), "manual")
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "backup": result})
}

func (a *App) handlePairingCode(w http.ResponseWriter, _ *http.Request) {
	code, err := a.pairing.Issue("local")
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"code": code, "expiresInSec": 600})
}

func decodeBody(w http.ResponseWriter, r *http.Request, dst any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	err := decoder.Decode(dst)
	if err != nil {
		if !errors.Is(err, io.EOF) {
			writeJSONError(w, http.StatusBadRequest, "Invalid JSON body")
		} else {
			writeJSONError(w, http.StatusBadRequest, "Request body is required")
		}
	}
	return err
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeJSONError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"error": message})
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func isLocalRequest(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	return ip == nil || ip.IsLoopback()
}

func (a *App) Handler() http.Handler { return a.handler }
func (a *App) Close() error {
	if a == nil || a.db == nil {
		return nil
	}
	if a.db.Reader != nil {
		_ = a.db.Reader.Close()
	}
	if a.read != nil {
		a.read.Close()
	}
	return a.db.Writer.Close()
}

func registerReadRoutes(mux *http.ServeMux, read *dbread.Handler, guard func(http.Handler) http.Handler) {
	handle := func(pattern string, fn http.Handler) { mux.Handle(pattern, guard(fn)) }
	handle("POST /v1/db/group-aggregates", read)
	handle("POST /v1/db/stats", http.HandlerFunc(read.Stats))
	handle("POST /v1/db/group-stats", http.HandlerFunc(read.GroupStats))
	handle("POST /v1/db/group-files", http.HandlerFunc(read.GroupFiles))
	handle("POST /v1/db/group-download-ids", http.HandlerFunc(read.GroupDownloadIDs))
	handle("POST /v1/db/downloads/all", http.HandlerFunc(read.AllDownloads))
	handle("POST /v1/db/downloads/group", http.HandlerFunc(read.DownloadsGroup))
	handle("POST /v1/db/downloads/by-ids", http.HandlerFunc(read.DownloadsByIDs))
	handle("POST /v1/db/downloads/search", http.HandlerFunc(read.Search))
	handle("POST /v1/db/share-links", http.HandlerFunc(read.ShareLinks))
	handle("POST /v1/db/update-history", http.HandlerFunc(read.UpdateHistory))
	handle("POST /v1/db/nsfw-tiers", http.HandlerFunc(read.NsfwTiers))
	handle("POST /v1/db/nsfw-histogram", http.HandlerFunc(read.NsfwHistogram))
	handle("POST /v1/db/nsfw-list", http.HandlerFunc(read.NsfwList))
	handle("POST /v1/db/nsfw-candidates", http.HandlerFunc(read.NsfwCandidates))
	handle("POST /v1/db/people", http.HandlerFunc(read.People))
	handle("POST /v1/db/thumbs-list", http.HandlerFunc(read.ThumbsList))
	handle("POST /v1/db/seekbar-list", http.HandlerFunc(read.SeekbarList))
	handle("POST /v1/db/faces-by-download", http.HandlerFunc(read.FacesByDownload))
	handle("POST /v1/db/person-groups", http.HandlerFunc(read.PersonGroups))
	handle("POST /v1/db/person-photos", http.HandlerFunc(read.PersonPhotos))
	handle("POST /v1/db/face-embeddings", http.HandlerFunc(read.FaceEmbeddings))
	handle("POST /v1/db/ai-counts", http.HandlerFunc(read.AICounts))
	handle("POST /v1/db/ai-candidates", http.HandlerFunc(read.AICandidates))
	handle("POST /v1/db/ai-pending", http.HandlerFunc(read.AIPending))
	handle("POST /v1/db/quality-candidates", http.HandlerFunc(read.QualityCandidates))
	handle("POST /v1/db/recovery-stats", http.HandlerFunc(read.RecoveryStats))
	handle("POST /v1/db/cluster-downloads", http.HandlerFunc(read.ClusterDownloads))
	handle("POST /v1/db/cluster-downloads-since", http.HandlerFunc(read.ClusterDownloadsSince))
	handle("POST /v1/db/cluster-search", http.HandlerFunc(read.ClusterSearch))
	handle("POST /v1/db/telegram-media-candidates", http.HandlerFunc(read.TelegramMediaCandidates))
	handle("POST /v1/db/file-hash-candidates", http.HandlerFunc(read.FileHashCandidates))
	handle("POST /v1/db/file-name-candidates", http.HandlerFunc(read.FileNameCandidates))
	handle("POST /v1/db/dedup-stats", http.HandlerFunc(read.DedupStats))
	handle("POST /v1/db/seekbar-stats", http.HandlerFunc(read.SeekbarStats))
	handle("POST /v1/db/seekbar-candidates", http.HandlerFunc(read.SeekbarCandidates))
	handle("POST /v1/db/faststart-candidates", http.HandlerFunc(read.FaststartCandidates))
	handle("POST /v1/db/faststart-stats", http.HandlerFunc(read.FaststartStats))
	handle("POST /v1/db/disk-rotator-candidates", http.HandlerFunc(read.DiskRotatorCandidates))
	handle("POST /v1/db/integrity-candidates", http.HandlerFunc(read.IntegrityCandidates))
	handle("POST /v1/db/integrity-check", http.HandlerFunc(read.IntegrityCheck))
	handle("POST /v1/db/dedup-candidates", http.HandlerFunc(read.DedupCandidates))
	handle("POST /v1/db/dedup-groups", http.HandlerFunc(read.DedupGroups))
	handle("POST /v1/db/dedup-files", http.HandlerFunc(read.DedupFiles))
}
