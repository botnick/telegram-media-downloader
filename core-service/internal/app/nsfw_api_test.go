package app

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

// nsfwFakeSidecar scores uploads by content: "nsfw" → 0.95, anything else
// → 0.1. Path mode is off, so the client falls back to uploads like a
// sidecar on another host.
type nsfwFakeSidecar struct {
	block    chan struct{} // non-nil: /classify/upload waits on it or the request
	status   atomic.Int32  // forced /classify* status
	inFlight atomic.Int32
	peak     atomic.Int32
	uploads  atomic.Int32
}

func (f *nsfwFakeSidecar) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.URL.Path == "/health" {
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "ready": true, "model": "fake", "version": "1.2.0", "features": []string{"path", "upload"}})
		return
	}
	if code := f.status.Load(); code != 0 {
		w.WriteHeader(int(code))
		return
	}
	if r.URL.Path == "/classify" {
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": "path_not_allowed", "code": "path_not_allowed"})
		return
	}
	n := f.inFlight.Add(1)
	defer f.inFlight.Add(-1)
	for {
		peak := f.peak.Load()
		if n <= peak || f.peak.CompareAndSwap(peak, n) {
			break
		}
	}
	f.uploads.Add(1)
	if f.block != nil {
		select {
		case <-f.block:
		case <-r.Context().Done():
			return
		}
	} else {
		time.Sleep(5 * time.Millisecond)
	}
	body, _ := io.ReadAll(r.Body)
	score := 0.1
	if string(body) == "nsfw" {
		score = 0.95
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"score": score, "label": "x"})
}

type nsfwHarness struct {
	t     *testing.T
	a     *App
	token string
	data  string
}

func newNSFWHarness(t *testing.T, nsfwCfg map[string]any) *nsfwHarness {
	t.Helper()
	for _, key := range []string{"TGDL_NSFW_SIDECAR_URL", "TGDL_NSFW_API_TOKEN", "TGDL_NSFW_PATH_MAP"} {
		t.Setenv(key, "")
	}
	data := t.TempDir()
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: data, Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.Close() })
	if err := a.config.Save(context.Background(), map[string]any{
		"web":      map[string]any{"password": "test-admin-password", "enabled": true},
		"advanced": map[string]any{"nsfw": nsfwCfg},
	}); err != nil {
		t.Fatal(err)
	}
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	return &nsfwHarness{t: t, a: a, token: token, data: data}
}

// addFile inserts a download row and, unless content is empty, its file.
func (h *nsfwHarness) addFile(id int64, kind, name, content, hash string) {
	h.t.Helper()
	if content != "" {
		p := filepath.Join(h.data, "downloads", "g", name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			h.t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
			h.t.Fatal(err)
		}
	}
	var fileHash any
	if hash != "" {
		fileHash = hash
	}
	if _, err := h.a.db.Writer.Exec(`INSERT INTO downloads(id, group_id, message_id, file_name, file_path, file_type, file_hash) VALUES (?, '-1', ?, ?, ?, ?, ?)`, id, id, name, "g/"+name, kind, fileHash); err != nil {
		h.t.Fatal(err)
	}
}

func (h *nsfwHarness) call(method, path string, body any) (int, map[string]any) {
	h.t.Helper()
	var reader io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, reader)
	req.AddCookie(&http.Cookie{Name: h.a.sessions.CookieName(), Value: h.token})
	rr := httptest.NewRecorder()
	h.a.Handler().ServeHTTP(rr, req)
	var out map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	return rr.Code, out
}

func (h *nsfwHarness) score(id int64) (sql.NullFloat64, sql.NullInt64) {
	h.t.Helper()
	var score sql.NullFloat64
	var checked sql.NullInt64
	if err := h.a.db.Writer.QueryRow(`SELECT nsfw_score, nsfw_checked_at FROM downloads WHERE id = ?`, id).Scan(&score, &checked); err != nil {
		h.t.Fatal(err)
	}
	return score, checked
}

func waitEvent(t *testing.T, events <-chan ws.Event, kind string) ws.Event {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case ev := <-events:
			if ev.Type == kind {
				return ev
			}
		case <-deadline:
			t.Fatalf("no %s event", kind)
		}
	}
}

