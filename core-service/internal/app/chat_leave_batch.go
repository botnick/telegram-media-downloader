package app

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
	"github.com/gotd/td/tgerr"
)

const maxLeaveBatch = 500

// Leave many chats with one confirmed account. Removals run one at a time in
// the background; files are deleted only for chats Telegram confirmed removed.
func (a *App) handleChatLeaveBatch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		AccountID   string   `json:"accountId"`
		IDs         []string `json:"ids"`
		DeleteFiles bool     `json:"deleteFiles"`
		Confirm     string   `json:"confirm"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		return
	}
	ids := make([]string, 0, len(body.IDs))
	seen := map[string]bool{}
	for _, id := range body.IDs {
		n, err := strconv.ParseInt(id, 10, 64)
		if err != nil || n == 0 || strconv.FormatInt(n, 10) != id {
			writeJSONError(w, 400, "Every chat needs a valid Telegram chat ID")
			return
		}
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 || len(ids) > maxLeaveBatch {
		writeJSONError(w, 400, "Choose between 1 and 500 chats")
		return
	}
	if strings.TrimSpace(body.AccountID) == "" || body.Confirm != strconv.Itoa(len(ids)) {
		writeJSONError(w, 400, "Choose an account and confirm the number of chats before removing them")
		return
	}
	a.leaveBatchMu.Lock()
	if a.leaveBatchStatus["running"] == true {
		a.leaveBatchMu.Unlock()
		writeJSON(w, 409, map[string]any{"error": "Another leave job is still running", "code": "ALREADY_RUNNING"})
		return
	}
	previous := a.leaveBatchStatus
	done, ok := a.beginMaintenance()
	if !ok {
		a.leaveBatchMu.Unlock()
		writeJSONError(w, 503, "Server is stopping")
		return
	}
	status := dedupIdleStatus("chatLeaveBatch")
	status["attempts"] = jobCount(previous["attempts"]) + 1
	status["successes"], status["failures"] = previous["successes"], previous["failures"]
	status["running"], status["stage"], status["startedAt"] = true, "connecting", time.Now().UnixMilli()
	status["accountId"], status["deleteFiles"], status["total"] = body.AccountID, body.DeleteFiles, len(ids)
	status["processed"], status["removed"], status["failed"], status["filesDeleted"] = 0, 0, 0, 0
	status["results"] = []any{}
	a.leaveBatchStatus = status
	payload := cloneConfigValue(status)
	a.leaveBatchMu.Unlock()
	a.hub.Broadcast(ws.Event{Type: "chat_leave_batch_progress", Flat: true, Payload: payload})
	go func() {
		defer done()
		a.runChatLeaveBatch(a.ctx, body.AccountID, ids, body.DeleteFiles)
	}()
	writeJSON(w, 200, map[string]any{"success": true, "started": true, "total": len(ids)})
}

func (a *App) handleChatLeaveBatchStatus(w http.ResponseWriter, r *http.Request) {
	a.leaveBatchMu.Lock()
	status := cloneConfigValue(a.leaveBatchStatus)
	a.leaveBatchMu.Unlock()
	writeJSON(w, 200, status)
}

func (a *App) updateLeaveBatch(mutate func(status map[string]any)) {
	a.leaveBatchMu.Lock()
	mutate(a.leaveBatchStatus)
	payload := cloneConfigValue(a.leaveBatchStatus)
	a.leaveBatchMu.Unlock()
	a.hub.Broadcast(ws.Event{Type: "chat_leave_batch_progress", Flat: true, Payload: payload})
}

func floodWaitSeconds(err error) (int, bool) {
	if d, ok := tgerr.AsFloodWait(err); ok {
		return int(d.Seconds()), true
	}
	return 0, err != nil && strings.Contains(err.Error(), "FLOOD_WAIT")
}

func (a *App) runChatLeaveBatch(ctx context.Context, accountID string, ids []string, deleteFiles bool) {
	started := time.Now()
	removed, runErr := a.leaveBatchRemote(ctx, accountID, ids)
	if len(removed) > 0 {
		a.leaveBatchLocal(ctx, removed, deleteFiles)
		a.hub.Broadcast(ws.Event{Type: "config_updated"})
		a.hub.Broadcast(ws.Event{Type: "chat_access_changed", Flat: true, Payload: map[string]any{"ids": removed}})
	}
	var done map[string]any
	a.updateLeaveBatch(func(status map[string]any) {
		status["running"] = false
		status["finishedAt"], status["durationMs"] = time.Now().UnixMilli(), time.Since(started).Milliseconds()
		if runErr != nil {
			status["stage"], status["error"] = "error", runErr.Error()
			status["failures"] = jobCount(status["failures"]) + 1
		} else {
			status["stage"] = "done"
			if status["stopped"] == true {
				status["stage"] = "stopped"
			}
			status["successes"] = jobCount(status["successes"]) + 1
		}
		done = cloneConfigValue(status).(map[string]any)
	})
	a.hub.Broadcast(ws.Event{Type: "chat_leave_batch_done", Flat: true, Payload: done})
}

// leaveBatchRemote returns the IDs Telegram confirmed removed. The dialog
// session is closed before any local purge stops the account run.
func (a *App) leaveBatchRemote(ctx context.Context, accountID string, ids []string) ([]string, error) {
	a.monitorOp.Lock()
	err := a.startTelegramEngine(ctx, false)
	var session *engine.DialogSession
	if err == nil {
		session, err = a.monitor.OpenDialogs(ctx)
	}
	a.monitorOp.Unlock()
	if err != nil {
		return nil, errors.New("Could not connect to the Telegram account")
	}
	defer session.Close()
	if !session.HasAccount(accountID) {
		return nil, errors.New("Selected Telegram account is not connected")
	}
	a.updateLeaveBatch(func(status map[string]any) { status["stage"] = "leaving" })
	var removed []string
	err = session.RemoveDialogs(accountID, ids, func(id string, err error) bool {
		// Already gone from the account on Telegram: nothing to leave, so it
		// only needs the local cleanup.
		gone := errors.Is(err, telegram.ErrDialogNotInAccount)
		if gone {
			err = nil
		}
		wait, flood := floodWaitSeconds(err)
		a.updateLeaveBatch(func(status map[string]any) {
			result := map[string]any{"id": id, "ok": err == nil}
			status["processed"] = jobCount(status["processed"]) + 1
			if gone {
				result["alreadyGone"] = true
				status["alreadyGone"] = jobCount(status["alreadyGone"]) + 1
			}
			if err == nil {
				status["removed"] = jobCount(status["removed"]) + 1
			} else {
				result["error"] = err.Error()
				status["failed"] = jobCount(status["failed"]) + 1
			}
			status["results"] = append(status["results"].([]any), result)
			if flood {
				status["stopped"], status["waitSeconds"] = true, wait
			}
		})
		if err == nil {
			removed = append(removed, id)
		}
		return !flood && ctx.Err() == nil
	})
	if session.AccountCount() != 1 || session.Err() != nil {
		// Keep shared local configuration unless this is the only account.
		a.updateLeaveBatch(func(status map[string]any) { status["sharedConfig"] = true })
	}
	a.monitorOp.Lock()
	a.dialogVersion++
	a.monitorOp.Unlock()
	if err != nil && len(removed) == 0 {
		return nil, err
	}
	if err != nil {
		a.updateLeaveBatch(func(status map[string]any) { status["error"] = err.Error() })
	}
	return removed, nil
}

func (a *App) leaveBatchLocal(ctx context.Context, removed []string, deleteFiles bool) {
	a.leaveBatchMu.Lock()
	shared := a.leaveBatchStatus["sharedConfig"] == true
	a.leaveBatchMu.Unlock()
	if deleteFiles {
		a.updateLeaveBatch(func(status map[string]any) { status["stage"], status["filesProcessed"] = "deleting_files", 0 })
	}
	for _, id := range removed {
		if ctx.Err() != nil {
			return
		}
		var files int
		var err error
		if deleteFiles {
			files, err = a.purgeChatNow(ctx, id)
		} else if !shared {
			a.monitorOp.Lock()
			_, err = a.removeLeftChatConfig(ctx, id)
			a.monitorOp.Unlock()
		}
		a.updateLeaveBatch(func(status map[string]any) {
			if deleteFiles {
				status["filesProcessed"] = jobCount(status["filesProcessed"]) + 1
				status["filesDeleted"] = jobCount(status["filesDeleted"]) + files
			}
			if err == nil {
				return
			}
			for _, raw := range status["results"].([]any) {
				if result := raw.(map[string]any); result["id"] == id {
					result["localError"] = err.Error()
				}
			}
			status["localFailed"] = jobCount(status["localFailed"]) + 1
		})
	}
}

// purgeChatNow removes one chat's downloads, files and local settings, waiting
// for the shared purge worker to finish. Returns the number of files deleted.
func (a *App) purgeChatNow(ctx context.Context, id string) (int, error) {
	p, err := a.claimPurge(ctx, id, false, false)
	if err != nil {
		return 0, err
	}
	err = a.runPurge(ctx, p, false)
	a.purgeWG.Done()
	if err != nil {
		return 0, err
	}
	a.purgeMu.Lock()
	defer a.purgeMu.Unlock()
	result, _ := a.purges[p.Key].Status["result"].(map[string]any)
	deleted, _ := result["deleted"].(map[string]any)
	return jobCount(deleted["files"]), nil
}
