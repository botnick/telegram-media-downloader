package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
	"github.com/gotd/td/tg"
)

func (a *App) startHistoryWorker(id string) {
	a.historyMu.Lock()
	if a.historyCancel[id] != nil {
		a.historyMu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(a.ctx)
	a.historyCancel[id] = cancel
	a.historyMu.Unlock()
	if !a.launchMaintenance(func() {
		defer cancel()
		err := a.runHistory(ctx, id)
		a.finishHistory(id, err)
		a.historyMu.Lock()
		delete(a.historyCancel, id)
		a.historyMu.Unlock()
		a.startHistoryDrain(false)
	}) {
		cancel()
		a.historyMu.Lock()
		delete(a.historyCancel, id)
		a.historyMu.Unlock()
	}
}

func (a *App) historyCopy(id string) (historyJob, error) {
	a.historyMu.Lock()
	defer a.historyMu.Unlock()
	j := a.historyJobs[id]
	if j == nil {
		return historyJob{}, errors.New("history job no longer exists")
	}
	if j.Cancelled {
		return *j, context.Canceled
	}
	return *j, nil
}

func (a *App) runHistory(ctx context.Context, id string) error {
	a.monitorOp.Lock()
	// A purge can remove an uninitialized job while this worker waits for
	// monitorOp. Revalidate before opening any account clients.
	j, err := a.historyCopy(id)
	if err == nil {
		err = a.startTelegramEngine(ctx, false)
	}
	var session *engine.MessageSession
	if err == nil {
		session, err = a.monitor.OpenHistory(ctx, j.accountID)
	}
	a.monitorOp.Unlock()
	if err != nil {
		return err
	}
	defer session.Close()
	dialog, err := session.Resolve(j.query)
	if err != nil {
		return err
	}
	if err = a.initializeHistory(ctx, id, session.AccountID, dialog); err != nil {
		return err
	}
	cfg, err := a.config.Load(ctx)
	if err != nil {
		return err
	}
	history := objectAt(cfg, "advanced", "history")
	cap := max(1, min(10000, int(number(history["backpressureCap"], 500))))
	stall := time.Duration(max(1, min(86400000, number(history["backpressureMaxWaitMs"], 15*60*1000)))) * time.Millisecond
	shortEvery := max(0, int(number(history["shortBreakEveryN"], 100)))
	longEvery := max(0, int(number(history["longBreakEveryN"], 1000)))
	lastProgress := time.Now()
	lastPending := -1
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		j, err = a.historyCopy(id)
		if err != nil {
			return err
		}
		if j.Limit != nil && j.Processed >= *j.Limit {
			return nil
		}
		pending, err := a.monitor.PendingManual(ctx)
		if err != nil {
			return err
		}
		if pending < lastPending || pending < cap {
			lastProgress = time.Now()
		}
		lastPending = pending
		if pending >= cap {
			if time.Since(lastProgress) > stall {
				return errors.New("history queue made no progress before the stall deadline")
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(250 * time.Millisecond):
				continue
			}
		}
		limit := min(100, cap-pending)
		if j.Limit != nil {
			limit = min(limit, *j.Limit-j.Processed)
		}
		page, err := session.Page(dialog, telegram.HistoryRequest{OffsetID: j.cursor, MinID: j.minID, Limit: limit})
		if err != nil {
			return err
		}
		for _, raw := range page.Messages {
			var target engine.Target
			allowed := false
			message, _ := raw.(*tg.Message)
			if message != nil {
				target, allowed, err = session.Filter(ctx, message, page.Entities)
				if err != nil {
					return err
				}
			}
			if err = a.checkpointHistory(ctx, id, session, raw.GetID(), message, target, allowed); err != nil {
				return err
			}
			current, e := a.historyCopy(id)
			if e != nil {
				return e
			}
			if current.Limit == nil || current.Processed < *current.Limit {
				pause := time.Duration(0)
				if longEvery > 0 && current.Processed%longEvery == 0 {
					pause = 60 * time.Second
				} else if shortEvery > 0 && current.Processed%shortEvery == 0 {
					pause = 2 * time.Second
				}
				if pause > 0 {
					select {
					case <-ctx.Done():
						return ctx.Err()
					case <-time.After(pause):
					}
				}
			}
		}
		if page.Done {
			return nil
		}
		if len(page.Messages) == 0 {
			return errors.New("history page did not advance")
		}
	}
}

