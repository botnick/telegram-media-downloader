package app

import (
	"context"
	"encoding/json"
	"io"
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

func TestProxySettingsReachAllAccountsLoginRestartAndManualJobs(t *testing.T) {
	made := make(chan engine.AccountConfig, 16)
	logins := make(chan telegram.GotdConfig, 2)
	var loginClosed atomic.Bool
	base := urlFactory(func(_ context.Context, _ telegram.Dialog, id int) (*telegram.RefreshedMessage, error) {
		return urlMessage(id), nil
	}, func(context.Context, telegram.Attachment, io.Writer) error { return nil })
	factory := func(c engine.AccountConfig, s *telegram.UpdateState, h func(context.Context, tg.UpdatesClass) error, g func(int64)) (engine.Account, error) {
		made <- c
		return base(c, s, h, g)
	}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory, AccountLoginFactory: func(c telegram.GotdConfig) (telegram.LoginClient, error) {
		logins <- c
		return &httpLoginFixture{cfg: c, closed: &loginClosed}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureMonitor(t, a)
	if err = os.WriteFile(filepath.Join(a.dataDir, "sessions", "two.enc"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	check := func(host string) {
		t.Helper()
		seen := map[string]bool{}
		for range 2 {
			select {
			case c := <-made:
				seen[c.ID] = true
				if host == "" {
					if c.Telegram.Proxy != nil {
						t.Fatal("explicit clear not applied")
					}
				} else if c.Telegram.Proxy == nil || c.Telegram.Proxy.Host != host || c.Telegram.Proxy.Username != "alice" || c.Telegram.Proxy.Password != "private" {
					t.Fatal("account did not receive proxy snapshot")
				}
			case <-time.After(time.Second):
				t.Fatal("missing account config")
			}
		}
		if !seen["one"] || !seen["two"] {
			t.Fatal("missing account")
		}
	}
	historyHTTP(t, a, "POST", "/api/config", `{"proxy":{"type":"socks5","host":"first.example","port":1080,"username":"alice","password":"private"}}`)
	if w := monitorRequest(t, a, "/api/monitor/start"); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	check("first.example")
	begin := historyHTTP(t, a, "POST", "/api/accounts/auth/begin", `{"label":"three"}`)
	id := begin["sessionId"].(string)
	historyHTTP(t, a, "POST", "/api/config", `{"proxy":{"host":"second.example"}}`)
	result := historyHTTP(t, a, "POST", "/api/accounts/auth/phone", `{"sessionId":"`+id+`","phone":"+10000000001"}`)
	if result["state"] != "code" {
		t.Fatal("phone step failed")
	}
	select {
	case c := <-logins:
		if c.Proxy == nil || c.Proxy.Host != "first.example" {
			t.Fatal("active login lost its original proxy snapshot")
		}
	case <-time.After(time.Second):
		t.Fatal("login factory absent")
	}
	historyHTTP(t, a, "POST", "/api/accounts/auth/cancel", `{"sessionId":"`+id+`"}`)
	if !loginClosed.Load() {
		t.Fatal("login cancel did not join client")
	}
	if w := monitorRequest(t, a, "/api/monitor/restart"); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	check("second.example")
	if w := monitorRequest(t, a, "/api/monitor/stop"); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if _, err = a.db.Writer.Exec(`UPDATE tgdl_queue_state SET paused=1`); err != nil {
		t.Fatal(err)
	}
	result = urlResults(t, a, `{"url":"https://t.me/channel/10"}`)[0].(map[string]any)
	if result["ok"] != true {
		t.Fatal(result)
	}
	check("second.example")
	status, err := a.monitor.Status(context.Background())
	if err != nil || status["state"] == "running" {
		t.Fatal("manual job enabled subscriptions")
	}
	historyHTTP(t, a, "POST", "/api/config", `{"proxy":null}`)
	if w := monitorRequest(t, a, "/api/monitor/restart"); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	check("")
}

func TestInvalidSavedProxyPreventsBothLoginAndMonitorFactory(t *testing.T) {
	var made atomic.Int64
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: func(engine.AccountConfig, *telegram.UpdateState, func(context.Context, tg.UpdatesClass) error, func(int64)) (engine.Account, error) {
		made.Add(1)
		return nil, nil
	}, AccountLoginFactory: func(telegram.GotdConfig) (telegram.LoginClient, error) { made.Add(1); return nil, nil }})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureMonitor(t, a)
	// Config editing permits partial settings; connection creation validates them.
	historyHTTP(t, a, "POST", "/api/config", `{"proxy":{"type":"mtproxy","host":"proxy.example","port":443,"secret":"never-print-this"}}`)
	for _, path := range []string{"/api/monitor/start", "/api/accounts/auth/begin"} {
		w := accountRequest(t, a, "POST", path, `{}`)
		if w.Code < 400 || strings.Contains(w.Body.String(), "never-print-this") {
			t.Fatalf("invalid proxy accepted/exposed for %s", path)
		}
	}
	if made.Load() != 0 {
		t.Fatal("invalid proxy started network client")
	}
}

func TestMTProxySecretReadRedactionAndRoundTrip(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	secret := strings.Repeat("ab", 16)
	historyHTTP(t, a, "POST", "/api/config", `{"proxy":{"type":"mtproxy","host":"proxy.example","port":443,"secret":"`+secret+`"}}`)
	for _, role := range []string{"admin", "guest"} {
		token, err := a.sessions.Create(context.Background(), role)
		if err != nil {
			t.Fatal(err)
		}
		w := requestPurge(a, token, "GET", "/api/config", "")
		if role == "guest" {
			if w.Code != 403 || strings.Contains(w.Body.String(), secret) {
				t.Fatal("guest proxy configuration access changed")
			}
			continue
		}
		if w.Code != 200 || strings.Contains(w.Body.String(), secret) {
			t.Fatalf("proxy config read role=%s status=%d leaked=%v", role, w.Code, strings.Contains(w.Body.String(), secret))
		}
		var cfg map[string]any
		if err = json.Unmarshal(w.Body.Bytes(), &cfg); err != nil {
			t.Fatal(err)
		}
		if cfg["proxy"].(map[string]any)["secretSet"] != true {
			t.Fatal("missing configured-secret indicator")
		}
		if role == "admin" {
			saved := requestPurge(a, token, "POST", "/api/config", w.Body.String())
			if saved.Code != 200 {
				t.Fatal(saved.Body.String())
			}
		}
	}
	raw := accountRequest(t, a, "GET", "/api/maintenance/config/raw", "")
	if raw.Code != 200 || strings.Contains(raw.Body.String(), secret) {
		t.Fatal("raw config exposed proxy secret")
	}
	cfg, err := a.config.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	p := cfg["proxy"].(map[string]any)
	if p["secret"] != secret || p["secretSet"] != nil {
		t.Fatal("redacted round trip corrupted proxy credential")
	}
}
