// Package seekbar runs the CPU-heavy video sprite encode outside Node.
//
// Node owns seekbar cache metadata and database rows. This package only
// decodes a video, samples frames, tiles them, and writes the requested
// sprite at the caller-provided temporary path. The Node caller publishes it
// with an atomic rename after the request succeeds.
package seekbar

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

const (
	maxBody        = 64 << 10
	defaultWorkers = 2
	maxWorkers     = 8
	maxWaiting     = 32
	maxFrames      = 720
	maxCols        = 50
	maxRows        = 720
	maxTileWidth   = 800
)

var hwaccelAllow = map[string]bool{
	"vaapi": true, "cuda": true, "qsv": true,
	"videotoolbox": true, "d3d11va": true, "dxva2": true,
}

type request struct {
	Path      string  `json:"path"`
	Output    string  `json:"output"`
	Frames    int     `json:"frames"`
	Interval  float64 `json:"intervalSec"`
	Cols      int     `json:"cols"`
	Rows      int     `json:"rows"`
	TileWidth int     `json:"tileWidth"`
	Format    string  `json:"format"`
	Quality   int     `json:"quality"`
	FFmpeg    string  `json:"ffmpeg,omitempty"`
	HWAccel   string  `json:"hwaccel,omitempty"`
}

type response struct {
	Status string `json:"status"`
	Size   int64  `json:"size"`
}

// Handler serves POST /v1/seekbar.
type Handler struct {
	Roots *hash.Roots
	Log   *slog.Logger

	Workers int
	once    sync.Once
	slots   chan struct{}
	waiting chan struct{}
}

func (h *Handler) init() {
	h.once.Do(func() {
		workers := h.Workers
		if workers < 1 {
			workers = defaultWorkers
			if raw := strings.TrimSpace(os.Getenv("SEEKBAR_CONCURRENCY")); raw != "" {
				if n, err := strconv.Atoi(raw); err == nil && n > 0 {
					workers = n
				}
			}
		}
		if workers > maxWorkers {
			workers = maxWorkers
		}
		h.slots = make(chan struct{}, workers)
		h.waiting = make(chan struct{}, maxWaiting)
	})
}

func (h *Handler) acquire(ctx context.Context) error {
	h.init()
	select {
	case h.slots <- struct{}{}:
		return nil
	default:
	}
	select {
	case h.waiting <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	default:
		return errors.New("seekbar queue is full")
	}
	defer func() { <-h.waiting }()
	select {
	case h.slots <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (h *Handler) release() { <-h.slots }

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req request
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody))
	if err := dec.Decode(&req); err != nil || req.Path == "" || req.Output == "" {
		writeError(w, http.StatusBadRequest, "EINVAL", `body must be JSON {"path":"/abs/video","output":"/abs/sprite.tmp",...}`)
		return
	}
	if err := validate(req); err != nil {
		writeError(w, http.StatusBadRequest, "EINVAL", err.Error())
		return
	}
	input, err := h.Roots.Resolve(req.Path)
	if err != nil {
		h.writeResolveError(w, err)
		return
	}
	output, err := h.resolveOutput(req.Output)
	if err != nil {
		h.writeResolveError(w, err)
		return
	}
	st, err := os.Stat(input)
	if err != nil {
		writeFileError(w, err)
		return
	}
	if !st.Mode().IsRegular() {
		writeError(w, http.StatusUnprocessableEntity, "EISDIR", "seekbar input is not a regular file")
		return
	}
	if err := h.acquire(r.Context()); err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			writeError(w, 499, "ECANCELED", err.Error())
		} else {
			writeError(w, http.StatusServiceUnavailable, "EQUEUEFULL", err.Error())
		}
		return
	}
	defer h.release()

	if err := render(r.Context(), input, output, req); err != nil {
		if h.Log != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			h.Log.Debug("seekbar sprite failed", "path", input, "err", err)
		}
		code := "EIO"
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			code = "ECANCELED"
		} else if strings.HasPrefix(err.Error(), "ffmpeg:") {
			code = "EFFMPEG"
		}
		_ = os.Remove(output)
		writeError(w, hash.StatusFor(code), code, err.Error())
		return
	}
	out, err := os.Stat(output)
	if err != nil || !out.Mode().IsRegular() || out.Size() == 0 {
		_ = os.Remove(output)
		writeError(w, http.StatusUnprocessableEntity, "EIO", "ffmpeg produced an empty sprite")
		return
	}
	hash.WriteJSON(w, http.StatusOK, response{Status: "ok", Size: out.Size()})
}

