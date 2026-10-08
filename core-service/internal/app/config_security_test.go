package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestConfigSecretsAreWriteOnlyAndPartialSavesPreserveState(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	cfg := map[string]any{"web": map[string]any{"password": "admin-secret-value", "shareSecret": "share-secret-value"}, "telegram": map[string]any{"apiId": 123, "apiHash": "telegram-secret-value"}, "proxy": map[string]any{"password": "proxy-secret-value"}, "advanced": map[string]any{"ai": map[string]any{"faces": map[string]any{"sidecarToken": "face-secret-value"}}}, "download": map[string]any{"concurrent": 2, "retries": 5}}
	cfg["groups"] = []any{map[string]any{"id": "1", "monitorAccount": "monitor-secret-value", "forwardAccount": "forward-secret-value"}}
	cfg["accounts"] = []any{map[string]any{"id": "one", "name": "Primary", "phone": "phone-secret-value"}}
	if err := a.config.Save(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	call := func(method, path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, r)
		return w
	}
	got := call("GET", "/api/config", "")
	if strings.Contains(got.Body.String(), "secret-value") {
		t.Errorf("config leaked credential: %s", got.Body.String())
	}
	if result := call("POST", "/api/config", got.Body.String()); result.Code != 200 {
		t.Fatalf("config round trip failed: %s", result.Body.String())
	}
	roundTrip, err := a.config.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	group := roundTrip["groups"].([]any)[0].(map[string]any)
	if group["monitorAccount"] != "monitor-secret-value" || group["forwardAccount"] != "forward-secret-value" || group["hasMonitorAccount"] != nil {
		t.Fatal("round trip corrupted group account assignments")
	}
	if roundTrip["accounts"].([]any)[0].(map[string]any)["phone"] != "phone-secret-value" {
		t.Fatal("round trip erased account metadata")
	}
	observer := a.hub.Add("guest")
	defer a.hub.Remove(observer)
	saved := call("POST", "/api/config", `{"telegram":{"apiId":456},"download":{"concurrent":3}}`)
	if saved.Code != 200 {
		t.Fatal(saved.Body.String())
	}
	select {
	case e := <-observer.Events():
		raw, _ := json.Marshal(e)
		if string(raw) != `{"type":"config_updated"}` {
			t.Errorf("config update must contain no configuration: %s", raw)
		}
	default:
		t.Error("missing config notification")
	}
	stored, err := a.config.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if stored["telegram"].(map[string]any)["apiHash"] != "telegram-secret-value" {
		t.Error("partial save erased Telegram credential")
	}
	if stored["download"].(map[string]any)["retries"] != float64(5) {
		t.Error("partial save erased retries")
	}
	for _, body := range []string{`{"web":{"password":"injected"}}`, `{"web":{"passwordHash":null}}`, `{"web":{"guestPasswordHash":"injected"}}`, `{"web":null}`} {
		if w := call("POST", "/api/config", body); w.Code != 400 {
			t.Errorf("auth injection accepted: %s %d", body, w.Code)
		}
	}
}
