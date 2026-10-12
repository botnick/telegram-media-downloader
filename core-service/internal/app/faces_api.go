package app

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

// Face sidecar, scan and maintenance routes of the Safety & AI → Faces
// tab (src/web/server.js /api/ai/*). The local auto-spawned sidecar of
// the Node app (faces-spawn.js) is not part of this server: "Local" mode
// reports that it is unavailable and the external sidecar (dashboard URL,
// TGDL_FACES_SIDECAR_URL or the compose FACES_SERVICE_URL) does the work.
func registerFacesRoutes(mux *http.ServeMux, a *App) {
	session := func(fn http.HandlerFunc) http.Handler { return a.requireSession(fn) }
	admin := func(fn http.HandlerFunc) http.Handler { return a.requireAdmin(fn) }
	mux.Handle("GET /api/ai/status", session(a.handleAIStatus))
	mux.Handle("GET /api/ai/doctor", session(a.handleAIDoctor))
	mux.Handle("GET /api/ai/health", session(a.handleAIDoctor))
	mux.Handle("GET /api/ai/scan/status", session(a.handleAIScanStatus))
	mux.Handle("POST /api/ai/scan/start", admin(a.handleAIScanStart))
	mux.Handle("POST /api/ai/scan/cancel", admin(a.handleAIScanCancel))
	mux.Handle("POST /api/ai/faces/recluster", admin(a.handleAIRecluster))
	mux.Handle("POST /api/ai/faces/restart", admin(a.handleAIFacesRestart))
	mux.Handle("GET /api/ai/faces/health-test", admin(a.handleAIHealthTest))
	mux.Handle("POST /api/ai/faces/health-test", admin(a.handleAIHealthTest))
	mux.Handle("GET /api/ai/faces/provider-probe", admin(a.handleAIProviderProbe))
	mux.Handle("POST /api/ai/faces/install-deps", admin(a.handleAIInstallDeps))
	mux.Handle("POST /api/ai/detect-test", admin(a.handleAIDetectTest))
	mux.Handle("POST /api/ai/preload-model/{model}", admin(a.handleAIPreload))
	mux.Handle("GET /api/ai/preload-model/{model}/status", admin(a.handleAIPreload))
	mux.Handle("POST /api/ai/backfill-quality", admin(a.handleAIBackfillQuality))
	mux.Handle("GET /api/ai/backfill-quality/status", session(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, a.faces.quality.Status())
	}))
	mux.Handle("POST /api/ai/auto-scan", admin(a.handleAIAutoScan))
	mux.Handle("POST /api/ai/search", session(a.handleAISearch))
	mux.Handle("POST /api/ai/search/similar", session(a.handleAISearch))
}

// facesConfig loads the effective advanced.ai block and the resolved
// settings, and points the sidecar client at the configured URL.
func (a *App) facesConfig(ctx context.Context) (map[string]any, facesSettings, error) {
	raw, err := a.config.Load(ctx)
	if err != nil {
		return nil, facesSettings{}, err
	}
	effective := effectiveConfig(raw)
	settings := resolveFacesSettings(effective, os.Getenv)
	a.faces.client.configure(settings)
	ai := objectAt(effective, "advanced", "ai")
	if ai == nil {
		ai = map[string]any{}
	}
	return ai, settings, nil
}

func facesModeLabel(mode string) string {
	switch mode {
	case "external":
		return "external URL"
	case "docker":
		return "FACES_SERVICE_URL"
	case "override":
		return "external URL (legacy facesServiceUrl)"
	default:
		return "local sidecar (not available in this server)"
	}
}

// sidecarState probes the configured sidecar (cached, bounded) and maps the
// answer to the badge states of maintenance-ai.js.
func (a *App) sidecarState(ctx context.Context, s facesSettings) (string, facesHealth) {
	if s.URL == "" {
		return "idle", facesHealth{Error: facesLocalUnavailableMsg}
	}
	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	h := a.faces.client.Health(probeCtx)
	switch {
	case h.OK && h.Ready:
		return "healthy", h
	case h.OK:
		return "loading", h
	default:
		return "failed", h
	}
}

