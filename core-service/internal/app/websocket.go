package app

import (
	"bufio"
	"context"
	"errors"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/auth"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
	"github.com/gorilla/websocket"
)

// Registration and credential changes share configMu. The registry separately
// owns hijacked sockets, which http.Server.Shutdown does not close or join.
type webSocketRegistry struct {
	mu      sync.Mutex
	wg      sync.WaitGroup
	closed  bool
	clients map[*sessionSocket]struct{}
}

type sessionSocket struct {
	session auth.Session // immutable identity; expiry is local to the writer
	client  *ws.Client
	ctx     context.Context
	cancel  context.CancelFunc
	conn    net.Conn // guarded by webSockets.mu, including the upgrade interval
}

// Caller holds configMu for the complete credential/config operation.
func (a *App) saveAuthConfig(ctx context.Context, config map[string]any, role string) error {
	if err := a.config.SaveRevoking(ctx, config, role); err != nil {
		return err
	}
	if role != "" {
		a.revokeWebSockets("", role)
	}
	return nil
}

// Revalidate after acquiring configMu; middleware may have accepted a session
// just before a concurrent password reset revoked it.
func (a *App) currentAdmin(w http.ResponseWriter, r *http.Request) bool {
	sess, err := a.sessionFromRequest(r)
	if err == nil {
		sess, err = a.validateDashboardSession(r.Context(), sess.Token)
	}
	if err != nil {
		writeJSONError(w, http.StatusUnauthorized, "Unauthorized")
		return false
	}
	if sess.Role != "admin" {
		adminOnly(w)
		return false
	}
	return true
}

// Caller holds configMu. Close the transport before returning the credential
// response, interrupting even a blocked write. Never drain the buffered events
// of a revoked subscriber or wait for a peer to acknowledge a close frame.
func (a *App) revokeWebSockets(token, role string) {
	a.webSockets.mu.Lock()
	defer a.webSockets.mu.Unlock()
	for s := range a.webSockets.clients {
		if token != "" && s.session.Token != token || role != "" && role != "all" && s.session.Role != role {
			continue
		}
		a.stopWebSocket(s)
	}
}

// Caller holds webSockets.mu; only net.Conn.Close may run beside the writer.
func (a *App) stopWebSocket(s *sessionSocket) {
	s.cancel()
	a.hub.Remove(s.client)
	if s.conn != nil {
		_ = s.conn.Close()
	}
}

func (a *App) closeWebSockets() {
	a.webSockets.mu.Lock()
	a.webSockets.closed = true
	for s := range a.webSockets.clients {
		a.stopWebSocket(s)
	}
	a.webSockets.mu.Unlock()
	a.webSockets.wg.Wait()
}

func (a *App) finishWebSocket(s *sessionSocket) {
	a.webSockets.mu.Lock()
	a.stopWebSocket(s)
	delete(a.webSockets.clients, s)
	a.webSockets.mu.Unlock()
	a.webSockets.wg.Done()
}

type sessionHijacker struct {
	http.ResponseWriter
	app    *App
	socket *sessionSocket
}

func (w sessionHijacker) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, rw, err := http.NewResponseController(w.ResponseWriter).Hijack()
	if err != nil {
		return nil, nil, err
	}
	w.app.webSockets.mu.Lock()
	defer w.app.webSockets.mu.Unlock()
	if w.socket.ctx.Err() != nil || w.app.webSockets.closed {
		_ = conn.Close()
		return nil, nil, errors.New("websocket session closed")
	}
	w.socket.conn = conn
	return conn, rw, nil
}

func (a *App) validateDashboardSession(ctx context.Context, token string) (auth.Session, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	sess, err := a.sessions.Validate(ctx, token)
	if err != nil {
		return auth.Session{}, err
	}
	config, err := a.config.Load(ctx)
	if err != nil {
		return auth.Session{}, err
	}
	web, _ := config["web"].(map[string]any)
	if !auth.IsConfigured(config) || !webBoolValue(web, "enabled", true) || sess.Role == "guest" && !webBoolValue(web, "guestEnabled", true) {
		return auth.Session{}, errors.New("dashboard access disabled")
	}
	return sess, nil
}

