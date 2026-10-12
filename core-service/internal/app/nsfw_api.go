package app

import (
	"context"
	"math"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/nsfw"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

// NSFW review runs entirely through the external nsfw-service sidecar: the
// Go server has no in-process model. Without a sidecar URL the review
// pages still browse, whitelist and delete rows scored earlier, and every
// classifier route answers 503 NSFW_SIDECAR_REQUIRED.

const (
	nsfwSidecarCode    = "NSFW_SIDECAR_REQUIRED"
	nsfwSidecarMessage = "Configure the NSFW sidecar first: set TGDL_NSFW_SIDECAR_URL (or Maintenance → NSFW review → External) to a running nsfw-service. This server has no built-in classifier."
)

var nsfwTierMeta = []map[string]any{
	{"id": "def_not", "min": 0.0, "max": 0.3, "label": "Definitely not 18+"},
	{"id": "maybe_not", "min": 0.3, "max": 0.5, "label": "Probably not 18+"},
	{"id": "uncertain", "min": 0.5, "max": 0.7, "label": "Borderline / review"},
	{"id": "maybe", "min": 0.7, "max": 0.9, "label": "Probably 18+"},
	{"id": "def", "min": 0.9, "max": 1.01, "label": "Definitely 18+"},
}

type nsfwConfig struct {
	Enabled          bool
	BlocklistEnabled bool
	Model            string
	Threshold        float64
	Concurrency      int
	BatchSize        int
	VideoMaxTiles    int
	FileTypes        []string
	Sidecar          nsfw.Settings
	Sources          map[string]string
}

func (c nsfwConfig) fileTypeArgs() []any {
	out := make([]any, len(c.FileTypes))
	for i, t := range c.FileTypes {
		out[i] = t
	}
	return out
}

// nsfwRuntime holds the scan, bulk and auto-scan state. Its mutex guards
// everything but the client, which is safe for concurrent use.
type nsfwRuntime struct {
	client *nsfw.Client
	queue  chan nsfwJob

	mu           sync.Mutex
	scan         nsfwScanState
	scanCancel   context.CancelFunc
	lastProgress time.Time
	load         map[string]any
	bulk         map[string]any
	draining     bool
}

type nsfwJob struct {
	id  int64
	key string
}

func newNSFWRuntime() *nsfwRuntime {
	return &nsfwRuntime{
		client: nsfw.NewClient(&http.Client{}),
		queue:  make(chan nsfwJob, 200),
		load:   map[string]any{"state": "idle", "model": nil, "dtype": nil, "progress": nil, "error": nil, "startedAt": nil, "finishedAt": nil},
		bulk:   dedupIdleStatus("nsfwBulk"),
	}
}

func registerNSFWRoutes(mux *http.ServeMux, a *App) {
	admin := func(pattern string, fn http.HandlerFunc) { mux.Handle(pattern, a.requireAdmin(fn)) }
	admin("GET /api/maintenance/nsfw/status", a.handleNSFWStatus)
	admin("POST /api/maintenance/nsfw/scan", a.handleNSFWScan)
	admin("POST /api/maintenance/nsfw/scan/cancel", a.handleNSFWScanCancel)
	admin("POST /api/maintenance/nsfw/preload", a.handleNSFWPreload)
	admin("POST /api/maintenance/nsfw/sidecar-test", a.handleNSFWSidecarTest)
	admin("GET /api/maintenance/nsfw/model-status", a.handleNSFWModelStatus)
	admin("DELETE /api/maintenance/nsfw/cache", a.handleNSFWCache)
	admin("GET /api/maintenance/nsfw/results", a.handleNSFWResults)
	admin("POST /api/maintenance/nsfw/delete", a.handleNSFWDelete)
	admin("POST /api/maintenance/nsfw/whitelist", a.handleNSFWWhitelist)
	admin("GET /api/maintenance/nsfw/v2/tiers-meta", a.handleNSFWTiersMeta)
	admin("GET /api/maintenance/nsfw/v2/tiers", a.handleNSFWTiers)
	admin("GET /api/maintenance/nsfw/v2/histogram", a.handleNSFWHistogram)
	admin("GET /api/maintenance/nsfw/v2/list", a.handleNSFWList)
	admin("POST /api/maintenance/nsfw/v2/bulk-delete", a.handleNSFWBulk("delete"))
	admin("POST /api/maintenance/nsfw/v2/bulk-whitelist", a.handleNSFWBulk("whitelist"))
	admin("POST /api/maintenance/nsfw/v2/unwhitelist", a.handleNSFWBulk("unwhitelist"))
	admin("POST /api/maintenance/nsfw/v2/reclassify", a.handleNSFWBulk("reclassify"))
	admin("GET /api/maintenance/nsfw/v2/bulk/status", a.handleNSFWBulkStatus)
	admin("GET /api/maintenance/nsfw/blocklist/stats", a.handleNSFWBlocklistStats)
	admin("DELETE /api/maintenance/nsfw/blocklist", a.handleNSFWBlocklistClear)
}

// nsfwSettings reads advanced.nsfw on every call so a saved setting takes
// effect on the next scan without a restart. TGDL_NSFW_SIDECAR_URL,
// TGDL_NSFW_API_TOKEN and TGDL_NSFW_PATH_MAP win over the dashboard values,
// as in 2.x. The sidecar client is reconfigured as a side effect.
func (a *App) nsfwSettings(ctx context.Context) nsfwConfig {
	stored, err := a.config.Load(ctx)
	if err != nil {
		stored = nil
	}
	advanced, _ := stored["advanced"].(map[string]any)
	ns, _ := advanced["nsfw"].(map[string]any)
	cfg := nsfwConfig{
		Enabled:          ns["enabled"] == true,
		BlocklistEnabled: ns["blocklistEnabled"] == true,
		Model:            stringOr(ns["model"], ""),
		Threshold:        clampFloat(number(ns["threshold"], 0.6), 0.1, 0.99, 0.6),
		Concurrency:      int(clampConfigInt(ns["concurrency"], 1, 4, 2)),
		BatchSize:        int(clampConfigInt(ns["batchSize"], 1, 500, 50)),
		VideoMaxTiles:    int(clampConfigInt(ns["videoMaxTiles"], 1, 200, 48)),
		Sources:          map[string]string{},
	}
	if cfg.Model == "" {
		cfg.Model = "AdamCodd/vit-base-nsfw-detector"
	}
	allowed := map[string]bool{"photo": true, "video": true, "sticker": true, "document": true}
	for _, t := range cleanTypes(ns["fileTypes"], allowed, []any{"photo"}) {
		cfg.FileTypes = append(cfg.FileTypes, t.(string))
	}
	pick := func(env, key, source string) string {
		if v := strings.TrimSpace(os.Getenv(env)); v != "" {
			cfg.Sources[source] = "env"
			return v
		}
		cfg.Sources[source] = "config"
		return stringOr(ns[key], "")
	}
	cfg.Sidecar = nsfw.Settings{
		URL:        pick("TGDL_NSFW_SIDECAR_URL", "sidecarUrl", "url"),
		Token:      pick("TGDL_NSFW_API_TOKEN", "apiToken", "token"),
		PathMap:    pick("TGDL_NSFW_PATH_MAP", "pathMap", "pathMap"),
		MaxRetries: int(clampConfigInt(ns["maxRetries"], 0, 10, 0)),
	}
	if ms := number(ns["requestTimeoutMs"], 0); ms > 0 {
		cfg.Sidecar.RequestTimeout = time.Duration(ms) * time.Millisecond
	}
	if list, ok := ns["retryBackoffMs"].([]any); ok {
		for _, v := range list {
			if ms := number(v, -1); ms >= 0 {
				cfg.Sidecar.Backoff = append(cfg.Sidecar.Backoff, time.Duration(ms)*time.Millisecond)
			}
		}
	}
	cfg.Sidecar.URL = nsfw.NormalizeURL(cfg.Sidecar.URL)
	a.nsfw.client.Configure(cfg.Sidecar)
	return cfg
}

func writeNSFWSidecarRequired(w http.ResponseWriter) {
	writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": nsfwSidecarMessage, "code": nsfwSidecarCode, "sidecarConfigured": false})
}

// nsfwStats mirrors 2.x getNsfwStats: candidates are LOW-score rows (likely
// not 18+), keep are rows at or above the threshold.
func (a *App) nsfwStats(ctx context.Context, cfg nsfwConfig) (map[string]any, error) {
	in := strings.TrimSuffix(strings.Repeat("?,", len(cfg.FileTypes)), ",")
	args := append([]any{cfg.Threshold, cfg.Threshold}, cfg.fileTypeArgs()...)
	var total, scanned, candidates, keep, whitelisted int64
	var last *int64
	err := a.db.Reader.QueryRowContext(ctx, `SELECT COUNT(*),
		COALESCE(SUM(nsfw_checked_at IS NOT NULL),0),
		COALESCE(SUM(nsfw_score IS NOT NULL AND nsfw_score < ? AND nsfw_whitelist = 0),0),
		COALESCE(SUM(nsfw_score IS NOT NULL AND nsfw_score >= ?),0),
		MAX(nsfw_checked_at)
		FROM downloads WHERE file_type IN (`+in+`)`, args...).Scan(&total, &scanned, &candidates, &keep, &last)
	if err != nil {
		return nil, err
	}
	if err := a.db.Reader.QueryRowContext(ctx, `SELECT COUNT(*) FROM downloads WHERE nsfw_whitelist = 1`).Scan(&whitelisted); err != nil {
		return nil, err
	}
	var lastAt any
	if last != nil {
		lastAt = *last
	}
	return map[string]any{"totalEligible": total, "scanned": scanned, "candidates": candidates, "keep": keep, "whitelisted": whitelisted, "lastCheckedAt": lastAt}, nil
}

func (a *App) handleNSFWStatus(w http.ResponseWriter, r *http.Request) {
	cfg := a.nsfwSettings(r.Context())
	stats, err := a.nsfwStats(r.Context(), cfg)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "nsfw status query failed")
		return
	}
	a.nsfw.mu.Lock()
	scan := a.nsfw.scan
	a.nsfw.mu.Unlock()
	out := map[string]any{"enabled": cfg.Enabled, "running": scan.Running, "scanned": stats["scanned"], "total": scan.Total, "candidates": stats["candidates"], "keep": stats["keep"], "whitelisted": stats["whitelisted"], "totalEligible": stats["totalEligible"], "lastCheckedAt": stats["lastCheckedAt"], "startedAt": scan.StartedAt, "finishedAt": scan.FinishedAt, "error": scan.Error, "model": cfg.Model, "threshold": cfg.Threshold, "fileTypes": cfg.FileTypes, "concurrency": cfg.Concurrency, "sidecarConfigured": cfg.Sidecar.URL != ""}
	if scan.Running {
		// Live counters while the run is in flight, like 2.x's merged state.
		out["scanned"] = scan.Scanned
	}
	if cfg.Sidecar.URL == "" {
		out["code"] = nsfwSidecarCode
		out["message"] = nsfwSidecarMessage
		if cfg.Enabled && scan.Error == nil {
			out["error"] = nsfwSidecarMessage
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *App) handleNSFWScan(w http.ResponseWriter, r *http.Request) {
	cfg := a.nsfwSettings(r.Context())
	if !cfg.Enabled {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "NSFW review is disabled. Open Maintenance → NSFW review and toggle it on first.", "code": "NSFW_DISABLED"})
		return
	}
	if cfg.Sidecar.URL == "" {
		writeNSFWSidecarRequired(w)
		return
	}
	switch a.startNSFWScan(cfg) {
	case errNSFWScanRunning:
		writeJSON(w, http.StatusConflict, map[string]any{"error": "A scan is already running", "code": "ALREADY_RUNNING"})
	case errNSFWStopping:
		writeJSONError(w, http.StatusServiceUnavailable, "server is stopping")
	default:
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "started": true})
	}
}

