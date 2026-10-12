package app

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

type historyJob struct {
	ID          string  `json:"id"`
	State       string  `json:"state"`
	Processed   int     `json:"processed"`
	Downloaded  int     `json:"downloaded"`
	Error       *string `json:"error"`
	Group       string  `json:"group"`
	GroupID     string  `json:"groupId"`
	Limit       *int    `json:"limit"`
	StartedAt   int64   `json:"startedAt"`
	FinishedAt  *int64  `json:"finishedAt"`
	Cancelled   bool    `json:"cancelled"`
	Mode        string  `json:"mode,omitempty"`
	OffsetDate  int64   `json:"offsetDate,omitempty"` // unix seconds: only messages sent before
	MinDate     int64   `json:"minDate,omitempty"`    // unix seconds: stop at messages sent before
	accountID   string
	query       string
	cursor      int
	minID       int
	initialized bool
}

type historyRecord struct {
	Job         historyJob `json:"job"`
	AccountID   string     `json:"accountId"`
	Query       string     `json:"query"`
	Cursor      int        `json:"cursor"`
	MinID       int        `json:"minId"`
	Initialized bool       `json:"initialized"`
}

func historyBytes(j historyJob) ([]byte, error) {
	return json.Marshal(historyRecord{j, j.accountID, j.query, j.cursor, j.minID, j.initialized})
}

func registerHistoryRoutes(mux *http.ServeMux, a *App) {
	mux.Handle("POST /api/history", a.requireAdmin(http.HandlerFunc(a.handleHistoryStart)))
	mux.Handle("GET /api/history", a.requireAdmin(http.HandlerFunc(a.handleHistoryLive)))
	mux.Handle("GET /api/history/jobs", a.requireAdmin(http.HandlerFunc(a.handleHistoryJobs)))
	mux.Handle("GET /api/history/{jobId}", a.requireAdmin(http.HandlerFunc(a.handleHistoryGet)))
	mux.Handle("POST /api/history/{jobId}/cancel", a.requireAdmin(http.HandlerFunc(a.handleHistoryCancel)))
	mux.Handle("DELETE /api/history/{jobId}", a.requireAdmin(http.HandlerFunc(a.handleHistoryDelete)))
	mux.Handle("DELETE /api/history", a.requireAdmin(http.HandlerFunc(a.handleHistoryClear)))
}

