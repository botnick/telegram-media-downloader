package app

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
	"unicode/utf16"

	"github.com/botnick/telegram-media-downloader/core-service/internal/auth"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

func (a *App) handleAuthCheck(w http.ResponseWriter, r *http.Request) {
	config, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, 500, "Internal error")
		return
	}
	web, _ := config["web"].(map[string]any)
	configured, enabled := auth.IsConfigured(config), webBoolValue(web, "enabled", true)
	var role any
	if configured && enabled {
		if sess, err := a.sessionFromRequest(r); err == nil {
			role = sess.Role
		}
	}
	writeJSON(w, 200, map[string]any{"configured": configured, "enabled": enabled, "authenticated": role != nil, "role": role, "setupRequired": !configured || !enabled, "guestEnabled": auth.GuestEnabled(config)})
}

func readAuthBody(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	var body map[string]any
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20))
	if err := dec.Decode(&body); err != nil && !errors.Is(err, io.EOF) {
		writeJSONError(w, 400, "Invalid JSON body")
		return nil, false
	}
	return body, true
}
func passwordLength(password string) int { return len(utf16.Encode([]rune(password))) }

func (a *App) handleLogin(w http.ResponseWriter, r *http.Request) {
	body, ok := readAuthBody(w, r)
	if !ok {
		return
	}
	password, ok := body["password"].(string)
	if !ok || password == "" {
		writeJSONError(w, 400, "Password required")
		return
	}
	// Verification and issuance form one credential operation. A guest disable
	// or reset cannot revoke the old sessions and then be followed by issuance
	// based on a password verified before that change.
	a.configMu.Lock()
	defer a.configMu.Unlock()
	role, configured, err := a.config.Login(r.Context(), password)
	if err != nil {
		writeJSONError(w, 500, "Internal error")
		return
	}
	if !configured {
		writeJSON(w, 503, map[string]any{"error": "Web dashboard not initialised. Run `npm run auth`.", "setupRequired": true})
		return
	}
	if role == "" {
		writeJSONError(w, 401, "Invalid password")
		return
	}
	// Persist a hash for successful legacy logins, leaving other config intact.
	if role == "admin" {
		config, loadErr := a.config.Load(r.Context())
		web, _ := config["web"].(map[string]any)
		if loadErr == nil && web["passwordHash"] == nil && auth.MatchesAdmin(config, password) {
			loadErr = a.config.SetAdminPassword(r.Context(), password)
		}
		if loadErr != nil {
			writeJSONError(w, 500, "Internal error")
			return
		}
	}
	if !a.issueSession(w, r, role) {
		return
	}
	writeJSON(w, 200, map[string]any{"success": true, "role": role})
}

func (a *App) handleSetup(w http.ResponseWriter, r *http.Request) {
	body, ok := readAuthBody(w, r)
	if !ok {
		return
	}
	password, ok := body["password"].(string)
	if !ok || passwordLength(password) < 8 {
		writeJSONError(w, 400, "Password must be at least 8 characters")
		return
	}
	a.configMu.Lock()
	defer a.configMu.Unlock()
	config, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, 500, "Internal error")
		return
	}
	if auth.IsConfigured(config) {
		writeJSONError(w, 409, "Already configured — use POST /api/auth/change-password")
		return
	}
	if !localBootstrap(r) {
		writeJSONError(w, 403, "Initial setup must be done from the local machine. Run `npm run auth` instead.")
		return
	}
	if err := a.config.SetAdminPassword(r.Context(), password); err != nil {
		writeJSONError(w, 500, "Internal error")
		return
	}
	if !a.issueSession(w, r, "admin") {
		return
	}
	writeJSON(w, 200, map[string]any{"success": true})
}

