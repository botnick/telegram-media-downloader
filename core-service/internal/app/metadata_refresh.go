package app

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image/jpeg"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

type metadataUpdate struct {
	target        metadataTarget
	account, name string
	photo         []byte
	hasPhoto      bool
	result        map[string]any
}

type metadataTarget struct {
	id          string
	raw         any
	configured  bool
	pin, owner  string
	username    string
	suspended   bool
	accessState string
}

func (a *App) metadataTargets(ctx context.Context, photos bool) ([]metadataTarget, error) {
	cfg, err := a.config.Load(ctx)
	if err != nil {
		return nil, err
	}
	targets := []metadataTarget{}
	seen := map[string]bool{}
	for _, group := range configuredGroupList(cfg) {
		id := strings.TrimSpace(toString(group["id"]))
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		targets = append(targets, metadataTarget{id: id, raw: group["id"], configured: true, pin: toString(group["monitorAccount"]), owner: toString(group["ownerPeerId"]), username: toString(group["username"]), suspended: group["suspended"] == true, accessState: toString(legacyDialogAccess(group)["state"])})
	}
	if photos {
		return targets, nil
	}
	rows, err := a.db.Reader.QueryContext(ctx, `SELECT DISTINCT group_id FROM downloads WHERE group_id IS NOT NULL AND group_id<>'' ORDER BY group_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		if !seen[id] {
			seen[id] = true
			targets = append(targets, metadataTarget{id: id, raw: id})
		}
	}
	return targets, rows.Err()
}

// Resolve aliases once, rejecting unsigned IDs that name different peer types.
func metadataCandidates(index *engine.RecoveryIndex) map[string][]engine.RecoveryDialog {
	out := map[string][]engine.RecoveryDialog{}
	for _, d := range index.Dialogs {
		out[d.Dialog.ID] = append(out[d.Dialog.ID], d)
		if id, err := strconv.ParseInt(d.Dialog.ID, 10, 64); err == nil && id < 0 {
			raw := -id
			if id < -1000000000000 {
				raw = -1000000000000 - id
			}
			key := strconv.FormatInt(raw, 10)
			out[key] = append(out[key], d)
		}
	}
	return out
}

func metadataCandidate(items []engine.RecoveryDialog, pin string) (engine.RecoveryDialog, bool, error) {
	var selected engine.RecoveryDialog
	found := false
	for _, candidate := range items {
		if pin != "" && candidate.AccountID != pin {
			continue
		}
		if found && selected.Dialog.ID != candidate.Dialog.ID {
			return selected, false, errors.New("ambiguous historical group id; resolve the group before refreshing")
		}
		if !found {
			selected = candidate
			found = true
		}
	}
	if !found && len(items) > 0 && pin != "" {
		return selected, false, fmt.Errorf("pinned account %s has no matching dialog", pin)
	}
	return selected, found, nil
}

type photoBuffer struct{ bytes.Buffer }

func (b *photoBuffer) Write(p []byte) (int, error) {
	if len(p) > (2<<20)-b.Len() {
		return 0, errors.New("Telegram profile photo exceeds 2 MiB")
	}
	return b.Buffer.Write(p)
}

func (a *App) refreshTelegramGroups(ctx context.Context, photos bool, epoch uint64, progress func(map[string]any)) (map[string]any, error) {
	targets, err := a.metadataTargets(ctx, photos)
	if err != nil {
		return nil, err
	}
	a.monitorOp.Lock()
	err = a.checkURLPurge(epoch)
	if err == nil {
		err = a.startTelegramEngine(ctx, false)
	}
	var index *engine.RecoveryIndex
	if err == nil {
		index, err = a.monitor.OpenRecoveryIndex(ctx)
	}
	a.monitorOp.Unlock()
	defer a.startHistoryDrain(false)
	if err != nil {
		return nil, err
	}
	defer index.Close()
	ctx = index.Context()
	if err = index.Load(); err != nil {
		return nil, err
	}
	candidates := metadataCandidates(index)
	updates := []any{}
	results := []any{}
	updated := 0
	stage := "resolving"
	if photos {
		stage = "downloading"
	}
	report := func(n int) {
		p := map[string]any{"processed": n, "total": len(targets), "stage": stage}
		if !photos {
			p["updated"] = updated
		}
		progress(p)
	}
	pending := []metadataUpdate{}
	pendingBytes := 0
	flush := func() error {
		if len(pending) == 0 {
			return nil
		}
		accepted, e := a.applyMetadataBatch(ctx, pending, photos, epoch)
		if e != nil {
			return e
		}
		for n, item := range pending {
			if !accepted[n] {
				continue
			}
			if item.name != "" && !photos {
				updated++
				updates = append(updates, map[string]any{"id": item.target.id, "name": item.name})
			}
			if item.hasPhoto && item.result != nil {
				item.result["url"] = "/photos/" + item.target.id + ".jpg"
			}
		}
		pending = nil
		pendingBytes = 0
		return nil
	}
	report(0)
	access, err := a.readDialogAccess(ctx)
	if err != nil {
		return nil, err
	}
	for n, target := range targets {
		if err = index.Err(); err != nil {
			return nil, err
		}
		state := target.accessState
		if current := access[target.id]; current != nil {
			state = toString(current["state"])
		}
		blocked := blockingChatState(state) || target.suspended
		if target.owner != "" && target.owner != "local" {
			var raw string
			if err = a.db.Reader.QueryRowContext(ctx, `SELECT value FROM kv WHERE key='peer_id'`).Scan(&raw); err != nil && !errors.Is(err, sql.ErrNoRows) {
				return nil, err
			}
			var self string
			if raw != "" {
				if err = json.Unmarshal([]byte(raw), &self); err != nil {
					return nil, err
				}
			}
			blocked = blocked || self != target.owner
		}
		var candidate engine.RecoveryDialog
		found := false
		if !blocked {
			var e error
			candidate, found, e = metadataCandidate(candidates[target.id], target.pin)
			if e != nil {
				return nil, e
			}
			if !found && target.username != "" {
				candidate, e = index.Lookup("@"+strings.TrimPrefix(target.username, "@"), target.pin)
				if e != nil {
					return nil, e
				}
				matches := candidate.Dialog.ID == target.id
				if id, e := strconv.ParseInt(candidate.Dialog.ID, 10, 64); e == nil && id < -1000000000000 {
					matches = matches || strconv.FormatInt(-1000000000000-id, 10) == target.id
				}
				if !matches {
					return nil, errors.New("resolved username no longer matches configured group")
				}
				found = true
			}
		}
		photoResult := map[string]any{"id": target.raw, "url": nil}
		if found && !blocked {
			if blockingChatState(toString(access[candidate.Dialog.ID]["state"])) {
				found = false
			}
		}
		if found && !blocked {
			buffer := new(photoBuffer)
			hasPhoto, e := index.Photo(candidate, buffer)
			if e != nil {
				return nil, fmt.Errorf("refresh %s photo: %w", target.id, e)
			}
			if hasPhoto {
				cfg, e := jpeg.DecodeConfig(bytes.NewReader(buffer.Bytes()))
				if e != nil || cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > 4096 || cfg.Height > 4096 {
					return nil, fmt.Errorf("invalid Telegram profile photo for %s", target.id)
				}
				if _, e = jpeg.Decode(bytes.NewReader(buffer.Bytes())); e != nil {
					return nil, e
				}
			} else if buffer.Len() != 0 {
				return nil, errors.New("photo transport returned bytes without a photo")
			}
			name := candidate.Dialog.Name
			if name == candidate.Dialog.ID {
				name = ""
			}
			if len(pending) >= 64 || pendingBytes+buffer.Len() > 8<<20 {
				if err = flush(); err != nil {
					return nil, err
				}
			}
			pending = append(pending, metadataUpdate{target: target, account: candidate.AccountID, name: name, photo: buffer.Bytes(), hasPhoto: hasPhoto, result: photoResult})
			pendingBytes += buffer.Len()
		} else if photos {
			photoResult["url"] = a.cachedMetadataPhoto(target.id)
		}
		if photos {
			results = append(results, photoResult)
		}
		report(n + 1)
	}
	if err = flush(); err != nil {
		return nil, err
	}
	report(len(targets))
	if photos {
		return map[string]any{"results": results}, nil
	}
	if len(updates) > 0 {
		a.hub.Broadcast(ws.Event{Type: "groups_refreshed", Flat: true, Payload: map[string]any{"updates": updates}})
	}
	return map[string]any{"scanned": len(targets), "updated": updated, "updates": updates}, nil
}

func (a *App) cachedMetadataPhoto(id string) any {
	if !chatIDPattern.MatchString(id) {
		return nil
	}
	f, err := openMedia(filepath.Join(a.dataDir, "photos"), id+".jpg")
	if err != nil {
		return nil
	}
	defer f.Close()
	if st, e := f.Stat(); e == nil && st.Mode().IsRegular() && st.Size() > 0 {
		return "/photos/" + id + ".jpg"
	}
	return nil
}

// A bounded batch amortizes config decoding and commits names together. RPCs
// run outside these locks; user edits are reread and merged at each commit.
func (a *App) applyMetadataBatch(ctx context.Context, items []metadataUpdate, photosOnly bool, epoch uint64) ([]bool, error) {
	a.mediaMu.RLock()
	defer a.mediaMu.RUnlock()
	if err := a.mediaWritable(ctx); err != nil {
		return nil, err
	}
	if err := a.checkURLPurge(epoch); err != nil {
		return nil, err
	}
	a.configMu.Lock()
	defer a.configMu.Unlock()
	cfg, err := a.config.Load(ctx)
	if err != nil {
		return nil, err
	}
	groups := map[string]map[string]any{}
	for _, g := range configuredGroupList(cfg) {
		groups[toString(g["id"])] = g
	}
	accepted := make([]bool, len(items))
	for n, item := range items {
		target := item.target
		group := groups[target.id]
		if group == nil && target.configured {
			continue
		}
		if group != nil {
			pin, owner := toString(group["monitorAccount"]), toString(group["ownerPeerId"])
			if (pin != "" && pin != item.account) || owner != target.owner || group["suspended"] == true {
				continue
			}
		} else {
			var exists bool
			if err = a.db.Reader.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM downloads WHERE group_id=?)`, target.id).Scan(&exists); err != nil {
				return nil, err
			}
			if !exists {
				continue
			}
		}
		accepted[n] = true
	}
	if !photosOnly {
		tx, err := a.db.Writer.BeginTx(ctx, nil)
		if err != nil {
			return nil, err
		}
		defer tx.Rollback()
		stmt, err := tx.PrepareContext(ctx, `UPDATE downloads SET group_name=? WHERE group_id=? AND (group_name IS NULL OR group_name='' OR group_name='Unknown' OR group_name=?)`)
		if err != nil {
			return nil, err
		}
		defer stmt.Close()
		mutated := false
		for n, item := range items {
			if !accepted[n] || item.name == "" {
				continue
			}
			if _, err = stmt.ExecContext(ctx, item.name, item.target.id, item.target.id); err != nil {
				return nil, err
			}
			group := groups[item.target.id]
			old := toString(group["name"])
			if group != nil && (old == "" || old == "Unknown" || old == item.target.id || strings.HasPrefix(old, "Group ")) {
				group["name"] = item.name
				mutated = true
			}
		}
		if mutated {
			data, e := json.Marshal(cfg)
			if e != nil {
				return nil, e
			}
			if _, err = tx.ExecContext(ctx, `UPDATE kv SET value=?,updated_at=? WHERE key='config'`, string(data), time.Now().UnixMilli()); err != nil {
				return nil, err
			}
		}
		if err = tx.Commit(); err != nil {
			return nil, err
		}
		if mutated {
			a.hub.Broadcast(ws.Event{Type: "config_updated", Flat: true})
		}
	}
	for n, item := range items {
		if !accepted[n] {
			continue
		}
		if err = a.publishMetadataPhoto(ctx, item.target.id, item.photo, item.hasPhoto); err != nil {
			return nil, err
		}
	}
	return accepted, nil
}

func (a *App) publishMetadataPhoto(ctx context.Context, id string, data []byte, exists bool) error {
	if !chatIDPattern.MatchString(id) {
		return errors.New("invalid profile photo group id")
	}
	root, err := os.OpenRoot(a.dataDir)
	if err != nil {
		return err
	}
	defer root.Close()
	if err = root.MkdirAll("photos", 0755); err != nil {
		return err
	}
	dir, err := root.OpenRoot("photos")
	if err != nil {
		return err
	}
	defer dir.Close()
	name := id + ".jpg"
	if err = ctx.Err(); err != nil {
		return err
	}
	if !exists {
		err = dir.Remove(name)
		if os.IsNotExist(err) {
			err = nil
		}
		return err
	}
	random := make([]byte, 12)
	if _, err = rand.Read(random); err != nil {
		return err
	}
	tmp := ".photo-" + hex.EncodeToString(random) + ".tmp"
	f, err := dir.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil {
		return err
	}
	defer dir.Remove(tmp)
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	err = errors.Join(err, f.Close())
	if err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	return dir.Rename(tmp, name)
}
