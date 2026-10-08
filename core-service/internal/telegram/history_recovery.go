package telegram

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/gotd/td/tg"
)

// historyAPI is the small part of Telegram's API needed to repair a channel
// whose update difference is too old. Keeping it narrow makes the recovery
// path deterministic in tests and avoids constructing a second client.
type historyAPI interface {
	MessagesGetHistory(context.Context, *tg.MessagesGetHistoryRequest) (tg.MessagesMessagesClass, error)
}

type recoveryDifferenceAPI interface {
	UpdatesGetChannelDifference(context.Context, *tg.UpdatesGetChannelDifferenceRequest) (tg.UpdatesChannelDifferenceClass, error)
}

type historyRecoveryAPI interface {
	historyAPI
	recoveryDifferenceAPI
}

const recoveryPageSize = 100
const recoveryMaxPages = 1000
const recoveryDifferenceLimit = 100

func (a *Account) SupportsHistoryRecovery() bool { return true }

func (a *Account) recoverPending(ctx context.Context, userID int64) error {
	return recoverPendingHistory(ctx, a.API(), a.state, userID, a.handle)
}

func recoverPendingHistory(ctx context.Context, api historyRecoveryAPI, state *UpdateState, userID int64, handle func(context.Context, tg.UpdatesClass) error) error {
	records, err := state.PendingRecovery(ctx)
	if err != nil {
		return err
	}
	for _, record := range records {
		if record.ChannelID <= 0 {
			return fmt.Errorf("account %s has incomplete recovery state for channel %d", state.AccountID, record.ChannelID)
		}
		if record.UserID != 0 && record.UserID != userID {
			return fmt.Errorf("account %s recovery belongs to another Telegram user", state.AccountID)
		}
		hash, found, err := state.GetChannelAccessHash(ctx, userID, record.ChannelID)
		if err != nil {
			return err
		}
		if !found {
			return fmt.Errorf("channel %d access hash is missing for history recovery", record.ChannelID)
		}
		if record.Pts <= 0 {
			record.Pts, err = resolveRecoveryPts(ctx, api, userID, record.ChannelID, hash, state)
			if err != nil {
				return fmt.Errorf("resolve channel %d recovery cursor: %w", record.ChannelID, err)
			}
			if record.Pts <= 0 {
				return fmt.Errorf("resolve channel %d recovery cursor returned %d", record.ChannelID, record.Pts)
			}
			if err = state.RecordRecovery(ctx, userID, record.ChannelID, record.Pts); err != nil {
				return err
			}
		}
		if err = recoverChannelHistory(ctx, api, handle, record.ChannelID, hash); err != nil {
			return fmt.Errorf("recover channel %d history: %w", record.ChannelID, err)
		}
		if err = state.CompleteRecovery(ctx, RecoveryRecord{ChannelID: record.ChannelID, UserID: userID, Pts: record.Pts}); err != nil {
			return err
		}
	}
	return nil
}

