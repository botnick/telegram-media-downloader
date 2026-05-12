// Package api exposes the seekbar service over HTTP.
//
// Endpoints (admin / authenticated callers):
//   POST   /v1/sprite            — submit a single video (sync or async)
//   POST   /v1/batch             — submit many at once
//   GET    /v1/jobs/:id          — job status
//   GET    /v1/jobs              — list recent jobs
//   POST   /v1/jobs/:id/cancel   — request cancel (best-effort)
//   GET    /v1/config            — current effective config (for parent health checks)
//   GET    /sprite/:video_id     — serve the WebP/JPEG sprite bytes
//   GET    /meta/:video_id       — serve the JSON sidecar
//   DELETE /v1/sprite/:video_id  — remove sprite + meta from disk
//   GET    /health               — liveness probe (always open)
//   GET    /v1/hwaccel           — probe what backends work on this host
//   GET    /v1/stats             — pool counters
//
// The token (if HTTP.APIToken is set) is checked once via middleware so
// every mutating route is gated. /health is always open so a Docker
// healthcheck never needs credentials.
package api

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"

	"github.com/botnick/telegram-media-downloader/seekbar-service/internal/config"
	"github.com/botnick/telegram-media-downloader/seekbar-service/internal/ffmpeg"
	"github.com/botnick/telegram-media-downloader/seekbar-service/internal/logx"
	"github.com/botnick/telegram-media-downloader/seekbar-service/internal/worker"
)

const ServiceVersion = "0.3.0"

type Server struct {
	cfg  *config.Config
	log  *logx.Logger
	pool *worker.Pool

	mu      sync.RWMutex
	jobs    map[string]*worker.Job
	jobList []string

	// resolved at Start() — cached so /health is instant
	hwaccelResolved string
	ffmpegVersion   string
	startedAt       time.Time
}

func New(cfg *config.Config, log *logx.Logger, pool *worker.Pool) *Server {
	return &Server{
		cfg:       cfg,
		log:       log,
		pool:      pool,
		jobs:      make(map[string]*worker.Job),
		startedAt: time.Now(),
	}
}

// Init resolves hwaccel + ffmpeg version in the background so /health
// answers quickly. Pass the already-resolved backend from pool.Start so
// we don't probe twice; resolvedHWAccel == "" causes an independent probe.
func (s *Server) Init(resolvedHWAccel string) {
	go func() {
		// If the pool already resolved hwaccel, store it immediately
		// without another probe.
		if resolvedHWAccel != "" {
			s.mu.Lock()
			s.hwaccelResolved = resolvedHWAccel
			s.mu.Unlock()
		} else {
			// Independent probe with a 20-second cap so startup never
			// hangs on a misconfigured host.
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			b, err := ffmpeg.Resolve(ctx, s.cfg.FFmpeg.Path, s.cfg.FFmpeg.HWAccel, s.cfg.FFmpeg.VAAPIDevice)
			if err == nil {
				s.mu.Lock()
				s.hwaccelResolved = string(b)
				s.mu.Unlock()
			}
		}
		// ffmpeg version — always probe independently.
		if v := ffmpegVersionString(s.cfg.FFmpeg.Path); v != "" {
			s.mu.Lock()
			s.ffmpegVersion = v
			s.mu.Unlock()
		}
	}()
}

// ffmpegVersionString extracts the version token from `ffmpeg -version`.
func ffmpegVersionString(bin string) string {
	if bin == "" {
		bin = "ffmpeg"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "-version").Output()
	if err != nil {
		return ""
	}
	line := strings.SplitN(string(out), "\n", 2)[0]
	// "ffmpeg version N.N.N Copyright ..." — trim to just the version token.
	fields := strings.Fields(line)
	if len(fields) >= 3 {
		return fields[2]
	}
	return strings.TrimSpace(line)
}

