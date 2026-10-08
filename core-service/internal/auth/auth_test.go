package auth

import (
	"context"
	"database/sql"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

func TestSessionStoreCreatesAndValidatesRoleCookie(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE web_sessions (token TEXT PRIMARY KEY, role TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	sessions := NewSessionStore(db, "tg_dl_session", 24*time.Hour)
	token, err := sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	got, err := sessions.Validate(context.Background(), token)
	if err != nil {
		t.Fatal(err)
	}
	if got.Role != "admin" || got.Token != token {
		t.Fatalf("unexpected session: %+v", got)
	}
}

func TestSessionStoreRenewsInFinalQuarter(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE web_sessions (token TEXT PRIMARY KEY, role TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	ttl := time.Hour
	sessions := NewSessionStore(db, "tg_dl_session", ttl)
	token, err := sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	nearExpiry := time.Now().Add(10 * time.Minute).UnixMilli()
	if _, err := db.Exec(`UPDATE web_sessions SET issued_at = ?, expires_at = ? WHERE token = ?`, nearExpiry-ttl.Milliseconds(), nearExpiry, token); err != nil {
		t.Fatal(err)
	}
	got, err := sessions.Validate(context.Background(), token)
	if err != nil {
		t.Fatal(err)
	}
	if renewed, err := sessions.Renew(context.Background(), got); err != nil || renewed != ttl {
		t.Fatalf("renewal=%v err=%v", renewed, err)
	}
	got, err = sessions.Validate(context.Background(), token)
	if err != nil {
		t.Fatal(err)
	}
	if got.ExpiresAt < time.Now().Add(50*time.Minute).UnixMilli() {
		t.Fatalf("session was not renewed: %d", got.ExpiresAt)
	}
}