func (a *App) handleNSFWScanCancel(w http.ResponseWriter, _ *http.Request) {
	a.nsfw.mu.Lock()
	cancel := a.nsfw.scanCancel
	a.nsfw.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "cancelled": cancel != nil})
}

// handleNSFWPreload has no weights to fetch here; it checks that the
// sidecar's model is loaded and reports it through the same model-status
// state and nsfw_model_downloading event the page already listens to.
func (a *App) handleNSFWPreload(w http.ResponseWriter, r *http.Request) {
	cfg := a.nsfwSettings(r.Context())
	if cfg.Sidecar.URL == "" {
		writeNSFWSidecarRequired(w)
		return
	}
	h := a.nsfwRefreshLoad(r.Context(), cfg)
	status := "ready"
	if !h.OK {
		status = "error"
	}
	a.hub.Broadcast(ws.Event{Type: "nsfw_model_downloading", Flat: true, Payload: map[string]any{"status": status, "model": h.Model, "error": h.Error}})
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "started": true, "remote": true, "alreadyReady": h.OK, "sidecarHealth": h})
}

func (a *App) nsfwRefreshLoad(ctx context.Context, cfg nsfwConfig) nsfw.Health {
	h := a.nsfw.client.Health(ctx)
	now := time.Now().UnixMilli()
	state, model, errText := "ready", any("remote"), any(nil)
	if h.Model != nil {
		model = h.Model
	}
	if !h.OK {
		state, errText = "error", h.Error
		if h.Error == "" {
			errText = "sidecar reports the model is not ready"
		}
	}
	a.nsfw.mu.Lock()
	a.nsfw.load = map[string]any{"state": state, "model": model, "dtype": nil, "progress": nil, "error": errText, "startedAt": now, "finishedAt": now}
	a.nsfw.mu.Unlock()
	return h
}

