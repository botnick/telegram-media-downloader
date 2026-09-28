// Package api exposes the seekbar service over HTTP.
//
// Endpoints (admin / authenticated callers):
//
//	POST   /v1/sprite            — submit a single video (sync or async)
//	POST   /v1/batch             — submit many at once
//	GET    /v1/jobs/:id          — job status
//	GET    /v1/jobs              — list recent jobs
//	POST   /v1/jobs/:id/cancel   — request cancel (best-effort)
//	GET    /v1/config            — current effective config (for parent health checks)
//	GET    /sprite/:video_id     — serve the WebP/JPEG sprite bytes
//	GET    /meta/:video_id       — serve the JSON sidecar
//	DELETE /v1/sprite/:video_id  — remove sprite + meta from disk
//	PUT    /v1/uploads/:id       — append a chunk of a video (upload mode)
//	DELETE /v1/uploads/:id       — drop a partial upload
//	GET    /health               — liveness probe (always open)
//	GET    /v1/hwaccel           — probe what backends work on this host
//	GET    /v1/stats             — pool counters
//
// The token (if HTTP.APIToken is set) is checked once via middleware so
// every /v1 route is gated; /sprite and /meta too unless
// HTTP.PublicMedia is set. /health is always open so a Docker
// healthcheck never needs credentials.
//
// Upload mode is for a caller on another host that can't share its
// files: it PUTs the video in chunks (each below proxy body limits such
// as Cloudflare's 100 MB), submits the job with `upload_id`, polls it,
// then downloads the sprite from /sprite/:video_id. The uploaded file is
// deleted as soon as the job settles.
package api

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
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

const ServiceVersion = "0.4.0"

// Features advertised on /health so callers can pick what this build
// supports (older builds report none and are used in path mode only).
var Features = []string{"path", "upload", "job_params", "sprite_download"}

// UploadChunkBytes is the chunk size callers should use — well below the
// 100 MB request cap of Cloudflare Tunnel and common reverse proxies.
const UploadChunkBytes = 32 << 20

// uploadIODeadline bounds one chunk's transfer on a slow link.
const uploadIODeadline = 15 * time.Minute

