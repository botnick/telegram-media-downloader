package app

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

func (a *App) handleChatLeave(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	n, err := strconv.ParseInt(id, 10, 64)
	if err != nil || n == 0 || strconv.FormatInt(n, 10) != id {
		writeJSONError(w, 400, "A valid Telegram chat ID is required")
		return
	}
	var body struct {
		AccountID string `json:"accountId"`
		Confirm   string `json:"confirm"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		return
	}
	if strings.TrimSpace(body.AccountID) == "" || body.Confirm != id {
		writeJSONError(w, 400, "Choose an account and confirm this chat before removing it")
		return
	}
	done, ok := a.beginMaintenance()
	if !ok {
		writeJSONError(w, 503, "Server is stopping")
		return
	}
	defer done()
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	a.monitorOp.Lock()
	err = a.startTelegramEngine(ctx, false)
	var session *engine.DialogSession
	if err == nil {
		session, err = a.monitor.OpenDialogs(ctx)
	}
	a.monitorOp.Unlock()
	if err != nil {
		writeJSONError(w, 503, "Could not connect to the Telegram account")
		return
	}
	defer session.Close()
	if !session.HasAccount(body.AccountID) {
		writeJSONError(w, 409, "Selected Telegram account is not connected")
		return
	}
	if err := session.RemoveDialog(body.AccountID, id); err != nil {
		writeJSONError(w, 502, err.Error())
		return
	}
	// Invalidate listings that started before this confirmed remote change.
	// Retain shared configuration when any other account may still use it.
	a.monitorOp.Lock()
	a.dialogVersion++
	removed := false
	var cleanupErr error
	if session.AccountCount() == 1 && session.Err() == nil {
		removed, cleanupErr = a.removeLeftChatConfig(ctx, id)
	}
	a.monitorOp.Unlock()
	response := map[string]any{"success": true, "id": id, "accountId": body.AccountID, "localConfigRemoved": removed}
	if cleanupErr != nil {
		response["warning"] = "Removed from Telegram, but the local list could not be updated. Refresh or remove the local list entry."
	}
	a.hub.Broadcast(ws.Event{Type: "config_updated"})
	a.hub.Broadcast(ws.Event{Type: "chat_access_changed", Flat: true, Payload: map[string]any{"ids": []string{id}}})
	writeJSON(w, 200, response)
}

// Drop only the sole account's local subscription. Library files and download
// rows stay intact; multi-account subscriptions are deliberately retained.
func (a *App) removeLeftChatConfig(ctx context.Context, id string) (bool, error) {
	a.configMu.Lock()
	defer a.configMu.Unlock()
	cfg, err := a.config.Load(ctx)
	if err != nil {
		return false, err
	}
	groups, _ := cfg["groups"].([]any)
	kept := make([]any, 0, len(groups))
	for _, raw := range groups {
		group, ok := raw.(map[string]any)
		if !ok || toString(group["id"]) != id {
			kept = append(kept, raw)
		}
	}
	cfg["groups"] = kept
	raw, err := json.Marshal(cfg)
	if err != nil {
		return false, err
	}
	tx, err := a.db.Writer.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `UPDATE kv SET value=?,updated_at=? WHERE key='config'`, string(raw), time.Now().UnixMilli()); err != nil {
		return false, err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM chat_access WHERE chat_id=?`, id); err != nil {
		return false, err
	}
	if err = tx.Commit(); err != nil {
		return false, err
	}
	return len(kept) != len(groups), nil
}
