package app

import (
	"context"
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
