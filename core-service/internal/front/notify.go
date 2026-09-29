package front

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"time"
)

// What Go has to tell Node, because Node alone writes the database: a
// session in the last quarter of its lifetime needs its expiry pushed out,
// and a file that is gone needs its row pruned (and the dashboard told).
// Go answers the request itself and posts the event to Node afterwards,
// authenticated with the per-spawn token (never reachable by a client: the
// front server drops every X-Tgdl-* request header).
const (
	notifyPath = "/__tgdl/notify"
	hdrNotify  = "X-Tgdl-Notify"
)

// notifyEvery: the same event is not posted again within this time (a
// video is many range requests; Node acts on the first one).
const notifyEvery = 30 * time.Second

// notifyMaxInflight bounds the posts in flight; an event dropped here comes
// again with the next request.
const notifyMaxInflight = 8

type notifier struct {
	sem  chan struct{}
	mu   sync.Mutex
	seen map[string]time.Time
}

func newNotifier() notifier {
	return notifier{sem: make(chan struct{}, notifyMaxInflight), seen: map[string]time.Time{}}
}

// due reports whether the event is new (or old enough to repeat).
func (n *notifier) due(key string) bool {
	now := time.Now()
	n.mu.Lock()
	defer n.mu.Unlock()
	if t, ok := n.seen[key]; ok && now.Sub(t) < notifyEvery {
		return false
	}
	if len(n.seen) >= 1024 {
		for k, t := range n.seen {
			if now.Sub(t) >= notifyEvery {
				delete(n.seen, k)
			}
		}
	}
	n.seen[key] = now
	return true
}

// notify posts {kind, value} to Node in the background and never waits.
func (s *Server) notify(kind, value string) {
	if !s.notes.due(kind + "\x00" + value) {
		return
	}
	select {
	case s.notes.sem <- struct{}{}:
	default:
		return
	}
	go func() {
		defer func() { <-s.notes.sem }()
		body, _ := json.Marshal(map[string]string{"kind": kind, "value": value})
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+s.cfg.Upstream+notifyPath, bytes.NewReader(body))
		if err != nil {
			return
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(hdrNotify, s.cfg.UpstreamToken)
		resp, err := (&http.Client{Transport: s.transport}).Do(req)
		if err != nil {
			s.log.Debug("notify failed", "kind", kind, "err", err)
			return
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
		_ = resp.Body.Close()
	}()
}
