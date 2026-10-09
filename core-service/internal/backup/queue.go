package backup

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

func (m *Manager) Jobs(ctx context.Context, id int64, status string, limit, offset int, recent bool) ([]map[string]any, error) {
	query := `SELECT j.* FROM backup_jobs j WHERE j.destination_id=?`
	args := []any{id}
	if status != "" {
		query += ` AND j.status=?`
		args = append(args, status)
	}
	query += ` ORDER BY j.id DESC LIMIT ? OFFSET ?`
	args = append(args, max(1, min(500, limit)), max(0, offset))
	if recent {
		query = `SELECT j.*,d.name AS destination_name,d.provider FROM backup_jobs j JOIN backup_destinations d ON d.id=j.destination_id ORDER BY COALESCE(j.finished_at,j.started_at,j.id) DESC LIMIT ?`
		args = []any{max(1, min(200, limit))}
	}
	rows, err := m.opts.Reader.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	for rows.Next() {
		values := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range values {
			ptrs[i] = &values[i]
		}
		if err = rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		row := map[string]any{}
		for i, c := range cols {
			row[c] = values[i]
		}
		out = append(out, row)
	}
	return out, rows.Err()
}
func (m *Manager) Retry(ctx context.Context, id int64) (bool, error) {
	m.op.Lock()
	defer m.op.Unlock()
	if err := m.available(); err != nil {
		return false, err
	}
	var dest int64
	err := m.opts.Reader.QueryRowContext(ctx, `SELECT destination_id FROM backup_jobs WHERE id=?`, id).Scan(&dest)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	m.stop(dest)
	_, err = m.opts.Writer.ExecContext(ctx, `UPDATE backup_jobs SET status='pending',attempts=0,error=NULL,started_at=NULL,finished_at=NULL,next_retry_at=NULL WHERE id=?`, id)
	if d, e := m.load(m.ctx, dest); e == nil && d.Enabled {
		m.start(dest)
	}
	return err == nil, err
}
func (m *Manager) Run(ctx context.Context, id int64) error {
	m.op.Lock()
	defer m.op.Unlock()
	if err := m.available(); err != nil {
		return err
	}
	return m.run(ctx, id)
}
func (m *Manager) run(ctx context.Context, id int64) error {
	d, err := m.load(ctx, id)
	if err != nil {
		return err
	}
	if !d.Enabled {
		return ErrDisabled
	}
	if d.Mode == "mirror" {
		// A set-based INSERT keeps catalog data in SQLite, uses constant Go memory,
		// and makes acceptance atomic with all jobs, including across process death.
		res, e := m.opts.Writer.ExecContext(ctx, `INSERT INTO backup_jobs(destination_id,download_id,remote_path)
   SELECT ?,d.id,REPLACE(d.file_path,char(92),'/') FROM downloads d WHERE d.file_path IS NOT NULL AND d.file_path<>''
   AND NOT EXISTS(SELECT 1 FROM backup_jobs j WHERE j.destination_id=? AND j.download_id=d.id) ORDER BY d.id`, id, id)
		if e != nil {
			return e
		}
		n, e := res.RowsAffected()
		if e != nil {
			return e
		}
		if _, e = m.opts.Writer.ExecContext(ctx, `UPDATE backup_destinations SET last_error=NULL WHERE id=?`, id); e != nil {
			return e
		}
		m.Log("info", fmt.Sprintf("mirror catch-up enqueued %d jobs for #%d", n, id))
	} else {
		// Reserve the archive job before building anything. A crash can restart the
		// snapshot from its database job without an acknowledged run disappearing.
		_, err = m.opts.Writer.ExecContext(ctx, `INSERT INTO backup_jobs(destination_id) SELECT ? WHERE NOT EXISTS(SELECT 1 FROM backup_jobs WHERE destination_id=? AND download_id IS NULL AND status IN ('pending','uploading'))`, id, id)
		if err != nil {
			return err
		}
	}
	m.wake(id)
	return nil
}
func (m *Manager) start(id int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.ctx.Err() != nil || m.workers[id] != nil {
		return
	}
	ctx, cancel := context.WithCancel(m.ctx)
	w := &worker{cancel: cancel, done: make(chan struct{}), wake: make(chan struct{}, 1)}
	m.workers[id] = w
	go func() { defer close(w.done); m.work(ctx, id, w) }()
}
func (m *Manager) stop(id int64) {
	m.mu.Lock()
	w := m.workers[id]
	delete(m.workers, id)
	m.mu.Unlock()
	if w != nil {
		w.cancel()
		<-w.done
	}
}
func (m *Manager) wake(id int64) {
	m.mu.Lock()
	w := m.workers[id]
	m.mu.Unlock()
	if w != nil {
		select {
		case w.wake <- struct{}{}:
		default:
		}
	}
}
func (m *Manager) Wake() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, w := range m.workers {
		select {
		case w.wake <- struct{}{}:
		default:
		}
	}
}

