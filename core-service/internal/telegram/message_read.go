package telegram

import (
	"context"
	"errors"

	"github.com/gotd/td/tg"
)

func (a *Account) ReadMessage(ctx context.Context, dialog Dialog, id int) (*RefreshedMessage, error) {
	return readMessage(ctx, a.API(), dialog, id)
}

func readMessage(ctx context.Context, api messageAPI, dialog Dialog, id int) (*RefreshedMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if id <= 0 || int64(id) > 2147483647 {
		return nil, errors.New("invalid Telegram message id")
	}
	var peer tg.PeerClass
	switch p := dialog.peer.(type) {
	case *tg.InputPeerChannel:
		peer = &tg.PeerChannel{ChannelID: p.ChannelID}
	case *tg.InputPeerChat:
		peer = &tg.PeerChat{ChatID: p.ChatID}
	case *tg.InputPeerUser:
		peer = &tg.PeerUser{UserID: p.UserID}
	default:
		return nil, errors.New("message dialog has no account-specific peer")
	}
	if markedHistoryPeer(peer) != dialog.ID {
		return nil, errors.New("message dialog does not match its peer")
	}
	ids := []tg.InputMessageClass{&tg.InputMessageID{ID: id}}
	var result tg.MessagesMessagesClass
	var err error
	if channel, ok := dialog.peer.(*tg.InputPeerChannel); ok {
		result, err = api.ChannelsGetMessages(ctx, &tg.ChannelsGetMessagesRequest{Channel: &tg.InputChannel{ChannelID: channel.ChannelID, AccessHash: channel.AccessHash}, ID: ids})
	} else {
		result, err = api.MessagesGetMessages(ctx, ids)
	}
	if err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	messages, users, chats, err := historyMessages(result)
	if err != nil {
		return nil, err
	}
	if len(messages) != 1 || messages[0] == nil || messages[0].GetID() != id {
		return nil, errors.New("Telegram message is no longer available")
	}
	message, ok := messages[0].(*tg.Message)
	if !ok {
		if service, ok := messages[0].(*tg.MessageService); ok && samePeer(service.PeerID, peer) {
			return nil, ErrNoMedia
		}
		return nil, errors.New("Telegram message is no longer available")
	}
	if !samePeer(message.PeerID, peer) {
		return nil, errors.New("Telegram message lookup returned another peer")
	}
	fresh := &RefreshedMessage{Message: message, Entities: &tg.Updates{Users: users, Chats: chats}}
	if dialogs := mapDialogPage([]tg.DialogClass{&tg.Dialog{Peer: peer}}, chats, users); len(dialogs) == 1 {
		if dialogs[0].Name != dialogs[0].ID {
			dialog.Name = dialogs[0].Name
		}
		if dialogs[0].Username != "" {
			dialog.Username = dialogs[0].Username
		}
	}
	fresh.Dialog = &dialog
	if channel, ok := result.(*tg.MessagesChannelMessages); ok {
		fresh.PTS = channel.Pts
	}
	return fresh, nil
}
