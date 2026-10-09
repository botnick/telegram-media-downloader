package telegram

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/gotd/td/tg"
)

// ErrDialogNotInAccount means the account's complete current dialog list does
// not contain the chat: it was already left, removed or deleted on Telegram.
var ErrDialogNotInAccount = errors.New("dialog is not in the selected account's current dialogs")

type dialogRemovalAPI interface {
	ChannelsLeaveChannel(context.Context, tg.InputChannelClass) (tg.UpdatesClass, error)
	MessagesDeleteChatUser(context.Context, *tg.MessagesDeleteChatUserRequest) (tg.UpdatesClass, error)
	MessagesDeleteHistory(context.Context, *tg.MessagesDeleteHistoryRequest) (*tg.MessagesAffectedHistory, error)
}

// RemoveDialog removes a current dialog from this account only. Callers must
// hold the account's run lease and obtain explicit confirmation for this ID.
// Downloaded media and the downloader's local history are never touched here.
func (a *Account) RemoveDialog(ctx context.Context, id string) error {
	if a == nil || a.API() == nil {
		return errors.New("Telegram account is not connected")
	}
	return removeDialog(ctx, a.API(), a.RecoveryDialogs, id)
}

func removeDialog(ctx context.Context, api dialogRemovalAPI, dialogs func(context.Context, bool) ([]Dialog, error), id string) error {
	if err := canonicalDialogID(id); err != nil {
		return err
	}
	// Bound the whole operation, including continued history deletion. A caller's
	// earlier deadline still takes precedence; cancellation never becomes success.
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	current, err := currentDialogs(ctx, dialogs)
	if err != nil {
		return err
	}
	return removeResolvedDialog(ctx, api, current, id)
}

// RemoveDialogs removes several dialogs from this account only, reading the
// account's dialog list once. each receives every outcome; returning false
// stops before the next removal. Callers hold the same confirmations as for
// RemoveDialog.
func (a *Account) RemoveDialogs(ctx context.Context, ids []string, each func(id string, err error) bool) error {
	if a == nil || a.API() == nil {
		return errors.New("Telegram account is not connected")
	}
	return removeDialogs(ctx, a.API(), a.RecoveryDialogs, ids, each)
}

// Pause between removals so a long batch does not trip Telegram's flood limits.
var dialogRemovalPace = 1500 * time.Millisecond

