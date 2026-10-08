package app

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/tg"
)

type fixtureAccount struct {
	handle   func(context.Context, tg.UpdatesClass) error
	download mediaTransport
}

func (a *fixtureAccount) Run(ctx context.Context, ready func()) error {
	ready()
	<-ctx.Done()
	return ctx.Err()
}
func (a *fixtureAccount) Fingerprint() string { return "fixture-account-key" }
func (a *fixtureAccount) RefreshMessage(_ context.Context, m *tg.Message) (*telegram.RefreshedMessage, error) {
	return &telegram.RefreshedMessage{Message: m, Entities: &tg.Updates{}}, nil
}
func (a *fixtureAccount) DownloadMedia(ctx context.Context, media telegram.Attachment, w io.Writer) error {
	return a.download(ctx, media, w)
}

func monitorRequest(t *testing.T, a *App, path string) *httptest.ResponseRecorder {
	t.Helper()
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("POST", path, nil)
	req.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	rec := httptest.NewRecorder()
	a.Handler().ServeHTTP(rec, req)
	return rec
}
func configureMonitor(t *testing.T, a *App) {
	t.Helper()
	cfg, err := a.config.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	cfg["telegram"] = map[string]any{"apiId": 123, "apiHash": "fixture"}
	cfg["download"] = map[string]any{"concurrent": 2, "retries": 2}
	cfg["groups"] = []any{map[string]any{"id": "-1000000000042", "name": "Test", "enabled": true}}
	if err = a.config.Save(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(filepath.Join(a.dataDir, "sessions"), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(a.dataDir, "sessions", "one.enc"), []byte("fixture source; fake account factory"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(a.dataDir, "secret.key"), []byte("fixture-secret"), 0600); err != nil {
		t.Fatal(err)
	}
}
func updateFixture() *tg.Updates {
	return &tg.Updates{Updates: []tg.UpdateClass{&tg.UpdateNewChannelMessage{Message: &tg.Message{ID: 10, Date: 100, PeerID: &tg.PeerChannel{ChannelID: 42}, Media: &tg.MessageMediaDocument{Document: &tg.Document{ID: 123, Size: 4, DCID: 2, Attributes: []tg.DocumentAttributeClass{&tg.DocumentAttributeFilename{FileName: "live.bin"}}}}}}}}
}
func waitCompleted(t *testing.T, a *App) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var n int
		if err := a.db.Reader.QueryRow(`SELECT count(*) FROM tgdl_work WHERE status='completed'`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n == 1 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	var status string
	var detail any
	a.db.Reader.QueryRow(`SELECT status,error FROM tgdl_work LIMIT 1`).Scan(&status, &detail)
	t.Fatalf("work did not finish: %s %v", status, detail)
}
func TestMonitorHTTPStartsRealQueueAndDownloadsUpdate(t *testing.T) {
	made := make(chan *fixtureAccount, 2)
	var calls atomic.Int64
	factory := func(_ engine.AccountConfig, _ *telegram.UpdateState, handler func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		account := &fixtureAccount{handle: handler, download: func(_ context.Context, _ telegram.Attachment, w io.Writer) error {
			calls.Add(1)
			_, err := w.Write([]byte("live"))
			return err
		}}
		made <- account
		return account, nil
	}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureMonitor(t, a)
	if rec := monitorRequest(t, a, "/api/monitor/start"); rec.Code != 200 {
		t.Fatalf("start=%d %s", rec.Code, rec.Body.String())
	}
	account := <-made
	if err = account.handle(context.Background(), updateFixture()); err != nil {
		t.Fatal(err)
	}
	waitCompleted(t, a)
	var path string
	if err = a.db.Reader.QueryRow(`SELECT file_path FROM downloads`).Scan(&path); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(a.dataDir, "downloads", path))
	if err != nil || string(data) != "live" {
		t.Fatalf("file=%q err=%v", data, err)
	}
	if rec := monitorRequest(t, a, "/api/monitor/stop"); rec.Code != 200 {
		t.Fatalf("stop=%d %s", rec.Code, rec.Body.String())
	}
	if rec := monitorRequest(t, a, "/api/monitor/start"); rec.Code != 200 {
		t.Fatalf("restart=%d %s", rec.Code, rec.Body.String())
	}
	account = <-made
	if err = account.handle(context.Background(), updateFixture()); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("duplicate transferred %d times", calls.Load())
	}
}

func TestMonitorShutdownPreservesClaimAndAutoStartResumes(t *testing.T) {
	dir := t.TempDir()
	made := make(chan *fixtureAccount, 2)
	entered := make(chan struct{}, 1)
	blocking := func(_ engine.AccountConfig, _ *telegram.UpdateState, handler func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		account := &fixtureAccount{handle: handler, download: func(ctx context.Context, _ telegram.Attachment, w io.Writer) error {
			if _, err := w.Write([]byte("li")); err != nil {
				return err
			}
			entered <- struct{}{}
			<-ctx.Done()
			return ctx.Err()
		}}
		made <- account
		return account, nil
	}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: dir, AccountFactory: blocking})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureMonitor(t, a)
	if rec := monitorRequest(t, a, "/api/monitor/start"); rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	if err = (<-made).handle(context.Background(), updateFixture()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("transfer did not start")
	}
	token, e := a.sessions.Create(context.Background(), "admin")
	if e != nil {
		t.Fatal(e)
	}
	request := httptest.NewRequest("GET", "/api/queue/snapshot", nil)
	request.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	rec := httptest.NewRecorder()
	a.Handler().ServeHTTP(rec, request)
	var snapshot struct {
		Active []struct {
			Received int
			Status   string
		}
	}
	if e = json.Unmarshal(rec.Body.Bytes(), &snapshot); e != nil {
		t.Fatal(e)
	}
	if rec.Code != 200 || len(snapshot.Active) != 1 || snapshot.Active[0].Received != 2 || snapshot.Active[0].Status != "active" {
		t.Fatalf("live queue: %d %s", rec.Code, rec.Body.String())
	}
	for _, secret := range []string{"access_hash", "file_reference", "body", "fixture-secret"} {
		if strings.Contains(rec.Body.String(), secret) {
			t.Fatalf("snapshot leaked %q", secret)
		}
	}
	if err = a.Close(); err != nil {
		t.Fatal(err)
	}
	resumed := func(_ engine.AccountConfig, _ *telegram.UpdateState, handler func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		return &fixtureAccount{handle: handler, download: func(_ context.Context, _ telegram.Attachment, w io.Writer) error {
			_, err := w.Write([]byte("live"))
			return err
		}}, nil
	}
	second, err := New(context.Background(), Config{DataDir: dir, AccountFactory: resumed})
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	waitCompleted(t, second)
}