func (a *App) handleNSFWSidecarTest(w http.ResponseWriter, r *http.Request) {
	body, ok := readAuthBody(w, r)
	if !ok {
		return
	}
	base, problem := nsfw.ProbeURL(toString(body["url"]))
	if problem != "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": problem})
		return
	}
	cfg := a.nsfwSettings(r.Context())
	// The typed token wins; otherwise reuse the saved one when the URL under
	// test is the saved URL, so a write-only secret needn't be re-entered.
	token := strings.TrimSpace(toString(body["token"]))
	if token == "" && body["useSavedToken"] != false && cfg.Sidecar.URL != "" && nsfw.NormalizeURL(base) == cfg.Sidecar.URL {
		token = cfg.Sidecar.Token
	}
	res := nsfw.Probe(r.Context(), &http.Client{}, base, token)
	h := res.Health
	var pathMode any
	if v, ok := h["path_mode"].(bool); ok {
		pathMode = v
	}
	transfer := "base64"
	for _, f := range res.Features {
		if f == "upload" {
			transfer = "upload"
		}
	}
	var errText, authRequired any
	if res.Error != "" {
		errText = res.Error
	}
	if res.AuthRequired != nil {
		authRequired = *res.AuthRequired
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": res.OK, "reachable": res.Reachable, "error": errText, "version": res.Version, "model": h["model"], "ready": h["ready"] == true, "device": h["device"], "features": res.Features, "auth": res.Auth, "authRequired": authRequired, "pathMode": pathMode, "transfer": transfer, "tokenSent": token != ""})
}

