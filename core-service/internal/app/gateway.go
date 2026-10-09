package app

import (
	"fmt"
	"html"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/auth"
	"github.com/gorilla/websocket"
)

// gateway applies transport and access policy before mux route selection, so
// adding a handler or requesting an unknown route cannot bypass the policy.
func (a *App) gateway(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store, max-age=0")
			w.Header().Set("Pragma", "no-cache")
			w.Header().Set("Vary", a.apiVary(r))
		} else if !strings.HasPrefix(r.URL.Path, "/share/") {
			w.Header().Set("Vary", "Accept-Encoding")
		}
		if mutatingMethod(r.Method) {
			if message := originError(r); message != "" {
				writeJSONError(w, 403, message)
				return
			}
		}
		// Auth routes do their own checks so change-password shares the login
		// limiter even when the supplied session is missing or expired.
		if isPublicPath(r.URL.Path) || isAuthRoute(r.URL.Path) || r.URL.Path == "/api/logout" {
			next.ServeHTTP(w, r)
			return
		}
		config, err := a.config.Load(r.Context())
		if err != nil {
			writeJSONError(w, 500, "Internal error")
			return
		}
		web, _ := config["web"].(map[string]any)
		upgrade := websocket.IsWebSocketUpgrade(r)
		if !auth.IsConfigured(config) || !webBoolValue(web, "enabled", true) {
			if strings.HasPrefix(r.URL.Path, "/api/") || upgrade || strings.HasPrefix(r.URL.Path, "/v1/") {
				writeJSON(w, 503, map[string]any{"error": "Web dashboard not initialised. Run `npm run auth` to set a password.", "setupRequired": true})
			} else {
				redirect(w, r, "/setup-needed.html")
			}
			return
		}
		// File bearer tokens intentionally authorize only the media mount. They
		// are checked before the normal cookie path so a shared file can be
		// opened without exposing any API or dashboard session.
		if (r.Method == http.MethodGet || r.Method == http.MethodHead) && strings.HasPrefix(r.URL.Path, "/files/") {
			if role, ok := a.fileTokenRole(r.Context(), r.URL.Query().Get("token")); ok {
				// The route only needs the role. Keep the synthetic context free of
				// a cookie token so it can never be renewed or revoked as a session.
				r = r.WithContext(auth.WithSession(r.Context(), auth.Session{Role: role}))
				next.ServeHTTP(w, r)
				return
			}
		}
		sess, err := a.sessionFromRequest(r)
		if err != nil {
			if strings.HasPrefix(r.URL.Path, "/api/") || upgrade || strings.HasPrefix(r.URL.Path, "/v1/") {
				writeJSONError(w, 401, "Unauthorized")
			} else {
				redirect(w, r, "/login.html")
			}
			return
		}
		if sess.Role == "guest" && (strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/v1/")) && !guestAllowed(r) {
			adminOnly(w)
			return
		}
		if ttl, err := a.sessions.Renew(r.Context(), sess); err != nil {
			writeJSONError(w, 500, "Internal error")
			return
		} else if ttl > 0 {
			a.setSessionCookie(w, sess.Token, ttl)
		}
		r = r.WithContext(auth.WithSession(r.Context(), sess))
		if strings.HasPrefix(r.URL.Path, "/files/") && strings.TrimPrefix(r.URL.Path, "/files/") == "" {
			fileMountNotFound(w, r)
			return
		}
		if upgrade && (r.URL.Path == "/" || r.URL.Path == "/ws") {
			a.handleWebSocket(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *App) apiVary(r *http.Request) string {
	if compressionRequestOptOut(r) || a.httpOptions.CompressionLevel != nil && *a.httpOptions.CompressionLevel == 0 {
		return "Cookie"
	}
	return "Cookie, Accept-Encoding"
}

func isAuthRoute(path string) bool {
	switch path {
	case "/api/auth/setup", "/api/auth/change-password", "/api/auth/guest-password", "/api/auth/reset/request", "/api/auth/reset/confirm":
		return true
	}
	return false
}

func isPublicPath(p string) bool {
	switch p {
	case "/health", "/api/login", "/api/auth_check", "/api/version", "/api/version/check":
		return true
	}
	for _, pre := range []string{"/login", "/setup-needed", "/js/", "/css/", "/locales/", "/icons/", "/favicon", "/manifest.webmanifest", "/sw.js", "/metrics", "/share/"} {
		if strings.HasPrefix(p, pre) {
			return true
		}
	}
	return false
}

func guestAllowed(r *http.Request) bool {
	if r.Method == "POST" && r.URL.Path == "/api/logout" {
		return true
	}
	if r.Method != "GET" {
		return false
	}
	for _, pre := range []string{"/api/auth_check", "/api/me", "/api/version", "/api/downloads", "/api/groups", "/api/stats", "/api/thumbs", "/api/seekbar/sprite", "/api/seekbar/meta", "/api/monitor/status", "/api/files/token"} {
		if r.URL.Path == pre || strings.HasPrefix(r.URL.Path, pre+"/") {
			return true
		}
	}
	return false
}

func (a *App) sessionFromRequest(r *http.Request) (auth.Session, error) {
	if sess, ok := auth.SessionFromContext(r.Context()); ok {
		return sess, nil
	}
	// Retain the last duplicate cookie, matching the existing parser.
	var token string
	for _, cookie := range r.Cookies() {
		if cookie.Name == a.sessions.CookieName() {
			token = cookie.Value
		}
	}
	if decoded, err := url.PathUnescape(token); err == nil {
		token = decoded
	}
	return a.sessions.Validate(r.Context(), token)
}

func (a *App) requireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sess, err := a.sessionFromRequest(r)
		if err != nil {
			writeJSONError(w, 401, "Unauthorized")
			return
		}
		next.ServeHTTP(w, r.WithContext(auth.WithSession(r.Context(), sess)))
	})
}
func (a *App) requireAdmin(next http.Handler) http.Handler {
	return a.requireSession(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sess, _ := auth.SessionFromContext(r.Context())
		if sess.Role != "admin" {
			adminOnly(w)
			return
		}
		next.ServeHTTP(w, r)
	}))
}
func adminOnly(w http.ResponseWriter) {
	writeJSON(w, 403, map[string]any{"error": "Admin only", "adminRequired": true})
}

