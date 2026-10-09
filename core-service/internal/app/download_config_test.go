package app

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDownloadConfigRejectsCountsThatEngineCannotStart(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		key, value string
		want       int
	}{
		{"retries", "0", 400}, {"retries", "21", 400}, {"retries", "50", 400},
		{"retries", "1.5", 400}, {"retries", "-1", 400}, {"retries", "null", 400},
		{"concurrent", "0", 400}, {"concurrent", "51", 400}, {"concurrent", "2.5", 400},
		{"retries", "1", 200}, {"retries", "20", 200},
		{"concurrent", "1", 200}, {"concurrent", "50", 200},
	} {
		t.Run(tc.key+"="+tc.value, func(t *testing.T) {
			before, err := a.config.Load(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			r := httptest.NewRequest("POST", "/api/config", strings.NewReader(fmt.Sprintf(`{"download":{"%s":%s}}`, tc.key, tc.value)))
			r.Header.Set("Content-Type", "application/json")
			r.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
			w := httptest.NewRecorder()
			a.Handler().ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("save count=%d want=%d body=%s", w.Code, tc.want, w.Body.String())
			}
			if tc.want == 400 {
				after, err := a.config.Load(context.Background())
				if err != nil {
					t.Fatal(err)
				}
				if fmt.Sprint(before["download"]) != fmt.Sprint(after["download"]) {
					t.Fatal("rejected request changed download configuration")
				}
			}
		})
	}
}
