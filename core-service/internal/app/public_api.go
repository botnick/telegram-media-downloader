package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
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

// Update check: the newest stable vX.Y.Z GitHub release, cached for 10
// minutes; a failed lookup serves the last answer marked stale.
var (
	updateCheckURL = "https://api.github.com/repos/botnick/telegram-media-downloader/releases?per_page=100"
	updateCheckTTL = 10 * time.Minute
	appReleaseTag  = regexp.MustCompile(`^v\d+\.\d+\.\d+$`)
)

type updateCheckCache struct {
	mu        sync.Mutex
	fetchedAt time.Time
	data      map[string]any
}

var latestRelease updateCheckCache

func compareSemver(a, b string) int {
	parse := func(s string) [3]int {
		var out [3]int
		s = strings.SplitN(strings.TrimPrefix(strings.TrimPrefix(s, "v"), "V"), "-", 2)[0]
		for i, part := range strings.SplitN(s, ".", 3) {
			out[i], _ = strconv.Atoi(part)
		}
		return out
	}
	x, y := parse(a), parse(b)
	for i := range x {
		if x[i] != y[i] {
			if x[i] > y[i] {
				return 1
			}
			return -1
		}
	}
	return 0
}

func fetchLatestRelease(ctx context.Context) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, updateCheckURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "tgdl-update-check")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub releases returned %d", res.StatusCode)
	}
	var list []struct {
		Tag         string `json:"tag_name"`
		Name        string `json:"name"`
		URL         string `json:"html_url"`
		PublishedAt string `json:"published_at"`
		Draft       bool   `json:"draft"`
		Prerelease  bool   `json:"prerelease"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 8<<20)).Decode(&list); err != nil {
		return nil, err
	}
	best := -1
	for i, rel := range list {
		if rel.Draft || rel.Prerelease || !appReleaseTag.MatchString(rel.Tag) {
			continue
		}
		if best < 0 || compareSemver(rel.Tag, list[best].Tag) > 0 {
			best = i
		}
	}
	if best < 0 {
		return nil, errors.New("no stable release")
	}
	rel := list[best]
	name := rel.Name
	if name == "" {
		name = rel.Tag
	}
	return map[string]any{"latest": rel.Tag, "latestName": name, "releaseUrl": rel.URL, "publishedAt": rel.PublishedAt}, nil
}

func (a *App) handleAPIVersionCheck(w http.ResponseWriter, r *http.Request) {
	current := version.AppVersion
	answer := func(data map[string]any, extra map[string]any) {
		out := map[string]any{"current": current, "updateAvailable": compareSemver(toString(data["latest"]), current) > 0}
		for k, v := range data {
			out[k] = v
		}
		for k, v := range extra {
			out[k] = v
		}
		writeJSON(w, http.StatusOK, out)
	}
	latestRelease.mu.Lock()
	cached, at := latestRelease.data, latestRelease.fetchedAt
	latestRelease.mu.Unlock()
	if r.URL.Query().Get("force") != "1" && cached != nil && time.Since(at) < updateCheckTTL && compareSemver(current, toString(cached["latest"])) < 0 {
		answer(cached, map[string]any{"cached": true})
		return
	}
	data, err := fetchLatestRelease(r.Context())
	if err != nil {
		if cached != nil {
			answer(cached, map[string]any{"cached": true, "stale": true})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"current": current, "latest": nil, "updateAvailable": false, "error": "unreachable"})
		return
	}
	latestRelease.mu.Lock()
	latestRelease.data, latestRelease.fetchedAt = data, time.Now()
	latestRelease.mu.Unlock()
	answer(data, map[string]any{"cached": false})
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
