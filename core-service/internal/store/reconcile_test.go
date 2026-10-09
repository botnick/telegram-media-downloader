package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

// A database created by an early Node release has only the original
// downloads columns and none of the later tables.
func TestOpenUpgradesEarlyNodeDatabase(t *testing.T) {
	dir := t.TempDir()
	old, err := sql.Open("sqlite", filepath.Join(dir, "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(`CREATE TABLE downloads (
		id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL, group_name TEXT, message_id INTEGER NOT NULL,
		file_name TEXT, file_size INTEGER, file_type TEXT, file_path TEXT, status TEXT DEFAULT 'completed',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(group_id, message_id));
		INSERT INTO downloads(group_id,message_id,file_name,file_path) VALUES('-1001',7,'a.jpg','g/a.jpg');
		CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);`); err != nil {
		t.Fatal(err)
	}
	old.Close()
	db, err := Open(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Writer.Close()
	defer db.Reader.Close()
	var kind sql.NullString
	var pinned int
	if err := db.Reader.QueryRow(`SELECT telegram_media_kind, pinned FROM downloads d WHERE d.message_id=7`).Scan(&kind, &pinned); err != nil {
		t.Fatalf("upgraded columns: %v", err)
	}
	if kind.Valid || pinned != 0 {
		t.Fatalf("kind=%v pinned=%d", kind, pinned)
	}
	var n int
	if err := db.Reader.QueryRow(`SELECT count(*) FROM sqlite_master WHERE name IN ('idx_telegram_media','web_sessions','update_history','idx_file_hash')`).Scan(&n); err != nil || n != 4 {
		t.Fatalf("missing schema objects: %d %v", n, err)
	}
	if _, err := RunMigrations(context.Background(), db.Writer); err != nil {
		t.Fatalf("second migration: %v", err)
	}
}
