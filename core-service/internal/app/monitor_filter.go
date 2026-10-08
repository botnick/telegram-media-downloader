package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/tg"
)

func (a *App) monitorFilter(ctx context.Context, accountID string, message *tg.Message, updates tg.UpdatesClass) (engine.Target, bool, error) {
	cfg, err := a.config.Load(ctx)
	if err != nil {
		return engine.Target{}, false, err
	}
	media, err := telegram.MessageAttachment(message)
	if err != nil {
		return engine.Target{}, false, err
	}
	var rawID string
	switch peer := message.PeerID.(type) {
	case *tg.PeerChannel:
		rawID = strconv.FormatInt(peer.ChannelID, 10)
	case *tg.PeerChat:
		rawID = strconv.FormatInt(peer.ChatID, 10)
	case *tg.PeerUser:
		rawID = strconv.FormatInt(peer.UserID, 10)
	}
	groups, _ := cfg["groups"].([]any)
	var group map[string]any
	// Prefer an exact marked ID over historical unsigned IDs.
	for _, raw := range groups {
		g, ok := raw.(map[string]any)
		if ok && toString(g["id"]) == media.GroupID {
			group = g
			break
		}
	}
	if group == nil {
		for _, raw := range groups {
			g, ok := raw.(map[string]any)
			if ok && toString(g["id"]) == rawID {
				group = g
				break
			}
		}
	}
	if group == nil || group["enabled"] != true {
		return engine.Target{}, false, nil
	}
	if peer := toString(group["ownerPeerId"]); peer != "" && peer != "local" {
		var raw string
		err := a.db.Reader.QueryRowContext(ctx, `SELECT value FROM kv WHERE key='peer_id'`).Scan(&raw)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return engine.Target{}, false, err
		}
		var self string
		if err == nil {
			if err = json.Unmarshal([]byte(raw), &self); err != nil {
				return engine.Target{}, false, err
			}
		}
		if self != peer {
			return engine.Target{}, false, nil
		}
	}
	filters, _ := group["filters"].(map[string]any)
	key := map[string]string{"photo": "photos", "video": "videos", "audio": "audio", "document": "documents", "sticker": "stickers", "gif": "gifs"}[media.Type]
	if filters[key] == false || (media.Type == "sticker" && filters[key] != true) {
		return engine.Target{}, false, nil
	}
	users, _ := group["trackUsers"].(map[string]any)
	if users["enabled"] == true && users["mode"] != "all" {
		sender := ""
		if peer, ok := message.FromID.(*tg.PeerUser); ok {
			sender = strconv.FormatInt(peer.UserID, 10)
		}
		username := ""
		var entities []tg.UserClass
		switch u := updates.(type) {
		case *tg.Updates:
			entities = u.Users
		case *tg.UpdatesCombined:
			entities = u.Users
		}
		for _, entity := range entities {
			if user, ok := entity.(*tg.User); ok && strconv.FormatInt(user.ID, 10) == sender {
				username = user.Username
				break
			}
		}
		tracked := false
		for _, value := range []any{users["users"], cfg["globalTrackedUsers"]} {
			list, _ := value.([]any)
			for _, raw := range list {
				if u, ok := raw.(map[string]any); ok {
					if sender != "" && toString(u["id"]) == sender || username != "" && strings.EqualFold(strings.TrimPrefix(toString(u["username"]), "@"), username) {
						tracked = true
					}
				}
			}
		}
		if users["mode"] == "whitelist" && !tracked || users["mode"] == "blacklist" && tracked {
			return engine.Target{}, false, nil
		}
	}
	topics, _ := group["topics"].(map[string]any)
	if reply, ok := message.ReplyTo.(*tg.MessageReplyHeader); ok && reply.ForumTopic && topics["enabled"] == true {
		topic := reply.ReplyToMsgID
		if reply.ReplyToTopID != 0 {
			topic = reply.ReplyToTopID
		}
		listed := false
		ids, _ := topics["ids"].([]any)
		for _, id := range ids {
			if int(number(id, 0)) == topic {
				listed = true
				break
			}
		}
		if topics["mode"] == "whitelist" && !listed || topics["mode"] == "blacklist" && listed {
			return engine.Target{}, false, nil
		}
	}
	return engine.Target{ID: toString(group["id"]), Name: toString(group["name"])}, true, nil
}
