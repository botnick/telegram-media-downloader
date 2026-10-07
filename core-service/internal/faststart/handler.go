// Package faststart moves MP4 metadata to the front of a file without
// decoding it. The operation is intentionally isolated from Node: ffmpeg is
// I/O bound and can otherwise hold the Node event loop and child-process
// bookkeeping open during a large maintenance sweep.
package faststart

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

const (
	maxBody        = 64 << 10
	defaultWorkers = 2
	maxWorkers     = 8
	maxWaiting     = 32
)

var dataTrackError = "Could not find tag for codec"

type request struct {
	Path   string `json:"path"`
	FFmpeg string `json:"ffmpeg,omitempty"`
}

type response struct {
	Status  string `json:"status"`
	NewSize int64  `json:"newSize,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

// Handler serves POST /v1/faststart.
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
			if raw := strings.TrimSpace(os.Getenv("FASTSTART_CONCURRENCY")); raw != "" {
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
		return errors.New("faststart queue is full")
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
	if err := dec.Decode(&req); err != nil || req.Path == "" {
		writeError(w, http.StatusBadRequest, "EINVAL", `body must be JSON {"path":"/abs/file"}`)
		return
	}
	resolved, err := h.Roots.Resolve(req.Path)
	if err != nil {
		h.writeResolveError(w, err)
		return
	}
	st, err := os.Stat(resolved)
	if err != nil {
		writeFileError(w, err)
		return
	}
	if !st.Mode().IsRegular() {
		writeError(w, http.StatusUnprocessableEntity, "EISDIR", "faststart input is not a regular file")
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

	result, err := optimize(r.Context(), resolved, req.FFmpeg)
	if err != nil {
		if h.Log != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			h.Log.Debug("faststart failed", "path", resolved, "err", err)
		}
		code := "EIO"
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			code = "ECANCELED"
		} else if strings.HasPrefix(err.Error(), "ffmpeg:") {
			code = "EFFMPEG"
		}
		writeError(w, hash.StatusFor(code), code, err.Error())
		return
	}
	hash.WriteJSON(w, http.StatusOK, result)
}

func optimize(ctx context.Context, path, ffmpeg string) (response, error) {
	atom, err := secondAtom(path)
	if err != nil {
		return response{}, err
	}
	if atom == "moov" {
		return response{Status: "already"}, nil
	}
	if atom == "" {
		return response{}, errors.New("ffmpeg: input is not a valid MP4 container")
	}

	tmp := path + ".faststart.tmp"
	_ = os.Remove(tmp)
	args := func(dropData bool) []string {
		out := []string{"-hide_banner", "-loglevel", "error", "-i", path, "-c", "copy", "-map", "0"}
		if dropData {
			out = append(out, "-map", "-0:d")
		}
		return append(out, "-movflags", "+faststart", "-f", "mp4", "-y", tmp)
	}
	if err := runFFmpeg(ctx, args(false), ffmpeg); err != nil {
		if !strings.Contains(err.Error(), dataTrackError) {
			_ = os.Remove(tmp)
			return response{}, err
		}
		if err = runFFmpeg(ctx, args(true), ffmpeg); err != nil {
			_ = os.Remove(tmp)
			return response{}, err
		}
	}
	tmpStat, err := os.Stat(tmp)
	if err != nil {
		return response{}, fmt.Errorf("ffmpeg: produced no output: %w", err)
	}
	srcStat, err := os.Stat(path)
	if err != nil {
		_ = os.Remove(tmp)
		return response{}, err
	}
	if tmpStat.Size() < int64(float64(srcStat.Size())*0.8) || tmpStat.Size() > int64(float64(srcStat.Size())*1.1) {
		_ = os.Remove(tmp)
		return response{}, fmt.Errorf("ffmpeg: output size sanity check failed: src=%d tmp=%d", srcStat.Size(), tmpStat.Size())
	}
	if err := renameWithRetry(ctx, tmp, path); err != nil {
		_ = os.Remove(tmp)
		return response{}, err
	}
	return response{Status: "optimized", NewSize: tmpStat.Size()}, nil
}

func secondAtom(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	head := make([]byte, 64)
	n, err := io.ReadFull(f, head)
	if err != nil && n < 16 {
		return "", errors.New("ffmpeg: input is not a valid MP4 container")
	}
	if string(head[4:8]) != "ftyp" {
		return "", errors.New("ffmpeg: input is not a valid MP4 container")
	}
	sz := binary.BigEndian.Uint32(head[:4])
	if sz < 8 || sz > 1024 {
		return "", errors.New("ffmpeg: input has an invalid ftyp atom")
	}
	if int(sz)+8 > n {
		buf := make([]byte, 8)
		if _, err := f.ReadAt(buf, int64(sz)); err != nil {
			return "", errors.New("ffmpeg: input is truncated")
		}
		return string(buf[4:8]), nil
	}
	return string(head[sz+4 : sz+8]), nil
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
			return fmt.Errorf("ffmpeg: executable not found")
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

func renameWithRetry(ctx context.Context, from, to string) error {
	var last error
	for i := 0; i < 6; i++ {
		if err := os.Rename(from, to); err == nil {
			return nil
		} else {
			last = err
			if !errors.Is(err, os.ErrPermission) && !errors.Is(err, os.ErrExist) {
				return err
			}
		}
		t := time.NewTimer(time.Duration(200*(1<<i)) * time.Millisecond)
		select {
		case <-ctx.Done():
			t.Stop()
			return ctx.Err()
		case <-t.C:
		}
	}
	// Unix rename is atomic; on Windows an open reader can keep the target
	// locked. Copying then removing is the same last-resort behavior as the
	// old Node implementation.
	in, err := os.Open(from)
	if err != nil {
		return last
	}
	out, err := os.Create(to)
	if err != nil {
		_ = in.Close()
		return last
	}
	_, copyErr := io.Copy(out, in)
	closeErr := errors.Join(out.Close(), in.Close())
	if copyErr != nil || closeErr != nil {
		return errors.Join(copyErr, closeErr)
	}
	return os.Remove(from)
}

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
