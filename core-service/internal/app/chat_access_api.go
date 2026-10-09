package app

import (
	"context"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

type chatQuery struct {
	kind      string
	messageID int64
	topicID   *int64
	message   bool
	reason    string
}

type chatRecheckState struct {
	running    bool
	attempts   int
	successes  int
	failures   int
	startedAt  int64
	finishedAt int64
	durationMs int64
	stage      string
	progress   map[string]any
	result     any
	err        any
}

var chatIDPattern = regexp.MustCompile(`^-?\d+$`)

func registerChatAccessRoutes(mux *http.ServeMux, a *App) {
	mux.Handle("POST /api/chats/{id}/leave", a.requireAdmin(http.HandlerFunc(a.handleChatLeave)))
	mux.Handle("POST /api/chats/leave-batch", a.requireAdmin(http.HandlerFunc(a.handleChatLeaveBatch)))
	mux.Handle("GET /api/chats/leave-batch/status", a.requireAdmin(http.HandlerFunc(a.handleChatLeaveBatchStatus)))
	mux.Handle("GET /api/chats/access", a.requireAdmin(http.HandlerFunc(a.handleChatAccessList)))
	mux.Handle("POST /api/chats/access/recheck", a.requireAdmin(http.HandlerFunc(a.handleChatAccessRecheck)))
	mux.Handle("GET /api/chats/access/recheck/status", a.requireAdmin(http.HandlerFunc(a.handleChatAccessRecheckStatus)))
	mux.Handle("POST /api/chats/access/stop", a.requireAdmin(http.HandlerFunc(a.handleChatAccessStop)))
	mux.Handle("POST /api/chats/access/remove", a.requireAdmin(http.HandlerFunc(a.handleChatAccessRemove)))
	mux.Handle("POST /api/chats/{id}/follow-migration", a.requireAdmin(http.HandlerFunc(a.handleFollowMigration)))
	mux.Handle("GET /api/chats/lookup", a.requireAdmin(http.HandlerFunc(a.handleChatLookup)))
}

func (a *App) handleChatAccessList(w http.ResponseWriter, r *http.Request) {
	config, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "config read failed")
		return
	}
	access := a.loadDialogAccess(r)
	items := make([]map[string]any, 0)
	byState := map[string]int{}
	for _, raw := range configuredGroupList(config) {
		id := toString(raw["id"])
		if id == "" || strings.HasPrefix(id, "unknown:") {
			continue
		}
		state := access[id]
		if state == nil {
			state = legacyDialogAccess(raw)
		}
		if !blockingChatState(toString(state["state"])) {
			continue
		}
		name := toString(raw["name"])
		if name == "" {
			name = id
		}
		byState[toString(state["state"])]++
		items = append(items, map[string]any{
			"id": id, "name": name, "type": raw["type"], "enabled": raw["enabled"] != false, "access": state,
		})
	}
	if r.URL.Query().Get("countOnly") == "1" {
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "total": len(items), "byState": byState})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "total": len(items), "byState": byState, "items": items})
}

func configuredGroupList(config map[string]any) []map[string]any {
	groups, _ := config["groups"].([]any)
	out := make([]map[string]any, 0, len(groups))
	for _, raw := range groups {
		if group, ok := raw.(map[string]any); ok {
			out = append(out, group)
		}
	}
	return out
}

func blockingChatState(state string) bool {
	switch state {
	case "", "ok", "unknown":
		return false
	default:
		return true
	}
}

