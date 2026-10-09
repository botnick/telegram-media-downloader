package cluster

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"strings"
	"time"
)

type AuthError string

func (e AuthError) Error() string { return string(e) }

type SignedRequest struct {
	PeerID, Timestamp, Signature, Method, Target string
	Body                                         []byte
}
type Handshake struct {
	PeerID       string  `json:"peer_id"`
	Name         string  `json:"name"`
	URL          string  `json:"url"`
	Version      *string `json:"version"`
	SharedSecret string  `json:"shared_secret"`
	PairingCode  string  `json:"pairing_code"`
	Timestamp    int64   `json:"ts"`
}
type HandshakeReply struct {
	PeerID          string `json:"peer_id"`
	Name            string `json:"name"`
	Version         string `json:"version"`
	Fingerprint     string `json:"fingerprint"`
	PairedAt        int64  `json:"paired_at"`
	SharedSecretAck string `json:"shared_secret_ack"`
}

func validateSigned(req SignedRequest, now int64) (int64, error) {
	if req.PeerID == "" || req.Timestamp == "" || req.Signature == "" {
		return 0, AuthError("missing_headers")
	}
	stamp, err := strconv.ParseInt(req.Timestamp, 10, 64)
	if err != nil || stamp <= 0 {
		return 0, AuthError("bad_ts")
	}
	// Compare before subtracting or multiplying, including adversarial int64s.
	if stamp < now-60000 || stamp > now+60000 {
		return 0, AuthError("clock_skew")
	}
	if !peerIDPattern.MatchString(req.PeerID) {
		return 0, AuthError("bad_signature")
	}
	return stamp, nil
}
func acceptSignature(ctx context.Context, tx *sql.Tx, req SignedRequest, secret string, now int64) error {
	stamp, err := validateSigned(req, now)
	if err != nil {
		return err
	}
	if !signatureMatches(secret, req.Method, req.Target, stamp, req.Body, req.Signature) {
		return AuthError("bad_signature")
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM tgdl_cluster_replay WHERE expires_at<=?`, now); err != nil {
		return err
	}
	res, err := tx.ExecContext(ctx, `INSERT INTO tgdl_cluster_replay(peer_id,signature,expires_at) VALUES(?,?,?) ON CONFLICT DO NOTHING`, req.PeerID, strings.ToLower(req.Signature), now+120000)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return AuthError("replay")
	}
	return nil
}

// Verify consumes the signed request durably. Paired requests select exactly
// the stored per-pair key; a global bootstrap token cannot impersonate a peer.
func (s Store) Verify(ctx context.Context, req SignedRequest) (Peer, error) {
	now := time.Now().UnixMilli()
	if _, err := validateSigned(req, now); err != nil {
		return Peer{}, err
	}
	tx, err := s.transaction(ctx)
	if err != nil {
		return Peer{}, err
	}
	defer tx.Rollback()
	p, err := scanPeer(tx.QueryRowContext(ctx, `SELECT `+peerColumns+` FROM peers WHERE peer_id=?`, req.PeerID))
	if errors.Is(err, sql.ErrNoRows) {
		return p, AuthError("no_secret")
	}
	if err != nil {
		return p, err
	}
	if p.Status == "revoked" {
		return p, AuthError("revoked")
	}
	if !secretPattern.Match(p.Secret) {
		return p, AuthError("migration_required")
	}
	if err = acceptSignature(ctx, tx, req, string(p.Secret), now); err != nil {
		return p, err
	}
	return p, tx.Commit()
}

func validateHandshake(h *Handshake, self string) error {
	if h.PeerID == "" || h.Name == "" || h.URL == "" {
		return errors.New("peer_id, name, url required")
	}
	if !peerIDPattern.MatchString(h.PeerID) {
		return errors.New("peer_id must be a UUID-like hex string")
	}
	if h.PeerID == self {
		return errors.New("peer_id matches self")
	}
	h.Name = clip(strings.TrimSpace(h.Name), 64)
	if h.Name == "" {
		return errors.New("peer name required")
	}
	var err error
	h.URL, err = NormalizeURL(h.URL)
	return err
}
func upsert(ctx context.Context, tx *sql.Tx, h Handshake, fp string) (Peer, error) {
	var secret any
	if h.SharedSecret != "" {
		secret = []byte(h.SharedSecret)
	}
	now := time.Now().UnixMilli()
	_, err := tx.ExecContext(ctx, `INSERT INTO peers(peer_id,name,url,status,stream_mode,last_seen_at,paired_at,fingerprint,version,shared_secret)
 VALUES(?,?,?,'online','proxy',?,?,?,?,?) ON CONFLICT(peer_id) DO UPDATE SET name=excluded.name,url=excluded.url,status='online',last_seen_at=excluded.last_seen_at,fingerprint=excluded.fingerprint,version=COALESCE(excluded.version,peers.version),shared_secret=COALESCE(excluded.shared_secret,peers.shared_secret)`, h.PeerID, h.Name, h.URL, now, now, fp, h.Version, secret)
	if err != nil {
		return Peer{}, err
	}
	return scanPeer(tx.QueryRowContext(ctx, `SELECT `+peerColumns+` FROM peers WHERE peer_id=?`, h.PeerID))
}

// AcceptHandshake commits code consumption, replay protection, peer secret and
// audit together. No success/secret acknowledgement precedes durable storage.
func (s Store) AcceptHandshake(ctx context.Context, req SignedRequest, h Handshake, version string) (HandshakeReply, error) {
	var reply HandshakeReply
	now := time.Now().UnixMilli()
	if _, err := validateSigned(req, now); err != nil {
		return reply, err
	}
	tx, err := s.transaction(ctx)
	if err != nil {
		return reply, err
	}
	defer tx.Rollback()
	var self, token, name string
	if err = kvRead(ctx, tx, "peer_id", &self); err != nil {
		return reply, err
	}
	if err = kvRead(ctx, tx, "cluster_token", &token); err != nil {
		return reply, err
	}
	key := token
	if h.PairingCode != "" {
		h.PairingCode = strings.ToUpper(strings.TrimSpace(h.PairingCode))
		m, err := codes(ctx, tx)
		if err != nil {
			return reply, err
		}
		if _, ok := m[h.PairingCode]; !ok {
			return reply, AuthError("bad_pairing_code")
		}
		key = PairingKey(h.PairingCode)
		delete(m, h.PairingCode)
		if err = kvWrite(ctx, tx, "pairing_codes", m); err != nil {
			return reply, err
		}
	}
	if err = acceptSignature(ctx, tx, req, key, now); err != nil {
		return reply, err
	}
	if h.PeerID != req.PeerID {
		return reply, AuthError("peer_id_mismatch")
	}
	if err = validateHandshake(&h, self); err != nil {
		return reply, err
	}
	if h.SharedSecret != "" && !secretPattern.MatchString(h.SharedSecret) {
		return reply, errors.New("shared secret must be 32+ hex chars")
	}
	// An identity-only refresh may keep a previously installed pair secret.
	// New pairs must install one; no legacy global-key runtime mode is created.
	if h.SharedSecret == "" {
		var existing []byte
		if err = tx.QueryRowContext(ctx, `SELECT shared_secret FROM peers WHERE peer_id=?`, h.PeerID).Scan(&existing); err != nil && !errors.Is(err, sql.ErrNoRows) {
			return reply, err
		}
		if !secretPattern.Match(existing) {
			return reply, errors.New("shared_secret required for a new pairing")
		}
	}
	fp := Fingerprint(token, h.PeerID)
	p, err := upsert(ctx, tx, h, fp)
	if err != nil {
		return reply, err
	}
	detail := "inbound from " + h.URL + ": paired"
	if h.SharedSecret != "" {
		detail += " (per-pair-secret installed)"
	}
	if err = audit(ctx, tx, h.PeerID, "handshake", detail, true); err != nil {
		return reply, err
	}
	err = kvRead(ctx, tx, "peer_name", &name)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return reply, err
	}
	if strings.TrimSpace(name) == "" {
		i, e := s.Identity(ctx)
		if e != nil {
			return reply, e
		}
		name = i.Name
	}
	reply = HandshakeReply{PeerID: self, Name: strings.TrimSpace(name), Version: version, Fingerprint: fp, PairedAt: p.PairedAt, SharedSecretAck: h.SharedSecret}
	return reply, tx.Commit()
}
func (s Store) SaveOutbound(ctx context.Context, h Handshake, key string) (Peer, error) {
	i, err := s.Identity(ctx)
	if err != nil {
		return Peer{}, err
	}
	if err = validateHandshake(&h, i.PeerID); err != nil {
		return Peer{}, err
	}
	if !secretPattern.MatchString(h.SharedSecret) {
		return Peer{}, errors.New("missing shared-secret acknowledgement")
	}
	tx, err := s.transaction(ctx)
	if err != nil {
		return Peer{}, err
	}
	defer tx.Rollback()
	p, err := upsert(ctx, tx, h, Fingerprint(key, h.PeerID))
	if err != nil {
		return p, err
	}
	if err = audit(ctx, tx, h.PeerID, "handshake", "outbound to "+h.URL+": paired", true); err != nil {
		return p, err
	}
	return p, tx.Commit()
}
