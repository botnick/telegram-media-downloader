package download

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
)

// Item describes one fresh Telegram message. The stable media identity is
// independent of its message, group and filename; each message retains its own
// catalog row even when several messages reuse the same physical file.
type Item struct {
	GroupID    string
	GroupName  string
	MessageID  int64
	Name       string
	Type       string
	Identity   telegram.MediaIdentity
	generation int64
}

type Record struct {
	ID     int64
	Path   string
	SHA256 string
	Reused bool
}

// Library uses the existing downloads table as its durable identity index.
// Only active transfers have in-memory entries, bounded by the worker limit.
// It shares the app's SQLite writer with deletion and cleanup.
type Library struct {
	writer, reader *sql.DB
	root           string
	dataDir        string
	mu             sync.Mutex
	flights        map[string]chan struct{}
	slots          chan struct{}
}

func NewLibrary(writer, reader *sql.DB, root string, workers int) (*Library, error) {
	if writer == nil || reader == nil || root == "" || workers < 1 || workers > 64 {
		return nil, errors.New("invalid media library configuration")
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	configuredRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	return &Library{writer: writer, reader: reader, root: root, dataDir: filepath.Dir(configuredRoot), flights: make(map[string]chan struct{}), slots: make(chan struct{}, workers)}, nil
}

// enter coalesces identity/content work, including wait cancellation. It does
// not retain completed IDs; completed media is looked up in SQLite next time.
func (l *Library) enter(ctx context.Context, key string) (func(), error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		l.mu.Lock()
		if done, ok := l.flights[key]; ok {
			l.mu.Unlock()
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-done:
				continue
			}
		}
		done := make(chan struct{})
		l.flights[key] = done
		l.mu.Unlock()
		return func() { l.mu.Lock(); delete(l.flights, key); close(done); l.mu.Unlock() }, nil
	}
}

func (l *Library) Ingest(ctx context.Context, item Item, client Client) (Record, error) {
	item.GroupID = strings.TrimSpace(item.GroupID)
	item.Identity.Kind = strings.ToLower(strings.TrimSpace(item.Identity.Kind))
	item.Identity.ID = strings.TrimSpace(item.Identity.ID)
	if !item.Identity.Valid() || item.GroupID == "" || item.MessageID <= 0 {
		return Record{}, ErrInvalidIdentity
	}
	select {
	case l.slots <- struct{}{}:
		defer func() { <-l.slots }()
	case <-ctx.Done():
		return Record{}, ctx.Err()
	}
	messageRelease, err := l.enter(ctx, "message:"+item.GroupID+":"+strconv.FormatInt(item.MessageID, 10))
	if err != nil {
		return Record{}, err
	}
	defer messageRelease()
	if err := l.writer.QueryRowContext(ctx, `INSERT INTO tgdl_message_generations(group_id,message_id,generation) VALUES(?,?,1)
      ON CONFLICT(group_id,message_id) DO UPDATE SET generation=generation+1 RETURNING generation`, item.GroupID, item.MessageID).Scan(&item.generation); err != nil {
		return Record{}, err
	}
	release, err := l.enter(ctx, "identity:"+item.Identity.Key())
	if err != nil {
		return Record{}, err
	}
	defer release()
	if record, found, err := l.reuse(ctx, item, `d.telegram_media_kind=? AND d.telegram_media_id=? AND (d.telegram_media_size=? OR (d.telegram_media_size IS NULL AND d.file_size=?))`, item.Identity.Kind, item.Identity.ID, item.Identity.Size, item.Identity.Size); err != nil || found {
		return record, err
	}
	if client == nil {
		return Record{}, errors.New("Telegram download client is unavailable")
	}
	relative, err := l.destination(item)
	if err != nil {
		return Record{}, err
	}
	payload, err := json.Marshal(item)
	if err != nil {
		return Record{}, err
	}
	if _, err = l.writer.ExecContext(ctx, `INSERT INTO tgdl_ingest_files(path,item,generation) VALUES(?,?,?)`, filepath.ToSlash(relative), string(payload), item.generation); err != nil {
		return Record{}, err
	}
	digest := sha256.New()
	// The per-transfer handoff owns exactly one identity; the durable library
	// owns all cross-message coalescing and does not retain this temporary map.
	m := NewManager(hashClient{client, digest}, telegram.NewDedupIndex())
	m.prepared = func() error {
		_, err := l.writer.ExecContext(ctx, `UPDATE tgdl_ingest_files SET sha256=? WHERE path=?`, hex.EncodeToString(digest.Sum(nil)), filepath.ToSlash(relative))
		return err
	}
	root, err := os.OpenRoot(l.root)
	if err != nil {
		return Record{}, err
	}
	defer root.Close()
	path, err := m.DownloadInRoot(ctx, item.Identity, root, relative)
	if err != nil {
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_, cleanupErr := l.writer.ExecContext(cleanupCtx, `DELETE FROM tgdl_ingest_files WHERE path=?`, filepath.ToSlash(relative))
		return Record{}, errors.Join(err, cleanupErr)
	}
	f, info, err := l.open(relative)
	if err != nil {
		return Record{}, err
	}
	fingerprint, stampErr := fileFingerprint(f, info)
	f.Close()
	if stampErr != nil {
		return Record{}, stampErr
	}
	sum := hex.EncodeToString(digest.Sum(nil))
	contentRelease, err := l.enter(ctx, "sha256:"+sum)
	if err != nil {
		return Record{}, err
	}
	defer contentRelease()
	if record, found, err := l.reuse(ctx, item, `d.file_hash=? AND d.file_size=?`, sum, item.Identity.Size); err != nil {
		return Record{}, err
	} else if found {
		// No catalog entry has ever named our unique destination. Deleting
		// only this transfer's file cannot remove another message's media.
		if err := root.Remove(path); err != nil {
			return record, fmt.Errorf("remove redundant downloaded file: %w", err)
		}
		if _, err := l.writer.ExecContext(ctx, `DELETE FROM tgdl_ingest_files WHERE path=?`, filepath.ToSlash(path)); err != nil {
			return record, err
		}
		return record, nil
	}
	record, err := l.register(ctx, item, candidate{path: relative, sha256: sum, info: info, fingerprint: fingerprint}, false)
	// A failed catalog commit intentionally leaves the completed file in place
	// for recovery rather than claiming success or deleting downloaded data.
	if err != nil {
		return Record{}, fmt.Errorf("catalog registration failed for %s: %w", relative, err)
	}
	return record, nil
}

