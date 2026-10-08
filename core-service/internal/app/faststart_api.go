package app

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/faststart"
	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

func registerFaststartRoutes(mux *http.ServeMux, a *App) {
	mux.Handle("GET /api/maintenance/faststart/stats", a.requireAdmin(http.HandlerFunc(a.handleFaststartStats)))
	mux.Handle("GET /api/maintenance/faststart/auto-stats", a.requireAdmin(http.HandlerFunc(a.handleFaststartAutoStats)))
	mux.Handle("GET /api/maintenance/faststart/status", a.requireAdmin(http.HandlerFunc(a.handleFaststartStatus)))
	mux.Handle("POST /api/maintenance/faststart/scan", a.requireAdmin(http.HandlerFunc(a.handleFaststartScan)))
}

func faststartIdleStatus() map[string]any {
	return map[string]any{"attempts": 0, "durationMs": 0, "error": nil, "failures": 0, "finishedAt": 0, "kind": "faststart", "progress": map[string]any{}, "result": nil, "running": false, "stage": "idle", "startedAt": 0, "successes": 0}
}

func (a *App) videoRows(ctx context.Context) ([]struct {
	id   int64
	path string
}, error) {
	rows, err := a.db.Reader.QueryContext(ctx, "SELECT id,file_path FROM downloads WHERE file_type='video' ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []struct {
		id   int64
		path string
	}{}
	for rows.Next() {
		var row struct {
			id   int64
			path string
		}
		if rows.Scan(&row.id, &row.path) == nil {
			out = append(out, row)
		}
	}
	return out, rows.Err()
}

func faststartAtom(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	head := make([]byte, 12)
	if _, err = io.ReadFull(f, head); err != nil || string(head[4:8]) != "ftyp" {
		return ""
	}
	sz := binary.BigEndian.Uint32(head[:4])
	if sz < 8 || sz > 4096 {
		return ""
	}
	if _, err = f.Seek(int64(sz), io.SeekStart); err != nil {
		return ""
	}
	atom := make([]byte, 8)
	if _, err = io.ReadFull(f, atom); err != nil {
		return ""
	}
	return string(atom[4:8])
}

func (a *App) handleFaststartStats(w http.ResponseWriter, r *http.Request) {
	rows, _ := a.videoRows(r.Context())
	optimized, pending, unknown, missing := 0, 0, 0, 0
	for _, row := range rows {
		p := filepath.Join(a.dataDir, "downloads", filepath.FromSlash(row.path))
		if _, err := os.Stat(p); err != nil {
			missing++
			continue
		}
		switch faststartAtom(p) {
		case "moov":
			optimized++
		case "":
			unknown++
		default:
			pending++
		}
	}
	a.faststartMu.Lock()
	var last any
	if len(a.faststartLastRun) > 0 {
		last = cloneConfigValue(a.faststartLastRun)
	}
	a.faststartMu.Unlock()
	ffmpeg := false
	if _, err := exec.LookPath("ffmpeg"); err == nil {
		ffmpeg = true
	}
	writeJSON(w, 200, map[string]any{"success": true, "ffmpegAvailable": ffmpeg, "lastRun": last, "missing": missing, "optimized": optimized, "pending": pending, "total": len(rows), "unknown": unknown})
}
func (a *App) handleFaststartAutoStats(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, 200, map[string]any{"success": true, "ffmpegAvailable": true, "lastAt": nil, "lastError": nil, "lastResult": nil, "already": 0, "errored": 0, "optimized": 0, "skipped": 0, "total": 0})
}
func (a *App) handleFaststartStatus(w http.ResponseWriter, _ *http.Request) {
	a.faststartMu.Lock()
	s := cloneConfigValue(a.faststartStatus).(map[string]any)
	a.faststartMu.Unlock()
	writeJSON(w, 200, s)
}

func (a *App) handleFaststartScan(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	a.faststartMu.Lock()
	previousAttempts, _ := a.faststartStatus["attempts"].(int)
	previousSuccesses, _ := a.faststartStatus["successes"].(int)
	a.faststartMu.Unlock()
	rows, _ := a.videoRows(r.Context())
	a.faststartMu.Lock()
	status := faststartIdleStatus()
	status["attempts"] = previousAttempts + 1
	status["running"] = true
	status["stage"] = "scanning"
	status["startedAt"] = started.UnixMilli()
	a.faststartStatus = status
	a.faststartMu.Unlock()
	a.hub.Broadcast(ws.Event{Type: "faststart_progress", Flat: true, Payload: map[string]any{"total": len(rows)}})
	roots, _ := hash.NewRoots([]string{filepath.Join(a.dataDir, "downloads")})
	handler := &faststart.Handler{Roots: roots}
	already, optimized, errored, skipped := 0, 0, 0, 0
	for _, row := range rows {
		path := filepath.Join(a.dataDir, "downloads", filepath.FromSlash(row.path))
		if faststartAtom(path) == "moov" {
			already++
			continue
		}
		body, _ := json.Marshal(map[string]any{"path": path})
		req := r.Clone(r.Context())
		req.Method = http.MethodPost
		req.Body = io.NopCloser(bytes.NewReader(body))
		rec := &responseCapture{header: make(http.Header), body: bytes.NewBuffer(nil), status: 200}
		handler.ServeHTTP(rec, req)
		if rec.status == 200 {
			var out map[string]any
			_ = json.Unmarshal(rec.body.Bytes(), &out)
			if out["status"] == "optimized" {
				optimized++
			} else {
				skipped++
			}
		} else {
			errored++
		}
	}
	finished := time.Now()
	result := map[string]any{"already": already, "errored": errored, "optimized": optimized, "scanned": len(rows), "skipped": skipped}
	a.faststartMu.Lock()
	status["running"] = false
	status["stage"] = "done"
	status["finishedAt"] = finished.UnixMilli()
	status["durationMs"] = finished.Sub(started).Milliseconds()
	status["successes"] = previousSuccesses + 1
	status["already"] = already
	status["optimized"] = optimized
	status["errored"] = errored
	status["skipped"] = skipped
	status["processed"] = len(rows)
	status["total"] = len(rows)
	status["progress"] = map[string]any{"already": already, "errored": errored, "optimized": optimized, "processed": len(rows), "skipped": skipped, "stage": "done", "total": len(rows)}
	status["result"] = result
	a.faststartStatus = status
	a.faststartLastRun = map[string]any{"already": already, "errored": errored, "finishedAt": finished.UnixMilli(), "optimized": optimized, "scanned": len(rows), "skipped": skipped}
	a.faststartMu.Unlock()
	a.hub.Broadcast(ws.Event{Type: "faststart_done", Flat: true, Payload: map[string]any{"already": already, "durationMs": finished.Sub(started).Milliseconds(), "errored": errored, "kind": "faststart", "optimized": optimized, "scanned": len(rows), "skipped": skipped}})
	writeJSON(w, 200, map[string]any{"started": true, "success": true})
}
