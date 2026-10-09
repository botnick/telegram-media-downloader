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