type hashClient struct {
	Client
	digest hash.Hash
}

func (c hashClient) Download(ctx context.Context, id telegram.MediaIdentity, w io.Writer) error {
	return c.Client.Download(ctx, id, io.MultiWriter(w, c.digest))
}

func safeComponent(value string) string {
	value = strings.Map(func(r rune) rune {
		if r < 32 || strings.ContainsRune(`/\:*?"<>|`, r) {
			return '_'
		}
		return r
	}, value)
	value = strings.Trim(value, " .")
	for len(value) > 120 {
		_, n := utf8.DecodeLastRuneInString(value)
		value = value[:len(value)-n]
	}
	if value == "" {
		value = "media"
	}
	return value
}

func (l *Library) destination(item Item) (string, error) {
	group := item.GroupName
	if strings.TrimSpace(group) == "" {
		group = item.GroupID
	}
	folder := "documents"
	switch item.Type {
	case "photo":
		folder = "images"
	case "video":
		folder = "videos"
	case "audio":
		folder = "audio"
	case "sticker":
		folder = "stickers"
	case "gif":
		folder = "gifs"
	}
	dir := filepath.Join(safeComponent(group), folder)
	root, err := os.OpenRoot(l.root)
	if err != nil {
		return "", err
	}
	defer root.Close()
	if err := root.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	// No user-controlled directory symlink may be used by the transfer path.
	parts := strings.Split(dir, string(filepath.Separator))
	prefix := ""
	for _, part := range parts {
		prefix = filepath.Join(prefix, part)
		info, err := root.Lstat(prefix)
		if err != nil {
			return "", err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("media destination contains a symlink")
		}
	}
	name := safeComponent(item.Name)
	extension := filepath.Ext(name)
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	name = strings.TrimSuffix(name, extension) + "_" + strconv.FormatInt(item.MessageID, 10) + "_" + hex.EncodeToString(random) + extension
	return filepath.Join(dir, name), nil
}

