package app

import (
	"errors"
	"net/http"
	"strings"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

func registerQueueRoutes(mux *http.ServeMux, a *App) {
	mux.Handle("POST /api/queue/pause-all", a.requireAdmin(http.HandlerFunc(a.handleQueuePauseAll)))
	mux.Handle("POST /api/queue/resume-all", a.requireAdmin(http.HandlerFunc(a.handleQueueResumeAll)))
	mux.Handle("POST /api/queue/cancel-all", a.requireAdmin(http.HandlerFunc(a.handleQueueCancelAll)))
	mux.Handle("POST /api/queue/clear-finished", a.requireAdmin(http.HandlerFunc(a.handleQueueClearFinished)))
	mux.Handle("POST /api/queue/{key}/pause", a.requireAdmin(http.HandlerFunc(a.handleQueuePause)))
	mux.Handle("POST /api/queue/{key}/resume", a.requireAdmin(http.HandlerFunc(a.handleQueueResume)))
	mux.Handle("POST /api/queue/{key}/cancel", a.requireAdmin(http.HandlerFunc(a.handleQueueCancel)))
	mux.Handle("POST /api/queue/{key}/retry", a.requireAdmin(http.HandlerFunc(a.handleQueueRetry)))
	mux.Handle("POST /api/queue/batch", a.requireAdmin(http.HandlerFunc(a.handleQueueBatch)))
	mux.Handle("POST /api/queue/retry-all", a.requireAdmin(http.HandlerFunc(a.handleQueueRetryAll)))
}

func writeQueueError(w http.ResponseWriter, err error) {
	if errors.Is(err, engine.ErrEngineNotRunning) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": err.Error()})
		return
	}
	writeJSONError(w, http.StatusInternalServerError, err.Error())
}

func queueChanged(a *App, payload map[string]any) {
	a.hub.Broadcast(ws.Event{Type: "queue_changed", Payload: payload})
}

func (a *App) handleQueuePauseAll(w http.ResponseWriter, r *http.Request) {
	if err := a.monitor.PauseAll(r.Context()); err != nil {
		writeQueueError(w, err)
		return
	}
	queueChanged(a, map[string]any{"op": "pause-all"})
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (a *App) handleQueueResumeAll(w http.ResponseWriter, r *http.Request) {
	if err := a.monitor.ResumeAll(r.Context()); err != nil {
		writeQueueError(w, err)
		return
	}
	queueChanged(a, map[string]any{"op": "resume-all"})
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (a *App) handleQueueCancelAll(w http.ResponseWriter, r *http.Request) {
	removed, err := a.monitor.CancelAllQueued(r.Context())
	if err != nil {
		writeQueueError(w, err)
		return
	}
	queueChanged(a, map[string]any{"op": "cancel-all", "removed": removed})
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "removed": removed})
}

func (a *App) handleQueueClearFinished(w http.ResponseWriter, r *http.Request) {
	if err := a.monitor.ClearFinished(r.Context()); err != nil {
		writeQueueError(w, err)
		return
	}
	queueChanged(a, map[string]any{"op": "clear-finished"})
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func queueKey(r *http.Request) string { return strings.TrimSpace(r.PathValue("key")) }

func (a *App) handleQueuePause(w http.ResponseWriter, r *http.Request) {
	ok, err := a.monitor.PauseJob(r.Context(), queueKey(r))
	if err != nil {
		writeQueueError(w, err)
		return
	}
	queueChanged(a, map[string]any{"op": "pause", "key": queueKey(r)})
	writeJSON(w, http.StatusOK, map[string]any{"success": ok})
}

func (a *App) handleQueueResume(w http.ResponseWriter, r *http.Request) {
	ok, err := a.monitor.ResumeJob(r.Context(), queueKey(r))
	if err != nil {
		writeQueueError(w, err)
		return
	}
	queueChanged(a, map[string]any{"op": "resume", "key": queueKey(r)})
	writeJSON(w, http.StatusOK, map[string]any{"success": ok})
}

func (a *App) handleQueueCancel(w http.ResponseWriter, r *http.Request) {
	ok, err := a.monitor.CancelJob(r.Context(), queueKey(r))
	if err != nil {
		writeQueueError(w, err)
		return
	}
	queueChanged(a, map[string]any{"op": "cancel", "key": queueKey(r)})
	writeJSON(w, http.StatusOK, map[string]any{"success": ok})
}

func (a *App) handleQueueRetry(w http.ResponseWriter, r *http.Request) {
	ok, err := a.monitor.RetryJob(r.Context(), queueKey(r))
	if err != nil {
		writeQueueError(w, err)
		return
	}
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "Cannot retry: original job no longer in memory. Re-trigger from the source (link / backfill / monitor)."})
		return
	}
	queueChanged(a, map[string]any{"op": "retry", "key": queueKey(r)})
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (a *App) handleQueueRetryAll(w http.ResponseWriter, r *http.Request) {
	retried, err := a.monitor.RetryAll(r.Context())
	if err != nil {
		writeQueueError(w, err)
		return
	}
	queueChanged(a, map[string]any{"op": "retry-all", "retried": retried})
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "retried": retried, "skipped": 0})
}

func (a *App) handleQueueBatch(w http.ResponseWriter, r *http.Request) {
	if err := a.monitor.RequireRunning(); err != nil {
		writeQueueError(w, err)
		return
	}
	var body struct {
		Keys   []any  `json:"keys"`
		Action string `json:"action"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		return
	}
	if len(body.Keys) == 0 {
		writeJSONError(w, http.StatusBadRequest, "keys must be a non-empty array")
		return
	}
	if len(body.Keys) > 1000 {
		writeJSONError(w, http.StatusBadRequest, "too many queue keys")
		return
	}
	switch body.Action {
	case "pause", "resume", "cancel", "retry", "dismiss":
	default:
		writeJSONError(w, http.StatusBadRequest, "action must be one of: pause, resume, cancel, retry, dismiss")
		return
	}
	okCount := 0
	failed := make([]map[string]any, 0)
	for _, raw := range body.Keys {
		key := strings.TrimSpace(toString(raw))
		if key == "" {
			failed = append(failed, map[string]any{"key": raw, "reason": "empty key"})
			continue
		}
		var ok bool
		var err error
		switch body.Action {
		case "pause":
			ok, err = a.monitor.PauseJob(r.Context(), key)
		case "resume":
			ok, err = a.monitor.ResumeJob(r.Context(), key)
		case "cancel":
			ok, err = a.monitor.CancelJob(r.Context(), key)
		case "retry":
			ok, err = a.monitor.RetryJob(r.Context(), key)
		case "dismiss":
			ok, err = a.monitor.DismissJob(r.Context(), key)
		}
		if err != nil {
			writeQueueError(w, err)
			return
		}
		if ok {
			okCount++
		} else {
			failed = append(failed, map[string]any{"key": key, "reason": "not applicable"})
		}
	}
	queueChanged(a, map[string]any{"op": "batch", "action": body.Action, "ok": okCount, "failed": len(failed)})
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "ok": okCount, "failed": failed})
}
