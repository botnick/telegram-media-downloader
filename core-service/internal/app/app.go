// Package app composes the production Go HTTP application.
package app

import (
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/url"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/auth"
	"github.com/botnick/telegram-media-downloader/core-service/internal/dbread"
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
	a := &App{db: db, sessions: auth.NewSessionStore(db.Writer, cookie, ttl), hub: ws.NewHub(64), read: read}
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
		if _, err := a.sessions.Validate(r.Context(), cookie.Value); err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
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
