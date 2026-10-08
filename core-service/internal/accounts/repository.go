package accounts

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/auth"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
)

var ErrAccountNotFound = errors.New("Account not found")

type Repository struct {
	writer, reader *sql.DB
	dir            string
	mu             sync.Mutex
	configMu       *sync.Mutex
}
type operation struct {
	ID, Action, Source, Digest string
	Metadata                   map[string]string
	Files                      []string
}

func NewRepository(writer, reader *sql.DB, dir string, configMu *sync.Mutex) *Repository {
	if configMu == nil {
		configMu = new(sync.Mutex)
	}
	return &Repository{writer: writer, reader: reader, dir: dir, configMu: configMu}
}
func safeID(id string) bool {
	return id != "" && id != "." && id != ".." && len(id) <= 240 && !strings.ContainsAny(id, "/\\\x00:<>\"|?*") && !strings.HasSuffix(id, ".") && !strings.HasSuffix(id, " ")
}

// Secret never replaces an existing key or generates a new key for a library
// which already has encrypted sessions. The first account creates it once.
func (r *Repository) Secret(ctx context.Context) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return "", err
	}
	root, err := os.OpenRoot(r.dir)
	if err != nil {
		return "", err
	}
	defer root.Close()
	if info, err := root.Lstat("secret.key"); err == nil {
		if !info.Mode().IsRegular() || info.Size() > 4096 {
			return "", errors.New("invalid session encryption secret file")
		}
		data, err := root.ReadFile("secret.key")
		if err != nil {
			return "", err
		}
		secret := strings.TrimSpace(string(data))
		if secret == "" {
			return "", errors.New("session encryption secret is empty")
		}
		return secret, nil
	} else if !os.IsNotExist(err) {
		return "", err
	}
	sessions, err := telegram.SavedSessions(r.dir)
	if err != nil {
		return "", err
	}
	if len(sessions) > 0 {
		return "", errors.New("session encryption secret is missing for saved accounts")
	}
	var key [32]byte
	if _, err = rand.Read(key[:]); err != nil {
		return "", err
	}
	secret := hex.EncodeToString(key[:])
	file, err := root.OpenFile("secret.key", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return "", err
	}
	defer file.Close()
	if _, err = io.WriteString(file, secret); err != nil {
		return "", err
	}
	if err = file.Sync(); err != nil {
		return "", err
	}
	return secret, nil
}
func (r *Repository) Exists(ctx context.Context, id string) (bool, error) {
	if !safeID(id) {
		return false, errors.New("invalid account ID")
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	sessions, err := telegram.SavedSessions(r.dir)
	if err != nil {
		return false, err
	}
	for _, s := range sessions {
		if s.ID == id {
			return true, nil
		}
	}
	return false, nil
}
func (r *Repository) Publish(ctx context.Context, p PendingAccount) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	source, err := filepath.Rel(r.dir, p.SessionPath)
	if err != nil || filepath.Dir(source) != filepath.Join("sessions", "pending") || !safeID(filepath.Base(source)) {
		return "", errors.New("invalid pending session path")
	}
	root, err := os.OpenRoot(r.dir)
	if err != nil {
		return "", err
	}
	defer root.Close()
	journaled := false
	defer func() {
		if !journaled {
			_ = root.Remove(source)
		}
	}()
	if p.User == nil || p.User.ID <= 0 {
		return "", errors.New("authorized Telegram user is required")
	}
	id, err := NormalizeLabel(p.Label)
	if err != nil {
		return "", err
	}
	if id == "" {
		id, err = NormalizeLabel(p.User.Username)
		if err != nil || id == "" {
			id = fmt.Sprintf("acc_%d", p.User.ID)
		}
	}
	base := id
	reserved := make(map[string]bool, len(p.ReservedLabels))
	for _, label := range p.ReservedLabels {
		if normalized, normalizeErr := NormalizeLabel(label); normalizeErr == nil && normalized != "" {
			reserved[normalized] = true
		}
	}
	for n := 0; ; n++ {
		exists, e := r.Exists(ctx, id)
		if e != nil {
			return "", e
		}
		if !exists && !reserved[id] {
			break
		}
		if p.Label != "" {
			return "", fmt.Errorf("Account %q already exists", id)
		}
		id = fmt.Sprintf("%s_%d", base, n+1)
	}
	digest, err := sessionDigest(root, source)
	if err != nil {
		return "", err
	}
	name := strings.TrimSpace(p.User.FirstName + " " + p.User.LastName)
	if name == "" {
		name = id
	}
	op := operation{ID: id, Action: "add", Source: source, Digest: digest, Metadata: map[string]string{"id": id, "name": name, "username": p.User.Username, "phone": p.User.Phone, "userId": fmt.Sprint(p.User.ID)}}
	if err = r.record(ctx, op); err != nil {
		return "", err
	}
	journaled = true
	if err = r.apply(ctx, root, op); err != nil {
		return "", err
	}
	return id, nil
}
func (r *Repository) Remove(ctx context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	exists, err := r.Exists(ctx, id)
	if err != nil {
		return err
	}
	if !exists {
		return ErrAccountNotFound
	}
	files := []string{filepath.Join("sessions", id+".enc"), filepath.Join("sessions", "native", id+".enc")}
	saved, err := telegram.SavedSessions(r.dir)
	if err != nil {
		return err
	}
	for _, session := range saved {
		if session.ID == id && session.ImportPath == filepath.Join(r.dir, "session.enc") {
			files = append(files, "session.enc")
			if _, markerErr := os.Stat(filepath.Join(r.dir, "sessions", "native", "legacy.enc.imported")); markerErr == nil {
				files = append(files, filepath.Join("sessions", "native", "legacy.enc.imported"))
			}
			break
		}
	}
	op := operation{ID: id, Action: "delete", Files: files}
	if err = r.record(ctx, op); err != nil {
		return err
	}
	root, err := os.OpenRoot(r.dir)
	if err != nil {
		return err
	}
	defer root.Close()
	return r.apply(ctx, root, op)
}
func (r *Repository) record(ctx context.Context, op operation) error {
	raw, err := json.Marshal(op)
	if err != nil {
		return err
	}
	_, err = r.writer.ExecContext(ctx, `INSERT INTO tgdl_account_ops(id,payload) VALUES(?,?)`, op.ID, string(raw))
	return err
}
func sessionDigest(root *os.Root, name string) (string, error) {
	info, err := root.Lstat(name)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Size() == 0 || info.Size() > 4<<20 {
		return "", errors.New("invalid encrypted session file")
	}
	f, err := root.Open(name)
	if err != nil {
		return "", err
	}
	defer f.Close()
	hash := sha256.New()
	n, err := io.Copy(hash, io.LimitReader(f, (4<<20)+1))
	if err != nil {
		return "", err
	}
	if n > 4<<20 {
		return "", errors.New("encrypted session exceeds size limit")
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
func (r *Repository) apply(ctx context.Context, root *os.Root, op operation) error {
	if !safeID(op.ID) {
		return errors.New("invalid journal account ID")
	}
	switch op.Action {
	case "add":
		if filepath.Dir(op.Source) != filepath.Join("sessions", "pending") || !safeID(filepath.Base(op.Source)) || op.Metadata["id"] != op.ID {
			return errors.New("invalid publication journal")
		}
		target := filepath.Join("sessions", "native", op.ID+".enc")
		if err := root.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return err
		}
		if _, err := root.Lstat(target); os.IsNotExist(err) {
			digest, err := sessionDigest(root, op.Source)
			if err != nil {
				return err
			}
			if digest != op.Digest {
				return errors.New("pending session changed during publication")
			}
			if err = root.Link(op.Source, target); err != nil {
				return fmt.Errorf("publish account session: %w", err)
			}
		} else if err != nil {
			return err
		}
		digest, err := sessionDigest(root, target)
		if err != nil {
			return err
		}
		if digest != op.Digest {
			return errors.New("account destination belongs to another session")
		}
	case "delete":
		for _, name := range op.Files {
			if name != filepath.Join("sessions", op.ID+".enc") && name != filepath.Join("sessions", "native", op.ID+".enc") && !(op.ID == "legacy" && (name == "session.enc" || name == filepath.Join("sessions", "native", "legacy.enc.imported"))) {
				return errors.New("invalid account removal journal")
			}
			if err := root.Remove(name); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
	default:
		return errors.New("unknown account operation")
	}
	if err := r.commitConfig(ctx, op); err != nil {
		return err
	}
	if op.Action == "add" {
		_ = root.Remove(op.Source)
	}
	return nil
}
func (r *Repository) commitConfig(ctx context.Context, op operation) error {
	r.configMu.Lock()
	defer r.configMu.Unlock()
	cfg, err := (auth.ConfigStore{DB: r.writer}).Load(ctx)
	if err != nil {
		return err
	}
	original, _ := cfg["accounts"].([]any)
	list := make([]any, 0, len(original)+1)
	for _, raw := range original {
		meta, ok := raw.(map[string]any)
		if !ok || fmt.Sprint(meta["id"]) != op.ID {
			list = append(list, raw)
		}
	}
	if op.Action == "add" {
		list = append(list, op.Metadata)
	}
	cfg["accounts"] = list
	if op.Action == "delete" {
		groups, _ := cfg["groups"].([]any)
		for _, raw := range groups {
			if group, ok := raw.(map[string]any); ok && fmt.Sprint(group["monitorAccount"]) == op.ID {
				delete(group, "monitorAccount")
			}
		}
	}
	raw, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	tx, err := r.writer.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `INSERT INTO kv(key,value,updated_at) VALUES('config',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, string(raw), time.Now().UnixMilli()); err != nil {
		return err
	}
	if op.Action == "delete" {
		if _, err = tx.ExecContext(ctx, `UPDATE tgdl_work SET status='failed',body=X'',error='Source Telegram account removed',claim_generation=NULL WHERE account_id=? AND status IN ('pending','processing')`, op.ID); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `DELETE FROM tgdl_update_recovery WHERE account_id=?`, op.ID); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `DELETE FROM tgdl_update_recovery_state WHERE account_id=?`, op.ID); err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM tgdl_account_ops WHERE id=?`, op.ID); err != nil {
		return err
	}
	return tx.Commit()
}

// Recover runs with no active account mutations, before clients are started.
func (r *Repository) Recover(ctx context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	rows, err := r.reader.QueryContext(ctx, `SELECT payload FROM tgdl_account_ops ORDER BY id`)
	if err != nil {
		return err
	}
	var all []operation
	for rows.Next() {
		var raw string
		if err = rows.Scan(&raw); err != nil {
			rows.Close()
			return err
		}
		var op operation
		if err = json.Unmarshal([]byte(raw), &op); err != nil {
			rows.Close()
			return err
		}
		all = append(all, op)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	root, err := os.OpenRoot(r.dir)
	if err != nil {
		return err
	}
	defer root.Close()
	for _, op := range all {
		if err = r.apply(ctx, root, op); err != nil {
			return fmt.Errorf("recover account %s: %w", op.ID, err)
		}
	}
	return nil
}
