package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

type recoveryPlan struct {
	id        string
	group     map[string]any
	candidate engine.RecoveryDialog
	reason    string
}

func (a *App) resolveRecovery(ctx context.Context, status map[string]any, ids []string) (map[string]any, error) {
	result := map[string]any{"op": "resolve", "resolved": 0, "results": []map[string]any{}}
	a.monitorOp.Lock()
	defer a.monitorOp.Unlock()
	if a.monitor.RequireRunning() != nil {
		result["note"] = "monitor not running"
		return result, nil
	}
	index, err := a.monitor.RecoveryIndex(ctx)
	if err != nil {
		return nil, err
	}
	defer index.Close()
	cfg, err := a.config.Load(ctx)
	if err != nil {
		return nil, err
	}
	groups := map[string]map[string]any{}
	for _, group := range configuredGroupList(cfg) {
		groups[toString(group["id"])] = group
	}
	byID, byName, byUsername := map[string][]engine.RecoveryDialog{}, map[string][]engine.RecoveryDialog{}, map[string][]engine.RecoveryDialog{}
	for _, item := range index.Dialogs {
		d := item.Dialog
		byID[d.ID] = append(byID[d.ID], item)
		byName[d.Name] = append(byName[d.Name], item)
		if key := recoveryFolderName(d.Name); key != d.Name {
			byName[key] = append(byName[key], item)
		}
		if d.Username != "" {
			key := strings.ToLower(strings.TrimPrefix(d.Username, "@"))
			byUsername[key] = append(byUsername[key], item)
		}
	}
	plans := make([]recoveryPlan, 0, len(ids))
	for pos, id := range ids {
		if err := index.Err(); err != nil {
			return nil, err
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		plan := recoveryPlan{id: id, group: groups[id]}
		if plan.group != nil {
			pin := toString(plan.group["monitorAccount"])
			candidates := byID[id]
			query := id
			synthetic := strings.HasPrefix(id, "unknown:")
			if synthetic {
				query = strings.TrimPrefix(id, "unknown:")
				candidates = byUsername[strings.ToLower(strings.TrimPrefix(query, "@"))]
				if len(candidates) == 0 {
					candidates = byName[query]
				}
			}
			unique := map[string]engine.RecoveryDialog{}
			for _, candidate := range candidates {
				if pin != "" && candidate.AccountID != pin {
					continue
				}
				if _, found := unique[candidate.Dialog.ID]; !found {
					unique[candidate.Dialog.ID] = candidate
				}
			}
			switch {
			case len(unique) > 1:
				plan.reason = "ambiguous_title"
			case len(unique) == 1:
				for _, candidate := range unique {
					plan.candidate = candidate
				}
			case query == "":
				plan.reason = "empty_folder"
			default:
				if !synthetic || recoveryUsername.MatchString(query) {
					candidate, err := index.Lookup(query, pin)
					if err != nil {
						plan.reason = err.Error()
					} else {
						plan.candidate = candidate
					}
				} else {
					plan.reason = "index_miss"
				}
			}
			if plan.reason == "" {
				if err := index.Probe(plan.candidate); err != nil {
					plan.reason = err.Error()
				}
			}
		}
		plans = append(plans, plan)
		a.recoveryProgress(status, pos+1, len(ids))
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	// Network evidence belongs to this run. Collect it first, then join workers
	// once before changing the identities they may have queued or published.
	if err := index.Err(); err != nil {
		return nil, err
	}
	if err := a.beginRecoveryWrite(); err != nil {
		return nil, err
	}
	defer a.endRecoveryWrite()
	resume, err := a.stopForRecovery(ctx)
	if err != nil {
		return nil, err
	}
	a.mediaMu.Lock()
	resolved := 0
	results := []map[string]any{}
	for _, plan := range plans {
		item, applyErr := a.applyRecoveryPlan(ctx, plan)
		if applyErr != nil {
			err = applyErr
			break
		}
		if item["status"] == "resolved" {
			resolved++
		}
		results = append(results, item)
	}
	a.mediaMu.Unlock()
	a.endRecoveryWrite()
	if resume && a.ctx.Err() == nil && !a.purgePending() {
		err = errors.Join(err, a.resumeAfterRecovery())
	}
	result["resolved"], result["results"], result["total"] = resolved, results, len(ids)
	return result, err
}

func (a *App) applyRecoveryPlan(ctx context.Context, plan recoveryPlan) (map[string]any, error) {
	result := map[string]any{"id": plan.id, "status": "not_found"}
	if plan.group == nil {
		return result, nil
	}
	a.configMu.Lock()
	defer a.configMu.Unlock()
	cfg, err := a.config.Load(ctx)
	if err != nil {
		return nil, err
	}
	var group map[string]any
	for _, g := range configuredGroupList(cfg) {
		if toString(g["id"]) == plan.id {
			group = g
			break
		}
	}
	if group == nil {
		return result, nil
	}
	result["status"] = "still_unknown"
	if !reflect.DeepEqual(group, plan.group) {
		result["reason"] = "config_changed"
		return result, nil
	}
	target := plan.candidate.Dialog.ID
	if plan.reason == "" && target != plan.id {
		for _, g := range configuredGroupList(cfg) {
			if toString(g["id"]) == target {
				plan.reason = "target_conflict"
				break
			}
		}
	}
	tx, err := a.db.Writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if plan.reason == "" && target != plan.id {
		for _, table := range []string{"downloads", "queue", "tgdl_work", "tgdl_message_generations"} {
			var collision int
			query := `SELECT COUNT(*) FROM ` + table + ` a JOIN ` + table + ` b ON a.message_id=b.message_id WHERE a.group_id=? AND b.group_id=?`
			if err := tx.QueryRowContext(ctx, query, plan.id, target).Scan(&collision); err != nil {
				return nil, err
			}
			if collision > 0 {
				plan.reason = "target_conflict"
				break
			}
		}
	}
	accessChanged := false
	if plan.reason != "" {
		group["_resolveFailedAt"], group["_resolveFailedReason"] = time.Now().UnixMilli(), plan.reason
		result["reason"] = plan.reason
	} else {
		name := toString(group["name"])
		if name == "" || name == strings.TrimPrefix(plan.id, "unknown:") {
			name = plan.candidate.Dialog.Name
			group["name"] = name
		}
		group["id"], group["monitorAccount"] = target, plan.candidate.AccountID
		delete(group, "_resolveFailedAt")
		delete(group, "_resolveFailedReason")
		if target != plan.id {
			for _, table := range []string{"downloads", "queue", "tgdl_work", "tgdl_message_generations"} {
				if _, err := tx.ExecContext(ctx, `UPDATE `+table+` SET group_id=? WHERE group_id=?`, target, plan.id); err != nil {
					return nil, err
				}
			}
			for _, table := range []string{"downloads", "tgdl_work"} {
				if _, err := tx.ExecContext(ctx, `UPDATE `+table+` SET group_name=? WHERE group_id=?`, name, target); err != nil {
					return nil, err
				}
			}
			if _, err := tx.ExecContext(ctx, `UPDATE tgdl_ingest_files SET item=json_set(item,'$.GroupID',?,'$.GroupName',?) WHERE json_extract(item,'$.GroupID')=?`, target, name, plan.id); err != nil {
				return nil, err
			}
			if err := rekeyRecoveryHistory(ctx, tx, plan.id, target, name); err != nil {
				return nil, err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE queue SET meta=json_set(meta,'$.groupId',?,'$.groupName',?) WHERE group_id=? AND meta IS NOT NULL`, target, name, target); err != nil {
				return nil, err
			}
		}
		if err := reassignRecoveryWork(ctx, tx, target, plan.candidate.AccountID); err != nil {
			return nil, err
		}
		res, err := tx.ExecContext(ctx, `DELETE FROM chat_access WHERE chat_id IN (?,?)`, plan.id, target)
		if err != nil {
			return nil, err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return nil, err
		}
		accessChanged = n > 0
		result["status"], result["numericId"] = "resolved", target
	}
	if err := saveRecoveryConfig(ctx, tx, cfg); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	if accessChanged {
		ids := []string{plan.id}
		if target != plan.id {
			ids = append(ids, target)
		}
		a.hub.Broadcast(ws.Event{Type: "chat_access_changed", Flat: true, Payload: map[string]any{"ids": ids}})
	}
	return result, nil
}

func rekeyRecoveryHistory(ctx context.Context, tx *sql.Tx, oldID, newID, name string) error {
	var raw string
	err := tx.QueryRowContext(ctx, `SELECT value FROM kv WHERE key='queue_history'`).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var entries []map[string]any
	if err := json.Unmarshal([]byte(raw), &entries); err != nil {
		return err
	}
	for _, entry := range entries {
		if toString(entry["groupId"]) != oldID {
			continue
		}
		entry["groupId"], entry["groupName"] = newID, name
		if key := toString(entry["key"]); strings.HasPrefix(key, oldID+"_") {
			entry["key"] = newID + strings.TrimPrefix(key, oldID)
		}
	}
	data, err := json.Marshal(entries)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE kv SET value=?,updated_at=? WHERE key='queue_history'`, string(data), time.Now().UnixMilli())
	return err
}

var recoveryUsername = regexp.MustCompile(`^@?[A-Za-z][A-Za-z0-9_]{3,31}$`)
var recoveryInvisible = regexp.MustCompile(`[\x{00ad}\x{034f}\x{061c}\x{115f}\x{1160}\x{17b4}\x{17b5}\x{180e}\x{200b}-\x{200f}\x{202a}-\x{202e}\x{2060}-\x{206f}\x{2800}\x{3164}\x{fe00}-\x{fe0f}\x{feff}\x{ffa0}]`)
var recoveryUnderscores = regexp.MustCompile(`_+`)
var recoveryReserved = regexp.MustCompile(`(?i)^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$`)

// Match the historic on-disk folder spelling, without renaming stored files.
func recoveryFolderName(raw string) string {
	value := recoveryInvisible.ReplaceAllString(raw, "")
	value = strings.Map(func(r rune) rune {
		if r < 32 || unicode.IsSpace(r) && r != '\u0085' || strings.ContainsRune(`<>:"/\|?*`, r) {
			return '_'
		}
		return r
	}, value)
	value = strings.Trim(recoveryUnderscores.ReplaceAllString(value, "_"), "_")
	if value == "" {
		if raw == "" || !recoveryInvisible.MatchString(raw) {
			return "_unnamed"
		}
		var hash uint32
		for _, r := range utf16.Encode([]rune(raw)) {
			hash = hash*31 + uint32(r)
		}
		return "_unnamed_" + strconv.FormatUint(uint64(hash), 36)
	}
	if recoveryReserved.MatchString(value) {
		value = "_" + value
	}
	if len(value) > 80 {
		value = value[:80]
		for !utf8.ValidString(value) {
			value = value[:len(value)-1]
		}
	}
	return value
}

func jsTruthy(value any) bool {
	switch value := value.(type) {
	case nil:
		return false
	case bool:
		return value
	case string:
		return value != ""
	case float64:
		return value != 0
	case int:
		return value != 0
	case int64:
		return value != 0
	}
	return true
}
func jsString(value any) string {
	if value == nil {
		return "null"
	}
	return fmt.Sprint(value)
}
