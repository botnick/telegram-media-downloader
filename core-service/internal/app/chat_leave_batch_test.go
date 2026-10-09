package app

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/tg"
)

type batchLeaveAccount struct {
	fixtureAccount
	mu    sync.Mutex
	calls []string
	fail  map[string]error
}

func (a *batchLeaveAccount) RemoveDialog(_ context.Context, id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls = append(a.calls, id)
	return a.fail[id]
}

func (a *batchLeaveAccount) called() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.calls...)
}

func TestChatLeaveBatchKeepsOrDeletesFilesAndStopsOnFloodWait(t *testing.T) {
	account := &batchLeaveAccount{fail: map[string]error{"-1000000000044": errors.New("leave Telegram channel: rpc error code 420: FLOOD_WAIT (30)")}}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: func(_ engine.AccountConfig, _ *telegram.UpdateState, handler func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		account.handle = handler
		return account, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureMonitor(t, a)
	cfg, err := a.config.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	cfg["groups"] = []any{
		map[string]any{"id": "-1000000000042", "name": "Keep", "enabled": true},
		map[string]any{"id": "-1000000000043", "name": "Drop", "enabled": true},
		map[string]any{"id": "-1000000000044", "name": "Flood", "enabled": true},
		map[string]any{"id": "-1000000000045", "name": "Later", "enabled": true},
	}
	if err := a.config.Save(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	for _, f := range []struct{ group, path string }{{"-1000000000042", "keep/a.bin"}, {"-1000000000043", "drop/b.bin"}} {
		full := filepath.Join(a.dataDir, "downloads", filepath.FromSlash(f.path))
		if err := os.MkdirAll(filepath.Dir(full), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("media"), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := a.db.Writer.Exec(`INSERT INTO downloads(group_id,group_name,message_id,file_path) VALUES(?,?,?,?)`, f.group, "g", 1, f.path); err != nil {
			t.Fatal(err)
		}
	}
	request := func(role, method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		token, err := a.sessions.Create(context.Background(), role)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, r)
		return w
	}
	wait := func() map[string]any {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			a.leaveBatchMu.Lock()
			status := cloneConfigValue(a.leaveBatchStatus).(map[string]any)
			a.leaveBatchMu.Unlock()
			if status["running"] != true {
				return status
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("leave batch did not finish")
		return nil
	}
	for _, tc := range []struct {
		role, body string
		code       int
	}{
		{"guest", `{"accountId":"one","ids":["-1000000000042"],"confirm":"1"}`, 403},
		{"admin", `{"accountId":"one","ids":["-1000000000042"],"confirm":"2"}`, 400},
		{"admin", `{"ids":["-1000000000042"],"confirm":"1"}`, 400},
		{"admin", `{"accountId":"one","ids":["042"],"confirm":"1"}`, 400},
		{"admin", `{"accountId":"one","ids":[],"confirm":"0"}`, 400},
	} {
		if w := request(tc.role, http.MethodPost, "/api/chats/leave-batch", tc.body); w.Code != tc.code {
			t.Fatalf("guard %s=%d want %d", tc.body, w.Code, tc.code)
		}
	}
	if len(account.called()) != 0 {
		t.Fatal("guard reached Telegram")
	}

	// Leave only: files and download rows stay, the local entry goes.
	if w := request("admin", http.MethodPost, "/api/chats/leave-batch", `{"accountId":"one","ids":["-1000000000042","-1000000000042"],"confirm":"1"}`); w.Code != 200 {
		t.Fatalf("keep batch=%d %s", w.Code, w.Body.String())
	}
	status := wait()
	if status["stage"] != "done" || jobCount(status["removed"]) != 1 {
		t.Fatalf("keep status=%v", status)
	}
	if _, err := os.Stat(filepath.Join(a.dataDir, "downloads", "keep", "a.bin")); err != nil {
		t.Fatalf("kept file removed: %v", err)
	}

	// Leave + delete: the flood wait stops the batch before the next chat and
	// only the confirmed chat loses its files.
	if w := request("admin", http.MethodPost, "/api/chats/leave-batch", `{"accountId":"one","ids":["-1000000000043","-1000000000044","-1000000000045"],"deleteFiles":true,"confirm":"3"}`); w.Code != 200 {
		t.Fatalf("delete batch=%d %s", w.Code, w.Body.String())
	}
	status = wait()
	if status["stage"] != "stopped" || jobCount(status["removed"]) != 1 || jobCount(status["failed"]) != 1 || jobCount(status["filesDeleted"]) != 1 {
		t.Fatalf("delete status=%v", status)
	}
	if got := strings.Join(account.called(), ","); got != "-1000000000042,-1000000000043,-1000000000044" {
		t.Fatalf("calls=%s", got)
	}
	if _, err := os.Stat(filepath.Join(a.dataDir, "downloads", "drop", "b.bin")); !os.IsNotExist(err) {
		t.Fatalf("deleted chat's file remains: %v", err)
	}
	var rows int
	if err := a.db.Reader.QueryRow(`SELECT count(*) FROM downloads WHERE group_id='-1000000000043'`).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("download rows=%d err=%v", rows, err)
	}
	if err := a.db.Reader.QueryRow(`SELECT count(*) FROM downloads WHERE group_id='-1000000000042'`).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("kept rows=%d err=%v", rows, err)
	}
	cfg, err = a.config.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var left []string
	for _, g := range configuredGroupList(cfg) {
		left = append(left, toString(g["id"]))
	}
	if strings.Join(left, ",") != "-1000000000044,-1000000000045" {
		t.Fatalf("configured=%v", left)
	}
}