// Routes returns the chi mux with every endpoint wired.
func (s *Server) Routes() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)
	r.Use(middleware.RequestID)
	r.Use(s.logRequests)

	// Always-open endpoints — no token required.
	r.Get("/health", s.handleHealth)
	r.Get("/sprite/{videoID}", s.handleSprite)
	r.Get("/meta/{videoID}", s.handleMeta)

	r.Route("/v1", func(r chi.Router) {
		r.Use(s.requireToken)
		r.Post("/sprite", s.handleSubmitOne)
		r.Post("/batch", s.handleSubmitBatch)
		r.Get("/jobs", s.handleListJobs)
		r.Get("/jobs/{id}", s.handleGetJob)
		r.Post("/jobs/{id}/cancel", s.handleCancelJob)
		r.Delete("/sprite/{videoID}", s.handleDeleteSprite)
		r.Get("/hwaccel", s.handleHWAccel)
		r.Get("/stats", s.handleStats)
		r.Get("/config", s.handleConfig)
	})
	return r
}

func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		s.log.Debug("http",
			"method", r.Method,
			"path", r.URL.Path,
			"status", ww.Status(),
			"dur_ms", time.Since(start).Milliseconds(),
		)
	})
}

func (s *Server) requireToken(next http.Handler) http.Handler {
	want := strings.TrimSpace(s.cfg.HTTP.APIToken)
	if want == "" {
		s.log.Warn("SEEKBAR_API_TOKEN is empty — all /v1 endpoints are unauthenticated")
		return next
	}
	wantBytes := []byte(want)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get("X-API-Token")
		if got == "" {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		gotBytes := []byte(got)
		if len(gotBytes) != len(wantBytes) || subtle.ConstantTimeCompare(gotBytes, wantBytes) != 1 {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ---- Health / static serve ----

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	s.mu.RLock()
	hwa := s.hwaccelResolved
	ffv := s.ffmpegVersion
	s.mu.RUnlock()

	queued, processing, completed, failed := s.pool.Stats()
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":               true,
		"service":          "seekbar-service",
		"version":          ServiceVersion,
		"platform":         runtime.GOOS,
		"arch":             runtime.GOARCH,
		"ready":            true,
		"ffmpeg_version":   ffv,
		"hwaccel_config":   s.cfg.FFmpeg.HWAccel,
		"hwaccel_resolved": hwa,
		"format":           s.cfg.Thumb.Format,
		"concurrency":      s.cfg.Jobs.Concurrency,
		"uptime_sec":       time.Since(s.startedAt).Seconds(),
		"stats": map[string]any{
			"queued":     queued,
			"processing": processing,
			"completed":  completed,
			"failed":     failed,
		},
	})
}

func (s *Server) handleSprite(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "videoID")
	if !validID(id) {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	path, ok := s.findSprite(id)
	if !ok {
		w.Header().Set("Cache-Control", "no-store")
		http.NotFound(w, r)
		return
	}
	if strings.HasSuffix(path, ".webp") {
		w.Header().Set("Content-Type", "image/webp")
	} else {
		w.Header().Set("Content-Type", "image/jpeg")
	}
	w.Header().Set("Cache-Control", "public, max-age=3600, must-revalidate")
	http.ServeFile(w, r, path)
}