type candidate struct {
	path, sha256, fingerprint string
	info                      os.FileInfo
}

var ErrSuperseded = errors.New("Telegram message was superseded by a later ingestion")

var errCandidateChanged = errors.New("media candidate changed before registration")

func (l *Library) open(name string) (*os.File, os.FileInfo, error) {
	name = strings.ReplaceAll(name, "\\", "/")
	if !filepath.IsLocal(name) || filepath.Clean(name) == "." {
		return nil, nil, os.ErrPermission
	}
	f, err := os.OpenInRoot(l.root, name)
	if err != nil {
		return nil, nil, err
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		f.Close()
		if err == nil {
			err = os.ErrPermission
		}
		return nil, nil, err
	}
	return f, info, nil
}

func sameMedia(a, b os.FileInfo) bool {
	return os.SameFile(a, b) && a.Size() == b.Size() && a.ModTime().Equal(b.ModTime())
}

func (l *Library) reuse(ctx context.Context, item Item, where string, args ...any) (Record, bool, error) {
	// The identity index eliminates filename scans. A verified size/mtime hash
	// cache avoids rereading multi-gigabyte media for every forwarded message.
	rows, err := l.reader.QueryContext(ctx, `WITH candidates AS (
        SELECT DISTINCT d.file_path FROM downloads d
        WHERE d.status='completed' AND d.file_path IS NOT NULL AND (`+where+`)
    ) SELECT d.file_path,NULL,v.size,v.mtime_ns,v.sha256,v.fingerprint,
        (SELECT min(lower(o.file_hash)) FROM downloads o WHERE o.file_path=d.file_path AND o.file_hash<>''),
        (SELECT max(lower(o.file_hash)) FROM downloads o WHERE o.file_path=d.file_path AND o.file_hash<>'')
        FROM candidates d LEFT JOIN tgdl_verified_media v ON v.path=d.file_path`, args...)
	if err != nil {
		return Record{}, false, err
	}
	defer rows.Close()
	for rows.Next() {
		var path string
		var storedHash, cachedHash, cachedFingerprint, minHash, maxHash sql.NullString
		var size, mtime sql.NullInt64
		if err := rows.Scan(&path, &storedHash, &size, &mtime, &cachedHash, &cachedFingerprint, &minHash, &maxHash); err != nil {
			return Record{}, false, err
		}
		f, info, err := l.open(path)
		if err != nil {
			// Unreadable, non-regular and root-escaping historical entries are
			// never dedup evidence. Another valid candidate can still win.
			continue
		}
		if info.Size() != item.Identity.Size {
			f.Close()
			continue
		}
		fingerprint, err := fileFingerprint(f, info)
		if err != nil {
			f.Close()
			return Record{}, false, err
		}
		sum := cachedHash.String
		if fingerprint == "" || fingerprint != cachedFingerprint.String || !cachedHash.Valid || !size.Valid || !mtime.Valid || size.Int64 != info.Size() || mtime.Int64 != info.ModTime().UnixNano() {
			h := sha256.New()
			buf := make([]byte, 1<<20)
			for {
				if err = ctx.Err(); err != nil {
					break
				}
				var n int
				n, err = f.Read(buf)
				if n > 0 {
					_, _ = h.Write(buf[:n])
				}
				if err != nil {
					break
				}
			}
			if err != nil && err != io.EOF {
				f.Close()
				return Record{}, false, err
			}
			after, err := f.Stat()
			if err != nil {
				f.Close()
				return Record{}, false, err
			}
			afterStamp, stampErr := fileFingerprint(f, after)
			if stampErr != nil {
				f.Close()
				return Record{}, false, stampErr
			}
			if !sameMedia(info, after) || fingerprint != afterStamp {
				f.Close()
				continue
			}
			sum = hex.EncodeToString(h.Sum(nil))
		}
		f.Close()
		if (storedHash.Valid && storedHash.String != "" && !strings.EqualFold(storedHash.String, sum)) || (cachedHash.Valid && cachedHash.String != "" && !strings.EqualFold(cachedHash.String, sum)) {
			continue
		}
		if (minHash.Valid && minHash.String != sum) || (maxHash.Valid && maxHash.String != sum) {
			continue
		}
		record, err := l.register(ctx, item, candidate{path: path, sha256: sum, info: info, fingerprint: fingerprint}, true)
		if errors.Is(err, errCandidateChanged) {
			continue
		}
		return record, err == nil, err
	}
	return Record{}, false, rows.Err()
}

