// Package app composes the production Go HTTP application.
package app

import (
	"context"
	"crypto/sha1" // #nosec G505 -- HTTP cache validators, not authentication.
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/accounts"
	"github.com/botnick/telegram-media-downloader/core-service/internal/auth"
	"github.com/botnick/telegram-media-downloader/core-service/internal/backup"
	"github.com/botnick/telegram-media-downloader/core-service/internal/cluster"
	"github.com/botnick/telegram-media-downloader/core-service/internal/dbread"
	"github.com/botnick/telegram-media-downloader/core-service/internal/download"
	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/jobs"
	"github.com/botnick/telegram-media-downloader/core-service/internal/store"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
	"github.com/gorilla/websocket"
)

type Config struct {
	AccountFactory      engine.Factory
	AccountLoginFactory telegram.LoginFactory
	DataDir             string
	Port                int
	Static              fs.FS
	CookieName          string
	SessionTTL          time.Duration
	SecureCookies       bool
	Output              io.Writer
}
type App struct {
	monitor          *engine.Controller
	accounts         *accounts.Repository
	accountWizard    *accounts.Wizard
	monitorOp        sync.Mutex
	historyMu        sync.Mutex
	historyJobs      map[string]*historyJob
	historyCancel    map[string]context.CancelFunc
	historyDrain     bool
	ctx              context.Context
	cancel           context.CancelFunc
	bootWG           sync.WaitGroup
	releaseOwnership func()
	closeOnce        sync.Once
	closeErr         error

	backups             *backup.Manager
	db                  *store.DB
	library             *download.Library
	sessions            *auth.SessionStore
	hub                 *ws.Hub
	read                *dbread.Handler
	config              auth.ConfigStore
	jobs                *jobs.Tracker
	dataDir             string
	pairing             *cluster.PairingStore
	loginRL             *rateLimiter
	handler             http.Handler
	configMu            sync.Mutex
	dedupMu             sync.Mutex
	dedupWG             sync.WaitGroup
	dedupClosed         bool
	mediaMu             sync.RWMutex
	purgeMu             sync.Mutex
	purgeEpoch          uint64 // guarded by purgeMu; invalidates unresolved URL requests
	purgeWG             sync.WaitGroup
	purgeClosed         bool
	purgeResume         bool
	recoveryWriting     bool
	recoveryMu          sync.Mutex
	recoveryStatus      map[string]any
	purges              map[string]purgeRecord
	maintenanceJobMu    sync.Mutex
	maintenanceJobWG    sync.WaitGroup
	maintenanceClosed   bool
	dedupLastScan       map[string]any
	dedupScanStatus     map[string]any
	dedupDeleteStatus   map[string]any
	faststartMu         sync.Mutex
	faststartStatus     map[string]any
	faststartLastRun    map[string]any
	thumbMu             sync.Mutex
	thumbBuildStatus    map[string]any
	thumbBuildLastRun   map[string]any
	thumbRebuildStatus  map[string]any
	thumbBuildCancel    context.CancelFunc
	maintenanceMu       sync.Mutex
	telegramMaintenance map[string]map[string]any
	storiesOp           sync.Mutex
	dbIntegrityStatus   map[string]any
	filesVerifyStatus   map[string]any
	filesVerifyLastRun  map[string]any
	reindexStatus       map[string]any
	reindexLastRun      map[string]any
	vacuumStatus        map[string]any
	setupRL             *rateLimiter
	secureCookies       bool
	output              io.Writer
	resetMu             sync.Mutex
	resetTokens         map[string]time.Time
	chatRecheckMu       sync.Mutex
	chatRecheck         chatRecheckState
	chatRecheckWG       sync.WaitGroup
	chatRecheckClosed   bool
	groupRefreshMu      sync.Mutex
	groupRefreshInfo    groupRefreshState
	groupRefreshPhotos  groupRefreshState
	groupRefreshWG      sync.WaitGroup
	groupRefreshClosed  bool
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
	release, err := engine.AcquireServerOwnership(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	db, err := store.Open(ctx, cfg.DataDir)
	if err != nil {
		release()
		return nil, err
	}
	cookie := cfg.CookieName
	if cookie == "" {
		cookie = "tg_dl_session"
	}
	ttl := cfg.SessionTTL
	if ttl <= 0 {
		ttl = 7 * 24 * time.Hour
	}
	read := dbread.NewHandler(filepath.Join(cfg.DataDir, "db.sqlite"), nil)
	a := &App{db: db, sessions: auth.NewSessionStore(db.Writer, cookie, ttl), hub: ws.NewHub(64), read: read, config: auth.ConfigStore{DB: db.Writer}, jobs: jobs.NewTracker(), dataDir: cfg.DataDir, pairing: cluster.NewPairingStore(10 * time.Minute), loginRL: newRateLimiter(10, 15*time.Minute), setupRL: newRateLimiter(20, 15*time.Minute), secureCookies: cfg.SecureCookies, output: cfg.Output, resetTokens: make(map[string]time.Time), dedupLastScan: map[string]any{}, dedupScanStatus: dedupIdleStatus("dedupScan"), dedupDeleteStatus: dedupIdleStatus("dedupDelete"), faststartStatus: faststartIdleStatus(), faststartLastRun: map[string]any{}, thumbBuildStatus: thumbsIdleStatus("thumbsBuild"), thumbRebuildStatus: thumbsIdleStatus("thumbsRebuild"), dbIntegrityStatus: maintenanceIdleStatus("dbIntegrity"), filesVerifyStatus: maintenanceIdleStatus("filesVerify"), reindexStatus: maintenanceIdleStatus("reindex"), vacuumStatus: maintenanceIdleStatus("dbVacuum")}
	a.ctx, a.cancel = context.WithCancel(ctx)
	a.releaseOwnership = release
	a.accounts = accounts.NewRepository(db.Writer, db.Reader, cfg.DataDir, &a.configMu)
	if err = a.accounts.Recover(ctx); err != nil {
		a.Close()
		return nil, err
	}
	a.accountWizard = accounts.NewWizard(a.ctx, accounts.WizardConfig{DataDir: cfg.DataDir, Factory: cfg.AccountLoginFactory, Publish: a.publishAccount})
	a.library, err = download.NewLibrary(db.Writer, db.Reader, filepath.Join(cfg.DataDir, "downloads"), 64)
	if err != nil {
		a.Close()
		return nil, err
	}
	if err = a.library.Recover(ctx); err != nil {
		a.Close()
		return nil, fmt.Errorf("recover media ingestion: %w", err)
	}
	if err := a.drainFileCleanup(ctx); err != nil && cfg.Output != nil {
		fmt.Fprintf(cfg.Output, "Media cleanup remains pending: %v\n", err)
	}
	a.monitor = engine.New(db.Writer, db.Reader, cfg.DataDir, cfg.AccountFactory, a.monitorFilter, a.ingestWork, a.monitorEvent)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "service": "tgdl-server"})
	})
	mux.HandleFunc("GET /api/auth_check", a.handleAuthCheck)
	mux.Handle("POST /api/login", a.loginRL.middleware(http.HandlerFunc(a.handleLogin)))
	mux.HandleFunc("POST /api/logout", a.handleLogout)
	mux.Handle("POST /api/auth/setup", a.setupRL.middleware(http.HandlerFunc(a.handleSetup)))
	mux.Handle("POST /api/auth/change-password", a.loginRL.middleware(a.requireAdmin(http.HandlerFunc(a.handleChangePassword))))
	mux.Handle("POST /api/auth/guest-password", a.requireAdmin(http.HandlerFunc(a.handleGuestPassword)))
	mux.Handle("POST /api/auth/reset/request", a.loginRL.middleware(http.HandlerFunc(a.handleResetRequest)))
	mux.Handle("POST /api/auth/reset/confirm", a.loginRL.middleware(http.HandlerFunc(a.handleResetConfirm)))
	mux.Handle("POST /api/downloads/pin", a.requireAdmin(http.HandlerFunc(a.handleBatchPin)))
	mux.Handle("POST /api/downloads/{id}/pin", a.requireAdmin(http.HandlerFunc(a.handlePin)))
	mux.Handle("GET /api/jobs", a.requireSession(http.HandlerFunc(a.handleJobs)))
	mux.Handle("GET /api/jobs/{id}", a.requireSession(http.HandlerFunc(a.handleJob)))
	mux.Handle("POST /api/jobs/{id}/cancel", a.requireAdmin(http.HandlerFunc(a.handleJobCancel)))
	mux.Handle("POST /api/maintenance/db/backup", a.requireAdmin(http.HandlerFunc(a.handleBackup)))
	mux.Handle("POST /api/cluster/pairing-code", a.requireAdmin(http.HandlerFunc(a.handlePairingCode)))
	registerMonitorRoutes(mux, a)
	registerMonitorMaintenance(mux, a)
	registerHistoryRoutes(mux, a)
	registerURLRoutes(mux, a)
	registerStoryRoutes(mux, a)
	mux.Handle("POST /api/proxy/test", a.requireAdmin(http.HandlerFunc(a.handleProxyProbe)))
	registerQueueRoutes(mux, a)
	registerAccountRoutes(mux, a)
	registerDialogRoutes(mux, a)
	registerChatAccessRoutes(mux, a)
	registerGroupRefreshRoutes(mux, a)
	registerGalleryRoutes(mux, a)
	registerAIRoutes(mux, a)
	registerDedupRoutes(mux, a)
	registerFaststartRoutes(mux, a)
	registerThumbRoutes(mux, a)
	registerMaintenanceRoutes(mux, a)
	registerSystemRoutes(mux, a)
	registerPurgeRoutes(mux, a)
	registerRecoveryRoutes(mux, a)
	registerConfigWriteRoutes(mux, a)
	registerMediaRoutes(mux, a)
	registerArchiveRoutes(mux, a)
	registerBackupRoutes(mux, a)
	registerShareRoutes(mux, a)
	registerReadRoutes(mux, read, a.requireSession)
	mux.HandleFunc("GET /ws", a.handleWebSocket)
	mux.Handle("/", newStaticHandler(cfg.Static))
	registerPublicAPIRoutes(mux, a)

	a.handler = securityHeaders(a.gateway(mux))
	if err := a.recoverPurges(ctx); err != nil {
		a.Close()
		return nil, fmt.Errorf("recover purge jobs: %w", err)
	}
	if err := a.recoverHistoryJobs(ctx); err != nil {
		a.Close()
		return nil, fmt.Errorf("recover history jobs: %w", err)
	}
	stored, err := a.config.Load(ctx)
	if err != nil {
		a.Close()
		return nil, err
	}
	a.backups, err = backup.NewManager(a.ctx, backup.Options{
		Writer: db.Writer, Reader: db.Reader, DataDir: a.dataDir, Secret: a.shareSecret,
		Publish: func(kind string, payload map[string]any) {
			a.hub.Broadcast(ws.Event{Type: kind, Flat: true, Payload: payload, Roles: []string{"admin"}})
		},
		LockSnapshot: func() func() { a.configMu.Lock(); return a.configMu.Unlock },
	})
	if err != nil {
		a.Close()
		return nil, fmt.Errorf("initialize native backups: %w", err)
	}
	if monitor, ok := stored["monitor"].(map[string]any); ok && monitor["autoStart"] == true {
		a.bootWG.Add(1)
		go func() {
			defer a.bootWG.Done()
			a.monitorOp.Lock()
			defer a.monitorOp.Unlock()
			if err := a.startMonitor(a.ctx); err != nil && a.ctx.Err() == nil && a.output != nil {
				fmt.Fprintf(a.output, "Monitor auto-start failed: %v\n", err)
			}
		}()
	}
	return a, nil
}

