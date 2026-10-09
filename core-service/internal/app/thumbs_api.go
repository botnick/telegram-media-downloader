package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
	"github.com/botnick/telegram-media-downloader/core-service/internal/thumbs"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

const thumbWidth = 320

func registerThumbRoutes(mux *http.ServeMux, a *App) {
	mux.Handle("GET /api/maintenance/thumbs/stats", a.requireAdmin(http.HandlerFunc(a.handleThumbStats)))
	mux.Handle("GET /api/maintenance/thumbs/list", a.requireAdmin(http.HandlerFunc(a.handleThumbList)))
	mux.Handle("GET /api/maintenance/thumbs/build/status", a.requireAdmin(http.HandlerFunc(a.handleThumbBuildStatus)))
	mux.Handle("GET /api/maintenance/thumbs/build/stats", a.requireAdmin(http.HandlerFunc(a.handleThumbBuildStats)))
	mux.Handle("POST /api/maintenance/thumbs/build-all", a.requireAdmin(http.HandlerFunc(a.handleThumbBuild)))
	mux.Handle("POST /api/maintenance/thumbs/build/cancel", a.requireAdmin(http.HandlerFunc(a.handleThumbBuildCancel)))
	mux.Handle("GET /api/maintenance/thumbs/rebuild/status", a.requireAdmin(http.HandlerFunc(a.handleThumbRebuildStatus)))
	mux.Handle("POST /api/maintenance/thumbs/rebuild", a.requireAdmin(http.HandlerFunc(a.handleThumbRebuild)))
	mux.Handle("POST /api/maintenance/thumbs/rebuild-one/{id}", a.requireAdmin(http.HandlerFunc(a.handleThumbRebuildOne)))
	mux.Handle("GET /api/maintenance/thumbs/hwaccel-probe", a.requireAdmin(http.HandlerFunc(a.handleThumbHWAccel)))
}

func thumbsIdleStatus(kind string) map[string]any {
	return map[string]any{"attempts": 0, "durationMs": 0, "error": nil, "failures": 0, "finishedAt": 0, "kind": kind, "progress": map[string]any{}, "result": nil, "running": false, "stage": "idle", "startedAt": 0, "successes": 0}
}

func thumbKindTypes(kind string) ([]string, string) {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "image":
		return []string{"photo", "image", "sticker"}, "image"
	case "video":
		return []string{"video"}, "video"
	case "audio":
		return []string{"audio"}, "audio"
	default:
		return []string{"photo", "image", "sticker", "video", "audio"}, "all"
	}
}

type thumbRow struct {
	id    int64
	path  string
	type_ string
}

func (a *App) thumbRows(ctx context.Context, kind string) ([]thumbRow, error) {
	types, _ := thumbKindTypes(kind)
	placeholders := make([]string, len(types))
	args := make([]any, len(types))
	for i, typ := range types {
		placeholders[i], args[i] = "?", typ
	}
	rows, err := a.db.Reader.QueryContext(ctx, `SELECT id,file_path,file_type FROM downloads WHERE file_path IS NOT NULL AND file_type IN (`+strings.Join(placeholders, ",")+`) ORDER BY id DESC`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]thumbRow, 0)
	for rows.Next() {
		var row thumbRow
		if err := rows.Scan(&row.id, &row.path, &row.type_); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func thumbCachePath(root string, id int64) string {
	sum := sha256.Sum256([]byte(strconv.FormatInt(id, 10) + ":320"))
	return filepath.Join(root, hex.EncodeToString(sum[:])[:32]+".webp")
}

func (a *App) handleThumbStats(w http.ResponseWriter, _ *http.Request) {
	root := filepath.Join(a.dataDir, "thumbs")
	names, _ := os.ReadDir(root)
	count, bytesTotal := 0, int64(0)
	for _, name := range names {
		if name.IsDir() || !strings.HasSuffix(name.Name(), ".webp") {
			continue
		}
		if st, err := name.Info(); err == nil && st.Mode().IsRegular() {
			count++
			bytesTotal += st.Size()
		}
	}
	_, err := exec.LookPath("ffmpeg")
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "ffmpegAvailable": err == nil, "allowedWidths": []int{thumbWidth}, "count": count, "bytes": bytesTotal})
}

