// Package api is tgdl-core's HTTP surface on 127.0.0.1.
//
//	GET  /health             liveness + version + features (no token)
//	POST /v1/hash            {"path": "/abs/file"} -> {"sha256","size","mtimeMs"};
//	                         only files inside the allowed roots (403 EOUTSIDE otherwise)
//	POST /v1/fs/stat-batch   {"paths": [...]} -> fs.stat per path, Node's error codes
//	POST /v1/fs/walk         recursive fs.readdir (+ fs.stat), NDJSON stream
//	POST /v1/dbscan          face-embedding DBSCAN, NDJSON progress + result
//	POST /v1/zip             STORE-mode ZIP stream from allow-root files
//	GET  /v1/stats           counters (cheap token check for the parent)
//
// Every route except /health requires the X-API-Token header, unknown
// routes included, so an unauthenticated caller learns nothing beyond
// what /health says.
package api

import (
	"crypto/subtle"
	"log/slog"
	"net/http"
	"os"
	"runtime"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/dbscan"
	"github.com/botnick/telegram-media-downloader/core-service/internal/fsx"
	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
	"github.com/botnick/telegram-media-downloader/core-service/internal/version"
	"github.com/botnick/telegram-media-downloader/core-service/internal/zipstream"
)

// TokenHeader carries the shared secret (same header as the other sidecars).
const TokenHeader = "X-API-Token"

// maxQueuedHashes bounds requests waiting for a hash slot.
const maxQueuedHashes = 1024

// Server wires the routes.
type Server struct {
	token     []byte
	log       *slog.Logger
	roots     *hash.Roots
	limiter   *hash.Limiter
	stats     *hash.Stats
	fsStats   *fsx.Stats
	startedAt time.Time
}

// New builds a Server. hashConcurrency follows HASH_WORKER_POOL_SIZE;
// roots limits which files may be read (nil or empty refuses all).
func New(token string, hashConcurrency int, roots *hash.Roots, log *slog.Logger) *Server {
	return &Server{
		token:     []byte(token),
		log:       log,
		roots:     roots,
		limiter:   hash.NewLimiter(hashConcurrency, maxQueuedHashes),
		stats:     &hash.Stats{},
		fsStats:   &fsx.Stats{},
		startedAt: time.Now(),
	}
}

// Handler returns the root handler.
func (s *Server) Handler() http.Handler {
	private := http.NewServeMux()
	private.Handle("POST /v1/hash", &hash.Handler{Limiter: s.limiter, Stats: s.stats, Roots: s.roots, Log: s.log})
	private.Handle("POST /v1/fs/stat-batch", &fsx.StatBatchHandler{Roots: s.roots, Stats: s.fsStats, Log: s.log})
	private.Handle("POST /v1/fs/walk", &fsx.WalkHandler{Roots: s.roots, Stats: s.fsStats, Log: s.log})
	private.Handle("POST /v1/dbscan", &dbscan.Handler{Log: s.log})
	private.Handle("POST /v1/zip", &zipstream.Handler{Roots: s.roots, Log: s.log})
	private.HandleFunc("GET /v1/stats", s.handleStats)
	private.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		hash.WriteError(w, http.StatusNotFound, "ENOTFOUND", "no such route")
	})

	root := http.NewServeMux()
	root.HandleFunc("GET /health", s.handleHealth)
	root.Handle("/", s.requireToken(private))
	return recoverer(s.log, root)
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	hash.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"service":  version.Service,
		"version":  version.Version,
		"features": version.Features,
		"pid":      os.Getpid(),
		"go":       runtime.Version(),
		"platform": runtime.GOOS + "/" + runtime.GOARCH,
		"hash": map[string]any{
			"concurrency": s.limiter.Capacity(),
			"roots":       s.roots.Len(),
		},
		"fs": map[string]any{
			"maxBatch": fsx.MaxBatch,
			"fastStat": fsx.FastStatAvailable(),
		},
	})
}

func (s *Server) handleStats(w http.ResponseWriter, _ *http.Request) {
	hash.WriteJSON(w, http.StatusOK, map[string]any{
		"uptimeSec": int64(time.Since(s.startedAt).Seconds()),
		"hash": map[string]any{
			"concurrency": s.limiter.Capacity(),
			"inFlight":    s.limiter.InFlight(),
			"waiting":     s.limiter.Waiting(),
			"completed":   s.stats.Completed.Load(),
			"failed":      s.stats.Failed.Load(),
			"bytes":       s.stats.Bytes.Load(),
			"roots":       s.roots.List(),
		},
		"fs": map[string]any{
			"statCalls": s.fsStats.StatCalls.Load(),
			"statPaths": s.fsStats.StatPaths.Load(),
			"walks":     s.fsStats.Walks.Load(),
			"walkFiles": s.fsStats.WalkFiles.Load(),
		},
	})
}

func (s *Server) requireToken(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := []byte(r.Header.Get(TokenHeader))
		if len(s.token) == 0 || subtle.ConstantTimeCompare(got, s.token) != 1 {
			hash.WriteError(w, http.StatusUnauthorized, "EAUTH", "missing or wrong "+TokenHeader)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// recoverer turns a handler panic into a 500 instead of a dropped
// connection, and logs it.
func recoverer(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				if v == http.ErrAbortHandler {
					panic(v)
				}
				if log != nil {
					log.Error("handler panic", "path", r.URL.Path, "panic", v)
				}
				hash.WriteError(w, http.StatusInternalServerError, "EINTERNAL", "internal error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}
