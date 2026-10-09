package telegram

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/gotd/td/tg"
)

type Dialog struct {
	peer       tg.InputPeerClass
	photo      *peerPhoto
	photoKnown bool
	ID         string
	Name       string
	Username   string
	Type       string
	Archived   bool
	Members    *int
	Access     DialogAccess
}

// DialogAccess contains evidence supplied by Telegram, not a guess based on a
// missing title, an absent dialog, or a failed network request.
type DialogAccess struct {
	State      string `json:"state"`
	Code       string `json:"code,omitempty"`
	Detail     string `json:"detail,omitempty"`
	MigratedTo string `json:"migratedTo,omitempty"`
}

func restrictionAccess(reasons []tg.RestrictionReason) DialogAccess {
	for _, reason := range reasons {
		// A platform-only restriction does not prove that the native downloader
		// cannot read the chat. Global Telegram restrictions apply here.
		if reason.Platform == "all" {
			return DialogAccess{State: "restricted", Code: reason.Reason, Detail: reason.Text}
		}
	}
	return DialogAccess{State: "ok"}
}

// Recovery must distinguish an absent peer from one beyond the UI's limit.
func (a *Account) RecoveryDialogs(ctx context.Context, archived bool) ([]Dialog, error) {
	folder := 0
	if archived {
		folder = 1
	}
	return fetchDialogPages(ctx, a.API(), -1, folder, func(ctx context.Context, chats []tg.ChatClass, users []tg.UserClass) error {
		return a.state.cacheStoryPeers(ctx, a.selfID, chats, users)
	})
}

type dialogsAPI interface {
	MessagesGetDialogs(context.Context, *tg.MessagesGetDialogsRequest) (tg.MessagesDialogsClass, error)
}

func (a *Account) Dialogs(ctx context.Context, limit int, archived bool) ([]Dialog, error) {
	if limit != -1 && (limit <= 0 || limit > 1000) {
		limit = 500
	}
	folder := 0
	if archived {
		folder = 1
	}
	return fetchDialogPages(ctx, a.API(), limit, folder, func(ctx context.Context, chats []tg.ChatClass, users []tg.UserClass) error {
		return a.state.cacheStoryPeers(ctx, a.selfID, chats, users)
	})
}

func fetchDialogs(ctx context.Context, api dialogsAPI, limit, folder int) ([]Dialog, error) {
	return fetchDialogPages(ctx, api, limit, folder, nil)
}

