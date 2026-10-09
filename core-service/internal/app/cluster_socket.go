package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/cluster"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
	"github.com/gorilla/websocket"
)

const maxClusterSockets = 256

type clusterSocket struct {
	peer    cluster.Peer
	wake    chan struct{}
	inbound bool
}
type clusterSockets struct {
	app      *App
	mu       sync.Mutex
	sessions map[*websocket.Conn]*clusterSocket
}
type clusterSocketWorker struct {
	peer   cluster.Peer
	cancel context.CancelFunc
	done   chan struct{}
}

func sameSocketPeer(a, b cluster.Peer) bool {
	return a.PeerID == b.PeerID && a.URL == b.URL && b.Status != "revoked" && bytes.Equal(a.Secret, b.Secret)
}

// One supervisor owns discovery, revocation and catalog polling for every
// connection. Each destination has one reconnect worker, each socket one
// reader and one writer. Notifications coalesce; durable HTTP pages carry data.
func (m *clusterSockets) run(ctx context.Context) {
	workers := make(map[string]clusterSocketWorker)
	defer func() {
		for _, w := range workers {
			w.cancel()
		}
		m.mu.Lock()
		for conn := range m.sessions {
			conn.Close()
		}
		m.mu.Unlock()
		for _, w := range workers {
			<-w.done
		}
	}()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	var epoch string
	var revision int64 = -1
	for ctx.Err() == nil {
		pass, cancel := context.WithTimeout(ctx, 3*time.Second)
		peers, err := m.app.cluster.Peers(pass)
		if err == nil {
			current := make(map[string]cluster.Peer, len(peers))
			for _, p := range peers {
				if p.Status != "revoked" {
					current[p.PeerID] = p
				}
			}
			for id, w := range workers {
				if p, ok := current[id]; !ok || !sameSocketPeer(w.peer, p) {
					w.cancel()
				}
				select {
				case <-w.done:
					delete(workers, id)
				default:
				}
			}
			m.mu.Lock()
			for conn, s := range m.sessions {
				if p, ok := current[s.peer.PeerID]; !ok || !sameSocketPeer(s.peer, p) {
					conn.Close()
				}
			}
			m.mu.Unlock()
			for _, p := range peers {
				if len(workers) >= maxClusterSockets/2 {
					break
				}
				if p.Status == "revoked" {
					continue
				}
				if _, ok := workers[p.PeerID]; ok {
					continue
				}
				workerCtx, stop := context.WithCancel(ctx)
				w := clusterSocketWorker{peer: p, cancel: stop, done: make(chan struct{})}
				workers[p.PeerID] = w
				go func() { defer close(w.done); m.connect(workerCtx, w.peer) }()
			}
		} else {
			// Do not keep trusting cached credentials while membership is unreadable.
			m.mu.Lock()
			for conn := range m.sessions {
				conn.Close()
			}
			m.mu.Unlock()
		}
		e, v, err := m.app.cluster.CatalogVersion(pass)
		cancel()
		if err == nil && (e != epoch || v != revision) {
			epoch, revision = e, v
			m.mu.Lock()
			for _, s := range m.sessions {
				select {
				case s.wake <- struct{}{}:
				default:
				}
			}
			m.mu.Unlock()
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (m *clusterSockets) connect(ctx context.Context, p cluster.Peer) {
	backoff := time.Second
	for ctx.Err() == nil {
		attempt, cancel := context.WithTimeout(ctx, 10*time.Second)
		u, err := m.app.clusterHTTP.SocketURL(attempt, p)
		var conn *websocket.Conn
		if err == nil {
			var response *http.Response
			conn, response, err = dialClusterSocket(attempt, u)
			if response != nil && response.Body != nil {
				response.Body.Close()
			}
		}
		cancel()
		if err == nil {
			started := time.Now()
			m.serve(ctx, p, conn, false)
			if time.Since(started) > 30*time.Second {
				backoff = time.Second
			}
		}
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		backoff = min(30*time.Second, backoff*2)
	}
}

func dialClusterSocket(ctx context.Context, target string) (*websocket.Conn, *http.Response, error) {
	// Gorilla applies a deadline to the HTTP handshake, but cancellation after
	// TCP connect alone does not interrupt ReadResponse. Own that socket until
	// the upgrade completes, then hand its lifetime to serve.
	stop := func() bool { return true }
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second, ReadBufferSize: 4096, WriteBufferSize: 4096,
		NetDialContext: func(dialCtx context.Context, network, address string) (net.Conn, error) {
			conn, err := (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext(dialCtx, network, address)
			if err == nil {
				stop = context.AfterFunc(ctx, func() { conn.Close() })
			}
			return conn, err
		},
	}
	conn, res, err := dialer.DialContext(ctx, target, nil)
	stop()
	if ctx.Err() != nil {
		if conn != nil {
			conn.Close()
		}
		return nil, res, ctx.Err()
	}
	return conn, res, err
}

func (a *App) handleClusterSocket(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, 405, "Method not allowed")
		return
	}
	q := r.URL.Query()
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	p, err := a.cluster.VerifyConnect(ctx, q.Get("peer"), q.Get("ts"), q.Get("sig"))
	cancel()
	if err != nil {
		a.clusterAuthError(w, r, err)
		return
	}
	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	a.clusterSockets.serve(r.Context(), p, conn, true)
}

func (m *clusterSockets) serve(parent context.Context, p cluster.Peer, conn *websocket.Conn, inbound bool) {
	defer conn.Close()
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	s := &clusterSocket{peer: p, inbound: inbound, wake: make(chan struct{}, 1)}
	m.mu.Lock()
	count := 0
	for _, v := range m.sessions {
		if v.inbound == inbound && v.peer.PeerID == p.PeerID {
			count++
		}
	}
	if len(m.sessions) >= maxClusterSockets || count >= 2 {
		m.mu.Unlock()
		return
	}
	m.sessions[conn] = s
	m.mu.Unlock()
	defer func() { m.mu.Lock(); delete(m.sessions, conn); m.mu.Unlock() }()
	check, cancelCheck := context.WithTimeout(ctx, 3*time.Second)
	err := m.app.cluster.CurrentPeer(check, p)
	cancelCheck()
	if err != nil {
		return
	}
	conn.SetReadLimit(1 << 20)
	conn.SetReadDeadline(time.Now().Add(40 * time.Second))
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(40 * time.Second)) })
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer cancel()
		for ctx.Err() == nil {
			kind, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if kind != websocket.TextMessage {
				return
			}
			var event cluster.SocketEvent
			if json.Unmarshal(raw, &event) != nil {
				return
			}
			apply, cancelApply := context.WithTimeout(ctx, 5*time.Second)
			err = m.app.cluster.ApplySocketEvent(apply, p, event)
			cancelApply()
			if err != nil {
				return
			}
			conn.SetReadDeadline(time.Now().Add(40 * time.Second))
			switch event.Type {
			case "catalog_changed", "download_added", "download_updated", "download_deleted":
				m.app.wakeClusterSync()
				if event.Type != "catalog_changed" {
					m.app.hub.Broadcast(ws.Event{Type: "peer_catalog_update", Payload: map[string]any{"peerId": p.PeerID}})
				}
			}
		}
	}()
	defer func() { cancel(); conn.Close(); <-done }()
	m.app.wakeClusterSync()
	select {
	case s.wake <- struct{}{}:
	default:
	}
	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()
	for ctx.Err() == nil {
		kind := "catalog_changed"
		select {
		case <-ctx.Done():
			return
		case <-s.wake:
		case <-ping.C:
			kind = "ping"
		}
		attempt, cancelAttempt := context.WithTimeout(ctx, 5*time.Second)
		var payload any = map[string]any{}
		if kind == "catalog_changed" {
			e, v, err := m.app.cluster.CatalogVersion(attempt)
			if err != nil {
				cancelAttempt()
				return
			}
			payload = map[string]any{"epoch": e, "revision": v}
		}
		raw, err := m.app.clusterHTTP.SignEvent(attempt, p, kind, payload)
		cancelAttempt()
		if err != nil {
			return
		}
		conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if err = conn.WriteMessage(websocket.TextMessage, raw); err != nil {
			return
		}
		if kind == "ping" {
			if err = conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second)); err != nil {
				return
			}
		}
	}
}
