package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/gorilla/websocket"
)

func TestNewServesHealthAndStaticWithAuthenticatedWebSocket(t *testing.T) {
	static := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok")}}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), Port: 0, Static: static})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	h := a.Handler()
	health := httptest.NewRecorder()
	h.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/health", nil))
	if health.Code != http.StatusOK {
		t.Fatalf("health status = %d", health.Code)
	}
	page := httptest.NewRecorder()
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	pageReq := httptest.NewRequest(http.MethodGet, "/", nil)
	pageReq.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	h.ServeHTTP(page, pageReq)
	if page.Code != http.StatusOK || page.Body.String() != "ok" {
		t.Fatalf("static response = %d %q", page.Code, page.Body.String())
	}
}

func TestAuthCheckIsAReadyEndpointWithoutSession(t *testing.T) {
	a, err := New(context.Background(), Config{DataDir: t.TempDir(), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	rr := httptest.NewRecorder()
	a.Handler().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/auth_check", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("auth check status = %d", rr.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["authenticated"] != false || body["setupRequired"] != true {
		t.Fatalf("auth check body = %#v", body)
	}
}

func TestWebSocketRequiresSessionAndAnswersPing(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()

	server := httptest.NewServer(a.Handler())
	defer server.Close()
	url := "ws" + server.URL[len("http"):] + "/"
	if _, _, err := websocket.DefaultDialer.Dial(url, nil); err == nil {
		t.Fatal("unauthenticated websocket unexpectedly connected")
	}
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	header := http.Header{"Cookie": []string{a.sessions.CookieName() + "=" + token}}
	conn, _, err := websocket.DefaultDialer.Dial(url, header)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteControl(websocket.PingMessage, []byte("ping"), time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	pong := make(chan struct{}, 1)
	conn.SetPongHandler(func(string) error { pong <- struct{}{}; return nil })
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()
	select {
	case <-pong:
	case <-time.After(time.Second):
		t.Fatal("missing WebSocket pong")
	}
	conn.Close()
	<-readDone
}

func TestReadAPIUsesTheApplicationDatabase(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if _, err := a.db.Writer.Exec(`INSERT INTO downloads (group_id, group_name, message_id, file_size, file_type, file_name, file_path)
		VALUES ('-100', 'Read API', 1, 42, 'photo', 'a.jpg', 'Read API/images/a.jpg')`); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{})
	req := httptest.NewRequest(http.MethodPost, "/v1/db/stats", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	rr := httptest.NewRecorder()
	a.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("read API status = %d body=%s", rr.Code, rr.Body.String())
	}
	var got struct {
		TotalFiles int64 `json:"totalFiles"`
		TotalSize  int64 `json:"totalSize"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.TotalFiles != 1 || got.TotalSize != 42 {
		t.Fatalf("read API stats = %+v", got)
	}
}

func TestReadAPIRequiresSession(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	req := httptest.NewRequest(http.MethodPost, "/v1/db/stats", bytes.NewReader([]byte(`{}`)))
	rr := httptest.NewRecorder()
	a.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated read API status = %d body=%s", rr.Code, rr.Body.String())
	}
}

func TestEveryReadRouteIsSessionGated(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	routes := []string{
		"/v1/db/group-aggregates", "/v1/db/stats", "/v1/db/group-stats", "/v1/db/group-files",
		"/v1/db/group-download-ids", "/v1/db/downloads/all", "/v1/db/downloads/group",
		"/v1/db/downloads/by-ids", "/v1/db/downloads/search", "/v1/db/share-links",
		"/v1/db/update-history", "/v1/db/nsfw-tiers", "/v1/db/nsfw-histogram", "/v1/db/nsfw-list",
		"/v1/db/nsfw-candidates", "/v1/db/people", "/v1/db/thumbs-list", "/v1/db/seekbar-list",
		"/v1/db/faces-by-download", "/v1/db/person-groups", "/v1/db/person-photos",
		"/v1/db/face-embeddings", "/v1/db/ai-counts", "/v1/db/ai-candidates", "/v1/db/ai-pending",
		"/v1/db/quality-candidates", "/v1/db/recovery-stats", "/v1/db/cluster-downloads",
		"/v1/db/cluster-downloads-since", "/v1/db/cluster-search", "/v1/db/telegram-media-candidates",
		"/v1/db/file-hash-candidates", "/v1/db/file-name-candidates", "/v1/db/dedup-stats",
		"/v1/db/seekbar-stats", "/v1/db/seekbar-candidates", "/v1/db/faststart-candidates",
		"/v1/db/faststart-stats", "/v1/db/disk-rotator-candidates", "/v1/db/integrity-candidates",
		"/v1/db/integrity-check", "/v1/db/dedup-candidates", "/v1/db/dedup-groups", "/v1/db/dedup-files",
	}
	for _, path := range routes {
		req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader([]byte(`{}`)))
		rr := httptest.NewRecorder()
		a.Handler().ServeHTTP(rr, req)
		if rr.Code != http.StatusUnauthorized {
			t.Errorf("%s status = %d, want %d", path, rr.Code, http.StatusUnauthorized)
		}
	}
}

func TestAuthSetupLoginAndLogout(t *testing.T) {
	a, err := New(context.Background(), Config{DataDir: t.TempDir(), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	setupBody, _ := json.Marshal(map[string]string{"password": "correct horse"})
	setupReq := httptest.NewRequest(http.MethodPost, "/api/auth/setup", bytes.NewReader(setupBody))
	setupReq.RemoteAddr = "127.0.0.1:1234"
	setup := httptest.NewRecorder()
	a.Handler().ServeHTTP(setup, setupReq)
	if setup.Code != http.StatusOK {
		t.Fatalf("setup status = %d body=%s", setup.Code, setup.Body.String())
	}
	cookie := setup.Result().Cookies()[0]
	check := httptest.NewRequest(http.MethodGet, "/api/auth_check", nil)
	check.AddCookie(cookie)
	checked := httptest.NewRecorder()
	a.Handler().ServeHTTP(checked, check)
	if checked.Code != http.StatusOK || !strings.Contains(checked.Body.String(), `"role":"admin"`) {
		t.Fatalf("auth check = %d %s", checked.Code, checked.Body.String())
	}
	logout := httptest.NewRequest(http.MethodPost, "/api/logout", nil)
	logout.AddCookie(cookie)
	loggedOut := httptest.NewRecorder()
	a.Handler().ServeHTTP(loggedOut, logout)
	if loggedOut.Code != http.StatusOK {
		t.Fatalf("logout status = %d", loggedOut.Code)
	}
	loginBody, _ := json.Marshal(map[string]string{"password": "correct horse"})
	login := httptest.NewRecorder()
	a.Handler().ServeHTTP(login, httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewReader(loginBody)))
	if login.Code != http.StatusOK {
		t.Fatalf("login status = %d body=%s", login.Code, login.Body.String())
	}
}

func TestPinMutationRunsThroughWriterAndBroadcasts(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if _, err := a.db.Writer.Exec(`INSERT INTO downloads(group_id, message_id, file_name, pinned) VALUES ('-1', 1, 'a.jpg', 0)`); err != nil {
		t.Fatal(err)
	}
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	wsClient := a.hub.Add("admin")
	defer a.hub.Remove(wsClient)
	body, _ := json.Marshal(map[string]any{"pinned": true})
	req := httptest.NewRequest(http.MethodPost, "/api/downloads/1/pin", bytes.NewReader(body))
	req.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	rr := httptest.NewRecorder()
	a.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("pin status = %d body=%s", rr.Code, rr.Body.String())
	}
	var pinned int
	if err := a.db.Writer.QueryRow(`SELECT pinned FROM downloads WHERE id=1`).Scan(&pinned); err != nil {
		t.Fatal(err)
	}
	if pinned != 1 {
		t.Fatalf("pinned value = %d", pinned)
	}
	select {
	case event := <-wsClient.Events():
		if event.Type != "download_pinned" {
			t.Fatalf("event type = %q", event.Type)
		}
	default:
		t.Fatal("pin event was not broadcast")
	}
}

func TestGuestCannotPin(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if _, err := a.db.Writer.Exec(`INSERT INTO downloads(group_id, message_id) VALUES ('-1', 1)`); err != nil {
		t.Fatal(err)
	}
	token, err := a.sessions.Create(context.Background(), "guest")
	if err != nil {
		t.Fatal(err)
	}
	body := bytes.NewBufferString(`{"pinned":true}`)
	req := httptest.NewRequest(http.MethodPost, "/api/downloads/1/pin", body)
	req.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	rr := httptest.NewRecorder()
	a.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("guest pin status = %d body=%s", rr.Code, rr.Body.String())
	}
}

func TestJobStatusAndCancelRoutes(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	job, err := a.jobs.Start(context.Background(), "maintenance", 1, func(ctx context.Context, _ func(int, string)) error {
		<-ctx.Done()
		return ctx.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/jobs/"+job.ID, nil)
	req.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	rr := httptest.NewRecorder()
	a.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("job status = %d body=%s", rr.Code, rr.Body.String())
	}
	cancel := httptest.NewRequest(http.MethodPost, "/api/jobs/"+job.ID+"/cancel", nil)
	cancel.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	cr := httptest.NewRecorder()
	a.Handler().ServeHTTP(cr, cancel)
	if cr.Code != http.StatusOK {
		t.Fatalf("job cancel = %d body=%s", cr.Code, cr.Body.String())
	}
	<-job.Done
}

func TestBackupAndPairingRoutes(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	backupReq := httptest.NewRequest(http.MethodPost, "/api/maintenance/db/backup", bytes.NewReader([]byte(`{}`)))
	backupReq.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	backup := httptest.NewRecorder()
	a.Handler().ServeHTTP(backup, backupReq)
	if backup.Code != http.StatusOK {
		t.Fatalf("backup status = %d body=%s", backup.Code, backup.Body.String())
	}
	pairReq := httptest.NewRequest(http.MethodPost, "/api/cluster/pairing-code", bytes.NewReader([]byte(`{}`)))
	pairReq.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	pair := httptest.NewRecorder()
	a.Handler().ServeHTTP(pair, pairReq)
	if pair.Code != http.StatusOK || !strings.Contains(pair.Body.String(), `"code"`) {
		t.Fatalf("pairing status = %d body=%s", pair.Code, pair.Body.String())
	}
}

func TestGalleryReadRoutesAreServedByGo(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if _, err := a.db.Writer.Exec(`INSERT INTO downloads(group_id, group_name, message_id, file_name, file_path, file_size, file_type, created_at)
		VALUES ('-1', 'Gallery', 1, 'photo.jpg', 'Gallery/images/photo.jpg', 12, 'photo', '2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/stats", "/api/downloads", "/api/downloads/all", "/api/downloads/search?q=photo", "/api/groups"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
		rr := httptest.NewRecorder()
		a.Handler().ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Errorf("%s status = %d body=%s", path, rr.Code, rr.Body.String())
		}
	}
	groupReq := httptest.NewRequest(http.MethodGet, "/api/downloads/-1", nil)
	groupReq.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	group := httptest.NewRecorder()
	a.Handler().ServeHTTP(group, groupReq)
	if group.Code != http.StatusOK {
		t.Fatalf("group gallery status = %d body=%s", group.Code, group.Body.String())
	}
}

func TestConfigAndGroupWritesCommitToKV(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	configReq := httptest.NewRequest(http.MethodPost, "/api/config", bytes.NewReader([]byte(`{"groups":[{"id":"-5","name":"New"}]}`)))
	configReq.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	configRR := httptest.NewRecorder()
	a.Handler().ServeHTTP(configRR, configReq)
	if configRR.Code != http.StatusOK {
		t.Fatalf("config status = %d body=%s", configRR.Code, configRR.Body.String())
	}
	groupReq := httptest.NewRequest(http.MethodPut, "/api/groups/-5", bytes.NewReader([]byte(`{"name":"Renamed","enabled":true}`)))
	groupReq.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	groupRR := httptest.NewRecorder()
	a.Handler().ServeHTTP(groupRR, groupReq)
	if groupRR.Code != http.StatusOK {
		t.Fatalf("group status = %d body=%s", groupRR.Code, groupRR.Body.String())
	}
	var raw string
	if err := a.db.Writer.QueryRow(`SELECT value FROM kv WHERE key='config'`).Scan(&raw); err != nil || !strings.Contains(raw, "Renamed") {
		t.Fatalf("stored config = %q err=%v", raw, err)
	}
}

func TestDeleteRoutesUseTransactions(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if _, err := a.db.Writer.Exec(`INSERT INTO downloads(group_id, message_id) VALUES ('-1', 1), ('-1', 2)`); err != nil {
		t.Fatal(err)
	}
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	body := bytes.NewBufferString(`{"ids":[1]}`)
	req := httptest.NewRequest(http.MethodPost, "/api/downloads/bulk-delete", body)
	req.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	rr := httptest.NewRecorder()
	a.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("bulk delete status = %d body=%s", rr.Code, rr.Body.String())
	}
	var count int
	if err := a.db.Writer.QueryRow(`SELECT COUNT(*) FROM downloads`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("remaining rows = %d err=%v", count, err)
	}
}

func TestDeleteRoutesRemoveOnlySafeMediaFiles(t *testing.T) {
	dataDir := t.TempDir()
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: dataDir, Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	media := filepath.Join(dataDir, "downloads", "Gallery", "photo.jpg")
	if err := os.MkdirAll(filepath.Dir(media), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(media, []byte("image"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Writer.Exec(`INSERT INTO downloads(group_id, message_id, file_path) VALUES ('-1', 1, 'Gallery/photo.jpg')`); err != nil {
		t.Fatal(err)
	}
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/downloads/bulk-delete", strings.NewReader(`{"ids":[1]}`))
	req.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	rr := httptest.NewRecorder()
	a.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("delete status = %d body=%s", rr.Code, rr.Body.String())
	}
	if _, err := os.Stat(media); !os.IsNotExist(err) {
		t.Fatalf("media still exists, stat error=%v", err)
	}
}

// Most handler tests exercise an installed dashboard; first-run cases call New directly.
func newConfiguredTestApp(ctx context.Context, cfg Config) (*App, error) {
	a, err := New(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err := a.config.Save(ctx, map[string]any{"web": map[string]any{"password": "test-admin-password", "enabled": true}}); err != nil {
		a.Close()
		return nil, err
	}
	return a, nil
}
