package engine

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/tg"
)

type Account interface {
	telegram.MediaDownloader
	Run(context.Context, func()) error
	Fingerprint() string
	RefreshMessage(context.Context, *tg.Message) (*telegram.RefreshedMessage, error)
}
type historyRecoverable interface{ SupportsHistoryRecovery() bool }

type Dialog struct {
	ID, Name, Username, Type string
	Archived                 bool
	Members                  *int
	AccountIDs               []string
}

type dialogSource interface {
	Dialogs(context.Context, int, bool) ([]telegram.Dialog, error)
}
type AccountConfig struct {
	ID, Name string
	Telegram telegram.GotdConfig
}
type Factory func(AccountConfig, *telegram.UpdateState, func(context.Context, tg.UpdatesClass) error, func(int64)) (Account, error)
type Target struct{ ID, Name string }
type Filter func(context.Context, string, *tg.Message, tg.UpdatesClass) (Target, bool, error)
type Sink func(context.Context, *Work, *tg.Message, telegram.MediaDownloader) error

type Controller struct {
	writer, reader *sql.DB
	work           *WorkStore
	dataDir        string
	factory        Factory
	filter         Filter
	sink           Sink
	notify         func(string, error)
	opMu           sync.Mutex
	mu             sync.Mutex
	state          string
	lastError      error
	started        time.Time
	run            *running
	attemptLimit   func(int64) time.Duration
}
type running struct {
	ctx         context.Context
	cancel      context.CancelCauseFunc
	done        chan struct{}
	wake        chan struct{}
	accounts    map[string]Account
	ids         []string
	workers     int
	maxAttempts int
	mu          sync.Mutex
	active      map[int64]context.CancelFunc
	progress    map[int64]*transferStats
}

func New(writer, reader *sql.DB, dataDir string, factory Factory, filter Filter, sink Sink, notify func(string, error)) *Controller {
	if factory == nil {
		factory = func(cfg AccountConfig, state *telegram.UpdateState, handler func(context.Context, tg.UpdatesClass) error, gap func(int64)) (Account, error) {
			return telegram.NewAccount(cfg.Telegram, state, handler, gap)
		}
	}
	return &Controller{writer: writer, reader: reader, work: NewWorkStore(writer, reader), dataDir: dataDir, factory: factory, filter: filter, sink: sink, notify: notify, state: "stopped", attemptLimit: attemptTimeout}
}
func (c *Controller) setState(state string, cause error) {
	c.mu.Lock()
	c.state = state
	c.lastError = cause
	c.mu.Unlock()
	if c.notify != nil {
		c.notify(state, cause)
	}
}