func (a *App) aiCounts(r *http.Request, s facesSettings) map[string]any {
	payload, status := a.invokeRead(r, a.read.AICounts, map[string]any{"fileTypes": s.statusTypes()})
	if status >= 400 {
		return map[string]any{"totalEligible": 0, "indexed": 0, "withFaces": 0}
	}
	return payload
}

func (a *App) handleAIStatus(w http.ResponseWriter, r *http.Request) {
	ai, s, err := a.facesConfig(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	faces, _ := ai["faces"].(map[string]any)
	if faces == nil {
		faces = map[string]any{}
	}
	envSource := func(name string) string {
		if strings.TrimSpace(os.Getenv(name)) != "" {
			return "env"
		}
		return "config"
	}
	counts := a.aiCounts(r, s)
	state, health := a.sidecarState(r.Context(), s)
	mode := s.Mode
	if mode == "" {
		mode = "local"
	}
	id := s.FacesModel
	if id == "" {
		id = "insightface " + s.DetectorModel + " (Python sidecar)"
	}
	source := "bundled"
	if s.FacesModel != "" {
		source = "override"
	}
	var providers any
	if len(health.ProvidersResolved) > 0 {
		providers = health.ProvidersResolved
	}
	var sidecarError any
	if state == "failed" || state == "idle" {
		sidecarError = health.Error
	}
	realtime, backfill := a.faces.queueDepths()
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"config": map[string]any{
			"enabled":            s.Enabled,
			"faceClustering":     s.FaceClustering,
			"federateFaces":      s.FederateFaces,
			"fileTypes":          s.BackgroundTypes,
			"facesEpsilon":       s.Epsilon,
			"facesMinPoints":     s.MinPoints,
			"facesDetector":      firstNonEmpty(stringOr(ai["facesDetector"], ""), "tiny"),
			"facesDetectorModel": s.DetectorModel,
			"faces": map[string]any{
				"providers":       s.Providers,
				"detectorModel":   s.DetectorModel,
				"scanVideos":      s.ScanVideos,
				"sidecarUrl":      stringOr(faces["sidecarUrl"], ""),
				"sidecarTokenSet": stringOr(faces["sidecarToken"], "") != "",
				"pathMap":         stringOr(faces["pathMap"], ""),
				"sources": map[string]any{
					"url":     envSource("TGDL_FACES_SIDECAR_URL"),
					"token":   envSource("TGDL_FACES_SIDECAR_TOKEN"),
					"pathMap": envSource("TGDL_FACES_PATH_MAP"),
				},
			},
		},
		"counts": counts,
		"scans":  map[string]any{"faces": a.faces.scanState().payload()},
		"models": map[string]any{"faces": map[string]any{
			"id": id, "preset": s.DetectorModel, "dim": 512, "dtype": "fp32", "source": source,
			"enabled": s.FaceClustering, "loaded": state == "healthy", "bundled": s.FacesModel == "",
			"providers": providers, "providersRequested": s.Providers, "version": health.Version,
			"mode": mode, "modeLabel": facesModeLabel(s.Mode), "state": state, "url": emptyNil(s.URL),
			"error": sidecarError,
		}},
		"bgQueue":                map[string]any{"realtime": realtime, "backfill": backfill},
		"qualityBackfillPending": counts["qualityPending"],
		"trackers": map[string]any{
			"aiPeople":        a.faces.people.Status(),
			"qualityBackfill": a.faces.quality.Status(),
		},
	})
}

