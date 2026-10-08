// Package app composes the production Go HTTP application.
package app

import (
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/auth"
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
	a := &App{db: db, sessions: auth.NewSessionStore(db.Writer, cookie, ttl), hub: ws.NewHub(64)}
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
func (a *App) Handler() http.Handler { return a.handler }
func (a *App) Close() error {
	if a == nil || a.db == nil {
		return nil
	}
	if a.db.Reader != nil {
		_ = a.db.Reader.Close()
	}
	return a.db.Writer.Close()
}
