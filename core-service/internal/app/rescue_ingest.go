package app

import (
	"context"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
	"github.com/gotd/td/tg"
)

func (a *App) observeRescueUpdate(ctx context.Context, account string, update tg.UpdateClass) error {
	switch u := update.(type) {
	case *tg.UpdateDeleteChannelMessages:
		if u.ChannelID <= 0 || u.ChannelID > math.MaxInt64-1000000000000 {
			return errors.New("invalid source-delete channel")
		}
		return a.markRescued(ctx, account, u.ChannelID, u.Messages)
	case *tg.UpdateDeleteMessages:
		return a.markRescued(ctx, account, 0, u.Messages)
	}
	return nil
}

// Channel IDs are globally scoped. Ordinary message IDs are account-scoped;
// never rescue unrelated channels or another account's identically numbered DM.
func (a *App) markRescued(ctx context.Context, account string, channel int64, ids []int) error {
	if account == "" {
		return errors.New("source-delete account is required")
	}
	for start := 0; start < len(ids); start += 500 {
		part := ids[start:min(start+500, len(ids))]
		var marks []string
		var args []any
		for _, id := range part {
			if id > 0 {
				marks = append(marks, "?")
				args = append(args, id)
			}
		}
		if len(marks) == 0 {
			continue
		}
		where := `message_id IN (` + strings.Join(marks, ",") + `) AND channel_id=?`
		args = append(args, channel)
		if channel == 0 {
			where += ` AND account_id=?`
			args = append(args, account)
		}
		tx, err := a.db.Writer.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		now := time.Now().UnixMilli()
		_, err = tx.ExecContext(ctx, `UPDATE tgdl_rescue_messages SET rescued_at=COALESCE(rescued_at,?) WHERE `+where, append([]any{now}, args...)...)
		if err != nil {
			tx.Rollback()
			return err
		}
		predicate := `EXISTS(SELECT 1 FROM tgdl_rescue_messages r WHERE r.group_id=downloads.group_id AND r.message_id=downloads.message_id AND r.rescued_at IS NOT NULL AND ` + strings.ReplaceAll(where, "message_id", "r.message_id") + `)`
		// Legacy catalog rows have no source-account receipts. Channel deletes
		// still resolve safely using exact raw/marked IDs; ambiguous DMs do not.
		if channel > 0 {
			predicate = `(` + predicate + ` OR (group_id IN (?,?) AND message_id IN (` + strings.Join(marks, ",") + `)))`
			args = append(args, strconv.FormatInt(channel, 10), strconv.FormatInt(-1000000000000-channel, 10))
			for _, id := range part {
				if id > 0 {
					args = append(args, id)
				}
			}
		}
		rows, err := tx.QueryContext(ctx, `UPDATE downloads SET rescued_at=?,pending_until=NULL WHERE pending_until IS NOT NULL AND rescued_at IS NULL AND `+predicate+` RETURNING group_id,message_id`, append([]any{now}, args...)...)
		if err != nil {
			tx.Rollback()
			return err
		}
		type rescued struct {
			group string
			id    int64
		}
		var events []rescued
		for rows.Next() {
			var row rescued
			if err = rows.Scan(&row.group, &row.id); err != nil {
				break
			}
			events = append(events, row)
		}
		err = errors.Join(err, rows.Err(), rows.Close())
		if err != nil {
			tx.Rollback()
			return err
		}
		if err = tx.Commit(); err != nil {
			return err
		}
		for _, event := range events {
			a.hub.Broadcast(ws.Event{Type: "rescued", Payload: map[string]any{"groupId": event.group, "messageId": event.id}})
		}
	}
	return nil
}