func securityHeaders(next http.Handler) http.Handler {
	const csp = "default-src 'self';base-uri 'self';font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net;form-action 'self';frame-ancestors 'self';img-src 'self' data: blob:;object-src 'none';script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com;script-src-attr 'unsafe-inline';style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://fonts.googleapis.com;style-src-attr 'unsafe-inline';media-src 'self' blob:;connect-src 'self' ws: wss:;frame-src 'self'"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", csp)
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		w.Header().Set("Origin-Agent-Cluster", "?1")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Strict-Transport-Security", "max-age=0")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-DNS-Prefetch-Control", "off")
		w.Header().Set("X-Download-Options", "noopen")
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		w.Header().Set("X-Permitted-Cross-Domain-Policies", "none")
		w.Header().Set("X-XSS-Protection", "0")
		next.ServeHTTP(w, r)
	})
}

func webBoolValue(web map[string]any, key string, fallback bool) bool {
	if web == nil {
		return fallback
	}
	value, ok := web[key].(bool)
	if !ok {
		return fallback
	}
	return value
}

func ensureMap(root map[string]any, key string) map[string]any {
	if value, ok := root[key].(map[string]any); ok {
		return value
	}
	value := map[string]any{}
	root[key] = value
	return value
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
	// Subscribe before the 101 response becomes observable. The browser can
	// issue a mutation as soon as its handshake completes, even while Upgrade
	// is still returning on this goroutine.
	client := a.hub.Add(sess.Role)
	defer a.hub.Remove(client)
	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer func() {
		_ = conn.Close()
	}()
	conn.SetReadLimit(1 << 20)
	_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	})
	heartbeat := time.NewTicker(30 * time.Second)
	defer heartbeat.Stop()
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
		case <-heartbeat.C:
			if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second)); err != nil {
				return
			}
		case event, ok := <-client.Events():
			if !ok {
				return
			}
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteJSON(event); err != nil {
				return
			}
		}
	}
}