func (a *App) handleAIDoctor(w http.ResponseWriter, r *http.Request) {
	_, s, err := a.facesConfig(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	check := func(id, label, status, detail string) map[string]any {
		return map[string]any{"id": id, "label": label, "status": status, "detail": detail}
	}
	var checks []map[string]any
	state, h := a.sidecarState(r.Context(), s)
	var rich any
	switch state {
	case "idle":
		checks = append(checks, check("sidecar", "Python face sidecar", "warn", "not configured — "+facesLocalUnavailableMsg))
	case "failed":
		checks = append(checks, check("sidecar", "Python face sidecar", "fail", fmt.Sprintf("%s at %s is not reachable: %s", facesModeLabel(s.Mode), s.URL, h.Error)))
	default:
		version := ""
		if h.Version != nil {
			version = fmt.Sprintf("v%v · ", h.Version)
		}
		checks = append(checks, check("sidecar", "Python face sidecar", "ok", fmt.Sprintf("%s%s at %s", version, facesModeLabel(s.Mode), s.URL)))
	}
	if state != "idle" {
		rich = map[string]any{
			"ok": h.OK, "version": h.Version, "model": h.Model, "dim": h.Dim, "ready": h.Ready,
			"providersResolved": h.ProvidersResolved, "providersRequested": h.ProvidersRequested,
			"detSize": h.DetSize, "platform": h.Platform, "python": h.Python,
		}
	}
	if h.OK {
		top := "CPUExecutionProvider"
		if len(h.ProvidersResolved) > 0 {
			top = h.ProvidersResolved[0]
		}
		label := map[string]string{
			"CUDAExecutionProvider":   "GPU acceleration: CUDA",
			"CoreMLExecutionProvider": "GPU acceleration: Apple Silicon (CoreML)",
			"DmlExecutionProvider":    "GPU acceleration: DirectML",
			"CPUExecutionProvider":    "CPU-only (no GPU detected)",
		}[top]
		checks = append(checks, check("provider", "Inference provider", "ok", firstNonEmpty(label, top)))
		if h.Ready {
			checks = append(checks, check("model", "Model loaded", "ok", fmt.Sprintf("%v (%v-dim)", orDefault(h.Model, "buffalo_l"), orDefault(h.Dim, 512))))
		} else {
			checks = append(checks, check("model", "Model loaded", "warn", "not loaded yet (first scan will load)"))
		}
	} else {
		checks = append(checks, check("provider", "Inference provider", "warn", "unable to probe (sidecar offline)"))
		checks = append(checks, check("model", "Model loaded", "warn", "unable to probe (sidecar offline)"))
	}
	counts := a.aiCounts(r, s)
	indexed, total := number(counts["indexed"], 0), number(counts["totalEligible"], 0)
	pct := 0
	if total > 0 {
		pct = int(indexed / total * 100)
	}
	label := "Photos indexed"
	if s.ScanVideos {
		label = "Files indexed"
	}
	checks = append(checks, check("indexed", label, "ok", fmt.Sprintf("%d/%d (%d%%) · with faces %d", int64(indexed), int64(total), pct, int64(number(counts["withFaces"], 0)))))
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "checks": checks, "richHealth": rich})
}

func emptyNil(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func orDefault(value, fallback any) any {
	if value == nil {
		return fallback
	}
	return value
}

func readFeature(w http.ResponseWriter, r *http.Request) (bool, bool) {
	var body struct {
		Feature string `json:"feature"`
	}
	if r.ContentLength != 0 {
		if err := decodeBody(w, r, &body); err != nil {
			return false, false
		}
	}
	if strings.ToLower(strings.TrimSpace(body.Feature)) != "faces" {
		writeJSONError(w, http.StatusBadRequest, "feature must be embed|tags|faces")
		return false, false
	}
	return true, true
}

func (a *App) handleAIScanStatus(w http.ResponseWriter, r *http.Request) {
	if strings.ToLower(r.URL.Query().Get("feature")) != "faces" {
		writeJSONError(w, http.StatusBadRequest, "feature must be embed|tags|faces")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "state": a.faces.scanState().payload()})
}

func (a *App) writeScanStartError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errAIJobRunning):
		writeJSON(w, http.StatusConflict, map[string]any{"error": "Tracker busy", "code": "ALREADY_RUNNING"})
	case errors.Is(err, errAIStopping):
		writeJSONError(w, http.StatusServiceUnavailable, err.Error())
	default:
		writeJSONError(w, http.StatusInternalServerError, err.Error())
	}
}

