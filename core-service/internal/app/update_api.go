package app

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/version"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

// One-click update through the watchtower sidecar, the same flow as 2.x:
// ping watchtower → check the live DB → snapshot it to data/backups →
// verify the snapshot → POST /v1/update. The audit rows in update_history
// are promoted to success when the recreated container boots a new version.

const (
	updatePingTimeout    = 5 * time.Second
	updateTriggerTimeout = 15 * time.Second
)

var updateSnapshotName = regexp.MustCompile(`^db-pre-update-(\d{8}-\d{6})\.sqlite$`)

type updateError struct {
	code, msg string
	backup    map[string]any
}

func (e *updateError) Error() string { return e.msg }

func registerUpdateRoutes(mux *http.ServeMux, a *App) {
	mux.Handle("GET /api/update/status", a.requireSession(http.HandlerFunc(a.handleUpdateStatus)))
	mux.Handle("POST /api/update", a.requireAdmin(http.HandlerFunc(a.handleUpdateRun)))
	mux.Handle("GET /api/auto-update/status", a.requireAdmin(http.HandlerFunc(a.handleAutoUpdateJob)))
	mux.Handle("GET /api/update/history", a.requireAdmin(http.HandlerFunc(a.handleUpdateHistory)))
}

func envInt(name string, fallback int) int {
	if n, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name))); err == nil && n > 0 {
		return n
	}
	return fallback
}

// watchtowerToken prefers WATCHTOWER_HTTP_API_TOKEN, else the token the
// app generates once in data/watchtower/api-token for the bundled sidecar.
func (a *App) watchtowerToken() string {
	if token := strings.TrimSpace(os.Getenv("WATCHTOWER_HTTP_API_TOKEN")); token != "" {
		return token
	}
	file := filepath.Join(a.dataDir, "watchtower", "api-token")
	if raw, err := os.ReadFile(file); err == nil {
		return strings.TrimSpace(string(raw))
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err == nil {
		_ = os.MkdirAll(filepath.Dir(file), 0o755)
		if f, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644); err == nil {
			_, _ = f.WriteString(hex.EncodeToString(buf))
			_ = f.Close()
		}
	}
	if raw, err := os.ReadFile(file); err == nil {
		return strings.TrimSpace(string(raw))
	}
	return ""
}

// ensureWatchtowerToken creates data/watchtower/ at boot when the sidecar is
// wired, so Synology's Docker can bind-mount the token folder.
func (a *App) ensureWatchtowerToken() {
	if os.Getenv("WATCHTOWER_URL") != "" {
		_ = a.watchtowerToken()
	}
}

func (a *App) watchtowerEndpoint() (string, string, bool) {
	raw := strings.TrimRight(strings.TrimSpace(os.Getenv("WATCHTOWER_URL")), "/")
	if raw == "" {
		return "", "", false
	}
	if u, err := url.Parse(raw); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", "", false
	}
	token := a.watchtowerToken()
	if token == "" {
		return "", "", false
	}
	return raw, token, true
}

var inDocker = func() bool {
	_, err := os.Stat("/.dockerenv")
	return err == nil
}

func (a *App) autoUpdateStatus() map[string]any {
	endpoint, _, ok := a.watchtowerEndpoint()
	docker := inDocker()
	var shown any
	if ok {
		shown = endpoint
	}
	return map[string]any{"available": docker && ok, "inDocker": docker, "watchtowerConfigured": ok, "watchtowerUrl": shown, "overlayStallMs": envInt("UPDATE_OVERLAY_STALL_MS", 120000)}
}

func (a *App) handleUpdateStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, 200, a.autoUpdateStatus())
}

func (a *App) handleAutoUpdateJob(w http.ResponseWriter, _ *http.Request) {
	a.updateMu.Lock()
	status := cloneConfigValue(a.updateStatus)
	a.updateMu.Unlock()
	writeJSON(w, 200, status)
}

