package app

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

func registerMonitorMaintenance(mux *http.ServeMux, a *App) {
	mux.Handle("POST /api/maintenance/resync-dialogs", a.requireAdmin(http.HandlerFunc(a.handleResyncDialogs)))
	mux.Handle("POST /api/maintenance/restart-monitor", a.requireAdmin(http.HandlerFunc(a.handleRestartMaintenance)))
	for path, kind := range map[string]string{"resync-dialogs": "resyncDialogs", "restart-monitor": "restartMonitor"} {
		mux.Handle("GET /api/maintenance/"+path+"/status", a.requireAdmin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, a.telegramMaintenanceStatus(kind)) })))
	}
}

func (a *App) telegramReadiness(ctx context.Context) error {
	cfg, err := a.config.Load(ctx)
	if err != nil {
		return err
	}
	api, _ := cfg["telegram"].(map[string]any)
	if number(api["apiId"], 0) <= 0 || strings.TrimSpace(toString(api["apiHash"])) == "" {
		return errNoAPICredentials
	}
	saved, err := telegram.SavedSessions(a.dataDir)
	if err != nil {
		return err
	}
	if len(saved) == 0 {
		return errNoAccounts
	}
	return nil
}

func (a *App) telegramMaintenanceStatus(kind string) map[string]any {
	a.maintenanceMu.Lock()
	defer a.maintenanceMu.Unlock()
	if state := a.telegramMaintenance[kind]; state != nil {
		return cloneConfigValue(state).(map[string]any)
	}
	return maintenanceIdleStatus(kind)
}

func (a *App) startTelegramMaintenance(w http.ResponseWriter, kind, prefix, conflict string, fn func(func(map[string]any)) (map[string]any, error)) {
	done, ok := a.beginMaintenance()
	if !ok {
		writeJSONError(w, 503, "server is stopping")
		return
	}
	a.maintenanceMu.Lock()
	if a.telegramMaintenance == nil {
		a.telegramMaintenance = map[string]map[string]any{}
	}
	state := a.telegramMaintenance[kind]
	if state != nil && state["running"] == true {
		a.maintenanceMu.Unlock()
		done()
		writeJSON(w, 409, map[string]any{"error": conflict, "code": "ALREADY_RUNNING"})
		return
	}
	if state == nil {
		state = maintenanceIdleStatus(kind)
	} else {
		state = cloneConfigValue(state).(map[string]any)
	}
	start := time.Now()
	state["attempts"] = jobCount(state["attempts"]) + 1
	state["running"], state["stage"], state["progress"], state["error"] = true, "starting", map[string]any{}, nil
	state["startedAt"], state["finishedAt"], state["durationMs"] = start.UnixMilli(), 0, 0
	a.telegramMaintenance[kind] = cloneConfigValue(state).(map[string]any)
	a.maintenanceMu.Unlock()
	a.hub.Broadcast(ws.Event{Type: prefix + "_progress", Flat: true, Payload: cloneConfigValue(state)})
	go func() {
		defer done()
		result, err := fn(func(progress map[string]any) {
			state["progress"] = cloneConfigValue(progress)
			if stage := toString(progress["stage"]); stage != "" {
				state["stage"] = stage
			}
			a.maintenanceMu.Lock()
			a.telegramMaintenance[kind] = cloneConfigValue(state).(map[string]any)
			a.maintenanceMu.Unlock()
			payload := cloneConfigValue(state).(map[string]any)
			for k, v := range progress {
				payload[k] = v
			}
			a.hub.Broadcast(ws.Event{Type: prefix + "_progress", Flat: true, Payload: payload})
		})
		state["running"], state["finishedAt"], state["durationMs"] = false, time.Now().UnixMilli(), time.Since(start).Milliseconds()
		payload := map[string]any{"kind": kind, "durationMs": state["durationMs"]}
		if err != nil {
			state["stage"], state["error"], state["failures"] = "error", err.Error(), jobCount(state["failures"])+1
			payload["error"] = err.Error()
		} else {
			state["result"] = result
			state["stage"], state["successes"] = "done", jobCount(state["successes"])+1
			for k, v := range result {
				payload[k] = v
			}
		}
		a.maintenanceMu.Lock()
		a.telegramMaintenance[kind] = cloneConfigValue(state).(map[string]any)
		a.maintenanceMu.Unlock()
		a.hub.Broadcast(ws.Event{Type: prefix + "_done", Flat: true, Payload: payload})
	}()
	writeJSON(w, 200, map[string]any{"success": true, "started": true})
}

func (a *App) handleResyncDialogs(w http.ResponseWriter, r *http.Request) {
	if err := a.telegramReadiness(r.Context()); err != nil {
		switch {
		case errors.Is(err, errNoAPICredentials):
			writeJSON(w, 503, map[string]any{"error": err.Error(), "code": "NO_API_CREDS"})
		case errors.Is(err, errNoAccounts):
			writeJSONError(w, 409, "No Telegram accounts loaded")
		default:
			writeJSONError(w, 500, err.Error())
		}
		return
	}
	epoch, err := a.urlPurgeCheckpoint()
	if err != nil {
		writeJSONError(w, 409, err.Error())
		return
	}
	a.startTelegramMaintenance(w, "resyncDialogs", "resync_dialogs", "Resync already in progress", func(progress func(map[string]any)) (map[string]any, error) {
		result, err := a.refreshTelegramGroups(a.ctx, false, epoch, progress)
		if err != nil {
			return nil, err
		}
		a.hub.Broadcast(ws.Event{Type: "config_updated", Flat: true})
		return map[string]any{"scanned": result["scanned"], "updated": result["updated"]}, nil
	})
}

func (a *App) handleRestartMaintenance(w http.ResponseWriter, r *http.Request) {
	body, ok := readAuthBody(w, r)
	if !ok {
		return
	}
	if body["confirm"] != true {
		writeJSONError(w, 400, `Pass {"confirm": true} in the request body to proceed.`)
		return
	}
	a.startTelegramMaintenance(w, "restartMonitor", "restart_monitor", "Restart already in progress", func(_ func(map[string]any)) (map[string]any, error) {
		a.monitorOp.Lock()
		defer a.monitorOp.Unlock()
		status, err := a.monitor.Status(a.ctx)
		if err != nil {
			return nil, err
		}
		if status["state"] != "running" {
			if status["state"] == "starting" {
				if err = a.monitor.Stop(a.ctx); err != nil {
					return nil, err
				}
			}
			return map[string]any{"restarted": false, "note": "Monitor was not running; nothing to restart."}, nil
		}
		if err = a.monitor.Stop(a.ctx); err != nil {
			return nil, err
		}
		if err = a.startMonitor(a.ctx); err != nil {
			return nil, err
		}
		status, err = a.monitor.Status(a.ctx)
		return map[string]any{"restarted": true, "status": status}, err
	})
}
