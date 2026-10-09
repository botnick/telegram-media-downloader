package backup

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type missingDestination int64

func (e missingDestination) Error() string { return fmt.Sprintf("destination #%d not found", int64(e)) }
func IsRunRejection(err error) bool {
	var missing missingDestination
	return errors.As(err, &missing) || errors.Is(err, ErrDisabled)
}

var ErrDisabled = errors.New("destination is disabled")

type Options struct {
	Writer, Reader *sql.DB
	DataDir        string
	Secret         func(context.Context) ([]byte, error)
	Publish        func(string, map[string]any)
	Factory        Factory
	// LockSnapshot freezes account/config file replacements while archiving.
	LockSnapshot func() func()
}
type Manager struct {
	opts    Options
	ctx     context.Context
	cancel  context.CancelFunc
	op      sync.Mutex
	mu      sync.Mutex
	closed  bool
	workers map[int64]*worker
	keys    map[int64][]byte
	wg      sync.WaitGroup
}
type worker struct {
	running atomic.Bool
	cancel  context.CancelFunc
	done    chan struct{}
	wake    chan struct{}
}
type destination struct {
	ID                 int64
	Name, Provider     string
	Blob               []byte
	Enabled, Encrypted bool
	Salt               []byte
	Mode               string
	Cron               sql.NullString
	Retain             int
	Success, Failure   sql.NullInt64
	Error              sql.NullString
	Bytes, Files       int64
	Throttle           sql.NullInt64
	Created            int64
}

const destinationColumns = `id,name,provider,config_blob,enabled,encryption,encryption_salt,mode,cron,COALESCE(retain_count,7),last_success_at,last_failure_at,last_error,total_bytes,total_files,throttle_bps,created_at`

type scanner interface{ Scan(...any) error }