func (a *App) handleAIScanStart(w http.ResponseWriter, r *http.Request) {
	_, s, err := a.facesConfig(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !s.Enabled {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "AI subsystem disabled — enable it in Maintenance → AI first.", "code": "AI_DISABLED"})
		return
	}
	if ok, _ := readFeature(w, r); !ok {
		return
	}
	if a.faces.scanRunning() {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "Scan already running", "code": "ALREADY_RUNNING"})
		return
	}
	if s.URL == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": facesLocalUnavailableMsg, "code": "SIDECAR_NOT_CONFIGURED"})
		return
	}
	if err := a.faces.startScan(s, true); err != nil {
		a.writeScanStartError(w, err)
		return
	}
	a.faces.logf("faces scan starting")
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "started": true})
}

func (a *App) handleAIScanCancel(w http.ResponseWriter, r *http.Request) {
	if ok, _ := readFeature(w, r); !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "cancelled": a.faces.cancelScan()})
}

// handleAIRecluster re-runs the clustering with the current ε / minPoints.
// As in Node it goes through the scan runner, so rows not scanned yet are
// detected first; without a sidecar only the clustering runs.
func (a *App) handleAIRecluster(w http.ResponseWriter, r *http.Request) {
	_, s, err := a.facesConfig(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if a.faces.scanRunning() {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "scan_running", "message": "A face scan is already in progress."})
		return
	}
	if err := a.faces.startScan(s, s.URL != ""); err != nil {
		a.writeScanStartError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "started": true})
}

// handleFacesReindex wipes every face and person and re-queues every
// eligible download for detection.
func (a *App) handleFacesReindex(w http.ResponseWriter, r *http.Request) {
	if a.faces.scanRunning() {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "scan_running", "message": "A face scan is already in progress. Cancel it before reindexing."})
		return
	}
	_, s, err := a.facesConfig(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	marks, args := sqlIn(s.statusTypes())
	tx, err := a.db.Writer.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer tx.Rollback() //nolint:errcheck // no-op after Commit
	for _, stmt := range []struct {
		query string
		args  []any
	}{
		{`DELETE FROM faces`, nil},
		{`DELETE FROM people`, nil},
		{`UPDATE downloads SET ai_indexed_at = NULL WHERE file_type IN (` + marks + `)`, args},
	} {
		if _, err := tx.ExecContext(r.Context(), stmt.query, stmt.args...); err != nil {
			writeJSONError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	a.hub.Broadcast(ws.Event{Type: "ai_faces_reindexed", Flat: true, Payload: map[string]any{"ts": nowMillis()}})
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// handleAIFacesRestart re-reads the sidecar settings and forgets what was
// learned about the previous sidecar; the new state is published as
// ai_faces_status once probed. There is no local process to restart.
func (a *App) handleAIFacesRestart(w http.ResponseWriter, r *http.Request) {
	_, s, err := a.facesConfig(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	a.faces.client.reset()
	if s.URL == "" {
		a.hub.Broadcast(ws.Event{Type: "ai_faces_status", Flat: true, Payload: map[string]any{"ok": false, "state": "idle", "mode": "local", "error": facesLocalUnavailableMsg}})
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "mode": "local", "available": false, "message": facesLocalUnavailableMsg})
		return
	}
	a.launchMaintenance(func() {
		ctx, cancel := context.WithTimeout(a.ctx, 15*time.Second)
		defer cancel()
		state, h := a.sidecarState(ctx, s)
		var cause any
		if state == "failed" {
			cause = fmt.Sprintf("sidecar at %s is not reachable: %s", s.URL, h.Error)
		}
		a.hub.Broadcast(ws.Event{Type: "ai_faces_status", Flat: true, Payload: map[string]any{"ok": h.OK, "url": s.URL, "mode": s.Mode, "state": state, "error": cause}})
	})
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "mode": s.Mode, "available": true})
}