type job struct {
	ID            int64
	Download      sql.NullInt64
	Snapshot      sql.NullString
	Remote        sql.NullString
	Attempts, Max int
	Version       int64
}

func (m *Manager) claim(ctx context.Context, id int64) (job, error) {
	var j job
	err := m.opts.Writer.QueryRowContext(ctx, `UPDATE backup_jobs SET status='uploading',started_at=?,attempts=attempts+1 WHERE id=(SELECT id FROM backup_jobs WHERE destination_id=? AND status='pending' AND (next_retry_at IS NULL OR next_retry_at<=?) ORDER BY id LIMIT 1) RETURNING id,download_id,snapshot_path,remote_path,attempts,max_attempts,COALESCE((SELECT version FROM native_backup_versions WHERE job_id=backup_jobs.id),0)`, time.Now().UnixMilli(), id, time.Now().UnixMilli()).Scan(&j.ID, &j.Download, &j.Snapshot, &j.Remote, &j.Attempts, &j.Max, &j.Version)
	return j, err
}
func (m *Manager) work(ctx context.Context, id int64, w *worker) {
	// Independent destinations run concurrently; each destination has one writer
	// to serialize aliases of the same file, snapshots and retention.
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	drained := false
	var provider Provider
	var pacer *uploadPacer
	defer func() {
		if provider != nil {
			_ = provider.Close()
		}
	}()
	blocked := ""
	var retryProviderAt time.Time
	for {
		if ctx.Err() != nil {
			return
		}
		d, err := m.load(ctx, id)
		if err != nil || !d.Enabled {
			return
		}
		var paused bool
		err = m.opts.Reader.QueryRowContext(ctx, `SELECT paused FROM native_backup_state WHERE destination_id=?`, id).Scan(&paused)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return
		}
		var pending int
		err = m.opts.Reader.QueryRowContext(ctx, `SELECT count(*) FROM backup_jobs WHERE destination_id=? AND status='pending'`, id).Scan(&pending)
		if err != nil {
			return
		}
		var cleanup int
		if err = m.opts.Reader.QueryRowContext(ctx, `SELECT count(*) FROM native_backup_retention r JOIN backup_jobs j ON j.id=r.job_id WHERE j.destination_id=?`, id).Scan(&cleanup); err != nil {
			return
		}
		if !paused && (pending > 0 || cleanup > 0) {
			blockedError := ""
			if d.Encrypted && pending > 0 {
				if !m.unlocked(d) {
					blockedError = "backup encryption is locked; unlock this destination"
				}
			}
			if blockedError == "" && provider == nil && time.Now().Before(retryProviderAt) {
				blockedError = blocked
			}
			if blockedError == "" && provider == nil {
				cfg, e := m.config(ctx, d)
				if e == nil {
					provider, e = m.provider(ctx, d, cfg)
					pacer = newUploadPacer(d.Throttle.Int64)
				}
				if e != nil {
					blockedError = e.Error()
					retryProviderAt = time.Now().Add(30 * time.Second)
				}
			}
			if blockedError != "" {
				if blockedError != blocked {
					blocked = blockedError
					_, _ = m.opts.Writer.ExecContext(ctx, `UPDATE backup_destinations SET last_error=? WHERE id=?`, blocked, id)
					m.Log("warn", fmt.Sprintf("backup #%d waiting: %s", id, blocked))
				}
			} else {
				if cleanup > 0 {
					var done job
					e := m.opts.Reader.QueryRowContext(ctx, `SELECT j.id,j.snapshot_path,j.remote_path FROM native_backup_retention r JOIN backup_jobs j ON j.id=r.job_id WHERE j.destination_id=? ORDER BY j.id LIMIT 1`, id).Scan(&done.ID, &done.Snapshot, &done.Remote)
					if e == nil {
						w.running.Store(true)
						e = m.retention(ctx, d, done, provider)
						w.running.Store(false)
						if e == nil {
							continue
						}
						m.Log("warn", fmt.Sprintf("retention on #%d remains pending: %v", id, e))
					}
				}
				j, e := m.claim(ctx, id)
				if e == nil {
					drained = false
					w.running.Store(true)
					m.transfer(withUploadPacer(ctx, pacer), d, j, provider)
					w.running.Store(false)
					continue
				}
				if !errors.Is(e, sql.ErrNoRows) && ctx.Err() == nil {
					m.Log("error", fmt.Sprintf("worker fill failed: %v", e))
				}
			}
		}
		if !paused && pending == 0 && cleanup == 0 && !drained {
			m.emit("backup_queue_drained", map[string]any{"destinationId": id})
			drained = true
		}
		select {
		case <-ctx.Done():
			return
		case <-w.wake:
			drained = false
		case <-ticker.C:
		}
	}
}
func (m *Manager) transfer(ctx context.Context, d destination, j job, p Provider) {
	var err error
	permanent := false
	sourceName := ""
	var file *os.File
	var root *os.Root
	if !j.Download.Valid {
		sourceName, j.Remote.String, err = m.prepareSnapshot(ctx, d, j)
		j.Snapshot = sql.NullString{String: sourceName, Valid: sourceName != ""}
		j.Remote.Valid = err == nil
		if err == nil {
			root, err = os.OpenRoot(filepath.Join(m.opts.DataDir, "backups"))
			if err == nil {
				file, err = root.Open(filepath.Base(sourceName))
			}
		}
	} else {
		var rel string
		err = m.opts.Reader.QueryRowContext(ctx, `SELECT file_path FROM downloads WHERE id=?`, j.Download.Int64).Scan(&rel)
		if err == nil {
			rel = strings.ReplaceAll(rel, "\\", "/")
			sourceName = filepath.Join(m.opts.downloads(), filepath.FromSlash(rel))
			if e := validObject(rel); e != nil {
				err = e
				permanent = true
			} else {
				root, err = os.OpenRoot(m.opts.downloads())
				if err == nil {
					file, err = root.Open(rel)
				}
			}
		}
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, sql.ErrNoRows) {
			err = fmt.Errorf("local file missing: %s", sourceName)
			permanent = true
		}
	}
	if root != nil {
		defer root.Close()
	}
	if file != nil {
		defer file.Close()
	}
	var result UploadResult
	if err == nil {
		var info fs.FileInfo
		info, err = file.Stat()
		if err == nil && !info.Mode().IsRegular() {
			err = errors.New("backup source is not a regular file")
			permanent = true
		}
		if err == nil {
			var stage *payloadStage
			uploadFile, uploadSize := file, info.Size()
			if d.Encrypted {
				m.mu.Lock()
				key := append([]byte(nil), m.keys[d.ID]...)
				m.mu.Unlock()
				stage, err = m.stagePayload(ctx, file, info.Size(), key)
				clear(key)
				if err == nil {
					uploadFile = stage.file
					uploadSize += payloadHeaderSize + payloadTagSize
				}
			}
			last := time.Time{}
			progress := func(n int64) {
				if time.Since(last) >= 500*time.Millisecond {
					last = time.Now()
					m.emit("backup_progress", map[string]any{"destinationId": d.ID, "jobId": j.ID, "downloadId": nullableInt(j.Download), "bytesUploaded": n})
				}
			}
			if err == nil {
				result, err = p.Upload(ctx, j.Remote.String, uploadFile, uploadSize, progress)
			}
			if stage != nil {
				if e := stage.Close(); e != nil {
					m.Log("warn", fmt.Sprintf("encrypted backup staging cleanup remains pending: %v", e))
				}
			}
		}
	}
	if ctx.Err() != nil {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = m.opts.Writer.ExecContext(cleanup, `UPDATE backup_jobs SET status='pending',started_at=NULL,attempts=MAX(0,attempts-1) WHERE id=? AND status='uploading'`, j.ID)
		return
	}
	if m.requeueChanged(ctx, j) {
		return
	}
	if err != nil {
		m.failed(ctx, d, j, err, permanent)
		return
	}
	tx, err := m.opts.Writer.BeginTx(ctx, nil)
	if err == nil {
		defer tx.Rollback()
		var resultSQL sql.Result
		resultSQL, err = tx.ExecContext(ctx, `UPDATE backup_jobs SET status='done',finished_at=?,bytes_uploaded=?,error=NULL,next_retry_at=NULL,remote_path=? WHERE id=? AND status='uploading' AND COALESCE((SELECT version FROM native_backup_versions WHERE job_id=?),0)=?`, time.Now().UnixMilli(), result.Bytes, j.Remote.String, j.ID, j.ID, j.Version)
		if err == nil {
			n, e := resultSQL.RowsAffected()
			err = e
			if err == nil && n == 0 {
				_, err = tx.ExecContext(ctx, `UPDATE backup_jobs SET status='pending',started_at=NULL,attempts=0 WHERE id=?`, j.ID)
				if err == nil {
					err = tx.Commit()
				}
				if err != nil {
					m.Log("error", fmt.Sprintf("requeue changed backup: %v", err))
				}
				return
			}
		}
		if err == nil {
			_, err = tx.ExecContext(ctx, `UPDATE backup_destinations SET total_bytes=total_bytes+?,total_files=total_files+1,last_success_at=?,last_error=NULL WHERE id=?`, result.Bytes, time.Now().UnixMilli(), d.ID)
		}
		if err == nil && !j.Download.Valid {
			_, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO native_backup_retention(job_id) VALUES(?)`, j.ID)
		}
		if err == nil {
			err = tx.Commit()
		}
	}
	if err != nil {
		m.failed(ctx, d, j, err, false)
		return
	}
	if !j.Download.Valid {
		if e := m.retention(ctx, d, j, p); e != nil {
			m.Log("warn", fmt.Sprintf("retention on #%d remains pending: %v", d.ID, e))
		}
	}
	payload := map[string]any{"destinationId": d.ID, "jobId": j.ID, "downloadId": nullableInt(j.Download), "bytes": result.Bytes}
	if result.Skipped {
		payload["skipped"] = true
	}
	if result.ETag != "" {
		payload["etag"] = result.ETag
	}
	m.emit("backup_done", payload)
	if !result.Skipped {
		m.Log("info", fmt.Sprintf("uploaded %s (%d B) → #%d", j.Remote.String, result.Bytes, d.ID))
	}
}

// If live media changes during transfer, completion belongs to the old
// revision. Preserve the new durable request instead of marking it backed up.
func (m *Manager) requeueChanged(ctx context.Context, j job) bool {
	res, err := m.opts.Writer.ExecContext(ctx, `UPDATE backup_jobs SET status='pending',started_at=NULL,attempts=0 WHERE id=? AND COALESCE((SELECT version FROM native_backup_versions WHERE job_id=?),0)<>?`, j.ID, j.ID, j.Version)
	if err != nil {
		return false
	}
	n, _ := res.RowsAffected()
	return n > 0
}
func (m *Manager) failed(ctx context.Context, d destination, j job, cause error, permanent bool) {
	willRetry := !permanent && j.Attempts < j.Max
	status := "failed"
	var next, finished any = time.Now().Add(time.Duration(1<<min(j.Attempts, 10)) * time.Second).UnixMilli(), nil
	if !willRetry {
		status = "failed"
		next = nil
		finished = time.Now().UnixMilli()
	} else {
		status = "pending"
	}
	msg := cause.Error()
	if len(msg) > 4000 {
		msg = msg[:4000]
	}
	res, err := m.opts.Writer.ExecContext(ctx, `UPDATE backup_jobs SET status=?,error=?,next_retry_at=?,finished_at=? WHERE id=? AND COALESCE((SELECT version FROM native_backup_versions WHERE job_id=?),0)=?`, status, msg, next, finished, j.ID, j.ID, j.Version)
	if err != nil {
		m.Log("error", fmt.Sprintf("record backup failure: %v", err))
		return
	}
	if n, e := res.RowsAffected(); e != nil || n == 0 {
		m.requeueChanged(ctx, j)
		return
	}
	payload := map[string]any{"destinationId": d.ID, "jobId": j.ID, "error": msg, "willRetry": willRetry}
	if !permanent {
		payload["nextRetryAt"] = next
		_, _ = m.opts.Writer.ExecContext(ctx, `UPDATE backup_destinations SET last_error=?,last_failure_at=? WHERE id=?`, msg, time.Now().UnixMilli(), d.ID)
	}
	m.emit("backup_error", payload)
	if permanent {
		m.Log("warn", fmt.Sprintf("job #%d on dest #%d failed: %s", j.ID, d.ID, msg))
	} else {
		m.Log("warn", fmt.Sprintf("upload failed for job #%d on dest #%d: %s", j.ID, d.ID, msg))
	}
}

var snapshotName = regexp.MustCompile(`^snapshot-\d{8}-\d{6}\.tar\.gz$`)

func (m *Manager) retention(ctx context.Context, d destination, j job, p Provider) error {
	if d.Mode == "snapshot" {
		objects, err := p.List(ctx, "snapshots/")
		if err != nil {
			m.Log("warn", fmt.Sprintf("retention on #%d: %v", d.ID, err))
			return err
		}
		snapshots := []Object{}
		for _, o := range objects {
			if strings.Count(o.Path, "/") == 1 && snapshotName.MatchString(strings.TrimPrefix(o.Path, "snapshots/")) {
				snapshots = append(snapshots, o)
			}
		}
		sort.Slice(snapshots, func(i, j int) bool { return snapshots[i].Path > snapshots[j].Path })
		var bytes int64
		kept, pruned, failures := 0, 0, 0
		for i, o := range snapshots {
			if i >= max(1, d.Retain) {
				if e := p.Delete(ctx, o.Path); e == nil {
					pruned++
					continue
				}
				failures++
			}
			kept++
			bytes += o.Size
		}
		if _, err = m.opts.Writer.ExecContext(ctx, `UPDATE backup_destinations SET total_bytes=?,total_files=? WHERE id=?`, bytes, kept, d.ID); err != nil {
			m.Log("warn", fmt.Sprintf("retention statistics: %v", err))
			return err
		}
		msg := fmt.Sprintf("retention on #%d: listed %d, kept %d, pruned %d", d.ID, len(snapshots), kept, pruned)
		if failures > 0 {
			msg += fmt.Sprintf(", %d delete(s) failed", failures)
		}
		m.Log("info", msg)
		if failures > 0 {
			return fmt.Errorf("%d snapshot deletions failed", failures)
		}
		if fresh, e := m.load(ctx, d.ID); e == nil {
			m.emit("backup_destination_updated", map[string]any{"destination": m.scrub(fresh)})
		}
	}
	if j.Snapshot.Valid && snapshotName.MatchString(filepath.Base(j.Snapshot.String)) && filepath.Dir(j.Snapshot.String) == filepath.Join(m.opts.DataDir, "backups") {
		if err := os.Remove(j.Snapshot.String); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	_, err := m.opts.Writer.ExecContext(ctx, `DELETE FROM native_backup_retention WHERE job_id=?`, j.ID)
	return err
}