func resolveRecoveryPts(ctx context.Context, api recoveryDifferenceAPI, userID, channelID, accessHash int64, state *UpdateState) (int, error) {
	if api == nil {
		return 0, errors.New("Telegram difference API is not configured")
	}
	local, _, err := state.GetChannelPts(ctx, userID, channelID)
	if err != nil {
		return 0, err
	}
	for attempt := 0; attempt < recoveryMaxPages; attempt++ {
		result, err := api.UpdatesGetChannelDifference(ctx, &tg.UpdatesGetChannelDifferenceRequest{
			Channel: &tg.InputChannel{ChannelID: channelID, AccessHash: accessHash},
			Filter:  &tg.ChannelMessagesFilterEmpty{},
			Pts:     local,
			Limit:   recoveryDifferenceLimit,
		})
		if err != nil {
			return 0, err
		}
		switch result := result.(type) {
		case *tg.UpdatesChannelDifference:
			if result.Pts <= 0 {
				return 0, errors.New("channel recovery response has no pts")
			}
			if result.Final {
				return result.Pts, nil
			}
			if result.Pts <= local {
				return 0, fmt.Errorf("channel recovery cursor did not advance: %d", result.Pts)
			}
			local = result.Pts
		case *tg.UpdatesChannelDifferenceEmpty:
			if result.Pts <= 0 {
				return 0, errors.New("empty channel recovery response has no pts")
			}
			return result.Pts, nil
		case *tg.UpdatesChannelDifferenceTooLong:
			dialog, ok := result.Dialog.(*tg.Dialog)
			if !ok {
				return 0, fmt.Errorf("unexpected recovery dialog %T", result.Dialog)
			}
			pts, ok := dialog.GetPts()
			if !ok || pts <= 0 {
				return 0, errors.New("recovery dialog has no pts")
			}
			return pts, nil
		default:
			return 0, fmt.Errorf("unexpected channel recovery response %T", result)
		}
	}
	return 0, errors.New("channel recovery difference exceeded its bounded page limit")
}

func recoverChannelHistory(ctx context.Context, api historyAPI, handle func(context.Context, tg.UpdatesClass) error, channelID, accessHash int64) error {
	if api == nil || handle == nil {
		return errors.New("Telegram history recovery is not configured")
	}
	offsetID := 0
	for page := 0; page < recoveryMaxPages; page++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		result, err := api.MessagesGetHistory(callCtx, &tg.MessagesGetHistoryRequest{
			Peer:     &tg.InputPeerChannel{ChannelID: channelID, AccessHash: accessHash},
			OffsetID: offsetID,
			Limit:    recoveryPageSize,
		})
		cancel()
		if err != nil {
			return err
		}
		if err = ctx.Err(); err != nil {
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
		// Validate the complete page before delivering it. A different peer or
		// a stalled cursor must retain the recovery marker, not report success.
		for _, raw := range messages {
			if raw == nil || raw.GetID() <= 0 || !historyMessageBelongsToChannel(raw, channelID) {
				return errors.New("Telegram history response contained an invalid channel message")
			}
			if minimumID == 0 || raw.GetID() < minimumID {
				minimumID = raw.GetID()
			}
		}
		if offsetID > 0 && minimumID >= offsetID {
			return fmt.Errorf("Telegram history cursor did not advance from %d", offsetID)
		}
		seen := make(map[int]bool, len(messages))
		for _, raw := range messages {
			if err = ctx.Err(); err != nil {
				return err
			}
			id := raw.GetID()
			if seen[id] || (offsetID > 0 && id >= offsetID) {
				continue
			}
			message, ok := raw.(*tg.Message)
			if !ok {
				continue
			}
			seen[id] = true
			if err = handle(ctx, &tg.Updates{
				Updates: []tg.UpdateClass{&tg.UpdateNewChannelMessage{Message: message}},
				Users:   users,
				Chats:   chats,
			}); err != nil {
				return err
			}
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		// The complete constructor is terminal. Slice/channel responses can be
		// short; keep paging until an empty response or the oldest possible ID.
		_, complete := result.(*tg.MessagesMessages)
		if complete || minimumID == 1 {
			return nil
		}
		offsetID = minimumID
	}
	return errors.New("Telegram history recovery exceeded its bounded page limit")
}

func historyMessageBelongsToChannel(raw tg.MessageClass, channelID int64) bool {
	var peer tg.PeerClass
	switch message := raw.(type) {
	case *tg.Message:
		peer = message.PeerID
	case *tg.MessageService:
		peer = message.PeerID
	case *tg.MessageEmpty:
		// Empty placeholders can omit their peer. Their ID still moves the
		// cursor within this account's explicitly requested channel.
		if message.PeerID == nil {
			return true
		}
		peer = message.PeerID
	default:
		return false
	}
	channel, ok := peer.(*tg.PeerChannel)
	return ok && channel.ChannelID == channelID
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
