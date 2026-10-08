package app

import (
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type rateWindow struct {
	count int
	reset time.Time
}
type rateLimiter struct {
	mu      sync.Mutex
	window  time.Duration
	limit   int
	clients map[string]rateWindow
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
	}
	l.limit = limit
	l.window = window
}
func (l *rateLimiter) allow(key string, now time.Time) (bool, int, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	current, exists := l.clients[key]
	if !exists || !now.Before(current.reset) {
		// Expired buckets are reclaimed and capacity fails closed, rather than
		// evicting live buckets and allowing brute-force clients another quota.
		for k, entry := range l.clients {
			if !now.Before(entry.reset) {
				delete(l.clients, k)
			}
		}
		if len(l.clients) >= 10000 {
			return false, 0, l.window
		}
		current = rateWindow{reset: now.Add(l.window)}
	}
	if current.count >= l.limit {
		return false, 0, current.reset.Sub(now)
	}
	current.count++
	l.clients[key] = current
	return true, l.limit - current.count, current.reset.Sub(now)
}
func clientKey(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		// The default reverse-proxy trust boundary is loopback. Never accept
		// forwarded IPs from remote peers when choosing an authentication quota.
		if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
			parts := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
			for i := len(parts) - 1; i >= 0; i-- {
				if forwarded := net.ParseIP(strings.TrimSpace(parts[i])); forwarded != nil && !forwarded.IsLoopback() {
					return forwarded.String()
				}
			}
		}
		return host
	}
	return r.RemoteAddr
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
