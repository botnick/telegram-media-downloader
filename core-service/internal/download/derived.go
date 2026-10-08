package download

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

func (l *Library) invalidateDerived(ctx context.Context, tx *sql.Tx, id int64) error {
	sum := sha256.Sum256([]byte(strconv.FormatInt(id, 10) + ":320"))
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO tgdl_derived_cleanup(area,path) VALUES('thumbs',?)`, hex.EncodeToString(sum[:])[:32]+".webp"); err != nil {
		return err
	}
	var sprite, meta string
	err := tx.QueryRowContext(ctx, `SELECT sprite_path,meta_path FROM seekbar_sprites WHERE download_id=?`, id).Scan(&sprite, &meta)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	for _, name := range []string{sprite, meta} {
		if name == "" {
			continue
		}
		if filepath.IsAbs(name) {
			var err error
			name, err = filepath.Rel(filepath.Join(l.dataDir, "seekbar"), name)
			if err != nil {
				return err
			}
		}
		if !filepath.IsLocal(name) {
			return fmt.Errorf("seekbar cache path is outside cache root")
		}
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO tgdl_derived_cleanup(area,path) VALUES('seekbar',?)`, filepath.ToSlash(name)); err != nil {
			return err
		}
	}
	for _, table := range []string{"image_embeddings", "image_tags", "faces", "seekbar_sprites"} {
		if _, err := tx.ExecContext(ctx, "DELETE FROM "+table+" WHERE download_id=?", id); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, `UPDATE downloads SET nsfw_score=NULL,nsfw_checked_at=NULL,nsfw_whitelist=0,ai_indexed_at=NULL WHERE id=?`, id)
	return err
}

func (l *Library) cleanDerived(ctx context.Context) error {
	tx, err := l.writer.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `UPDATE tgdl_derived_cleanup SET path=path WHERE 0`); err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, `SELECT area,path FROM tgdl_derived_cleanup`)
	if err != nil {
		return err
	}
	type entry struct{ area, path string }
	var entries []entry
	for rows.Next() {
		var e entry
		if err = rows.Scan(&e.area, &e.path); err != nil {
			rows.Close()
			return err
		}
		entries = append(entries, e)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.area != "thumbs" && e.area != "seekbar" {
			return errors.New("invalid derived cache area")
		}
		root, openErr := os.OpenRoot(filepath.Join(l.dataDir, e.area))
		if openErr != nil && !os.IsNotExist(openErr) {
			return openErr
		}
		if openErr == nil {
			err = root.Remove(e.path)
			root.Close()
			if err != nil && !os.IsNotExist(err) {
				return err
			}
		}
		if _, err = tx.ExecContext(ctx, `DELETE FROM tgdl_derived_cleanup WHERE area=? AND path=?`, e.area, e.path); err != nil {
			return err
		}
	}
	return tx.Commit()
}
