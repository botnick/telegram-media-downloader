package backup

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Spool ciphertext once so each provider can seek for checksums and retries
// without reusing a nonce against a changed source. Ownership precedes creation.
// Only ciphertext is staged here; snapshot archives have their own lifecycle.
type payloadStage struct {
	file    *os.File
	root    *os.Root
	manager *Manager
	name    string
}

func (m *Manager) stagePayload(ctx context.Context, src *os.File, size int64, key []byte) (*payloadStage, error) {
	if err := payloadSize(size); err != nil {
		return nil, err
	}
	folder := filepath.Join(m.opts.DataDir, "backups")
	if err := os.MkdirAll(folder, 0700); err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(folder)
	if err != nil {
		return nil, err
	}
	name, err := randomSFTPName(".tgdb-stage-")
	if err != nil {
		root.Close()
		return nil, err
	}
	if _, err = m.opts.Writer.ExecContext(ctx, `INSERT INTO native_backup_staging(name) VALUES(?)`, name); err != nil {
		root.Close()
		return nil, err
	}
	s := &payloadStage{root: root, manager: m, name: name}
	s.file, err = root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if errors.Is(err, os.ErrExist) {
		_, saveErr := m.opts.Writer.ExecContext(ctx, `DELETE FROM native_backup_staging WHERE name=?`, name)
		root.Close()
		return nil, errors.Join(err, saveErr)
	}
	if err == nil {
		err = encryptPayload(ctx, s.file, src, size, key)
	}
	if err == nil {
		err = s.file.Sync()
	}
	if err == nil {
		_, err = s.file.Seek(0, io.SeekStart)
	}
	if err != nil {
		return nil, errors.Join(err, s.Close())
	}
	return s, nil
}

func (s *payloadStage) Close() error {
	var err error
	if s.file != nil {
		err = s.file.Close()
		s.file = nil
	}
	removeErr := s.root.Remove(s.name)
	if errors.Is(removeErr, os.ErrNotExist) {
		removeErr = nil
	}
	if removeErr == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, removeErr = s.manager.opts.Writer.ExecContext(ctx, `DELETE FROM native_backup_staging WHERE name=?`, s.name)
		cancel()
	}
	return errors.Join(err, removeErr, s.root.Close())
}

func (m *Manager) recoverPayloadStages(ctx context.Context) error {
	folder := filepath.Join(m.opts.DataDir, "backups")
	root, err := os.OpenRoot(folder)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if root != nil {
		defer root.Close()
	}
	for {
		rows, err := m.opts.Reader.QueryContext(ctx, `SELECT name FROM native_backup_staging ORDER BY name LIMIT 256`)
		if err != nil {
			return err
		}
		names := make([]string, 0, 256)
		for rows.Next() {
			var name string
			if err = rows.Scan(&name); err != nil {
				break
			}
			names = append(names, name)
		}
		err = errors.Join(err, rows.Err(), rows.Close())
		if err != nil {
			return err
		}
		if len(names) == 0 {
			return nil
		}
		for _, name := range names {
			suffix := strings.TrimPrefix(name, ".tgdb-stage-")
			decoded, e := hex.DecodeString(suffix)
			if suffix == name || e != nil || len(decoded) != 16 || filepath.Base(name) != name {
				return errors.New("invalid encrypted backup staging record")
			}
			if root != nil {
				e = root.Remove(name)
				if e != nil && !errors.Is(e, os.ErrNotExist) {
					return fmt.Errorf("remove interrupted encrypted backup stage: %w", e)
				}
			}
			if _, err = m.opts.Writer.ExecContext(ctx, `DELETE FROM native_backup_staging WHERE name=?`, name); err != nil {
				return err
			}
		}
	}
}
