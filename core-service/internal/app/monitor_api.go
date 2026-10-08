package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
	"github.com/gotd/td/tg"
)

var errNoAPICredentials = errors.New("Telegram API credentials not configured. Add telegram.apiId and telegram.apiHash in Settings first.")
var errNoAccounts = errors.New("No Telegram accounts loaded. Add one in Settings → Accounts first.")

func registerMonitorRoutes(mux *http.ServeMux, a *App) {
	mux.Handle("POST /api/monitor/start", a.requireAdmin(http.HandlerFunc(a.handleMonitorStart)))
	mux.Handle("POST /api/monitor/stop", a.requireAdmin(http.HandlerFunc(a.handleMonitorStop)))
	mux.Handle("POST /api/monitor/restart", a.requireAdmin(http.HandlerFunc(a.handleMonitorRestart)))
}
func (a *App) startMonitor(ctx context.Context) error {
	if err := a.accounts.Recover(ctx); err != nil {
		return err
	}
	cfg, err := a.config.Load(ctx)
	if err != nil {
		return err
	}
	api, _ := cfg["telegram"].(map[string]any)
	appID := int(number(api["apiId"], 0))
	appHash := strings.TrimSpace(toString(api["apiHash"]))
	if appID <= 0 || appHash == "" {
		return errNoAPICredentials
	}
	saved, err := telegram.SavedSessions(a.dataDir)
	if err != nil {
		return err
	}
	if len(saved) == 0 {
		return errNoAccounts
	}
	secret, err := os.ReadFile(filepath.Join(a.dataDir, "secret.key"))
	if err != nil {
		return fmt.Errorf("read Telegram session encryption secret: %w", err)
	}
	if len(strings.TrimSpace(string(secret))) == 0 {
		return errors.New("Telegram session encryption secret is empty")
	}
	names := map[string]string{}
	if accounts, ok := cfg["accounts"].([]any); ok {
		for _, raw := range accounts {
			if account, ok := raw.(map[string]any); ok {
				names[toString(account["id"])] = toString(account["name"])
			}
		}
	}
	specs := make([]engine.AccountConfig, 0, len(saved))
	for _, saved := range saved {
		specs = append(specs, engine.AccountConfig{ID: saved.ID, Name: names[saved.ID], Telegram: telegram.GotdConfig{AppID: appID, AppHash: appHash, SessionPath: saved.NativePath, EncryptedSessionPath: saved.ImportPath, SessionSecret: strings.TrimSpace(string(secret))}})
	}
	download, _ := cfg["download"].(map[string]any)
	return a.monitor.Start(ctx, a.ctx, specs, int(number(download["concurrent"], 10)), int(number(download["retries"], 5)))
}
func (a *App) setAutoStart(ctx context.Context, value bool) error {
	a.configMu.Lock()
	defer a.configMu.Unlock()
	cfg, err := a.config.Load(ctx)
	if err != nil {
		return err
	}
	ensureMap(cfg, "monitor")["autoStart"] = value
	return a.config.Save(ctx, cfg)
}
func (a *App) writeMonitorResult(w http.ResponseWriter, r *http.Request, err error) {
	if err != nil {
		switch {
		case errors.Is(err, errNoAPICredentials):
			writeJSON(w, 503, map[string]any{"error": err.Error(), "code": "NO_API_CREDS"})
		case errors.Is(err, errNoAccounts):
			writeJSONError(w, 409, err.Error())
		default:
			writeJSONError(w, 500, err.Error())
		}
		return
	}
	status, err := a.monitor.Status(r.Context())
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"success": true, "status": status})
}
func (a *App) handleMonitorStart(w http.ResponseWriter, r *http.Request) {
	a.monitorOp.Lock()
	defer a.monitorOp.Unlock()
	err := a.startMonitor(r.Context())
	if err == nil {
		err = a.setAutoStart(r.Context(), true)
	}
	a.writeMonitorResult(w, r, err)
}
func (a *App) handleMonitorStop(w http.ResponseWriter, r *http.Request) {
	// Cancel first so an operator can stop an in-progress startup promptly.
	err := a.monitor.Stop(r.Context())
	a.monitorOp.Lock()
	defer a.monitorOp.Unlock()
	// A concurrent start may still have been preparing settings when the first
	// cancellation ran. Serialize a second stop after that preparation finishes.
	if err == nil {
		err = a.monitor.Stop(r.Context())
	}
	if err == nil {
		err = a.setAutoStart(r.Context(), false)
	}
	a.writeMonitorResult(w, r, err)
}
func (a *App) handleMonitorRestart(w http.ResponseWriter, r *http.Request) {
	a.monitorOp.Lock()
	defer a.monitorOp.Unlock()
	err := a.monitor.Stop(r.Context())
	if err == nil {
		err = a.startMonitor(r.Context())
	}
	if err == nil {
		err = a.setAutoStart(r.Context(), true)
	}
	a.writeMonitorResult(w, r, err)
}
func (a *App) ingestWork(ctx context.Context, work *engine.Work, message *tg.Message, transport telegram.MediaDownloader) error {
	_, err := a.ingestTelegram(ctx, message, work.GroupID, work.GroupName, work.AccountID, transport)
	return err
}
func (a *App) monitorEvent(state string, err error) {
	var cause any
	if err != nil {
		cause = err.Error()
	}
	a.hub.Broadcast(ws.Event{Type: "monitor_state", Payload: map[string]any{"state": state, "error": cause}})
}
