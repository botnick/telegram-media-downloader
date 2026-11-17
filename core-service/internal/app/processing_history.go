package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/download"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

type processingAttempt struct {
	ID            int64  `json:"id"`
	GroupID       string `json:"groupId"`
	GroupName     string `json:"groupName"`
	MessageID     int64  `json:"messageId"`
	FileName      string `json:"fileName"`
	FileSize      int64  `json:"fileSize"`
	Origin        string `json:"origin"`
	Outcome       string `json:"outcome"`
	Reason        string `json:"reason"`
	Forward       string `json:"forwardStatus"`
	ForwardReason string `json:"forwardReason"`
	DeleteStatus  string `json:"deleteStatus"`
	DeleteReason  string `json:"deleteReason"`
	LocalDeleted  bool   `json:"localDeleted"`
	CreatedAt     int64  `json:"createdAt"`
}

func (a *App) startProcessingAttempt(ctx context.Context, item download.Item, origin string) (int64, error) {
	var id int64
	err := a.db.Writer.QueryRowContext(ctx, `INSERT INTO tgdl_processing_attempts(group_id,group_name,message_id,file_name,file_size,origin,media_key,created_at)
		VALUES(?,?,?,?,?,?,?,?) RETURNING id`, item.GroupID, item.GroupName, item.MessageID, item.Name, item.Identity.Size, origin, item.Identity.Kind+":"+item.Identity.ID, time.Now().UnixMilli()).Scan(&id)
	if err == nil {
		a.notifyProcessingHistory()
	}
	return id, err
}

func (a *App) finishProcessingAttempt(ctx context.Context, id int64, outcome, reason, hash, forward string, deleteAfter ...bool) error {
	deleteStatus := "not_requested"
	if len(deleteAfter) > 0 && deleteAfter[0] {
		deleteStatus = "pending"
	}
	_, err := a.db.Writer.ExecContext(ctx, `UPDATE tgdl_processing_attempts SET outcome=?,reason=?,media_hash=?,forward_status=?,local_delete_status=?,
		completed_at=CASE WHEN ?='pending' THEN 0 ELSE ? END WHERE id=?`, outcome, reason, hash, forward, deleteStatus, forward, time.Now().UnixMilli(), id)
	if err == nil {
		a.notifyProcessingHistory()
	}
	return err
}

// notifyProcessingHistory tells admin pages the history changed. Every
// download writes history twice, so the event is coalesced to one per second
// instead of competing with download events in each client's queue.
func (a *App) notifyProcessingHistory() {
	if a.hub == nil || !a.historyNotifyPending.CompareAndSwap(false, true) {
		return
	}
	time.AfterFunc(time.Second, func() {
		a.historyNotifyPending.Store(false)
		a.hub.Broadcast(ws.Event{Type: "processing_history_changed", Flat: true, Roles: []string{"admin"}})
	})
}

const (
	// Processing history is a diagnostic log, not the library: keep 30 days
	// and at most 200k attempts so it cannot grow with the archive.
	processingHistoryMaxAge  = 30 * 24 * time.Hour
	processingHistoryMaxRows = 200_000
	processingHistoryBatch   = 5000
)

func (a *App) runProcessingHistoryPruner(ctx context.Context) {
	timer := time.NewTimer(time.Minute)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		if _, err := a.pruneProcessingHistory(ctx, time.Now()); err != nil && ctx.Err() == nil && a.output != nil {
			fmt.Fprintf(a.output, "Processing history cleanup failed: %v\n", err)
		}
		timer.Reset(6 * time.Hour)
	}
}