func TestNSFWWithoutSidecarExplainsWhatToConfigure(t *testing.T) {
	h := newNSFWHarness(t, map[string]any{"enabled": true})
	h.addFile(1, "photo", "a.jpg", "x", "")
	if _, err := h.a.db.Writer.Exec(`UPDATE downloads SET nsfw_score = 0.2, nsfw_checked_at = 1 WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	code, status := h.call(http.MethodGet, "/api/maintenance/nsfw/status", nil)
	if code != 200 || status["sidecarConfigured"] != false || status["code"] != nsfwSidecarCode || status["error"] != nsfwSidecarMessage || status["candidates"] != 1.0 {
		t.Fatalf("status %d %v", code, status)
	}
	for _, route := range []struct{ method, path string }{
		{http.MethodPost, "/api/maintenance/nsfw/scan"},
		{http.MethodPost, "/api/maintenance/nsfw/preload"},
		{http.MethodDelete, "/api/maintenance/nsfw/cache"},
	} {
		code, body := h.call(route.method, route.path, map[string]any{})
		if code != http.StatusServiceUnavailable || body["code"] != nsfwSidecarCode {
			t.Fatalf("%s %s = %d %v", route.method, route.path, code, body)
		}
	}
	code, model := h.call(http.MethodGet, "/api/maintenance/nsfw/model-status", nil)
	sidecar, _ := model["sidecar"].(map[string]any)
	if code != 200 || model["code"] != nsfwSidecarCode || sidecar["configured"] != false {
		t.Fatalf("model-status %d %v", code, model)
	}
	// Review still works on rows scored earlier.
	code, tiers := h.call(http.MethodGet, "/api/maintenance/nsfw/v2/tiers", nil)
	if code != 200 || tiers["threshold"] != 0.6 || tiers["tiers"].(map[string]any)["def_not"] != 1.0 {
		t.Fatalf("tiers %d %v", code, tiers)
	}
	code, list := h.call(http.MethodGet, "/api/maintenance/nsfw/v2/list?tier=def_not", nil)
	if code != 200 || list["total"] != 1.0 {
		t.Fatalf("list %d %v", code, list)
	}
	code, hist := h.call(http.MethodGet, "/api/maintenance/nsfw/v2/histogram?bins=10", nil)
	if code != 200 || hist["bins"] != 10.0 {
		t.Fatalf("histogram %d %v", code, hist)
	}
}

func TestNSFWScanScoresPhotosThroughSidecar(t *testing.T) {
	fake := &nsfwFakeSidecar{}
	srv := httptest.NewServer(fake)
	defer srv.Close()
	h := newNSFWHarness(t, map[string]any{"enabled": true, "sidecarUrl": srv.URL, "concurrency": 2.0, "batchSize": 3.0, "threshold": 0.5})
	h.addFile(1, "photo", "keep.jpg", "nsfw", "")
	h.addFile(2, "photo", "drop.jpg", "plain", "")
	h.addFile(3, "photo", "gone.jpg", "", "")      // file missing on disk
	h.addFile(4, "video", "clip.mp4", "video", "") // not in fileTypes
	for id := int64(10); id < 20; id++ {
		h.addFile(id, "photo", "p"+string(rune('a'+id))+".jpg", "plain", "")
	}
	client := h.a.hub.Add("admin")
	defer h.a.hub.Remove(client)
	if code, body := h.call(http.MethodPost, "/api/maintenance/nsfw/scan", map[string]any{}); code != 200 || body["started"] != true {
		t.Fatalf("scan %d %v", code, body)
	}
	done := waitEvent(t, client.Events(), "nsfw_done").Payload.(nsfwScanState)
	if done.Running || done.Error != nil || done.Scanned != 13 || done.Keep != 1 || done.Candidates != 11 {
		t.Fatalf("done=%+v", done)
	}
	if s, c := h.score(1); !c.Valid || s.Float64 != 0.95 {
		t.Fatalf("row 1 score=%v checked=%v", s, c)
	}
	if s, c := h.score(3); !c.Valid || s.Valid {
		t.Fatalf("missing file should be checked without a score: %v %v", s, c)
	}
	if _, c := h.score(4); c.Valid {
		t.Fatal("video row is not an eligible file type")
	}
	if peak := fake.peak.Load(); peak > 2 {
		t.Fatalf("concurrency bound exceeded: %d", peak)
	}
	code, status := h.call(http.MethodGet, "/api/maintenance/nsfw/status", nil)
	if code != 200 || status["running"] != false || status["candidates"] != 11.0 || status["keep"] != 1.0 || status["lastCheckedAt"] == nil {
		t.Fatalf("status %d %v", code, status)
	}
	// A second run finds nothing left to do.
	if code, _ := h.call(http.MethodPost, "/api/maintenance/nsfw/scan", map[string]any{}); code != 200 {
		t.Fatalf("rescan %d", code)
	}
	if again := waitEvent(t, client.Events(), "nsfw_done").Payload.(nsfwScanState); again.Scanned != 0 {
		t.Fatalf("rescan=%+v", again)
	}
}

func TestNSFWScanCancelAndConflict(t *testing.T) {
	fake := &nsfwFakeSidecar{block: make(chan struct{})}
	srv := httptest.NewServer(fake)
	defer srv.Close()
	defer close(fake.block)
	h := newNSFWHarness(t, map[string]any{"enabled": true, "sidecarUrl": srv.URL, "concurrency": 1.0})
	h.addFile(1, "photo", "a.jpg", "plain", "")
	h.addFile(2, "photo", "b.jpg", "plain", "")
	client := h.a.hub.Add("admin")
	defer h.a.hub.Remove(client)
	if code, _ := h.call(http.MethodPost, "/api/maintenance/nsfw/scan", map[string]any{}); code != 200 {
		t.Fatalf("scan %d", code)
	}
	deadline := time.Now().Add(5 * time.Second)
	for fake.uploads.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if code, body := h.call(http.MethodPost, "/api/maintenance/nsfw/scan", map[string]any{}); code != http.StatusConflict || body["code"] != "ALREADY_RUNNING" {
		t.Fatalf("second scan %d %v", code, body)
	}
	if code, body := h.call(http.MethodPost, "/api/maintenance/nsfw/scan/cancel", map[string]any{}); code != 200 || body["cancelled"] != true {
		t.Fatalf("cancel %d %v", code, body)
	}
	done := waitEvent(t, client.Events(), "nsfw_done").Payload.(nsfwScanState)
	if done.Error != nil || done.Scanned != 0 {
		t.Fatalf("done=%+v", done)
	}
	if _, c := h.score(1); c.Valid {
		t.Fatal("cancelled row must stay unchecked")
	}
}

func TestNSFWScanStopsWhenSidecarFails(t *testing.T) {
	fake := &nsfwFakeSidecar{}
	fake.status.Store(http.StatusServiceUnavailable)
	srv := httptest.NewServer(fake)
	defer srv.Close()
	h := newNSFWHarness(t, map[string]any{"enabled": true, "sidecarUrl": srv.URL, "retryBackoffMs": []any{1.0}})
	h.addFile(1, "photo", "a.jpg", "plain", "")
	client := h.a.hub.Add("admin")
	defer h.a.hub.Remove(client)
	if code, _ := h.call(http.MethodPost, "/api/maintenance/nsfw/scan", map[string]any{}); code != 200 {
		t.Fatalf("scan %d", code)
	}
	done := waitEvent(t, client.Events(), "nsfw_done").Payload.(nsfwScanState)
	if done.Error == nil || !strings.Contains(*done.Error, "unavailable") {
		t.Fatalf("done=%+v", done)
	}
	if _, c := h.score(1); c.Valid {
		t.Fatal("a sidecar outage must not mark rows as checked")
	}
}

func TestNSFWShutdownStopsScan(t *testing.T) {
	fake := &nsfwFakeSidecar{block: make(chan struct{})}
	srv := httptest.NewServer(fake)
	defer srv.Close()
	defer close(fake.block)
	h := newNSFWHarness(t, map[string]any{"enabled": true, "sidecarUrl": srv.URL})
	h.addFile(1, "photo", "a.jpg", "plain", "")
	if code, _ := h.call(http.MethodPost, "/api/maintenance/nsfw/scan", map[string]any{}); code != 200 {
		t.Fatalf("scan %d", code)
	}
	closed := make(chan struct{})
	go func() { h.a.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(10 * time.Second):
		t.Fatal("Close did not stop the scan")
	}
}

func TestNSFWBulkActionsAndBlocklist(t *testing.T) {
	h := newNSFWHarness(t, map[string]any{"enabled": true, "blocklistEnabled": true})
	for id, score := range map[int64]float64{1: 0.1, 2: 0.2, 3: 0.6, 4: 0.95} {
		h.addFile(id, "photo", "f"+string(rune('0'+id))+".jpg", "data", "hash"+string(rune('0'+id)))
		if _, err := h.a.db.Writer.Exec(`UPDATE downloads SET nsfw_score = ?, nsfw_checked_at = 1 WHERE id = ?`, score, id); err != nil {
			t.Fatal(err)
		}
	}
	client := h.a.hub.Add("admin")
	defer h.a.hub.Remove(client)
	run := func(path string, body map[string]any) map[string]any {
		t.Helper()
		if code, res := h.call(http.MethodPost, path, body); code != 200 || res["started"] != true {
			t.Fatalf("%s %d %v", path, code, res)
		}
		return waitEvent(t, client.Events(), "nsfw_bulk_done").Payload.(map[string]any)
	}
	if code, _ := h.call(http.MethodPost, "/api/maintenance/nsfw/v2/bulk-delete", map[string]any{"tier": "def_not"}); code != http.StatusBadRequest {
		t.Fatalf("bulk-delete without confirm = %d", code)
	}
	if done := run("/api/maintenance/nsfw/v2/bulk-whitelist", map[string]any{"ids": []any{3.0}}); done["op"] != "whitelist" || done["updated"] != int64(1) {
		t.Fatalf("whitelist done=%v", done)
	}
	if done := run("/api/maintenance/nsfw/v2/unwhitelist", map[string]any{"tier": "uncertain"}); done["updated"] != int64(1) {
		t.Fatalf("unwhitelist done=%v", done)
	}
	if done := run("/api/maintenance/nsfw/v2/reclassify", map[string]any{"ids": []any{4.0}}); done["op"] != "reclassify" || done["cleared"] != int64(1) {
		t.Fatalf("reclassify done=%v", done)
	}
	if s, c := h.score(4); s.Valid || c.Valid {
		t.Fatal("reclassify must clear the score")
	}
	done := run("/api/maintenance/nsfw/v2/bulk-delete", map[string]any{"tier": "def_not", "confirm": true})
	if done["op"] != "delete" || done["deleted"] != int64(2) {
		t.Fatalf("delete done=%v", done)
	}
	var left int
	_ = h.a.db.Writer.QueryRow(`SELECT COUNT(*) FROM downloads`).Scan(&left)
	if left != 2 {
		t.Fatalf("rows left=%d", left)
	}
	if code, stats := h.call(http.MethodGet, "/api/maintenance/nsfw/blocklist/stats", nil); code != 200 || stats["count"] != 2.0 {
		t.Fatalf("blocklist %d %v", code, stats)
	}
	if code, st := h.call(http.MethodGet, "/api/maintenance/nsfw/v2/bulk/status", nil); code != 200 || st["running"] != false || st["successes"] != 4.0 {
		t.Fatalf("bulk status %d %v", code, st)
	}

	// A re-download of a blocklisted file is removed by the auto-scan hook.
	h.addFile(9, "photo", "again.jpg", "data", "hash1")
	h.a.queueNSFW(9, "-1_9")
	ev := waitEvent(t, client.Events(), "nsfw_blocklist_deleted").Payload.(map[string]any)
	if ev["id"] != int64(9) || ev["key"] != "-1_9" {
		t.Fatalf("blocklist event=%v", ev)
	}
	if err := h.a.db.Writer.QueryRow(`SELECT COUNT(*) FROM downloads WHERE id = 9`).Scan(&left); err != nil || left != 0 {
		t.Fatalf("blocklisted row still present (%d, %v)", left, err)
	}

	if code, _ := h.call(http.MethodDelete, "/api/maintenance/nsfw/blocklist", map[string]any{}); code != http.StatusBadRequest {
		t.Fatalf("clear without confirm = %d", code)
	}
	if code, res := h.call(http.MethodDelete, "/api/maintenance/nsfw/blocklist", map[string]any{"confirm": true}); code != 200 || res["removed"] != 2.0 {
		t.Fatalf("clear %d %v", code, res)
	}
}

func TestNSFWAutoScanScoresNewDownloads(t *testing.T) {
	fake := &nsfwFakeSidecar{}
	srv := httptest.NewServer(fake)
	defer srv.Close()
	h := newNSFWHarness(t, map[string]any{"enabled": true, "sidecarUrl": srv.URL})
	h.addFile(1, "photo", "new.jpg", "nsfw", "")
	h.a.queueNSFW(1, "-1_1")
	deadline := time.Now().Add(10 * time.Second)
	for {
		if s, c := h.score(1); c.Valid {
			if s.Float64 != 0.95 {
				t.Fatalf("score=%v", s)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("auto-scan did not score the new download")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestNSFWQueueNeverBlocks(t *testing.T) {
	h := newNSFWHarness(t, map[string]any{})
	var wg sync.WaitGroup
	start := time.Now()
	for i := int64(1); i <= 1000; i++ {
		wg.Add(1)
		go func(id int64) { defer wg.Done(); h.a.queueNSFW(id, "") }(i)
	}
	wg.Wait()
	if time.Since(start) > 5*time.Second {
		t.Fatal("queueNSFW blocked the caller")
	}
}

func TestNSFWSidecarTestUsesSavedToken(t *testing.T) {
	var gotToken atomic.Value
	gotToken.Store("")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/health" {
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "model": "m", "device": "cpu", "features": []string{"upload"}, "auth_required": true, "path_mode": false})
			return
		}
		gotToken.Store(r.Header.Get("X-API-Token"))
		if r.Header.Get("X-API-Token") != "s3cret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer srv.Close()
	h := newNSFWHarness(t, map[string]any{"sidecarUrl": srv.URL, "apiToken": "s3cret"})
	code, res := h.call(http.MethodPost, "/api/maintenance/nsfw/sidecar-test", map[string]any{"url": srv.URL + "/"})
	if code != 200 || res["ok"] != true || res["auth"] != "ok" || res["transfer"] != "upload" || res["pathMode"] != false || res["tokenSent"] != true {
		t.Fatalf("probe %d %v", code, res)
	}
	code, res = h.call(http.MethodPost, "/api/maintenance/nsfw/sidecar-test", map[string]any{"url": srv.URL, "token": "wrong"})
	if code != 200 || res["ok"] != false || res["error"] != "token_rejected" || gotToken.Load() != "wrong" {
		t.Fatalf("bad token probe %d %v", code, res)
	}
	if code, res := h.call(http.MethodPost, "/api/maintenance/nsfw/sidecar-test", map[string]any{"url": "file:///etc"}); code != http.StatusBadRequest || res["error"] != "invalid_scheme" {
		t.Fatalf("scheme %d %v", code, res)
	}
	code, model := h.call(http.MethodGet, "/api/maintenance/nsfw/model-status", nil)
	if code != 200 || model["state"] != "ready" || model["ready"] != true {
		t.Fatalf("model-status %d %v", code, model)
	}
}

func TestNSFWScanScoresVideosFromSeekbarSprites(t *testing.T) {
	fake := &nsfwFakeSidecar{}
	srv := httptest.NewServer(fake)
	defer srv.Close()
	h := newNSFWHarness(t, map[string]any{"enabled": true, "sidecarUrl": srv.URL, "fileTypes": []any{"video"}, "videoMaxTiles": 4.0})
	h.addFile(1, "video", "with-sprite.mp4", "v", "")
	h.addFile(2, "video", "no-sprite.mp4", "v", "")
	dir := filepath.Join(h.data, "seekbar")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	sheet := image.NewRGBA(image.Rect(0, 0, 80, 40))
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, sheet, nil); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "1.jpg"), buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "1.json"), []byte(`{"cols":4,"rows":2,"tile_w":20,"tile_h":20,"frames":8}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := h.a.db.Writer.Exec(`INSERT INTO seekbar_sprites(download_id, sprite_path, meta_path, format, generated_at) VALUES (1, '1.jpg', '1.json', 'jpeg', 1)`); err != nil {
		t.Fatal(err)
	}
	client := h.a.hub.Add("admin")
	defer h.a.hub.Remove(client)
	if code, _ := h.call(http.MethodPost, "/api/maintenance/nsfw/scan", map[string]any{}); code != 200 {
		t.Fatalf("scan %d", code)
	}
	done := waitEvent(t, client.Events(), "nsfw_done").Payload.(nsfwScanState)
	if done.Error != nil || done.Scanned != 1 {
		t.Fatalf("done=%+v", done)
	}
	if s, c := h.score(1); !c.Valid || s.Float64 < 0.099 || s.Float64 > 0.101 {
		t.Fatalf("video score=%v checked=%v", s, c)
	}
	if got := fake.uploads.Load(); got != 4 {
		t.Fatalf("tiles classified=%d want 4", got)
	}
	if _, c := h.score(2); c.Valid {
		t.Fatal("a video without a sprite stays unchecked for a later scan")
	}
}
