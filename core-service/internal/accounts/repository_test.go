package accounts

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/auth"
	"github.com/botnick/telegram-media-downloader/core-service/internal/store"
	"github.com/gotd/td/tg"
)

func TestPublicationRecoversAfterConfigCommitFailure(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Reader.Close()
	defer db.Writer.Close()
	repo := NewRepository(db.Writer, db.Reader, dir, new(sync.Mutex))
	if err = (auth.ConfigStore{DB: db.Writer}).Save(ctx, map[string]any{"keep": "value"}); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Writer.Exec(`CREATE TRIGGER fail_account_config BEFORE UPDATE ON kv WHEN NEW.key='config' BEGIN SELECT RAISE(FAIL,'injected config failure'); END`); err != nil {
		t.Fatal(err)
	}
	dirPending := filepath.Join(dir, "sessions", "pending")
	if err = os.MkdirAll(dirPending, 0700); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(dirPending, "0123456789abcdef.enc")
	if err = os.WriteFile(source, []byte("encrypted fixture bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err = repo.Publish(ctx, PendingAccount{SessionPath: source, Label: "alice", User: &tg.User{ID: 42, FirstName: "Alice"}})
	if err == nil {
		t.Fatal("reported success despite failed metadata commit")
	}
	var n int
	if err = db.Reader.QueryRow(`SELECT count(*) FROM tgdl_account_ops`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("lost publication intent: %d %v", n, err)
	}
	if _, err = db.Writer.Exec(`DROP TRIGGER fail_account_config`); err != nil {
		t.Fatal(err)
	}
	if err = repo.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	cfg, err := (auth.ConfigStore{DB: db.Writer}).Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if cfg["keep"] != "value" || cfg["accounts"].([]any)[0].(map[string]any)["id"] != "alice" {
		t.Fatalf("metadata lost: %+v", cfg)
	}
	data, err := os.ReadFile(filepath.Join(dir, "sessions", "native", "alice.enc"))
	if err != nil || string(data) != "encrypted fixture bytes" {
		t.Fatalf("published=%q %v", data, err)
	}
	if _, err = os.Stat(source); !os.IsNotExist(err) {
		t.Fatalf("temporary session retained after success: %v", err)
	}
}
func TestAccountRemovalClearsOnlyOwnPinsAndSessions(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Reader.Close()
	defer db.Writer.Close()
	repo := NewRepository(db.Writer, db.Reader, dir, new(sync.Mutex))
	cfg := map[string]any{"accounts": []any{map[string]any{"id": "alice"}, map[string]any{"id": "bob"}}, "groups": []any{map[string]any{"id": "one", "monitorAccount": "alice"}, map[string]any{"id": "two", "monitorAccount": "bob"}}}
	if err = (auth.ConfigStore{DB: db.Writer}).Save(ctx, cfg); err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(filepath.Join(dir, "sessions", "native"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"sessions/alice.enc", "sessions/native/alice.enc", "sessions/bob.enc"} {
		if err = os.WriteFile(filepath.Join(dir, name), []byte(name), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err = os.WriteFile(filepath.Join(dir, "session.enc"), []byte("old legacy session"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Writer.Exec(`INSERT INTO tgdl_update_recovery(account_id,channel_id,reason,created_at) VALUES('alice',99,'gap',0)`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Writer.Exec(`INSERT INTO tgdl_update_recovery_state(account_id,channel_id,user_id,pts) VALUES('alice',99,7,20)`); err != nil {
		t.Fatal(err)
	}
	if err = repo.Remove(ctx, "alice"); err != nil {
		t.Fatal(err)
	}
	cfg, err = (auth.ConfigStore{DB: db.Writer}).Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg["accounts"].([]any)) != 1 || cfg["groups"].([]any)[0].(map[string]any)["monitorAccount"] != nil || cfg["groups"].([]any)[1].(map[string]any)["monitorAccount"] != "bob" {
		t.Fatalf("incorrect removal: %+v", cfg)
	}
	if _, err = os.Stat(filepath.Join(dir, "sessions", "bob.enc")); err != nil {
		t.Fatal("removed another account")
	}
	for _, name := range []string{"sessions/alice.enc", "sessions/native/alice.enc"} {
		if _, err = os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Fatalf("removed account session retained: %s %v", name, err)
		}
	}
	if _, err = os.Stat(filepath.Join(dir, "session.enc")); err != nil {
		t.Fatalf("removing another account touched legacy session: %v", err)
	}
	var gaps int
	if err = db.Reader.QueryRow(`SELECT count(*) FROM tgdl_update_recovery WHERE account_id='alice'`).Scan(&gaps); err != nil || gaps != 0 {
		t.Fatalf("stale recovery marker survived account removal: %d %v", gaps, err)
	}
	if err = db.Reader.QueryRow(`SELECT count(*) FROM tgdl_update_recovery_state WHERE account_id='alice'`).Scan(&gaps); err != nil || gaps != 0 {
		t.Fatalf("stale recovery cursor survived account removal: %d %v", gaps, err)
	}
	if err = repo.Remove(ctx, "../bob"); err == nil {
		t.Fatal("traversal accepted")
	}
}

func TestLegacyRemovalOwnsOnlyExplicitLegacySource(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Reader.Close()
	defer db.Writer.Close()
	repo := NewRepository(db.Writer, db.Reader, dir, new(sync.Mutex))
	if err = (auth.ConfigStore{DB: db.Writer}).Save(ctx, map[string]any{"accounts": []any{map[string]any{"id": "legacy"}}}); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, "session.enc"), []byte("legacy"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = repo.Remove(ctx, "legacy"); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(dir, "session.enc")); !os.IsNotExist(err) {
		t.Fatalf("owned legacy source survived removal: %v", err)
	}
}

func TestLegacyRemovalCleansImportedMarkerWithRelativeJournalPath(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Reader.Close()
	defer db.Writer.Close()
	repo := NewRepository(db.Writer, db.Reader, dir, new(sync.Mutex))
	if err = (auth.ConfigStore{DB: db.Writer}).Save(ctx, map[string]any{"accounts": []any{map[string]any{"id": "legacy"}}}); err != nil {
		t.Fatal(err)
	}
	native := filepath.Join(dir, "sessions", "native")
	if err = os.MkdirAll(native, 0700); err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string]string{"session.enc": "old", "sessions/native/legacy.enc": "converted", "sessions/native/legacy.enc.imported": "legacy\n"} {
		if err = os.MkdirAll(filepath.Dir(filepath.Join(dir, name)), 0700); err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(dir, name), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err = repo.Remove(ctx, "legacy"); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"session.enc", "sessions/native/legacy.enc", "sessions/native/legacy.enc.imported"} {
		if _, err = os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Fatalf("legacy file survived removal: %s (%v)", name, err)
		}
	}
}

func TestPublicationSkipsLabelsReservedByActiveLogin(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Reader.Close()
	defer db.Writer.Close()
	repo := NewRepository(db.Writer, db.Reader, dir, new(sync.Mutex))
	pending := filepath.Join(dir, "sessions", "pending", "new.enc")
	if err = os.MkdirAll(filepath.Dir(pending), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(pending, []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}
	id, err := repo.Publish(ctx, PendingAccount{SessionPath: pending, ReservedLabels: []string{"Alice"}, User: &tg.User{ID: 100, Username: "alice"}})
	if err != nil || id != "alice_1" {
		t.Fatalf("reserved label was reused: %q %v", id, err)
	}
}
