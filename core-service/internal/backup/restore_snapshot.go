package backup

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/botnick/telegram-media-downloader/core-service/internal/cluster"
	"github.com/botnick/telegram-media-downloader/core-service/internal/filepublish"
	_ "modernc.org/sqlite"
)

type RestoreOptions struct {
	Passphrase string
	Salt       []byte
	Plaintext  bool
	MaxBytes   int64
	MaxFiles   int
}
type RestoreResult struct {
	Files int
	Bytes int64
}

// RestoreSnapshot restores into a new, inactive data directory. Authentication,
// archive validation and SQLite integrity checks precede atomic publication.
// It never writes over a running or pre-existing data directory.
func RestoreSnapshot(ctx context.Context, input, output string, opts RestoreOptions) (result RestoreResult, err error) {
	if opts.MaxBytes == 0 {
		opts.MaxBytes = 16 << 30
	}
	if opts.MaxFiles == 0 {
		opts.MaxFiles = 100000
	}
	if opts.MaxBytes < 1 || opts.MaxBytes > 1<<50 || opts.MaxFiles < 1 || opts.MaxFiles > 1000000 {
		return result, errors.New("invalid snapshot extraction limits")
	}
	output = filepath.Clean(output)
	parent, name := filepath.Dir(output), filepath.Base(output)
	if name == "." || name == ".." || name == string(filepath.Separator) {
		return result, errors.New("invalid restore directory")
	}
	root, err := os.OpenRoot(parent)
	if err != nil {
		return result, err
	}
	defer root.Close()
	if _, err = root.Lstat(name); err == nil {
		return result, os.ErrExist
	} else if !errors.Is(err, os.ErrNotExist) {
		return result, err
	}
	stage, err := randomSFTPName(".tgdb-restore-dir-")
	if err != nil {
		return result, err
	}
	if err = root.Mkdir(stage, 0700); err != nil {
		return result, err
	}
	defer root.RemoveAll(stage)
	private, err := root.OpenRoot(stage)
	if err != nil {
		return result, err
	}
	defer private.Close()
	source, err := os.Open(input)
	if err != nil {
		return result, err
	}
	defer source.Close()
	info, err := source.Stat()
	if err != nil {
		return result, err
	}
	if !info.Mode().IsRegular() {
		return result, errors.New("snapshot input is not a regular file")
	}
	archive := source
	if !opts.Plaintext {
		key, e := payloadKey(opts.Passphrase, opts.Salt)
		if e != nil {
			return result, e
		}
		defer clear(key)
		archive, err = private.OpenFile(".archive", os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
		if err != nil {
			return result, err
		}
		defer archive.Close()
		if err = decryptPayload(ctx, archive, source, info.Size(), key); err != nil {
			return result, err
		}
		if _, err = archive.Seek(0, io.SeekStart); err != nil {
			return result, err
		}
	}
	result, err = extractSnapshot(ctx, archive, private, opts)
	if err != nil {
		return result, err
	}
	if archive != source {
		if err = archive.Close(); err != nil {
			return result, err
		}
		if err = private.Remove(".archive"); err != nil {
			return result, err
		}
	}
	if err = validateRestoredDatabase(ctx, filepath.Join(parent, stage, "db.sqlite")); err != nil {
		return result, err
	}
	if err = resetRestoredCatalog(ctx, filepath.Join(parent, stage, "db.sqlite")); err != nil {
		return result, err
	}
	if err = ctx.Err(); err != nil {
		return result, err
	}
	if err = private.Close(); err != nil {
		return result, err
	}
	dir, err := root.Open(".")
	if err != nil {
		return result, err
	}
	defer dir.Close()
	err = filepublish.ExclusiveAt(dir, stage, name)
	return result, err
}

func resetRestoredCatalog(ctx context.Context, name string) error {
	abs, err := filepath.Abs(name)
	if err != nil {
		return err
	}
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(abs), RawQuery: "mode=rw"}
	if !strings.HasPrefix(u.Path, "/") {
		u.Path = "/" + u.Path
	}
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return err
	}
	db.SetMaxOpenConns(1)
	defer db.Close()
	// The staged archive contains one database, never a live WAL sidecar.
	if _, err = db.ExecContext(ctx, `PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL`); err != nil {
		return err
	}
	if err = (cluster.Store{Writer: db}).RotateCatalogEpoch(ctx); err != nil {
		return err
	}
	return db.Close()
}

