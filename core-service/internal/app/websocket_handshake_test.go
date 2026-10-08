package app

import (
	"bufio"
	"bytes"
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
	"github.com/gorilla/websocket"
)

type handshakeBarrier struct {
	net.Conn
	written chan struct{}
	release <-chan struct{}
}

func (c handshakeBarrier) Write(p []byte) (int, error) {
	n, err := c.Conn.Write(p)
	if err == nil && bytes.HasPrefix(p, []byte("HTTP/1.1 101")) {
		close(c.written)
		<-c.release
	}
	return n, err
}

type barrierHijacker struct {
	http.ResponseWriter
	written chan struct{}
	release <-chan struct{}
}

func (w barrierHijacker) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	c, r, err := w.ResponseWriter.(http.Hijacker).Hijack()
	if err != nil {
		return nil, nil, err
	}
	return handshakeBarrier{Conn: c, written: w.written, release: w.release}, r, nil
}

func TestWebSocketReceivesEventsBeforeUpgradeReturns(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	written, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	defer unblock()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a.handleWebSocket(barrierHijacker{ResponseWriter: w, written: written, release: release}, r)
	}))
	defer srv.Close()
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	conn, _, err := websocket.DefaultDialer.Dial("ws"+srv.URL[len("http"):]+"/", http.Header{"Cookie": []string{a.sessions.CookieName() + "=" + token}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	select {
	case <-written:
	case <-time.After(time.Second):
		t.Fatal("handshake did not write")
	}
	// This is the same interval in which a browser's first HTTP mutation can
	// complete. No arbitrary scheduling delay is needed to reproduce it.
	a.hub.Broadcast(ws.Event{Type: "history_deleted", Flat: true, Payload: map[string]any{"jobId": "first"}})
	unblock()
	if err = conn.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	var event map[string]any
	if err = conn.ReadJSON(&event); err != nil {
		t.Fatalf("first event lost: %v", err)
	}
	if event["type"] != "history_deleted" || event["jobId"] != "first" {
		t.Fatal(event)
	}
}

func TestFailedWebSocketUpgradeRemovesSubscription(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "/", nil)
	r.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	a.handleWebSocket(httptest.NewRecorder(), r)
	if a.hub.Count() != 0 {
		t.Fatal("failed upgrade leaked an event subscription")
	}
}
