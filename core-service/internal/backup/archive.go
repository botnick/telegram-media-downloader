package backup

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
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
	staging, err := os.MkdirTemp(folder, ".snapshot-stage-")
	if err != nil {
		return "", "", err
	}
	defer os.RemoveAll(staging)
	snap, err := Snapshot(ctx, m.opts.Writer, staging, "database")
	if err != nil {
		return "", "", err
	}
	out, err := os.CreateTemp(folder, ".snapshot-archive-")
	if err != nil {
		return "", "", err
	}
	defer os.Remove(out.Name())
	defer out.Close()
	zw := gzip.NewWriter(out)
	tw := tar.NewWriter(zw)
	appendFile := func(name string, file *os.File) error {
		defer file.Close()
		info, e := file.Stat()
		if e != nil {
			return e
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("snapshot entry %q is not a regular file", name)
		}
		header := &tar.Header{Name: name, Mode: 0600, Size: info.Size(), ModTime: info.ModTime(), Typeflag: tar.TypeReg}
		if e = tw.WriteHeader(header); e != nil {
			return e
		}
		n, e := io.Copy(tw, contextReader{ctx, file})
		if e != nil {
			return e
		}
		if n != info.Size() {
			return errors.New("snapshot source size changed")
		}
		return nil
	}
	f, err := os.Open(snap.Path)
	if err != nil {
		return "", "", err
	}
	if err = appendFile("db.sqlite", f); err != nil {
		return "", "", err
	}
	root, err := os.OpenRoot(m.opts.DataDir)
	if err != nil {
		return "", "", err
	}
	defer root.Close()
	// The native session key is essential to restore encrypted account sessions.
	for _, name := range []string{"config.json", "secret.key"} {
		info, e := root.Lstat(name)
		if errors.Is(e, fs.ErrNotExist) {
			continue
		}
		if e != nil {
			return "", "", e
		}
		if !info.Mode().IsRegular() {
			return "", "", fmt.Errorf("snapshot entry %s is not regular", name)
		}
		f, e := root.Open(name)
		if e != nil {
			return "", "", e
		}
		if e = appendFile(name, f); e != nil {
			return "", "", e
		}
	}
	err = fs.WalkDir(root.FS(), "sessions", func(name string, entry fs.DirEntry, e error) error {
		if errors.Is(e, fs.ErrNotExist) && name == "sessions" {
			return fs.SkipAll
		}
		if e != nil {
			return e
		}
		if e = ctx.Err(); e != nil {
			return e
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("snapshot refuses session symlink %s", name)
		}
		if entry.IsDir() {
			return nil
		}
		f, e := root.Open(name)
		if e != nil {
			return e
		}
		return appendFile(strings.ReplaceAll(name, "\\", "/"), f)
	})
	if err != nil {
		return "", "", err
	}
	if err = tw.Close(); err != nil {
		return "", "", err
	}
	if err = zw.Close(); err != nil {
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