func (a *App) handleChatAccessRecheck(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID  any   `json:"id"`
		IDs []any `json:"ids"`
		All bool  `json:"all"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		return
	}
	if id := strings.TrimSpace(toString(body.ID)); id != "" && len(body.IDs) == 0 && !body.All {
		state := a.chatAccessForID(r, id)
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "id": id, "state": toString(state["state"]), "access": state, "accountId": nil, "inconclusive": true, "results": []any{}})
		return
	}
	ids := make([]string, 0, len(body.IDs))
	seen := map[string]bool{}
	for _, raw := range body.IDs {
		id := strings.TrimSpace(toString(raw))
		if id != "" && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	if body.All {
		ids = ids[:0]
		seen = map[string]bool{}
		config, err := a.config.Load(r.Context())
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "config read failed")
			return
		}
		access := a.loadDialogAccess(r)
		for _, group := range configuredGroupList(config) {
			id := toString(group["id"])
			state := access[id]
			if state == nil {
				state = legacyDialogAccess(group)
			}
			if id != "" && !strings.HasPrefix(id, "unknown:") && blockingChatState(toString(state["state"])) && !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
		}
	}
	if len(ids) > 500 {
		ids = ids[:500]
	}
	if len(ids) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "started": false, "total": 0})
		return
	}
	if !a.beginChatRecheck(ids) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "A check is already running", "code": "ALREADY_RUNNING"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "started": true, "total": len(ids)})
}

func (a *App) chatAccessForID(r *http.Request, id string) map[string]any {
	access := a.loadDialogAccess(r)[id]
	if access != nil {
		return access
	}
	config, _ := a.config.Load(r.Context())
	for _, group := range configuredGroupList(config) {
		if toString(group["id"]) == id {
			return legacyDialogAccess(group)
		}
	}
	return map[string]any{"state": "ok"}
}

func (a *App) handleChatAccessRecheckStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, a.chatRecheckStatus())
}

func (a *App) chatRecheckStatus() map[string]any {
	a.chatRecheckMu.Lock()
	defer a.chatRecheckMu.Unlock()
	if a.chatRecheck.stage == "" {
		a.chatRecheck.stage = "idle"
	}
	progress := map[string]any{}
	for key, value := range a.chatRecheck.progress {
		progress[key] = value
	}
	return map[string]any{
		"attempts": a.chatRecheck.attempts, "durationMs": a.chatRecheck.durationMs, "error": a.chatRecheck.err,
		"failures": a.chatRecheck.failures, "finishedAt": a.chatRecheck.finishedAt, "kind": "chatAccessRecheck",
		"progress": progress, "result": a.chatRecheck.result, "running": a.chatRecheck.running, "stage": a.chatRecheck.stage,
		"startedAt": a.chatRecheck.startedAt, "successes": a.chatRecheck.successes,
	}
}

func (a *App) beginChatRecheck(ids []string) bool {
	a.chatRecheckMu.Lock()
	if a.chatRecheck.running || a.chatRecheckClosed || a.ctx.Err() != nil {
		a.chatRecheckMu.Unlock()
		return false
	}
	start := time.Now()
	a.chatRecheck.running = true
	a.chatRecheck.attempts++
	a.chatRecheck.startedAt = start.UnixMilli()
	a.chatRecheck.finishedAt = 0
	a.chatRecheck.durationMs = 0
	a.chatRecheck.stage = "starting"
	a.chatRecheck.progress = map[string]any{}
	a.chatRecheck.err = nil
	a.chatRecheckWG.Add(1)
	a.chatRecheckMu.Unlock()
	a.broadcastChatRecheckProgress()
	go func() {
		defer a.chatRecheckWG.Done()
		defer func() {
			if a.ctx.Err() != nil {
				a.chatRecheckMu.Lock()
				a.chatRecheck.running = false
				a.chatRecheck.stage = "error"
				a.chatRecheck.err = a.ctx.Err().Error()
				a.chatRecheck.failures++
				a.chatRecheck.finishedAt = time.Now().UnixMilli()
				a.chatRecheck.durationMs = time.Since(start).Milliseconds()
				a.chatRecheckMu.Unlock()
			}
		}()
		results := make([]map[string]any, 0, len(ids))
		reachable := 0
		a.chatRecheckMu.Lock()
		a.chatRecheck.progress = map[string]any{"processed": 0, "total": len(ids), "reachable": 0}
		a.chatRecheckMu.Unlock()
		a.broadcastChatRecheckProgress()
		for index, id := range ids {
			if index > 0 {
				timer := time.NewTimer(2 * time.Second)
				select {
				case <-a.ctx.Done():
					timer.Stop()
					return
				case <-timer.C:
				}
			}
			if a.ctx.Err() != nil {
				return
			}
			state := a.chatAccessForID(contextRequest(a.ctx), id)
			stateName := toString(state["state"])
			if stateName == "" {
				stateName = "unknown"
			}
			if stateName == "ok" {
				reachable++
			}
			results = append(results, map[string]any{"id": id, "state": stateName, "inconclusive": true})
			a.chatRecheckMu.Lock()
			a.chatRecheck.progress = map[string]any{"processed": index + 1, "total": len(ids), "reachable": reachable}
			a.chatRecheckMu.Unlock()
			a.broadcastChatRecheckProgress()
		}
		finished := time.Now()
		result := map[string]any{"total": len(ids), "reachable": reachable, "results": results}
		a.chatRecheckMu.Lock()
		a.chatRecheck.running = false
		a.chatRecheck.finishedAt = finished.UnixMilli()
		a.chatRecheck.durationMs = finished.Sub(time.UnixMilli(a.chatRecheck.startedAt)).Milliseconds()
		a.chatRecheck.stage = "done"
		a.chatRecheck.result = result
		a.chatRecheck.successes++
		a.chatRecheckMu.Unlock()
		a.hub.Broadcast(ws.Event{Type: "chat_access_recheck_done", Flat: true, Payload: map[string]any{"kind": "chatAccessRecheck", "durationMs": resultDuration(a), "reachable": reachable, "results": results, "total": len(ids)}})
	}()
	return true
}

// contextRequest gives helpers a cancellable context without coupling the
// short-lived recheck worker to an HTTP request that has already returned.
func contextRequest(ctx context.Context) *http.Request {
	if ctx == nil {
		ctx = context.Background()
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "/", nil)
	return req
}

func resultDuration(a *App) int64 {
	a.chatRecheckMu.Lock()
	defer a.chatRecheckMu.Unlock()
	return a.chatRecheck.durationMs
}

func (a *App) broadcastChatRecheckProgress() {
	status := a.chatRecheckStatus()
	if progress, ok := status["progress"].(map[string]any); ok {
		for _, key := range []string{"processed", "reachable", "total"} {
			if value, exists := progress[key]; exists {
				status[key] = value
			}
		}
	}
	a.hub.Broadcast(ws.Event{Type: "chat_access_recheck_progress", Flat: true, Payload: status})
}

func (a *App) handleChatAccessStop(w http.ResponseWriter, r *http.Request) {
	a.configMu.Lock()
	defer a.configMu.Unlock()
	var body struct {
		IDs any `json:"ids"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		return
	}
	ids := stringIDsValue(body.IDs)
	if len(ids) == 0 {
		writeJSONError(w, http.StatusBadRequest, "ids[] required")
		return
	}
	config, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "config read failed")
		return
	}
	stopped := 0
	for _, group := range configuredGroupList(config) {
		if contains(ids, toString(group["id"])) && group["enabled"] != false {
			group["enabled"] = false
			stopped++
		}
	}
	if stopped > 0 {
		if err := a.config.Save(r.Context(), config); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "config save failed")
			return
		}
		a.hub.Broadcast(ws.Event{Type: "config_updated"})
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "stopped": stopped})
}

