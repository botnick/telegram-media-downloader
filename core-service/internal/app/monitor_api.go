package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

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
	return a.startTelegramEngine(ctx, true)
}

func (a *App) startTelegramEngine(ctx context.Context, observe bool) error {
	if a.purgePending() {
		return errors.New("a purge must finish before the monitor can start")
	}
	if err := a.accounts.Recover(ctx); err != nil {
		return err
	}
	// Serialize loading and applying the speed with settings saves, so a slow
	// account startup cannot overwrite a newer limit saved by the operator.
	a.configMu.Lock()
	cfg, err := a.config.Load(ctx)
	if err == nil {
		a.applyDownloadSpeed(cfg)
	}
	a.configMu.Unlock()
	if err != nil {
		return err
	}
	api, _ := cfg["telegram"].(map[string]any)
	appID := int(number(api["apiId"], 0))
	appHash := strings.TrimSpace(toString(api["apiHash"]))
	if appID <= 0 || appHash == "" {
		return errNoAPICredentials
	}
	proxy, err := telegram.ParseProxy(cfg["proxy"])
	if err != nil {
		return err
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
		specs = append(specs, engine.AccountConfig{ID: saved.ID, Name: names[saved.ID], Telegram: telegram.GotdConfig{AppID: appID, AppHash: appHash, Proxy: proxy, SessionPath: saved.NativePath, EncryptedSessionPath: saved.ImportPath, SessionSecret: strings.TrimSpace(string(secret))}})
	}
	download, _ := cfg["download"].(map[string]any)
	if !observe {
		return a.monitor.StartJobs(ctx, a.ctx, specs, int(number(download["concurrent"], 10)), int(number(download["retries"], 5)))
	}
	return a.monitor.Start(ctx, a.ctx, specs, int(number(download["concurrent"], 10)), int(number(download["retries"], 5)))
}

func (a *App) applyDownloadSpeed(cfg map[string]any) {
	download, _ := cfg["download"].(map[string]any)
	// Old configurations may contain null/string values. Keep their unlimited
	// meaning, and bound conversion before handing an integer to the engine.
	n := number(download["maxSpeed"], 0)
	if n < 0 || n > 1<<53-1 {
		n = 0
	}
	a.monitor.SetMaxSpeed(int64(n))
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
	a.writeMonitorResult(w, r, a.startMonitorDetached(r, false))
}

// startMonitorDetached starts (or restarts) monitoring on the server's own
// context. A start can spend many minutes repairing missed channel history;
// a dashboard request timing out or the tab closing must not cancel it.
// The reply waits up to monitorStartWait, then reports the current state
// (usually "starting"); the dashboard follows monitor_state events.
var monitorStartWait = 20 * time.Second

