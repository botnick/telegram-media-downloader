package app

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"sort"
	"strings"

	"github.com/botnick/telegram-media-downloader/core-service/internal/auth"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
)

func registerDialogRoutes(mux *http.ServeMux, a *App) {
	mux.Handle("GET /api/dialogs", a.requireSession(http.HandlerFunc(a.handleDialogs)))
}

func (a *App) handleDialogs(w http.ResponseWriter, r *http.Request) {
	dialogs, err := a.monitor.Dialogs(r.Context(), 500)
	if err != nil {
		saved, savedErr := telegram.SavedSessions(a.dataDir)
		if savedErr == nil && len(saved) == 0 {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "no_account", "message": "No Telegram account configured"})
		} else {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "not_connected", "message": "Telegram client not connected"})
		}
		return
	}
	accessByID := a.loadDialogAccess(r)
	cfg, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	groups, _ := cfg["groups"].([]any)
	groupByID := map[string]map[string]any{}
	for _, raw := range groups {
		if group, ok := raw.(map[string]any); ok {
			groupByID[toString(group["id"])] = group
		}
	}
	allowDM := false
	if value, ok := cfg["allowDmDownloads"].(bool); ok {
		allowDM = value
	}
	result := make([]map[string]any, 0, len(dialogs))
	for _, dialog := range dialogs {
		if (dialog.Type == "user" || dialog.Type == "bot") && !allowDM {
			continue
		}
		group := groupByID[dialog.ID]
		filters := map[string]any{"photos": true, "videos": true, "files": true, "links": true, "voice": false, "gifs": false, "stickers": false}
		if configured, ok := group["filters"].(map[string]any); ok {
			for key, value := range configured {
				filters[key] = value
			}
		}
		autoForward := map[string]any{"enabled": false, "destination": nil, "deleteAfterForward": false}
		if configured, ok := group["autoForward"].(map[string]any); ok {
			for key, value := range configured {
				autoForward[key] = value
			}
		}
		var members any
		if dialog.Members != nil {
			members = *dialog.Members
		}
		access, knownAccess := accessByID[dialog.ID]
		if !knownAccess {
			access = legacyDialogAccess(group)
		}
		if sess, ok := auth.SessionFromContext(r.Context()); ok && sess.Role == "guest" {
			if _, ok := access["accounts"].([]map[string]any); ok {
				access["accounts"] = []map[string]any{}
			}
		}
		result = append(result, map[string]any{
			"id": dialog.ID, "name": dialog.Name, "type": dialog.Type, "username": dialog.Username,
			"archived": dialog.Archived, "members": members, "enabled": group != nil && group["enabled"] == true,
			"inConfig": group != nil, "suspended": group != nil && group["suspended"] == true,
			"filters": filters, "autoForward": autoForward, "photoUrl": "/api/groups/" + dialog.ID + "/photo", "accountIds": dialog.AccountIDs,
			"access": access,
		})
	}
	accountList := make([]map[string]any, 0)
	accountIDs := map[string]bool{}
	if rawAccounts, ok := cfg["accounts"].([]any); ok {
		for _, raw := range rawAccounts {
			if account, ok := raw.(map[string]any); ok {
				id := toString(account["id"])
				if id == "" || accountIDs[id] {
					continue
				}
				accountIDs[id] = true
				accountList = append(accountList, map[string]any{"id": id, "name": firstNonEmpty(toString(account["name"]), toString(account["username"]), id), "phone": toString(account["phone"]), "username": toString(account["username"])})
			}
		}
	}
	if saved, savedErr := telegram.SavedSessions(a.dataDir); savedErr == nil {
		for _, session := range saved {
			if session.ID == "" || accountIDs[session.ID] {
				continue
			}
			accountIDs[session.ID] = true
			accountList = append(accountList, map[string]any{"id": session.ID, "name": session.ID, "phone": "", "username": ""})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "dialogs": result, "allowDM": allowDM, "accounts": accountList})
}

func (a *App) loadDialogAccess(r *http.Request) map[string]map[string]any {
	result := map[string]map[string]any{}
	rows, err := a.db.Reader.QueryContext(r.Context(), `SELECT chat_id,state,code,detail,migrated_to,first_seen_at,checked_at,next_check_at,checks,accounts FROM chat_access LIMIT 50000`)
	if err != nil {
		return result
	}
	defer rows.Close()
	for rows.Next() {
		var id, state string
		var code, detail, migrated, accountsJSON sql.NullString
		var firstSeen, checked, nextCheck sql.NullInt64
		var checks int
		if err := rows.Scan(&id, &state, &code, &detail, &migrated, &firstSeen, &checked, &nextCheck, &checks, &accountsJSON); err != nil {
			continue
		}
		accounts := []map[string]any{}
		var accountMap map[string]struct {
			State string `json:"state"`
			Code  string `json:"code"`
			At    int64  `json:"at"`
		}
		if accountsJSON.Valid && json.Unmarshal([]byte(accountsJSON.String), &accountMap) == nil {
			for accountID, account := range accountMap {
				if accountID == "_" {
					continue
				}
				var code any
				if account.Code != "" {
					code = account.Code
				}
				accounts = append(accounts, map[string]any{"id": accountID, "state": account.State, "code": code, "at": account.At})
			}
		}
		sort.Slice(accounts, func(i, j int) bool { return accounts[i]["id"].(string) < accounts[j]["id"].(string) })
		access := map[string]any{"state": state, "code": dialogNullableString(code), "detail": dialogNullableString(detail), "migratedTo": dialogNullableString(migrated), "firstSeenAt": dialogNullableInt(firstSeen), "checkedAt": dialogNullableInt(checked), "nextCheckAt": dialogNullableInt(nextCheck), "checks": checks, "accounts": accounts}
		result[id] = access
	}
	return result
}

func legacyDialogAccess(group map[string]any) map[string]any {
	if group == nil || (group["suspended"] != true && group["_resolveFailedAt"] == nil) {
		return map[string]any{"state": "ok"}
	}
	state := "banned"
	code := any(nil)
	if reason := toString(group["_resolveFailedReason"]); reason != "" {
		if index := strings.IndexByte(reason, ':'); index >= 0 && index+1 < len(reason) {
			code = reason[index+1:]
			if code == "USER_NOT_PARTICIPANT" {
				state = "left"
			}
		}
	}
	return map[string]any{"state": state, "code": code, "detail": nil, "migratedTo": nil, "firstSeenAt": group["_resolveFailedAt"], "checkedAt": group["_resolveFailedAt"], "nextCheckAt": nil, "checks": 0, "accounts": []map[string]any{}, "legacy": true}
}

func dialogNullableString(value sql.NullString) any {
	if !value.Valid || strings.TrimSpace(value.String) == "" {
		return nil
	}
	return value.String
}

func dialogNullableInt(value sql.NullInt64) any {
	if !value.Valid {
		return nil
	}
	return value.Int64
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