func (a *App) handleThumbList(w http.ResponseWriter, r *http.Request) {
	kind := r.URL.Query().Get("kind")
	limit := queryInt(r, "limit", 60)
	cursor := queryInt(r, "cursor", 0)
	cachedOnly := r.URL.Query().Get("cachedOnly") == "1"
	payload, status := a.invokeRead(r, a.read.ThumbsList, map[string]any{"kind": kind, "limit": limit, "cursor": cursor, "cachedOnly": cachedOnly, "cacheRoot": filepath.Join(a.dataDir, "thumbs")})
	writeJSON(w, status, payload)
}

func (a *App) handleThumbBuildStatus(w http.ResponseWriter, _ *http.Request) {
	a.thumbMu.Lock()
	status := cloneConfigValue(a.thumbBuildStatus).(map[string]any)
	a.thumbMu.Unlock()
	writeJSON(w, http.StatusOK, status)
}

func (a *App) handleThumbRebuildStatus(w http.ResponseWriter, _ *http.Request) {
	a.thumbMu.Lock()
	status := cloneConfigValue(a.thumbRebuildStatus).(map[string]any)
	a.thumbMu.Unlock()
	writeJSON(w, http.StatusOK, status)
}

func (a *App) handleThumbBuildStats(w http.ResponseWriter, _ *http.Request) {
	a.thumbMu.Lock()
	var last any
	if a.thumbBuildLastRun != nil {
		last = cloneConfigValue(a.thumbBuildLastRun)
	}
	a.thumbMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"lastRun": last})
}

func (a *App) handleThumbBuild(w http.ResponseWriter, r *http.Request) {
	body, _ := readAuthBody(w, r)
	_, kind := thumbKindTypes(toString(body["kind"]))
	a.thumbMu.Lock()
	if a.thumbBuildStatus["running"] == true {
		a.thumbMu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]any{"error": "A thumbnail build is already running", "code": "ALREADY_RUNNING"})
		return
	}
	ctx, cancel := context.WithCancel(a.ctx)
	a.thumbBuildCancel = cancel
	a.thumbBuildStatus["running"] = true
	a.thumbMu.Unlock()
	if !a.launchMaintenance(func() { a.runThumbBuild(ctx, kind) }) {
		writeJSONError(w, http.StatusServiceUnavailable, "server is stopping")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "started": true, "kind": kind})
}

