package engine

import (
	"context"
	"errors"
)

func (s *DialogSession) HasAccount(id string) bool { return id != "" && s.run.accounts[id] != nil }
func (s *DialogSession) AccountCount() int         { return len(s.run.accounts) }

func (s *DialogSession) RemoveDialog(accountID, id string) error {
	if err := s.Err(); err != nil {
		return err
	}
	account, ok := s.run.accounts[accountID].(interface {
		RemoveDialog(context.Context, string) error
	})
	if !ok {
		return errors.New("selected account cannot remove Telegram chats")
	}
	if err := account.RemoveDialog(s.ctx, id); err != nil {
		return err
	}
	s.run.mu.Lock()
	delete(s.run.dialogPhotos, id)
	s.run.mu.Unlock()
	return s.Err()
}

// RemoveDialogs removes confirmed dialogs from one account. Accounts without a
// batch method fall back to one removal at a time with the same outcomes.
func (s *DialogSession) RemoveDialogs(accountID string, ids []string, each func(id string, err error) bool) error {
	if err := s.Err(); err != nil {
		return err
	}
	forget := func(id string, err error) bool {
		if err == nil {
			s.run.mu.Lock()
			delete(s.run.dialogPhotos, id)
			s.run.mu.Unlock()
		}
		return each(id, err)
	}
	switch account := s.run.accounts[accountID].(type) {
	case interface {
		RemoveDialogs(context.Context, []string, func(string, error) bool) error
	}:
		if err := account.RemoveDialogs(s.ctx, ids, forget); err != nil {
			return err
		}
	case interface {
		RemoveDialog(context.Context, string) error
	}:
		for _, id := range ids {
			if err := s.Err(); err != nil {
				return err
			}
			if !forget(id, account.RemoveDialog(s.ctx, id)) {
				break
			}
		}
	default:
		return errors.New("selected account cannot remove Telegram chats")
	}
	return s.Err()
}