func (a *App) initializeHistory(ctx context.Context, id, accountID string, dialog telegram.Dialog) error {
	a.mediaMu.RLock()
	defer a.mediaMu.RUnlock()
	if err := a.mediaWritable(ctx); err != nil {
		return err
	}
	a.configMu.Lock()
	defer a.configMu.Unlock()
	cfg, err := a.config.Load(ctx)
	if err != nil {
		return err
	}
	a.historyMu.Lock()
	defer a.historyMu.Unlock()
	current := a.historyJobs[id]
	if current == nil {
		return errors.New("history job missing")
	}
	if current.Cancelled {
		return context.Canceled
	}
	j := *current
	if j.accountID != "" && j.accountID != accountID {
		return errors.New("history account changed while resuming")
	}
	j.accountID = accountID
	var group map[string]any
	for _, g := range configuredGroupList(cfg) {
		if toString(g["id"]) == j.GroupID {
			group = g
			break
		}
	}
	if group == nil {
		if j.initialized {
			return errors.New("history group was removed")
		}
		for _, g := range configuredGroupList(cfg) {
			if toString(g["id"]) == dialog.ID {
				group = g
				j.GroupID = dialog.ID
				break
			}
		}
	}
	added := false
	if group == nil {
		group = manualGroup(dialog)
		groups, _ := cfg["groups"].([]any)
		cfg["groups"] = append(groups, group)
		j.GroupID = dialog.ID
		added = true
	}
	if pin := toString(group["monitorAccount"]); pin != "" && pin != accountID {
		return errors.New("history group is pinned to another account")
	}
	if group["suspended"] == true {
		return errors.New("history group is suspended")
	}
	j.Group = toString(group["name"])
	j.query = dialog.ID
	if !j.initialized {
		switch j.Mode {
		case "pull-older":
			err = a.db.Reader.QueryRowContext(ctx, `SELECT COALESCE(MIN(message_id),0) FROM downloads WHERE group_id=? AND message_id BETWEEN 1 AND 2147483647 AND file_type IS NOT 'stories'`, j.GroupID).Scan(&j.cursor)
		case "catch-up":
			err = a.db.Reader.QueryRowContext(ctx, `SELECT COALESCE(MAX(message_id),0) FROM downloads WHERE group_id=? AND message_id BETWEEN 1 AND 2147483647 AND file_type IS NOT 'stories'`, j.GroupID).Scan(&j.minID)
		}
		if err != nil {
			return err
		}
		j.initialized = true
	}
	tx, err := a.db.Writer.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if added {
		encoded, e := json.Marshal(cfg)
		if e != nil {
			return e
		}
		_, err = tx.ExecContext(ctx, `UPDATE kv SET value=?,updated_at=? WHERE key='config'`, string(encoded), time.Now().UnixMilli())
		if err != nil {
			return err
		}
	}
	if err = historySaveTx(ctx, tx, j); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	*current = j
	if added {
		a.hub.Broadcast(ws.Event{Type: "config_updated", Flat: true})
	}
	return nil
}

func (a *App) checkpointHistory(ctx context.Context, id string, session *engine.MessageSession, cursor int, message *tg.Message, target engine.Target, allowed bool) error {
	a.mediaMu.RLock()
	defer a.mediaMu.RUnlock()
	if err := a.mediaWritable(ctx); err != nil {
		return err
	}
	a.historyMu.Lock()
	defer a.historyMu.Unlock()
	current := a.historyJobs[id]
	if current == nil {
		return errors.New("history job missing")
	}
	if current.Cancelled {
		return context.Canceled
	}
	if current.Limit != nil && current.Processed >= *current.Limit {
		return nil
	}
	j := *current
	if cursor <= 0 || (j.cursor > 0 && cursor >= j.cursor) {
		return errors.New("history checkpoint did not advance")
	}
	j.cursor = cursor
	j.Processed++
	tx, err := a.db.Writer.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var workID int64
	if allowed {
		if target.ID != j.GroupID {
			return errors.New("history filter selected another group")
		}
		var changed bool
		workID, changed, err = session.QueueTx(ctx, tx, target, message, j.Mode == "rescan")
		if err != nil {
			return err
		}
		if changed {
			j.Downloaded++
		}
	}
	if err = historySaveTx(ctx, tx, j); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	*current = j
	session.Wake(workID)
	a.hub.Broadcast(ws.Event{Type: "history_progress", Flat: true, Payload: map[string]any{"jobId": j.ID, "processed": j.Processed, "downloaded": j.Downloaded, "skipped": j.Processed - j.Downloaded, "urls": 0, "group": j.Group, "groupId": j.GroupID, "limit": j.Limit, "startedAt": j.StartedAt, "mode": j.Mode, "currentId": cursor}})
	return nil
}

