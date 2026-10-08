package app

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
)

func registerStoryRoutes(mux *http.ServeMux, a *App) {
	for _, kind := range []string{"user", "all", "download"} {
		mux.Handle("POST /api/stories/"+kind, a.requireAdmin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { a.handleStories(w, r, kind) })))
	}
}

func (a *App) storyBlocked(ctx context.Context, ref string) (map[string]any, error) {
	cfg, err := a.config.Load(ctx)
	if err != nil {
		return nil, err
	}
	group := urlGroup(cfg, ref)
	id := ref
	if group != nil {
		id = toString(group["id"])
	}
	if !chatIDPattern.MatchString(id) {
		return nil, nil
	}
	access, err := a.readDialogAccess(ctx)
	if err != nil {
		return nil, err
	}
	state := access[id]
	if state == nil {
		state = legacyDialogAccess(group)
	}
	if blockingChatState(toString(state["state"])) {
		return state, nil
	}
	return nil, nil
}

func writeStoryBlocked(w http.ResponseWriter, access map[string]any) {
	writeJSON(w, 409, map[string]any{"error": "This chat can't be reached (" + toString(access["state"]) + ") — no account can read it", "code": "CHAT_UNREACHABLE", "access": access})
}

func (a *App) openStorySession(ctx context.Context, ref string, epoch uint64) (*engine.MessageSession, telegram.Dialog, error) {
	cfg, err := a.config.Load(ctx)
	if err != nil {
		return nil, telegram.Dialog{}, err
	}
	open := func(pin string) (*engine.MessageSession, error) {
		a.monitorOp.Lock()
		defer a.monitorOp.Unlock()
		if err := a.checkURLPurge(epoch); err != nil {
			return nil, err
		}
		if err := a.startTelegramEngine(ctx, false); err != nil {
			return nil, err
		}
		return a.monitor.OpenStories(ctx, pin)
	}
	s, err := open(toString(urlGroup(cfg, ref)["monitorAccount"]))
	if err != nil {
		return nil, telegram.Dialog{}, err
	}
	if ref == "" {
		return s, telegram.Dialog{}, nil
	}
	d, err := s.Resolve(ref)
	if err != nil {
		s.Close()
		return nil, d, err
	}
	cfg, err = a.config.Load(ctx)
	if err != nil {
		s.Close()
		return nil, d, err
	}
	if pin := toString(urlGroup(cfg, d.ID)["monitorAccount"]); pin != "" && pin != s.AccountID {
		id := d.ID
		s.Close()
		s, err = open(pin)
		if err != nil {
			return nil, d, err
		}
		d, err = s.Resolve(ref)
		if err == nil && d.ID != id {
			err = errors.New("Telegram username changed while selecting its account")
		}
		if err != nil {
			s.Close()
			return nil, d, err
		}
	}
	return s, d, nil
}

func (a *App) handleStories(w http.ResponseWriter, r *http.Request, kind string) {
	body, ok := readAuthBody(w, r)
	if !ok {
		return
	}
	ref := strings.TrimSpace(toString(body["username"]))
	if value, ok := body["username"].(float64); ok {
		ref = strconv.FormatFloat(value, 'f', -1, 64)
	}
	ids := []int{}
	if kind != "all" {
		if ref == "" {
			msg := "username required"
			if kind == "download" {
				msg = "username and storyIds required"
			}
			writeJSONError(w, 400, msg)
			return
		}
		if !chatIDPattern.MatchString(ref) {
			ref = "@" + strings.TrimPrefix(ref, "@")
		}
	}
	if kind == "download" {
		raw, ok := body["storyIds"].([]any)
		if !ok || len(raw) == 0 {
			writeJSONError(w, 400, "username and storyIds required")
			return
		}
		if len(raw) > 100 {
			writeJSONError(w, 400, "At most 100 story IDs may be submitted at once")
			return
		}
		for _, item := range raw {
			value := toString(item)
			if f, ok := item.(float64); ok {
				value = strconv.FormatFloat(f, 'f', -1, 64)
			}
			n, err := strconv.ParseInt(value, 10, 32)
			if err != nil || n <= 0 {
				writeJSONError(w, 400, "storyIds must contain positive integers")
				return
			}
			ids = append(ids, int(n))
		}
	}
	done, ok := a.beginMaintenance()
	if !ok {
		writeJSONError(w, 503, "Server is shutting down")
		return
	}
	defer done()
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	stop := context.AfterFunc(a.ctx, cancel)
	defer stop()
	if kind != "all" {
		access, err := a.storyBlocked(ctx, ref)
		if err != nil {
			writeJSONError(w, 500, err.Error())
			return
		}
		if access != nil {
			writeStoryBlocked(w, access)
			return
		}
	}
	err := a.telegramReadiness(ctx)
	if err != nil {
		switch {
		case errors.Is(err, errNoAccounts):
			writeJSONError(w, 409, "No Telegram accounts loaded")
		case errors.Is(err, errNoAPICredentials):
			if kind == "download" {
				writeJSONError(w, 500, "Telegram API credentials not configured")
			} else {
				writeJSON(w, 503, map[string]any{"code": "NO_API_CREDS", "error": err.Error()})
			}
		default:
			writeJSONError(w, 500, err.Error())
		}
		return
	}
	epoch, err := a.urlPurgeCheckpoint()
	if err != nil {
		writeJSONError(w, 409, err.Error())
		return
	}
	defer a.startHistoryDrain(false)
	if kind == "download" {
		a.storiesOp.Lock()
		defer a.storiesOp.Unlock()
	}
	s, d, err := a.openStorySession(ctx, ref, epoch)
	if err != nil {
		status := 502
		if kind == "download" {
			status = 500
		}
		writeJSONError(w, status, err.Error())
		return
	}
	defer s.Close()
	if kind != "all" {
		access, e := a.storyBlocked(ctx, d.ID)
		if e != nil {
			writeJSONError(w, 500, e.Error())
			return
		}
		if access != nil {
			writeStoryBlocked(w, access)
			return
		}
	}
	switch kind {
	case "all":
		groups, count, e := s.AllStories()
		if e != nil {
			writeJSONError(w, 502, e.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"success": true, "groups": groups, "count": count})
	case "user":
		result, e := s.PeerStories(d, ref)
		if e != nil {
			writeJSONError(w, 502, e.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"success": true, "peer": result.Peer, "stories": result.Stories})
	case "download":
		unique := []int{}
		seen := map[int]bool{}
		for _, id := range ids {
			if !seen[id] {
				unique = append(unique, id)
				seen[id] = true
			}
		}
		messages, e := s.Stories(d, unique)
		if e != nil {
			writeJSONError(w, 500, e.Error())
			return
		}
		for _, fresh := range messages {
			if fresh == nil || fresh.Message == nil {
				writeJSONError(w, 502, "Telegram returned no story")
				return
			}
			media, e := telegram.MessageAttachment(fresh.Message)
			if e != nil || media.GroupID != d.ID || !seen[fresh.Message.ID] {
				writeJSONError(w, 502, "Telegram returned a different story")
				return
			}
			delete(seen, fresh.Message.ID)
			if fresh.Dialog != nil && fresh.Dialog.ID == d.ID {
				d.Name, d.Username = fresh.Dialog.Name, fresh.Dialog.Username
			}
		}
		_, queued, e := a.queueExplicitMessages(ctx, s, d, messages, epoch)
		if e != nil {
			writeJSONError(w, 500, e.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"success": true, "queued": queued, "requested": len(ids)})
	}
}