func (a *App) recoverHistoryJobs(ctx context.Context) error {
	a.historyJobs = map[string]*historyJob{}
	a.historyCancel = map[string]context.CancelFunc{}
	rows, err := a.db.Reader.QueryContext(ctx, `SELECT payload FROM tgdl_history_jobs WHERE state='running'`)
	if err != nil {
		return err
	}
	var jobs []*historyJob
	for rows.Next() {
		var data []byte
		if err = rows.Scan(&data); err != nil {
			rows.Close()
			return err
		}
		var record historyRecord
		if err = json.Unmarshal(data, &record); err != nil {
			rows.Close()
			return err
		}
		j := record.Job
		j.accountID, j.query, j.cursor, j.minID, j.initialized = record.AccountID, record.Query, record.Cursor, record.MinID, record.Initialized
		if j.ID == "" || j.GroupID == "" || j.State != "running" {
			rows.Close()
			return errors.New("invalid persisted history job")
		}
		a.historyJobs[j.ID] = &j
		jobs = append(jobs, &j)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, j := range jobs {
		a.startHistoryWorker(j.ID)
	}
	pending, err := a.monitor.PendingManual(ctx)
	if err != nil {
		return err
	}
	if pending > 0 {
		a.startHistoryDrain(true)
	}
	return nil
}

func (a *App) handleHistoryStart(w http.ResponseWriter, r *http.Request) {
	var body struct {
		GroupID  any    `json:"groupId"`
		Limit    any    `json:"limit"`
		OffsetID any    `json:"offsetId"`
		Mode     string `json:"mode"`
		// Date bounds: unix seconds (milliseconds are recognised),
		// YYYY-MM-DD (UTC midnight) or RFC 3339. offsetDate is Telegram's
		// offset_date (messages sent before it); minDate ends the walk.
		OffsetDate any `json:"offsetDate"`
		MinDate    any `json:"minDate"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
		writeJSONError(w, 400, "Invalid JSON body")
		return
	}
	id := strings.TrimSpace(toString(body.GroupID))
	if id == "" {
		writeJSONError(w, 400, "groupId required")
		return
	}
	offsetDate, err := historyDateBound(body.OffsetDate)
	if err != nil {
		writeJSONError(w, 400, "offsetDate: "+err.Error())
		return
	}
	minDate, err := historyDateBound(body.MinDate)
	if err != nil {
		writeJSONError(w, 400, "minDate: "+err.Error())
		return
	}
	if offsetDate > 0 && minDate >= offsetDate {
		writeJSONError(w, 400, "minDate must be earlier than offsetDate")
		return
	}
	a.historyMu.Lock()
	for _, j := range a.historyJobs {
		if j.GroupID == id && j.State == "running" {
			jobID := j.ID
			a.historyMu.Unlock()
			writeJSON(w, 409, map[string]any{"error": "A backfill is already running for this group", "code": "ALREADY_RUNNING", "jobId": jobID})
			return
		}
	}
	a.historyMu.Unlock()
	access := a.chatAccessForID(r, id)
	if state := toString(access["state"]); blockingChatState(state) {
		if code := toString(access["code"]); code != "" {
			state += ": " + code
		}
		writeJSON(w, 409, map[string]any{"error": "This chat can't be reached (" + state + ") — no account can read it", "code": "CHAT_UNREACHABLE", "access": access})
		return
	}
	cfg, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	api, _ := cfg["telegram"].(map[string]any)
	if number(api["apiId"], 0) <= 0 || strings.TrimSpace(toString(api["apiHash"])) == "" {
		writeJSONError(w, 500, "Telegram API credentials not configured")
		return
	}
	saved, err := telegram.SavedSessions(a.dataDir)
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	if len(saved) == 0 {
		writeJSONError(w, 409, "No Telegram accounts loaded")
		return
	}
	if a.purgePending() {
		writeJSONError(w, 409, "a purge must finish before history can start")
		return
	}
	limit := 100
	if body.Limit != nil {
		if value, e := strconv.Atoi(toString(body.Limit)); e == nil {
			limit = value
		}
	}
	if limit != 0 {
		limit = max(1, min(50000, limit))
	}
	mode := body.Mode
	if mode != "catch-up" && mode != "rescan" {
		mode = "pull-older"
	}
	offset := max(0, int(number(body.OffsetID, 0)))
	if offset > 0 {
		mode = "rescan"
	}
	buf := make([]byte, 6)
	if _, err = rand.Read(buf); err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	j := &historyJob{ID: hex.EncodeToString(buf), State: "running", Group: id, GroupID: id, StartedAt: time.Now().UnixMilli(), Mode: mode, OffsetDate: offsetDate, MinDate: minDate, query: id, cursor: offset}
	if limit != 0 {
		j.Limit = &limit
	}
	for _, g := range configuredGroupList(cfg) {
		if toString(g["id"]) == id {
			j.Group = toString(g["name"])
			j.accountID = toString(g["monitorAccount"])
			break
		}
	}
	done, ok := a.beginMaintenance()
	if !ok {
		writeJSONError(w, 503, "Server is shutting down")
		return
	}
	defer done()
	a.historyMu.Lock()
	for _, old := range a.historyJobs {
		if old.GroupID == id && old.State == "running" {
			jobID := old.ID
			a.historyMu.Unlock()
			writeJSON(w, 409, map[string]any{"error": "A backfill is already running for this group", "code": "ALREADY_RUNNING", "jobId": jobID})
			return
		}
	}
	data, err := historyBytes(*j)
	if err == nil {
		_, err = a.db.Writer.ExecContext(r.Context(), `INSERT INTO tgdl_history_jobs(id,group_id,state,payload) VALUES(?,?,?,?)`, j.ID, j.GroupID, j.State, string(data))
	}
	if err != nil {
		a.historyMu.Unlock()
		writeJSONError(w, 500, err.Error())
		return
	}
	a.historyJobs[j.ID] = j
	jobID := j.ID
	response := map[string]any{"success": true, "jobId": jobID, "group": j.Group, "limit": j.Limit, "mode": j.Mode}
	if j.OffsetDate > 0 {
		response["offsetDate"] = j.OffsetDate
	}
	if j.MinDate > 0 {
		response["minDate"] = j.MinDate
	}
	a.historyMu.Unlock()
	a.startHistoryWorker(jobID)
	writeJSON(w, 200, response)
}

// historyDateBound reads a backfill date bound as unix seconds; absent or
// empty is 0 (no bound).
func historyDateBound(value any) (int64, error) {
	var seconds float64
	switch v := value.(type) {
	case nil:
		return 0, nil
	case float64:
		seconds = v
	case string:
		v = strings.TrimSpace(v)
		if v == "" {
			return 0, nil
		}
		if n, err := strconv.ParseFloat(v, 64); err == nil {
			seconds = n
			break
		}
		var at time.Time
		var err error
		if at, err = time.Parse(time.DateOnly, v); err != nil {
			if at, err = time.Parse(time.RFC3339, v); err != nil {
				return 0, errors.New("use unix seconds, YYYY-MM-DD or an RFC 3339 time")
			}
		}
		seconds = float64(at.Unix())
	default:
		return 0, errors.New("use unix seconds, YYYY-MM-DD or an RFC 3339 time")
	}
	if seconds > 1e11 { // a JavaScript millisecond timestamp
		seconds /= 1000
	}
	// Telegram dates are 32-bit unix seconds.
	if seconds < 0 || seconds > math.MaxInt32 || seconds != seconds {
		return 0, errors.New("date out of range")
	}
	return int64(seconds), nil
}

func (a *App) historyLiveLocked() []historyJob {
	out := make([]historyJob, 0, len(a.historyJobs))
	cutoff := time.Now().Add(-5 * time.Minute).UnixMilli()
	for id, j := range a.historyJobs {
		if j.FinishedAt != nil && *j.FinishedAt < cutoff {
			delete(a.historyJobs, id)
			continue
		}
		out = append(out, *j)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt > out[j].StartedAt })
	return out
}

func (a *App) handleHistoryLive(w http.ResponseWriter, r *http.Request) {
	a.historyMu.Lock()
	out := a.historyLiveLocked()
	a.historyMu.Unlock()
	writeJSON(w, 200, out)
}
func (a *App) handleHistoryGet(w http.ResponseWriter, r *http.Request) {
	a.historyMu.Lock()
	a.historyLiveLocked()
	j := a.historyJobs[r.PathValue("jobId")]
	if j == nil {
		a.historyMu.Unlock()
		writeJSONError(w, 404, "Job not found")
		return
	}
	copy := *j
	a.historyMu.Unlock()
	writeJSON(w, 200, copy)
}

func (a *App) historySaved(ctx context.Context) ([]historyJob, error) {
	var encoded string
	err := a.db.Reader.QueryRowContext(ctx, `SELECT value FROM kv WHERE key='history_jobs'`).Scan(&encoded)
	if errors.Is(err, sql.ErrNoRows) {
		return []historyJob{}, nil
	}
	if err != nil {
		return nil, err
	}
	var out []historyJob
	err = json.Unmarshal([]byte(encoded), &out)
	return out, err
}

func historyCutoff(cfg map[string]any) int64 {
	history := objectAt(cfg, "advanced", "history")
	return time.Now().Add(-time.Duration(max(1, min(3650, int(number(history["retentionDays"], 30))))) * 24 * time.Hour).UnixMilli()
}

func (a *App) handleHistoryJobs(w http.ResponseWriter, r *http.Request) {
	a.historyMu.Lock()
	defer a.historyMu.Unlock()
	saved, err := a.historySaved(r.Context())
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	cfg, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	cutoff := historyCutoff(cfg)
	byID := map[string]historyJob{}
	for _, j := range saved {
		byID[j.ID] = j
	}
	for _, j := range a.historyLiveLocked() {
		byID[j.ID] = j
	}
	active, recent := []historyJob{}, []historyJob{}
	for _, j := range byID {
		if j.State == "running" {
			active = append(active, j)
			continue
		}
		when := j.StartedAt
		if j.FinishedAt != nil {
			when = *j.FinishedAt
		}
		if when >= cutoff {
			recent = append(recent, j)
		}
	}
	sort.Slice(active, func(i, j int) bool { return active[i].StartedAt > active[j].StartedAt })
	sort.Slice(recent, func(i, j int) bool { return recent[i].StartedAt > recent[j].StartedAt })
	if len(recent) > 30 {
		recent = recent[:30]
	}
	writeJSON(w, 200, map[string]any{"active": active, "recent": recent, "past": recent})
}

func historySaveTx(ctx context.Context, tx *sql.Tx, j historyJob) error {
	data, err := historyBytes(j)
	if err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `UPDATE tgdl_history_jobs SET group_id=?,state=?,payload=? WHERE id=?`, j.GroupID, j.State, string(data), j.ID)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return errors.New("history job was removed")
	}
	return nil
}

func (a *App) handleHistoryCancel(w http.ResponseWriter, r *http.Request) {
	a.historyMu.Lock()
	defer a.historyMu.Unlock()
	j := a.historyJobs[r.PathValue("jobId")]
	if j == nil {
		writeJSONError(w, 404, "Job not found")
		return
	}
	if j.State != "running" {
		writeJSONError(w, 409, fmt.Sprintf("Job is %s, cannot cancel", j.State))
		return
	}
	copy := *j
	copy.Cancelled = true
	data, err := historyBytes(copy)
	if err == nil {
		_, err = a.db.Writer.ExecContext(r.Context(), `UPDATE tgdl_history_jobs SET payload=? WHERE id=?`, string(data), j.ID)
	}
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	*j = copy
	if cancel := a.historyCancel[j.ID]; cancel != nil {
		cancel()
	}
	a.hub.Broadcast(ws.Event{Type: "history_cancelling", Flat: true, Payload: map[string]any{"jobId": j.ID, "group": j.Group}})
	writeJSON(w, 200, map[string]any{"success": true})
}

func (a *App) deleteHistory(w http.ResponseWriter, r *http.Request, all bool) {
	a.historyMu.Lock()
	defer a.historyMu.Unlock()
	id := r.PathValue("jobId")
	if j := a.historyJobs[id]; !all && j != nil && j.State == "running" {
		writeJSONError(w, 409, "Cannot delete a running job — cancel first.")
		return
	}
	saved, err := a.historySaved(r.Context())
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	kept := []historyJob{}
	for _, j := range saved {
		if (!all && j.ID != id) || j.State == "running" {
			kept = append(kept, j)
		}
	}
	encoded, err := json.Marshal(kept)
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	tx, err := a.db.Writer.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	defer tx.Rollback()
	if all {
		_, err = tx.ExecContext(r.Context(), `DELETE FROM tgdl_history_jobs WHERE state<>'running'`)
	} else {
		_, err = tx.ExecContext(r.Context(), `DELETE FROM tgdl_history_jobs WHERE id=? AND state<>'running'`, id)
	}
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO kv(key,value,updated_at) VALUES('history_jobs',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, string(encoded), time.Now().UnixMilli())
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	removed := 0
	for key, j := range a.historyJobs {
		if j.State != "running" && (all || key == id) {
			delete(a.historyJobs, key)
			removed++
		}
	}
	if all {
		a.hub.Broadcast(ws.Event{Type: "history_cleared", Flat: true})
		writeJSON(w, 200, map[string]any{"success": true, "removed": removed})
	} else {
		a.hub.Broadcast(ws.Event{Type: "history_deleted", Flat: true, Payload: map[string]any{"jobId": id}})
		writeJSON(w, 200, map[string]any{"success": true})
	}
}
func (a *App) handleHistoryDelete(w http.ResponseWriter, r *http.Request) {
	a.deleteHistory(w, r, false)
}
func (a *App) handleHistoryClear(w http.ResponseWriter, r *http.Request) { a.deleteHistory(w, r, true) }
