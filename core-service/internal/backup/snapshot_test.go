package backup

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

func TestSnapshotUsesSQLiteConsistentBackupAndChecksum(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "source.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items(value) VALUES ('ok')`); err != nil {
		t.Fatal(err)
	}
	result, err := Snapshot(context.Background(), db, t.TempDir(), "nightly")
	if err != nil {
		t.Fatal(err)
	}
	if result.Path == "" || result.Bytes == 0 || result.SHA256 == "" {
		t.Fatalf("snapshot result = %+v", result)
	}
	if _, err := os.Stat(result.Path); err != nil {
		t.Fatal(err)
	}
	copyDB, err := sql.Open("sqlite", result.Path)
	if err != nil {
		t.Fatal(err)
	}
	defer copyDB.Close()
	var value string
	if err := copyDB.QueryRow(`SELECT value FROM items`).Scan(&value); err != nil || value != "ok" {
		t.Fatalf("backup value = %q err=%v", value, err)
	}
}
