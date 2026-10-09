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
	schema, err := schemaFS.ReadFile("schema.sql")
	if err != nil {
		return 0, fmt.Errorf("read embedded schema: %w", err)
	}
	if tables != 0 {
		// Databases created by older Node releases lack columns and tables
		// that later releases added lazily (or never). Add what is missing
		// before the base schema creates indexes that reference them.
		if err := reconcileSchema(ctx, db, string(schema)); err != nil {
			return 0, fmt.Errorf("upgrade older database schema: %w", err)
		}
	}
	if _, err := db.ExecContext(ctx, makeIdempotent(string(schema))); err != nil {
		return 0, fmt.Errorf("apply base schema: %w", err)
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
	// Descriptive Telegram media facts for likely-duplicate detection. Added
	// columns only; existing rows simply keep NULLs.
	for _, column := range []struct{ name, kind string }{
		{"telegram_mime", "TEXT"}, {"media_width", "INTEGER"}, {"media_height", "INTEGER"},
		{"media_duration_ms", "INTEGER"}, {"forward_origin", "TEXT"}, {"telegram_thumb", "BLOB"},
	} {
		var exists int
		if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM pragma_table_info('downloads') WHERE name=?`, column.name).Scan(&exists); err != nil {
			return 0, err
		}
		if exists == 0 {
			if _, err := db.ExecContext(ctx, `ALTER TABLE downloads ADD COLUMN `+column.name+` `+column.kind); err != nil {
				return 0, fmt.Errorf("add media fact %s: %w", column.name, err)
			}
		}
	}
	if _, err := db.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_media_facts ON downloads(file_type, media_duration_ms, media_width, media_height) WHERE media_width IS NOT NULL OR media_duration_ms IS NOT NULL`); err != nil {
		return 0, err
	}
	var version int
	// The old runtime placed stories in the message ID namespace. Relocate
	// only positively identified story rows; keep row IDs, files and metadata.
	// A conflicting reserved key is an error, never permission to overwrite.
	if _, err := db.ExecContext(ctx, `UPDATE downloads SET message_id=4294967296+message_id WHERE file_type='stories' AND message_id BETWEEN 1 AND 2147483647`); err != nil {
		return 0, fmt.Errorf("separate story catalog identifiers: %w", err)
	}
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

// reconcileSchema adds every column of the reference schema that an existing
// table lacks. Columns are only ever added, never changed or dropped; a
// primary-key column cannot be added and is left alone.
func reconcileSchema(ctx context.Context, db *sql.DB, schema string) error {
	ref, err := sql.Open("sqlite", "file:tgdl-schema-reference?mode=memory&cache=private")
	if err != nil {
		return err
	}
	defer ref.Close()
	ref.SetMaxOpenConns(1)
	if _, err := ref.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("load reference schema: %w", err)
	}
	rows, err := ref.QueryContext(ctx, `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%'`)
	if err != nil {
		return err
	}
	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return err
		}
		tables = append(tables, name)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	type column struct {
		name, kind string
		notNull    bool
		dflt       sql.NullString
		pk         int
	}
	read := func(conn *sql.DB, table string) ([]column, error) {
		rows, err := conn.QueryContext(ctx, `SELECT name,type,"notnull",dflt_value,pk FROM pragma_table_info(?)`, table)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []column
		for rows.Next() {
			var c column
			if err := rows.Scan(&c.name, &c.kind, &c.notNull, &c.dflt, &c.pk); err != nil {
				return nil, err
			}
			out = append(out, c)
		}
		return out, rows.Err()
	}
	for _, table := range tables {
		have, err := read(db, table)
		if err != nil {
			return err
		}
		if len(have) == 0 {
			continue // missing table: the idempotent base schema creates it
		}
		existing := map[string]bool{}
		for _, c := range have {
			existing[strings.ToLower(c.name)] = true
		}
		want, err := read(ref, table)
		if err != nil {
			return err
		}
		for _, c := range want {
			if existing[strings.ToLower(c.name)] || c.pk > 0 {
				continue
			}
			stmt := `ALTER TABLE "` + table + `" ADD COLUMN "` + c.name + `" ` + c.kind
			if c.dflt.Valid {
				if c.notNull {
					stmt += " NOT NULL"
				}
				stmt += " DEFAULT " + c.dflt.String
			}
			if _, err := db.ExecContext(ctx, stmt); err != nil {
				return fmt.Errorf("add %s.%s: %w", table, c.name, err)
			}
		}
	}
	return nil
}
