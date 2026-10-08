// Package store owns the single Go SQLite writer and the read pool.
package store

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

//go:embed schema.sql engine_schema.sql
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
	writer, err := sql.Open("sqlite", sqliteDSN(dbPath))
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
	reader, err := sql.Open("sqlite", sqliteDSN(dbPath))
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

// PRAGMAs belong to each connection, including new pool entries and replacement
// connections after cancellation. Configuring just the first connection leaves
// subsequent readers/writers without the intended busy timeout or constraints.
func sqliteDSN(path string) string {
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(path)}
	q := url.Values{}
	q.Add("_pragma", "busy_timeout(5000)")
	q.Add("_pragma", "foreign_keys(1)")
	q.Add("_pragma", "synchronous(NORMAL)")
	u.RawQuery = q.Encode()
	return u.String()
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
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS tgdl_verified_media (
		path TEXT PRIMARY KEY NOT NULL, size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, sha256 TEXT NOT NULL, fingerprint TEXT NOT NULL
	)`); err != nil {
		return 0, fmt.Errorf("create verified media cache: %w", err)
	}
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS tgdl_ingest_files (
        path TEXT PRIMARY KEY NOT NULL, item TEXT NOT NULL, generation INTEGER NOT NULL, sha256 TEXT NOT NULL DEFAULT ''
    )`); err != nil {
		return 0, fmt.Errorf("create ingest journal: %w", err)
	}
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS tgdl_derived_cleanup (area TEXT NOT NULL,path TEXT NOT NULL,PRIMARY KEY(area,path))`); err != nil {
		return 0, err
	}
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS tgdl_message_generations (
      group_id TEXT NOT NULL,message_id INTEGER NOT NULL,generation INTEGER NOT NULL,PRIMARY KEY(group_id,message_id))`); err != nil {
		return 0, err
	}
	engineSchema, err := schemaFS.ReadFile("engine_schema.sql")
	if err != nil {
		return 0, err
	}
	if _, err = db.ExecContext(ctx, string(engineSchema)); err != nil {
		return 0, fmt.Errorf("create engine schema: %w", err)
	}
	var pausedColumn int
	var originColumn int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM pragma_table_info('tgdl_work') WHERE name='origin'`).Scan(&originColumn); err != nil {
		return 0, err
	}
	if originColumn == 0 {
		if _, err := db.ExecContext(ctx, `ALTER TABLE tgdl_work ADD COLUMN origin TEXT NOT NULL DEFAULT 'live'`); err != nil {
			return 0, err
		}
	}
	if _, err := db.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_tgdl_work_priority ON tgdl_work(status,paused,CASE origin WHEN 'history' THEN 1 ELSE 0 END,id)`); err != nil {
		return 0, err
	}
	var refreshColumn int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM pragma_table_info('tgdl_work') WHERE name='refresh_required'`).Scan(&refreshColumn); err != nil {
		return 0, err
	}
	if refreshColumn == 0 {
		if _, err := db.ExecContext(ctx, `ALTER TABLE tgdl_work ADD COLUMN refresh_required INTEGER NOT NULL DEFAULT 0`); err != nil {
			return 0, err
		}
	}
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM pragma_table_info('tgdl_work') WHERE name='paused'`).Scan(&pausedColumn); err != nil {
		return 0, fmt.Errorf("inspect queue schema: %w", err)
	}
	if pausedColumn == 0 {
		if _, err := db.ExecContext(ctx, `ALTER TABLE tgdl_work ADD COLUMN paused INTEGER NOT NULL DEFAULT 0`); err != nil {
			return 0, fmt.Errorf("add queue pause state: %w", err)
		}
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
