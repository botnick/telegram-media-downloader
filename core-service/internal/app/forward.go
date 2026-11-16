package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/rand/v2"
	"net"
	"net/http"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/download"
	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
	"github.com/gotd/td/bin"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

// Auto-forward, as 2.x did it: after a chat's file is downloaded, the file is
// uploaded to the chat's "Forward to" destination with a caption linking the
// source post. deleteAfterForward then removes the local copy (never anything
// on Telegram). Forwards use a separate concurrency limit and never hold up
// the download queue.

// forwardSender is the engine surface auto-forward needs.
type forwardSender interface {
	Observing() bool
	SendFile(context.Context, string, telegram.SendFileRequest) (string, int, error)
}
type nativeForwardSender interface {
	ForwardMessage(context.Context, string, telegram.ForwardMessageRequest) (string, int, error)
}

var (
	forwardLocalPathPattern = regexp.MustCompile(`(?:/Users/[^\s,;]+|/home/[^\s,;]+|/private/[^\s,;]+|/tmp/[^\s,;]+|[A-Za-z]:\\[^\s,;]+)`)
	forwardSecretPattern    = regexp.MustCompile(`(?i)\b(api[_ -]?hash|api[_ -]?id|token|password|session)\b\s*[:=]\s*[^\s,;]+`)
)

type forwardJob struct {
	queueID            int64
	groupID, groupName string
	fileName           string
	messageID          int
	topicID            int
	text               string
	recordID           int64
	historyID          int64
	path               string
	facts              telegram.MediaFacts
	settings           map[string]any
	accountID          string
	stage              string
	destinations       []forwardDestination
	attempts           int
	retryAt            int64
	noAutoRetry        bool
	waitForEngine      bool
	retryBeforeSend    bool
	directForward      func(context.Context, telegram.ForwardMessageRequest) error
	sourceMessage      []byte
}

type forwardDestination struct {
	Settings             map[string]any `json:"settings"`
	Status               string         `json:"status"`
	Method               string         `json:"method"`
	Reason               string         `json:"reason,omitempty"`
	FallbackReason       string         `json:"fallbackReason,omitempty"`
	DirectFailed         bool           `json:"directFailed,omitempty"`
	DestinationMessageID int            `json:"destinationMessageId,omitempty"`
}

type forwardConfigSnapshot struct {
	Settings     map[string]any       `json:"settings"`
	AccountID    string               `json:"accountId"`
	Destinations []forwardDestination `json:"destinations,omitempty"`
}

func (a *App) handleForwardProtection(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Protect bool `json:"protect"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		return
	}
	cfg, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	forwarding, _ := cfg["forwarding"].(map[string]any)
	if forwarding == nil {
		forwarding = map[string]any{}
	}
	forwarding["protect"] = body.Protect
	cfg["forwarding"] = forwarding
	if err := a.config.Save(r.Context(), cfg); err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"success": true})
}

const (
	maxForwardConcurrency = 5
)

// queueForward persists the job before waking the single forward worker.
func (a *App) queueForward(job forwardJob) {
	ctx := a.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	if job.settings == nil {
		cfg, err := a.config.Load(ctx)
		if err != nil {
			a.forwardFailed(job, "", err)
			return
		}
		job.settings, job.accountID, _ = forwardSettings(cfg, job.groupID)
	}
	if job.stage == "" {
		job.stage = "metadata"
	}
	facts, err := json.Marshal(job.facts)
	if err != nil {
		a.forwardFailed(job, "", err)
		return
	}
	globalConfig, _ := a.config.Load(ctx)
	resolved := job.destinations
	if len(resolved) == 0 {
		for _, route := range matchingForwardRoutes(job.settings, job.topicID) {
			settings := effectiveForwardProtection(inheritCaptionSettings(route, job.settings), job.settings, route, job.topicID, globalConfig)
			resolved = append(resolved, forwardDestination{Settings: settings, Status: "pending"})
		}
	}
	forwardConfig, err := json.Marshal(forwardConfigSnapshot{Settings: job.settings, AccountID: job.accountID, Destinations: resolved})
	if err != nil {
		a.forwardFailed(job, "", err)
		return
	}
	destinationsJSON, err := json.Marshal(resolved)
	if err != nil {
		a.forwardFailed(job, "", err)
		return
	}
	queueLimit := a.forwarderConfig(ctx).queueSize
	tx, err := a.db.Writer.BeginTx(ctx, nil)
	if err != nil {
		a.forwardFailed(job, "", err)
		return
	}
	defer tx.Rollback()
	var queued int
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM tgdl_forward_queue WHERE status IN ('pending','processing')`).Scan(&queued); err != nil {
		_ = tx.Rollback()
		a.forwardFailed(job, "", err)
		return
	}
	if queued >= queueLimit {
		now := time.Now().UnixMilli()
		reason := "auto-forward queue is full"
		err = tx.QueryRowContext(ctx, `INSERT INTO tgdl_forward_queue(history_id,group_id,group_name,message_id,file_name,topic_id,caption,record_id,file_path,facts_json,forward_config_json,destinations_json,status,reason,stage,created_at,updated_at,completed_at)
			VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'failed',?,'enqueue',?,?,?) RETURNING id`, job.historyID, job.groupID, job.groupName, job.messageID, job.fileName, job.topicID, job.text, job.recordID, job.path, string(facts), string(forwardConfig), string(destinationsJSON), reason, now, now, now).Scan(&job.queueID)
		if err == nil {
			err = tx.Commit()
		} else {
			_ = tx.Rollback()
		}
		if err != nil {
			a.forwardFailed(job, "", err)
			return
		}
		a.forwardFailed(job, "", errors.New(reason))
		a.notifyForwardQueue()
		return
	}
	now := time.Now().UnixMilli()
	if job.fileName == "" && job.path != "" {
		job.fileName = path.Base(job.path)
	}
	err = tx.QueryRowContext(ctx, `INSERT INTO tgdl_forward_queue(history_id,group_id,group_name,message_id,file_name,topic_id,caption,record_id,file_path,facts_json,forward_config_json,destinations_json,stage,created_at,updated_at)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`, job.historyID, job.groupID, job.groupName, job.messageID, job.fileName, job.topicID, job.text, job.recordID, job.path, string(facts), string(forwardConfig), string(destinationsJSON), job.stage, now, now).Scan(&job.queueID)
	if err != nil {
		_ = tx.Rollback()
		a.forwardFailed(job, "", err)
		return
	}
	if err = tx.Commit(); err != nil {
		a.forwardFailed(job, "", err)
		return
	}
	a.notifyForwardQueue()
	select {
	case a.forwards <- struct{}{}:
	default:
	}
}

