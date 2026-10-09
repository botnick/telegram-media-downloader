package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/auth"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
	"github.com/gorilla/websocket"
)

func socketTestApp(t *testing.T) (*App, *httptest.Server) {
	t.Helper()
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := a.Close(); err != nil {
			t.Error(err)
		}
	})
	srv := httptest.NewServer(a.Handler())
	t.Cleanup(srv.Close)
	return a, srv
}

func socketToken(t *testing.T, a *App, role string, ttl time.Duration) string {
	t.Helper()
	token, err := a.sessions.CreateWithTTL(context.Background(), role, ttl)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func socketDial(t *testing.T, a *App, srv *httptest.Server, token string) *websocket.Conn {
	t.Helper()
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", http.Header{"Cookie": {a.sessions.CookieName() + "=" + token}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func socketRequest(t *testing.T, a *App, srv *httptest.Server, token, path, body string) *http.Response {
	t.Helper()
	r, err := http.NewRequest("POST", srv.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Content-Type", "application/json")
	r.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	c := &http.Client{Timeout: 5 * time.Second}
	resp, err := c.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

func requireSocketClosed(t *testing.T, c *websocket.Conn) {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, _, err := c.ReadMessage()
	if err == nil {
		t.Fatal("revoked socket received a data frame")
	}
	var timeout net.Error
	if errors.As(err, &timeout) && timeout.Timeout() {
		t.Fatalf("socket was not closed: %v", err)
	}
}

func requireSocketEvent(t *testing.T, c *websocket.Conn, kind string) {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		var event map[string]any
		if err := c.ReadJSON(&event); err != nil {
			t.Fatal(err)
		}
		if event["type"] == kind {
			return
		}
	}
}

func TestWebSocketLogoutClosesEveryConnectionForOnlyThatToken(t *testing.T) {
	a, srv := socketTestApp(t)
	a1 := socketToken(t, a, "admin", time.Hour)
	a2 := socketToken(t, a, "admin", time.Hour)
	g := socketToken(t, a, "guest", time.Hour)
	first, second := socketDial(t, a, srv, a1), socketDial(t, a, srv, a1)
	other, guest := socketDial(t, a, srv, a2), socketDial(t, a, srv, g)
	if res := socketRequest(t, a, srv, a1, "/api/logout", `{}`); res.StatusCode != 200 {
		t.Fatal(res.StatusCode)
	}
	a.hub.Broadcast(ws.Event{Type: "after_logout"})
	requireSocketClosed(t, first)
	requireSocketClosed(t, second)
	requireSocketEvent(t, other, "after_logout")
	requireSocketEvent(t, guest, "after_logout")
	if _, err := a.sessions.Validate(context.Background(), a1); err == nil {
		t.Fatal("logged-out token remains valid")
	}
}

func TestWebSocketCredentialChangesRevokeMatchingRoles(t *testing.T) {
	cases := []struct{ name, path, body, scope string }{
		{"password", "/api/auth/change-password", `{"currentPassword":"test-admin-password","newPassword":"next-admin-password"}`, "admin"},
		{"guest_disable", "/api/auth/guest-password", `{"enabled":false}`, "guest"},
		{"guest_clear", "/api/auth/guest-password", `{"clear":true}`, "guest"},
		{"guest_password", "/api/auth/guest-password", `{"password":"new-guest-password"}`, "guest"},
		{"config_guest_disable", "/api/config", `{"web":{"guestEnabled":false}}`, "guest"},
		{"config_web_disable", "/api/config", `{"web":{"enabled":false}}`, "all"},
		{"revoke_all", "/api/maintenance/sessions/revoke-all", `{"confirm":true,"password":"test-admin-password"}`, "all"},
		{"reset", "/api/auth/reset/confirm", `{"token":"test-reset-token","newPassword":"reset-admin-password"}`, "all"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a, srv := socketTestApp(t)
			a.resetMu.Lock()
			a.resetTokens["test-reset-token"] = time.Now().Add(time.Minute)
			a.resetMu.Unlock()
			admin := socketToken(t, a, "admin", time.Hour)
			other := socketToken(t, a, "admin", time.Hour)
			guest := socketToken(t, a, "guest", time.Hour)
			ac, oc, gc := socketDial(t, a, srv, admin), socketDial(t, a, srv, other), socketDial(t, a, srv, guest)
			res := socketRequest(t, a, srv, admin, tc.path, tc.body)
			if res.StatusCode != 200 {
				t.Fatalf("status %d", res.StatusCode)
			}
			a.hub.Broadcast(ws.Event{Type: "after_credentials"})
			for _, entry := range []struct {
				role, token string
				conn        *websocket.Conn
			}{{"admin", admin, ac}, {"admin", other, oc}, {"guest", guest, gc}} {
				_, err := a.sessions.Validate(context.Background(), entry.token)
				if tc.scope == "all" || tc.scope == entry.role {
					if err == nil {
						t.Fatalf("%s session survived", entry.role)
					}
					requireSocketClosed(t, entry.conn)
				} else {
					if err != nil {
						t.Fatal(err)
					}
					requireSocketEvent(t, entry.conn, "after_credentials")
				}
			}
			if tc.name == "password" || tc.name == "reset" {
				cookies := res.Cookies()
				if len(cookies) != 1 {
					t.Fatal("missing replacement session")
				}
				fresh := socketDial(t, a, srv, cookies[0].Value)
				a.hub.Broadcast(ws.Event{Type: "replacement_works"})
				requireSocketEvent(t, fresh, "replacement_works")
			}
			if tc.name == "config_web_disable" {
				login := socketRequest(t, a, srv, "", "/api/login", `{"password":"test-admin-password"}`)
				if login.StatusCode != 401 {
					t.Fatalf("disabled web login: %d", login.StatusCode)
				}
			}
		})
	}
}

func TestWebSocketExpiryAndHTTPRenewal(t *testing.T) {
	t.Run("idle_expiry", func(t *testing.T) {
		a, srv := socketTestApp(t)
		token := socketToken(t, a, "admin", 750*time.Millisecond)
		conn := socketDial(t, a, srv, token)
		requireSocketClosed(t, conn)
		if _, err := a.sessions.Validate(context.Background(), token); err == nil {
			t.Fatal("socket renewed idle session")
		}
	})
	t.Run("http_renewal", func(t *testing.T) {
		a, srv := socketTestApp(t)
		token := socketToken(t, a, "admin", 1200*time.Millisecond)
		conn := socketDial(t, a, srv, token)
		sess, err := a.sessions.Validate(context.Background(), token)
		if err != nil {
			t.Fatal(err)
		}
		now := time.Now().UnixMilli()
		// Make HTTP renewal deterministic without waiting for the final quarter.
		if _, err = a.db.Writer.Exec(`UPDATE web_sessions SET issued_at=?,expires_at=? WHERE token=?`, now-3500, now+500, token); err != nil {
			t.Fatal(err)
		}
		r, _ := http.NewRequest("GET", srv.URL+"/api/monitor/status", nil)
		r.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
		res, err := srv.Client().Do(r)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != 200 || len(res.Cookies()) == 0 {
			t.Fatalf("HTTP did not renew: status=%d cookies=%v", res.StatusCode, res.Cookies())
		}
		time.Sleep(time.Until(time.UnixMilli(sess.ExpiresAt).Add(100 * time.Millisecond)))
		a.hub.Broadcast(ws.Event{Type: "renewed"})
		requireSocketEvent(t, conn, "renewed")
	})
}

func TestWebSocketUsesCanonicalCookieAndRejectsStaleContext(t *testing.T) {
	a, srv := socketTestApp(t)
	admin, guest := socketToken(t, a, "admin", time.Hour), socketToken(t, a, "guest", time.Hour)
	conn := socketDial(t, a, srv, admin+"; "+a.sessions.CookieName()+"="+guest)
	if res := socketRequest(t, a, srv, guest, "/api/logout", `{}`); res.StatusCode != 200 {
		t.Fatal(res.StatusCode)
	}
	requireSocketClosed(t, conn)
	sess, err := a.sessions.Validate(context.Background(), admin)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.sessions.Revoke(context.Background(), admin); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "/ws", nil).WithContext(auth.WithSession(context.Background(), sess))
	w := httptest.NewRecorder()
	a.handleWebSocket(w, r)
	if w.Code != 401 {
		t.Fatalf("stale context accepted: %d", w.Code)
	}
}