func (a *App) handleNSFWModelStatus(w http.ResponseWriter, r *http.Request) {
	cfg := a.nsfwSettings(r.Context())
	if cfg.Sidecar.URL != "" {
		a.nsfwRefreshLoad(r.Context(), cfg)
	}
	a.nsfw.mu.Lock()
	out := cloneConfigValue(a.nsfw.load).(map[string]any)
	a.nsfw.mu.Unlock()
	if cfg.Sidecar.URL == "" {
		out = map[string]any{"state": "idle", "model": nil, "dtype": nil, "progress": nil, "error": nsfwSidecarMessage, "code": nsfwSidecarCode, "startedAt": nil, "finishedAt": nil}
	}
	out["success"] = true
	out["ready"] = out["state"] == "ready"
	sidecar := a.nsfw.client.Info()
	sidecar["sources"] = cfg.Sources
	sidecar["configured"] = cfg.Sidecar.URL != ""
	out["sidecar"] = sidecar
	writeJSON(w, http.StatusOK, out)
}

// handleNSFWCache: the weights live in the sidecar, so this server has no
// model cache to wipe.
func (a *App) handleNSFWCache(w http.ResponseWriter, r *http.Request) {
	if a.nsfwSettings(r.Context()).Sidecar.URL == "" {
		writeNSFWSidecarRequired(w)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "files": 0, "bytes": 0, "remote": true})
}