func removeDialogs(ctx context.Context, api dialogRemovalAPI, dialogs func(context.Context, bool) ([]Dialog, error), ids []string, each func(id string, err error) bool) error {
	for _, id := range ids {
		if err := canonicalDialogID(id); err != nil {
			return err
		}
	}
	listCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	current, err := currentDialogs(listCtx, dialogs)
	cancel()
	if err != nil {
		return err
	}
	for i, id := range ids {
		if i > 0 && dialogRemovalPace > 0 {
			timer := time.NewTimer(dialogRemovalPace)
			select {
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			case <-timer.C:
			}
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		var err error
		if dialog, ok := current[id]; ok && dialog.Access.State == "ok" {
			// Batches are only for dead chats; a working chat needs the single,
			// per-chat confirmation instead.
			err = errors.New("chat is still available; only unavailable chats can be removed together")
		} else {
			removeCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
			err = removeResolvedDialog(removeCtx, api, current, id)
			cancel()
		}
		if !each(id, err) {
			return nil
		}
	}
	return nil
}

func canonicalDialogID(id string) error {
	numericID, err := strconv.ParseInt(id, 10, 64)
	if err != nil || numericID == 0 || strconv.FormatInt(numericID, 10) != id {
		return errors.New("a canonical Telegram dialog ID is required")
	}
	return nil
}

// Active dialogs are read first, so an active entry wins over an archived duplicate.
func currentDialogs(ctx context.Context, dialogs func(context.Context, bool) ([]Dialog, error)) (map[string]Dialog, error) {
	current := map[string]Dialog{}
	for _, archived := range []bool{false, true} {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		items, err := dialogs(ctx, archived)
		if err != nil {
			return nil, fmt.Errorf("read current account dialogs: %w", err)
		}
		for _, item := range items {
			if _, ok := current[item.ID]; !ok {
				current[item.ID] = item
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return current, nil
}

func removeResolvedDialog(ctx context.Context, api dialogRemovalAPI, current map[string]Dialog, id string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	dialog, ok := current[id]
	if !ok {
		return ErrDialogNotInAccount
	}
	selected := &dialog
	if selected.Access.State == "" || selected.Access.State == "unknown" {
		return errors.New("dialog has no confirmed Telegram entity; refresh before removing it")
	}
	if err := validateRemovalPeer(*selected); err != nil {
		return err
	}

	switch peer := selected.peer.(type) {
	case *tg.InputPeerChannel:
		result, err := api.ChannelsLeaveChannel(ctx, &tg.InputChannel{ChannelID: peer.ChannelID, AccessHash: peer.AccessHash})
		if err != nil {
			return fmt.Errorf("leave Telegram channel: %w", err)
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if result == nil {
			return errors.New("Telegram returned no channel leave result")
		}
		return nil
	case *tg.InputPeerChat:
		// These current entity states prove that the old basic chat cannot be
		// left again. A forbidden entity alone never implies remote deletion:
		// deleting our own history must still succeed before returning success.
		alreadyOut := selected.Access.State == "left" || selected.Access.State == "migrated" ||
			selected.Access.State == "inaccessible" && selected.Access.Code == "CHAT_FORBIDDEN"
		if !alreadyOut {
			result, err := api.MessagesDeleteChatUser(ctx, &tg.MessagesDeleteChatUserRequest{
				ChatID: peer.ChatID, UserID: &tg.InputUserSelf{}, RevokeHistory: false,
			})
			if err != nil {
				return fmt.Errorf("leave Telegram group: %w", err)
			}
			if err := ctx.Err(); err != nil {
				return fmt.Errorf("group was left, but dialog removal did not finish: %w", err)
			}
			if result == nil {
				return errors.New("Telegram returned no group leave result")
			}
		}
		if err := removeOwnDialogHistory(ctx, api, peer); err != nil {
			if !alreadyOut {
				return fmt.Errorf("group was left, but dialog removal did not finish: %w", err)
			}
			return err
		}
		return nil
	case *tg.InputPeerUser:
		return removeOwnDialogHistory(ctx, api, peer)
	default:
		return errors.New("dialog does not support account removal")
	}
}

func validateRemovalPeer(dialog Dialog) error {
	valid := false
	switch peer := dialog.peer.(type) {
	case *tg.InputPeerChannel:
		valid = peer != nil && peer.ChannelID > 0 && peer.AccessHash != 0 && (dialog.Type == "channel" || dialog.Type == "supergroup") &&
			dialog.ID == strconv.FormatInt(-1000000000000-peer.ChannelID, 10)
	case *tg.InputPeerChat:
		valid = peer != nil && peer.ChatID > 0 && dialog.Type == "group" && dialog.ID == "-"+strconv.FormatInt(peer.ChatID, 10)
	case *tg.InputPeerUser:
		valid = peer != nil && peer.UserID > 0 && (dialog.Type == "user" || dialog.Type == "bot") &&
			dialog.ID == strconv.FormatInt(peer.UserID, 10) && (peer.AccessHash != 0 || dialog.Access.State == "deleted")
	case *tg.InputPeerSelf:
		return errors.New("Saved Messages cannot be removed as a dialog")
	}
	if !valid {
		return errors.New("dialog has no valid reusable peer for this account")
	}
	return nil
}

func removeOwnDialogHistory(ctx context.Context, api dialogRemovalAPI, peer tg.InputPeerClass) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		// max_id=0 selects all history. Neither revoke-for-everyone nor the
		// clear-only operation is used: remove only this account's dialog.
		result, err := api.MessagesDeleteHistory(ctx, &tg.MessagesDeleteHistoryRequest{
			Peer: peer, MaxID: 0, Revoke: false, JustClear: false,
		})
		if err != nil {
			return fmt.Errorf("remove Telegram dialog history: %w", err)
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if result == nil || result.Offset < 0 {
			return errors.New("Telegram returned an invalid history removal result")
		}
		if result.Offset == 0 {
			return nil
		}
		// This method has no offset input; a positive affectedHistory.offset
		// means repeat the same request until Telegram reports zero.
	}
}