// sidecarTestURL validates an admin-typed sidecar base URL: http(s) only,
// no credentials, query or fragment.
func sidecarTestURL(raw string) (string, string) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", "url_required"
	}
	if len(value) > 2048 {
		return "", "invalid_url"
	}
	u, err := url.Parse(value)
	if err != nil || u.Host == "" {
		return "", "invalid_url"
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", "invalid_scheme"
	}
	if u.User != nil {
		return "", "invalid_url"
	}
	u.Path = strings.TrimRight(u.Path, "/")
	u.RawPath, u.RawQuery, u.Fragment = "", "", ""
	return strings.TrimRight(u.String(), "/"), ""
}

func (a *App) handleAIHealthTest(w http.ResponseWriter, r *http.Request) {
	_, s, err := a.facesConfig(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	var body struct {
		URL           string `json:"url"`
		Token         string `json:"token"`
		UseSavedToken *bool  `json:"useSavedToken"`
	}
	if r.Method == http.MethodPost {
		if err := decodeBody(w, r, &body); err != nil {
			return
		}
	} else {
		body.URL = firstNonEmpty(r.URL.Query().Get("url"), s.URL)
	}
	base, problem := sidecarTestURL(body.URL)
	if problem != "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": problem})
		return
	}
	// The typed token, else the saved one when testing the saved URL.
	token := strings.TrimSpace(body.Token)
	if token == "" && (body.UseSavedToken == nil || *body.UseSavedToken) && s.URL != "" && normalizeSidecarURL(base) == s.URL {
		token = s.Token
	}
	p := probeFacesSidecar(r.Context(), a.faces.client.http, base, token)
	var model, providers any
	ready := false
	if p.Health != nil {
		model, ready = p.Health["model"], p.Health["ready"] == true
		providers = orDefault(p.Health["providers_resolved"], p.Health["providers"])
	}
	transfer := "base64"
	if containsString(p.Features, "upload") {
		transfer = "upload"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": p.OK, "reachable": p.Reachable, "error": p.Error, "version": p.Version, "model": model,
		"ready": ready, "providers": providers, "features": p.Features, "auth": p.Auth,
		"authRequired": p.AuthRequired, "transfer": transfer, "tokenSent": token != "",
	})
}

func (a *App) handleAIProviderProbe(w http.ResponseWriter, r *http.Request) {
	_, s, err := a.facesConfig(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if s.URL == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "Face sidecar not running — " + facesLocalUnavailableMsg, "code": "SIDECAR_OFFLINE"})
		return
	}
	status, body, err := a.faces.client.Proxy(r.Context(), http.MethodGet, "/providers", 10*time.Second)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if status != http.StatusOK {
		writeJSON(w, status, map[string]any{"error": fmt.Sprintf("Sidecar returned HTTP %d", status), "code": "SIDECAR_ERROR"})
		return
	}
	writeJSON(w, http.StatusOK, body)
}

// handleAIInstallDeps: the Node installer pip-installed onnxruntime for the
// auto-spawned sidecar. This server only uses an external sidecar.
func (a *App) handleAIInstallDeps(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"started": false,
		"code":    "NOT_APPLICABLE",
		"error":   "Installing sidecar dependencies is not applicable: this server does not run a local face sidecar. Run the tgdl-faces container (or `python -m tgdl_faces`) and set its URL as the External sidecar.",
	})
}

