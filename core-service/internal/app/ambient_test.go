package app

import (
	"context"
	"encoding/json"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

func TestAmbientMonitorUsesHTTPProjectionAndStatsAreLive(t *testing.T) {
	a, srv := socketTestApp(t)
	token := socketToken(t, a, "admin", time.Hour)
	conn := socketDial(t, a, srv, token)
	guest := socketDial(t, a, srv, socketToken(t, a, "guest", time.Hour))
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	var event struct {
		Type    string
		Payload map[string]any
	}
	if err := conn.ReadJSON(&event); err != nil {
		t.Fatal(err)
	}
	if event.Type != "monitor_status_push" {
		t.Fatal(event.Type)
	}
	req, _ := http.NewRequest("GET", srv.URL+"/api/monitor/status", nil)
	req.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	res, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var actual map[string]any
	if err = json.NewDecoder(res.Body).Decode(&actual); err != nil {
		t.Fatal(err)
	}
	want, _ := json.Marshal(actual)
	got, _ := json.Marshal(event.Payload)
	if string(want) != string(got) {
		t.Fatalf("HTTP %s != WS %s", want, got)
	}
	requireSocketEvent(t, guest, "monitor_status_push")
	rescueInsert(t, a, 1, "one.bin", nil, nil, 0)
	if err = a.pushStats(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err = conn.ReadJSON(&event); err != nil {
		t.Fatal(err)
	}
	if event.Type != "stats_push" || event.Payload["totalFiles"] != float64(1) || event.Payload["totalSize"] != float64(4) {
		t.Fatal(event)
	}
	requireSocketEvent(t, guest, "stats_push")
}

func TestAmbientNoSubscribersNoQueriesAndSlowPushDoesNotOverlap(t *testing.T) {
	a, _ := socketTestApp(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	entered := make(chan struct{})
	var calls atomic.Int64
	go func() {
		defer close(done)
		a.runPushes(ctx, 5*time.Millisecond, func(ctx context.Context) error { calls.Add(1); close(entered); <-ctx.Done(); return ctx.Err() })
	}()
	time.Sleep(30 * time.Millisecond)
	if calls.Load() != 0 {
		t.Fatal("idle loop built a snapshot")
	}
	client := a.hub.Add("admin")
	defer a.hub.Remove(client)
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("no push for subscriber")
	}
	time.Sleep(30 * time.Millisecond)
	if calls.Load() != 1 {
		t.Fatal("overlapping snapshot builds")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("push loop did not join")
	}
}

func TestAmbientQueryFailureDoesNotPublishInventedCounters(t *testing.T) {
	a, _ := socketTestApp(t)
	c := a.hub.Add("guest")
	defer a.hub.Remove(c)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := a.pushStats(ctx); err == nil {
		t.Fatal("canceled stats succeeded")
	}
	if err := a.pushMonitorStatus(ctx); err == nil {
		t.Fatal("canceled monitor snapshot succeeded")
	}
	select {
	case event := <-c.Events():
		t.Fatalf("invented state: %+v", event)
	default:
	}
}
