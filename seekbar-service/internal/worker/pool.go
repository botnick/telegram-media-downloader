// Package worker implements the concurrent job runner + sprite generator.
//
// Lifecycle: the pool starts N goroutines at boot. Each goroutine pulls
// the next pending job from the store (SQLite or in-memory), runs
// ffprobe + ffmpeg, persists metadata, and emits a progress event. The
// pool honours context cancellation so SIGTERM drains gracefully.
package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/botnick/telegram-media-downloader/seekbar-service/internal/config"
	"github.com/botnick/telegram-media-downloader/seekbar-service/internal/ffmpeg"
	"github.com/botnick/telegram-media-downloader/seekbar-service/internal/logx"
)

// Job represents a single sprite-generation request.
type Job struct {
	ID       string `json:"id"`
	VideoID  string `json:"video_id"`
	SrcPath  string `json:"src_path"`
	Status   string `json:"status"` // pending|running|done|failed|cancelled
	Error    string `json:"error,omitempty"`
	Retries  int    `json:"retries"`
	Priority int    `json:"priority"` // 0 = realtime, 1 = backfill
	// Result fields (populated on done)
	SpritePath string  `json:"sprite_path,omitempty"`
	MetaPath   string  `json:"meta_path,omitempty"`
	Duration   float64 `json:"duration,omitempty"`
	Frames     int     `json:"frames,omitempty"`
	Cols       int     `json:"cols,omitempty"`
	Rows       int     `json:"rows,omitempty"`
	TileW      int     `json:"tile_w,omitempty"`
	Bytes      int64   `json:"bytes,omitempty"`
	CreatedAt  int64   `json:"created_at"`
	StartedAt  int64   `json:"started_at,omitempty"`
	FinishedAt int64   `json:"finished_at,omitempty"`
}

// SpriteMeta is the JSON sidecar written alongside each sprite. The
// parent system (telegram-media-downloader) reads this via the HTTP
// /meta/:id endpoint to feed the video player's hover-preview logic.
type SpriteMeta struct {
	Version     int     `json:"version"`
	VideoID     string  `json:"video_id"`
	SpriteURL   string  `json:"sprite_url,omitempty"`
	MetaURL     string  `json:"meta_url,omitempty"`
	DurationSec float64 `json:"duration_sec"`
	Frames      int     `json:"frames"`
	Cols        int     `json:"cols"`
	Rows        int     `json:"rows"`
	TileW       int     `json:"tile_w"`
	TileH       int     `json:"tile_h"`
	IntervalSec float64 `json:"interval_sec"`
	Format      string  `json:"format"`
	Bytes       int64   `json:"bytes"`
	SourceSize  int64   `json:"source_size"`
	SourceMtime int64   `json:"source_mtime"`
	GeneratedAt int64   `json:"generated_at"`
}

// ProgressFunc is called after each completed/failed job so the host
// process (or SSE/WS relay) can report % completion.
type ProgressFunc func(done, total, generated, errored, queued int)

// Pool manages concurrent sprite workers.
type Pool struct {
	cfg    *config.Config
	log    *logx.Logger
	hwArgs []string

	mu      sync.Mutex
	queue   []*Job
	total   int
	done    int32 // total finished (ok + err)
	genOk   int32 // completed successfully
	genErr  int32 // failed permanently
	running int32 // currently in-flight

	cancel     context.CancelFunc
	wg         sync.WaitGroup
	onProgress ProgressFunc
}

// NewPool creates a ready-to-start pool. Call Start to begin processing.
func NewPool(cfg *config.Config, log *logx.Logger) *Pool {
	return &Pool{cfg: cfg, log: log}
}

// SetProgressCallback wires a function called after each job finishes.
func (p *Pool) SetProgressCallback(fn ProgressFunc) {
	p.onProgress = fn
}

// Submit enqueues a job. Thread-safe.
func (p *Pool) Submit(j *Job) {
	p.mu.Lock()
	defer p.mu.Unlock()
	j.Status = "pending"
	j.CreatedAt = time.Now().UnixMilli()
	p.queue = append(p.queue, j)
	p.total++
}