func (l *Library) register(ctx context.Context, item Item, media candidate, reused bool) (Record, error) {
	tx, err := l.writer.BeginTx(ctx, nil)
	if err != nil {
		return Record{}, err
	}
	defer tx.Rollback()
	// Acquire the write lock before inspecting disk: the deletion outbox uses
	// this same lock, so a retained path cannot be unlinked before commit.
	if _, err := tx.ExecContext(ctx, `UPDATE tgdl_file_cleanup SET path=path WHERE 0`); err != nil {
		return Record{}, err
	}
	var generation int64
	if err := tx.QueryRowContext(ctx, `SELECT generation FROM tgdl_message_generations WHERE group_id=? AND message_id=?`, item.GroupID, item.MessageID).Scan(&generation); err != nil {
		return Record{}, err
	}
	if generation != item.generation {
		return Record{}, ErrSuperseded
	}
	f, info, err := l.open(media.path)
	if err != nil {
		if os.IsNotExist(err) {
			return Record{}, errCandidateChanged
		}
		return Record{}, err
	}
	fingerprint, stampErr := fileFingerprint(f, info)
	f.Close()
	if stampErr != nil {
		return Record{}, stampErr
	}
	if !sameMedia(media.info, info) || (media.fingerprint != "" && media.fingerprint != fingerprint) {
		return Record{}, errCandidateChanged
	}
	var previousPath, previousHash sql.NullString
	err = tx.QueryRowContext(ctx, `SELECT file_path,file_hash FROM downloads WHERE group_id=? AND message_id=?`, item.GroupID, item.MessageID).Scan(&previousPath, &previousHash)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return Record{}, err
	}
	var id int64
	err = tx.QueryRowContext(ctx, `INSERT INTO downloads(group_id,group_name,message_id,file_name,file_size,file_type,file_path,file_hash,telegram_media_kind,telegram_media_id,telegram_media_size,status)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,'completed') ON CONFLICT(group_id,message_id) DO UPDATE SET
		group_name=excluded.group_name,file_name=excluded.file_name,file_size=excluded.file_size,file_type=excluded.file_type,
		file_path=excluded.file_path,file_hash=excluded.file_hash,telegram_media_kind=excluded.telegram_media_kind,
		telegram_media_id=excluded.telegram_media_id,telegram_media_size=excluded.telegram_media_size,status='completed' RETURNING id`,
		item.GroupID, item.GroupName, item.MessageID, item.Name, item.Identity.Size, item.Type, filepath.ToSlash(media.path), media.sha256, item.Identity.Kind, item.Identity.ID, item.Identity.Size).Scan(&id)
	if err != nil {
		return Record{}, err
	}
	if previousPath.Valid && (!previousHash.Valid || !strings.EqualFold(previousHash.String, media.sha256)) {
		if err := l.InvalidateDerived(ctx, tx, id); err != nil {
			return Record{}, err
		}
	}
	if previousPath.Valid && previousPath.String != "" && previousPath.String != media.path {
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO tgdl_file_cleanup(path) VALUES(?)`, previousPath.String); err != nil {
			return Record{}, err
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO tgdl_verified_media(path,size,mtime_ns,sha256,fingerprint) VALUES(?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET size=excluded.size,mtime_ns=excluded.mtime_ns,sha256=excluded.sha256,fingerprint=excluded.fingerprint`, filepath.ToSlash(media.path), info.Size(), info.ModTime().UnixNano(), media.sha256, fingerprint); err != nil {
		return Record{}, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM tgdl_ingest_files WHERE path=?`, filepath.ToSlash(media.path)); err != nil {
		return Record{}, err
	}
	if err := tx.Commit(); err != nil {
		return Record{}, err
	}
	return Record{ID: id, Path: filepath.ToSlash(media.path), SHA256: media.sha256, Reused: reused}, l.CleanDerived(ctx)
}