func (a *App) runThumbBuild(ctx context.Context, kind string) {
	a.mediaMu.RLock()
	defer a.mediaMu.RUnlock()
	started := time.Now()
	a.thumbMu.Lock()
	previousAttempts, _ := a.thumbBuildStatus["attempts"].(int)
	previousSuccesses, _ := a.thumbBuildStatus["successes"].(int)
	status := thumbsIdleStatus("thumbsBuild")
	status["attempts"], status["running"], status["stage"], status["startedAt"] = previousAttempts+1, true, "building", started.UnixMilli()
	a.thumbBuildStatus = cloneConfigValue(status).(map[string]any)
	a.thumbMu.Unlock()
	if err := a.mediaWritable(ctx); err != nil {
		a.finishThumbBuild(started, status, kind, previousSuccesses, 0, 0, 0, 0, err)
		return
	}
	rows, err := a.thumbRows(ctx, kind)
	if err != nil {
		a.finishThumbBuild(started, status, kind, previousSuccesses, 0, 0, 0, 0, err)
		return
	}
	a.thumbMu.Lock()
	status["total"] = len(rows)
	a.thumbBuildStatus = cloneConfigValue(status).(map[string]any)
	a.thumbMu.Unlock()
	a.hub.Broadcast(ws.Event{Type: "thumbs_progress", Flat: true, Payload: map[string]any{"kind": kind, "processed": 0, "total": len(rows), "built": 0, "skipped": 0, "errored": 0, "stage": "building"}})
	roots, _ := hash.NewRoots([]string{a.downloadsDir, filepath.Join(a.dataDir, "thumbs")})
	handlers := map[string]*thumbs.Handler{
		"image": {Roots: roots, Kind: "image"},
		"video": {Roots: roots, Kind: "video"},
		"audio": {Roots: roots, Kind: "audio"},
	}
	built, skipped, errored, processed := 0, 0, 0, 0
	for _, row := range rows {
		if ctx.Err() != nil {
			break
		}
		processed++
		cache := thumbCachePath(filepath.Join(a.dataDir, "thumbs"), row.id)
		if st, err := os.Stat(cache); err == nil && st.Size() > 0 {
			skipped++
			continue
		}
		kindName := "image"
		if row.type_ == "video" {
			kindName = "video"
		} else if row.type_ == "audio" {
			kindName = "audio"
		}
		if err := os.MkdirAll(filepath.Dir(cache), 0o700); err != nil {
			errored++
			continue
		}
		tmp := cache + ".tmp-" + strconv.FormatInt(time.Now().UnixNano(), 10)
		body, _ := json.Marshal(map[string]any{"path": filepath.Join(a.downloadsDir, filepath.FromSlash(row.path)), "output": tmp, "width": thumbWidth})
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://localhost/v1/thumb/"+kindName, bytes.NewReader(body))
		rec := &responseCapture{header: make(http.Header), body: bytes.NewBuffer(nil), status: http.StatusOK}
		handlers[kindName].ServeHTTP(rec, req)
		var result map[string]any
		_ = json.Unmarshal(rec.body.Bytes(), &result)
		if rec.status == http.StatusOK && result["status"] == "ok" {
			if err := os.Rename(tmp, cache); err != nil {
				errored++
			} else {
				built++
			}
		} else {
			_ = os.Remove(tmp)
			if rec.status == http.StatusUnprocessableEntity || result["code"] == "EFFMPEG" {
				errored++
			} else {
				skipped++
			}
		}
		if processed == len(rows) || processed%10 == 0 {
			a.hub.Broadcast(ws.Event{Type: "thumbs_progress", Flat: true, Payload: map[string]any{"kind": kind, "processed": processed, "total": len(rows), "built": built, "skipped": skipped, "errored": errored, "stage": "building"}})
		}
	}
	a.finishThumbBuild(started, status, kind, previousSuccesses, processed, built, skipped, errored, ctx.Err())
}

func (a *App) finishThumbBuild(started time.Time, status map[string]any, requestedKind string, previousSuccesses, processed, built, skipped, errored int, runErr error) {
	finished := time.Now()
	result := map[string]any{"built": built, "errored": errored, "kind": requestedKind, "scanned": statusTotal(status, processed), "skipped": skipped}
	if runErr != nil {
		status["error"] = runErr.Error()
		status["failures"] = 1
	}
	status["running"], status["stage"], status["finishedAt"], status["durationMs"] = false, "done", finished.UnixMilli(), finished.Sub(started).Milliseconds()
	status["successes"] = previousSuccesses + 1
	if runErr != nil {
		status["stage"], status["successes"] = "error", previousSuccesses
	}
	status["processed"], status["built"], status["skipped"], status["errored"], status["total"] = processed, built, skipped, errored, statusTotal(status, processed)
	status["progress"] = map[string]any{"built": built, "errored": errored, "kind": requestedKind, "processed": processed, "skipped": skipped, "stage": status["stage"], "total": statusTotal(status, processed)}
	status["result"] = result
	a.thumbMu.Lock()
	a.thumbBuildStatus = cloneConfigValue(status).(map[string]any)
	a.thumbBuildLastRun = map[string]any{"finishedAt": finished.UnixMilli(), "kind": requestedKind, "built": built, "skipped": skipped, "errored": errored, "scanned": statusTotal(status, processed)}
	a.thumbBuildCancel = nil
	a.thumbMu.Unlock()
	if runErr != nil {
		a.hub.Broadcast(ws.Event{Type: "thumbs_done", Flat: true, Payload: map[string]any{"error": runErr.Error(), "durationMs": finished.Sub(started).Milliseconds(), "kind": "thumbsBuild"}})
		return
	}
	a.hub.Broadcast(ws.Event{Type: "thumbs_done", Flat: true, Payload: map[string]any{"built": built, "durationMs": finished.Sub(started).Milliseconds(), "errored": errored, "kind": "thumbsBuild", "scanned": statusTotal(status, processed), "skipped": skipped}})
}