// Start launches worker goroutines. Accepts a pre-resolved hwaccel
// backend so the caller (server.go) can share detection results with
// the /health endpoint without probing twice. Pass an empty string to
// let the pool resolve hwaccel itself from the config.
//
// Returns the resolved HWAccelBackend that is now in use (may be "" for
// CPU-only). Call Stop or cancel the parent ctx to drain.
func (p *Pool) Start(ctx context.Context, resolvedHWAccel string) ffmpeg.HWAccelBackend {
	var hwa ffmpeg.HWAccelBackend
	if resolvedHWAccel != "" {
		// Caller already probed — trust it.
		hwa = ffmpeg.HWAccelBackend(resolvedHWAccel)
	} else {
		// Resolve hwaccel once at boot rather than per-job.
		probeCtx, probeCancel := context.WithTimeout(ctx, 20*time.Second)
		var err error
		hwa, err = ffmpeg.Resolve(probeCtx, p.cfg.FFmpeg.Path, p.cfg.FFmpeg.HWAccel, p.cfg.FFmpeg.VAAPIDevice)
		probeCancel()
		if err != nil {
			p.log.Warn("hwaccel resolve failed, using CPU", "err", err)
		}
	}
	p.hwArgs = ffmpeg.Args(hwa, p.cfg.FFmpeg.VAAPIDevice)
	if len(p.hwArgs) > 0 {
		p.log.Info("hwaccel active", "backend", string(hwa))
	} else {
		p.log.Info("hwaccel not available, using CPU decode")
	}

	ctx, p.cancel = context.WithCancel(ctx)
	n := p.cfg.Jobs.Concurrency
	if n < 1 {
		n = 1
	}
	for i := 0; i < n; i++ {
		p.wg.Add(1)
		go p.worker(ctx)
	}
	return hwa
}

// Stop signals cancellation and waits for in-flight jobs to finish.
func (p *Pool) Stop() {
	if p.cancel != nil {
		p.cancel()
	}
	p.wg.Wait()
}

// Stats returns a snapshot of pool counters.
// Returns: queued, processing, completed, failed counts.
func (p *Pool) Stats() (queued, processing, completed, failed int) {
	p.mu.Lock()
	queued = len(p.queue)
	p.mu.Unlock()
	return queued,
		int(atomic.LoadInt32(&p.running)),
		int(atomic.LoadInt32(&p.genOk)),
		int(atomic.LoadInt32(&p.genErr))
}

// LegacyStats returns the old (total, done, genOk, genErr, queued)
// tuple for backwards-compatible callers.
func (p *Pool) LegacyStats() (total, done, genOk, genErr, queued int) {
	p.mu.Lock()
	queued = len(p.queue)
	total = p.total
	p.mu.Unlock()
	return total, int(atomic.LoadInt32(&p.done)), int(atomic.LoadInt32(&p.genOk)),
		int(atomic.LoadInt32(&p.genErr)), queued
}

func (p *Pool) next() *Job {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.queue) == 0 {
		return nil
	}
	j := p.queue[0]
	p.queue = p.queue[1:]
	j.Status = "running"
	j.StartedAt = time.Now().UnixMilli()
	return j
}

func (p *Pool) worker(ctx context.Context) {
	defer p.wg.Done()
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		j := p.next()
		if j == nil {
			// Back-off when the queue is empty.
			select {
			case <-ctx.Done():
				return
			case <-time.After(200 * time.Millisecond):
				continue
			}
		}
		atomic.AddInt32(&p.running, 1)
		p.processJob(ctx, j)
		atomic.AddInt32(&p.running, -1)
		d := int(atomic.AddInt32(&p.done, 1))
		if p.onProgress != nil {
			p.mu.Lock()
			q := len(p.queue)
			p.mu.Unlock()
			p.onProgress(d, p.total, int(atomic.LoadInt32(&p.genOk)), int(atomic.LoadInt32(&p.genErr)), q)
		}
	}
}

