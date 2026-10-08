package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

func TestRunMigrationsIsIdempotentAndPreservesSeedSchema(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "db.sqlite")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	first, err := RunMigrations(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	second, err := RunMigrations(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if first == 0 || second != first {
		t.Fatalf("schema versions = %d then %d", first, second)
	}
	var n int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='downloads'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("downloads table count = %d", n)
	}
}

func TestOpenCreatesMissingDataDirectory(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "nested", "data")
	db, err := Open(context.Background(), dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Writer.Close()
	defer db.Reader.Close()
}
