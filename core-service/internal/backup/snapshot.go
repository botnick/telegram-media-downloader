// Package backup implements restart-safe SQLite snapshots without involving a
// second runtime. SQLite's VACUUM INTO gives a consistent copy while readers
// continue to use WAL.
package backup

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Result struct {
	Path   string `json:"path"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}

func Snapshot(ctx context.Context, db *sql.DB, destination, label string) (Result, error) {
	if db == nil {
		return Result{}, errors.New("database is nil")
	}
	if strings.TrimSpace(destination) == "" {
		return Result{}, errors.New("backup destination is required")
	}
	label = sanitizeLabel(label)
	if err := os.MkdirAll(destination, 0o700); err != nil {
		return Result{}, fmt.Errorf("create backup destination: %w", err)
	}
	timestamp := time.Now().UTC().Format("20060102T150405.000000000Z")
	finalPath := filepath.Join(destination, fmt.Sprintf("%s-%s.sqlite", label, timestamp))
	tmp, err := os.CreateTemp(destination, ".tgdl-backup-*.sqlite")
	if err != nil {
		return Result{}, fmt.Errorf("create backup temp file: %w", err)
	}
	tmpPath := tmp.Name()
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return Result{}, err
	}
	defer os.Remove(tmpPath)
	if _, err := db.ExecContext(ctx, `VACUUM INTO ?`, tmpPath); err != nil {
		return Result{}, fmt.Errorf("snapshot SQLite database: %w", err)
	}
	if err := syncFile(tmpPath); err != nil {
		return Result{}, err
	}
	if err := os.Rename(tmpPath, finalPath); err != nil {
		return Result{}, fmt.Errorf("publish backup: %w", err)
	}
	result, err := checksum(finalPath)
	if err != nil {
		return Result{}, err
	}
	result.Path = finalPath
	return result, nil
}

func sanitizeLabel(label string) string {
	label = strings.TrimSpace(label)
	if label == "" {
		return "backup"
	}
	var b strings.Builder
	for _, r := range label {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		}
	}
	if b.Len() == 0 {
		return "backup"
	}
	return b.String()
}

func syncFile(path string) error {
	f, err := os.OpenFile(path, os.O_RDONLY, 0)
	if err != nil {
		return fmt.Errorf("open backup for sync: %w", err)
	}
	defer f.Close()
	if err := f.Sync(); err != nil {
		return fmt.Errorf("sync backup: %w", err)
	}
	return nil
}

func checksum(path string) (Result, error) {
	f, err := os.Open(path)
	if err != nil {
		return Result{}, fmt.Errorf("open backup: %w", err)
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return Result{}, fmt.Errorf("hash backup: %w", err)
	}
	return Result{Bytes: n, SHA256: hex.EncodeToString(h.Sum(nil))}, nil
}
