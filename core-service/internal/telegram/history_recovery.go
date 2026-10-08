package telegram

import (
	"context"
	"errors"
	"fmt"

	"github.com/gotd/td/tg"
)

// historyAPI is the small part of Telegram's API needed to repair a channel
// whose update difference is too old. Keeping it narrow makes the recovery
// path deterministic in tests and avoids constructing a second client.
type historyAPI interface {
	MessagesGetHistory(context.Context, *tg.MessagesGetHistoryRequest) (tg.MessagesMessagesClass, error)
}

const recoveryPageSize = 100
const recoveryMaxPages = 1000

func (a *Account) SupportsHistoryRecovery() bool { return true }

func (a *Account) recoverPending(ctx context.Context, userID int64) error {
	records, err := a.state.PendingRecovery(ctx)
	if err != nil {
		return err
	}
	for _, record := range records {
		if record.ChannelID <= 0 || record.Pts <= 0 {
			return fmt.Errorf("account %s has incomplete recovery state for channel %d", a.state.AccountID, record.ChannelID)
		}
		if record.UserID != 0 && record.UserID != userID {
			return fmt.Errorf("account %s recovery belongs to another Telegram user", a.state.AccountID)
		}
		hash, found, err := a.state.GetChannelAccessHash(ctx, userID, record.ChannelID)
		if err != nil {
			return err
		}
		if !found {
			return fmt.Errorf("channel %d access hash is missing for history recovery", record.ChannelID)
		}
		if err = recoverChannelHistory(ctx, a.API(), a.handle, record.ChannelID, hash); err != nil {
			return fmt.Errorf("recover channel %d history: %w", record.ChannelID, err)
		}
		if err = a.state.CompleteRecovery(ctx, RecoveryRecord{ChannelID: record.ChannelID, UserID: userID, Pts: record.Pts}); err != nil {
			return err
		}
	}
	return nil
}

func recoverChannelHistory(ctx context.Context, api historyAPI, handle func(context.Context, tg.UpdatesClass) error, channelID, accessHash int64) error {
	if api == nil || handle == nil {
		return errors.New("Telegram history recovery is not configured")
	}
	offsetID := 0
	for page := 0; page < recoveryMaxPages; page++ {
		result, err := api.MessagesGetHistory(ctx, &tg.MessagesGetHistoryRequest{
			Peer:     &tg.InputPeerChannel{ChannelID: channelID, AccessHash: accessHash},
			OffsetID: offsetID,
			Limit:    recoveryPageSize,
		})
		if err != nil {
			return err
		}
		messages, users, chats, err := historyMessages(result)
		if err != nil {
			return err
		}
		if len(messages) == 0 {
			return nil
		}
		minimumID := 0
		for _, raw := range messages {
			message, ok := raw.(*tg.Message)
			if !ok || message.ID <= 0 {
				continue
			}
			if peer, ok := message.PeerID.(*tg.PeerChannel); !ok || peer.ChannelID != channelID {
				continue
			} else if minimumID == 0 || message.ID < minimumID {
				minimumID = message.ID
			}
			if err = handle(ctx, &tg.Updates{
				Updates: []tg.UpdateClass{&tg.UpdateNewChannelMessage{Message: message}},
				Users:   users,
				Chats:   chats,
			}); err != nil {
				return err
			}
		}
		if minimumID == 0 {
			return errors.New("Telegram history response contained no channel messages")
		}
		if len(messages) < recoveryPageSize || minimumID <= 1 || minimumID == offsetID {
			return nil
		}
		offsetID = minimumID
	}
	return errors.New("Telegram history recovery exceeded its bounded page limit")
}

func historyMessages(result tg.MessagesMessagesClass) ([]tg.MessageClass, []tg.UserClass, []tg.ChatClass, error) {
	switch result := result.(type) {
	case *tg.MessagesMessages:
		return result.Messages, result.Users, result.Chats, nil
	case *tg.MessagesMessagesSlice:
		return result.Messages, result.Users, result.Chats, nil
	case *tg.MessagesChannelMessages:
		return result.Messages, result.Users, result.Chats, nil
	default:
		return nil, nil, nil, fmt.Errorf("unexpected Telegram history response %T", result)
	}
}
