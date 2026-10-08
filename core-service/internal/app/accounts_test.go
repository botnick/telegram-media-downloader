package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func accountRequest(t *testing.T, a *App, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	token, err := a.sessions.Create(context.Background(), "admin")
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
func TestAccountListReadsSavedMetadataWithoutTelegram(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	cfg, err := a.config.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	cfg["accounts"] = []any{map[string]any{"id": "alice", "name": "Alice", "username": "alice_ex", "phone": "+10000000001"}}
	if err = a.config.Save(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(a.dataDir, "sessions", "native")
	if err = os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, "alice.enc"), []byte("listing does not open key material"), 0600); err != nil {
		t.Fatal(err)
	}
	w := accountRequest(t, a, "GET", "/api/accounts", "")
	var result []map[string]any
	if err = json.Unmarshal(w.Body.Bytes(), &result); err != nil || w.Code != 200 {
		t.Fatalf("accounts=%d %s", w.Code, w.Body.String())
	}
	if len(result) != 1 || result[0]["name"] != "Alice" || result[0]["isDefault"] != true {
		t.Fatalf("accounts=%v", result)
	}
}
func TestAccountWizardMissingCredentialsPreservesHTTPError(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	for _, route := range []struct {
		method, path string
		code         int
	}{
		{"POST", "/api/accounts/auth/begin", 503}, {"POST", "/api/accounts/auth/phone", 400}, {"GET", "/api/accounts/auth/missing", 503}, {"DELETE", "/api/accounts/missing", 503},
	} {
		w := accountRequest(t, a, route.method, route.path, "{}")
		if w.Code != route.code || !strings.Contains(w.Body.String(), "Telegram API credentials not configured") {
			t.Errorf("%s=%d %s", route.path, w.Code, w.Body.String())
		}
	}
}