// pruneProcessingHistory deletes old attempts in small batches so the single
// writer is never held for long. Attempts a forward job still points at stay.
func (a *App) pruneProcessingHistory(ctx context.Context, now time.Time) (int64, error) {
	var cutoff int64
	err := a.db.Reader.QueryRowContext(ctx, `SELECT MAX(
		COALESCE((SELECT id FROM tgdl_processing_attempts WHERE created_at<? ORDER BY id DESC LIMIT 1),0),
		COALESCE((SELECT id FROM tgdl_processing_attempts ORDER BY id DESC LIMIT 1 OFFSET ?),0))`, now.Add(-processingHistoryMaxAge).UnixMilli(), processingHistoryMaxRows).Scan(&cutoff)
	if err != nil || cutoff == 0 {
		return 0, err
	}
	var removed int64
	for ctx.Err() == nil {
		result, err := a.db.Writer.ExecContext(ctx, `DELETE FROM tgdl_processing_attempts WHERE id IN (
			SELECT p.id FROM tgdl_processing_attempts p WHERE p.id<=? AND NOT EXISTS (
				SELECT 1 FROM tgdl_forward_queue q WHERE q.history_id=p.id AND q.status IN ('pending','processing','failed','interrupted','uncertain'))
			ORDER BY p.id LIMIT ?)`, cutoff, processingHistoryBatch)
		if err != nil {
			return removed, err
		}
		n, _ := result.RowsAffected()
		removed += n
		if n < processingHistoryBatch {
			break
		}
	}
	if removed > 0 {
		a.notifyProcessingHistory()
	}
	return removed, ctx.Err()
}

func (a *App) failProcessingAttempt(ctx context.Context, id int64, cause error) error {
	outcome, reason := "failed", cause.Error()
	if errors.Is(cause, context.Canceled) {
		outcome, reason = "interrupted", "processing cancelled (context canceled)"
	}
	return errors.Join(cause, a.finishProcessingAttempt(ctx, id, outcome, reason, "", "not_applicable"))
}

func (a *App) finishProcessingForward(ctx context.Context, id int64, status string) {
	if id == 0 {
		return
	}
	_, _ = a.db.Writer.ExecContext(ctx, `UPDATE tgdl_processing_attempts SET forward_status=?,local_delete_status=CASE WHEN ?<>'forwarded' AND local_delete_status='pending' THEN 'not_performed' ELSE local_delete_status END,completed_at=? WHERE id=?`, status, status, time.Now().UnixMilli(), id)
	a.notifyProcessingHistory()
}

func (a *App) failProcessingForward(ctx context.Context, id int64, cause error) {
	if id != 0 {
		_, _ = a.db.Writer.ExecContext(ctx, `UPDATE tgdl_processing_attempts SET forward_status='failed',forward_reason=?,completed_at=? WHERE id=?`, cause.Error(), time.Now().UnixMilli(), id)
		a.notifyProcessingHistory()
	}
}

func (a *App) markProcessingDeleted(ctx context.Context, id int64) {
	if id != 0 {
		_, _ = a.db.Writer.ExecContext(ctx, `UPDATE tgdl_processing_attempts SET local_deleted=1,local_delete_status='deleted',local_delete_reason='' WHERE id=?`, id)
		a.notifyProcessingHistory()
	}
}

func (a *App) setProcessingDeleteStatus(ctx context.Context, id int64, status, reason string) {
	if id != 0 {
		_, _ = a.db.Writer.ExecContext(ctx, `UPDATE tgdl_processing_attempts SET local_delete_status=?,local_delete_reason=? WHERE id=?`, status, reason, id)
		a.notifyProcessingHistory()
	}
}

func registerProcessingHistoryRoutes(mux *http.ServeMux, a *App) {
	mux.Handle("GET /api/maintenance/processing-history", a.requireAdmin(http.HandlerFunc(a.handleProcessingHistory)))
}