func statusTotal(status map[string]any, fallback int) int {
	if v, ok := status["total"].(int); ok && v > 0 {
		return v
	}
	return fallback
}

func (a *App) handleThumbBuildCancel(w http.ResponseWriter, _ *http.Request) {
	a.thumbMu.Lock()
	cancelled := false
	if a.thumbBuildCancel != nil {
		a.thumbBuildCancel()
		cancelled = true
	}
	a.thumbMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "cancelled": cancelled})
}

func (a *App) handleThumbRebuild(w http.ResponseWriter, r *http.Request) {
	body, _ := readAuthBody(w, r)
	_, kind := thumbKindTypes(toString(body["kind"]))
	a.thumbMu.Lock()
	if a.thumbRebuildStatus["running"] == true {
		a.thumbMu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]any{"error": "A thumbnail wipe is already running", "code": "ALREADY_RUNNING"})
		return
	}
	previousAttempts, _ := a.thumbRebuildStatus["attempts"].(int)
	previousSuccesses, _ := a.thumbRebuildStatus["successes"].(int)
	status := thumbsIdleStatus("thumbsRebuild")
	status["attempts"], status["successes"], status["running"], status["stage"], status["startedAt"] = previousAttempts+1, previousSuccesses, true, "rebuilding", time.Now().UnixMilli()
	a.thumbRebuildStatus = cloneConfigValue(status).(map[string]any)
	a.thumbMu.Unlock()
	if !a.launchMaintenance(func() { a.runThumbRebuild(kind, status, previousSuccesses) }) {
		writeJSONError(w, http.StatusServiceUnavailable, "server is stopping")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "started": true, "kind": kind})
}

func (a *App) runThumbRebuild(kind string, status map[string]any, previousSuccesses int) {
	a.mediaMu.RLock()
	defer a.mediaMu.RUnlock()
	started := time.Now()
	removed := 0
	root := filepath.Join(a.dataDir, "thumbs")
	if kind == "all" {
		if names, err := os.ReadDir(root); err == nil {
			for _, name := range names {
				if strings.HasSuffix(name.Name(), ".webp") || strings.Contains(name.Name(), ".tmp-") {
					if os.Remove(filepath.Join(root, name.Name())) == nil {
						removed++
					}
				}
			}
		}
	} else if rows, err := a.thumbRows(context.Background(), kind); err == nil {
		for _, row := range rows {
			if os.Remove(thumbCachePath(root, row.id)) == nil {
				removed++
			}
		}
	}
	a.hub.Broadcast(ws.Event{Type: "thumbs_rebuild_progress", Flat: true, Payload: map[string]any{"kind": kind, "removed": removed}})
	finished := time.Now()
	status["running"], status["stage"], status["finishedAt"], status["durationMs"], status["successes"] = false, "done", finished.UnixMilli(), finished.Sub(started).Milliseconds(), previousSuccesses+1
	status["result"] = map[string]any{"kind": kind, "removed": removed}
	status["progress"] = map[string]any{}
	a.thumbMu.Lock()
	a.thumbRebuildStatus = cloneConfigValue(status).(map[string]any)
	a.thumbMu.Unlock()
	a.hub.Broadcast(ws.Event{Type: "thumbs_rebuild_done", Flat: true, Payload: map[string]any{"durationMs": finished.Sub(started).Milliseconds(), "kind": "thumbsRebuild", "removed": removed}})
}