func (a *App) handleUpdateHistory(w http.ResponseWriter, r *http.Request) {
	_ = a.finalisePendingUpdates(r.Context())
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit < 1 {
		limit = 25
	}
	limit = min(limit, 200)
	rows, err := a.db.Reader.QueryContext(r.Context(), `SELECT id, from_version, to_version, from_instance_id, started_at, finished_at,
		status, error_code, error_msg, backup_path, backup_bytes FROM update_history ORDER BY id DESC LIMIT ?`, limit)
	if err != nil {
		writeJSONError(w, 500, "Failed to read update history")
		return
	}
	defer rows.Close()
	history := []map[string]any{}
	for rows.Next() {
		var id, started int64
		var status string
		var from, to, instance, code, msg, path sql.NullString
		var finished, bytes sql.NullInt64
		if err := rows.Scan(&id, &from, &to, &instance, &started, &finished, &status, &code, &msg, &path, &bytes); err != nil {
			writeJSONError(w, 500, "Failed to read update history")
			return
		}
		history = append(history, map[string]any{"id": id, "from_version": updateNullString(from), "to_version": updateNullString(to), "from_instance_id": updateNullString(instance),
			"started_at": started, "finished_at": updateNullInt(finished), "status": status, "error_code": updateNullString(code), "error_msg": updateNullString(msg),
			"backup_path": updateNullString(path), "backup_bytes": updateNullInt(bytes)})
	}
	writeJSON(w, 200, map[string]any{"history": history})
}

func updateNullString(v sql.NullString) any {
	if v.Valid {
		return v.String
	}
	return nil
}

func updateNullInt(v sql.NullInt64) any {
	if v.Valid {
		return v.Int64
	}
	return nil
}

// finalisePendingUpdates promotes rows a previous container triggered (2.x
// or 3.x) once this process runs a different version, and marks rows older
// than UPDATE_STALL_AFTER_MS that never swapped as stalled.
func (a *App) finalisePendingUpdates(ctx context.Context) error {
	now := time.Now().UnixMilli()
	stall := int64(envInt("UPDATE_STALL_AFTER_MS", 10*60*1000))
	if _, err := a.db.Writer.ExecContext(ctx, `UPDATE update_history SET status='success', finished_at=?, to_version=?
		WHERE status='triggered' AND from_version IS NOT NULL AND from_version<>?`, now, version.AppVersion, version.AppVersion); err != nil {
		return err
	}
	_, err := a.db.Writer.ExecContext(ctx, `UPDATE update_history SET status='stalled', finished_at=?, error_code='STALL_TIMEOUT', error_msg=?
		WHERE status='triggered' AND ?-started_at>?`, now, fmt.Sprintf("Container did not recreate within %d min; watchtower swap likely never completed.", stall/60000), now, stall)
	return err
}

func (a *App) handleUpdateRun(w http.ResponseWriter, _ *http.Request) {
	a.updateMu.Lock()
	if a.updateStatus["running"] == true {
		a.updateMu.Unlock()
		writeJSON(w, 409, map[string]any{"error": "An update is already in progress", "code": "ALREADY_RUNNING"})
		return
	}
	done, ok := a.beginMaintenance()
	if !ok {
		a.updateMu.Unlock()
		writeJSONError(w, 503, "Server is stopping")
		return
	}
	started := time.Now()
	status := a.updateStatus
	status["attempts"] = jobCount(status["attempts"]) + 1
	status["running"], status["stage"], status["error"], status["result"] = true, "starting", nil, nil
	status["startedAt"], status["finishedAt"], status["durationMs"] = started.UnixMilli(), 0, 0
	a.updateMu.Unlock()
	go func() {
		defer done()
		result, err := a.runAutoUpdate(a.ctx)
		a.updateMu.Lock()
		status := a.updateStatus
		status["running"], status["finishedAt"], status["durationMs"] = false, time.Now().UnixMilli(), time.Since(started).Milliseconds()
		payload := map[string]any{"kind": "autoUpdate"}
		if err != nil {
			status["stage"], status["error"] = "error", err.Error()
			status["failures"] = jobCount(status["failures"]) + 1
			payload["error"] = err.Error()
		} else {
			status["stage"], status["result"] = "done", result
			status["successes"] = jobCount(status["successes"]) + 1
		}
		a.updateMu.Unlock()
		if err != nil {
			a.hub.Broadcast(ws.Event{Type: "update_done", Flat: true, Payload: payload})
		}
	}()
	writeJSON(w, 200, map[string]any{"success": true, "started": true})
}

