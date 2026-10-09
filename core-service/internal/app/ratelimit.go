package app

import (
	"container/heap"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"
)

type rateWindow struct {
	count int
	reset time.Time
}
type rateExpiry struct {
	key   string
	reset time.Time
}
type rateExpiries []rateExpiry

func (h rateExpiries) Len() int           { return len(h) }
func (h rateExpiries) Less(i, j int) bool { return h[i].reset.Before(h[j].reset) }
func (h rateExpiries) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *rateExpiries) Push(x any)        { *h = append(*h, x.(rateExpiry)) }
func (h *rateExpiries) Pop() any {
	old := *h
	n := len(old)
	v := old[n-1]
	old[n-1] = rateExpiry{}
	*h = old[:n-1]
	return v
}

type rateLimiter struct {
	mu      sync.Mutex
	window  time.Duration
	limit   int
	clients map[string]rateWindow
	expires rateExpiries
	message string
}

func newRateLimiter(limit int, window time.Duration) *rateLimiter {
	return &rateLimiter{limit: limit, window: window, clients: make(map[string]rateWindow), message: "Too many login attempts. Try again in 15 minutes."}
}

func (l *rateLimiter) configure(limit int, window time.Duration) {
	if limit <= 0 {
		limit = 60
	}
	if window <= 0 {
		window = time.Minute
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if window != l.window {
		l.clients = make(map[string]rateWindow)
		l.expires = nil
	}
	l.limit = limit
	l.window = window
}
func (l *rateLimiter) allow(key string, now time.Time) (bool, int, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.allowLocked(key, now, l.limit)
}
func (l *rateLimiter) allowPolicy(key string, now time.Time, limit int, window time.Duration) (bool, int, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.window != window {
		l.clients = make(map[string]rateWindow)
		l.expires = nil
		l.window = window
	}
	return l.allowLocked(key, now, limit)
}
func (l *rateLimiter) allowLocked(key string, now time.Time, limit int) (bool, int, time.Duration) {
	// Expire each bucket once, rather than scanning the whole client map for
	// every newly observed address. Live buckets are never evicted for space.
	for len(l.expires) > 0 && !now.Before(l.expires[0].reset) {
		expired := heap.Pop(&l.expires).(rateExpiry)
		delete(l.clients, expired.key)
	}
	current, exists := l.clients[key]
	if !exists {
		if len(l.clients) >= 10000 {
			return false, 0, l.window
		}
		current = rateWindow{reset: now.Add(l.window)}
		heap.Push(&l.expires, rateExpiry{key, current.reset})
	}
	if current.count >= limit {
		return false, 0, current.reset.Sub(now)
	}
	current.count++
	l.clients[key] = current
	return true, limit - current.count, current.reset.Sub(now)
}
func clientKey(r *http.Request) string {
	n := networkForRequest(r)
	if n.client.IsValid() {
		return n.client.String()
	}
	return "invalid-client"
}
func (l *rateLimiter) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		allowed, remaining, reset := l.allow(clientKey(r), time.Now())
		l.mu.Lock()
		limit, window, message := l.limit, l.window, l.message
		l.mu.Unlock()
		seconds := int((reset + time.Second - 1) / time.Second)
		w.Header().Set("RateLimit", fmt.Sprintf("limit=%d, remaining=%d, reset=%d", limit, remaining, seconds))
		w.Header().Set("RateLimit-Policy", fmt.Sprintf("%d;w=%d", limit, int(window/time.Second)))
		if !allowed {
			w.Header().Set("Retry-After", strconv.Itoa(seconds))
			writeJSONError(w, 429, message)
			return
		}
		next.ServeHTTP(w, r)
	})
}