func TestWebSocketRevokedDuringHandshakeDiscardsBufferedEvents(t *testing.T) {
	a, api := socketTestApp(t)
	written, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	defer unblock()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a.handleWebSocket(barrierHijacker{w, written, release}, r)
	}))
	defer srv.Close()
	token := socketToken(t, a, "admin", time.Hour)
	conn := socketDial(t, a, srv, token)
	<-written
	for i := 0; i < 1000; i++ {
		a.hub.Broadcast(ws.Event{Type: "queued_secret"})
	}
	if res := socketRequest(t, a, api, token, "/api/logout", `{}`); res.StatusCode != 200 {
		t.Fatal(res.StatusCode)
	}
	requireSocketClosed(t, conn)
	unblock()
}

func TestWebSocketCloseJoinsConnectionsBeforeDatabaseClose(t *testing.T) {
	a, srv := socketTestApp(t)
	conn := socketDial(t, a, srv, socketToken(t, a, "admin", time.Hour))
	done := make(chan error, 1)
	go func() { done <- a.Close() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Close did not join sockets")
	}
	requireSocketClosed(t, conn)
	a.webSockets.mu.Lock()
	n := len(a.webSockets.clients)
	a.webSockets.mu.Unlock()
	if n != 0 || a.hub.Count() != 0 {
		t.Fatal("socket ownership leaked")
	}
}

