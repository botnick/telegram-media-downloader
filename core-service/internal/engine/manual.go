package engine

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/tg"
)

type originKey struct{}

func WithOrigin(ctx context.Context, origin string) context.Context {
	return context.WithValue(ctx, originKey{}, origin)
}
func Origin(ctx context.Context) string {
	if value, _ := ctx.Value(originKey{}).(string); value != "" {
		return value
	}
	return "live"
}

type historySource interface {
	recoverySource
	HistoryPage(context.Context, telegram.Dialog, telegram.HistoryRequest) (telegram.HistoryPage, error)
}

// MessageSession binds every lookup and page to one account and one run.
// It never tries another account after an access/RPC error.
type MessageSession struct {
	AccountID  string
	controller *Controller
	run        *running
	source     recoverySource
	origin     string
	ctx        context.Context
	cancel     context.CancelFunc
	stop       func() bool
	once       sync.Once
}

func (c *Controller) OpenHistory(ctx context.Context, accountID string) (*MessageSession, error) {
	return c.openMessages(ctx, accountID, "history")
}

func (c *Controller) OpenURL(ctx context.Context, accountID string) (*MessageSession, error) {
	return c.openMessages(ctx, accountID, "url")
}

type messageSource interface {
	ReadMessage(context.Context, telegram.Dialog, int) (*telegram.RefreshedMessage, error)
}

func (c *Controller) openMessages(ctx context.Context, accountID, origin string) (*MessageSession, error) {
	c.opMu.Lock()
	defer c.opMu.Unlock()
	run, err := c.queueRun()
	if err != nil {
		return nil, err
	}
	if err := run.ctx.Err(); err != nil {
		return nil, err
	}
	if accountID == "" {
		ids := append([]string(nil), run.ids...)
		sort.Strings(ids)
		if len(ids) == 0 {
			return nil, errors.New("No Telegram accounts loaded")
		}
		accountID = ids[0]
	}
	source, ok := run.accounts[accountID].(recoverySource)
	if !ok {
		return nil, fmt.Errorf("account %s cannot resolve Telegram messages", accountID)
	}
	if origin == "history" {
		if _, ok := source.(historySource); !ok {
			return nil, fmt.Errorf("account %s cannot read Telegram history", accountID)
		}
	} else if _, ok := source.(messageSource); !ok {
		return nil, fmt.Errorf("account %s cannot read Telegram messages", accountID)
	}
	ctx, cancel := context.WithCancel(ctx)
	s := &MessageSession{AccountID: accountID, controller: c, run: run, source: source, origin: origin, ctx: ctx, cancel: cancel, stop: context.AfterFunc(run.ctx, cancel)}
	run.jobUsers.Add(1)
	return s, nil
}

func (s *MessageSession) Close()     { s.once.Do(func() { s.stop(); s.cancel(); s.run.jobUsers.Add(-1) }) }
func (s *MessageSession) Err() error { return s.ctx.Err() }

func (s *MessageSession) Resolve(query string) (telegram.Dialog, error) {
	if err := s.ctx.Err(); err != nil {
		return telegram.Dialog{}, err
	}
	ctx, cancel := context.WithTimeout(s.ctx, 10*time.Minute)
	defer cancel()
	call, end := context.WithTimeout(ctx, 30*time.Second)
	dialog, err := s.source.ResolveDialog(call, query)
	end()
	if err == nil {
		return dialog, nil
	}
	if _, parse := strconv.ParseInt(query, 10, 64); parse != nil {
		return telegram.Dialog{}, err
	}
	// Numeric user IDs and uncached channel hashes need this same account's
	// complete dialog list. The capped UI projection cannot prove absence.
	for _, archived := range []bool{false, true} {
		items, listErr := s.source.RecoveryDialogs(ctx, archived)
		if listErr != nil {
			return telegram.Dialog{}, listErr
		}
		for _, item := range items {
			if item.ID == query {
				return item, nil
			}
		}
	}
	return telegram.Dialog{}, err
}