type Server struct {
	cfg  *config.Config
	log  *logx.Logger
	pool *worker.Pool

	mu      sync.RWMutex
	jobs    map[string]*worker.Job
	jobList []string

	uploadMu  sync.Mutex
	uploading map[string]bool // upload ids with a chunk in flight

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
		uploading: make(map[string]bool),
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

	// Always-open endpoint — no token required.
	r.Get("/health", s.handleHealth)
	// Sprite + meta: open unless a token is set (then gated, so a tunnel-
	// exposed sidecar doesn't serve thumbnails to anyone), or explicitly
	// public via SEEKBAR_PUBLIC_MEDIA.
	r.Group(func(r chi.Router) {
		if !s.cfg.HTTP.PublicMedia && strings.TrimSpace(s.cfg.HTTP.APIToken) != "" {
			r.Use(s.requireToken)
		}
		r.Get("/sprite/{videoID}", s.handleSprite)
		r.Get("/meta/{videoID}", s.handleMeta)
	})

	r.Route("/v1", func(r chi.Router) {
		r.Use(s.requireToken)
		r.Post("/sprite", s.handleSubmitOne)
		r.Post("/batch", s.handleSubmitBatch)
		r.Get("/jobs", s.handleListJobs)
		r.Get("/jobs/{id}", s.handleGetJob)
		r.Post("/jobs/{id}/cancel", s.handleCancelJob)
		r.Delete("/sprite/{videoID}", s.handleDeleteSprite)
		r.Put("/uploads/{uploadID}", s.handleUploadChunk)
		r.Delete("/uploads/{uploadID}", s.handleDeleteUpload)
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
		"ok":                 true,
		"service":            "seekbar-service",
		"version":            ServiceVersion,
		"platform":           runtime.GOOS,
		"arch":               runtime.GOARCH,
		"ready":              true,
		"ffmpeg_version":     ffv,
		"hwaccel_config":     s.cfg.FFmpeg.HWAccel,
		"hwaccel_resolved":   hwa,
		"format":             s.cfg.Thumb.Format,
		"concurrency":        s.cfg.Jobs.Concurrency,
		"uptime_sec":         time.Since(s.startedAt).Seconds(),
		"features":           Features,
		"auth_required":      strings.TrimSpace(s.cfg.HTTP.APIToken) != "",
		"public_media":       s.cfg.HTTP.PublicMedia,
		"max_upload_bytes":   s.maxUploadBytes(),
		"upload_chunk_bytes": UploadChunkBytes,
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
	UploadID  string `json:"upload_id,omitempty"`
	Priority  int    `json:"priority"`
	Overwrite string `json:"overwrite,omitempty"`
	Async     bool   `json:"async"`
	// Optional per-job thumb settings (0 / "" = sidecar defaults).
	IntervalSec float64 `json:"interval_sec,omitempty"`
	TileW       int     `json:"tile_w,omitempty"`
	Cols        int     `json:"cols,omitempty"`
	MaxTiles    int     `json:"max_tiles,omitempty"`
	Format      string  `json:"format,omitempty"`
	Quality     int     `json:"quality,omitempty"`
}

func (req submitOneReq) overwrite() string {
	switch o := strings.ToLower(strings.TrimSpace(req.Overwrite)); o {
	case "never", "if-changed", "always":
		return o
	}
	return ""
}

func (req submitOneReq) params() *worker.JobParams {
	jp := &worker.JobParams{
		IntervalSec: req.IntervalSec,
		TileW:       req.TileW,
		Cols:        req.Cols,
		MaxTiles:    req.MaxTiles,
		Format:      strings.ToLower(strings.TrimSpace(req.Format)),
		Quality:     req.Quality,
	}
	return jp.Clamp()
}

// errSource is a client error that maps to a 400 with a JSON body.
type errSource struct{ body map[string]any }

func (e *errSource) Error() string { return "bad source" }

// buildJob validates one submission and resolves its source file. An
// upload is claimed (renamed out of the writable .part name) so no
// further chunk can change it under ffmpeg.
func (s *Server) buildJob(req submitOneReq) (*worker.Job, error) {
	if req.VideoID == "" || (req.Path == "" && req.UploadID == "") {
		return nil, &errSource{map[string]any{"error": "video_id and path (or upload_id) required"}}
	}
	if !validID(req.VideoID) {
		return nil, &errSource{map[string]any{"error": "bad video_id"}}
	}
	j := &worker.Job{
		ID:        uuid.NewString(),
		VideoID:   req.VideoID,
		Priority:  req.Priority,
		Params:    req.params(),
		Overwrite: req.overwrite(),
	}
	if req.UploadID != "" {
		if !validID(req.UploadID) {
			return nil, &errSource{map[string]any{"error": "bad upload_id"}}
		}
		part := s.uploadPath(req.UploadID, ".part")
		claimed := s.uploadPath(req.UploadID, ".job")
		s.uploadMu.Lock()
		busy := s.uploading[req.UploadID]
		var err error
		if !busy {
			err = os.Rename(part, claimed)
		}
		s.uploadMu.Unlock()
		if busy {
			return nil, &errSource{map[string]any{"error": "upload still in progress", "upload_id": req.UploadID}}
		}
		if err != nil {
			return nil, &errSource{map[string]any{"error": "upload not found", "upload_id": req.UploadID}}
		}
		j.SrcPath = claimed
		j.Source = "upload"
		return j, nil
	}
	src, ok := s.resolveSource(req.Path)
	if !ok {
		return nil, &errSource{map[string]any{"error": "source not found", "path": req.Path}}
	}
	j.SrcPath = src
	j.Source = "path"
	return j, nil
}

// resolveSource checks a path-mode source: it must exist and, when
// storage.allow_roots is set, resolve (symlinks included) to a file under
// one of those roots. Returns the path to read.
func (s *Server) resolveSource(p string) (string, bool) {
	roots := s.cfg.Storage.AllowRoots
	if len(roots) == 0 {
		if _, err := os.Stat(p); err != nil {
			return "", false
		}
		return p, true
	}
	abs, err := filepath.Abs(filepath.Clean(p))
	if err != nil {
		return "", false
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", false
	}
	for _, r := range roots {
		root, err := filepath.Abs(filepath.Clean(r))
		if err != nil {
			continue
		}
		if rr, err := filepath.EvalSymlinks(root); err == nil {
			root = rr
		}
		rel, err := filepath.Rel(root, real)
		if err != nil || rel == ".." || filepath.IsAbs(rel) ||
			strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			continue
		}
		if st, err := os.Stat(real); err == nil && st.Mode().IsRegular() {
			return real, true
		}
		return "", false
	}
	return "", false
}

func (s *Server) handleSubmitOne(w http.ResponseWriter, r *http.Request) {
	var req submitOneReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"bad json"}`, http.StatusBadRequest)
		return
	}
	j, err := s.buildJob(req)
	if err != nil {
		var es *errSource
		if errors.As(err, &es) {
			writeJSON(w, http.StatusBadRequest, es.body)
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
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
		// Batch keeps its lenient contract: bad items are skipped, but
		// unlike single submits a missing path isn't checked up front.
		if item.VideoID == "" || !validID(item.VideoID) || (item.Path == "" && item.UploadID == "") {
			continue
		}
		var j *worker.Job
		if item.UploadID != "" {
			var err error
			if j, err = s.buildJob(item); err != nil {
				continue
			}
		} else {
			j = &worker.Job{
				ID:        uuid.NewString(),
				VideoID:   item.VideoID,
				SrcPath:   item.Path,
				Source:    "path",
				Priority:  item.Priority,
				Params:    item.params(),
				Overwrite: item.overwrite(),
			}
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

// ---- Upload mode ----

func (s *Server) uploadDir() string {
	return filepath.Join(s.cfg.Storage.TempDir, "uploads")
}

func (s *Server) uploadPath(id, ext string) string {
	return filepath.Join(s.uploadDir(), id+ext)
}

func (s *Server) maxUploadBytes() int64 {
	return int64(s.cfg.Storage.MaxUploadMB) << 20
}

// handleUploadChunk appends one chunk to an upload. The client sends the
// byte offset it believes the upload is at (`X-Upload-Offset` header or
// `?offset=`); a mismatch answers 409 with the real size so the client
// can resume, and a chunk that fails mid-transfer is rolled back so the
// same chunk can simply be retried.
func (s *Server) handleUploadChunk(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "uploadID")
	if !validID(id) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad upload id"})
		return
	}
	offStr := r.Header.Get("X-Upload-Offset")
	if offStr == "" {
		offStr = r.URL.Query().Get("offset")
	}
	offset := int64(0)
	if offStr != "" {
		n, err := strconv.ParseInt(offStr, 10, 64)
		if err != nil || n < 0 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad offset"})
			return
		}
		offset = n
	}
	// The server-wide ReadTimeout (30 s) is too short for a big chunk on a
	// slow uplink; give this request its own deadline.
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Now().Add(uploadIODeadline))
	_ = rc.SetWriteDeadline(time.Now().Add(uploadIODeadline + time.Minute))

	s.uploadMu.Lock()
	if s.uploading[id] {
		s.uploadMu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]any{"error": "chunk already in flight"})
		return
	}
	s.uploading[id] = true
	s.uploadMu.Unlock()
	defer func() {
		s.uploadMu.Lock()
		delete(s.uploading, id)
		s.uploadMu.Unlock()
	}()

	if err := os.MkdirAll(s.uploadDir(), 0o755); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "upload dir: " + err.Error()})
		return
	}
	path := s.uploadPath(id, ".part")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "open: " + err.Error()})
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "stat: " + err.Error()})
		return
	}
	size := st.Size()
	if offset != size {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "offset mismatch", "size": size})
		return
	}
	if _, err := f.Seek(size, io.SeekStart); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "seek: " + err.Error()})
		return
	}
	limit := s.maxUploadBytes() - size
	n, err := io.Copy(f, io.LimitReader(r.Body, limit+1))
	if n > limit {
		_ = f.Truncate(size)
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{
			"error":     "upload too large",
			"max_bytes": s.maxUploadBytes(),
		})
		return
	}
	if err != nil {
		_ = f.Truncate(size)
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "chunk interrupted", "size": size})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"upload_id": id, "size": size + n})
}

func (s *Server) handleDeleteUpload(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "uploadID")
	if !validID(id) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad upload id"})
		return
	}
	s.uploadMu.Lock()
	busy := s.uploading[id]
	s.uploadMu.Unlock()
	if busy {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "chunk in flight"})
		return
	}
	err := os.Remove(s.uploadPath(id, ".part"))
	writeJSON(w, http.StatusOK, map[string]any{"upload_id": id, "removed": err == nil})
}

// StartUploadGC removes claimed uploads a previous run left behind (jobs
// don't survive a restart) and, every few minutes, partial uploads
// nobody has touched within UploadTTLMin.
func (s *Server) StartUploadGC(ctx context.Context) {
	if matches, _ := filepath.Glob(filepath.Join(s.uploadDir(), "*.job")); len(matches) > 0 {
		for _, m := range matches {
			_ = os.Remove(m)
		}
	}
	go func() {
		t := time.NewTicker(5 * time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.sweepUploads(time.Now().Add(-time.Duration(s.cfg.Storage.UploadTTLMin) * time.Minute))
			}
		}
	}()
}

func (s *Server) sweepUploads(olderThan time.Time) int {
	matches, _ := filepath.Glob(filepath.Join(s.uploadDir(), "*.part"))
	removed := 0
	for _, m := range matches {
		id := strings.TrimSuffix(filepath.Base(m), ".part")
		s.uploadMu.Lock()
		busy := s.uploading[id]
		s.uploadMu.Unlock()
		if busy {
			continue
		}
		if st, err := os.Stat(m); err == nil && st.ModTime().Before(olderThan) {
			if os.Remove(m) == nil {
				removed++
			}
		}
	}
	return removed
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
