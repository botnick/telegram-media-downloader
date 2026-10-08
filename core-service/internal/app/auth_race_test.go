package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/auth"
)

func TestGuestDisableCannotBeUndoneByRacingLogin(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	hash, err := auth.HashPassword("guest-password")
	if err != nil {
		t.Fatal(err)
	}
	config, err := a.config.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	web := config["web"].(map[string]any)
	web["guestPasswordHash"] = hash.JSON()
	web["guestEnabled"] = true
	if err := a.config.Save(context.Background(), config); err != nil {
		t.Fatal(err)
	}
	admin, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	login := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		a.Handler().ServeHTTP(login, httptest.NewRequest("POST", "/api/login", strings.NewReader(`{"password":"guest-password"}`)))
	}()
	// Password verification is deliberately expensive. Disable during that
	// verification; after disable completes, no racing login may stay usable.
	time.Sleep(10 * time.Millisecond)
	r := httptest.NewRequest("POST", "/api/auth/guest-password", strings.NewReader(`{"enabled":false}`))
	r.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: admin})
	disabled := httptest.NewRecorder()
	a.Handler().ServeHTTP(disabled, r)
	<-done
	if disabled.Code != 200 {
		t.Fatalf("disable %d %s", disabled.Code, disabled.Body.String())
	}
	if login.Code == 401 {
		return
	}
	if login.Code != 200 {
		t.Fatalf("login %d %s", login.Code, login.Body.String())
	}
	check := httptest.NewRequest("GET", "/api/downloads", nil)
	for _, cookie := range login.Result().Cookies() {
		check.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, check)
	if w.Code != 401 {
		t.Fatalf("disabled guest still has a session: %d", w.Code)
	}
}