func scanDestination(s scanner) (destination, error) {
	var d destination
	err := s.Scan(&d.ID, &d.Name, &d.Provider, &d.Blob, &d.Enabled, &d.Encrypted, &d.Salt, &d.Mode, &d.Cron, &d.Retain, &d.Success, &d.Failure, &d.Error, &d.Bytes, &d.Files, &d.Throttle, &d.Created)
	return d, err
}
func NewManager(ctx context.Context, opts Options) (*Manager, error) {
	if opts.Writer == nil || opts.Reader == nil || opts.Secret == nil {
		return nil, errors.New("backup database and credential secret are required")
	}
	if opts.Factory == nil {
		opts.Factory = nativeProvider
	}
	ctx, cancel := context.WithCancel(ctx)
	m := &Manager{opts: opts, ctx: ctx, cancel: cancel, workers: map[int64]*worker{}, keys: map[int64][]byte{}}
	if _, err := opts.Writer.ExecContext(ctx, backupSchema); err != nil {
		cancel()
		return nil, err
	}
	if _, err := opts.Writer.ExecContext(ctx, `UPDATE backup_jobs SET status='pending',started_at=NULL WHERE status='uploading'`); err != nil {
		cancel()
		return nil, err
	}
	ds, err := m.destinations(ctx)
	if err != nil {
		cancel()
		return nil, err
	}
	for _, d := range ds {
		if d.Enabled {
			m.start(d.ID)
		}
	}
	m.wg.Add(1)
	go m.schedule()
	return m, nil
}
func (m *Manager) Close() {
	m.op.Lock()
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		m.op.Unlock()
		return
	}
	m.closed = true
	m.cancel()
	workers := m.workers
	m.workers = map[int64]*worker{}
	m.mu.Unlock()
	m.op.Unlock()
	m.wg.Wait()
	for _, w := range workers {
		w.cancel()
		<-w.done
	}
	m.mu.Lock()
	for id, key := range m.keys {
		clear(key)
		delete(m.keys, id)
	}
	m.mu.Unlock()
}
func (m *Manager) available() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return errors.New("backup manager is closed")
	}
	return m.ctx.Err()
}
func (m *Manager) emit(kind string, data map[string]any) {
	if m.opts.Publish != nil {
		m.opts.Publish(kind, data)
	}
}
func (m *Manager) Log(level, msg string) {
	m.emit("log", map[string]any{"source": "backup", "level": level, "msg": msg, "ts": time.Now().UnixMilli()})
}
func (m *Manager) load(ctx context.Context, id int64) (destination, error) {
	d, err := scanDestination(m.opts.Reader.QueryRowContext(ctx, `SELECT `+destinationColumns+` FROM backup_destinations WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		err = missingDestination(id)
	}
	return d, err
}
func (m *Manager) destinations(ctx context.Context) ([]destination, error) {
	rows, err := m.opts.Reader.QueryContext(ctx, `SELECT `+destinationColumns+` FROM backup_destinations ORDER BY id DESC LIMIT 1000`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ds := []destination{}
	for rows.Next() {
		d, err := scanDestination(rows)
		if err != nil {
			return nil, err
		}
		ds = append(ds, d)
	}
	return ds, rows.Err()
}
func nullableInt(v sql.NullInt64) any {
	if v.Valid {
		return v.Int64
	}
	return nil
}
func nullableString(v sql.NullString) any {
	if v.Valid && v.String != "" {
		return v.String
	}
	return nil
}
func (m *Manager) unlocked(d destination) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return !d.Encrypted || len(m.keys[d.ID]) == 32
}
func (m *Manager) scrub(d destination) map[string]any {
	return map[string]any{"id": d.ID, "name": d.Name, "provider": d.Provider, "enabled": d.Enabled, "mode": d.Mode, "cron": nullableString(d.Cron), "retainCount": d.Retain, "encryption": d.Encrypted, "encryptionUnlocked": m.unlocked(d), "lastSuccessAt": nullableInt(d.Success), "lastFailureAt": nullableInt(d.Failure), "lastError": nullableString(d.Error), "totalBytes": d.Bytes, "totalFiles": d.Files, "createdAt": d.Created}
}
func (m *Manager) List(ctx context.Context) ([]map[string]any, error) {
	ds, err := m.destinations(ctx)
	out := []map[string]any{}
	for _, d := range ds {
		out = append(out, m.scrub(d))
	}
	return out, err
}
func (m *Manager) config(ctx context.Context, d destination) (map[string]any, error) {
	secret, err := m.opts.Secret(ctx)
	if err != nil {
		return nil, err
	}
	defer clear(secret)
	return openConfig(d.Blob, secret)
}
func (m *Manager) Config(ctx context.Context, id int64) (map[string]any, error) {
	d, err := m.load(ctx, id)
	if err != nil {
		return nil, err
	}
	cfg, err := m.config(ctx, d)
	out := map[string]any{}
	if err != nil {
		return out, nil
	}
	p, _ := providerInfo(d.Provider)
	for _, f := range p.ConfigSchema {
		key, _ := f["name"].(string)
		if f["secret"] != true {
			if v, ok := cfg[key]; ok {
				out[key] = v
			}
		}
	}
	return out, nil
}
func (m *Manager) Status(ctx context.Context, id int64) (map[string]any, error) {
	d, err := m.load(ctx, id)
	if err != nil {
		return nil, err
	}
	out := m.scrub(d)
	delete(out, "cron")
	delete(out, "retainCount")
	delete(out, "createdAt")
	var queued, processing, done, failed int64
	err = m.opts.Reader.QueryRowContext(ctx, `SELECT COALESCE(SUM(status='pending'),0),COALESCE(SUM(status='uploading'),0),COALESCE(SUM(status='done' AND finished_at>?),0),COALESCE(SUM(status='failed' AND finished_at>?),0) FROM backup_jobs WHERE destination_id=?`, time.Now().Add(-24*time.Hour).UnixMilli(), time.Now().Add(-24*time.Hour).UnixMilli(), id).Scan(&queued, &processing, &done, &failed)
	if err != nil {
		return nil, err
	}
	var paused bool
	err = m.opts.Reader.QueryRowContext(ctx, `SELECT paused FROM native_backup_state WHERE destination_id=?`, id).Scan(&paused)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	out["queued"] = queued
	out["processing"] = processing
	out["completed24h"] = done
	out["failed24h"] = failed
	m.mu.Lock()
	active := m.workers[id] != nil && m.workers[id].running.Load()
	m.mu.Unlock()
	out["running"] = processing > 0 || active
	out["paused"] = paused
	return out, nil
}
func text(v any) string { s, _ := v.(string); return s }
func integer(v any, def int) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case string:
		if i, e := strconv.Atoi(n); e == nil {
			return i
		}
	}
	return def
}
func cleanName(v any) string {
	r := []rune(strings.TrimSpace(text(v)))
	if len(r) > 200 {
		r = r[:200]
	}
	return string(r)
}
func (m *Manager) Create(ctx context.Context, input map[string]any) (map[string]any, error) {
	m.op.Lock()
	defer m.op.Unlock()
	if err := m.available(); err != nil {
		return nil, err
	}
	name := cleanName(input["name"])
	if name == "" {
		return nil, errors.New("name required")
	}
	provider := strings.TrimSpace(text(input["provider"]))
	if _, ok := providerInfo(provider); !ok {
		return nil, fmt.Errorf("unknown provider %q", provider)
	}
	mode := text(input["mode"])
	if mode != "snapshot" && mode != "manual" {
		mode = "mirror"
	}
	cron := text(input["cron"])
	if mode == "snapshot" && cron == "" {
		return nil, errors.New("snapshot mode requires a cron expression")
	}
	if cron != "" {
		if err := validateCron(cron); err != nil {
			return nil, err
		}
	}
	retain := integer(input["retainCount"], integer(input["retain_count"], 7))
	if retain <= 0 {
		retain = 7
	}
	retain = min(retain, 365)
	cfg, _ := input["config"].(map[string]any)
	if cfg == nil {
		cfg = map[string]any{}
	}
	secret, err := m.opts.Secret(ctx)
	if err != nil {
		return nil, err
	}
	defer clear(secret)
	blob, err := sealConfig(cfg, secret)
	if err != nil {
		return nil, err
	}
	encrypted := input["encryption"] == true
	var salt, key, verifier []byte
	if encrypted {
		salt = make([]byte, 16)
		if _, err = rand.Read(salt); err != nil {
			return nil, err
		}
		if pass := text(input["passphrase"]); pass != "" {
			key, err = payloadKey(pass, salt)
			if err != nil {
				return nil, err
			}
			defer clear(key)
			verifier = keyVerifier(key)
		}
	}
	tx, err := m.opts.Writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `INSERT INTO backup_destinations(name,provider,config_blob,enabled,encryption,encryption_salt,mode,cron,retain_count,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, name, provider, blob, input["enabled"] != false, encrypted, salt, mode, nullString(cron), retain, time.Now().UnixMilli())
	if err != nil {
		return nil, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO native_backup_state(destination_id,key_verifier) VALUES(?,?)`, id, verifier); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	if key != nil {
		m.setKey(id, key)
	}
	d, err := m.load(ctx, id)
	if err != nil {
		return nil, err
	}
	out := m.scrub(d)
	m.emit("backup_destination_added", map[string]any{"destination": out})
	m.Log("info", fmt.Sprintf("destination added — %s/%s (#%d)", provider, name, id))
	if d.Enabled {
		m.start(id)
	}
	return out, nil
}
func nullString(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func (m *Manager) setKey(id int64, key []byte) {
	m.mu.Lock()
	defer m.mu.Unlock()
	clear(m.keys[id])
	if key == nil {
		delete(m.keys, id)
	} else {
		m.keys[id] = append([]byte(nil), key...)
	}
}
func (m *Manager) Update(ctx context.Context, id int64, patch map[string]any) (map[string]any, error) {
	m.op.Lock()
	defer m.op.Unlock()
	if err := m.available(); err != nil {
		return nil, err
	}
	d, err := m.load(ctx, id)
	if err != nil {
		return nil, err
	}
	if v, ok := patch["name"]; ok {
		d.Name = cleanName(v)
		if d.Name == "" {
			return nil, errors.New("name required")
		}
	}
	if v, ok := patch["mode"]; ok {
		d.Mode = text(v)
		if d.Mode != "mirror" && d.Mode != "snapshot" && d.Mode != "manual" {
			return nil, fmt.Errorf("invalid mode %q", d.Mode)
		}
	}
	if v, ok := patch["cron"]; ok {
		d.Cron = sql.NullString{String: text(v), Valid: text(v) != ""}
	}
	if d.Mode == "snapshot" && !d.Cron.Valid {
		return nil, errors.New("snapshot mode requires a cron expression")
	}
	if d.Cron.Valid {
		if err = validateCron(d.Cron.String); err != nil {
			return nil, err
		}
	}
	if v, ok := patch["retainCount"]; ok {
		d.Retain = max(1, min(365, integer(v, 7)))
	}
	if v, ok := patch["enabled"]; ok {
		d.Enabled = v == true
	}
	if cfg, ok := patch["config"].(map[string]any); ok {
		old, e := m.config(ctx, d)
		if e != nil {
			old = map[string]any{}
		}
		secrets := secretFields(d.Provider)
		for k, v := range cfg {
			if secrets[k] && (v == nil || v == "") {
				continue
			}
			old[k] = v
		}
		secret, e := m.opts.Secret(ctx)
		if e != nil {
			return nil, e
		}
		d.Blob, e = sealConfig(old, secret)
		clear(secret)
		if e != nil {
			return nil, e
		}
	}
	m.stop(id)
	_, err = m.opts.Writer.ExecContext(ctx, `UPDATE backup_destinations SET name=?,config_blob=?,enabled=?,mode=?,cron=?,retain_count=? WHERE id=?`, d.Name, d.Blob, d.Enabled, d.Mode, nullableString(d.Cron), d.Retain, id)
	if err != nil {
		if old, e := m.load(m.ctx, id); e == nil && old.Enabled {
			m.start(id)
		}
		return nil, err
	}
	d, err = m.load(ctx, id)
	if err != nil {
		return nil, err
	}
	out := m.scrub(d)
	m.emit("backup_destination_updated", map[string]any{"destination": out})
	m.Log("info", fmt.Sprintf("destination updated — #%d", id))
	if d.Enabled {
		m.start(id)
	}
	return out, nil
}
func (m *Manager) Remove(ctx context.Context, id int64) (bool, error) {
	m.op.Lock()
	defer m.op.Unlock()
	if err := m.available(); err != nil {
		return false, err
	}
	m.stop(id)
	res, err := m.opts.Writer.ExecContext(ctx, `DELETE FROM backup_destinations WHERE id=?`, id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	m.setKey(id, nil)
	m.emit("backup_destination_removed", map[string]any{"destinationId": id})
	m.Log("info", fmt.Sprintf("destination removed — #%d", id))
	return n > 0, err
}
func (m *Manager) Pause(ctx context.Context, id int64, paused bool) error {
	m.op.Lock()
	defer m.op.Unlock()
	if err := m.available(); err != nil {
		return err
	}
	d, err := m.load(ctx, id)
	if err != nil {
		return err
	}
	m.stop(id)
	_, err = m.opts.Writer.ExecContext(ctx, `INSERT INTO native_backup_state(destination_id,paused) VALUES(?,?) ON CONFLICT(destination_id) DO UPDATE SET paused=excluded.paused`, id, paused)
	if d.Enabled {
		m.start(id)
	}
	if err == nil {
		m.emit("backup_destination_updated", map[string]any{"destination": m.scrub(d)})
	}
	return err
}
func (m *Manager) Test(ctx context.Context, id int64) (bool, string, error) {
	d, err := m.load(ctx, id)
	if err != nil {
		return false, "", err
	}
	cfg, err := m.config(ctx, d)
	if err != nil {
		return false, err.Error(), nil
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	p, err := m.opts.Factory(ctx, d.Provider, cfg)
	if err != nil {
		return false, err.Error(), nil
	}
	defer p.Close()
	detail, err := p.Test(ctx)
	if err != nil {
		return false, err.Error(), nil
	}
	return true, detail, nil
}
func keyVerifier(key []byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte("tgdl-backup-key-verifier-v1"))
	return h.Sum(nil)
}
func (m *Manager) Encryption(ctx context.Context, id int64, enabled bool, passphrase string, unlockOnly bool) (map[string]any, error) {
	m.op.Lock()
	defer m.op.Unlock()
	if err := m.available(); err != nil {
		return nil, err
	}
	d, err := m.load(ctx, id)
	if err != nil {
		return nil, err
	}
	if unlockOnly && (!d.Encrypted || len(d.Salt) < 8) {
		return nil, errors.New("encryption is not enabled for this destination")
	}
	var key, verify []byte
	if enabled {
		if passphrase == "" {
			if !unlockOnly {
				return nil, errors.New("passphrase required to enable encryption")
			}
			return nil, errors.New("passphrase required")
		}
		if len(d.Salt) < 8 {
			d.Salt = make([]byte, 16)
			if _, err = rand.Read(d.Salt); err != nil {
				return nil, err
			}
		}
		key, err = payloadKey(passphrase, d.Salt)
		if err != nil {
			return nil, err
		}
		defer clear(key)
		verify = keyVerifier(key)
		var existing []byte
		err = m.opts.Reader.QueryRowContext(ctx, `SELECT key_verifier FROM native_backup_state WHERE destination_id=?`, id).Scan(&existing)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		if len(existing) > 0 && !hmac.Equal(existing, verify) {
			return nil, errors.New("incorrect backup passphrase")
		}
	}
	m.stop(id)
	defer func() {
		if d.Enabled {
			m.start(id)
		}
	}()
	tx, err := m.opts.Writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `UPDATE backup_destinations SET encryption=?,encryption_salt=? WHERE id=?`, enabled, d.Salt, id); err != nil {
		return nil, err
	}
	// Retain salt/verifier on disable: old encrypted objects must remain recoverable.
	if _, err = tx.ExecContext(ctx, `INSERT INTO native_backup_state(destination_id,key_verifier) VALUES(?,?) ON CONFLICT(destination_id) DO UPDATE SET key_verifier=COALESCE(excluded.key_verifier,key_verifier)`, id, verify); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	m.setKey(id, key)
	d.Encrypted = enabled
	out := m.scrub(d)
	if !unlockOnly {
		word := "disabled"
		if enabled {
			word = "enabled"
		}
		m.Log("info", fmt.Sprintf("encryption %s for #%d", word, id))
		m.emit("backup_destination_updated", map[string]any{"destination": out})
	}
	return out, nil
}

const backupSchema = `
CREATE TABLE IF NOT EXISTS native_backup_state(
 destination_id INTEGER PRIMARY KEY REFERENCES backup_destinations(id) ON DELETE CASCADE,
 paused INTEGER NOT NULL DEFAULT 0,
 last_scheduled_minute INTEGER,
 key_verifier BLOB
);
CREATE TRIGGER IF NOT EXISTS native_backup_download_insert AFTER INSERT ON downloads
WHEN NEW.file_path IS NOT NULL AND NEW.file_path<>''
BEGIN
 INSERT INTO backup_jobs(destination_id,download_id,remote_path)
 SELECT d.id,NEW.id,REPLACE(NEW.file_path,char(92),'/') FROM backup_destinations d
 WHERE d.enabled=1 AND d.mode='mirror'
 AND NOT EXISTS(SELECT 1 FROM backup_jobs j WHERE j.destination_id=d.id AND j.download_id=NEW.id);
END;
CREATE TABLE IF NOT EXISTS native_backup_retention(job_id INTEGER PRIMARY KEY REFERENCES backup_jobs(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS native_backup_versions(job_id INTEGER PRIMARY KEY REFERENCES backup_jobs(id) ON DELETE CASCADE,version INTEGER NOT NULL DEFAULT 0);
DROP TRIGGER IF EXISTS native_backup_download_update;
CREATE TRIGGER native_backup_download_update AFTER UPDATE OF file_path,file_hash ON downloads
WHEN NEW.file_path IS NOT NULL AND NEW.file_path<>'' AND (NEW.file_path IS NOT OLD.file_path OR NEW.file_hash IS NOT OLD.file_hash)
BEGIN
 INSERT INTO native_backup_versions(job_id,version)
 SELECT j.id,1 FROM backup_jobs j JOIN backup_destinations d ON d.id=j.destination_id
 WHERE j.download_id=NEW.id AND d.enabled=1 AND d.mode='mirror'
 ON CONFLICT(job_id) DO UPDATE SET version=version+1;
 UPDATE backup_jobs SET remote_path=REPLACE(NEW.file_path,char(92),'/'),
 status=CASE WHEN status='uploading' THEN status ELSE 'pending' END,
 attempts=CASE WHEN status='uploading' THEN attempts ELSE 0 END,
 error=NULL,next_retry_at=NULL,finished_at=NULL
 WHERE download_id=NEW.id AND destination_id IN(SELECT id FROM backup_destinations WHERE enabled=1 AND mode='mirror');
 INSERT INTO backup_jobs(destination_id,download_id,remote_path)
 SELECT d.id,NEW.id,REPLACE(NEW.file_path,char(92),'/') FROM backup_destinations d
 WHERE d.enabled=1 AND d.mode='mirror'
 AND NOT EXISTS(SELECT 1 FROM backup_jobs j WHERE j.destination_id=d.id AND j.download_id=NEW.id);
END;
`
