package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

// fakeFaces is an httptest stand-in for faces-service/tgdl_faces/app.py.
// A file's content names its person: "a…" and "b…" are two people, any
// other content has no face.
type fakeFaces struct {
	token     string
	noPaths   bool          // answer file_not_found in path mode (no shared mount)
	block     chan struct{} // when set, /detect/batch waits on it or the client
	batches   atomic.Int64
	uploads   atomic.Int64
	srv       *httptest.Server
	rejectTok atomic.Int64
}

func newFakeFaces(t *testing.T, configure func(*fakeFaces)) *fakeFaces {
	f := &fakeFaces{}
	if configure != nil {
		configure(f)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "ready": true, "version": "0.5.1", "model": "buffalo_l", "providers": []string{"CPUExecutionProvider"}, "features": []string{"path", "b64", "video", "auth", "upload"}, "max_upload_bytes": 64 << 20})
	})
	mux.HandleFunc("POST /detect/batch", func(w http.ResponseWriter, r *http.Request) {
		f.batches.Add(1)
		if f.block != nil {
			select {
			case <-f.block:
			case <-r.Context().Done():
				return
			}
		}
		var body struct {
			Files    []string `json:"files"`
			MinScore float64  `json:"min_score"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		results := []map[string]any{}
		for _, file := range body.Files {
			if f.noPaths {
				results = append(results, map[string]any{"file": file, "faces": []any{}, "error": "file_not_found"})
				continue
			}
			data, err := os.ReadFile(file)
			if err != nil {
				results = append(results, map[string]any{"file": file, "faces": []any{}, "error": "file_not_found"})
				continue
			}
			results = append(results, map[string]any{"file": file, "faces": fakeFacesFor(string(data)), "exif_oriented": true})
		}
		writeJSON(w, 200, map[string]any{"results": results, "total_files": len(results)})
	})
	mux.HandleFunc("POST /detect/upload", func(w http.ResponseWriter, r *http.Request) {
		f.uploads.Add(1)
		data, _ := io.ReadAll(r.Body)
		if r.URL.Query().Get("min_score") == "" {
			http.Error(w, "missing thresholds", 400)
			return
		}
		writeJSON(w, 200, map[string]any{"faces": fakeFacesFor(string(data)), "exif_oriented": true})
	})
	mux.HandleFunc("GET /providers", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]any{"available": []string{"CPUExecutionProvider"}, "details": []any{map[string]any{"name": "CPUExecutionProvider", "verified": true}}, "recommended": "CPUExecutionProvider"})
	})
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if f.token != "" && r.URL.Path != "/health" && r.Header.Get("X-API-Token") != f.token {
			f.rejectTok.Add(1)
			writeJSON(w, 401, map[string]any{"error": "missing or invalid API token", "code": "unauthorized"})
			return
		}
		mux.ServeHTTP(w, r)
	}))
	t.Cleanup(func() {
		if f.block != nil {
			select {
			case <-f.block:
			default:
				close(f.block)
			}
		}
		f.srv.Close()
	})
	return f
}

func fakeEmbedding(axis int, jitter float64) []float32 {
	v := make([]float32, 512)
	v[axis] = 1
	v[10] = float32(jitter)
	return v
}

func fakeFacesFor(content string) []map[string]any {
	var axis int
	switch {
	case strings.HasPrefix(content, "a"):
		axis = 0
	case strings.HasPrefix(content, "b"):
		axis = 1
	default:
		return []map[string]any{}
	}
	jitter := float64(len(content)) / 100
	return []map[string]any{{"x": 10, "y": 20, "w": 120, "h": 130, "score": 0.93, "quality_score": 0.8, "embedding": fakeEmbedding(axis, jitter)}}
}

type facesFixture struct {
	t     *testing.T
	a     *App
	token string
	ids   map[string]int64
}

func newFacesFixture(t *testing.T, ai map[string]any) *facesFixture {
	t.Helper()
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Close() })
	cfg, err := a.config.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ensureMap(cfg, "advanced")["ai"] = ai
	if err := a.config.Save(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	return &facesFixture{t: t, a: a, token: token, ids: map[string]int64{}}
}

func (f *facesFixture) addPhoto(name, content string) int64 {
	f.t.Helper()
	rel := "chat/images/" + name
	abs := filepath.Join(f.a.downloadsDir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		f.t.Fatal(err)
	}
	res, err := f.a.db.Writer.Exec(`INSERT INTO downloads(group_id, message_id, file_name, file_type, file_path) VALUES ('-100', ?, ?, 'photo', ?)`, len(f.ids)+1, name, rel)
	if err != nil {
		f.t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	f.ids[name] = id
	return id
}

func (f *facesFixture) do(method, path string, body any) (*httptest.ResponseRecorder, map[string]any) {
	f.t.Helper()
	var reader io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, reader)
	req.AddCookie(&http.Cookie{Name: f.a.sessions.CookieName(), Value: f.token})
	rec := httptest.NewRecorder()
	f.a.Handler().ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec, out
}

// waitDone waits for the <prefix>_done event and returns its payload.
func waitDone(t *testing.T, client *ws.Client, kind string) map[string]any {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case event := <-client.Events():
			if event.Type == kind {
				payload, _ := event.Payload.(map[string]any)
				return payload
			}
		case <-deadline:
			t.Fatalf("no %s event", kind)
		}
	}
}

func (f *facesFixture) count(query string, args ...any) int {
	f.t.Helper()
	var n int
	if err := f.a.db.Writer.QueryRow(query, args...).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

func TestFacesScanStoresFacesClustersAndKeepsLabels(t *testing.T) {
	side := newFakeFaces(t, func(f *fakeFaces) { f.token = "s3cret" })
	fx := newFacesFixture(t, map[string]any{"enabled": true, "faces": map[string]any{"sidecarUrl": side.srv.URL + "/", "sidecarToken": "s3cret", "cpuThrottleRatio": 0.0}})
	for name, content := range map[string]string{"a1.jpg": "a1", "a2.jpg": "a22", "a3.jpg": "a333", "b1.jpg": "b1", "b2.jpg": "b22", "empty.jpg": "landscape"} {
		fx.addPhoto(name, content)
	}
	client := fx.a.hub.Add("admin")
	defer fx.a.hub.Remove(client)

	if rec, body := fx.do("POST", "/api/ai/scan/start", map[string]any{"feature": "faces"}); rec.Code != 200 || body["started"] != true {
		t.Fatalf("scan/start=%d %s", rec.Code, rec.Body.String())
	}
	done := waitDone(t, client, "ai_people_done")
	if done["error"] != nil || done["peopleCount"] != float64(2) && done["peopleCount"] != 2 {
		t.Fatalf("done=%v", done)
	}
	if n := fx.count(`SELECT COUNT(*) FROM faces WHERE length(embedding) = 2048 AND quality_score = 0.8 AND exif_oriented = 1 AND person_id IS NOT NULL`); n != 5 {
		t.Fatalf("stored faces=%d", n)
	}
	if n := fx.count(`SELECT COUNT(*) FROM downloads WHERE ai_indexed_at IS NULL`); n != 0 {
		t.Fatalf("unstamped rows=%d", n)
	}
	if n := fx.count(`SELECT COUNT(*) FROM people WHERE face_count IN (2, 3) AND length(embedding_centroid) = 2048`); n != 2 {
		t.Fatalf("people=%d", n)
	}
	var alice int64
	if err := fx.a.db.Writer.QueryRow(`SELECT person_id FROM faces WHERE download_id = ?`, fx.ids["a1.jpg"]).Scan(&alice); err != nil {
		t.Fatal(err)
	}
	if n := fx.count(`SELECT COUNT(DISTINCT person_id) FROM faces WHERE download_id IN (?, ?, ?)`, fx.ids["a1.jpg"], fx.ids["a2.jpg"], fx.ids["a3.jpg"]); n != 1 {
		t.Fatalf("person A split over %d clusters", n)
	}

	// A name survives re-clustering: the new cluster closest to the named
	// centroid inherits it.
	if rec, _ := fx.do("PATCH", "/api/ai/people/"+strconv.FormatInt(alice, 10), map[string]any{"label": "Alice"}); rec.Code != 200 {
		t.Fatalf("rename=%d %s", rec.Code, rec.Body.String())
	}
	if rec, _ := fx.do("POST", "/api/ai/faces/recluster", map[string]any{}); rec.Code != 200 {
		t.Fatalf("recluster=%d %s", rec.Code, rec.Body.String())
	}
	waitDone(t, client, "ai_people_done")
	var label string
	if err := fx.a.db.Writer.QueryRow(`SELECT p.label FROM faces f JOIN people p ON p.id = f.person_id WHERE f.download_id = ?`, fx.ids["a2.jpg"]).Scan(&label); err != nil || label != "Alice" {
		t.Fatalf("label after recluster=%q err=%v", label, err)
	}
	if n := fx.count(`SELECT COUNT(*) FROM people WHERE id <= ?`, alice); n != 0 {
		t.Fatalf("previous people generation kept: %d", n)
	}
	if side.rejectTok.Load() != 0 {
		t.Fatal("sidecar token was not sent")
	}

	rec, status := fx.do("GET", "/api/ai/status", nil)
	if rec.Code != 200 || status["success"] != true {
		t.Fatalf("status=%d %s", rec.Code, rec.Body.String())
	}
	faces := status["models"].(map[string]any)["faces"].(map[string]any)
	scan := status["scans"].(map[string]any)["faces"].(map[string]any)
	cfg := status["config"].(map[string]any)
	if faces["state"] != "healthy" || faces["mode"] != "external" || faces["loaded"] != true || faces["version"] != "0.5.1" {
		t.Fatalf("models.faces=%v", faces)
	}
	if scan["running"] != false || scan["finishedAt"] == nil || scan["peopleCount"] != float64(2) {
		t.Fatalf("scans.faces=%v", scan)
	}
	if cfg["enabled"] != true || cfg["faces"].(map[string]any)["sidecarTokenSet"] != true {
		t.Fatalf("config=%v", cfg)
	}
	if _, ok := status["trackers"].(map[string]any)["aiPeople"].(map[string]any)["successes"]; !ok {
		t.Fatalf("trackers=%v", status["trackers"])
	}
	if counts := status["counts"].(map[string]any); counts["indexed"] != float64(6) || counts["peopleCount"] != float64(2) {
		t.Fatalf("counts=%v", counts)
	}
	if rec, body := fx.do("GET", "/api/ai/doctor", nil); rec.Code != 200 || len(body["checks"].([]any)) != 4 {
		t.Fatalf("doctor=%d %s", rec.Code, rec.Body.String())
	}
	if rec, body := fx.do("GET", "/api/ai/faces/provider-probe", nil); rec.Code != 200 || body["recommended"] != "CPUExecutionProvider" {
		t.Fatalf("provider-probe=%d %s", rec.Code, rec.Body.String())
	}
	if rec, body := fx.do("POST", "/api/ai/faces/health-test", map[string]any{"url": side.srv.URL}); rec.Code != 200 || body["ok"] != true || body["auth"] != "ok" || body["transfer"] != "upload" {
		t.Fatalf("health-test=%d %s", rec.Code, rec.Body.String())
	}
	if rec, body := fx.do("POST", "/api/ai/detect-test", map[string]any{"downloadId": fx.ids["b1.jpg"]}); rec.Code != 200 || body["rawCount"] != float64(1) {
		t.Fatalf("detect-test=%d %s", rec.Code, rec.Body.String())
	}
}

func TestFacesExternalSidecarWithoutSharedFilesUploadsBytes(t *testing.T) {
	side := newFakeFaces(t, func(f *fakeFaces) { f.noPaths = true })
	fx := newFacesFixture(t, map[string]any{"enabled": true, "faces": map[string]any{"sidecarUrl": side.srv.URL, "cpuThrottleRatio": 0.0}})
	fx.addPhoto("a1.jpg", "a1")
	fx.addPhoto("a2.jpg", "a22")
	client := fx.a.hub.Add("admin")
	defer fx.a.hub.Remove(client)
	if rec, _ := fx.do("POST", "/api/ai/scan/start", map[string]any{"feature": "faces"}); rec.Code != 200 {
		t.Fatalf("scan/start=%d %s", rec.Code, rec.Body.String())
	}
	if done := waitDone(t, client, "ai_people_done"); done["error"] != nil {
		t.Fatalf("done=%v", done)
	}
	if n := fx.count(`SELECT COUNT(*) FROM faces`); n != 2 {
		t.Fatalf("faces=%d", n)
	}
	if side.uploads.Load() != 2 || !fx.a.faces.client.isBytesMode() {
		t.Fatalf("uploads=%d bytesMode=%v", side.uploads.Load(), fx.a.faces.client.isBytesMode())
	}
}

func TestFacesScanCancelStopsWithoutStamping(t *testing.T) {
	side := newFakeFaces(t, func(f *fakeFaces) { f.block = make(chan struct{}) })
	fx := newFacesFixture(t, map[string]any{"enabled": true, "faces": map[string]any{"sidecarUrl": side.srv.URL, "batchSize": 2}})
	for i := 0; i < 6; i++ {
		fx.addPhoto("a"+strconv.Itoa(i)+".jpg", "a")
	}
	client := fx.a.hub.Add("admin")
	defer fx.a.hub.Remove(client)
	if rec, _ := fx.do("POST", "/api/ai/scan/start", map[string]any{"feature": "faces"}); rec.Code != 200 {
		t.Fatalf("scan/start=%d %s", rec.Code, rec.Body.String())
	}
	deadline := time.Now().Add(5 * time.Second)
	for side.batches.Load() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("scan never reached the sidecar")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if rec, _ := fx.do("POST", "/api/ai/scan/start", map[string]any{"feature": "faces"}); rec.Code != http.StatusConflict {
		t.Fatalf("second start=%d", rec.Code)
	}
	if rec, body := fx.do("POST", "/api/ai/scan/cancel", map[string]any{"feature": "faces"}); rec.Code != 200 || body["cancelled"] != true {
		t.Fatalf("cancel=%d %s", rec.Code, rec.Body.String())
	}
	waitDone(t, client, "ai_people_done")
	if n := fx.count(`SELECT COUNT(*) FROM downloads WHERE ai_indexed_at IS NULL`); n != 6 {
		t.Fatalf("cancelled scan stamped rows: %d left", n)
	}
	if fx.a.faces.scanRunning() {
		t.Fatal("scan still running after cancel")
	}
	if rec, body := fx.do("POST", "/api/ai/scan/cancel", map[string]any{"feature": "faces"}); rec.Code != 200 || body["cancelled"] != false {
		t.Fatalf("idle cancel=%d %s", rec.Code, rec.Body.String())
	}
}

func TestFacesWithoutSidecarIsAClearErrorAndReclusterStillWorks(t *testing.T) {
	fx := newFacesFixture(t, map[string]any{"enabled": true})
	rec, body := fx.do("POST", "/api/ai/scan/start", map[string]any{"feature": "faces"})
	if rec.Code != http.StatusServiceUnavailable || body["code"] != "SIDECAR_NOT_CONFIGURED" || !strings.Contains(toString(body["error"]), "External sidecar") {
		t.Fatalf("scan/start without sidecar=%d %s", rec.Code, rec.Body.String())
	}
	_, status := fx.do("GET", "/api/ai/status", nil)
	faces := status["models"].(map[string]any)["faces"].(map[string]any)
	if faces["state"] != "idle" || faces["mode"] != "local" || faces["loaded"] != false {
		t.Fatalf("models.faces=%v", faces)
	}
	if rec, body := fx.do("GET", "/api/ai/faces/provider-probe", nil); rec.Code != http.StatusServiceUnavailable || body["code"] != "SIDECAR_OFFLINE" {
		t.Fatalf("provider-probe=%d %s", rec.Code, rec.Body.String())
	}
	if rec, body := fx.do("POST", "/api/ai/faces/install-deps", map[string]any{}); rec.Code != 200 || body["started"] != false || body["code"] != "NOT_APPLICABLE" {
		t.Fatalf("install-deps=%d %s", rec.Code, rec.Body.String())
	}
	if rec, body := fx.do("POST", "/api/ai/faces/restart", map[string]any{}); rec.Code != 200 || body["available"] != false {
		t.Fatalf("restart=%d %s", rec.Code, rec.Body.String())
	}
	if rec, _ := fx.do("POST", "/api/ai/search", map[string]any{"q": "cat"}); rec.Code != http.StatusNotImplemented {
		t.Fatalf("search=%d", rec.Code)
	}

	// Faces stored by 2.x cluster without any sidecar.
	id := fx.addPhoto("old.jpg", "")
	for i, axis := range []int{0, 0, 1, 1, 1, 7} {
		if _, err := fx.a.db.Writer.Exec(`INSERT INTO faces(download_id, x, y, w, h, embedding, quality_score) VALUES (?, 0, 0, 90, 90, ?, NULL)`, id, embeddingBlob(fakeEmbedding(axis, float64(i)/100))); err != nil {
			t.Fatal(err)
		}
	}
	client := fx.a.hub.Add("admin")
	defer fx.a.hub.Remove(client)
	if rec, _ := fx.do("POST", "/api/ai/faces/recluster", map[string]any{}); rec.Code != 200 {
		t.Fatalf("recluster=%d %s", rec.Code, rec.Body.String())
	}
	if done := waitDone(t, client, "ai_people_done"); done["error"] != nil || done["noiseFaces"] != 1 && done["noiseFaces"] != float64(1) {
		t.Fatalf("done=%v", done)
	}
	if n := fx.count(`SELECT COUNT(*) FROM people`); n != 2 {
		t.Fatalf("people=%d", n)
	}
	if n := fx.count(`SELECT COUNT(*) FROM faces WHERE person_id IS NULL`); n != 1 {
		t.Fatalf("noise faces=%d", n)
	}
	if n := fx.count(`SELECT face_count FROM people ORDER BY id LIMIT 1`); n != 3 {
		t.Fatalf("largest cluster first, got face_count=%d", n)
	}
}

func TestFacesUnreachableSidecarLeavesRowsQueued(t *testing.T) {
	dead := httptest.NewServer(http.NotFoundHandler())
	url := dead.URL
	dead.Close()
	fx := newFacesFixture(t, map[string]any{"enabled": true, "faces": map[string]any{"sidecarUrl": url, "sidecarWaitMs": 0.0}})
	fx.addPhoto("a1.jpg", "a1")
	client := fx.a.hub.Add("admin")
	defer fx.a.hub.Remove(client)
	if rec, _ := fx.do("POST", "/api/ai/scan/start", map[string]any{"feature": "faces"}); rec.Code != 200 {
		t.Fatalf("scan/start=%d %s", rec.Code, rec.Body.String())
	}
	done := waitDone(t, client, "ai_people_done")
	if !strings.Contains(toString(done["error"]), "face sidecar unavailable") {
		t.Fatalf("done=%v", done)
	}
	if n := fx.count(`SELECT COUNT(*) FROM downloads WHERE ai_indexed_at IS NULL`); n != 1 {
		t.Fatal("row stamped while the sidecar was down")
	}
	_, status := fx.do("GET", "/api/ai/status", nil)
	if state := status["models"].(map[string]any)["faces"].(map[string]any)["state"]; state != "failed" {
		t.Fatalf("state=%v", state)
	}
}

func TestFacesBackgroundQueueDetectsNewDownloads(t *testing.T) {
	side := newFakeFaces(t, nil)
	fx := newFacesFixture(t, map[string]any{"enabled": true, "faces": map[string]any{"sidecarUrl": side.srv.URL}})
	id := fx.addPhoto("b1.jpg", "b1")
	none := fx.addPhoto("n.jpg", "nothing")
	fx.a.faces.enqueue(id, true)
	fx.a.faces.enqueue(none, false)
	deadline := time.Now().Add(5 * time.Second)
	for fx.count(`SELECT COUNT(*) FROM downloads WHERE ai_indexed_at IS NULL`) != 0 {
		if time.Now().After(deadline) {
			t.Fatal("queued downloads were not scanned")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if n := fx.count(`SELECT COUNT(*) FROM faces WHERE download_id = ?`, id); n != 1 {
		t.Fatalf("faces=%d", n)
	}
}

func TestFacesPathMapAndSettings(t *testing.T) {
	rules := parseFacesPathMap("/app/data/downloads=/media\n# comment; C:\\dl => /win ;/app/data=/data")
	for in, want := range map[string]string{
		"/app/data/downloads/chat/a.jpg": "/media/chat/a.jpg",
		"/app/data/other/b.jpg":          "/data/other/b.jpg",
		`c:\dl\x.jpg`:                    "/win/x.jpg",
		"/elsewhere/c.jpg":               "/elsewhere/c.jpg",
	} {
		if got := toSidecarPath(in, rules); got != want {
			t.Errorf("toSidecarPath(%q)=%q want %q", in, got, want)
		}
	}
	env := map[string]string{"FACES_SERVICE_URL": "http://tgdl-faces:8011/", "TGDL_FACES_SIDECAR_TOKEN": "tok"}
	s := resolveFacesSettings(effectiveConfig(map[string]any{"advanced": map[string]any{"ai": map[string]any{"enabled": true, "faces": map[string]any{"epsilon": 0.9, "sidecarMaxConcurrency": 2.0}}}}), func(k string) string { return env[k] })
	if s.URL != "http://tgdl-faces:8011" || s.Mode != "docker" || s.Token != "tok" || s.Epsilon != 0.9 || s.MinPoints != 2 || s.MaxConcurrency != 2 || s.MinBoxPx != 80 || s.BatchSize != 16 {
		t.Fatalf("settings=%+v", s)
	}
	if s.LabelMatchEps < 0.2 || s.LabelMatchEps > 0.6 {
		t.Fatalf("labelMatchEps=%v", s.LabelMatchEps)
	}
}
