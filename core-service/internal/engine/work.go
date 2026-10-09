// Package engine owns account lifetimes and the durable Telegram work queue.
package engine

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/rescue"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/bin"
	"github.com/gotd/td/tg"
)

type WorkStore struct{ writer, reader *sql.DB }

var errFiltered = errors.New("queued message no longer matches download filters")
var ErrFiltered = errFiltered

func NewWorkStore(writer, reader *sql.DB) *WorkStore {
	return &WorkStore{writer: writer, reader: reader}
}

type Work struct {
	ID, MessageID, Generation                          int64
	AccountID, GroupID, GroupName, MediaType, FileName string
	FileSize                                           int64
	Attempts                                           int
	CreatedAt                                          int64
	ForceRefresh                                       bool
	Origin                                             string
	body                                               []byte
}

func (w *Work) Message() (*tg.Message, error) {
	var message tg.Message
	if err := message.Decode(&bin.Buffer{Buf: w.body}); err != nil {
		return nil, fmt.Errorf("decode queued Telegram message: %w", err)
	}
	return &message, nil
}

// Enqueue commits before an update can advance its Telegram state. Identical
// updates from multiple accounts keep the original source account. A newer
// edit replaces the payload but keeps a running claim until it is released.
func (s *WorkStore) Enqueue(ctx context.Context, accountID string, target Target, message *tg.Message, updatePTS ...int) (int64, bool, error) {
	pts := 0
	if len(updatePTS) > 0 {
		pts = updatePTS[0]
	}
	return enqueueWork(ctx, s.writer, accountID, target, message, pts, "live")
}

type queueWriter interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func enqueueWork(ctx context.Context, db queueWriter, accountID string, target Target, message *tg.Message, pts int, origin string, repair ...bool) (int64, bool, error) {
	media, err := telegram.MessageAttachment(message)
	if err != nil {
		return 0, false, err
	}
	if accountID == "" {
		return 0, false, errors.New("queue account is required")
	}
	sourcePTS := int64(pts)
	if origin == "stories" {
		media.MessageID, err = telegram.StoryKey(message.ID)
		if err != nil {
			return 0, false, err
		}
		media.Type = "stories"
	}
	buffer := bin.Buffer{}
	if err = message.Encode(&buffer); err != nil {
		return 0, false, err
	}
	if target.ID == "" {
		target.ID = media.GroupID
	}
	if err := rescue.Observe(ctx, db, accountID, target.ID, message, origin); err != nil {
		return 0, false, err
	}
	if origin == "stories" {
		// Stories have no message PTS. Explicit reads serialize in the app and
		// enqueue in a transaction. Use a durable sequence independent of the
		// wall clock, including across account changes and process restarts.
		if err = db.QueryRowContext(ctx, `SELECT COALESCE((SELECT source_pts FROM tgdl_work WHERE group_id=? AND message_id=?),0)+1`, target.ID, media.MessageID).Scan(&sourcePTS); err != nil {
			return 0, false, err
		}
	}
	version := max(message.Date, message.EditDate)
	_, channel := message.PeerID.(*tg.PeerChannel)
	comparable := channel || origin == "stories"
	now := time.Now().UnixMilli()
	verifyExisting := len(repair) > 0 && repair[0] && origin != "live"
	var id int64
	err = db.QueryRowContext(ctx, `INSERT INTO tgdl_work(account_id,group_id,group_name,message_id,version,source_pts,identity,media_type,file_name,file_size,body,created_at,updated_at,origin)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
 ON CONFLICT(group_id,message_id) DO UPDATE SET
 account_id=excluded.account_id,group_name=excluded.group_name,version=excluded.version,
 source_pts=CASE WHEN excluded.version=tgdl_work.version AND excluded.identity=tgdl_work.identity AND (? OR excluded.account_id=tgdl_work.account_id)
 THEN MAX(tgdl_work.source_pts,excluded.source_pts) ELSE excluded.source_pts END,identity=excluded.identity,
 media_type=excluded.media_type,file_name=excluded.file_name,file_size=excluded.file_size,body=excluded.body,
 generation=tgdl_work.generation+1,attempts=0,retry_at=0,error=NULL,refresh_required=0,updated_at=excluded.updated_at,
 origin=CASE WHEN excluded.origin='url' THEN 'url' WHEN tgdl_work.origin<>'live' THEN tgdl_work.origin ELSE excluded.origin END,
 status=CASE WHEN tgdl_work.status='processing' THEN 'processing' ELSE 'pending' END
 WHERE excluded.version>tgdl_work.version OR (excluded.version=tgdl_work.version AND excluded.identity<>tgdl_work.identity
 AND excluded.source_pts>tgdl_work.source_pts AND (? OR excluded.account_id=tgdl_work.account_id))
 OR (excluded.origin<>'live' AND excluded.version=tgdl_work.version AND excluded.identity=tgdl_work.identity
 AND ((tgdl_work.origin='live' AND tgdl_work.status='pending')
 OR (excluded.origin='url' AND tgdl_work.origin<>'url' AND tgdl_work.status IN ('pending','processing'))))
 OR (? AND excluded.version=tgdl_work.version AND excluded.identity=tgdl_work.identity AND tgdl_work.status IN ('completed','skipped','failed'))
 RETURNING id`, accountID, target.ID, target.Name, media.MessageID, version, sourcePTS, media.Identity.Key(), media.Type, media.Name, media.Identity.Size, buffer.Buf, now, now, origin, comparable, comparable, verifyExisting).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		// A repeated identity can still carry a newer ordering watermark. Keep
		// it without requeueing, otherwise an intermediate delayed edit could
		// replace a later observation of the current attachment.
		_, err = db.ExecContext(ctx, `UPDATE tgdl_work SET source_pts=MAX(source_pts,?)
 WHERE group_id=? AND message_id=? AND version=? AND identity=? AND (? OR account_id=?)`, sourcePTS, target.ID, media.MessageID, version, media.Identity.Key(), comparable, accountID)
		return 0, false, err
	}
	return id, err == nil, err
}

