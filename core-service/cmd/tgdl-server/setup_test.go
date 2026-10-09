package main

import (
	"bytes"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSetupDashboardLocalRequest(t *testing.T) {
	const password = "  private password  "
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Password string }
		if r.Method != "POST" || r.URL.Path != "/api/auth/setup" || r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("unexpected setup request: %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Password != password {
			t.Error("password was not preserved")
		}
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer server.Close()
	_, port, _ := net.SplitHostPort(server.Listener.Addr().String())
	t.Setenv("PORT", port)
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	t.Setenv("ALL_PROXY", "http://127.0.0.1:1")
	var out, errOut bytes.Buffer
	if code := setupDashboard([]string{"--password-stdin"}, strings.NewReader(password+"\r\n"), &out, &errOut); code != 0 {
		t.Fatalf("exit=%d stderr=%s", code, &errOut)
	}
	if strings.Contains(out.String()+errOut.String(), password) || !strings.Contains(out.String(), "configured") {
		t.Fatal("setup output leaked password or omitted success")
	}
}

func TestSetupDashboardRejectsBadInputBeforeRequest(t *testing.T) {
	for _, tc := range []struct {
		name, port, password string
		args                 []string
	}{
		{"missing flag", "3000", "password", nil},
		{"positional secret", "3000", "password", []string{"--password-stdin", "secret"}},
		{"invalid port", "0", "password", []string{"--password-stdin"}},
		{"short", "3000", "short", []string{"--password-stdin"}},
		{"multiline", "3000", "password\nextra", []string{"--password-stdin"}},
		{"oversize", "3000", strings.Repeat("a", 4097), []string{"--password-stdin"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("PORT", tc.port)
			var out, errOut bytes.Buffer
			if code := setupDashboard(tc.args, strings.NewReader(tc.password), &out, &errOut); code != 2 {
				t.Fatalf("exit=%d stderr=%s", code, &errOut)
			}
		})
	}
}

func TestSetupDashboardDoesNotRedirectOrEchoResponse(t *testing.T) {
	for _, status := range []int{http.StatusTemporaryRedirect, http.StatusConflict, http.StatusForbidden, http.StatusOK} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			requests := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests++
				w.Header().Set("Location", "/leak")
				w.WriteHeader(status)
				_, _ = w.Write([]byte("secret-reflected-password"))
			}))
			defer server.Close()
			_, port, _ := net.SplitHostPort(server.Listener.Addr().String())
			t.Setenv("PORT", port)
			var out, errOut bytes.Buffer
			if code := setupDashboard([]string{"--password-stdin"}, strings.NewReader("secret-reflected-password"), &out, &errOut); code != 1 {
				t.Fatalf("exit=%d stdout=%s stderr=%s", code, &out, &errOut)
			}
			if requests != 1 || strings.Contains(out.String()+errOut.String(), "secret-reflected-password") {
				t.Fatal("redirect followed or response echoed")
			}
		})
	}
}