func (a *App) handleAIDetectTest(w http.ResponseWriter, r *http.Request) {
	var body struct {
		DownloadID float64 `json:"downloadId"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		return
	}
	id := int64(body.DownloadID)
	if body.DownloadID < 1 || float64(id) != body.DownloadID {
		writeJSONError(w, http.StatusBadRequest, "downloadId must be a positive integer")
		return
	}
	var stored, fileType sql.NullString
	if err := a.db.Reader.QueryRowContext(r.Context(), `SELECT file_path, file_type FROM downloads WHERE id = ?`, id).Scan(&stored, &fileType); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "download not found", "code": "NOT_FOUND"})
		return
	}
	payload := map[string]any{"success": true, "downloadId": id, "filePath": nullableString(stored), "absPath": nil, "fileType": nullableString(fileType), "error": nil, "raw": nil, "rawCount": nil, "warnings": []string{}}
	abs := a.resolveMedia(stored.String)
	if abs == "" {
		payload["error"] = "file_not_found_on_disk"
		writeJSON(w, http.StatusOK, payload)
		return
	}
	payload["absPath"] = abs
	_, s, err := a.facesConfig(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	var warnings []string
	collect := func(format string, args ...any) { warnings = append(warnings, "[warn] "+fmt.Sprintf(format, args...)) }
	out, err := a.faces.client.DetectBatch(r.Context(), []string{abs}, s.detectParams(), 0, collect)
	if err != nil {
		collect("%v", err)
	} else if out[0].answered {
		faces := qualityFilter(out[0].faces, s)
		raw := make([]map[string]any, len(faces))
		for i, f := range faces {
			raw[i] = map[string]any{"x": f.X, "y": f.Y, "w": f.W, "h": f.H, "score": f.Score, "embeddingDim": len(f.Embedding)}
		}
		payload["raw"], payload["rawCount"] = raw, len(raw)
	}
	if warnings != nil {
		payload["warnings"] = warnings
	}
	writeJSON(w, http.StatusOK, payload)
}

var modelNamePattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)

func (a *App) handleAIPreload(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("model")
	if !modelNamePattern.MatchString(name) {
		writeJSONError(w, http.StatusBadRequest, "invalid model name")
		return
	}
	_, s, err := a.facesConfig(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if s.URL == "" {
		writeJSONError(w, http.StatusServiceUnavailable, "sidecar not running — "+facesLocalUnavailableMsg)
		return
	}
	method, path, timeout := http.MethodPost, "/preload/"+url.PathEscape(name), 5*time.Second
	if r.Method == http.MethodGet {
		method, path, timeout = http.MethodGet, path+"/status", 3*time.Second
	}
	_, body, err := a.faces.client.Proxy(r.Context(), method, path, timeout)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, body)
}

func (a *App) handleAIBackfillQuality(w http.ResponseWriter, r *http.Request) {
	_, s, err := a.facesConfig(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if s.URL == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"started": false, "error": facesLocalUnavailableMsg, "code": "SIDECAR_NOT_CONFIGURED"})
		return
	}
	snapshot, err := a.faces.quality.Start(a, nil, a.faces.qualityBackfill)
	switch {
	case errors.Is(err, errAIJobRunning):
		writeJSON(w, http.StatusConflict, map[string]any{"started": false, "code": "ALREADY_RUNNING", "snapshot": snapshot})
	case err != nil:
		writeJSONError(w, http.StatusServiceUnavailable, err.Error())
	default:
		writeJSON(w, http.StatusOK, map[string]any{"started": true, "snapshot": snapshot})
	}
}

func (a *App) handleAIAutoScan(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Action string `json:"action"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		return
	}
	next := map[string]string{"start": "running", "pause": "paused", "stop": "idle"}[strings.ToLower(body.Action)]
	if next == "" {
		writeJSONError(w, http.StatusBadRequest, "action must be one of: start, pause, stop")
		return
	}
	a.configMu.Lock()
	cfg, err := a.config.Load(r.Context())
	if err == nil {
		ensureMap(ensureMap(cfg, "advanced"), "ai")["autoScan"] = next
		err = a.config.Save(r.Context(), cfg)
	}
	a.configMu.Unlock()
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	a.faces.configChanged()
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "state": next})
}

// handleAISearch: semantic search was removed from the Node app before
// 2.32 (faces-only build); the gallery buttons get a clear answer.
func (a *App) handleAISearch(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusNotImplemented, map[string]any{
		"success": false,
		"code":    "SEARCH_UNAVAILABLE",
		"error":   "AI search is not available: this build only clusters faces (Safety & AI → Faces).",
	})
}
