package engine

import (
	"context"
	"database/sql"
	"time"

	"github.com/gotd/td/bin"
	"github.com/gotd/td/tg"
)

// ReassignGroup requires stopped/joined workers and the caller's config
// transaction. Keep channel PTS (shared across accounts), but discard global
// PTS from the old account. Every retained payload must be refreshed before use.
func ReassignGroup(ctx context.Context, tx *sql.Tx, groupID, accountID string) error {
	rows, err := tx.QueryContext(ctx, `SELECT id,body FROM tgdl_work WHERE group_id=? AND length(body)>0 AND status IN ('pending','processing','failed')`, groupID)
	if err != nil {
		return err
	}
	type entry struct {
		id      int64
		channel bool
	}
	entries := []entry{}
	for rows.Next() {
		var e entry
		var body []byte
		if err = rows.Scan(&e.id, &body); err != nil {
			break
		}
		var message tg.Message
		if err = message.Decode(&bin.Buffer{Buf: body}); err != nil {
			break
		}
		_, e.channel = message.PeerID.(*tg.PeerChannel)
		entries = append(entries, e)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return err
	}
	for _, e := range entries {
		if _, err := tx.ExecContext(ctx, `UPDATE tgdl_work SET account_id=?,refresh_required=1,source_pts=CASE WHEN ? THEN source_pts ELSE 0 END,generation=generation+1,claim_generation=NULL,status='pending',attempts=0,retry_at=0,error=NULL,updated_at=? WHERE id=?`, accountID, e.channel, time.Now().UnixMilli(), e.id); err != nil {
			return err
		}
	}
	return nil
}
