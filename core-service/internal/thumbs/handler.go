// Package thumbs runs the video thumbnail ffmpeg path outside Node.
//
// The Node layer still owns cache keys, database rows and atomic publication;
// this package owns the CPU-heavy decode/scale/WebP encode. The endpoint is
// optional so an older tgdl-core can fall back to the existing Node path.
package thumbs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
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
	maxBody           = 64 << 10
	defaultImgWorkers = 4
	defaultWorkers    = 6
	maxImgWorkers     = 32
	maxWorkers        = 16
	maxWaiting        = 32
	maxWidth          = 4096
)

var hwaccelAllow = map[string]bool{
	"vaapi": true, "cuda": true, "qsv": true,
	"videotoolbox": true, "d3d11va": true, "dxva2": true,
}

type request struct {
	Path   string `json:"path"`
	Output string `json:"output"`
	Width  int    `json:"width"`
	FFmpeg string `json:"ffmpeg,omitempty"`
	HW     string `json:"hwaccel,omitempty"`
}

type response struct {
	Status string `json:"status"`
	Size   int64  `json:"size,omitempty"`
}

// Handler serves one of the POST /v1/thumb/{video,image,audio} routes.
type Handler struct {
	Roots *hash.Roots
	Log   *slog.Logger
	Kind  string

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
			envName := "THUMBS_VID_CONCURRENCY"
			if h.Kind == "image" || h.Kind == "audio" {
				workers = defaultImgWorkers
				envName = "THUMBS_IMG_CONCURRENCY"
			}
			if raw := strings.TrimSpace(os.Getenv(envName)); raw != "" {
				if n, err := strconv.Atoi(raw); err == nil && n > 0 {
					workers = n
				}
			}
		}
		max := maxWorkers
		if h.Kind == "image" || h.Kind == "audio" {
			max = maxImgWorkers
		}
		if workers > max {
			workers = max
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
		return errors.New("thumbnail queue is full")
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
		writeError(w, http.StatusBadRequest, "EINVAL", `body must be JSON {"path":"/abs/video","output":"/abs/thumb.tmp","width":320}`)
		return
	}
	if req.Width < 1 || req.Width > maxWidth {
		writeError(w, http.StatusBadRequest, "EINVAL", "width must be between 1 and 4096")
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
		writeError(w, http.StatusUnprocessableEntity, "EISDIR", "thumbnail input is not a regular file")
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

	if err := render(r.Context(), input, output, req.Width, req.FFmpeg, req.HW, h.Kind); err != nil {
		if h.Log != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			h.Log.Debug("video thumbnail failed", "path", input, "err", err)
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
		writeError(w, http.StatusUnprocessableEntity, "EIO", "ffmpeg produced an empty thumbnail")
		return
	}
	hash.WriteJSON(w, http.StatusOK, response{Status: "ok", Size: out.Size()})
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

func render(ctx context.Context, input, output string, width int, requested, hw, kind string) error {
	if kind == "image" || kind == "audio" {
		return renderStill(ctx, input, output, width, requested, kind)
	}
	_ = os.Remove(output)
	args := func(sec int) []string {
		filter := fmt.Sprintf("scale='min(%d,iw)':-2:flags=fast_bilinear", width)
		out := []string{"-hide_banner", "-loglevel", "error"}
		if hwaccelAllow[strings.ToLower(strings.TrimSpace(hw))] {
			out = append(out, "-hwaccel", strings.ToLower(strings.TrimSpace(hw)))
		}
		out = append(out, "-ss", strconv.Itoa(sec), "-i", input, "-frames:v", "1", "-an", "-vf", filter, "-pix_fmt", "yuv420p", "-c:v", "libwebp", "-quality", "62", "-compression_level", "6", "-f", "webp", "-y", output)
		return out
	}
	if err := runFFmpeg(ctx, args(1), requested); err == nil && nonEmpty(output) {
		return nil
	} else if err != nil && ctx.Err() != nil {
		return err
	}
	_ = os.Remove(output)
	if err := runFFmpeg(ctx, args(0), requested); err != nil {
		_ = os.Remove(output)
		return err
	}
	return nil
}

func renderStill(ctx context.Context, input, output string, width int, requested, kind string) error {
	_ = os.Remove(output)
	// Sharp keeps the exact aspect-ratio rounding for stills (odd heights
	// included); -1 avoids ffmpeg's even-dimension -2 adjustment.
	filter := fmt.Sprintf("scale='min(%d,iw)':-1:flags=fast_bilinear", width)
	args := []string{
		"-hide_banner", "-loglevel", "error", "-i", input,
	}
	if kind == "audio" {
		args = append(args, "-map", "0:v:0")
	}
	args = append(args,
		"-frames:v", "1", "-an", "-vf", filter, "-pix_fmt", "yuv420p",
		"-c:v", "libwebp", "-quality", "62", "-compression_level", "6",
		"-f", "webp", "-y", output,
	)
	if err := runFFmpeg(ctx, args, requested); err != nil {
		_ = os.Remove(output)
		return err
	}
	if !nonEmpty(output) {
		return errors.New("ffmpeg: produced an empty thumbnail")
	}
	return nil
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