func (a *App) registerWebSocket(r *http.Request) (*sessionSocket, error) {
	a.configMu.Lock()
	defer a.configMu.Unlock()
	a.webSockets.mu.Lock()
	if a.webSockets.closed || a.ctx.Err() != nil {
		a.webSockets.mu.Unlock()
		return nil, errors.New("server closing")
	}
	// Count validation too: Close must not close the database underneath it.
	a.webSockets.wg.Add(1)
	a.webSockets.mu.Unlock()
	sess, err := a.sessionFromRequest(r)
	if err == nil {
		// The gateway's context can predate a logout waiting on configMu.
		sess, err = a.validateDashboardSession(r.Context(), sess.Token)
	}
	if err != nil {
		a.webSockets.wg.Done()
		return nil, err
	}
	a.webSockets.mu.Lock()
	defer a.webSockets.mu.Unlock()
	if a.webSockets.closed || a.ctx.Err() != nil {
		a.webSockets.wg.Done()
		return nil, errors.New("server closing")
	}
	ctx, cancel := context.WithCancel(r.Context())
	s := &sessionSocket{session: sess, ctx: ctx, cancel: cancel, client: a.hub.Add(sess.Role)}
	if a.webSockets.clients == nil {
		a.webSockets.clients = make(map[*sessionSocket]struct{})
	}
	a.webSockets.clients[s] = struct{}{}
	return s, nil
}

func (a *App) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	s, err := a.registerWebSocket(r)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	defer a.finishWebSocket(s)
	// Subscribe AND own the raw socket before the 101 is observable. Revocation
	// during Upgrade must close the handshake as well as discard queued events.
	upgrader := wsUpgrader
	upgrader.HandshakeTimeout = min(10*time.Second, time.Until(time.UnixMilli(s.session.ExpiresAt)))
	if upgrader.HandshakeTimeout <= 0 {
		return
	}
	conn, err := upgrader.Upgrade(sessionHijacker{w, a, s}, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	conn.SetReadLimit(1 << 20)
	_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(90 * time.Second)) })
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		for {
			if _, _, err := conn.NextReader(); err != nil {
				return
			}
		}
	}()
	defer func() { _ = conn.Close(); <-readDone }()
	expires := time.UnixMilli(s.session.ExpiresAt)
	expiry := time.NewTimer(time.Until(expires))
	defer expiry.Stop()
	heartbeat := time.NewTicker(30 * time.Second)
	defer heartbeat.Stop()
	refresh := func() bool {
		sess, err := a.validateDashboardSession(s.ctx, s.session.Token)
		if err != nil || sess.Role != s.session.Role {
			return false
		}
		// HTTP may have renewed the session. Socket traffic never renews it.
		expires = time.UnixMilli(sess.ExpiresAt)
		expiry.Reset(time.Until(expires))
		return true
	}
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-a.ctx.Done():
			return
		case <-readDone:
			return
		case <-expiry.C:
			if !refresh() {
				return
			}
		case <-heartbeat.C:
			if !refresh() {
				return
			}
			if err := conn.WriteControl(websocket.PingMessage, nil, minTime(time.Now().Add(10*time.Second), expires)); err != nil {
				return
			}
		case event, ok := <-s.client.Events():
			if !ok || s.ctx.Err() != nil || a.ctx.Err() != nil {
				return
			}
			deadline := time.Now().Add(10 * time.Second)
			for _, frame := range event.Frames() {
				if s.ctx.Err() != nil || a.ctx.Err() != nil {
					return
				}
				if !time.Now().Before(expires) && !refresh() {
					return
				}
				_ = conn.SetWriteDeadline(minTime(deadline, expires))
				if err := conn.WriteJSON(frame); err != nil {
					return
				}
			}
		}
	}
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}