// Claim changes pending -> processing in one SQLite statement. Only accounts
// whose authenticated Run callback is active can claim their own work.
func (s *WorkStore) Claim(ctx context.Context, accounts []string, now time.Time, manualOnly ...bool) (*Work, error) {
	if len(accounts) == 0 {
		return nil, nil
	}
	args := []any{now.UnixMilli()}
	marks := make([]string, len(accounts))
	for i, id := range accounts {
		marks[i] = "?"
		args = append(args, id)
	}
	args = append(args, now.UnixMilli())
	originClause := ""
	if len(manualOnly) > 0 && manualOnly[0] {
		originClause = " AND origin<>'live'"
	}
	row := s.writer.QueryRowContext(ctx, `UPDATE tgdl_work SET status='processing',claim_generation=generation,attempts=attempts+1,updated_at=?
	 WHERE id=(SELECT id FROM tgdl_work WHERE status='pending' AND paused=0 AND (SELECT paused FROM tgdl_queue_state WHERE id=1)=0 AND account_id IN (`+strings.Join(marks, ",")+`) AND retry_at<=?`+originClause+` ORDER BY CASE origin WHEN 'history' THEN 1 ELSE 0 END,id LIMIT 1)
 RETURNING id,account_id,group_id,group_name,message_id,generation,media_type,file_name,file_size,body,attempts,created_at,refresh_required,origin`, args...)
	w := new(Work)
	if err := row.Scan(&w.ID, &w.AccountID, &w.GroupID, &w.GroupName, &w.MessageID, &w.Generation, &w.MediaType, &w.FileName, &w.FileSize, &w.body, &w.Attempts, &w.CreatedAt, &w.ForceRefresh, &w.Origin); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return w, nil
}

