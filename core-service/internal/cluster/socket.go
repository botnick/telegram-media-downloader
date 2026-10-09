package cluster

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type SocketEvent struct {
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
	Timestamp int64           `json:"ts"`
	Signature string          `json:"sig"`
}

func socketMAC(key, base string) string {
	m := hmac.New(sha256.New, []byte(key))
	m.Write([]byte(base))
	return hex.EncodeToString(m.Sum(nil))
}
func ConnectSignature(key string, stamp int64) string {
	return socketMAC(key, fmt.Sprintf("connect|%d", stamp))
}
func EventSignature(key string, e SocketEvent) string {
	if len(e.Payload) == 0 {
		e.Payload = json.RawMessage(`{}`)
	}
	compact, err := socketJSON(e.Payload)
	if err != nil {
		return ""
	}
	h := sha256.Sum256(compact)
	return socketMAC(key, fmt.Sprintf("%s|%d|%x", e.Type, e.Timestamp, h))
}
func acceptSocketSignature(ctx context.Context, tx *sql.Tx, peer, sig, want string, stamp int64) error {
	now := time.Now().UnixMilli()
	if stamp < now-60000 || stamp > now+60000 {
		return AuthError("clock_skew")
	}
	actual, err := hex.DecodeString(sig)
	if err != nil {
		return AuthError("bad_signature")
	}
	expected, err := hex.DecodeString(want)
	if err != nil || len(expected) != 32 || !hmac.Equal(actual, expected) {
		return AuthError("bad_signature")
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM tgdl_cluster_replay WHERE expires_at<=?`, now); err != nil {
		return err
	}
	r, err := tx.ExecContext(ctx, `INSERT INTO tgdl_cluster_replay(peer_id,signature,expires_at) VALUES(?,?,?) ON CONFLICT DO NOTHING`, peer, strings.ToLower(sig), now+120000)
	if err != nil {
		return err
	}
	n, err := r.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return AuthError("replay")
	}
	return nil
}
func (s Store) VerifyConnect(ctx context.Context, id, stamp, sig string) (Peer, error) {
	t, err := strconv.ParseInt(stamp, 10, 64)
	if err != nil {
		return Peer{}, AuthError("bad_ts")
	}
	tx, err := s.transaction(ctx)
	if err != nil {
		return Peer{}, err
	}
	defer tx.Rollback()
	p, err := scanPeer(tx.QueryRowContext(ctx, `SELECT `+peerColumns+` FROM peers WHERE peer_id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return p, AuthError("no_secret")
	}
	if err != nil {
		return p, err
	}
	if err = validateDestination(p, "/api/cluster/health"); err != nil {
		return p, err
	}
	if err = acceptSocketSignature(ctx, tx, id, sig, ConnectSignature(string(p.Secret), t), t); err != nil {
		return p, err
	}
	return p, tx.Commit()
}
func (c *Client) SocketURL(ctx context.Context, p Peer) (string, error) {
	if err := validateDestination(p, "/api/cluster/health"); err != nil {
		return "", err
	}
	i, err := c.Store.Identity(ctx)
	if err != nil {
		return "", err
	}
	stamp, err := c.timestamp(ctx)
	if err != nil {
		return "", err
	}
	base, _ := NormalizeURL(p.URL)
	base = strings.Replace(base, "http", "ws", 1)
	q := url.Values{"peer": {i.PeerID}, "ts": {strconv.FormatInt(stamp, 10)}, "sig": {ConnectSignature(string(p.Secret), stamp)}}
	return base + "/ws/cluster?" + q.Encode(), nil
}
func (c *Client) SignEvent(ctx context.Context, p Peer, kind string, payload any) ([]byte, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	stamp, err := c.timestamp(ctx)
	if err != nil {
		return nil, err
	}
	e := SocketEvent{Type: kind, Payload: raw, Timestamp: stamp}
	e.Signature = EventSignature(string(p.Secret), e)
	if e.Signature == "" {
		return nil, errors.New("invalid peer event payload")
	}
	return json.Marshal(e)
}

// Application and replay receipt commit together; a failed write remains
// retryable. Once revision sync owns the cache, unversioned events are hints.
func (s Store) ApplySocketEvent(ctx context.Context, p Peer, e SocketEvent) error {
	if len(e.Type) == 0 || len(e.Type) > 128 || len(e.Payload) > 512<<10 {
		return errors.New("invalid peer event")
	}
	tx, err := s.transaction(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = checkPeer(ctx, tx, p); err != nil {
		return err
	}
	if err = acceptSocketSignature(ctx, tx, p.PeerID, e.Signature, EventSignature(string(p.Secret), e), e.Timestamp); err != nil {
		return err
	}
	state, err := syncState(ctx, tx)
	if err != nil {
		return err
	}
	switch e.Type {
	case "download_added", "download_updated", "download_deleted":
		if state[p.PeerID].CatalogEpoch == "" {
			if _, err = applyCatalogChange(ctx, tx, p.PeerID, Change{Type: e.Type, Payload: e.Payload}, time.Now().UnixMilli()); err != nil {
				return err
			}
		}
	case "config_changed", "failover_requested", "failover_completed", "group_added", "group_changed", "group_removed":
		return errors.New("peer event workflow not implemented")
	}
	if _, err = tx.ExecContext(ctx, `UPDATE peers SET ws_last_seen=?,last_seen_at=?,status='online' WHERE peer_id=?`, time.Now().UnixMilli(), time.Now().UnixMilli(), p.PeerID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s Store) CatalogVersion(ctx context.Context) (string, int64, error) {
	var epoch string
	var revision int64
	if err := kvRead(ctx, s.Reader, "cluster_catalog_epoch", &epoch); err != nil {
		return "", 0, err
	}
	err := s.Reader.QueryRowContext(ctx, `SELECT revision FROM tgdl_cluster_revision WHERE id=1`).Scan(&revision)
	return epoch, revision, err
}
func (s Store) CurrentPeer(ctx context.Context, p Peer) error {
	tx, err := s.Reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	return checkPeer(ctx, tx, p)
}
