package app

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestProxyPolicyTrustBoundary(t *testing.T) {
	for _, tc := range []struct {
		policy                           *string
		remote, forwarded, proto, client string
		secure, fail                     bool
	}{
		{nil, "127.0.0.1:12", "203.0.113.9", "https", "203.0.113.9", true, false},
		{nil, "198.51.100.5:12", "127.0.0.1", "https", "198.51.100.5", false, false},
		{nil, "[::ffff:127.0.0.1]:12", "198.51.100.1, 127.0.0.2", "https", "198.51.100.1", true, false},
		{nil, "127.0.0.1:12", "garbage, 198.51.100.1", "http", "198.51.100.1", false, false},
		{nil, "127.0.0.1:12", "198.51.100.1, garbage", "https", "", false, true},
		{nil, "127.0.0.1:12", "[::1]:12", "https", "", false, true},
		{strptr(""), "127.0.0.1:12", "203.0.113.9", "https", "127.0.0.1", false, false},
		{strptr("1"), "10.1.2.3:12", "203.0.113.9, 192.0.2.5", "https", "192.0.2.5", true, false},
		{strptr("2"), "10.1.2.3:12", "203.0.113.9, 192.0.2.5", "https", "203.0.113.9", true, false},
		{strptr("10.0.0.0/8, loopback"), "10.1.2.3:12", "203.0.113.9, 10.2.3.4", "https", "203.0.113.9", true, false},
		{strptr("::ffff:10.0.0.0/104"), "[::ffff:10.1.2.3]:12", "::ffff:203.0.113.9", "https", "203.0.113.9", true, false},
		{strptr("0"), "127.0.0.1:12", "203.0.113.9", "https", "127.0.0.1", false, false},
	} {
		p, err := parseProxyPolicy(tc.policy)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest("GET", "http://gallery.example/", nil)
		r.RemoteAddr = tc.remote
		r.Header.Set("X-Forwarded-For", tc.forwarded)
		r.Header.Set("X-Forwarded-Proto", tc.proto)
		n, err := p.resolve(r)
		if tc.fail {
			if err == nil {
				t.Fatal("invalid chain accepted", tc)
			}
			continue
		}
		if err != nil || n.client.String() != tc.client || n.secure != tc.secure {
			t.Fatalf("%+v: %+v %v", tc, n, err)
		}
		r = withNetwork(r, n)
		if clientKey(r) != tc.client || (requestScheme(r) == "https") != tc.secure {
			t.Fatal("policy split between quota and share links")
		}
	}
	for _, value := range []string{"*", "true", "-1", "257", "10.0.0.0/99", "loopback,", "::ffff:10.0.0.0/80"} {
		if _, err := parseProxyPolicy(&value); err == nil {
			t.Fatal("bad trust accepted", value)
		}
	}
	p, _ := parseProxyPolicy(nil)
	r := httptest.NewRequest("GET", "https://gallery.example/", nil)
	r.RemoteAddr = "127.0.0.1:12"
	r.TLS = &tls.ConnectionState{}
	r.Header.Set("X-Forwarded-Proto", "http")
	if n, err := p.resolve(r); err != nil || !n.secure {
		t.Fatal("TLS downgraded")
	}
	r.Header.Set("X-Forwarded-For", strings.Repeat("1", 8193))
	if _, err := p.resolve(r); err == nil {
		t.Fatal("unbounded chain")
	}
}
func strptr(s string) *string { return &s }

func TestHTTPOptionsRejectInvalidSettings(t *testing.T) {
	for _, env := range []map[string]string{{"TRUST_PROXY": "evil"}, {"COMPRESSION_LEVEL": "-1"}, {"COMPRESSION_LEVEL": "10"}, {"COMPRESSION_LEVEL": "2x"}} {
		if _, err := HTTPOptionsFromEnv(func(k string) (string, bool) { v, ok := env[k]; return v, ok }); err == nil {
			t.Fatal("bad options accepted", env)
		}
	}
	opts, err := HTTPOptionsFromEnv(func(k string) (string, bool) {
		switch k {
		case "TRUST_PROXY":
			return "", true
		case "TGDL_CSP":
			return "off", true
		case "COMPRESSION_LEVEL":
			return "0", true
		}
		return "", false
	})
	if err != nil || opts.TrustProxy == nil || *opts.TrustProxy != "" || !opts.DisableCSP || opts.CompressionLevel == nil || *opts.CompressionLevel != 0 {
		t.Fatal(opts, err)
	}
}

