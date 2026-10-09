package app

import (
	"fmt"
	"github.com/botnick/telegram-media-downloader/core-service/internal/backup"
	"net/http"
	"strconv"
)

func registerBackupRoutes(mux *http.ServeMux, a *App) {
	mux.Handle("GET /api/backup/providers", a.requireAdmin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"success": true, "providers": backup.Providers()})
	})))
	mux.Handle("GET /api/backup/destinations", a.requireAdmin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ds, err := a.backups.List(r.Context())
		if err != nil {
			writeJSONError(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"success": true, "destinations": ds})
	})))
	mux.Handle("POST /api/backup/destinations", a.requireAdmin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input map[string]any
		if decodeBody(w, r, &input) != nil {
			return
		}
		d, err := a.backups.Create(r.Context(), input)
		if err != nil {
			a.backups.Log("warn", "destination create rejected: "+err.Error())
			writeJSONError(w, 400, err.Error())
			return
		}
		a.backups.Log("info", fmt.Sprintf("destination created (#%v)", d["id"]))
		writeJSON(w, 200, map[string]any{"success": true, "id": d["id"], "destination": d})
	})))
	mux.Handle("GET /api/backup/jobs/recent", a.requireAdmin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		jobs, err := a.backups.Jobs(r.Context(), 0, "", backupQueryInt(r, "limit", 20), 0, true)
		if err != nil {
			writeJSONError(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"success": true, "jobs": jobs})
	})))
	mux.Handle("POST /api/backup/jobs/{id}/retry", a.requireAdmin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, ok := backupID(w, r)
		if !ok {
			return
		}
		done, err := a.backups.Retry(r.Context(), id)
		if err != nil {
			writeJSONError(w, 500, err.Error())
			return
		}
		if done {
			a.backups.Log("info", fmt.Sprintf("manual retry on job #%d", id))
		}
		writeJSON(w, 200, map[string]any{"success": done})
	})))
	for _, route := range []string{"PUT /api/backup/destinations/{id}", "DELETE /api/backup/destinations/{id}", "GET /api/backup/destinations/{id}/config", "GET /api/backup/destinations/{id}/status", "GET /api/backup/destinations/{id}/jobs", "POST /api/backup/destinations/{id}/test", "POST /api/backup/destinations/{id}/run", "POST /api/backup/destinations/{id}/pause", "POST /api/backup/destinations/{id}/resume", "POST /api/backup/destinations/{id}/encryption", "POST /api/backup/destinations/{id}/unlock"} {
		mux.Handle(route, a.requireAdmin(http.HandlerFunc(a.handleBackupDestination)))
	}
}
func backupQueryInt(r *http.Request, key string, def int) int {
	v, e := strconv.Atoi(r.URL.Query().Get(key))
	if e != nil || v == 0 {
		return def
	}
	return v
}
func backupID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeJSONError(w, 400, "bad id")
		return 0, false
	}
	return id, true
}
func (a *App) handleBackupDestination(w http.ResponseWriter, r *http.Request) {
	id, ok := backupID(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	out := map[string]any{"success": true}
	status := 500
	var err error
	switch r.Pattern {
	case "PUT /api/backup/destinations/{id}":
		status = 400
		var input map[string]any
		if decodeBody(w, r, &input) != nil {
			return
		}
		out["destination"], err = a.backups.Update(ctx, id, input)
		if err == nil {
			a.backups.Log("info", fmt.Sprintf("destination updated (#%d)", id))
		}
	case "DELETE /api/backup/destinations/{id}":
		out["success"], err = a.backups.Remove(ctx, id)
		if err == nil {
			a.backups.Log("info", fmt.Sprintf("destination removed (#%d)", id))
		}
	case "GET /api/backup/destinations/{id}/config":
		status = 404
		out["config"], err = a.backups.Config(ctx, id)
	case "GET /api/backup/destinations/{id}/status":
		status = 404
		out, err = a.backups.Status(ctx, id)
		if err == nil {
			out["success"] = true
		}
	case "GET /api/backup/destinations/{id}/jobs":
		out["jobs"], err = a.backups.Jobs(ctx, id, r.URL.Query().Get("status"), backupQueryInt(r, "limit", 50), backupQueryInt(r, "offset", 0), false)
	case "POST /api/backup/destinations/{id}/test":
		var ok bool
		var detail string
		ok, detail, err = a.backups.Test(ctx, id)
		if err == nil {
			out["ok"], out["detail"] = ok, detail
			level := "info"
			if !ok {
				level = "warn"
			}
			a.backups.Log(level, fmt.Sprintf("test connection on #%d: %s", id, detail))
		}
	case "POST /api/backup/destinations/{id}/run":
		// Jobs are durable before acknowledgement; workers own archive/transfer lifetime.
		if e := a.backups.Run(ctx, id); e != nil {
			a.backups.Log("error", fmt.Sprintf("run failed for #%d: %v", id, e))
			if !backup.IsRunRejection(e) {
				writeJSONError(w, 500, e.Error())
				return
			}
		}
		out["started"] = true
	case "POST /api/backup/destinations/{id}/pause", "POST /api/backup/destinations/{id}/resume":
		paused := r.Pattern == "POST /api/backup/destinations/{id}/pause"
		err = a.backups.Pause(ctx, id, paused)
		if err == nil {
			action := "resumed"
			if paused {
				action = "paused"
			}
			a.backups.Log("info", fmt.Sprintf("%s #%d", action, id))
		}
	case "POST /api/backup/destinations/{id}/encryption", "POST /api/backup/destinations/{id}/unlock":
		status = 400
		var input map[string]any
		if decodeBody(w, r, &input) != nil {
			return
		}
		unlock := r.Pattern == "POST /api/backup/destinations/{id}/unlock"
		pass, _ := input["passphrase"].(string)
		var d map[string]any
		d, err = a.backups.Encryption(ctx, id, unlock || input["enabled"] == true, pass, unlock)
		if !unlock {
			out["destination"] = d
		}
	}
	if err != nil {
		writeJSONError(w, status, err.Error())
		return
	}
	writeJSON(w, 200, out)
}
