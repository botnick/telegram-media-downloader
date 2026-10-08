package app

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

// groupRefreshState mirrors the small public job snapshot used by the web
// dashboard. It is intentionally kept in memory: the operation is a cache
// refresh and can safely be re-run after a process restart.
type groupRefreshState struct {
	running    bool
	attempts   int
	successes  int
	failures   int
	startedAt  int64
	finishedAt int64
	durationMs int64
	stage      string
	progress   map[string]any
	result     any
	err        any
}

func registerGroupRefreshRoutes(mux *http.ServeMux, a *App) {
	mux.Handle("POST /api/groups/refresh-info", a.requireAdmin(http.HandlerFunc(a.handleGroupRefreshInfo)))
	mux.Handle("GET /api/groups/refresh-info/status", a.requireSession(http.HandlerFunc(a.handleGroupRefreshInfoStatus)))
	mux.Handle("POST /api/groups/refresh-photos", a.requireAdmin(http.HandlerFunc(a.handleGroupRefreshPhotos)))
	mux.Handle("GET /api/groups/refresh-photos/status", a.requireSession(http.HandlerFunc(a.handleGroupRefreshPhotosStatus)))
}

func (a *App) handleGroupRefreshInfoStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, a.groupRefreshStatus(false))
}

func (a *App) handleGroupRefreshPhotosStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, a.groupRefreshStatus(true))
}

func (a *App) handleGroupRefreshInfo(w http.ResponseWriter, r *http.Request) {
	if !a.startGroupRefresh(false) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "Group refresh already in progress", "code": "ALREADY_RUNNING", "snapshot": a.groupRefreshStatus(false)})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "started": true})
}

func (a *App) handleGroupRefreshPhotos(w http.ResponseWriter, r *http.Request) {
	if !a.startGroupRefresh(true) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "Photo refresh already in progress", "code": "ALREADY_RUNNING"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "started": true})
}

func (a *App) startGroupRefresh(photos bool) bool {
	a.groupRefreshMu.Lock()
	if a.groupRefreshClosed || a.ctx.Err() != nil {
		a.groupRefreshMu.Unlock()
		return false
	}
	state := a.groupRefreshStateLocked(photos)
	if state.running {
		a.groupRefreshMu.Unlock()
		return false
	}
	now := time.Now()
	*state = groupRefreshState{running: true, attempts: state.attempts + 1, startedAt: now.UnixMilli(), stage: "starting", progress: map[string]any{}}
	a.groupRefreshWG.Add(1)
	a.groupRefreshMu.Unlock()
	a.broadcastGroupRefreshProgress(photos)
	go func() {
		defer a.groupRefreshWG.Done()
		if photos {
			a.runPhotoRefresh(now)
		} else {
			a.runInfoRefresh(now)
		}
	}()
	return true
}

func (a *App) runInfoRefresh(start time.Time) {
	ids := make([]string, 0, 64)
	seen := map[string]bool{}
	config, err := a.config.Load(a.ctx)
	if err == nil {
		for _, group := range configuredGroupList(config) {
			id := strings.TrimSpace(toString(group["id"]))
			if id != "" && !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
		}
	}
	if rows, queryErr := a.groupAggregates(contextRequest(a.ctx)); queryErr == nil {
		for _, row := range rows {
			if row.id != "" && !seen[row.id] {
				seen[row.id] = true
				ids = append(ids, row.id)
			}
		}
	}
	a.setGroupRefreshProgress(false, map[string]any{"processed": 0, "total": len(ids), "updated": 0, "stage": "resolving"})
	for i := range ids {
		if a.ctx.Err() != nil {
			a.finishGroupRefresh(false, start, nil, a.ctx.Err())
			return
		}
		a.setGroupRefreshProgress(false, map[string]any{"processed": i + 1, "total": len(ids), "updated": 0, "stage": "resolving"})
	}
	result := map[string]any{"updated": 0, "scanned": len(ids), "updates": []any{}}
	a.finishGroupRefresh(false, start, result, nil)
}