func (a *App) reserveForward(job *forwardJob) bool {
	ctx := a.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	facts, err := json.Marshal(job.facts)
	if err != nil {
		return false
	}
	forwardConfig, err := json.Marshal(forwardConfigSnapshot{Settings: job.settings, AccountID: job.accountID, Destinations: job.destinations})
	if err != nil {
		return false
	}
	limit := a.forwarderConfig(ctx).queueSize
	tx, err := a.db.Writer.BeginTx(ctx, nil)
	if err != nil {
		return false
	}
	defer tx.Rollback()
	var queued int
	if tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM tgdl_forward_queue WHERE status IN ('pending','processing')`).Scan(&queued) != nil || queued >= limit {
		return false
	}
	now := time.Now().UnixMilli()
	if tx.QueryRowContext(ctx, `INSERT INTO tgdl_forward_queue(history_id,group_id,group_name,message_id,file_name,topic_id,caption,record_id,file_path,facts_json,forward_config_json,status,stage,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'processing',?,?,?) RETURNING id`, job.historyID, job.groupID, job.groupName, job.messageID, job.fileName, job.topicID, job.text, 0, "", string(facts), string(forwardConfig), job.stage, now, now).Scan(&job.queueID) != nil {
		return false
	}
	if tx.Commit() != nil {
		return false
	}
	job.attempts = 1
	return job.queueID > 0
}

func (a *App) updateForwardReservation(ctx context.Context, job forwardJob, status, reason string) {
	now := time.Now().UnixMilli()
	reason = a.safeForwardReason(reason)
	completedAt := now
	if status == "pending" || status == "processing" {
		completedAt = 0
	}
	if job.queueID > 0 {
		_, _ = a.db.Writer.ExecContext(ctx, `UPDATE tgdl_forward_queue SET status=?,reason=?,stage=?,record_id=?,file_path=?,destinations_json=?,attempts=?,retry_at=?,updated_at=?,completed_at=? WHERE id=?`, status, reason, job.stage, job.recordID, job.path, mustJSON(job.destinations), job.attempts, job.retryAt, now, completedAt, job.queueID)
	} else {
		_, _ = a.db.Writer.ExecContext(ctx, `UPDATE tgdl_forward_queue SET status=?,reason=?,stage=?,record_id=?,file_path=?,destinations_json=?,attempts=?,retry_at=?,updated_at=?,completed_at=? WHERE history_id=?`, status, reason, job.stage, job.recordID, job.path, mustJSON(job.destinations), job.attempts, job.retryAt, now, completedAt, job.historyID)
	}
	a.notifyForwardQueue()
}

func (a *App) deferForwardFlood(ctx context.Context, job *forwardJob, err error) bool {
	wait, flood := tgerr.AsFloodWait(err)
	if !flood || wait <= 0 {
		return false
	}
	if job.accountID == "" && a.monitor != nil {
		job.accountID = a.monitor.DefaultAccountID()
	}
	a.blockForwardAccount(ctx, job.accountID, wait+time.Second)
	job.retryAt = time.Now().Add(wait + time.Second).UnixMilli()
	for i := range job.destinations {
		if job.destinations[i].Status == "processing" {
			job.destinations[i].Status = "pending"
			job.destinations[i].Reason = "Telegram requested a FloodWait; retry deferred"
		}
	}
	return true
}

func mustJSON(value any) string { raw, _ := json.Marshal(value); return string(raw) }

func (a *App) directForwardNow(ctx context.Context, job *forwardJob) error {
	for i, route := range matchingForwardRoutes(job.settings, job.topicID) {
		settings := job.destinations[i].Settings
		destination := toString(settings["destinationGroupId"])
		if destination == "" {
			destination = toString(settings["destination"])
		}
		if job.directForward == nil {
			return errors.New("native Telegram forwarding is unavailable")
		}
		request := telegram.ForwardMessageRequest{Source: job.groupID, Destination: destination, MessageID: job.messageID, TopicID: int(number(route["destinationTopicId"], 0))}
		var destinationMessageID int
		request.ResultMessageID = &destinationMessageID
		if toString(settings["captionMode"]) == "custom" {
			caption, entities, err := routeCaption(settings, *job)
			if err != nil {
				return err
			}
			request.EditCaption, request.Caption, request.Entities = true, caption, entities
		}
		if err := a.waitForwardAccount(ctx, job.accountID); err != nil {
			return err
		}
		job.destinations[i].Status, job.destinations[i].Method = "processing", "native_forward"
		a.persistForwardProgress(ctx, *job)
		forwardErr := job.directForward(ctx, request)
		job.destinations[i].DestinationMessageID = destinationMessageID
		if forwardErr != nil {
			if a.deferForwardFlood(ctx, job, forwardErr) {
				job.destinations[i].DirectFailed = false
				job.destinations[i].Reason = "Telegram requested a FloodWait; retry deferred"
				job.destinations[i].Method = "native_forward"
				a.persistForwardProgress(context.WithoutCancel(ctx), *job)
				return forwardErr
			}
			job.destinations[i].DirectFailed = true
			job.destinations[i].Reason = "direct forward failed"
			if ambiguousDeliveryError(forwardErr) {
				job.destinations[i].Status = "uncertain"
				job.destinations[i].Reason = "Telegram response was lost; delivery may have succeeded"
			}
			if errors.Is(forwardErr, telegram.ErrForwardCaptionUnresolved) {
				job.stage = "caption_edit_failed"
			} else {
				job.stage = "fallback_download"
				job.destinations[i].Method = "upload"
				job.destinations[i].FallbackReason = "Direct forward was rejected; downloaded and uploaded instead: " + a.safeForwardReason(forwardErr.Error())
			}
			a.persistForwardProgress(ctx, *job)
			return forwardErr
		}
		job.destinations[i].DirectFailed = false
		job.destinations[i].Reason = ""
		job.destinations[i].Status = "forwarded"
		a.persistForwardProgress(ctx, *job)
	}
	return nil
}

func (a *App) runForwards(ctx context.Context) {
	var active atomic.Int32
	var workers sync.WaitGroup
	var scheduleMu sync.Mutex
	var nextStart time.Time
	for range maxForwardConcurrency {
		workers.Add(1)
		go func() {
			defer workers.Done()
			ticker := time.NewTicker(time.Second)
			defer ticker.Stop()
			for {
				if ctx.Err() != nil {
					return
				}
				if !a.forwardEngineReady() {
					select {
					case <-ctx.Done():
						return
					case <-a.forwards:
					case <-ticker.C:
					}
					continue
				}
				config := a.forwarderConfig(ctx)
				current := active.Load()
				if current < int32(config.concurrency) && active.CompareAndSwap(current, current+1) {
					job, err := a.claimForward(ctx)
					if err == nil && job != nil {
						if !a.waitForwardStart(ctx, &scheduleMu, &nextStart, time.Duration(config.intervalSec)*time.Second) {
							if err := a.releaseForwardClaim(ctx, job.queueID, ""); err != nil && a.output != nil {
								fmt.Fprintf(a.output, "AutoForward: could not release cancelled forward job: %v\n", err)
							}
							active.Add(-1)
							continue
						}
						if !a.forwardEngineReady() {
							if err := a.releaseForwardClaim(ctx, job.queueID, "Waiting for monitor to start"); err != nil && a.output != nil {
								fmt.Fprintf(a.output, "AutoForward: could not return job while monitor is stopped: %v\n", err)
							}
							active.Add(-1)
							continue
						}
						a.notifyForwardQueue()
						a.forward(ctx, *job)
						active.Add(-1)
						continue
					}
					active.Add(-1)
					if err != nil && ctx.Err() == nil && a.output != nil {
						fmt.Fprintf(a.output, "AutoForward: could not claim queued job: %v\n", err)
					}
				}
				select {
				case <-ctx.Done():
					return
				case <-a.forwards:
				case <-ticker.C:
				}
			}
		}()
	}
	<-ctx.Done()
	workers.Wait()
}

type forwarderRuntimeConfig struct {
	concurrency, queueSize, intervalSec, floodWaitAttempts int
}

func (a *App) forwarderConfig(ctx context.Context) forwarderRuntimeConfig {
	cfg, err := a.config.Load(ctx)
	if err != nil {
		return forwarderRuntimeConfig{concurrency: 1, queueSize: 256, intervalSec: 1, floodWaitAttempts: 3}
	}
	advanced, _ := cfg["advanced"].(map[string]any)
	forwarder, _ := advanced["forwarder"].(map[string]any)
	return forwarderRuntimeConfig{
		concurrency:       max(1, min(maxForwardConcurrency, int(number(forwarder["concurrency"], 1)))),
		queueSize:         max(1, min(10000, int(number(forwarder["queueSize"], 256)))),
		intervalSec:       max(0, min(3600, int(number(forwarder["intervalSec"], 1)))),
		floodWaitAttempts: max(1, min(10, int(number(forwarder["floodWaitAttempts"], 3)))),
	}
}

func (a *App) forwardEngineReady() bool {
	return !a.gateForwards || a.monitor == nil || a.monitor.RequireRunning() == nil
}

func (a *App) releaseForwardClaim(ctx context.Context, queueID int64, reason string) error {
	if queueID <= 0 {
		return nil
	}
	if _, err := a.db.Writer.ExecContext(context.WithoutCancel(ctx), `UPDATE tgdl_forward_queue SET status='pending',reason=CASE WHEN ?='' THEN reason ELSE ? END,retry_at=0,updated_at=? WHERE id=? AND status='processing'`, reason, reason, time.Now().UnixMilli(), queueID); err != nil {
		return err
	}
	a.notifyForwardQueue()
	return nil
}

func (a *App) waitForwardStart(ctx context.Context, mu *sync.Mutex, next *time.Time, interval time.Duration) bool {
	mu.Lock()
	start := time.Now()
	if next.After(start) {
		start = *next
	}
	*next = start.Add(interval)
	mu.Unlock()
	if wait := time.Until(start); wait > 0 {
		timer := time.NewTimer(wait)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return false
		case <-timer.C:
		}
	}
	return ctx.Err() == nil
}

func (a *App) blockForwardAccount(ctx context.Context, accountID string, wait time.Duration) {
	if accountID == "" || wait <= 0 {
		return
	}
	until := time.Now().Add(wait).UnixMilli()
	_, _ = a.db.Writer.ExecContext(ctx, `INSERT INTO tgdl_forward_account_limits(account_id,blocked_until) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET blocked_until=MAX(blocked_until,excluded.blocked_until)`, accountID, until)
}

func (a *App) waitForwardAccount(ctx context.Context, accountID string) error {
	if accountID == "" {
		return nil
	}
	for {
		var until int64
		if err := a.db.Reader.QueryRowContext(ctx, `SELECT COALESCE((SELECT blocked_until FROM tgdl_forward_account_limits WHERE account_id=?),0)`, accountID).Scan(&until); err != nil {
			return err
		}
		wait := time.Until(time.UnixMilli(until))
		if wait <= 0 {
			return nil
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func (a *App) claimForward(ctx context.Context) (*forwardJob, error) {
	var job forwardJob
	var facts, forwardConfig, destinations string
	now := time.Now().UnixMilli()
	err := a.db.Writer.QueryRowContext(ctx, `UPDATE tgdl_forward_queue SET status='processing',reason='',retry_at=0,updated_at=? WHERE id=(
		SELECT id FROM tgdl_forward_queue WHERE status='pending' AND retry_at<=? AND COALESCE((SELECT paused FROM tgdl_forward_queue_state WHERE id=1),0)=0 ORDER BY id LIMIT 1
	) RETURNING id,history_id,group_id,group_name,message_id,file_name,topic_id,caption,record_id,file_path,facts_json,forward_config_json,stage,destinations_json,attempts,source_message`, now, now).Scan(
		&job.queueID, &job.historyID, &job.groupID, &job.groupName, &job.messageID, &job.fileName, &job.topicID, &job.text, &job.recordID, &job.path, &facts, &forwardConfig, &job.stage, &destinations, &job.attempts, &job.sourceMessage)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal([]byte(facts), &job.facts); err != nil {
		a.failClaimedForward(ctx, job.queueID, "saved forward job data is invalid; requeue after reviewing the destination")
		return nil, nil
	}
	if err = json.Unmarshal([]byte(destinations), &job.destinations); err != nil {
		a.failClaimedForward(ctx, job.queueID, "saved destination state is invalid; requeue after reviewing the destination")
		return nil, nil
	}
	var snapshot forwardConfigSnapshot
	if forwardConfig == "" || json.Unmarshal([]byte(forwardConfig), &snapshot) != nil || snapshot.Settings == nil || !hasForwardDestination(snapshot.Settings) {
		a.failClaimedForward(ctx, job.queueID, "saved destination snapshot is unavailable; requeue after reviewing the destination")
		return nil, nil
	}
	job.settings, job.accountID = snapshot.Settings, snapshot.AccountID
	if len(snapshot.Destinations) > 0 && len(job.destinations) == 0 {
		job.destinations = snapshot.Destinations
	}
	return &job, nil
}

func (a *App) failClaimedForward(ctx context.Context, id int64, reason string) {
	now := time.Now().UnixMilli()
	_, _ = a.db.Writer.ExecContext(ctx, `UPDATE tgdl_forward_queue SET status='failed',reason=?,updated_at=?,completed_at=? WHERE id=? AND status='processing'`, reason, now, now, id)
	a.notifyForwardQueue()
}

func (a *App) notifyForwardQueue() {
	if a.hub != nil {
		a.hub.Broadcast(ws.Event{Type: "forward_queue_changed", Flat: true})
	}
}

func (a *App) handleManualForwardEnqueue(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IDs         []int64  `json:"ids"`
		Paths       []string `json:"paths"`
		Destination string   `json:"destination"`
		Caption     string   `json:"caption"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		return
	}
	if len(body.IDs) == 0 && len(body.Paths) > 0 {
		for _, p := range body.Paths {
			var id int64
			if err := a.db.Reader.QueryRowContext(r.Context(), `SELECT id FROM downloads WHERE REPLACE(file_path,char(92),'/')=? AND status='completed' ORDER BY id DESC LIMIT 1`, strings.ReplaceAll(p, "\\", "/")).Scan(&id); err != nil {
				writeJSONError(w, http.StatusNotFound, "selected media not found")
				return
			}
			body.IDs = append(body.IDs, id)
		}
	}
	if len(body.IDs) == 0 || len(body.IDs) > 100 {
		writeJSONError(w, http.StatusBadRequest, "select 1 to 100 media items")
		return
	}
	if strings.TrimSpace(body.Destination) == "" {
		writeJSONError(w, http.StatusBadRequest, "destination is required")
		return
	}
	type mediaRow struct {
		id, historyID                  int64
		groupID, groupName, name, path string
		messageID                      int
	}
	rows := make([]mediaRow, 0, len(body.IDs))
	seen := map[int64]bool{}
	for _, id := range body.IDs {
		if id <= 0 || seen[id] {
			writeJSONError(w, http.StatusBadRequest, "media IDs must be positive and unique")
			return
		}
		seen[id] = true
		var row mediaRow
		row.id = id
		err := a.db.Reader.QueryRowContext(r.Context(), `SELECT id,group_id,group_name,message_id,file_name,COALESCE(file_path,'') FROM downloads WHERE id=? AND status='completed'`, id).Scan(&row.id, &row.groupID, &row.groupName, &row.messageID, &row.name, &row.path)
		if err != nil {
			writeJSONError(w, http.StatusNotFound, "download not found")
			return
		}
		if row.messageID <= 0 {
			writeJSONError(w, http.StatusConflict, "download has no Telegram source message ID")
			return
		}
		_ = a.db.Reader.QueryRowContext(r.Context(), `SELECT id FROM tgdl_processing_attempts WHERE group_id=? AND message_id=? ORDER BY id DESC LIMIT 1`, row.groupID, row.messageID).Scan(&row.historyID)
		rows = append(rows, row)
	}
	cfg, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	queued := 0
	a.manualForwardMu.Lock()
	defer a.manualForwardMu.Unlock()
	for _, row := range rows {
		already, err := a.forwardAlreadyQueued(r.Context(), row.groupID, row.messageID, body.Destination)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if already {
			continue
		}
		settings, accountID := manualForwardSettings(cfg, row.groupID, body.Destination, body.Caption)
		if accountID == "" {
			writeJSONError(w, http.StatusConflict, "select a forward account for this source group before forwarding")
			return
		}
		a.queueForward(forwardJob{groupID: row.groupID, groupName: row.groupName, messageID: row.messageID, fileName: row.name, recordID: row.id, path: row.path, historyID: row.historyID, settings: settings, accountID: accountID, stage: "manual_direct"})
		queued++
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"success": true, "queued": queued, "skipped": len(rows) - queued})
}

func manualForwardSettings(cfg map[string]any, groupID, destination, caption string) (map[string]any, string) {
	_, accountID, _ := forwardSettings(cfg, groupID)
	for _, group := range configuredGroupList(cfg) {
		if toString(group["id"]) == groupID && accountID == "" {
			accountID = toString(group["monitorAccount"])
		}
	}
	mode := "source_info"
	if caption != "" {
		mode = "override"
	}
	route := map[string]any{"destinationGroupId": strings.TrimSpace(destination), "captionMode": mode, "caption": caption}
	return map[string]any{"enabled": true, "routes": []any{route}, "captionMode": mode, "caption": caption, "directForward": true, "scanRoute": "direct", "manualDirect": true}, accountID
}

func (a *App) forwardAlreadyQueued(ctx context.Context, groupID string, messageID int, destination string) (bool, error) {
	rows, err := a.db.Reader.QueryContext(ctx, `SELECT destinations_json FROM tgdl_forward_queue WHERE group_id=? AND message_id=? AND status IN ('pending','processing','forwarded','uncertain')`, groupID, messageID)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var raw string
		var states []forwardDestination
		if rows.Scan(&raw) != nil || json.Unmarshal([]byte(raw), &states) != nil {
			continue
		}
		for _, state := range states {
			to := toString(state.Settings["destinationGroupId"])
			if to == "" {
				to = toString(state.Settings["destination"])
			}
			if destinationKey(to) == destinationKey(destination) {
				return true, nil
			}
		}
	}
	return false, rows.Err()
}