func TestHTTPPolicyImmediateConfigChangesAndForwardedHTTPS(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	req := func(method, path, body, remote, xff, proto string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://gallery.example"+path, strings.NewReader(body))
		r.RemoteAddr = remote
		r.Header.Set("X-Forwarded-For", xff)
		r.Header.Set("X-Forwarded-Proto", proto)
		r.AddCookie(&http.Cookie{Name: "tg_dl_session", Value: token})
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, r)
		return w
	}
	save := func(body string) {
		t.Helper()
		w := req("POST", "/api/config", body, "127.0.0.1:12", "", "")
		if w.Code != 200 {
			t.Fatalf("save %d %s", w.Code, w.Body.String())
		}
	}
	save(`{"web":{"forceHttps":true}}`)
	w := req("GET", "/api/version?x=1", "", "127.0.0.1:12", "203.0.113.9", "")
	if w.Code != 308 || w.Header().Get("Location") != "https://gallery.example/api/version?x=1" {
		t.Fatal(w.Code, w.Header())
	}
	w = req("HEAD", "/api/version", "", "127.0.0.1:12", "203.0.113.9", "")
	if w.Code != 308 || w.Body.Len() != 0 {
		t.Fatal("HEAD redirect", w.Code, w.Body.String())
	}
	w = req("POST", "/api/config", `{"web":{"forceHttps":false}}`, "127.0.0.1:12", "203.0.113.9", "")
	if w.Code != 403 {
		t.Fatal("insecure mutation", w.Code)
	}
	w = req("GET", "/api/version", "", "203.0.113.9:12", "127.0.0.1", "https")
	if w.Code != 308 {
		t.Fatal("untrusted proxy bypass", w.Code)
	}
	w = req("GET", "/api/version", "", "127.0.0.1:12", "", "")
	if w.Code != 200 || w.Header().Get("Strict-Transport-Security") != "" {
		t.Fatal("local recovery locked", w.Code, w.Header())
	}
	w = req("GET", "/api/version", "", "127.0.0.1:12", "203.0.113.9", "https")
	if w.Code != 200 || !strings.Contains(w.Header().Get("Strict-Transport-Security"), "31536000") || !strings.Contains(w.Header().Get("Content-Security-Policy"), "upgrade-insecure-requests") {
		t.Fatal(w.Code, w.Header())
	}
	save(`{"web":{"forceHttps":false,"csp":{"reportOnly":true,"directives":{"img-src":["'self'","https://images.example","https://images.example"],"frame-ancestors":["https://embed.example"],"object-src":[]}}}}`)
	w = req("GET", "/api/version", "", "127.0.0.1:12", "203.0.113.9", "https")
	csp := w.Header().Get("Content-Security-Policy-Report-Only")
	if w.Code != 200 || w.Header().Get("Content-Security-Policy") != "" || w.Header().Get("X-Frame-Options") != "" || w.Header().Get("Strict-Transport-Security") != "max-age=0" || !strings.Contains(csp, "img-src 'self' https://images.example;") || strings.Contains(csp, "object-src") || strings.Contains(csp, "upgrade-insecure") {
		t.Fatal(w.Code, w.Header())
	}
	for _, body := range []string{`{"web":{"csp":{"directives":{"img-src":["a;script-src *"]}}}}`, `{"web":{"csp":{"directives":{"img-src":["a\r\nX-Bad: yes"]}}}}`, `{"web":{"csp":[]}}`, `{"web":{"csp":{"directives":{"bad name":[]}}}}`} {
		w = req("POST", "/api/config", body, "127.0.0.1:12", "", "")
		if w.Code != 400 {
			t.Fatal("bad CSP accepted", body, w.Code)
		}
	}
	w = req("GET", "/api/version", "", "127.0.0.1:12", "", "")
	if w.Header().Get("Content-Security-Policy-Report-Only") != csp {
		t.Fatal("invalid save changed policy")
	}
	save(`{"web":{"csp":{"enabled":false}}}`)
	w = req("GET", "/api/version", "", "127.0.0.1:12", "", "")
	if w.Header().Get("Content-Security-Policy-Report-Only") != "" {
		t.Fatal("CSP disable ineffective")
	}
	save(`{"web":{"csp":null}}`)
	w = req("GET", "/api/version", "", "127.0.0.1:12", "", "")
	if w.Header().Get("Content-Security-Policy") == "" || w.Header().Get("X-Frame-Options") != "SAMEORIGIN" {
		t.Fatal("CSP reset did not restore defaults", w.Header())
	}
}