func mutatingMethod(method string) bool {
	return method == "POST" || method == "PUT" || method == "PATCH" || method == "DELETE"
}
func originError(r *http.Request) string {
	value := r.Header.Get("Origin")
	if value == "" {
		value = r.Header.Get("Referer")
	}
	if value == "" {
		return ""
	}
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "Invalid Origin/Referer"
	}
	if strings.EqualFold(u.Host, r.Host) {
		return ""
	}
	expected := &url.URL{Host: r.Host}
	if localHost(u.Hostname()) && localHost(expected.Hostname()) && u.Port() == expected.Port() {
		return ""
	}
	return "Cross-origin request blocked"
}
func localHost(host string) bool {
	return strings.EqualFold(host, "localhost") || host == "127.0.0.1" || host == "::1"
}

// Proxied bootstrap requests are never considered local. In particular,
// publishing the dashboard through a loopback reverse proxy must not permit
// a remote caller to claim the first admin password.
func localBootstrap(r *http.Request) bool {
	if r.Header.Get("Forwarded") != "" || r.Header.Get("X-Forwarded-For") != "" {
		return false
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func redirect(w http.ResponseWriter, r *http.Request, location string) {
	w.Header().Set("Location", location)
	w.Header().Set("Vary", "Accept, Accept-Encoding")
	if strings.HasPrefix(r.URL.Path, "/files/") {
		w.Header().Set("Cache-Control", "private, max-age=2592000, immutable")
		w.Header().Set("Vary", "Accept")
	} else if strings.HasPrefix(r.URL.Path, "/photos/") {
		w.Header().Set("Cache-Control", "private, max-age=86400, stale-while-revalidate=604800")
		w.Header().Set("Vary", "Accept")
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusFound)
	if r.Method != "HEAD" {
		fmt.Fprintf(w, "Found. Redirecting to %s", location)
	}
}
func writeNotFound(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Security-Policy", "default-src 'none'")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusNotFound)
	if r.Method != "HEAD" {
		fmt.Fprintf(w, "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot %s %s</pre>\n</body>\n</html>\n", html.EscapeString(r.Method), html.EscapeString(r.URL.EscapedPath()))
	}
}

func (a *App) setSessionCookie(w http.ResponseWriter, token string, ttl time.Duration) {
	http.SetCookie(w, &http.Cookie{Name: a.sessions.CookieName(), Value: token, Path: "/", MaxAge: int(ttl / time.Second), Expires: time.Now().Add(ttl), HttpOnly: true, Secure: a.secureCookies, SameSite: http.SameSiteStrictMode})
}
