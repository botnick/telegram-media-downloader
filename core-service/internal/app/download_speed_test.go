package app

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/tg"
)

func TestDownloadSpeedConfigControlsActiveQueueAndSurvivesRestart(t *testing.T) {
	made := make(chan *fixtureAccount, 1)
	entered, finished := make(chan struct{}, 1), make(chan struct{}, 1)
	factory := func(_ engine.AccountConfig, _ *telegram.UpdateState, handler func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		account := &fixtureAccount{handle: handler, download: func(_ context.Context, _ telegram.Attachment, w io.Writer) error {
			entered <- struct{}{}
			_, err := w.Write([]byte("live"))
			finished <- struct{}{}
			return err
		}}
		made <- account
		return account, nil
	}
	dir := t.TempDir()
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: dir, AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { a.Close() }()
	configureMonitor(t, a)
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	save := func(value string, want int) {
		t.Helper()
		r := httptest.NewRequest("POST", "/api/config", strings.NewReader(`{"download":{"maxSpeed":`+value+`}}`))
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("save %s: %d %s", value, w.Code, w.Body.String())
		}
	}
	snapshot := func(want any) {
		t.Helper()
		snap, err := a.monitor.Snapshot(context.Background())
		if err != nil || snap["maxSpeed"] != want {
			t.Fatalf("snapshot maxSpeed=%v want=%v err=%v", snap["maxSpeed"], want, err)
		}
	}
	save("1", 200)
	snapshot(int64(1))
	for _, invalid := range []string{"-1", "0.5", "1e30", `"bad"`, "true", "{}"} {
		save(invalid, 400)
		snapshot(int64(1))
	}
	if rec := monitorRequest(t, a, "/api/monitor/start"); rec.Code != 200 {
		t.Fatalf("start=%d %s", rec.Code, rec.Body.String())
	}
	account := <-made
	if err = account.handle(context.Background(), updateFixture()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("queue did not start")
	}
	select {
	case <-finished:
		t.Fatal("configured bandwidth cap was ignored")
	case <-time.After(100 * time.Millisecond):
	}
	save("null", 200)
	snapshot(nil)
	waitCompleted(t, a)
	save("50", 200)
	if rec := monitorRequest(t, a, "/api/monitor/stop"); rec.Code != 200 {
		t.Fatalf("stop=%d %s", rec.Code, rec.Body.String())
	}
	a.Close()
	a, err = New(context.Background(), Config{DataDir: dir, AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	snapshot(int64(50))
	save("0", 200)
	snapshot(nil)
}
