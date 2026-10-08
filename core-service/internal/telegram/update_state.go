package telegram

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"time"

	"github.com/gotd/td/telegram/updates"
	"github.com/gotd/td/tg"
)

// UpdateState is account-scoped and persists all gotd update cursors. Some
// gotd handlers log sink errors then try to save a cursor anyway; the shared
// latch makes advancing after a failed durable enqueue impossible.
type UpdateState struct {
	Writer, Reader *sql.DB
	AccountID      string
	OnFailure      func(error)
	mu             sync.Mutex
	failed         error
}

type RecoveryRecord struct {
	ChannelID int64
	UserID    int64
	Pts       int
}

var _ updates.StateStorage = (*UpdateState)(nil)
var _ updates.ChannelAccessHasher = (*UpdateState)(nil)

func (s *UpdateState) guard(ctx context.Context, fn func() error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failed != nil {
		return s.failed
	}
	err := fn()
	if err != nil {
		s.failed = err
		if s.OnFailure != nil {
			s.OnFailure(err)
		}
	}
	return err
}
func (s *UpdateState) GuardHandler(handle func(context.Context, tg.UpdatesClass) error) func(context.Context, tg.UpdatesClass) error {
	return func(ctx context.Context, u tg.UpdatesClass) error {
		return s.guard(ctx, func() error { return handle(ctx, u) })
	}
}
func (s *UpdateState) GetState(ctx context.Context, userID int64) (updates.State, bool, error) {
	var state updates.State
	err := s.Reader.QueryRowContext(ctx, `SELECT pts,qts,date,seq FROM tgdl_update_state WHERE account_id=? AND user_id=?`, s.AccountID, userID).Scan(&state.Pts, &state.Qts, &state.Date, &state.Seq)
	if errors.Is(err, sql.ErrNoRows) {
		return state, false, nil
	}
	return state, err == nil, err
}
func (s *UpdateState) SetState(ctx context.Context, userID int64, state updates.State) error {
	return s.guard(ctx, func() error {
		_, err := s.Writer.ExecContext(ctx, `INSERT INTO tgdl_update_state(account_id,user_id,pts,qts,date,seq) VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,user_id) DO UPDATE SET pts=excluded.pts,qts=excluded.qts,date=excluded.date,seq=excluded.seq`, s.AccountID, userID, state.Pts, state.Qts, state.Date, state.Seq)
		return err
	})
}
func (s *UpdateState) set(ctx context.Context, userID int64, columns string, args ...any) error {
	return s.guard(ctx, func() error {
		args = append(args, s.AccountID, userID)
		result, err := s.Writer.ExecContext(ctx, `UPDATE tgdl_update_state SET `+columns+` WHERE account_id=? AND user_id=?`, args...)
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err == nil && n == 0 {
			return errors.New("Telegram update state is missing")
		}
		return err
	})
}
func (s *UpdateState) SetPts(ctx context.Context, userID int64, pts int) error {
	return s.set(ctx, userID, "pts=?", pts)
}
func (s *UpdateState) SetQts(ctx context.Context, userID int64, qts int) error {
	return s.set(ctx, userID, "qts=?", qts)
}
func (s *UpdateState) SetDate(ctx context.Context, userID int64, date int) error {
	return s.set(ctx, userID, "date=?", date)
}
func (s *UpdateState) SetSeq(ctx context.Context, userID int64, seq int) error {
	return s.set(ctx, userID, "seq=?", seq)
}
func (s *UpdateState) SetDateSeq(ctx context.Context, userID int64, date, seq int) error {
	return s.set(ctx, userID, "date=?,seq=?", date, seq)
}
func (s *UpdateState) GetChannelPts(ctx context.Context, userID, channelID int64) (int, bool, error) {
	var pts int
	err := s.Reader.QueryRowContext(ctx, `SELECT pts FROM tgdl_update_channels WHERE account_id=? AND user_id=? AND channel_id=? AND pts IS NOT NULL`, s.AccountID, userID, channelID).Scan(&pts)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	return pts, err == nil, err
}
func (s *UpdateState) SetChannelPts(ctx context.Context, userID, channelID int64, pts int) error {
	return s.guard(ctx, func() error {
		_, err := s.Writer.ExecContext(ctx, `INSERT INTO tgdl_update_channels(account_id,user_id,channel_id,pts) VALUES(?,?,?,?) ON CONFLICT(account_id,user_id,channel_id) DO UPDATE SET pts=excluded.pts`, s.AccountID, userID, channelID, pts)
		return err
	})
}
func (s *UpdateState) ForEachChannels(ctx context.Context, userID int64, fn func(context.Context, int64, int) error) error {
	rows, err := s.Reader.QueryContext(ctx, `SELECT channel_id,pts FROM tgdl_update_channels WHERE account_id=? AND user_id=? AND pts IS NOT NULL`, s.AccountID, userID)
	if err != nil {
		return err
	}
	type entry struct {
		id  int64
		pts int
	}
	var all []entry
	for rows.Next() {
		var e entry
		if err = rows.Scan(&e.id, &e.pts); err != nil {
			rows.Close()
			return err
		}
		all = append(all, e)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, e := range all {
		if err = fn(ctx, e.id, e.pts); err != nil {
			return err
		}
	}
	return nil
}
func (s *UpdateState) SetChannelAccessHash(ctx context.Context, userID, channelID, hash int64) error {
	return s.guard(ctx, func() error {
		_, err := s.Writer.ExecContext(ctx, `INSERT INTO tgdl_update_channels(account_id,user_id,channel_id,access_hash) VALUES(?,?,?,?) ON CONFLICT(account_id,user_id,channel_id) DO UPDATE SET access_hash=excluded.access_hash`, s.AccountID, userID, channelID, hash)
		return err
	})
}
func (s *UpdateState) GetChannelAccessHash(ctx context.Context, userID, channelID int64) (int64, bool, error) {
	var hash int64
	err := s.Reader.QueryRowContext(ctx, `SELECT access_hash FROM tgdl_update_channels WHERE account_id=? AND user_id=? AND channel_id=? AND access_hash IS NOT NULL`, s.AccountID, userID, channelID).Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	return hash, err == nil, err
}

func (s *UpdateState) RecordRecovery(ctx context.Context, userID, channelID int64, pts int) error {
	if channelID < 0 || pts < 0 {
		return errors.New("invalid Telegram recovery cursor")
	}
	tx, err := s.Writer.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `INSERT INTO tgdl_update_recovery(account_id,channel_id,reason,created_at) VALUES(?,?,?,?) ON CONFLICT(account_id,channel_id) DO UPDATE SET reason=excluded.reason,created_at=excluded.created_at`, s.AccountID, channelID, "Telegram update difference exceeded retention", time.Now().UnixMilli()); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO tgdl_update_recovery_state(account_id,channel_id,user_id,pts) VALUES(?,?,?,?) ON CONFLICT(account_id,channel_id) DO UPDATE SET user_id=excluded.user_id,pts=excluded.pts`, s.AccountID, channelID, userID, pts); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *UpdateState) PendingRecovery(ctx context.Context) ([]RecoveryRecord, error) {
	rows, err := s.Reader.QueryContext(ctx, `SELECT r.channel_id,COALESCE(s.user_id,0),COALESCE(s.pts,0) FROM tgdl_update_recovery r LEFT JOIN tgdl_update_recovery_state s ON s.account_id=r.account_id AND s.channel_id=r.channel_id WHERE r.account_id=? ORDER BY r.channel_id`, s.AccountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var records []RecoveryRecord
	for rows.Next() {
		var record RecoveryRecord
		if err := rows.Scan(&record.ChannelID, &record.UserID, &record.Pts); err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

func (s *UpdateState) CompleteRecovery(ctx context.Context, record RecoveryRecord) error {
	return s.guard(ctx, func() error {
		tx, err := s.Writer.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		if _, err = tx.ExecContext(ctx, `INSERT INTO tgdl_update_channels(account_id,user_id,channel_id,pts) VALUES(?,?,?,?) ON CONFLICT(account_id,user_id,channel_id) DO UPDATE SET pts=excluded.pts`, s.AccountID, record.UserID, record.ChannelID, record.Pts); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `DELETE FROM tgdl_update_recovery WHERE account_id=? AND channel_id=?`, s.AccountID, record.ChannelID); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `DELETE FROM tgdl_update_recovery_state WHERE account_id=? AND channel_id=?`, s.AccountID, record.ChannelID); err != nil {
			return err
		}
		return tx.Commit()
	})
}
