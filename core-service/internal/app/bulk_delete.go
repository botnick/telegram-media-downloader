package app

import (
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

func jobCount(value any) int {
	if n, ok := value.(int); ok {
		return n
	}
	return int(number(value, 0))
}

// The gallery and duplicate finder share a single deletion job. Claim the
// slot before returning to HTTP so concurrent clicks cannot overlap jobs.
func (a *App) startBulkDelete(ids []int64, paths []string) bool {
	a.dedupMu.Lock()
	if a.dedupClosed || a.ctx.Err() != nil || a.dedupDeleteStatus["running"] == true {
		a.dedupMu.Unlock()
		return false
	}
	started := time.Now()
	status := a.dedupDeleteStatus
	status["attempts"] = jobCount(status["attempts"]) + 1
	status["running"], status["stage"] = true, "starting"
	status["startedAt"], status["finishedAt"], status["durationMs"] = started.UnixMilli(), 0, 0
	status["progress"], status["error"] = map[string]any{}, nil
	a.dedupWG.Add(1)
	payload := cloneConfigValue(status)
	a.dedupMu.Unlock()
	a.hub.Broadcast(ws.Event{Type: "dedup_delete_progress", Flat: true, Payload: payload})
	go func() {
		defer a.dedupWG.Done()
		result, err := a.runBulkDelete(ids, paths)
		finished := time.Now()
		a.dedupMu.Lock()
		status["running"], status["stage"] = false, "done"
		status["finishedAt"], status["durationMs"] = finished.UnixMilli(), finished.Sub(started).Milliseconds()
		done := map[string]any{"kind": "dedupDelete", "durationMs": status["durationMs"]}
		if err != nil {
			status["stage"], status["error"] = "error", err.Error()
			status["failures"] = jobCount(status["failures"]) + 1
			done["error"] = err.Error()
		} else {
			status["result"] = result
			status["successes"] = jobCount(status["successes"]) + 1
			for key, value := range result {
				done[key] = value
			}
		}
		a.dedupMu.Unlock()
		a.hub.Broadcast(ws.Event{Type: "dedup_delete_done", Flat: true, Payload: done})
	}()
	return true
}

func (a *App) bulkDeleteProgress(progress map[string]any) {
	a.dedupMu.Lock()
	status := a.dedupDeleteStatus
	status["stage"], status["progress"] = progress["stage"], progress
	payload := cloneConfigValue(status).(map[string]any)
	for key, value := range progress {
		payload[key] = value
	}
	a.dedupMu.Unlock()
	a.hub.Broadcast(ws.Event{Type: "dedup_delete_progress", Flat: true, Payload: payload})
}
