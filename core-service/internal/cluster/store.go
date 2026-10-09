package cluster

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

var peerIDPattern = regexp.MustCompile(`^[0-9a-fA-F-]{32,64}$`)
var secretPattern = regexp.MustCompile(`^[0-9a-fA-F]{32,256}$`)

type Store struct{ Writer, Reader *sql.DB }
type Identity struct {
	PeerID string `json:"peerId"`
	Name   string `json:"name"`
}
type Peer struct {
	ID                int64   `json:"id"`
	PeerID            string  `json:"peerId"`
	Name              string  `json:"name"`
	URL               string  `json:"url"`
	Status            string  `json:"status"`
	StreamMode        string  `json:"streamMode"`
	LastSeenAt        *int64  `json:"lastSeenAt"`
	WSLastSeen        *int64  `json:"wsLastSeen"`
	PairedAt          int64   `json:"pairedAt"`
	Fingerprint       string  `json:"fingerprint"`
	Version           *string `json:"version"`
	Notes             *string `json:"notes"`
	Role              string  `json:"role"`
	MigrationRequired bool    `json:"migrationRequired"`
	Secret            []byte  `json:"-"`
}
type Code struct {
	Code      string `json:"code"`
	ExpiresAt int64  `json:"expiresAt"`
}
type storedCode struct {
	ExpiresAt int64  `json:"expiresAt"`
	Secret    string `json:"secret,omitempty"`
}
type querier interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}
type executor interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func kvRead(ctx context.Context, db querier, key string, into any) error {
	var raw string
	if err := db.QueryRowContext(ctx, `SELECT value FROM kv WHERE key=?`, key).Scan(&raw); err != nil {
		return err
	}
	return json.Unmarshal([]byte(raw), into)
}
func kvWrite(ctx context.Context, db executor, key string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, `INSERT INTO kv(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, key, string(raw), time.Now().UnixMilli())
	return err
}
func (s Store) transaction(ctx context.Context) (*sql.Tx, error) {
	tx, err := s.Writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE kv SET value=value WHERE 0`); err != nil {
		tx.Rollback()
		return nil, err
	}
	return tx, nil
}
func NewSecret() (string, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw[:]), nil
}
func (s Store) Initialize(ctx context.Context) error {
	tx, err := s.transaction(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var id string
	err = kvRead(ctx, tx, "peer_id", &id)
	if errors.Is(err, sql.ErrNoRows) || err == nil && id == "" {
		var raw [16]byte
		if _, err = rand.Read(raw[:]); err != nil {
			return err
		}
		raw[6] = raw[6]&15 | 64
		raw[8] = raw[8]&63 | 128
		id = fmt.Sprintf("%x-%x-%x-%x-%x", raw[:4], raw[4:6], raw[6:8], raw[8:10], raw[10:])
		if err = kvWrite(ctx, tx, "peer_id", id); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	if !peerIDPattern.MatchString(id) {
		return errors.New("invalid persisted peer identity")
	}
	var token string
	err = kvRead(ctx, tx, "cluster_token", &token)
	if errors.Is(err, sql.ErrNoRows) || err == nil && token == "" {
		if token, err = NewSecret(); err != nil {
			return err
		}
		if err = kvWrite(ctx, tx, "cluster_token", token); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	if !secretPattern.MatchString(token) {
		return errors.New("invalid persisted cluster token")
	}
	return tx.Commit()
}
func clip(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}
func (s Store) Identity(ctx context.Context) (Identity, error) {
	var i Identity
	if err := kvRead(ctx, s.Reader, "peer_id", &i.PeerID); err != nil {
		return i, err
	}
	err := kvRead(ctx, s.Reader, "peer_name", &i.Name)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return i, err
	}
	i.Name = strings.TrimSpace(i.Name)
	if i.Name == "" {
		i.Name, _ = os.Hostname()
		if i.Name == "" {
			i.Name = "tgdl-peer"
		}
		i.Name = clip(i.Name, 64)
	}
	return i, nil
}
func (s Store) Rename(ctx context.Context, name string) error {
	name = clip(strings.TrimSpace(name), 64)
	if name == "" {
		return errors.New("peer name must be non-empty")
	}
	return kvWrite(ctx, s.Writer, "peer_name", name)
}
func (s Store) Token(ctx context.Context) (string, error) {
	var token string
	err := kvRead(ctx, s.Reader, "cluster_token", &token)
	return token, err
}
func (s Store) SetToken(ctx context.Context, token, kind string) (string, error) {
	token = strings.ToLower(strings.TrimSpace(token))
	if !secretPattern.MatchString(token) {
		return "", errors.New("cluster token must be 32+ hex chars")
	}
	tx, err := s.transaction(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	if err = kvWrite(ctx, tx, "cluster_token", token); err != nil {
		return "", err
	}
	if err = kvWrite(ctx, tx, "pairing_codes", map[string]storedCode{}); err != nil {
		return "", err
	}
	detail := "admin set cluster token to externally-supplied value"
	if kind == "rotate_token" {
		detail = "admin rotated cluster token"
	}
	if err = audit(ctx, tx, "", kind, detail, true); err != nil {
		return "", err
	}
	return token, tx.Commit()
}
func codes(ctx context.Context, tx *sql.Tx) (map[string]storedCode, error) {
	m := map[string]storedCode{}
	err := kvRead(ctx, tx, "pairing_codes", &m)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	if err != nil {
		return nil, err
	}
	if m == nil {
		m = map[string]storedCode{}
	}
	for k, v := range m {
		if v.ExpiresAt <= time.Now().UnixMilli() {
			delete(m, k)
		}
	}
	return m, nil
}
func (s Store) IssueCode(ctx context.Context) (Code, error) {
	tx, err := s.transaction(ctx)
	if err != nil {
		return Code{}, err
	}
	defer tx.Rollback()
	m, err := codes(ctx, tx)
	if err != nil {
		return Code{}, err
	}
	if len(m) >= 32 {
		return Code{}, errors.New("too many active pairing codes")
	}
	const alphabet = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ"
	var out Code
	for {
		var raw [8]byte
		if _, err = rand.Read(raw[:]); err != nil {
			return out, err
		}
		for i := range raw {
			raw[i] = alphabet[int(raw[i])%len(alphabet)]
		}
		out = Code{Code: string(raw[:]), ExpiresAt: time.Now().Add(5 * time.Minute).UnixMilli()}
		if _, found := m[out.Code]; !found {
			break
		}
	}
	m[out.Code] = storedCode{ExpiresAt: out.ExpiresAt}
	if err = kvWrite(ctx, tx, "pairing_codes", m); err != nil {
		return out, err
	}
	if err = audit(ctx, tx, "", "pairing_code", "admin issued pairing code", true); err != nil {
		return out, err
	}
	return out, tx.Commit()
}
func NormalizeURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "http" && u.Scheme != "https") || strings.ContainsAny(raw, "\\\r\n\t ") {
		return "", errors.New("peer URL must be http:// or https://")
	}
	return strings.TrimRight(u.String(), "/"), nil
}

const peerColumns = `id,peer_id,name,url,status,stream_mode,last_seen_at,ws_last_seen,paired_at,fingerprint,version,notes,role,shared_secret`

type scanner interface{ Scan(...any) error }

func scanPeer(row scanner) (Peer, error) {
	var p Peer
	err := row.Scan(&p.ID, &p.PeerID, &p.Name, &p.URL, &p.Status, &p.StreamMode, &p.LastSeenAt, &p.WSLastSeen, &p.PairedAt, &p.Fingerprint, &p.Version, &p.Notes, &p.Role, &p.Secret)
	p.MigrationRequired = !secretPattern.Match(p.Secret)
	return p, err
}
func (s Store) Peer(ctx context.Context, id string) (Peer, error) {
	return scanPeer(s.Reader.QueryRowContext(ctx, `SELECT `+peerColumns+` FROM peers WHERE peer_id=?`, id))
}
func (s Store) Peers(ctx context.Context) ([]Peer, error) {
	i, err := s.Identity(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := s.Reader.QueryContext(ctx, `SELECT `+peerColumns+` FROM peers WHERE peer_id<>? ORDER BY name COLLATE NOCASE,id`, i.PeerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Peer{}
	for rows.Next() {
		p, err := scanPeer(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
func audit(ctx context.Context, db executor, peer, kind, detail string, ok bool) error {
	_, err := db.ExecContext(ctx, `INSERT INTO cluster_audit(ts,peer_id,kind,detail,ok) VALUES(?,NULLIF(?,''),?,NULLIF(?,''),?)`, time.Now().UnixMilli(), clip(peer, 128), kind, clip(detail, 4096), ok)
	return err
}
func (s Store) Audit(ctx context.Context, peer, kind, detail string, ok bool) error {
	return audit(ctx, s.Writer, peer, kind, detail, ok)
}
func (s Store) Revoke(ctx context.Context, id string) (bool, error) {
	if !peerIDPattern.MatchString(id) {
		return false, errors.New("peer_id must be a UUID-like hex string")
	}
	tx, err := s.transaction(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `DELETE FROM peers WHERE peer_id=?`, id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	if n == 0 {
		return false, nil
	}
	for _, table := range []string{"peer_downloads", "peer_groups", "peer_accounts", "peer_history", "peer_delete_jobs"} {
		if _, err = tx.ExecContext(ctx, `DELETE FROM `+table+` WHERE peer_id=?`, id); err != nil {
			return false, err
		}
	}
	state, err := syncState(ctx, tx)
	if err != nil {
		return false, err
	}
	delete(state, id)
	if err = kvWrite(ctx, tx, "cluster_sync_state", state); err != nil {
		return false, err
	}
	if err = audit(ctx, tx, id, "revoke", "", true); err != nil {
		return false, err
	}
	return true, tx.Commit()
}
func (s Store) Update(ctx context.Context, id string, patch map[string]any) (Peer, error) {
	if !peerIDPattern.MatchString(id) {
		return Peer{}, errors.New("peer_id must be a UUID-like hex string")
	}
	fields := []string{}
	args := []any{}
	for _, field := range []struct{ key, column string }{{"name", "name"}, {"url", "url"}, {"streamMode", "stream_mode"}, {"notes", "notes"}, {"version", "version"}} {
		v, ok := patch[field.key]
		if !ok {
			continue
		}
		str, ok := v.(string)
		if !ok && v != nil {
			return Peer{}, fmt.Errorf("%s must be text", field.key)
		}
		switch field.key {
		case "name":
			str = clip(strings.TrimSpace(str), 64)
			if str == "" {
				return Peer{}, errors.New("peer name must be non-empty")
			}
		case "url":
			var err error
			str, err = NormalizeURL(str)
			if err != nil {
				return Peer{}, err
			}
		case "streamMode":
			if str != "proxy" && str != "direct" {
				return Peer{}, errors.New("streamMode must be proxy or direct")
			}
		}
		fields = append(fields, field.column+"=?")
		if v == nil && (field.key == "notes" || field.key == "version") {
			args = append(args, nil)
		} else {
			args = append(args, str)
		}
	}
	if len(fields) > 0 {
		args = append(args, id)
		if _, err := s.Writer.ExecContext(ctx, `UPDATE peers SET `+strings.Join(fields, ",")+` WHERE peer_id=?`, args...); err != nil {
			return Peer{}, err
		}
	}
	return s.Peer(ctx, id)
}