func (a *App) handleProcessingHistory(w http.ResponseWriter, r *http.Request) {
	groupID := strings.TrimSpace(r.URL.Query().Get("groupId"))
	where, args := "", []any{}
	if groupID != "" {
		where, args = " WHERE group_id=?", []any{groupID}
	}
	var stats struct {
		Attempts      int64 `json:"attempts"`
		Downloaded    int64 `json:"downloaded"`
		Reused        int64 `json:"reused"`
		Duplicates    int64 `json:"duplicates"`
		Failed        int64 `json:"failed"`
		Forwarded     int64 `json:"forwarded"`
		ForwardFailed int64 `json:"forwardFailed"`
		Deleted       int64 `json:"deleted"`
		DeleteFailed  int64 `json:"deleteFailed"`
		UniqueFiles   int64 `json:"uniqueFiles"`
	}
	query := `SELECT COUNT(*),COALESCE(SUM(outcome='downloaded'),0),COALESCE(SUM(outcome='reused'),0),COALESCE(SUM(outcome='duplicate_skipped'),0),
		COALESCE(SUM(outcome='failed'),0),COALESCE(SUM(forward_status='forwarded'),0),COALESCE(SUM(forward_status='failed'),0),COALESCE(SUM(local_deleted),0),COALESCE(SUM(local_delete_status='failed'),0),
		COUNT(DISTINCT CASE WHEN outcome IN ('downloaded','reused','duplicate_skipped') THEN
			CASE WHEN media_hash<>'' THEN 'sha256:'||media_hash ELSE 'telegram:'||media_key END END)
		FROM tgdl_processing_attempts` + where
	if err := a.db.Reader.QueryRowContext(r.Context(), query, args...).Scan(&stats.Attempts, &stats.Downloaded, &stats.Reused, &stats.Duplicates, &stats.Failed, &stats.Forwarded, &stats.ForwardFailed, &stats.Deleted, &stats.DeleteFailed, &stats.UniqueFiles); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "Unable to read processing history")
		return
	}
	limit, offset := 100, 0
	if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && n > 0 {
		limit = min(n, 500)
	}
	if n, err := strconv.Atoi(r.URL.Query().Get("offset")); err == nil && n > 0 {
		offset = n
	}
	rows, err := a.db.Reader.QueryContext(r.Context(), `SELECT id,group_id,group_name,message_id,file_name,file_size,origin,outcome,reason,forward_status,forward_reason,local_delete_status,local_delete_reason,local_deleted,created_at
		FROM tgdl_processing_attempts`+where+` ORDER BY id DESC LIMIT ? OFFSET ?`, append(args, limit, offset)...)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "Unable to read processing history")
		return
	}
	defer rows.Close()
	items := make([]processingAttempt, 0, limit)
	for rows.Next() {
		var item processingAttempt
		var deleted int
		if err := rows.Scan(&item.ID, &item.GroupID, &item.GroupName, &item.MessageID, &item.FileName, &item.FileSize, &item.Origin, &item.Outcome, &item.Reason, &item.Forward, &item.ForwardReason, &item.DeleteStatus, &item.DeleteReason, &deleted, &item.CreatedAt); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "Unable to read processing history")
			return
		}
		item.LocalDeleted = deleted != 0
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "Unable to read processing history")
		return
	}
	rows.Close()
	groups, err := a.db.Reader.QueryContext(r.Context(), `SELECT group_id,MAX(group_name) FROM tgdl_processing_attempts GROUP BY group_id ORDER BY MAX(group_name),group_id`)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "Unable to read processing history")
		return
	}
	type groupOption struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	groupList := []groupOption{}
	for groups.Next() {
		var group groupOption
		if err := groups.Scan(&group.ID, &group.Name); err != nil {
			groups.Close()
			writeJSONError(w, http.StatusInternalServerError, "Unable to read processing history")
			return
		}
		groupList = append(groupList, group)
	}
	if err := groups.Err(); err != nil {
		groups.Close()
		writeJSONError(w, http.StatusInternalServerError, "Unable to read processing history")
		return
	}
	groups.Close()
	var total int64
	if err := a.db.Reader.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM tgdl_processing_attempts`+where, args...).Scan(&total); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "Unable to read processing history")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"stats": stats, "items": items, "groups": groupList, "total": total, "limit": limit, "offset": offset})
}
