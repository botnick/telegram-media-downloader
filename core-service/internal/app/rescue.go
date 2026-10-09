package app

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

type rescueRow struct {
	id    int64
	group string
	path  sql.NullString
}

const rescueBatchSize = 500

// Delete catalog rows and queue their assets in the same transaction. The
// existing durable cleanup rechecks retained file owners under the writer lock.
// A rescue/delete event that commits first wins; pinned rows are never swept.
func (a *App) sweepRescue(ctx context.Context, now time.Time) (int, error) {
	a.rescueMu.Lock()
	defer a.rescueMu.Unlock()
	a.mediaMu.RLock()
	defer a.mediaMu.RUnlock()
	if err := a.mediaWritable(ctx); err != nil {
		return 0, err
	}
	tx, err := a.db.Writer.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `UPDATE tgdl_file_cleanup SET path=path WHERE 0`); err != nil {
		return 0, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT id,COALESCE(group_id,''),file_path FROM downloads WHERE pending_until<? AND rescued_at IS NULL AND COALESCE(pinned,0)=0 ORDER BY pending_until,id LIMIT ?`, now.UnixMilli(), rescueBatchSize)
	if err != nil {
		return 0, err
	}
	var selected []rescueRow
	for rows.Next() {
		var row rescueRow
		if err = rows.Scan(&row.id, &row.group, &row.path); err != nil {
			break
		}
		selected = append(selected, row)
	}
	err = errors.Join(err, rows.Err(), rows.Close())
	if err != nil {
		return 0, err
	}
	for _, row := range selected {
		if err = a.library.InvalidateDerived(ctx, tx, row.id); err != nil {
			return 0, err
		}
		if row.path.Valid && row.path.String != "" {
			if _, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO tgdl_file_cleanup(path) VALUES(?)`, row.path.String); err != nil {
				return 0, err
			}
		}
		if _, err = tx.ExecContext(ctx, `DELETE FROM downloads WHERE id=?`, row.id); err != nil {
			return 0, err
		}
	}
	if len(selected) > 0 {
		if _, err = tx.ExecContext(ctx, `INSERT INTO kv(key,value,updated_at) VALUES('native_rescue_last',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, len(selected), now.UnixMilli()); err != nil {
			return 0, err
		}
	}
	if err = tx.Commit(); err != nil {
		return 0, err
	}
	cleanupErr := errors.Join(a.drainFileCleanup(ctx), a.library.CleanDerived(ctx))
	events := make([]ws.Event, 0, len(selected)+1)
	for _, row := range selected {
		var path any
		if row.path.Valid && row.path.String != "" {
			path = row.path.String
		}
		events = append(events, ws.Event{Type: "file_deleted", Flat: true, Payload: map[string]any{"id": row.id, "groupId": row.group, "path": path, "source": "rescue"}})
	}
	if len(selected) > 0 {
		events = append(events, ws.Event{Type: "rescue_sweep_done", Flat: true, Payload: map[string]any{"count": len(selected)}})
		a.hub.BroadcastBatch(events)
		a.broadcastStatsUpdate(ctx)
	}
	return len(selected), cleanupErr
}