func (a *App) handleForwardBackfill(w http.ResponseWriter, r *http.Request) {
	var body struct {
		GroupID         string `json:"groupId"`
		Destination     string `json:"destination"`
		Caption         string `json:"caption"`
		BeforeMessageID int    `json:"beforeMessageId"`
		Limit           int    `json:"limit"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		return
	}
	body.GroupID, body.Destination = strings.TrimSpace(body.GroupID), strings.TrimSpace(body.Destination)
	if body.GroupID == "" || body.Destination == "" {
		writeJSONError(w, http.StatusBadRequest, "source group and destination are required")
		return
	}
	if body.Limit <= 0 {
		body.Limit = 50
	}
	if body.Limit > 100 {
		body.Limit = 100
	}
	if body.BeforeMessageID <= 0 {
		body.BeforeMessageID = int(^uint(0) >> 1)
	}
	cfg, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	settings, accountID := manualForwardSettings(cfg, body.GroupID, body.Destination, body.Caption)
	if accountID == "" {
		writeJSONError(w, http.StatusConflict, "select a forward account for this source group before forwarding")
		return
	}
	rows, err := a.db.Reader.QueryContext(r.Context(), `SELECT record_id,group_id,group_name,message_id,file_name,file_path,history_id FROM (
		SELECT d.id AS record_id,d.group_id,d.group_name,CAST(d.message_id AS INTEGER) AS message_id,d.file_name,COALESCE(d.file_path,'') AS file_path,
		COALESCE((SELECT p.id FROM tgdl_processing_attempts p WHERE p.group_id=d.group_id AND p.message_id=d.message_id ORDER BY p.id DESC LIMIT 1),0) AS history_id
		FROM downloads d WHERE d.group_id=? AND d.status='completed' AND CAST(d.message_id AS INTEGER)>0
		UNION ALL
		SELECT 0,p.group_id,p.group_name,p.message_id,p.file_name,'' AS file_path,p.id AS history_id FROM tgdl_processing_attempts p
		WHERE p.group_id=? AND p.outcome IN ('downloaded','reused') AND p.message_id>0
		AND p.id=(SELECT MAX(p2.id) FROM tgdl_processing_attempts p2 WHERE p2.group_id=p.group_id AND p2.message_id=p.message_id AND p2.outcome IN ('downloaded','reused'))
		AND NOT EXISTS(SELECT 1 FROM downloads d WHERE d.group_id=p.group_id AND d.message_id=p.message_id)
	) WHERE message_id<? ORDER BY message_id DESC,record_id DESC LIMIT ?`, body.GroupID, body.GroupID, body.BeforeMessageID, body.Limit+1)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	type candidate struct {
		recordID           int64
		groupID, groupName string
		messageID          int
		fileName, filePath string
		historyID          int64
	}
	items := make([]candidate, 0, body.Limit)
	for rows.Next() {
		var item candidate
		if err = rows.Scan(&item.recordID, &item.groupID, &item.groupName, &item.messageID, &item.fileName, &item.filePath, &item.historyID); err != nil {
			rows.Close()
			writeJSONError(w, 500, err.Error())
			return
		}
		items = append(items, item)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		writeJSONError(w, 500, err.Error())
		return
	}
	rows.Close()
	hasMore := len(items) > body.Limit
	if hasMore {
		items = items[:body.Limit]
	}
	queued, skipped := 0, 0
	a.manualForwardMu.Lock()
	defer a.manualForwardMu.Unlock()
	for _, item := range items {
		already, queryErr := a.forwardAlreadyQueued(r.Context(), item.groupID, item.messageID, body.Destination)
		if queryErr != nil {
			writeJSONError(w, 500, queryErr.Error())
			return
		}
		if already {
			skipped++
			continue
		}
		a.queueForward(forwardJob{groupID: item.groupID, groupName: item.groupName, messageID: item.messageID, fileName: item.fileName, recordID: item.recordID, path: item.filePath, historyID: item.historyID, settings: settings, accountID: accountID, stage: "manual_direct"})
		queued++
	}
	next := 0
	if len(items) > 0 {
		next = items[len(items)-1].messageID
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"success": true, "scanned": len(items), "queued": queued, "skipped": skipped, "nextBeforeMessageId": next, "hasMore": hasMore})
}

func (a *App) handleGlobalForwardProtection(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Protect bool `json:"protect"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		return
	}
	cfg, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	block, _ := cfg["forwarding"].(map[string]any)
	if block == nil {
		block = map[string]any{}
	}
	block["protect"] = body.Protect
	cfg["forwarding"] = block
	if err := a.config.Save(r.Context(), cfg); err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"success": true})
}

func (a *App) handleForwardQueueRetry(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeJSONError(w, http.StatusBadRequest, "invalid forward job id")
		return
	}
	res, err := a.db.Writer.ExecContext(r.Context(), `UPDATE tgdl_forward_queue SET status='pending',reason='',retry_at=0,completed_at=0,updated_at=? WHERE id=? AND status IN ('failed','interrupted')`, time.Now().UnixMilli(), id)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		writeJSONError(w, http.StatusConflict, "forward job is not retryable")
		return
	}
	a.notifyForwardQueue()
	select {
	case a.forwards <- struct{}{}:
	default:
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (a *App) setForwardQueuePaused(ctx context.Context, paused bool) error {
	value := 0
	if paused {
		value = 1
	}
	if _, err := a.db.Writer.ExecContext(ctx, `UPDATE tgdl_forward_queue_state SET paused=? WHERE id=1`, value); err != nil {
		return err
	}
	a.notifyForwardQueue()
	return nil
}

func (a *App) handleForwardQueuePause(w http.ResponseWriter, r *http.Request) {
	if err := a.setForwardQueuePaused(r.Context(), true); err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "bucket": "forward", "paused": true})
}

func (a *App) handleForwardQueueResume(w http.ResponseWriter, r *http.Request) {
	if err := a.setForwardQueuePaused(r.Context(), false); err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	select {
	case a.forwards <- struct{}{}:
	default:
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "bucket": "forward", "paused": false})
}

