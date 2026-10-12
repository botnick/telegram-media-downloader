package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
	"github.com/gotd/td/tgerr"
)

// Auto-forward, as 2.x did it: after a chat's file is downloaded, the file is
// uploaded to the chat's "Forward to" destination with a caption linking the
// source post. deleteAfterForward then removes the local copy (never anything
// on Telegram). Forwards run one at a time behind the downloads, through the
// account's flood guard, and never hold up the download queue.

// forwardSender is the engine surface auto-forward needs.
type forwardSender interface {
	Observing() bool
	SendFile(context.Context, string, telegram.SendFileRequest) (string, int, error)
}

type forwardJob struct {
	groupID, groupName string
	messageID          int
	text               string
	recordID           int64
	path               string
	facts              telegram.MediaFacts
}

const (
	forwardQueueSize     = 256
	forwardFloodAttempts = 3
)

// queueForward never blocks ingestion: a full queue drops the forward and
// says so, exactly like a failed upload.
func (a *App) queueForward(job forwardJob) {
	select {
	case a.forwards <- job:
	default:
		a.forwardFailed(job, "", errors.New("auto-forward queue is full"))
	}
}

func (a *App) runForwards(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case job := <-a.forwards:
			a.forward(ctx, job)
		}
	}
}

// forwardSettings returns the chat's autoForward rule and forward account, or
// ok=false when the chat has no enabled rule.
func forwardSettings(cfg map[string]any, groupID string) (settings map[string]any, accountID string, ok bool) {
	for _, group := range configuredGroupList(cfg) {
		if toString(group["id"]) != groupID {
			continue
		}
		settings, _ = group["autoForward"].(map[string]any)
		return settings, toString(group["forwardAccount"]), settings["enabled"] == true
	}
	return nil, "", false
}

func (a *App) forward(ctx context.Context, job forwardJob) {
	cfg, err := a.config.Load(ctx)
	if err != nil {
		a.forwardFailed(job, "", err)
		return
	}
	settings, accountID, enabled := forwardSettings(cfg, job.groupID)
	if !enabled {
		return
	}
	destination := strings.TrimSpace(toString(settings["destination"]))
	// The source chat is paused everywhere else; stay consistent.
	if blocked, _, err := a.accessBlocked(ctx, job.groupID); err != nil || blocked {
		return
	}
	key := destinationKey(destination)
	destWasBlocked := false
	if key != "" {
		blocked, due, err := a.accessBlocked(ctx, key)
		if err != nil {
			a.forwardFailed(job, destination, err)
			return
		}
		if blocked && !due {
			// That forward is the re-check once its time comes.
			return
		}
		destWasBlocked = blocked
	}
	file, err := openMedia(a.downloadsDir, job.path)
	if err != nil {
		a.forwardFailed(job, destination, fmt.Errorf("open downloaded file: %w", err))
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		a.forwardFailed(job, destination, err)
		return
	}
	caption, entities := telegram.ForwardCaption(job.text, job.groupName, job.groupID, job.messageID)
	req := telegram.SendFileRequest{Destination: destination, Name: path.Base(job.path), Size: info.Size(), Facts: job.facts, Caption: caption, Entities: entities}
	var used string
	var sent int
	for attempt := 1; ; attempt++ {
		if _, err = file.Seek(0, io.SeekStart); err != nil {
			break
		}
		req.Body = file
		attemptCtx, cancel := context.WithTimeout(ctx, forwardTimeout(info.Size()))
		used, sent, err = a.forwarder.SendFile(attemptCtx, accountID, req)
		cancel()
		wait, flood := tgerr.AsFloodWait(err)
		if !flood || attempt >= forwardFloodAttempts {
			break
		}
		// Telegram asked this account to wait; the flood guard keeps every
		// other request off it meanwhile. Try again once the wait is over.
		timer := time.NewTimer(wait + time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		a.forwardFailed(job, destination, err)
		if key != "" {
			if state, code, definite := classifyAccessError(err); definite {
				if recordErr := a.recordDestinationAccess(ctx, key, used, state, code, destWasBlocked); recordErr != nil && a.output != nil {
					fmt.Fprintf(a.output, "AutoForward: could not record destination access: %v\n", recordErr)
				}
			}
		}
		return
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
	if settings["deleteAfterForward"] == true {
		file.Close()
		a.deleteForwarded(ctx, job)
	}
}

// deleteForwarded removes the local copy, as 2.x's unlink did. The catalog
// row goes with it (2.x's integrity sweep dropped it later), and the file
// itself stays when another row shares it (a deduplicated download).
func (a *App) deleteForwarded(ctx context.Context, job forwardJob) {
	deleted, err := a.deleteByWhere(contextRequest(ctx), `id=? AND REPLACE(file_path,char(92),'/')=?`, job.recordID, job.path)
	if err != nil {
		if a.output != nil {
			fmt.Fprintf(a.output, "AutoForward: forwarded but local delete failed for %s: %v\n", path.Base(job.path), err)
		}
		return
	}
	if deleted == 0 {
		return
	}
	payload := map[string]any{"path": job.path}
	if remaining, err := openMedia(a.downloadsDir, job.path); err == nil {
		remaining.Close()
		payload = map[string]any{"id": job.recordID}
	}
	a.hub.Broadcast(ws.Event{Type: "file_deleted", Flat: true, Payload: payload})
	if a.output != nil {
		fmt.Fprintf(a.output, "AutoForward: deleted local file %s\n", path.Base(job.path))
	}
}

func (a *App) forwardFailed(job forwardJob, destination string, err error) {
	if a.output != nil {
		fmt.Fprintf(a.output, "AutoForward: %s message %d failed: %v\n", job.groupName, job.messageID, err)
	}
	a.hub.Broadcast(ws.Event{Type: "forward_error", Payload: map[string]any{
		"groupId": job.groupID, "groupName": job.groupName, "messageId": job.messageID, "destination": destination, "error": err.Error(),
	}})
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
func (a *App) forwardCandidate(ctx context.Context, groupID string, messageID int64) (bool, error) {
	if a.forwarder == nil || !a.forwarder.Observing() {
		return false, nil
	}
	cfg, err := a.config.Load(ctx)
	if err != nil {
		return false, err
	}
	if _, _, enabled := forwardSettings(cfg, groupID); !enabled {
		return false, nil
	}
	var exists bool
	err = a.db.Reader.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM downloads WHERE group_id=? AND message_id=?)`, groupID, messageID).Scan(&exists)
	return !exists, err
}
