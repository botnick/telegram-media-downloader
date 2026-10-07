// Package tarstream writes a bounded-memory tar.gz snapshot from an allowed
// directory. The Node backup manager still owns the SQLite consistent copy;
// tgdl-core owns the CPU-heavy archive walk and compression.
package tarstream

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

const maxBody = 64 << 10

var copyBufPool = sync.Pool{New: func() any { return make([]byte, 256<<10) }}

type request struct {
	Root string `json:"root"`
}

// Handler streams a USTAR/PAX-compatible gzip archive of one allowed root.
// The root itself is not included as a top-level directory; entries use paths
// relative to it, matching the existing Node snapshot format.
type Handler struct {
	Roots *hash.Roots
	Log   *slog.Logger
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req request
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody))
	if err := dec.Decode(&req); err != nil || strings.TrimSpace(req.Root) == "" {
		writeError(w, http.StatusBadRequest, "EINVAL", `body must be JSON {"root": "/abs/staging"}`)
		return
	}
	root, err := h.Roots.Resolve(req.Root)
	if err != nil {
		h.writeResolveError(w, err)
		return
	}
	st, err := os.Stat(root)
	if err != nil {
		writeFileError(w, err)
		return
	}
	if !st.IsDir() {
		writeError(w, http.StatusUnprocessableEntity, "ENOTDIR", "archive root is not a directory")
		return
	}

	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Cache-Control", "no-store")
	// DefaultCompression keeps backup CPU bounded while retaining useful
	// reduction for SQLite/text payloads. The backup is not a media archive.
	gz, err := gzip.NewWriterLevel(w, gzip.DefaultCompression)
	if err != nil {
		return
	}
	tw := tar.NewWriter(gz)
	err = walk(r.Context(), root, tw)
	if err == nil {
		err = tw.Close()
	}
	if err == nil {
		err = gz.Close()
	} else {
		_ = tw.Close()
		_ = gz.Close()
	}
	if err != nil && h.Log != nil && !errors.Is(err, context.Canceled) {
		h.Log.Debug("tar.gz stream failed", "err", err)
	}
}

func walk(ctx context.Context, root string, tw *tar.Writer) error {
	return filepath.WalkDir(root, func(abs string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if abs == root {
			return nil
		}
		// Do not follow links from a backup staging directory. Node's copy
		// path historically followed them, but refusing them keeps an archive
		// request from escaping the configured root.
		if entry.Type()&os.ModeSymlink != 0 {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, abs)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if entry.IsDir() {
			return tw.WriteHeader(&tar.Header{
				Name:     rel + "/",
				Mode:     0o755,
				ModTime:  info.ModTime(),
				Typeflag: tar.TypeDir,
				Format:   tar.FormatPAX,
			})
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		if err := tw.WriteHeader(&tar.Header{
			Name:    rel,
			Mode:    0o644,
			Size:    info.Size(),
			ModTime: info.ModTime(),
			Format:  tar.FormatPAX,
		}); err != nil {
			return err
		}
		f, err := os.Open(abs)
		if err != nil {
			return err
		}
		buf := copyBufPool.Get().([]byte)
		n, copyErr := io.CopyBuffer(tw, contextReader{ctx: ctx, r: f}, buf)
		copyBufPool.Put(buf)
		closeErr := f.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		if n != info.Size() {
			return errors.New("file changed while creating tar.gz")
		}
		return nil
	})
}

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

type errorBody struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	var body errorBody
	body.Error.Code = code
	body.Error.Message = message
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