func (a *App) runPhotoRefresh(start time.Time) {
	config, err := a.config.Load(a.ctx)
	groups := []map[string]any{}
	if err == nil {
		groups = configuredGroupList(config)
	}
	results := make([]map[string]any, 0, len(groups))
	a.setGroupRefreshProgress(true, map[string]any{"processed": 0, "total": len(groups), "stage": "downloading"})
	for i, group := range groups {
		if a.ctx.Err() != nil {
			a.finishGroupRefresh(true, start, nil, a.ctx.Err())
			return
		}
		id := group["id"]
		idText := strings.TrimSpace(toString(id))
		var photo any
		if idText != "" {
			if info, statErr := os.Stat(filepath.Join(a.dataDir, "photos", idText+".jpg")); statErr == nil && !info.IsDir() {
				photo = "/photos/" + idText + ".jpg"
			}
		}
		results = append(results, map[string]any{"id": id, "url": photo})
		a.setGroupRefreshProgress(true, map[string]any{"processed": i + 1, "total": len(groups), "stage": "downloading"})
	}
	a.finishGroupRefresh(true, start, map[string]any{"results": results}, nil)
}

func (a *App) groupRefreshStateLocked(photos bool) *groupRefreshState {
	if photos {
		return &a.groupRefreshPhotos
	}
	return &a.groupRefreshInfo
}

func (a *App) groupRefreshStatus(photos bool) map[string]any {
	a.groupRefreshMu.Lock()
	defer a.groupRefreshMu.Unlock()
	state := a.groupRefreshStateLocked(photos)
	stage := state.stage
	if stage == "" {
		stage = "idle"
	}
	progress := map[string]any{}
	for key, value := range state.progress {
		progress[key] = value
	}
	return map[string]any{
		"attempts": state.attempts, "durationMs": state.durationMs, "error": state.err,
		"failures": state.failures, "finishedAt": state.finishedAt,
		"kind":     map[bool]string{false: "groupsRefreshInfo", true: "groupsRefreshPhotos"}[photos],
		"progress": progress, "result": state.result, "running": state.running,
		"stage": stage, "startedAt": state.startedAt, "successes": state.successes,
	}
}

func (a *App) setGroupRefreshProgress(photos bool, progress map[string]any) {
	a.groupRefreshMu.Lock()
	state := a.groupRefreshStateLocked(photos)
	state.progress = progress
	state.stage = toString(progress["stage"])
	a.groupRefreshMu.Unlock()
	a.broadcastGroupRefreshProgress(photos)
}

func (a *App) broadcastGroupRefreshProgress(photos bool) {
	status := a.groupRefreshStatus(photos)
	if progress, ok := status["progress"].(map[string]any); ok {
		for _, key := range []string{"processed", "total", "updated"} {
			if value, exists := progress[key]; exists {
				status[key] = value
			}
		}
	}
	prefix := "groups_refresh_info"
	if photos {
		prefix = "groups_refresh_photos"
	}
	a.hub.Broadcast(ws.Event{Type: prefix + "_progress", Flat: true, Payload: status})
}

func (a *App) finishGroupRefresh(photos bool, start time.Time, result map[string]any, runErr error) {
	a.groupRefreshMu.Lock()
	state := a.groupRefreshStateLocked(photos)
	state.running = false
	state.finishedAt = time.Now().UnixMilli()
	state.durationMs = time.Since(start).Milliseconds()
	state.result = result
	if runErr != nil {
		state.stage = "error"
		state.err = runErr.Error()
		state.failures++
	} else {
		state.stage = "done"
		state.err = nil
		state.successes++
	}
	duration := state.durationMs
	a.groupRefreshMu.Unlock()
	if runErr != nil {
		return
	}
	prefix := "groups_refresh_info"
	kind := "groupsRefreshInfo"
	if photos {
		prefix = "groups_refresh_photos"
		kind = "groupsRefreshPhotos"
	}
	payload := map[string]any{"kind": kind, "durationMs": duration}
	for key, value := range result {
		payload[key] = value
	}
	a.hub.Broadcast(ws.Event{Type: prefix + "_done", Flat: true, Payload: payload})
}