func TestHTTPPolicyInvalidStoredConfigFailsClosedAndExplicitRecoveryWorks(t *testing.T) {
	for _, off := range []bool{false, true} {
		a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), HTTP: HTTPOptions{DisableCSP: off}})
		if err != nil {
			t.Fatal(err)
		}
		cfg, err := a.config.Load(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		ensureMap(cfg, "web")["csp"] = map[string]any{"directives": map[string]any{"img-src": []any{"a\r\nInjected: yes"}}}
		if err = a.config.Save(context.Background(), cfg); err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest("GET", "/api/version", nil)
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, r)
		if !off && w.Code != 503 || off && (w.Code != 200 || w.Header().Get("Content-Security-Policy") != "") {
			t.Fatal(off, w.Code, w.Header())
		}
		a.Close()
	}
}

func TestHTTPGlobalLimitIsImmediateAndDoesNotReplaceLoginLimit(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	cfg, err := a.config.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ensureMap(cfg, "web")["rateLimit"] = map[string]any{"enabled": true, "perMinute": 10}
	if err = a.config.Save(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	request := func(ip, path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", path, nil)
		r.RemoteAddr = "127.0.0.1:12"
		r.Header.Set("X-Forwarded-For", ip)
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, r)
		return w
	}
	for i := 0; i < 10; i++ {
		if w := request("203.0.113.1", "/api/version"); w.Code != 200 {
			t.Fatal(i, w.Code)
		}
	}
	w := request("203.0.113.1", "/api/version")
	if w.Code != 429 || w.Header().Get("Retry-After") == "" || w.Body.String() != "Too many requests, please try again later." {
		t.Fatal(w.Code, w.Header(), w.Body.String())
	}
	if w = request("203.0.113.1", "/health"); w.Code != 200 || w.Header().Get("RateLimit") != "" {
		t.Fatal("non-API limited")
	}
	if w = request("203.0.113.2", "/api/version"); w.Code != 200 {
		t.Fatal("other IP limited")
	}
	// Concurrent requests consume exactly one shared quota, with no map races.
	var wg sync.WaitGroup
	results := make(chan int, 40)
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); results <- request("203.0.113.3", "/api/version").Code }()
	}
	wg.Wait()
	close(results)
	ok, limited := 0, 0
	for status := range results {
		switch status {
		case 200:
			ok++
		case 429:
			limited++
		default:
			t.Fatal(status)
		}
	}
	if ok != 10 || limited != 30 {
		t.Fatal(ok, limited)
	}
	ensureMap(cfg, "web")["rateLimit"] = map[string]any{"enabled": false}
	if err = a.config.Save(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	if w = request("203.0.113.1", "/api/version"); w.Code != 200 || w.Header().Get("RateLimit") != "" {
		t.Fatal("disable not immediate")
	}
	for i := 0; i < 10; i++ {
		a.loginRL.allow("203.0.113.8", time.Now())
	}
	r := httptest.NewRequest("POST", "/api/login", strings.NewReader(`{"password":"wrong"}`))
	r.RemoteAddr = "127.0.0.1:12"
	r.Header.Set("X-Forwarded-For", "203.0.113.8")
	w = httptest.NewRecorder()
	a.Handler().ServeHTTP(w, r)
	if w.Code != 429 || !strings.Contains(w.Body.String(), "login attempts") {
		t.Fatal("login limit lost", w.Code, w.Body.String())
	}
}

func FuzzCSPHeaderValidation(f *testing.F) {
	f.Add("img-src", "https://example.com")
	f.Add("bad name", "a\r\nX-Test: bad")
	f.Fuzz(func(t *testing.T, name, source string) {
		if len(name) > 200 || len(source) > 1000 {
			return
		}
		v, err := normalizeCSP(map[string]any{"directives": map[string]any{name: []any{source}}})
		if err != nil {
			return
		}
		b, _ := json.Marshal(map[string]any{"csp": v})
		p, err := compileWebPolicy(string(b), false)
		if err != nil || strings.ContainsAny(p.cspValue, "\r\n\x00") {
			t.Fatal("unsafe header accepted", err)
		}
	})
}

func BenchmarkRateLimiterManyClients(b *testing.B) {
	for _, clients := range []int{1, 10000} {
		b.Run(fmt.Sprint(clients), func(b *testing.B) {
			l := newRateLimiter(1000000000, time.Minute)
			now := time.Now()
			keys := make([]string, clients)
			for i := range keys {
				keys[i] = fmt.Sprint(i)
				l.allow(keys[i], now)
			}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				l.allow(keys[i%clients], now)
			}
		})
	}
}
