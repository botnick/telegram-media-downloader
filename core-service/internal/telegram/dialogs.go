package telegram

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/gotd/td/tg"
)

type Dialog struct {
	ID       string
	Name     string
	Username string
	Type     string
	Archived bool
	Members  *int
}

type dialogsAPI interface {
	MessagesGetDialogs(context.Context, *tg.MessagesGetDialogsRequest) (tg.MessagesDialogsClass, error)
}

func (a *Account) Dialogs(ctx context.Context, limit int, archived bool) ([]Dialog, error) {
	if limit <= 0 || limit > 1000 {
		limit = 500
	}
	folder := 0
	if archived {
		folder = 1
	}
	return fetchDialogs(ctx, a.API(), limit, folder)
}

func fetchDialogs(ctx context.Context, api dialogsAPI, limit, folder int) ([]Dialog, error) {
	result, err := api.MessagesGetDialogs(ctx, &tg.MessagesGetDialogsRequest{FolderID: folder, Limit: limit, OffsetPeer: &tg.InputPeerEmpty{}})
	if err != nil {
		return nil, err
	}
	var rawDialogs []tg.DialogClass
	var chats []tg.ChatClass
	var users []tg.UserClass
	switch result := result.(type) {
	case *tg.MessagesDialogs:
		rawDialogs, chats, users = result.Dialogs, result.Chats, result.Users
	case *tg.MessagesDialogsSlice:
		rawDialogs, chats, users = result.Dialogs, result.Chats, result.Users
	default:
		return nil, fmt.Errorf("unexpected Telegram dialogs response %T", result)
	}
	chatByID := map[int64]tg.ChatClass{}
	for _, chat := range chats {
		switch chat := chat.(type) {
		case *tg.Chat:
			chatByID[chat.ID] = chat
		case *tg.Channel:
			chatByID[chat.ID] = chat
		}
	}
	userByID := map[int64]*tg.User{}
	for _, raw := range users {
		if user, ok := raw.(*tg.User); ok {
			userByID[user.ID] = user
		}
	}
	out := make([]Dialog, 0, len(rawDialogs))
	for _, raw := range rawDialogs {
		dialog, ok := raw.(*tg.Dialog)
		if !ok || dialog.Peer == nil {
			continue
		}
		folderID, hasFolder := dialog.GetFolderID()
		item := Dialog{Archived: hasFolder && folderID != 0}
		switch peer := dialog.Peer.(type) {
		case *tg.PeerChannel:
			// Keep the same marked peer ID used by Telegram clients and the
			// downloader's persisted group IDs (see attachment.go).
			item.ID = fmt.Sprintf("%d", -1000000000000-peer.ChannelID)
			item.Type = "channel"
			if channel, ok := chatByID[peer.ChannelID].(*tg.Channel); ok {
				item.Name = channel.Title
				item.Username = channel.Username
				if channel.ParticipantsCount > 0 {
					members := channel.ParticipantsCount
					item.Members = &members
				}
			}
		case *tg.PeerChat:
			item.ID = fmt.Sprintf("-%d", peer.ChatID)
			item.Type = "group"
			if chat, ok := chatByID[peer.ChatID].(*tg.Chat); ok {
				item.Name = chat.Title
				if chat.ParticipantsCount > 0 {
					members := chat.ParticipantsCount
					item.Members = &members
				}
			}
		case *tg.PeerUser:
			item.ID = fmt.Sprint(peer.UserID)
			item.Type = "user"
			if user := userByID[peer.UserID]; user != nil {
				item.Name = strings.TrimSpace(user.FirstName + " " + user.LastName)
				item.Username = user.Username
				if user.Bot {
					item.Type = "bot"
				}
			}
		default:
			continue
		}
		if item.Name == "" {
			item.Name = item.ID
		}
		out = append(out, item)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}