func (a *App) handleLogout(w http.ResponseWriter, r *http.Request) {
	a.configMu.Lock()
	defer a.configMu.Unlock()
	if sess, err := a.sessionFromRequest(r); err == nil {
		if err := a.sessions.Revoke(r.Context(), sess.Token); err != nil {
			writeJSONError(w, 500, "Internal error")
			return
		}
		a.revokeWebSockets(sess.Token, "")
	}
	http.SetCookie(w, &http.Cookie{Name: a.sessions.CookieName(), Value: "", Path: "/", Expires: time.Unix(0, 0), HttpOnly: true, Secure: a.secureCookies, SameSite: http.SameSiteStrictMode})
	writeJSON(w, 200, map[string]any{"success": true})
}

func (a *App) issueSession(w http.ResponseWriter, r *http.Request, role string) bool {
	config, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, 500, "Internal error")
		return false
	}
	ttl := a.sessions.TTL()
	advanced, _ := config["advanced"].(map[string]any)
	web, _ := advanced["web"].(map[string]any)
	days, ok := web["sessionTtlDays"].(float64)
	if text, textOK := web["sessionTtlDays"].(string); textOK {
		days, err = strconv.ParseFloat(text, 64)
		ok = err == nil
	}
	if ok && days >= 1 && days <= 365 {
		ttl = time.Duration(days * float64(24*time.Hour))
	}
	token, err := a.sessions.CreateWithTTL(r.Context(), role, ttl)
	if err != nil {
		writeJSONError(w, 500, "Internal error")
		return false
	}
	a.setSessionCookie(w, token, ttl)
	return true
}

func (a *App) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	body, ok := readAuthBody(w, r)
	if !ok {
		return
	}
	current, currentOK := body["currentPassword"].(string)
	next, nextOK := body["newPassword"].(string)
	if !currentOK || !nextOK {
		writeJSONError(w, 400, "currentPassword and newPassword required")
		return
	}
	if passwordLength(next) < 8 {
		writeJSONError(w, 400, "New password must be at least 8 characters")
		return
	}
	a.configMu.Lock()
	defer a.configMu.Unlock()
	if !a.currentAdmin(w, r) {
		return
	}
	config, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, 500, "Internal error")
		return
	}
	if !auth.IsConfigured(config) {
		writeJSONError(w, 409, "No password configured yet — use /api/auth/setup")
		return
	}
	if !auth.MatchesAdmin(config, current) {
		writeJSONError(w, 401, "Current password is incorrect")
		return
	}
	web, _ := config["web"].(map[string]any)
	if auth.MatchesHash(next, web["guestPasswordHash"]) {
		writeJSON(w, 400, map[string]any{"error": "New password must differ from the guest password", "code": "SAME_AS_GUEST"})
		return
	}
	hash, err := auth.HashPassword(next)
	if err != nil {
		writeJSONError(w, 500, "Internal error")
		return
	}
	web["passwordHash"] = hash.JSON()
	web["enabled"] = true
	delete(web, "password")
	if err := a.saveAuthConfig(r.Context(), config, "admin"); err != nil {
		writeJSONError(w, 500, "Internal error")
		return
	}
	if !a.issueSession(w, r, "admin") {
		return
	}
	writeJSON(w, 200, map[string]any{"success": true})
}