func TestCredentialTransactionFailureKeepsSessionsAndSockets(t *testing.T) {
	a, srv := socketTestApp(t)
	token := socketToken(t, a, "admin", time.Hour)
	conn := socketDial(t, a, srv, token)
	if _, err := a.db.Writer.Exec(`CREATE TRIGGER fail_revoke BEFORE DELETE ON web_sessions BEGIN SELECT RAISE(ABORT,'injected failure'); END`); err != nil {
		t.Fatal(err)
	}
	res := socketRequest(t, a, srv, token, "/api/auth/change-password", `{"currentPassword":"test-admin-password","newPassword":"new-admin-password"}`)
	if res.StatusCode != 500 {
		t.Fatal(res.StatusCode)
	}
	config, err := a.config.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !auth.MatchesAdmin(config, "test-admin-password") {
		t.Fatal("failed revoke changed credentials")
	}
	if _, err = a.sessions.Validate(context.Background(), token); err != nil {
		t.Fatal(err)
	}
	a.hub.Broadcast(ws.Event{Type: "transaction_rolled_back"})
	requireSocketEvent(t, conn, "transaction_rolled_back")
}

func TestRevokedAdminContextCannotChangeConfiguration(t *testing.T) {
	a, _ := socketTestApp(t)
	token := socketToken(t, a, "admin", time.Hour)
	sess, err := a.sessions.Validate(context.Background(), token)
	if err != nil {
		t.Fatal(err)
	}
	if err = a.sessions.Revoke(context.Background(), token); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		handler http.HandlerFunc
		body    string
	}{
		{a.handleAPIConfigSave, `{"web":{"enabled":false}}`},
		{a.handleGuestPassword, `{"enabled":false}`},
		{a.handleChangePassword, `{"currentPassword":"test-admin-password","newPassword":"new-admin-password"}`},
		{a.handleRevokeAll, `{"confirm":true,"password":"test-admin-password"}`},
	} {
		r := httptest.NewRequest("POST", "/", strings.NewReader(tc.body)).WithContext(auth.WithSession(context.Background(), sess))
		w := httptest.NewRecorder()
		tc.handler(w, r)
		if w.Code != 401 {
			data, _ := json.Marshal(w.Body.String())
			t.Fatalf("stale mutation: %d %s", w.Code, data)
		}
	}
}