// handleNSFWResults is the 2.x delete-candidate list (score below threshold).
func (a *App) handleNSFWResults(w http.ResponseWriter, r *http.Request) {
	cfg := a.nsfwSettings(r.Context())
	page := max(1, queryInt(r, "page", 1))
	limit := min(200, max(1, queryInt(r, "limit", 50)))
	in := strings.TrimSuffix(strings.Repeat("?,", len(cfg.FileTypes)), ",")
	where := `file_type IN (` + in + `) AND nsfw_score IS NOT NULL AND nsfw_score < ? AND nsfw_whitelist = 0`
	args := append(cfg.fileTypeArgs(), cfg.Threshold)
	var total int64
	if err := a.db.Reader.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM downloads WHERE `+where, args...).Scan(&total); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "nsfw results query failed")
		return
	}
	rows, err := a.db.Reader.QueryContext(r.Context(), `SELECT id, CAST(group_id AS TEXT), group_name, file_name, file_path, file_type, file_size, CAST(created_at AS TEXT), nsfw_score, nsfw_checked_at FROM downloads WHERE `+where+` ORDER BY nsfw_score ASC, id ASC LIMIT ? OFFSET ?`, append(args, limit, (page-1)*limit)...)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "nsfw results query failed")
		return
	}
	defer rows.Close()
	list := []map[string]any{}
	for rows.Next() {
		var id int64
		var gid, gname, name, path, kind, created any
		var size, checked any
		var score any
		if err := rows.Scan(&id, &gid, &gname, &name, &path, &kind, &size, &created, &score, &checked); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "nsfw results read failed")
			return
		}
		list = append(list, map[string]any{"id": id, "group_id": gid, "group_name": gname, "file_name": name, "file_path": path, "file_type": kind, "file_size": size, "created_at": created, "nsfw_score": score, "nsfw_checked_at": checked})
	}
	if rows.Err() != nil {
		writeJSONError(w, http.StatusInternalServerError, "nsfw results read failed")
		return
	}
	pages := int64(math.Max(1, math.Ceil(float64(total)/float64(limit))))
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "rows": list, "total": total, "page": page, "totalPages": pages, "threshold": cfg.Threshold})
}

func (a *App) handleNSFWTiersMeta(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"tiers": nsfwTierMeta})
}

func (a *App) handleNSFWTiers(w http.ResponseWriter, r *http.Request) {
	cfg := a.nsfwSettings(r.Context())
	payload, status := a.invokeRead(r, a.read.NsfwTiers, map[string]any{"fileTypes": cfg.FileTypes})
	if status < 400 {
		payload["threshold"], payload["tiers_meta"] = cfg.Threshold, nsfwTierMeta
	}
	writeJSON(w, status, payload)
}

func (a *App) handleNSFWHistogram(w http.ResponseWriter, r *http.Request) {
	cfg := a.nsfwSettings(r.Context())
	payload, status := a.invokeRead(r, a.read.NsfwHistogram, map[string]any{"fileTypes": cfg.FileTypes, "bins": queryInt(r, "bins", 20)})
	writeJSON(w, status, payload)
}

func (a *App) handleNSFWList(w http.ResponseWriter, r *http.Request) {
	cfg := a.nsfwSettings(r.Context())
	q := r.URL.Query()
	payload, status := a.invokeRead(r, a.read.NsfwList, map[string]any{
		"tier": q.Get("tier"), "fileTypes": cfg.FileTypes, "groupId": q.Get("group"),
		"includeWhitelisted": q.Get("include_whitelisted") == "1",
		"page":               queryInt(r, "page", 1), "limit": queryInt(r, "limit", 50), "fileKind": q.Get("kind"),
	})
	writeJSON(w, status, payload)
}

func (a *App) handleNSFWBlocklistStats(w http.ResponseWriter, r *http.Request) {
	var n int64
	if err := a.db.Reader.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM nsfw_hash_blocklist`).Scan(&n); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "nsfw blocklist query failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"count": n})
}

func (a *App) handleNSFWBlocklistClear(w http.ResponseWriter, r *http.Request) {
	body, ok := readAuthBody(w, r)
	if !ok {
		return
	}
	if body["confirm"] != true {
		writeJSONError(w, http.StatusBadRequest, `Pass {"confirm": true} in the request body to proceed.`)
		return
	}
	res, err := a.db.Writer.ExecContext(r.Context(), `DELETE FROM nsfw_hash_blocklist`)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "nsfw blocklist clear failed")
		return
	}
	removed, _ := res.RowsAffected()
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "removed": removed})
}

// broadcastNSFWStats sends the light nsfw_progress refresh 2.x fires after
// review mutations so open dashboards update their counters.
func (a *App) broadcastNSFWStats(ctx context.Context) {
	cfg := a.nsfwSettings(ctx)
	stats, err := a.nsfwStats(ctx, cfg)
	if err != nil {
		return
	}
	a.nsfw.mu.Lock()
	stats["running"] = a.nsfw.scan.Running
	a.nsfw.mu.Unlock()
	a.hub.Broadcast(ws.Event{Type: "nsfw_progress", Flat: true, Payload: stats})
}
