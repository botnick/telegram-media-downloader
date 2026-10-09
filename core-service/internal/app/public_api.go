package app

import (
	"encoding/json"
	"net/http"
	"os"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/version"
)

var processStartedAt = time.Now()

func registerPublicAPIRoutes(mux *http.ServeMux, a *App) {
	mux.HandleFunc("GET /api/version", a.handleAPIVersion)
	mux.HandleFunc("GET /api/version/check", a.handleAPIVersionCheck)
	mux.HandleFunc("GET /metrics", a.handleMetrics)
}

func (a *App) handleAPIVersion(w http.ResponseWriter, r *http.Request) {
	value := map[string]any{"version": version.AppVersion, "commit": buildCommit(), "builtAt": buildTime()}
	if r.Header.Get("If-None-Match") == "" {
		writeJSON(w, http.StatusOK, value)
		return
	}
	body, _ := json.Marshal(value)
	tag := weakETag(body)
	w.Header().Set("ETag", tag)
	if r.Header.Get("If-None-Match") == tag {
		w.Header().Set("Vary", "Cookie")
		w.WriteHeader(http.StatusNotModified)
		return
	}
	writeJSON(w, http.StatusOK, value)
}

func (a *App) handleAPIVersionCheck(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"current": version.AppVersion, "latest": nil, "error": "unreachable", "updateAvailable": false})
}

func (a *App) handleMetrics(w http.ResponseWriter, r *http.Request) {
	if expected := strings.TrimSpace(os.Getenv("TGDL_METRICS_TOKEN")); expected != "" && r.URL.Query().Get("token") != expected {
		writePlainText(w, http.StatusUnauthorized, "text/plain; charset=utf-8", "# unauthorized\n")
		return
	}
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	uptime := int64(time.Since(processStartedAt).Seconds())
	body := "# HELP tgdl_accounts_loaded Telegram accounts currently loaded.\n" +
		"# TYPE tgdl_accounts_loaded gauge\n" +
		"tgdl_accounts_loaded 0\n" +
		"# HELP tgdl_active_downloads Downloads currently in flight.\n" +
		"# TYPE tgdl_active_downloads gauge\n" +
		"tgdl_active_downloads 0\n" +
		"# HELP tgdl_queue_size Current downloader queue depth (high + normal lanes).\n" +
		"# TYPE tgdl_queue_size gauge\n" +
		"tgdl_queue_size 0\n" +
		"# HELP tgdl_workers Active downloader worker count.\n" +
		"# TYPE tgdl_workers gauge\n" +
		"tgdl_workers 0\n" +
		"# TYPE process_resident_memory_bytes gauge\n" +
		"process_resident_memory_bytes " + strconv.FormatUint(uint64(mem.Sys), 10) + "\n" +
		"# TYPE process_heap_bytes gauge\n" +
		"process_heap_bytes " + strconv.FormatUint(uint64(mem.HeapAlloc), 10) + "\n" +
		"# TYPE process_uptime_seconds counter\n" +
		"process_uptime_seconds " + strconv.FormatInt(uptime, 10) + "\n"
	writePlainText(w, http.StatusOK, "text/plain; charset=utf-8; version=0.0.4", body)
}

func writePlainText(w http.ResponseWriter, status int, contentType, body string) {
	data := []byte(body)
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("ETag", weakETag(data))
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

// buildCommit is the Docker build's GIT_SHA, else the VCS revision Go
// embeds when building from a checkout, else "dev".
func buildCommit() string {
	if sha := strings.TrimSpace(os.Getenv("GIT_SHA")); sha != "" && sha != "dev" {
		return sha[:min(len(sha), 7)]
	}
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, s := range info.Settings {
			if s.Key == "vcs.revision" && s.Value != "" {
				return s.Value[:min(len(s.Value), 7)]
			}
		}
	}
	return "dev"
}

func buildTime() any {
	if at := strings.TrimSpace(os.Getenv("BUILT_AT")); at != "" {
		return at
	}
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, s := range info.Settings {
			if s.Key == "vcs.time" && s.Value != "" {
				return s.Value
			}
		}
	}
	return nil
}
