package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSecurityGateFailsClosedAndRejectsGuestConfig(t *testing.T) {
	a, err := New(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	check := func(path string, token string, want int) {
		t.Helper()
		r := httptest.NewRequest("GET", path, nil)
		if token != "" {
			r.AddCookie(&http.Cookie{Name: "tg_dl_session", Value: token})
		}
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s status=%d want=%d body=%s", path, w.Code, want, w.Body.String())
		}
	}
	check("/api/downloads", "", 503)
	if err := a.config.Save(context.Background(), map[string]any{"web": map[string]any{"password": "test-admin", "enabled": true}}); err != nil {
		t.Fatal(err)
	}
	guest, err := a.sessions.Create(context.Background(), "guest")
	if err != nil {
		t.Fatal(err)
	}
	check("/api/config", guest, 403)
	check("/api/unknown-route", guest, 403)
	check("/api/downloads", guest, 200)
	if err := a.config.Save(context.Background(), map[string]any{"web": map[string]any{"password": "test-admin", "enabled": false}}); err != nil {
		t.Fatal(err)
	}
	check("/api/downloads", guest, 503)
}

func TestCSRFBeforeRouteSelection(t *testing.T) {
	a, err := New(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	for _, origin := range []string{"http://evil.example", "not a url", "null"} {
		r := httptest.NewRequest("POST", "/api/unknown-route", strings.NewReader(`{}`))
		r.Header.Set("Origin", origin)
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatalf("origin %s status=%d", origin, w.Code)
		}
	}
}

func TestJSONETagMatchesPublishedWireFormat(t *testing.T) {
	w := httptest.NewRecorder()
	writeJSON(w, 200, map[string]any{"ok": true})
	// SHA-1 of {"ok":true}, length in hex, standard base64 without padding.
	if got := w.Header().Get("ETag"); got != `W/"b-Ai2R8hgEarLmHKwesT1qcY913ys"` {
		t.Fatalf("etag=%s", got)
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
}
