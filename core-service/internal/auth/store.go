// Package auth implements Go-owned web sessions and role checks.
package auth

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"
)

type Session struct {
	Token     string
	Role      string
	IssuedAt  int64
	ExpiresAt int64
}

type SessionStore struct {
	db         *sql.DB
	cookieName string
	ttl        time.Duration
}

func NewSessionStore(db *sql.DB, cookieName string, ttl time.Duration) *SessionStore {
	return &SessionStore{db: db, cookieName: cookieName, ttl: ttl}
}

func (s *SessionStore) Create(ctx context.Context, role string) (string, error) {
	if role != "admin" && role != "guest" {
		return "", errors.New("invalid session role")
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token := hex.EncodeToString(b)
	now := time.Now().UnixMilli()
	expiry := time.Now().Add(s.ttl).UnixMilli()
	_, err := s.db.ExecContext(ctx, `INSERT INTO web_sessions(token, role, issued_at, expires_at, last_seen) VALUES(?,?,?,?,?)`, token, role, now, expiry, now)
	return token, err
}

func (s *SessionStore) Validate(ctx context.Context, token string) (Session, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return Session{}, errors.New("missing session")
	}
	var out Session
	err := s.db.QueryRowContext(ctx, `SELECT token, role, issued_at, expires_at FROM web_sessions WHERE token = ? AND expires_at > ?`, token, time.Now().UnixMilli()).Scan(&out.Token, &out.Role, &out.IssuedAt, &out.ExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, errors.New("invalid session")
	}
	if err != nil {
		return Session{}, err
	}
	now := time.Now()
	// Match the Node dashboard's sliding renewal: sessions are extended only
	// in their final quarter, keeping ordinary requests a cheap read.
	if s.ttl > 0 && out.ExpiresAt-now.UnixMilli() <= s.ttl.Milliseconds()/4 {
		out.ExpiresAt = now.Add(s.ttl).UnixMilli()
		if _, err := s.db.ExecContext(ctx, `UPDATE web_sessions SET expires_at = ?, last_seen = ? WHERE token = ?`, out.ExpiresAt, now.UnixMilli(), token); err != nil {
			return Session{}, err
		}
	} else {
		_, _ = s.db.ExecContext(ctx, `UPDATE web_sessions SET last_seen = ? WHERE token = ?`, now.UnixMilli(), token)
	}
	return out, err
}

func (s *SessionStore) CookieName() string { return s.cookieName }

func (s *SessionStore) TTL() time.Duration { return s.ttl }

func (s *SessionStore) Revoke(ctx context.Context, token string) error {
	if strings.TrimSpace(token) == "" {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM web_sessions WHERE token = ?`, token)
	return err
}

func (s *SessionStore) RevokeAll(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM web_sessions`)
	return err
}

func (s *SessionStore) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(s.cookieName)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		sess, err := s.Validate(r.Context(), c.Value)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r.WithContext(WithSession(r.Context(), sess)))
	})
}

type sessionKey struct{}

func WithSession(ctx context.Context, s Session) context.Context {
	return context.WithValue(ctx, sessionKey{}, s)
}
func SessionFromContext(ctx context.Context) (Session, bool) {
	s, ok := ctx.Value(sessionKey{}).(Session)
	return s, ok
}
