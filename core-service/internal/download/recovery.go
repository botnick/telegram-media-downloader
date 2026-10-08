package download

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// Recover must run once before accepting new transfers. A synced, published
// file is verified and cataloged without network I/O. Incomplete transfers
// remain the responsibility of the persistent work queue; their partial files
// are removed so the next attempt starts from a known state.
func (l *Library) Recover(ctx context.Context) error {
	rows, err := l.reader.QueryContext(ctx, `SELECT path,item,sha256,generation FROM tgdl_ingest_files`)
	if err != nil {
		return err
	}
	type entry struct {
		path, payload, sum string
		generation         int64
	}
	var pending []entry
	for rows.Next() {
		var p entry
		if err = rows.Scan(&p.path, &p.payload, &p.sum, &p.generation); err != nil {
			rows.Close()
			return err
		}
		pending = append(pending, p)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	root, err := os.OpenRoot(l.root)
	if err != nil {
		return err
	}
	defer root.Close()
	for _, p := range pending {
		if err = ctx.Err(); err != nil {
			return err
		}
		var item Item
		if err = json.Unmarshal([]byte(p.payload), &item); err != nil {
			return fmt.Errorf("invalid ingest journal: %w", err)
		}
		item.generation = p.generation
		var current int64
		if err = l.reader.QueryRowContext(ctx, `SELECT generation FROM tgdl_message_generations WHERE group_id=? AND message_id=?`, item.GroupID, item.MessageID).Scan(&current); err != nil {
			return err
		}
		if current != p.generation {
			var owners int
			if err = l.reader.QueryRowContext(ctx, `SELECT count(*) FROM downloads WHERE file_path=?`, p.path).Scan(&owners); err != nil {
				return err
			}
			if owners == 0 {
				if err = root.Remove(p.path); err != nil && !os.IsNotExist(err) {
					return err
				}
			}
			if err = root.Remove(filepath.Join(filepath.Dir(p.path), partName(filepath.Base(p.path)))); err != nil && !os.IsNotExist(err) {
				return err
			}
			if _, err = l.writer.ExecContext(ctx, `DELETE FROM tgdl_ingest_files WHERE path=?`, p.path); err != nil {
				return err
			}
			continue
		}
		f, info, openErr := l.open(p.path)
		if openErr != nil && !os.IsNotExist(openErr) {
			return openErr
		}
		if openErr == nil {
			beforeStamp, err := fileFingerprint(f, info)
			if err != nil {
				f.Close()
				return err
			}
			h := sha256.New()
			_, hashErr := io.Copy(h, &contextReader{ctx: ctx, r: f})
			after, statErr := f.Stat()
			var afterStamp string
			if statErr == nil {
				afterStamp, statErr = fileFingerprint(f, after)
			}
			f.Close()
			if hashErr != nil {
				return hashErr
			}
			if statErr != nil {
				return statErr
			}
			if p.sum == "" || info.Size() != item.Identity.Size || !sameMedia(info, after) || beforeStamp != afterStamp || hex.EncodeToString(h.Sum(nil)) != p.sum {
				return fmt.Errorf("incomplete or changed published media %q; retained for inspection", p.path)
			}
			if _, found, err := l.reuse(ctx, item, `d.file_hash=? AND d.file_size=?`, p.sum, item.Identity.Size); err != nil {
				return err
			} else if found {
				// This includes a commit that succeeded before its acknowledgement.
				var referenced int
				if err = l.reader.QueryRowContext(ctx, `SELECT count(*) FROM downloads WHERE file_path=?`, p.path).Scan(&referenced); err != nil {
					return err
				}
				if referenced == 0 {
					if err = root.Remove(p.path); err != nil && !os.IsNotExist(err) {
						return err
					}
				}
			} else if _, err = l.register(ctx, item, candidate{path: p.path, sha256: p.sum, info: after, fingerprint: afterStamp}, false); err != nil {
				return err
			}
		}
		part := filepath.Join(filepath.Dir(p.path), partName(filepath.Base(p.path)))
		if err = root.Remove(part); err != nil && !os.IsNotExist(err) {
			return err
		}
		if _, err = l.writer.ExecContext(ctx, `DELETE FROM tgdl_ingest_files WHERE path=?`, p.path); err != nil {
			return err
		}
	}
	return l.cleanDerived(ctx)
}

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r *contextReader) Read(b []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(b)
}
