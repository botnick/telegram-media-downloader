package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

func registerURLRoutes(mux *http.ServeMux, a *App) {
	mux.Handle("POST /api/download/url", a.requireAdmin(http.HandlerFunc(a.handleDownloadURL)))
}

func (a *App) handleDownloadURL(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL  string `json:"url"`
		URLs []any  `json:"urls"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
		writeJSONError(w, 400, "Invalid JSON body")
		return
	}
	list := body.URLs
	if list == nil {
		for _, line := range strings.FieldsFunc(body.URL, func(c rune) bool { return c == '\r' || c == '\n' }) {
			if line = strings.TrimSpace(line); line != "" {
				list = append(list, line)
			}
		}
	}
	if len(list) == 0 {
		writeJSONError(w, 400, "Provide url or urls")
		return
	}
	if len(list) > 100 {
		writeJSONError(w, 400, "At most 100 URLs may be submitted at once")
		return
	}
	done, ok := a.beginMaintenance()
	if !ok {
		writeJSONError(w, 503, "Server is shutting down")
		return
	}
	defer done()
	ctx, cancel := context.WithCancel(r.Context())
	stop := context.AfterFunc(a.ctx, cancel)
	defer stop()
	defer cancel()
	r = r.WithContext(ctx)
	cfg, err := a.config.Load(ctx)
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
	epoch, err := a.urlPurgeCheckpoint()
	if err != nil {
		writeJSONError(w, 409, err.Error())
		return
	}
	// Also covers all-error batches that started a jobs-only account pool.
	defer a.startHistoryDrain(false)
	results := make([]map[string]any, 0, len(list))
	for _, raw := range list {
		result := map[string]any{"url": raw, "ok": false}
		results = append(results, result)
		text, ok := raw.(string)
		if !ok {
			result["error"] = "URL must be a string"
			continue
		}
		link, err := telegram.ParseMessageLink(text)
		if err == nil {
			err = a.acceptMessageURL(r, link, result, epoch)
		}
		if err != nil {
			result["error"] = err.Error()
		}
	}
	writeJSON(w, 200, map[string]any{"success": true, "results": results})
}

func (a *App) urlAccess(r *http.Request, id string, result map[string]any) error {
	var state string
	err := a.db.Reader.QueryRowContext(r.Context(), `SELECT state FROM chat_access WHERE chat_id=?`, id).Scan(&state)
	if errors.Is(err, sql.ErrNoRows) {
		cfg, e := a.config.Load(r.Context())
		if e != nil {
			return e
		}
		if group := urlGroup(cfg, id); group != nil {
			state = toString(legacyDialogAccess(group)["state"])
		}
	} else if err != nil {
		return err
	}
	if blockingChatState(state) {
		result["code"] = "CHAT_UNREACHABLE"
		return errors.New("This chat can't be reached (" + state + ")")
	}
	return nil
}

// urlGroup follows the same exact-marked-before-unsigned convention as live
// ingestion, avoiding two catalog groups for a historic unsigned channel ID.
func urlGroup(cfg map[string]any, ref string) map[string]any {
	groups := configuredGroupList(cfg)
	for _, g := range groups {
		if toString(g["id"]) == ref {
			return g
		}
	}
	if id, err := strconv.ParseInt(ref, 10, 64); err == nil && id < -1000000000000 {
		raw := strconv.FormatInt(-1000000000000-id, 10)
		for _, g := range groups {
			if toString(g["id"]) == raw {
				return g
			}
		}
	}
	if strings.HasPrefix(ref, "@") {
		for _, g := range groups {
			if strings.EqualFold(strings.TrimPrefix(toString(g["username"]), "@"), strings.TrimPrefix(ref, "@")) {
				return g
			}
		}
	}
	return nil
}

func (a *App) urlPurgeCheckpoint() (uint64, error) {
	a.purgeMu.Lock()
	defer a.purgeMu.Unlock()
	for _, p := range a.purges {
		if p.Phase != "done" {
			return 0, errPurgePending
		}
	}
	return a.purgeEpoch, nil
}

func (a *App) checkURLPurge(epoch uint64) error {
	current, err := a.urlPurgeCheckpoint()
	if err != nil {
		return err
	}
	if current != epoch {
		return errors.New("A purge interrupted this URL request; submit the link again if needed")
	}
	return nil
}

func (a *App) acceptMessageURL(r *http.Request, link telegram.MessageLink, result map[string]any, epoch uint64) error {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	r = r.WithContext(ctx)
	if err := a.urlAccess(r, link.ChatRef, result); err != nil {
		return err
	}
	cfg, err := a.config.Load(ctx)
	if err != nil {
		return err
	}
	group := urlGroup(cfg, link.ChatRef)
	accountID := toString(group["monitorAccount"])
	open := func(id string) (*engine.MessageSession, error) {
		a.monitorOp.Lock()
		defer a.monitorOp.Unlock()
		if err := a.checkURLPurge(epoch); err != nil {
			return nil, err
		}
		if err := a.startTelegramEngine(ctx, false); err != nil {
			return nil, err
		}
		return a.monitor.OpenURL(ctx, id)
	}
	session, err := open(accountID)
	if err != nil {
		return err
	}
	defer func() { session.Close() }()
	dialog, err := session.Resolve(link.ChatRef)
	if err != nil {
		return err
	}
	cfg, err = a.config.Load(ctx)
	if err != nil {
		return err
	}
	group = urlGroup(cfg, dialog.ID)
	if group != nil {
		if err = a.urlAccess(r, toString(group["id"]), result); err != nil {
			return err
		}
	}
	if err = a.urlAccess(r, dialog.ID, result); err != nil {
		return err
	}
	// Resolving a public username can reveal a configured numeric pin. Route
	// to that account before reading media; an RPC failure never selects another.
	if pin := toString(group["monitorAccount"]); pin != "" && pin != session.AccountID {
		resolvedID := dialog.ID
		session.Close()
		next, err := open(pin)
		if err != nil {
			return err
		}
		session = next
		dialog, err = session.Resolve(link.ChatRef)
		if err != nil {
			return err
		}
		if dialog.ID != resolvedID {
			return errors.New("Telegram username changed while selecting its account")
		}
	}
	fresh, err := session.Read(dialog, link.MessageID)
	if errors.Is(err, telegram.ErrNoMedia) {
		return errors.New("Message has no downloadable media")
	}
	if err != nil {
		return err
	}
	if fresh == nil || fresh.Message == nil {
		return errors.New("Telegram returned no message")
	}
	media, err := telegram.MessageAttachment(fresh.Message)
	if errors.Is(err, telegram.ErrNoMedia) {
		return errors.New("Message has no downloadable media")
	}
	if err != nil {
		return err
	}
	if media.GroupID != dialog.ID || media.MessageID != int64(link.MessageID) {
		return errors.New("Telegram returned a different message")
	}
	if fresh.Dialog != nil && fresh.Dialog.ID == dialog.ID {
		dialog.Name, dialog.Username = fresh.Dialog.Name, fresh.Dialog.Username
	}
	name, accepted, err := a.queueMessageURL(ctx, session, dialog, fresh, epoch)
	if err != nil {
		return err
	}
	publicType := media.FilterKey()
	if publicType == "files" {
		publicType = "documents"
	}
	result["ok"], result["group"], result["messageId"], result["mediaType"] = accepted, name, link.MessageID, publicType
	return nil
}

func manualGroup(dialog telegram.Dialog) map[string]any {
	return map[string]any{"id": dialog.ID, "name": dialog.Name, "username": dialog.Username, "enabled": false,
		"filters":     map[string]any{"photos": true, "videos": true, "files": true, "links": true, "voice": false, "gifs": false, "stickers": false},
		"autoForward": map[string]any{"enabled": false, "destination": nil, "deleteAfterForward": false},
		"trackUsers":  map[string]any{"enabled": false, "users": []any{}}, "topics": map[string]any{"enabled": false, "ids": []any{}}}
}

func (a *App) queueMessageURL(ctx context.Context, session *engine.MessageSession, dialog telegram.Dialog, fresh *telegram.RefreshedMessage, epoch uint64) (string, bool, error) {
	a.mediaMu.RLock()
	defer a.mediaMu.RUnlock()
	if err := a.mediaWritable(ctx); err != nil {
		return "", false, err
	}
	if err := a.checkURLPurge(epoch); err != nil {
		return "", false, err
	}
	if err := session.Err(); err != nil {
		return "", false, err
	}
	a.configMu.Lock()
	defer a.configMu.Unlock()
	cfg, err := a.config.Load(ctx)
	if err != nil {
		return "", false, err
	}
	group := urlGroup(cfg, dialog.ID)
	added := group == nil
	if added {
		group = manualGroup(dialog)
		groups, _ := cfg["groups"].([]any)
		cfg["groups"] = append(groups, group)
	}
	target, allowed, err := a.monitorFilterConfig(engine.WithOrigin(ctx, "url"), cfg, session.AccountID, fresh.Message, fresh.Entities)
	if err != nil {
		return "", false, err
	}
	if !allowed {
		return "", false, errors.New("Group account, suspension or ownership prevents this download")
	}
	// Serialize acceptance with the drainer's final pending-work check so it
	// cannot exit on an older empty snapshot after this enqueue succeeds.
	a.historyMu.Lock()
	defer a.historyMu.Unlock()
	tx, err := a.db.Writer.BeginTx(ctx, nil)
	if err != nil {
		return "", false, err
	}
	defer tx.Rollback()
	if added {
		encoded, e := json.Marshal(cfg)
		if e != nil {
			return "", false, e
		}
		if _, err = tx.ExecContext(ctx, `UPDATE kv SET value=?,updated_at=? WHERE key='config'`, string(encoded), time.Now().UnixMilli()); err != nil {
			return "", false, err
		}
	}
	id, accepted, err := session.QueueTx(ctx, tx, target, fresh.Message, true, fresh.PTS)
	if err != nil {
		return "", false, err
	}
	if err = tx.Commit(); err != nil {
		return "", false, err
	}
	session.Wake(id)
	if added {
		a.hub.Broadcast(ws.Event{Type: "config_updated", Flat: true})
	}
	return target.Name, accepted, nil
}
