package app

import (
	"context"
	"encoding/json"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
)

// Persist only entities actually observed in a complete successful response.
// Missing/minimal peers and failed requests never prove that a chat was deleted.
func (a *App) saveDialogAccess(ctx context.Context, dialogs []engine.Dialog, observedAt int64) error {
	tx, err := a.db.Writer.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, dialog := range dialogs {
		access := dialog.Access
		if access.State == "" || access.State == "unknown" {
			continue
		}
		accounts, err := json.Marshal(dialog.AccountAccess)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO chat_access(chat_id,state,code,detail,migrated_to,first_seen_at,checked_at,checks,accounts,updated_at)
		VALUES(?,?,?,?,?,?,?,1,?,?) ON CONFLICT(chat_id) DO UPDATE SET
		state=excluded.state, code=excluded.code, detail=excluded.detail, migrated_to=excluded.migrated_to,
		first_seen_at=CASE WHEN chat_access.state=excluded.state THEN chat_access.first_seen_at ELSE excluded.first_seen_at END,
		checked_at=excluded.checked_at, next_check_at=NULL, checks=chat_access.checks+1, accounts=excluded.accounts, updated_at=excluded.updated_at
		WHERE chat_access.updated_at<=excluded.updated_at`, dialog.ID, access.State, access.Code, access.Detail, access.MigratedTo, observedAt, observedAt, string(accounts), observedAt)
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

func liveDialogAccess(dialog engine.Dialog) map[string]any {
	a := dialog.Access
	accounts := make([]map[string]any, 0, len(dialog.AccountIDs))
	for _, id := range dialog.AccountIDs {
		value := dialog.AccountAccess[id]
		accounts = append(accounts, map[string]any{"id": id, "state": value.State, "code": value.Code, "detail": value.Detail})
	}
	return map[string]any{"state": a.State, "code": a.Code, "detail": a.Detail, "migratedTo": a.MigratedTo, "accounts": accounts}
}
