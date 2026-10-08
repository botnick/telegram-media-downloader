package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
	"time"

	"github.com/gorilla/websocket"
)

func TestNewServesHealthAndStaticWithAuthenticatedWebSocket(t *testing.T) {
	static := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok")}}
	a, err := New(context.Background(), Config{DataDir: t.TempDir(), Port: 0, Static: static})
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
	h.ServeHTTP(page, httptest.NewRequest(http.MethodGet, "/", nil))
	if page.Code != http.StatusOK || page.Body.String() != "ok" {
		t.Fatalf("static response = %d %q", page.Code, page.Body.String())
	}
}

func TestWebSocketRequiresSessionAndAnswersPing(t *testing.T) {
	a, err := New(context.Background(), Config{DataDir: t.TempDir(), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()

	server := httptest.NewServer(a.Handler())
	defer server.Close()
	url := "ws" + server.URL[len("http"):] + "/ws"
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
	conn.SetPongHandler(func(string) error { return nil })
	if _, _, err := conn.ReadMessage(); err != nil && !websocket.IsCloseError(err, websocket.CloseNormalClosure) {
		t.Fatalf("websocket did not stay alive after ping: %v", err)
	}
}

func TestReadAPIUsesTheApplicationDatabase(t *testing.T) {
	a, err := New(context.Background(), Config{DataDir: t.TempDir(), Port: 0})
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
	a, err := New(context.Background(), Config{DataDir: t.TempDir(), Port: 0})
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
	a, err := New(context.Background(), Config{DataDir: t.TempDir(), Port: 0})
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
