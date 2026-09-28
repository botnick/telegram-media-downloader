// Package hash streams files through SHA-256.
//
// The digest must be byte-identical to src/core/checksum.js
// (crypto.createHash('sha256') over fs.createReadStream): lowercase hex
// of the whole file, read until EOF. Files are read with a 1 MiB buffer
// and the context is checked between reads, so a caller that gives up
// (timeout, disconnect) stops the read and frees the slot quickly.
package hash

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// BufferSize is the read size per syscall.
const BufferSize = 1 << 20

// Result is what POST /v1/hash returns on success.
type Result struct {
	SHA256 string `json:"sha256"`
	// Size is the number of bytes hashed.
	Size int64 `json:"size"`
	// MtimeMs is the modification time in milliseconds since the epoch,
	// like fs.Stats.mtimeMs, taken from the open file before reading.
	MtimeMs float64 `json:"mtimeMs"`
}

// Error carries a Node-style error code (ENOENT, EACCES, ...).
type Error struct {
	Code string
	Path string
	Err  error
}

func (e *Error) Error() string {
	if e.Err == nil {
		return fmt.Sprintf("%s: %s", e.Code, e.Path)
	}
	return fmt.Sprintf("%s: %v", e.Code, e.Err)
}

func (e *Error) Unwrap() error { return e.Err }

var bufPool = sync.Pool{New: func() any {
	b := make([]byte, BufferSize)
	return &b
}}

// File hashes the file at path, which must be absolute.
func File(ctx context.Context, path string) (Result, error) {
	if path == "" || strings.IndexByte(path, 0) >= 0 {
		return Result{}, &Error{Code: "EINVAL", Path: path, Err: errors.New("path must be a non-empty string without NUL bytes")}
	}
	if !filepath.IsAbs(path) {
		return Result{}, &Error{Code: "EINVAL", Path: path, Err: errors.New("path must be absolute")}
	}
	if err := ctx.Err(); err != nil {
		return Result{}, &Error{Code: "ECANCELED", Path: path, Err: err}
	}

	f, err := openShared(path)
	if err != nil {
		// Some platforms refuse to open a directory for reading (Windows
		// answers "access denied"); report it the way Node does.
		if st, serr := os.Stat(path); serr == nil && st.IsDir() {
			return Result{}, &Error{Code: "EISDIR", Path: path, Err: fmt.Errorf("illegal operation on a directory, read '%s'", path)}
		}
		return Result{}, classify(path, err)
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil {
		return Result{}, classify(path, err)
	}
	if st.IsDir() {
		return Result{}, &Error{Code: "EISDIR", Path: path, Err: fmt.Errorf("illegal operation on a directory, read '%s'", path)}
	}

	bp := bufPool.Get().(*[]byte)
	defer bufPool.Put(bp)
	buf := *bp

	h := sha256.New()
	var n int64
	for {
		if err := ctx.Err(); err != nil {
			return Result{}, &Error{Code: "ECANCELED", Path: path, Err: err}
		}
		m, rerr := f.Read(buf)
		if m > 0 {
			h.Write(buf[:m])
			n += int64(m)
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return Result{}, classify(path, rerr)
		}
	}
	return Result{
		SHA256:  hex.EncodeToString(h.Sum(nil)),
		Size:    n,
		MtimeMs: MtimeMs(st.ModTime()),
	}, nil
}

// MtimeMs converts a modification time to fs.Stats.mtimeMs units.
func MtimeMs(t time.Time) float64 {
	return float64(t.UnixNano()) / 1e6
}

// classify maps an OS error to the error code Node would report for the
// same failure. Anything unrecognised during open/read is EIO.
func classify(path string, err error) *Error {
	var he *Error
	if errors.As(err, &he) {
		return he
	}
	code := "EIO"
	var errno syscall.Errno
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		code = "ECANCELED"
	case errors.As(err, &errno) && platformCode(errno) != "":
		code = platformCode(errno)
	case errors.Is(err, fs.ErrNotExist):
		code = "ENOENT"
	case errors.Is(err, fs.ErrPermission):
		code = "EACCES"
	}
	return &Error{Code: code, Path: path, Err: err}
}
