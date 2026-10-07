// Package zipstream streams STORE-mode ZIP archives from files inside the
// configured allow-roots. It deliberately keeps compression disabled: the
// media this app archives is already compressed, so STORE avoids CPU and
// preserves a bounded memory profile for multi-gigabyte downloads.
package zipstream

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

// MaxBytes and MaxEntries match the non-ZIP64 limits enforced by the Node
// bulk-zip route. The archive contains only file bytes; headers are bounded
// separately by MaxEntries and the ZIP name length limit.
const (
	MaxBytes   = uint64(0xfffffffe)
	MaxEntries = 0xfffe
	maxBody    = 32 << 20
)

type entry struct {
	Path string `json:"path"`
	Name string `json:"name"`
}

type request struct {
	Entries []entry `json:"entries"`
}

type resolvedEntry struct {
	path string
	name string
	size int64
	mod  int64
}

// Handler serves POST /v1/zip.
type Handler struct {
	Roots *hash.Roots
	Log   *slog.Logger
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req request
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody))
	if err := dec.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "EINVAL", "body must be JSON {\"entries\": […]}")
		return
	}
	if len(req.Entries) == 0 {
		writeError(w, http.StatusBadRequest, "EINVAL", "entries must be a non-empty array")
		return
	}
	if len(req.Entries) > MaxEntries {
		writeError(w, http.StatusRequestEntityTooLarge, "E2BIG", "too many ZIP entries")
		return
	}

	entries := make([]resolvedEntry, 0, len(req.Entries))
	var total uint64
	for _, in := range req.Entries {
		if !validName(in.Name) {
			writeError(w, http.StatusBadRequest, "EINVAL", "invalid ZIP entry name")
			return
		}
		resolved, err := h.Roots.Resolve(in.Path)
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
			writeError(w, http.StatusUnprocessableEntity, "EISDIR", "ZIP entry is not a regular file")
			return
		}
		if st.Size() < 0 {
			writeError(w, http.StatusUnprocessableEntity, "EIO", "invalid ZIP entry size")
			return
		}
		sz := uint64(st.Size())
		if sz > MaxBytes || total > MaxBytes-sz {
			writeError(w, http.StatusRequestEntityTooLarge, "E2BIG", "selection exceeds non-ZIP64 limit")
			return
		}
		total += sz
		entries = append(entries, resolvedEntry{
			path: resolved,
			name: in.Name,
			size: st.Size(),
			mod:  st.ModTime().UnixNano(),
		})
	}

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Transfer-Encoding", "chunked")
	zw := zip.NewWriter(w)
	for _, e := range entries {
		if err := streamEntry(r.Context(), zw, e); err != nil {
			if h.Log != nil && !errors.Is(err, context.Canceled) {
				h.Log.Debug("zip stream failed", "err", err)
			}
			return
		}
	}
	if err := zw.Close(); err != nil && h.Log != nil {
		h.Log.Debug("zip close failed", "err", err)
	}
}

func streamEntry(ctx context.Context, zw *zip.Writer, e resolvedEntry) error {
	f, err := os.Open(e.path)
	if err != nil {
		return err
	}
	defer f.Close()
	fh := &zip.FileHeader{Name: e.name, Method: zip.Store}
	fh.SetModTime(time.Unix(0, e.mod))
	dst, err := zw.CreateHeader(fh)
	if err != nil {
		return err
	}
	// Read at most one byte past the preflight size. A file that grows while
	// it is being archived must fail rather than silently producing an archive
	// whose central-directory size disagrees with the selected cap.
	reader := io.LimitReader(contextReader{ctx: ctx, r: f}, e.size+1)
	n, err := io.Copy(dst, reader)
	if err != nil {
		return err
	}
	if n != e.size {
		return errors.New("file changed while creating ZIP")
	}
	return nil
}

// contextReader stops a long archive promptly when the browser disconnects.
type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	select {
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	default:
		return r.r.Read(p)
	}
}

func validName(name string) bool {
	if name == "" || !utf8.ValidString(name) || strings.IndexByte(name, 0) >= 0 {
		return false
	}
	if len(name) > 0xffff || strings.HasPrefix(name, "/") || strings.Contains(name, `\`) {
		return false
	}
	clean := path.Clean(name)
	if clean != name || clean == "." {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == ".." || part == "." || part == "" {
			return false
		}
	}
	return true
}

func (h *Handler) writeResolveError(w http.ResponseWriter, err error) {
	code := "EIO"
	var he *hash.Error
	if errors.As(err, &he) {
		code = he.Code
	}
	status := http.StatusUnprocessableEntity
	if code == "EOUTSIDE" {
		status = http.StatusForbidden
	} else if code == "EINVAL" {
		status = http.StatusBadRequest
	}
	writeError(w, status, code, err.Error())
}

func writeFileError(w http.ResponseWriter, err error) {
	code := "EIO"
	if errors.Is(err, os.ErrNotExist) {
		code = "ENOENT"
	}
	writeError(w, http.StatusUnprocessableEntity, code, err.Error())
}

func writeError(w http.ResponseWriter, status int, code, msg string) {
	hash.WriteError(w, status, code, msg)
}
