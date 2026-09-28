package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
	"github.com/botnick/telegram-media-downloader/core-service/internal/version"
)

const token = "test-token"

func newTestServer(t *testing.T, roots ...string) *httptest.Server {
	t.Helper()
	r, _ := hash.NewRoots(roots)
	ts := httptest.NewServer(New(token, 2, r, nil).Handler())
	t.Cleanup(ts.Close)
	return ts
}

func do(t *testing.T, method, url, tok string, body any) (*http.Response, map[string]any) {
	t.Helper()
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, url, rd)
	if tok != "" {
		req.Header.Set(TokenHeader, tok)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp, out
}

func TestHealthIsOpen(t *testing.T) {
	ts := newTestServer(t)
	resp, body := do(t, "GET", ts.URL+"/health", "", nil)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if body["ok"] != true || body["service"] != "tgdl-core" || body["version"] != version.Version {
		t.Fatalf("unexpected body %v", body)
	}
	feats, _ := body["features"].([]any)
	if len(feats) != 1 || feats[0] != "hash" {
		t.Fatalf("features = %v", body["features"])
	}
}

func TestEverythingElseNeedsToken(t *testing.T) {
	ts := newTestServer(t)
	for _, c := range []struct{ method, path, tok string }{
		{"POST", "/v1/hash", ""},
		{"POST", "/v1/hash", "wrong"},
		{"GET", "/v1/stats", ""},
		{"GET", "/nope", ""},
		{"POST", "/health", ""},
	} {
		resp, body := do(t, c.method, ts.URL+c.path, c.tok, map[string]string{"path": "/x"})
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s %s token=%q: status %d, want 401", c.method, c.path, c.tok, resp.StatusCode)
		}
		if e, _ := body["error"].(map[string]any); e["code"] != "EAUTH" {
			t.Errorf("%s %s: body %v", c.method, c.path, body)
		}
	}
}

func TestHashRoute(t *testing.T) {
	dir := t.TempDir()
	ts := newTestServer(t, dir)
	data := []byte("hello tgdl-core")
	p := filepath.Join(dir, "ไฟล์ 🎬.bin")
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)

	resp, body := do(t, "POST", ts.URL+"/v1/hash", token, map[string]string{"path": p})
	if resp.StatusCode != 200 {
		t.Fatalf("status %d body %v", resp.StatusCode, body)
	}
	if body["sha256"] != hex.EncodeToString(sum[:]) || body["size"] != float64(len(data)) {
		t.Fatalf("unexpected body %v", body)
	}
	if mt, ok := body["mtimeMs"].(float64); !ok || mt <= 0 {
		t.Fatalf("mtimeMs = %v", body["mtimeMs"])
	}

	resp, body = do(t, "GET", ts.URL+"/v1/stats", token, nil)
	h, _ := body["hash"].(map[string]any)
	if resp.StatusCode != 200 || h["completed"] != float64(1) || h["concurrency"] != float64(2) {
		t.Fatalf("stats: %d %v", resp.StatusCode, body)
	}
	if roots, _ := h["roots"].([]any); len(roots) != 1 {
		t.Fatalf("stats roots = %v", h["roots"])
	}
}

func TestHashRouteRefusesPathsOutsideRoots(t *testing.T) {
	root := t.TempDir()
	other := t.TempDir()
	p := filepath.Join(other, "secret.bin")
	if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		name string
		ts   *httptest.Server
		path string
	}{
		{"outside the root", newTestServer(t, root), p},
		{"dot-dot out of the root", newTestServer(t, root), root + string(filepath.Separator) + ".." + string(filepath.Separator) + filepath.Base(other) + string(filepath.Separator) + "secret.bin"},
		{"no roots configured", newTestServer(t), p},
	} {
		resp, body := do(t, "POST", c.ts.URL+"/v1/hash", token, map[string]string{"path": c.path})
		e, _ := body["error"].(map[string]any)
		if resp.StatusCode != http.StatusForbidden || e["code"] != "EOUTSIDE" {
			t.Errorf("%s: got %d %v, want 403 EOUTSIDE", c.name, resp.StatusCode, body)
		}
	}
	// /health reports how many roots there are, not which.
	_, body := do(t, "GET", newTestServer(t, root).URL+"/health", "", nil)
	if h, _ := body["hash"].(map[string]any); h["roots"] != float64(1) {
		t.Fatalf("health hash = %v", body["hash"])
	}
}

func TestHashErrors(t *testing.T) {
	dir := t.TempDir()
	ts := newTestServer(t, dir)
	cases := []struct {
		body   any
		status int
		code   string
	}{
		{map[string]string{"path": filepath.Join(dir, "missing.bin")}, 422, "ENOENT"},
		{map[string]string{"path": dir}, 422, "EISDIR"},
		{map[string]string{"path": "relative.bin"}, 400, "EINVAL"},
		{map[string]string{}, 400, "EINVAL"},
		{"not an object", 400, "EINVAL"},
	}
	for _, c := range cases {
		resp, body := do(t, "POST", ts.URL+"/v1/hash", token, c.body)
		e, _ := body["error"].(map[string]any)
		if resp.StatusCode != c.status || e["code"] != c.code {
			t.Errorf("body %v: got %d %v, want %d %s", c.body, resp.StatusCode, body, c.status, c.code)
		}
	}
	// Empty body.
	req, _ := http.NewRequest("POST", ts.URL+"/v1/hash", nil)
	req.Header.Set(TokenHeader, token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Errorf("empty body: status %d", resp.StatusCode)
	}
}

func TestUnknownRouteWithToken(t *testing.T) {
	ts := newTestServer(t)
	resp, _ := do(t, "GET", ts.URL+"/v1/nope", token, nil)
	if resp.StatusCode != 404 {
		t.Fatalf("status %d", resp.StatusCode)
	}
}