func (a *App) runAutoUpdate(ctx context.Context) (map[string]any, error) {
	from := version.AppVersion
	fail := func(err error) (map[string]any, error) {
		code, msg := "UNKNOWN", err.Error()
		var backupPath, backupBytes any
		var ue *updateError
		if errors.As(err, &ue) {
			code = ue.code
			if ue.backup != nil {
				backupPath, backupBytes = ue.backup["path"], ue.backup["sizeBytes"]
			}
		}
		now := time.Now().UnixMilli()
		_, _ = a.db.Writer.ExecContext(context.WithoutCancel(ctx), `INSERT INTO update_history(from_version,started_at,finished_at,status,error_code,error_msg,backup_path,backup_bytes)
			VALUES(?,?,?,'failed',?,?,?,?)`, from, now, now, code, msg, backupPath, backupBytes)
		return nil, err
	}
	status := a.autoUpdateStatus()
	if status["available"] != true {
		why := "Watchtower sidecar is not configured. Use the bundled docker-compose.yml (it includes the watchtower service) and set WATCHTOWER_HTTP_API_TOKEN in .env."
		if status["inDocker"] != true {
			why = "Auto-update only works inside Docker (the dashboard process is not running in a container)."
		}
		return fail(&updateError{code: "AUTO_UPDATE_UNAVAILABLE", msg: why})
	}
	endpoint, token, _ := a.watchtowerEndpoint()
	if err := pingWatchtower(ctx, endpoint, token); err != nil {
		return fail(err)
	}
	if err := quickCheck(ctx, a.db.Writer); err != nil {
		return fail(&updateError{code: "DB_CORRUPT", msg: "Live DB integrity check failed — " + err.Error() + ". Refusing to snapshot a corrupt DB; run \"Maintenance → DB integrity\" and recover before retrying."})
	}
	backup, err := a.snapshotForUpdate(ctx)
	if err != nil {
		return fail(&updateError{code: "BACKUP_FAILED", msg: "Pre-update DB snapshot failed: " + err.Error()})
	}
	if err := verifyUpdateSnapshot(ctx, backup["path"].(string)); err != nil {
		_ = os.Remove(backup["path"].(string))
		return fail(&updateError{code: "BACKUP_VERIFY_FAILED", msg: "Pre-update snapshot verification failed: " + err.Error() + ". The bad snapshot has been deleted; please retry once you've inspected disk health."})
	}
	// Record and announce before watchtower stops this container.
	_, _ = a.db.Writer.ExecContext(ctx, `INSERT INTO update_history(from_version,started_at,status,backup_path,backup_bytes) VALUES(?,?,'triggered',?,?)`,
		from, time.Now().UnixMilli(), backup["path"], backup["sizeBytes"])
	a.hub.Broadcast(ws.Event{Type: "update_started", Flat: true, Payload: map[string]any{"backup": backup}})
	if err := triggerWatchtower(ctx, endpoint, token); err != nil {
		_, _ = a.db.Writer.ExecContext(context.WithoutCancel(ctx), `UPDATE update_history SET status='failed', finished_at=?, error_code='TRIGGER_FAILED', error_msg=?
			WHERE id=(SELECT max(id) FROM update_history WHERE status='triggered')`, time.Now().UnixMilli(), "Watchtower trigger failed: "+err.Error())
		return nil, &updateError{code: "TRIGGER_FAILED", msg: "Watchtower trigger failed: " + err.Error(), backup: backup}
	}
	return map[string]any{"backup": backup}, nil
}

