package telegram

import (
	"context"
	"database/sql"
	"errors"

	"github.com/gotd/td/tg"
)

func (s *UpdateState) cacheStoryPeers(ctx context.Context, self int64, chats []tg.ChatClass, users []tg.UserClass) error {
	if err := s.cacheDialogHashes(ctx, self, chats); err != nil {
		return err
	}
	hashes := map[int64]int64{}
	for _, raw := range users {
		if u, ok := raw.(*tg.User); ok && !u.Min && u.ID > 0 && u.AccessHash != 0 {
			hashes[u.ID] = u.AccessHash
		}
	}
	if len(hashes) == 0 {
		return ctx.Err()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failed != nil {
		return s.failed
	}
	tx, err := s.Writer.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for id, hash := range hashes {
		if _, err = tx.ExecContext(ctx, `INSERT INTO tgdl_user_peers(account_id,self_id,user_id,access_hash) VALUES(?,?,?,?) ON CONFLICT(account_id,self_id,user_id) DO UPDATE SET access_hash=excluded.access_hash`, s.AccountID, self, id, hash); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *UpdateState) userAccessHash(ctx context.Context, self, id int64) (int64, bool, error) {
	var hash int64
	err := s.Reader.QueryRowContext(ctx, `SELECT access_hash FROM tgdl_user_peers WHERE account_id=? AND self_id=? AND user_id=?`, s.AccountID, self, id).Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	return hash, err == nil, err
}