// The requested limit is a total, not an RPC page size. Telegram can return a
// slice even when fewer than the requested number of dialogs fit in the page.
// Never interpret a partial or malformed page as a complete recovery index.
func fetchDialogPages(ctx context.Context, api dialogsAPI, limit, folder int, observe func(context.Context, []tg.ChatClass, []tg.UserClass) error) ([]Dialog, error) {
	if limit != -1 && (limit <= 0 || limit > 1000) {
		limit = 500
	}
	req := tg.MessagesGetDialogsRequest{OffsetPeer: &tg.InputPeerEmpty{}}
	// folder_id=0 needs its presence flag too, otherwise both folders are read.
	req.SetFolderID(folder)
	out := make([]Dialog, 0, 100)
	seen := make(map[string]bool)
	cursors := make(map[string]bool)
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		req.Limit = 100
		if limit > 0 {
			req.Limit = min(100, limit-len(out))
		}
		callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		result, err := api.MessagesGetDialogs(callCtx, &req)
		cancel()
		if err != nil {
			return nil, err
		}
		var rawDialogs []tg.DialogClass
		var chats []tg.ChatClass
		var users []tg.UserClass
		var messages []tg.MessageClass
		complete := false
		switch result := result.(type) {
		case *tg.MessagesDialogs:
			rawDialogs, chats, users, messages = result.Dialogs, result.Chats, result.Users, result.Messages
			complete = true
		case *tg.MessagesDialogsSlice:
			rawDialogs, chats, users, messages = result.Dialogs, result.Chats, result.Users, result.Messages
		default:
			return nil, fmt.Errorf("unexpected Telegram dialogs response %T", result)
		}
		if observe != nil {
			if err := observe(ctx, chats, users); err != nil {
				return nil, err
			}
		}
		for _, item := range mapDialogPage(rawDialogs, chats, users) {
			if !seen[item.ID] {
				seen[item.ID] = true
				out = append(out, item)
				if len(out) > 100000 {
					return nil, errors.New("Telegram recovery dialog index exceeded safety bound")
				}
				if len(out) == limit {
					break
				}
			}
		}
		if complete || len(rawDialogs) == 0 || limit > 0 && len(out) >= limit {
			sort.SliceStable(out, func(i, j int) bool { return out[i].ID < out[j].ID })
			return out, nil
		}
		var last *tg.Dialog
		for i := len(rawDialogs) - 1; i >= 0; i-- {
			if dialog, ok := rawDialogs[i].(*tg.Dialog); ok && dialog.Peer != nil && !dialog.Pinned {
				last = dialog
				break
			}
		}
		if last == nil {
			// Pinned entries don't define chronological pagination. An initial
			// page containing only pinned entries must be followed by a first
			// unpinned page, with the empty offset preserved.
			if req.ExcludePinned {
				return nil, errors.New("Telegram dialogs page has no usable cursor")
			}
			req.SetExcludePinned(true)
			continue
		}
		date := 0
		for _, raw := range messages {
			if message, ok := raw.AsNotEmpty(); ok && message.GetID() == last.TopMessage && samePeer(message.GetPeerID(), last.Peer) {
				date = message.GetDate()
				break
			}
		}
		if date == 0 || last.TopMessage == 0 {
			return nil, errors.New("Telegram dialogs page is missing its last message")
		}
		peer, err := dialogOffsetPeer(last.Peer, chats, users)
		if err != nil {
			return nil, err
		}
		cursor := fmt.Sprintf("%T:%v:%d:%d", last.Peer, last.Peer, last.TopMessage, date)
		if cursors[cursor] {
			return nil, errors.New("Telegram dialogs pagination did not advance")
		}
		cursors[cursor] = true
		req.OffsetID, req.OffsetDate, req.OffsetPeer = last.TopMessage, date, peer
		req.SetExcludePinned(true)
	}
}

func dialogOffsetPeer(peer tg.PeerClass, chats []tg.ChatClass, users []tg.UserClass) (tg.InputPeerClass, error) {
	switch peer := peer.(type) {
	case *tg.PeerChat:
		return &tg.InputPeerChat{ChatID: peer.ChatID}, nil
	case *tg.PeerChannel:
		for _, raw := range chats {
			switch channel := raw.(type) {
			case *tg.Channel:
				if channel.ID == peer.ChannelID && !channel.Min && channel.AccessHash != 0 {
					return &tg.InputPeerChannel{ChannelID: channel.ID, AccessHash: channel.AccessHash}, nil
				}
			case *tg.ChannelForbidden:
				if channel.ID == peer.ChannelID && channel.AccessHash != 0 {
					return &tg.InputPeerChannel{ChannelID: channel.ID, AccessHash: channel.AccessHash}, nil
				}
			}
		}
	case *tg.PeerUser:
		for _, raw := range users {
			if user, ok := raw.(*tg.User); ok && user.ID == peer.UserID {
				if user.Self {
					return &tg.InputPeerSelf{}, nil
				}
				if !user.Min && (user.AccessHash != 0 || user.Deleted) {
					return &tg.InputPeerUser{UserID: user.ID, AccessHash: user.AccessHash}, nil
				}
			}
		}
	}
	return nil, fmt.Errorf("Telegram dialogs cursor has no reusable access hash for %T", peer)
}

