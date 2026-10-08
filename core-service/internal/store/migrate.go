// Package store owns the single Go SQLite writer and the read pool.
package store

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schemaFS embed.FS

const schemaVersion = 1

// DB contains the writer and read-only query pool used by the Go server.
type DB struct {
	Writer *sql.DB
	Reader *sql.DB
}

// Open creates the database at dataDir/db.sqlite and applies migrations.
func Open(ctx context.Context, dataDir string) (*DB, error) {
	if strings.TrimSpace(dataDir) == "" {
		return nil, errors.New("data directory is required")
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}
	dbPath := filepath.Join(dataDir, "db.sqlite")
	writer, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open writer: %w", err)
	}
	writer.SetMaxOpenConns(1)
	writer.SetMaxIdleConns(1)
	if err := configure(ctx, writer); err != nil {
		writer.Close()
		return nil, err
	}
	if _, err := RunMigrations(ctx, writer); err != nil {
		writer.Close()
		return nil, err
	}
	reader, err := sql.Open("sqlite", dbPath)
	if err != nil {
		writer.Close()
		return nil, fmt.Errorf("open reader: %w", err)
	}
	reader.SetMaxOpenConns(8)
	reader.SetMaxIdleConns(8)
	if err := configure(ctx, reader); err != nil {
		reader.Close()
		writer.Close()
		return nil, err
	}
	return &DB{Writer: writer, Reader: reader}, nil
}

func configure(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;`)
	if err != nil {
		return fmt.Errorf("configure sqlite: %w", err)
	}
	return nil
}

// RunMigrations is idempotent and safe for a database created by the existing
// Node release. It never drops or renames an existing column.
func RunMigrations(ctx context.Context, db *sql.DB) (int, error) {
	if db == nil {
		return 0, errors.New("nil sqlite database")
	}
	var tables int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='downloads'`).Scan(&tables); err != nil {
		return 0, fmt.Errorf("inspect schema: %w", err)
	}
	if tables == 0 {
		schema, err := schemaFS.ReadFile("schema.sql")
		if err != nil {
			return 0, fmt.Errorf("read embedded schema: %w", err)
		}
		if _, err := db.ExecContext(ctx, makeIdempotent(string(schema))); err != nil {
			return 0, fmt.Errorf("apply base schema: %w", err)
		}
	}
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS tgdl_schema_meta (version INTEGER NOT NULL); INSERT INTO tgdl_schema_meta(version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM tgdl_schema_meta);`); err != nil {
		return 0, fmt.Errorf("record schema version: %w", err)
	}
	// File cleanup is a durable outbox: a process exit between the database
	// commit and unlink must not silently abandon files or undo deleted rows.
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS tgdl_file_cleanup (path TEXT PRIMARY KEY NOT NULL)`); err != nil {
		return 0, fmt.Errorf("create file cleanup queue: %w", err)
	}
	var version int
	if err := db.QueryRowContext(ctx, `SELECT version FROM tgdl_schema_meta LIMIT 1`).Scan(&version); err != nil {
		return 0, fmt.Errorf("read schema version: %w", err)
	}
	return version, nil
}

func makeIdempotent(schema string) string {
	schema = strings.ReplaceAll(schema, "CREATE VIRTUAL TABLE ", "CREATE VIRTUAL TABLE IF NOT EXISTS ")
	schema = strings.ReplaceAll(schema, "CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ")
	schema = strings.ReplaceAll(schema, "CREATE INDEX ", "CREATE INDEX IF NOT EXISTS ")
	schema = strings.ReplaceAll(schema, "CREATE TRIGGER ", "CREATE TRIGGER IF NOT EXISTS ")
	return schema
}