func (p *Pool) processJob(ctx context.Context, j *Job) {
	cfg := p.cfg
	outDir := cfg.Storage.OutputDir
	_ = os.MkdirAll(outDir, 0o755)

	ext := "webp"
	if cfg.Thumb.Format == "jpeg" || cfg.Thumb.Format == "jpg" {
		ext = "jpg"
	}
	dstPath := filepath.Join(outDir, j.VideoID+"."+ext)
	metaPath := filepath.Join(outDir, j.VideoID+".json")

	// Overwrite policy check.
	if cfg.Storage.Overwrite == "never" {
		if fileExists(dstPath) && fileExists(metaPath) {
			j.Status = "done"
			j.SpritePath = dstPath
			j.MetaPath = metaPath
			j.FinishedAt = time.Now().UnixMilli()
			atomic.AddInt32(&p.genOk, 1)
			return
		}
	}

	// Duration probe.
	dur, err := ffmpeg.Duration(ctx, cfg.FFmpeg.ProbePath, j.SrcPath)
	if err != nil {
		p.fail(j, fmt.Sprintf("probe: %v", err))
		return
	}
	j.Duration = dur

	plan := ffmpeg.Plan(dur, cfg.Thumb.IntervalSec, cfg.Thumb.Columns, cfg.Thumb.MaxTiles, cfg.Thumb.Width)

	// if-changed: compare source size/mtime with prior meta.
	if cfg.Storage.Overwrite == "if-changed" && fileExists(metaPath) {
		if prior, ok := readMeta(metaPath); ok {
			si, _ := os.Stat(j.SrcPath)
			if si != nil && prior.SourceSize == si.Size() && prior.SourceMtime == si.ModTime().UnixMilli() {
				j.Status = "done"
				j.SpritePath = dstPath
				j.MetaPath = metaPath
				j.Frames = prior.Frames
				j.Cols = prior.Cols
				j.Rows = prior.Rows
				j.TileW = prior.TileW
				j.Bytes = prior.Bytes
				j.FinishedAt = time.Now().UnixMilli()
				atomic.AddInt32(&p.genOk, 1)
				return
			}
		}
	}

	// Build sprite.
	tmpPath := ffmpeg.TempPath(dstPath)
	args := ffmpeg.BuildArgs(j.SrcPath, tmpPath, plan, cfg.Thumb.Format, cfg.Thumb.Quality, p.hwArgs, cfg.FFmpeg.ExtraArgs)

	var lastErr error
	maxAttempts := cfg.Jobs.MaxRetries + 1
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if ctx.Err() != nil {
			j.Status = "cancelled"
			j.FinishedAt = time.Now().UnixMilli()
			return
		}
		if err := ffmpeg.Run(ctx, cfg.FFmpeg.Path, args); err != nil {
			lastErr = err
			time.Sleep(time.Duration(cfg.Jobs.RetryDelay*(attempt+1)) * time.Second / 10)
			continue
		}
		lastErr = nil
		break
	}
	if lastErr != nil {
		_ = os.Remove(tmpPath)
		p.fail(j, fmt.Sprintf("ffmpeg: %v", lastErr))
		return
	}
	if err := ffmpeg.AtomicRename(tmpPath, dstPath); err != nil {
		p.fail(j, fmt.Sprintf("rename: %v", err))
		return
	}

	// Write JSON meta.
	fi, _ := os.Stat(dstPath)
	var spriteBytes int64
	if fi != nil {
		spriteBytes = fi.Size()
	}
	si, _ := os.Stat(j.SrcPath)
	var srcSize int64
	var srcMtime int64
	if si != nil {
		srcSize = si.Size()
		srcMtime = si.ModTime().UnixMilli()
	}
	meta := SpriteMeta{
		Version:     1,
		VideoID:     j.VideoID,
		SpriteURL:   cfg.HTTP.BasePath + "/sprite/" + j.VideoID,
		MetaURL:     cfg.HTTP.BasePath + "/meta/" + j.VideoID,
		DurationSec: dur,
		Frames:      plan.Frames,
		Cols:        plan.Cols,
		Rows:        plan.Rows,
		TileW:       plan.TileW,
		TileH:       0,
		IntervalSec: plan.IntervalSec,
		Format:      ext,
		Bytes:       spriteBytes,
		SourceSize:  srcSize,
		SourceMtime: srcMtime,
		GeneratedAt: time.Now().UnixMilli(),
	}
	raw, _ := json.Marshal(meta)
	tmpMeta := ffmpeg.TempPath(metaPath)
	if err := os.WriteFile(tmpMeta, raw, 0o644); err == nil {
		_ = ffmpeg.AtomicRename(tmpMeta, metaPath)
	} else {
		_ = os.Remove(tmpMeta)
	}

	j.Status = "done"
	j.SpritePath = dstPath
	j.MetaPath = metaPath
	j.Frames = plan.Frames
	j.Cols = plan.Cols
	j.Rows = plan.Rows
	j.TileW = plan.TileW
	j.Bytes = spriteBytes
	j.FinishedAt = time.Now().UnixMilli()
	atomic.AddInt32(&p.genOk, 1)
	p.log.Debug("sprite done", "video_id", j.VideoID, "frames", plan.Frames, "bytes", spriteBytes)
}

func (p *Pool) fail(j *Job, msg string) {
	j.Status = "failed"
	j.Error = msg
	j.FinishedAt = time.Now().UnixMilli()
	j.Retries++
	atomic.AddInt32(&p.genErr, 1)
	p.log.Warn("job failed", "video_id", j.VideoID, "err", msg)
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func readMeta(p string) (SpriteMeta, bool) {
	raw, err := os.ReadFile(p)
	if err != nil {
		return SpriteMeta{}, false
	}
	var m SpriteMeta
	if json.Unmarshal(raw, &m) != nil {
		return SpriteMeta{}, false
	}
	return m, true
}
