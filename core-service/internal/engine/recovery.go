package engine

import (
	"context"
	"fmt"
	"io"
	"sort"
	"sync"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
)

type recoverySource interface {
	RecoveryDialogs(context.Context, bool) ([]telegram.Dialog, error)
	ProbeDialog(context.Context, telegram.Dialog) error
	ResolveDialog(context.Context, string) (telegram.Dialog, error)
}

type RecoveryDialog struct {
	Dialog    telegram.Dialog
	AccountID string
}

// RecoveryIndex owns a view of one authenticated run. Cancellation of that run
// invalidates every subsequent probe, even if another monitor starts meanwhile.
type RecoveryIndex struct {
	Dialogs  []RecoveryDialog
	ctx      context.Context
	runCtx   context.Context
	cancel   context.CancelFunc
	stop     func() bool
	accounts map[string]recoverySource
	ids      []string
	release  func()
	once     sync.Once
}

func (i *RecoveryIndex) Close() {
	i.once.Do(func() { i.stop(); i.cancel(); i.release() })
}

func (i *RecoveryIndex) Err() error {
	if err := i.runCtx.Err(); err != nil {
		return err
	}
	return i.ctx.Err()
}

func (i *RecoveryIndex) Context() context.Context { return i.ctx }

func (c *Controller) RecoveryIndex(ctx context.Context) (*RecoveryIndex, error) {
	index, err := c.OpenRecoveryIndex(ctx)
	if err != nil {
		return nil, err
	}
	if err = index.Load(); err != nil {
		index.Close()
		return nil, err
	}
	return index, nil
}

// OpenRecoveryIndex acquires a manual lease before asynchronous enumeration.
// Opening is local; Load performs the potentially long Telegram reads.
func (c *Controller) OpenRecoveryIndex(ctx context.Context) (*RecoveryIndex, error) {
	c.opMu.Lock()
	defer c.opMu.Unlock()
	c.mu.Lock()
	if c.run == nil || c.state != "running" {
		c.mu.Unlock()
		return nil, ErrEngineNotRunning
	}
	run := c.run
	sources := map[string]recoverySource{}
	ids := append([]string(nil), run.ids...)
	for _, id := range ids {
		source, ok := run.accounts[id].(recoverySource)
		if !ok {
			c.mu.Unlock()
			return nil, fmt.Errorf("account %s does not support recovery", id)
		}
		sources[id] = source
	}
	c.mu.Unlock()
	sort.Strings(ids)
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	run.jobUsers.Add(1)
	index := &RecoveryIndex{ctx: ctx, runCtx: run.ctx, cancel: cancel, stop: context.AfterFunc(run.ctx, cancel), accounts: sources, ids: ids, release: func() { run.jobUsers.Add(-1) }}
	if err := run.ctx.Err(); err != nil {
		index.Close()
		return nil, err
	}
	return index, nil
}

func (i *RecoveryIndex) Load() error {
	if err := i.Err(); err != nil {
		return err
	}
	dialogs := []RecoveryDialog{}
	for _, id := range i.ids {
		seen := map[string]bool{}
		for _, archived := range []bool{false, true} {
			items, err := i.accounts[id].RecoveryDialogs(i.ctx, archived)
			if err != nil {
				return fmt.Errorf("recovery index account %s: %w", id, err)
			}
			for _, item := range items {
				if !seen[item.ID] {
					dialogs = append(dialogs, RecoveryDialog{Dialog: item, AccountID: id})
					seen[item.ID] = true
				}
			}
		}
	}
	if err := i.Err(); err != nil {
		return err
	}
	i.Dialogs = dialogs
	return nil
}

func (i *RecoveryIndex) Photo(candidate RecoveryDialog, w io.Writer) (bool, error) {
	if err := i.Err(); err != nil {
		return false, err
	}
	source, ok := i.accounts[candidate.AccountID].(interface {
		DownloadDialogPhoto(context.Context, telegram.Dialog, io.Writer) (bool, error)
	})
	if !ok {
		return false, fmt.Errorf("account %s cannot download profile photos", candidate.AccountID)
	}
	ctx, cancel := context.WithTimeout(i.ctx, 30*time.Second)
	defer cancel()
	return source.DownloadDialogPhoto(ctx, candidate.Dialog, w)
}

func (i *RecoveryIndex) Probe(candidate RecoveryDialog) error {
	if err := i.ctx.Err(); err != nil {
		return err
	}
	source := i.accounts[candidate.AccountID]
	if source == nil {
		return fmt.Errorf("account %s is not connected", candidate.AccountID)
	}
	ctx, cancel := context.WithTimeout(i.ctx, 30*time.Second)
	defer cancel()
	return source.ProbeDialog(ctx, candidate.Dialog)
}

// A pin is authoritative. An unpinned lookup uses the first account in stable
// order; an RPC error never silently changes the selected account.
func (i *RecoveryIndex) Lookup(query, pin string) (RecoveryDialog, error) {
	if err := i.ctx.Err(); err != nil {
		return RecoveryDialog{}, err
	}
	if pin == "" && len(i.ids) > 0 {
		pin = i.ids[0]
	}
	source := i.accounts[pin]
	if source == nil {
		return RecoveryDialog{}, fmt.Errorf("account %s is not connected", pin)
	}
	ctx, cancel := context.WithTimeout(i.ctx, 30*time.Second)
	defer cancel()
	dialog, err := source.ResolveDialog(ctx, query)
	return RecoveryDialog{Dialog: dialog, AccountID: pin}, err
}