func (a *App) handleGuestPassword(w http.ResponseWriter, r *http.Request) {
	body, ok := readAuthBody(w, r)
	if !ok {
		return
	}
	a.configMu.Lock()
	defer a.configMu.Unlock()
	if !a.currentAdmin(w, r) {
		return
	}
	config, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, 500, "Internal error")
		return
	}
	web := ensureMap(config, "web")
	revoke := false
	password, _ := body["password"].(string)
	if body["clear"] == true {
		delete(web, "guestPasswordHash")
		web["guestEnabled"] = false
		revoke = true
	} else if password != "" {
		if passwordLength(password) < 8 {
			writeJSONError(w, 400, "Guest password must be at least 8 characters")
			return
		}
		if auth.MatchesAdmin(config, password) {
			writeJSON(w, 400, map[string]any{"error": "Guest password must differ from the admin password", "code": "SAME_AS_ADMIN"})
			return
		}
		hash, err := auth.HashPassword(password)
		if err != nil {
			writeJSONError(w, 500, "Internal error")
			return
		}
		web["guestPasswordHash"] = hash.JSON()
		web["guestEnabled"] = true
		revoke = true
	} else if enabled, ok := body["enabled"].(bool); ok {
		if enabled && web["guestPasswordHash"] == nil {
			writeJSONError(w, 400, "Set a guest password before enabling guest access")
			return
		}
		web["guestEnabled"] = enabled
		revoke = !enabled
	} else {
		writeJSONError(w, 400, "Provide one of: password, enabled, clear")
		return
	}
	role := ""
	if revoke {
		role = "guest"
	}
	if err := a.saveAuthConfig(r.Context(), config, role); err != nil {
		writeJSONError(w, 500, "Internal error")
		return
	}
	a.hub.Broadcast(ws.Event{Type: "config_updated"})
	writeJSON(w, 200, map[string]any{"success": true, "configured": web["guestPasswordHash"] != nil, "enabled": webBoolValue(web, "guestEnabled", true)})
}

func (a *App) handleResetRequest(w http.ResponseWriter, r *http.Request) {
	config, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, 500, "Internal error")
		return
	}
	if !auth.IsConfigured(config) {
		writeJSONError(w, 409, "No password configured yet — use /api/auth/setup")
		return
	}
	if a.output == nil {
		writeJSONError(w, 503, "Operator output is not configured")
		return
	}
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		writeJSONError(w, 500, "Internal error")
		return
	}
	token := hex.EncodeToString(raw[:])
	now := time.Now()
	a.resetMu.Lock()
	for key, expiry := range a.resetTokens {
		if !now.Before(expiry) {
			delete(a.resetTokens, key)
		}
	}
	if len(a.resetTokens) >= 50 {
		var oldest string
		var expires time.Time
		for key, expiry := range a.resetTokens {
			if oldest == "" || expiry.Before(expires) {
				oldest, expires = key, expiry
			}
		}
		delete(a.resetTokens, oldest)
	}
	a.resetTokens[token] = now.Add(10 * time.Minute)
	_, err = fmt.Fprintf(a.output, "Dashboard password reset — valid for 10 minutes, single use.\nToken: %s\n", token)
	if err != nil {
		delete(a.resetTokens, token)
	}
	a.resetMu.Unlock()
	if err != nil {
		writeJSONError(w, 500, "Operator output failed")
		return
	}
	writeJSON(w, 200, map[string]any{"success": true, "ttlSeconds": 600})
}

func (a *App) handleResetConfirm(w http.ResponseWriter, r *http.Request) {
	body, ok := readAuthBody(w, r)
	if !ok {
		return
	}
	token, tokenOK := body["token"].(string)
	password, passwordOK := body["newPassword"].(string)
	if !tokenOK || !passwordOK {
		writeJSONError(w, 400, "token and newPassword required")
		return
	}
	if passwordLength(password) < 8 {
		writeJSONError(w, 400, "New password must be at least 8 characters")
		return
	}
	a.resetMu.Lock()
	expires, exists := a.resetTokens[token]
	delete(a.resetTokens, token)
	a.resetMu.Unlock()
	if !exists || !time.Now().Before(expires) {
		writeJSONError(w, 401, "Invalid or expired token")
		return
	}
	a.configMu.Lock()
	defer a.configMu.Unlock()
	config, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, 500, "Internal error")
		return
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		writeJSONError(w, 500, "Internal error")
		return
	}
	web := ensureMap(config, "web")
	web["passwordHash"] = hash.JSON()
	web["enabled"] = true
	delete(web, "password")
	if err := a.saveAuthConfig(r.Context(), config, "all"); err != nil {
		writeJSONError(w, 500, "Internal error")
		return
	}
	if !a.issueSession(w, r, "admin") {
		return
	}
	writeJSON(w, 200, map[string]any{"success": true})
}
