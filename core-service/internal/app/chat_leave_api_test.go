package app

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/tg"
)

type leaveFixtureAccount struct {
	fixtureAccount
	calls atomic.Int64
	err   error
}

func (a *leaveFixtureAccount) RemoveDialog(ctx context.Context, id string) error {
	a.calls.Add(1)
	if id != "-1000000000042" {
		return errors.New("wrong chat")
	}
	return a.err
}

func TestChatLeaveRequiresChosenAccountAndConfirmation(t *testing.T) {
	account := &leaveFixtureAccount{}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: func(_ engine.AccountConfig, _ *telegram.UpdateState, handler func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		account.handle = handler
		return account, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureMonitor(t, a)
	path := filepath.Join(a.dataDir, "downloads", "kept.bin")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("keep media"), 0600); err != nil {
		t.Fatal(err)
	}
	request := func(role, body string) *httptest.ResponseRecorder {
		t.Helper()
		token, err := a.sessions.Create(context.Background(), role)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(http.MethodPost, "/api/chats/-1000000000042/leave", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, r)
		return w
	}
	for _, tc := range []struct {
		role, body string
		code       int
	}{
		{"guest", `{"accountId":"one","confirm":"-1000000000042"}`, 403},
		{"admin", `{"accountId":"one"}`, 400},
		{"admin", `{"confirm":"-1000000000042"}`, 400},
		{"admin", `{"accountId":"missing","confirm":"-1000000000042"}`, 409},
	} {
		if w := request(tc.role, tc.body); w.Code != tc.code {
			t.Fatalf("guard=%d want=%d %s", w.Code, tc.code, w.Body.String())
		}
	}
	if account.calls.Load() != 0 {
		t.Fatal("guard made destructive call")
	}
	account.err = errors.New("CHANNEL_PRIVATE")
	if w := request("admin", `{"accountId":"one","confirm":"-1000000000042"}`); w.Code != 502 {
		t.Fatalf("remote failure=%d %s", w.Code, w.Body.String())
	}
	cfg, err := a.config.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(configuredGroupList(cfg)) != 1 {
		t.Fatal("failed remote operation removed local configuration")
	}
	account.err = nil
	if w := request("admin", `{"accountId":"one","confirm":"-1000000000042"}`); w.Code != 200 {
		t.Fatalf("leave=%d %s", w.Code, w.Body.String())
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "keep media" {
		t.Fatalf("local media changed: %v", err)
	}
	if account.calls.Load() != 2 {
		t.Fatalf("calls=%d", account.calls.Load())
	}
	cfg, err = a.config.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(configuredGroupList(cfg)) != 0 {
		t.Fatal("sole account's removed chat still clutters configured list")
	}
}
