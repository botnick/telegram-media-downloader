package app

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func mediaName(stored string) (string, error) {
	stored = strings.ReplaceAll(stored, "\\", "/")
	if strings.ContainsRune(stored, '\x00') || !filepath.IsLocal(stored) || filepath.Clean(stored) == "." {
		return "", os.ErrPermission
	}
	return filepath.Clean(stored), nil
}

// All media reads and unlinks use directory handles. Checking a lexical path
// then reopening it allows symlinks to escape, including during a rename race.
func openMedia(root, stored string) (*os.File, error) {
	name, err := mediaName(stored)
	if err != nil {
		return nil, err
	}
	f, err := os.OpenInRoot(root, name)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		f.Close()
		if err == nil {
			err = os.ErrPermission
		}
		return nil, err
	}
	return f, nil
}

func (a *App) deleteRows(r *http.Request, ids []int64, paths []string) (int64, error) {
	if len(ids)+len(paths) > 2000 {
		return 0, errors.New("delete batch exceeds 2000 items")
	}
	var terms []string
	var args []any
	var marks []string
	for _, id := range ids {
		if id > 0 {
			marks = append(marks, "?")
			args = append(args, id)
		}
	}
	if len(marks) > 0 {
		terms = append(terms, "id IN ("+strings.Join(marks, ",")+")")
	}
	marks = nil
	for _, path := range paths {
		if strings.TrimSpace(path) != "" {
			marks = append(marks, "?")
			args = append(args, strings.ReplaceAll(path, "\\", "/"))
		}
	}
	if len(marks) > 0 {
		terms = append(terms, `REPLACE(file_path, char(92), '/') IN (`+strings.Join(marks, ",")+")")
	}
	if len(terms) == 0 {
		return 0, nil
	}
	return a.deleteByWhere(r, strings.Join(terms, " OR "), args...)
}

func (a *App) deleteByWhere(r *http.Request, where string, args ...any) (int64, error) {
	tx, err := a.db.Writer.BeginTx(r.Context(), nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	err = a.queueDeletedAssets(r.Context(), tx, where, args...)
	if err != nil {
		return 0, err
	}
	_, err = tx.ExecContext(r.Context(), `INSERT OR IGNORE INTO tgdl_file_cleanup(path) SELECT file_path FROM downloads WHERE file_path IS NOT NULL AND file_path<>'' AND (`+where+`)`, args...)
	if err != nil {
		return 0, err
	}
	result, err := tx.ExecContext(r.Context(), `DELETE FROM downloads WHERE `+where, args...)
	if err != nil {
		return 0, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	if err = tx.Commit(); err != nil {
		return 0, err
	}
	return count, errors.Join(a.drainFileCleanup(r.Context()), a.library.CleanDerived(r.Context()))
}

func (a *App) queueDeletedAssets(ctx context.Context, tx *sql.Tx, where string, args ...any) error {
	rows, err := tx.QueryContext(ctx, `SELECT id FROM downloads WHERE `+where, args...)
	if err != nil {
		return err
	}
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err := a.library.InvalidateDerived(ctx, tx, id); err != nil {
			return err
		}
	}
	return nil
}

func queryPaths(ctx context.Context, tx *sql.Tx, query string) ([]string, error) {
	rows, err := tx.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	paths := []string{}
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			return nil, err
		}
		paths = append(paths, path)
	}
	return paths, rows.Err()
}

// Recheck references while holding the SQLite writer lock so another mutation
// cannot add a reference between this check and the unlink. Failures remain in
// the outbox for retry on the next deletion or server start.
func (a *App) drainFileCleanup(ctx context.Context) error {
	tx, err := a.db.Writer.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `UPDATE tgdl_file_cleanup SET path=path WHERE 0`); err != nil {
		return err
	}
	paths, err := queryPaths(ctx, tx, `SELECT path FROM tgdl_file_cleanup`)
	if err != nil {
		return err
	}
	if len(paths) == 0 {
		return tx.Commit()
	}
	rootPath := filepath.Join(a.dataDir, "downloads")
	root, err := os.OpenRoot(rootPath)
	if os.IsNotExist(err) {
		_, err = tx.ExecContext(ctx, `DELETE FROM tgdl_file_cleanup; DELETE FROM tgdl_verified_media`)
		if err != nil {
			return err
		}
		return tx.Commit()
	}
	if err != nil {
		return err
	}
	defer root.Close()
	owned, err := queryPaths(ctx, tx, `SELECT DISTINCT file_path FROM downloads WHERE file_path IS NOT NULL AND file_path<>''`)
	if err != nil {
		return err
	}
	keep := map[string]bool{}
	// Cleaning separators and resolving internal aliases also protects imports
	// from Windows and historical paths containing ./ or directory symlinks.
	key := func(name string) string {
		if real, err := filepath.EvalSymlinks(filepath.Join(rootPath, name)); err == nil {
			return real
		}
		return filepath.Join(rootPath, name)
	}
	for _, path := range owned {
		if name, err := mediaName(path); err == nil {
			keep[key(name)] = true
		}
	}
	var failures []error
	for _, path := range paths {
		name, pathErr := mediaName(path)
		if pathErr == nil && !keep[key(name)] {
			pathErr = root.Remove(name)
		}
		if pathErr != nil && !os.IsNotExist(pathErr) {
			failures = append(failures, fmt.Errorf("media cleanup pending for %q: %w", path, pathErr))
			continue
		}
		if (pathErr == nil || os.IsNotExist(pathErr)) && !keep[key(name)] {
			if _, err := tx.ExecContext(ctx, `DELETE FROM tgdl_verified_media WHERE REPLACE(path,char(92),'/')=?`, filepath.ToSlash(name)); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM tgdl_file_cleanup WHERE path=?`, path); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return errors.Join(failures...)
}