func (s *Server) handleMeta(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "videoID")
	if !validID(id) {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	metaPath := filepath.Join(s.cfg.Storage.OutputDir, id+".json")
	raw, err := os.ReadFile(metaPath)
	if err != nil {
		w.Header().Set("Cache-Control", "no-store")
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=3600, must-revalidate")
	_, _ = w.Write(raw)
}

func (s *Server) findSprite(id string) (string, bool) {
	for _, ext := range []string{".webp", ".jpg"} {
		p := filepath.Join(s.cfg.Storage.OutputDir, id+ext)
		if _, err := os.Stat(p); err == nil {
			return p, true
		}
	}
	return "", false
}

// ---- Submission ----

type submitOneReq struct {
	VideoID   string `json:"video_id"`
	Path      string `json:"path"`
	Priority  int    `json:"priority"`
	Overwrite string `json:"overwrite,omitempty"`
	Async     bool   `json:"async"`
}

func (s *Server) handleSubmitOne(w http.ResponseWriter, r *http.Request) {
	var req submitOneReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"bad json"}`, http.StatusBadRequest)
		return
	}
	if req.VideoID == "" || req.Path == "" {
		http.Error(w, `{"error":"video_id and path required"}`, http.StatusBadRequest)
		return
	}
	if !validID(req.VideoID) {
		http.Error(w, `{"error":"bad video_id"}`, http.StatusBadRequest)
		return
	}
	if _, err := os.Stat(req.Path); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "source not found", "path": req.Path})
		return
	}
	j := &worker.Job{
		ID:       uuid.NewString(),
		VideoID:  req.VideoID,
		SrcPath:  req.Path,
		Priority: req.Priority,
	}
	s.trackJob(j)
	s.pool.Submit(j)
	if !req.Async {
		// Wait for the job to leave the queue (best-effort, capped).
		// Mostly here so the parent can do a synchronous "regenerate one"
		// without polling. Long videos still take real ffmpeg time.
		ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
		defer cancel()
		for {
			select {
			case <-ctx.Done():
				writeJSON(w, http.StatusAccepted, map[string]any{
					"job_id":   j.ID,
					"status":   "timeout",
					"video_id": j.VideoID,
				})
				return
			case <-time.After(150 * time.Millisecond):
				// Read Status under the server lock to avoid a data race:
				// pool workers write j.Status without holding s.mu.
				s.mu.RLock()
				status := j.Status
				s.mu.RUnlock()
				if status == "done" || status == "failed" || status == "cancelled" {
					writeJSON(w, http.StatusOK, j)
					return
				}
			}
		}
	}
	writeJSON(w, http.StatusAccepted, j)
}

type submitBatchReq struct {
	Items []submitOneReq `json:"items"`
}

func (s *Server) handleSubmitBatch(w http.ResponseWriter, r *http.Request) {
	var req submitBatchReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"bad json"}`, http.StatusBadRequest)
		return
	}
	if len(req.Items) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"submitted": 0})
		return
	}
	ids := make([]string, 0, len(req.Items))
	for _, item := range req.Items {
		if item.VideoID == "" || item.Path == "" || !validID(item.VideoID) {
			continue
		}
		j := &worker.Job{
			ID:       uuid.NewString(),
			VideoID:  item.VideoID,
			SrcPath:  item.Path,
			Priority: item.Priority,
		}
		s.trackJob(j)
		s.pool.Submit(j)
		ids = append(ids, j.ID)
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"submitted": len(ids),
		"job_ids":   ids,
	})
}

func (s *Server) handleListJobs(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	// Newest first; cap at 200 so a long-running service doesn't dump
	// 10k rows when the operator opens the maintenance page.
	limit := 200
	if v := r.URL.Query().Get("limit"); v != "" {
		if n := atoi(v); n > 0 && n < 2000 {
			limit = n
		}
	}
	out := make([]*worker.Job, 0, limit)
	for i := len(s.jobList) - 1; i >= 0 && len(out) < limit; i-- {
		if j, ok := s.jobs[s.jobList[i]]; ok {
			out = append(out, j)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"jobs": out, "count": len(out)})
}

func (s *Server) handleGetJob(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	s.mu.RLock()
	j, ok := s.jobs[id]
	s.mu.RUnlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, http.StatusOK, j)
}

func (s *Server) handleCancelJob(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	s.mu.Lock()
	j, ok := s.jobs[id]
	if ok && j.Status == "pending" {
		j.Status = "cancelled"
	}
	s.mu.Unlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, http.StatusOK, j)
}

func (s *Server) handleDeleteSprite(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "videoID")
	if !validID(id) {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	removed := 0
	for _, ext := range []string{".webp", ".jpg", ".json"} {
		p := filepath.Join(s.cfg.Storage.OutputDir, id+ext)
		if err := os.Remove(p); err == nil {
			removed++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"video_id": id, "removed": removed})
}