func (c *Controller) Dialogs(ctx context.Context, limit int) ([]Dialog, error) {
	if limit <= 0 || limit > 1000 {
		limit = 500
	}
	c.mu.Lock()
	run := c.run
	accounts := make(map[string]Account)
	var accountIDs []string
	if run != nil {
		accountIDs = append(accountIDs, run.ids...)
		for _, id := range accountIDs {
			if account := run.accounts[id]; account != nil {
				accounts[id] = account
			}
		}
	}
	c.mu.Unlock()
	if len(accounts) == 0 {
		return nil, errors.New("Telegram monitor is not running")
	}
	merged := map[string]Dialog{}
	order := make([]string, 0)
	accountSets := map[string]map[string]bool{}
	var firstErr error
	for _, id := range accountIDs {
		account := accounts[id]
		source, ok := account.(dialogSource)
		if !ok {
			continue
		}
		for _, archived := range []bool{false, true} {
			items, err := source.Dialogs(ctx, limit, archived)
			if err != nil {
				if firstErr == nil {
					firstErr = err
				}
				continue
			}
			for _, item := range items {
				current, found := merged[item.ID]
				if !found {
					merged[item.ID] = Dialog{ID: item.ID, Name: item.Name, Username: item.Username, Type: item.Type, Archived: item.Archived, Members: item.Members}
					order = append(order, item.ID)
				} else if current.Archived && !item.Archived {
					merged[item.ID] = Dialog{ID: item.ID, Name: item.Name, Username: item.Username, Type: item.Type, Archived: item.Archived, Members: item.Members}
				}
				if accountSets[item.ID] == nil {
					accountSets[item.ID] = map[string]bool{}
				}
				accountSets[item.ID][id] = true
			}
		}
	}
	if len(merged) == 0 && firstErr != nil {
		return nil, firstErr
	}
	out := make([]Dialog, 0, len(order))
	for _, id := range order {
		item := merged[id]
		for accountID := range accountSets[id] {
			item.AccountIDs = append(item.AccountIDs, accountID)
		}
		sort.Strings(item.AccountIDs)
		out = append(out, item)
	}
	return out, nil
}
func (c *Controller) Start(request, parent context.Context, accounts []AccountConfig, workers, maxAttempts int) error {
	c.opMu.Lock()
	locked := true
	defer func() {
		if locked {
			c.opMu.Unlock()
		}
	}()
	c.mu.Lock()
	old := c.run
	c.mu.Unlock()
	if old != nil {
		select {
		case <-old.done:
		default:
			return errors.New("Runtime already running")
		}
	}
	if len(accounts) == 0 {
		return errors.New("No Telegram accounts loaded. Add one in Settings → Accounts first.")
	}
	if workers < 1 || workers > 64 || maxAttempts < 1 || maxAttempts > 20 {
		return errors.New("invalid worker or retry count")
	}
	if c.filter == nil || c.sink == nil {
		return errors.New("engine ingestion is not configured")
	}
	release, err := acquireLock(filepath.Join(c.dataDir, ".tgdl-engine.lock"))
	if err != nil {
		return fmt.Errorf("another engine owns this data directory: %w", err)
	}
	ctx, cancel := context.WithCancelCause(parent)
	run := &running{ctx: ctx, cancel: cancel, done: make(chan struct{}), wake: make(chan struct{}, 1), accounts: make(map[string]Account), workers: workers, maxAttempts: maxAttempts, active: make(map[int64]context.CancelFunc), progress: make(map[int64]*transferStats)}
	failed := true
	defer func() {
		if failed {
			cancel(context.Canceled)
			release()
		}
	}()
	seen := map[string]bool{}
	recoveryPending := false
	for _, config := range accounts {
		if config.ID == "" || run.accounts[config.ID] != nil {
			return errors.New("duplicate or empty account ID")
		}
		config := config
		var gaps int
		if err := c.reader.QueryRowContext(request, `SELECT count(*) FROM tgdl_update_recovery WHERE account_id=?`, config.ID).Scan(&gaps); err != nil {
			return err
		}
		pendingRecovery := gaps > 0
		recoveryPending = recoveryPending || pendingRecovery
		state := &telegram.UpdateState{Writer: c.writer, Reader: c.reader, AccountID: config.ID, OnFailure: func(err error) { cancel(fmt.Errorf("account %s update persistence: %w", config.ID, err)) }}
		handler := func(ctx context.Context, u tg.UpdatesClass) error { return c.accept(ctx, run, config.ID, u) }
		gap := func(channelID int64) {
			gapCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
			defer stop()
			err := state.RecordRecovery(gapCtx, 0, channelID, 0)
			if err != nil {
				cancel(fmt.Errorf("account %s recovery marker: %w", config.ID, err))
			} else {
				recoveryErr := fmt.Errorf("account %s channel %d requires history recovery", config.ID, channelID)
				_ = state.Latch(gapCtx, recoveryErr)
				cancel(recoveryErr)
			}
		}
		account, err := c.factory(config, state, handler, gap)
		if err != nil {
			return fmt.Errorf("account %s: %w", config.ID, err)
		}
		if pendingRecovery {
			recoverable, ok := account.(historyRecoverable)
			if !ok || !recoverable.SupportsHistoryRecovery() {
				return fmt.Errorf("account %s has pending Telegram history recovery", config.ID)
			}
		}
		fingerprint := account.Fingerprint()
		if fingerprint == "" || seen[fingerprint] {
			return errors.New("saved accounts contain a missing or duplicated authentication key")
		}
		seen[fingerprint] = true
		run.accounts[config.ID] = account
		run.ids = append(run.ids, config.ID)
	}
	if err = c.work.Recover(request); err != nil {
		return err
	}
	c.mu.Lock()
	c.run = run
	c.started = time.Time{}
	c.mu.Unlock()
	c.setState("starting", nil)
	ready := make(chan struct{}, len(accounts))
	var wg sync.WaitGroup
	wg.Add(len(accounts))
	for _, id := range run.ids {
		id := id
		go func() {
			defer wg.Done()
			var once sync.Once
			err := run.accounts[id].Run(ctx, func() { once.Do(func() { ready <- struct{}{} }) })
			if ctx.Err() == nil {
				if err == nil {
					err = errors.New("Telegram connection ended")
				}
				cancel(fmt.Errorf("account %s: %w", id, err))
			}
		}()
	}
	// One coordinator owns the worker WaitGroup additions and lifetime. Start
	// never races Wait against Add, and the lock remains held until every user
	// of the account/database has left.
	startWorkers := make(chan bool, 1)
	go func() {
		if <-startWorkers {
			wg.Add(workers)
			for i := 0; i < workers; i++ {
				go func() { defer wg.Done(); c.worker(run) }()
			}
		}
		wg.Wait()
		release()
		cause := context.Cause(ctx)
		if cause != nil && !errors.Is(cause, context.Canceled) {
			c.setState("error", cause)
		} else {
			c.setState("stopped", nil)
		}
		c.mu.Lock()
		c.started = time.Time{}
		c.mu.Unlock()
		close(run.done)
	}()
	failed = false
	// Publish the run before waiting on the network so Stop can cancel startup.
	c.opMu.Unlock()
	locked = false
	startupBudget := 30 * time.Second
	if recoveryPending {
		// History repair can legitimately fetch many bounded pages. A normal
		// login startup deadline would cancel it repeatedly before it can
		// advance the durable cursor.
		startupBudget = 30 * time.Minute
	}
	startup := time.NewTimer(startupBudget)
	defer startup.Stop()
	for range accounts {
		select {
		case <-ready:
		case <-ctx.Done():
			startWorkers <- false
			<-run.done
			return context.Cause(ctx)
		case <-request.Done():
			cancel(request.Err())
			startWorkers <- false
			<-run.done
			return request.Err()
		case <-startup.C:
			err = errors.New("Telegram startup timed out")
			cancel(err)
			startWorkers <- false
			<-run.done
			return err
		}
	}
	c.opMu.Lock()
	locked = true
	if ctx.Err() != nil {
		startWorkers <- false
		<-run.done
		return context.Cause(ctx)
	}
	c.mu.Lock()
	c.started = time.Now()
	c.mu.Unlock()
	c.setState("running", nil)
	startWorkers <- true
	return nil
}
func (c *Controller) Stop(ctx context.Context) error {
	c.opMu.Lock()
	c.mu.Lock()
	run := c.run
	c.mu.Unlock()
	if run == nil {
		c.opMu.Unlock()
		return nil
	}
	select {
	case <-run.done:
		c.opMu.Unlock()
		return nil
	default:
	}
	c.setState("stopping", nil)
	run.cancel(context.Canceled)
	c.opMu.Unlock()
	select {
	case <-run.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (c *Controller) Status(ctx context.Context) (map[string]any, error) {
	c.mu.Lock()
	state, cause, started, run := c.state, c.lastError, c.started, c.run
	c.mu.Unlock()
	var errorValue any
	if cause != nil {
		errorValue = cause.Error()
	}
	var startedAt any
	var uptime int64
	if !started.IsZero() {
		startedAt = started.UnixMilli()
		uptime = time.Since(started).Milliseconds()
	}
	workers, accounts := 0, 0
	if run != nil && (state == "running" || state == "starting" || state == "stopping") {
		workers = run.workers
		accounts = len(run.accounts)
	}
	counts, err := c.work.Counts(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]any{"state": state, "error": errorValue, "startedAt": startedAt, "uptimeMs": uptime, "workers": workers, "accounts": accounts, "queue": counts["pending"], "active": counts["processing"], "stats": nil}, nil
}

func (c *Controller) accept(ctx context.Context, run *running, accountID string, u tg.UpdatesClass) error {
	var list []tg.UpdateClass
	switch update := u.(type) {
	case *tg.Updates:
		list = update.Updates
	case *tg.UpdatesCombined:
		list = update.Updates
	case *tg.UpdateShort:
		list = []tg.UpdateClass{update.Update}
	default:
		return nil
	}
	for _, update := range list {
		var raw tg.MessageClass
		var pts int
		switch update := update.(type) {
		case *tg.UpdateNewMessage:
			raw = update.Message
			pts = update.Pts
		case *tg.UpdateNewChannelMessage:
			raw = update.Message
			pts = update.Pts
		case *tg.UpdateEditMessage:
			raw = update.Message
			pts = update.Pts
		case *tg.UpdateEditChannelMessage:
			raw = update.Message
			pts = update.Pts
		default:
			continue
		}
		message, ok := raw.(*tg.Message)
		if !ok {
			continue
		}
		if _, err := telegram.MessageAttachment(message); errors.Is(err, telegram.ErrNoMedia) {
			continue
		} else if err != nil {
			return err
		}
		target, allowed, err := c.filter(ctx, accountID, message, u)
		if err != nil {
			return err
		}
		if !allowed {
			continue
		}
		id, changed, err := c.work.Enqueue(ctx, accountID, target, message, pts)
		if err != nil {
			return err
		}
		if changed {
			run.mu.Lock()
			if cancel := run.active[id]; cancel != nil {
				cancel()
			}
			run.mu.Unlock()
			select {
			case run.wake <- struct{}{}:
			default:
			}
		}
	}
	return nil
}
func (c *Controller) worker(run *running) {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for run.ctx.Err() == nil {
		work, err := c.work.Claim(run.ctx, run.ids, time.Now())
		if err != nil {
			if run.ctx.Err() == nil {
				run.cancel(fmt.Errorf("claim work: %w", err))
			}
			return
		}
		if work == nil {
			select {
			case <-run.ctx.Done():
				return
			case <-run.wake:
			case <-tick.C:
			}
			continue
		}
		ctx, cancel := context.WithCancel(run.ctx)
		progress := &transferStats{started: time.Now()}
		run.mu.Lock()
		run.active[work.ID] = cancel
		run.progress[work.ID] = progress
		run.mu.Unlock()
		current, err := c.work.IsCurrent(ctx, work)
		if err == nil && !current {
			cancel()
			err = context.Canceled
		}
		var message *tg.Message
		if err == nil {
			message, err = work.Message()
		}
		attemptCtx, finishAttempt := context.WithTimeout(ctx, c.attemptLimit(work.FileSize))
		if err == nil && (work.Attempts > 1 || time.Since(time.UnixMilli(work.CreatedAt)) > time.Minute) {
			var fresh *telegram.RefreshedMessage
			fresh, err = run.accounts[work.AccountID].RefreshMessage(attemptCtx, message)
			if err == nil && (fresh == nil || fresh.Message == nil) {
				err = errors.New("Telegram refresh returned no message")
			}
			if err == nil {
				message = fresh.Message
				_, allowed, filterErr := c.filter(attemptCtx, work.AccountID, message, fresh.Entities)
				if filterErr != nil {
					err = filterErr
				} else if !allowed {
					err = errFiltered
				}
			}
			if err == nil {
				current, err = c.work.Refresh(attemptCtx, work, message)
				if err == nil && !current {
					cancel()
					err = context.Canceled
				}
			}
		}
		if err == nil {
			err = c.sink(attemptCtx, work, message, trackedTransport{MediaDownloader: run.accounts[work.AccountID], stats: progress})
		}
		finishAttempt()
		wasCancelled := ctx.Err() != nil
		cancel()
		run.mu.Lock()
		delete(run.active, work.ID)
		delete(run.progress, work.ID)
		run.mu.Unlock()
		retry := time.Time{}
		if err != nil && !errors.Is(err, errFiltered) && !wasCancelled && work.Attempts < run.maxAttempts {
			retry = time.Now().Add(time.Second * time.Duration(1<<min(work.Attempts-1, 8)))
		}
		finishCtx, stop := context.WithTimeout(context.Background(), 10*time.Second)
		finishErr := c.work.Finish(finishCtx, work, err, wasCancelled, retry)
		stop()
		if finishErr != nil {
			run.cancel(fmt.Errorf("finish work: %w", finishErr))
			return
		}
	}
}

// Bound library-internal RPC timeout retries while allowing large files on
// slow links. An attempt deadline consumes a retry; engine cancellation does not.
func attemptTimeout(size int64) time.Duration {
	seconds := min(max(size, 0)/(16*1024), int64((24*time.Hour)/time.Second))
	return min(2*time.Minute+time.Duration(seconds)*time.Second, 24*time.Hour)
}