// A peer can stop reading after the 101 response. Inject the blocked transport
// write deterministically instead of depending on kernel socket buffer sizes.
type blockedEventConn struct {
	net.Conn
	entered   chan struct{}
	closed    chan struct{}
	writeOnce sync.Once
	closeOnce sync.Once
}

func (c *blockedEventConn) Write(p []byte) (int, error) {
	if bytes.HasPrefix(p, []byte("HTTP/1.1 101")) {
		return c.Conn.Write(p)
	}
	c.writeOnce.Do(func() { close(c.entered) })
	<-c.closed
	return 0, net.ErrClosed
}

func (c *blockedEventConn) Close() error {
	c.closeOnce.Do(func() { close(c.closed) })
	return c.Conn.Close()
}

type blockedEventHijacker struct {
	http.ResponseWriter
	entered chan struct{}
}

func (w blockedEventHijacker) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	c, rw, err := http.NewResponseController(w.ResponseWriter).Hijack()
	if err != nil {
		return nil, nil, err
	}
	return &blockedEventConn{Conn: c, entered: w.entered, closed: make(chan struct{})}, rw, nil
}

func TestWebSocketRevocationAndShutdownInterruptBlockedWriter(t *testing.T) {
	for _, mode := range []string{"logout", "shutdown", "batch_logout", "batch_shutdown"} {
		t.Run(mode, func(t *testing.T) {
			shutdown := strings.HasSuffix(mode, "shutdown")
			a, api := socketTestApp(t)
			entered := make(chan struct{})
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { a.handleWebSocket(blockedEventHijacker{w, entered}, r) }))
			defer srv.Close()
			token := socketToken(t, a, "admin", time.Hour)
			conn := socketDial(t, a, srv, token)
			if strings.HasPrefix(mode, "batch_") {
				events := make([]ws.Event, 500)
				for i := range events {
					events[i] = ws.Event{Type: "blocked_event"}
				}
				a.hub.BroadcastBatch(events)
			} else {
				a.hub.Broadcast(ws.Event{Type: "blocked_event"})
			}
			select {
			case <-entered:
			case <-time.After(time.Second):
				t.Fatal("writer did not enter transport")
			}
			done := make(chan error, 1)
			if shutdown {
				go func() { done <- a.Close() }()
			} else {
				go func() {
					r, _ := http.NewRequest("POST", api.URL+"/api/logout", strings.NewReader(`{}`))
					r.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
					res, err := api.Client().Do(r)
					if err == nil {
						res.Body.Close()
						if res.StatusCode != 200 {
							err = errors.New("logout failed")
						}
					}
					done <- err
				}()
			}
			select {
			case err := <-done:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("blocked writer prevented revocation/shutdown")
			}
			requireSocketClosed(t, conn)
		})
	}
}

func TestWebSocketExpiryRevalidationFailsClosed(t *testing.T) {
	for _, invalid := range []string{"role", "config"} {
		t.Run(invalid, func(t *testing.T) {
			a, srv := socketTestApp(t)
			token := socketToken(t, a, "admin", 750*time.Millisecond)
			conn := socketDial(t, a, srv, token)
			var err error
			if invalid == "role" {
				_, err = a.db.Writer.Exec(`UPDATE web_sessions SET role='guest',expires_at=? WHERE token=?`, time.Now().Add(time.Hour).UnixMilli(), token)
			} else {
				_, err = a.db.Writer.Exec(`UPDATE web_sessions SET expires_at=? WHERE token=?`, time.Now().Add(time.Hour).UnixMilli(), token)
				if err == nil {
					_, err = a.db.Writer.Exec(`UPDATE kv SET value='invalid-json' WHERE key='config'`)
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			requireSocketClosed(t, conn)
		})
	}
}