func (a *App) handleForwardQueueReconcile(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeJSONError(w, http.StatusBadRequest, "invalid forward job id")
		return
	}
	var body struct {
		Action               string `json:"action"`
		ConfirmDuplicateRisk bool   `json:"confirmDuplicateRisk"`
		DestinationIndex     *int   `json:"destinationIndex"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		return
	}
	if body.Action != "sent" && body.Action != "resend" {
		writeJSONError(w, http.StatusBadRequest, "action must be sent or resend")
		return
	}
	if body.Action == "resend" && !body.ConfirmDuplicateRisk {
		writeJSONError(w, http.StatusBadRequest, "resend may create a duplicate; explicit confirmation is required")
		return
	}
	var legacyResendSnapshot *forwardConfigSnapshot
	if body.Action == "resend" {
		var raw, forwardConfig, groupID string
		var topicID int
		if err := a.db.Reader.QueryRowContext(r.Context(), `SELECT destinations_json,forward_config_json,group_id,topic_id FROM tgdl_forward_queue WHERE id=? AND status='uncertain'`, id).Scan(&raw, &forwardConfig, &groupID, &topicID); err == nil {
			var destinations []forwardDestination
			var saved forwardConfigSnapshot
			snapshotValid := json.Unmarshal([]byte(raw), &destinations) == nil && len(destinations) > 0
			if !snapshotValid {
				snapshotValid = json.Unmarshal([]byte(forwardConfig), &saved) == nil && saved.Settings != nil && hasForwardDestination(saved.Settings)
			}
			if !snapshotValid {
				cfg, loadErr := a.config.Load(r.Context())
				if loadErr != nil {
					writeJSONError(w, http.StatusInternalServerError, "forward configuration is unavailable")
					return
				}
				settings, accountID, _ := forwardSettings(cfg, groupID)
				destinations = nil
				for _, route := range matchingForwardRoutes(settings, topicID) {
					routeSettings := effectiveForwardProtection(inheritCaptionSettings(route, settings), settings, route, topicID, cfg)
					destinations = append(destinations, forwardDestination{Settings: routeSettings, Status: "uncertain"})
				}
				if len(destinations) == 0 {
					writeJSONError(w, http.StatusConflict, "legacy forward has no current destination to resend to")
					return
				}
				legacyResendSnapshot = &forwardConfigSnapshot{Settings: settings, AccountID: accountID, Destinations: destinations}
			}
		} else if !errors.Is(err, sql.ErrNoRows) {
			writeJSONError(w, http.StatusInternalServerError, "forward job state is unavailable")
			return
		}
	}
	tx, err := a.db.Writer.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer tx.Rollback()
	var raw, forwardConfig, groupID string
	var topicID int
	if err = tx.QueryRowContext(r.Context(), `SELECT destinations_json,forward_config_json,group_id,topic_id FROM tgdl_forward_queue WHERE id=? AND status='uncertain'`, id).Scan(&raw, &forwardConfig, &groupID, &topicID); err != nil {
		writeJSONError(w, http.StatusConflict, "forward job is not uncertain")
		return
	}
	var destinations []forwardDestination
	if err = json.Unmarshal([]byte(raw), &destinations); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "forward destination state is invalid")
		return
	}
	var saved forwardConfigSnapshot
	savedSnapshotValid := json.Unmarshal([]byte(forwardConfig), &saved) == nil && saved.Settings != nil && hasForwardDestination(saved.Settings)
	missingSnapshot := false
	if len(destinations) == 0 {
		destinations = saved.Destinations
		if len(destinations) == 0 && savedSnapshotValid {
			for _, route := range matchingForwardRoutes(saved.Settings, topicID) {
				destinations = append(destinations, forwardDestination{Settings: route, Status: "uncertain"})
			}
		}
		if len(destinations) == 0 && !savedSnapshotValid {
			missingSnapshot = true
			if body.Action == "resend" {
				if legacyResendSnapshot == nil || legacyResendSnapshot.Settings == nil {
					writeJSONError(w, http.StatusConflict, "legacy forward snapshot is unavailable; refresh and retry")
					return
				}
				destinations = legacyResendSnapshot.Destinations
				saved = *legacyResendSnapshot
			}
		}
	}
	for i := range destinations {
		if destinations[i].Status == "pending" || destinations[i].Status == "processing" {
			destinations[i].Status = "uncertain"
		}
	}
	if body.DestinationIndex != nil && (*body.DestinationIndex < 0 || *body.DestinationIndex >= len(destinations)) {
		writeJSONError(w, http.StatusBadRequest, "destination index is invalid")
		return
	}
	changed := false
	for i := range destinations {
		if body.DestinationIndex != nil && i != *body.DestinationIndex {
			continue
		}
		if destinations[i].Status != "uncertain" && destinations[i].Status != "processing" {
			continue
		}
		changed = true
		if body.Action == "sent" {
			destinations[i].Status = "forwarded"
			destinations[i].Reason = "operator confirmed delivered"
		} else {
			destinations[i].Status = "pending"
			destinations[i].Reason = "operator requested resend"
		}
	}
	if body.DestinationIndex == nil && !changed && body.Action == "resend" {
		for i := range destinations {
			if destinations[i].Status == "forwarded" {
				continue
			}
			destinations[i].Status = "pending"
			destinations[i].Reason = "operator requested resend"
			changed = true
		}
	}
	if body.DestinationIndex == nil && !changed && body.Action == "sent" && missingSnapshot {
		changed = true
	}
	if !changed {
		writeJSONError(w, http.StatusConflict, "forward job has no uncertain destination")
		return
	}
	status := "pending"
	for _, destination := range destinations {
		if destination.Status == "uncertain" || destination.Status == "processing" {
			status = "uncertain"
			break
		}
	}
	if status != "uncertain" && body.Action == "sent" {
		status = "forwarded"
		for _, destination := range destinations {
			if destination.Status != "forwarded" {
				status = "pending"
				break
			}
		}
	}
	destinationJSON, _ := json.Marshal(destinations)
	savedConfigToPersist := forwardConfig
	if missingSnapshot && body.Action == "resend" {
		encodedConfig, _ := json.Marshal(saved)
		savedConfigToPersist = string(encodedConfig)
	}
	now := time.Now().UnixMilli()
	if _, err = tx.ExecContext(r.Context(), `UPDATE tgdl_forward_queue SET status=?,reason='',retry_at=0,forward_config_json=?,destinations_json=?,updated_at=?,completed_at=CASE WHEN ?='forwarded' THEN ? ELSE 0 END WHERE id=? AND status='uncertain'`, status, savedConfigToPersist, string(destinationJSON), now, status, now, id); err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	detail := "operator confirmed delivery"
	if body.Action == "resend" {
		detail = "operator requested resend after explicit duplicate-risk confirmation"
	}
	if body.DestinationIndex != nil {
		detail = fmt.Sprintf("destination %d: %s", *body.DestinationIndex, detail)
	}
	if missingSnapshot {
		detail = "legacy job had no saved destination snapshot; " + detail
		if body.Action == "resend" {
			detail += " using destinations explicitly accepted from current configuration"
		}
	}
	if _, err = tx.ExecContext(r.Context(), `INSERT INTO tgdl_forward_queue_audit(job_id,action,created_at,detail) VALUES(?,?,?,?)`, id, body.Action, now, detail); err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	a.notifyForwardQueue()
	if status == "pending" {
		select {
		case a.forwards <- struct{}{}:
		default:
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "status": status, "warning": "Telegram does not provide enough evidence to guarantee exactly-once delivery."})
}

func (a *App) handleForwardQueueRetryAll(w http.ResponseWriter, r *http.Request) {
	res, err := a.db.Writer.ExecContext(r.Context(), `UPDATE tgdl_forward_queue SET status='pending',reason='',retry_at=0,completed_at=0,updated_at=? WHERE status IN ('failed','interrupted')`, time.Now().UnixMilli())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	retried, err := res.RowsAffected()
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if retried > 0 {
		a.notifyForwardQueue()
		select {
		case a.forwards <- struct{}{}:
		default:
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "retried": retried})
}

func (a *App) finishForwardQueue(ctx context.Context, job forwardJob, status, reason string) {
	if job.queueID == 0 {
		return
	}
	now := time.Now().UnixMilli()
	reason = a.safeForwardReason(reason)
	destinations, _ := json.Marshal(job.destinations)
	completedAt := now
	if status == "pending" || status == "processing" {
		completedAt = 0
	}
	_, err := a.db.Writer.ExecContext(ctx, `UPDATE tgdl_forward_queue SET status=?,reason=CASE WHEN ?='' THEN reason ELSE ? END,stage=?,destinations_json=?,attempts=?,retry_at=?,updated_at=?,completed_at=? WHERE id=?`, status, reason, reason, job.stage, string(destinations), job.attempts, job.retryAt, now, completedAt, job.queueID)
	if err != nil && a.output != nil {
		fmt.Fprintf(a.output, "AutoForward: could not record queue status for %s: %v\n", job.fileName, err)
	}
	a.notifyForwardQueue()
}

const forwardQueuePageSize = 50

func (a *App) forwardQueueSnapshot(ctx context.Context, offset int) (map[string]any, error) {
	if offset < 0 {
		offset = 0
	}
	var stats struct {
		Total, Pending, Active, Forwarded, Failed, Interrupted, Uncertain, NotApplicable int64
	}
	// Count statuses from the existing (status,id) covering index.
	// This remains O(queue rows) but avoids reading the full queue records
	// and evaluating eight boolean SUM expressions for each row.
	counts, err := a.db.Reader.QueryContext(ctx, `SELECT status, COUNT(*) FROM tgdl_forward_queue GROUP BY status`)
	if err != nil {
		return nil, err
	}
	for counts.Next() {
		var status string
		var count int64
		if err := counts.Scan(&status, &count); err != nil {
			counts.Close()
			return nil, err
		}
		stats.Total += count
		switch status {
		case "pending":
			stats.Pending = count
		case "processing":
			stats.Active = count
		case "forwarded":
			stats.Forwarded = count
		case "failed":
			stats.Failed = count
		case "interrupted":
			stats.Interrupted = count
		case "uncertain":
			stats.Uncertain = count
		case "not_applicable":
			stats.NotApplicable = count
		}
	}
	if err := counts.Err(); err != nil {
		counts.Close()
		return nil, err
	}
	counts.Close()
	actionable := stats.Pending + stats.Active + stats.Failed + stats.Interrupted + stats.Uncertain
	if actionable == 0 {
		offset = 0
	} else if int64(offset) >= actionable {
		offset = int((actionable - 1) / forwardQueuePageSize * forwardQueuePageSize)
	}
	rows, err := a.db.Reader.QueryContext(ctx, `SELECT id,group_id,group_name,message_id,file_name,topic_id,status,reason,created_at,forward_config_json,stage,destinations_json,attempts,retry_at FROM tgdl_forward_queue
		WHERE status IN ('pending','processing','failed','interrupted','uncertain')
		ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'processing' THEN 1 WHEN 'uncertain' THEN 2 ELSE 3 END,id DESC LIMIT ? OFFSET ?`, forwardQueuePageSize, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]map[string]any, 0, forwardQueuePageSize)
	cfg, _ := a.config.Load(ctx)
	for rows.Next() {
		var queueID int64
		var groupID, groupName, fileName, status, reason, forwardConfig, stage, destinationsJSON string
		var messageID int64
		var topicID int
		var createdAt int64
		var attempts int
		var retryAt int64
		if err := rows.Scan(&queueID, &groupID, &groupName, &messageID, &fileName, &topicID, &status, &reason, &createdAt, &forwardConfig, &stage, &destinationsJSON, &attempts, &retryAt); err != nil {
			return nil, err
		}
		var destinations []string
		settings, _, _ := forwardSettings(cfg, groupID)
		if forwardConfig != "" {
			var snapshot forwardConfigSnapshot
			if json.Unmarshal([]byte(forwardConfig), &snapshot) == nil && snapshot.Settings != nil {
				settings = snapshot.Settings
			}
		}
		for _, route := range matchingForwardRoutes(settings, topicID) {
			destination := strings.TrimSpace(toString(route["destinationGroupId"]))
			if destination == "" {
				destination = strings.TrimSpace(toString(route["destination"]))
			}
			if destination != "" {
				destinations = append(destinations, destination)
			}
		}
		var destinationStates []forwardDestination
		_ = json.Unmarshal([]byte(destinationsJSON), &destinationStates)
		items = append(items, map[string]any{"id": queueID, "groupId": groupID, "groupName": groupName, "messageId": messageID, "fileName": fileName, "topicId": topicID, "destinations": destinations, "destinationStates": destinationStates, "stage": stage, "status": status, "reason": a.safeForwardReason(reason), "attempts": attempts, "retryAt": retryAt, "createdAt": createdAt})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	recent := make([]map[string]any, 0, 10)
	completed, err := a.db.Reader.QueryContext(ctx, `SELECT id,group_id,group_name,message_id,file_name,topic_id,reason,created_at,stage,destinations_json FROM tgdl_forward_queue WHERE status='forwarded' ORDER BY completed_at DESC,id DESC LIMIT 10`)
	if err != nil {
		return nil, err
	}
	for completed.Next() {
		var id, messageID, createdAt int64
		var groupID, groupName, fileName, reason, stage, destinationsJSON string
		var topicID int
		if err := completed.Scan(&id, &groupID, &groupName, &messageID, &fileName, &topicID, &reason, &createdAt, &stage, &destinationsJSON); err != nil {
			completed.Close()
			return nil, err
		}
		var destinationStates []forwardDestination
		_ = json.Unmarshal([]byte(destinationsJSON), &destinationStates)
		destinations := make([]string, 0, len(destinationStates))
		for _, d := range destinationStates {
			target := strings.TrimSpace(toString(d.Settings["destinationGroupId"]))
			if target == "" {
				target = strings.TrimSpace(toString(d.Settings["destination"]))
			}
			if target != "" {
				destinations = append(destinations, target)
			}
		}
		recent = append(recent, map[string]any{"id": id, "groupId": groupID, "groupName": groupName, "messageId": messageID, "fileName": fileName, "topicId": topicID, "status": "forwarded", "reason": a.safeForwardReason(reason), "stage": stage, "createdAt": createdAt, "destinations": destinations, "destinationStates": destinationStates})
	}
	if err := completed.Err(); err != nil {
		completed.Close()
		return nil, err
	}
	completed.Close()
	var paused int
	_ = a.db.Reader.QueryRowContext(ctx, `SELECT paused FROM tgdl_forward_queue_state WHERE id=1`).Scan(&paused)
	config := a.forwarderConfig(ctx)
	workerStatus := "running"
	if paused != 0 {
		workerStatus = "paused"
	}
	return map[string]any{"total": stats.Total - stats.NotApplicable, "pending": stats.Pending, "active": stats.Active, "forwarded": stats.Forwarded, "failed": stats.Failed, "interrupted": stats.Interrupted, "uncertain": stats.Uncertain, "paused": paused != 0, "workerStatus": workerStatus, "concurrency": config.concurrency, "capacity": config.queueSize, "intervalSec": config.intervalSec, "notApplicable": stats.NotApplicable, "page": offset/forwardQueuePageSize + 1, "pageSize": forwardQueuePageSize, "hasMore": int64(offset+len(items)) < actionable, "items": items, "recent": recent}, nil
}

// forwardSettings returns the chat's autoForward rule and forward account, or
// ok=false when the chat has no enabled rule.
func forwardSettings(cfg map[string]any, groupID string) (settings map[string]any, accountID string, ok bool) {
	for _, group := range configuredGroupList(cfg) {
		if toString(group["id"]) != groupID {
			continue
		}
		stored, _ := group["autoForward"].(map[string]any)
		if stored == nil {
			return nil, toString(group["forwardAccount"]), false
		}
		settings = cloneMap(stored)
		if _, present := settings["directForward"]; !present {
			settings["directForward"] = false
		}
		return settings, toString(group["forwardAccount"]), settings["enabled"] == true
	}
	return nil, "", false
}

func autoForwardEnabled(cfg map[string]any, groupID string) bool {
	_, _, enabled := forwardSettings(cfg, groupID)
	return enabled
}

func forwardRoutingSignature(settings map[string]any) string {
	var routes []string
	if raw, ok := settings["routes"].([]any); ok {
		for _, item := range raw {
			route, ok := item.(map[string]any)
			if !ok {
				continue
			}
			routes = append(routes, fmt.Sprintf("%d\x00%s\x00%d", int(number(route["sourceTopicId"], 0)), toString(route["destinationGroupId"]), int(number(route["destinationTopicId"], 0))))
		}
		sort.Strings(routes)
	}
	if len(routes) == 0 {
		return strings.TrimSpace(toString(settings["destinationGroupId"])) + "\x00" + strings.TrimSpace(toString(settings["destination"]))
	}
	return strings.Join(routes, "\x01")
}

func hasForwardDestination(settings map[string]any) bool {
	if routes, ok := settings["routes"].([]any); ok {
		return len(routes) > 0
	}
	return strings.TrimSpace(toString(settings["destinationGroupId"])) != "" || strings.TrimSpace(toString(settings["destination"])) != ""
}

func normalizedAutoForward(existing, value any) (map[string]any, error) {
	current, _ := existing.(map[string]any)
	incoming, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("autoForward must be an object")
	}
	out := make(map[string]any, len(current)+len(incoming))
	for key, item := range current {
		out[key] = item
	}
	for key, item := range incoming {
		out[key] = item
	}
	if enabled, ok := out["enabled"].(bool); !ok {
		out["enabled"] = false
	} else {
		out["enabled"] = enabled
	}
	if enabled, ok := out["deleteAfterForward"].(bool); !ok {
		out["deleteAfterForward"] = false
	} else {
		out["deleteAfterForward"] = enabled
	}
	if enabled, ok := out["directForward"].(bool); !ok {
		out["directForward"] = false
	} else {
		out["directForward"] = enabled
	}
	scanRoute := toString(out["scanRoute"])
	if scanRoute != "" && scanRoute != "download" && scanRoute != "direct" && scanRoute != "both" {
		return nil, errors.New("autoForward scanRoute must be download, direct, or both")
	}
	if protectionValue(out["protect"]) == 1 {
		out["directForward"] = false
	}
	rawRoutes, validRoutes := out["routes"].([]any)
	_, hasRoutes := out["routes"]
	if hasRoutes && !validRoutes {
		return nil, errors.New("autoForward routes must be an array")
	}
	if len(rawRoutes) > 100 {
		return nil, errors.New("autoForward supports at most 100 routes")
	}
	routes := make([]any, 0, len(rawRoutes))
	for _, raw := range rawRoutes {
		original, ok := raw.(map[string]any)
		if !ok {
			return nil, errors.New("autoForward route must be an object")
		}
		route := make(map[string]any, len(original))
		for key, value := range original {
			route[key] = value
		}
		destination := strings.TrimSpace(toString(route["destinationGroupId"]))
		if destination == "" {
			continue
		}
		mode := toString(route["captionMode"])
		if mode == "" {
			mode = "inherit"
		}
		legacyMode := mode
		if mode == "override" || mode == "regex" {
			mode = "custom"
		}
		if mode == "source_info" && route["captionModeOverride"] != true {
			mode = "inherit"
		}
		if mode == "source_info" {
			mode = "custom"
			route["captionBase"] = "custom"
			if toString(route["caption"]) == "" {
				route["caption"] = "{{source_caption}}\n\n{{source_info}}"
			}
		}
		if legacyMode == "override" {
			route["captionBase"] = "custom"
		} else if legacyMode == "regex" {
			route["captionBase"] = "source"
		}
		if mode == "custom" {
			base := toString(route["captionBase"])
			if base == "" {
				if toString(route["caption"]) != "" {
					base = "custom"
				} else {
					base = "source"
				}
			}
			if base != "source" && base != "custom" {
				return nil, errors.New("autoForward route has an invalid caption base")
			}
			route["captionBase"] = base
		}
		switch mode {
		case "inherit", "source_info", "source", "none", "custom", "override", "regex":
		default:
			return nil, errors.New("autoForward route has an invalid caption mode")
		}
		for _, key := range []string{"caption", "regexPattern", "regexReplacement"} {
			if len(toString(route[key])) > 4096 {
				return nil, errors.New("autoForward caption fields must be 4096 bytes or fewer")
			}
		}
		if (mode == "custom" || mode == "regex") && strings.TrimSpace(toString(route["regexPattern"])) != "" {
			pattern := toString(route["regexPattern"])
			if _, err := regexp.Compile(pattern); err != nil {
				return nil, fmt.Errorf("invalid caption regex: %w", err)
			}
		}
		route["destinationGroupId"] = destination
		route["captionMode"] = mode
		route["captionModeOverride"] = mode != "inherit"
		for _, key := range []string{"sourceTopicId", "destinationTopicId"} {
			n := float64(0)
			if value, present := route[key]; present {
				n = number(value, math.NaN())
			}
			if math.IsNaN(n) || n < 0 || n > 2147483647 || n != float64(int(n)) {
				return nil, errors.New("autoForward topic IDs must be non-negative integers")
			}
			route[key] = n
		}
		routes = append(routes, route)
	}
	seenRoutes := make(map[string]struct{}, len(routes))
	for _, raw := range routes {
		route := raw.(map[string]any)
		key := fmt.Sprintf("%d\x00%s", int(number(route["sourceTopicId"], 0)), toString(route["destinationGroupId"]))
		if _, exists := seenRoutes[key]; exists {
			return nil, errors.New("autoForward route duplicates a source topic and destination")
		}
		seenRoutes[key] = struct{}{}
	}
	mode := toString(out["captionMode"])
	if mode == "" {
		mode = "source"
	}
	legacyMode := mode
	if mode == "source_info" {
		mode = "custom"
		out["captionBase"] = "custom"
		if toString(out["caption"]) == "" {
			out["caption"] = "{{source_caption}}\n\n{{source_info}}"
		}
	}
	if mode == "override" || mode == "regex" {
		mode = "custom"
	}
	if legacyMode == "override" {
		out["captionBase"] = "custom"
	} else if legacyMode == "regex" {
		out["captionBase"] = "source"
	}
	switch mode {
	case "source_info", "source", "none", "custom", "override", "regex":
	default:
		return nil, errors.New("autoForward has an invalid caption mode")
	}
	if mode == "custom" {
		base := toString(out["captionBase"])
		if base == "" {
			if toString(out["caption"]) != "" {
				base = "custom"
			} else {
				base = "source"
			}
		}
		if base != "source" && base != "custom" {
			return nil, errors.New("autoForward has an invalid caption base")
		}
		out["captionBase"] = base
	}
	for _, key := range []string{"caption", "regexPattern", "regexReplacement"} {
		if len(toString(out[key])) > 4096 {
			return nil, errors.New("autoForward caption fields must be 4096 bytes or fewer")
		}
	}
	if (mode == "custom" || mode == "regex") && strings.TrimSpace(toString(out["regexPattern"])) != "" {
		pattern := toString(out["regexPattern"])
		if _, err := regexp.Compile(pattern); err != nil {
			return nil, fmt.Errorf("invalid caption regex: %w", err)
		}
	}
	if _, ok := out["protect"]; ok {
		if _, valid := out["protect"].(bool); !valid {
			if toString(out["protect"]) != "on" && toString(out["protect"]) != "off" {
				return nil, errors.New("autoForward protect must be on or off")
			}
		}
	}
	for i, value := range routes {
		route, _ := value.(map[string]any)
		if route == nil {
			continue
		}
		mode := toString(route["captionMode"])
		if mode == "inherit" {
			mode = toString(out["captionMode"])
		}
		if mode == "" {
			mode = "source_info"
		}
		route["captionMode"] = mode
		routes[i] = route
	}
	out["captionMode"] = mode
	if hasRoutes {
		out["routes"] = routes
	}
	return out, nil
}

func (a *App) forward(ctx context.Context, job forwardJob) {
	finishActivity := a.beginForward(job.groupID)
	defer finishActivity()
	status := "failed"
	reason := ""
	job.attempts++
	defer func() {
		if ctx.Err() != nil {
			status = "interrupted"
			reason = ctx.Err().Error()
		}
		if job.waitForEngine && ctx.Err() == nil {
			status = "pending"
			reason = "Waiting for monitor to start"
			job.attempts = max(0, job.attempts-1)
			job.retryAt = 0
		}
		if job.retryBeforeSend {
			if ctx.Err() == nil {
				status = "pending"
				reason = "forward interrupted before Telegram request"
			}
			job.attempts = max(0, job.attempts-1)
			job.retryAt = 0
		}
		if hasUncertainDestination(job.destinations) {
			status = "uncertain"
			reason = "Telegram response was lost; delivery may have succeeded"
		}
		if job.retryAt > time.Now().UnixMilli() && ctx.Err() == nil && status != "uncertain" {
			status = "pending"
			reason = "Telegram FloodWait; automatically retrying after the requested wait"
			job.attempts = max(0, job.attempts-1)
		}
		if status == "failed" && job.queueID > 0 && job.attempts < 3 && !job.noAutoRetry && ctx.Err() == nil {
			status = "pending"
			reason = ""
			if job.retryAt <= time.Now().UnixMilli() {
				job.retryAt = time.Now().Add(time.Second * time.Duration(1<<max(0, job.attempts-1))).UnixMilli()
			}
		}
		a.finishForwardQueue(context.WithoutCancel(ctx), job, status, reason)
		a.finishProcessingForward(context.WithoutCancel(ctx), job.historyID, status)
		if status == "forwarded" && job.recordID != 0 && job.settings["deleteAfterForward"] == true && job.path != "" {
			a.deleteForwarded(context.WithoutCancel(ctx), job)
		}
	}()
	if job.historyID != 0 {
		_, _ = a.db.Writer.ExecContext(context.WithoutCancel(ctx), `UPDATE tgdl_processing_attempts SET forward_status='processing',local_delete_status=CASE WHEN local_delete_status='pending' THEN 'pending' ELSE 'not_requested' END WHERE id=?`, job.historyID)
		a.notifyProcessingHistory()
	}
	globalConfig, err := a.config.Load(ctx)
	if err != nil {
		a.forwardFailed(job, "", err)
		return
	}
	// Queued automatic jobs carry a settings snapshot. The live toggle still
	// gates them; explicit manual forwards use stage "available".
	if job.stage != "available" {
		_, _, enabled := forwardSettings(globalConfig, job.groupID)
		if !enabled && job.stage != "scan_direct" && job.stage != "manual_direct" {
			status = "not_applicable"
			return
		}
	}
	groupSettings, accountID := job.settings, job.accountID
	if groupSettings == nil {
		groupSettings, accountID, _ = forwardSettings(globalConfig, job.groupID)
	}
	enabled := groupSettings["enabled"] == true
	if !enabled {
		status = "not_applicable"
		return
	}
	routes := matchingForwardRoutes(groupSettings, job.topicID)
	if len(routes) == 0 {
		status = "not_applicable"
		return
	}
	// The source chat is paused everywhere else; stay consistent.
	if blocked, _, err := a.accessBlocked(ctx, job.groupID); err != nil || blocked {
		return
	}
	if len(job.destinations) != len(routes) {
		job.destinations = make([]forwardDestination, len(routes))
	}
	needsUpload := false
	needsSourceDownload := false
	directCaptionEnabled := job.settings["scanRoute"] == "direct" || job.settings["scanRoute"] == "both" || groupSettings["directForward"] == true
	for i, route := range routes {
		settings := inheritCaptionSettings(route, groupSettings)
		settings = effectiveForwardProtection(settings, groupSettings, route, job.topicID, globalConfig)
		if job.destinations[i].Settings == nil {
			job.destinations[i] = forwardDestination{Settings: settings, Status: "pending"}
		} else {
			settings = job.destinations[i].Settings
		}
		job.destinations[i].Settings = settings
		if job.stage == "caption_edit_failed" && customCaption(settings) {
			continue
		} else if settings["protect"] == true {
			needsUpload = true
			needsSourceDownload = job.path == ""
		} else if customCaption(settings) && !directCaptionEnabled {
			needsUpload = true
			needsSourceDownload = job.path == ""
		}
	}
	if job.stage == "caption_edit_failed" {
		for i, route := range routes {
			if job.destinations[i].Status != "forwarded" && customCaption(job.destinations[i].Settings) && job.destinations[i].DestinationMessageID == 0 {
				a.forwardFailed(job, toString(route["destinationGroupId"]), errors.New("cannot safely retry caption edit: destination message id was not captured"))
				return
			}
		}
	}
	if needsSourceDownload {
		job.stage = "fallback_download"
		if err := a.downloadForForward(ctx, &job); err != nil {
			if a.deferForwardFlood(ctx, &job, err) {
				return
			}
			a.forwardFailed(job, "", err)
			return
		}
		needsUpload, needsSourceDownload = true, false
	}
	if job.stage != "caption_edit_failed" {
		if needsUpload {
			job.stage = "upload"
		} else if job.stage != "fallback_upload" && (job.settings["manualDirect"] == true || groupSettings["directForward"] == true) {
			job.stage = "native_forward"
		} else if job.path == "" {
			job.stage = "native_forward"
		} else {
			job.stage = "upload"
		}
	}
	a.persistForwardProgress(ctx, job)
	for i, route := range routes {
		settings := inheritCaptionSettings(route, groupSettings)
		settings = effectiveForwardProtection(settings, groupSettings, route, job.topicID, globalConfig)
		if job.destinations[i].Settings != nil {
			settings = job.destinations[i].Settings
		}
		deleteAfter := job.recordID != 0 && groupSettings["deleteAfterForward"] == true && i == len(routes)-1
		if job.destinations[i].Status == "forwarded" || job.destinations[i].Status == "uncertain" {
			continue
		}
		job.destinations[i].Status = "processing"
		directCaption := job.stage == "caption_edit_failed" || job.path == "" && directCaptionEnabled && customCaption(settings) && settings["protect"] != true
		if directCaption && job.destinations[i].DestinationMessageID > 0 {
			job.destinations[i].Method = "caption_edit"
		} else if directCaption {
			job.destinations[i].Method = "native_forward_edit"
		} else if customCaption(settings) || settings["protect"] == true || job.path != "" {
			job.destinations[i].Method = "upload"
		} else {
			job.destinations[i].Method = "native_forward"
		}
		a.persistForwardProgress(ctx, job)
		if !a.forwardToRoute(ctx, &job, accountID, settings, deleteAfter) {
			if job.retryAt <= time.Now().UnixMilli() && job.destinations[i].Status != "uncertain" && !job.waitForEngine && !job.retryBeforeSend {
				job.destinations[i].Status = "failed"
				job.destinations[i].Reason = "delivery failed"
			}
			return
		}
		job.destinations[i].Status = "forwarded"
		if !job.destinations[i].DirectFailed {
			job.destinations[i].Reason = ""
		}
		a.persistForwardProgress(ctx, job)
	}
	job.stage = "complete"
	status = "forwarded"
}

func ambiguousDeliveryError(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) || errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	var networkError net.Error
	return errors.As(err, &networkError)
}

func hasUncertainDestination(destinations []forwardDestination) bool {
	for _, destination := range destinations {
		if destination.Status == "uncertain" {
			return true
		}
	}
	return false
}

func (a *App) downloadForForward(ctx context.Context, job *forwardJob) error {
	if job.messageID <= 0 || a.monitor == nil || job.accountID == "" {
		return errors.New("fallback download unavailable: source message ID, forward account, or live Telegram session is missing")
	}
	var message *tg.Message
	if len(job.sourceMessage) > 0 {
		var decoded tg.Message
		buffer := bin.Buffer{Buf: job.sourceMessage}
		if err := decoded.Decode(&buffer); err != nil {
			return fmt.Errorf("fallback download unavailable: decode queued source message: %w", err)
		}
		message = &decoded
	} else {
		session, err := a.monitor.OpenHistory(ctx, job.accountID)
		if err != nil {
			return fmt.Errorf("fallback download unavailable: open Telegram history: %w", err)
		}
		defer session.Close()
		dialog, err := session.Resolve(job.groupID)
		if err != nil {
			return fmt.Errorf("fallback download unavailable: resolve source group: %w", err)
		}
		fresh, err := session.Read(dialog, job.messageID)
		if err != nil {
			return fmt.Errorf("fallback download unavailable: read source message: %w", err)
		}
		message = fresh.Message
		var encoded bin.Buffer
		if err = message.Encode(&encoded); err != nil {
			return fmt.Errorf("save source message for retry: %w", err)
		}
		job.sourceMessage = encoded.Raw()
		if job.queueID > 0 {
			if _, err = a.db.Writer.ExecContext(ctx, `UPDATE tgdl_forward_queue SET source_message=?,updated_at=? WHERE id=?`, job.sourceMessage, time.Now().UnixMilli(), job.queueID); err != nil {
				return fmt.Errorf("save source message for retry: %w", err)
			}
		}
	}
	if message.ID != job.messageID {
		return errors.New("fallback download unavailable: source message ID changed")
	}
	attachment, err := telegram.MessageAttachment(message)
	if err != nil {
		return fmt.Errorf("fallback download unavailable: %w", err)
	}
	job.facts = attachment.Facts
	job.stage = "fallback_download"
	a.persistForwardProgress(ctx, *job)
	item := download.Item{GroupID: job.groupID, GroupName: job.groupName, MessageID: int64(job.messageID), Name: attachment.Name, Type: attachment.Type, Identity: attachment.Identity, Facts: job.facts}
	if item.Name == "" {
		item.Name = job.fileName
	}
	record, err := a.library.Ingest(ctx, item, forwardMessageClient{controller: a.monitor, accountID: job.accountID, message: message, identity: attachment.Identity})
	if err != nil {
		return fmt.Errorf("fallback download failed: %w", err)
	}
	job.recordID, job.path = record.ID, record.Path
	job.fileName = path.Base(record.Path)
	for i := range job.destinations {
		job.destinations[i].Method = "upload"
		if job.destinations[i].FallbackReason == "" {
			switch {
			case job.destinations[i].Settings["protect"] == true:
				job.destinations[i].FallbackReason = "Destination requires protected media; downloaded and uploaded instead"
			case customCaption(job.destinations[i].Settings):
				job.destinations[i].FallbackReason = "Destination caption requires upload; downloaded and uploaded instead"
			default:
				job.destinations[i].FallbackReason = "Direct forwarding requires upload for this route; downloaded and uploaded instead"
			}
		}
	}
	job.stage = "fallback_upload"
	a.persistForwardProgress(ctx, *job)
	return nil
}

type forwardMessageClient struct {
	controller *engine.Controller
	accountID  string
	message    *tg.Message
	identity   telegram.MediaIdentity
}

func (c forwardMessageClient) Download(ctx context.Context, identity telegram.MediaIdentity, w io.Writer) error {
	if identity.Key() != c.identity.Key() {
		return errors.New("fallback media identity mismatch")
	}
	return c.controller.DownloadMessage(ctx, c.accountID, c.message, c.identity, w)
}

func customCaption(settings map[string]any) bool {
	switch toString(settings["captionMode"]) {
	case "native", "source":
		return false
	default:
		return true
	}
}

var captionVariablePattern = regexp.MustCompile(`\{\{([a-z_]+)\}\}`)

func captionVariables(job forwardJob) map[string]string {
	sourceName := job.groupName
	if sourceName == "" {
		sourceName = job.groupID
	}
	link := ""
	if strings.HasPrefix(job.groupID, "-100") && job.messageID > 0 {
		channelID := strings.TrimPrefix(job.groupID, "-100")
		link = "https://t.me/c/" + channelID + "/" + strconv.Itoa(job.messageID)
	}
	return map[string]string{
		"source_caption": job.text,
		"source_name":    sourceName,
		"source_id":      job.groupID,
		"message_id":     strconv.Itoa(job.messageID),
		"source_info":    "📌 Source: " + sourceName,
		"source_link":    link,
	}
}

func expandCaptionVariables(value string, job forwardJob) string {
	variables := captionVariables(job)
	return captionVariablePattern.ReplaceAllStringFunc(value, func(token string) string {
		key := strings.TrimSuffix(strings.TrimPrefix(token, "{{"), "}}")
		if replacement, ok := variables[key]; ok {
			return replacement
		}
		return token
	})
}

func effectiveForwardProtection(settings, group map[string]any, route map[string]any, topicID int, config ...map[string]any) map[string]any {
	out := make(map[string]any, len(settings)+1)
	for k, v := range settings {
		out[k] = v
	}
	delete(out, "protect")
	value := any(nil)
	if len(config) > 0 {
		block, _ := config[0]["forwarding"].(map[string]any)
		value = block["protect"]
	}
	if v, ok := group["protect"]; ok {
		value = v
	}
	out["protect"] = protectionValue(value) == 1
	return out
}

func protectionValue(v any) int {
	switch x := v.(type) {
	case bool:
		if x {
			return 1
		}
		return 0
	case string:
		if strings.EqualFold(x, "on") {
			return 1
		}
		if strings.EqualFold(x, "off") {
			return 0
		}
	}
	return -1
}

func (a *App) persistForwardProgress(ctx context.Context, job forwardJob) {
	if job.queueID == 0 {
		return
	}
	raw, _ := json.Marshal(job.destinations)
	_, _ = a.db.Writer.ExecContext(ctx, `UPDATE tgdl_forward_queue SET stage=?,destinations_json=?,updated_at=? WHERE id=?`, job.stage, string(raw), time.Now().UnixMilli(), job.queueID)
	a.notifyForwardQueue()
}

func forwardDestinationIndex(destinations []forwardDestination, destination string, topicID int) int {
	for i, state := range destinations {
		routeDestination := toString(state.Settings["destinationGroupId"])
		if routeDestination == "" {
			routeDestination = toString(state.Settings["destination"])
		}
		if routeDestination == destination && int(number(state.Settings["destinationTopicId"], 0)) == topicID {
			return i
		}
	}
	return -1
}

func (a *App) forwardToRoute(ctx context.Context, job *forwardJob, accountID string, settings map[string]any, deleteAfter bool) bool {
	destination := strings.TrimSpace(toString(settings["destinationGroupId"]))
	if destination == "" {
		destination = strings.TrimSpace(toString(settings["destination"]))
	}
	key := destinationKey(destination)
	destWasBlocked := false
	if key != "" {
		blocked, due, err := a.accessBlocked(ctx, key)
		if err != nil {
			a.forwardFailed(*job, destination, err)
			return false
		}
		if blocked && !due {
			// That forward is the re-check once its time comes.
			return false
		}
		destWasBlocked = blocked
	}
	directCaption := customCaption(settings) && (job.settings["scanRoute"] == "direct" || job.settings["scanRoute"] == "both" || job.settings["directForward"] == true && settings["protect"] != true || job.stage == "caption_edit_failed")
	if (job.path == "" || job.stage == "native_forward" || job.stage == "caption_edit_failed") && (!customCaption(settings) || directCaption) && settings["protect"] != true && job.messageID > 0 {
		sender, ok := a.forwarder.(nativeForwardSender)
		var directErr error
		var destinationMessageID int
		var sentID int
		requestIssued := false
		request := telegram.ForwardMessageRequest{Source: job.groupID, Destination: destination, MessageID: job.messageID, TopicID: int(number(settings["destinationTopicId"], 0)), Protect: false}
		if !ok {
			directErr = errors.New("native Telegram forwarding is unavailable")
		} else {
			if directCaption {
				caption, entities, captionErr := routeCaption(settings, *job)
				if captionErr != nil {
					return false
				}
				if i := forwardDestinationIndex(job.destinations, destination, request.TopicID); caption == "" && (i < 0 || job.destinations[i].DestinationMessageID == 0) {
					request.DropMediaCaptions = true
				} else {
					request.EditCaption, request.Caption, request.Entities = true, caption, entities
					request.ResultMessageID = &destinationMessageID
					if i := forwardDestinationIndex(job.destinations, destination, request.TopicID); i >= 0 {
						request.EditMessageID = job.destinations[i].DestinationMessageID
					}
				}
			}
			if waitErr := a.waitForwardAccount(ctx, accountID); waitErr != nil {
				directErr = waitErr
			} else {
				requestIssued = true
				_, sentID, directErr = sender.ForwardMessage(ctx, accountID, request)
			}
			if destinationMessageID == 0 {
				destinationMessageID = sentID
			}
		}
		if i := forwardDestinationIndex(job.destinations, destination, request.TopicID); i >= 0 {
			if destinationMessageID > 0 {
				job.destinations[i].DestinationMessageID = destinationMessageID
			}
			if directErr != nil {
				job.destinations[i].DirectFailed = true
				job.destinations[i].Reason = "direct forward failed"
				if requestIssued && ambiguousDeliveryError(directErr) {
					job.destinations[i].Status = "uncertain"
					job.destinations[i].Reason = "Telegram response was lost; delivery may have succeeded"
				} else if !requestIssued && errors.Is(directErr, context.Canceled) {
					job.destinations[i].Status = "pending"
					job.destinations[i].Reason = "forward interrupted before Telegram request"
					job.destinations[i].DirectFailed = false
					job.retryBeforeSend = true
					job.destinations[i].Method = "native_forward"
				}
				if job.destinations[i].Status != "pending" {
					job.destinations[i].Method = "upload"
				}
			} else {
				job.destinations[i].DirectFailed = false
				job.destinations[i].Reason = ""
				if directCaption {
					job.destinations[i].Method = "caption_edit"
				}
			}
		}
		if directErr == nil {
			return true
		}
		if errors.Is(directErr, engine.ErrEngineNotRunning) {
			if i := forwardDestinationIndex(job.destinations, destination, request.TopicID); i >= 0 {
				job.destinations[i].Status = "pending"
				job.destinations[i].Reason = "Waiting for monitor to start"
				job.destinations[i].DirectFailed = false
				job.destinations[i].Method = "native_forward"
				if directCaption {
					job.destinations[i].Method = "native_forward_edit"
				}
				if job.destinations[i].DestinationMessageID > 0 && directCaption {
					job.destinations[i].Method = "caption_edit"
				}
			}
			job.waitForEngine = true
			return false
		}
		if !requestIssued && errors.Is(directErr, context.Canceled) {
			a.persistForwardProgress(context.WithoutCancel(ctx), *job)
			return false
		}
		if _, _, permanent := classifyAccessError(directErr); permanent {
			job.noAutoRetry = true
		}
		if a.deferForwardFlood(ctx, job, directErr) {
			i := forwardDestinationIndex(job.destinations, destination, request.TopicID)
			if i >= 0 {
				job.destinations[i].DirectFailed = false
				job.destinations[i].Method = "native_forward"
				job.destinations[i].Reason = "Telegram requested a FloodWait; retry deferred"
			}
			a.persistForwardProgress(context.WithoutCancel(ctx), *job)
			return false
		}
		a.persistForwardProgress(ctx, *job)
		// The source may disallow native forwarding while still allowing the
		// application account to download and send an accessible media file.
		i := forwardDestinationIndex(job.destinations, destination, request.TopicID)
		if job.path == "" {
			if destinationMessageID > 0 || requestIssued && ambiguousDeliveryError(directErr) {
				return false
			}
			fallbackReason := "Direct forward was rejected; downloaded and uploaded instead: " + a.safeForwardReason(directErr.Error())
			if i >= 0 {
				job.destinations[i].FallbackReason = fallbackReason
			}
			job.stage = "fallback_download"
			a.persistForwardProgress(ctx, *job)
			if err := a.downloadForForward(ctx, job); err != nil {
				if a.deferForwardFlood(ctx, job, err) {
					return false
				}
				a.forwardFailed(*job, destination, fmt.Errorf("%s; fallback failed: %w", fallbackReason, err))
				return false
			}
			if i >= 0 {
				job.destinations[i].FallbackReason = fallbackReason
			}
			job.stage = "fallback_upload"
			a.persistForwardProgress(ctx, *job)
			return a.forwardToRoute(ctx, job, accountID, settings, deleteAfter)
		}
		fallbackReason := "Direct forward was rejected; uploaded local media instead: " + a.safeForwardReason(directErr.Error())
		if i >= 0 {
			job.destinations[i].FallbackReason = fallbackReason
			job.destinations[i].Method = "upload"
		}
		probe, openErr := openMedia(a.downloadsDir, job.path)
		if openErr == nil {
			_ = probe.Close()
		}
		if openErr != nil {
			fallbackReason := "Direct forward was rejected; local file unavailable, downloaded and uploaded instead: " + a.safeForwardReason(directErr.Error())
			if i >= 0 {
				job.destinations[i].FallbackReason = fallbackReason
				job.destinations[i].Method = "upload"
			}
			job.path = ""
			job.stage = "fallback_download"
			a.persistForwardProgress(ctx, *job)
			if err := a.downloadForForward(ctx, job); err != nil {
				if a.deferForwardFlood(ctx, job, err) {
					return false
				}
				a.forwardFailed(*job, destination, fmt.Errorf("%s; fallback failed: %w", fallbackReason, err))
				return false
			}
			job.stage = "fallback_upload"
			a.persistForwardProgress(ctx, *job)
			return a.forwardToRoute(ctx, job, accountID, settings, deleteAfter)
		}
		job.stage = "fallback_upload"
		a.persistForwardProgress(ctx, *job)
	}
	file, err := openMedia(a.downloadsDir, job.path)
	if err != nil {
		a.forwardFailed(*job, destination, fmt.Errorf("open downloaded file: %w", err))
		return false
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		a.forwardFailed(*job, destination, err)
		return false
	}
	caption, entities, err := routeCaption(settings, *job)
	if err != nil {
		a.forwardFailed(*job, destination, err)
		return false
	}
	req := telegram.SendFileRequest{Destination: destination, TopicID: int(number(settings["destinationTopicId"], 0)), Name: path.Base(job.path), Size: info.Size(), Facts: job.facts, Caption: caption, Entities: entities, Protect: settings["protect"] == true}
	var used string
	var sent int
	floodWaitAttempts := a.forwarderConfig(ctx).floodWaitAttempts
	var floodWait time.Duration
	var floodLimited bool
	for attempt := 1; ; attempt++ {
		if err = a.waitForwardAccount(ctx, accountID); err != nil {
			if errors.Is(err, context.Canceled) {
				if i := forwardDestinationIndex(job.destinations, destination, req.TopicID); i >= 0 {
					job.destinations[i].Status = "pending"
					job.destinations[i].Reason = "forward interrupted before Telegram request"
					job.destinations[i].Method = "upload"
				}
				job.retryBeforeSend = true
				a.persistForwardProgress(context.WithoutCancel(ctx), *job)
			}
			return false
		}
		if _, err = file.Seek(0, io.SeekStart); err != nil {
			break
		}
		req.Body = file
		attemptCtx, cancel := context.WithTimeout(ctx, forwardTimeout(info.Size()))
		used, sent, err = a.forwarder.SendFile(attemptCtx, accountID, req)
		cancel()
		if used != "" {
			accountID, job.accountID = used, used
		}
		wait, flood := tgerr.AsFloodWait(err)
		floodWait, floodLimited = wait, flood
		if flood && wait > 0 {
			a.blockForwardAccount(ctx, accountID, wait+time.Second)
			job.retryAt = time.Now().Add(wait + time.Second).UnixMilli()
		}
		if !flood || attempt >= floodWaitAttempts {
			break
		}
		// The account gate is shared by every forward worker and persists across restarts.
	}
	if err != nil {
		if errors.Is(err, engine.ErrEngineNotRunning) {
			if i := forwardDestinationIndex(job.destinations, destination, req.TopicID); i >= 0 {
				job.destinations[i].Status = "pending"
				job.destinations[i].Reason = "Waiting for monitor to start"
				job.destinations[i].DirectFailed = false
			}
			job.waitForEngine = true
			return false
		}
		if floodLimited && floodWait > 0 {
			a.deferForwardFlood(ctx, job, err)
			i := forwardDestinationIndex(job.destinations, destination, req.TopicID)
			if i >= 0 {
				job.destinations[i].Status = "pending"
				job.destinations[i].Reason = "Telegram requested a FloodWait; retry deferred"
				job.destinations[i].Method = "upload"
			}
			a.persistForwardProgress(context.WithoutCancel(ctx), *job)
			return false
		}
		if ctx.Err() != nil {
			return false
		}
		if ambiguousDeliveryError(err) {
			if i := forwardDestinationIndex(job.destinations, destination, req.TopicID); i >= 0 {
				job.destinations[i].Status = "uncertain"
				job.destinations[i].Reason = "Telegram response was lost; delivery may have succeeded"
				job.destinations[i].Method = "upload"
			}
			a.persistForwardProgress(ctx, *job)
			return false
		}
		if _, _, permanent := classifyAccessError(err); permanent {
			job.noAutoRetry = true
		}
		a.forwardFailed(*job, destination, err)
		if key != "" {
			if state, code, definite := classifyAccessError(err); definite {
				if recordErr := a.recordDestinationAccess(ctx, key, used, state, code, destWasBlocked); recordErr != nil && a.output != nil {
					fmt.Fprintf(a.output, "AutoForward: could not record destination access: %v\n", recordErr)
				}
			}
		}
		return false
	}
	if key != "" {
		if err := a.markDestinationReachable(ctx, key, used); err != nil && a.output != nil {
			fmt.Fprintf(a.output, "AutoForward: could not record destination access: %v\n", err)
		}
	}
	if a.output != nil {
		label := destination
		if label == "" || label == "storage" {
			label = telegram.StorageChannelTitle
		}
		tail := ""
		if sent > 0 {
			tail = fmt.Sprintf(" (msg #%d)", sent)
		}
		fmt.Fprintf(a.output, "AutoForward: sent %s from %s to %s%s\n", req.Name, job.groupName, label, tail)
	}
	return true
}

func inheritCaptionSettings(route, group map[string]any) map[string]any {
	if _, routeSpecific := route["destinationGroupId"]; !routeSpecific || toString(route["captionMode"]) != "inherit" {
		return route
	}
	out := make(map[string]any, len(route)+4)
	for key, value := range route {
		out[key] = value
	}
	for _, key := range []string{"captionMode", "captionBase", "caption", "regexPattern", "regexReplacement"} {
		if value, ok := group[key]; ok {
			out[key] = value
		}
	}
	return out
}

func cloneMap(source map[string]any) map[string]any {
	out := make(map[string]any, len(source))
	for key, value := range source {
		out[key] = value
	}
	return out
}

func matchingForwardRoutes(settings map[string]any, sourceTopicID int) []map[string]any {
	raw, present := settings["routes"]
	if !present {
		return []map[string]any{settings}
	}
	routes, ok := raw.([]any)
	if !ok {
		return nil
	}
	var exact, fallback []map[string]any
	for _, raw := range routes {
		route, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		topicID := int(number(route["sourceTopicId"], 0))
		if topicID == sourceTopicID && sourceTopicID != 0 {
			exact = append(exact, route)
		}
		if topicID == 0 {
			fallback = append(fallback, route)
		}
	}
	destinations := make(map[string]bool)
	for _, route := range exact {
		destinations[toString(route["destinationGroupId"])] = true
	}
	for _, route := range fallback {
		if !destinations[toString(route["destinationGroupId"])] {
			exact = append(exact, route)
		}
	}
	return exact
}

func routeCaption(settings map[string]any, job forwardJob) (string, []tg.MessageEntityClass, error) {
	switch toString(settings["captionMode"]) {
	case "none":
		return "", nil, nil
	case "source":
		return telegram.PlainForwardCaption(job.text), nil, nil
	case "override":
		return telegram.PlainForwardCaption(expandCaptionVariables(toString(settings["caption"]), job)), nil, nil
	case "regex":
		pattern, err := regexp.Compile(toString(settings["regexPattern"]))
		if err != nil {
			return "", nil, fmt.Errorf("invalid caption regex: %w", err)
		}
		return telegram.PlainForwardCaption(pattern.ReplaceAllString(job.text, expandCaptionVariables(toString(settings["regexReplacement"]), job))), nil, nil
	case "custom":
		caption := job.text
		if toString(settings["captionBase"]) == "custom" || (toString(settings["captionBase"]) == "" && toString(settings["caption"]) != "") {
			caption = toString(settings["caption"])
		}
		caption = expandCaptionVariables(caption, job)
		patternText := strings.TrimSpace(toString(settings["regexPattern"]))
		if patternText != "" {
			pattern, err := regexp.Compile(patternText)
			if err != nil {
				return "", nil, fmt.Errorf("invalid caption regex: %w", err)
			}
			caption = pattern.ReplaceAllString(caption, expandCaptionVariables(toString(settings["regexReplacement"]), job))
		}
		return telegram.PlainForwardCaption(caption), nil, nil
	default:
		caption, entities := telegram.ForwardCaption(job.text, job.groupName, job.groupID, job.messageID)
		return caption, entities, nil
	}
}

// deleteForwarded evicts local bytes only after forward completion, preserving
// the catalog and backup rows so future scans remain idempotent.
func (a *App) deleteForwarded(ctx context.Context, job forwardJob) {
	name, err := mediaName(job.path)
	if err != nil {
		a.setProcessingDeleteStatus(context.WithoutCancel(ctx), job.historyID, "failed", err.Error())
		return
	}
	name = filepath.ToSlash(name)
	a.mediaMu.RLock()
	defer a.mediaMu.RUnlock()
	tx, err := a.db.Writer.BeginTx(ctx, nil)
	if err != nil {
		a.setProcessingDeleteStatus(context.WithoutCancel(ctx), job.historyID, "failed", err.Error())
		return
	}
	defer tx.Rollback()
	where := `id=? AND REPLACE(file_path,char(92),'/')=?`
	var backupPending bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM backup_jobs WHERE download_id=? AND status<>'done') OR EXISTS(
		SELECT 1 FROM backup_destinations d LEFT JOIN backup_jobs j ON j.destination_id=d.id AND j.download_id=?
		WHERE d.enabled=1 AND d.mode='mirror' AND (j.id IS NULL OR j.status<>'done'))`, job.recordID, job.recordID).Scan(&backupPending); err != nil {
		tx.Rollback()
		a.setProcessingDeleteStatus(context.WithoutCancel(ctx), job.historyID, "failed", err.Error())
		return
	}
	if backupPending {
		tx.Rollback()
		a.setProcessingDeleteStatus(context.WithoutCancel(ctx), job.historyID, "deferred_backup_pending", "backup job still needs the local file")
		return
	}
	if err = a.queueDeletedAssets(ctx, tx, where, job.recordID, name); err != nil {
		tx.Rollback()
		a.setProcessingDeleteStatus(context.WithoutCancel(ctx), job.historyID, "failed", err.Error())
		return
	}
	if _, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO tgdl_file_cleanup(path) SELECT file_path FROM downloads WHERE `+where, job.recordID, name); err != nil {
		tx.Rollback()
		a.setProcessingDeleteStatus(context.WithoutCancel(ctx), job.historyID, "failed", err.Error())
		return
	}
	res, err := tx.ExecContext(ctx, `UPDATE downloads SET file_path=NULL WHERE `+where, job.recordID, name)
	if err != nil {
		tx.Rollback()
		a.setProcessingDeleteStatus(context.WithoutCancel(ctx), job.historyID, "failed", err.Error())
		return
	}
	deleted, err := res.RowsAffected()
	if err != nil {
		tx.Rollback()
		a.setProcessingDeleteStatus(context.WithoutCancel(ctx), job.historyID, "failed", err.Error())
		return
	}
	if deleted == 0 {
		tx.Rollback()
		a.setProcessingDeleteStatus(context.WithoutCancel(ctx), job.historyID, "already_absent", "local download record was already removed")
		return
	}
	if err = tx.Commit(); err != nil {
		a.setProcessingDeleteStatus(context.WithoutCancel(ctx), job.historyID, "failed", err.Error())
		return
	}
	if err = errors.Join(a.drainFileCleanup(ctx), a.library.CleanDerived(ctx)); err != nil {
		a.setProcessingDeleteStatus(context.WithoutCancel(ctx), job.historyID, "failed", err.Error())
		return
	}
	a.markProcessingDeleted(ctx, job.historyID)
	a.hub.Broadcast(ws.Event{Type: "file_deleted", Flat: true, Payload: map[string]any{"id": job.recordID}})
	if a.output != nil {
		fmt.Fprintf(a.output, "AutoForward: deleted local file %s\n", path.Base(job.path))
	}
}

func (a *App) forwardFailed(job forwardJob, destination string, err error) {
	ctx := a.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	safeErr := errors.New(a.safeForwardReason(err.Error()))
	a.failProcessingForward(context.WithoutCancel(ctx), job.historyID, safeErr)
	a.finishForwardQueue(context.WithoutCancel(ctx), job, "failed", safeErr.Error())
	if a.output != nil {
		fmt.Fprintf(a.output, "AutoForward: %s message %d failed: %s\n", job.groupName, job.messageID, safeErr)
	}
	a.hub.Broadcast(ws.Event{Type: "forward_error", Payload: map[string]any{
		"groupId": job.groupID, "groupName": job.groupName, "messageId": job.messageID, "destination": destination, "error": safeErr.Error(),
	}})
}

func (a *App) safeForwardReason(reason string) string {
	for _, root := range []string{a.downloadsDir, a.dataDir} {
		if root != "" {
			reason = strings.ReplaceAll(reason, root, "[local data]")
		}
	}
	reason = forwardLocalPathPattern.ReplaceAllString(reason, "[local path]")
	reason = forwardSecretPattern.ReplaceAllString(reason, "$1=[redacted]")
	if len(reason) > 512 {
		reason = reason[:512]
	}
	return reason
}

// Bound one upload like a download attempt: 2 minutes plus 1 s per 16 KiB.
func forwardTimeout(size int64) time.Duration {
	return min(2*time.Minute+time.Duration(max(size, 0)/(16*1024))*time.Second, 24*time.Hour)
}

// ---- Destination access (2.x chat-access rows under a "dest:" key) ---------

var numericID = regexp.MustCompile(`^-?\d+$`)

// destinationKey is 2.x's registry key for a forward destination:
// "dest:<chat id>" or "dest:@username". It is namespaced so a destination
// that refuses posts never pauses reading the same chat. Saved Messages and
// the storage channel have none.
func destinationKey(destination string) string {
	d := strings.TrimSpace(destination)
	switch d {
	case "", "storage", "me", "saved":
		return ""
	}
	if numericID.MatchString(d) {
		return "dest:" + d
	}
	return "dest:@" + strings.ToLower(strings.TrimPrefix(d, "@"))
}

// Telegram error names that say something definite about a chat (2.x's
// CODE_STATES).
var accessErrorStates = map[string]string{
	"CHANNEL_PRIVATE": "private", "CHANNEL_INVALID": "deleted", "CHAT_ID_INVALID": "deleted",
	"PEER_ID_INVALID": "deleted", "USERNAME_INVALID": "deleted", "USERNAME_NOT_OCCUPIED": "deleted",
	"CHAT_FORBIDDEN": "banned", "USER_BANNED_IN_CHANNEL": "banned", "USER_KICKED": "banned",
	"USER_NOT_PARTICIPANT": "left", "CHANNEL_PUBLIC_GROUP_NA": "restricted", "CHAT_RESTRICTED": "restricted",
	"CHAT_WRITE_FORBIDDEN": "restricted", "CHAT_SEND_MEDIA_FORBIDDEN": "restricted", "CHAT_ADMIN_REQUIRED": "restricted",
}

var accessPriority = map[string]int{"migrated": 7, "deleted": 6, "banned": 5, "restricted": 4, "private": 3, "left": 2}

func classifyAccessError(err error) (state, code string, definite bool) {
	if rpc, ok := tgerr.As(err); ok {
		if state, found := accessErrorStates[rpc.Type]; found {
			return state, rpc.Type, true
		}
	}
	if errors.Is(err, telegram.ErrDestinationNotFound) {
		return "left", "ENTITY_NOT_FOUND", true
	}
	return "", "", false
}

// accessBlocked reads a chat_access row: blocked, and whether its scheduled
// re-check time has come.
func (a *App) accessBlocked(ctx context.Context, id string) (blocked, due bool, err error) {
	var state string
	var next sql.NullInt64
	err = a.db.Reader.QueryRowContext(ctx, `SELECT state,next_check_at FROM chat_access WHERE chat_id=?`, id).Scan(&state, &next)
	if errors.Is(err, sql.ErrNoRows) {
		return false, false, nil
	}
	if err != nil {
		return false, false, err
	}
	blocked = blockingChatState(state)
	return blocked, blocked && next.Valid && next.Int64 <= time.Now().UnixMilli(), nil
}

type accountAccess struct {
	State  string `json:"state"`
	Code   string `json:"code,omitempty"`
	Detail string `json:"detail,omitempty"`
	At     int64  `json:"at"`
}

// Re-check delays after the 1st, 2nd and 3rd+ failed check (±10 %).
var recheckSchedule = []time.Duration{time.Hour, 6 * time.Hour, 24 * time.Hour}

func recheckDelay(checks int) time.Duration {
	base := recheckSchedule[min(checks, len(recheckSchedule)-1)]
	return time.Duration(float64(base) * (0.9 + 0.2*rand.Float64()))
}

// recordDestinationAccess is 2.x's recordResult for one account's definite
// refusal: the destination is paused until its re-check time.
func (a *App) recordDestinationAccess(ctx context.Context, key, accountID, state, code string, isRecheck bool) error {
	return a.updateDestinationAccess(ctx, key, accountID, accountAccess{State: state, Code: code}, isRecheck)
}

// markDestinationReachable is 2.x's markReachable: a successful post clears
// the row once no account is failing.
func (a *App) markDestinationReachable(ctx context.Context, key, accountID string) error {
	return a.updateDestinationAccess(ctx, key, accountID, accountAccess{State: "ok"}, false)
}

func (a *App) updateDestinationAccess(ctx context.Context, key, accountID string, result accountAccess, isRecheck bool) error {
	tx, err := a.db.Writer.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var prevState string
	var accountsJSON sql.NullString
	var firstSeen, next sql.NullInt64
	var checks int
	err = tx.QueryRowContext(ctx, `SELECT state,accounts,first_seen_at,next_check_at,checks FROM chat_access WHERE chat_id=?`, key).Scan(&prevState, &accountsJSON, &firstSeen, &next, &checks)
	exists := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if !exists && result.State == "ok" {
		return nil
	}
	accounts := map[string]accountAccess{}
	if accountsJSON.Valid {
		_ = json.Unmarshal([]byte(accountsJSON.String), &accounts)
	}
	if accountID == "" {
		accountID = "_"
	}
	now := time.Now().UnixMilli()
	result.At = now
	accounts[accountID] = result
	var verdict *accountAccess
	anyOK, failing := false, false
	for id := range accounts {
		entry := accounts[id]
		switch {
		case entry.State == "ok":
			anyOK = true
		case accessPriority[entry.State] > 0:
			failing = true
			if verdict == nil || accessPriority[entry.State] > accessPriority[verdict.State] {
				verdict = &entry
			}
		}
	}
	if anyOK && !failing {
		if _, err = tx.ExecContext(ctx, `DELETE FROM chat_access WHERE chat_id=?`, key); err != nil {
			return err
		}
		return tx.Commit()
	}
	encoded, err := json.Marshal(accounts)
	if err != nil {
		return err
	}
	if anyOK || verdict == nil {
		// Postable through another account: keep the per-account note only.
		_, err = tx.ExecContext(ctx, `INSERT INTO chat_access(chat_id,state,code,detail,migrated_to,first_seen_at,checked_at,next_check_at,checks,accounts,updated_at)
 VALUES(?,'ok',NULL,NULL,NULL,NULL,?,NULL,0,?,?) ON CONFLICT(chat_id) DO UPDATE SET state='ok',code=NULL,detail=NULL,migrated_to=NULL,first_seen_at=NULL,
 checked_at=excluded.checked_at,next_check_at=NULL,checks=0,accounts=excluded.accounts,updated_at=excluded.updated_at`, key, now, string(encoded), now)
		if err != nil {
			return err
		}
		return tx.Commit()
	}
	wasBlocked := exists && accessPriority[prevState] > 0
	nextCheck := now + recheckDelay(0).Milliseconds()
	if wasBlocked {
		if isRecheck {
			checks++
			nextCheck = now + recheckDelay(checks).Milliseconds()
		} else if next.Valid {
			nextCheck = next.Int64
		} else {
			nextCheck = now + recheckDelay(checks).Milliseconds()
		}
	} else {
		checks = 0
	}
	first := now
	if wasBlocked && firstSeen.Valid {
		first = firstSeen.Int64
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO chat_access(chat_id,state,code,detail,migrated_to,first_seen_at,checked_at,next_check_at,checks,accounts,updated_at)
 VALUES(?,?,?,NULL,NULL,?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET state=excluded.state,code=excluded.code,
 detail=CASE WHEN chat_access.state=excluded.state THEN chat_access.detail ELSE NULL END,migrated_to=NULL,first_seen_at=excluded.first_seen_at,
 checked_at=excluded.checked_at,next_check_at=excluded.next_check_at,checks=excluded.checks,accounts=excluded.accounts,updated_at=excluded.updated_at`,
		key, verdict.State, nullIfEmpty(verdict.Code), first, now, nextCheck, checks, string(encoded), now)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// forwardCandidate decides, before ingestion, whether this download would be
