package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/version"
)

func TestOneClickUpdateSnapshotsAndTriggersWatchtower(t *testing.T) {
	var pings, triggers atomic.Int64
	watchtower := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer wt-token" {
			w.WriteHeader(401)
			return
		}
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/":
			pings.Add(1)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/update":
			triggers.Add(1)
		default:
			t.Errorf("unexpected watchtower call %s %s", r.Method, r.URL.Path)
		}
	}))
	defer watchtower.Close()
	t.Setenv("WATCHTOWER_URL", watchtower.URL)
	t.Setenv("WATCHTOWER_HTTP_API_TOKEN", "wt-token")
	saved := inDocker
	inDocker = func() bool { return true }
	defer func() { inDocker = saved }()

	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	// A 2.32.1 container triggered the update that started this version.
	if _, err := a.db.Writer.Exec(`INSERT INTO update_history(from_version,started_at,status) VALUES('2.32.1',?,'triggered')`, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	do := func(method, path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader("{}"))
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, r)
		return w
	}
	if w := do("GET", "/api/update/status"); w.Code != 200 || !strings.Contains(w.Body.String(), `"available":true`) {
		t.Fatalf("status=%d %s", w.Code, w.Body.String())
	}
	if w := do("POST", "/api/update"); w.Code != 200 {
		t.Fatalf("update=%d %s", w.Code, w.Body.String())
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if w := do("GET", "/api/auto-update/status"); strings.Contains(w.Body.String(), `"running":false`) && strings.Contains(w.Body.String(), `"stage":"done"`) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if pings.Load() != 1 || triggers.Load() != 1 {
		t.Fatalf("pings=%d triggers=%d", pings.Load(), triggers.Load())
	}
	snaps, _ := filepath.Glob(filepath.Join(a.dataDir, "backups", "db-pre-update-*.sqlite"))
	if len(snaps) != 1 {
		t.Fatalf("snapshots=%v", snaps)
	}
	if info, err := os.Stat(snaps[0]); err != nil || info.Size() == 0 {
		t.Fatalf("empty snapshot: %v", err)
	}
	w := do("GET", "/api/update/history")
	body := w.Body.String()
	if w.Code != 200 || !strings.Contains(body, `"status":"triggered"`) || !strings.Contains(body, `"to_version":"`+version.AppVersion+`"`) || !strings.Contains(body, `"status":"success"`) {
		t.Fatalf("history=%d %s", w.Code, body)
	}
}

func TestOneClickUpdateRecordsUnreachableWatchtower(t *testing.T) {
	t.Setenv("WATCHTOWER_URL", "http://127.0.0.1:1")
	t.Setenv("WATCHTOWER_HTTP_API_TOKEN", "wt-token")
	saved := inDocker
	inDocker = func() bool { return true }
	defer func() { inDocker = saved }()
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if _, err := a.runAutoUpdate(context.Background()); err == nil || !strings.Contains(err.Error(), "Watchtower preflight failed") {
		t.Fatalf("err=%v", err)
	}
	var code string
	if err := a.db.Reader.QueryRow(`SELECT error_code FROM update_history WHERE status='failed'`).Scan(&code); err != nil || code != "WATCHTOWER_UNREACHABLE" {
		t.Fatalf("code=%q err=%v", code, err)
	}
}
