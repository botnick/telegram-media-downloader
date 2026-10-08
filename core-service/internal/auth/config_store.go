package auth

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// ConfigStore persists the existing JSON config inside the kv table. Keeping
// this boundary small lets the Go server read and update auth without taking
// ownership of unrelated configuration fields during migration.
type ConfigStore struct {
	DB *sql.DB
}

func (s ConfigStore) Load(ctx context.Context) (map[string]any, error) {
	if s.DB == nil {
		return nil, errors.New("auth config database is nil")
	}
	var raw string
	err := s.DB.QueryRowContext(ctx, `SELECT value FROM kv WHERE key = 'config'`).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return map[string]any{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("load config: %w", err)
	}
	var config map[string]any
	if err := json.Unmarshal([]byte(raw), &config); err != nil {
		return nil, fmt.Errorf("decode config: %w", err)
	}
	if config == nil {
		config = map[string]any{}
	}
	return config, nil
}

func (s ConfigStore) Save(ctx context.Context, config map[string]any) error {
	if s.DB == nil {
		return errors.New("auth config database is nil")
	}
	raw, err := json.Marshal(config)
	if err != nil {
		return fmt.Errorf("encode config: %w", err)
	}
	_, err = s.DB.ExecContext(ctx, `
		INSERT INTO kv(key, value, updated_at) VALUES ('config', ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, string(raw), time.Now().UnixMilli())
	if err != nil {
		return fmt.Errorf("save config: %w", err)
	}
	return nil
}

// SaveRevoking commits credential changes and session revocation together.
func (s ConfigStore) SaveRevoking(ctx context.Context, config map[string]any, role string) error {
	if role != "" && role != "guest" && role != "all" {
		return errors.New("invalid revoke scope")
	}
	raw, err := json.Marshal(config)
	if err != nil {
		return err
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `INSERT INTO kv(key,value,updated_at) VALUES('config',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, string(raw), time.Now().UnixMilli()); err != nil {
		return err
	}
	if role == "all" {
		_, err = tx.ExecContext(ctx, `DELETE FROM web_sessions`)
	} else if role != "" {
		_, err = tx.ExecContext(ctx, `DELETE FROM web_sessions WHERE role=?`, role)
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s ConfigStore) Login(ctx context.Context, password string) (role string, configured bool, err error) {
	config, err := s.Load(ctx)
	if err != nil {
		return "", false, err
	}
	web, _ := config["web"].(map[string]any)
	if web == nil {
		return "", false, nil
	}
	configured = IsConfigured(config)
	if MatchesAdmin(config, password) {
		return "admin", configured, nil
	}
	guest, guestOK := parsePasswordHash(web["guestPasswordHash"])
	if configured && guestOK && webBool(web, "guestEnabled", true) {
		if VerifyPassword(password, guest) {
			return "guest", true, nil
		}
	}
	return "", configured, nil
}

// IsConfigured only examines configuration; checking dashboard readiness
// must not run scrypt or treat a guest password as an admin bootstrap.
func IsConfigured(config map[string]any) bool {
	web, _ := config["web"].(map[string]any)
	if web["passwordHash"] != nil {
		return true
	}
	password, _ := web["password"].(string)
	return password != ""
}

func GuestEnabled(config map[string]any) bool {
	web, _ := config["web"].(map[string]any)
	return web["guestPasswordHash"] != nil && webBool(web, "guestEnabled", true)
}

func MatchesAdmin(config map[string]any, password string) bool {
	web, _ := config["web"].(map[string]any)
	if web["passwordHash"] != nil {
		return MatchesHash(password, web["passwordHash"])
	}
	legacy, _ := web["password"].(string)
	return legacy != "" && constantStringEqual(password, legacy)
}

func MatchesHash(password string, value any) bool {
	hash, ok := parsePasswordHash(value)
	return ok && VerifyPassword(password, hash)
}

func (s ConfigStore) SetAdminPassword(ctx context.Context, password string) error {
	hash, err := HashPassword(password)
	if err != nil {
		return err
	}
	config, err := s.Load(ctx)
	if err != nil {
		return err
	}
	web := ensureObject(config, "web")
	web["enabled"] = true
	web["passwordHash"] = hash.JSON()
	delete(web, "password")
	return s.Save(ctx, config)
}

func parsePasswordHash(value any) (PasswordHash, bool) {
	bytes, err := json.Marshal(value)
	if err != nil {
		return PasswordHash{}, false
	}
	var encoded PasswordHashJSON
	if err := json.Unmarshal(bytes, &encoded); err != nil {
		return PasswordHash{}, false
	}
	hash, err := PasswordHashFromJSON(encoded)
	return hash, err == nil
}

func ensureObject(root map[string]any, key string) map[string]any {
	if object, ok := root[key].(map[string]any); ok {
		return object
	}
	object := map[string]any{}
	root[key] = object
	return object
}

func webBool(web map[string]any, key string, fallback bool) bool {
	value, ok := web[key].(bool)
	if !ok {
		return fallback
	}
	return value
}

func constantStringEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var diff byte
	for i := range a {
		diff |= a[i] ^ b[i]
	}
	return diff == 0
}