func (a *App) finishHistory(id string, cause error) {
	// Shutdown leaves the durable running row and exact committed cursor for
	// the next process. An explicit cancellation is persisted before its ack.
	if a.ctx.Err() != nil {
		return
	}
	a.historyMu.Lock()
	defer a.historyMu.Unlock()
	current := a.historyJobs[id]
	if current == nil {
		return
	}
	j := *current
	now := time.Now().UnixMilli()
	j.FinishedAt = &now
	j.State = "done"
	if j.Cancelled {
		j.State = "cancelled"
	} else if cause != nil {
		j.State = "error"
		s := cause.Error()
		j.Error = &s
	}
	saved, err := a.historySaved(a.ctx)
	cfg, configErr := a.config.Load(a.ctx)
	if err == nil {
		err = configErr
	}
	cutoff := historyCutoff(cfg)
	if err == nil {
		filtered := make([]historyJob, 0, len(saved)+1)
		for _, old := range saved {
			when := old.StartedAt
			if old.FinishedAt != nil {
				when = *old.FinishedAt
			}
			if old.ID != j.ID && when >= cutoff {
				filtered = append(filtered, old)
			}
		}
		filtered = append(filtered, j)
		var data []byte
		data, err = json.Marshal(filtered)
		if err == nil {
			tx, e := a.db.Writer.BeginTx(a.ctx, nil)
			err = e
			if err == nil {
				err = historySaveTx(a.ctx, tx, j)
				if err == nil {
					_, err = tx.ExecContext(a.ctx, `INSERT INTO kv(key,value,updated_at) VALUES('history_jobs',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, string(data), now)
				}
				if err == nil {
					_, err = tx.ExecContext(a.ctx, `DELETE FROM tgdl_history_jobs WHERE state<>'running' AND json_extract(payload,'$.job.finishedAt')<?`, cutoff)
				}
				if err == nil {
					err = tx.Commit()
				}
				tx.Rollback()
			}
		}
	}
	if err != nil {
		if a.output != nil {
			fmt.Fprintf(a.output, "History completion remains pending: %v\n", err)
		}
		return
	}
	*current = j
	event := "history_done"
	if j.State == "cancelled" {
		event = "history_cancelled"
	}
	if j.State == "error" {
		event = "history_error"
	}
	data, _ := json.Marshal(j)
	payload := map[string]any{}
	_ = json.Unmarshal(data, &payload)
	payload["jobId"] = j.ID
	a.hub.Broadcast(ws.Event{Type: event, Flat: true, Payload: payload})
}

func (a *App) startHistoryDrain(restart bool) {
	a.historyMu.Lock()
	if a.historyDrain {
		a.historyMu.Unlock()
		return
	}
	a.historyDrain = true
	a.historyMu.Unlock()
	if !a.launchMaintenance(func() {
		owned := true
		defer func() {
			if owned {
				a.historyMu.Lock()
				a.historyDrain = false
				a.historyMu.Unlock()
			}
		}()
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for {
			if a.ctx.Err() != nil {
				return
			}
			a.monitorOp.Lock()
			// Purge/account changes hold monitorOp while deleting queued work.
			// Read after acquiring it; an older snapshot can reopen accounts
			// after a successful purge has removed the last manual job.
			pending, err := a.monitor.PendingManual(a.ctx)
			if err == nil && pending > 0 && (restart || a.monitor.RequireRunning() != nil) {
				err = a.startTelegramEngine(a.ctx, false)
				restart = false
			}
			if err == nil {
				err = a.monitor.StopIdleJobs(a.ctx)
			}
			a.monitorOp.Unlock()
			if err != nil {
				if a.output != nil {
					fmt.Fprintf(a.output, "History queue drain stopped: %v\n", err)
				}
				return
			}
			a.historyMu.Lock()
			running := len(a.historyCancel)
			// Recheck under the checkpoint mutex: the preceding query can be
			// older than the final enqueue of a just-finished enumerator.
			pending, err = a.monitor.PendingManual(a.ctx)
			if err == nil && pending == 0 && running == 0 {
				a.historyDrain = false
				owned = false
				a.historyMu.Unlock()
				return
			}
			a.historyMu.Unlock()
			if err != nil {
				return
			}
			select {
			case <-a.ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}) {
		a.historyMu.Lock()
		a.historyDrain = false
		a.historyMu.Unlock()
	}
}