// Finish cannot acknowledge an edit that arrived during an older claim. A
// shutdown cancellation preserves pending work instead of recording failure.
func (s *WorkStore) Finish(ctx context.Context, w *Work, cause error, cancelled bool, retryAt time.Time) error {
	status := "completed"
	var detail any
	if cause != nil {
		detail = cause.Error()
		status = "failed"
	}
	if errors.Is(cause, errFiltered) {
		status = "skipped"
	}
	if cancelled || !retryAt.IsZero() {
		status = "pending"
	}
	when := int64(0)
	if !retryAt.IsZero() {
		when = retryAt.UnixMilli()
	}
	_, err := s.writer.ExecContext(ctx, `UPDATE tgdl_work SET
 status=CASE WHEN generation<>? THEN 'pending' ELSE ? END,
 error=CASE WHEN generation<>? THEN NULL ELSE ? END,
 retry_at=CASE WHEN generation<>? THEN 0 ELSE ? END,
 body=CASE WHEN generation=? AND ? IN ('completed','skipped') THEN X'' ELSE body END,
 attempts=CASE WHEN generation=? AND ? THEN MAX(0,attempts-1) ELSE attempts END,
 claim_generation=NULL,updated_at=?
 WHERE id=? AND status='processing' AND claim_generation=?`, w.Generation, status, w.Generation, detail, w.Generation, when, w.Generation, status, w.Generation, cancelled, time.Now().UnixMilli(), w.ID, w.Generation)
	return err
}

// IsCurrent closes the interval between claiming work and registering its
// cancellation function. Later edits cancel through the active map.
func (s *WorkStore) IsCurrent(ctx context.Context, w *Work) (bool, error) {
	var current bool
	err := s.reader.QueryRowContext(ctx, `SELECT generation=? AND status='processing' AND claim_generation=? FROM tgdl_work WHERE id=?`, w.Generation, w.Generation, w.ID).Scan(&current)
	return current, err
}

// Refresh persists renewed file references. If Telegram now reports another
// attachment, replace only this claim's generation and let the next claim own
// the new media; an update arriving during the RPC always wins.
func (s *WorkStore) Refresh(ctx context.Context, w *Work, message *tg.Message) (bool, error) {
	media, err := telegram.MessageAttachment(message)
	if err != nil {
		return false, err
	}
	if w.Origin == "stories" {
		media.Type = "stories"
	}
	buf := bin.Buffer{}
	if err = message.Encode(&buf); err != nil {
		return false, err
	}
	var generation int64
	err = s.writer.QueryRowContext(ctx, `UPDATE tgdl_work SET
 generation=generation+CASE WHEN identity<>? THEN 1 ELSE 0 END,
 attempts=CASE WHEN identity<>? THEN 0 ELSE attempts END,
 version=MAX(version,?),identity=?,media_type=?,file_name=?,file_size=?,body=?,refresh_required=0,updated_at=?
 WHERE id=? AND generation=? AND claim_generation=? AND status='processing' RETURNING generation`,
		media.Identity.Key(), media.Identity.Key(), max(message.Date, message.EditDate), media.Identity.Key(), media.Type, media.Name, media.Identity.Size, buf.Buf, time.Now().UnixMilli(), w.ID, w.Generation, w.Generation).Scan(&generation)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return generation == w.Generation, err
}

// Recover runs under exclusive engine ownership before any worker starts.
func (s *WorkStore) Recover(ctx context.Context) error {
	_, err := s.writer.ExecContext(ctx, `UPDATE tgdl_work SET status='pending',claim_generation=NULL WHERE status='processing'`)
	return err
}

