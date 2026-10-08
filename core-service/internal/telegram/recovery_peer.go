package telegram

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/gotd/td/tg"
)

type peerRecoveryAPI interface {
	MessagesGetHistory(context.Context, *tg.MessagesGetHistoryRequest) (tg.MessagesMessagesClass, error)
	ContactsResolveUsername(context.Context, string) (*tg.ContactsResolvedPeer, error)
}

func (a *Account) ProbeDialog(ctx context.Context, dialog Dialog) error {
	return probeDialog(ctx, a.API(), dialog)
}

func probeDialog(ctx context.Context, api peerRecoveryAPI, dialog Dialog) error {
	if dialog.peer == nil {
		return errors.New("dialog has no reusable access hash")
	}
	result, err := api.MessagesGetHistory(ctx, &tg.MessagesGetHistoryRequest{Peer: dialog.peer, Limit: 1})
	if err != nil {
		return err
	}
	switch result.(type) {
	case *tg.MessagesMessages, *tg.MessagesMessagesSlice, *tg.MessagesChannelMessages:
		return nil
	default:
		return fmt.Errorf("unexpected Telegram probe response %T", result)
	}
}

func (a *Account) ResolveDialog(ctx context.Context, query string) (Dialog, error) {
	return resolveDialog(ctx, a.API(), a.state, a.selfID, query)
}

func resolveDialog(ctx context.Context, api peerRecoveryAPI, state *UpdateState, selfID int64, query string) (Dialog, error) {
	if id, err := strconv.ParseInt(query, 10, 64); err == nil {
		dialog := Dialog{ID: query, Name: query}
		switch {
		case id < -1000000000000:
			channel := -1000000000000 - id
			hash, found, err := state.GetChannelAccessHash(ctx, selfID, channel)
			if err != nil {
				return Dialog{}, err
			}
			if !found {
				return Dialog{}, errors.New("channel access hash is missing")
			}
			dialog.Type, dialog.peer = "channel", &tg.InputPeerChannel{ChannelID: channel, AccessHash: hash}
		case id < 0:
			dialog.Type, dialog.peer = "group", &tg.InputPeerChat{ChatID: -id}
		default:
			if id <= 0 {
				return Dialog{}, errors.New("invalid user id")
			}
			dialog.Type = "user"
			if id == selfID {
				dialog.peer = &tg.InputPeerSelf{}
				return dialog, nil
			}
			hash, found, err := state.userAccessHash(ctx, selfID, id)
			if err != nil {
				return Dialog{}, err
			}
			if !found {
				return Dialog{}, errors.New("user is absent from the dialog index; username required")
			}
			dialog.peer = &tg.InputPeerUser{UserID: id, AccessHash: hash}
		}
		return dialog, nil
	}
	result, err := api.ContactsResolveUsername(ctx, strings.TrimPrefix(query, "@"))
	if err != nil {
		return Dialog{}, err
	}
	if result == nil || result.Peer == nil {
		return Dialog{}, errors.New("username returned no peer")
	}
	dialogs := mapDialogPage([]tg.DialogClass{&tg.Dialog{Peer: result.Peer}}, result.Chats, result.Users)
	if len(dialogs) != 1 || dialogs[0].peer == nil {
		return Dialog{}, errors.New("username returned no usable peer")
	}
	if err := state.cacheStoryPeers(ctx, selfID, result.Chats, result.Users); err != nil {
		return Dialog{}, err
	}
	return dialogs[0], nil
}