func (a *App) handlePin(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeJSONError(w, http.StatusBadRequest, "Invalid id")
		return
	}
	body, ok := readAuthBody(w, r)
	if !ok {
		return
	}
	pinned, valid := body["pinned"].(bool)
	if !valid {
		writeJSONError(w, http.StatusBadRequest, "Body must include `pinned` (boolean)")
		return
	}
	result, err := a.db.Writer.ExecContext(r.Context(), `UPDATE downloads SET pinned = ? WHERE id = ?`, boolInt(pinned), id)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "Update failed")
		return
	}
	if count, _ := result.RowsAffected(); count == 0 {
		writeJSONError(w, http.StatusNotFound, "Not found")
		return
	}
	a.hub.Broadcast(ws.Event{Type: "download_pinned", Flat: true, Payload: map[string]any{"id": id, "pinned": pinned}})
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "id": id, "pinned": pinned})
}

func (a *App) handleBatchPin(w http.ResponseWriter, r *http.Request) {
	body, ok := readAuthBody(w, r)
	if !ok {
		return
	}
	pinned, valid := body["pinned"].(bool)
	if !valid {
		writeJSONError(w, http.StatusBadRequest, "Body must include `pinned` (boolean)")
		return
	}
	rawIDs, valid := body["ids"].([]any)
	if !valid || len(rawIDs) == 0 {
		writeJSONError(w, http.StatusBadRequest, "`ids` must be a non-empty array")
		return
	}
	if len(rawIDs) > 5000 {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "Too many ids in one request (max 5000)", "max": 5000})
		return
	}
	ids := make([]int64, 0, len(rawIDs))
	seen := map[int64]bool{}
	for _, raw := range rawIDs {
		var id int64
		switch value := raw.(type) {
		case float64:
			id = int64(value)
		case string:
			id, _ = strconv.ParseInt(strings.TrimSpace(value), 10, 64)
		}
		if id > 0 && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	tx, err := a.db.Writer.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "Update failed")
		return
	}
	updated := make([]int64, 0, len(ids))
	for _, id := range ids {
		if id <= 0 {
			continue
		}
		result, err := tx.ExecContext(r.Context(), `UPDATE downloads SET pinned = ? WHERE id = ?`, boolInt(pinned), id)
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
	if len(updated) > 0 {
		a.hub.Broadcast(ws.Event{Type: "downloads_pinned", Flat: true, Payload: map[string]any{"ids": updated, "pinned": pinned}})
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "pinned": pinned, "ids": updated, "updated": len(updated)})
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
	body, err := json.Marshal(value)
	if err != nil {
		status = http.StatusInternalServerError
		body = []byte(`{"error":"Internal error"}`)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	sum := sha1.Sum(body) // #nosec G401 -- HTTP ETag wire compatibility.
	w.Header().Set("ETag", `W/"`+strconv.FormatInt(int64(len(body)), 16)+`-`+base64.RawStdEncoding.EncodeToString(sum[:])+`"`)
	w.WriteHeader(status)
	_, _ = w.Write(body)
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

func (a *App) Handler() http.Handler { return a.handler }
func (a *App) Close() error {
	if a == nil {
		return nil
	}
	a.closeOnce.Do(func() {
		a.maintenanceJobMu.Lock()
		a.maintenanceClosed = true
		a.maintenanceJobMu.Unlock()
		a.purgeMu.Lock()
		a.purgeClosed = true
		a.purgeMu.Unlock()
		a.dedupMu.Lock()
		a.dedupClosed = true
		a.dedupMu.Unlock()
		a.chatRecheckMu.Lock()
		a.chatRecheckClosed = true
		a.chatRecheckMu.Unlock()
		a.groupRefreshMu.Lock()
		a.groupRefreshClosed = true
		a.groupRefreshMu.Unlock()
		if a.cancel != nil {
			a.cancel()
		}
		if a.backups != nil {
			a.backups.Close()
		}
		a.chatRecheckWG.Wait()
		a.groupRefreshWG.Wait()
		a.bootWG.Wait()
		a.dedupWG.Wait()
		a.purgeWG.Wait()
		a.maintenanceJobWG.Wait()
		if a.accountWizard != nil {
			a.closeErr = errors.Join(a.closeErr, a.accountWizard.Close())
		}
		a.monitorOp.Lock()
		defer a.monitorOp.Unlock()
		if a.monitor != nil {
			a.closeErr = a.monitor.Stop(context.Background())
		}
		if a.hub != nil {
			a.hub.Close()
		}
		if a.read != nil {
			a.read.Close()
		}
		if a.db != nil {
			if a.db.Reader != nil {
				a.db.Reader.Close()
			}
			a.closeErr = errors.Join(a.closeErr, a.db.Writer.Close())
		}
		if a.releaseOwnership != nil {
			a.releaseOwnership()
		}
	})
	return a.closeErr
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