// auto-forwarded: 2.x forwarded each newly downloaded message while its
// runtime (the live monitor) was running, and never a message it already had.
func (a *App) forwardCandidate(ctx context.Context, groupID string, messageID int64) (bool, map[string]any, string, error) {
	if a.forwarder == nil || !a.forwarder.Observing() {
		return false, nil, "", nil
	}
	a.forwardActivityMu.Lock()
	cfg, err := a.config.Load(ctx)
	if err != nil {
		a.forwardActivityMu.Unlock()
		return false, nil, "", err
	}
	settings, accountID, enabled := forwardSettings(cfg, groupID)
	a.forwardActivityMu.Unlock()
	if !enabled {
		return false, nil, "", nil
	}
	var directQueued bool
	if err := a.db.Reader.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM tgdl_forward_queue WHERE group_id=? AND message_id=? AND (stage='scan_direct' OR (json_valid(forward_config_json) AND json_extract(forward_config_json,'$.settings.scanRoute') IN ('direct','both'))))`, groupID, messageID).Scan(&directQueued); err != nil {
		return false, nil, "", err
	}
	if directQueued {
		return false, settings, accountID, nil
	}
	var exists bool
	err = a.db.Reader.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM downloads WHERE group_id=? AND message_id=?)`, groupID, messageID).Scan(&exists)
	return !exists, settings, accountID, err
}