func (s *MessageSession) Page(dialog telegram.Dialog, request telegram.HistoryRequest) (telegram.HistoryPage, error) {
	if err := s.ctx.Err(); err != nil {
		return telegram.HistoryPage{}, err
	}
	ctx, cancel := context.WithTimeout(s.ctx, 30*time.Second)
	defer cancel()
	source, ok := s.source.(historySource)
	if !ok {
		return telegram.HistoryPage{}, errors.New("account cannot read history")
	}
	return source.HistoryPage(ctx, dialog, request)
}

func (s *MessageSession) Read(dialog telegram.Dialog, id int) (*telegram.RefreshedMessage, error) {
	if err := s.ctx.Err(); err != nil {
		return nil, err
	}
	source, ok := s.source.(messageSource)
	if !ok {
		return nil, errors.New("account cannot read messages")
	}
	ctx, cancel := context.WithTimeout(s.ctx, 30*time.Second)
	defer cancel()
	return source.ReadMessage(ctx, dialog, id)
}

func (s *MessageSession) Filter(ctx context.Context, message *tg.Message, entities *tg.Updates) (Target, bool, error) {
	if err := s.ctx.Err(); err != nil {
		return Target{}, false, err
	}
	if _, err := telegram.MessageAttachment(message); errors.Is(err, telegram.ErrNoMedia) {
		return Target{}, false, nil
	} else if err != nil {
		return Target{}, false, err
	}
	return s.controller.filter(WithOrigin(ctx, s.origin), s.AccountID, message, entities)
}

// QueueTx makes the caller's config/cursor checkpoint atomic with acceptance.
func (s *MessageSession) QueueTx(ctx context.Context, tx *sql.Tx, target Target, message *tg.Message, repair bool, pts ...int) (int64, bool, error) {
	if err := s.ctx.Err(); err != nil {
		return 0, false, err
	}
	watermark := 0
	if len(pts) > 0 {
		watermark = pts[0]
	}
	return enqueueWork(ctx, tx, s.AccountID, target, message, watermark, s.origin, repair)
}

func (s *MessageSession) Wake(id int64) {
	if id != 0 {
		s.run.mu.Lock()
		if cancel := s.run.active[id]; cancel != nil {
			cancel()
		}
		s.run.mu.Unlock()
	}
	s.controller.wake(s.run)
}

func (c *Controller) PendingManual(ctx context.Context) (int, error) {
	var count int
	err := c.reader.QueryRowContext(ctx, `SELECT count(*) FROM tgdl_work WHERE origin<>'live' AND status IN ('pending','processing')`).Scan(&count)
	return count, err
}

// Stopping the live subscription does not interrupt an explicit backfill.
// Internal account mutations and application shutdown still call hard Stop.
func (c *Controller) StopObserving(ctx context.Context) error {
	c.opMu.Lock()
	run, err := c.queueRun()
	if err != nil {
		c.opMu.Unlock()
		return c.Stop(ctx)
	}
	pending, err := c.PendingManual(ctx)
	if err != nil {
		c.opMu.Unlock()
		return err
	}
	if run.jobUsers.Load() == 0 && pending == 0 {
		c.opMu.Unlock()
		return c.Stop(ctx)
	}
	run.observing.Store(false)
	run.mu.Lock()
	for id, cancel := range run.active {
		if run.activeOrigin[id] == "live" {
			cancel()
		}
	}
	run.mu.Unlock()
	c.opMu.Unlock()
	if c.notify != nil {
		c.notify("stopped", nil)
	}
	return nil
}

func (c *Controller) StopIdleJobs(ctx context.Context) error {
	c.opMu.Lock()
	c.mu.Lock()
	run := c.run
	c.mu.Unlock()
	if run == nil || run.observing.Load() || run.jobUsers.Load() != 0 {
		c.opMu.Unlock()
		return nil
	}
	pending, err := c.PendingManual(ctx)
	if err != nil || pending != 0 {
		c.opMu.Unlock()
		return err
	}
	run.cancel(context.Canceled)
	c.opMu.Unlock()
	select {
	case <-run.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