func (s *WorkStore) Counts(ctx context.Context) (map[string]int, error) {
	rows, err := s.reader.QueryContext(ctx, `SELECT status,count(*) FROM tgdl_work GROUP BY status`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{"pending": 0, "processing": 0, "completed": 0, "failed": 0}
	for rows.Next() {
		var status string
		var count int
		if err = rows.Scan(&status, &count); err != nil {
			return nil, err
		}
		out[status] = count
	}
	return out, rows.Err()
}

func (s *WorkStore) QueuePaused(ctx context.Context) (bool, error) {
	var paused bool
	err := s.reader.QueryRowContext(ctx, `SELECT paused<>0 FROM tgdl_queue_state WHERE id=1`).Scan(&paused)
	return paused, err
}

func (s *WorkStore) SetQueuePaused(ctx context.Context, paused bool) error {
	value := 0
	if paused {
		value = 1
	}
	now := time.Now().UnixMilli()
	if _, err := s.writer.ExecContext(ctx, `UPDATE tgdl_queue_state SET paused=?,updated_at=? WHERE id=1`, value, now); err != nil {
		return err
	}
	if !paused {
		// The Node queue's resume-all action also clears individual pauses. Keep
		// that durable behavior so a restart cannot leave a row unexpectedly
		// hidden after the operator resumed the whole queue.
		_, err := s.writer.ExecContext(ctx, `UPDATE tgdl_work SET paused=0,updated_at=? WHERE paused<>0 AND status IN ('pending','processing')`, now)
		return err
	}
	return nil
}

func (s *WorkStore) PausedCount(ctx context.Context) (int, error) {
	var count int
	err := s.reader.QueryRowContext(ctx, `SELECT COUNT(*) FROM tgdl_work WHERE paused<>0 AND status IN ('pending','processing')`).Scan(&count)
	return count, err
}

func (s *WorkStore) PauseJob(ctx context.Context, key string) (bool, error) {
	result, err := s.writer.ExecContext(ctx, `UPDATE tgdl_work SET paused=1,updated_at=? WHERE group_id||'_'||message_id=? AND status IN ('pending','processing')`, time.Now().UnixMilli(), key)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	return n > 0, err
}

func (s *WorkStore) ResumeJob(ctx context.Context, key string) (bool, error) {
	result, err := s.writer.ExecContext(ctx, `UPDATE tgdl_work SET paused=0,updated_at=? WHERE group_id||'_'||message_id=? AND paused<>0 AND status IN ('pending','processing')`, time.Now().UnixMilli(), key)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	return n > 0, err
}

func (s *WorkStore) CancelAllQueued(ctx context.Context) (int, error) {
	result, err := s.writer.ExecContext(ctx, `UPDATE tgdl_work SET status='skipped',paused=0,claim_generation=NULL,body=X'',error='cancelled by queue action',updated_at=? WHERE status='pending'`, time.Now().UnixMilli())
	if err != nil {
		return 0, err
	}
	n, err := result.RowsAffected()
	return int(n), err
}

func (s *WorkStore) CancelJob(ctx context.Context, key string) (bool, error) {
	result, err := s.writer.ExecContext(ctx, `UPDATE tgdl_work SET status='skipped',paused=0,claim_generation=NULL,body=X'',error='cancelled by queue action',updated_at=? WHERE group_id||'_'||message_id=? AND status IN ('pending','processing')`, time.Now().UnixMilli(), key)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	return n > 0, err
}

func (s *WorkStore) RetryJob(ctx context.Context, key string) (bool, error) {
	result, err := s.writer.ExecContext(ctx, `UPDATE tgdl_work SET status='pending',paused=0,claim_generation=NULL,attempts=0,retry_at=0,error=NULL,updated_at=? WHERE group_id||'_'||message_id=? AND status='failed' AND length(body)>0`, time.Now().UnixMilli(), key)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	return n > 0, err
}

func (s *WorkStore) RetryAll(ctx context.Context) (int, error) {
	result, err := s.writer.ExecContext(ctx, `UPDATE tgdl_work SET status='pending',paused=0,claim_generation=NULL,attempts=0,retry_at=0,error=NULL,updated_at=? WHERE status='failed' AND length(body)>0`, time.Now().UnixMilli())
	if err != nil {
		return 0, err
	}
	n, err := result.RowsAffected()
	return int(n), err
}

func (s *WorkStore) DismissJob(ctx context.Context, key string) (bool, error) {
	result, err := s.writer.ExecContext(ctx, `DELETE FROM tgdl_work WHERE group_id||'_'||message_id=? AND status IN ('completed','failed','skipped')`, key)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	return n > 0, err
}

func (s *WorkStore) ClearFinished(ctx context.Context) error {
	if _, err := s.writer.ExecContext(ctx, `DELETE FROM tgdl_work WHERE status IN ('completed','failed','skipped')`); err != nil {
		return err
	}
	_, err := s.writer.ExecContext(ctx, `DELETE FROM kv WHERE key='queue_history'`)
	return err
}
