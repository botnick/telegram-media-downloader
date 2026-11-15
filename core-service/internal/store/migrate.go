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
	"time"

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
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS tgdl_processing_attempts (
		id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL, group_name TEXT NOT NULL DEFAULT '', message_id INTEGER NOT NULL,
		file_name TEXT NOT NULL DEFAULT '', file_size INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL DEFAULT '',
		outcome TEXT NOT NULL DEFAULT 'processing', reason TEXT NOT NULL DEFAULT '', media_hash TEXT NOT NULL DEFAULT '', media_key TEXT NOT NULL DEFAULT '',
		forward_status TEXT NOT NULL DEFAULT 'not_applicable', forward_reason TEXT NOT NULL DEFAULT '',
		local_delete_status TEXT NOT NULL DEFAULT 'not_requested', local_delete_reason TEXT NOT NULL DEFAULT '', local_deleted INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL, completed_at INTEGER NOT NULL DEFAULT 0
	)`); err != nil {
		return 0, fmt.Errorf("create processing history: %w", err)
	}
	if _, err := db.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_tgdl_processing_attempts_group_id ON tgdl_processing_attempts(group_id,id DESC)`); err != nil {
		return 0, err
	}
	if _, err := db.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_tgdl_processing_attempts_message ON tgdl_processing_attempts(group_id,message_id,id DESC)`); err != nil {
		return 0, err
	}
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS tgdl_forward_queue (
		id INTEGER PRIMARY KEY AUTOINCREMENT, history_id INTEGER NOT NULL DEFAULT 0, group_id TEXT NOT NULL, group_name TEXT NOT NULL DEFAULT '',
		message_id INTEGER NOT NULL, file_name TEXT NOT NULL DEFAULT '', topic_id INTEGER NOT NULL DEFAULT 0, caption TEXT NOT NULL DEFAULT '',
		record_id INTEGER NOT NULL DEFAULT 0, file_path TEXT NOT NULL DEFAULT '', facts_json TEXT NOT NULL DEFAULT '{}', source_message BLOB NOT NULL DEFAULT X'', forward_config_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending',
		reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER NOT NULL DEFAULT 0
	)`); err != nil {
		return 0, fmt.Errorf("create forward queue: %w", err)
	}
	columns, err := db.QueryContext(ctx, `PRAGMA table_info(tgdl_forward_queue)`)
	if err != nil {
		return 0, err
	}
	hasForwardConfig := false
	hasForwardStage, hasForwardDestinations, hasForwardAttempts, hasForwardRetryAt, hasForwardSourceKind, hasSourceMessage := false, false, false, false, false, false
	for columns.Next() {
		var cid, notNull, primaryKey int
		var name, kind string
		var defaultValue any
		if err := columns.Scan(&cid, &name, &kind, &notNull, &defaultValue, &primaryKey); err != nil {
			columns.Close()
			return 0, err
		}
		if name == "forward_config_json" {
			hasForwardConfig = true
		}
		if name == "stage" {
			hasForwardStage = true
		}
		if name == "destinations_json" {
			hasForwardDestinations = true
		}
		if name == "attempts" {
			hasForwardAttempts = true
		}
		if name == "retry_at" {
			hasForwardRetryAt = true
		}
		if name == "source_kind" {
			hasForwardSourceKind = true
		}
		if name == "source_message" {
			hasSourceMessage = true
		}
	}
	if err := columns.Close(); err != nil {
		return 0, err
	}
	if !hasForwardConfig {
		if _, err := db.ExecContext(ctx, `ALTER TABLE tgdl_forward_queue ADD COLUMN forward_config_json TEXT NOT NULL DEFAULT '{}'`); err != nil {
			return 0, fmt.Errorf("add forward queue config snapshot: %w", err)
		}
	}
	if !hasForwardStage {
		if _, err := db.ExecContext(ctx, `ALTER TABLE tgdl_forward_queue ADD COLUMN stage TEXT NOT NULL DEFAULT 'forward'`); err != nil {
			return 0, err
		}
	}
	if !hasForwardDestinations {
		if _, err := db.ExecContext(ctx, `ALTER TABLE tgdl_forward_queue ADD COLUMN destinations_json TEXT NOT NULL DEFAULT '[]'`); err != nil {
			return 0, err
		}
	}
	if !hasForwardAttempts {
		if _, err := db.ExecContext(ctx, `ALTER TABLE tgdl_forward_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`); err != nil {
			return 0, err
		}
	}
	if !hasForwardRetryAt {
		if _, err := db.ExecContext(ctx, `ALTER TABLE tgdl_forward_queue ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0`); err != nil {
			return 0, err
		}
	}
	if !hasForwardSourceKind {
		if _, err := db.ExecContext(ctx, `ALTER TABLE tgdl_forward_queue ADD COLUMN source_kind TEXT NOT NULL DEFAULT ''`); err != nil {
			return 0, fmt.Errorf("add forward queue source kind: %w", err)
		}
	}
	if !hasSourceMessage {
		if _, err := db.ExecContext(ctx, `ALTER TABLE tgdl_forward_queue ADD COLUMN source_message BLOB NOT NULL DEFAULT X''`); err != nil {
			return 0, fmt.Errorf("add forward queue source message: %w", err)
		}
	}
	if _, err := db.ExecContext(ctx, `UPDATE tgdl_forward_queue SET source_kind='scan_direct'
		WHERE id IN (
			SELECT MIN(id) FROM tgdl_forward_queue
			WHERE history_id=0 AND record_id=0 AND file_path=''
			GROUP BY group_id,message_id
		)
		AND NOT EXISTS (
			SELECT 1 FROM tgdl_forward_queue existing
			WHERE existing.group_id=tgdl_forward_queue.group_id AND existing.message_id=tgdl_forward_queue.message_id AND existing.source_kind='scan_direct'
		)`); err != nil {
		return 0, fmt.Errorf("backfill direct scan deduplication keys: %w", err)
	}
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS tgdl_forward_queue_state (id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL DEFAULT 0);
		INSERT INTO tgdl_forward_queue_state(id,paused) VALUES(1,0) ON CONFLICT(id) DO NOTHING;
		CREATE TABLE IF NOT EXISTS tgdl_forward_queue_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL, action TEXT NOT NULL, created_at INTEGER NOT NULL, detail TEXT NOT NULL DEFAULT '');
		CREATE TABLE IF NOT EXISTS tgdl_forward_account_limits (account_id TEXT PRIMARY KEY NOT NULL, blocked_until INTEGER NOT NULL DEFAULT 0);
		DROP INDEX IF EXISTS idx_tgdl_forward_scan_once;
		CREATE UNIQUE INDEX idx_tgdl_forward_scan_once ON tgdl_forward_queue(group_id,message_id) WHERE source_kind='scan_direct';`); err != nil {
		return 0, fmt.Errorf("create independent forward queue state: %w", err)
	}
	if _, err := db.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_tgdl_forward_queue_status ON tgdl_forward_queue(status,id)`); err != nil {
		return 0, err
	}
	if _, err := db.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_tgdl_forward_queue_due ON tgdl_forward_queue(status,retry_at,id)`); err != nil {
		return 0, err
	}
	// Match the actionable Queue UI's priority expression and id DESC ordering.
	// A plain (status,id) index cannot satisfy ORDER BY CASE(status).
	if _, err := db.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_tgdl_forward_queue_page ON tgdl_forward_queue(
		(CASE status WHEN 'pending' THEN 0 WHEN 'processing' THEN 1 WHEN 'uncertain' THEN 2 ELSE 3 END), id DESC
	) WHERE status IN ('pending','processing','failed','interrupted','uncertain')`); err != nil {
		return 0, fmt.Errorf("create forward queue pagination index: %w", err)
	}
	now := time.Now().UnixMilli()
	if _, err := db.ExecContext(ctx, `UPDATE tgdl_forward_queue SET status='uncertain',reason='server restarted while Telegram delivery outcome was unknown',updated_at=?,completed_at=? WHERE status='processing'`, now, now); err != nil {
		return 0, err
	}
	if _, err := db.ExecContext(ctx, `UPDATE tgdl_processing_attempts SET outcome='interrupted',reason='server restarted before processing completed',completed_at=? WHERE outcome='processing'`, now); err != nil {
		return 0, err
	}
	if _, err := db.ExecContext(ctx, `UPDATE tgdl_processing_attempts SET outcome='interrupted',reason='processing cancelled (context canceled)',completed_at=? WHERE outcome='failed' AND reason IN ('download Telegram media: context canceled','download Telegram media: write output: context canceled')`, now); err != nil {
		return 0, err
	}
	if _, err := db.ExecContext(ctx, `UPDATE tgdl_processing_attempts SET forward_status='uncertain',forward_reason='server restarted while Telegram delivery outcome was unknown',completed_at=?
		WHERE EXISTS (SELECT 1 FROM tgdl_forward_queue q WHERE q.history_id=tgdl_processing_attempts.id AND q.status='uncertain')`, now); err != nil {
		return 0, err
	}
	if _, err := db.ExecContext(ctx, `UPDATE tgdl_processing_attempts SET forward_status='interrupted',forward_reason='server restarted before forwarding completed',completed_at=?
		WHERE (forward_status='processing' AND NOT EXISTS (SELECT 1 FROM tgdl_forward_queue q WHERE q.history_id=tgdl_processing_attempts.id AND q.status='uncertain'))
		OR (forward_status='pending' AND NOT EXISTS (SELECT 1 FROM tgdl_forward_queue q WHERE q.history_id=tgdl_processing_attempts.id AND q.status IN ('pending','processing','uncertain')))`, now); err != nil {
		return 0, err
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
	// Self-destructing media jumps the queue; the claim order (and so this
	// index) gained a TTL lane. Rebuild an index from older releases once.
	var ttlColumn int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM pragma_table_info('tgdl_work') WHERE name='ttl_seconds'`).Scan(&ttlColumn); err != nil {
		return 0, err
	}
	if ttlColumn == 0 {
		if _, err := db.ExecContext(ctx, `ALTER TABLE tgdl_work ADD COLUMN ttl_seconds INTEGER NOT NULL DEFAULT 0`); err != nil {
			return 0, err
		}
	}
	var prioritySQL sql.NullString
	if err := db.QueryRowContext(ctx, `SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_tgdl_work_priority'`).Scan(&prioritySQL); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	if prioritySQL.Valid && !strings.Contains(prioritySQL.String, "ttl_seconds") {
		if _, err := db.ExecContext(ctx, `DROP INDEX idx_tgdl_work_priority`); err != nil {
			return 0, err
		}
	}
	if _, err := db.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_tgdl_work_priority ON tgdl_work(status,paused,CASE WHEN ttl_seconds>0 THEN 0 WHEN origin='history' THEN 2 ELSE 1 END,id)`); err != nil {
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
