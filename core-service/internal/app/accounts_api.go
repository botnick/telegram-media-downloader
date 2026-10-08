package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/botnick/telegram-media-downloader/core-service/internal/accounts"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

func registerAccountRoutes(mux *http.ServeMux, a *App) {
	mux.Handle("GET /api/accounts", a.requireAdmin(http.HandlerFunc(a.handleAccounts)))
	mux.Handle("POST /api/accounts/auth/begin", a.requireAdmin(http.HandlerFunc(a.handleAccountBegin)))
	for _, step := range []string{"phone", "code", "2fa", "cancel"} {
		step := step
		mux.Handle("POST /api/accounts/auth/"+step, a.requireAdmin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { a.handleAccountStep(w, r, step) })))
	}
	mux.Handle("GET /api/accounts/auth/{sessionId}", a.requireAdmin(http.HandlerFunc(a.handleAccountStatus)))
	mux.Handle("DELETE /api/accounts/{id}", a.requireAdmin(http.HandlerFunc(a.handleAccountRemove)))
}
func (a *App) telegramCredentials(ctx context.Context) (telegram.GotdConfig, error) {
	cfg, err := a.config.Load(ctx)
	if err != nil {
		return telegram.GotdConfig{}, err
	}
	api, _ := cfg["telegram"].(map[string]any)
	id := int(number(api["apiId"], 0))
	hash := strings.TrimSpace(toString(api["apiHash"]))
	if id <= 0 || hash == "" {
		return telegram.GotdConfig{}, errNoAPICredentials
	}
	proxy, err := telegram.ParseProxy(cfg["proxy"])
	if err != nil {
		return telegram.GotdConfig{}, err
	}
	return telegram.GotdConfig{AppID: id, AppHash: hash, Proxy: proxy}, nil
}
func (a *App) accountError(w http.ResponseWriter, err error, step bool) {
	if errors.Is(err, errNoAPICredentials) {
		if step {
			writeJSONError(w, 400, "Telegram API credentials not configured")
		} else {
			writeJSON(w, 503, map[string]any{"error": errNoAPICredentials.Error(), "code": "NO_API_CREDS"})
		}
		return
	}
	writeJSONError(w, 400, err.Error())
}
func (a *App) handleAccounts(w http.ResponseWriter, r *http.Request) {
	saved, err := telegram.SavedSessions(a.dataDir)
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	cfg, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	metadata := map[string]map[string]any{}
	all, _ := cfg["accounts"].([]any)
	for _, raw := range all {
		if meta, ok := raw.(map[string]any); ok {
			metadata[toString(meta["id"])] = meta
		}
	}
	out := make([]map[string]any, 0, len(saved))
	for i, s := range saved {
		meta := metadata[s.ID]
		name := toString(meta["name"])
		if name == "" {
			name = s.ID
		}
		out = append(out, map[string]any{"id": s.ID, "name": name, "username": toString(meta["username"]), "phone": toString(meta["phone"]), "isDefault": i == 0})
	}
	writeJSON(w, 200, out)
}
func (a *App) handleAccountBegin(w http.ResponseWriter, r *http.Request) {
	cfg, err := a.telegramCredentials(r.Context())
	if err != nil {
		a.accountError(w, err, false)
		return
	}
	var body struct {
		Label string `json:"label"`
	}
	if err = decodeBody(w, r, &body); err != nil {
		writeJSONError(w, 400, "Invalid body")
		return
	}
	label, err := accounts.NormalizeLabel(body.Label)
	if err != nil {
		a.accountError(w, err, false)
		return
	}
	if label != "" {
		exists, e := a.accounts.Exists(r.Context(), label)
		if e != nil {
			a.accountError(w, e, false)
			return
		}
		if exists {
			a.accountError(w, fmt.Errorf("Account %q already exists", label), false)
			return
		}
	}
	cfg.SessionSecret, err = a.accounts.Secret(r.Context())
	if err != nil {
		a.accountError(w, err, false)
		return
	}
	result, err := a.accountWizard.Begin(r.Context(), cfg, label)
	if err != nil {
		a.accountError(w, err, false)
		return
	}
	writeJSON(w, 200, result)
}
func (a *App) handleAccountStep(w http.ResponseWriter, r *http.Request, step string) {
	// Check credentials first for the existing route-specific missing-setup
	// errors. A live flow can still be cancelled after settings are changed.
	var body struct {
		SessionID string `json:"sessionId"`
		Phone     string `json:"phone"`
		Code      string `json:"code"`
		Password  string `json:"password"`
	}
	decodeErr := decodeBody(w, r, &body)
	_, known := a.accountWizard.Status(body.SessionID)
	if !known {
		if _, err := a.telegramCredentials(r.Context()); err != nil {
			a.accountError(w, err, true)
			return
		}
	}
	if decodeErr != nil {
		writeJSONError(w, 400, "Invalid body")
		return
	}
	if step == "cancel" {
		found, err := a.accountWizard.Cancel(r.Context(), body.SessionID)
		if err != nil {
			a.accountError(w, err, true)
			return
		}
		if !found {
			writeJSON(w, 200, map[string]any{"ok": false, "reason": "not_found"})
		} else {
			writeJSON(w, 200, map[string]any{"ok": true})
		}
		return
	}
	value := body.Phone
	if step == "code" {
		value = body.Code
	} else if step == "2fa" {
		step = "password"
		value = body.Password
	}
	result, err := a.accountWizard.Submit(r.Context(), body.SessionID, step, value)
	if err != nil {
		a.accountError(w, err, true)
		return
	}
	writeJSON(w, 200, result)
}
func (a *App) handleAccountStatus(w http.ResponseWriter, r *http.Request) {
	if status, found := a.accountWizard.Status(r.PathValue("sessionId")); found {
		writeJSON(w, 200, status)
		return
	}
	if _, err := a.telegramCredentials(r.Context()); err != nil {
		a.accountError(w, err, false)
		return
	}
	writeJSONError(w, 404, "Auth session not found")
}
func (a *App) publishAccount(ctx context.Context, p accounts.PendingAccount) (string, error) {
	handedOff := false
	defer func() {
		if !handedOff {
			_ = os.Remove(p.SessionPath)
		}
	}()
	a.monitorOp.Lock()
	defer a.monitorOp.Unlock()
	if err := ctx.Err(); err != nil {
		return "", err
	}
	status, err := a.monitor.Status(ctx)
	if err != nil {
		return "", err
	}
	restart := status["state"] == "running"
	if err = a.accounts.Recover(ctx); err != nil {
		return "", err
	}
	// Repository.Publish removes an unjournaled temporary file itself, while a
	// journaled failure must retain it for startup recovery.
	handedOff = true
	id, err := a.accounts.Publish(ctx, p)
	if err != nil {
		return "", err
	}
	// The old monitor only owns the sessions that existed at its start. Keep
	// it running until publication has committed, so a collision or any other
	// publication error cannot take healthy existing accounts offline.
	a.hub.Broadcast(ws.Event{Type: "config_updated"})
	if err = a.monitor.Stop(ctx); err != nil {
		if a.output != nil {
			fmt.Fprintf(a.output, "Account saved; monitor stop for refresh failed: %v\n", err)
		}
		return id, nil
	}
	a.restartAfterAccountsChange(restart)
	return id, nil
}
func (a *App) restartAfterAccountsChange(restart bool) {
	if !restart || a.ctx.Err() != nil {
		return
	}
	saved, err := telegram.SavedSessions(a.dataDir)
	if err == nil && len(saved) > 0 {
		err = a.startMonitor(a.ctx)
	}
	if err != nil && a.output != nil {
		fmt.Fprintf(a.output, "Account saved; monitor restart failed: %v\n", err)
	}
}
func (a *App) handleAccountRemove(w http.ResponseWriter, r *http.Request) {
	if _, err := a.telegramCredentials(r.Context()); err != nil {
		a.accountError(w, err, false)
		return
	}
	a.monitorOp.Lock()
	defer a.monitorOp.Unlock()
	id := r.PathValue("id")
	found, err := a.accounts.Exists(r.Context(), id)
	if err != nil {
		a.accountError(w, err, false)
		return
	}
	if !found {
		writeJSONError(w, 404, "Account not found")
		return
	}
	status, err := a.monitor.Status(r.Context())
	if err != nil {
		a.accountError(w, err, false)
		return
	}
	restart := status["state"] == "running"
	err = a.monitor.Stop(r.Context())
	stopped := err == nil
	if err == nil {
		err = a.accounts.Recover(r.Context())
	}
	if err == nil {
		err = a.accounts.Remove(r.Context(), id)
	}
	if err != nil {
		// Removal is journaled and can fail at either the pre-commit or
		// recovery boundary. Reopen the previous monitor after the error so a
		// transient config/DB failure never strands healthy accounts stopped.
		if restart && stopped {
			a.restartAfterAccountsChange(true)
		}
		a.accountError(w, err, false)
		return
	}
	a.hub.Broadcast(ws.Event{Type: "config_updated"})
	a.restartAfterAccountsChange(restart)
	writeJSON(w, 200, map[string]any{"success": true})
}