func (a *App) handleThumbRebuildOne(w http.ResponseWriter, r *http.Request) {
	a.mediaMu.RLock()
	defer a.mediaMu.RUnlock()
	if err := a.mediaWritable(r.Context()); err != nil {
		writeJSONError(w, http.StatusConflict, err.Error())
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeJSONError(w, http.StatusBadRequest, "Bad id")
		return
	}
	removed := 0
	if os.Remove(thumbCachePath(filepath.Join(a.dataDir, "thumbs"), id)) == nil {
		removed = 1
	}
	rows, _ := a.thumbRows(context.Background(), "all")
	for _, row := range rows {
		if row.id != id {
			continue
		}
		// Warm the default width synchronously, matching the old endpoint's
		// response: cached is true only when the source can be rendered.
		a.buildOneThumb(r.Context(), row)
		break
	}
	_, _ = a.db.Reader.ExecContext(r.Context(), "SELECT 1")
	_, statErr := os.Stat(thumbCachePath(filepath.Join(a.dataDir, "thumbs"), id))
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "removed": removed, "cached": statErr == nil})
}

func (a *App) buildOneThumb(ctx context.Context, row thumbRow) {
	kind := "image"
	if row.type_ == "video" {
		kind = "video"
	} else if row.type_ == "audio" {
		kind = "audio"
	} else if row.type_ != "photo" && row.type_ != "image" && row.type_ != "sticker" {
		return
	}
	cache := thumbCachePath(filepath.Join(a.dataDir, "thumbs"), row.id)
	_ = os.MkdirAll(filepath.Dir(cache), 0o700)
	roots, _ := hash.NewRoots([]string{a.downloadsDir, filepath.Join(a.dataDir, "thumbs")})
	tmp := cache + ".tmp-one"
	body, _ := json.Marshal(map[string]any{"path": filepath.Join(a.downloadsDir, filepath.FromSlash(row.path)), "output": tmp, "width": thumbWidth})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://localhost/v1/thumb/"+kind, bytes.NewReader(body))
	rec := &responseCapture{header: make(http.Header), body: bytes.NewBuffer(nil), status: http.StatusOK}
	(&thumbs.Handler{Roots: roots, Kind: kind}).ServeHTTP(rec, req)
	if rec.status == http.StatusOK {
		_ = os.Rename(tmp, cache)
	}
	_ = os.Remove(tmp)
}

func (a *App) handleThumbHWAccel(w http.ResponseWriter, _ *http.Request) {
	path, err := exec.LookPath("ffmpeg")
	if err != nil {
		path = "ffmpeg"
	}
	compiled := []string{}
	if out, runErr := exec.Command(path, "-hide_banner", "-hwaccels").Output(); runErr == nil {
		known := map[string]bool{"vaapi": true, "cuda": true, "qsv": true, "videotoolbox": true, "d3d11va": true, "dxva2": true, "opencl": true, "vulkan": true}
		for _, line := range strings.Split(string(out), "\n") {
			line = strings.ToLower(strings.TrimSpace(line))
			if known[line] && !containsString(compiled, line) {
				compiled = append(compiled, line)
			}
		}
	}
	// Keep the invariant required by the UI: available is a subset of the
	// compiled list. Device initialization is host-specific, so the safe
	// default is the empty verified set.
	writeJSON(w, http.StatusOK, map[string]any{"available": []string{}, "compiledIn": compiled, "ffmpegPath": path, "recommended": nil})
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
