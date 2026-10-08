package telegram

import (
	"context"
	"errors"
	"fmt"

	"github.com/gotd/td/tg"
)

type messageAPI interface {
	ChannelsGetMessages(context.Context, *tg.ChannelsGetMessagesRequest) (tg.MessagesMessagesClass, error)
	MessagesGetMessages(context.Context, []tg.InputMessageClass) (tg.MessagesMessagesClass, error)
}

type RefreshedMessage struct {
	Message  *tg.Message
	Entities *tg.Updates
	PTS      int
	Dialog   *Dialog
}

func (a *Account) RefreshMessage(ctx context.Context, message *tg.Message) (*RefreshedMessage, error) {
	return refreshMessage(ctx, a.API(), a.state, a.selfID, message)
}

func refreshMessage(ctx context.Context, api messageAPI, state *UpdateState, userID int64, message *tg.Message) (*RefreshedMessage, error) {
	ids := []tg.InputMessageClass{&tg.InputMessageID{ID: message.ID}}
	var result tg.MessagesMessagesClass
	var err error
	if peer, ok := message.PeerID.(*tg.PeerChannel); ok {
		hash, found, e := state.GetChannelAccessHash(ctx, userID, peer.ChannelID)
		if e != nil {
			return nil, e
		}
		if !found {
			return nil, fmt.Errorf("channel %d access hash is missing", peer.ChannelID)
		}
		result, err = api.ChannelsGetMessages(ctx, &tg.ChannelsGetMessagesRequest{Channel: &tg.InputChannel{ChannelID: peer.ChannelID, AccessHash: hash}, ID: ids})
	} else {
		result, err = api.MessagesGetMessages(ctx, ids)
	}
	if err != nil {
		return nil, err
	}
	var messages []tg.MessageClass
	entities := &tg.Updates{}
	switch r := result.(type) {
	case *tg.MessagesMessages:
		messages = r.Messages
		entities.Users, entities.Chats = r.Users, r.Chats
	case *tg.MessagesMessagesSlice:
		messages = r.Messages
		entities.Users, entities.Chats = r.Users, r.Chats
	case *tg.MessagesChannelMessages:
		messages = r.Messages
		entities.Users, entities.Chats = r.Users, r.Chats
	default:
		return nil, fmt.Errorf("unexpected message refresh result %T", result)
	}
	for _, raw := range messages {
		if fresh, ok := raw.(*tg.Message); ok && fresh.ID == message.ID {
			if !samePeer(fresh.PeerID, message.PeerID) {
				return nil, errors.New("message refresh returned another peer")
			}
			return &RefreshedMessage{Message: fresh, Entities: entities}, nil
		}
	}
	return nil, errors.New("queued Telegram message is no longer available")
}

func samePeer(a, b tg.PeerClass) bool {
	switch a := a.(type) {
	case *tg.PeerChannel:
		b, ok := b.(*tg.PeerChannel)
		return ok && a.ChannelID == b.ChannelID
	case *tg.PeerChat:
		b, ok := b.(*tg.PeerChat)
		return ok && a.ChatID == b.ChatID
	case *tg.PeerUser:
		b, ok := b.(*tg.PeerUser)
		return ok && a.UserID == b.UserID
	}
	return false
}