func (a *App) startMonitorDetached(r *http.Request, restart bool) error {
	done := make(chan error, 1)
	launched := a.launchMaintenance(func() {
		a.monitorOp.Lock()
		defer a.monitorOp.Unlock()
		var err error
		if restart {
			err = a.monitor.Stop(a.ctx)
		}
		if err == nil {
			err = a.startMonitor(a.ctx)
		}
		if err == nil {
			err = a.setAutoStart(a.ctx, true)
		}
		done <- err
	})
	if !launched {
		return errors.New("Server is stopping")
	}
	timer := time.NewTimer(monitorStartWait)
	defer timer.Stop()
	select {
	case err := <-done:
		return err
	case <-timer.C:
	case <-r.Context().Done():
	}
	return nil
}
func (a *App) handleMonitorStop(w http.ResponseWriter, r *http.Request) {
	// Cancel first so an operator can stop an in-progress startup promptly.
	err := a.monitor.StopObserving(r.Context())
	a.monitorOp.Lock()
	defer a.monitorOp.Unlock()
	// A concurrent start may still have been preparing settings when the first
	// cancellation ran. Serialize a second stop after that preparation finishes.
	if err == nil {
		err = a.monitor.StopObserving(r.Context())
	}
	if err == nil {
		err = a.setAutoStart(r.Context(), false)
	}
	a.writeMonitorResult(w, r, err)
}
func (a *App) handleMonitorRestart(w http.ResponseWriter, r *http.Request) {
	a.writeMonitorResult(w, r, a.startMonitorDetached(r, true))
}
func (a *App) ingestWork(ctx context.Context, work *engine.Work, message *tg.Message, transport telegram.MediaDownloader) error {
	cfg, err := a.config.Load(ctx)
	if err != nil {
		return err
	}
	allowed := false
	for _, group := range configuredGroupList(cfg) {
		if toString(group["id"]) == work.GroupID {
			pin := toString(group["monitorAccount"])
			allowed = (group["enabled"] == true || work.Origin == "history" || work.Origin == "url" || work.Origin == "stories") && group["suspended"] != true && (pin == "" || pin == work.AccountID)
			break
		}
	}
	if !allowed {
		return engine.ErrFiltered
	}
	if work.Origin == "url" || work.Origin == "stories" {
		_, allowed, err = a.monitorFilterConfig(engine.WithOrigin(ctx, work.Origin), cfg, work.AccountID, message, nil)
		if err != nil {
			return err
		}
		if !allowed {
			return engine.ErrFiltered
		}
	}
	_, err = a.ingestTelegram(ctx, message, work.GroupID, work.GroupName, work.AccountID, transport)
	return err
}
func (a *App) monitorEvent(state string, err error) {
	var cause any
	if err != nil {
		cause = err.Error()
	}
	a.hub.Broadcast(ws.Event{Type: "monitor_state", Flat: true, Payload: map[string]any{"state": state, "error": cause}})
	if a.output != nil && state != "starting" {
		if err != nil {
			fmt.Fprintf(a.output, "Monitor %s: %v\n", state, err)
		} else {
			fmt.Fprintf(a.output, "Monitor %s\n", state)
		}
	}
	switch state {
	case "running":
		a.restartMu.Lock()
		a.monitorRunningSince = time.Now()
		a.restartMu.Unlock()
	case "error":
		a.scheduleMonitorRestart()
	}
}

// Delays before restarting a monitor that stopped on an error while it is
// meant to run (autoStart). A channel gap ("requires history recovery") is
// repaired by the next start, so the first retry comes quickly; repeated
// failures back off to 5 minutes. A run that lasted 10 minutes resets it.
var monitorRestartDelays = []time.Duration{5 * time.Second, 30 * time.Second, time.Minute, 5 * time.Minute}

func (a *App) scheduleMonitorRestart() {
	a.restartMu.Lock()
	if a.restartPending {
		a.restartMu.Unlock()
		return
	}
	if !a.monitorRunningSince.IsZero() && time.Since(a.monitorRunningSince) > 10*time.Minute {
		a.restartAttempt = 0
	}
	a.monitorRunningSince = time.Time{}
	delay := monitorRestartDelays[min(a.restartAttempt, len(monitorRestartDelays)-1)]
	a.restartAttempt++
	a.restartPending = true
	a.restartMu.Unlock()
	launched := a.launchMaintenance(func() {
		timer := time.NewTimer(delay)
		defer timer.Stop()
		select {
		case <-a.ctx.Done():
			return
		case <-timer.C:
		}
		a.restartMu.Lock()
		a.restartPending = false
		a.restartMu.Unlock()
		a.monitorOp.Lock()
		retry := false
		if a.monitorShouldRestart() {
			if err := a.startMonitor(a.ctx); err != nil && a.ctx.Err() == nil {
				if a.output != nil {
					fmt.Fprintf(a.output, "Monitor restart failed: %v\n", err)
				}
				retry = true
			}
		}
		a.monitorOp.Unlock()
		if retry {
			a.scheduleMonitorRestart()
		}
	})
	if !launched {
		a.restartMu.Lock()
		a.restartPending = false
		a.restartMu.Unlock()
	}
}

// monitorShouldRestart: the operator left monitoring on and it is still
// stopped on an error (not stopped by hand or already running again).
func (a *App) monitorShouldRestart() bool {
	cfg, err := a.config.Load(a.ctx)
	if err != nil {
		return false
	}
	monitor, _ := cfg["monitor"].(map[string]any)
	if monitor["autoStart"] != true {
		return false
	}
	status, err := a.monitor.Status(a.ctx)
	return err == nil && (status["state"] == "error" || status["state"] == "stopped")
}
