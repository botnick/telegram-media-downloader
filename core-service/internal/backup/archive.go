package backup

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

func (m *Manager) prepareSnapshot(ctx context.Context, d destination, j job) (string, string, error) {
	folder := filepath.Join(m.opts.DataDir, "backups")
	if err := os.MkdirAll(folder, 0700); err != nil {
		return "", "", err
	}
	archive := j.Snapshot.String
	remote := j.Remote.String
	if !j.Snapshot.Valid {
		// Reserve distinct seconds in SQLite across destinations and rapid runs.
		// A stable name survives a crash before/during archive construction.
		for stamp := time.Now(); ; stamp = stamp.Add(time.Second) {
			name := "snapshot-" + stamp.Format("20060102-150405") + ".tar.gz"
			archive = filepath.Join(folder, name)
			var n int
			if err := m.opts.Reader.QueryRowContext(ctx, `SELECT count(*) FROM backup_jobs WHERE snapshot_path=?`, archive).Scan(&n); err != nil {
				return "", "", err
			}
			if n > 0 {
				continue
			}
			if _, err := os.Lstat(archive); !errors.Is(err, fs.ErrNotExist) {
				if err != nil {
					return "", "", err
				}
				continue
			}
			remote = "snapshots/" + name
			res, err := m.opts.Writer.ExecContext(ctx, `UPDATE backup_jobs SET snapshot_path=?,remote_path=? WHERE id=? AND NOT EXISTS(SELECT 1 FROM backup_jobs WHERE snapshot_path=?)`, archive, remote, j.ID, archive)
			if err != nil {
				return "", "", err
			}
			n64, err := res.RowsAffected()
			if err != nil {
				return "", "", err
			}
			if n64 > 0 {
				break
			}
		}
	}
	if filepath.Dir(archive) != folder || !snapshotName.MatchString(filepath.Base(archive)) {
		return "", "", errors.New("invalid staged snapshot path")
	}
	if info, err := os.Lstat(archive); err == nil {
		if !info.Mode().IsRegular() {
			return "", "", errors.New("snapshot is not a regular file")
		}
		return archive, remote, nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return "", "", err
	}
	if m.opts.LockSnapshot != nil {
		unlock := m.opts.LockSnapshot()
		defer unlock()
	}
	out, err := os.CreateTemp(folder, ".snapshot-archive-")
	if err != nil {
		return "", "", err
	}
	defer os.Remove(out.Name())
	defer out.Close()
	if _, err = writeStateArchive(ctx, m.opts.Writer, m.opts.DataDir, folder, out, nil); err != nil {
		return "", "", err
	}
	if err = out.Sync(); err != nil {
		return "", "", err
	}
	if err = out.Close(); err != nil {
		return "", "", err
	}
	if err = ctx.Err(); err != nil {
		return "", "", err
	}
	if err = os.Rename(out.Name(), archive); err != nil {
		return "", "", err
	}
	m.Log("info", fmt.Sprintf("snapshot built %s → enqueued for #%d", archive, d.ID))
	return archive, remote, nil
}
