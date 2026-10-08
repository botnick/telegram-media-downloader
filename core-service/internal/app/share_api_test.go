package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestShareCreateServeTamperRevoke(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if err := os.MkdirAll(filepath.Join(a.dataDir, "downloads"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(a.dataDir, "downloads", "image.jpg"), []byte("media bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Writer.Exec(`INSERT INTO downloads(group_id,message_id,file_path,file_name,file_type,file_size) VALUES('1',1,'image.jpg','image.jpg','photo',11)`); err != nil {
		t.Fatal(err)
	}
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, path, body string, admin bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		if admin {
			r.AddCookie(&http.Cookie{Name: "tg_dl_session", Value: token})
		}
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, r)
		return w
	}
	created := request("POST", "/api/share/links", `{"downloadId":1,"ttlSeconds":60}`, true)
	if created.Code != 200 {
		t.Fatalf("create=%d %s", created.Code, created.Body.String())
	}
	var body struct {
		Link struct {
			URL string `json:"url"`
		} `json:"link"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	uri, err := url.Parse(body.Link.URL)
	if err != nil {
		t.Fatal(err)
	}
	served := request("GET", uri.RequestURI(), "", false)
	if served.Code != 200 || served.Body.String() != "media bytes" {
		t.Fatalf("serve=%d %q", served.Code, served.Body.String())
	}
	if w := request("GET", "/share/1?s=forged", "", false); w.Code != 401 {
		t.Fatalf("tamper=%d", w.Code)
	}
	if w := request("DELETE", "/api/share/links/1", "", true); w.Code != 200 {
		t.Fatalf("revoke=%d", w.Code)
	}
	if w := request("GET", uri.RequestURI(), "", false); w.Code != 401 {
		t.Fatalf("revoked serve=%d", w.Code)
	}
}

func TestShareSchemeTrustsOnlyLoopbackProxy(t *testing.T) {
	for _, tc := range []struct{ remote, forwarded, want string }{
		{"127.0.0.1:1234", "https", "https"},
		{"[::1]:1234", "https", "https"},
		{"192.0.2.1:1234", "https", "http"},
		{"127.0.0.1:1234", "garbage", "http"},
	} {
		r := httptest.NewRequest("GET", "http://gallery.example/", nil)
		r.RemoteAddr = tc.remote
		r.Header.Set("X-Forwarded-Proto", tc.forwarded)
		if got := requestScheme(r); got != tc.want {
			t.Errorf("%s scheme=%s want=%s", tc.remote, got, tc.want)
		}
	}
}