func (a *App) handleChatAccessRemove(w http.ResponseWriter, r *http.Request) {
	a.configMu.Lock()
	defer a.configMu.Unlock()
	var body struct {
		IDs any `json:"ids"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		return
	}
	ids := stringIDsValue(body.IDs)
	if len(ids) == 0 {
		writeJSONError(w, http.StatusBadRequest, "ids[] required")
		return
	}
	config, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "config read failed")
		return
	}
	before := len(configuredGroupList(config))
	groups, _ := config["groups"].([]any)
	kept := make([]any, 0, len(groups))
	for _, raw := range groups {
		group, ok := raw.(map[string]any)
		if ok && contains(ids, toString(group["id"])) {
			continue
		}
		kept = append(kept, raw)
	}
	config["groups"] = kept
	removed := before - len(configuredGroupList(config))
	if removed > 0 {
		if err := a.config.Save(r.Context(), config); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "config save failed")
			return
		}
		a.hub.Broadcast(ws.Event{Type: "config_updated"})
	}
	if _, err := a.db.Writer.ExecContext(r.Context(), `DELETE FROM chat_access WHERE chat_id IN (`+placeholders(len(ids))+`)`, stringAny(ids)...); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "access cleanup failed")
		return
	}
	a.hub.Broadcast(ws.Event{Type: "chat_access_changed", Flat: true, Payload: map[string]any{"ids": ids}})
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "removed": removed})
}

func (a *App) handleFollowMigration(w http.ResponseWriter, r *http.Request) {
	a.configMu.Lock()
	defer a.configMu.Unlock()
	id := strings.TrimSpace(r.PathValue("id"))
	config, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "config read failed")
		return
	}
	var old map[string]any
	for _, group := range configuredGroupList(config) {
		if toString(group["id"]) == id {
			old = group
			break
		}
	}
	if old == nil {
		writeJSONError(w, http.StatusNotFound, "Chat not in the list")
		return
	}
	access := a.chatAccessForID(r, id)
	newID := toString(access["migratedTo"])
	if toString(access["state"]) != "migrated" || newID == "" {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "This chat was not moved to a new group", "code": "NOT_MIGRATED"})
		return
	}
	var target map[string]any
	for _, group := range configuredGroupList(config) {
		if toString(group["id"]) == newID {
			target = group
			break
		}
	}
	added := target == nil
	if target == nil {
		targetID := any(newID)
		if parsedID, parseErr := strconv.ParseInt(newID, 10, 64); parseErr == nil {
			targetID = parsedID
		}
		target = map[string]any{"id": targetID, "name": old["name"], "enabled": old["enabled"] != false}
		if filters, ok := old["filters"].(map[string]any); ok {
			target["filters"] = map[string]any{
				"photos": filters["photos"], "videos": filters["videos"], "files": filters["files"],
				"links": filters["links"], "urls": true, "audio": false, "voice": filters["voice"],
				"gifs": filters["gifs"], "stickers": filters["stickers"],
			}
		}
		for _, key := range []string{"filters", "autoForward", "trackUsers", "topics", "rescueMode", "rescueRetentionHours", "monitorAccount", "forwardAccount", "ownerPeerId", "backupPeerId"} {
			if key == "filters" {
				continue
			}
			if value, ok := old[key]; ok {
				target[key] = value
			}
		}
		groups, _ := config["groups"].([]any)
		config["groups"] = append(groups, target)
	} else if old["enabled"] != false {
		target["enabled"] = true
	}
	old["enabled"] = false
	if err := a.config.Save(r.Context(), config); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "config save failed")
		return
	}
	a.hub.Broadcast(ws.Event{Type: "config_updated"})
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "added": added, "group": target, "previous": map[string]any{"id": old["id"], "enabled": false}})
}

func (a *App) handleChatLookup(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeJSONError(w, http.StatusBadRequest, "q required")
		return
	}
	parsed := parseChatQuery(q)
	if parsed.kind == "name" {
		writeJSON(w, http.StatusOK, map[string]any{"kind": "name", "chat": nil})
		return
	}
	if parsed.kind == "unsupported" {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"kind": "unsupported", "error": parsed.reason})
		return
	}
	var message any
	if parsed.message {
		message = map[string]any{"messageId": parsed.messageID, "topicId": parsed.topicID, "url": q}
	}
	writeJSON(w, http.StatusServiceUnavailable, map[string]any{"kind": parsed.kind, "error": "no_account", "message": message})
}

func parseChatQuery(q string) chatQuery {
	q = strings.TrimSpace(q)
	if strings.HasPrefix(q, "@") {
		return chatQuery{kind: "username"}
	}
	if chatIDPattern.MatchString(q) && strings.HasPrefix(q, "-100") {
		return chatQuery{kind: "id"}
	}
	u := strings.TrimPrefix(strings.TrimPrefix(q, "https://"), "http://")
	u = strings.TrimPrefix(u, "www.")
	if !strings.HasPrefix(u, "t.me/") {
		return chatQuery{kind: "name"}
	}
	parts := strings.Split(strings.Trim(strings.TrimPrefix(u, "t.me/"), "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		return chatQuery{kind: "unsupported", reason: "Not a chat link"}
	}
	if parts[0] == "joinchat" || (strings.HasPrefix(parts[0], "+") && !chatIDPattern.MatchString(strings.TrimPrefix(parts[0], "+"))) {
		return chatQuery{kind: "invite"}
	}
	if strings.HasPrefix(parts[0], "+") {
		return chatQuery{kind: "unsupported", reason: "Not a chat link"}
	}
	if parts[0] == "c" {
		if len(parts) < 2 || !chatIDPattern.MatchString(parts[1]) {
			return chatQuery{kind: "unsupported", reason: "Private-channel link without a chat id"}
		}
		if len(parts) < 3 || !chatIDPattern.MatchString(parts[len(parts)-1]) {
			return chatQuery{kind: "unsupported", reason: "Private-channel link without a message id"}
		}
		messageID, _ := strconv.ParseInt(parts[len(parts)-1], 10, 64)
		var topic *int64
		if len(parts) >= 4 {
			value, err := strconv.ParseInt(parts[len(parts)-2], 10, 64)
			if err == nil {
				topic = &value
			}
		}
		return chatQuery{kind: "message", messageID: messageID, topicID: topic, message: true}
	}
	if strings.HasPrefix(parts[0], "+") || parts[0] == "addstickers" || parts[0] == "proxy" {
		return chatQuery{kind: "unsupported", reason: "Not a chat link"}
	}
	if len(parts) == 1 {
		return chatQuery{kind: "username"}
	}
	if len(parts) == 2 && chatIDPattern.MatchString(parts[1]) {
		messageID, _ := strconv.ParseInt(parts[1], 10, 64)
		return chatQuery{kind: "message", messageID: messageID, message: true}
	}
	return chatQuery{kind: "unsupported", reason: "Not a chat link"}
}

func stringIDs(values []any) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		id := strings.TrimSpace(toString(value))
		if id != "" && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

func stringIDsValue(value any) []string {
	values, ok := value.([]any)
	if !ok {
		return nil
	}
	return stringIDs(values)
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func placeholders(n int) string {
	if n < 1 {
		return "?"
	}
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

func stringAny(values []string) []any {
	out := make([]any, len(values))
	for i, value := range values {
		out[i] = value
	}
	return out
}