func (s *Server) handleHWAccel(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	compiled, err := ffmpeg.CompiledIn(ctx, s.cfg.FFmpeg.Path)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"error": err.Error()})
		return
	}
	avail := ffmpeg.ProbeAvailableWithDevice(ctx, s.cfg.FFmpeg.Path, compiled, s.cfg.FFmpeg.VAAPIDevice)

	s.mu.RLock()
	resolved := s.hwaccelResolved
	s.mu.RUnlock()

	writeJSON(w, http.StatusOK, map[string]any{
		"compiled":         backendsAsStrings(compiled),
		"available":        backendsAsStrings(avail),
		"ffmpeg_path":      s.cfg.FFmpeg.Path,
		"hwaccel_config":   s.cfg.FFmpeg.HWAccel,
		"hwaccel_resolved": resolved,
	})
}

func (s *Server) handleStats(w http.ResponseWriter, _ *http.Request) {
	queued, processing, completed, failed := s.pool.Stats()
	writeJSON(w, http.StatusOK, map[string]any{
		"queued":     queued,
		"processing": processing,
		"completed":  completed,
		"failed":     failed,
	})
}

// handleConfig returns the current effective configuration. Useful for
// the Node.js parent to verify the sidecar picked up its env vars
// correctly without needing a full health-check parse.
func (s *Server) handleConfig(w http.ResponseWriter, _ *http.Request) {
	s.mu.RLock()
	resolved := s.hwaccelResolved
	ffv := s.ffmpegVersion
	s.mu.RUnlock()

	writeJSON(w, http.StatusOK, map[string]any{
		"http": map[string]any{
			"listen":    s.cfg.HTTP.Listen,
			"base_path": s.cfg.HTTP.BasePath,
			// APIToken deliberately omitted — never expose secrets.
			"cors_origins": s.cfg.HTTP.CORSOrigins,
		},
		"storage": map[string]any{
			"output_dir": s.cfg.Storage.OutputDir,
			"temp_dir":   s.cfg.Storage.TempDir,
			"overwrite":  s.cfg.Storage.Overwrite,
		},
		"ffmpeg": map[string]any{
			"path":             s.cfg.FFmpeg.Path,
			"probe_path":       s.cfg.FFmpeg.ProbePath,
			"hwaccel":          s.cfg.FFmpeg.HWAccel,
			"hwaccel_resolved": resolved,
			"ffmpeg_version":   ffv,
			"vaapi_device":     s.cfg.FFmpeg.VAAPIDevice,
		},
		"thumb": map[string]any{
			"interval_sec": s.cfg.Thumb.IntervalSec,
			"width":        s.cfg.Thumb.Width,
			"height":       s.cfg.Thumb.Height,
			"columns":      s.cfg.Thumb.Columns,
			"max_tiles":    s.cfg.Thumb.MaxTiles,
			"format":       s.cfg.Thumb.Format,
			"quality":      s.cfg.Thumb.Quality,
		},
		"jobs": map[string]any{
			"concurrency": s.cfg.Jobs.Concurrency,
			"max_retries": s.cfg.Jobs.MaxRetries,
			"retry_delay": s.cfg.Jobs.RetryDelay,
		},
	})
}

// ---- helpers ----

func (s *Server) trackJob(j *worker.Job) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.jobs[j.ID] = j
	s.jobList = append(s.jobList, j.ID)
	// Cap history to bound memory — keep the most recent 1000.
	if len(s.jobList) > 1000 {
		evict := s.jobList[0]
		s.jobList = s.jobList[1:]
		delete(s.jobs, evict)
	}
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

// validID guards path-traversal — sprite/meta filenames are user-controlled
// only via this id, so we keep the alphabet conservative.
func validID(id string) bool {
	if id == "" || len(id) > 128 {
		return false
	}
	for _, c := range id {
		if !((c >= '0' && c <= '9') ||
			(c >= 'a' && c <= 'z') ||
			(c >= 'A' && c <= 'Z') ||
			c == '-' || c == '_' || c == '.') {
			return false
		}
	}
	// No leading dot (`.git`), no `..` traversal.
	if id[0] == '.' || strings.Contains(id, "..") {
		return false
	}
	return true
}

func atoi(s string) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + int(c-'0')
	}
	return n
}

func backendsAsStrings(in []ffmpeg.HWAccelBackend) []string {
	out := make([]string, 0, len(in))
	for _, b := range in {
		out = append(out, string(b))
	}
	return out
}