func validate(req request) error {
	if req.Frames < 8 || req.Frames > maxFrames {
		return fmt.Errorf("frames must be between 8 and %d", maxFrames)
	}
	if req.Interval <= 0 || req.Interval > 86400 {
		return errors.New("intervalSec must be greater than 0")
	}
	if req.Cols < 2 || req.Cols > maxCols {
		return fmt.Errorf("cols must be between 2 and %d", maxCols)
	}
	if req.Rows < 1 || req.Rows > maxRows {
		return fmt.Errorf("rows must be between 1 and %d", maxRows)
	}
	if req.TileWidth < 40 || req.TileWidth > maxTileWidth {
		return fmt.Errorf("tileWidth must be between 40 and %d", maxTileWidth)
	}
	format := strings.ToLower(strings.TrimSpace(req.Format))
	if format != "webp" && format != "jpeg" && format != "jpg" {
		return errors.New("format must be webp or jpeg")
	}
	if req.Quality < 1 || req.Quality > 100 {
		return errors.New("quality must be between 1 and 100")
	}
	return nil
}

func (h *Handler) resolveOutput(p string) (string, error) {
	if strings.IndexByte(p, 0) >= 0 || !filepath.IsAbs(p) {
		return "", &hash.Error{Code: "EINVAL", Path: p, Err: errors.New("output must be an absolute path without NUL bytes")}
	}
	contained, ok := h.Roots.Contain(filepath.Clean(p))
	if !ok {
		return "", hash.Outside(p)
	}
	parent, err := h.Roots.Resolve(filepath.Dir(contained))
	if err != nil {
		return "", err
	}
	output := filepath.Join(parent, filepath.Base(contained))
	if st, err := os.Lstat(output); err == nil && st.Mode()&os.ModeSymlink != 0 {
		return "", hash.Outside(p)
	}
	return output, nil
}

func render(ctx context.Context, input, output string, req request) error {
	_ = os.Remove(output)
	filter := fmt.Sprintf("fps=1/%s,scale=%d:-2:flags=fast_bilinear,tile=%dx%d", formatFloat(req.Interval), req.TileWidth, req.Cols, req.Rows)
	args := []string{"-hide_banner", "-loglevel", "error"}
	if hw := strings.ToLower(strings.TrimSpace(req.HWAccel)); hwaccelAllow[hw] {
		args = append(args, "-hwaccel", hw)
	}
	args = append(args, "-i", input, "-frames:v", "1", "-an", "-vf", filter)
	if strings.EqualFold(req.Format, "webp") {
		args = append(args, "-c:v", "libwebp", "-quality", strconv.Itoa(req.Quality), "-compression_level", "6", "-f", "webp")
	} else {
		q := int(math.Round(31 - float64(req.Quality)/4))
		if q < 2 {
			q = 2
		}
		args = append(args, "-c:v", "mjpeg", "-q:v", strconv.Itoa(q), "-f", "image2")
	}
	args = append(args, "-y", output)
	if err := runFFmpeg(ctx, args, req.FFmpeg); err != nil {
		return err
	}
	if !nonEmpty(output) {
		return errors.New("ffmpeg: produced an empty sprite")
	}
	return nil
}

func formatFloat(v float64) string {
	return strconv.FormatFloat(v, 'f', 6, 64)
}

func nonEmpty(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.Mode().IsRegular() && st.Size() > 0
}

func runFFmpeg(ctx context.Context, args []string, requested string) error {
	bin := strings.TrimSpace(requested)
	if bin == "" {
		bin = strings.TrimSpace(os.Getenv("FFMPEG_PATH"))
	}
	if bin == "" {
		var err error
		bin, err = exec.LookPath("ffmpeg")
		if err != nil {
			return errors.New("ffmpeg: executable not found")
		}
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	var stderr limitedBuffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return fmt.Errorf("ffmpeg: %s", msg[:min(len(msg), 400)])
	}
	return nil
}

type limitedBuffer struct{ b []byte }

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if len(b.b) < 4096 {
		n := min(4096-len(b.b), len(p))
		b.b = append(b.b, p[:n]...)
	}
	return len(p), nil
}

func (b *limitedBuffer) String() string { return string(b.b) }

func (h *Handler) writeResolveError(w http.ResponseWriter, err error) {
	code := "EIO"
	var he *hash.Error
	if errors.As(err, &he) {
		code = he.Code
	}
	writeError(w, hash.StatusFor(code), code, err.Error())
}

func writeFileError(w http.ResponseWriter, err error) {
	code := "EIO"
	if errors.Is(err, os.ErrNotExist) {
		code = "ENOENT"
	}
	writeError(w, hash.StatusFor(code), code, err.Error())
}

func writeError(w http.ResponseWriter, status int, code, msg string) {
	hash.WriteError(w, status, code, msg)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