func mapDialogPage(rawDialogs []tg.DialogClass, chats []tg.ChatClass, users []tg.UserClass) []Dialog {
	chatByID := map[int64]tg.ChatClass{}
	channelByID := map[int64]tg.ChatClass{}
	for _, chat := range chats {
		switch chat := chat.(type) {
		case *tg.Chat:
			chatByID[chat.ID] = chat
		case *tg.Channel:
			channelByID[chat.ID] = chat
		case *tg.ChatForbidden:
			chatByID[chat.ID] = chat
		case *tg.ChannelForbidden:
			channelByID[chat.ID] = chat
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
		item := Dialog{Archived: hasFolder && folderID != 0, Access: DialogAccess{State: "unknown"}}
		switch peer := dialog.Peer.(type) {
		case *tg.PeerChannel:
			// Keep the same marked peer ID used by Telegram clients and the
			// downloader's persisted group IDs (see attachment.go).
			item.ID = fmt.Sprintf("%d", -1000000000000-peer.ChannelID)
			item.Type = "channel"
			if channel, ok := channelByID[peer.ChannelID].(*tg.Channel); ok {
				item.Access = DialogAccess{State: "ok"}
				if channel.Megagroup {
					item.Type = "supergroup"
				}
				switch {
				case channel.Min:
					item.Access.State = "unknown"
				case channel.BannedRights.ViewMessages:
					item.Access = DialogAccess{State: "banned", Code: "VIEW_MESSAGES_FORBIDDEN"}
				case channel.Restricted:
					item.Access = restrictionAccess(channel.RestrictionReason)
				case channel.Left:
					item.Access = DialogAccess{State: "left", Code: "CHANNEL_LEFT"}
				}
				if item.Access.State == "ok" && channel.Left {
					item.Access = DialogAccess{State: "left", Code: "CHANNEL_LEFT"}
				}
				item.photo, item.photoKnown = chatPhoto(channel.Photo)
				item.Name = channel.Title
				item.Username = channel.Username
				if channel.ParticipantsCount > 0 {
					members := channel.ParticipantsCount
					item.Members = &members
				}
			}
			if channel, ok := channelByID[peer.ChannelID].(*tg.ChannelForbidden); ok {
				item.Name = channel.Title
				if channel.Megagroup {
					item.Type = "supergroup"
				}
				item.Access = DialogAccess{State: "inaccessible", Code: "CHANNEL_FORBIDDEN"}
			}
		case *tg.PeerChat:
			item.ID = fmt.Sprintf("-%d", peer.ChatID)
			item.Type = "group"
			if chat, ok := chatByID[peer.ChatID].(*tg.Chat); ok {
				item.Access = DialogAccess{State: "ok"}
				if migrated, ok := chat.MigratedTo.(*tg.InputChannel); ok && migrated.ChannelID > 0 {
					item.Access = DialogAccess{State: "migrated", Code: "CHAT_MIGRATED", MigratedTo: fmt.Sprintf("%d", -1000000000000-migrated.ChannelID)}
				} else if chat.Deactivated {
					item.Access = DialogAccess{State: "migrated", Code: "CHAT_MIGRATED"}
				} else if chat.Left {
					item.Access = DialogAccess{State: "left", Code: "CHAT_LEFT"}
				}
				item.photo, item.photoKnown = chatPhoto(chat.Photo)
				item.Name = chat.Title
				if chat.ParticipantsCount > 0 {
					members := chat.ParticipantsCount
					item.Members = &members
				}
			}
			if chat, ok := chatByID[peer.ChatID].(*tg.ChatForbidden); ok {
				item.Name = chat.Title
				item.Access = DialogAccess{State: "inaccessible", Code: "CHAT_FORBIDDEN"}
			}
		case *tg.PeerUser:
			item.ID = fmt.Sprint(peer.UserID)
			item.Type = "user"
			if user := userByID[peer.UserID]; user != nil {
				item.Access = DialogAccess{State: "ok"}
				switch {
				case user.Deleted:
					item.Access = DialogAccess{State: "deleted", Code: "USER_DELETED"}
				case user.Min:
					item.Access.State = "unknown"
				case user.Restricted:
					item.Access = restrictionAccess(user.RestrictionReason)
				}
				item.photoKnown = !user.Min
				switch p := user.Photo.(type) {
				case *tg.UserProfilePhoto:
					item.photo, item.photoKnown = &peerPhoto{ID: p.PhotoID, DC: p.DCID}, true
				case *tg.UserProfilePhotoEmpty:
					item.photoKnown = true
				}
				item.Name = strings.TrimSpace(user.FirstName + " " + user.LastName)
				if item.Name == "" && user.Deleted {
					item.Name = "Deleted account"
				}
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
		item.peer, _ = dialogOffsetPeer(dialog.Peer, chats, users)
		if item.peer == nil && item.Access.State == "deleted" {
			if peer, ok := dialog.Peer.(*tg.PeerUser); ok {
				item.peer = &tg.InputPeerUser{UserID: peer.UserID, AccessHash: userByID[peer.UserID].AccessHash}
			}
		}
		out = append(out, item)
	}
	return out
}