func pingWatchtower(ctx context.Context, endpoint, token string) error {
	ctx, cancel := context.WithTimeout(ctx, updatePingTimeout)
	defer cancel()
	// GET / — `HEAD /v1/update` would make watchtower start pulling.
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"/", nil)
	if err != nil {
		return &updateError{code: "WATCHTOWER_UNREACHABLE", msg: "Watchtower preflight failed — " + err.Error()}
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		reason := "unreachable: " + err.Error()
		if ctx.Err() != nil {
			reason = fmt.Sprintf("ping timed out after %dms", updatePingTimeout.Milliseconds())
		}
		return &updateError{code: "WATCHTOWER_UNREACHABLE", msg: "Watchtower preflight failed — " + reason + ". The sidecar may be down or the WATCHTOWER_URL / token is wrong."}
	}
	res.Body.Close()
	switch {
	case res.StatusCode == 401 || res.StatusCode == 403:
		return &updateError{code: "WATCHTOWER_UNAUTHENTICATED", msg: fmt.Sprintf("Watchtower preflight failed — watchtower returned HTTP %d — token rejected. Re-generate WATCHTOWER_HTTP_API_TOKEN in .env (it must match the watchtower sidecar) and recreate the watchtower service.", res.StatusCode)}
	case res.StatusCode >= 500:
		return &updateError{code: "WATCHTOWER_UNREACHABLE", msg: fmt.Sprintf("Watchtower preflight failed — watchtower returned HTTP %d. The sidecar may be down or the WATCHTOWER_URL / token is wrong.", res.StatusCode)}
	}
	return nil
}

func triggerWatchtower(ctx context.Context, endpoint, token string) error {
	ctx, cancel := context.WithTimeout(ctx, updateTriggerTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint+"/v1/update", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		// Still pulling after the timeout: watchtower accepted the request.
		if ctx.Err() != nil {
			return nil
		}
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		buf := make([]byte, 200)
		n, _ := res.Body.Read(buf)
		return fmt.Errorf("watchtower /v1/update returned %d %s", res.StatusCode, strings.TrimSpace(string(buf[:n])))
	}
	return nil
}

func quickCheck(ctx context.Context, db *sql.DB) error {
	rows, err := db.QueryContext(ctx, `PRAGMA quick_check`)
	if err != nil {
		return err
	}
	defer rows.Close()
	var results []string
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			return err
		}
		results = append(results, line)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(results) != 1 || results[0] != "ok" {
		return fmt.Errorf("quick_check failed — %s", strings.Join(results[:min(len(results), 5)], "; "))
	}
	return nil
}

func (a *App) snapshotForUpdate(ctx context.Context) (map[string]any, error) {
	dir := filepath.Join(a.dataDir, "backups")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	dst := filepath.Join(dir, "db-pre-update-"+time.Now().UTC().Format("20060102-150405")+".sqlite")
	ctx, cancel := context.WithTimeout(ctx, time.Duration(envInt("UPDATE_SNAPSHOT_TIMEOUT_MS", 15*60*1000))*time.Millisecond)
	defer cancel()
	// VACUUM INTO writes a consistent copy of the live WAL database. A 2 GB
	// library takes about a minute on a NAS, so allow 15 minutes by default.
	if _, err := a.db.Writer.ExecContext(ctx, `VACUUM INTO ?`, dst); err != nil {
		_ = os.Remove(dst)
		return nil, err
	}
	info, err := os.Stat(dst)
	if err != nil {
		return nil, err
	}
	if entries, err := os.ReadDir(dir); err == nil {
		var names []string
		for _, entry := range entries {
			if updateSnapshotName.MatchString(entry.Name()) {
				names = append(names, entry.Name())
			}
		}
		sort.Sort(sort.Reverse(sort.StringSlice(names)))
		for _, old := range names[min(len(names), envInt("UPDATE_BACKUP_KEEP", 5)):] {
			_ = os.Remove(filepath.Join(dir, old))
		}
	}
	return map[string]any{"path": dst, "sizeBytes": info.Size()}, nil
}

func verifyUpdateSnapshot(ctx context.Context, path string) error {
	if _, err := os.Stat(path); err != nil {
		return errors.New("snapshot file missing")
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?mode=ro")
	if err != nil {
		return err
	}
	defer db.Close()
	var name string
	if err := db.QueryRowContext(ctx, `SELECT name FROM sqlite_master WHERE type='table' AND name='downloads'`).Scan(&name); err != nil {
		return errors.New("snapshot missing downloads table")
	}
	if err := quickCheck(ctx, db); err != nil {
		return fmt.Errorf("snapshot %w", err)
	}
	return nil
}