func extractSnapshot(ctx context.Context, src io.Reader, root *os.Root, opts RestoreOptions) (result RestoreResult, err error) {
	gz, err := gzip.NewReader(contextReader{ctx, src})
	if err != nil {
		return result, err
	}
	defer gz.Close()
	// Bound even tar padding/extended headers, in addition to per-entry limits.
	budget := &io.LimitedReader{R: contextReader{ctx, gz}, N: opts.MaxBytes + int64(opts.MaxFiles)*4096 + (1 << 20)}
	tr := tar.NewReader(budget)
	var database, nativeSession, secret bool
	buffer := make([]byte, 64<<10)
	defer clear(buffer)
	for entries := 0; ; entries++ {
		h, e := tr.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			return result, e
		}
		if entries >= opts.MaxFiles {
			return result, errors.New("snapshot contains too many entries")
		}
		name := strings.TrimPrefix(h.Name, "./")
		if h.Typeflag == tar.TypeDir {
			name = strings.TrimSuffix(name, "/")
			if name == "" || name == "." {
				continue
			}
		}
		if e = validObject(name); e != nil {
			return result, e
		}
		allowed := name == "db.sqlite" || name == "config.json" || name == "secret.key" || name == "sessions" || strings.HasPrefix(name, "sessions/")
		if !allowed {
			return result, fmt.Errorf("unsupported snapshot entry %q", name)
		}
		if h.Typeflag == tar.TypeDir {
			if name != "sessions" && !strings.HasPrefix(name, "sessions/") {
				return result, errors.New("snapshot data file is a directory")
			}
			if err = root.MkdirAll(name, 0700); err != nil {
				return result, err
			}
			continue
		}
		if h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeRegA {
			return result, errors.New("snapshot links and special files are forbidden")
		}
		if name == "sessions" || h.Size < 0 || h.Size > opts.MaxBytes-result.Bytes {
			return result, errors.New("snapshot extraction limit exceeded or invalid entry")
		}
		if err = root.MkdirAll(path.Dir(name), 0700); err != nil {
			return result, err
		}
		out, e := root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			return result, e
		}
		n, copyErr := io.CopyBuffer(out, contextReader{ctx, tr}, buffer)
		syncErr := out.Sync()
		closeErr := out.Close()
		if e = errors.Join(copyErr, syncErr, closeErr); e != nil {
			return result, e
		}
		if n != h.Size {
			return result, io.ErrUnexpectedEOF
		}
		result.Files++
		result.Bytes += n
		if name == "db.sqlite" {
			database = true
		}
		if name == "secret.key" {
			secret = n > 0
		}
		if strings.HasPrefix(name, "sessions/native/") && strings.HasSuffix(name, ".enc") {
			nativeSession = true
		}
		if name == "config.json" {
			if n > 16<<20 {
				return result, errors.New("snapshot config is too large")
			}
			b, e := root.ReadFile(name)
			if e != nil {
				return result, e
			}
			var value map[string]any
			if e = json.Unmarshal(b, &value); e != nil || value == nil {
				return result, errors.New("snapshot config is not a JSON object")
			}
		}
	}
	// Read through gzip's checksum after tar's end markers. Only bounded zero
	// record padding is allowed; a second hidden archive/data stream is rejected.
	padding, err := io.ReadAll(io.LimitReader(budget, (1<<20)+1))
	if err != nil {
		return result, err
	}
	if len(padding) > 1<<20 || budget.N == 0 {
		return result, errors.New("excessive snapshot padding")
	}
	for _, v := range padding {
		if v != 0 {
			return result, errors.New("unexpected data after snapshot archive")
		}
	}
	if !database {
		return result, errors.New("snapshot has no database")
	}
	if nativeSession && !secret {
		return result, errors.New("native session backup is missing secret.key")
	}
	return result, nil
}

func validateRestoredDatabase(ctx context.Context, name string) error {
	abs, err := filepath.Abs(name)
	if err != nil {
		return err
	}
	uriPath := filepath.ToSlash(abs)
	if !strings.HasPrefix(uriPath, "/") {
		uriPath = "/" + uriPath
	}
	u := url.URL{Scheme: "file", Path: uriPath, RawQuery: "mode=ro&immutable=1"}
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	var integrity string
	if err = db.QueryRowContext(ctx, `PRAGMA integrity_check`).Scan(&integrity); err != nil {
		return fmt.Errorf("restored database integrity: %w", err)
	}
	if integrity != "ok" {
		return errors.New("restored database failed integrity check")
	}
	var tables int
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('downloads','kv')`).Scan(&tables); err != nil {
		return err
	}
	if tables != 2 {
		return errors.New("snapshot database is not a downloader library")
	}
	return nil
}
