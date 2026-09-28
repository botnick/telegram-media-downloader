package front

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite" // pure-Go SQLite driver ("sqlite")
)

// sessionStore reads the dashboard's web_sessions table. The connection is
// read-only twice over (mode=ro and PRAGMA query_only): Node stays the only
// writer — it creates sessions, deletes expired ones and extends them.
type sessionStore struct {
	path string

	mu   sync.Mutex
	db   *sql.DB
	stmt *sql.Stmt
	err  error
	at   time.Time
}

type session struct {
	role string
	// Doubles, as better-sqlite3 hands them to Node.
	issuedAt  float64
	expiresAt float64
}

// sessionDSN builds the modernc.org/sqlite URI for a read-only, query-only
// connection that waits up to 5 s for a writer.
func sessionDSN(path string) string {
	p := filepath.ToSlash(path)
	if !strings.HasPrefix(p, "/") {
		p = "/" + p // file:/C:/… on Windows
	}
	u := url.URL{Scheme: "file", Path: p}
	q := url.Values{}
	q.Set("mode", "ro")
	q.Add("_pragma", "query_only(1)")
	q.Add("_pragma", "busy_timeout(5000)")
	u.RawQuery = q.Encode()
	return u.String()
}

func newSessionStore(path string) *sessionStore { return &sessionStore{path: path} }

// open (re)opens the connection lazily; a failure is retried at most once
// every 5 s. Without a store the fast path simply never authenticates by
// cookie, so every such request goes to Node.
func (s *sessionStore) open() (*sql.Stmt, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stmt != nil {
		return s.stmt, nil
	}
	if s.path == "" {
		return nil, errors.New("no database path")
	}
	if s.err != nil && time.Since(s.at) < 5*time.Second {
		return nil, s.err
	}
	s.at = time.Now()
	db, err := sql.Open("sqlite", sessionDSN(s.path))
	if err != nil {
		s.err = err
		return nil, err
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(4)
	db.SetConnMaxIdleTime(5 * time.Minute)
	stmt, err := db.Prepare(`SELECT role, issued_at, expires_at FROM web_sessions WHERE token = ?`)
	if err != nil {
		_ = db.Close()
		s.err = err
		return nil, err
	}
	s.db, s.stmt, s.err = db, stmt, nil
	return stmt, nil
}

// lookup returns the session row for token. found is false when there is
// no such row; err reports a database problem (the caller proxies).
func (s *sessionStore) lookup(ctx context.Context, token string) (sess session, found bool, err error) {
	stmt, err := s.open()
	if err != nil {
		return session{}, false, err
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	err = stmt.QueryRowContext(ctx, token).Scan(&sess.role, &sess.issuedAt, &sess.expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return session{}, false, nil
	}
	if err != nil {
		return session{}, false, err
	}
	return sess, true, nil
}

func (s *sessionStore) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stmt != nil {
		_ = s.stmt.Close()
	}
	if s.db != nil {
		_ = s.db.Close()
	}
	s.db, s.stmt = nil, nil
}
